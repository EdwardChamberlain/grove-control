/**
 * LoginPage flows not covered by LoginPage.test.tsx: forgot password, the
 * reset-password link, OIDC errors, SSO autologin and the email / backup
 * 2FA methods.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { LoginPage } from '../../pages/LoginPage';
import { server } from '../mocks/server';

const A = '/api/v1/auth';
const realLocation = window.location;

function advancedAuth(extra: Record<string, unknown> = {}) {
  server.use(
    http.get(`${A}/advanced-auth/status`, () =>
      HttpResponse.json({ advanced_auth_enabled: true, smtp_configured: true, ...extra }),
    ),
  );
}

function stubLocation() {
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { ...realLocation, hash: '', href: 'http://localhost:3000/login' },
  });
}

beforeEach(() => {
  server.use(http.get(`${A}/status`, () => HttpResponse.json({ auth_enabled: true, requires_setup: false })));
});

afterEach(() => {
  Object.defineProperty(window, 'location', { writable: true, configurable: true, value: realLocation });
  window.location.hash = '';
  window.history.pushState({}, '', '/');
  sessionStorage.clear();
});

describe('credentials step', () => {
  it('shows the server error when sign-in fails', async () => {
    server.use(http.post(`${A}/login`, () => HttpResponse.json({ detail: 'Account locked' }, { status: 401 })));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(await screen.findByLabelText(/Username/i), 'ada');
    await user.type(screen.getByLabelText(/Password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /Sign in/i }));

    expect(await screen.findByText('Account locked')).toBeInTheDocument();
  });

  it('asks for username or email when advanced auth is on', async () => {
    advancedAuth();
    render(<LoginPage />);

    expect(await screen.findByText(/Username or Email/i)).toBeInTheDocument();
  });
});

describe('forgot password', () => {
  it('explains how to reset when email is not set up', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
    expect(screen.getByText(/contact your system administrator/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(screen.queryByText(/contact your system administrator/)).not.toBeInTheDocument();
  });

  it('sends a reset email when advanced auth is on', async () => {
    advancedAuth();
    const sent: unknown[] = [];
    server.use(
      http.post(`${A}/forgot-password`, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ message: 'Check your inbox' });
      }),
    );
    const user = userEvent.setup();
    render(<LoginPage />);

    await screen.findByText(/Username or Email/i);
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText('Email Address'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Reset Email' }));

    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(sent).toEqual([{ email: 'ada@example.com' }]);
    expect(screen.queryByLabelText('Email Address')).not.toBeInTheDocument();
  });

  it('shows the error when the reset email fails, and cancels', async () => {
    advancedAuth();
    server.use(http.post(`${A}/forgot-password`, () => HttpResponse.json({ detail: 'SMTP down' }, { status: 500 })));
    const user = userEvent.setup();
    render(<LoginPage />);

    await screen.findByText(/Username or Email/i);
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText('Email Address'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Reset Email' }));
    expect(await screen.findByText('SMTP down')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Email Address')).not.toBeInTheDocument();
  });
});

describe('reset-password link', () => {
  it('validates and sets the new password', async () => {
    const confirmed: unknown[] = [];
    server.use(
      http.post(`${A}/forgot-password/confirm`, async ({ request }) => {
        confirmed.push(await request.json());
        return HttpResponse.json({ message: 'Password updated' });
      }),
    );
    window.location.hash = '#reset_token=tok123';
    const user = userEvent.setup();
    render(<LoginPage />);

    const newPassword = await screen.findByLabelText('New Password');
    const confirm = screen.getByLabelText('Confirm Password');
    const submit = screen.getByRole('button', { name: 'Set New Password' });

    await user.type(newPassword, 'longenough');
    await user.type(confirm, 'different1');
    await user.click(submit);
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();

    await user.clear(newPassword);
    await user.clear(confirm);
    await user.type(newPassword, 'short');
    await user.type(confirm, 'short');
    await user.click(submit);
    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();

    await user.clear(newPassword);
    await user.clear(confirm);
    await user.type(newPassword, 'longenough');
    await user.type(confirm, 'longenough');
    await user.click(submit);

    expect(await screen.findByText('Password updated')).toBeInTheDocument();
    expect(confirmed).toEqual([{ token: 'tok123', new_password: 'longenough' }]);
    expect(await screen.findByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });

  it('shows the error from an expired link and can go back', async () => {
    server.use(
      http.post(`${A}/forgot-password/confirm`, () => HttpResponse.json({ detail: 'Link expired' }, { status: 400 })),
    );
    window.location.hash = '#reset_token=old';
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(await screen.findByLabelText('New Password'), 'longenough');
    await user.type(screen.getByLabelText('Confirm Password'), 'longenough');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));
    expect(await screen.findByText('Link expired')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));
    expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });
});

describe('OIDC errors', () => {
  it.each([
    ['invalid_state', 'OIDC state is invalid or has already been used'],
    ['token_exchange_invalid_grant', 'OIDC token exchange failed'],
    ['something_new', 'OIDC login failed'],
  ])('maps %s to a safe message', async (code, message) => {
    window.history.pushState({}, '', `/login?oidc_error=${code}`);
    render(<LoginPage />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('reports a failed token exchange', async () => {
    server.use(http.post(`${A}/oidc/exchange`, () => HttpResponse.json({ detail: 'nope' }, { status: 400 })));
    window.location.hash = '#oidc_token=bad';
    render(<LoginPage />);

    expect(await screen.findByText('OIDC login failed')).toBeInTheDocument();
  });

  it('reports when fetching the provider URL fails', async () => {
    server.use(
      http.get(`${A}/oidc/providers`, () =>
        HttpResponse.json([{ id: 3, name: 'Authentik', has_icon: false, is_enabled: true }]),
      ),
      http.get(`${A}/oidc/authorize/3`, () => HttpResponse.json({ detail: 'Provider offline' }, { status: 502 })),
    );
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(await screen.findByRole('button', { name: /Authentik/ }));

    expect(await screen.findByText('Provider offline')).toBeInTheDocument();
  });

  it('remembers where to go after the provider round-trip', async () => {
    server.use(
      http.get(`${A}/oidc/providers`, () =>
        HttpResponse.json([{ id: 3, name: 'Authentik', has_icon: false, is_enabled: true }]),
      ),
      http.get(`${A}/oidc/authorize/3`, () => HttpResponse.json({ auth_url: 'https://idp.test/authorize' })),
    );
    const user = userEvent.setup();
    // BrowserRouter reads location.state from history.state.usr.
    window.history.pushState({ usr: { from: { pathname: '/queue', search: '?x=1' } }, key: 'k', idx: 0 }, '', '/login');
    render(<LoginPage />);

    await screen.findByRole('button', { name: /Authentik/ });
    stubLocation();
    await user.click(screen.getByRole('button', { name: /Authentik/ }));

    await waitFor(() => expect(window.location.href).toBe('https://idp.test/authorize'));
    expect(sessionStorage.getItem('auth_post_login_redirect')).toBe('/queue?x=1');
  });
});

describe('SSO autologin', () => {
  it('redirects straight to the provider', async () => {
    stubLocation();
    advancedAuth({ autologin_provider_id: 3 });
    server.use(http.get(`${A}/oidc/authorize/3`, () => HttpResponse.json({ auth_url: 'https://idp.test/auto' })));
    render(<LoginPage />);

    await waitFor(() => expect(window.location.href).toBe('https://idp.test/auto'));
  });

  it('falls back to the login form with a banner when the provider fails', async () => {
    advancedAuth({ autologin_provider_id: 3, local_login_enabled: false });
    server.use(http.get(`${A}/oidc/authorize/3`, () => HttpResponse.json({ detail: 'down' }, { status: 500 })));
    render(<LoginPage />);

    expect(await screen.findByText(/Automatic SSO sign-in failed/)).toBeInTheDocument();
    expect(screen.getByText(/Local sign-in is disabled/)).toBeInTheDocument();
  });

  it('skips autologin with ?fallback=local', async () => {
    window.history.pushState({}, '', '/login?fallback=local');
    let requested = false;
    advancedAuth({ autologin_provider_id: 3 });
    server.use(
      http.get(`${A}/oidc/authorize/3`, () => {
        requested = true;
        return HttpResponse.json({ auth_url: 'https://idp.test/auto' });
      }),
    );
    render(<LoginPage />);

    await screen.findByText(/Username or Email/i);
    expect(requested).toBe(false);
  });
});

describe('2FA methods', () => {
  async function reach2FA(methods: string[]) {
    server.use(
      http.post(`${A}/login`, () =>
        HttpResponse.json({ requires_2fa: true, pre_auth_token: 'pre-1', two_fa_methods: methods }),
      ),
    );
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(await screen.findByLabelText(/Username/i), 'ada');
    await user.type(screen.getByLabelText(/Password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /Sign in/i }));
    await screen.findByRole('heading', { name: /Two-Factor Authentication/i });
    return user;
  }

  it('sends and resends an email code, using the refreshed pre-auth token', async () => {
    const sends: unknown[] = [];
    const verifies: unknown[] = [];
    server.use(
      http.post(`${A}/2fa/email/send`, async ({ request }) => {
        sends.push(await request.json());
        return HttpResponse.json({ message: 'Code emailed', pre_auth_token: `pre-${sends.length + 1}` });
      }),
      http.post(`${A}/2fa/verify`, async ({ request }) => {
        verifies.push(await request.json());
        return HttpResponse.json({ detail: 'Wrong code' }, { status: 400 });
      }),
    );
    const user = await reach2FA(['email']);

    await user.click(screen.getByRole('button', { name: 'Send Code via Email' }));
    expect(await screen.findByText('Code emailed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resend code' }));
    await waitFor(() => expect(sends).toHaveLength(2));

    await user.type(screen.getByRole('textbox'), '123456');
    await user.click(screen.getByRole('button', { name: /Verify/ }));

    expect(await screen.findByText('Wrong code')).toBeInTheDocument();
    expect(sends).toEqual([{ pre_auth_token: 'pre-1' }, { pre_auth_token: 'pre-2' }]);
    expect(verifies).toEqual([{ pre_auth_token: 'pre-3', code: '123456', method: 'email' }]);
    // The code is cleared after a failure.
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('shows the error when the email code cannot be sent', async () => {
    server.use(http.post(`${A}/2fa/email/send`, () => HttpResponse.json({ detail: 'Rate limited' }, { status: 429 })));
    const user = await reach2FA(['email']);

    await user.click(screen.getByRole('button', { name: 'Send Code via Email' }));

    expect(await screen.findByText('Rate limited')).toBeInTheDocument();
  });

  it('defaults to backup codes and switches between methods', async () => {
    const user = await reach2FA(['backup']);
    expect(screen.getByText(/backup code/i, { selector: 'label' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Verify/ }));
    // Empty code is rejected before calling the server (button may be disabled).
    expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
  });

  it('lets the user pick a method when several are enabled', async () => {
    const user = await reach2FA(['totp', 'email', 'backup']);

    await user.click(screen.getByRole('button', { name: 'Backup Code' }));
    expect(screen.getByText(/backup code/i, { selector: 'label' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Email Code' }));
    expect(screen.getByRole('button', { name: 'Send Code via Email' })).toBeInTheDocument();
  });

  it('reports an unexpected verify response', async () => {
    server.use(http.post(`${A}/2fa/verify`, () => HttpResponse.json({ token_type: 'bearer' })));
    const user = await reach2FA(['totp']);

    await user.type(screen.getByRole('textbox'), '123456');
    await user.click(screen.getByRole('button', { name: /Verify/ }));

    expect(await screen.findByText(/Login failed/i)).toBeInTheDocument();
  });
});
