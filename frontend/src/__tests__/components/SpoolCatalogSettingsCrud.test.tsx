/**
 * SpoolCatalogSettings against the API (MSW): add, edit, delete, search,
 * bulk delete, reset, export and import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SpoolCatalogSettings } from '../../components/SpoolCatalogSettings';

const catalog = [
  { id: 1, name: 'Bambu Lab - Plastic', weight: 250, is_default: true },
  { id: 2, name: 'Bambu Lab - Cardboard', weight: 200, is_default: true },
  { id: 3, name: 'My Reusable Spool', weight: 180, is_default: false },
];

let calls: { method: string; path: string; body: unknown }[];

function useApi() {
  calls = [];
  let nextId = 10;
  const record = async (request: Request) => {
    const text = await request.text();
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return body;
  };
  server.use(
    http.get('/api/v1/inventory/catalog', () => HttpResponse.json(catalog)),
    http.post('/api/v1/inventory/catalog', async ({ request }) => {
      const body = await record(request);
      if (body.name === 'Broken') return HttpResponse.json({ detail: 'no' }, { status: 500 });
      return HttpResponse.json({ id: nextId++, is_default: false, ...body });
    }),
    http.put('/api/v1/inventory/catalog/:id', async ({ request, params }) =>
      HttpResponse.json({ id: Number(params.id), is_default: false, ...(await record(request)) }),
    ),
    http.delete('/api/v1/inventory/catalog/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'deleted' });
    }),
    http.post('/api/v1/inventory/catalog/bulk-delete', async ({ request }) => {
      const body = await record(request);
      return HttpResponse.json({ deleted: body.ids.length });
    }),
    http.post('/api/v1/inventory/catalog/reset', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'ok' });
    }),
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

beforeEach(() => {
  useApi();
  // jsdom's File has no text(); the component reads imports with it.
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

describe('SpoolCatalogSettings CRUD', () => {
  it('lists entries with their type and searches them', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);

    expect(await screen.findByText('My Reusable Spool')).toBeInTheDocument();
    expect(within(rowOf('My Reusable Spool')).getByText('Custom')).toBeInTheDocument();
    expect(within(rowOf('Bambu Lab - Plastic')).getByText('Default')).toBeInTheDocument();
    expect(within(rowOf('Bambu Lab - Plastic')).getByText('250g')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search catalog...'), 'cardboard');
    expect(screen.queryByText('My Reusable Spool')).not.toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Search catalog...'));
    await user.type(screen.getByPlaceholderText('Search catalog...'), 'nothing');
    expect(screen.getByText('No entries match your search')).toBeInTheDocument();
  });

  it('adds an entry, requiring name and weight', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    const form = screen.getByText('Add New Entry').parentElement as HTMLElement;
    await user.click(within(form).getByRole('button', { name: /Add/ }));
    expect(await screen.findByText('Name and weight are required')).toBeInTheDocument();

    await user.type(within(form).getByPlaceholderText('Name (e.g., Bambu Lab - Plastic)'), 'Sunlu - Plastic');
    await user.type(within(form).getByPlaceholderText('g'), '160');
    await user.click(within(form).getByRole('button', { name: /Add/ }));

    expect(await screen.findByText('Entry added')).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', path: '/api/v1/inventory/catalog', body: { name: 'Sunlu - Plastic', weight: 160 } });
    expect(screen.getByText('Sunlu - Plastic')).toBeInTheDocument();
  });

  it('edits an entry and can cancel an edit', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    const [edit] = within(rowOf('My Reusable Spool')).getAllByRole('button');
    await user.click(edit);
    const name = screen.getByDisplayValue('My Reusable Spool');
    await user.clear(name);
    await user.type(name, 'Reusable v2');
    const weight = screen.getByDisplayValue('180');
    await user.clear(weight);
    await user.type(weight, '175');
    await user.click(within(name.closest('tr')!).getAllByRole('button')[0]);

    expect(await screen.findByText('Entry updated')).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'PUT', path: '/api/v1/inventory/catalog/3', body: { name: 'Reusable v2', weight: 175 } });

    await user.click(within(rowOf('Reusable v2')).getAllByRole('button')[0]);
    await user.click(within(screen.getByDisplayValue('Reusable v2').closest('tr')!).getAllByRole('button')[1]);
    expect(screen.getByText('Reusable v2')).toBeInTheDocument();
  });

  it('deletes one entry after confirming', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    await user.click(within(rowOf('My Reusable Spool')).getAllByRole('button')[1]);
    expect(screen.getByText('Are you sure you want to delete "My Reusable Spool"?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Entry deleted')).toBeInTheDocument();
    expect(screen.queryByText('My Reusable Spool')).not.toBeInTheDocument();
  });

  it('bulk deletes selected entries', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    const [selectAll] = screen.getAllByRole('checkbox');
    await user.click(selectAll);
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await user.click(selectAll);
    await user.click(within(rowOf('My Reusable Spool')).getByRole('checkbox'));
    await user.click(within(rowOf('Bambu Lab - Cardboard')).getByRole('checkbox'));
    await user.click(within(rowOf('Bambu Lab - Cardboard')).getByRole('checkbox'));
    await user.click(within(rowOf('Bambu Lab - Cardboard')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Delete Selected/ }));
    await user.click(screen.getAllByRole('button', { name: /Delete/ }).pop()!);

    expect(await screen.findByText('Deleted 2 entries')).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({ ids: [3, 2] });
  });

  it('resets the catalog to defaults', async () => {
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    await user.click(screen.getByTitle('Reset to defaults'));
    await user.click(screen.getAllByRole('button', { name: /Reset/ }).pop()!);

    expect(await screen.findByText('Catalog reset to defaults')).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain('/api/v1/inventory/catalog/reset');
  });

  it('exports the catalog as JSON', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    await user.click(screen.getByTitle('Export catalog to JSON'));

    expect(click).toHaveBeenCalled();
    expect(await screen.findByText('Exported 3 entries')).toBeInTheDocument();
    click.mockRestore();
  });

  it('imports new entries and skips duplicates, invalid rows and failures', async () => {
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    const file = new File(
      [JSON.stringify([
        { name: 'New Spool', weight: 140 },
        { name: 'my reusable spool', weight: 1 },
        { name: 'No Weight' },
        { name: 'Broken', weight: 1 },
      ])],
      'catalog.json',
      { type: 'application/json' },
    );
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByText('Imported 1 entries (3 skipped)')).toBeInTheDocument();
    expect(screen.getByText('New Spool')).toBeInTheDocument();
  });

  it('rejects an import that is not a JSON list', async () => {
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['{"not":"a list"}'], 'x.json')] },
    });

    expect(await screen.findByText('Failed to import: invalid JSON format')).toBeInTheDocument();
  });

  it.each([
    ['load', () => server.use(http.get('/api/v1/inventory/catalog', () => HttpResponse.json({}, { status: 500 }))), 'Failed to load spool catalog'],
  ])('reports a failed %s', async (_, breakIt, message) => {
    breakIt();
    render(<SpoolCatalogSettings />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('reports failed add, update, delete, bulk delete and reset', async () => {
    server.use(
      http.post('/api/v1/inventory/catalog', () => HttpResponse.json({}, { status: 500 })),
      http.put('/api/v1/inventory/catalog/:id', () => HttpResponse.json({}, { status: 500 })),
      http.delete('/api/v1/inventory/catalog/:id', () => HttpResponse.json({}, { status: 500 })),
      http.post('/api/v1/inventory/catalog/bulk-delete', () => HttpResponse.json({}, { status: 500 })),
      http.post('/api/v1/inventory/catalog/reset', () => HttpResponse.json({}, { status: 500 })),
    );
    const user = userEvent.setup();
    render(<SpoolCatalogSettings />);
    await screen.findByText('My Reusable Spool');

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    const form = screen.getByText('Add New Entry').parentElement as HTMLElement;
    await user.type(within(form).getByPlaceholderText('Name (e.g., Bambu Lab - Plastic)'), 'X');
    await user.type(within(form).getByPlaceholderText('g'), '1');
    await user.click(within(form).getByRole('button', { name: /Add/ }));
    expect(await screen.findByText('Failed to add entry')).toBeInTheDocument();
    // Close the add form: it shares its name/weight state with the inline editor.
    await user.click(within(form).getAllByRole('button').pop()!);

    await user.click(within(rowOf('My Reusable Spool')).getAllByRole('button')[0]);
    const editRow = screen.getByDisplayValue('My Reusable Spool').closest('tr') as HTMLElement;
    await user.click(within(editRow).getAllByRole('button')[0]);
    expect(await screen.findByText('Failed to update entry')).toBeInTheDocument();
    await user.click(within(editRow).getAllByRole('button')[1]);

    await user.click(within(rowOf('My Reusable Spool')).getAllByRole('button')[1]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Failed to delete entry')).toBeInTheDocument();

    await user.click(within(rowOf('My Reusable Spool')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Delete Selected/ }));
    await user.click(screen.getAllByRole('button', { name: /Delete/ }).pop()!);
    expect(await screen.findByText('Failed to delete entries')).toBeInTheDocument();

    await user.click(screen.getByTitle('Reset to defaults'));
    await user.click(screen.getAllByRole('button', { name: /Reset/ }).pop()!);
    await waitFor(() => expect(screen.getByText('Failed to reset catalog')).toBeInTheDocument());
  });
});
