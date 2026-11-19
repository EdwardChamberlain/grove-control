import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryFilters } from '../../hooks/useHistoryFilters';

function stored(values: Record<string, string>) {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => values[key] ?? null);
}

beforeEach(() => {
  stored({});
  vi.mocked(localStorage.setItem).mockClear();
  vi.mocked(localStorage.removeItem).mockClear();
});

describe('useHistoryFilters', () => {
  it('starts empty when nothing is saved', () => {
    const { result } = renderHook(() => useHistoryFilters());
    expect(result.current.hasActive).toBe(false);
    expect(result.current.sortBy).toBe('date-desc');
    expect(result.current.values.collection).toBe('all');
    expect(result.current.values.filterFileType).toBe('all');
  });

  it('restores every saved filter under its original storage key', () => {
    stored({
      archiveFilterPrinter: '3', archiveFilterMaterial: 'PETG', archiveFilterColors: '["#f00"]',
      archiveColorFilterMode: 'and', archiveFilterFavorites: 'true', archiveHideFailed: 'true',
      archiveHideDuplicates: 'true', archiveFilterTag: 'cal', archiveFilterFileType: 'source',
      archiveSortBy: 'name-asc', archiveCollection: 'recent', logFilterUser: 'ada', logFilterStatus: 'failed',
      logFilterDateFrom: '2026-01-01', logFilterDateTo: '2026-01-31',
    });
    const { result } = renderHook(() => useHistoryFilters());
    expect(result.current.values).toMatchObject({
      filterPrinter: 3, filterMaterial: 'PETG', colorFilterMode: 'and', filterFavorites: true, hideFailed: true,
      hideDuplicates: true, filterTag: 'cal', filterFileType: 'source', collection: 'recent', filterUser: 'ada',
      filterStatus: 'failed', filterDateFrom: '2026-01-01', filterDateTo: '2026-01-31',
    });
    expect([...result.current.values.filterColors]).toEqual(['#f00']);
    expect(result.current.sortBy).toBe('name-asc');
    expect(result.current.hasActive).toBe(true);
  });

  it('saves a change, and forgets a filter that is cleared', () => {
    const { result } = renderHook(() => useHistoryFilters());
    act(() => result.current.setFilterPrinter(2));
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveFilterPrinter', '2');
    act(() => result.current.setFilterStatus('failed'));
    expect(localStorage.setItem).toHaveBeenCalledWith('logFilterStatus', 'failed');
    act(() => result.current.setSortBy('size-desc'));
    expect(localStorage.setItem).toHaveBeenCalledWith('archiveSortBy', 'size-desc');

    act(() => result.current.setFilterPrinter(null));
    expect(localStorage.removeItem).toHaveBeenCalledWith('archiveFilterPrinter');
  });

  it('keeps the same values object until a filter changes', () => {
    const { result, rerender } = renderHook(() => useHistoryFilters());
    const first = result.current.values;
    rerender();
    expect(result.current.values).toBe(first);

    act(() => result.current.setSearch('gear'));
    expect(result.current.values).not.toBe(first);
    expect(result.current.values.search).toBe('gear');
  });

  it('toggles colours on and off', () => {
    const { result } = renderHook(() => useHistoryFilters());
    act(() => result.current.toggleColor('#f00'));
    act(() => result.current.toggleColor('#0f0'));
    expect([...result.current.values.filterColors]).toEqual(['#f00', '#0f0']);
    act(() => result.current.toggleColor('#f00'));
    expect([...result.current.values.filterColors]).toEqual(['#0f0']);
  });

  it('clears one filter by its chip key', () => {
    const { result } = renderHook(() => useHistoryFilters());
    act(() => {
      result.current.setSearch('x');
      result.current.setFilterPrinter(1);
      result.current.setFilterStatus('failed');
      result.current.setCollection('recent');
      result.current.setFilterUser('ada');
      result.current.setFilterDateFrom('2026-01-01');
      result.current.setFilterDateTo('2026-01-02');
      result.current.setFilterMaterial('PLA');
      result.current.setFilterFileType('gcode');
      result.current.setFilterTag('t');
      result.current.setFilterFavorites(true);
      result.current.setHideFailed(true);
      result.current.setHideDuplicates(true);
      result.current.toggleColor('#f00');
    });
    for (const key of ['search', 'printer', 'status', 'collection', 'user', 'from', 'to', 'material', 'filetype', 'tag', 'favorites', 'hidefailed', 'hidedupes', 'color-#f00', 'unknown']) {
      act(() => result.current.clearFilter(key));
    }
    expect(result.current.hasActive).toBe(false);
  });

  it('clears everything at once', () => {
    const { result } = renderHook(() => useHistoryFilters());
    act(() => {
      result.current.setSearch('x');
      result.current.setFilterMaterial('PLA');
      result.current.toggleColor('#f00');
      result.current.setCollection('failed');
    });
    expect(result.current.hasActive).toBe(true);
    act(() => result.current.clearAll());
    expect(result.current.hasActive).toBe(false);
    expect(result.current.values.filterColors.size).toBe(0);
  });

  it('drops saved dates that are not real, so a stale value cannot break the page', () => {
    stored({ logFilterDateFrom: '20255-01-01', logFilterDateTo: '2026-13-45' });
    const { result } = renderHook(() => useHistoryFilters());
    expect(result.current.values.filterDateFrom).toBe('');
    expect(result.current.values.filterDateTo).toBe('');
    expect(result.current.hasActive).toBe(false);
  });

  it('keeps saved dates that are real', () => {
    stored({ logFilterDateFrom: '2026-01-01', logFilterDateTo: '2026-01-31' });
    const { result } = renderHook(() => useHistoryFilters());
    expect(result.current.values.filterDateFrom).toBe('2026-01-01');
    expect(result.current.values.filterDateTo).toBe('2026-01-31');
  });

  it('ignores a typed date that is not real, but accepts a real one or a cleared field', () => {
    const { result } = renderHook(() => useHistoryFilters());
    act(() => result.current.setFilterDateFrom('2026-03-01'));
    act(() => result.current.setFilterDateTo('2026-03-31'));

    // A fifth digit in the year (Chrome allows it) must not replace a good value.
    act(() => result.current.setFilterDateFrom('20265-03-01'));
    act(() => result.current.setFilterDateTo('2026-02-31x'));
    expect(result.current.values.filterDateFrom).toBe('2026-03-01');
    expect(result.current.values.filterDateTo).toBe('2026-03-31');

    act(() => result.current.setFilterDateFrom(''));
    expect(result.current.values.filterDateFrom).toBe('');
  });
});
