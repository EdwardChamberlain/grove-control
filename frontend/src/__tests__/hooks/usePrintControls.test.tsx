import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

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
});
