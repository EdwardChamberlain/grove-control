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
import { setAuthToken } from '../../api/client';
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
    await user.click(screen.getByTestId('select-mode-toggle'));
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
    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());

    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(screen.getByRole('button', { name: 'Exit selection' }));
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

  it('puts clear log in the toolbar as an icon-only button', async () => {
    setView('log');
    useArchives();
    useLog(entries);
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    const clear = screen.getByRole('button', { name: /Clear Log/ });
    expect(clear).toHaveTextContent('');
    expect(clear).toHaveAttribute('title', expect.stringMatching(/Clear Log/));
    expect(clear).toBeEnabled();
  });

  it('disables clear log for someone without permission to delete all archives', async () => {
    setView('log');
    setAuthToken('test-token', 'session');
    try {
      server.use(
        http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
        http.get('/api/v1/auth/me', () =>
          HttpResponse.json({ id: 7, username: 'reader', groups: [], permissions: ['archives:read_all'] }),
        ),
      );
      useArchives();
      useLog(entries);
      render(<ArchivesPage />);

      await screen.findByText('Log Benchy');
      await waitFor(() => expect(screen.getByRole('button', { name: /Clear Log/ })).toBeDisabled());
    } finally {
      setAuthToken(null);
    }
  });

  it('does not show clear log outside the log view', async () => {
    setView('grid');
    useArchives();
    render(<ArchivesPage />);

    await screen.findByText('Benchy');
    expect(screen.queryByRole('button', { name: /Clear Log/ })).not.toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    setView('log');
    useArchives();
    useLog([]);
    render(<ArchivesPage />);

    expect(await screen.findByText('No print log entries found')).toBeInTheDocument();
  });

  it('still shows the log when there are no archives at all', async () => {
    setView('log');
    useArchives([]);
    useLog(entries);
    render(<ArchivesPage />);

    expect(await screen.findByText('Log Benchy')).toBeInTheDocument();
  });

  it('shares the filter bar with the other views and sends its filters to the log', async () => {
    setView('log');
    useArchives();
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('/api/v1/print-log/', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: entries, total: entries.length });
      }),
    );
    render(<ArchivesPage />);
    await screen.findByText('Log Benchy');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(await screen.findByLabelText('To'), { target: { value: '2026-01-31' } });
    await waitFor(() => expect(requests.some((r) => r.get('date_to') === new Date('2026-01-31T23:59:59.999').toISOString())).toBe(true));
    // Same panel as the grid view, not a log-only set.
    expect(screen.getByRole('button', { name: 'All Materials' })).toBeInTheDocument();
  });

  it('filters log rows through their archive and offers row actions', async () => {
    setView('log');
    const items = [archive(1, 'Benchy', { is_favorite: true }), archive(2, 'Bracket')];
    const calls = useArchives(items);
    const linked = [
      { ...entries[0], archive_id: 1 },
      { ...entries[1], archive_id: 2 },
    ];
    useLog(linked);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    await user.click(screen.getAllByTitle('Remove from Favorites')[0]);
    await waitFor(() => expect(calls.favorites).toEqual([1]));

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(await screen.findByRole('button', { name: /^Favorites$/ }));
    await waitFor(() => expect(screen.queryByText('Log Clip')).not.toBeInTheDocument());
    expect(screen.getByText('Log Benchy')).toBeInTheDocument();
  });

  it('opens the linked archive in the grid', async () => {
    setView('log');
    useArchives([archive(1, 'Benchy')]);
    useLog([{ ...entries[0], archive_id: 1 }]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    await user.click(screen.getByTitle('Show in grid'));
    expect(await screen.findAllByText('Benchy')).not.toHaveLength(0);
    expect(screen.queryByText('Log Benchy')).not.toBeInTheDocument();
  });
});

describe('ArchivesPage selection and the Filters panel', () => {
  it('Escape closes the Filters panel without dropping the selection', async () => {
    setView('grid');
    useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // With the panel closed, Escape clears the selection as before.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
  });

  it('switching to the log drops a selection made in the grid', async () => {
    setView('grid');
    useArchives();
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByTitle('Print Log'));
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
  });
});

