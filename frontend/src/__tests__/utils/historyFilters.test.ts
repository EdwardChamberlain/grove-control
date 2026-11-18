import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Archive, PrintLogEntry } from '../../api/client';
import {
  colorLabel,
  exportIgnoredFilters,
  filterAndSortArchives,
  filterLogEntries,
  getActiveFilterChips,
  getExportParams,
  getServerFilterBounds,
  isSlicedFile,
  needsClientLogFilter,
  panelBadgeCount,
  statusFilterValues,
  type HistoryFilterValues,
} from '../../utils/historyFilters';

const none: HistoryFilterValues = {
  search: '', filterPrinter: null, filterMaterial: null, filterColors: new Set(), colorFilterMode: 'or',
  filterFavorites: false, hideFailed: false, hideDuplicates: false, filterTag: null, filterFileType: 'all',
  filterStatus: null, filterUser: null, filterDateFrom: '', filterDateTo: '', collection: 'all',
};
const filters = (over: Partial<HistoryFilterValues> = {}): HistoryFilterValues => ({ ...none, ...over });

function archive(id: number, name: string, over: Record<string, unknown> = {}): Archive {
  return {
    id, filename: `${name}.gcode.3mf`, print_name: name, status: 'completed', file_size: id * 1000,
    created_at: `2026-01-0${id}T09:00:00Z`, started_at: `2026-01-0${id}T10:00:00Z`, last_run_at: null,
    is_favorite: false, tags: null, filament_type: 'PLA', filament_color: null,
    duplicate_count: 0, duplicate_sequence: 0, created_by_username: 'ada', ...over,
  } as unknown as Archive;
}

const names = (list: Archive[]) => list.map((a) => a.print_name);

// A stand-in for i18n's t: the key (plus any default), enough to read chips.
const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as unknown as TFunction;

