/**
 * ArchivesPage: bulk selection actions, keyboard shortcuts, the print log
 * view and the calendar view.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { server } from '../mocks/server';

function archive(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename: `${name}.gcode.3mf`,
    print_name: name,
    printer_id: 1,
    file_path: `archive/${id}/${name}.gcode.3mf`,
    file_size: id * 1000,
    status: 'completed',
    created_at: `2026-01-0${id}T09:00:00Z`,
    completed_at: `2026-01-0${id}T11:00:00Z`,
    started_at: `2026-01-0${id}T10:00:00Z`,
    print_time_seconds: 3600,
    is_favorite: false,
    tags: null,
    photos: null,
    ...extra,
  };
}

function setView(view: string | null) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => (key === 'archiveViewMode' ? view : null));
}

function useArchives(items = [archive(1, 'Benchy'), archive(2, 'Bracket')]) {
  const calls = { favorites: [] as number[], deletes: [] as string[] };
  server.use(
    http.get('/api/v1/archives/', () => HttpResponse.json(items)),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: items.length })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    http.post('/api/v1/archives/:id/favorite', ({ params }) => {
      calls.favorites.push(Number(params.id));
      return HttpResponse.json({});
    }),
    http.delete('/api/v1/archives/:id', ({ params }) => {
      calls.deletes.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

describe('ArchivesPage bulk selection', () => {
  it('favourites and deletes every selected archive', async () => {
    setView('grid');
    const calls = useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByRole('button', { name: /^Select$/ }));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Favorite$/ }));
    await waitFor(() => expect(calls.favorites.sort()).toEqual([1, 2]));
    expect(await screen.findByText('Toggled favorites for 2 archives')).toBeInTheDocument();

    const toolbar = screen.getByText('2 selected').closest('div.fixed') as HTMLElement;
    const toolbarButtons = within(toolbar).getAllByRole('button');
    await user.click(toolbarButtons[toolbarButtons.length - 1]);
    await user.click(await screen.findByRole('button', { name: /Delete 2/ }));
    await waitFor(() => expect(calls.deletes.sort()).toEqual(['1', '2']));
    expect(await screen.findByText('2 archives deleted')).toBeInTheDocument();
  });

  it('Escape and Close leave selection mode', async () => {
    setView('grid');
    useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByRole('button', { name: /^Select$/ }));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Select$/ }));
    await user.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByRole('button', { name: 'Select All' })).not.toBeInTheDocument();
  });

  it('slash focuses the search box', async () => {
    setView('grid');
    useArchives();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    fireEvent.keyDown(document.body, { key: '/' });

    expect(document.activeElement?.tagName).toBe('INPUT');
  });
});

describe('ArchivesPage print log view', () => {
  function useLog(items: unknown[]) {
    const calls = { deleted: [] as string[], cleared: 0 };
    server.use(
      http.get('/api/v1/print-log/', () => HttpResponse.json({ items, total: items.length })),
      http.delete('/api/v1/print-log/:id', ({ params }) => {
        calls.deleted.push(String(params.id));
        return HttpResponse.json({ status: 'deleted', id: Number(params.id) });
      }),
      http.delete('/api/v1/print-log/', () => {
        calls.cleared += 1;
        return HttpResponse.json({ deleted: items.length });
      }),
    );
    return calls;
  }

  const entries = [
    { id: 11, print_name: 'Log Benchy', printer_name: 'X1 Carbon', created_by_username: 'ada', status: 'completed', duration_seconds: 3600, filament_used_grams: 12, started_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' },
    { id: 12, print_name: 'Log Clip', printer_name: 'X1 Carbon', created_by_username: null, status: 'failed', duration_seconds: null, filament_used_grams: null, started_at: null, created_at: '2026-01-02T10:00:00Z' },
  ];

  it('lists runs and deletes a single entry', async () => {
    setView('log');
    useArchives();
    const calls = useLog(entries);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    expect(await screen.findByText('Log Benchy')).toBeInTheDocument();
    expect(screen.getByText('Log Clip')).toBeInTheDocument();

    const deleteButtons = screen.getAllByTitle(/Delete/i).filter((el) => el.closest('tr'));
    await user.click(deleteButtons[0]);
    const confirm = await screen.findAllByRole('button', { name: /^Delete$/ });
    await user.click(confirm[confirm.length - 1]);

    await waitFor(() => expect(calls.deleted).toEqual(['11']));
    expect(await screen.findByText('Print log entry deleted')).toBeInTheDocument();
  });

  it('clears the whole log after confirmation', async () => {
    setView('log');
    useArchives();
    const calls = useLog(entries);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    await user.click(screen.getByRole('button', { name: /Clear Log/ }));
    await user.click(await screen.findByRole('button', { name: 'Clear All' }));

    await waitFor(() => expect(calls.cleared).toBe(1));
    expect(await screen.findByText('2 log entries cleared')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    setView('log');
    useArchives();
    useLog([]);
    render(<ArchivesPage />);

    expect(await screen.findByText('No print log entries found')).toBeInTheDocument();
  });
});

describe('ArchivesPage calendar view', () => {
  it('renders archives on a calendar', async () => {
    setView('calendar');
    useArchives([archive(1, 'Benchy', { created_at: new Date().toISOString(), completed_at: new Date().toISOString() })]);
    render(<ArchivesPage />);

    const monthName = new Date().toLocaleString('en-US', { month: 'long' });
    expect(await screen.findByText(new RegExp(monthName))).toBeInTheDocument();
  });
});
