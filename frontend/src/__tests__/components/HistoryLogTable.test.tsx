import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { HistoryLogTable } from '../../components/HistoryLogTable';
import type { Archive, PrintLogEntry } from '../../api/client';

function archive(id: number, over: Record<string, unknown> = {}): Archive {
  return {
    id, filename: `model${id}.gcode.3mf`, print_name: `Model ${id}`, file_path: `archive/${id}/model${id}.gcode.3mf`,
    status: 'completed', is_favorite: false, created_by_id: null, total_layers: 100, print_time_seconds: 3600, ...over,
  } as unknown as Archive;
}

function entry(id: number, over: Record<string, unknown> = {}): PrintLogEntry {
  return {
    id, archive_id: null, print_name: `Run ${id}`, printer_name: 'X1 Carbon', created_by_username: 'ada', status: 'completed',
    duration_seconds: 3600, started_at: '2026-01-02T10:00:00Z', created_at: '2026-01-02T10:00:00Z',
    filament_type: 'PLA', filament_color: null, cost: null, failure_reason: null, thumbnail_path: null, ...over,
  } as unknown as PrintLogEntry;
}

const linked = entry(1, { archive_id: 1, filament_color: '#FF0000,#00FF00', cost: 1.5, thumbnail_path: 'thumb.png' });
const orphan = entry(2, { status: 'failed', failure_reason: 'spaghettiDetached', duration_seconds: null });
const sourceOnly = entry(3, { archive_id: 2, status: 'stopped' });

