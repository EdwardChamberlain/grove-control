import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { UserResponse } from '../api/client';
import type { PrintModalProps, PrintModalResult } from '../components/PrintModal/types';

const mocks = vi.hoisted(() => {
  const operator: UserResponse = {
    id: 7,
    username: 'operator',
    role: 'operator',
    auth_source: 'local',
    created_at: '2026-01-01T00:00:00Z',
    is_active: true,
    is_admin: false,
    permissions: ['queue:create', 'library:read_own'],
    groups: [],
  };
  return {
    operator,
    auth: {
      authEnabled: true,
      loading: false,
      user: operator as UserResponse | null,
      hasPermission: vi.fn<(permission: string) => boolean>(),
    },
    getAuthStatus: vi.fn(),
    getCurrentUser: vi.fn(),
    getLibraryFile: vi.fn(),
    getLibraryFilePlates: vi.fn(),
    getAuthToken: vi.fn(),
    setAuthToken: vi.fn(),
    clearMemoryAuthTokenOverride: vi.fn(),
    themeMounts: 0,
    printProps: null as PrintModalProps | null,
    connectHandler: null as ((message: unknown) => void) | null,
    bridgePost: vi.fn(),
  };
});

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
  PrintModal: (props: PrintModalProps) => {
    mocks.printProps = props;
    return (
      <button
        type="button"
        onClick={() => props.onResult?.({
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

import { ApiError } from '../api/client';
import { OrcaIntegrationPage } from '../pages/OrcaIntegrationPage';

function renderIntegration(url: string) {
  const route = () => (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/integrations/orca" element={<OrcaIntegrationPage />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(route());
  return { refresh: () => view.rerender(route()) };
}

function bridgeEnvelope(type: string, requestId: string, fields: Record<string, unknown> = {}) {
  return { type, protocol_version: 1, request_id: requestId, ...fields };
}

const printRequestId = 'orca-print';
const printReceipt = { user_id: 7, library_file_id: 42 };

function sendPrintMessage(type: string, fields: Record<string, unknown> = {}) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: bridgeEnvelope(type, printRequestId, fields),
    }));
  });
}

function startPrint(fields: Record<string, unknown> = {}) {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const view = renderIntegration(`/integrations/orca?mode=print&protocol_version=1&request_id=${printRequestId}`);
  expect(post).toHaveBeenCalledWith(bridgeEnvelope('ready', printRequestId), '*');
  sendPrintMessage('initialize', {
    mode: 'print',
    access_token: 'header.payload.signature',
    expected_user_id: 7,
    library_file_id: 42,
    filename: 'part.3mf',
    ...fields,
  });
  return { post, ...view };
}

function startConnect() {
  window.orca = {
    postMessage: mocks.bridgePost,
    onMessage: (handler) => { mocks.connectHandler = handler; },
  };
  const requestId = 'orca-connect';
  renderIntegration(`/integrations/orca?mode=connect&protocol_version=1&request_id=${requestId}`);
  expect(mocks.bridgePost).toHaveBeenCalledWith(bridgeEnvelope('ready', requestId));
  return {
    requestId,
    send: (type: string, fields: Record<string, unknown> = {}) => {
      act(() => mocks.connectHandler?.(bridgeEnvelope(type, requestId, fields)));
    },
  };
}

