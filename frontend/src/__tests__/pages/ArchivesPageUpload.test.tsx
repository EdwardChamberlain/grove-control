/**
 * ArchivesPage: attaching a source 3MF, an F3D file or a timelapse to an
 * archive from its actions menu, in both grid and list layouts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { server } from '../mocks/server';

const archive = {
  id: 1,
  filename: 'benchy.gcode.3mf',
  print_name: 'Benchy',
  printer_id: 1,
  printer_name: 'X1 Carbon',
  file_path: 'archive/1/benchy.gcode.3mf',
  file_size: 1000,
  print_time_seconds: 3600,
  status: 'completed',
  created_at: '2026-01-01T09:00:00Z',
  completed_at: '2026-01-01T11:00:00Z',
  started_at: '2026-01-01T10:00:00Z',
  thumbnail_path: null,
  timelapse_path: null,
  source_3mf_path: null,
  f3d_path: null,
  photos: null,
  is_favorite: false,
  project_id: null,
  tags: null,
  duplicate_count: 0,
  duplicate_sequence: 0,
  created_by_id: null,
};

/**
 * Records each upload and answers with the file name the server stores. The
 * multipart name jsdom sends is not reliable, so the stored name is fixed per route.
 */
function useUploads(options: { fail?: string } = {}) {
  const uploads: { route: string; sentFile: boolean }[] = [];
  const stored: Record<string, string> = {
    source: 'benchy-source.3mf',
    f3d: 'benchy.f3d',
    timelapse: 'print.mp4',
  };
  const respond = (route: string) => async ({ request }: { request: Request }) => {
    const body = await request.text();
    uploads.push({ route, sentFile: body.includes('name="file"') });
    if (options.fail) return HttpResponse.json({ detail: options.fail }, { status: 400 });
    return HttpResponse.json({ status: 'uploaded', filename: stored[route] });
  };
  server.use(
    http.get('/api/v1/archives/', () => HttpResponse.json([archive])),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: 1 })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    http.get('/api/v1/archives/:id/delete-impact', () => HttpResponse.json({ related_queue_items: 0, currently_printing: 0 })),
    http.post('/api/v1/archives/:id/source', respond('source')),
    http.post('/api/v1/archives/:id/f3d', respond('f3d')),
    http.post('/api/v1/archives/:id/timelapse/upload', respond('timelapse')),
  );
  return uploads;
}

const layouts = ['grid', 'list'] as const;

describe.each(layouts)('archive file uploads (%s layout)', (layout) => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => (key === 'archiveViewMode' ? layout : null));
  });

  async function openUploadMenuItem(label: string) {
    const user = userEvent.setup();
    await screen.findAllByText('Benchy');
    await user.click(screen.getAllByTitle('Right-click for more options')[0]);
    const favourite = screen.getByRole('button', { name: /^(Add to|Remove from) Favorites/ });
    const panel = favourite.closest('div.fixed') as HTMLElement;
    await user.click(within(panel).getByRole('button', { name: new RegExp(`^${label}`) }));
    return user;
  }

  /** The hidden file input the page keeps for one kind of upload. */
  function fileInput(accept: string): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(`input[type="file"][accept="${accept}"]`);
    if (!input) throw new Error(`no file input accepting ${accept}`);
    return input;
  }

  it('attaches a source 3MF and reports its name', async () => {
    const uploads = useUploads();
    render(<ArchivesPage />);
    const user = await openUploadMenuItem('Upload Source 3MF');

    await user.upload(fileInput('.3mf'), new File(['x'], 'benchy-source.3mf'));

    expect(await screen.findByText('Source 3MF attached: benchy-source.3mf')).toBeInTheDocument();
    expect(uploads).toEqual([{ route: 'source', sentFile: true }]);
  });

  it('attaches an F3D file', async () => {
    const uploads = useUploads();
    render(<ArchivesPage />);
    const user = await openUploadMenuItem('Upload F3D');

    await user.upload(fileInput('.f3d'), new File(['x'], 'benchy.f3d'));

    expect(await screen.findByText('F3D attached: benchy.f3d')).toBeInTheDocument();
    expect(uploads).toEqual([{ route: 'f3d', sentFile: true }]);
  });

  it('uploads a timelapse video', async () => {
    const uploads = useUploads();
    render(<ArchivesPage />);
    const user = await openUploadMenuItem('Upload Timelapse');

    await user.upload(fileInput('.mp4,.avi,.mkv'), new File(['x'], 'print.mp4'));

    expect(await screen.findByText('Timelapse uploaded: print.mp4')).toBeInTheDocument();
    expect(uploads).toEqual([{ route: 'timelapse', sentFile: true }]);
  });

  it('shows the server reason when an upload is rejected', async () => {
    useUploads({ fail: 'File is not a valid 3MF' });
    render(<ArchivesPage />);
    const user = await openUploadMenuItem('Upload Source 3MF');

    await user.upload(fileInput('.3mf'), new File(['x'], 'broken.3mf'));

    expect(await screen.findByText('File is not a valid 3MF')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Source 3MF attached/)).not.toBeInTheDocument());
  });
});