describe('ArchivesPage print log selection and limits', () => {
  const logEntries = [
    { id: 11, archive_id: 1, print_name: 'Log Benchy', printer_name: 'X1 Carbon', created_by_username: 'ada', status: 'completed', duration_seconds: 3600, started_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' },
    { id: 12, archive_id: null, print_name: 'Orphan', printer_name: 'X1 Carbon', created_by_username: 'ada', status: 'completed', duration_seconds: 60, started_at: '2026-01-02T10:00:00Z', created_at: '2026-01-02T10:00:00Z' },
  ];

  it('Select All in the log selects only the archives behind the rows on screen', async () => {
    setView('log');
    useArchives();
    server.use(http.get('/api/v1/print-log/', () => HttpResponse.json({ items: logEntries, total: 2 })));
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    await user.click(screen.getByTestId('select-mode-toggle'));
    await user.click(screen.getByRole('button', { name: 'Select All' }));

    // Archive 2 (Bracket) has no row in the log and the orphan has no archive: only archive 1 counts.
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('says so when archive-level filters only cover the newest 500 prints', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      ({ archiveViewMode: 'log', archiveFilterFavorites: 'true' } as Record<string, string>)[key] ?? null,
    );
    useArchives([archive(1, 'Benchy', { is_favorite: true })]);
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('/api/v1/print-log/', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [logEntries[0]], total: 600 });
      }),
    );
    render(<ArchivesPage />);

    expect(await screen.findByText(/Filtering the newest 500 of 600 prints/)).toBeInTheDocument();
    expect(requests[0].get('limit')).toBe('500');
  });

  it('shows no note when the server did the filtering', async () => {
    setView('log');
    useArchives();
    server.use(http.get('/api/v1/print-log/', () => HttpResponse.json({ items: logEntries, total: 600 })));
    render(<ArchivesPage />);

    await screen.findByText('Log Benchy');
    expect(screen.queryByText(/Filtering the newest/)).not.toBeInTheDocument();
  });
});

