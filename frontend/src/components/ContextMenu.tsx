import { useEffect, useRef, useState, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, Search } from 'lucide-react';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
  // When set on an item with a submenu, render a search input above the
  // submenu items that filters by label (case-insensitive).
  submenuSearchPlaceholder?: string;
  title?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const VIEWPORT_PADDING = 8;

function keepInViewport(start: number, size: number, available: number) {
  return Math.max(VIEWPORT_PADDING, Math.min(start, available - size - VIEWPORT_PADDING));
}

function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
  if (!buttons.length) return;

  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'ArrowDown'
    ? (current + 1) % buttons.length
    : (current <= 0 ? buttons.length - 1 : current - 1);
  buttons[next].focus();
}

interface SubmenuPanelProps {
  items: ContextMenuItem[];
  anchor: HTMLButtonElement;
  searchPlaceholder?: string;
  focusOnOpen: boolean;
  onClose: () => void;
  onBack: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function SubmenuPanel({
  items,
  anchor,
  searchPlaceholder,
  focusOnOpen,
  onClose,
  onBack,
  onMouseEnter,
  onMouseLeave,
}: SubmenuPanelProps) {
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const trigger = anchor.getBoundingClientRect();
    const x = trigger.right + 4 + rect.width <= window.innerWidth - VIEWPORT_PADDING
      ? trigger.right + 4
      : trigger.left - rect.width - 4;
    panel.style.left = keepInViewport(x, rect.width, window.innerWidth) + 'px';
    panel.style.top = keepInViewport(trigger.top, rect.height, window.innerHeight) + 'px';

    if (focusOnOpen) {
      (inputRef.current ?? panel.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    }
  }, [anchor, focusOnOpen]);

  const trimmed = query.trim().toLowerCase();
  const filteredItems = searchPlaceholder && trimmed
    ? items.filter((i) => i.label.toLowerCase().includes(trimmed))
    : items;

