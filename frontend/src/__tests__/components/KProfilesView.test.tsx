/**
 * Tests for KProfilesView: empty and offline states, the profile list
 * (truncated K values, search), editing, single and bulk delete, and export.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { KProfilesView } from '../../components/KProfilesView';

type Captured = { method: string; path: string; body: Record<string, unknown> | null };

const profile = (overrides: Record<string, unknown>) => ({
  slot_id: 1,
  extruder_id: 0,
  nozzle_id: 'HH00-0.4',
  nozzle_diameter: '0.4',
  filament_id: 'GFA00',
  name: 'High Flow_Bambu PLA Basic',
  k_value: '0.025400',
  n_coef: '1.4',
  ams_id: 0,
  tray_id: 0,
  setting_id: null,
  ...overrides,
});

let captured: Captured[];
let printers: Record<string, unknown>[];
let profiles: Record<string, unknown>[];
let kprofilesError: string | null;

async function record(request: Request) {
  const text = await request.text();
  captured.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
}

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  captured = [];
  kprofilesError = null;
  printers = [{ id: 5, name: 'Workshop X1C', is_active: true, nozzle_count: 1, model: 'X1C' }];
  profiles = [
    profile({ slot_id: 1, name: 'High Flow_Bambu PLA Basic', k_value: '0.025400', filament_id: 'GFA00' }),
    profile({ slot_id: 2, name: 'Standard_Bambu PETG HF', k_value: '0.041990', filament_id: 'GFG02', nozzle_id: 'HS00-0.4' }),
  ];
  server.use(
    http.get('*/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('*/api/v1/printers/:id/kprofiles/', () =>
      kprofilesError
        ? HttpResponse.json({ detail: kprofilesError }, { status: 503 })
        : HttpResponse.json({ profiles, nozzle_diameter: '0.4' }),
    ),
    http.get('*/api/v1/printers/:id/kprofiles/notes', () => HttpResponse.json({ notes: {} })),
    http.get('*/api/v1/cloud/builtin-filaments', () =>
      HttpResponse.json([
        { filament_id: 'GFA00', name: 'Bambu PLA Basic' },
        { filament_id: 'GFG02', name: 'Bambu PETG HF' },
      ]),
    ),
    http.get('*/api/v1/cloud/filament-id-map', () => HttpResponse.json({})),
    http.post('*/api/v1/printers/:id/kprofiles/', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
    http.delete('*/api/v1/printers/:id/kprofiles/', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
  );
});

describe('KProfilesView — empty states', () => {
  it('asks the user to add a printer when there are none', async () => {
    printers = [];
    render(<KProfilesView />);
    expect(await screen.findByText('No Printers Configured')).toBeInTheDocument();
  });

  it('explains that no printer is connected', async () => {
    printers = [{ id: 5, name: 'Offline X1C', is_active: false, nozzle_count: 1 }];
    render(<KProfilesView />);
    expect(await screen.findByText('No Active Printers')).toBeInTheDocument();
  });

  it('shows the offline state when the printer is not connected', async () => {
    kprofilesError = 'Printer not connected';
    render(<KProfilesView />);
    expect(await screen.findByText('Printer Offline')).toBeInTheDocument();
  });

  it('offers to create the first profile when the printer has none', async () => {
    profiles = [];
    render(<KProfilesView />);
    // The view refetches shortly after mount, so wait for the settled render.
    await waitFor(() => {
      expect(screen.getByText('No K-Profiles')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Create First Profile/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled();
    });
  });
});

describe('KProfilesView — profile list', () => {
  it('lists profiles for the first active printer with truncated K values', async () => {
    render(<KProfilesView />);
    expect(await screen.findByText('High Flow_Bambu PLA Basic')).toBeInTheDocument();
    expect(screen.getByText('Standard_Bambu PETG HF')).toBeInTheDocument();
    expect(screen.getByText('0.025')).toBeInTheDocument();
    expect(screen.getByText('0.041')).toBeInTheDocument();
  });

  it('filters by name or filament id', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');
    await user.type(screen.getByPlaceholderText('Search by name or filament...'), 'gfg02');
    await waitFor(() => expect(screen.queryByText('High Flow_Bambu PLA Basic')).not.toBeInTheDocument());
    expect(screen.getByText('Standard_Bambu PETG HF')).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Search by name or filament...'));
    await user.type(screen.getByPlaceholderText('Search by name or filament...'), 'nothing-matches');
    expect(await screen.findByText('No Matching Profiles')).toBeInTheDocument();
  });
});

describe('KProfilesView — editing', () => {
  it('saves an edited K value with six decimals and the existing slot', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await user.click(await screen.findByText('High Flow_Bambu PLA Basic'));
    expect(await screen.findByText('Edit K-Profile')).toBeInTheDocument();

    const kInput = screen.getByPlaceholderText('0.020');
    await user.clear(kInput);
    await user.type(kInput, '0.031');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(captured.find((c) => c.method === 'POST')).toBeDefined());
    expect(captured.find((c) => c.method === 'POST')).toMatchObject({
      path: '/api/v1/printers/5/kprofiles/',
      body: {
        name: 'High Flow_Bambu PLA Basic',
        k_value: '0.031000',
        filament_id: 'GFA00',
        nozzle_id: 'HH00-0.4',
        nozzle_diameter: '0.4',
        extruder_id: 0,
        slot_id: 1,
      },
    });
  });

  it('rejects non-numeric K value input', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await user.click(await screen.findByText('High Flow_Bambu PLA Basic'));
    const kInput = await screen.findByPlaceholderText('0.020');
    await user.clear(kInput);
    await user.type(kInput, '0.0a2');
    expect(kInput).toHaveValue('0.02');
  });

  it('deletes a profile after confirmation', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await user.click(await screen.findByText('High Flow_Bambu PLA Basic'));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    const message = await screen.findByText(/Are you sure you want to delete "High Flow_Bambu PLA Basic"/);
    const dialog = message.closest('div')!.parentElement!;
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));

    await waitFor(() => expect(captured.find((c) => c.method === 'DELETE')).toBeDefined());
    expect(captured.find((c) => c.method === 'DELETE')?.body).toMatchObject({
      slot_id: 1,
      extruder_id: 0,
      nozzle_id: 'HH00-0.4',
      filament_id: 'GFA00',
    });
  });
});

describe('KProfilesView — bulk actions', () => {
  it('selects all visible profiles and deletes them', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');
    await user.click(screen.getByRole('button', { name: /^Select$/ }));
    await user.click(screen.getByRole('button', { name: /Select All/ }));
    await user.click(screen.getByRole('button', { name: /Delete \(2\)/ }));

    const confirm = await screen.findAllByRole('button', { name: /^Delete$/ });
    await user.click(confirm[confirm.length - 1]);

    await waitFor(() => expect(captured.filter((c) => c.method === 'DELETE')).toHaveLength(2), { timeout: 3000 });
    expect(captured.filter((c) => c.method === 'DELETE').map((c) => c.body?.slot_id).sort()).toEqual([1, 2]);
  });

  it('exports the current profiles as a JSON download', async () => {
    const createObjectURL = vi.fn(() => 'blob:kprofiles');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');
    await user.click(screen.getByRole('button', { name: /Export/ }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalled();
    expect(await screen.findByText('Exported 2 profiles')).toBeInTheDocument();
    clickSpy.mockRestore();
  });
});
