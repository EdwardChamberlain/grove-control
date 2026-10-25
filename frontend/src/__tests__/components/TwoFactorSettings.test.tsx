/**
 * TwoFactorSettings: authenticator app setup and removal, backup codes,
 * email OTP and linked SSO accounts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setAuthToken } from '../../api/client';
import { server } from '../mocks/server';
import { TwoFactorSettings } from '../../components/TwoFactorSettings';
import { render } from '../utils';

const A = '/api/v1/auth';

function signIn(email: string | null = 'ada@example.com') {
  setAuthToken('test-token');
  server.use(
    http.get(`${A}/status`, () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get(`${A}/me`, () =>
      HttpResponse.json({ id: 1, username: 'ada', email, is_admin: false, groups: [], permissions: [] }),
    ),
  );
}

interface Status {
  totp_enabled: boolean;
  email_otp_enabled: boolean;
  backup_codes_remaining: number;
}

function useTwoFa(initial: Partial<Status> = {}, links: unknown[] = []) {
  const status: Status = { totp_enabled: false, email_otp_enabled: false, backup_codes_remaining: 0, ...initial };
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, body: unknown) => {
    (calls[name] ??= []).push(body);
  };
  server.use(
    http.get(`${A}/2fa/status`, () => HttpResponse.json(status)),
    http.get(`${A}/oidc/links`, () => HttpResponse.json(links)),
    http.post(`${A}/2fa/totp/setup`, () =>
      HttpResponse.json({ secret: 'JBSWY3DPEHPK3PXP', qr_code_b64: 'AAAA', issuer: 'Bambuddy' }),
    ),
    http.post(`${A}/2fa/totp/enable`, async ({ request }) => {
      const body = (await request.json()) as { code: string };
      record('enable', body);
      if (body.code !== '123456') return HttpResponse.json({ detail: 'bad' }, { status: 400 });
      status.totp_enabled = true;
      status.backup_codes_remaining = 2;
      return HttpResponse.json({ message: 'ok', backup_codes: ['AAAA1111', 'BBBB2222'] });
    }),
    http.post(`${A}/2fa/totp/disable`, async ({ request }) => {
      record('disable', await request.json());
      status.totp_enabled = false;
      return HttpResponse.json({ message: 'ok' });
    }),
    http.post(`${A}/2fa/totp/regenerate-backup-codes`, async ({ request }) => {
      record('regen', await request.json());
      return HttpResponse.json({ backup_codes: ['NEWCODE1', 'NEWCODE2'] });
    }),
    http.post(`${A}/2fa/email/enable`, () => {
      record('emailEnable', null);
      return HttpResponse.json({ message: 'Code sent', setup_token: 'tok' });
    }),
    http.post(`${A}/2fa/email/enable/confirm`, async ({ request }) => {
      record('emailConfirm', await request.json());
      status.email_otp_enabled = true;
      return HttpResponse.json({ message: 'ok' });
    }),
    http.post(`${A}/2fa/email/disable`, async ({ request }) => {
      record('emailDisable', await request.json());
      status.email_otp_enabled = false;
      return HttpResponse.json({ message: 'ok' });
    }),
    http.delete(`${A}/oidc/links/:id`, ({ params }) => {
      record('unlink', params.id);
      return HttpResponse.json({ message: 'ok' });
    }),
  );
  return calls;
}

afterEach(() => setAuthToken(null));

describe('authenticator app', () => {
  it('walks through setup, rejects a wrong code, then shows backup codes', async () => {
    signIn();
    const calls = useTwoFa();
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: /Set up Authenticator App/ }));
    expect(await screen.findByAltText('TOTP QR Code')).toBeInTheDocument();
    expect(screen.queryByText('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();

    // Reveal and copy the secret.
    const secretButtons = screen.getByText('••••••••••••••••').parentElement!.querySelectorAll('button');
    await user.click(secretButtons[0]);
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.click(secretButtons[1]);
    expect(await navigator.clipboard.readText()).toBe('JBSWY3DPEHPK3PXP');

    await user.click(screen.getByRole('button', { name: /continue/ }));
    const activate = screen.getByRole('button', { name: 'Activate' });
    expect(activate).toBeDisabled();

    // Back returns to the QR step, then forward again.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: /continue/ }));

    const input = screen.getByPlaceholderText('000000');
    await user.type(input, '999999');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Invalid code. Please try again.')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '123456');
    await user.click(screen.getByRole('button', { name: 'Activate' }));

    expect(await screen.findByText('Save your backup codes')).toBeInTheDocument();
    expect(screen.getByText('AAAA1111')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('AAAA1111\nBBBB2222');
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /saved my codes/ }));
    expect(await screen.findByText('2 backup codes remaining')).toBeInTheDocument();
    expect(calls.enable).toHaveLength(2);
  });

  it('closes the setup wizard with the X button', async () => {
    signIn();
    useTwoFa();
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: /Set up Authenticator App/ }));
    await screen.findByAltText('TOTP QR Code');
    const heading = screen.getByRole('heading', { level: 4, name: 'Set up Authenticator App' });
    await user.click(heading.parentElement!.querySelector('button')!);

    expect(screen.queryByAltText('TOTP QR Code')).not.toBeInTheDocument();
  });

  it('regenerates backup codes', async () => {
    signIn();
    const calls = useTwoFa({ totp_enabled: true, backup_codes_remaining: 3 });
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Regenerate Backup Codes' }));
    // Cancel once, then reopen.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Regenerate Backup Codes' }));

    await user.type(screen.getByPlaceholderText('000000 or XXXXXXXX'), 'abcdef12');
    await user.click(screen.getByRole('button', { name: 'Regenerate Backup Codes' }));

    expect(await screen.findByText('New backup codes')).toBeInTheDocument();
    expect(screen.getByText('NEWCODE1')).toBeInTheDocument();
    // Codes are upper-cased as they are typed.
    expect(calls.regen).toEqual([{ code: 'ABCDEF12' }]);

    await user.click(screen.getByRole('button', { name: /saved my codes/ }));
    expect(screen.queryByText('NEWCODE1')).not.toBeInTheDocument();
  });

  it('disables the authenticator', async () => {
    signIn();
    const calls = useTwoFa({ totp_enabled: true, backup_codes_remaining: 3 });
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Disable Authenticator' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Disable Authenticator' }));

    await user.type(screen.getByPlaceholderText('000000 or XXXXXXXX'), '654 321');
    await user.click(screen.getByRole('button', { name: 'Disable Authenticator' }));

    expect(await screen.findByText('Authenticator app disabled.')).toBeInTheDocument();
    expect(calls.disable).toEqual([{ code: '654321' }]);
  });

  it('reports a wrong code when disabling or regenerating', async () => {
    signIn();
    useTwoFa({ totp_enabled: true, backup_codes_remaining: 3 });
    server.use(
      http.post(`${A}/2fa/totp/disable`, () => HttpResponse.json({ detail: 'bad' }, { status: 400 })),
      http.post(`${A}/2fa/totp/regenerate-backup-codes`, () => HttpResponse.json({ detail: 'bad' }, { status: 400 })),
    );
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Disable Authenticator' }));
    await user.type(screen.getByPlaceholderText('000000 or XXXXXXXX'), '000000');
    await user.click(screen.getByRole('button', { name: 'Disable Authenticator' }));
    expect(await screen.findByText('Invalid code. Please try again.')).toBeInTheDocument();
  });
});

describe('email OTP', () => {
  it('asks for an email address first', async () => {
    signIn(null);
    useTwoFa();
    render(<TwoFactorSettings />);

    expect(await screen.findByText(/no email address/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable Email OTP' })).not.toBeInTheDocument();
  });

  it('enables after confirming the emailed code', async () => {
    signIn();
    const calls = useTwoFa();
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    expect(await screen.findByText(/ada@example.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable Email OTP' }));
    expect(await screen.findByText('Code sent')).toBeInTheDocument();

    // Cancel drops the token; request again.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Enable Email OTP' }));

    await user.type(await screen.findByPlaceholderText('000000'), '112233');
    await user.click(screen.getByRole('button', { name: 'Verify & Enable' }));

    expect(await screen.findByText('Email OTP enabled.')).toBeInTheDocument();
    expect(calls.emailEnable).toHaveLength(2);
    expect(calls.emailConfirm).toEqual([{ setup_token: 'tok', code: '112233' }]);
  });

  it.each([
    ['SMTP not configured', 'Please configure and test SMTP settings first.'],
    ['Something else broke', 'Something else broke'],
  ])('shows the error when requesting a code fails (%s)', async (detail, toast) => {
    signIn();
    useTwoFa();
    server.use(http.post(`${A}/2fa/email/enable`, () => HttpResponse.json({ detail }, { status: 400 })));
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Enable Email OTP' }));

    expect(await screen.findByText(toast)).toBeInTheDocument();
  });

  it('shows the error when the emailed code is wrong', async () => {
    signIn();
    useTwoFa();
    server.use(
      http.post(`${A}/2fa/email/enable/confirm`, () => HttpResponse.json({ detail: 'Code expired' }, { status: 400 })),
    );
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Enable Email OTP' }));
    await user.type(await screen.findByPlaceholderText('000000'), '112233');
    await user.click(screen.getByRole('button', { name: 'Verify & Enable' }));

    expect(await screen.findByText('Code expired')).toBeInTheDocument();
  });

  it('disables with the account password', async () => {
    signIn();
    const calls = useTwoFa({ email_otp_enabled: true });
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Disable Email OTP' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Disable Email OTP' }));

    const password = screen.getByPlaceholderText('Enter your password');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(password.parentElement!.querySelector('button')!);
    expect(password).toHaveAttribute('type', 'text');

    await user.type(password, 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Disable Email OTP' }));

    expect(await screen.findByText('Email OTP disabled.')).toBeInTheDocument();
    expect(calls.emailDisable).toEqual([{ password: 'hunter22' }]);
  });

  it('shows the error when the password is wrong', async () => {
    signIn();
    useTwoFa({ email_otp_enabled: true });
    server.use(http.post(`${A}/2fa/email/disable`, () => HttpResponse.json({ detail: 'Wrong password' }, { status: 400 })));
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    await user.click(await screen.findByRole('button', { name: 'Disable Email OTP' }));
    await user.type(screen.getByPlaceholderText('Enter your password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Disable Email OTP' }));

    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
  });
});

describe('linked SSO accounts', () => {
  const links = [
    { id: 1, provider_id: 5, provider_name: 'Authentik', provider_email: 'ada@sso.example', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, provider_id: 6, provider_name: 'Keycloak', provider_email: null, created_at: '2026-01-01T00:00:00Z' },
  ];

  it('lists links and unlinks one', async () => {
    signIn();
    const calls = useTwoFa({}, links);
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    expect(await screen.findByText('Linked SSO Accounts')).toBeInTheDocument();
    expect(screen.getByText('ada@sso.example')).toBeInTheDocument();
    const row = screen.getByText('Keycloak').closest('div')!.parentElement!;
    await user.click(row.querySelector('button')!);

    await waitFor(() => expect(calls.unlink).toEqual(['6']));
    expect(await screen.findByText('Account unlinked.')).toBeInTheDocument();
  });

  it('shows the error when unlinking fails', async () => {
    signIn();
    useTwoFa({}, links);
    server.use(http.delete(`${A}/oidc/links/:id`, () => HttpResponse.json({ detail: 'Last login method' }, { status: 400 })));
    const user = userEvent.setup();
    render(<TwoFactorSettings />);

    const row = (await screen.findByText('Authentik')).closest('div')!.parentElement!;
    await user.click(row.querySelector('button')!);

    expect(await screen.findByText('Last login method')).toBeInTheDocument();
  });

  it('hides the card when nothing is linked', async () => {
    signIn();
    useTwoFa();
    render(<TwoFactorSettings />);

    await screen.findByText('Authenticator App (TOTP)');
    expect(screen.queryByText('Linked SSO Accounts')).not.toBeInTheDocument();
  });
});
