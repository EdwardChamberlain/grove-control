/**
 * PrinterThermalControls: nozzle / bed / chamber temperature popovers
 * (presets and custom values), fans per printer model, dual-nozzle
 * extruder selection, nozzle rack cards, heater history, and the
 * read-only state when the printer is offline.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrinterThermalControls } from '../../components/printer/PrinterThermalControls';
import type { Printer, PrinterStatus } from '../../api/client';

const printer = (overrides: Partial<Printer> = {}) => ({ id: 1, name: 'X1', model: 'X1C', nozzle_count: 1, ...overrides }) as Printer;

const status = (overrides: Record<string, unknown> = {}) =>
  ({
    connected: true,
    state: 'IDLE',
    active_extruder: 0,
    cooling_fan_speed: 50,
    big_fan1_speed: 0,
    big_fan2_speed: 30,
    temperatures: { nozzle: 210.4, nozzle_target: 215, bed: 60, bed_target: 60, chamber: 35, nozzle_heating: true, bed_heating: false },
    supports_chamber_heater: true,
    nozzle_rack: [{ id: 0, nozzle_diameter: '0.4', nozzle_type: 'HS01', stat: 1, filament_id: 'GFA00', filament_color: 'FF0000FF', wear: 10 }],
    ...overrides,
  }) as unknown as PrinterStatus;

let calls: string[];

beforeEach(() => {
  calls = [];
  const record = (label: string) => ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    calls.push(`${label} ${url.search}`);
    return HttpResponse.json({ success: true, message: `${label} ok` });
  };
  server.use(
    http.post('/api/v1/printers/1/temperature/nozzle', record('nozzle')),
    http.post('/api/v1/printers/1/temperature/bed', record('bed')),
    http.post('/api/v1/printers/1/temperature/chamber', record('chamber')),
    http.post('/api/v1/printers/1/fan-speed', record('fan')),
    http.post('/api/v1/printers/1/select-extruder', record('extruder')),
    http.post('/api/v1/cloud/filament-info', () => HttpResponse.json({ GFA00: { name: 'Bambu PLA Basic', k: 0.02 } })),
    http.get('/api/v1/printers/1/heater-history', () => HttpResponse.json({ points: [] })),
  );
});

describe('single nozzle printer', () => {
  it('sets the nozzle from a preset and the bed from a custom value', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status()} />);

    expect(screen.getByText('210°C')).toBeInTheDocument();
    await user.click(screen.getByTestId('thermal-nozzle-control'));
    await user.click(await screen.findByRole('button', { name: '220 C' }));
    await waitFor(() => expect(calls[0]).toBe('nozzle ?target=220&nozzle=0'));
    expect(await screen.findByText('nozzle ok')).toBeInTheDocument();

    await user.click(screen.getByTestId('thermal-bed-control'));
    const custom = await screen.findByPlaceholderText('Custom');
    await user.type(custom, '75');
    await user.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(calls).toContain('bed ?target=75'));
  });

  it('sets the chamber when the printer has a chamber heater, and turns heaters off', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status()} />);

    await user.click(screen.getByTestId('thermal-chamber-control'));
    await user.click(await screen.findByRole('button', { name: 'Off' }));

    await waitFor(() => expect(calls).toContain('chamber ?target=0'));
  });

  it('shows the chamber read-only without a heater', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status({ supports_chamber_heater: false })} />);

    await user.click(screen.getByTestId('thermal-chamber-control'));

    expect(screen.queryByPlaceholderText('Custom')).not.toBeInTheDocument();
  });

  it('sets fan speeds, including the chamber fan on supported models', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status()} />);

    const fans = screen.getAllByText(/^\d+%$/).map((el) => el.parentElement as HTMLElement);
    expect(fans).toHaveLength(3);
    await user.click(fans[0]);
    await user.click(await screen.findByRole('button', { name: '75 %' }));
    await waitFor(() => expect(calls[0]).toBe('fan ?fan=part&speed=75'));

    await user.click(fans[2]);
    await user.click(await screen.findByRole('button', { name: 'Off' }));
    await waitFor(() => expect(calls).toContain('fan ?fan=chamber&speed=0'));
  });

  it('reports a failed command', async () => {
    server.use(http.post('/api/v1/printers/1/temperature/bed', () => HttpResponse.json({ detail: 'Printer busy' }, { status: 409 })));
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status()} />);

    await user.click(screen.getByTestId('thermal-bed-control'));
    await user.click(await screen.findByRole('button', { name: 'Off' }));

    expect(await screen.findByText('Printer busy')).toBeInTheDocument();
  });

  it('shows the nozzle details on hover and opens heater history', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status()} />);

    await user.hover(screen.getByText('210°C'));
    expect(await screen.findByText(/Hardened Steel/i)).toBeInTheDocument();
    expect(await screen.findByText(/Bambu PLA Basic/)).toBeInTheDocument();

    await user.click(screen.getAllByTitle('View heater history')[0]);
    expect(await screen.findByText('Heater History')).toBeInTheDocument();
  });

  it('is read-only while the printer is offline', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer()} status={status({ connected: false })} />);

    await user.click(screen.getByTestId('thermal-bed-control'));

    expect(screen.queryByPlaceholderText('Custom')).not.toBeInTheDocument();
  });

  it('renders nothing without temperatures', () => {
    render(<PrinterThermalControls printer={printer()} status={status({ temperatures: undefined })} />);

    expect(screen.queryByTestId('printer-thermal-controls')).not.toBeInTheDocument();
  });
});

describe('dual nozzle printer', () => {
  const dual = () =>
    status({
      active_extruder: 1,
      temperatures: { nozzle: 220, nozzle_target: 220, nozzle_2: 180, nozzle_2_target: 0, bed: 55, chamber: 30 },
      nozzle_rack: [
        { id: 0, nozzle_diameter: '0.4', nozzle_type: 'HH00', stat: 1, filament_id: '', wear: 0 },
        { id: 1, nozzle_diameter: '0.6', nozzle_type: 'HS05', stat: 1, filament_id: 'GFA00', filament_color: '00FF00FF', wear: 5 },
        { id: 2, nozzle_diameter: '0.2', nozzle_type: 'stainless', stat: 0, filament_id: '', wear: 0 },
        { id: 3, nozzle_diameter: '', nozzle_type: '', stat: 0, filament_id: '', wear: 0 },
      ],
    });

  it('sets each nozzle temperature separately', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer({ model: 'H2D', nozzle_count: 2 })} status={dual()} />);

    expect(screen.getByText('220° / 180°')).toBeInTheDocument();
    await user.click(screen.getByTestId('thermal-nozzle-control'));
    const [left] = await screen.findAllByPlaceholderText('Custom');
    await user.type(left, '230');
    await user.click(within(left.closest('form')!).getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(calls).toContain('nozzle ?target=230&nozzle=1'));

    await user.click(screen.getByTestId('thermal-nozzle-control'));
    const [, right] = await screen.findAllByPlaceholderText('Custom');
    await user.type(right, '190');
    fireEvent.submit(right.closest('form')!);
    await waitFor(() => expect(calls).toContain('nozzle ?target=190&nozzle=0'));
  });

  it('switches the active extruder when idle, but not while printing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PrinterThermalControls printer={printer({ model: 'H2D', nozzle_count: 2 })} status={dual()} />);

    const select = screen.getByTitle('Active: Left nozzle');
    await user.click(select);
    await user.click(await screen.findByRole('button', { name: 'Right' }));
    await waitFor(() => expect(calls).toContain('extruder ?extruder=0'));

    rerender(<PrinterThermalControls printer={printer({ model: 'H2D', nozzle_count: 2 })} status={{ ...dual(), state: 'RUNNING' } as PrinterStatus} />);
    expect(screen.getAllByRole('button').find((b) => /disabled while printing/i.test(b.getAttribute('title') ?? ''))).toBeDisabled();
  });

  it('shows the nozzle rack', async () => {
    const user = userEvent.setup();
    render(<PrinterThermalControls printer={printer({ model: 'H2C', nozzle_count: 2 })} status={dual()} />);

    const lr = screen.getByText(/^L 0\.6$/);
    await user.hover(lr);
    expect((await screen.findAllByText(/Tungsten Carbide|High Flow|Stainless Steel/i)).length).toBeGreaterThan(0);
  });
});

describe('exhaust fan models', () => {
  it('shows the left auxiliary and exhaust fans when present', () => {
    render(
      <PrinterThermalControls
        printer={printer({ model: 'P2S' })}
        status={status({ exhaust_fan_present: true, left_aux_fan_speed: 20, temperatures: { nozzle: 200, bed: 50 } })}
      />,
    );

    expect(screen.getAllByText(/^\d+%$/)).toHaveLength(4);
  });
});
