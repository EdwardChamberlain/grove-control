import type { ReactNode } from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client';
import { ToastProvider } from '../../contexts/ToastContext';
import { usePrintControls } from '../../hooks/usePrintControls';
import { server } from '../mocks/server';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

function recordPosts() {
  const paths: string[] = [];
  server.use(
    http.post('*/api/v1/printers/1/print/:action', ({ request }) => {
      paths.push(new URL(request.url).pathname);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
  );
  return paths;
}

function renderControls(state: string | undefined) {
  return renderHook(({ printerState }) => usePrintControls(1, printerState), {
    wrapper,
    initialProps: { printerState: state },
  });
}

describe('usePrintControls', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['pause', 'RUNNING'],
    ['resume', 'PAUSE'],
  ] as const)('sends %s only once the confirmation is accepted', async (action, state) => {
    const posts = recordPosts();
    const { result } = renderControls(state);

    act(() => result.current.requestPauseResume(action));
    expect(result.current.pauseResumeConfirm).toBe(action);
    expect(posts).toHaveLength(0);

    act(() => result.current.confirmPauseResume());
    await waitFor(() => expect(posts).toEqual([`/api/v1/printers/1/print/${action}`]));
  });

  it('closes the confirmation without sending anything', () => {
    const posts = recordPosts();
    const { result } = renderControls('RUNNING');

    act(() => result.current.requestPauseResume('pause'));
    act(() => result.current.closePauseResume());

    expect(result.current.pauseResumeConfirm).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('closes the confirmation when the printer state changes', () => {
    const { result, rerender } = renderControls('RUNNING');

    act(() => result.current.requestPauseResume('pause'));
    rerender({ printerState: 'RUNNING' });
    expect(result.current.pauseResumeConfirm).toBe('pause');

    rerender({ printerState: 'FINISH' });
    expect(result.current.pauseResumeConfirm).toBeNull();
  });

  it('sends nothing when confirming with no dialog open', async () => {
    const posts = recordPosts();
    const { result } = renderControls('RUNNING');

    act(() => result.current.confirmPauseResume());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts).toHaveLength(0);
    expect(result.current.isBusy).toBe(false);
  });

  it.each(['pause', 'resume'] as const)('settles without throwing when %s is refused', async (action) => {
    server.use(
      http.post('*/api/v1/printers/1/print/:action', () =>
        HttpResponse.json({ detail: 'Printer is busy' }, { status: 409 }),
      ),
    );
    const { result } = renderControls(action === 'pause' ? 'RUNNING' : 'PAUSE');

    act(() => result.current.requestPauseResume(action));
    act(() => result.current.confirmPauseResume());

    const mutation = action === 'pause' ? 'pausePrintMutation' : 'resumePrintMutation';
    await waitFor(() => expect(result.current[mutation].isError).toBe(true));
    expect(result.current.isBusy).toBe(false);
  });

  it('stops a print and reports it', async () => {
    const posts = recordPosts();
    const { result } = renderControls('RUNNING');

    act(() => result.current.stopPrintMutation.mutate());

    await waitFor(() => expect(posts).toEqual(['/api/v1/printers/1/print/stop']));
    expect(await screen.findByText('Print stopped')).toBeInTheDocument();
  });

  it('is busy while a request is in flight', async () => {
    let finish: () => void = () => {};
    vi.spyOn(api, 'pausePrint').mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ success: true, message: 'ok' });
      }) as ReturnType<typeof api.pausePrint>,
    );
    const { result } = renderControls('RUNNING');

    act(() => result.current.requestPauseResume('pause'));
    act(() => result.current.confirmPauseResume());
    await waitFor(() => expect(result.current.isBusy).toBe(true));

    await act(async () => finish());
    await waitFor(() => expect(result.current.isBusy).toBe(false));
  });

  it.each([
    ['stopPrint', 'stopPrintMutation', 'Failed to stop print'],
    ['pausePrint', 'pausePrintMutation', 'Failed to pause print'],
    ['resumePrint', 'resumePrintMutation', 'Failed to resume print'],
  ] as const)('falls back to a generic message when %s fails without one', async (method, mutation, message) => {
    vi.spyOn(api, method).mockRejectedValue(new Error(''));
    const { result } = renderControls('RUNNING');

    act(() => result.current[mutation].mutate());

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('shows the server message when a request is refused', async () => {
    server.use(
      http.post('*/api/v1/printers/1/print/pause', () =>
        HttpResponse.json({ detail: 'Printer is busy homing' }, { status: 409 }),
      ),
    );
    const { result } = renderControls('RUNNING');

    act(() => result.current.pausePrintMutation.mutate());

    expect(await screen.findByText('Printer is busy homing')).toBeInTheDocument();
  });
});
