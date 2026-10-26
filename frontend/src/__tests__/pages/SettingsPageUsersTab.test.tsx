/**
 * SettingsPage users tab: creating, editing and deleting users (with the
 * owned-items choice), deleting groups, changing your own password,
 * disabling authentication and the session policy presets.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setAuthToken } from '../../api/client';
import { server } from '../mocks/server';
import { SettingsPage } from '../../pages/SettingsPage';
import { render } from '../utils';

const admin = {
  id: 1,
  username: 'alice',
  email: 'alice@example.com',
  is_active: true,
  is_admin: true,
  auth_source: 'local',
  groups: [{ id: 1, name: 'Administrators' }],
  permissions: [],
  created_at: '2026-01-01T00:00:00Z',
};
const bob = { ...admin, id: 2, username: 'bob', email: 'bob@example.com', is_admin: false, groups: [{ id: 2, name: 'Operators' }] };

const groups = [
  { id: 1, name: 'Administrators', description: 'All access', is_system: true, user_count: 1, permissions: ['a'] },
  { id: 2, name: 'Operators', description: null, is_system: true, user_count: 1, permissions: [] },
  { id: 5, name: 'Night shift', description: 'Custom', is_system: false, user_count: 0, permissions: [] },
];

interface Calls {
  created: unknown[];
  updated: unknown[];
  deletedUsers: string[];
  deletedGroups: string[];
  passwords: unknown[];
  settings: Record<string, unknown>[];
  disabled: number;
}

function useUsersTab(itemCounts: unknown = { archives: 0, queue_items: 0, library_files: 0 }) {
  const calls: Calls = { created: [], updated: [], deletedUsers: [], deletedGroups: [], passwords: [], settings: [], disabled: 0 };
  setAuthToken('test-token');
  window.history.replaceState({}, '', '/settings?tab=users');
  server.use(
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('/api/v1/auth/me', () => HttpResponse.json(admin)),
    http.get('/api/v1/users/', () => HttpResponse.json([admin, bob])),
    http.get('/api/v1/groups/', () => HttpResponse.json(groups)),
    http.get('/api/v1/settings/', () => HttpResponse.json({ session_max_hours: 24, time_format: 'system' })),
    http.get('/api/v1/users/:id/items-count', () =>
      itemCounts === 'error' ? HttpResponse.json({}, { status: 500 }) : HttpResponse.json(itemCounts),
    ),
    http.post('/api/v1/users/', async ({ request }) => {
      calls.created.push(await request.json());
      return HttpResponse.json({ ...bob, id: 9 });
    }),
    http.patch('/api/v1/users/:id', async ({ request }) => {
      calls.updated.push(await request.json());
      return HttpResponse.json(bob);
    }),
    http.delete('/api/v1/users/:id', ({ request, params }) => {
      calls.deletedUsers.push(`${params.id}${new URL(request.url).search}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete('/api/v1/groups/:id', ({ params }) => {
      calls.deletedGroups.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/v1/users/me/change-password', async ({ request }) => {
      calls.passwords.push(await request.json());
      return HttpResponse.json({ message: 'ok' });
    }),
    http.post('/api/v1/auth/disable', () => {
      calls.disabled += 1;
      return HttpResponse.json({ message: 'ok', auth_enabled: false });
    }),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.settings.push(body);
      return HttpResponse.json(body);
    }),
  );
  return calls;
}

/** Icon-only action buttons in the row that shows `text`. */
function rowButtons(text: string, scope: HTMLElement = document.body): HTMLElement[] {
  let el: HTMLElement | null = within(scope).getByText(text, { selector: 'span, p, div' });
  while (el && el.querySelectorAll('button').length === 0) el = el.parentElement;
  return Array.from(el!.querySelectorAll('button'));
}

function groupsCard(): HTMLElement {
  let el: HTMLElement | null = document.getElementById('card-groups');
  while (el && !el.querySelector('.divide-y')) el = el.parentElement;
  return el!;
}

beforeEach(() => {
  setAuthToken(null);
});

afterEach(() => {
  setAuthToken(null);
  window.history.replaceState({}, '', '/');
});

