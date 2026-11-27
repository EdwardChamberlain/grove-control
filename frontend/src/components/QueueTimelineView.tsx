import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Clock, Layers } from 'lucide-react';
import { formatDuration, parseUTCDate } from '../utils/date';
import type { PrintQueueItem, Printer } from '../api/client';
import { api } from '../api/client';
import { Button } from './Button';
import { QUEUE_TONES, resolveQueueTone } from './queue/queueTones';

/** Gantt-style rolling timeline (6h, 12h, 24h or 48h window). One horizontal
 *  swimlane per printer, plus a "No eligible machine" lane for jobs no printer
 *  can take and one for unassigned items. Each queued, dispatching, or printing
 *  job is a coloured bar positioned by its predicted start time, width =
 *  predicted duration. A vertical NOW line marks current time. Hover a bar for
 *  details, click to edit/stop. */

const HOUR_MS = 60 * 60 * 1000;
const ZOOM_OPTIONS = [6, 12, 24, 48] as const;
type ZoomHours = (typeof ZOOM_OPTIONS)[number];
const DEFAULT_ZOOM: ZoomHours = 12;
// Hours between axis ticks for each zoom level.
const TICK_EVERY_HOURS: Record<ZoomHours, number> = { 6: 1, 12: 2, 24: 4, 48: 6 };
// Space (px) the Now pill takes up around the Now line: an axis label that
// ends within CLEAR_BEFORE of the line, or starts within CLEAR_AFTER of it,
// is hidden so the two never overlap.
const NOW_PILL_CLEAR_BEFORE_PX = 72;
const NOW_PILL_CLEAR_AFTER_PX = 140;
const DEFAULT_TRACK_WIDTH_PX = 1000;
// Minimum bar width — short prints (a few minutes) would otherwise render as
// 1-2px slivers and be unclickable. 32px keeps them at thumb size.
const MIN_BAR_PX = 32;
// Bar height, the gap between stacked rows, and the lane's vertical padding.
const LANE_BAR_HEIGHT_PX = 60;
const LANE_ROW_GAP_PX = 8;
// Visual gap between back-to-back bars; each bar is inset by half on each side.
const BAR_GAP_PX = 4;
const LANE_PADDING_PX = 16;
// Neutral jobs get a visible outline here so they lift off the lane background
// (the Queue tab's neutral border is too faint against the Gantt grid).
const NEUTRAL_BAR = 'bg-bambu-gray-light/10 border-bambu-gray-light/30';
// Lane for jobs that no printer can take (all deactivated, none in the target
// location). They can't run, so they take no time on any printer.
const NO_ELIGIBLE_LANE = 'no-eligible';
const LABEL_COL = 'w-36 sm:w-[200px] shrink-0';

interface ScheduleEvent {
  item: PrintQueueItem;
  estimatedStart: Date;
  estimatedEnd: Date;
  progress?: number;
  type: 'preheating' | 'dispatching' | 'printing' | 'queued' | 'waiting';
  /** Lane the bar is drawn on: the printer a model job would be dispatched to
   *  (or, if blocked, could go onto); its model lane if no printer is eligible. */
  laneKey: string;
}

