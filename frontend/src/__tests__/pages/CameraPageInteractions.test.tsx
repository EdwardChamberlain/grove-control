/**
 * CameraPage interactions: live / snapshot modes, zoom and pan, stream
 * errors with backoff reconnects, stall detection, the chamber light and
 * fullscreen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { server } from '../mocks/server';
import { CameraPage } from '../../pages/CameraPage';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AuthProvider } from '../../contexts/AuthContext';

let calls: string[];
let cameraStatus: { active: boolean; stalled: boolean };

function renderPage(search = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/cameras/1${search}`]}>
          <AuthProvider>
            <ThemeProvider>
              <ToastProvider>
                <Routes>
                  <Route path="/cameras/:printerId" element={<CameraPage />} />
                </Routes>
              </ToastProvider>
            </ThemeProvider>
          </AuthProvider>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('navigator', { ...navigator, sendBeacon: vi.fn().mockReturnValue(true) });
  calls = [];
  cameraStatus = { active: true, stalled: false };
  server.use(
    http.get('/api/v1/printers/1', () => HttpResponse.json({ id: 1, name: 'X1 Carbon', model: 'X1C', camera_rotation: 180 })),
    http.get('/api/v1/printers/1/status', () =>
      HttpResponse.json({ connected: true, state: 'RUNNING', chamber_light: true, printable_objects_count: 1 }),
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

const stream = () => screen.getByAltText('Camera stream') as HTMLImageElement;

describe('CameraPage interactions', () => {
  it('switches between live stream and snapshots', async () => {
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));
    // Mode buttons stay disabled until the current image has loaded.
    fireEvent.load(stream());

    fireEvent.click(screen.getByRole('button', { name: /Snapshot/ }));
    act(() => vi.advanceTimersByTime(150));
    await waitFor(() => expect(stream().src).toContain('snapshot'));
    expect(screen.getByTitle('Refresh snapshot')).toBeInTheDocument();
    fireEvent.load(stream());
    fireEvent.click(screen.getByTitle('Refresh snapshot'));
    act(() => vi.advanceTimersByTime(150));
    fireEvent.load(stream());

    fireEvent.click(screen.getByRole('button', { name: /Live/ }));
    act(() => vi.advanceTimersByTime(150));
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));
    expect(screen.getByTitle('Restart stream')).toBeInTheDocument();
  });

  it('zooms with buttons, the wheel and pinch, and pans when zoomed', async () => {
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));
    const img = stream();
    const area = img.parentElement as HTMLElement;

    fireEvent.click(screen.getByTitle('Zoom in'));
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(img.style.transform).toContain('scale(2)');
    fireEvent.click(screen.getByTitle('Zoom out'));
    fireEvent.wheel(area, { deltaY: -50 });
    expect(img.style.transform).toContain('scale(2)');

    fireEvent.mouseDown(img, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(area, { clientX: 40, clientY: 30 });
    fireEvent.mouseUp(area);

    fireEvent.touchStart(area, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchEnd(area, { touches: [] });
    fireEvent.touchStart(area, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 300, clientY: 0 }] });
    fireEvent.touchEnd(area, { touches: [{ clientX: 0, clientY: 0 }] });
    expect(img.style.transform).toContain('scale(4)');

    fireEvent.click(screen.getByTitle('Reset zoom'));
    expect(img.style.transform).toContain('scale(1)');
    fireEvent.wheel(area, { deltaY: 50 });
    expect(img.style.transform).toContain('scale(1)');
  });

  it('reconnects with backoff after errors, then offers a retry', async () => {
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));

    for (let attempt = 0; attempt < 5; attempt++) {
      fireEvent.error(stream());
      expect(screen.getByText('Connection lost')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(31000));
    }
    fireEvent.error(stream());
    expect(screen.getByText('Camera unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    act(() => vi.advanceTimersByTime(200));
    await waitFor(() => expect(calls).toContain('stop'));
    expect(screen.queryByText('Camera unavailable')).not.toBeInTheDocument();
  });

  it('reconnects immediately on request and clears state on load', async () => {
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));

    fireEvent.error(stream());
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.load(stream());

    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('reconnects when the server reports a stalled stream', async () => {
    cameraStatus = { active: false, stalled: true };
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));

    fireEvent.load(stream());
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    await waitFor(() => expect(screen.getByText('Connection lost')).toBeInTheDocument());
  });

  it('turns the chamber light off', async () => {
    renderPage();

    const light = await screen.findByTitle('Toggle chamber light');
    await waitFor(() => expect(light).toBeEnabled());
    fireEvent.click(light);

    await waitFor(() => expect(calls).toContain('light false'));
  });

  it('reports a failed chamber light toggle', async () => {
    server.use(http.post('/api/v1/printers/1/chamber-light', () => HttpResponse.json({ detail: 'Printer busy' }, { status: 409 })));
    renderPage();

    const light = await screen.findByTitle('Toggle chamber light');
    await waitFor(() => expect(light).toBeEnabled());
    fireEvent.click(light);

    expect(await screen.findByText('Printer busy')).toBeInTheDocument();
  });

  it('enters and leaves fullscreen', async () => {
    const request = vi.fn();
    HTMLElement.prototype.requestFullscreen = request;
    renderPage();
    await waitFor(() => expect(stream().src).toContain('/camera/stream'));

    fireEvent.click(screen.getByTitle('Fullscreen'));
    expect(request).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body });
    fireEvent(document, new Event('fullscreenchange'));
    const exit = vi.fn();
    document.exitFullscreen = exit;
    fireEvent.click(screen.getByTitle('Exit fullscreen'));
    expect(exit).toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByTitle('Fullscreen')).toBeInTheDocument();
  });
});
