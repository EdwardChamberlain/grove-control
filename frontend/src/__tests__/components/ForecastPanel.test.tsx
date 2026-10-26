/**
 * ForecastPanel: rate tiers (usage trend / estimate / no data), alerts,
 * filters and sorting, per-SKU settings and snoozing, the add-to-cart
 * modal, and the shopping list (status changes, receiving, CSV, clearing).
 *
 * Auth is disabled in these tests, so every permission applies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ForecastPanel } from '../../components/ForecastPanel';
import type { InventorySpool } from '../../api/client';

const base: InventorySpool = {
  id: 0, material: 'PLA', subtype: null, brand: null, color_name: null, rgba: 'FF0000FF',
  label_weight: 1000, core_weight: 250, core_weight_catalog_id: null, weight_used: 0,
  slicer_filament: null, slicer_filament_name: null, nozzle_temp_min: null, nozzle_temp_max: null,
  note: null, added_full: null, last_used: null, encode_time: null, tag_uid: null, tray_uuid: null,
  data_origin: 'manual', tag_type: null, archived_at: null, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', k_profiles: [], cost_per_kg: null, last_scale_weight: null,
  last_weighed_at: null, weight_locked: false, category: 'Active', low_stock_threshold_pct: null,
} as InventorySpool;

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

const spools: InventorySpool[] = [
  // PLA Red: nearly empty with heavy recent use → trend + alerts.
  { ...base, id: 1, material: 'PLA', brand: 'Polymaker', color_name: 'Red', weight_used: 900, created_at: daysAgo(60) },
  // PETG Black: no usage records, but weight used since creation → estimate.
  { ...base, id: 2, material: 'PETG', brand: 'Bambu', color_name: 'Black', weight_used: 300, created_at: daysAgo(30), rgba: '000000FF' },
  // ABS: brand new, nothing used → no data.
  { ...base, id: 3, material: 'ABS', brand: 'Bambu', color_name: 'White', weight_used: 0, created_at: daysAgo(1), rgba: 'FFFFFFFF' },
  // Archived spools are ignored.
  { ...base, id: 4, material: 'TPU', archived_at: daysAgo(2) },
];

const usage = [
  { id: 1, spool_id: 1, printer_id: 1, print_name: 'A', weight_used: 120, percent_used: 12, status: 'completed', cost: null, created_at: daysAgo(6) },
  { id: 2, spool_id: 1, printer_id: 1, print_name: 'B', weight_used: 150, percent_used: 15, status: 'completed', cost: null, created_at: daysAgo(4) },
  { id: 3, spool_id: 1, printer_id: 1, print_name: 'C', weight_used: 90, percent_used: 9, status: 'completed', cost: null, created_at: daysAgo(2) },
  { id: 4, spool_id: 1, printer_id: 1, print_name: 'D', weight_used: 40, percent_used: 4, status: 'completed', cost: null, created_at: daysAgo(2) },
];

let shoppingList: Record<string, unknown>[];
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  shoppingList = [];
  const record = async (request: Request) => {
    const text = await request.text();
    const url = new URL(request.url);
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, path: url.pathname + url.search, body });
    return body;
  };
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ forecast_global_lead_time_days: 7 })),
    http.put('/api/v1/settings/', async ({ request }) => HttpResponse.json(await record(request))),
    http.get('/api/v1/inventory/sku-settings', () =>
      HttpResponse.json([{ id: 1, material: 'PETG', subtype: null, brand: 'Bambu', color_name: 'Black', lead_time_days: 14, safety_margin_value: 5, safety_margin_unit: 'days', alerts_snoozed: false }]),
    ),
    http.post('/api/v1/inventory/sku-settings', async ({ request }) => HttpResponse.json({ id: 9, ...(await record(request)) })),
    http.get('/api/v1/inventory/usage', () => HttpResponse.json(usage)),
    http.get('/api/v1/inventory/shopping-list', () => HttpResponse.json(shoppingList)),
    http.post('/api/v1/inventory/shopping-list', async ({ request }) => HttpResponse.json({ id: 50, status: 'pending', ...(await record(request)) })),
    http.patch('/api/v1/inventory/shopping-list/:id/status', async ({ request }) => HttpResponse.json(await record(request))),
    http.delete('/api/v1/inventory/shopping-list/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'deleted' });
    }),
    http.delete('/api/v1/inventory/shopping-list', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ deleted: 2 });
    }),
    http.post('/api/v1/inventory/spools/bulk', async ({ request }) => HttpResponse.json([await record(request)])),
  );
});

/** The table row for a SKU, found by its "brand material colour" label. */
const rowFor = (label: string) =>
  screen.getAllByText(label, { selector: 'span' }).map((el) => el.closest('tr')).find(Boolean) as HTMLElement;