  return (
    <div
      ref={panelRef}
      className="fixed z-[60] w-[200px] max-w-[calc(100dvw-16px)] max-h-[min(300px,calc(100dvh-16px))] overflow-y-auto overscroll-contain bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1"
      role="menu"
      aria-label={anchor.textContent ?? undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && event.target !== inputRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          onBack();
          return;
        }
        moveMenuFocus(event);
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {searchPlaceholder && (
        <div className="sticky top-0 z-[1] px-2 py-1.5 bg-bambu-dark-secondary border-b border-bambu-dark-tertiary">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-bambu-gray pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = filteredItems.find((i) => !i.disabled);
                  if (first) {
                    first.onClick();
                    onClose();
                  }
                }
              }}
              placeholder={searchPlaceholder}
              className="w-full pl-7 pr-2 py-1 text-sm bg-bambu-dark border border-bambu-dark-tertiary rounded text-white placeholder-bambu-gray focus:border-bambu-green focus:outline-none"
            />
          </div>
        </div>
      )}
      {filteredItems.map((subItem, subIndex) => (
        <button
          key={subIndex}
          role="menuitem"
          onClick={() => {
            if (!subItem.disabled) {
              subItem.onClick();
              onClose();
            }
          }}
          disabled={subItem.disabled}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
            subItem.disabled
              ? 'text-bambu-gray cursor-not-allowed'
              : subItem.danger
              ? 'text-red-400 hover:bg-red-400/10'
              : 'text-white hover:bg-bambu-dark-tertiary'
          }`}
        >
          {subItem.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{subItem.icon}</span>}
          <span className="flex-1 truncate">{subItem.label}</span>
        </button>
      ))}
      {searchPlaceholder && filteredItems.length === 0 && (
        <div className="px-3 py-2 text-sm text-bambu-gray text-center italic">—</div>
      )}
    </div>
  );
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<{
    index: number;
    anchor: HTMLButtonElement;
    focusOnOpen: boolean;
  } | null>(null);
  const submenuTimeoutRef = useRef<number | null>(null);
  const [position, setPosition] = useState({ x, y, visible: false });

  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onClose();
      }
    };

    const handleScroll = (e: Event) => {
      // Scrolling either menu panel should keep the menu open.
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return;
      }
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
      if (submenuTimeoutRef.current) {
        clearTimeout(submenuTimeoutRef.current);
      }
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const rect = listRef.current?.getBoundingClientRect();
    if (!rect) return;

    setPosition({
      x: keepInViewport(x, rect.width, window.innerWidth),
      y: keepInViewport(y, rect.height, window.innerHeight),
      visible: true,
    });
  }, [x, y]);

  const cancelSubmenuClose = () => {
    if (submenuTimeoutRef.current !== null) {
      window.clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
  };

  const openSubmenu = (index: number, anchor: HTMLButtonElement, focusOnOpen: boolean) => {
    cancelSubmenuClose();
    setActiveSubmenu({ index, anchor, focusOnOpen });
  };

  const scheduleSubmenuClose = () => {
    cancelSubmenuClose();
    submenuTimeoutRef.current = window.setTimeout(() => {
      submenuTimeoutRef.current = null;
      setActiveSubmenu(null);
    }, 150);
  };

  const submenuItem = activeSubmenu ? items[activeSubmenu.index] : undefined;

  return (
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{ left: position.x, top: position.y, visibility: position.visible ? 'visible' : 'hidden' }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={listRef}
        role="menu"
        onKeyDown={moveMenuFocus}
        onScroll={() => setActiveSubmenu(null)}
        className="min-w-[180px] max-w-[280px] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl py-1"
      >
        {items.map((item, index) => {
          if (item.divider) {
            return <div key={index} className="my-1 border-t border-bambu-dark-tertiary" />;
          }

          const hasSubmenu = !!item.submenu?.length;
          const submenuOpen = activeSubmenu?.index === index;

          return (
            <button
              key={index}
              role="menuitem"
              aria-haspopup={hasSubmenu ? 'menu' : undefined}
              aria-expanded={hasSubmenu ? submenuOpen : undefined}
              onMouseEnter={(event) => {
                if (hasSubmenu && !item.disabled) openSubmenu(index, event.currentTarget, false);
              }}
              onMouseLeave={hasSubmenu ? scheduleSubmenuClose : undefined}
              onKeyDown={(event) => {
                if (hasSubmenu && event.key === 'ArrowRight') {
                  event.preventDefault();
                  openSubmenu(index, event.currentTarget, true);
                }
              }}
              onClick={(event) => {
                if (hasSubmenu) {
                  openSubmenu(index, event.currentTarget, true);
                } else if (!item.disabled) {
                  item.onClick();
                  onClose();
                }
              }}
              disabled={item.disabled}
              title={item.title}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                item.disabled
                  ? 'text-bambu-gray cursor-not-allowed'
                  : item.danger
                  ? 'text-red-400 hover:bg-red-400/10'
                  : 'text-white hover:bg-bambu-dark-tertiary'
              } ${submenuOpen ? 'bg-bambu-dark-tertiary' : ''}`}
            >
              {item.icon && <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{item.icon}</span>}
              <span className="flex-1">{item.label}</span>
              {hasSubmenu && <ChevronRight className="w-4 h-4 text-bambu-gray" />}
            </button>
          );
        })}
      </div>
      {/* Keep the submenu outside the scrollable list so it can open beside it. */}
      {activeSubmenu && submenuItem?.submenu && (
        <SubmenuPanel
          key={activeSubmenu.index}
          items={submenuItem.submenu}
          anchor={activeSubmenu.anchor}
          searchPlaceholder={submenuItem.submenuSearchPlaceholder}
          focusOnOpen={activeSubmenu.focusOnOpen}
          onClose={onClose}
          onBack={() => {
            activeSubmenu.anchor.focus();
            setActiveSubmenu(null);
          }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
        />
      )}
    </div>
  );
}