describe('deleting users', () => {
  it('asks what to do with the items a user owns', async () => {
    const calls = useUsersTab({ archives: 3, queue_items: 1, library_files: 2 });
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    const [, del] = rowButtons('bob');
    await user.click(del);

    expect(await screen.findByText('This user has created:')).toBeInTheDocument();
    expect(screen.getByText('3 archives')).toBeInTheDocument();
    expect(screen.getByText('1 queue item')).toBeInTheDocument();
    expect(screen.getByText('2 library files')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('This user has created:')).not.toBeInTheDocument();

    await user.click(del);
    await user.click(await screen.findByRole('button', { name: 'Delete user AND their items' }));
    await waitFor(() => expect(calls.deletedUsers).toEqual(['2?delete_items=true']));
    expect(await screen.findByText('User deleted successfully')).toBeInTheDocument();

    await user.click(del);
    await user.click(await screen.findByRole('button', { name: /keep items/ }));
    await waitFor(() => expect(calls.deletedUsers).toHaveLength(2));
    expect(calls.deletedUsers[1]).toBe('2?delete_items=false');
  });

  it('uses a plain confirmation when the user owns nothing, or counts fail', async () => {
    const calls = useUsersTab('error');
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    await user.click(rowButtons('bob')[1]);
    expect(await screen.findByText('Are you sure you want to delete this user?')).toBeInTheDocument();

    // Clicking the backdrop closes it.
    await user.click(document.querySelector('.fixed.inset-0')!);
    expect(screen.queryByText('Are you sure you want to delete this user?')).not.toBeInTheDocument();

    await user.click(rowButtons('bob')[1]);
    await screen.findByText('Are you sure you want to delete this user?');
    await user.click(screen.getByRole('button', { name: 'Delete User' }));
    await waitFor(() => expect(calls.deletedUsers).toEqual(['2?delete_items=false']));
  });

  it('shows the error when deleting fails', async () => {
    useUsersTab();
    server.use(http.delete('/api/v1/users/:id', () => HttpResponse.json({ detail: 'Busy' }, { status: 409 })));
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    await user.click(rowButtons('bob')[1]);
    await user.click(await screen.findByRole('button', { name: 'Delete User' }));

    expect(await screen.findByText('Busy')).toBeInTheDocument();
  });

  it('does not offer to delete yourself', async () => {
    useUsersTab();
    render(<SettingsPage />);

    await screen.findByText('bob');
    // Only the edit button on your own row.
    const usersList = screen.getByText('bob', { selector: 'p' }).closest('.divide-y') as HTMLElement;
    expect(rowButtons('alice', usersList)).toHaveLength(1);
    expect(rowButtons('bob', usersList)).toHaveLength(2);
  });
});

describe('creating and editing users', () => {
  it('creates a user with a strong password', async () => {
    const calls = useUsersTab();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: /Add User/ }));
    const dialog = screen.getByRole('heading', { name: 'Create User' }).closest('.max-w-md') as HTMLElement;
    const submit = within(dialog).getAllByRole('button', { name: /Create User/ }).pop()!;

    await user.type(within(dialog).getByPlaceholderText('Enter username'), 'erin');
    await user.type(within(dialog).getByPlaceholderText('Enter password'), 'weakpass');
    await user.type(within(dialog).getByPlaceholderText('Confirm password'), 'weakpass');
    expect(submit).toBeDisabled();

    await user.clear(within(dialog).getByPlaceholderText('Enter password'));
    await user.clear(within(dialog).getByPlaceholderText('Confirm password'));
    await user.type(within(dialog).getByPlaceholderText('Enter password'), 'Str0ng!pw');
    await user.type(within(dialog).getByPlaceholderText('Confirm password'), 'Str0ng!pw');
    await user.click(within(dialog).getByLabelText(/Night shift/));
    await user.click(submit);

    await waitFor(() => expect(calls.created).toEqual([{ username: 'erin', password: 'Str0ng!pw', group_ids: [5] }]));
    expect(await screen.findByText('User created successfully')).toBeInTheDocument();
  });

  it('shows the error when creating fails', async () => {
    useUsersTab();
    server.use(http.post('/api/v1/users/', () => HttpResponse.json({ detail: 'Duplicate' }, { status: 400 })));
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: /Add User/ }));
    await user.type(screen.getByPlaceholderText('Enter username'), 'bob');
    await user.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!pw');
    await user.type(screen.getByPlaceholderText('Confirm password'), 'Str0ng!pw');
    await user.click(screen.getAllByRole('button', { name: /Create User/ }).pop()!);

    expect(await screen.findByText('Duplicate')).toBeInTheDocument();
  });

  it('edits a user, keeping the password unless a new one is entered', async () => {
    const calls = useUsersTab();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    await user.click(rowButtons('bob')[0]);
    expect(await screen.findByDisplayValue('bob@example.com')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Night shift/));
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => expect(calls.updated).toHaveLength(1));
    expect(calls.updated[0]).toEqual({ username: 'bob', email: 'bob@example.com', group_ids: [2, 5] });
    expect(await screen.findByText('User updated successfully')).toBeInTheDocument();

    await user.click(rowButtons('bob')[0]);
    await user.type(await screen.findByPlaceholderText('Enter new password'), 'N3w!passw');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'N3w!passw');
    await user.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => expect(calls.updated).toHaveLength(2));
    expect(calls.updated[1]).toMatchObject({ password: 'N3w!passw' });
  });

  it('shows the error when saving a user fails', async () => {
    useUsersTab();
    server.use(http.patch('/api/v1/users/:id', () => HttpResponse.json({ detail: 'Nope' }, { status: 400 })));
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    await user.click(rowButtons('bob')[0]);
    await user.click(await screen.findByRole('button', { name: /Save Changes/ }));

    expect(await screen.findByText('Nope')).toBeInTheDocument();
  });
});

