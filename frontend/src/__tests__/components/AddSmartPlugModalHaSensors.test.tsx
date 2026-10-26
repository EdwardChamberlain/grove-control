/**
 * AddSmartPlugModal Home Assistant energy sensors: picking power, energy
 * today and lifetime energy sensors (search, none, clear) and saving them
 * with the plug.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AddSmartPlugModal } from '../../components/AddSmartPlugModal';

let created: Record<string, unknown> | null;

const sensor = (entity_id: string, friendly_name: string, unit: string, state: string) => ({ entity_id, friendly_name, unit_of_measurement: unit, state });

beforeEach(() => {
  created = null;
  server.use(
    http.get('*/api/v1/printers/', () => HttpResponse.json([{ id: 7, name: 'Workshop X1C', model: 'X1C' }])),
    http.get('*/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('*/api/v1/settings/', () => HttpResponse.json({ ha_enabled: true, ha_url: 'http://ha:8123', ha_token: 'tok' })),
    http.get('*/api/v1/smart-plugs/ha/entities', () =>
      HttpResponse.json([{ entity_id: 'switch.printer_plug', friendly_name: 'Printer Plug', state: 'on', domain: 'switch' }]),
    ),
    http.get('*/api/v1/smart-plugs/ha/sensors', () =>
      HttpResponse.json([
        sensor('sensor.plug_power', 'Plug Power', 'W', '120'),
        sensor('sensor.desk_power', 'Desk Power', 'kW', '0.2'),
        sensor('sensor.plug_today', 'Plug Energy Today', 'kWh', '1.5'),
        sensor('sensor.plug_total', 'Plug Energy Total', 'Wh', '45000'),
        sensor('sensor.temperature', 'Room Temperature', '°C', '21'),
      ]),
    ),
    http.post('*/api/v1/smart-plugs/', async ({ request }) => {
      created = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: 1 });
    }),
  );
});

const fieldInput = (label: string) => screen.getByText(label).parentElement!.querySelector('input') as HTMLInputElement;

async function openHa(user: ReturnType<typeof userEvent.setup>) {
  render(<AddSmartPlugModal onClose={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: /^HA$/ }));
  await user.type(screen.getByPlaceholderText('Living Room Plug'), 'Printer power');
  await user.click(fieldInput('Select Entity *'));
  await user.click(await screen.findByText('Printer Plug'));
}

describe('AddSmartPlugModal Home Assistant sensors', () => {
  it('saves the chosen power and energy sensors', async () => {
    const user = userEvent.setup();
    await openHa(user);

    // Power: only W / kW / mW sensors are offered, and search narrows them.
    await user.click(fieldInput('Power Sensor (W)'));
    expect(screen.queryByText(/Room Temperature/)).not.toBeInTheDocument();
    await user.type(fieldInput('Power Sensor (W)'), 'desk');
    expect(screen.queryByText(/^Plug Power/)).not.toBeInTheDocument();
    await user.clear(fieldInput('Power Sensor (W)'));
    await user.click(await screen.findByText(/^Plug Power/));
    expect(fieldInput('Power Sensor (W)')).toHaveValue('Plug Power (120 W)');

    await user.click(fieldInput('Energy Today (kWh)'));
    await user.click(await screen.findByText(/^Plug Energy Today/));
    await user.click(fieldInput('Total Energy (kWh)'));
    await user.type(fieldInput('Total Energy (kWh)'), 'total');
    await user.click(await screen.findByText(/^Plug Energy Total/));

    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({
      ha_entity_id: 'switch.printer_plug',
      ha_power_entity: 'sensor.plug_power',
      ha_energy_today_entity: 'sensor.plug_today',
      ha_energy_total_entity: 'sensor.plug_total',
    });
  });

  it('clears sensors with the X and with None', async () => {
    const user = userEvent.setup();
    await openHa(user);

    for (const label of ['Power Sensor (W)', 'Energy Today (kWh)', 'Total Energy (kWh)']) {
      await user.click(fieldInput(label));
      const options = await screen.findAllByRole('button', { name: /^Plug /i });
      await user.click(options[0]);
      // Clear with the X button next to the field.
      const clear = fieldInput(label).parentElement!.querySelector('button') as HTMLButtonElement;
      await user.click(clear);
      expect(fieldInput(label)).toHaveValue('');
      // Pick again, then choose None.
      await user.click(fieldInput(label));
      await user.click((await screen.findAllByRole('button', { name: /^Plug /i }))[0]);
      await user.click(fieldInput(label));
      await user.click(screen.getByRole('button', { name: 'None' }));
      expect(fieldInput(label)).toHaveValue('');
    }

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ ha_power_entity: null, ha_energy_today_entity: null, ha_energy_total_entity: null });
  });

  it('closes the sensor dropdowns on an outside click', async () => {
    const user = userEvent.setup();
    await openHa(user);

    for (const label of ['Power Sensor (W)', 'Energy Today (kWh)', 'Total Energy (kWh)']) {
      await user.click(fieldInput(label));
      expect(screen.getByRole('button', { name: 'None' })).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'None' })).not.toBeInTheDocument());
    }
  });
});
