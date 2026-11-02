/**
 * ArchivesPage: the toolbar filters, sort order, collections, search and
 * pagination in the archive grid.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { server } from '../mocks/server';

type Overrides = Record<string, unknown>;

function archive(id: number, name: string, extra: Overrides = {}) {
  return {
    id,
    filename: `${name.toLowerCase()}.gcode.3mf`,
    print_name: name,
    printer_id: 1,
    printer_name: 'X1 Carbon',
    file_path: `archive/${id}/${name}.gcode.3mf`,
    file_size: id * 1000,
    status: 'completed',
    created_at: new Date(Date.UTC(2026, 0, id, 9)).toISOString(),
    completed_at: new Date(Date.UTC(2026, 0, id, 11)).toISOString(),
    started_at: new Date(Date.UTC(2026, 0, id, 10)).toISOString(),
    print_time_seconds: 3600,
    is_favorite: false,
    tags: null,
    photos: null,
    filament_type: 'PLA',
    filament_color: null,
    duplicate_count: 0,
    duplicate_sequence: 0,
    ...extra,
  };
}

const printers = [
  { id: 1, name: 'X1 Carbon', model: 'X1C' },
  { id: 2, name: 'P1S', model: 'P1S' },
];

/**
 * Serves the given archives. The printer filter is applied on the server
 * side, as the real endpoint does, and every request's query is recorded.
 */
function useArchives(items: ReturnType<typeof archive>[]) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get('/api/v1/archives/', ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params);
      const printerId = params.get('printer_id');
      return HttpResponse.json(printerId ? items.filter((a) => a.printer_id === Number(printerId)) : items);
    }),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_prints: items.length })),
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
  );
  return { queries };
}

function setStorage(values: Record<string, string>) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => values[key] ?? null);
}

beforeEach(() => {
  setStorage({ archiveViewMode: 'grid' });
});

/** Print names in the order they appear on the page. */
function visibleNames(names: string[]): string[] {
  return screen.getAllByText(new RegExp(`^(${names.join('|')})$`)).map((el) => el.textContent ?? '');
}

async function pickOption(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
  await user.click(screen.getByRole('button', { name: trigger }));
  await user.click(await screen.findByRole('button', { name: option }));
}

