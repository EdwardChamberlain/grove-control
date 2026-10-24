/**
 * `/files?file=ID` deep link: opens the file's folder, scrolls the file into
 * view and highlights it briefly. Unknown or unusable IDs leave the page alone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';

const folder = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  parent_id: null,
  file_count: 1,
  latest_activity_at: null,
  project_id: null,
  archive_id: null,
  project_name: null,
  archive_name: null,
  is_external: false,
  is_system: false,
  external_path: null,
  external_readonly: false,
  children: [],
  ...extra,
});

const file = (id: number, filename: string, folderId: number | null) => ({
  id,
  filename,
  file_path: `/library/${filename}`,
  file_size: 1024,
  file_type: 'stl',
  folder_id: folderId,
  folder_name: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
});

const allFiles = [file(1, 'root-part.stl', null), file(5, 'bracket.stl', 2), file(6, 'other-bracket.stl', 2)];

let requestedFolderIds: Array<string | null>;

function visit(path: string) {
  window.history.pushState({}, '', path);
}

describe('FileManagerPage — ?file= deep link', () => {
  beforeEach(() => {
    localStorage.clear();
    requestedFolderIds = [];
    server.use(
      http.get('/api/v1/library/folders', () =>
        HttpResponse.json([folder(1, 'Parts', { children: [folder(2, 'Brackets', { parent_id: 1 })] })]),
      ),
      http.get('/api/v1/library/files', ({ request }) => {
        const folderId = new URL(request.url).searchParams.get('folder_id');
        requestedFolderIds.push(folderId);
        const wanted = folderId === null ? null : Number(folderId);
        return HttpResponse.json(allFiles.filter((f) => f.folder_id === wanted));
      }),
      http.get('/api/v1/library/files/:id', ({ params }) => {
        const found = allFiles.find((f) => f.id === Number(params.id));
        return found ? HttpResponse.json(found) : HttpResponse.json({ detail: 'File not found' }, { status: 404 });
      }),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({
          total_files: 3,
          total_folders: 2,
          total_size_bytes: 0,
          disk_free_bytes: 1,
          disk_total_bytes: 2,
        }),
      ),
      http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false })),
    );
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
  });

  const row = (id: number) => document.querySelector(`[data-file-id="${id}"]`);

  it('opens the file’s folder and highlights the file', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    visit('/files?file=5');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(5)?.getAttribute('data-highlighted')).toBe('true'));
    expect(requestedFolderIds).toContain('2');
    expect(row(6)?.getAttribute('data-highlighted')).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('still scrolls to and highlights the file when the folder tree loads after the file list', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    server.use(
      http.get('/api/v1/library/folders', async () => {
        await delay(400);
        return HttpResponse.json([folder(1, 'Parts', { children: [folder(2, 'Brackets', { parent_id: 1 })] })]);
      }),
    );
    visit('/files?file=5');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(5)?.getAttribute('data-highlighted')).toBe('true'));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('highlights a file in the root without needing a folder', async () => {
    visit('/files?file=1');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(1)?.getAttribute('data-highlighted')).toBe('true'));
  });

  it('still works when the link also names a folder', async () => {
    visit('/files?folder=2&file=5');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(5)?.getAttribute('data-highlighted')).toBe('true'));
  });

  it('lets the file win when the folder in the link is wrong', async () => {
    visit('/files?folder=1&file=5');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(5)?.getAttribute('data-highlighted')).toBe('true'));
  });

  it('falls back to the normal view for an unknown file', async () => {
    visit('/files?file=999');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(1)).not.toBeNull());
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it('ignores a file parameter that is not a number', async () => {
    visit('/files?file=abc');
    render(<FileManagerPage />);

    await waitFor(() => expect(row(1)).not.toBeNull());
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
  });

  it('removes the highlight after a few seconds', async () => {
    visit('/files?file=1');
    render(<FileManagerPage />);
    await waitFor(() => expect(row(1)?.getAttribute('data-highlighted')).toBe('true'));

    await waitFor(() => expect(row(1)?.getAttribute('data-highlighted')).toBeNull(), { timeout: 5000 });
  });
});
