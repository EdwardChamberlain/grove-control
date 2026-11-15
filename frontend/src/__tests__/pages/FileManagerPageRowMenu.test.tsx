/**
 * FileManagerPage row actions menu: the kebab menu shared by the grid cards
 * and list rows. Covers the actions that open modals or navigate (Slice,
 * 3D Preview, Download) and the tooltips shown when the user lacks a permission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { api, setAuthToken } from '../../api/client';
import { FileManagerPage } from '../../pages/FileManagerPage';

// The real modals pull in the slicer sidecar and three.js; these tests only
// care that the menu opens them for the right file.
vi.mock('../../components/SliceModal', () => ({
  SliceModal: ({ source }: { source: { filename: string } }) => <div role="dialog">Slicing {source.filename}</div>,
}));
vi.mock('../../components/ModelViewerModal', () => ({
  ModelViewerModal: ({ title }: { title: string }) => <div role="dialog">Viewing {title}</div>,
}));

const file = (id: number, filename: string, fileType: string) => ({
  id, filename, file_path: `/library/${filename}`, file_size: 1000, file_type: fileType,
  folder_id: null, thumbnail_path: null, print_name: null, print_time_seconds: 60, print_count: 0, duplicate_count: 0,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by_id: null,
});

function mockLibrary() {
  server.use(
    http.get('/api/v1/library/folders', () => HttpResponse.json([])),
    http.get('/api/v1/library/files', () =>
      HttpResponse.json([
        file(1, 'benchy.gcode.3mf', '3mf'),
        file(2, 'hook.stl', 'stl'),
        file(3, 'plain.3mf', '3mf'),
      ]),
    ),
    http.get('/api/v1/library/stats', () => HttpResponse.json({ total_files: 3, total_folders: 0, total_size_bytes: 3000 })),
    http.get('/api/v1/settings/', () => HttpResponse.json({ library_disk_warning_gb: 5, use_slicer_api: true })),
  );
}

async function ready() {
  render(<FileManagerPage />);
  await screen.findByText('benchy.gcode.3mf');
}

async function openFileMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const item = screen.getByText(name).closest('[data-file-id]') as HTMLElement;
  await user.click(within(item).getByRole('button', { name: 'Actions' }));
}

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  mockLibrary();
});

afterEach(() => {
  setAuthToken(null);
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('file row menu actions', () => {
  it('opens Slice for a model file', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTitle('List view'));

    await openFileMenu(user, 'hook.stl');
    await user.click(screen.getByRole('menuitem', { name: 'Slice' }));

    expect(await screen.findByText('Slicing hook.stl')).toBeInTheDocument();
  });

  it('does not offer Slice for an already sliced file', async () => {
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'benchy.gcode.3mf');

    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Slice' })).not.toBeInTheDocument();
  });

  it('downloads the file from the menu', async () => {
    const download = vi.spyOn(api, 'downloadLibraryFile').mockResolvedValue();
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'hook.stl');
    await user.click(screen.getByRole('menuitem', { name: 'Download' }));

    expect(download).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('previews an unsliced file in the model viewer from the list view', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTitle('List view'));

    await openFileMenu(user, 'plain.3mf');
    await user.click(screen.getByRole('menuitem', { name: '3D Preview' }));

    expect(await screen.findByText('Viewing plain.3mf')).toBeInTheDocument();
  });

  it('previews a sliced file in the G-code viewer from the list view', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTitle('List view'));

    await openFileMenu(user, 'benchy.gcode.3mf');
    await user.click(screen.getByRole('menuitem', { name: '3D Preview' }));

    await waitFor(() => expect(window.location.pathname).toBe('/gcode-viewer'));
    expect(window.location.search).toBe('?library_file=1');
  });
});

describe('file row menu permissions', () => {
  beforeEach(() => {
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ id: 1, username: 'viewer', is_admin: false, permissions: ['library:read'] }),
      ),
      http.get('/api/v1/users/', () => HttpResponse.json([])),
    );
  });

  it('disables modifying actions and explains why for a read-only user', async () => {
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'hook.stl');

    const expectDenied = async (name: string, reason: string) => {
      const item = screen.getByRole('menuitem', { name });
      await waitFor(() => expect(item).toBeDisabled());
      expect(item).toHaveAttribute('title', reason);
    };
    await expectDenied('Slice', 'You do not have permission to slice files');
    await expectDenied('Generate Thumbnail', 'You do not have permission to generate thumbnails');
    await expectDenied('Rename', 'You do not have permission to rename this file');
    await expectDenied('Delete', 'You do not have permission to delete this file');
    // Read access is granted, so viewing and downloading stay available.
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeEnabled();
  });

  it('disables Print without queue permission', async () => {
    const user = userEvent.setup();
    await ready();

    await openFileMenu(user, 'benchy.gcode.3mf');

    const print = screen.getByRole('menuitem', { name: 'Print' });
    await waitFor(() => expect(print).toBeDisabled());
    expect(print).toHaveAttribute('title', 'You do not have permission to add to queue');
  });
});