describe('ArchivesPage print log: printer filter, server filters and paging', () => {
  const entry = (id: number, over: Record<string, unknown> = {}) => ({
    id, archive_id: 1, print_name: `Run ${id}`, printer_name: 'X1 Carbon', printer_id: 1, created_by_username: 'ada',
    status: 'completed', duration_seconds: 60, started_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z', ...over,
  });

  it('keeps a reprinted model\'s row actions when filtering the log by the printer it used', async () => {
    // Printed on printer 1, then reprinted on printer 2: the archive now says printer 2.
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      ({ archiveViewMode: 'log', archiveFilterPrinter: '1' } as Record<string, string>)[key] ?? null,
    );
    const archiveQueries: URLSearchParams[] = [];
    const reprinted = archive(1, 'Benchy', { printer_id: 2 });
    server.use(
      http.get('/api/v1/archives/', ({ request }) => {
        const params = new URL(request.url).searchParams;
        archiveQueries.push(params);
        const printerId = params.get('printer_id');
        return HttpResponse.json(printerId ? [reprinted].filter((a) => a.printer_id === Number(printerId)) : [reprinted]);
      }),
      http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: 1 })),
      http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }, { id: 2, name: 'P1S', model: 'P1S' }])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
      http.get('/api/v1/print-log/', () => HttpResponse.json({ items: [entry(11)], total: 1 })),
    );
    render(<ArchivesPage />);

    await screen.findByText('Run 11');
    // The lookup was not narrowed by the printer filter, so the row still has its archive actions.
    expect(await screen.findByTitle('Add to Favorites')).toBeInTheDocument();
    expect(archiveQueries.every((q) => !q.has('printer_id'))).toBe(true);
  });

  it('sends time-based collections to the server instead of fetching 500 rows', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      ({ archiveViewMode: 'log', archiveCollection: 'this-week' } as Record<string, string>)[key] ?? null,
    );
    useArchives();
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('/api/v1/print-log/', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [entry(11)], total: 600 });
      }),
    );
    render(<ArchivesPage />);

    await screen.findByText('Run 11');
    expect(requests[0].get('date_from')).toBeTruthy();
    expect(requests[0].get('limit')).toBe('25');
    expect(screen.queryByText(/Filtering the newest/)).not.toBeInTheDocument();
  });

  it('steps back a page when the last row on it disappears', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      ({ archiveViewMode: 'log', logPageSize: '10' } as Record<string, string>)[key] ?? null,
    );
    useArchives();
    let rows = Array.from({ length: 11 }, (_, i) => entry(i + 1, { archive_id: null, print_name: `Run ${String(i + 1).padStart(2, '0')}` }));
    server.use(
      http.get('/api/v1/print-log/', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        const limit = Number(params.get('limit') ?? 25);
        return HttpResponse.json({ items: rows.slice(offset, offset + limit), total: rows.length });
      }),
      http.delete('/api/v1/print-log/:id', ({ params }) => {
        rows = rows.filter((r) => r.id !== Number(params.id));
        return HttpResponse.json({ status: 'deleted', id: Number(params.id) });
      }),
    );
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 01');
    const pager = screen.getByText(/^Page 1/).parentElement as HTMLElement;
    const buttons = within(pager).getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('Run 11')).toBeInTheDocument();

    // Delete the only row on page 2: the page must step back rather than show an empty table.
    await user.click(screen.getAllByTitle(/Delete/i).filter((el) => el.closest('tr'))[0]);
    const confirm = await screen.findAllByRole('button', { name: /^Delete$/ });
    await user.click(confirm[confirm.length - 1]);

    expect(await screen.findByText('Run 01')).toBeInTheDocument();
    expect(screen.queryByText('No print log entries found')).not.toBeInTheDocument();
  });

  it('disables the favourite button on a row for someone who cannot update archives', async () => {
    setView('log');
    setAuthToken('test-token', 'session');
    try {
      server.use(
        http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
        http.get('/api/v1/auth/me', () =>
          HttpResponse.json({ id: 7, username: 'reader', groups: [], permissions: ['archives:read_all'] }),
        ),
      );
      useArchives([archive(1, 'Benchy', { created_by_id: 8 })]);
      server.use(http.get('/api/v1/print-log/', () => HttpResponse.json({ items: [entry(11)], total: 1 })));
      render(<ArchivesPage />);

      await screen.findByText('Run 11');
      const favourite = await screen.findByRole('button', { name: 'Add to Favorites' });
      await waitFor(() => expect(favourite).toBeDisabled());
      expect(favourite).toHaveAttribute('title', expect.stringMatching(/permission/i));
    } finally {
      setAuthToken(null);
    }
  });

  it('slides the "Last 24 hours" window on a refetch instead of reusing the first one', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      ({ archiveViewMode: 'log', archiveCollection: 'recent' } as Record<string, string>)[key] ?? null,
    );
    useArchives();
    const lowerBounds: string[] = [];
    let rows = [entry(11), entry(12, { archive_id: null })];
    server.use(
      http.get('/api/v1/print-log/', ({ request }) => {
        lowerBounds.push(new URL(request.url).searchParams.get('date_from') ?? '');
        return HttpResponse.json({ items: rows, total: rows.length });
      }),
      http.delete('/api/v1/print-log/:id', ({ params }) => {
        rows = rows.filter((r) => r.id !== Number(params.id));
        return HttpResponse.json({ status: 'deleted', id: Number(params.id) });
      }),
    );
    // Only Date is faked, so the network and React Query keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    try {
      const user = userEvent.setup();
      render(<ArchivesPage />);
      await screen.findByText('Run 11');
      expect(lowerBounds[0]).toBe('2026-06-14T12:00:00.000Z');

      // Two hours later something refetches the log (here: deleting a row).
      vi.setSystemTime(new Date('2026-06-15T14:00:00Z'));
      await user.click(screen.getAllByTitle(/Delete/i).filter((el) => el.closest('tr'))[0]);
      const confirm = await screen.findAllByRole('button', { name: /^Delete$/ });
      await user.click(confirm[confirm.length - 1]);

      await waitFor(() => expect(lowerBounds.length).toBeGreaterThan(1));
      expect(lowerBounds.at(-1)).toBe('2026-06-14T14:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says in the Export menu that the log exports models, not individual prints', async () => {
    setView('log');
    useArchives();
    server.use(http.get('/api/v1/print-log/', () => HttpResponse.json({ items: [entry(11)], total: 1 })));
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findByText('Run 11');
    await user.click(screen.getByRole('button', { name: /^Export$/ }));
    expect(screen.getByText(/one row per model/i)).toBeInTheDocument();
  });
});

