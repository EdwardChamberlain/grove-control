import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, VideoOff, WifiOff } from 'lucide-react';
import { getAuthToken, withStreamToken } from '../api/client';

export type CameraTileMode = 'live' | 'snapshot' | 'paused';

interface CameraTileProps {
  printerId: number;
  printerName: string;
  cameraRotation?: number;
  mode: CameraTileMode;
  snapshotIntervalMs: number;
  connected: boolean;
  onClick?: () => void;
  onOpenFullscreen?: () => void;
  printerState?: string | null;
  progress?: number | null;
}

// Tiles render lighter than EmbeddedCameraViewer's full window: lower fps,
// no drag/resize/zoom shell, and snapshot fallback when off-cap. The server
// still does the MJPEG fan-out, so per-tile cost is one TLS pull on the wire.
const LIVE_FPS = 8;

type StatusBucket = 'printing' | 'paused' | 'finished' | 'error' | 'idle';

function classifyState(state: string | null | undefined): StatusBucket {
  switch (state) {
    case 'RUNNING':
      return 'printing';
    case 'PAUSE':
      return 'paused';
    case 'FINISH':
    case 'FAILED':
      return 'finished';
    default:
      return 'idle';
  }
}

export function CameraTile({
  printerId,
  printerName,
  cameraRotation = 0,
  mode,
  snapshotIntervalMs,
  connected,
  onClick,
  onOpenFullscreen,
  printerState = null,
  progress = null,
}: CameraTileProps) {
  const { t } = useTranslation();
  const [bust, setBust] = useState(0);
  const [errored, setErrored] = useState(false);
  const lastModeRef = useRef<CameraTileMode>(mode);

  // Tell the backend to release its MJPEG transcoder when this tile stops
  // being live — either by unmounting or by transitioning to snapshot/paused.
  // EmbeddedCameraViewer uses the same /camera/stop with keepalive on unmount.
  useEffect(() => {
    const wasLive = lastModeRef.current === 'live';
    const isLive = mode === 'live';
    lastModeRef.current = mode;
    if (wasLive && !isLive) {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`/api/v1/printers/${printerId}/camera/stop`, {
        method: 'POST',
        keepalive: true,
        headers,
      }).catch(() => {});
    }
    setErrored(false);
    setBust((b) => b + 1);
  }, [mode, printerId]);

  useEffect(() => {
    return () => {
      if (lastModeRef.current === 'live') {
        const headers: Record<string, string> = {};
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        fetch(`/api/v1/printers/${printerId}/camera/stop`, {
          method: 'POST',
          keepalive: true,
          headers,
        }).catch(() => {});
      }
    };
  }, [printerId]);

  useEffect(() => {
    if (mode !== 'snapshot') return;
    const interval = setInterval(() => setBust((b) => b + 1), snapshotIntervalMs);
    return () => clearInterval(interval);
  }, [mode, snapshotIntervalMs]);

  const liveUrl = withStreamToken(
    `/api/v1/printers/${printerId}/camera/stream?fps=${LIVE_FPS}&t=${bust}`,
  );
  const snapshotUrl = withStreamToken(
    `/api/v1/printers/${printerId}/camera/snapshot?t=${bust}`,
  );

  const handleClick = () => {
    if (onClick) onClick();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  };

  const transform = cameraRotation ? `rotate(${cameraRotation}deg)` : undefined;

  const bucket = classifyState(printerState);
  const isPrintingOrPaused = bucket === 'printing' || bucket === 'paused';
  const progressPct = progress != null ? Math.round(progress) : null;
  const displayedProgress = isPrintingOrPaused && progressPct != null
    ? Math.max(0, Math.min(100, progressPct))
    : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="group relative aspect-video w-full overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-black text-left focus:outline-none focus:ring-2 focus:ring-bambu-green"
      title={printerName}
      aria-label={printerName}
    >
      {!connected || mode === 'paused' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/60">
          {connected ? (
            <VideoOff className="h-8 w-8 text-bambu-gray/70" aria-hidden="true" />
          ) : (
            <WifiOff className="h-8 w-8 text-bambu-gray/70" aria-hidden="true" />
          )}
        </div>
      ) : errored ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/80 text-bambu-gray">
          <VideoOff className="h-7 w-7" aria-hidden="true" />
          <span className="text-xs">{t('printers.camWall.noSignal')}</span>
        </div>
      ) : (
        <img
          key={`${mode}-${bust}`}
          src={mode === 'live' ? liveUrl : snapshotUrl}
          alt={printerName}
          draggable={false}
          loading="lazy"
          className="h-full w-full select-none object-contain"
          style={{ transform }}
          onError={() => setErrored(true)}
        />
      )}

      {/* Mode indicator (top-left) */}
      <span
        className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          mode === 'live'
            ? 'bg-red-500/80 text-white'
            : mode === 'snapshot'
              ? 'bg-amber-500/70 text-black'
              : 'bg-bambu-dark-tertiary/70 text-bambu-gray'
        }`}
      >
        {mode === 'live'
          ? t('printers.camWall.live')
          : mode === 'snapshot'
            ? t('printers.camWall.snap')
            : t('printers.camWall.off')}
      </span>

      {onOpenFullscreen && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenFullscreen();
          }}
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded bg-black/65 text-white transition-colors hover:bg-black/85 focus:outline-none focus:ring-2 focus:ring-bambu-green"
          title={t('printers.camWall.openFullScreen', 'Open full screen')}
          aria-label={t('printers.camWall.openFullScreen', 'Open full screen')}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Printer name */}
      <div className="absolute inset-x-0 bottom-1.5 px-2 pb-1.5 pt-3 text-white">
        <span className="block truncate text-xs font-medium">{printerName}</span>
      </div>

      <div
        role="progressbar"
        aria-label={t('printers.camWall.progressLabel', 'Print progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayedProgress}
        className="absolute inset-x-0 bottom-0 h-1.5 overflow-hidden bg-bambu-dark-tertiary"
      >
        <div
          className={`h-full rounded-r-full transition-all ${bucket === 'paused' ? 'bg-status-warning' : 'bg-bambu-green'}`}
          style={{ width: `${displayedProgress}%` }}
        />
      </div>
    </div>
  );
}