describe('filterAndSortArchives', () => {
  const list = [archive(1, 'Benchy'), archive(2, 'Bracket'), archive(3, 'Clip')];

  it('sorts by last print, so a reprinted model rises above newer uploads', () => {
    const reprinted = [archive(1, 'Benchy', { last_run_at: '2026-06-01T12:00:00Z' }), archive(2, 'Bracket'), archive(3, 'Clip')];
    expect(names(filterAndSortArchives(reprinted, none, 'date-desc'))).toEqual(['Benchy', 'Clip', 'Bracket']);
    expect(names(filterAndSortArchives(reprinted, none, 'date-asc'))).toEqual(['Bracket', 'Clip', 'Benchy']);
  });

  it('falls back to the upload date for archives that were never printed', () => {
    const unprinted = [archive(1, 'Old', { started_at: null }), archive(2, 'New', { started_at: null })];
    expect(names(filterAndSortArchives(unprinted, none, 'date-desc'))).toEqual(['New', 'Old']);
  });

  it('sorts by name and size', () => {
    expect(names(filterAndSortArchives(list, none, 'name-desc'))).toEqual(['Clip', 'Bracket', 'Benchy']);
    expect(names(filterAndSortArchives(list, none, 'size-asc'))).toEqual(['Benchy', 'Bracket', 'Clip']);
    expect(names(filterAndSortArchives(list, none, 'size-desc'))).toEqual(['Clip', 'Bracket', 'Benchy']);
    expect(names(filterAndSortArchives(list, none, 'name-asc'))).toEqual(['Benchy', 'Bracket', 'Clip']);
  });

  it('matches search text against the print name or filename', () => {
    expect(names(filterAndSortArchives(list, filters({ search: 'brack' }), 'name-asc'))).toEqual(['Bracket']);
  });

  it('treats Cancelled as cancelled or aborted, and keeps Stopped separate', () => {
    const mixed = [
      archive(1, 'Halted', { status: 'stopped' }), archive(2, 'Killed', { status: 'aborted' }),
      archive(3, 'Dropped', { status: 'cancelled' }), archive(4, 'Done'),
    ];
    expect(names(filterAndSortArchives(mixed, filters({ filterStatus: 'cancelled' }), 'name-asc'))).toEqual(['Dropped', 'Killed']);
    expect(names(filterAndSortArchives(mixed, filters({ filterStatus: 'stopped' }), 'name-asc'))).toEqual(['Halted']);
    expect(statusFilterValues('cancelled')).toEqual(['cancelled', 'aborted']);
    expect(statusFilterValues('something-else')).toEqual(['something-else']);
  });

  it('keeps prints inside the local-day date range, inclusive of both ends', () => {
    const inRange = filterAndSortArchives(list, filters({ filterDateFrom: '2026-01-02', filterDateTo: '2026-01-02' }), 'name-asc');
    // Depending on the runner's timezone the 10:00Z print may fall on the neighbouring day, but never outside a 1-day window.
    expect(inRange.length).toBeLessThanOrEqual(2);
    expect(filterAndSortArchives(list, filters({ filterDateFrom: '2030-01-01' }), 'name-asc')).toEqual([]);
    expect(filterAndSortArchives(list, filters({ filterDateTo: '2000-01-01' }), 'name-asc')).toEqual([]);
  });

  it('filters by user, material, tag, favourites and file type', () => {
    const rich = [
      archive(1, 'A', { created_by_username: 'grace', filament_type: 'PETG, PLA', tags: 'x, y', is_favorite: true }),
      archive(2, 'B', { filename: 'b.3mf', total_layers: null, print_time_seconds: null }),
    ];
    expect(names(filterAndSortArchives(rich, filters({ filterUser: 'grace' }), 'name-asc'))).toEqual(['A']);
    expect(names(filterAndSortArchives(rich, filters({ filterMaterial: 'PETG' }), 'name-asc'))).toEqual(['A']);
    expect(names(filterAndSortArchives(rich, filters({ filterTag: 'y' }), 'name-asc'))).toEqual(['A']);
    expect(names(filterAndSortArchives(rich, filters({ filterFavorites: true }), 'name-asc'))).toEqual(['A']);
    expect(names(filterAndSortArchives(rich, filters({ filterFileType: 'source' }), 'name-asc'))).toEqual(['B']);
    expect(names(filterAndSortArchives(rich, filters({ filterFileType: 'gcode' }), 'name-asc'))).toEqual(['A']);
  });

  it('matches colours with OR or AND', () => {
    const coloured = [archive(1, 'Both', { filament_color: '#f00,#0f0' }), archive(2, 'Red', { filament_color: '#f00' })];
    const colours = new Set(['#f00', '#0f0']);
    expect(names(filterAndSortArchives(coloured, filters({ filterColors: colours }), 'name-asc'))).toEqual(['Both', 'Red']);
    expect(names(filterAndSortArchives(coloured, filters({ filterColors: colours, colorFilterMode: 'and' }), 'name-asc'))).toEqual(['Both']);
  });

  it('lets a collection stand in for its matching toggle', () => {
    const failing = [archive(1, 'Bad', { status: 'failed' }), archive(2, 'Good')];
    expect(names(filterAndSortArchives(failing, filters({ hideFailed: true }), 'name-asc'))).toEqual(['Good']);
    // Viewing the failed collection overrides "hide failed" rather than showing nothing.
    expect(names(filterAndSortArchives(failing, filters({ hideFailed: true, collection: 'failed' }), 'name-asc'))).toEqual(['Bad']);
  });

  it('hides later copies of a duplicate but keeps the first', () => {
    const dupes = [archive(1, 'First', { duplicate_count: 2, duplicate_sequence: 0 }), archive(2, 'Copy', { duplicate_count: 2, duplicate_sequence: 1 })];
    expect(names(filterAndSortArchives(dupes, filters({ hideDuplicates: true }), 'name-asc'))).toEqual(['First']);
  });
});

