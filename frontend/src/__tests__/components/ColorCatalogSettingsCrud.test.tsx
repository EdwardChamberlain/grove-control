/**
 * ColorCatalogSettings against the API (MSW): search and manufacturer
 * filter, add, edit, delete, bulk delete, reset, the streamed sync from
 * FilamentColors.xyz, export and import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ColorCatalogSettings } from '../../components/ColorCatalogSettings';

const catalog = [
  { id: 1, manufacturer: 'Bambu Lab', color_name: 'Jade White', hex_color: '#FFFFFF', material: 'PLA Basic', extra_colors: null, effect_type: null, is_default: true },
  { id: 2, manufacturer: 'Bambu Lab', color_name: 'Black', hex_color: '#000000', material: 'PETG', extra_colors: null, effect_type: null, is_default: true },
  { id: 3, manufacturer: 'Polymaker', color_name: 'Galaxy', hex_color: '#223344', material: null, extra_colors: '#112233,#445566', effect_type: 'sparkle', is_default: false },
];

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  let nextId = 20;
  const record = async (request: Request) => {
    const text = await request.text();
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return body;
  };
  server.use(
    http.get('/api/v1/inventory/colors', () => HttpResponse.json(catalog)),
    http.post('/api/v1/inventory/colors', async ({ request }) => {
      const body = await record(request);
      if (body.color_name === 'Broken') return HttpResponse.json({}, { status: 500 });
      return HttpResponse.json({ id: nextId++, is_default: false, ...body });
    }),
    http.put('/api/v1/inventory/colors/:id', async ({ request, params }) =>
      HttpResponse.json({ id: Number(params.id), is_default: false, ...(await record(request)) }),
    ),
    http.delete('/api/v1/inventory/colors/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'deleted' });
    }),
    http.post('/api/v1/inventory/colors/bulk-delete', async ({ request }) => {
      const body = await record(request);
      return HttpResponse.json({ deleted: body.ids.length });
    }),
    http.post('/api/v1/inventory/colors/reset', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'ok' });
    }),
  );
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
});

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

async function ready() {
  render(<ColorCatalogSettings />);
  await screen.findByText('Galaxy');
}

describe('ColorCatalogSettings CRUD', () => {
  it('searches and filters by manufacturer', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(screen.getByPlaceholderText('Search colors...'), 'petg');
    expect(screen.queryByText('Galaxy')).not.toBeInTheDocument();
    expect(screen.getByText('Black')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 3 colors')).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Search colors...'));

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Polymaker' }));
    expect(screen.queryByText('Black')).not.toBeInTheDocument();
    expect(screen.getByText('Galaxy')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search colors...'), 'nothing');
    expect(screen.getByText('No colors match your search')).toBeInTheDocument();
  });

  it('adds a colour, requiring manufacturer and name', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    const form = screen.getByText('Add New Color').parentElement as HTMLElement;
    await user.click(within(form).getByRole('button', { name: /Add/ }));
    expect(await screen.findByText('Manufacturer, color name, and hex color are required')).toBeInTheDocument();

    await user.type(within(form).getByPlaceholderText('Manufacturer'), 'Sunlu');
    await user.type(within(form).getByPlaceholderText('Color Name'), 'Sky Blue');
    const hex = within(form).getByPlaceholderText('#FFFFFF');
    await user.clear(hex);
    await user.type(hex, '#87CEEB');
    await user.type(within(form).getByPlaceholderText('Material (optional)'), 'PLA+');
    await user.click(within(form).getByRole('button', { name: /Add/ }));

    expect(await screen.findByText('Color added')).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({
      manufacturer: 'Sunlu', color_name: 'Sky Blue', hex_color: '#87CEEB', material: 'PLA+', extra_colors: null, effect_type: null,
    });
    expect(screen.getByText('Sky Blue')).toBeInTheDocument();
  });

  it('edits a colour and can cancel', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(within(rowOf('Galaxy')).getAllByRole('button')[0]);
    const name = screen.getByDisplayValue('Galaxy');
    await user.clear(name);
    await user.type(name, 'Galaxy Black');
    await user.click(within(name.closest('tr')!).getAllByRole('button')[0]);

    expect(await screen.findByText('Color updated')).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT', path: '/api/v1/inventory/colors/3',
      body: { color_name: 'Galaxy Black', extra_colors: '#112233,#445566', effect_type: 'sparkle' },
    });

    await user.click(within(rowOf('Galaxy Black')).getAllByRole('button')[0]);
    await user.click(within(screen.getByDisplayValue('Galaxy Black').closest('tr')!).getAllByRole('button')[1]);
    expect(screen.getByText('Galaxy Black')).toBeInTheDocument();
  });

  it('deletes one and bulk deletes several', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(within(rowOf('Galaxy')).getAllByRole('button')[1]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Color deleted')).toBeInTheDocument();

    await user.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Delete Selected/ }));
    await user.click(screen.getAllByRole('button', { name: /Delete/ }).pop()!);
    expect(await screen.findByText('Deleted 2 colors')).toBeInTheDocument();
  });

  it('resets to defaults', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await user.click(screen.getAllByRole('button', { name: /Reset/ }).pop()!);

    expect(await screen.findByText('Color catalog reset to defaults')).toBeInTheDocument();
  });

  it.each([
    [[{ type: 'progress', total_fetched: 50, total_available: 100 }, { type: 'complete', added: 4, skipped: 96, total_fetched: 100 }], 'Added 4 new colors (96 already existed)'],
    [[{ type: 'complete', added: 0, skipped: 100, total_fetched: 100 }], 'Already up to date (100 colors checked)'],
    [[{ type: 'error', error: 'rate limited' }], 'Sync error: rate limited'],
  ])('syncs from FilamentColors.xyz (%#)', async (events, toast) => {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('') + 'data: {broken\n';
    server.use(http.post('/api/v1/inventory/colors/sync', () => new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } })));
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByTitle(/Sync from FilamentColors/));

    expect(await screen.findByText(toast)).toBeInTheDocument();
  });

  it('reports a sync that cannot start', async () => {
    server.use(http.post('/api/v1/inventory/colors/sync', () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByTitle(/Sync from FilamentColors/));

    expect(await screen.findByText('Failed to sync from FilamentColors.xyz')).toBeInTheDocument();
  });

  it('exports and imports', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(await screen.findByText('Exported 3 colors')).toBeInTheDocument();
    click.mockRestore();

    const file = new File(
      [JSON.stringify([
        { manufacturer: 'Sunlu', color_name: 'Mint', hex_color: '#AAFFCC', material: 'PLA' },
        { manufacturer: 'bambu lab', color_name: 'jade white', hex_color: '#FFFFFF', material: 'pla basic' },
        { manufacturer: 'Sunlu', color_name: '', hex_color: '#000000' },
        { manufacturer: 'Sunlu', color_name: 'Broken', hex_color: '#000000' },
      ])],
      'colors.json',
    );
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText('Imported 1 colors (3 skipped)')).toBeInTheDocument();

    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['{}'], 'x.json')] } });
    expect(await screen.findByText('Failed to import: invalid JSON format')).toBeInTheDocument();
  });

  it('reports failures', async () => {
    server.use(
      http.post('/api/v1/inventory/colors', () => HttpResponse.json({}, { status: 500 })),
      http.put('/api/v1/inventory/colors/:id', () => HttpResponse.json({}, { status: 500 })),
      http.delete('/api/v1/inventory/colors/:id', () => HttpResponse.json({}, { status: 500 })),
      http.post('/api/v1/inventory/colors/bulk-delete', () => HttpResponse.json({}, { status: 500 })),
      http.post('/api/v1/inventory/colors/reset', () => HttpResponse.json({}, { status: 500 })),
    );
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    const form = screen.getByText('Add New Color').parentElement as HTMLElement;
    await user.type(within(form).getByPlaceholderText('Manufacturer'), 'X');
    await user.type(within(form).getByPlaceholderText('Color Name'), 'Y');
    await user.click(within(form).getByRole('button', { name: /Add/ }));
    expect(await screen.findByText('Failed to add color')).toBeInTheDocument();
    await user.click(within(form).getAllByRole('button').pop()!);

    await user.click(within(rowOf('Galaxy')).getAllByRole('button')[0]);
    const editRow = screen.getByDisplayValue('Galaxy').closest('tr') as HTMLElement;
    await user.click(within(editRow).getAllByRole('button')[0]);
    expect(await screen.findByText('Failed to update color')).toBeInTheDocument();
    await user.click(within(editRow).getAllByRole('button')[1]);

    await user.click(within(rowOf('Galaxy')).getAllByRole('button')[1]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Failed to delete color')).toBeInTheDocument();

    await user.click(within(rowOf('Galaxy')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Delete Selected/ }));
    await user.click(screen.getAllByRole('button', { name: /Delete/ }).pop()!);
    expect(await screen.findByText('Failed to delete colors')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await user.click(screen.getAllByRole('button', { name: /Reset/ }).pop()!);
    await waitFor(() => expect(screen.getByText('Failed to reset catalog')).toBeInTheDocument());
  });

  it('reports a failed load', async () => {
    server.use(http.get('/api/v1/inventory/colors', () => HttpResponse.json({}, { status: 500 })));
    render(<ColorCatalogSettings />);

    expect(await screen.findByText('Failed to load color catalog')).toBeInTheDocument();
  });
});