interface QueueTimelineViewProps {
  queueItems: PrintQueueItem[];
  printers: Printer[];
  /** False until the printer list has loaded. Without it every model job
   *  would look like it has no eligible machine, so a loading (or error)
   *  placeholder is shown instead of the board. Defaults to true. */
  printersLoaded?: boolean;
  /** The printer list failed to load; shown in place of the board. */
  printersError?: boolean;
  printerStatuses: Record<number, { progress?: number; remaining_time?: number; state?: string }>;
  onItemClick: (item: PrintQueueItem) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

interface LaneDescriptor {
  key: string;
  label: string;
  /** null for the "No eligible machine" and unassigned lanes. */
  printerId: number | null;
  /** The printer is deactivated: the forecast never places jobs on it. */
  inactive?: boolean;
}

function normaliseModel(model: string | null | undefined): string {
  return (model ?? '').trim().toLowerCase();
}

function formatTooltipTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function QueueTimelineView({
  queueItems,
  printers,
  printersLoaded = true,
  printersError = false,
  printerStatuses,
  onItemClick,
  t,
}: QueueTimelineViewProps) {
  // Tick "now" every minute so the NOW line and ETA labels stay live.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Width of the time track, so the Now pill's clear zone is in pixels.
  const [trackWidth, setTrackWidth] = useState(DEFAULT_TRACK_WIDTH_PX);
  const observerRef = useRef<ResizeObserver | null>(null);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    setTrackWidth(el.getBoundingClientRect().width || DEFAULT_TRACK_WIDTH_PX);
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(() => {
        setTrackWidth(el.getBoundingClientRect().width || DEFAULT_TRACK_WIDTH_PX);
      });
      observerRef.current.observe(el);
    }
  }, []);

  const [zoom, setZoom] = useState<ZoomHours>(DEFAULT_ZOOM);
  const rangeMs = zoom * HOUR_MS;
  // The window shifts by half its width. Default = current time, so the
  // timeline reads "the next N hours from now."
  const [windowOffsetMs, setWindowOffsetMs] = useState(0);

  // Round the window start down to the previous full hour so the axis ticks
  // land on whole hours.
  const rangeStartMs = useMemo(() => {
    const target = now.getTime() + windowOffsetMs;
    return Math.floor(target / HOUR_MS) * HOUR_MS;
  }, [now, windowOffsetMs]);
  const rangeEndMs = rangeStartMs + rangeMs;
  const nowMs = now.getTime();

  // Build schedule events. Only committed schedules are rendered:
  //  • currently dispatching or printing → always
  //  • pending with explicit scheduled_time → at that time
  //  • pending ASAP that chain behind a print actually running on the same
  //    lane → forecast
  // Placement:
  //  • printer-specific jobs chain on their printer, first;
  //  • model jobs ("Any P1S") go to the eligible printer that can start them
  //    soonest, fitted into the gaps around what is already claimed there;
  //  • model jobs blocked on something a person must fix (waiting_needs_action
  //    or filament_short) are placed last and claim no time. They are drawn on
  //    the printer they could go onto, at the earliest it could start once
  //    unblocked, so blocked jobs sharing a slot overlap and the lane stacks
  //    them in sub-rows;
  //  • a model job with no eligible printer goes on the "No eligible machine"
  //    lane, whether or not anything anchors its model lane.
  //  • blocked printer-specific jobs sit on their own printer after what is
  //    queued there, drawn blocked, and claim no time.
  // Staged (manual_start) items are not on the timeline because they won't
  // auto-dispatch — they'd be misleading bars.
  // Idle-printer ASAP queues also stay off until something starts on them.
  const events = useMemo<ScheduleEvent[]>(() => {
    const result: ScheduleEvent[] = [];
    const pendingByLaneKey = new Map<string, PrintQueueItem[]>();
    // Blocked model jobs (missing material etc.), placed after the rest.
    const waitingByModelLane = new Map<string, PrintQueueItem[]>();
    // Blocked jobs with no model lane to go on (a specific printer, or none).
    const blockedElsewhere: PrintQueueItem[] = [];
    // Lanes that have an active print right now — only these qualify for
    // ASAP chain forecasting.
    const lanesWithActive = new Set<string>();
    // Chain-end timestamp per lane (where the next pending item's bar starts).
    const chainEndByLane = new Map<string, number>();

    const laneKeyOf = (item: PrintQueueItem): string => {
      if (item.printer_id != null) return `printer:${item.printer_id}`;
      if (item.target_model) return `model:${item.target_model}`;
      return 'unassigned';
    };

    for (const item of queueItems) {
      if (item.status === 'preheating' || item.status === 'dispatching' || item.status === 'printing') {
        const isDispatching = item.status === 'preheating' || item.status === 'dispatching';
        const status = item.printer_id != null ? printerStatuses[item.printer_id] : undefined;
        const start = parseUTCDate(isDispatching ? item.dispatched_at : item.started_at) || new Date();
        let endTime: Date;
        if (!isDispatching && status?.remaining_time != null && status.remaining_time > 0) {
          endTime = new Date(nowMs + status.remaining_time * 60 * 1000);
        } else if (item.print_time_seconds) {
          const progress = isDispatching ? 0 : status?.progress || 0;
          const remainingFraction = Math.max(0, 1 - progress / 100);
          endTime = new Date(nowMs + item.print_time_seconds * remainingFraction * 1000);
        } else {
          endTime = new Date(nowMs + HOUR_MS);
        }
        result.push({
          item,
          estimatedStart: start,
          estimatedEnd: endTime,
          progress: isDispatching ? undefined : status?.progress ?? undefined,
          type: item.status,
          laneKey: laneKeyOf(item),
        });
        const lk = laneKeyOf(item);
        lanesWithActive.add(lk);
        chainEndByLane.set(lk, Math.max(chainEndByLane.get(lk) ?? nowMs, endTime.getTime()));
      } else if (item.status === 'pending') {
        // Skip un-committed pending shapes — staged items and waiting items
        // won't auto-dispatch, so a bar would lie.
        if (item.manual_start) continue;
        // A wait that clears by itself (printer busy, upload slot) still
        // dispatches on its own, so it is forecast like any queued job. Only
        // waits that need a person (material etc.) are blocked.
        const waitNeedsAction = !!item.waiting_reason && item.waiting_needs_action !== false;
        const isModelJob = item.printer_id == null && !!item.target_model;
        if (isModelJob && (waitNeedsAction || item.filament_short)) {
          // Blocked model jobs are drawn on the printer they could go onto,
          // flagged as blocked by colour.
          const lk = laneKeyOf(item);
          if (!waitingByModelLane.has(lk)) waitingByModelLane.set(lk, []);
          waitingByModelLane.get(lk)!.push(item);
          continue;
        }
        // A printer-specific or unassigned job waiting on a person claims no
        // time and is drawn blocked on its own lane. One that is only short of
        // filament is still forecast (and drawn purple).
        if (waitNeedsAction) {
          blockedElsewhere.push(item);
          continue;
        }
        const lk = laneKeyOf(item);
        if (!pendingByLaneKey.has(lk)) pendingByLaneKey.set(lk, []);
        pendingByLaneKey.get(lk)!.push(item);
      }
    }

    // Time already claimed on each printer: its active print, then whatever
    // is queued or scheduled on it. Model jobs fit into the gaps around these.
    const busyByPrinter = new Map<number, { start: number; end: number }[]>();
    for (const p of printers) {
      const activeEnd = chainEndByLane.get(`printer:${p.id}`);
      busyByPrinter.set(p.id, activeEnd != null ? [{ start: nowMs, end: activeEnd }] : []);
    }
    const claim = (printerId: number, start: number, end: number) => {
      const list = busyByPrinter.get(printerId);
      if (list) list.push({ start, end });
    };
    // Earliest start >= notBefore at which `duration` fits on the printer
    // without overlapping time already claimed.
    const earliestSlot = (printerId: number, notBefore: number, duration: number) => {
      const busy = [...(busyByPrinter.get(printerId) ?? [])].sort((a, b) => a.start - b.start);
      let t = notBefore;
      for (const b of busy) {
        if (b.end <= t) continue;
        if (b.start >= t + duration) break;
        t = b.end;
      }
      return t;
    };
    // The eligible printer that can start the job soonest (first wins a tie).
    const bestSlot = (eligible: Printer[], notBefore: number, duration: number) => {
      let best: { printer: Printer; start: number } | null = null;
      for (const p of eligible) {
        const start = earliestSlot(p.id, notBefore, duration);
        if (!best || start < best.start) best = { printer: p, start };
      }
      return best;
    };

    const pushQueued = (item: PrintQueueItem, startMs: number, laneKey: string) => {
      const duration = (item.print_time_seconds || 3600) * 1000;
      result.push({
        item,
        estimatedStart: new Date(startMs),
        estimatedEnd: new Date(startMs + duration),
        type: 'queued',
        laneKey,
      });
      return startMs + duration;
    };

    // Printer-specific (and unassigned) lanes chain on a single printer.
    // Process these first so model-based jobs see the capacity they consume.
    for (const [lk, items] of pendingByLaneKey) {
      if (lk.startsWith('model:')) continue;
      items.sort((a, b) => a.position - b.position);
      // A lane is timelineable when EITHER it has an active print (chain
      // forecast off its end) OR its first pending item is scheduled (a
      // committed anchor exists). Otherwise every chained ASAP item is just
      // a guess — drop the whole lane to keep the view honest.
      const firstScheduled = items[0] ? parseUTCDate(items[0].scheduled_time) : null;
      if (!lanesWithActive.has(lk) && !firstScheduled) continue;

      let chainEnd = chainEndByLane.get(lk) ?? nowMs;
      for (const item of items) {
        const scheduled = parseUTCDate(item.scheduled_time);
        if (scheduled) chainEnd = Math.max(chainEnd, scheduled.getTime());
        const chainStart = chainEnd;
        chainEnd = pushQueued(item, chainEnd, lk);
        if (lk.startsWith('printer:')) claim(Number(lk.slice(8)), chainStart, chainEnd);
      }
    }

    // Printers a model job could be dispatched to: active, matching its model
    // (or one of its cross-model variants) and its target location.
    const eligiblePrinters = (item: PrintQueueItem, fallbackModel: string) => {
      const models = new Set([fallbackModel, ...(item.variants ?? []).map((v) => normaliseModel(v.target_model))]);
      return printers.filter(
        (p) =>
          p.is_active &&
          models.has(normaliseModel(p.model)) &&
          (!item.target_location || p.location === item.target_location),
      );
    };

    // A job no printer can take sits on the "No eligible machine" lane from now
    // (or its scheduled time). It can't run, so it claims no time anywhere and
    // such jobs stack in sub-rows.
    const pushNoEligible = (item: PrintQueueItem) => {
      const scheduled = parseUTCDate(item.scheduled_time)?.getTime() ?? 0;
      const start = Math.max(nowMs, scheduled);
      const duration = (item.print_time_seconds || 3600) * 1000;
      result.push({
        item,
        estimatedStart: new Date(start),
        estimatedEnd: new Date(start + duration),
        type: 'waiting',
        laneKey: NO_ELIGIBLE_LANE,
      });
    };

    // Model-based lanes: the dispatcher sends each job to any eligible idle
    // printer, so forecast against per-printer capacity rather than a single
    // chain per model. Jobs go in queue order to the printer that can start
    // them soonest and never start before their own scheduled time.
    for (const [lk, allItems] of pendingByLaneKey) {
      if (!lk.startsWith('model:')) continue;
      const model = normaliseModel(lk.slice(6));
      // Surface jobs with no eligible printer regardless of anchoring: a stuck
      // job is worth seeing even when nothing else is committed.
      const items = allItems.filter((item) => {
        if (eligiblePrinters(item, model).length > 0) return true;
        pushNoEligible(item);
        return false;
      });
      items.sort((a, b) => a.position - b.position);
      // Committed when a scheduled job anchors the lane or an eligible printer
      // is busy to chain off; otherwise an ASAP job is just a guess.
      const anchored = items.some(
        (item) =>
          !!parseUTCDate(item.scheduled_time) ||
          eligiblePrinters(item, model).some((p) => lanesWithActive.has(`printer:${p.id}`)),
      );
      if (!anchored) continue;

      for (const item of items) {
        const scheduled = parseUTCDate(item.scheduled_time)?.getTime() ?? 0;
        const duration = (item.print_time_seconds || 3600) * 1000;
        const slot = bestSlot(eligiblePrinters(item, model), Math.max(nowMs, scheduled), duration);
        if (slot) claim(slot.printer.id, slot.start, pushQueued(item, slot.start, `printer:${slot.printer.id}`));
      }
    }

    // Blocked model jobs can't take a printer yet, so they don't consume
    // capacity. Draw each on the printer that frees up first, at the end of
    // what is queued there: the earliest it could start once unblocked.
    // Without an eligible printer it goes on the "No eligible machine" lane.
    for (const [lk, items] of waitingByModelLane) {
      items.sort((a, b) => a.position - b.position);
      const model = normaliseModel(lk.slice(6));
      for (const item of items) {
        const eligible = eligiblePrinters(item, model);
        const scheduled = parseUTCDate(item.scheduled_time)?.getTime() ?? 0;
        const duration = (item.print_time_seconds || 3600) * 1000;
        const slot = bestSlot(eligible, Math.max(nowMs, scheduled), duration);
        const start = slot ? slot.start : Math.max(nowMs, scheduled);
        const next = slot?.printer ?? null;
        result.push({
          item,
          estimatedStart: new Date(start),
          estimatedEnd: new Date(start + duration),
          type: 'waiting',
          laneKey: next ? `printer:${next.id}` : NO_ELIGIBLE_LANE,
        });
      }
    }

    // Blocked printer-specific (or unassigned) jobs: after everything on that
    // printer, at the earliest it could start once unblocked.
    for (const item of blockedElsewhere) {
      const scheduled = parseUTCDate(item.scheduled_time)?.getTime() ?? 0;
      const duration = (item.print_time_seconds || 3600) * 1000;
      const laneKey = laneKeyOf(item);
      const busy = item.printer_id != null ? busyByPrinter.get(item.printer_id) ?? [] : [];
      const freeAt = busy.reduce((latest, b) => Math.max(latest, b.end), nowMs);
      const start = Math.max(freeAt, scheduled);
      result.push({
        item,
        estimatedStart: new Date(start),
        estimatedEnd: new Date(start + duration),
        type: 'waiting',
        laneKey,
      });
    }
    return result;
  }, [queueItems, printers, printerStatuses, nowMs]);

  // Lanes: every printer, then a "No eligible machine" lane and an
  // "unassigned" lane when they have jobs. Printers that have NO events
  // queued still get a lane so users see idle capacity.
  const lanes = useMemo<LaneDescriptor[]>(() => {
    const list: LaneDescriptor[] = [];
    for (const p of printers) {
      list.push({
        key: `printer:${p.id}`,
        label: p.name,
        printerId: p.id,
        inactive: p.is_active === false,
      });
    }
    let hasNoEligible = false;
    let hasUnassigned = false;
    for (const ev of events) {
      if (ev.laneKey === NO_ELIGIBLE_LANE) hasNoEligible = true;
      else if (ev.laneKey === 'unassigned') hasUnassigned = true;
    }
    if (hasNoEligible) {
      list.push({
        key: NO_ELIGIBLE_LANE,
        label: t('queue.timeline.lane.noEligible'),
        printerId: null,
      });
    }
    if (hasUnassigned) {
      list.push({
        key: 'unassigned',
        label: t('queue.filter.unassigned'),
        printerId: null,
      });
    }
    return list;
  }, [printers, events, t]);

  const eventsByLane = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();
    for (const ev of events) {
      const key = ev.laneKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [events]);

  // Bars that would overlap on screen stack into sub-rows: each takes the
  // first row that is free. That covers jobs sharing a slot (blocked jobs,
  // jobs with no eligible machine) and short jobs, which are drawn at least
  // MIN_BAR_PX wide and so run into the next job at wide zoom levels. A bar's
  // drawn end is therefore its real end or, if later, its minimum width plus
  // the gap.
  const rowsByLane = useMemo(() => {
    const rowOf = new Map<number, number>();
    const rowCount = new Map<string, number>();
    const minDrawnMs = ((MIN_BAR_PX + BAR_GAP_PX) / Math.max(trackWidth, 1)) * rangeMs;
    for (const [key, list] of eventsByLane) {
      const rowEnds: number[] = [];
      const sorted = [...list].sort((a, b) => a.estimatedStart.getTime() - b.estimatedStart.getTime());
      for (const ev of sorted) {
        const start = ev.estimatedStart.getTime();
        let row = rowEnds.findIndex((end) => end <= start);
        if (row === -1) {
          row = rowEnds.length;
          rowEnds.push(0);
        }
        rowEnds[row] = Math.max(ev.estimatedEnd.getTime(), start + minDrawnMs);
        rowOf.set(ev.item.id, row);
      }
      rowCount.set(key, Math.max(1, rowEnds.length));
    }
    return { rowOf, rowCount };
  }, [eventsByLane, trackWidth, rangeMs]);

  const hourTicks = useMemo(() => {
    const ticks: { ms: number; pct: number; label: string }[] = [];
    // Skip the tick at the very start so it does not sit under the label column.
    for (let h = 0; h < zoom; h += TICK_EVERY_HOURS[zoom]) {
      const ms = rangeStartMs + h * HOUR_MS;
      const date = new Date(ms);
      // Wide windows span days, so mark each midnight with the weekday.
      const label =
        zoom >= 24 && date.getHours() === 0
          ? `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${formatTooltipTime(date)}`
          : formatTooltipTime(date);
      ticks.push({ ms, pct: (h / zoom) * 100, label });
    }
    return ticks;
  }, [rangeStartMs, zoom]);

  const nowPct = ((nowMs - rangeStartMs) / rangeMs) * 100;
  const nowInView = nowPct >= 0 && nowPct <= 100;

  // Per printer: is it busy, when does it free up, and when is its next job.
  const laneInfo = useMemo(() => {
    const info = new Map<string, { printing: boolean; freeAt: number | null; nextAt: number | null }>();
    for (const [key, list] of eventsByLane) {
      let freeAt: number | null = null;
      let nextAt: number | null = null;
      for (const ev of list) {
        if (ev.type === 'printing' || ev.type === 'dispatching' || ev.type === 'preheating') {
          freeAt = Math.max(freeAt ?? 0, ev.estimatedEnd.getTime());
        } else if (ev.type === 'queued') {
          nextAt = Math.min(nextAt ?? Infinity, ev.estimatedStart.getTime());
        }
      }
      info.set(key, { printing: freeAt != null, freeAt, nextAt });
    }
    return info;
  }, [eventsByLane]);

  // Aggregated "all done by" across the entire (un-windowed) event set.
  const allDoneBy = useMemo(() => {
    let latest = 0;
    for (const ev of events) {
      if (ev.type === 'waiting') continue;
      latest = Math.max(latest, ev.estimatedEnd.getTime());
    }
    return latest > 0 ? new Date(latest) : null;
  }, [events]);

  const swatchClass = 'w-2.5 h-2.5 rounded-[3px] border';

  if (!printersLoaded) {
    return (
      <div
        role={printersError ? 'alert' : 'status'}
        className="flex items-center justify-center py-16 text-sm text-bambu-gray"
      >
        {printersError ? t('common.errorLoading') : t('common.loading')}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <div
          role="group"
          aria-label={t('queue.timeline.window.zoom')}
          className="flex bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg p-0.5 self-start"
        >
          {ZOOM_OPTIONS.map((hours) => (
            <button
              key={hours}
              type="button"
              data-testid={`queue-timeline-zoom-${hours}`}
              aria-pressed={zoom === hours}
              onClick={() => setZoom(hours)}
              className={`px-3.5 py-1.5 rounded-md text-sm transition-colors ${
                zoom === hours
                  ? 'bg-bambu-dark-tertiary text-white font-semibold'
                  : 'text-bambu-gray hover:text-white font-medium'
              }`}
            >
              {t('queue.timeline.window.hours', { count: hours })}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v - rangeMs / 2)}
            className="p-1.5"
            title={t('queue.timeline.window.earlier')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-semibold text-white min-w-[180px] text-center">
            {new Date(rangeStartMs).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' → '}
            {new Date(rangeEndMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v + rangeMs / 2)}
            className="p-1.5"
            title={t('queue.timeline.window.later')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {windowOffsetMs !== 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWindowOffsetMs(0)}
              className="text-xs text-bambu-green"
            >
              {t('queue.timeline.window.now')}
            </Button>
          )}
        </div>
        <span className="flex-1" />
        {allDoneBy && (
          <span className="self-start sm:self-auto text-sm text-bambu-gray flex items-center gap-2 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-full px-3.5 py-2">
            <Clock className="w-4 h-4" />
            {t('queue.timeline.allDoneBy', {
              time: allDoneBy.toLocaleString(undefined, {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mb-4 text-xs text-bambu-gray">
        <span className="flex items-center gap-1.5">
          <span className={`${swatchClass} ${QUEUE_TONES.active.gutter}`} />
          {t('queue.status.printing')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`${swatchClass} ${NEUTRAL_BAR}`} />
          {t('queue.timeline.legend.scheduledQueued')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`${swatchClass} border-dashed ${QUEUE_TONES.waiting.gutter}`} />
          {t('queue.timeline.legend.blocked')}
        </span>
      </div>

      {/* Empty-state notice when the fleet is idle and no queued item is
          committed (no scheduled_time / no active print to chain off).
          Without this, users see striped lanes with no bars and assume the
          timeline is broken — common confusion from the GHSA-r2qv era. */}
      {lanes.length > 0 && events.length === 0 && (
        <div className="mb-4 p-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/40 text-xs text-bambu-gray">
          {t('queue.timeline.nothingCommitted')}
        </div>
      )}

      {lanes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-bambu-gray">
          <Layers className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{t('queue.timeline.noData')}</p>
        </div>
      ) : (
        <div className="relative bg-bambu-dark-secondary rounded-2xl border border-bambu-dark-tertiary overflow-hidden">
          {/* Hour axis */}
          <div className="flex border-b border-bambu-dark-tertiary h-[41px]">
            <div className={LABEL_COL} />
            <div ref={trackRef} className="relative flex-1">
              {hourTicks
                // The Now pill sits in this row, so drop labels it would cover.
                .filter((tick) => {
                  if (!nowInView) return true;
                  const offsetPx = ((tick.pct - nowPct) / 100) * trackWidth;
                  return offsetPx < -NOW_PILL_CLEAR_BEFORE_PX || offsetPx > NOW_PILL_CLEAR_AFTER_PX;
                })
                .map((tick) => (
                <span
                  key={tick.ms}
                  data-testid="queue-timeline-tick"
                  className="absolute top-[12px] text-[11px] leading-[13px] text-bambu-gray pl-[8px] whitespace-nowrap"
                  style={{ left: `${tick.pct}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>

          {/* Lanes */}
          <div className="relative">
            {lanes.map((lane) => {
              const laneEvents = eventsByLane.get(lane.key) ?? [];
              const laneRows = rowsByLane.rowCount.get(lane.key) ?? 1;
              const info = laneInfo.get(lane.key);
              const isPrinterLane = lane.printerId != null;
              let laneStatus: string | null = null;
              if (lane.inactive) {
                // Not idle capacity: eligibility skips deactivated printers.
                laneStatus = t('queue.timeline.lane.deactivated');
              } else if (isPrinterLane) {
                if (info?.printing && info.freeAt != null) {
                  laneStatus = t('queue.timeline.lane.printingFree', { time: formatTooltipTime(new Date(info.freeAt)) });
                } else if (info?.nextAt != null) {
                  laneStatus = t('queue.timeline.lane.idleNext', { time: formatTooltipTime(new Date(info.nextAt)) });
                } else {
                  laneStatus = t('queue.timeline.lane.idleEmpty');
                }
              }
              const dotClass = lane.inactive
                ? 'bg-bambu-gray/40'
                : isPrinterLane
                ? info?.printing
                  ? 'bg-bambu-green'
                  : 'bg-bambu-gray'
                : 'bg-orange-400';
              return (
                <div key={lane.key} className="flex border-b border-bambu-dark-tertiary/60 last:border-b-0">
                  <div className={`${LABEL_COL} px-[16px] sm:px-[20px] flex flex-col justify-center gap-[4px]`}>
                    <div className="flex items-center gap-[8px] min-w-0">
                      <span className={`w-[8px] h-[8px] rounded-full shrink-0 ${dotClass}`} aria-hidden />
                      <span className={`text-sm font-semibold truncate ${lane.inactive ? 'text-bambu-gray' : 'text-white'}`}>{lane.label}</span>
                    </div>
                    {laneStatus && (
                      <span className="text-[12px] text-bambu-gray pl-[16px] truncate">{laneStatus}</span>
                    )}
                  </div>
                  <div
                    className="relative flex-1"
                    style={{ height: laneRows * (LANE_BAR_HEIGHT_PX + LANE_ROW_GAP_PX) + LANE_PADDING_PX * 2 - LANE_ROW_GAP_PX }}
                  >
                    {/* Hour grid lines */}
                    {hourTicks.slice(1).map((tick) => (
                      <div
                        key={tick.ms}
                        className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/50"
                        style={{ left: `${tick.pct}%` }}
                        aria-hidden
                      />
                    ))}

                    {/* Job bars */}
                    {laneEvents.map((ev) => {
                      // Clip to the visible window.
                      const startMs = Math.max(rangeStartMs, ev.estimatedStart.getTime());
                      const endMs = Math.min(rangeEndMs, ev.estimatedEnd.getTime());
                      if (endMs <= rangeStartMs || startMs >= rangeEndMs) return null;
                      const leftPct = ((startMs - rangeStartMs) / rangeMs) * 100;
                      const widthPct = ((endMs - startMs) / rangeMs) * 100;
                      const displayName = ev.item.archive_name
                        || ev.item.library_file_name
                        || `#${ev.item.id}`;
                      const thumbnailUrl = ev.item.archive_thumbnail
                        ? api.getArchiveThumbnail(ev.item.archive_id!)
                        : ev.item.library_file_thumbnail
                          ? api.getLibraryFileThumbnailUrl(ev.item.library_file_id!)
                          : null;
                      // Same status colours as the Queue tab: colour means a person
                      // needs to act (purple = blocked), green = printing, else neutral.
                      const { tone } = resolveQueueTone(
                        ev.item,
                        ev.item.printer_id != null ? printerStatuses[ev.item.printer_id]?.state : undefined,
                        t,
                      );
                      const isPrinting = ev.type === 'printing';
                      const isWaiting = ev.type === 'waiting';
                      const isDispatching = ev.type === 'preheating' || ev.type === 'dispatching';
                      const duration = ev.item.print_time_seconds ? formatDuration(ev.item.print_time_seconds) : null;
                      const dispatchLabel = isDispatching
                        ? t(ev.type === 'preheating' ? 'heatSoak.status' : 'queue.status.dispatching')
                        : null;
                      const progressLabel = isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null;
                      // The lane already says which printer, so the bar shows
                      // the job name, then when it runs and for how long.
                      const blockedReason = ev.item.waiting_reason
                        || (ev.item.filament_short ? t('queue.filamentShort.rowBadge') : null);
                      const subtitle = isWaiting
                        ? [blockedReason, duration]
                        : isPrinting
                          ? [duration, progressLabel]
                          : isDispatching
                            ? [duration, dispatchLabel]
                            : [formatTooltipTime(ev.estimatedStart), duration];
                      const subtitleText = subtitle.filter(Boolean).join(' · ');
                      const tooltipParts = [
                        displayName,
                        `${formatTooltipTime(ev.estimatedStart)} → ${formatTooltipTime(ev.estimatedEnd)}`,
                        duration,
                        isWaiting ? blockedReason : null,
                        dispatchLabel,
                        progressLabel,
                      ].filter(Boolean).join(' · ');
                      return (
                        <button
                          key={ev.item.id}
                          data-testid={`queue-timeline-item-${ev.item.id}`}
                          data-status={ev.type}
                          onClick={() => onItemClick(ev.item)}
                          title={tooltipParts}
                          className={`absolute rounded-[10px] transition-all hover:brightness-110 hover:z-10 overflow-hidden flex items-start gap-[8px] px-[12px] py-[8px] text-left border ${tone === QUEUE_TONES.neutral ? NEUTRAL_BAR : tone.gutter} ${isWaiting ? 'border-dashed' : ''}`}
                          style={{
                            left: `calc(${leftPct}% + ${BAR_GAP_PX / 2}px)`,
                            width: `max(${MIN_BAR_PX}px, calc(${widthPct}% - ${BAR_GAP_PX}px))`,
                            top: LANE_PADDING_PX + (rowsByLane.rowOf.get(ev.item.id) ?? 0) * (LANE_BAR_HEIGHT_PX + LANE_ROW_GAP_PX),
                            height: LANE_BAR_HEIGHT_PX,
                          }}
                        >
                          {thumbnailUrl && (
                            <img
                              src={thumbnailUrl}
                              alt=""
                              className="w-8 h-8 rounded object-cover shrink-0 bg-bambu-dark self-center"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-[13px] text-white font-semibold truncate leading-[16px]">
                              {isWaiting && <AlertCircle className={`w-3.5 h-3.5 shrink-0 ${tone.text}`} aria-hidden />}
                              <span className="truncate">{displayName}</span>
                            </div>
                            <div className={`text-[11px] truncate leading-[14px] mt-[3px] ${isWaiting || isPrinting ? tone.text : 'text-bambu-gray'}`}>
                              {subtitleText}
                            </div>
                          </div>
                          {isPrinting && ev.progress != null && (
                            <div className="absolute bottom-[8px] left-[12px] right-[12px] h-[3px] rounded-sm bg-bambu-gray-light/20" aria-hidden>
                              <div className={`h-full rounded-sm ${tone.bar}`} style={{ width: `${ev.progress}%` }} />
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* NOW marker — a line through every lane plus a labelled pill in
              the axis row. Offset by the label column so it lines up with the
              time track. */}
          {nowInView && (
            <div className="absolute inset-0 pointer-events-none z-20 flex">
              <div className={LABEL_COL} />
              <div className="relative flex-1">
                <div className="absolute top-0 bottom-0 w-0.5 bg-red-400" style={{ left: `${nowPct}%` }} />
                <span
                  className="absolute top-[9px] ml-[8px] whitespace-nowrap rounded-full bg-red-400 px-[8px] py-[3px] text-[11px] leading-[13px] font-bold text-red-950"
                  style={{ left: `${nowPct}%` }}
                >
                  {t('queue.timeline.nowLabel', { time: formatTooltipTime(now) })}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
