/**
 * useWebSocket: messages driven end to end through the hook.
 *
 * Covers the throttled printer_status merge, queue/print invalidations, the
 * debounced inventory refreshes, the window events other components listen
 * for, the missing-spool toast, keepalive pings and error/close handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../contexts/ToastContext';
import { useWebSocket } from '../../hooks/useWebSocket';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'printers.toast.missingSpoolAssignment' && options
        ? `Missing assignments for ${options.printer}: ${options.slots}`
        : key,
    i18n: {},
  }),
}));

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1006 }));
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor(public url: string) {
    sockets.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  receive(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let queryClient: QueryClient;
let originalWebSocket: typeof WebSocket;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(ToastProvider, {}, React.createElement(QueryClientProvider, { client: queryClient }, children));
}

async function connected() {
  const hook = renderHook(() => useWebSocket(), { wrapper });
  await act(flushMicrotasks);
  const ws = sockets[sockets.length - 1];
  act(() => ws.open());
  return { hook, ws };
}

function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown[] }).queryKey));
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ token: 'tok' }),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
});

describe('printer_status', () => {
  it('coalesces rapid updates per printer and keeps a known wifi signal', async () => {
    queryClient.setQueryData(['printerStatus', 1], { state: 'IDLE', wifi_signal: -60, progress: 0 });
    const { ws } = await connected();

    act(() => {
      ws.receive({ type: 'printer_status', printer_id: 1, data: { state: 'RUNNING', wifi_signal: null } });
      ws.receive({ type: 'printer_status', printer_id: 1, data: { progress: 12 } });
      ws.receive({ type: 'printer_status', printer_id: 2, data: { state: 'IDLE' } });
    });
    // Nothing is applied until the 100ms throttle window closes.
    expect(queryClient.getQueryData(['printerStatus', 1])).toEqual({ state: 'IDLE', wifi_signal: -60, progress: 0 });

    act(() => vi.advanceTimersByTime(100));

    expect(queryClient.getQueryData(['printerStatus', 1])).toEqual({ state: 'RUNNING', wifi_signal: -60, progress: 12 });
    expect(queryClient.getQueryData(['printerStatus', 2])).toEqual({ state: 'IDLE' });
  });
});

describe('immediate invalidations', () => {
  it('print_start refreshes queue work and that printer', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { ws } = await connected();

    act(() => ws.receive({ type: 'print_start', printer_id: 3 }));

    expect(invalidatedKeys(spy)).toEqual(['["printerQueueWork"]', '["printerStatus",3]']);
  });

  it('queue_work_changed refreshes queue work', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { ws } = await connected();

    act(() => ws.receive({ type: 'queue_work_changed' }));

    expect(invalidatedKeys(spy)).toEqual(['["printerQueueWork"]']);
  });
});

describe('debounced invalidations', () => {
  it.each([
    ['spool_assignment_changed', ['["spool-assignments"]', '["slotPresets"]']],
    ['spool_auto_assigned', ['["inventory-spools"]', '["spool-assignments"]']],
    ['spool_usage_logged', ['["inventory-spools"]']],
  ])('%s refreshes inventory data after a pause', async (type, keys) => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { ws } = await connected();

    act(() => ws.receive({ type }));
    act(() => vi.advanceTimersByTime(2999));
    expect(spy).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1 + 500 * keys.length));
    expect(invalidatedKeys(spy)).toEqual(keys);
  });

  it('a burst of messages becomes one refresh per key', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { ws } = await connected();

    act(() => {
      ws.receive({ type: 'archive_updated' });
      ws.receive({ type: 'archive_updated' });
      ws.receive({ type: 'spool_usage_logged' });
    });
    act(() => vi.advanceTimersByTime(10_000));

    expect(invalidatedKeys(spy).sort()).toEqual(['["archives"]', '["inventory-spools"]']);
  });

  it('unmounting cancels pending refreshes', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { hook, ws } = await connected();

    act(() => {
      ws.receive({ type: 'archive_updated' });
      ws.receive({ type: 'printer_status', printer_id: 1, data: { state: 'IDLE' } });
    });
    hook.unmount();
    act(() => vi.advanceTimersByTime(10_000));

    expect(spy).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['printerStatus', 1])).toBeUndefined();
  });
});

describe('window events', () => {
  it('plate_not_empty is re-dispatched for the toast layer', async () => {
    const listener = vi.fn();
    window.addEventListener('plate-not-empty', listener);
    const { ws } = await connected();

    act(() => ws.receive({ type: 'plate_not_empty', printer_id: 4, printer_name: 'X1C', message: 'Objects on plate' }));

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      printer_id: 4,
      printer_name: 'X1C',
      message: 'Objects on plate',
    });
    window.removeEventListener('plate-not-empty', listener);
  });

  it('unknown_tag carries the slot data', async () => {
    const listener = vi.fn();
    window.addEventListener('unknown-tag', listener);
    const { ws } = await connected();

    act(() =>
      ws.receive({
        type: 'unknown_tag',
        printer_id: 1,
        ams_id: 0,
        tray_id: 2,
        tag_uid: 'AABB',
        tray_uuid: 'CCDD',
        tray_type: 'PLA',
        tray_color: 'FF0000FF',
        tray_sub_brands: 'PLA Basic',
        tray_count: 4,
      }),
    );

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ tray_id: 2, tag_uid: 'AABB', tray_count: 4 });
    window.removeEventListener('unknown-tag', listener);
  });
});

describe('missing spool assignments', () => {
  it('warns once per distinct set of slots', async () => {
    const { ws } = await connected();
    const message = {
      type: 'missing_spool_assignment',
      printer_id: 1,
      printer_name: 'Workshop',
      missing_slots: [{ slot: 'AMS-A T1' }, { slot: 'AMS-A T3' }],
    };

    act(() => {
      ws.receive(message);
      vi.advanceTimersByTime(16);
      ws.receive(message);
      vi.advanceTimersByTime(16);
    });

    expect(screen.getAllByText('Missing assignments for Workshop: AMS-A T1, AMS-A T3')).toHaveLength(1);
  });

  it('an empty list resets the warning so it can show again', async () => {
    const { ws } = await connected();
    const message = { type: 'missing_spool_assignment', printer_id: 2, missing_slots: [{ slot: 'Ext' }] };

    act(() => {
      ws.receive(message);
      vi.advanceTimersByTime(16);
      ws.receive({ ...message, missing_slots: [] });
      vi.advanceTimersByTime(16);
      ws.receive(message);
      vi.advanceTimersByTime(16);
    });

    expect(screen.getAllByText('Missing assignments for Printer 2: Ext')).toHaveLength(2);
  });

  it('ignores malformed payloads', async () => {
    const { ws } = await connected();

    act(() => {
      ws.receive({ type: 'missing_spool_assignment', printer_id: 1, missing_slots: 'nope' });
      vi.advanceTimersByTime(16);
    });

    expect(screen.queryByText(/Missing assignments/)).not.toBeInTheDocument();
  });
});

describe('connection handling', () => {
  it('pings every 30 seconds while open', async () => {
    const { ws } = await connected();

    act(() => vi.advanceTimersByTime(30_000));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('closes the socket on error and reconnects', async () => {
    const { ws } = await connected();

    act(() => ws.onerror?.(new Event('error')));
    expect(ws.close).toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushMicrotasks();
    });
    expect(sockets).toHaveLength(2);
  });

  it('connects without a token when the token request fails for a non-auth reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    renderHook(() => useWebSocket(), { wrapper });
    await act(flushMicrotasks);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).not.toContain('token=');
  });
});
