/**
 * LDAPSettings: loading saved settings, validation, saving, enabling and
 * disabling LDAP, and testing the connection.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setAuthToken } from '../../api/client';
import { server } from '../mocks/server';
import { LDAPSettings } from '../../components/LDAPSettings';
import { render } from '../utils';

function useLdap({
  authEnabled = true,
  settings = {},
  status = { ldap_enabled: false, ldap_configured: false },
}: {
  authEnabled?: boolean;
  settings?: Record<string, unknown>;
  status?: { ldap_enabled: boolean; ldap_configured: boolean };
} = {}) {
  const puts: Record<string, unknown>[] = [];
  if (authEnabled) setAuthToken('test-token');
  server.use(
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: authEnabled, requires_setup: false })),
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({ id: 1, username: 'admin', is_admin: true, groups: [], permissions: [] }),
    ),
    http.get('/api/v1/settings/', () => HttpResponse.json(settings)),
    http.get('/api/v1/auth/ldap/status', () => HttpResponse.json(status)),
    http.get('/api/v1/groups/', () =>
      HttpResponse.json([
        { id: 1, name: 'Administrators' },
        { id: 2, name: 'Operators' },
      ]),
    ),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      puts.push(body);
      return HttpResponse.json({ ...settings, ...body });
    }),
  );
  return puts;
}

afterEach(() => setAuthToken(null));

describe('LDAPSettings', () => {
  it('requires a server URL and search base before saving', async () => {
    const puts = useLdap();
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.click(await screen.findByRole('button', { name: /Save/ }));
    expect(await screen.findByText('LDAP server URL is required')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('ldaps://ldap.example.com:636'), 'ldap://dc1');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Search base DN is required')).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('saves the form, including the advanced options', async () => {
    const puts = useLdap();
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.type(await screen.findByPlaceholderText('ldaps://ldap.example.com:636'), 'ldaps://dc1');
    await user.click(screen.getByRole('button', { name: 'LDAPS' }));
    await user.type(screen.getByPlaceholderText(/cn=service-account/), 'cn=svc');
    await user.type(screen.getByPlaceholderText('ou=users,dc=example,dc=com'), 'dc=corp');
    const filter = screen.getByPlaceholderText('(sAMAccountName={username})');
    await user.clear(filter);
    await user.type(filter, '(uid={{username})');

    await user.click(screen.getByText('Advanced'));
    const autoProvision = screen.getByText('Auto-provision users').closest('div')!.parentElement!.querySelector('button')!;
    await user.click(autoProvision);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Operators' }));
    await user.type(document.querySelector('textarea')!, '{{}');

    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      ldap_server_url: 'ldaps://dc1',
      ldap_bind_dn: 'cn=svc',
      ldap_search_base: 'dc=corp',
      ldap_user_filter: '(uid={username})',
      ldap_security: 'ldaps',
      ldap_group_mapping: '{}',
      ldap_auto_provision: true,
      ldap_default_group: 'Operators',
    });
    expect(await screen.findByText('LDAP settings saved')).toBeInTheDocument();
  });

  it('loads saved settings and only sends a password when one is typed', async () => {
    const puts = useLdap({
      settings: {
        ldap_server_url: 'ldap://saved',
        ldap_bind_dn: 'cn=saved',
        ldap_search_base: 'dc=saved',
        ldap_security: 'starttls',
      },
    });
    const user = userEvent.setup();
    render(<LDAPSettings />);

    expect(await screen.findByDisplayValue('ldap://saved')).toBeInTheDocument();
    const password = screen.getByPlaceholderText('••••••••');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('ldap_bind_password');

    await user.type(password, 's3cret');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].ldap_bind_password).toBe('s3cret');
  });

  it('shows the error when saving fails', async () => {
    useLdap({ settings: { ldap_server_url: 'ldap://x', ldap_search_base: 'dc=x' } });
    server.use(http.put('/api/v1/settings/', () => HttpResponse.json({ detail: 'Invalid mapping' }, { status: 400 })));
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await screen.findByDisplayValue('ldap://x');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Invalid mapping')).toBeInTheDocument();
  });

  it('refuses to enable without authentication', async () => {
    useLdap({ authEnabled: false });
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.click(await screen.findByRole('button', { name: /^Enable$/ }));

    expect(await screen.findByText('Enable authentication first')).toBeInTheDocument();
  });

  it('refuses to enable before LDAP is configured', async () => {
    const puts = useLdap();
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.click(await screen.findByRole('button', { name: /^Enable$/ }));

    expect(await screen.findByText('Save LDAP settings first')).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('enables a configured server', async () => {
    const puts = useLdap({ status: { ldap_enabled: false, ldap_configured: true } });
    const user = userEvent.setup();
    render(<LDAPSettings />);

    expect(await screen.findByText('LDAP authentication is disabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Enable$/ }));

    await waitFor(() => expect(puts).toEqual([{ ldap_enabled: true }]));
    expect(await screen.findByText('LDAP authentication enabled')).toBeInTheDocument();
  });

  it('disables an enabled server', async () => {
    const puts = useLdap({ status: { ldap_enabled: true, ldap_configured: true } });
    const user = userEvent.setup();
    render(<LDAPSettings />);

    expect(await screen.findByText('LDAP authentication is enabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Disable$/ }));

    await waitFor(() => expect(puts).toEqual([{ ldap_enabled: false }]));
    expect(await screen.findByText('LDAP authentication disabled')).toBeInTheDocument();
  });

  it('shows the error when toggling fails', async () => {
    useLdap({ status: { ldap_enabled: false, ldap_configured: true } });
    server.use(http.put('/api/v1/settings/', () => HttpResponse.json({ detail: 'Nope' }, { status: 500 })));
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.click(await screen.findByRole('button', { name: /^Enable$/ }));

    expect(await screen.findByText('Nope')).toBeInTheDocument();
  });

  it.each([
    [{ success: true, message: 'Connected as cn=svc' }, 200, 'Connected as cn=svc'],
    [{ success: false, message: 'Bind failed' }, 200, 'Bind failed'],
    [{ detail: 'Server unreachable' }, 500, 'Server unreachable'],
  ])('reports the connection test result (%#)', async (body, status, toast) => {
    useLdap();
    server.use(http.post('/api/v1/auth/ldap/test', () => HttpResponse.json(body, { status })));
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.click(await screen.findByRole('button', { name: /Test Connection/ }));

    expect(await screen.findByText(toast)).toBeInTheDocument();
  });
});
