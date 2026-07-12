import type { Page } from '@playwright/test';

export async function stubWebSocket(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      binaryType: BinaryType = 'blob';
      bufferedAmount = 0;
      extensions = '';
      protocol = '';
      readyState = MockWebSocket.CONNECTING;
      url: string;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          const event = new Event('open');
          this.onopen?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      send() {
        // The app only needs a live socket surface for smoke tests.
      }

      close(code = 1000, reason = '') {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        const event = new CloseEvent('close', { code, reason, wasClean: true });
        this.onclose?.(event);
        this.dispatchEvent(event);
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
  });
}
