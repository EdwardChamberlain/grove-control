/**
 * ArchivesPage: exporting the list, the batch and comparison dialogs, the
 * purge and tag dialogs, the missing-3MF notice, and the print log's filters,
 * paging and entry editor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { server } from '../mocks/server';

const archives = [
  {
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
    tags: 'calibration',
    duplicate_count: 0,
    duplicate_sequence: 0,
    created_by_id: null,
  },
  {
    id: 2,
    filename: 'bracket.gcode.3mf',
    print_name: 'Bracket',
    printer_id: 1,
    printer_name: 'X1 Carbon',
    file_path: 'archive/2/bracket.gcode.3mf',
    file_size: 2000,
    print_time_seconds: 1800,
    status: 'completed',
    created_at: '2026-01-02T09:00:00Z',
    completed_at: '2026-01-02T11:00:00Z',
    started_at: '2026-01-02T10:00:00Z',
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
  },
];

function useBaseHandlers(extra: Parameters<typeof server.use>[0][] = []) {
  server.use(
    http.get('/api/v1/archives/', () => HttpResponse.json(archives)),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: 2 })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([{ id: 7, name: 'Gift boxes', color: '#00ae42', status: 'active' }])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([{ name: 'calibration', count: 1 }])),
    http.get('/api/v1/users/', () => HttpResponse.json([{ id: 1, username: 'ada' }])),
    ...extra,
  );
}

function setStorage(values: Record<string, string>) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => values[key] ?? null);
}

/** Enter selection mode and select every archive on the page. */
async function selectAll(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByText('Benchy');
  await user.click(screen.getByRole('button', { name: /^Select$/ }));
  await user.click(screen.getByRole('button', { name: 'Select All' }));
}

