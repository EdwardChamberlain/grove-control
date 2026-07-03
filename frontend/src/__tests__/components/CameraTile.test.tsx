import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { CameraTile } from '../../components/CameraTile';

// The shared render() util mounts AuthProvider, which fires an async
// /auth/me probe on mount. Each test absorbs that settle with a single
// `await act(async () => {})` after render so the AuthProvider state
// update doesn't bleed into the assertion phase as an act() warning.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CameraTile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the live stream URL in live mode', async () => {
    render(
      <CameraTile
        printerId={42}
        printerName="X1C-Lab"
        mode="live"
        snapshotIntervalMs={5000}
        connected
      />,
    );
    await flushMicrotasks();
    const img = screen.getByAltText('X1C-Lab') as HTMLImageElement;
    expect(img.src).toContain('/api/v1/printers/42/camera/stream');
    expect(img.src).toContain('fps=8');
  });

  it('renders the snapshot URL and refreshes on the interval', async () => {
    render(
      <CameraTile
        printerId={7}
        printerName="P1S-Garage"
        mode="snapshot"
        snapshotIntervalMs={1000}
        connected
      />,
    );
    await flushMicrotasks();
    const initial = (screen.getByAltText('P1S-Garage') as HTMLImageElement).src;
    expect(initial).toContain('/api/v1/printers/7/camera/snapshot');

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    const refreshed = (screen.getByAltText('P1S-Garage') as HTMLImageElement).src;
    expect(refreshed).toContain('/api/v1/printers/7/camera/snapshot');
    expect(refreshed).not.toBe(initial);
  });

  it('shows an offline placeholder when not connected', async () => {
    render(
      <CameraTile
        printerId={1}
        printerName="A1-Offline"
        mode="live"
        snapshotIntervalMs={5000}
        connected={false}
      />,
    );
    await flushMicrotasks();
    expect(screen.queryByAltText('A1-Offline')).toBeNull();
  });

  it('shows the paused placeholder in paused mode', async () => {
    render(
      <CameraTile
        printerId={9}
        printerName="H2D-Booth"
        mode="paused"
        snapshotIntervalMs={5000}
        connected
      />,
    );
    await flushMicrotasks();
    expect(screen.queryByAltText('H2D-Booth')).toBeNull();
  });

  it('keeps tile navigation separate from the full-screen action', async () => {
    const onClick = vi.fn();
    const onOpenFullscreen = vi.fn();
    render(
      <CameraTile
        printerId={5}
        printerName="X1C-Camera"
        mode="live"
        snapshotIntervalMs={5000}
        connected
        onClick={onClick}
        onOpenFullscreen={onOpenFullscreen}
      />,
    );
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'X1C-Camera' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onOpenFullscreen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
    expect(onOpenFullscreen).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not trigger tile navigation from fullscreen keyboard events', async () => {
    const onClick = vi.fn();
    render(
      <CameraTile
        printerId={5}
        printerName="X1C-Camera"
        mode="live"
        snapshotIntervalMs={5000}
        connected
        onClick={onClick}
        onOpenFullscreen={vi.fn()}
      />,
    );
    await flushMicrotasks();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Open full screen' }), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the plate-clear action separate from tile navigation', async () => {
    const onClick = vi.fn();
    const onClearPlate = vi.fn();
    render(
      <CameraTile
        printerId={5}
        printerName="X1C-Camera"
        mode="live"
        snapshotIntervalMs={5000}
        connected
        showClearPlate
        onClick={onClick}
        onClearPlate={onClearPlate}
      />,
    );
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Mark plate as cleared' }));
    expect(onClearPlate).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows printer progress across the bottom of the camera frame', async () => {
    render(
      <CameraTile
        printerId={6}
        printerName="P1S-Printing"
        mode="live"
        snapshotIntervalMs={5000}
        connected
        printerState="RUNNING"
        progress={64}
      />,
    );
    await flushMicrotasks();

    const progressbar = screen.getByRole('progressbar', { name: 'Print progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '64');
    expect(progressbar.firstElementChild).toHaveStyle({ width: '64%' });
  });

  it('POSTs /camera/stop when leaving live mode', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const { rerender } = render(
      <CameraTile
        printerId={11}
        printerName="X1C-Stop"
        mode="live"
        snapshotIntervalMs={5000}
        connected
      />,
    );
    await flushMicrotasks();
    const liveImage = screen.getByAltText('X1C-Stop');
    fetchMock.mockClear();

    await act(async () => {
      rerender(
        <CameraTile
          printerId={11}
          printerName="X1C-Stop"
          mode="snapshot"
          snapshotIntervalMs={5000}
          connected
        />,
      );
    });

    const stopCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/v1/printers/11/camera/stop'),
    );
    expect(stopCalls.length).toBeGreaterThan(0);
    expect(liveImage).toHaveAttribute('src', '');
  });

  it('releases a live stream when the camera-wall tile unmounts', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const { unmount } = render(
      <CameraTile
        printerId={12}
        printerName="P1S-To-Cockpit"
        mode="live"
        snapshotIntervalMs={5000}
        connected
      />,
    );
    await flushMicrotasks();
    const liveImage = screen.getByAltText('P1S-To-Cockpit');
    fetchMock.mockClear();

    unmount();

    expect(liveImage).toHaveAttribute('src', '');
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/v1/printers/12/camera/stop'),
    )).toBe(true);
  });
});
