/**
 * LocationHASensorModal: binding a Home Assistant sensor to a storage
 * location — entity picking with seeded defaults, sibling auto-add, the
 * one-per-category overwrite, editing, deleting and validation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { LocationHASensorModal } from '../../components/LocationHASensorModal';
import type { LocationHASensor, StorageLocation } from '../../api/client';

const locations = [
  { id: 1, name: 'Dry box' },
  { id: 2, name: 'Shelf' },
] as StorageLocation[];

const entity = (id: string, deviceClass: string | null, extra: Record<string, unknown> = {}) => ({
  entity_id: id,
  friendly_name: `${id} name`,
  domain: id.split('.')[0],
  device_class: deviceClass,
  state: '21',
  unit_of_measurement: deviceClass === 'temperature' ? '°C' : '%',
  ...extra,
});

const entities = [
  entity('sensor.box_temperature', 'temperature'),
  entity('sensor.box_humidity', 'humidity'),
  entity('sensor.box_battery', 'battery'),
  entity('binary_sensor.leak', 'moisture'), // not a location category: hidden
  entity('binary_sensor.door_battery', 'battery', { state: null }),
];

interface Calls {
  created: Record<string, unknown>[];
  updated: [string, Record<string, unknown>][];
  deleted: string[];
}

function useApi({ haConfigured = true, existing = [] as Partial<LocationHASensor>[] } = {}) {
  const calls: Calls = { created: [], updated: [], deleted: [] };
  server.use(
    http.get('/api/v1/settings/', () =>
      HttpResponse.json(
        haConfigured ? { ha_enabled: true, ha_url: 'http://ha', ha_token: 't', location_sensor_alert_defaults: '' } : {},
      ),
    ),
    http.get('/api/v1/location-ha-sensors/entities', () => HttpResponse.json(entities)),
    http.get('/api/v1/location-ha-sensors/', () => HttpResponse.json(existing)),
    http.post('/api/v1/location-ha-sensors/', async ({ request }) => {
      calls.created.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: 50 });
    }),
    http.patch('/api/v1/location-ha-sensors/:id', async ({ params, request }) => {
      calls.updated.push([String(params.id), (await request.json()) as Record<string, unknown>]);
      return HttpResponse.json({});
    }),
    http.delete('/api/v1/location-ha-sensors/:id', ({ params }) => {
      calls.deleted.push(String(params.id));
      return HttpResponse.json({});
    }),
  );
  return calls;
}

async function pick(user: ReturnType<typeof userEvent.setup>, entityId: string) {
  await user.click(await screen.findByText(entityId, { exact: false, selector: 'div' }));
}

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReturnValue(null);
});

describe('adding a sensor', () => {
  it('offers to add the sibling sensors and adds the chosen ones', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={onClose} />);

    expect(await screen.findByText('sensor.box_temperature — 21 °C')).toBeInTheDocument();
    expect(screen.queryByText(/binary_sensor\.leak/)).not.toBeInTheDocument();
    await pick(user, 'sensor.box_temperature —');
    expect(screen.getByLabelText('Display name')).toHaveValue('sensor.box_temperature name');
    // Seeded temperature defaults (30 / 20).
    expect(screen.getAllByRole('spinbutton').map((i) => (i as HTMLInputElement).value)).toEqual(['30', '20']);

    await user.click(screen.getByRole('button', { name: /Save/ }));
    const dialog = (await screen.findByText('Add the other sensors too?')).closest('.fixed') as HTMLElement;
    await user.click(within(dialog).getByLabelText(/sensor\.box_battery/));
    await user.click(within(dialog).getByRole('button', { name: /Confirm/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.created.map((c) => c.entity_id)).toEqual(['sensor.box_temperature', 'sensor.box_humidity']);
    expect(calls.created[0]).toMatchObject({ location_id: 1, alert_above: 30, alert_below: 20, kind: 'numeric', unit: '°C' });
    expect(calls.created[1]).toMatchObject({ alert_above: 30, alert_below: 10 });
    expect(await screen.findByText('Also added: sensor.box_humidity')).toBeInTheDocument();
  });

  it('"only this one" saves just the picked sensor', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await pick(user, 'sensor.box_humidity —');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await user.click(await screen.findByRole('button', { name: 'Only this one' }));

    await waitFor(() => expect(calls.created.map((c) => c.entity_id)).toEqual(['sensor.box_humidity']));
    expect(await screen.findByText('Sensor added')).toBeInTheDocument();
  });

  it('replaces an existing sensor of the same category', async () => {
    const calls = useApi({
      existing: [{ id: 7, location_id: 1, device_class: 'temperature', name: 'Old probe', entity_id: 'sensor.old' }],
    });
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await pick(user, 'sensor.box_temperature —');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText(/already has a temperature sensor bound: Old probe/)).toBeInTheDocument();
    const dialog = screen.getByText('Replace existing sensor?').closest('.fixed') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.updated).toEqual([]);

    await user.click(screen.getByRole('button', { name: /Save/ }));
    const again = (await screen.findByText('Replace existing sensor?')).closest('.fixed') as HTMLElement;
    await user.click(within(again).getByRole('button', { name: /Confirm/ }));

    await waitFor(() => expect(calls.updated.map(([id]) => id)).toEqual(['7']));
    expect(calls.updated[0][1].entity_id).toBe('sensor.box_temperature');
  });

  it('saves directly when no sibling exists, with a notice', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await pick(user, 'binary_sensor.door_battery name');
    // Binary battery sensor: alert on a state, no thresholds.
    const [locationSelect, alertSelect] = Array.from(document.querySelectorAll('select'));
    await user.selectOptions(alertSelect, 'on');
    await user.click(screen.getByLabelText(/notification/));
    await user.selectOptions(locationSelect, '2');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toMatchObject({
      kind: 'binary', alert_state: 'on', alert_above: null, alert_below: null, notify_on_alert: true, location_id: 2,
    });
    expect(await screen.findByText(/No matching temperature, humidity, or battery sensors/)).toBeInTheDocument();
  });

  it('keeps a name the user typed when switching entity, and filters by search', async () => {
    useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await pick(user, 'sensor.box_temperature —');
    const name = screen.getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Box probe');
    await pick(user, 'sensor.box_humidity —');
    expect(name).toHaveValue('Box probe');

    await user.type(screen.getByPlaceholderText('Search entities...'), 'battery');
    // The selected entity stays pinned at the top.
    expect(screen.getByText('sensor.box_humidity name')).toBeInTheDocument();
    expect(screen.queryByText('sensor.box_temperature name')).not.toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Search entities...'));
    await user.type(screen.getByPlaceholderText('Search entities...'), 'zzz');
    expect(screen.getByText('sensor.box_humidity name')).toBeInTheDocument();
  });

  it('validates before saving', async () => {
    useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await screen.findByText('sensor.box_temperature name');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(screen.getByText('Pick a Home Assistant entity')).toBeInTheDocument();

    await pick(user, 'sensor.box_temperature —');
    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(screen.getByText('Enter a display name')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Display name'), 'Probe');
    await user.click(screen.getByLabelText(/notification/));
    for (const input of screen.getAllByRole('spinbutton')) await user.clear(input);
    // Notify is now disabled but still checked → alert condition required.
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(screen.getByText('Set an alert condition first')).toBeInTheDocument();
  });

  it('requires a storage location', async () => {
    useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={[]} onClose={vi.fn()} />);

    await pick(user, 'sensor.box_temperature —');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(screen.getByText('Pick a storage location')).toBeInTheDocument();
  });

  it('warns when Home Assistant is not configured', async () => {
    useApi({ haConfigured: false });
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    expect(await screen.findByText(/Home Assistant is not configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(screen.getByPlaceholderText('Search entities...')).toBeDisabled();
  });

  it('shows entity loading errors and create errors', async () => {
    useApi();
    server.use(
      http.post('/api/v1/location-ha-sensors/', () => HttpResponse.json({ detail: 'Entity already bound' }, { status: 409 })),
    );
    const user = userEvent.setup();
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    await pick(user, 'binary_sensor.door_battery name');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Entity already bound')).toBeInTheDocument();
  });

  it('shows the error when Home Assistant entities fail to load', async () => {
    useApi();
    server.use(http.get('/api/v1/location-ha-sensors/entities', () => HttpResponse.json({ detail: 'HA unreachable' }, { status: 502 })));
    render(<LocationHASensorModal locations={locations} onClose={vi.fn()} />);

    expect(await screen.findByText('HA unreachable')).toBeInTheDocument();
  });
});

describe('editing a sensor', () => {
  const bound = {
    id: 9,
    location_id: 2,
    entity_id: 'sensor.gone',
    kind: 'numeric',
    device_class: 'battery',
    unit: '%',
    name: 'Old battery',
    alert_state: null,
    alert_above: null,
    alert_below: 15,
    notify_on_alert: true,
    show_on_card: false,
  } as unknown as LocationHASensor;

  it('updates the existing binding', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationHASensorModal sensor={bound} locations={locations} onClose={onClose} />);

    expect(screen.getByText('Edit Home Assistant Sensor')).toBeInTheDocument();
    expect(screen.getByText('Shelf')).toBeInTheDocument();
    expect(await screen.findByText('Currently bound: sensor.gone')).toBeInTheDocument();
    const below = screen.getByRole('spinbutton');
    await user.clear(below);
    await user.type(below, '20');
    await user.click(screen.getByLabelText('Show on filament card'));
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.updated).toEqual([
      ['9', expect.objectContaining({ alert_below: 20, alert_above: null, show_on_card: true, notify_on_alert: true })],
    ]);
  });

  it('deletes the binding', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<LocationHASensorModal sensor={bound} locations={locations} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(calls.deleted).toEqual(['9']));
    expect(await screen.findByText('Sensor removed')).toBeInTheDocument();
  });

  it('shows an unknown location and closes on Escape', async () => {
    useApi();
    const onClose = vi.fn();
    render(<LocationHASensorModal sensor={{ ...bound, location_id: 99 }} locations={locations} onClose={onClose} />);

    expect(screen.getByText('Unknown location')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