describe('ArchivesPage export', () => {
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;

  beforeEach(() => {
    setStorage({ archiveViewMode: 'grid' });
    URL.createObjectURL = vi.fn(() => 'blob:archives-export') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    // jsdom cannot follow a blob link; the download itself is not under test.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    vi.mocked(HTMLAnchorElement.prototype.click).mockRestore();
  });

  it('downloads a CSV export of the current view', async () => {
    const requests: URLSearchParams[] = [];
    useBaseHandlers([
      http.get('/api/v1/archives/export', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return new HttpResponse('name,status\nBenchy,completed\n', {
          headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="archives_2026.csv"' },
        });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByRole('button', { name: /^Export$/ }));
    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));

    expect(await screen.findByText('Export downloaded')).toBeInTheDocument();
    expect(requests[0].get('format')).toBe('csv');
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('exports an Excel workbook with the search applied', async () => {
    const requests: URLSearchParams[] = [];
    useBaseHandlers([
      http.get('/api/v1/archives/export', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="archives.xlsx"' },
        });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.type(screen.getByPlaceholderText('Search archives...'), 'brack');
    await user.click(screen.getByRole('button', { name: /^Export$/ }));
    await user.click(screen.getByRole('button', { name: 'Export as Excel' }));

    expect(await screen.findByText('Export downloaded')).toBeInTheDocument();
    expect(requests[0].get('format')).toBe('xlsx');
    expect(requests[0].get('search')).toBe('brack');
  });

  it('reports when the export fails', async () => {
    useBaseHandlers([
      http.get('/api/v1/archives/export', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByRole('button', { name: /^Export$/ }));
    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));

    expect(await screen.findByText('Export failed')).toBeInTheDocument();
  });
});

describe('ArchivesPage dialogs', () => {
  beforeEach(() => {
    setStorage({ archiveViewMode: 'grid' });
  });

  it('opens the add-tags dialog for the selection and closes it', async () => {
    useBaseHandlers();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    expect(await screen.findByRole('heading', { name: 'Add Tags' })).toBeInTheDocument();
    expect(screen.getByText('Add tags for 2 selected archives')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add Tags' })).not.toBeInTheDocument());
  });

  it('opens the assign-to-project dialog for the selection', async () => {
    useBaseHandlers();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByRole('heading', { name: 'Assign to Project' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Assign to Project' })).not.toBeInTheDocument());
  });

  it('compares two selected archives side by side', async () => {
    const compared: string[] = [];
    useBaseHandlers([
      http.get('/api/v1/archives/compare', ({ request }) => {
        compared.push(new URL(request.url).searchParams.get('archive_ids') ?? '');
        return HttpResponse.json({
          archives: archives.map((a) => ({ id: a.id, print_name: a.print_name, status: a.status })),
          comparison: [],
          differences: [],
          success_correlation: { insights: [] },
        });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Compare (2)' }));

    await waitFor(() => expect(compared).toEqual(['2,1']));
    expect(await screen.findByRole('heading', { name: 'Compare Archives (2)' })).toBeInTheDocument();
  });

  it('opens the tag manager from the tag filter', async () => {
    useBaseHandlers();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByTitle('Manage Tags'));
    expect(await screen.findByRole('heading', { name: 'Manage Tags' })).toBeInTheDocument();
  });

  it('opens the purge dialog from the header', async () => {
    useBaseHandlers([
      http.get('/api/v1/archives/purge/settings', () =>
        HttpResponse.json({ enabled: false, days: 365, mode: 'age', max_count: 100, purge_stats: false }),
      ),
      http.get('/api/v1/archives/purge/preview', () =>
        HttpResponse.json({ count: 0, total_bytes: 0, sample_filenames: [], mode: 'age', older_than_days: 365, keep_count: null }),
      ),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByRole('button', { name: /Purge old/ }));
    expect(await screen.findByRole('heading', { name: 'Purge old archives' })).toBeInTheDocument();
  });
});

describe('ArchivesPage missing 3MF notice', () => {
  beforeEach(() => {
    setStorage({ archiveViewMode: 'grid' });
  });

  it('explains fallback archives and stays hidden once dismissed', async () => {
    useBaseHandlers([
      http.get('/api/v1/archives/no-3mf-warning', () => HttpResponse.json({ has_fallback: true })),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    expect(await screen.findByText(/couldn.t be archived with thumbnails/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss this notice' }));

    await waitFor(() => expect(screen.queryByText(/couldn.t be archived with thumbnails/)).not.toBeInTheDocument());
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveNo3MFWarningDismissed', 'true');
  });
});

describe('ArchivesPage print log filters and paging', () => {
  const entry = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    print_name: `Run ${id}`,
    printer_name: 'X1 Carbon',
    created_by_username: 'ada',
    status: 'completed',
    duration_seconds: 600,
    filament_used_grams: 4,
    started_at: '2026-01-01T10:00:00Z',
    created_at: '2026-01-01T10:00:00Z',
    failure_reason: null,
    filament_type: 'PLA',
    filament_color: null,
    ...extra,
  });

  it('filters the log by status and by start date', async () => {
    setStorage({ archiveViewMode: 'log' });
    const requests: URLSearchParams[] = [];
    useBaseHandlers([
      http.get('/api/v1/print-log/', ({ request }) => {
        const params = new URL(request.url).searchParams;
        requests.push(params);
        return HttpResponse.json({ items: [entry(1)], total: 1 });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 1');
    await user.click(screen.getByRole('button', { name: 'All Statuses' }));
    await user.click(await screen.findByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(requests.at(-1)?.get('status')).toBe('failed'));

    const dateFrom = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[0];
    fireEvent.change(dateFrom, { target: { value: '2026-01-01' } });
    await waitFor(() => expect(requests.at(-1)?.get('date_from')).toBe('2026-01-01'));
    expect(localStorage.setItem).toHaveBeenCalledWith('logFilterDateFrom', '2026-01-01');
  });

  it('pages through the log and shows the position', async () => {
    setStorage({ archiveViewMode: 'log', logPageSize: '25' });
    const offsets: string[] = [];
    useBaseHandlers([
      http.get('/api/v1/print-log/', ({ request }) => {
        const params = new URL(request.url).searchParams;
        offsets.push(params.get('offset') ?? '0');
        const start = Number(params.get('offset') ?? 0);
        const items = Array.from({ length: 25 }, (_, i) => entry(start + i + 1, { print_name: `Run ${start + i + 1}` }));
        return HttpResponse.json({ items, total: 60 });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 1');
    expect(screen.getByText('Page 1 / 3')).toBeInTheDocument();

    const pager = screen.getByText('Page 1 / 3').parentElement as HTMLElement;
    await user.click(within(pager).getAllByRole('button')[1]);

    expect(await screen.findByText('Page 2 / 3')).toBeInTheDocument();
    expect(offsets).toContain('25');
    expect(screen.getByText('Run 26')).toBeInTheDocument();
  });

  it('edits an entry status and saves only what changed', async () => {
    setStorage({ archiveViewMode: 'log' });
    const patches: unknown[] = [];
    useBaseHandlers([
      http.get('/api/v1/print-log/', () => HttpResponse.json({ items: [entry(5)], total: 1 })),
      http.patch('/api/v1/print-log/:id', async ({ request, params }) => {
        const text = await request.text();
        patches.push({ id: params.id, body: JSON.parse(text) });
        return HttpResponse.json({ ...entry(5), status: 'stopped' });
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 5');
    await user.click(screen.getByTitle('Edit print log entry'));
    expect(await screen.findByRole('heading', { name: 'Edit print log entry' })).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Completed' }));
    await user.click(await screen.findByRole('option', { name: 'Stopped' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Print log entry updated')).toBeInTheDocument();
    expect(patches).toEqual([{ id: '5', body: { status: 'stopped' } }]);
  });

  it('deletes nothing when the edit dialog is saved without changes', async () => {
    setStorage({ archiveViewMode: 'log' });
    const patches: unknown[] = [];
    useBaseHandlers([
      http.get('/api/v1/print-log/', () => HttpResponse.json({ items: [entry(6)], total: 1 })),
      http.patch('/api/v1/print-log/:id', async ({ request }) => {
        patches.push(await request.text());
        return HttpResponse.json(entry(6));
      }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 6');
    await user.click(screen.getByTitle('Edit print log entry'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Edit print log entry' })).not.toBeInTheDocument());
    expect(patches).toEqual([]);
  });
});
