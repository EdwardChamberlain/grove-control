/**
 * SettingsPage: the Network tab. Covers the autosaved network fields, the
 * FTP retry options, MQTT, Home Assistant connection testing and the
 * Prometheus metrics endpoint.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { SettingsPage } from '../../pages/SettingsPage';
import { server } from '../mocks/server';

const baseSettings = {
  auto_archive: true,
  save_thumbnails: true,
  capture_finish_photo: true,
  default_filament_cost: 25.0,
  currency: 'USD',
  ams_humidity_good: 40,
  ams_humidity_fair: 60,
  ams_temp_good: 30,
  ams_temp_fair: 35,
  time_format: 'system',
  date_format: 'system',
  mqtt_enabled: false,
  mqtt_broker: '',
  mqtt_port: 1883,
  mqtt_use_tls: false,
  mqtt_topic_prefix: 'bambuddy',
  ftp_retry_enabled: false,
  ftp_retry_count: 3,
  ftp_retry_delay: 2,
  ftp_timeout: 30,
  external_url: 'http://grove.local:8000',
  ha_enabled: false,
  ha_url: '',
  ha_token: '',
  prometheus_enabled: false,
  prometheus_token: '',
  check_updates: false,
  check_printer_firmware: false,
  bed_cooled_threshold: 35,
};

/** Records every settings PUT so tests can assert on what was saved. */
function useSettings(overrides: Record<string, unknown> = {}, mqttStatus: Record<string, unknown> = { enabled: false }) {
  const saves: Record<string, unknown>[] = [];
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ ...baseSettings, ...overrides })),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saves.push(body);
      return HttpResponse.json({ ...baseSettings, ...overrides, ...body });
    }),
    http.get('/api/v1/settings/mqtt/status', () => HttpResponse.json(mqttStatus)),
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('/api/v1/notifications/', () => HttpResponse.json([])),
    http.get('/api/v1/api-keys/', () => HttpResponse.json([])),
    http.get('/api/v1/virtual-printer/status', () => HttpResponse.json({ running: false })),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    http.get('/api/v1/external-links/', () => HttpResponse.json([])),
  );
  return saves;
}

/** The value of the last settings PUT that carried the given key. */
function lastSaved(saves: Record<string, unknown>[], key: string) {
  const matching = saves.filter((body) => key in body);
  return matching.length ? matching[matching.length - 1][key] : undefined;
}

/** Open the Network tab and wait until its settings have loaded. */
async function openNetworkTab(user: ReturnType<typeof userEvent.setup>) {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
  await user.click(screen.getByText('Network'));
  await screen.findByText('MQTT Publishing');
  // The page clears its initial-load guard on a 100 ms timer started when the settings load. This
  // later timer is registered after that one, so timers fire in order and the guard is always clear.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** The checkbox on the row that carries a given heading text. */
function rowSwitch(label: string): HTMLElement {
  const row = screen.getByText(label).parentElement?.parentElement as HTMLElement;
  return within(row).getByRole('checkbox');
}

/** The input or select that follows a field label. */
function fieldFor(label: string): HTMLElement {
  const field = screen.getByText(label).parentElement?.querySelector<HTMLElement>('input, select');
  if (!field) throw new Error(`no field under label ${label}`);
  return field;
}

describe('SettingsPage Network tab: autosaved fields', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  it('autosaves the external Grove Control URL', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openNetworkTab(user);

    const url = screen.getByPlaceholderText('http://192.168.1.100:8000');
    await user.clear(url);
    await user.type(url, 'http://grove.lan:9000');

    await waitFor(() => expect(lastSaved(saves, 'external_url')).toBe('http://grove.lan:9000'));
  });

  it('enables FTP retry and saves the retry count', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.click(rowSwitch('Enable retry'));
    await waitFor(() => expect(lastSaved(saves, 'ftp_retry_enabled')).toBe(true));

    await user.selectOptions(fieldFor('Retry attempts'), '5');
    await waitFor(() => expect(lastSaved(saves, 'ftp_retry_count')).toBe(5));
  });

  it('saves the retry delay and the connection timeout', async () => {
    const saves = useSettings({ ftp_retry_enabled: true });
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.selectOptions(fieldFor('Retry delay'), '10');
    await waitFor(() => expect(lastSaved(saves, 'ftp_retry_delay')).toBe(10));

    await user.selectOptions(fieldFor('Connection timeout'), '60');
    await waitFor(() => expect(lastSaved(saves, 'ftp_timeout')).toBe(60));
  });
});