describe('ArchivesPage with a bad saved date', () => {
  const entries = [
    { id: 11, archive_id: null, print_name: 'Log Benchy', printer_name: 'X1 Carbon', created_by_username: 'ada', status: 'completed', duration_seconds: 60, started_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' },
  ];
  // A saved date filter that isn't a real date (a 5-digit year typed into a date field) used to
  // make the page throw while rendering.
  for (const view of ['grid', 'log'] as const) {
    it(`still renders the ${view} view`, async () => {
      vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
        ({ archiveViewMode: view, logFilterDateFrom: '20255-01-01', logFilterDateTo: '2026-13-45' } as Record<string, string>)[key] ?? null,
      );
      useArchives();
      server.use(http.get('/api/v1/print-log/', () => HttpResponse.json({ items: entries, total: entries.length })));
      render(<ArchivesPage />);

      expect(await screen.findAllByText(view === 'grid' ? 'Benchy' : 'Log Benchy')).not.toHaveLength(0);
      // The bad values are dropped, so no date chip is shown.
      expect(screen.queryByRole('button', { name: /^Remove filter/ })).not.toBeInTheDocument();
    });
  }
});

describe('ArchivesPage deep links', () => {
  it('applies ?search= from another page and clears it from the URL', async () => {
    setView('grid');
    useArchives();
    window.history.pushState({}, '', '/archives?search=Bracket');
    render(<ArchivesPage />);

    expect(await screen.findAllByText('Bracket')).not.toHaveLength(0);
    expect(screen.queryByText('Benchy')).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    window.history.pushState({}, '', '/');
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

  it('shows the day detail for a selected day and the month totals for the whole page', async () => {
    setView('calendar');
    const now = new Date();
    const when = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
    useArchives([
      archive(1, 'Benchy', { created_at: when, started_at: when, completed_at: when }),
      archive(2, 'Bracket', { created_at: when, started_at: when, completed_at: when, status: 'failed' }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    expect(await screen.findByText('Select a day to see prints')).toBeInTheDocument();
    expect(screen.getByText('Prints this month').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Successful').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Failed').previousElementSibling).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: /^15\s*2$/ }));
    expect(await screen.findByText('Benchy')).toBeInTheDocument();
    expect(screen.getByText('Bracket')).toBeInTheDocument();
    expect(screen.queryByText('Select a day to see prints')).not.toBeInTheDocument();
  });

  it('jumps to the grid view when a print in the day detail is clicked', async () => {
    setView('calendar');
    const when = new Date(new Date().getFullYear(), new Date().getMonth(), 15, 12).toISOString();
    useArchives([archive(1, 'Benchy', { created_at: when, started_at: when, completed_at: when })]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await user.click(await screen.findByRole('button', { name: /^15\s*1$/ }));
    await user.click(await screen.findByRole('button', { name: /Benchy/ }));

    await waitFor(() => expect(screen.queryByText('Prints this month')).not.toBeInTheDocument());
    expect(screen.getByText('Benchy')).toBeInTheDocument();
  });
});