describe('Orca integration page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.themeMounts = 0;
    mocks.printProps = null;
    mocks.connectHandler = null;
    mocks.auth.authEnabled = true;
    mocks.auth.loading = false;
    mocks.auth.user = mocks.operator;
    mocks.auth.hasPermission.mockImplementation((permission) =>
      mocks.auth.user?.permissions.some((granted) => granted === permission) ?? false);
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
    const { post } = startPrint({ plate_id: 2 });

    await screen.findByRole('button', { name: 'Finish mocked print' });
    expect(mocks.setAuthToken).toHaveBeenCalledWith('header.payload.signature', 'memory');
    expect(mocks.getCurrentUser).toHaveBeenCalledOnce();
    expect(mocks.getLibraryFile).toHaveBeenCalledWith(42);
    expect(mocks.getLibraryFilePlates).toHaveBeenCalledWith(42);
    expect(mocks.themeMounts).toBe(1);
    expect(mocks.printProps?.initialPlateId).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Finish mocked print' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        bridgeEnvelope('submitted', printRequestId, {
          ...printReceipt,
          queue_item_ids: [101, 102],
        }),
        '*',
      );
    });
  });

  it('rejects an account mismatch before mounting user-dependent providers', async () => {
    mocks.getCurrentUser.mockResolvedValue({ ...mocks.operator, id: 8 });
    const { post } = startPrint();

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        bridgeEnvelope('session_expired', printRequestId, printReceipt),
        '*',
      );
    });
    expect(mocks.getLibraryFile).not.toHaveBeenCalled();
    expect(mocks.themeMounts).toBe(0);
  });

  it.each([
    {
      name: 'authentication is disabled',
      prepare: () => mocks.getAuthStatus.mockResolvedValue({ auth_enabled: false }),
      message: 'Grove user authentication must be enabled for Orca printing.',
    },
    {
      name: 'the connected account lacks queue permission',
      prepare: () => mocks.getCurrentUser.mockResolvedValue({ ...mocks.operator, permissions: ['library:read_own'] }),
      message: 'Your Grove account is missing permission to read this file or create queue items.',
    },
    {
      name: 'the file belongs to another account',
      prepare: () => mocks.getLibraryFile.mockResolvedValue({ id: 42, created_by_id: 8 }),
      message: 'The uploaded file does not belong to the connected Grove account.',
    },
    {
      name: 'the requested plate is missing',
      prepare: () => mocks.getLibraryFilePlates.mockResolvedValue({ plates: [{ index: 1 }] }),
      message: 'Plate 2 is not available in the uploaded file.',
    },
    {
      name: 'the library API denies access',
      prepare: () => mocks.getLibraryFile.mockRejectedValue(new ApiError('Forbidden', 403)),
      message: 'Your Grove account is missing permission to use this file or create queue items.',
    },
    {
      name: 'the library API is unreachable',
      prepare: () => mocks.getLibraryFile.mockRejectedValue(new TypeError('Failed to fetch')),
      message: 'Grove could not verify the session or uploaded file. Reconnect and try again.',
    },
  ])('rejects print initialization when $name', async ({ prepare, message }) => {
    prepare();
    const { post } = startPrint({ plate_id: 2 });

    expect(await screen.findByText(message)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('error', printRequestId, {
      ...printReceipt,
      queue_item_ids: [],
      message,
    }), '*');
    expect(mocks.themeMounts).toBe(0);
  });

  it('rejects an invalid plate number without using the bridged token', async () => {
    const { post } = startPrint({ plate_id: 0 });
    const message = 'Orca sent invalid print initialization data.';

    expect(await screen.findByText(message)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('error', printRequestId, {
      queue_item_ids: [],
      message,
    }), '*');
    expect(mocks.setAuthToken).not.toHaveBeenCalled();
  });

  it('asks Orca to reconnect when the API rejects an expired token', async () => {
    mocks.getCurrentUser.mockRejectedValue(new ApiError('Token expired', 401));
    const { post } = startPrint();

    expect(await screen.findByText(/Your Grove session expired/)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('session_expired', printRequestId, printReceipt), '*');
    expect(mocks.getLibraryFile).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.clearMemoryAuthTokenOverride).toHaveBeenCalledOnce());
  });

  it.each<{ result: PrintModalResult; event: string; message?: string }>([
    { result: { outcome: 'partial', queueItemIds: [101] }, event: 'partial' },
    { result: { outcome: 'cancelled', queueItemIds: [] }, event: 'cancelled' },
    { result: { outcome: 'session_expired', queueItemIds: [] }, event: 'session_expired' },
    {
      result: { outcome: 'uncertain', queueItemIds: [101] },
      event: 'error',
      message: 'Grove could not confirm whether every queue request was accepted. Check the Grove queue before trying again.',
    },
    {
      result: { outcome: 'failed', queueItemIds: [] },
      event: 'error',
      message: 'Grove could not create the requested queue items.',
    },
  ])('posts one terminal receipt for a $result.outcome result', async ({ result, event, message }) => {
    const { post } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });

    act(() => {
      mocks.printProps?.onResult?.(result);
      mocks.printProps?.onClose();
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope(event, printRequestId, {
      ...printReceipt,
      queue_item_ids: result.queueItemIds,
      ...(message ? { message, outcome: result.outcome } : {}),
    }), '*');
  });

  it('cancels an idle form without reporting a submission', async () => {
    const { post } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });

    sendPrintMessage('cancel_requested');

    expect(await screen.findByText(/Print request cancelled/)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('cancelled', printRequestId, {
      ...printReceipt,
      queue_item_ids: [],
    }), '*');
  });

  it('waits for the active POST to finish when Orca requests cancellation', async () => {
    const { post } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });
    act(() => mocks.printProps?.onSubmissionStateChange?.(true));

    sendPrintMessage('cancel_requested');

    expect(mocks.printProps?.cancelRequested).toBe(true);
    expect(mocks.printProps?.cancelRequestedRef?.current).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);

    act(() => mocks.printProps?.onResult?.({ outcome: 'partial', queueItemIds: [101] }));
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('partial', printRequestId, {
      ...printReceipt,
      queue_item_ids: [101],
    }), '*');
  });

  it('defers an expired-session receipt until the active submission finishes', async () => {
    const { post, refresh } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });
    const setSubmitting = mocks.printProps?.onSubmissionStateChange;
    act(() => setSubmitting?.(true));

    mocks.auth.user = null;
    refresh();

    expect(screen.getByText('Your Grove session is being checked…')).toBeVisible();
    expect(post).toHaveBeenCalledTimes(1);

    act(() => setSubmitting?.(false));
    expect(await screen.findByText(/Your Grove session expired/)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('session_expired', printRequestId, printReceipt), '*');
  });

  it('defers closing the form while a POST is active', async () => {
    const { post } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });
    act(() => mocks.printProps?.onSubmissionStateChange?.(true));

    act(() => mocks.printProps?.onClose());

    expect(mocks.printProps?.cancelRequestedRef?.current).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);

    act(() => mocks.printProps?.onResult?.({ outcome: 'success', queueItemIds: [101] }));
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('submitted', printRequestId, {
      ...printReceipt,
      queue_item_ids: [101],
    }), '*');
  });

  it('reports revoked permissions after mounting the print form', async () => {
    const { post, refresh } = startPrint();
    await screen.findByRole('button', { name: 'Finish mocked print' });

    mocks.auth.user = { ...mocks.operator, permissions: ['library:read_own'] };
    refresh();

    const message = 'Your Grove account is missing permission to use this file or create queue items.';
    expect(await screen.findByText(message)).toBeVisible();
    expect(post).toHaveBeenLastCalledWith(bridgeEnvelope('error', printRequestId, {
      ...printReceipt,
      queue_item_ids: [],
      message,
    }), '*');
  });

  it('returns the normal Grove user JWT through the connect bridge', async () => {
    const { requestId, send } = startConnect();
    expect(mocks.bridgePost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'authenticated' }));

    send('initialize', { mode: 'connect' });

    expect(await screen.findByText(/Grove account connected/)).toBeVisible();
    expect(mocks.bridgePost).toHaveBeenLastCalledWith(bridgeEnvelope('authenticated', requestId, {
      access_token: 'header.payload.signature',
    }));
  });

  it('shows normal Grove sign-in when Orca connects without a session', async () => {
    mocks.auth.user = null;
    const { send } = startConnect();

    send('initialize', { mode: 'connect' });

    expect(await screen.findByText('Grove login')).toBeVisible();
    expect(mocks.bridgePost).toHaveBeenCalledTimes(1);
  });

  it('rejects a remembered token that is not a JWT', async () => {
    mocks.getAuthToken.mockReturnValue('invalid-token');
    const { requestId, send } = startConnect();

    send('initialize', { mode: 'connect' });

    const message = 'Sign in to Grove with an active user account to connect Orca.';
    expect(await screen.findByText(message)).toBeVisible();
    expect(mocks.bridgePost).toHaveBeenLastCalledWith(bridgeEnvelope('error', requestId, { message }));
  });

  it('instructs a normal browser visitor to open Connect in Orca', () => {
    renderIntegration('/integrations/orca?mode=connect&protocol_version=1&request_id=browser');

    expect(screen.getByText('Open this page from Orca to connect a Grove account.')).toBeVisible();
  });

  it('reports Connect cancellation to Orca', async () => {
    const { requestId, send } = startConnect();

    send('cancel_requested');

    expect(await screen.findByText('Grove connection cancelled.')).toBeVisible();
    expect(mocks.bridgePost).toHaveBeenLastCalledWith(bridgeEnvelope('cancelled', requestId));
  });

  it('reports a disabled-authentication error through the Connect bridge', async () => {
    mocks.auth.authEnabled = false;
    const { requestId } = startConnect();
    const message = 'Grove user authentication must be enabled to connect Orca.';

    expect(await screen.findByText(message)).toBeVisible();
    expect(mocks.bridgePost).toHaveBeenLastCalledWith(bridgeEnvelope('error', requestId, { message }));
  });
});
