/**
 * APIBrowser: loads the OpenAPI schema, groups and searches endpoints,
 * builds example bodies from schemas, and executes requests.
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { APIBrowser } from '../../components/APIBrowser';

const schema = {
  paths: {
    '/api/v1/printers/{printer_id}': {
      parameters: [],
      get: {
        summary: 'Get printer',
        description: 'Fetch one printer',
        tags: ['printers'],
        parameters: [
          { name: 'printer_id', in: 'path', required: true, description: 'Printer ID' },
          { name: 'detail', in: 'query', schema: { type: 'string', enum: ['full', 'brief'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
        ],
      },
    },
    '/api/v1/printers/': {
      post: {
        summary: 'Create printer',
        tags: ['printers'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/PrinterCreate' } } } },
      },
    },
    '/api/v1/health': { get: { summary: 'Health check' } },
    '/api/v1/smart-plugs/': { delete: { summary: 'Delete all plugs', tags: ['smart-plugs'] } },
  },
  components: {
    schemas: {
      Base: { type: 'object', properties: { enabled: { type: 'boolean' } } },
      PrinterCreate: {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              model: { type: 'string', enum: ['X1C', 'P1S'] },
              port: { type: 'integer' },
              tags: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string', example: 'shop floor' },
              extra: { type: 'object' },
              weird: {},
            },
          },
        ],
      },
    },
  },
};

function useSchema(response = HttpResponse.json(schema)) {
  server.use(http.get('/openapi.json', () => response));
}

async function openTag(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('heading', { name }));
}

describe('APIBrowser', () => {
  it('groups endpoints by tag and searches them', async () => {
    useSchema();
    const user = userEvent.setup();
    render(<APIBrowser />);

    expect(await screen.findByText('4 endpoints in 3 categories')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'smart plugs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand All' }));
    expect(screen.getByText('Health check')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse All' }));
    expect(screen.queryByText('Health check')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search endpoints...'), 'create');
    expect(screen.getByText('1 endpoints in 1 categories')).toBeInTheDocument();
  });

  it('requires path parameters, then calls the endpoint with query values', async () => {
    useSchema();
    let requested = '';
    let apiKeyHeader: string | null = null;
    server.use(
      http.get('/api/v1/printers/:id', ({ request }) => {
        requested = request.url;
        apiKeyHeader = request.headers.get('X-API-Key');
        return HttpResponse.json({ id: 3, name: 'X1' });
      }),
    );
    const user = userEvent.setup();
    render(<APIBrowser apiKey="bb_key" />);

    await openTag(user, 'printers');
    await user.click(screen.getByText('Get printer'));
    expect(screen.getByText('Fetch one printer')).toBeInTheDocument();
    expect(screen.getByText('Fill in: printer_id')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Execute/ }));
    expect(screen.getByText('Missing required parameters: printer_id')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Printer ID'), '3');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'brief' }));
    await user.click(screen.getByRole('button', { name: /Execute/ }));

    expect(await screen.findByText(/200/)).toBeInTheDocument();
    expect(new URL(requested).pathname).toBe('/api/v1/printers/3');
    expect(new URL(requested).searchParams.get('detail')).toBe('brief');
    expect(new URL(requested).searchParams.get('limit')).toBe('10');
    expect(apiKeyHeader).toBe('bb_key');
    expect(screen.getByText(/"name": "X1"/)).toBeInTheDocument();

    // Copy the response.
    const copy = screen.getByText(/200/).closest('div')!.querySelector('button')!;
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toContain('"id": 3');
  });

  it('prefills a JSON body from the schema and sends it', async () => {
    useSchema();
    let body: unknown;
    server.use(
      http.post('/api/v1/printers/', async ({ request }) => {
        body = await request.json();
        return new HttpResponse('created', { status: 201, headers: { 'content-type': 'text/plain' } });
      }),
    );
    const user = userEvent.setup();
    render(<APIBrowser />);

    await openTag(user, 'printers');
    await user.click(screen.getByText('Create printer'));
    const textarea = screen.getByPlaceholderText('JSON request body...') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({
      enabled: false, name: 'string', model: 'X1C', port: 0, tags: ['string'], notes: 'shop floor', extra: {}, weird: null,
    });
    await user.click(screen.getByRole('button', { name: /Execute/ }));

    expect(await screen.findByText('created')).toBeInTheDocument();
    expect(screen.getByText(/201/)).toBeInTheDocument();
    expect(body).toMatchObject({ name: 'string' });
  });

  it('shows error responses and network failures', async () => {
    useSchema();
    server.use(http.delete('/api/v1/smart-plugs/', () => HttpResponse.json({ detail: 'Forbidden' }, { status: 403 })));
    const user = userEvent.setup();
    render(<APIBrowser />);

    await openTag(user, 'smart plugs');
    await user.click(screen.getByText('Delete all plugs'));
    await user.click(screen.getByRole('button', { name: /Execute/ }));
    expect(await screen.findByText(/403/)).toBeInTheDocument();

    server.use(http.delete('/api/v1/smart-plugs/', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: /Execute/ }));
    expect(await screen.findByText(/Network Error/)).toBeInTheDocument();
  });

  it('reports a schema that fails to load', async () => {
    useSchema(new HttpResponse(null, { status: 500 }));
    render(<APIBrowser />);

    expect(await screen.findByText('Failed to load API schema')).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch OpenAPI schema')).toBeInTheDocument();
  });

  it('collapses an endpoint again', async () => {
    useSchema();
    const user = userEvent.setup();
    render(<APIBrowser />);

    await openTag(user, 'Other');
    const row = screen.getByText('Health check');
    await user.click(row);
    expect(within(row.closest('.border')!).getByRole('button', { name: /Execute/ })).toBeInTheDocument();
    await user.click(row);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Execute/ })).not.toBeInTheDocument());
  });
});
