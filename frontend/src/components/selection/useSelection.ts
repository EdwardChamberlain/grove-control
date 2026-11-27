import { useCallback, useEffect, useId, useMemo, useState } from 'react';

export type SelectionId = string | number;

export interface UseSelectionOptions {
  /**
   * Exit select mode when Escape is pressed outside a text field or dialog.
   * Defaults to true.
   */
  exitOnEscape?: boolean;
  /**
   * Selections that share a group name are mutually exclusive: turning one on
   * turns the others off. For several selectable cards on one screen, which
   * would otherwise each show their own bar in the same place.
   */
  exclusiveGroup?: string;
}

const EXCLUSIVE_EVENT = 'selection-exclusive';

/** True when a dialog or full-screen overlay is showing (hidden ones, like the compact drawer backdrop, don't count). */
function isOverlayOpen(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed.inset-0'),
  ).some((el) => el.getAttribute('aria-hidden') !== 'true' && !el.classList.contains('pointer-events-none'));
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
  const { exitOnEscape = true, exclusiveGroup } = options;
  const instanceId = useId();
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
      if (isOverlayOpen()) return;
      exit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitOnEscape, active, exit]);

  useEffect(() => {
    if (!exclusiveGroup) return;
    const onOtherActive = (e: Event) => {
      const detail = (e as CustomEvent<{ group: string; id: string }>).detail;
      if (detail.group === exclusiveGroup && detail.id !== instanceId) exit();
    };
    window.addEventListener(EXCLUSIVE_EVENT, onOtherActive);
    return () => window.removeEventListener(EXCLUSIVE_EVENT, onOtherActive);
  }, [exclusiveGroup, instanceId, exit]);

  useEffect(() => {
    if (!exclusiveGroup || !active) return;
    window.dispatchEvent(new CustomEvent(EXCLUSIVE_EVENT, { detail: { group: exclusiveGroup, id: instanceId } }));
  }, [exclusiveGroup, active, instanceId]);

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