describe('forecast table', () => {
  it('shows each SKU with its rate tier and skips archived spools', async () => {
    render(<ForecastPanel spools={spools} />);

    expect(await screen.findByText('Trend')).toBeInTheDocument();
    expect(screen.getByText('Est.')).toBeInTheDocument();
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(screen.queryByText('TPU')).not.toBeInTheDocument();
  });

  it('raises alerts for SKUs that need reordering', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);

    await user.click(await screen.findByRole('button', { name: /^\d+ alerts?$/ }));

    expect(within(rowFor('Polymaker PLA Red')).getByLabelText(/Stock break risk|Reorder now/)).toBeInTheDocument();
  });

  it('filters by material and brand and sorts columns', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    const [materialSelect, brandSelect] = screen.getAllByRole('combobox');
    await user.click(materialSelect);
    await user.click(await screen.findByRole('option', { name: 'PETG' }));
    expect(screen.queryByText('Trend')).not.toBeInTheDocument();
    await user.click(materialSelect);
    await user.click(await screen.findByRole('option', { name: 'Material' }));

    await user.click(brandSelect);
    await user.click(await screen.findByRole('option', { name: 'Polymaker' }));
    expect(screen.queryByText('Est.')).not.toBeInTheDocument();
    await user.click(brandSelect);
    await user.click(await screen.findByRole('option', { name: 'Brand' }));

    // Sort by each sortable column, both directions.
    for (const header of ['Stock', 'Days Left', 'SKU']) {
      const th = screen.getAllByRole('columnheader').find((h) => h.textContent?.trim().startsWith(header));
      expect(th, header).toBeDefined();
      await user.click(th!);
      await user.click(th!);
    }
    expect(screen.getByText('Trend')).toBeInTheDocument();
  });

  it('saves the global lead time', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(screen.getByText('7d').parentElement!.querySelector('button')!);
    const input = screen.getByDisplayValue('7');
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', path: '/api/v1/settings/', body: { forecast_global_lead_time_days: 10 } }));
    expect(await screen.findByText('Global lead time saved')).toBeInTheDocument();
  });

  it('opens a row, shows its logistics and saves per-SKU settings', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(rowFor('Bambu PETG Black'));
    expect(await screen.findByText('Effective Lead Time')).toBeInTheDocument();
    expect(screen.getByText('14d')).toBeInTheDocument(); // max(global 7, SKU 14)
    expect(screen.getByText('Reorder Point')).toBeInTheDocument();

    // Lead time override: edit, cancel, edit again and save.
    const lead = screen.getByText('Lead Time Override').closest('div')!.parentElement as HTMLElement;
    await user.click(within(lead).getByRole('button'));
    await user.click(within(lead).getByRole('button', { name: 'Cancel' }));
    await user.click(within(lead).getByRole('button'));
    const input = within(lead).getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '21');
    await user.click(within(lead).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/inventory/sku-settings')?.body).toMatchObject({
      material: 'PETG', brand: 'Bambu', color_name: 'Black', lead_time_days: 21, safety_margin_value: 5, safety_margin_unit: 'days',
    }));
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();

    // Safety margin: switch the unit to grams and save.
    const margin = screen.getAllByText('Safety Margin')[0].closest('div')!.parentElement as HTMLElement;
    await user.click(within(margin).getByRole('button'));
    await user.click(within(margin).getByRole('button', { name: 'g' }));
    const marginInput = within(margin).getByRole('spinbutton');
    await user.clear(marginInput);
    await user.type(marginInput, '200');
    await user.click(within(margin).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/v1/inventory/sku-settings').at(-1)?.body).toMatchObject({
      safety_margin_value: 200, safety_margin_unit: 'g',
    }));

    await user.click(rowFor('Bambu PETG Black'));
    expect(screen.queryByText('Effective Lead Time')).not.toBeInTheDocument();
  });

  it('snoozes alerts for a SKU', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(screen.getAllByTitle('Mute alerts for this SKU')[0]);

    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/inventory/sku-settings')?.body).toMatchObject({ alerts_snoozed: true }));
  });

  it('shows the empty state without spools', async () => {
    render(<ForecastPanel spools={[]} />);

    expect(await screen.findByText(/No active spools found/)).toBeInTheDocument();
  });
});

