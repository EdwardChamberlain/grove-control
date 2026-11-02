/**
 * SettingsPage: the Notifications tab (provider tests, language, template
 * filter) and the Smart Plugs tab (energy summary, bulk on/off, Home Assistant
 * sensors).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
  notification_language: 'en',
  bed_cooled_threshold: 35,
  check_updates: false,
  check_printer_firmware: false,
};

function provider(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    provider_type: 'discord',
    enabled: true,
    config: {},
    on_print_start: false,
    on_print_complete: true,
    on_print_failed: false,
    on_print_stopped: false,
    on_print_progress: false,
    on_print_missing_spool_assignment: false,
    on_printer_offline: false,
    on_printer_error: false,
    on_filament_low: false,
    on_maintenance_due: false,
    ...extra,
  };
}

function template(id: number, name: string, titleTemplate: string) {
  return {
    id,
    event_type: name.toLowerCase().replace(/\s+/g, '_'),
    name,
    title_template: titleTemplate,
    body_template: '',
    is_default: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** Serves the settings page and records each autosaved patch. */
function useSettings(overrides: Record<string, unknown> = {}, handlers: Parameters<typeof server.use> = []) {
  const saves: Record<string, unknown>[] = [];
  // Overrides go first: the first matching handler wins.
  server.use(
    ...handlers,
    http.get('/api/v1/settings/', () => HttpResponse.json({ ...baseSettings, ...overrides })),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saves.push(body);
      return HttpResponse.json({ ...baseSettings, ...overrides, ...body });
    }),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C' }])),
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('/api/v1/notifications/', () => HttpResponse.json([])),
    http.get('/api/v1/notification-templates', () => HttpResponse.json([])),
    http.get('/api/v1/api-keys/', () => HttpResponse.json([])),
    http.get('/api/v1/virtual-printer/status', () => HttpResponse.json({ running: false })),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    http.get('/api/v1/external-links/', () => HttpResponse.json([])),
  );
  return saves;
}

function lastSaved(saves: Record<string, unknown>[], key: string) {
  const matching = saves.filter((body) => key in body);
  return matching.length ? matching[matching.length - 1][key] : undefined;
}

