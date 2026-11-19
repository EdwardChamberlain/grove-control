import type { TFunction } from 'i18next';
import type { Archive, PrintLogEntry } from '../api/client';
import { getColorName } from './colors';
import { getLastPrintedAt, localDayBound, parseUTCDate } from './date';

export type ViewMode = 'grid' | 'calendar' | 'log';
export type SortOption = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc';
export type Collection =
  | 'all' | 'recent' | 'this-week' | 'this-month' | 'favorites' | 'not-printed' | 'printed' | 'failed' | 'duplicates';
export type FileTypeFilter = 'all' | 'gcode' | 'source';
export type ColorMode = 'or' | 'and';

export const COLLECTION_IDS: Collection[] = [
  'all', 'recent', 'this-week', 'this-month', 'favorites', 'not-printed', 'printed', 'failed', 'duplicates',
];

/** Everything the History toolbar can filter by. Shared by the grid, calendar and log. */
export interface HistoryFilterValues {
  search: string;
  filterPrinter: number | null;
  filterMaterial: string | null;
  filterColors: Set<string>;
  colorFilterMode: ColorMode;
  filterFavorites: boolean;
  hideFailed: boolean;
  hideDuplicates: boolean;
  filterTag: string | null;
  filterFileType: FileTypeFilter;
  filterStatus: string | null;
  filterUser: string | null;
  filterDateFrom: string;
  filterDateTo: string;
  collection: Collection;
}

// Status values that indicate a print attempt has finished (regardless of outcome).
// `archived` is the only status that means "uploaded but never sent to a printer."
const PRINTED_STATUSES = ['completed', 'failed', 'aborted', 'cancelled', 'stopped'] as const;

// Status filter values and the raw statuses they cover. The printer reports a cancelled
// print as "aborted" and the grid card labels it "Cancelled", so Cancelled covers both.
// The "Failed prints" collection and "Hide failed" deliberately treat any print that did
// not complete (failed or aborted) as unsuccessful, as they always have.
const STATUS_FILTER_VALUES: Record<string, string[]> = {
  completed: ['completed'],
  failed: ['failed'],
  stopped: ['stopped'],
  cancelled: ['cancelled', 'aborted'],
};

export function statusFilterValues(filter: string): string[] {
  return STATUS_FILTER_VALUES[filter] ?? [filter];
}

function matchesStatusFilter(filter: string | null, status: string): boolean {
  return !filter || statusFilterValues(filter).includes(status);
}

/**
 * Whether a .3mf/.gcode archive is sliced (contains gcode) rather than a source project.
 * Uses the filename (.gcode, .gcode.3mf) first, then falls back to metadata: a .3mf with
 * total_layers or print_time is sliced, while a raw CAD export has neither.
 */
export function isSlicedFile(archive: { filename?: string | null; total_layers?: number | null; print_time_seconds?: number | null }): boolean {
  const filename = archive.filename;
  if (filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.gcode') || lower.includes('.gcode.')) return true;
  }
  if (archive.total_layers || archive.print_time_seconds) return true;
  return false;
}

/** Quick time/state filter, shared by the grid (per archive) and the log (per print). */
function matchesCollection(
  collection: Collection,
  date: Date,
  status: string,
  archive?: Pick<Archive, 'is_favorite' | 'duplicate_count'>,
): boolean {
  const now = new Date();
  switch (collection) {
    case 'recent':
      return now.getTime() - date.getTime() < 24 * 60 * 60 * 1000;
    case 'this-week':
      return now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000;
    case 'this-month':
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    case 'favorites':
      return archive?.is_favorite === true;
    case 'not-printed':
      return status === 'archived';
    case 'printed':
      return (PRINTED_STATUSES as readonly string[]).includes(status);
    case 'failed':
      return status === 'failed' || status === 'aborted';
    case 'duplicates':
      return (archive?.duplicate_count ?? 0) > 0;
    default:
      return true;
  }
}

function matchesColors(colours: string[], selected: Set<string>, mode: ColorMode): boolean {
  if (selected.size === 0) return true;
  return mode === 'or'
    ? colours.some((c) => selected.has(c))
    : [...selected].every((c) => colours.includes(c));
}

// Collections the server can apply to the log (by date or status); the rest need the linked archive.
const SERVER_LOG_COLLECTIONS: Collection[] = ['all', 'recent', 'this-week', 'this-month', 'failed'];

/** Filters that only the browser can apply to the print log (they need the linked archive). */
export function needsClientLogFilter(f: HistoryFilterValues): boolean {
  return !!(
    f.filterMaterial || f.filterColors.size > 0 || f.filterFavorites || f.hideFailed || f.hideDuplicates ||
    f.filterTag || f.filterFileType !== 'all' || !SERVER_LOG_COLLECTIONS.includes(f.collection)
  );
}

