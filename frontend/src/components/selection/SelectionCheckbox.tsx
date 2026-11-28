import type { MouseEvent } from 'react';
import { CheckSquare, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SelectionCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  /** Accessible name, e.g. the item's name. Defaults to a generic select/deselect label. */
  label?: string;
  /**
   * `overlay` positions the checkbox in the top-left of a `relative` card;
   * `inline` leaves layout to the caller (table cells, list rows).
   */
  variant?: 'overlay' | 'inline';
  className?: string;
}

/**
 * The checkbox shown over (or beside) each selectable item while select mode
 * is on. Render it only when the page's selection is `active`.
 */
export function SelectionCheckbox({
  checked,
  onToggle,
  label,
  variant = 'inline',
  className = '',
}: SelectionCheckboxProps) {
  const { t } = useTranslation();
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label ?? (checked ? t('selection.deselectItem') : t('selection.selectItem'))}
      onClick={handleClick}
      className={`${
        variant === 'overlay' ? 'absolute top-2 left-2 z-20 rounded bg-black/50 p-1 ' : 'shrink-0 '
      }flex items-center justify-center text-bambu-gray hover:text-bambu-green focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green ${className}`}
    >
      {checked ? (
        <CheckSquare className="w-5 h-5 text-bambu-green" />
      ) : (
        <Square className="w-5 h-5" />
      )}
    </button>
  );
}
