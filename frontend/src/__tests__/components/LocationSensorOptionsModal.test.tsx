/**
 * LocationSensorOptionsModal: seeding from server settings, saving only
 * changed server fields plus local preferences, and resetting every bound
 * sensor to the defaults.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { LocationSensorOptionsModal } from '../../components/LocationSensorOptionsModal';

const serverDefaults = JSON.stringify({
  temperature: { alertAbove: '28', alertBelow: '18', notifyOnAlert: true },
  humidity: { alertAbove: '40', alertBelow: '15', notifyOnAlert: false },
  battery: { alertAbove: '', alertBelow: '5', notifyOnAlert: false },
});

let store: Record<string, string>;

function useApi() {
  const calls = { settings: [] as Record<string, unknown>[], sensorPatches: [] as [string, unknown][] };
  server.use(
    http.get('/api/v1/settings/', () =>
      HttpResponse.json({ location_sensor_poll_interval: 300, location_sensor_alert_defaults: serverDefaults }),
    ),
    http.put('/api/v1/settings/', async ({ request }) => {
      calls.settings.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({});
    }),
    http.get('/api/v1/location-ha-sensors/', () =>
      HttpResponse.json([
        { id: 1, entity_id: 'sensor.box_temp', device_class: 'temperature' },
        { id: 2, entity_id: 'sensor.box_battery', device_class: 'battery' },
        { id: 3, entity_id: 'binary_sensor.leak', device_class: 'moisture' },
        { id: 4, entity_id: 'sensor.box_rh', device_class: 'humidity' },
      ]),
    ),
    http.get('/api/v1/location-ha-sensors/entities', () =>
      HttpResponse.json([{ entity_id: 'sensor.box_temp', friendly_name: 'Dry box temperature' }]),
    ),
    http.patch('/api/v1/location-ha-sensors/:id', async ({ params, request }) => {
      calls.sensorPatches.push([String(params.id), await request.json()]);
      return HttpResponse.json({});
    }),
  );
  return calls;
}

const CATEGORY_ORDER = ['temperature', 'humidity', 'battery'];

/** The settings block for one category (rendered in a fixed order). */
function section(category: string): HTMLElement {
  const blocks = document.querySelectorAll('form > .space-y-3 > .p-3');
  return blocks[CATEGORY_ORDER.indexOf(category)] as HTMLElement;
}

beforeEach(() => {
  store = {};
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    store[key] = value;
  });
});

describe('LocationSensorOptionsModal', () => {
  it('seeds from the server and saves only what changed', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={onClose} />);

    const poll = screen.getByLabelText('Update interval (seconds)');
    await waitFor(() => expect(poll).toHaveValue(300));
    const temperature = section('temperature');
    expect(within(temperature).getAllByRole('spinbutton')[0]).toHaveValue(28);

    // Clearing both thresholds disables the notify option.
    const [above, below] = within(temperature).getAllByRole('spinbutton');
    await user.clear(above);
    await user.clear(below);
    expect(within(temperature).getByLabelText(/notification/)).toBeDisabled();
    await user.type(above, '32');

    await user.click(within(section('battery')).getByLabelText('Show on filament card'));
    await user.click(screen.getByLabelText(/Colorize sensor values/));
    await user.click(screen.getByLabelText(/Colorize sensor values/));
    await user.selectOptions(screen.getByLabelText('Above threshold color'), 'orange');
    await user.selectOptions(screen.getByLabelText('Below threshold color'), 'blue');
    await user.selectOptions(screen.getByLabelText('Optimal value color'), 'pink');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.settings).toHaveLength(1);
    expect(calls.settings[0]).not.toHaveProperty('location_sensor_poll_interval');
    expect(JSON.parse(calls.settings[0].location_sensor_alert_defaults as string).temperature.alertAbove).toBe('32');
    expect(JSON.parse(store['bambuddy-location-sensor-show-on-card-defaults']).battery).toBe(false);
    expect(store['bambuddy-location-sensor-alert-above-color']).toBe('orange');
    expect(await screen.findByText('Options saved')).toBeInTheDocument();
  });

  it('clamps the poll interval to the minimum', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={vi.fn()} />);

    const poll = screen.getByLabelText('Update interval (seconds)');
    await waitFor(() => expect(poll).toHaveValue(300));
    await user.clear(poll);
    await user.tab();
    expect(poll).toHaveValue(120);
    await user.clear(poll);
    await user.type(poll, '5');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(calls.settings).toEqual([{ location_sensor_poll_interval: 60 }]));
  });

  it('reports a failed save without touching local preferences', async () => {
    useApi();
    server.use(http.put('/api/v1/settings/', () => HttpResponse.json({ detail: 'Admins only' }, { status: 403 })));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={onClose} />);

    const poll = screen.getByLabelText('Update interval (seconds)');
    await waitFor(() => expect(poll).toHaveValue(300));
    await user.clear(poll);
    await user.type(poll, '90');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Admins only')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(store['bambuddy-location-sensor-colorize-values']).toBeUndefined();
  });

  it('resets every bound location sensor to the defaults', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={onClose} />);

    await waitFor(() => expect(screen.getByLabelText('Update interval (seconds)')).toHaveValue(300));
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    const dialog = screen.getByText('Reset all existing location sensors?').closest('.fixed') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: /Reset/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patches = Object.fromEntries(calls.sensorPatches);
    expect(Object.keys(patches).sort()).toEqual(['1', '2', '4']); // moisture is not a location category
    expect(patches['1']).toEqual({ name: 'Dry box temperature', alert_above: 28, alert_below: 18, notify_on_alert: true, show_on_card: true });
    expect(patches['2']).toEqual({ alert_above: null, alert_below: 5, notify_on_alert: false, show_on_card: true });
    expect(await screen.findByText('Applied to 3 location sensors')).toBeInTheDocument();
  });

  it('reports a failed reset and can cancel it', async () => {
    useApi();
    server.use(http.get('/api/v1/location-ha-sensors/', () => HttpResponse.json({ detail: 'HA offline' }, { status: 502 })));
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Reset/ }));
    const first = screen.getByText('Reset all existing location sensors?').closest('.fixed') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Reset all existing location sensors?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    const dialog = screen.getByText('Reset all existing location sensors?').closest('.fixed') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: /Reset/ }));

    expect(await screen.findByText('HA offline')).toBeInTheDocument();
  });

  it('closes from the X, cancel and backdrop', async () => {
    useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<LocationSensorOptionsModal onClose={onClose} />);

    await user.click(screen.getByText('Location Sensor Options').parentElement!.parentElement!.querySelector('button')!);
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    await user.click(document.querySelector('.fixed.inset-0')!);

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
