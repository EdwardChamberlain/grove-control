/**
 * Tests for AddSmartPlugModal: per-type validation and payloads (Tasmota,
 * Home Assistant, MQTT, REST), connection tests, Tasmota discovery and edit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AddSmartPlugModal } from '../../components/AddSmartPlugModal';
import type { SmartPlug } from '../../api/client';

type Captured = { method: string; path: string; body: Record<string, unknown> | null };

let captured: Captured[];
let haEnabled: boolean;
let mqttBroker: string | null;

async function record(request: Request) {
  const text = await request.text();
  captured.push({
    method: request.method,
    path: new URL(request.url).pathname,
    body: text ? JSON.parse(text) : null,
  });
}

beforeEach(() => {
  captured = [];
  haEnabled = false;
  mqttBroker = null;
  server.use(
    http.get('*/api/v1/printers/', () =>
      HttpResponse.json([{ id: 7, name: 'Workshop X1C', model: 'X1C' }]),
    ),
    http.get('*/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('*/api/v1/settings/', () =>
      HttpResponse.json({
        ...(haEnabled ? { ha_enabled: true, ha_url: 'http://ha:8123', ha_token: 'tok' } : {}),
        ...(mqttBroker ? { mqtt_broker: mqttBroker } : {}),
      }),
    ),
    http.get('*/api/v1/smart-plugs/ha/entities', () =>
      HttpResponse.json([
        { entity_id: 'switch.printer_plug', friendly_name: 'Printer Plug', state: 'on', domain: 'switch' },
        { entity_id: 'switch.fan', friendly_name: 'Fan', state: 'off', domain: 'switch' },
      ]),
    ),
    http.get('*/api/v1/smart-plugs/ha/sensors', () => HttpResponse.json([])),
    http.post('*/api/v1/smart-plugs/', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ id: 1 });
    }),
    http.patch('*/api/v1/smart-plugs/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ id: 3 });
    }),
    http.post('*/api/v1/smart-plugs/test-connection', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, state: 'ON', device_name: 'Tasmota Plug 1' });
    }),
    http.post('*/api/v1/smart-plugs/rest/test-connection', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: false, error: 'Unreachable' });
    }),
    http.post('*/api/v1/smart-plugs/discover/scan', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ running: true });
    }),
    http.get('*/api/v1/smart-plugs/discover/status', () =>
      HttpResponse.json({ running: false, scanned: 254, total: 254 }),
    ),
    http.get('*/api/v1/smart-plugs/discover/devices', () =>
      HttpResponse.json([{ ip_address: '192.168.1.42', name: 'Garage Plug', module: 'Sonoff', state: 'ON' }]),
    ),
  );
});

const created = () => captured.find((c) => c.method === 'POST' && c.path === '/api/v1/smart-plugs/')?.body;

describe('AddSmartPlugModal — Tasmota', () => {
  it('requires a name and an IP address', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Living Room Plug'), 'Desk');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('IP address is required for Tasmota plugs')).toBeInTheDocument();
    expect(created()).toBeUndefined();
  });

  it('creates a Tasmota plug linked to a printer and closes', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={onClose} />);
    await user.type(await screen.findByPlaceholderText('Living Room Plug'), '  Desk plug  ');
    await user.type(screen.getByPlaceholderText('192.168.1.100'), '192.168.1.50');
    await user.type(screen.getByPlaceholderText('admin'), 'admin');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(created()).toMatchObject({
      name: 'Desk plug',
      plug_type: 'tasmota',
      ip_address: '192.168.1.50',
      username: 'admin',
      password: null,
      ha_entity_id: null,
      mqtt_power_topic: null,
      rest_on_url: null,
      controls_printer_power: true,
      show_on_printer_card: true,
    });
  });

  it('tests the connection and fills the name from the device', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    const testButton = await screen.findByRole('button', { name: /^Test$/ });
    expect(testButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('192.168.1.100'), '10.0.0.9');
    await user.click(testButton);

    expect(await screen.findByText('Connected!')).toBeInTheDocument();
    expect(screen.getByText(/Device: Tasmota Plug 1/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Living Room Plug')).toHaveValue('Tasmota Plug 1');
    expect(captured.find((c) => c.path === '/api/v1/smart-plugs/test-connection')?.body).toMatchObject({ ip_address: '10.0.0.9' });
  });

  it('discovers Tasmota devices and selecting one fills the form', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /Discover Tasmota Devices/ }));

    await user.click(await screen.findByText('Garage Plug'));
    expect(screen.getByPlaceholderText('192.168.1.100')).toHaveValue('192.168.1.42');
    expect(screen.getByPlaceholderText('Living Room Plug')).toHaveValue('Garage Plug');
    expect(captured.map((c) => c.path)).toContain('/api/v1/smart-plugs/discover/scan');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={onClose} />);
    await screen.findByText('Add Smart Plug');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AddSmartPlugModal — Home Assistant', () => {
  it('requires an entity, then saves the chosen entity', async () => {
    haEnabled = true;
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^HA$/ }));
    await user.type(screen.getByPlaceholderText('Living Room Plug'), 'Printer power');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('Entity is required for Home Assistant plugs')).toBeInTheDocument();

    // Open the entity dropdown and pick one.
    const search = screen.getByText('Select Entity *').parentElement!.querySelector('input')!;
    await user.click(search);
    await user.click(await screen.findByText('Printer Plug'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(created()).toBeDefined());
    expect(created()).toMatchObject({
      name: 'Printer power',
      plug_type: 'homeassistant',
      ha_entity_id: 'switch.printer_plug',
      ip_address: null,
    });
  });
});

