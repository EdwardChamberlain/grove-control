import { Flame, Snowflake } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type AirductMode = 'cooling' | 'heating';

interface PrinterAirductControlProps {
  isCapable: boolean;
  mode: number | null | undefined;
  isOpen: boolean;
  disabled?: boolean;
  buttonClassName: string;
  menuClassName?: string;
  iconClassName?: string;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onSelectMode: (mode: AirductMode) => void;
}

export function PrinterAirductControl({
  isCapable,
  mode,
  isOpen,
  disabled = false,
  buttonClassName,
  menuClassName = 'absolute bottom-full left-0 mb-1 z-50 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg py-1 min-w-[130px]',
  iconClassName = 'h-4 w-4',
  onToggleMenu,
  onCloseMenu,
  onSelectMode,
}: PrinterAirductControlProps) {
  const { t } = useTranslation();

  if (!isCapable) return null;

  const isHeating = mode === 1;
  const Icon = isHeating ? Flame : Snowflake;
  const color = isHeating ? 'text-orange-400' : 'text-sky-400';
  const bg = isHeating
    ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'
    : 'bg-sky-500/10 text-sky-400 hover:bg-sky-500/20';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleMenu}
        disabled={disabled}
        className={`${buttonClassName} ${bg}`}
        title={`${t('printers.airduct.title')}: ${isHeating ? t('printers.airduct.heating') : t('printers.airduct.cooling')}`}
        aria-label={`${t('printers.airduct.title')}: ${isHeating ? t('printers.airduct.heating') : t('printers.airduct.cooling')}`}
      >
        <Icon className={`${iconClassName} ${color}`} />
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={onCloseMenu} />
          <div className={menuClassName}>
            {([
              { mode: 'cooling', label: t('printers.airduct.cooling'), modeId: 0 },
              { mode: 'heating', label: t('printers.airduct.heating'), modeId: 1 },
            ] as const).map(({ mode: optionMode, label, modeId }) => (
              <button
                key={optionMode}
                type="button"
                onClick={() => {
                  onSelectMode(optionMode);
                  onCloseMenu();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  mode === modeId
                    ? 'bg-bambu-green/10 text-bambu-green'
                    : 'text-white hover:bg-bambu-dark-tertiary'
                }`}
              >
                {optionMode === 'heating' ? <Flame className="h-3 w-3" /> : <Snowflake className="h-3 w-3" />}
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
