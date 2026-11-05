import { useLayoutEffect, useState } from 'react';

// Matches Tailwind's max-h-72 (18rem), the menus' usual height cap.
const MENU_MAX_HEIGHT = 288;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

export type FloatingMenuPosition = {
  left: number;
  minWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
  placement: 'below' | 'above';
};

/**
 * Positions a portalled menu against its trigger. The menu opens below the
 * trigger unless it would not fit there and there is more room above, in which
 * case it opens upwards. Its height is capped to the space available so it
 * never runs off the screen.
 */
export function useFloatingMenuPosition(
  isOpen: boolean,
  triggerRef: { current: HTMLElement | null },
  menuRef: { current: HTMLElement | null },
): FloatingMenuPosition {
  const [position, setPosition] = useState<FloatingMenuPosition>({
    left: 0,
    top: 0,
    minWidth: 0,
    maxHeight: MENU_MAX_HEIGHT,
    placement: 'below',
  });

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const menu = menuRef.current;
      // scrollHeight leaves out the border, so add it back on.
      const borders = menu ? menu.offsetHeight - menu.clientHeight : 0;
      const menuHeight = Math.min(MENU_MAX_HEIGHT, (menu?.scrollHeight ?? 0) + borders);
      const openAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;

      setPosition(openAbove
        ? {
            left: rect.left,
            bottom: viewportHeight - rect.top + MENU_GAP,
            minWidth: rect.width,
            maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, spaceAbove)),
            placement: 'above',
          }
        : {
            left: rect.left,
            top: rect.bottom + MENU_GAP,
            minWidth: rect.width,
            maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, spaceBelow)),
            placement: 'below',
          });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, triggerRef, menuRef]);

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