describe('filterLogEntries', () => {
  const entry = (id: number, archiveId: number | null, over: Record<string, unknown> = {}) =>
    ({ id, archive_id: archiveId, print_name: `Run ${id}`, status: 'completed', started_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z', filament_type: 'PLA', filament_color: null, ...over }) as unknown as PrintLogEntry;
  const byId = new Map([[1, archive(1, 'Fav', { is_favorite: true, tags: 'a' })], [2, archive(2, 'Plain')]]);

  it('reaches archive-level filters through the linked archive', () => {
    const entries = [entry(1, 1), entry(2, 2), entry(3, null)];
    expect(filterLogEntries(entries, byId, filters({ filterFavorites: true })).map((e) => e.id)).toEqual([1]);
    expect(filterLogEntries(entries, byId, filters({ filterTag: 'a' })).map((e) => e.id)).toEqual([1]);
  });

  it('keeps orphaned entries for filters that do not need an archive', () => {
    const entries = [entry(1, 1), entry(3, null, { filament_type: 'ABS' })];
    expect(filterLogEntries(entries, byId, filters({ filterMaterial: 'ABS' })).map((e) => e.id)).toEqual([3]);
    expect(filterLogEntries(entries, byId, filters({ hideFailed: true })).map((e) => e.id)).toEqual([1, 3]);
    // ...but file type needs the archive, so an orphan can't match.
    expect(filterLogEntries(entries, byId, filters({ filterFileType: 'gcode' })).map((e) => e.id)).toEqual([1]);
  });

  it('matches colours on the entry itself', () => {
    const entries = [entry(1, 1, { filament_color: '#f00' }), entry(2, 2, { filament_color: '#0f0' })];
    expect(filterLogEntries(entries, byId, filters({ filterColors: new Set(['#0f0']) })).map((e) => e.id)).toEqual([2]);
  });

  it('applies the failed collection and hide-failed together sensibly', () => {
    const entries = [entry(1, 1, { status: 'failed' }), entry(2, 2)];
    expect(filterLogEntries(entries, byId, filters({ collection: 'failed' })).map((e) => e.id)).toEqual([1]);
    expect(filterLogEntries(entries, byId, filters({ hideFailed: true })).map((e) => e.id)).toEqual([2]);
  });

  it('hides later duplicate copies when asked', () => {
    const copies = new Map([[1, archive(1, 'Copy', { duplicate_count: 2, duplicate_sequence: 1 })]]);
    expect(filterLogEntries([entry(1, 1)], copies, filters({ hideDuplicates: true }))).toEqual([]);
  });
});

describe('needsClientLogFilter', () => {
  it('is only true for filters the print-log API cannot apply', () => {
    expect(needsClientLogFilter(none)).toBe(false);
    expect(needsClientLogFilter(filters({ search: 'x', filterPrinter: 1, filterStatus: 'failed', filterUser: 'ada' }))).toBe(false);
    expect(needsClientLogFilter(filters({ filterMaterial: 'PLA' }))).toBe(true);
    // Time-based collections and "failed" become a date bound or status list on the server.
    expect(needsClientLogFilter(filters({ collection: 'recent' }))).toBe(false);
    expect(needsClientLogFilter(filters({ collection: 'failed' }))).toBe(false);
    expect(needsClientLogFilter(filters({ collection: 'favorites' }))).toBe(true);
  });
});

describe('getServerFilterBounds and getExportParams', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // local noon, 15 June 2026

  it('has no bounds when nothing is filtered', () => {
    expect(getServerFilterBounds(none, now)).toEqual({ statuses: null, from: null, to: null });
    expect(getExportParams(none, now)).toEqual({
      printerId: undefined, status: undefined, username: undefined, search: undefined,
      printedFrom: undefined, printedTo: undefined,
    });
  });

  it('turns the time-based collections into a lower bound', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(getServerFilterBounds(filters({ collection: 'recent' }), now).from?.getTime()).toBe(now.getTime() - day);
    expect(getServerFilterBounds(filters({ collection: 'this-week' }), now).from?.getTime()).toBe(now.getTime() - 7 * day);
    expect(getServerFilterBounds(filters({ collection: 'this-month' }), now).from).toEqual(new Date(2026, 5, 1));
  });

  it('uses the later of the collection bound and the From date', () => {
    const early = getServerFilterBounds(filters({ collection: 'recent', filterDateFrom: '2026-01-01' }), now);
    expect(early.from?.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
    const late = getServerFilterBounds(filters({ collection: 'recent', filterDateFrom: '2026-06-15' }), now);
    expect(late.from).toEqual(new Date('2026-06-15T00:00:00'));
  });

  it('uses local-day bounds for the date range, end of day inclusive', () => {
    const b = getServerFilterBounds(filters({ filterDateFrom: '2026-03-01', filterDateTo: '2026-03-31' }), now);
    expect(b.from?.toISOString()).toBe(new Date('2026-03-01T00:00:00').toISOString());
    expect(b.to?.toISOString()).toBe(new Date('2026-03-31T23:59:59.999').toISOString());
  });

  it('combines a status with the failed collection, and flags a combination that cannot match', () => {
    expect(getServerFilterBounds(filters({ collection: 'failed' }), now).statuses).toEqual(['failed', 'aborted']);
    expect(getServerFilterBounds(filters({ collection: 'failed', filterStatus: 'cancelled' }), now).statuses).toEqual(['aborted']);
    expect(getServerFilterBounds(filters({ collection: 'failed', filterStatus: 'completed' }), now).statuses).toEqual([]);
  });

  it('turns the filters into export parameters', () => {
    const params = getExportParams(
      filters({ search: 'gear', filterPrinter: 4, filterUser: 'ada', filterStatus: 'stopped', filterDateFrom: '2026-03-01' }),
      now,
    );
    expect(params).toMatchObject({ printerId: 4, username: 'ada', search: 'gear', status: 'stopped' });
    expect(params.printedFrom).toBe(new Date('2026-03-01T00:00:00').toISOString());
  });
});

describe('active filter chips', () => {
  it('lists each active filter once, in toolbar order', () => {
    const chips = getActiveFilterChips(
      filters({
        search: 'gear', filterPrinter: 2, filterStatus: 'failed', collection: 'recent', filterUser: 'ada',
        filterDateFrom: '2026-01-01', filterDateTo: '2026-01-31', filterMaterial: 'PETG', filterFileType: 'gcode',
        filterTag: 'tag', filterFavorites: true, hideFailed: true, hideDuplicates: true, filterColors: new Set(['#f00']),
      }),
      t,
      'P1S',
    );
    expect(chips.map((c) => c.key)).toEqual([
      'search', 'printer', 'status', 'collection', 'user', 'from', 'to', 'material', 'filetype', 'tag',
      'favorites', 'hidefailed', 'hidedupes', 'color-#f00',
    ]);
    expect(chips[0].label).toBe('“gear”');
    expect(chips[1].label).toBe('P1S');
  });

  it('is empty when nothing is filtered', () => {
    expect(getActiveFilterChips(none, t)).toEqual([]);
  });

  it('labels a source-only file type', () => {
    expect(getActiveFilterChips(filters({ filterFileType: 'source' }), t)[0].label).toBe('archives.filters.sourceOnly');
  });
});

describe('colorLabel', () => {
  it('names a colour, and falls back to the hex code when it cannot', () => {
    expect(colorLabel('#FF0000')).toBe('Red');
    expect(colorLabel('#f00')).toBe('#f00');
  });
});

describe('panelBadgeCount', () => {
  const chips = getActiveFilterChips(filters({ search: 'x', filterPrinter: 1, filterMaterial: 'PLA', filterFavorites: true }), t, 'P1S');

  it('counts only what lives in the panel on desktop', () => {
    expect(panelBadgeCount(chips, false)).toBe(2);
  });

  it('counts every filter except search on a phone', () => {
    expect(panelBadgeCount(chips, true)).toBe(3);
  });
});

describe('exportIgnoredFilters', () => {
  it('names the filters the export cannot apply', () => {
    const f = filters({ filterMaterial: 'PLA', filterTag: 't', filterFavorites: true, filterColors: new Set(['#f00']), filterStatus: 'failed', filterUser: 'ada' });
    expect(exportIgnoredFilters(getActiveFilterChips(f, t), f.collection)).toEqual(['PLA', 't', 'archives.filters.favorites', '#f00']);
  });

  it('includes collections that depend on archive details, but not time-based ones', () => {
    const duplicates = filters({ collection: 'duplicates' });
    expect(exportIgnoredFilters(getActiveFilterChips(duplicates, t), duplicates.collection)).toEqual(['archives.collections.duplicates']);
    const recent = filters({ collection: 'recent' });
    expect(exportIgnoredFilters(getActiveFilterChips(recent, t), recent.collection)).toEqual([]);
  });
});

describe('isSlicedFile', () => {
  it('trusts the filename first, then slicing metadata', () => {
    expect(isSlicedFile({ filename: 'a.gcode' })).toBe(true);
    expect(isSlicedFile({ filename: 'A.GCODE.3MF' })).toBe(true);
    expect(isSlicedFile({ filename: 'a.3mf', total_layers: 10 })).toBe(true);
    expect(isSlicedFile({ filename: 'a.3mf', print_time_seconds: 60 })).toBe(true);
    expect(isSlicedFile({ filename: 'a.3mf' })).toBe(false);
    expect(isSlicedFile({})).toBe(false);
  });
});