describe('AddSmartPlugModal — MQTT', () => {
  it('explains that an MQTT broker must be configured first', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^MQTT$/ }));
    expect(await screen.findByText(/MQTT broker not configured/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('zigbee2mqtt/shelly-working-room')).not.toBeInTheDocument();
  });

  it('requires at least one topic and sends parsed multipliers', async () => {
    mqttBroker = 'mqtt.local';
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^MQTT$/ }));
    await user.type(screen.getByPlaceholderText('Living Room Plug'), 'Shelly');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(/At least one MQTT topic must be configured/)).toBeInTheDocument();

    await user.type(await screen.findByPlaceholderText('zigbee2mqtt/shelly-working-room'), 'shellies/plug1');
    await user.type(screen.getByPlaceholderText('power_l1'), 'power');
    const [powerMultiplier] = screen.getAllByPlaceholderText('1');
    await user.clear(powerMultiplier);
    await user.type(powerMultiplier, '0.5');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(created()).toBeDefined());
    expect(created()).toMatchObject({
      plug_type: 'mqtt',
      mqtt_power_topic: 'shellies/plug1',
      mqtt_power_path: 'power',
      mqtt_power_multiplier: 0.5,
      mqtt_energy_topic: null,
      ip_address: null,
    });
  });
});

describe('AddSmartPlugModal — REST', () => {
  it('requires an ON or OFF URL, then saves the REST config', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^REST$/ }));
    await user.type(screen.getByPlaceholderText('Living Room Plug'), 'openHAB plug');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('At least one URL (ON or OFF) is required for REST plugs')).toBeInTheDocument();

    const [onUrl] = screen.getAllByPlaceholderText('http://openhab:8080/rest/items/MyPlug');
    await user.type(onUrl, 'http://openhab/on');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(created()).toBeDefined());
    expect(created()).toMatchObject({
      plug_type: 'rest',
      rest_on_url: 'http://openhab/on',
      rest_off_url: null,
      rest_method: 'POST',
    });
  });

  it('shows the error when the REST connection test fails', async () => {
    const user = userEvent.setup();
    render(<AddSmartPlugModal onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^REST$/ }));
    const [onUrl] = screen.getAllByPlaceholderText('http://openhab:8080/rest/items/MyPlug');
    await user.type(onUrl, 'http://openhab/on');
    await user.click(screen.getByRole('button', { name: /Test Connection/ }));

    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(captured.find((c) => c.path === '/api/v1/smart-plugs/rest/test-connection')?.body).toMatchObject({
      url: 'http://openhab/on',
      method: 'POST',
    });
  });
});

describe('AddSmartPlugModal — editing', () => {
  it('prefills the plug, hides the type picker and saves with PATCH', async () => {
    const plug = {
      id: 3,
      name: 'Old name',
      plug_type: 'tasmota',
      ip_address: '192.168.1.60',
      printer_id: 7,
      controls_printer_power: false,
    } as unknown as SmartPlug;
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddSmartPlugModal plug={plug} onClose={onClose} />);

    expect(await screen.findByText('Edit Smart Plug')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^MQTT$/ })).not.toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText('Living Room Plug');
    expect(nameInput).toHaveValue('Old name');

    await user.clear(nameInput);
    await user.type(nameInput, 'New name');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = captured.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/api/v1/smart-plugs/3');
    expect(patch?.body).toMatchObject({ name: 'New name', ip_address: '192.168.1.60', printer_id: 7, controls_printer_power: false });
  });
});