/** Click a settings tab button (not the mobile dropdown copy of its label). */
async function openTab(user: ReturnType<typeof userEvent.setup>, label: string, marker: string) {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
  const buttons = screen.getAllByText(label).filter((el) => el.tagName === 'BUTTON');
  await user.click(buttons[0] ?? screen.getAllByText(label)[0]);
  await screen.findByText(marker);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** The input or select on the same settings row as a label. */
function fieldFor(label: string): HTMLElement {
  let row: HTMLElement | null = screen.getByText(label).parentElement;
  for (let depth = 0; row && depth < 4; depth += 1) {
    const field = row.querySelector<HTMLElement>('input, select');
    if (field) return field;
    row = row.parentElement;
  }
  throw new Error(`no field on the row of ${label}`);
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('SettingsPage Notifications tab', () => {
  it('tests every provider and reports the pass and fail counts', async () => {
    let testedAll = 0;
    useSettings({}, [
      http.get('/api/v1/notifications/', () =>
        HttpResponse.json([provider(1, 'Ops Discord'), provider(2, 'Phone Push', { provider_type: 'ntfy' })]),
      ),
      http.post('/api/v1/notifications/test-all', () => {
        testedAll += 1;
        return HttpResponse.json({
          tested: 2,
          success: 1,
          failed: 1,
          results: [
            { provider_id: 1, provider_name: 'Ops Discord', provider_type: 'discord', success: true, message: 'sent' },
            { provider_id: 2, provider_name: 'Phone Push', provider_type: 'ntfy', success: false, message: 'timeout' },
          ],
        });
      }),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Notifications', 'Notification Language');

    await user.click(screen.getByRole('button', { name: 'Test All' }));

    expect(await screen.findByText('Test Results')).toBeInTheDocument();
    expect(screen.getByText('1 passed')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(await screen.findByText('1/2 providers succeeded')).toBeInTheDocument();
    expect(testedAll).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Test Results')).not.toBeInTheDocument());
  });

  it('reports success when every provider passes', async () => {
    useSettings({}, [
      http.get('/api/v1/notifications/', () => HttpResponse.json([provider(1, 'Ops Discord')])),
      http.post('/api/v1/notifications/test-all', () =>
        HttpResponse.json({
          tested: 1,
          success: 1,
          failed: 0,
          results: [{ provider_id: 1, provider_name: 'Ops Discord', provider_type: 'discord', success: true, message: 'sent' }],
        }),
      ),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Notifications', 'Notification Language');

    await user.click(screen.getByRole('button', { name: 'Test All' }));
    expect(await screen.findByText('All 1 providers tested successfully!')).toBeInTheDocument();
  });

  it('saves the notification language and the bed-cooled threshold', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Notifications', 'Notification Language');

    await user.click(screen.getByRole('combobox', { name: 'English' }));
    const choices = await screen.findAllByRole('option');
    await user.click(choices[1]);
    await waitFor(() => expect(lastSaved(saves, 'notification_language')).toEqual(expect.any(String)));
    expect(lastSaved(saves, 'notification_language')).not.toBe('en');

    fireEvent.change(fieldFor('Bed Cooled Threshold'), { target: { value: '40' } });
    await waitFor(() => expect(lastSaved(saves, 'bed_cooled_threshold')).toBe(40));
  });

  it('filters message templates and opens one for editing', async () => {
    useSettings({}, [
      http.get('/api/v1/notification-templates', () =>
        HttpResponse.json([
          template(1, 'Print complete', 'Done: {name}'),
          template(2, 'Print failed', 'Failed: {name}'),
        ]),
      ),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Notifications', 'Message Templates');

    const filter = screen.getByPlaceholderText('Filter templates…');
    await user.type(filter, 'zzz');
    expect(await screen.findByText('No templates match your filter.')).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'failed');
    expect(await screen.findByText('Print failed')).toBeInTheDocument();
    expect(screen.queryByText('Print complete')).not.toBeInTheDocument();

    await user.click(screen.getByText('Print failed'));
    expect(await screen.findByRole('heading', { name: /Print failed/ })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Failed: {name}')).toBeInTheDocument();
  });
});

describe('SettingsPage Smart Plugs tab', () => {
  const plug = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    plug_type: 'tasmota',
    ip_address: `10.0.0.${id}`,
    ha_entity_id: null,
    ha_power_entity: null,
    ha_energy_today_entity: null,
    ha_energy_total_entity: null,
    mqtt_topic: null,
    mqtt_multiplier: 1,
    mqtt_power_topic: null,
    mqtt_power_path: null,
    mqtt_power_multiplier: 1,
    mqtt_energy_topic: null,
    mqtt_energy_path: null,
    mqtt_energy_multiplier: 1,
    mqtt_state_topic: null,
    mqtt_state_path: null,
    printer_id: null,
    enabled: true,
    ...extra,
  });

  it('adds up the energy readings of reachable plugs', async () => {
    useSettings({}, [
      http.get('/api/v1/smart-plugs/', () => HttpResponse.json([plug(1, 'Printer A'), plug(2, 'Printer B')])),
      http.get('/api/v1/smart-plugs/:id/status', ({ params }) =>
        HttpResponse.json({
          state: 'on',
          reachable: Number(params.id) === 1,
          device_name: `Device ${params.id}`,
          energy: Number(params.id) === 1
            ? { power: 12.5, today: 0.4, yesterday: 0.2, total: 9.1 }
            : null,
        }),
      ),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Smart Plugs', 'Energy Summary');

    expect(await screen.findByText(/12\.5/)).toBeInTheDocument();
    expect(screen.getByText('1/2 plugs online')).toBeInTheDocument();
  });

  it('turns every enabled plug off after confirmation, skipping disabled ones', async () => {
    const controlled: { id: string; body: unknown }[] = [];
    useSettings({}, [
      http.get('/api/v1/smart-plugs/', () =>
        HttpResponse.json([plug(1, 'Printer A'), plug(2, 'Printer B'), plug(3, 'Spare', { enabled: false })]),
      ),
      http.post('/api/v1/smart-plugs/:id/control', async ({ request, params }) => {
        controlled.push({ id: String(params.id), body: await request.json() });
        return HttpResponse.json({ success: true, action: 'off' });
      }),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Smart Plugs', 'Printer A');

    await user.click(screen.getByRole('button', { name: 'All Off' }));
    expect(await screen.findByText('Turn All Plugs Off')).toBeInTheDocument();
    expect(screen.getByText(/all 2 enabled smart plugs/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn All Off' }));

    expect(await screen.findByText('All 2 plugs turned off')).toBeInTheDocument();
    expect(controlled.map((c) => c.id).sort()).toEqual(['1', '2']);
    expect(controlled[0].body).toEqual({ action: 'off' });
  });

  it('reports partial failure when a plug cannot be reached', async () => {
    useSettings({}, [
      http.get('/api/v1/smart-plugs/', () => HttpResponse.json([plug(1, 'Printer A'), plug(2, 'Printer B')])),
      http.post('/api/v1/smart-plugs/:id/control', ({ params }) =>
        Number(params.id) === 2
          ? HttpResponse.json({ detail: 'offline' }, { status: 503 })
          : HttpResponse.json({ success: true, action: 'on' }),
      ),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Smart Plugs', 'Printer A');

    await user.click(screen.getByRole('button', { name: 'All On' }));
    await user.click(await screen.findByRole('button', { name: 'Turn All On' }));

    expect(await screen.findByText('1 plugs turned on, 1 failed')).toBeInTheDocument();
  });

  it('lists Home Assistant sensors with their alert badges and opens one for editing', async () => {
    useSettings({}, [
      http.get('/api/v1/smart-plugs/', () => HttpResponse.json([plug(1, 'Printer A')])),
      http.get('/api/v1/ha-sensors/', () =>
        HttpResponse.json([
          {
            id: 9,
            printer_id: 1,
            name: 'Chamber door',
            entity_id: 'binary_sensor.chamber_door',
            kind: 'binary',
            device_class: 'door',
            unit: null,
            alert_state: 'on',
            alert_above: null,
            alert_below: null,
            block_print: true,
            notify_on_alert: false,
          },
        ]),
      ),
    ]);
    const user = userEvent.setup();
    await openTab(user, 'Smart Plugs', 'Printer A');

    expect(await screen.findByText('Chamber door')).toBeInTheDocument();
    expect(screen.getByText('binary_sensor.chamber_door')).toBeInTheDocument();
    expect(screen.getByText('X1 Carbon')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Chamber door')).toBeInTheDocument();
  });
});
