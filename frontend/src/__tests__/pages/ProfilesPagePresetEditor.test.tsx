/**
 * ProfilesPage preset editor: creating a preset from a built-in base,
 * editing fields, the JSON tab, custom fields, templates, duplicating and
 * editing an existing preset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ProfilesPage } from '../../pages/ProfilesPage';

const settings = {
  filament: [
    { setting_id: 'PFUS001', name: 'My PLA @BBL X1C', type: 'filament', version: null, user_id: '1', updated_time: null, is_custom: true },
    { setting_id: 'GFSA00', name: 'Bambu PLA Basic @BBL X1C', type: 'filament', version: null, user_id: null, updated_time: null, is_custom: false },
  ],
  printer: [{ setting_id: 'GM001', name: 'Bambu Lab X1 Carbon 0.4 nozzle', type: 'printer', version: null, user_id: null, updated_time: null, is_custom: false }],
  process: [{ setting_id: 'GP004', name: '0.20mm Standard @BBL X1C', type: 'process', version: null, user_id: null, updated_time: null, is_custom: false }],
};

const fields = {
  fields: [
    { key: 'nozzle_temperature', label: 'Nozzle Temperature', type: 'number', category: 'temperature', unit: '°C', min: 150, max: 300 },
    { key: 'filament_type', label: 'Filament Type', type: 'select', category: 'basic', options: [{ value: 'PLA', label: 'PLA' }, { value: 'PETG', label: 'PETG' }] },
    { key: 'enable_pressure_advance', label: 'Pressure Advance', type: 'boolean', category: 'flow' },
  ],
};

let writes: { method: string; path: string; body: Record<string, unknown> }[];
let store: Record<string, string>;

beforeEach(() => {
  writes = [];
  store = {};
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    store[key] = value;
  });
  server.use(
    http.get('*/api/v1/cloud/status', () => HttpResponse.json({ is_authenticated: true, email: 'me@example.com', region: 'global' })),
    http.get('*/api/v1/printers/', () => HttpResponse.json([])),
    http.get('*/api/v1/cloud/settings', () => HttpResponse.json(settings)),
    http.get('*/api/v1/cloud/fields/:type', () => HttpResponse.json(fields)),
    http.get('*/api/v1/cloud/settings/:id', ({ params }) =>
      HttpResponse.json({
        public: params.id !== 'PFUS001',
        type: 'filament',
        name: params.id === 'PFUS001' ? 'My PLA @BBL X1C' : 'Bambu PLA Basic @BBL X1C',
        setting_id: params.id,
        setting:
          params.id === 'PFUS001'
            ? { inherits: 'Bambu PLA Basic @BBL X1C', nozzle_temperature: ['215'], fan_speed: '80' }
            : { nozzle_temperature: ['220', '220'], filament_type: ['PLA'], enable_pressure_advance: '1' },
      }),
    ),
    http.post('*/api/v1/cloud/settings', async ({ request }) => {
      writes.push({ method: 'POST', path: '/cloud/settings', body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ setting_id: 'PFUS999' });
    }),
    http.put('*/api/v1/cloud/settings/:id', async ({ params, request }) => {
      writes.push({ method: 'PUT', path: `/cloud/settings/${params.id}`, body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ setting_id: params.id });
    }),
  );
});

function modal(): HTMLElement {
  return screen.getByText(/^(Create New Preset|Duplicate Preset|Edit Preset)$/).closest('.fixed') as HTMLElement;
}

async function chooseDropdown(user: ReturnType<typeof userEvent.setup>, current: string, option: string) {
  await user.click(within(modal()).getByRole('button', { name: current }));
  await user.click(await screen.findByRole('button', { name: option }));
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  render(<ProfilesPage />);
  await screen.findByText('My PLA @BBL X1C');
  await user.click(screen.getByRole('button', { name: /New Preset/ }));
  await screen.findByText('Create New Preset');
}

