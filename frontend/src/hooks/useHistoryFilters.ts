import { useCallback, useEffect, useMemo, useState } from 'react';
import { localDayBound } from '../utils/date';
import type {
  Collection, ColorMode, FileTypeFilter, HistoryFilterValues, SortOption,
} from '../utils/historyFilters';

// The storage keys predate this hook (some are named for the log they once belonged to).
// They are kept as they are so a user's saved filters survive.
const KEYS = {
  printer: 'archiveFilterPrinter',
  material: 'archiveFilterMaterial',
  colors: 'archiveFilterColors',
  colorMode: 'archiveColorFilterMode',
  favorites: 'archiveFilterFavorites',
  hideFailed: 'archiveHideFailed',
  hideDuplicates: 'archiveHideDuplicates',
  tag: 'archiveFilterTag',
  fileType: 'archiveFilterFileType',
  sortBy: 'archiveSortBy',
  collection: 'archiveCollection',
  user: 'logFilterUser',
  status: 'logFilterStatus',
  dateFrom: 'logFilterDateFrom',
  dateTo: 'logFilterDateTo',
} as const;

/** A `YYYY-MM-DD` that is a real date, else an empty string. */
function validDay(value: string | null): string {
  return value && localDayBound(value, 'start') ? value : '';
}

/** Save a value, or forget it when there is nothing to keep. */
function persist(key: string, value: string | null) {
  if (value === null || value === '') localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/** Keeps `value` in localStorage under `key` whenever it changes. */
function usePersisted(key: string, value: string | null) {
  useEffect(() => persist(key, value), [key, value]);
}

/**
 * State for the History toolbar: every filter, the sort order, and the helpers to
 * clear them. Everything is persisted so the page reopens as it was left.
 * `values` keeps its identity until a filter actually changes, so it is safe to use
 * as a dependency for memoised filtering and for resetting paging.
 */
export function useHistoryFilters() {
  const [search, setSearch] = useState('');
  const [filterPrinter, setFilterPrinter] = useState<number | null>(() => {
    const saved = localStorage.getItem(KEYS.printer);
    return saved ? Number(saved) : null;
  });
  const [filterMaterial, setFilterMaterial] = useState<string | null>(() => localStorage.getItem(KEYS.material));
  const [filterColors, setFilterColors] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(KEYS.colors);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [colorFilterMode, setColorFilterMode] = useState<ColorMode>(
    () => (localStorage.getItem(KEYS.colorMode) as ColorMode) || 'or',
  );
  const [filterFavorites, setFilterFavorites] = useState(() => localStorage.getItem(KEYS.favorites) === 'true');
  const [hideFailed, setHideFailed] = useState(() => localStorage.getItem(KEYS.hideFailed) === 'true');
  const [hideDuplicates, setHideDuplicates] = useState(() => localStorage.getItem(KEYS.hideDuplicates) === 'true');
  const [filterTag, setFilterTag] = useState<string | null>(() => localStorage.getItem(KEYS.tag));
  const [filterFileType, setFilterFileType] = useState<FileTypeFilter>(
    () => (localStorage.getItem(KEYS.fileType) as FileTypeFilter) || 'all',
  );
  const [filterStatus, setFilterStatus] = useState<string | null>(() => localStorage.getItem(KEYS.status));
  const [filterUser, setFilterUser] = useState<string | null>(() => localStorage.getItem(KEYS.user) || null);
  // A saved date that is not a real one (stale, hand-edited, or a 5-digit year) is dropped.
  const [filterDateFrom, setDateFrom] = useState(() => validDay(localStorage.getItem(KEYS.dateFrom)));
  const [filterDateTo, setDateTo] = useState(() => validDay(localStorage.getItem(KEYS.dateTo)));
  const [collection, setCollection] = useState<Collection>(
    () => (localStorage.getItem(KEYS.collection) as Collection) || 'all',
  );
  const [sortBy, setSortBy] = useState<SortOption>(
    () => (localStorage.getItem(KEYS.sortBy) as SortOption) || 'date-desc',
  );

  usePersisted(KEYS.printer, filterPrinter === null ? null : String(filterPrinter));
  usePersisted(KEYS.material, filterMaterial);
  usePersisted(KEYS.colors, JSON.stringify([...filterColors]));
  usePersisted(KEYS.colorMode, colorFilterMode);
  usePersisted(KEYS.favorites, String(filterFavorites));
  usePersisted(KEYS.hideFailed, String(hideFailed));
  usePersisted(KEYS.hideDuplicates, String(hideDuplicates));
  usePersisted(KEYS.tag, filterTag);
  usePersisted(KEYS.fileType, filterFileType);
  usePersisted(KEYS.status, filterStatus);
  usePersisted(KEYS.user, filterUser);
  usePersisted(KEYS.dateFrom, filterDateFrom);
  usePersisted(KEYS.dateTo, filterDateTo);
  usePersisted(KEYS.collection, collection);
  usePersisted(KEYS.sortBy, sortBy);

  const values: HistoryFilterValues = useMemo(() => ({
    search, filterPrinter, filterMaterial, filterColors, colorFilterMode, filterFavorites, hideFailed,
    hideDuplicates, filterTag, filterFileType, filterStatus, filterUser, filterDateFrom, filterDateTo, collection,
  }), [
    search, filterPrinter, filterMaterial, filterColors, colorFilterMode, filterFavorites, hideFailed,
    hideDuplicates, filterTag, filterFileType, filterStatus, filterUser, filterDateFrom, filterDateTo, collection,
  ]);

  // Date inputs accept years far past 9999. Ignore a change that isn't a real date (or empty), so the
  // field snaps back instead of holding a value nothing can filter by.
  const setFilterDateFrom = useCallback((value: string) => {
    if (value === '' || localDayBound(value, 'start')) setDateFrom(value);
  }, []);
  const setFilterDateTo = useCallback((value: string) => {
    if (value === '' || localDayBound(value, 'end')) setDateTo(value);
  }, []);

  const toggleColor = useCallback((color: string) => {
    setFilterColors((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  }, []);

  /** Clear one filter by its chip key (see `getActiveFilterChips`). */
  const clearFilter = useCallback((key: string) => {
    switch (key) {
      case 'search': setSearch(''); break;
      case 'printer': setFilterPrinter(null); break;
      case 'status': setFilterStatus(null); break;
      case 'collection': setCollection('all'); break;
      case 'user': setFilterUser(null); break;
      case 'from': setDateFrom(''); break;
      case 'to': setDateTo(''); break;
      case 'material': setFilterMaterial(null); break;
      case 'filetype': setFilterFileType('all'); break;
      case 'tag': setFilterTag(null); break;
      case 'favorites': setFilterFavorites(false); break;
      case 'hidefailed': setHideFailed(false); break;
      case 'hidedupes': setHideDuplicates(false); break;
      default:
        if (key.startsWith('color-')) {
          const color = key.slice('color-'.length);
          setFilterColors((prev) => {
            const next = new Set(prev);
            next.delete(color);
            return next;
          });
        }
    }
  }, []);

  const clearAll = useCallback(() => {
    setSearch('');
    setFilterPrinter(null);
    setFilterMaterial(null);
    setFilterFavorites(false);
    setHideFailed(false);
    setHideDuplicates(false);
    setFilterTag(null);
    setFilterFileType('all');
    setFilterStatus(null);
    setFilterUser(null);
    setDateFrom('');
    setDateTo('');
    setFilterColors(new Set());
    setCollection('all');
  }, []);

  const hasActive = !!(
    search || filterStatus || filterUser || filterDateFrom || filterDateTo || filterColors.size > 0 ||
    collection !== 'all' || filterPrinter || filterMaterial || filterFavorites || hideFailed ||
    hideDuplicates || filterTag || filterFileType !== 'all'
  );

  return {
    values, sortBy, hasActive,
    setSearch, setFilterPrinter, setFilterMaterial, setColorFilterMode, setFilterFavorites, setHideFailed,
    setHideDuplicates, setFilterTag, setFilterFileType, setFilterStatus, setFilterUser, setFilterDateFrom,
    setFilterDateTo, setCollection, setSortBy, toggleColor, clearFilter, clearAll,
  };
}

export type HistoryFilters = ReturnType<typeof useHistoryFilters>;