/** What the server can apply for the current filters: a status list and a print-date window. */
export interface ServerFilterBounds {
  /** Raw statuses to keep, or null for any. An empty list means nothing can match. */
  statuses: string[] | null;
  from: Date | null;
  to: Date | null;
}

/**
 * The status and date part of the filters, in the form the print-log and export
 * endpoints take. Day bounds are local-day boundaries (as instants), and the
 * time-based collections become a lower bound, so the server and the browser agree.
 */
export function getServerFilterBounds(f: HistoryFilterValues, now: Date = new Date()): ServerFilterBounds {
  const fromStatus = f.filterStatus ? statusFilterValues(f.filterStatus) : null;
  const fromCollection = f.collection === 'failed' ? ['failed', 'aborted'] : null;
  const statuses = fromStatus && fromCollection
    ? fromStatus.filter((v) => fromCollection.includes(v))
    : fromStatus ?? fromCollection;

  const collectionFrom =
    f.collection === 'recent' ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
    : f.collection === 'this-week' ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    : f.collection === 'this-month' ? new Date(now.getFullYear(), now.getMonth(), 1)
    : null;
  const dateFrom = localDayBound(f.filterDateFrom, 'start');
  const from = [collectionFrom, dateFrom]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const to = localDayBound(f.filterDateTo, 'end');
  return { statuses, from, to };
}

/** Query parameters for the archive export that reproduce the current filters (where it can). */
export function getExportParams(f: HistoryFilterValues, now: Date = new Date()) {
  const { statuses, from, to } = getServerFilterBounds(f, now);
  return {
    printerId: f.filterPrinter || undefined,
    status: statuses?.join(',') || undefined,
    username: f.filterUser || undefined,
    search: f.search || undefined,
    printedFrom: from?.toISOString(),
    printedTo: to?.toISOString(),
  };
}

/** Grid/calendar rows: filter, then sort. Print dates are parsed once per archive, not per comparison. */
export function filterAndSortArchives(archives: Archive[], f: HistoryFilterValues, sortBy: SortOption): Archive[] {
  const query = f.search.toLowerCase();
  const from = localDayBound(f.filterDateFrom, 'start')?.getTime() ?? null;
  const to = localDayBound(f.filterDateTo, 'end')?.getTime() ?? null;

  const kept: { archive: Archive; printedAt: number }[] = [];
  for (const a of archives) {
    const printedAt = (parseUTCDate(getLastPrintedAt(a)) || new Date(0)).getTime();
    if (!matchesCollection(f.collection, new Date(printedAt), a.status, a)) continue;
    if (!matchesStatusFilter(f.filterStatus, a.status)) continue;
    if (f.filterUser && a.created_by_username !== f.filterUser) continue;
    if ((from !== null && printedAt < from) || (to !== null && printedAt > to)) continue;
    if (!(a.print_name || a.filename).toLowerCase().includes(query)) continue;
    if (f.filterMaterial && !a.filament_type?.split(', ').includes(f.filterMaterial)) continue;
    if (!matchesColors(a.filament_color?.split(',') || [], f.filterColors, f.colorFilterMode)) continue;
    // The favourites / hide-failed / hide-duplicates toggles are redundant with the matching collection.
    if (f.filterFavorites && f.collection !== 'favorites' && !a.is_favorite) continue;
    if (f.hideFailed && f.collection !== 'failed' && (a.status === 'failed' || a.status === 'aborted')) continue;
    if (f.hideDuplicates && f.collection !== 'duplicates' && a.duplicate_count !== 0 && a.duplicate_sequence !== 0) continue;
    if (f.filterTag && !(a.tags?.split(',').map((t) => t.trim()) || []).includes(f.filterTag)) continue;
    if (f.filterFileType !== 'all' && (f.filterFileType === 'gcode') !== isSlicedFile(a)) continue;
    kept.push({ archive: a, printedAt });
  }

  const name = (a: Archive) => a.print_name || a.filename;
  kept.sort((x, y) => {
    switch (sortBy) {
      case 'date-desc': return y.printedAt - x.printedAt;
      case 'date-asc': return x.printedAt - y.printedAt;
      case 'name-asc': return name(x.archive).localeCompare(name(y.archive));
      case 'name-desc': return name(y.archive).localeCompare(name(x.archive));
      case 'size-desc': return y.archive.file_size - x.archive.file_size;
      case 'size-asc': return x.archive.file_size - y.archive.file_size;
      default: return 0;
    }
  });
  return kept.map((k) => k.archive);
}

