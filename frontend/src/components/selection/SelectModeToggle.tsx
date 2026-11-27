import { CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SelectModeToggleProps {
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Tooltip shown instead of the default label, e.g. a permission message. */
  title?: string;
  /** `icon` is the compact header button; `menu` is a full-width labelled row for overflow menus. */
  variant?: 'icon' | 'menu';
  className?: string;
}

/**
 * The multi-select button that sits in a page's header action controls, next
 * to its filters. Turning it on reveals checkboxes over the items and the
 * `SelectionBar` at the bottom of the screen.
 */
export function SelectModeToggle({
  active,
  onToggle,
  disabled,
  title,
  variant = 'icon',
  className = '',
}: SelectModeToggleProps) {
  const { t } = useTranslation();
  const label = t('selection.toggle');
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      data-testid="select-mode-toggle"
      className={`h-8 px-2 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        variant === 'menu' ? 'w-full justify-center gap-1.5 text-sm font-medium flex items-center' : ''
      } ${
        active
          ? 'bg-bambu-green border-bambu-green text-white'
          : 'bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
      } ${className}`}
    >
      <CheckSquare className="w-4 h-4" />
      {variant === 'menu' && <span>{label}</span>}
    </button>
  );
}