function setup(over: Partial<Parameters<typeof HistoryLogTable>[0]> = {}) {
  const props = {
    rows: [linked, orphan, sourceOnly],
    isLoading: false,
    total: 3,
    offset: 0,
    pageSize: 25,
    onOffsetChange: vi.fn(),
    onPageSizeChange: vi.fn(),
    archiveById: new Map<number, Archive>([
      [1, archive(1)],
      // A source project: no gcode, and no file to download.
      [2, archive(2, { filename: 'model2.3mf', file_path: '', total_layers: null, print_time_seconds: null })],
    ]),
    selectionMode: false,
    selectedIds: new Set<number>(),
    onToggleSelect: vi.fn(),
    timeFormat: 'system' as const,
    currency: '$',
    hasActiveFilters: false,
    onResetFilters: vi.fn(),
    onReprint: vi.fn(),
    onToggleFavourite: vi.fn(),
    onDownload: vi.fn(),
    onShowInGrid: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    busy: { editing: false, deleting: false },
    ...over,
  };
  render(<HistoryLogTable {...props} />);
  return props;
}

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('HistoryLogTable rows', () => {
  it('shows what was printed, on what, by whom, how it went and what it cost', () => {
    setup();
    const row = within(rowOf('Run 1'));
    expect(row.getByText('X1 Carbon')).toBeInTheDocument();
    expect(row.getByText('ada')).toBeInTheDocument();
    expect(row.getByText('completed')).toBeInTheDocument();
    expect(row.getByText('1h 0m')).toBeInTheDocument();
    expect(row.getByText('$1.50')).toBeInTheDocument();
    // One swatch per filament colour, and the material.
    expect(row.getByTitle('#FF0000')).toBeInTheDocument();
    expect(row.getByTitle('#00FF00')).toBeInTheDocument();
    expect(row.getByText('PLA')).toBeInTheDocument();
  });

  it('explains a failure and shows dashes for what is unknown', () => {
    setup();
    const row = within(rowOf('Run 2'));
    expect(row.getByText('failed')).toBeInTheDocument();
    expect(row.getByText('Spaghetti / Detached')).toBeInTheDocument();
    // No duration and no cost.
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('colours the status pill by outcome', () => {
    setup();
    expect(screen.getByText('completed').className).toContain('green');
    expect(screen.getByText('failed').className).toContain('red');
    expect(screen.getByText('stopped').className).toContain('yellow');
  });
});

describe('HistoryLogTable row actions', () => {
  it('offers archive actions only on rows whose archive still exists', () => {
    setup();
    expect(within(rowOf('Run 1')).getByRole('button', { name: 'Reprint' })).toBeInTheDocument();
    // The orphan has no archive behind it.
    const orphanRow = within(rowOf('Run 2'));
    expect(orphanRow.queryByRole('button', { name: 'Reprint' })).not.toBeInTheDocument();
    expect(orphanRow.queryByRole('button', { name: /Favorites/ })).not.toBeInTheDocument();
    expect(orphanRow.queryByRole('button', { name: /Show .* in grid/ })).not.toBeInTheDocument();
    // But it can still be edited and deleted.
    expect(orphanRow.getByTitle('Edit print log entry')).toBeInTheDocument();
    expect(orphanRow.getByTitle('Delete print log entry')).toBeInTheDocument();
  });

  it('wires each action to its handler with the right target', async () => {
    const user = userEvent.setup();
    const props = setup();
    const row = within(rowOf('Run 1'));

    await user.click(row.getByRole('button', { name: 'Reprint' }));
    expect(props.onReprint).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

    await user.click(row.getByRole('button', { name: 'Add to Favorites' }));
    expect(props.onToggleFavourite).toHaveBeenCalledWith(1);

    await user.click(row.getByRole('button', { name: 'Download' }));
    expect(props.onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

    await user.click(row.getByRole('button', { name: /Show .* in grid|Show in grid/ }));
    expect(props.onShowInGrid).toHaveBeenCalledWith(1);

    await user.click(row.getByTitle('Edit print log entry'));
    expect(props.onEdit).toHaveBeenCalledWith(linked);

    await user.click(row.getByTitle('Delete print log entry'));
    expect(props.onDelete).toHaveBeenCalledWith(1);
  });

  it('labels the favourite button for what it will do', () => {
    setup({ archiveById: new Map([[1, archive(1, { is_favorite: true })]]), rows: [linked] });
    expect(screen.getByRole('button', { name: 'Remove from Favorites' })).toBeInTheDocument();
  });

  it('does not offer to reprint a source project, and cannot download one with no file', () => {
    setup();
    const row = within(rowOf('Run 3'));
    expect(row.queryByRole('button', { name: 'Reprint' })).not.toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('disables edit and delete while they are in flight', () => {
    setup({ busy: { editing: true, deleting: true } });
    const row = within(rowOf('Run 2'));
    expect(row.getByTitle('Edit print log entry')).toBeDisabled();
    expect(row.getByTitle('Delete print log entry')).toBeDisabled();
  });
});

describe('HistoryLogTable selection', () => {
  it('shows checkboxes only in selection mode, and only for rows with an archive', async () => {
    const user = userEvent.setup();
    const { onToggleSelect } = setup({ selectionMode: true, selectedIds: new Set([1]) });

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2); // Run 1 and Run 3; the orphan has none
    expect(within(rowOf('Run 1')).getByRole('checkbox')).toBeChecked();
    expect(within(rowOf('Run 3')).getByRole('checkbox')).not.toBeChecked();

    await user.click(within(rowOf('Run 3')).getByRole('checkbox'));
    expect(onToggleSelect).toHaveBeenCalledWith(2);
  });

  it('has no checkboxes outside selection mode', () => {
    setup();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('HistoryLogTable states', () => {
  it('shows only a spinner while loading', () => {
    setup({ isLoading: true });
    expect(screen.queryByText('Run 1')).not.toBeInTheDocument();
    expect(screen.queryByText('No print log entries found')).not.toBeInTheDocument();
  });

  it('offers a way out of an empty result only when filters are the cause', async () => {
    const user = userEvent.setup();
    const { onResetFilters } = setup({ rows: [], total: 0, hasActiveFilters: true });

    expect(screen.getByText('No print log entries found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onResetFilters).toHaveBeenCalled();
  });

  it('says there is nothing, without a reset, when no filter is active', () => {
    setup({ rows: [], total: 0, hasActiveFilters: false });
    expect(screen.getByText('No print log entries found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
  });
});

describe('HistoryLogTable paging', () => {
  it('reports how many are shown and which page this is', () => {
    setup({ total: 60, offset: 25, pageSize: 25 });
    expect(screen.getByText('Showing 50 of 60 entries')).toBeInTheDocument();
    expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
  });

  it('steps forward and back a page at a time', async () => {
    const user = userEvent.setup();
    const props = setup({ total: 60, offset: 25, pageSize: 25 });
    const pager = screen.getByText('Page 2 / 3').parentElement as HTMLElement;
    const [prev, next] = within(pager).getAllByRole('button');

    await user.click(next);
    expect(props.onOffsetChange).toHaveBeenLastCalledWith(50);
    await user.click(prev);
    expect(props.onOffsetChange).toHaveBeenLastCalledWith(0);
  });

  it('disables Previous on the first page and Next on the last', () => {
    setup({ total: 3, offset: 0, pageSize: 25 });
    const pager = screen.getByText('Page 1 / 1').parentElement as HTMLElement;
    const [prev, next] = within(pager).getAllByRole('button');
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();
  });

  it('goes back to the first page when the page size changes', async () => {
    const user = userEvent.setup();
    const props = setup({ total: 60, offset: 25, pageSize: 25 });

    screen.getByRole('combobox').focus();
    await user.keyboard('[ArrowDown][Enter]');

    expect(props.onPageSizeChange).toHaveBeenCalledWith(50);
    expect(props.onOffsetChange).toHaveBeenCalledWith(0);
  });
});
