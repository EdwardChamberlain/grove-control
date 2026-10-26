/**
 * ProjectDetailPage: the bill of materials (add, acquire, edit, delete,
 * hide done), due-date and priority badges, exporting the project and
 * saving it as a template.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProjectDetailPage } from '../../pages/ProjectDetailPage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: '1' }), useNavigate: () => vi.fn() };
});

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 1, name: 'Gift boxes', description: 'Holiday run', color: '#00ae42', status: 'active', priority: 'high',
  due_date: inDays(2), notes: 'Use matte PLA', parent_id: null, archive_count: 0, total_print_time_seconds: 0,
  total_filament_grams: 0, target_count: 10, target_parts_count: 20, budget: 50, tags: 'xmas,gift',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  stats: { total_archives: 4, completed_prints: 4, failed_prints: 1, queued_prints: 2, in_progress_prints: 0,
    total_print_time_hours: 3.5, total_filament_grams: 120, progress_percent: 40, parts_progress_percent: 25,
    remaining_prints: 6, remaining_parts: 15, bom_total_items: 2, bom_completed_items: 1,
    estimated_cost: 12.5, total_energy_kwh: 1.2, total_energy_cost: 0.3 },
  ...overrides,
});

const bom = [
  { id: 1, project_id: 1, name: 'M3x8 screws', quantity_needed: 40, quantity_acquired: 0, unit_price: 0.05, sourcing_url: 'https://shop.example/m3',
    archive_id: null, archive_name: null, stl_filename: null, remarks: 'stainless', sort_order: 0, is_complete: false, created_at: '', updated_at: '' },
  { id: 2, project_id: 1, name: 'Magnets', quantity_needed: 8, quantity_acquired: 8, unit_price: null, sourcing_url: null,
    archive_id: null, archive_name: null, stl_filename: null, remarks: null, sort_order: 1, is_complete: true, created_at: '', updated_at: '' },
];

let calls: { method: string; path: string; body: unknown }[];
let current: ReturnType<typeof project>;

beforeEach(() => {
  calls = [];
  current = project();
  const record = (response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response);
    };
  server.use(
    http.get('/api/v1/projects/:id', () => HttpResponse.json(current)),
    http.get('/api/v1/projects/:id/archives', () => HttpResponse.json([])),
    http.get('/api/v1/projects/:id/bom', () => HttpResponse.json(bom)),
    http.get('/api/v1/projects/:id/timeline', () => HttpResponse.json([])),
    http.get('/api/v1/library/folders/by-project/:id', () => HttpResponse.json([])),
    http.get('/api/v1/library/files', () => HttpResponse.json([])),
    http.post('/api/v1/projects/:id/bom', record({ id: 3 })),
    http.patch('/api/v1/projects/:id/bom/:itemId', record()),
    http.delete('/api/v1/projects/:id/bom/:itemId', record({ status: 'deleted', message: '' })),
    http.post('/api/v1/projects/:id/create-template', record({ id: 9, name: 'Gift boxes (template)' })),
    http.get('/api/v1/projects/:id/export', () => new HttpResponse('zip', { headers: { 'content-disposition': 'attachment; filename="gift.zip"' } })),
  );
});

async function ready() {
  render(<ProjectDetailPage />);
  await screen.findByText('M3x8 screws');
}

const bomRow = (name: string) => screen.getByText(name).closest('div.flex, li, tr') as HTMLElement;

describe('bill of materials', () => {
  it('shows parts and their progress, and hides finished ones', async () => {
    const user = userEvent.setup();
    await ready();

    expect(screen.getByText('(1/2 acquired)')).toBeInTheDocument();
    expect(screen.getByText('Magnets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Hide done/ }));
    expect(screen.queryByText('Magnets')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show all/ }));
    expect(screen.getByText('Magnets')).toBeInTheDocument();
  });

  it('adds a part', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: /Add Part/ }));
    await user.type(screen.getByPlaceholderText('Part name (e.g., M3x8 screws)'), 'Hinges');
    fireEvent.change(screen.getAllByPlaceholderText(/Qty/i)[0], { target: { value: '4' } });
    await user.type(screen.getAllByPlaceholderText(/Price/i)[0], '1.25');
    await user.type(screen.getAllByPlaceholderText(/https|URL|link/i)[0], 'https://shop.example/hinge');
    await user.click(screen.getAllByRole('button', { name: /Add Part/ }).pop()!);

    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Hinges', quantity_needed: 4, unit_price: 1.25, sourcing_url: 'https://shop.example/hinge',
    }));
    expect(await screen.findByText('Part added')).toBeInTheDocument();
  });

  it('marks a part acquired, edits it and deletes it', async () => {
    const user = userEvent.setup();
    await ready();

    // Toggle acquired.
    const screws = screen.getByText('M3x8 screws').closest('div[class*="rounded"]') as HTMLElement;
    await user.click(within(screws).getAllByRole('button')[0]);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ quantity_acquired: 40 }));

    // Edit.
    await user.click(within(screws).getByTitle('Edit'));
    const name = screen.getByDisplayValue('M3x8 screws');
    await user.clear(name);
    await user.type(name, 'M3x10 screws');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toMatchObject({ name: 'M3x10 screws', quantity_needed: 40 }));

    // Delete after confirming.
    await user.click(within(screen.getByText('M3x8 screws').closest('div[class*="rounded"]') as HTMLElement).getByTitle('Delete'));
    expect(screen.getByText('Are you sure you want to delete "M3x8 screws"?')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Delete|Confirm/ }).pop()!);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/bom/1'))).toBe(true));
    expect(await screen.findByText('Part removed')).toBeInTheDocument();
  });

  it('cancels an edit', async () => {
    const user = userEvent.setup();
    await ready();

    const screws = screen.getByText('M3x8 screws').closest('div[class*="rounded"]') as HTMLElement;
    await user.click(within(screws).getByTitle('Edit'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByDisplayValue('M3x8 screws')).not.toBeInTheDocument();
  });
});

describe('project header', () => {
  it.each([
    [inDays(-3), 'Overdue'],
    [inDays(-0.2), 'Due today'],
    [inDays(2), '2 days left'],
    [inDays(20), '20 days left'],
  ])('shows the due date status (%#)', async (due, label) => {
    current = project({ due_date: due });
    render(<ProjectDetailPage />);

    expect(await screen.findByText(`(${label})`)).toBeInTheDocument();
  });

  it.each([['low', 'Low'], ['urgent', 'Urgent']])('shows the %s priority badge', async (priority, label) => {
    current = project({ priority });
    render(<ProjectDetailPage />);

    await screen.findByText('M3x8 screws');
    expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument();
  });

  it('hides the badge for normal priority', async () => {
    current = project({ priority: 'normal' });
    render(<ProjectDetailPage />);

    await screen.findByText('M3x8 screws');
    expect(screen.queryByText('Normal', { selector: 'span' })).not.toBeInTheDocument();
  });

  it('exports the project and saves it as a template', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByTitle('Export project'));
    expect(await screen.findByText('Project exported')).toBeInTheDocument();
    expect(click).toHaveBeenCalled();
    click.mockRestore();

    await user.click(screen.getByRole('button', { name: /Save as Template/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/create-template'))).toBe(true));
    expect(await screen.findByText('Template created')).toBeInTheDocument();
  });

  it('reports a failed export', async () => {
    server.use(http.get('/api/v1/projects/:id/export', () => HttpResponse.json({ detail: 'Export failed on server' }, { status: 500 })));
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByTitle('Export project'));

    expect(await screen.findByText(/Export failed on server|HTTP 500/)).toBeInTheDocument();
  });
});
