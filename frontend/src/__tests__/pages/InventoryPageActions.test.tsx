/**
 * InventoryPage: filtering, sorting, grouping identical spools, switching
 * views, single-spool actions (archive / delete / restore / reset usage)
 * and bulk actions on a selection.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import InventoryPageRouter from '../../pages/InventoryPage';

const spool = (id: number, overrides: Record<string, unknown>) => ({
  id, material: 'PLA', subtype: null, brand: 'Bambu', color_name: 'Red', rgba: 'FF0000FF',
  label_weight: 1000, core_weight: 250, core_weight_catalog_id: null, weight_used: 0,
  slicer_filament: null, slicer_filament_name: null, nozzle_temp_min: null, nozzle_temp_max: null,
  note: null, added_full: null, last_used: null, encode_time: null, tag_uid: null, tray_uuid: null,
  data_origin: 'manual', tag_type: null, archived_at: null, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', k_profiles: [], cost_per_kg: null, last_scale_weight: null,
  last_weighed_at: null, weight_locked: false, category: null, low_stock_threshold_pct: null,
  location_id: null, storage_location: null,
  ...overrides,
});

const spools = [
  spool(1, { material: 'PLA', brand: 'Bambu', color_name: 'Red', weight_used: 900, category: 'Prototype' }),
  spool(2, { material: 'PETG', brand: 'Polymaker', color_name: 'Blue', weight_used: 100 }),
  spool(3, { material: 'PLA', brand: 'Bambu', color_name: 'Red', weight_used: 0 }),
  spool(4, { material: 'PLA', brand: 'Bambu', color_name: 'Red', weight_used: 0 }),
  spool(5, { material: 'ABS', brand: 'Elegoo', color_name: 'Black', archived_at: '2026-02-01T00:00:00Z' }),
];

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  const record = (response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response);
    };
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ spoolman_enabled: false, low_stock_threshold: 20, currency: 'USD' })),
    http.get('/api/v1/inventory/spools', () => HttpResponse.json(spools)),
    http.get('/api/v1/inventory/assignments', () => HttpResponse.json([])),
    http.get('/api/v1/inventory/catalog', () => HttpResponse.json([])),
    http.get('/api/v1/inventory/locations', () => HttpResponse.json([])),
    http.get('/api/v1/spoolman/settings', () => HttpResponse.json({ spoolman_enabled: 'false' })),
    http.delete('/api/v1/inventory/spools/:id', record({ status: 'deleted' })),
    http.post('/api/v1/inventory/spools/:id/archive', record()),
    http.post('/api/v1/inventory/spools/:id/restore', record()),
    http.post('/api/v1/inventory/spools/:id/reset-consumed-counter', record()),
    http.post('/api/v1/inventory/spools/reset-consumed-counter-bulk', record({ reset: 2 })),
    http.post('/api/v1/inventory/spools/bulk-update', record({ updated: 2, not_found: [] })),
    http.post('/api/v1/inventory/spools/bulk-delete', record({ deleted: 2, not_found: [] })),
    http.post('/api/v1/inventory/spools/bulk-archive', record({ archived: 2, already_archived: [], not_found: [] })),
    http.post('/api/v1/inventory/spools/bulk-restore', record({ restored: 1, already_active: [], not_found: [] })),
  );
});

/** The bulk-action bar shown while spools are selected. */
const bulkBar = () => screen.getByText(/^\d+ selected$/).parentElement as HTMLElement;

const paths = () => calls.map((c) => `${c.method} ${c.path}`);
/** The ID cell of a spool's table row. */
const idCell = (id: number) => screen.queryByText(String(id), { selector: 'td span.font-medium' });
const rowOf = (id: number) => idCell(id)!.closest('tr') as HTMLElement;
const shown = (id: number) => idCell(id) !== null;

async function ready() {
  render(<InventoryPageRouter />);
  await screen.findByText('2', { selector: 'td span.font-medium' });
}

async function confirm(user: ReturnType<typeof userEvent.setup>, label: string | RegExp) {
  const buttons = await screen.findAllByRole('button', { name: label });
  await user.click(buttons[buttons.length - 1]);
}

describe('filters and views', () => {
  it('filters by usage and archive state and clears filters', async () => {
    const user = userEvent.setup();
    await ready();

    expect(screen.getAllByText(/^4 spools/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(shown(1)).toBe(false);
    expect(shown(3)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Used' }));
    expect(shown(3)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Low Stock' }));
    expect(shown(1)).toBe(true);
    expect(shown(2)).toBe(false);

    await user.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(shown(2)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('5', { selector: 'td span.font-medium' })).toBeInTheDocument();
    expect(shown(2)).toBe(false);
  });

  it('filters by material, brand and category', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /^Material$/ }));
    await user.click(await screen.findByRole('button', { name: 'PETG' }));
    expect(shown(1)).toBe(false);
    expect(shown(2)).toBe(true);
    await user.click(screen.getByRole('button', { name: /Clear filters/ }));

    await user.click(screen.getByRole('button', { name: /^Brand$/ }));
    await user.click(await screen.findByRole('button', { name: 'Bambu' }));
    expect(shown(2)).toBe(false);
    await user.click(screen.getByRole('button', { name: /Clear filters/ }));

    const category = screen.getAllByRole('combobox').find((c) => c.textContent?.includes('Category')) as HTMLElement;
    await user.click(category);
    await user.click(await screen.findByRole('option', { name: 'Prototype' }));
    expect(shown(1)).toBe(true);
    expect(shown(3)).toBe(false);
  });

  it('sorts by a column, groups identical spools and switches to cards', async () => {
    const user = userEvent.setup();
    await ready();

    const header = screen.getAllByRole('columnheader').find((h) => /Material/i.test(h.textContent ?? '')) as HTMLElement;
    await user.click(header);
    await user.click(header);

    // Grouping collapses the two unused identical red PLA spools into one row;
    // the used one (#1) stays on its own.
    await user.click(screen.getByTitle('Group'));
    const groupRow = (await screen.findByText('#3, #4')).closest('tr') as HTMLElement;
    expect(shown(1)).toBe(true);
    expect(shown(4)).toBe(false);
    await user.click(groupRow);
    expect(shown(4)).toBe(true);

    await user.click(screen.getByRole('button', { name: /Cards/ }));
    expect(screen.getByText('2 identical spools')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Table/ }));
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
  });
});

