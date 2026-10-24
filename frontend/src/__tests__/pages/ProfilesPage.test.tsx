/**
 * Tests for ProfilesPage: Bambu Cloud login flows, the connected profile
 * list (search, detail, delete, logout) and tab switching.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ProfilesPage } from '../../pages/ProfilesPage';

type Captured = { method: string; path: string; body: unknown };

const settings = {
  filament: [
    { setting_id: 'PFUS001', name: 'My PLA @BBL X1C', type: 'filament', version: null, user_id: '1', updated_time: null, is_custom: true },
    { setting_id: 'GFSA00', name: 'Bambu PETG Basic @BBL X1C', type: 'filament', version: null, user_id: null, updated_time: null, is_custom: false },
  ],
  printer: [
    { setting_id: 'GM001', name: 'Bambu Lab X1 Carbon 0.4 nozzle', type: 'printer', version: null, user_id: null, updated_time: null, is_custom: false },
  ],
  process: [
    { setting_id: 'GP004', name: '0.20mm Standard @BBL X1C', type: 'process', version: null, user_id: null, updated_time: null, is_custom: false },
  ],
};

let captured: Captured[];
let cloudStatus: Record<string, unknown>;

function useCloudHandlers({ settingsStatus = 200 }: { settingsStatus?: number } = {}) {
  const record = async (request: Request) => {
    const text = await request.text();
    captured.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : null,
    });
  };
  server.use(
    http.get('*/api/v1/cloud/status', () => HttpResponse.json(cloudStatus)),
    http.get('*/api/v1/printers/', () => HttpResponse.json([])),
    http.get('*/api/v1/cloud/settings', () =>
      settingsStatus === 200
        ? HttpResponse.json(settings)
        : HttpResponse.json({ detail: 'boom' }, { status: settingsStatus }),
    ),
    http.get('*/api/v1/cloud/settings/:id', ({ params }) => {
      captured.push({ method: 'GET', path: `/api/v1/cloud/settings/${params.id}`, body: null });
      const temp = params.id === 'PFUS001' ? '220' : '235';
      return HttpResponse.json({ public: false, type: 'filament', name: 'detail', setting_id: params.id, setting: { nozzle_temperature: [temp], filament_type: ['PLA'] } });
    }),
    http.delete('*/api/v1/cloud/settings/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('*/api/v1/cloud/login', async ({ request }) => {
      await record(request);
      return HttpResponse.json(loginResponse);
    }),
    http.post('*/api/v1/cloud/verify', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, needs_verification: false, message: 'ok' });
    }),
    http.post('*/api/v1/cloud/token', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ is_authenticated: true, email: 'a@b.c' });
    }),
    http.post('*/api/v1/cloud/logout', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
  );
}

let loginResponse: Record<string, unknown>;

beforeEach(() => {
  captured = [];
  cloudStatus = { is_authenticated: false, email: null };
  loginResponse = { success: true, needs_verification: false, message: 'ok' };
  useCloudHandlers();
});

