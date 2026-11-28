import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';

interface SelectionBarProps {
  count: number;
  onClose: () => void;
  /** Page-specific actions, rendered after the count. */
  children?: ReactNode;
  /** Overrides the default "{{count}} selected" text. */
  countLabel?: string;
  className?: string;
  /**
   * Add bottom padding to the page's scroll container while the bar is shown, so the last
   * rows and pagination stay reachable. Turn off for a bar shown over a dialog.
   */
  reserveSpace?: boolean;
}

/** Bars currently reserving space on each scroll container, with its padding from before the first one. */
const reservations = new WeakMap<HTMLElement, { count: number; previous: string }>();

/** Vertical divider used between groups of controls in the bar. */
export function SelectionBarDivider() {
  return <div className="w-px h-6 bg-bambu-dark-tertiary" />;
}

/**
 * The multi-select action bar, fixed to the bottom of the screen while select
 * mode is on. It shows the count and a close button, and hosts each page's
 * own actions as children.
 */
export function SelectionBar({ count, onClose, children, countLabel, className = '', reserveSpace = true }: SelectionBarProps) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reserveSpace) return;
    const main = barRef.current?.closest('main');
    if (!main) return;
    const entry = reservations.get(main) ?? { count: 0, previous: main.style.paddingBottom };
    entry.count += 1;
    reservations.set(main, entry);
    main.style.paddingBottom = '7rem';
    return () => {
      entry.count -= 1;
      if (entry.count === 0) {
        main.style.paddingBottom = entry.previous;
        reservations.delete(main);
      }
    };
  }, [reserveSpace]);

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('selection.barLabel')}
      data-testid="selection-bar"
      // The bar can sit inside a dialog backdrop that closes on click; its buttons must not reach it.
      onClick={(e) => e.stopPropagation()}
      className={`fixed bottom-4 md:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] md:w-auto max-w-[calc(100%-2rem)] bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl px-4 py-3 flex items-center justify-center gap-3 flex-wrap ${className}`}
    >
      <Button
        variant="secondary"
        size="sm"
        onClick={onClose}
        aria-label={t('selection.exit')}
        title={t('selection.exit')}
      >
        <X className="w-4 h-4" />
      </Button>
      <SelectionBarDivider />
      <span className="text-white font-medium text-sm" data-testid="selection-count">
        {countLabel ?? t('selection.count', { count })}
      </span>
      {children ? <SelectionBarDivider /> : null}
      {children}
    </div>
  );
}
