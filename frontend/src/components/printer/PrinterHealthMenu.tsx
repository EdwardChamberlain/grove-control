import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Cable,
  CheckCircle,
  DoorClosed,
  DoorOpen,
  Download,
  Layers,
  Link,
  Signal,
  Unlink,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { api } from '../../api/client';
import type { FirmwareUpdateInfo, HMSError, Printer, PrinterStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { computePopoverPosition } from '../../utils/popoverPosition';
import { PlateClearedIcon } from '../icons/PlateClearedIcon';
import { HMSErrorModal } from '../HMSErrorModal';
import { FirmwareUpdateModal } from './FirmwareUpdateModal';

interface PrinterHealthMeta {
  label: string;
  className: string;
}

interface StatusDetailRow {
  key: string;
  title: string;
  state: string;
  className: string;
  icon: React.ReactNode;
  action?: () => void;
  trailingState?: string;
}

interface PrinterHealthMenuProps {
  printer: Printer;
  status?: PrinterStatus;
  printerHealth: PrinterHealthMeta;
  smartPlugPoweredOff?: boolean;
  knownHmsErrors: HMSError[];
  maintenanceInfo?: { due_count?: number; warning_count?: number };
  requirePlateClear?: boolean;
  needsPlateClear: boolean;
  firmwareInfo?: FirmwareUpdateInfo;
  hasDoorSensor: boolean;
  checkPrinterFirmware?: boolean;
  queueCount?: number;
  triggerClassName?: string;
  iconClassName?: string;
}

export function PrinterHealthMenu({
  printer,
  status,
  printerHealth,
  smartPlugPoweredOff = false,
  knownHmsErrors,
  maintenanceInfo,
  requirePlateClear,
  needsPlateClear,
  firmwareInfo,
  hasDoorSensor,
  checkPrinterFirmware = true,
  queueCount,
  triggerClassName = 'h-7 w-7',
  iconClassName = 'h-4 w-4',
}: PrinterHealthMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [showHmsModal, setShowHmsModal] = useState(false);
  const [showFirmwareModal, setShowFirmwareModal] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const { data: pendingQueue = [] } = useQuery({
    queryKey: ['queue', printer.id, 'pending'],
    queryFn: () => api.getQueue(printer.id, 'pending'),
    enabled: queueCount === undefined && isOpen,
  });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords(computePopoverPosition({
        triggerRect: rect,
        popoverWidth: 240,
        estimatedHeight: 360,
        horizontalAlign: 'center',
      }));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [isOpen]);

  const isPrintingOrPaused = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const isMaintenanceMode = printer.is_active === false;
  const isPlannedOffline = isMaintenanceMode || (!status?.connected && smartPlugPoweredOff);
  const plannedOfflineClass = 'bg-blue-500/20 text-blue-400';
  const maintenanceDueCount = maintenanceInfo?.due_count ?? 0;
  const maintenanceWarningCount = maintenanceInfo?.warning_count ?? 0;
  const effectiveQueueCount = queueCount ?? pendingQueue.length;
  const plateState = isPrintingOrPaused
    ? t('printers.plateStatus.inUse')
    : needsPlateClear
      ? t('printers.plateStatus.notCleared')
      : t('printers.plateStatus.cleared');
  const networkState = !status?.connected
    ? t('printers.connection.offline')
    : status.wired_network
      ? t('printers.connection.ethernet', 'Ethernet')
      : status.wifi_signal != null
        ? `${status.wifi_signal}dBm`
        : t('common.unknown', 'Unknown');
  const networkClass = !status?.connected
    ? 'bg-status-error/20 text-status-error'
    : status.wired_network || status.wifi_signal == null || status.wifi_signal >= -60
      ? 'bg-status-ok/20 text-status-ok'
      : status.wifi_signal >= -80
        ? 'bg-status-warning/20 text-status-warning'
        : 'bg-status-error/20 text-status-error';
  const errorState = status?.connected
    ? knownHmsErrors.length > 0
      ? t('printers.status.errorCount', '{{count}} active', { count: knownHmsErrors.length })
      : t('common.ok', 'OK')
    : t('common.unknown', 'Unknown');
  const maintenanceState = maintenanceDueCount > 0
    ? t('maintenance.dueCount', { count: maintenanceDueCount })
    : maintenanceWarningCount > 0
      ? t('maintenance.warningCount', { count: maintenanceWarningCount })
      : t('common.ok', 'OK');

  const closeAndRun = (action: () => void) => () => {
    setIsOpen(false);
    action();
  };
  const rows: StatusDetailRow[] = [
    {
      key: 'connection',
      title: t('printers.status.connection', 'Connection'),
      state: status?.connected ? t('printers.connection.connected') : t('printers.connection.offline'),
      className: !status?.connected && isPlannedOffline
        ? plannedOfflineClass
        : status?.connected ? 'bg-status-ok/20 text-status-ok' : 'bg-status-error/20 text-status-error',
      icon: status?.connected ? <Link className="h-3 w-3" /> : <Unlink className="h-3 w-3" />,
    },
    ...(requirePlateClear && status?.connected ? [{
      key: 'plate',
      title: t('printers.plateStatus.title', 'Plate'),
      state: plateState,
      className: needsPlateClear ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok',
      icon: <PlateClearedIcon className="h-3 w-3" />,
    }] : []),
    {
      key: 'network',
      title: t('printers.status.network', 'Network'),
      state: networkState,
      className: !status?.connected && isPlannedOffline ? plannedOfflineClass : networkClass,
      icon: status?.wired_network ? <Cable className="h-3 w-3" /> : <Signal className="h-3 w-3" />,
    },
    {
      key: 'errors',
      title: t('printers.status.errors', 'Errors'),
      state: errorState,
      className: !status?.connected
        ? isPlannedOffline ? plannedOfflineClass : 'bg-status-error/20 text-status-error'
        : knownHmsErrors.length > 0
          ? knownHmsErrors.some(error => error.severity <= 2)
            ? 'bg-status-error/20 text-status-error'
            : 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok',
      icon: <AlertTriangle className="h-3 w-3" />,
      action: status?.connected ? closeAndRun(() => setShowHmsModal(true)) : undefined,
    },
    {
      key: 'maintenance',
      title: t('maintenance.title', 'Maintenance'),
      state: isMaintenanceMode
        ? t('printers.maintenance.modeLabel', 'Maintenance Mode')
        : maintenanceState,
      className: isMaintenanceMode
        ? plannedOfflineClass
        : maintenanceDueCount > 0
        ? 'bg-status-error/20 text-status-error'
        : maintenanceWarningCount > 0
          ? 'bg-status-warning/20 text-status-warning'
          : 'bg-status-ok/20 text-status-ok',
      icon: <Wrench className="h-3 w-3" />,
      action: closeAndRun(() => navigate('/maintenance')),
    },
    {
      key: 'queue',
      title: t('printers.status.queue', 'Queue'),
      state: t('printers.queue.inQueue', { count: effectiveQueueCount }),
      className: 'bg-status-ok/20 text-status-ok',
      icon: <Layers className="h-3 w-3" />,
      action: closeAndRun(() => navigate('/queue')),
    },
  ];

  if (checkPrinterFirmware && firmwareInfo?.current_version && firmwareInfo.latest_version) {
    rows.push({
      key: 'firmware',
      title: t('printers.status.firmware', 'Firmware'),
      state: firmwareInfo.current_version,
      trailingState: firmwareInfo.update_available ? t('printers.status.updateAvailable', 'Update available') : t('common.ok', 'OK'),
      className: firmwareInfo.update_available ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok',
      icon: firmwareInfo.update_available ? <Download className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />,
      action: closeAndRun(() => setShowFirmwareModal(true)),
    });
  } else if (status?.firmware_version) {
    rows.push({
      key: 'firmware',
      title: t('printers.status.firmware', 'Firmware'),
      state: status.firmware_version,
      className: 'bg-status-ok/20 text-status-ok',
      icon: <CheckCircle className="h-3 w-3" />,
    });
  }

  if (status?.connected && hasDoorSensor) {
    rows.push({
      key: 'door',
      title: t('printers.status.door', 'Door'),
      state: status.door_open ? t('printers.door.open') : t('printers.door.closed'),
      className: status.door_open ? 'bg-status-warning/20 text-status-warning' : 'bg-status-ok/20 text-status-ok',
      icon: status.door_open ? <DoorOpen className="h-3 w-3" /> : <DoorClosed className="h-3 w-3" />,
    });
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen(open => !open);
        }}
        className={`pointer-events-auto inline-flex shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-80 ${triggerClassName} ${printerHealth.className}`}
        title={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
        aria-label={t('printers.health.title', 'Machine health: {{status}}', { status: printerHealth.label })}
        aria-expanded={isOpen}
      >
        <Activity className={iconClassName} />
      </button>

      {isOpen && createPortal(
        <>
          <div
            className="fixed inset-0 z-[1000]"
            onClick={(event) => {
              event.stopPropagation();
              setIsOpen(false);
            }}
          />
          <div
            className="fixed z-[1001] flex w-[240px] flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl"
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? 'visible' : 'hidden',
            }}
            onClick={event => event.stopPropagation()}
          >
            <div className="shrink-0 px-3 py-2.5 text-center text-sm font-medium text-white">
              {t('printers.health.statusDetails', 'Status details')}
            </div>
            <div className="h-px bg-bambu-dark-tertiary" />
            <div className="space-y-1.5 p-2.5">
              {rows.map(row => {
                const className = `flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium ${row.className} ${row.action ? 'cursor-pointer transition-opacity hover:opacity-80' : ''}`;
                const content = (
                  <>
                    {row.icon}
                    <span>{row.title}:</span>
                    <span>{row.state}</span>
                    {row.trailingState && <span>{row.trailingState}</span>}
                  </>
                );
                return row.action ? (
                  <button key={row.key} type="button" data-testid={`printer-health-${row.key}`} onClick={row.action} className={className}>
                    {content}
                  </button>
                ) : (
                  <div key={row.key} data-testid={`printer-health-${row.key}`} className={className}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        </>,
        document.body,
      )}

      {showHmsModal && (
        <HMSErrorModal
          printerName={printer.name}
          errors={status?.hms_errors || []}
          onClose={() => setShowHmsModal(false)}
          printerId={printer.id}
          hasPermission={hasPermission}
        />
      )}
      {showFirmwareModal && firmwareInfo && (
        <FirmwareUpdateModal printer={printer} firmwareInfo={firmwareInfo} onClose={() => setShowFirmwareModal(false)} />
      )}
    </>
  );
}
