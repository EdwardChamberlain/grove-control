import { useCallback, useEffect, useMemo, useState } from 'react';

export type SelectionId = string | number;

export interface UseSelectionOptions {
  /**
   * Exit select mode when Escape is pressed outside a text field or dialog.
   * Defaults to true.
   */
  exitOnEscape?: boolean;
}

export interface SelectionState<T extends SelectionId> {
  /** True while select mode is on (or something is selected). Drives checkbox overlays and the action bar. */
  active: boolean;
  /** The selected ids. */
  selected: ReadonlySet<T>;
  count: number;
  isSelected: (id: T) => boolean;
  toggle: (id: T) => void;
  /** Add ids to the selection, entering select mode. */
  add: (ids: Iterable<T>) => void;
  /** Replace the selection, entering select mode. */
  set: (ids: Iterable<T>) => void;
  /** Remove ids from the selection without leaving select mode. */
  remove: (ids: Iterable<T>) => void;
  /** Deselect everything but stay in select mode. */
  clear: () => void;
  /** Turn select mode on. */
  enter: () => void;
  /** Turn select mode off and clear the selection. */
  exit: () => void;
  /** Header toggle: exits when active, enters otherwise. */
  toggleMode: () => void;
}

/**
 * Shared multi-select state: a select-mode flag plus the selected ids.
 *
 * Pages supply ids and render `SelectModeToggle`, `SelectionCheckbox` and
 * `SelectionBar`; the mode handling, Escape-to-exit and count live here.
 */
export function useSelection<T extends SelectionId = number>(
  options: UseSelectionOptions = {},
): SelectionState<T> {
  const { exitOnEscape = true } = options;
  const [mode, setMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<T>>(() => new Set<T>());

  const active = mode || selected.size > 0;

  const toggle = useCallback((id: T) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const add = useCallback((ids: Iterable<T>) => {
    setSelected(prev => new Set([...prev, ...ids]));
    setMode(true);
  }, []);

  const set = useCallback((ids: Iterable<T>) => {
    setSelected(new Set(ids));
    setMode(true);
  }, []);

  const remove = useCallback((ids: Iterable<T>) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set<T>()), []);
  const enter = useCallback(() => setMode(true), []);
  const exit = useCallback(() => {
    setSelected(new Set<T>());
    setMode(false);
  }, []);
  const toggleMode = useCallback(() => {
    if (active) exit();
    else setMode(true);
  }, [active, exit]);

  const isSelected = useCallback((id: T) => selected.has(id), [selected]);

  useEffect(() => {
    if (!exitOnEscape || !active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Escape in a text field only leaves the field, and Escape in an open
      // dialog only closes the dialog; neither should throw the selection away.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0')) return;
      exit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitOnEscape, active, exit]);

  return useMemo(
    () => ({
      active,
      selected,
      count: selected.size,
      isSelected,
      toggle,
      add,
      set,
      remove,
      clear,
      enter,
      exit,
      toggleMode,
    }),
    [active, selected, isSelected, toggle, add, set, remove, clear, enter, exit, toggleMode],
  );
}
