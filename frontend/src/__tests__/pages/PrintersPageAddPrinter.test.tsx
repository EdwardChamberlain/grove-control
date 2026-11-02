/**
 * AddPrinterModal (exported from PrintersPage): form submission payload,
 * the connection-check button, cancel/Escape, and subnet discovery results
 * (picking a printer, placeholder serials, already-added filtering, empty
 * and failed scans).
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { AddPrinterModal } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const passingDiagnostic = {
  printer_id: null,
  ip_address: '192.168.1.50',
  overall: 'ok',
  checks: [{ id: 'port_mqtt', status: 'pass', params: {} }],
};

interface Requests {
  diagnose: unknown[];
  scans: unknown[];
  scanStarts: number;
  discoveryStarts: number;
}

function setup({
  docker = true,
  discovered = [] as unknown[],
  scanRunning = false,
  scanError = null as string | null,
} = {}) {
  const requests: Requests = { diagnose: [], scans: [], scanStarts: 0, discoveryStarts: 0 };
  server.use(
    http.get('/api/v1/discovery/info', () =>
      HttpResponse.json({
        is_docker: docker,
        ssdp_running: false,
        scan_running: false,
        subnets: ['192.168.1.0/24'],
      }),
    ),
    http.post('/api/v1/discovery/scan', async ({ request }) => {
      requests.scanStarts += 1;
      const text = await request.text();
      requests.scans.push(text ? JSON.parse(text) : null);
      if (scanError) return HttpResponse.json({ detail: scanError }, { status: 500 });
      return HttpResponse.json({ running: true, scanned: 0, total: 254 });
    }),
    http.get('/api/v1/discovery/scan/status', () =>
      HttpResponse.json({ running: scanRunning, scanned: 254, total: 254 }),
    ),
    http.get('/api/v1/discovery/printers', () => HttpResponse.json(discovered)),
    http.post('/api/v1/discovery/start', () => {
      requests.discoveryStarts += 1;
      return HttpResponse.json({ running: true });
    }),
    http.post('/api/v1/printers/diagnostic', async ({ request }) => {
      const text = await request.text();
      requests.diagnose.push(text ? JSON.parse(text) : null);
      return HttpResponse.json(passingDiagnostic);
    }),
  );
  return requests;
}

function renderModal(overrides: { onAdd?: (data: unknown) => void; onClose?: () => void; existingSerials?: string[] } = {}) {
  const onAdd = overrides.onAdd ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(<AddPrinterModal onAdd={onAdd} onClose={onClose} existingSerials={overrides.existingSerials ?? []} />);
  return { onAdd, onClose };
}

describe('AddPrinterModal form', () => {
  it('sends the typed details to onAdd after the connection check passes', async () => {
    const requests = setup();
    const { onAdd } = renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText('My Printer'), 'Garage P1S');
    await user.type(screen.getByPlaceholderText('192.168.1.100 or printer.local'), '192.168.1.50');
    await user.type(screen.getByPlaceholderText('01P00A000000000'), '00W00A123456789');
    await user.type(screen.getByPlaceholderText('From printer settings'), '12345678');
    await user.click(screen.getByRole('combobox', { name: 'Select model...' }));
    await user.click(await screen.findByRole('option', { name: 'P1S' }));
    await user.type(screen.getByPlaceholderText('e.g., Workshop, Office, Basement'), 'Garage');
    await user.click(screen.getByRole('checkbox', { name: 'Auto-archive completed prints' }));
    await user.click(screen.getByRole('button', { name: 'Add Printer' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(requests.diagnose).toEqual([
      { ip_address: '192.168.1.50', serial_number: '00W00A123456789', access_code: '12345678' },
    ]);
    expect(onAdd).toHaveBeenCalledWith({
      name: 'Garage P1S',
      serial_number: '00W00A123456789',
      ip_address: '192.168.1.50',
      access_code: '12345678',
      model: 'P1S',
      location: 'Garage',
      auto_archive: false,
    });
  });

  it('keeps the Run diagnostic button disabled until an IP address is typed', async () => {
    setup();
    renderModal();
    const user = userEvent.setup();
    const runButton = screen.getByRole('button', { name: 'Run diagnostic' });
    expect(runButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('192.168.1.100 or printer.local'), '192.168.1.50');
    expect(runButton).toBeEnabled();

    await user.click(runButton);
    // The diagnostic modal opens alongside the form, so a second run button appears.
    expect(await screen.findByRole('heading', { name: /Connection diagnostic/ })).toBeInTheDocument();
  });

  it('closes through Cancel and through Escape', async () => {
    setup();
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the auto-archive box ticked by default', () => {
    setup();
    renderModal();
    expect(screen.getByRole('checkbox', { name: 'Auto-archive completed prints' })).toBeChecked();
  });
});

describe('AddPrinterModal discovery', () => {
  it('scans the chosen subnet and fills the form from the printer picked', async () => {
    const requests = setup({
      discovered: [{ serial: '01P00A111111111', name: 'Workshop P1P', ip_address: '192.168.1.77', model: 'C11', discovered_at: null }],
    });
    renderModal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));

    const found = await screen.findByText('Workshop P1P');
    expect(requests.scans).toEqual([{ subnet: '192.168.1.0/24', timeout: 1.0 }]);

    await user.click(found);

    expect(screen.getByPlaceholderText('My Printer')).toHaveValue('Workshop P1P');
    expect(screen.getByPlaceholderText('192.168.1.100 or printer.local')).toHaveValue('192.168.1.77');
    expect(screen.getByPlaceholderText('01P00A000000000')).toHaveValue('01P00A111111111');
    expect(screen.getByRole('combobox', { name: 'P1P' })).toBeInTheDocument();
    // Picking a printer clears the result list.
    expect(screen.queryByText('Workshop P1P')).not.toBeInTheDocument();
  });

  it('leaves the serial blank and flags it when the printer reports only a placeholder', async () => {
    setup({
      discovered: [{ serial: 'unknown-192.168.1.88', name: '', ip_address: '192.168.1.88', model: null, discovered_at: null }],
    });
    renderModal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));
    expect(await screen.findByText(/Serial required/)).toBeInTheDocument();

    await user.click(screen.getByText('unknown-192.168.1.88'));

    expect(screen.getByPlaceholderText('01P00A000000000')).toHaveValue('');
    expect(screen.getByPlaceholderText('192.168.1.100 or printer.local')).toHaveValue('192.168.1.88');
    // No name in the report, so the name field stays empty.
    expect(screen.getByPlaceholderText('My Printer')).toHaveValue('');
  });

  it('hides printers that are already added and says so when nothing is left', async () => {
    setup({
      discovered: [{ serial: '01P00A222222222', name: 'Already Here', ip_address: '192.168.1.90', model: 'C11', discovered_at: null }],
    });
    renderModal({ existingSerials: ['01P00A222222222'] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));

    expect(await screen.findByText('All discovered printers are already configured.')).toBeInTheDocument();
    expect(screen.queryByText('Already Here')).not.toBeInTheDocument();
  });

  it('reports when a finished scan finds no printers', async () => {
    setup({ discovered: [] });
    renderModal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));

    expect(await screen.findByText('No printers found in the specified subnet.')).toBeInTheDocument();
  });

  it('shows the error when the scan cannot start', async () => {
    setup({ scanError: 'Subnet scan already running' });
    renderModal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));

    expect(await screen.findByText('Subnet scan already running')).toBeInTheDocument();
    // The button is available again after a failed start.
    expect(screen.getByRole('button', { name: 'Scan Subnet for Printers' })).toBeEnabled();
  });

  it('sends the custom CIDR when the Custom subnet option is chosen', async () => {
    const requests = setup();
    renderModal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('combobox', { name: '192.168.1.0/24' }));
    await user.click(await screen.findByRole('option', { name: 'Custom subnet...' }));
    const customInput = screen.getByRole('textbox', { name: 'Custom subnet (CIDR)' });
    await user.type(customInput, '10.1.1.0/24');
    await user.click(await screen.findByRole('button', { name: 'Scan Subnet for Printers' }));

    await waitFor(() => expect(requests.scanStarts).toBe(1));
    expect(requests.scans).toEqual([{ subnet: '10.1.1.0/24', timeout: 1.0 }]);
    expect(localStorage.setItem).toHaveBeenCalledWith('bambuddy.discovery.customSubnet', '10.1.1.0/24');
  });
});