describe('SettingsPage Network tab: MQTT', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  it('shows the broker the connection is using once MQTT is connected', async () => {
    useSettings(
      { mqtt_enabled: true, mqtt_broker: 'mqtt.lan' },
      { enabled: true, connected: true, broker: 'mqtt.lan', port: 1883 },
    );
    const user = userEvent.setup();
    await openNetworkTab(user);

    expect(await screen.findByText('mqtt.lan:1883')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('enables MQTT, then saves the broker, username and topic prefix', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.click(rowSwitch('Enable MQTT'));
    await waitFor(() => expect(lastSaved(saves, 'mqtt_enabled')).toBe(true));

    const broker = fieldFor('Broker hostname');
    await user.type(broker, 'mqtt.lan');
    await waitFor(() => expect(lastSaved(saves, 'mqtt_broker')).toBe('mqtt.lan'));

    await user.type(fieldFor('Username (optional)'), 'grove');
    await waitFor(() => expect(lastSaved(saves, 'mqtt_username')).toBe('grove'));

    await user.clear(fieldFor('Topic prefix'));
    await user.type(fieldFor('Topic prefix'), 'shop');
    await waitFor(() => expect(lastSaved(saves, 'mqtt_topic_prefix')).toBe('shop'));
  });

  it('clamps the port to the valid range and can switch TLS on', async () => {
    const saves = useSettings({ mqtt_enabled: true });
    const user = userEvent.setup();
    await openNetworkTab(user);

    fireEvent.change(fieldFor('Port'), { target: { value: '99999' } });
    await waitFor(() => expect(lastSaved(saves, 'mqtt_port')).toBe(65535));

    await user.click(rowSwitch('Use TLS'));
    await waitFor(() => expect(lastSaved(saves, 'mqtt_use_tls')).toBe(true));
  });
});

describe('SettingsPage Network tab: Home Assistant', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  it('saves the Home Assistant URL and token once enabled', async () => {
    const saves = useSettings({ ha_enabled: true });
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.type(fieldFor('Home Assistant URL'), 'http://ha.lan:8123');
    await waitFor(() => expect(lastSaved(saves, 'ha_url')).toBe('http://ha.lan:8123'));

    await user.type(fieldFor('Long-Lived Access Token'), 'abc123');
    await waitFor(() => expect(lastSaved(saves, 'ha_token')).toBe('abc123'));
  });

  it('reports a successful connection test and dismisses the result', async () => {
    const tested: unknown[] = [];
    useSettings({ ha_enabled: true, ha_url: 'http://ha.lan:8123', ha_token: 'abc123' });
    server.use(
      http.post('/api/v1/smart-plugs/ha/test-connection', async ({ request }) => {
        tested.push(await request.json());
        return HttpResponse.json({ success: true, message: 'Home Assistant 2026.1 reachable' });
      }),
    );
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.click(screen.getByRole('button', { name: 'Test Connection' }));

    expect(await screen.findByRole('heading', { name: 'Connection Successful' })).toBeInTheDocument();
    expect(screen.getByText('Home Assistant 2026.1 reachable')).toBeInTheDocument();
    expect(tested).toEqual([{ url: 'http://ha.lan:8123', token: 'abc123' }]);

    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Connection Successful' })).not.toBeInTheDocument());
  });

  it('shows the error when the connection test fails', async () => {
    useSettings({ ha_enabled: true, ha_url: 'http://ha.lan:8123', ha_token: 'wrong' });
    server.use(
      http.post('/api/v1/smart-plugs/ha/test-connection', () =>
        HttpResponse.json({ success: false, message: null, error: 'Unauthorized' }),
      ),
    );
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.click(screen.getByRole('button', { name: 'Test Connection' }));

    expect(await screen.findByRole('heading', { name: 'Connection Failed' })).toBeInTheDocument();
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
  });
});

describe('SettingsPage Network tab: Prometheus metrics', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  it('enables the metrics endpoint, lists its metrics and saves a bearer token', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openNetworkTab(user);

    await user.click(rowSwitch('Enable Metrics Endpoint'));
    await waitFor(() => expect(lastSaved(saves, 'prometheus_enabled')).toBe(true));
    expect(await screen.findByText('bambuddy_printer_connected')).toBeInTheDocument();

    await user.type(fieldFor('Bearer Token (optional)'), 'scrape-secret');
    await waitFor(() => expect(lastSaved(saves, 'prometheus_token')).toBe('scrape-secret'));
  });
});
