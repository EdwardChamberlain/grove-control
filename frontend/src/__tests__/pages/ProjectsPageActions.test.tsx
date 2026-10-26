/**
 * ProjectsPage: create (with URL validation), edit, delete, status
 * filters, exporting every project, and importing JSON (single and
 * multiple), ZIP and invalid files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProjectsPage } from '../../pages/ProjectsPage';

const project = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: `${name} description`, color: '#00ae42', status: 'active', priority: 'normal',
  archive_count: 2, total_print_time_seconds: 3600, total_filament_grams: 50, target_count: 4,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  archives: [{ id: 1, filament_type: 'PLA,PETG', filament_color: '#FF0000,#00FF00' }],
  ...extra,
});

let calls: { method: string; path: string; search: string; body: unknown }[];

beforeEach(() => {
  calls = [];
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
  const record = (response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      // Multipart uploads are not JSON; empty bodies (DELETE) have nothing to parse.
      const text = request.headers.get('content-type')?.includes('json') ? await request.text() : '';
      const body: unknown = text ? JSON.parse(text) : null;
      calls.push({ method: request.method, path: url.pathname, search: url.search, body });
      return HttpResponse.json(response);
    };
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ currency: 'EUR' })),
    http.get('/api/v1/projects/', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      calls.push({ method: 'GET', path: '/api/v1/projects/', search: status ?? '', body: null });
      return HttpResponse.json(
        status === 'archived'
          ? [project(3, 'Old Build', { status: 'archived' })]
          : [project(1, 'Voron Build', { priority: 'urgent', due_date: '2026-12-01T00:00:00Z', tags: 'printer,diy' }), project(2, 'Gift Boxes')],
      );
    }),
    http.post('/api/v1/projects/', record({ id: 9 })),
    http.patch('/api/v1/projects/:id', record()),
    http.delete('/api/v1/projects/:id', record()),
    http.get('/api/v1/projects/:id/export', () => HttpResponse.json({ name: 'exported' })),
    http.post('/api/v1/projects/import', record({ id: 10 })),
    http.post('/api/v1/projects/import/file', record({ id: 11 })),
  );
});

async function ready() {
  render(<ProjectsPage />);
  await screen.findByText('Voron Build');
}

async function openCardMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const card = screen.getByText(name).closest('div[class*="rounded"]') as HTMLElement;
  let el: HTMLElement | null = card;
  while (el && !within(el).queryAllByRole('button').some((b) => !b.textContent?.trim())) el = el.parentElement;
  const menu = within(el!).getAllByRole('button').find((b) => !b.textContent?.trim())!;
  await user.click(menu);
}

describe('ProjectsPage actions', () => {
  it('creates a project, validating the URL', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /New Project/ }));
    await user.type(screen.getByPlaceholderText('e.g., Voron 2.4 Build'), 'Desk Organiser');
    const url = screen.getAllByRole('textbox').find((i) => (i as HTMLInputElement).type === 'url' || /https?/.test((i as HTMLInputElement).placeholder)) as HTMLInputElement;
    await user.type(url, 'ftp://nope');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(screen.getByText('URL must start with http:// or https://')).toBeInTheDocument();

    await user.clear(url);
    await user.type(url, 'https://makerworld.example/desk');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/projects/')?.body).toMatchObject({
      name: 'Desk Organiser', url: 'https://makerworld.example/desk', priority: 'normal',
    }));
    expect(await screen.findByText('Project created')).toBeInTheDocument();
  });

  it('edits and deletes a project from its card menu', async () => {
    const user = userEvent.setup();
    await ready();

    await openCardMenu(user, 'Gift Boxes');
    await user.click(screen.getByRole('button', { name: /^Edit$/ }));
    const name = screen.getByDisplayValue('Gift Boxes');
    await user.clear(name);
    await user.type(name, 'Gift Boxes 2026');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/v1/projects/2', body: expect.objectContaining({ name: 'Gift Boxes 2026', status: 'active' }) }));
    expect(await screen.findByText('Project updated')).toBeInTheDocument();

    await openCardMenu(user, 'Gift Boxes');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(screen.getByText(/Archives and queue items will be unlinked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Project' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/projects/2')).toBe(true));
    expect(await screen.findByText('Project deleted')).toBeInTheDocument();
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /^Archived$/ }));
    expect(await screen.findByText('Old Build')).toBeInTheDocument();
    expect(calls.some((c) => c.search === 'archived')).toBe(true);
    await user.click(screen.getByRole('button', { name: /^All/ }));
    expect(await screen.findByText('Voron Build')).toBeInTheDocument();
  });

  it('exports every project as JSON', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByTitle('Export all projects'));

    expect(await screen.findByText('Projects exported (metadata only)')).toBeInTheDocument();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('imports one project, several projects and a ZIP', async () => {
    await ready();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File([JSON.stringify({ name: 'Single' })], 'one.json')] } });
    expect(await screen.findByText('Project imported')).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [new File([JSON.stringify([{ name: 'A' }, { name: 'B' }])], 'many.json')] } });
    expect(await screen.findByText('2 projects imported')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/v1/projects/import')).toHaveLength(3));

    fireEvent.change(input, { target: { files: [new File(['PK'], 'bundle.zip', { type: 'application/zip' })] } });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/projects/import/file')).toBe(true));
  });

  it('reports an invalid import file', async () => {
    await ready();

    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['{broken'], 'bad.json')] } });

    expect(await screen.findByText(/^Import failed:/)).toBeInTheDocument();
  });

  it('reports failed create and delete', async () => {
    server.use(
      http.post('/api/v1/projects/', () => HttpResponse.json({ detail: 'Name taken' }, { status: 400 })),
      http.delete('/api/v1/projects/:id', () => HttpResponse.json({ detail: 'In use' }, { status: 409 })),
    );
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /New Project/ }));
    await user.type(screen.getByPlaceholderText('e.g., Voron 2.4 Build'), 'Dup');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText('Name taken')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await openCardMenu(user, 'Gift Boxes');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await user.click(screen.getByRole('button', { name: 'Delete Project' }));
    expect(await screen.findByText('In use')).toBeInTheDocument();
  });
});
