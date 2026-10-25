/**
 * ArchivesPage: the per-archive actions menu, in both grid and list layouts.
 *
 * The card and the list row each build their own copy of this menu, so
 * every scenario runs once per layout.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { server } from '../mocks/server';

const baseArchive = {
  id: 1,
  filename: 'benchy.gcode.3mf',
  print_name: 'Benchy',
  printer_id: 1,
  printer_name: 'X1 Carbon',
  file_path: 'archive/1/benchy.gcode.3mf',
  print_time_seconds: 3600,
  filament_used_grams: 15.5,
  status: 'completed',
  started_at: '2026-01-01T10:00:00Z',
  completed_at: '2026-01-01T11:00:00Z',
  thumbnail_path: null,
  timelapse_path: null,
  source_3mf_path: null,
  f3d_path: null,
  photos: null,
  notes: null,
  rating: null,
  is_favorite: false,
  project_id: null,
  project_name: null,
  tags: null,
  created_at: '2026-01-01T09:00:00Z',
  updated_at: '2026-01-01T11:00:00Z',
  created_by_id: null,
};

interface Calls {
  favorite: number;
  patches: unknown[];
  deletes: string[];
  scans: number;
  selected: string[];
}

function useArchives(overrides: Record<string, unknown> = {}, scan: unknown = { status: 'not_found', message: '' }) {
  const calls: Calls = { favorite: 0, patches: [], deletes: [], scans: 0, selected: [] };
  server.use(
    http.get('/api/v1/archives/', () => HttpResponse.json([{ ...baseArchive, ...overrides }])),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: 1 })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([{ id: 7, name: 'Gift boxes', color: '#00ae42', status: 'active' }])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    http.post('/api/v1/archives/:id/favorite', () => {
      calls.favorite += 1;
      return HttpResponse.json({ ...baseArchive, is_favorite: true });
    }),
    http.patch('/api/v1/archives/:id', async ({ request }) => {
      calls.patches.push(await request.json());
      return HttpResponse.json(baseArchive);
    }),
    http.get('/api/v1/archives/:id/delete-impact', () => HttpResponse.json({ related_queue_items: 2, currently_printing: 0 })),
    http.delete('/api/v1/archives/:id', ({ request }) => {
      calls.deletes.push(new URL(request.url).pathname + new URL(request.url).search);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete('/api/v1/archives/:id/:what', ({ params }) => {
      calls.deletes.push(String(params.what));
      return HttpResponse.json({ status: 'deleted' });
    }),
    http.post('/api/v1/archives/:id/timelapse/scan', () => {
      calls.scans += 1;
      return HttpResponse.json(scan);
    }),
    http.post('/api/v1/archives/:id/timelapse/select', ({ request }) => {
      calls.selected.push(new URL(request.url).searchParams.get('filename') ?? '');
      return HttpResponse.json({ status: 'attached', message: 'ok', filename: 'clip.mp4' });
    }),
  );
  return calls;
}

const layouts = ['grid', 'list'] as const;

function setLayout(layout: (typeof layouts)[number]) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => (key === 'archiveViewMode' ? layout : null));
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByText('Benchy');
  await user.click(screen.getAllByTitle('Right-click for more options')[0]);
}

/** The open actions menu (a fixed panel holding the favourites item). */
function openMenuPanel(): HTMLElement {
  const favourite = screen.getByRole('button', { name: /^(Add to|Remove from) Favorites/ });
  return favourite.closest('div.fixed') as HTMLElement;
}

function menuItem(name: string) {
  return within(openMenuPanel()).getByRole('button', { name: new RegExp(`^${name}`) });
}

beforeEach(() => {
  setLayout('grid');
});