describe('groups', () => {
  it('only offers to delete custom groups, and deletes after confirming', async () => {
    const calls = useUsersTab();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('Night shift');
    const card = groupsCard();
    expect(within(card).getByText('All access')).toBeInTheDocument();
    expect(rowButtons('Administrators', card)).toHaveLength(1);

    const buttons = rowButtons('Night shift', card);
    await user.click(buttons[buttons.length - 1]);
    await user.click(screen.getByRole('button', { name: 'Delete Group' }));

    await waitFor(() => expect(calls.deletedGroups).toEqual(['5']));
    expect(await screen.findByText('Group deleted successfully')).toBeInTheDocument();
  });

  it('shows the error when deleting a group fails', async () => {
    useUsersTab();
    server.use(http.delete('/api/v1/groups/:id', () => HttpResponse.json({ detail: 'Group in use' }, { status: 400 })));
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('Night shift');
    const buttons = rowButtons('Night shift', groupsCard());
    await user.click(buttons[buttons.length - 1]);
    await user.click(screen.getByRole('button', { name: 'Delete Group' }));

    expect(await screen.findByText('Group in use')).toBeInTheDocument();
  });
});

describe('your account', () => {
  it('changes your password', async () => {
    const calls = useUsersTab();
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: /Change Password/ }));
    await user.type(screen.getByPlaceholderText('Enter current password'), 'oldpass');
    await user.type(screen.getByPlaceholderText('Enter new password (min 6 characters)'), 'newpass1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpass2');
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Confirm new password'));
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpass1');
    const buttons = screen.getAllByRole('button', { name: /Change Password/ });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(calls.passwords).toEqual([{ current_password: 'oldpass', new_password: 'newpass1' }]));
    expect(await screen.findByText('Password changed successfully')).toBeInTheDocument();
  });

  it('shows the error when the current password is wrong, and cancels', async () => {
    useUsersTab();
    server.use(
      http.post('/api/v1/users/me/change-password', () => HttpResponse.json({ detail: 'Wrong password' }, { status: 400 })),
    );
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: /Change Password/ }));
    await user.type(screen.getByPlaceholderText('Enter current password'), 'bad');
    await user.type(screen.getByPlaceholderText('Enter new password (min 6 characters)'), 'newpass1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpass1');
    const buttons = screen.getAllByRole('button', { name: /Change Password/ });
    await user.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Enter current password')).not.toBeInTheDocument();
  });

  it('shows the error when disabling authentication fails', async () => {
    useUsersTab();
    server.use(http.post('/api/v1/auth/disable', () => HttpResponse.json({ detail: 'Not allowed' }, { status: 403 })));
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByText('bob');
    await user.click(screen.getByRole('button', { name: /^Disable$/ }));
    await user.click(screen.getByRole('button', { name: 'Disable Authentication' }));

    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  });

  it('selects a session lifetime preset', async () => {
    useUsersTab();
    const user = userEvent.setup();
    render(<SettingsPage />);

    const sevenDays = await screen.findByRole('button', { name: '7 days' });
    await waitFor(() => expect(screen.getByRole('button', { name: '24 hours' })).toHaveClass('bg-bambu-green'));
    await user.click(sevenDays);

    expect(sevenDays).toHaveClass('bg-bambu-green');
    expect(screen.getByRole('button', { name: '24 hours' })).not.toHaveClass('bg-bambu-green');
  });
});