describe('single spool actions', () => {
  it('archives and deletes after confirming', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(within(rowOf(2)).getByTitle('Archive'));
    await confirm(user, 'Archive');
    await waitFor(() => expect(paths()).toContain('POST /api/v1/inventory/spools/2/archive'));
    expect(await screen.findByText('Spool archived')).toBeInTheDocument();

    await user.click(within(rowOf(2)).getByTitle('Delete'));
    await confirm(user, 'Delete');
    await waitFor(() => expect(paths()).toContain('DELETE /api/v1/inventory/spools/2'));
    expect(await screen.findByText('Spool deleted')).toBeInTheDocument();
  });

  it('resets the consumed counter and restores archived spools', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(within(rowOf(1)).getByTitle(/counter|consumed/i));
    await confirm(user, 'Reset counter');
    await waitFor(() => expect(paths()).toContain('POST /api/v1/inventory/spools/1/reset-consumed-counter'));
    expect(await screen.findByText('Counter reset')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await user.click(within(rowOf(5)).getByTitle('Restore'));
    await waitFor(() => expect(paths()).toContain('POST /api/v1/inventory/spools/5/restore'));
    expect(await screen.findByText('Spool restored')).toBeInTheDocument();
  });

  it('reports failed archive and delete', async () => {
    server.use(
      http.post('/api/v1/inventory/spools/:id/archive', () => HttpResponse.json({}, { status: 500 })),
      http.delete('/api/v1/inventory/spools/:id', () => HttpResponse.json({}, { status: 404 })),
    );
    const user = userEvent.setup();
    await ready();

    await user.click(within(rowOf(2)).getByTitle('Archive'));
    await confirm(user, 'Archive');
    expect(await screen.findByText('Failed to archive spool')).toBeInTheDocument();

    await user.click(within(rowOf(2)).getByTitle('Delete'));
    await confirm(user, 'Delete');
    expect(await screen.findByText(/not found|Failed to delete spool/i)).toBeInTheDocument();
  });
});

describe('bulk actions', () => {
  async function selectTwo(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(rowOf(1)).getByLabelText('Select row'));
    await user.click(within(rowOf(2)).getByLabelText('Select row'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  }

  it('archives, resets usage and deletes the selection', async () => {
    const user = userEvent.setup();
    await ready();

    await selectTwo(user);
    await user.click(within(bulkBar()).getByRole('button', { name: /^Archive$/ }));
    await confirm(user, /Archive/);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/bulk-archive'))?.body).toEqual({ ids: [1, 2] }));

    await selectTwo(user);
    await user.click(within(bulkBar()).getByRole('button', { name: /Reset usage/ }));
    await confirm(user, /Reset/);
    await waitFor(() => expect(paths()).toContain('POST /api/v1/inventory/spools/reset-consumed-counter-bulk'));

    await selectTwo(user);
    await user.click(within(bulkBar()).getByRole('button', { name: /^Delete$/ }));
    await confirm(user, /Delete/);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/bulk-delete'))?.body).toEqual({ ids: [1, 2] }));
    expect(await screen.findByText('2 spools deleted')).toBeInTheDocument();
  });

  it('bulk edits the selection', async () => {
    const user = userEvent.setup();
    await ready();

    await selectTwo(user);
    await user.click(within(bulkBar()).getByRole('button', { name: /^Edit$/ }));
    const noteRow = screen.getByText('Note', { selector: 'label' }).closest('div.flex.items-start') as HTMLElement;
    await user.type(within(noteRow).getByRole('textbox'), 'reboxed');
    await user.click(screen.getByRole('button', { name: /Apply to 2 spools/ }));

    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/bulk-update'))?.body).toEqual({ ids: [1, 2], update: { note: 'reboxed' } }));
    expect(await screen.findByText('2 spools updated')).toBeInTheDocument();
  });

  it('selects all visible rows and clears the selection', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByLabelText('Select all visible'));
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText('4 selected')).not.toBeInTheDocument();
  });

  it('restores archived spools in bulk', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await user.click(within(rowOf(5)).getByLabelText('Select row'));
    await user.click(within(bulkBar()).getByRole('button', { name: /^Restore$/ }));
    await confirm(user, /Restore/);

    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/bulk-restore'))?.body).toEqual({ ids: [5] }));
  });
});
