import { useLayoutEffect, useRef, useState } from 'react';

// The tallest a menu grows before it scrolls. The hook always sets maxHeight
// inline, so this is the only place the limit lives.
const MENU_MAX_HEIGHT = 288;
// Never shrink below roughly one option row, even on a very short screen.
const MENU_MIN_HEIGHT = 40;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

// The height position: fixed works against: the visible area without any
// horizontal scrollbar. Falls back to innerHeight where layout isn't available.
function viewportHeight() {
  return document.documentElement.clientHeight || window.innerHeight;
}

function clampHeight(space: number) {
  return Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, space));
}

export type FloatingMenuPosition = {
  left: number;
  minWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
  placement: 'below' | 'above';
};

export type FloatingMenuOptions = {
  /** Changes whenever the menu's content changes, so the menu is measured again. */
  contentKey?: unknown;
  /** Called when a scroll moves the trigger fully out of view while the menu is open. */
  onTriggerHidden?: () => void;
};

function samePosition(a: FloatingMenuPosition, b: FloatingMenuPosition) {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.minWidth === b.minWidth &&
    a.maxHeight === b.maxHeight &&
    a.placement === b.placement
  );
}

/**
 * Positions a portalled menu against its trigger. The menu opens below the
 * trigger unless it would not fit there and there is more room above, in which
 * case it opens upwards. Its height is capped to the vertical space available.
 * Horizontal overflow is not handled yet.
 */
export function useFloatingMenuPosition(
  isOpen: boolean,
  triggerRef: { current: HTMLElement | null },
  menuRef: { current: HTMLElement | null },
  { contentKey, onTriggerHidden }: FloatingMenuOptions = {},
): FloatingMenuPosition {
  const [position, setPosition] = useState<FloatingMenuPosition>({
    left: 0,
    top: 0,
    minWidth: 0,
    maxHeight: MENU_MAX_HEIGHT,
    placement: 'below',
  });
  // Held in a ref so a new callback each render doesn't re-subscribe the listeners.
  const onTriggerHiddenRef = useRef(onTriggerHidden);
  onTriggerHiddenRef.current = onTriggerHidden;

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = ({ fromScroll = false } = {}) => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const height = viewportHeight();
      // Only a scroll closes the menu: opening one whose trigger is off screen
      // (e.g. from the keyboard) still works. A zero-size rect means the
      // trigger isn't laid out, not that it scrolled away.
      const isLaidOut = rect.width > 0 || rect.height > 0;
      if (fromScroll && isLaidOut && (rect.bottom <= 0 || rect.top >= height)) {
        onTriggerHiddenRef.current?.();
        return;
      }

      const spaceBelow = height - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const menu = menuRef.current;
      // scrollHeight leaves out the border, so add it back on.
      const borders = menu ? menu.offsetHeight - menu.clientHeight : 0;
      const menuHeight = Math.min(MENU_MAX_HEIGHT, (menu?.scrollHeight ?? 0) + borders);
      const openAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;

      const next: FloatingMenuPosition = openAbove
        ? {
            left: rect.left,
            bottom: height - rect.top + MENU_GAP,
            minWidth: rect.width,
            maxHeight: clampHeight(spaceAbove),
            placement: 'above',
          }
        : {
            left: rect.left,
            top: rect.bottom + MENU_GAP,
            minWidth: rect.width,
            maxHeight: clampHeight(spaceBelow),
            placement: 'below',
          };

      // Skip the re-render when nothing moved, e.g. on most scroll events.
      setPosition(previous => (samePosition(previous, next) ? previous : next));
    };

    const handleScroll = (event: Event) => {
      // Scrolling inside the menu itself never moves the trigger.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      updatePosition({ fromScroll: true });
    };
    const handleResize = () => updatePosition();

    updatePosition();
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, triggerRef, menuRef, contentKey]);

  return position;
}

export function floatingMenuStyle(position: FloatingMenuPosition) {
  return {
    left: position.left,
    top: position.top,
    bottom: position.bottom,
    minWidth: position.minWidth,
    maxHeight: position.maxHeight,
  };
}