/**
 * Print-log rows that pass the filters the server could not apply. Archive-level
 * filters go through the linked archive; orphaned entries only match filters that
 * don't need one.
 */
export function filterLogEntries(
  entries: PrintLogEntry[],
  archiveById: Map<number, Archive>,
  f: HistoryFilterValues,
): PrintLogEntry[] {
  return entries.filter((entry) => {
    const linked = entry.archive_id != null ? archiveById.get(entry.archive_id) : undefined;
    const printedAt = parseUTCDate(entry.started_at || entry.created_at) || new Date(0);
    if (!matchesCollection(f.collection, printedAt, entry.status, linked)) return false;
    if (f.filterMaterial && !entry.filament_type?.split(', ').includes(f.filterMaterial)) return false;
    if (!matchesColors(entry.filament_color?.split(',') || [], f.filterColors, f.colorFilterMode)) return false;
    if (f.hideFailed && f.collection !== 'failed' && (entry.status === 'failed' || entry.status === 'aborted')) return false;
    if (f.filterFavorites && f.collection !== 'favorites' && !linked?.is_favorite) return false;
    if (f.filterTag && !linked?.tags?.split(',').map((t) => t.trim()).includes(f.filterTag)) return false;
    if (f.filterFileType !== 'all') {
      if (!linked) return false;
      if ((f.filterFileType === 'gcode') !== isSlicedFile(linked)) return false;
    }
    if (f.hideDuplicates && f.collection !== 'duplicates' && linked && linked.duplicate_count > 0 && linked.duplicate_sequence !== 0) return false;
    return true;
  });
}

export interface ActiveFilterChip {
  key: string;
  label: string;
}

/** A readable name for a filter colour, or the hex code itself when it can't be named. */
export function colorLabel(hex: string): string {
  const name = getColorName(hex);
  return name && name !== 'Unknown' ? name : hex;
}

/** One chip per active filter, in toolbar order, so nothing filters silently. */
export function getActiveFilterChips(f: HistoryFilterValues, t: TFunction, printerName?: string): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const add = (key: string, label: string) => chips.push({ key, label });
  if (f.search) add('search', `“${f.search}”`);
  if (f.filterPrinter) add('printer', printerName || t('archives.log.printer'));
  if (f.filterStatus) add('status', t(`archives.status.${f.filterStatus}`, { defaultValue: f.filterStatus }));
  if (f.collection !== 'all') add('collection', t(`archives.collections.${f.collection}`));
  if (f.filterUser) add('user', f.filterUser);
  if (f.filterDateFrom) add('from', `${t('archives.log.dateFrom')} ${f.filterDateFrom}`);
  if (f.filterDateTo) add('to', `${t('archives.log.dateTo')} ${f.filterDateTo}`);
  if (f.filterMaterial) add('material', f.filterMaterial);
  if (f.filterFileType !== 'all') add('filetype', f.filterFileType === 'gcode' ? t('archives.filters.sliced') : t('archives.filters.sourceOnly'));
  if (f.filterTag) add('tag', f.filterTag);
  if (f.filterFavorites) add('favorites', t('archives.filters.favorites'));
  if (f.hideFailed) add('hidefailed', t('archives.filters.hideFailed'));
  if (f.hideDuplicates) add('hidedupes', t('archives.hideDuplicates'));
  f.filterColors.forEach((color) => add(`color-${color}`, colorLabel(color)));
  return chips;
}

const PRIMARY_CHIP_KEYS = ['search', 'printer', 'status', 'collection'];

/** The Filters button's badge: what is active inside the panel (on a phone, every filter but search). */
export function panelBadgeCount(chips: ActiveFilterChip[], isMobile: boolean): number {
  return chips.filter((c) => c.key !== 'search' && (isMobile || !PRIMARY_CHIP_KEYS.includes(c.key))).length;
}

// Filters that depend on archive details, which the export endpoint cannot apply.
const EXPORT_UNSUPPORTED_KEYS = ['material', 'filetype', 'tag', 'favorites', 'hidefailed', 'hidedupes'];
const EXPORT_UNSUPPORTED_COLLECTIONS: Collection[] = ['favorites', 'not-printed', 'printed', 'duplicates'];

/** Labels of active filters the export cannot apply, so the menu can say so. */
export function exportIgnoredFilters(chips: ActiveFilterChip[], collection: Collection): string[] {
  return chips
    .filter((c) => EXPORT_UNSUPPORTED_KEYS.includes(c.key)
      || c.key.startsWith('color-')
      || (c.key === 'collection' && EXPORT_UNSUPPORTED_COLLECTIONS.includes(collection)))
    .map((c) => c.label);
}
