/**
 * "Save to Files" on the Archive card context menu: gated on a 3MF existing,
 * opens a folder picker, and only copies once the user confirms.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseArchive = {
  id: 1,
  filename: 'benchy.gcode.3mf',
  file_path: 'archive/1/benchy.gcode.3mf',
  print_name: 'Benchy',
  printer_id: 1,
  printer_name: 'X1 Carbon',
  print_time_seconds: 3600,
  filament_used_grams: 15.5,
  status: 'completed',
  started_at: '2024-01-01T10:00:00Z',
  completed_at: '2024-01-01T11:00:00Z',
  thumbnail_path: null,
  notes: null,
  rating: null,
  project_id: null,
  project_name: null,
  project_color: null,
  print_count: 1,
  tags: '',
  created_at: '2024-01-01T09:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  has_f3d: false,
};

const folders = [
  {
    id: 5,
    name: 'Keepers',
    parent_id: null,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    is_external: false,
    external_path: null,
    external_readonly: false,
    file_count: 0,
    latest_activity_at: null,
    children: [],
  },
];

function useArchives(archives: Array<Record<string, unknown>>) {
  server.use(
    http.get('/api/v1/archives/', () => HttpResponse.json(archives)),
    http.get('/api/v1/archives/stats', () =>
      HttpResponse.json({
        total_archives: archives.length,
        total_print_time_seconds: 0,
        total_filament_grams: 0,
        prints_this_week: 0,
        prints_this_month: 0,
      }),
    ),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    http.get('/api/v1/library/folders', () => HttpResponse.json(folders)),
  );
}

async function openContextMenu(name: string) {
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
  const card = screen.getByText(name).closest('[class*="rounded"]') as HTMLElement;
  fireEvent.contextMenu(card);
}

describe('ArchivesPage — Save to Files', () => {
  let saveBodies: unknown[];

  beforeEach(() => {
    saveBodies = [];
    server.use(
      http.post('/api/v1/archives/:id/save-to-files', async ({ request }) => {
        saveBodies.push(await request.json());
        return HttpResponse.json({
          id: 99,
          filename: 'benchy.gcode.3mf',
          file_type: 'gcode.3mf',
          file_size: 10,
          thumbnail_path: null,
          duplicate_of: null,
          metadata: null,
        });
      }),
    );
  });

  it('shows the action for an entry that has a 3MF', async () => {
    useArchives([baseArchive]);
    render(<ArchivesPage />);

    await openContextMenu('Benchy');

    expect(await screen.findByText('Save to Files')).toBeInTheDocument();
  });

  it('hides the action for a fallback entry with no 3MF', async () => {
    useArchives([{ ...baseArchive, file_path: '' }]);
    render(<ArchivesPage />);

    await openContextMenu('Benchy');

    await waitFor(() => expect(screen.getAllByText('Download').length).toBeGreaterThan(0));
    expect(screen.queryByText('Save to Files')).toBeNull();
  });

  it('saves to the chosen folder once confirmed', async () => {
    useArchives([baseArchive]);
    render(<ArchivesPage />);
    await openContextMenu('Benchy');

    fireEvent.click(await screen.findByText('Save to Files'));
    fireEvent.click(await screen.findByText('Keepers'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveBodies).toEqual([{ folder_id: 5 }]));
    expect(await screen.findByText('Saved Benchy to Files')).toBeInTheDocument();
  });

  it('saves to the root when no folder is picked', async () => {
    useArchives([baseArchive]);
    render(<ArchivesPage />);
    await openContextMenu('Benchy');

    fireEvent.click(await screen.findByText('Save to Files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveBodies).toEqual([{ folder_id: null }]));
  });

  it('creates nothing when the picker is cancelled', async () => {
    useArchives([baseArchive]);
    render(<ArchivesPage />);
    await openContextMenu('Benchy');

    fireEvent.click(await screen.findByText('Save to Files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save to Files' })).toBeNull());
    expect(saveBodies).toEqual([]);
  });

  it('warns when Files already holds the same content', async () => {
    useArchives([baseArchive]);
    server.use(
      http.post('/api/v1/archives/:id/save-to-files', () =>
        HttpResponse.json({
          id: 100,
          filename: 'benchy.gcode.3mf',
          file_type: 'gcode.3mf',
          file_size: 10,
          thumbnail_path: null,
          duplicate_of: 42,
          metadata: null,
        }),
      ),
    );
    render(<ArchivesPage />);
    await openContextMenu('Benchy');

    fireEvent.click(await screen.findByText('Save to Files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/a file with the same content already exists/)).toBeInTheDocument();
  });
});