describe('ArchivesPage printer and material filters', () => {
  it('filters by printer on the server and shows the matching count', async () => {
    const items = [
      archive(1, 'Benchy', { printer_id: 1 }),
      archive(2, 'Bracket', { printer_id: 2, printer_name: 'P1S' }),
      archive(3, 'Clip', { printer_id: 2, printer_name: 'P1S' }),
    ];
    const { queries } = useArchives(items);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    expect(screen.getByText('3 of 3 prints')).toBeInTheDocument();

    await pickOption(user, 'All Printers', 'P1S');

    await waitFor(() => expect(queries.at(-1)?.get('printer_id')).toBe('2'));
    expect(await screen.findByText('2 of 2 prints')).toBeInTheDocument();
    expect(screen.queryByText('Benchy')).not.toBeInTheDocument();
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveFilterPrinter', '2');
  });

  it('filters by material and resets back to every print', async () => {
    useArchives([
      archive(1, 'Benchy', { filament_type: 'PLA' }),
      archive(2, 'Gear', { filament_type: 'PETG, PLA' }),
      archive(3, 'Vase', { filament_type: 'ASA' }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    await pickOption(user, 'All Materials', 'PETG');

    expect(await screen.findByText('Gear')).toBeInTheDocument();
    expect(screen.queryByText('Benchy')).not.toBeInTheDocument();
    expect(screen.queryByText('Vase')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 prints')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('3 of 3 prints')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });
});

describe('ArchivesPage colour filter', () => {
  it('matches any or all selected colours and can be cleared', async () => {
    useArchives([
      archive(1, 'Red Cube', { filament_color: '#FF0000,#00FF00' }),
      archive(2, 'Red Cap', { filament_color: '#FF0000' }),
      archive(3, 'Green Cup', { filament_color: '#00FF00' }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Red Cube');
    const colours = within(screen.getByText('Colors:').parentElement as HTMLElement);

    await user.click(colours.getByTitle('#FF0000'));
    expect(await screen.findByText('2 of 3 prints')).toBeInTheDocument();

    await user.click(colours.getByTitle('#00FF00'));
    expect(await screen.findByText('3 of 3 prints')).toBeInTheDocument();

    // Switching to AND keeps only prints that carry both colours.
    await user.click(colours.getByRole('button', { name: 'OR' }));
    expect(await screen.findByText('1 of 3 prints')).toBeInTheDocument();
    expect(screen.getByText('Red Cube')).toBeInTheDocument();
    expect(screen.queryByText('Red Cap')).not.toBeInTheDocument();

    await user.click(colours.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('3 of 3 prints')).toBeInTheDocument();
  });
});

describe('ArchivesPage toggle filters', () => {
  it('hides failed prints, duplicates and shows favourites only', async () => {
    useArchives([
      archive(1, 'Fav Print', { is_favorite: true }),
      archive(2, 'Failed Print', { status: 'failed' }),
      archive(3, 'Copy Print', { duplicate_count: 2, duplicate_sequence: 1 }),
      archive(4, 'Plain Print'),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Plain Print');
    expect(screen.getByText('4 of 4 prints')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide Failed' }));
    expect(await screen.findByText('3 of 4 prints')).toBeInTheDocument();
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveHideFailed', 'true');

    await user.click(screen.getByRole('button', { name: 'Hide Duplicates' }));
    expect(await screen.findByText('2 of 4 prints')).toBeInTheDocument();
    expect(screen.queryByText('Copy Print')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(await screen.findByText('1 of 4 prints')).toBeInTheDocument();
    expect(screen.getByText('Fav Print')).toBeInTheDocument();

    // Clicking the active toggle again turns it off.
    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(await screen.findByText('2 of 4 prints')).toBeInTheDocument();
  });

  it('separates sliced files from source-only projects', async () => {
    useArchives([
      archive(1, 'Sliced Part'),
      archive(2, 'Source Part', { filename: 'source-part.3mf', print_time_seconds: null, total_layers: null }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Sliced Part');
    await pickOption(user, 'All Files', 'Source Only');
    expect(await screen.findByText('Source Part')).toBeInTheDocument();
    expect(screen.queryByText('Sliced Part')).not.toBeInTheDocument();

    await pickOption(user, 'Source Only', 'Sliced (GCODE)');
    expect(await screen.findByText('Sliced Part')).toBeInTheDocument();
    expect(screen.queryByText('Source Part')).not.toBeInTheDocument();
  });

  it('filters by tag once tags exist', async () => {
    useArchives([
      archive(1, 'Tagged', { tags: 'calibration, test' }),
      archive(2, 'Untagged'),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Untagged');
    await pickOption(user, 'All Tags', 'calibration');

    expect(await screen.findByText('Tagged')).toBeInTheDocument();
    expect(screen.queryByText('Untagged')).not.toBeInTheDocument();
  });
});

describe('ArchivesPage sorting', () => {
  const items = [
    archive(3, 'Alpha'),
    archive(1, 'Bravo'),
    archive(2, 'Charlie'),
  ];

  it('sorts by name and remembers the choice', async () => {
    useArchives(items);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Alpha');
    expect(visibleNames(['Alpha', 'Bravo', 'Charlie'])).toEqual(['Alpha', 'Charlie', 'Bravo']);

    await pickOption(user, 'Newest first', 'Name A-Z');
    await waitFor(() => expect(visibleNames(['Alpha', 'Bravo', 'Charlie'])).toEqual(['Alpha', 'Bravo', 'Charlie']));
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveSortBy', 'name-asc');
  });

  it('sorts by file size', async () => {
    useArchives(items);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Alpha');
    await pickOption(user, 'Newest first', 'Smallest first');
    await waitFor(() => expect(visibleNames(['Alpha', 'Bravo', 'Charlie'])).toEqual(['Bravo', 'Charlie', 'Alpha']));

    await pickOption(user, 'Smallest first', 'Largest first');
    await waitFor(() => expect(visibleNames(['Alpha', 'Bravo', 'Charlie'])).toEqual(['Alpha', 'Charlie', 'Bravo']));
  });
});

describe('ArchivesPage collections, search and pagination', () => {
  it('narrows to recent prints and to failed prints', async () => {
    const now = new Date().toISOString();
    useArchives([
      archive(1, 'Fresh Print', { created_at: now }),
      archive(2, 'Old Failure', { created_at: '2020-01-01T00:00:00Z', status: 'failed' }),
      archive(3, 'Old Print', { created_at: '2020-01-01T00:00:00Z' }),
    ]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Old Print');
    await pickOption(user, 'All Archives', 'Last 24 Hours');
    expect(await screen.findByText('Fresh Print')).toBeInTheDocument();
    expect(screen.queryByText('Old Print')).not.toBeInTheDocument();

    await pickOption(user, 'Last 24 Hours', 'Failed Prints');
    expect(await screen.findByText('Old Failure')).toBeInTheDocument();
    expect(screen.queryByText('Fresh Print')).not.toBeInTheDocument();
  });

  it('searches by name and shows a message when nothing matches', async () => {
    useArchives([archive(1, 'Benchy'), archive(2, 'Bracket')]);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Benchy');
    const search = screen.getByPlaceholderText('Search archives...');

    await user.type(search, 'brack');
    expect(await screen.findByText('1 of 2 prints')).toBeInTheDocument();
    expect(screen.queryByText('Benchy')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(await screen.findByText('No archives match your search')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 prints')).toBeInTheDocument();
  });

  it('pages through a long list with the page size control', async () => {
    setStorage({ archiveViewMode: 'grid', archivePageSize: '25' });
    const many = Array.from({ length: 26 }, (_, i) => archive(i + 1, `Print ${String(i + 1).padStart(2, '0')}`));
    useArchives(many);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Print 26');
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    const pager = screen.getByText('Page 1 of 2').parentElement as HTMLElement;
    const buttons = within(pager).getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Print 01')).toBeInTheDocument();
    expect(screen.queryByText('Print 26')).not.toBeInTheDocument();

    await user.click(within(pager).getAllByRole('button')[1]);
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Print 26')).toBeInTheDocument();
  });

  it('shows every print at once when "All" is chosen', async () => {
    setStorage({ archiveViewMode: 'grid', archivePageSize: '25' });
    const many = Array.from({ length: 26 }, (_, i) => archive(i + 1, `Print ${String(i + 1).padStart(2, '0')}`));
    useArchives(many);
    const user = userEvent.setup();
    render(<ArchivesPage />);

    await screen.findAllByText('Print 26');
    await user.click(screen.getByRole('combobox', { name: '25' }));
    await user.click(await screen.findByRole('option', { name: 'All' }));

    expect(await screen.findByText('26 prints')).toBeInTheDocument();
    expect(screen.queryByText('Page 1 of 2')).not.toBeInTheDocument();
    expect(screen.getByText('Print 01')).toBeInTheDocument();
  });
});
