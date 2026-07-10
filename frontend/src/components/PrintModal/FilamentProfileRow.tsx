import { AlertTriangle, Check, Circle, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

export type FilamentProfileStatus = 'match' | 'type_only' | 'mismatch' | 'empty' | 'neutral';

export interface FilamentProfileOption {
  value: string;
  label: string;
}

interface FilamentProfileRowProps {
  requiredColor: string | null;
  requiredLabel: string;
  usedGrams: number;
  value: string;
  options: FilamentProfileOption[];
  emptyLabel: string;
  onChange: (value: string) => void;
  status?: FilamentProfileStatus;
  isManual?: boolean;
  disabled?: boolean;
  leadingBadge?: ReactNode;
  requiredTitle?: string;
  selectTitle?: string;
  resetLabel?: string;
  onReset?: () => void;
}

/**
 * Shared sliced-profile → selected-profile row used by every PrintModal route.
 * Callers decide which same-family options are valid; this component keeps the
 * interaction and status language consistent across model and printer modes.
 */
export function FilamentProfileRow({
  requiredColor,
  requiredLabel,
  usedGrams,
  value,
  options,
  emptyLabel,
  onChange,
  status = 'neutral',
  isManual = false,
  disabled = false,
  leadingBadge,
  requiredTitle,
  selectTitle,
  resetLabel,
  onReset,
}: FilamentProfileRowProps) {
  const statusClasses = {
    match: 'border-bambu-green/50 text-bambu-green',
    type_only: 'border-yellow-400/50 text-yellow-400',
    mismatch: 'border-orange-400/50 text-orange-400',
    empty: 'border-orange-400/50 text-orange-400',
    neutral: isManual ? 'border-blue-400/50 text-blue-400' : 'border-bambu-gray/30 text-bambu-gray',
  }[status];

  return (
    <div
      className="grid items-center gap-2 text-xs"
      style={{ gridTemplateColumns: '16px minmax(70px, 1fr) auto minmax(120px, 2fr) 20px' }}
    >
      <span title={requiredTitle}>
        <Circle className="w-3 h-3" fill={requiredColor ?? 'transparent'} stroke={requiredColor ?? 'currentColor'} />
      </span>
      <span className="text-white truncate flex items-center gap-1">
        {leadingBadge}
        {requiredLabel} <span className="text-bambu-gray">({usedGrams}g)</span>
      </span>
      <span className="text-bambu-gray">→</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={`${requiredLabel} filament profile`}
        className={`min-w-0 px-2 py-1 rounded border text-xs bg-bambu-dark-secondary focus:outline-none focus:ring-1 focus:ring-bambu-green ${statusClasses} ${
          isManual ? 'ring-1 ring-blue-400/50' : ''
        }`}
        title={selectTitle}
      >
        <option value="" className="bg-bambu-dark text-bambu-gray">
          {emptyLabel}
        </option>
        {options.map((option, index) => (
          <option key={`${option.value}-${index}`} value={option.value} className="bg-bambu-dark text-white">
            {option.label}
          </option>
        ))}
      </select>
      {onReset && value ? (
        <button
          type="button"
          onClick={onReset}
          className="text-bambu-gray hover:text-white transition-colors"
          title={resetLabel}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      ) : status === 'match' ? (
        <Check className="w-3 h-3 text-bambu-green" />
      ) : status === 'type_only' ? (
        <AlertTriangle className="w-3 h-3 text-yellow-400" />
      ) : status === 'mismatch' || status === 'empty' ? (
        <AlertTriangle className="w-3 h-3 text-orange-400" />
      ) : (
        <span className="w-3" />
      )}
    </div>
  );
}