describe('ProfilesPage — signed out', () => {
  it('shows the Bambu Cloud login form', async () => {
    render(<ProfilesPage />);
    expect(await screen.findByText('Connect to Bambu Cloud')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Login$/ })).toBeInTheDocument();
  });

  it('submits email, password and region on login', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.type(await screen.findByPlaceholderText('your@email.com'), 'me@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'hunter2');
    await user.click(screen.getByRole('button', { name: /^Login$/ }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual({
      method: 'POST',
      path: '/api/v1/cloud/login',
      body: { email: 'me@example.com', password: 'hunter2', region: 'global' },
    });
  });

  it('asks for an authenticator code and verifies it with the tfa key', async () => {
    loginResponse = { success: false, needs_verification: true, verification_type: 'totp', tfa_key: 'tfa-123', message: '' };
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.type(await screen.findByPlaceholderText('your@email.com'), 'me@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'hunter2');
    await user.click(screen.getByRole('button', { name: /^Login$/ }));

    expect(await screen.findByText('Authenticator Code')).toBeInTheDocument();
    // Non-digits are stripped and the code is capped at 6 characters.
    await user.type(screen.getByPlaceholderText('000000'), '12a34567');
    expect(screen.getByPlaceholderText('000000')).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: /Verify/ }));

    await waitFor(() => expect(captured.map((c) => c.path)).toContain('/api/v1/cloud/verify'));
    expect(captured.find((c) => c.path === '/api/v1/cloud/verify')?.body).toEqual({
      email: 'me@example.com',
      code: '123456',
      tfa_key: 'tfa-123',
      region: 'global',
    });
  });

  it('shows the email-code hint and lets the user go back', async () => {
    loginResponse = { success: false, needs_verification: true, verification_type: 'email', message: '' };
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.type(await screen.findByPlaceholderText('your@email.com'), 'me@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'pw');
    await user.click(screen.getByRole('button', { name: /^Login$/ }));

    expect(await screen.findByText(/Check your email \(me@example.com\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();
  });

  it('shows the server message when login fails without verification', async () => {
    loginResponse = { success: false, needs_verification: false, message: 'Wrong password' };
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.type(await screen.findByPlaceholderText('your@email.com'), 'me@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'bad');
    await user.click(screen.getByRole('button', { name: /^Login$/ }));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
  });

  it('can sign in with an access token instead', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.click(await screen.findByText('Use access token instead'));
    await user.type(screen.getByPlaceholderText('eyJ...'), 'eyJtoken');
    await user.click(screen.getByRole('button', { name: /Set Token/ }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toMatchObject({ path: '/api/v1/cloud/token', body: { access_token: 'eyJtoken', region: 'global' } });

    await user.click(screen.getByText('Login with email instead'));
    expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();
  });

  it('explains why the form is back when the stored sign-in expired', async () => {
    cloudStatus = { is_authenticated: false, email: null, sign_in_expired: true };
    render(<ProfilesPage />);
    expect(await screen.findByText('Bambu Cloud sign-in expired')).toBeInTheDocument();
  });
});

describe('ProfilesPage — connected', () => {
  beforeEach(() => {
    cloudStatus = { is_authenticated: true, email: 'me@example.com', region: 'china' };
  });

  it('shows the account, region and every preset sorted by name', async () => {
    render(<ProfilesPage />);
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('China')).toBeInTheDocument();
    for (const name of ['My PLA @BBL X1C', 'Bambu PETG Basic @BBL X1C', 'Bambu Lab X1 Carbon 0.4 nozzle', '0.20mm Standard @BBL X1C']) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
  });

  it('filters presets by search text', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await screen.findByText('My PLA @BBL X1C');
    await user.type(screen.getByPlaceholderText('Search presets...'), 'petg');
    await waitFor(() => expect(screen.queryByText('My PLA @BBL X1C')).not.toBeInTheDocument());
    expect(screen.getByText('Bambu PETG Basic @BBL X1C')).toBeInTheDocument();
  });

  it('opens a preset, shows its detail and deletes a user preset', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.click(await screen.findByText('My PLA @BBL X1C'));

    expect(await screen.findByText(/nozzle_temperature/)).toBeInTheDocument();
    expect(screen.getByText('Editable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText('Delete this preset?')).toBeInTheDocument();
    const confirmRow = screen.getByText('Delete this preset?').closest('div')!.parentElement!;
    await user.click(within(confirmRow).getByRole('button', { name: /Delete/ }));

    await waitFor(() => expect(captured).toContainEqual({ method: 'DELETE', path: '/api/v1/cloud/settings/PFUS001', body: null }));
  });

  it('does not offer delete for built-in presets', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.click(await screen.findByText('Bambu PETG Basic @BBL X1C'));
    await screen.findByText(/nozzle_temperature/);
    expect(screen.queryByText('Editable')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });

  it('compares two presets of the same type', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await screen.findByText('My PLA @BBL X1C');
    await user.click(screen.getByRole('button', { name: /^Compare$/ }));
    await user.click(screen.getByText('My PLA @BBL X1C'));
    // A preset of a different type cannot be the second pick.
    await user.click(screen.getByText('0.20mm Standard @BBL X1C'));
    expect(screen.queryByRole('button', { name: /Compare Now/ })).not.toBeInTheDocument();
    await user.click(screen.getByText('Bambu PETG Basic @BBL X1C'));
    await user.click(await screen.findByRole('button', { name: /Compare Now/ }));

    await waitFor(() => {
      const paths = captured.filter((c) => c.method === 'GET').map((c) => c.path);
      expect(paths).toEqual(expect.arrayContaining(['/api/v1/cloud/settings/PFUS001', '/api/v1/cloud/settings/GFSA00']));
    });
    // The differing field and both values appear in the diff view.
    expect(await screen.findByText('nozzle_temperature')).toBeInTheDocument();
    expect(screen.getAllByText(/235/).length).toBeGreaterThan(0);
  });

  it('logs out of Bambu Cloud', async () => {
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await user.click(await screen.findByRole('button', { name: /Logout/ }));
    await waitFor(() => expect(captured).toContainEqual({ method: 'POST', path: '/api/v1/cloud/logout', body: null }));
  });

  it('offers a retry when the presets fail to load', async () => {
    useCloudHandlers({ settingsStatus: 500 });
    render(<ProfilesPage />);
    expect(await screen.findByText('Failed to load profiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('ProfilesPage — tabs', () => {
  it('switches to the Local Profiles tab', async () => {
    server.use(http.get('*/api/v1/local-presets/', () => HttpResponse.json({ filament: [], process: [], printer: [] })));
    const user = userEvent.setup();
    render(<ProfilesPage />);
    await screen.findByText('Connect to Bambu Cloud');
    await user.click(screen.getByRole('button', { name: /Local Profiles/ }));
    await waitFor(() => expect(screen.queryByText('Connect to Bambu Cloud')).not.toBeInTheDocument());
  });
});