describe.each(layouts)('archive actions menu (%s layout)', (layout) => {
  beforeEach(() => setLayout(layout));

  it('toggles favourite', async () => {
    const calls = useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Add to Favorites'));

    await waitFor(() => expect(calls.favorite).toBe(1));
    expect(await screen.findByText('Added to favorites')).toBeInTheDocument();
  });

  it('adds the archive to a project and removes it again', async () => {
    const calls = useArchives({ project_id: 7, project_name: 'Gift boxes' });
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.hover(menuItem('Add to Project'));
    await user.click(await screen.findByRole('button', { name: /Remove from Project/ }));

    await waitFor(() => expect(calls.patches).toEqual([{ project_id: null }]));
    expect(await screen.findByText('Project updated')).toBeInTheDocument();
  });

  it('copies the download link', async () => {
    useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Copy Download Link'));

    expect(await screen.findByText('Link copied to clipboard')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toContain('/archives/1/download');
  });

  it('deletes after confirming, showing related queue items', async () => {
    const calls = useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Delete'));
    const dialog = (await screen.findByText('Delete Archive')).closest('div') as HTMLElement;
    expect(dialog).toBeInTheDocument();
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => expect(calls.deletes).toContain('/api/v1/archives/1'));
    expect(await screen.findByText('Archive deleted')).toBeInTheDocument();
  });

  it('removes timelapse, source 3MF and F3D after confirmation', async () => {
    const calls = useArchives({
      timelapse_path: 'archive/1/timelapse.mp4',
      source_3mf_path: 'archive/1/source/benchy.3mf',
      f3d_path: 'archive/1/f3d/benchy.f3d',
    });
    const user = userEvent.setup();
    render(<ArchivesPage />);

    for (const [item, toast] of [
      ['Remove Timelapse', 'Timelapse removed'],
      ['Remove Source 3MF', 'Source 3MF removed'],
      ['Remove F3D', 'F3D removed'],
    ] as const) {
      await openMenu(user);
      await user.click(menuItem(item));
      const confirm = await screen.findAllByRole('button', { name: 'Remove' });
      await user.click(confirm[confirm.length - 1]);
      expect(await screen.findByText(toast)).toBeInTheDocument();
    }

    expect(calls.deletes.sort()).toEqual(['f3d', 'source', 'timelapse']);
  });

  it('scans for a timelapse and attaches the match', async () => {
    const calls = useArchives({}, { status: 'attached', message: 'ok', filename: 'clip.mp4' });
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Scan for Timelapse'));

    await waitFor(() => expect(calls.scans).toBe(1));
    expect(await screen.findByText('Timelapse attached: clip.mp4')).toBeInTheDocument();
  });

  it('lets the user pick a timelapse when none matches automatically', async () => {
    const calls = useArchives(
      {},
      { status: 'not_found', message: '', available_files: [{ name: 'video_1.mp4', path: '/timelapse/video_1.mp4', size: 1000, mtime: null }] },
    );
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Scan for Timelapse'));
    await user.click(await screen.findByText('video_1.mp4'));

    await waitFor(() => expect(calls.selected).toEqual(['video_1.mp4']));
  });

  it('reports when no timelapse is found', async () => {
    useArchives({}, { status: 'not_found', message: '' });
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('Scan for Timelapse'));

    expect(await screen.findByText('No matching timelapse found')).toBeInTheDocument();
  });

  it('opens the QR code and edit dialogs', async () => {
    useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);
    await user.click(menuItem('QR Code'));
    expect(await screen.findByRole('img', { name: /QR/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await openMenu(user);
    await user.click(menuItem('Edit'));
    expect(await screen.findByDisplayValue('Benchy')).toBeInTheDocument();
  });

  it('disables actions that need a file the archive does not have', async () => {
    useArchives({ timelapse_path: null, photos: null, printer_id: null });
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await openMenu(user);

    expect(menuItem('View Timelapse')).toBeDisabled();
    expect(menuItem('Scan for Timelapse')).toBeDisabled();
    expect(within(openMenuPanel()).queryByText(/Go to Project/)).not.toBeInTheDocument();
  });
});
