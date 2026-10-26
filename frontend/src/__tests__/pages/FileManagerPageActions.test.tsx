/**
 * FileManagerPage folder and file actions: renaming folders and files
 * (with filename validation), linking a folder to a project or archive,
 * deleting folders and files, and bulk delete / group-as-versions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';

const folder = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, parent_id: null, file_count: 1, latest_activity_at: null, project_id: null, archive_id: null,
  project_name: null, archive_name: null, children: [], ...extra,
});

const file = (id: number, filename: string, extra: Record<string, unknown> = {}) => ({
  id, filename, file_path: `/library/${filename}`, file_size: 1000, file_type: filename.endsWith('.stl') ? 'stl' : '3mf',
  folder_id: null, thumbnail_path: null, print_name: null, print_time_seconds: 60, print_count: 0, duplicate_count: 0,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by_id: null, ...extra,
});

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  const record = (response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response);
    };
  server.use(
    http.get('/api/v1/library/folders', () =>
      HttpResponse.json([folder(1, 'Brackets'), folder(2, 'Gifts', { project_id: 7, project_name: 'Xmas' })]),
    ),
    http.get('/api/v1/library/files', () =>
      HttpResponse.json([file(1, 'benchy.gcode.3mf'), file(2, 'cube.gcode.3mf'), file(3, 'hook.stl')]),
    ),
    http.get('/api/v1/library/stats', () => HttpResponse.json({ total_files: 3, total_folders: 2, total_size_bytes: 3000 })),
    http.get('/api/v1/settings/', () => HttpResponse.json({ library_disk_warning_gb: 5 })),
    http.get('/api/v1/projects/', () => HttpResponse.json([{ id: 7, name: 'Xmas', color: '#f00', status: 'active' }, { id: 8, name: 'Shop', color: '#0f0', status: 'active' }])),
    http.get('/api/v1/archives/', () => HttpResponse.json([{ id: 30, print_name: 'Old print', filename: 'old.3mf' }])),
    http.put('/api/v1/library/folders/:id', record()),
    http.delete('/api/v1/library/folders/:id', record({ status: 'deleted', message: '' })),
    http.put('/api/v1/library/files/:id', record()),
    http.delete('/api/v1/library/files/:id', record()),
    http.post('/api/v1/library/bulk-delete', record({ deleted_files: 2, deleted_folders: 0 })),
    http.post('/api/v1/library/variant-groups', record({ id: 1, members: [{}, {}] })),
  );
});

async function ready() {
  render(<FileManagerPage />);
  await screen.findByText('benchy.gcode.3mf');
}

async function openFolderMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = screen.getAllByText(name).map((el) => el.closest('div.group, div[class*="cursor-pointer"]')).find(Boolean) as HTMLElement;
  const menuButton = within(row).getAllByRole('button').filter((b) => !b.getAttribute('title')).pop()!;
  await user.click(menuButton);
}

async function openFileMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const card = screen.getByText(name).closest('div.group') as HTMLElement;
  await user.click(within(card).getByRole('button', { name: 'Actions' }));
}

const lastButton = (name: string | RegExp) => {
  const buttons = screen.getAllByRole('button', { name });
  return buttons[buttons.length - 1];
};

describe('folder actions', () => {
  it('renames a folder', async () => {
    const user = userEvent.setup();
    await ready();

    await openFolderMenu(user, 'Brackets');
    await user.click(screen.getByRole('button', { name: /^Rename$/ }));
    expect(screen.getByText('Rename Folder')).toBeInTheDocument();
    const input = screen.getByDisplayValue('Brackets');
    await user.clear(input);
    await user.type(input, 'Wall Brackets');
    await user.click(lastButton(/^Rename$/));

    await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', path: '/api/v1/library/folders/1', body: { name: 'Wall Brackets' } }));
    expect(await screen.findByText('Folder renamed')).toBeInTheDocument();
  });

  it('links a folder to a project, then to an archive, and unlinks', async () => {
    const user = userEvent.setup();
    await ready();

    await openFolderMenu(user, 'Brackets');
    await user.click(screen.getByRole('button', { name: /Link to\.\.\./ }));
    expect(screen.getByText('Link "Brackets" to a project or archive for quick access.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Shop/ }));
    await user.click(screen.getByRole('button', { name: /^Link$/ }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/api/v1/library/folders/1', body: { project_id: 8 } }));
    expect(await screen.findByText('Folder linked')).toBeInTheDocument();

    await openFolderMenu(user, 'Brackets');
    await user.click(screen.getByRole('button', { name: /Link to\.\.\./ }));
    await user.click(screen.getByRole('button', { name: /^Archive$/ }));
    await user.click(await screen.findByRole('button', { name: /Old print/ }));
    await user.click(screen.getByRole('button', { name: /^Link$/ }));
    await waitFor(() => expect(calls.at(-1)!.body).toMatchObject({ archive_id: 30 }));

    // The already-linked folder can be unlinked.
    await openFolderMenu(user, 'Gifts');
    await user.click(screen.getByRole('button', { name: 'Change Link...' }));
    await user.click(screen.getByRole('button', { name: /Unlink/ }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ path: '/api/v1/library/folders/2' }));
    expect(await screen.findByText('Folder unlinked')).toBeInTheDocument();
  });

  it('deletes a folder after confirming', async () => {
    const user = userEvent.setup();
    await ready();

    await openFolderMenu(user, 'Brackets');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(screen.getByText(/All files inside will also be deleted/)).toBeInTheDocument();
    await user.click(lastButton(/Delete/));

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/v1/library/folders/1' })));
    expect(await screen.findByText('Folder deleted')).toBeInTheDocument();
  });
});

describe('file actions', () => {
  it('renames a file, rejecting characters the printer cannot store', async () => {
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'hook.stl');
    await user.click(screen.getByRole('button', { name: /^Rename$/ }));
    expect(screen.getByText('Rename File')).toBeInTheDocument();
    const input = screen.getAllByRole('textbox').find((i) => (i as HTMLInputElement).value.startsWith('hook')) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'wall:hook');
    expect(screen.getByText(/The character ":" is not allowed/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'wall-hook');
    await user.click(lastButton(/^Rename$/));

    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/library/files/3')?.body).toMatchObject({ filename: expect.stringContaining('wall-hook') }));
    expect(await screen.findByText('File renamed')).toBeInTheDocument();
  });

  it('deletes a single file after confirming', async () => {
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'hook.stl');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(screen.getByText('Are you sure you want to delete this file?')).toBeInTheDocument();
    await user.click(lastButton(/Delete/));

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/v1/library/files/3' })));
    expect(await screen.findByText('File deleted')).toBeInTheDocument();
  });

  it('groups selected sliced files as versions', async () => {
    const user = userEvent.setup();
    await ready();

    // Clicking a card selects it.
    for (const name of ['benchy.gcode.3mf', 'cube.gcode.3mf']) {
      await user.click(screen.getByText(name).closest('div[class*="cursor-pointer"]') as HTMLElement);
    }
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Group as versions/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/library/variant-groups')?.body).toEqual({ members: [{ library_file_id: 1 }, { library_file_id: 2 }] }));
    expect(await screen.findByText('Grouped 2 files as versions')).toBeInTheDocument();
  });

  it('reports a failed delete', async () => {
    server.use(http.delete('/api/v1/library/files/:id', () => HttpResponse.json({ detail: 'File is in use' }, { status: 409 })));
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'hook.stl');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await user.click(lastButton(/Delete/));

    expect(await screen.findByText('File is in use')).toBeInTheDocument();
  });
});
