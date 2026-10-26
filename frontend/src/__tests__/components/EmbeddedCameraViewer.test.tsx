/**
 * EmbeddedCameraViewer: the floating camera window — saved position,
 * dragging and resizing, minimise, zoom and pan, the chamber light, stream
 * errors with backoff reconnects, stall detection, and stopping the stream
 * on close.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { EmbeddedCameraViewer } from '../../components/EmbeddedCameraViewer';

let store: Record<string, string>;
let calls: string[];
let cameraStatus: { active: boolean; stalled: boolean };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  store = {};
  calls = [];
  cameraStatus = { active: true, stalled: false };
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    store[key] = value;
  });
  server.use(
    http.get('/api/v1/printers/1', () => HttpResponse.json({ id: 1, name: 'X1', camera_rotation: 90 })),
    http.get('/api/v1/printers/1/status', () =>
      HttpResponse.json({ connected: true, state: 'RUNNING', chamber_light: false, printable_objects_count: 3 }),
    ),
    http.post('/api/v1/printers/1/chamber-light', ({ request }) => {
      calls.push(`light ${new URL(request.url).searchParams.get('on')}`);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
    http.get('/api/v1/printers/1/camera/status', () => HttpResponse.json(cameraStatus)),
    http.post('/api/v1/printers/1/camera/stop', () => {
      calls.push('stop');
      return HttpResponse.json({});
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function viewer(): HTMLElement {
  return screen.getByAltText('Camera stream').closest('.fixed') as HTMLElement;
}

describe('EmbeddedCameraViewer', () => {
  it('shows the stream, restores a saved position and saves moves', async () => {
    store['embeddedCameraState_1'] = JSON.stringify({ x: -50, y: 40, width: 400, height: 100 });
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    const img = screen.getByAltText('Camera stream') as HTMLImageElement;
    expect(img.src).toContain('/api/v1/printers/1/camera/stream?fps=15');
    // Off-screen and oversized values are clamped back on screen.
    expect(viewer().style.left).toBe('0px');
    expect(viewer().style.height).toBe('150px');
    await waitFor(() => expect(img.style.transform).toContain('rotate(90deg)'));

    // Drag by the header.
    const header = screen.getByText('X1').closest('div.cursor-grab') as HTMLElement;
    fireEvent.mouseDown(header, { clientX: 10, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 110, clientY: 150 });
    fireEvent.mouseUp(document);
    expect(viewer().style.left).toBe('100px');

    // Resize from the corner.
    fireEvent.mouseDown(screen.getByTitle('Drag to resize'));
    fireEvent.mouseMove(document, { clientX: 500, clientY: 400 });
    fireEvent.mouseUp(document);

    act(() => vi.advanceTimersByTime(600));
    expect(JSON.parse(store['embeddedCameraState_1']).x).toBe(100);
  });

  it('offsets new viewers so they do not stack', () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" viewerIndex={2} onClose={vi.fn()} />);

    expect(viewer().style.top).toBe('80px');
  });

  it('drags and resizes by touch', () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);
    const header = screen.getByText('X1').closest('div.cursor-grab') as HTMLElement;

    fireEvent.touchStart(header, { touches: [{ clientX: 5, clientY: 25 }] });
    fireEvent.touchMove(document, { touches: [{ clientX: 55, clientY: 75 }] });
    fireEvent.touchEnd(document);
    fireEvent.touchStart(screen.getByTitle('Drag to resize'), { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(document, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchCancel(document);

    expect(viewer().style.top).toBe('70px');
  });

  it('minimises and expands', () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByTitle('Minimize'));
    expect(screen.queryByAltText('Camera stream')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByAltText('Camera stream')).toBeInTheDocument();
  });

  it('zooms with buttons, the wheel and pinch, and pans when zoomed', () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);
    const img = screen.getByAltText('Camera stream') as HTMLImageElement;
    const area = img.parentElement as HTMLElement;

    fireEvent.click(screen.getByTitle('Zoom in'));
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(img.style.transform).toContain('scale(2)');
    fireEvent.click(screen.getByTitle('Zoom out'));
    expect(img.style.transform).toContain('scale(1.5)');
    fireEvent.wheel(area, { deltaY: -100 });
    expect(img.style.transform).toContain('scale(2)');

    // Mouse pan while zoomed.
    fireEvent.mouseDown(img, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(area, { clientX: 30, clientY: 20 });
    fireEvent.mouseUp(area);
    expect(img.style.transform).toMatch(/translate\((?!0px, 0px)/);

    // Single-finger pan and two-finger pinch.
    fireEvent.touchStart(area, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchEnd(area, { touches: [] });
    fireEvent.touchStart(area, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }] });
    fireEvent.touchEnd(area, { touches: [{ clientX: 0, clientY: 0 }] });
    expect(img.style.transform).toContain('scale(4)');

    fireEvent.click(screen.getByTitle('Reset zoom'));
    expect(img.style.transform).toContain('scale(1)');
    fireEvent.wheel(area, { deltaY: 100 });
    expect(img.style.transform).toContain('scale(1)');
  });

  it('toggles the chamber light', async () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    const light = await screen.findByTitle('Toggle chamber light');
    await waitFor(() => expect(light).toBeEnabled());
    fireEvent.click(light);

    await waitFor(() => expect(calls).toContain('light true'));
    expect(await screen.findByText('Chamber light on')).toBeInTheDocument();
  });

  it('reports a failed chamber light toggle', async () => {
    server.use(http.post('/api/v1/printers/1/chamber-light', () => HttpResponse.json({ detail: 'Printer offline' }, { status: 503 })));
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    const light = await screen.findByTitle('Toggle chamber light');
    await waitFor(() => expect(light).toBeEnabled());
    fireEvent.click(light);

    expect(await screen.findByText('Printer offline')).toBeInTheDocument();
  });

  it('reconnects with backoff after stream errors, then gives up', async () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    for (let attempt = 0; attempt < 5; attempt++) {
      fireEvent.error(screen.getByAltText('Camera stream'));
      expect(screen.getByText(/Reconnecting in \d+s/)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(31000));
    }
    fireEvent.error(screen.getByAltText('Camera stream'));

    expect(screen.getByText('Camera unavailable')).toBeInTheDocument();

    // Retry starts a fresh stream and asks the server to stop the old one.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    act(() => vi.advanceTimersByTime(200));
    await waitFor(() => expect(calls).toContain('stop'));
    expect(screen.queryByText('Camera unavailable')).not.toBeInTheDocument();
  });

  it('clears the reconnect state once the stream loads', () => {
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    fireEvent.error(screen.getByAltText('Camera stream'));
    fireEvent.load(screen.getByAltText('Camera stream'));

    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it('reconnects when the server reports a stalled stream', async () => {
    cameraStatus = { active: true, stalled: true };
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    fireEvent.load(screen.getByAltText('Camera stream'));
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });

    await waitFor(() => expect(screen.getByText(/Reconnecting in/)).toBeInTheDocument());
  });

  it('refreshes, opens the diagnostic and stops the stream on close', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={onClose} />);

    fireEvent.click(screen.getByTitle('Refresh stream'));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(screen.getByTitle('Diagnose'));
    expect(await screen.findByText('Camera diagnostic')).toBeInTheDocument();

    const header = screen.getByText('X1').closest('div.cursor-grab') as HTMLElement;
    fireEvent.click(within(header).getByTitle('Close'));
    expect(onClose).toHaveBeenCalled();
    calls.length = 0;
    unmount();
    await waitFor(() => expect(calls).toEqual(['stop']));
  });

  it('enters and leaves fullscreen', () => {
    const request = vi.fn();
    HTMLElement.prototype.requestFullscreen = request;
    render(<EmbeddedCameraViewer printerId={1} printerName="X1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByTitle('Fullscreen'));
    expect(request).toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: viewer() });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByTitle('Exit fullscreen')).toBeInTheDocument();
    const exit = vi.fn();
    document.exitFullscreen = exit;
    fireEvent.click(screen.getByTitle('Exit fullscreen'));
    expect(exit).toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByTitle('Fullscreen')).toBeInTheDocument();
  });
});
