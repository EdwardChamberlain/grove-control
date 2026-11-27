import type { ReactNode } from 'react';
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
}

/** Vertical divider used between groups of controls in the bar. */
export function SelectionBarDivider() {
  return <div className="w-px h-6 bg-bambu-dark-tertiary" />;
}

/**
 * The multi-select action bar, fixed to the bottom of the screen while select
 * mode is on. It shows the count and a close button, and hosts each page's
 * own actions as children.
 */
export function SelectionBar({ count, onClose, children, countLabel, className = '' }: SelectionBarProps) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-label={t('selection.barLabel')}
      data-testid="selection-bar"
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
