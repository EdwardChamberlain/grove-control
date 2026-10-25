/**
 * UsersPage: creating, editing and deleting users, password resets, the LDAP
 * tab and the permission gate.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setAuthToken } from '../../api/client';
import { server } from '../mocks/server';
import { UsersPage } from '../../pages/UsersPage';
import { render } from '../utils';

const me = {
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  is_active: true,
  is_admin: true,
  auth_source: 'local',
  groups: [{ id: 1, name: 'Administrators' }],
  permissions: ['users:read', 'groups:read'],
  created_at: '2026-01-01T00:00:00Z',
};

const bob = {
  ...me,
  id: 2,
  username: 'bob',
  email: 'bob@example.com',
  is_admin: false,
  is_active: false,
  groups: [{ id: 2, name: 'Operators' }],
  permissions: [],
};

const carol = { ...bob, id: 3, username: 'carol', email: null, is_active: true, groups: [{ id: 4, name: 'Custom' }] };
const dave = { ...bob, id: 4, username: 'dave', groups: [] };

function useUsers({
  permissions = me.permissions,
  advanced = false,
  ldap = false,
}: { permissions?: string[]; advanced?: boolean; ldap?: boolean } = {}) {
  const calls = { created: [] as unknown[], updated: [] as unknown[], deleted: [] as string[], reset: [] as unknown[] };
  setAuthToken('test-token');
  server.use(
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('/api/v1/auth/me', () => HttpResponse.json(permissions.length ? me : { ...me, is_admin: false, groups: [], permissions: [] })),
    http.get('/api/v1/auth/advanced-auth/status', () =>
      HttpResponse.json({ advanced_auth_enabled: advanced, smtp_configured: advanced }),
    ),
    http.get('/api/v1/auth/ldap/status', () => HttpResponse.json({ ldap_enabled: ldap, ldap_configured: ldap })),
    http.get('/api/v1/users/', () => HttpResponse.json([me, bob, carol, dave])),
    http.get('/api/v1/groups/', () =>
      HttpResponse.json([
        { id: 1, name: 'Administrators', is_system: true },
        { id: 2, name: 'Operators', is_system: true },
        { id: 3, name: 'Viewers', is_system: false },
      ]),
    ),
    http.post('/api/v1/users/', async ({ request }) => {
      calls.created.push(await request.json());
      return HttpResponse.json({ ...bob, id: 9 });
    }),
    http.patch('/api/v1/users/:id', async ({ request }) => {
      calls.updated.push(await request.json());
      return HttpResponse.json(bob);
    }),
    http.delete('/api/v1/users/:id', ({ params }) => {
      calls.deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/v1/auth/reset-password', async ({ request }) => {
      calls.reset.push(await request.json());
      return HttpResponse.json({ message: 'Password reset email sent' });
    }),
  );
  return calls;
}

function row(username: string) {
  return screen.getByText(username, { selector: 'td' }).closest('tr') as HTMLElement;
}

afterEach(() => setAuthToken(null));

describe('UsersPage', () => {
  it('lists users with their groups and status', async () => {
    useUsers();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    expect(within(row('bob')).getByText('Inactive')).toBeInTheDocument();
    expect(within(row('carol')).getByText('Custom')).toBeInTheDocument();
    expect(within(row('dave')).getByText('No groups')).toBeInTheDocument();
    // You cannot delete yourself.
    expect(within(row('alice')).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('blocks users without permission', async () => {
    useUsers({ permissions: [] });
    render(<UsersPage />);

    expect(await screen.findByText('You do not have permission to access this page.')).toBeInTheDocument();
  });

  it('creates a user once the passwords match', async () => {
    const calls = useUsers();
    const user = userEvent.setup();
    render(<UsersPage />);

    await user.click(await screen.findByRole('button', { name: /Create User/ }));
    const dialog = screen.getByRole('heading', { name: 'Create User' }).closest('.max-w-md') as HTMLElement;
    const submit = within(dialog).getAllByRole('button', { name: /Create User/ }).pop()!;

    await user.type(within(dialog).getByPlaceholderText('Enter username'), 'erin');
    await user.type(within(dialog).getByPlaceholderText('Enter password'), 'secret1');
    await user.type(within(dialog).getByPlaceholderText('Confirm password'), 'secret2');
    expect(within(dialog).getByText('Passwords do not match')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(within(dialog).getByPlaceholderText('Confirm password'));
    await user.type(within(dialog).getByPlaceholderText('Confirm password'), 'secret1');
    await user.click(within(dialog).getByLabelText(/Operators/));
    await user.click(within(dialog).getByLabelText(/Viewers/));
    await user.click(within(dialog).getByLabelText(/Viewers/));
    await user.click(submit);

    await waitFor(() => expect(calls.created).toEqual([{ username: 'erin', password: 'secret1', group_ids: [2] }]));
    expect(await screen.findByText('User created successfully')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create User' })).not.toBeInTheDocument();
  });

  it('shows the error when creating fails', async () => {
    useUsers();
    server.use(http.post('/api/v1/users/', () => HttpResponse.json({ detail: 'Username taken' }, { status: 400 })));
    const user = userEvent.setup();
    render(<UsersPage />);

    await user.click(await screen.findByRole('button', { name: /Create User/ }));
    await user.type(screen.getByPlaceholderText('Enter username'), 'bob');
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret1');
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret1');
    await user.click(screen.getAllByRole('button', { name: /Create User/ }).pop()!);

    expect(await screen.findByText('Username taken')).toBeInTheDocument();
  });

  it.each([
    ['the cancel button', async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Escape', async () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['the backdrop', async (user: ReturnType<typeof userEvent.setup>) => user.click(document.querySelector('.fixed.inset-0')!)],
  ])('closes the create dialog with %s', async (_, close) => {
    useUsers();
    const user = userEvent.setup();
    render(<UsersPage />);

    await user.click(await screen.findByRole('button', { name: /Create User/ }));
    await close(user);

    await waitFor(() => expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument());
  });

  it('switches to the LDAP tab when LDAP is enabled', async () => {
    useUsers({ ldap: true });
    const user = userEvent.setup();
    render(<UsersPage />);

    await user.click(await screen.findByRole('button', { name: /Create User/ }));
    await user.click(await screen.findByRole('tab', { name: 'LDAP' }));
    expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a username, name, or email...')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Local' }));
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'LDAP' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('tab', { name: 'LDAP' })).not.toBeInTheDocument();
  });

  it('edits a user, checking the new password', async () => {
    const calls = useUsers();
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    await user.click(within(row('bob')).getByRole('button', { name: /Edit/ }));
    expect(screen.getByDisplayValue('bob@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText(/Operators/)).toBeChecked();

    const save = screen.getByRole('button', { name: /Save Changes/ });
    await user.type(screen.getByPlaceholderText('Enter new password'), 'abc');
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'abd');
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Enter new password'));
    await user.type(screen.getByPlaceholderText('Enter new password'), 'abcdef');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'abcdef');
    await user.clear(screen.getByDisplayValue('bob@example.com'));
    await user.click(screen.getByLabelText(/Viewers/));
    await user.click(save);

    await waitFor(() =>
      expect(calls.updated).toEqual([{ username: 'bob', password: 'abcdef', group_ids: [2, 3] }]),
    );
    expect(await screen.findByText('User updated successfully')).toBeInTheDocument();
  });

  it('closes the edit dialog with the X, Escape and the backdrop', async () => {
    useUsers();
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });

    await user.click(within(row('bob')).getByRole('button', { name: /Edit/ }));
    await user.click(screen.getByRole('heading', { name: 'Edit User' }).parentElement!.parentElement!.querySelector('button')!);
    expect(screen.queryByRole('heading', { name: 'Edit User' })).not.toBeInTheDocument();

    await user.click(within(row('bob')).getByRole('button', { name: /Edit/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Edit User' })).not.toBeInTheDocument());

    await user.click(within(row('bob')).getByRole('button', { name: /Edit/ }));
    await user.click(document.querySelector('.fixed.inset-0')!);
    expect(screen.queryByRole('heading', { name: 'Edit User' })).not.toBeInTheDocument();
  });

  it('shows the error when saving fails', async () => {
    useUsers();
    server.use(http.patch('/api/v1/users/:id', () => HttpResponse.json({ detail: 'Cannot edit' }, { status: 400 })));
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('carol', { selector: 'td' });
    await user.click(within(row('carol')).getByRole('button', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));

    expect(await screen.findByText('Cannot edit')).toBeInTheDocument();
  });

  it('deletes a user after confirmation', async () => {
    const calls = useUsers();
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    await user.click(within(row('bob')).getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.deleted).toEqual([]);

    await user.click(within(row('bob')).getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Delete User' }));

    await waitFor(() => expect(calls.deleted).toEqual(['2']));
    expect(await screen.findByText('User deleted successfully')).toBeInTheDocument();
  });

  it('shows the error when deleting fails', async () => {
    useUsers();
    server.use(http.delete('/api/v1/users/:id', () => HttpResponse.json({ detail: 'Has active jobs' }, { status: 400 })));
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    await user.click(within(row('bob')).getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Delete User' }));

    expect(await screen.findByText('Has active jobs')).toBeInTheDocument();
  });

  it('resets passwords by email when advanced auth is on', async () => {
    const calls = useUsers({ advanced: true });
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    // Only users with an email, other than yourself, get the button.
    expect(within(row('carol')).queryByRole('button', { name: /Reset Password/ })).not.toBeInTheDocument();
    expect(within(row('alice')).queryByRole('button', { name: /Reset Password/ })).not.toBeInTheDocument();

    await user.click(within(row('bob')).getByRole('button', { name: /Reset Password/ }));

    await waitFor(() => expect(calls.reset).toEqual([{ user_id: 2 }]));
    expect(await screen.findByText('Password reset email sent')).toBeInTheDocument();
  });

  it('shows the error when a password reset fails', async () => {
    useUsers({ advanced: true });
    server.use(http.post('/api/v1/auth/reset-password', () => HttpResponse.json({ detail: 'SMTP down' }, { status: 500 })));
    const user = userEvent.setup();
    render(<UsersPage />);

    await screen.findByText('bob', { selector: 'td' });
    await user.click(within(row('bob')).getByRole('button', { name: /Reset Password/ }));

    expect(await screen.findByText('SMTP down')).toBeInTheDocument();
  });
});