describe('shopping list', () => {
  it('adds spools to the list by quantity or by duration', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(within(rowFor('Polymaker PLA Red')).getByTitle('Add to shopping list'));
    const modal = (await screen.findByText('Add to Shopping List')).closest('.fixed') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: 'By Duration' }));
    const days = within(modal).getByRole('spinbutton');
    await user.clear(days);
    await user.type(days, '60');
    expect(within(modal).getAllByText(/\d+ spools?/).length).toBeGreaterThan(0);
    await user.click(within(modal).getByRole('button', { name: 'By Quantity' }));
    const qty = within(modal).getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '3');
    await user.type(within(modal).getByPlaceholderText('e.g. for project X, urgent…'), 'for the farm');
    await user.click(within(modal).getByRole('button', { name: 'Add 3 spools' }));

    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/inventory/shopping-list')?.body).toMatchObject({
      material: 'PLA', brand: 'Polymaker', color_name: 'Red', quantity_spools: 3, note: 'for the farm',
    }));
    expect(await screen.findByText('Added to shopping list')).toBeInTheDocument();
  });

  it('warns when there is no usage to size a duration order', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(within(rowFor('Bambu ABS White')).getByTitle('Add to shopping list'));
    const modal = (await screen.findByText('Add to Shopping List')).closest('.fixed') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: 'By Duration' }));

    expect(within(modal).getByText('No usage data — quantity set to 1.')).toBeInTheDocument();
    await user.click(within(modal).getAllByRole('button')[0]);
    expect(screen.queryByText('Add to Shopping List')).not.toBeInTheDocument();
  });

  it('moves items through purchased and received, removes and clears them', async () => {
    shoppingList = [
      { id: 1, material: 'PLA', subtype: null, brand: 'Polymaker', color_name: 'Red', quantity_spools: 2, note: 'urgent', status: 'pending', purchased_at: null, added_at: daysAgo(1) },
      { id: 2, material: 'PETG', subtype: null, brand: 'Bambu', color_name: 'Black', quantity_spools: 1, note: null, status: 'purchased', purchased_at: daysAgo(1), added_at: daysAgo(3) },
    ];
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(screen.getByRole('button', { name: /Shopping List/ }));
    expect(await screen.findByText('urgent')).toBeInTheDocument();

    await user.click(screen.getByTitle('Mark as purchased'));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/api/v1/inventory/shopping-list/1/status' })));
    await user.click(screen.getByTitle('Reset to pending'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));

    // Receiving creates the spools in stock and removes the list item.
    // Only the purchased item can be received.
    const receive = screen.getAllByTitle(/Mark as received/) as HTMLButtonElement[];
    expect(receive.filter((b) => b.disabled)).toHaveLength(1);
    await user.click(receive.find((b) => !b.disabled)!);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/api/v1/inventory/spools/bulk'))).toBe(true));
    const bulk = calls.find((c) => c.path.startsWith('/api/v1/inventory/spools/bulk'))!;
    expect(JSON.stringify(bulk.body)).toContain('"category":"Stock"');

    await user.click(screen.getAllByTitle('Remove')[0]);
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE' && /shopping-list\/\d/.test(c.path)).length).toBeGreaterThanOrEqual(2));

    // The logistics view flags the item that will run out before it arrives.
    await user.click(screen.getByRole('button', { name: /^Logistics/ }));
    expect(screen.getAllByText(/Stock break in/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'List' }));

    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: /CSV/ }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: '/api/v1/inventory/shopping-list', body: null }));
  });

  it('shows an empty shopping list', async () => {
    const user = userEvent.setup();
    render(<ForecastPanel spools={spools} />);
    await screen.findByText('Trend');

    await user.click(screen.getByRole('button', { name: /Shopping List/ }));

    expect(await screen.findByText(/Shopping list is empty/)).toBeInTheDocument();
  });
});
