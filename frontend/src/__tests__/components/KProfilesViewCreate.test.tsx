/**
 * KProfilesView: creating profiles (single nozzle, and dual-nozzle batch
 * to both extruders), copying a profile, notes, and importing profiles
 * from a JSON file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { KProfilesView } from '../../components/KProfilesView';

const profile = (overrides: Record<string, unknown>) => ({
  slot_id: 1, extruder_id: 0, nozzle_id: 'HH00-0.4', nozzle_diameter: '0.4', filament_id: 'GFA00',
  name: 'High Flow_Bambu PLA Basic', k_value: '0.025400', n_coef: '1.4', ams_id: 0, tray_id: 0, setting_id: 'PFUS1',
  ...overrides,
});

let calls: { method: string; path: string; body: unknown }[];
let nozzleCount: number;

beforeEach(() => {
  calls = [];
  nozzleCount = 1;
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  if (!('text' in File.prototype)) {
    Object.defineProperty(File.prototype, 'text', {
      configurable: true,
      value(this: File) {
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(this);
        });
      },
    });
  }
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
  };
  server.use(
    http.get('*/api/v1/printers/', () => HttpResponse.json([{ id: 5, name: 'Workshop', is_active: true, nozzle_count: nozzleCount, model: nozzleCount === 2 ? 'H2D' : 'X1C' }])),
    http.get('*/api/v1/printers/5/status', () => HttpResponse.json({ connected: true, state: 'IDLE' })),
    http.get('*/api/v1/printers/:id/kprofiles/', () =>
      HttpResponse.json({ profiles: [profile({}), profile({ slot_id: 2, extruder_id: 1, name: 'Standard_Bambu PETG HF', filament_id: 'GFG02', nozzle_id: 'HS00-0.4', setting_id: 'PFUS2' })], nozzle_diameter: '0.4' }),
    ),
    http.get('*/api/v1/printers/:id/kprofiles/notes', () => HttpResponse.json({ notes: { PFUS1: 'Tuned on the textured plate' } })),
    http.get('*/api/v1/cloud/builtin-filaments', () =>
      HttpResponse.json([{ filament_id: 'GFA00', name: 'Bambu PLA Basic' }, { filament_id: 'GFG02', name: 'Bambu PETG HF' }]),
    ),
    http.get('*/api/v1/cloud/filament-id-map', () => HttpResponse.json({})),
    http.post('*/api/v1/printers/:id/kprofiles/', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
    http.post('*/api/v1/printers/:id/kprofiles/batch', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
    http.put('*/api/v1/printers/:id/kprofiles/notes', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, message: 'ok' });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function modal(): HTMLElement {
  return screen.getByText(/^(Add K-Profile|Edit K-Profile)$/).closest('.fixed') as HTMLElement;
}

async function fillNewProfile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Add Profile/ }));
  await user.type(within(modal()).getByPlaceholderText('My PLA Profile'), 'Silk PLA');
  const k = within(modal()).getByPlaceholderText('0.020');
  await user.clear(k);
  await user.type(k, '0.031');
  await user.click(within(modal()).getByRole('button', { name: 'Select filament...' }));
  // The dropdown option (rendered last) — a profile card shares the text.
  const options = await screen.findAllByRole('button', { name: /Bambu PETG HF/ });
  await user.click(options[options.length - 1]);
}

describe('creating profiles', () => {
  it('creates a profile on a single-nozzle printer and saves its note', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await fillNewProfile(user);
    await user.click(within(modal()).getByRole('button', { name: 'High Flow' }));
    await user.click(await screen.findByRole('button', { name: 'Standard' }));
    await user.type(within(modal()).getByPlaceholderText('Add notes about this profile...'), 'Slow first layer');
    await user.click(within(modal()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/kprofiles/'))?.body).toMatchObject({
      name: 'Silk PLA', k_value: '0.031000', filament_id: 'GFG02', nozzle_id: 'HS00-0.4', slot_id: 0,
    }));
    expect(await screen.findByText('K-profile saved')).toBeInTheDocument();
    // New profiles store their note under a name-based key.
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      setting_id: 'name_Silk PLA_GFG02', note: 'Slow first layer',
    }));
  });

  it('saves to both extruders of a dual-nozzle printer in one batch', async () => {
    nozzleCount = 2;
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await fillNewProfile(user);
    // New dual-nozzle profiles default to both extruders.
    expect(within(modal()).getByText('Left').closest('label')!.querySelector('input')).toBeChecked();
    expect(within(modal()).getByText('Right').closest('label')!.querySelector('input')).toBeChecked();
    await user.click(within(modal()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/batch'))).toBeDefined());
    const batch = calls.find((c) => c.path.endsWith('/batch'))!.body as Array<{ extruder_id: number }>;
    expect(batch.map((p) => p.extruder_id).sort()).toEqual([0, 1]);
    expect(await screen.findByText('K-profile saved to 2 extruders')).toBeInTheDocument();
  });

  it('requires at least one extruder on a dual-nozzle printer', async () => {
    nozzleCount = 2;
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await fillNewProfile(user);
    for (const label of ['Left', 'Right']) {
      await user.click(within(modal()).getByText(label).closest('label')!.querySelector('input')!);
    }
    await user.click(within(modal()).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Please select at least one extruder')).toBeInTheDocument();
  });

  it('reports a failed batch save', async () => {
    nozzleCount = 2;
    server.use(http.post('*/api/v1/printers/:id/kprofiles/batch', () => HttpResponse.json({ detail: 'busy' }, { status: 500 })));
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await fillNewProfile(user);
    await user.click(within(modal()).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Failed to save K-profiles')).toBeInTheDocument();
  });
});

describe('copying, notes and import', () => {
  it('copies a profile into a new one and shows saved notes', async () => {
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    expect(screen.getByTitle('Tuned on the textured plate')).toHaveTextContent('Note: Tuned on the textured plate');
    await user.click(screen.getAllByTitle('Copy profile')[0]);

    // The copy opens the editor pre-filled, named as a copy.
    expect(await screen.findByText('Edit K-Profile')).toBeInTheDocument();
    expect(within(modal()).getByDisplayValue('High Flow_Bambu PLA Basic (Copy)')).toBeInTheDocument();
  });

  function importFile(content: string) {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== 'file') return;
      Object.defineProperty(this, 'files', { configurable: true, value: [new File([content], 'k.json')] });
      this.onchange?.({ target: this } as unknown as Event);
    });
  }

  it('imports valid profiles and skips incomplete ones', async () => {
    importFile(JSON.stringify({ profiles: [
      { name: 'Imported PLA', k_value: '0.02', filament_id: 'GFA00' },
      { name: 'Missing filament', k_value: '0.02' },
    ] }));
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await user.click(screen.getByRole('button', { name: /Import/ }));

    expect(await screen.findByText('Imported 1 of 2 profiles', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/kprofiles/'))?.body).toMatchObject({ name: 'Imported PLA', k_value: '0.020000', nozzle_id: 'HH00-0.4' });
  });

  it.each([
    [JSON.stringify({ wrong: true }), 'Invalid file format'],
    ['{not json', 'Failed to parse import file'],
  ])('rejects bad import files (%#)', async (content, toast) => {
    importFile(content);
    const user = userEvent.setup();
    render(<KProfilesView />);
    await screen.findByText('High Flow_Bambu PLA Basic');

    await user.click(screen.getByRole('button', { name: /Import/ }));

    expect(await screen.findByText(toast)).toBeInTheDocument();
  });
});
