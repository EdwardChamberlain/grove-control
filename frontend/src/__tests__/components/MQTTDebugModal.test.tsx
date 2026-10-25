/**
 * MQTTDebugModal: start / stop / clear logging, filtering by direction and
 * search text, and expanding a message payload.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { MQTTDebugModal } from '../../components/MQTTDebugModal';

const logs = [
  { timestamp: '2026-01-01T10:00:00.123Z', topic: 'device/SER/report', direction: 'in', payload: { print: { gcode_state: 'RUNNING', note: 'x'.repeat(150) } } },
  { timestamp: '2026-01-01T10:00:01.456Z', topic: 'device/SER/request', direction: 'out', payload: { pushing: { command: 'pushall' } } },
  { timestamp: '2026-01-01T10:00:02.000Z', topic: 'device/SER/empty', direction: 'in', payload: null },
];

function useLogs(enabled: boolean, entries: unknown[] = logs) {
  const calls: string[] = [];
  server.use(
    http.get('/api/v1/printers/1/logging', () => HttpResponse.json({ logging_enabled: enabled, logs: entries })),
    http.post('/api/v1/printers/1/logging/enable', () => {
      calls.push('enable');
      return HttpResponse.json({ logging_enabled: true });
    }),
    http.post('/api/v1/printers/1/logging/disable', () => {
      calls.push('disable');
      return HttpResponse.json({ logging_enabled: false });
    }),
    http.delete('/api/v1/printers/1/logging', () => {
      calls.push('clear');
      return HttpResponse.json({ status: 'cleared' });
    }),
  );
  return calls;
}

describe('MQTTDebugModal', () => {
  it('shows an empty, stopped log and starts logging', async () => {
    const calls = useLogs(false, []);
    const user = userEvent.setup();
    render(<MQTTDebugModal printerId={1} printerName="X1" onClose={vi.fn()} />);

    expect(await screen.findByText('No messages logged yet')).toBeInTheDocument();
    expect(screen.getByText(/Click "Start Logging"/)).toBeInTheDocument();
    expect(screen.getByText('Logging stopped')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Start Logging/ }));

    await waitFor(() => expect(calls).toEqual(['enable']));
  });

  it('lists messages, filters them and expands payloads', async () => {
    const calls = useLogs(true);
    const user = userEvent.setup();
    render(<MQTTDebugModal printerId={1} printerName="X1" onClose={vi.fn()} />);

    expect(await screen.findByText('device/SER/report')).toBeInTheDocument();
    expect(screen.getByText('Logging active - messages will auto-refresh')).toBeInTheDocument();
    expect(screen.getByText('<empty>')).toBeInTheDocument();
    expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument(); // long payload truncated

    await user.click(screen.getByText('device/SER/request'));
    expect(screen.getByText(/"command": "pushall"/)).toBeInTheDocument();
    await user.click(screen.getByText('device/SER/request'));
    expect(screen.queryByText(/"command": "pushall"/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Outgoing/ }));
    expect(screen.queryByText('device/SER/report')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Incoming/ }));
    expect(screen.queryByText('device/SER/request')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^All$/ }));

    const search = screen.getByPlaceholderText('Search topic or payload...');
    await user.type(search, 'RUNNING');
    expect(screen.getByText('device/SER/report')).toBeInTheDocument();
    expect(screen.queryByText('device/SER/request')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'nothing-matches');
    expect(screen.getByText('No messages match your filter')).toBeInTheDocument();
    await user.click(search.parentElement!.querySelector('button')!);
    expect(search).toHaveValue('');

    await user.click(screen.getByRole('button', { name: /Clear Log/ }));
    await user.click(screen.getByRole('button', { name: /Stop Logging/ }));
    await waitFor(() => expect(calls).toEqual(['clear', 'disable']));
  });

  it('closes with the button, the X and Escape', async () => {
    useLogs(false, []);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MQTTDebugModal printerId={1} printerName="X1" onClose={onClose} />);

    await screen.findByText('No messages logged yet');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByText('MQTT Debug Log').parentElement!.parentElement!.querySelector('button')!);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'a' });

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