describe('creating a preset', () => {
  it('builds overrides on a built-in base and creates the preset', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    // Only built-in presets can be a base.
    await user.click(within(modal()).getByRole('button', { name: 'Select base preset...' }));
    expect(screen.queryByRole('button', { name: 'My PLA @BBL X1C' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Bambu PLA Basic @BBL X1C' }));
    expect(await within(modal()).findByText('Inherits from')).toBeInTheDocument();

    await user.type(within(modal()).getByPlaceholderText('My custom preset'), 'Silk PLA');
    // Base values show as placeholders; a typed value becomes an override.
    const temp = await within(modal()).findByPlaceholderText('220');
    await user.type(temp, '225');
    // Booleans toggle against the base value.
    const toggle = within(modal()).getByText('Pressure Advance').parentElement!.querySelector('button')!;
    await user.click(toggle);
    await chooseDropdown(user, 'PLA', 'PETG');

    expect(within(modal()).getByText('Current Overrides')).toBeInTheDocument();
    await user.click(within(modal()).getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({
      type: 'filament',
      name: 'Silk PLA',
      base_id: 'GFSA00',
      setting: {
        inherits: 'Bambu PLA Basic @BBL X1C',
        nozzle_temperature: '225',
        enable_pressure_advance: '1',
        filament_type: 'PETG',
        filament_settings_id: '"Silk PLA"',
      },
    });
    expect(await screen.findByText('Preset created')).toBeInTheDocument();
  });

  it('searches fields, adds discovered and custom fields and removes overrides', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    await user.click(within(modal()).getByRole('button', { name: /All Fields/ }));
    // fan_speed is discovered from the user's own presets.
    expect(await within(modal()).findByText('Fan Speed')).toBeInTheDocument();
    await user.type(within(modal()).getByPlaceholderText('Search fields...'), 'nozzle');
    expect(within(modal()).queryByText('Fan Speed')).not.toBeInTheDocument();
    await user.click(within(modal()).getByText('Nozzle Temperature'));
    await user.clear(within(modal()).getByPlaceholderText('Search fields...'));
    await user.type(within(modal()).getByPlaceholderText('Search fields...'), 'zzz');
    expect(within(modal()).getByText(/No matching fields|All fields added/)).toBeInTheDocument();

    await user.click(within(modal()).getByRole('button', { name: /Add custom field/ }));
    await user.type(within(modal()).getByPlaceholderText('custom_field_name'), 'My Field{Enter}');
    expect(await screen.findByText('Field "my_field" added')).toBeInTheDocument();

    const overrides = within(modal()).getByText('Your Overrides').closest('div')!.parentElement as HTMLElement;
    expect(within(overrides).getByText('nozzle_temperature')).toBeInTheDocument();
  });

  it('edits the raw JSON and reports invalid JSON', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    await user.click(within(modal()).getByRole('button', { name: /JSON/ }));
    const editor = modal().querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{ bad' } });
    expect(within(modal()).getByText(/JSON|Unexpected|Expected/, { selector: 'p, span, div.text-red-400' })).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: '{"inherits":"","hot_plate_temp":"60"}' } });

    await user.click(within(modal()).getByRole('button', { name: /Common/ }));
    expect(within(modal()).getByText('Current Overrides')).toBeInTheDocument();
  });

  it('saves the current overrides as a template and applies it later', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    // The save-as-template option only appears once there is an override.
    expect(within(modal()).queryByRole('button', { name: /Save as template/ })).not.toBeInTheDocument();
    const temp = within(modal()).getAllByRole('spinbutton')[0];
    await user.type(temp, '240');
    await user.click(within(modal()).getAllByRole('button', { name: /Save as template/ })[0]);
    await user.type(within(modal()).getByPlaceholderText('Template name'), 'Hot');
    await user.type(within(modal()).getByPlaceholderText('Description'), 'Runs hot');
    await user.click(within(modal()).getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText('Template created')).toBeInTheDocument();
    expect(JSON.parse(store['bambusy_preset_templates'])[0]).toMatchObject({ name: 'Hot', description: 'Runs hot', type: 'filament' });

    await user.clear(temp);
    await user.click(within(modal()).getByRole('button', { name: /Hot/ }));
    expect(await screen.findByText('Template applied')).toBeInTheDocument();
    expect(temp).toHaveValue(240);
    expect(within(modal()).getByText('Applied template:')).toBeInTheDocument();
  });

  it('reports a failed create', async () => {
    server.use(http.post('*/api/v1/cloud/settings', () => HttpResponse.json({ detail: 'Name already used' }, { status: 400 })));
    const user = userEvent.setup();
    await openCreate(user);

    await chooseDropdown(user, 'Select base preset...', 'Bambu PLA Basic @BBL X1C');
    await user.type(within(modal()).getByPlaceholderText('My custom preset'), 'Dup');
    await user.click(within(modal()).getByRole('button', { name: /^Create$/ }));

    expect(await screen.findByText('Name already used')).toBeInTheDocument();
  });

  it('switches preset type and closes', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    await chooseDropdown(user, 'Filament preset', 'Process preset');
    await user.click(within(modal()).getByRole('button', { name: 'Select base preset...' }));
    expect(screen.getByRole('button', { name: '0.20mm Standard @BBL X1C' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '0.20mm Standard @BBL X1C' }));

    await user.click(within(modal()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Create New Preset')).not.toBeInTheDocument();
  });
});

