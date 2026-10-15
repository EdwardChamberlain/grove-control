import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  auth: {
    authEnabled: true,
    loading: false,
    user: {
      id: 7,
      username: 'operator',
      is_active: true,
      is_admin: false,
      permissions: ['queue:create', 'library:read_own'],
      groups: [],
    },
    hasPermission: (permission: string) => ['queue:create', 'library:read_own'].includes(permission),
  },
  getAuthStatus: vi.fn(),
  getCurrentUser: vi.fn(),
  getLibraryFile: vi.fn(),
  getLibraryFilePlates: vi.fn(),
  getAuthToken: vi.fn(),
  setAuthToken: vi.fn(),
  clearMemoryAuthTokenOverride: vi.fn(),
  themeMounts: 0,
  printProps: null as Record<string, unknown> | null,
  connectHandler: null as ((message: unknown) => void) | null,
  bridgePost: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));

vi.mock('../contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => {
    mocks.themeMounts++;
    return children;
  },
}));

vi.mock('../contexts/ColorCatalogContext', () => ({
  ColorCatalogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../contexts/SliceJobTrackerContext', () => ({
  SliceJobTrackerProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../components/PrintModal', () => ({
  PrintModal: (props: Record<string, unknown>) => {
    mocks.printProps = props;
    return (
      <button
        type="button"
        onClick={() => (props.onResult as (result: unknown) => void)({
          outcome: 'success',
          queueItemIds: [101, 102],
        })}
      >
        Finish mocked print
      </button>
    );
  },
}));

vi.mock('../pages/LoginPage', () => ({
  LoginPage: () => <div>Grove login</div>,
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api: {
    getAuthStatus: mocks.getAuthStatus,
    getCurrentUser: mocks.getCurrentUser,
    getLibraryFile: mocks.getLibraryFile,
    getLibraryFilePlates: mocks.getLibraryFilePlates,
  },
  getAuthToken: mocks.getAuthToken,
  setAuthToken: mocks.setAuthToken,
  clearMemoryAuthTokenOverride: mocks.clearMemoryAuthTokenOverride,
}));

import { OrcaIntegrationPage } from '../pages/OrcaIntegrationPage';

function renderIntegration(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/integrations/orca" element={<OrcaIntegrationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bridgeEnvelope(type: string, requestId: string, fields: Record<string, unknown> = {}) {
  return { type, protocol_version: 1, request_id: requestId, ...fields };
}

describe('Orca integration page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.themeMounts = 0;
    mocks.printProps = null;
    mocks.connectHandler = null;
    mocks.auth.authEnabled = true;
    mocks.auth.loading = false;
    mocks.auth.user = {
      id: 7,
      username: 'operator',
      is_active: true,
      is_admin: false,
      permissions: ['queue:create', 'library:read_own'],
      groups: [],
    };
    mocks.getAuthStatus.mockResolvedValue({ auth_enabled: true, requires_setup: false });
    mocks.getCurrentUser.mockResolvedValue(mocks.auth.user);
    mocks.getLibraryFile.mockResolvedValue({ id: 42, filename: 'part.3mf', created_by_id: 7 });
    mocks.getLibraryFilePlates.mockResolvedValue({
      file_id: 42,
      filename: 'part.3mf',
      is_multi_plate: true,
      plates: [{ index: 2, name: 'Plate 2' }],
    });
    mocks.getAuthToken.mockReturnValue('header.payload.signature');
    mocks.bridgePost.mockClear();
    window.orca = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.orca = undefined;
  });

  it('sends ready, verifies the bridged owner, and returns every queue row', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const requestId = 'request-print-1';
    renderIntegration(`/integrations/orca?mode=print&protocol_version=1&request_id=${requestId}`);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        bridgeEnvelope('ready', requestId),
        '*',
      );
    });

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: bridgeEnvelope('initialize', requestId, {
        mode: 'print',
        access_token: 'header.payload.signature',
        expected_user_id: 7,
        library_file_id: 42,
        filename: 'part.3mf',
        plate_id: 2,
      }),
    }));

    await screen.findByRole('button', { name: 'Finish mocked print' });
    expect(mocks.setAuthToken).toHaveBeenCalledWith('header.payload.signature', 'memory');
    expect(mocks.getCurrentUser).toHaveBeenCalledOnce();
    expect(mocks.getLibraryFile).toHaveBeenCalledWith(42);
    expect(mocks.getLibraryFilePlates).toHaveBeenCalledWith(42);
    expect(mocks.themeMounts).toBe(1);
    expect(mocks.printProps?.initialPlateId).toBe(2);
    expect(mocks.printProps?.cleanupLibraryAfterDispatch).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Finish mocked print' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        bridgeEnvelope('submitted', requestId, {
          user_id: 7,
          library_file_id: 42,
          queue_item_ids: [101, 102],
        }),
        '*',
      );
    });
  });

  it('rejects an account mismatch before mounting user-dependent providers', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    mocks.getCurrentUser.mockResolvedValue({ ...mocks.auth.user, id: 8 });
    const requestId = 'request-print-2';
    renderIntegration(`/integrations/orca?mode=print&protocol_version=1&request_id=${requestId}`);

    await waitFor(() => expect(post).toHaveBeenCalledWith(bridgeEnvelope('ready', requestId), '*'));
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: bridgeEnvelope('initialize', requestId, {
        mode: 'print',
        access_token: 'header.payload.signature',
        expected_user_id: 7,
        library_file_id: 42,
        filename: 'part.3mf',
      }),
    }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        bridgeEnvelope('session_expired', requestId, { user_id: 7, library_file_id: 42 }),
        '*',
      );
    });
    expect(mocks.getLibraryFile).not.toHaveBeenCalled();
    expect(mocks.themeMounts).toBe(0);
  });

  it('returns the normal Grove user JWT through the connect bridge', async () => {
    window.orca = {
      postMessage: mocks.bridgePost,
      onMessage: (handler) => { mocks.connectHandler = handler; },
    };
    const requestId = 'request-connect-1';
    renderIntegration(`/integrations/orca?mode=connect&protocol_version=1&request_id=${requestId}`);

    await waitFor(() => {
      expect(mocks.bridgePost).toHaveBeenCalledWith(bridgeEnvelope('ready', requestId));
    });
    expect(mocks.bridgePost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'authenticated' }));
    mocks.connectHandler?.(bridgeEnvelope('initialize', requestId, { mode: 'connect' }));

    await waitFor(() => {
      expect(mocks.bridgePost).toHaveBeenCalledWith(bridgeEnvelope('authenticated', requestId, {
        access_token: 'header.payload.signature',
      }));
    });
  });
});