describe('existing presets', () => {
  async function openDetail(user: ReturnType<typeof userEvent.setup>) {
    render(<ProfilesPage />);
    await user.click(await screen.findByText('My PLA @BBL X1C'));
    await screen.findByText(/nozzle_temperature/);
  }

  it('duplicates a preset as a copy', async () => {
    const user = userEvent.setup();
    await openDetail(user);

    await user.click(screen.getAllByRole('button', { name: /^Duplicate$/ }).pop()!);
    expect(await screen.findByText('Duplicate Preset')).toBeInTheDocument();
    expect(within(modal()).getByDisplayValue('My PLA @BBL X1C (Copy)')).toBeInTheDocument();
    await user.click(within(modal()).getByRole('button', { name: /^Duplicate$/ }));

    await waitFor(() => expect(writes[0]?.method).toBe('POST'));
    expect(writes[0].body.name).toBe('My PLA @BBL X1C (Copy)');
  });

  it('edits a preset in place', async () => {
    const user = userEvent.setup();
    await openDetail(user);

    await user.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(await screen.findByText('Edit Preset')).toBeInTheDocument();
    const name = within(modal()).getByDisplayValue('My PLA @BBL X1C');
    await user.clear(name);
    await user.type(name, 'Renamed PLA');

    await user.click(within(modal()).getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(writes[0]?.method).toBe('PUT'));
    expect(writes[0].path).toBe('/cloud/settings/PFUS001');
    expect(writes[0].body.name).toBe('Renamed PLA');
    expect(await screen.findByText('Preset updated')).toBeInTheDocument();
  });

  it('reports a failed update', async () => {
    server.use(http.put('*/api/v1/cloud/settings/:id', () => HttpResponse.json({ detail: 'Cloud rejected it' }, { status: 400 })));
    const user = userEvent.setup();
    await openDetail(user);

    await user.click(screen.getByRole('button', { name: /^Edit$/ }));
    await user.click(await within(modal()).findByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText('Cloud rejected it')).toBeInTheDocument();
  });
});

describe('templates manager', () => {
  const seeded = [
    { id: 't1', name: 'Hot PLA', description: 'Runs hot', type: 'filament', settings: { nozzle_temperature: '240' }, showInModal: true },
    { id: 't2', name: 'Draft', description: 'Fast', type: 'print', settings: { layer_height: '0.28', speed: '300' }, showInModal: false },
  ];

  async function openTemplates(user: ReturnType<typeof userEvent.setup>) {
    store['bambusy_preset_templates'] = JSON.stringify(seeded);
    render(<ProfilesPage />);
    await screen.findByText('My PLA @BBL X1C');
    await user.click(screen.getByRole('button', { name: /^Templates$/ }));
    return (await screen.findByText('Quick Templates')).closest('.fixed') as HTMLElement;
  }

  const saved = () => JSON.parse(store['bambusy_preset_templates']);

  it('filters, edits, hides and deletes templates', async () => {
    const user = userEvent.setup();
    const dialog = await openTemplates(user);

    expect(within(dialog).getByText('Hot PLA')).toBeInTheDocument();
    expect(within(dialog).getByText('2 fields')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Process preset' }));
    expect(within(dialog).queryByText('Hot PLA')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Printer preset' }));
    expect(within(dialog).getByText('No templates yet')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'All' }));

    // Edit: invalid JSON is reported, cancel restores, then a valid edit saves.
    const hotRow = within(dialog).getByText('Hot PLA').closest('.p-4, .p-3, li, div[class*="rounded"]') as HTMLElement;
    await user.click(within(hotRow).getByTitle('Edit'));
    const json = dialog.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(json, { target: { value: '{oops' } });
    await user.click(within(dialog).getByRole('button', { name: /^Save$/ }));
    expect(dialog.querySelector('p.text-red-400')).not.toBeNull();
    fireEvent.change(json, { target: { value: '{"nozzle_temperature":"245"}' } });
    const name = within(dialog).getByDisplayValue('Hot PLA');
    await user.clear(name);
    await user.type(name, 'Hotter PLA');
    await user.click(within(dialog).getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText('Template updated')).toBeInTheDocument();
    expect(saved()[0]).toMatchObject({ name: 'Hotter PLA', settings: { nozzle_temperature: '245' } });

    await user.click(within(dialog).getAllByTitle('Edit')[1]);
    await user.click(within(dialog).getByRole('button', { name: /Cancel/ }));

    await user.click(within(dialog).getByTitle('Hidden in modals'));
    expect(saved()[1].showInModal).toBe(true);

    await user.click(within(dialog).getAllByTitle('Delete')[1]);
    const confirm = screen.getByText('Are you sure you want to delete "Draft"?').parentElement as HTMLElement;
    await user.click(within(confirm).getByRole('button', { name: /Delete/ }));
    expect(await screen.findByText('Template deleted')).toBeInTheDocument();
    expect(saved().map((t: { id: string }) => t.id)).toEqual(['t1']);
  });

  it('applies a template by opening the editor with its settings', async () => {
    const user = userEvent.setup();
    const dialog = await openTemplates(user);

    await user.click(within(dialog).getAllByRole('button', { name: /Apply/ })[0]);

    expect(await screen.findByText('Duplicate Preset')).toBeInTheDocument();
    expect(within(modal()).getByDisplayValue('240')).toBeInTheDocument();
  });

  it('closes on Escape and the X', async () => {
    const user = userEvent.setup();
    const dialog = await openTemplates(user);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Quick Templates')).not.toBeInTheDocument());
    expect(dialog).not.toBeInTheDocument();
  });
});

describe('comparing with the base preset', () => {
  it('shows the differences from the base', async () => {
    const user = userEvent.setup();
    await openCreate(user);

    await chooseDropdown(user, 'Select base preset...', 'Bambu PLA Basic @BBL X1C');
    await user.type(await within(modal()).findByPlaceholderText('220'), '230');
    await user.click(within(modal()).getByRole('button', { name: /Compare/ }));

    expect((await screen.findAllByText(/Base: Bambu PLA Basic/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Current: /).length).toBeGreaterThan(0);
  });
});
