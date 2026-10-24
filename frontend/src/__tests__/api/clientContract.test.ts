/**
 * Contract test: every `api` client method must call a route the backend
 * actually serves.
 *
 * `backend-routes.json` is generated from the FastAPI app and kept in sync by
 * backend/tests/unit/test_api_route_snapshot.py. This test calls each client
 * method with placeholder arguments, records the requests it sends, and checks
 * every request's method + path against that list. A typo in a URL, a renamed
 * backend route, or a wrong HTTP verb fails here instead of 404ing in the app.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api } from '../../api/client';
import backendRoutes from './backend-routes.json';

type Recorded = { method: string; path: string };

const API_PREFIX = '/api/v1/';

// Methods that build a URL or do client-side work without calling the API.
// Keep this list short: anything here is not contract-checked.
const NO_REQUEST_METHODS = new Set<string>([]);

const routeMatchers = (backendRoutes as string[]).map((entry) => {
  const [method, template] = entry.split(' ');
  const pattern = template
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{[^}:]+:path\}/g, '.+')
    .replace(/\{[^}]+\}/g, '[^/]+');
  return { method, template, regex: new RegExp(`^${pattern}/?$`) };
});

function matchesBackend(req: Recorded): boolean {
  return routeMatchers.some((r) => r.method === req.method && r.regex.test(req.path));
}

let recorded: Recorded[] = [];

beforeEach(() => {
  recorded = [];
  server.use(
    http.all('*', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith(API_PREFIX)) {
        recorded.push({ method: request.method, path: url.pathname });
      }
      return HttpResponse.json({});
    }),
  );
});

const placeholderFile = () => new File(['x'], 'model.3mf', { type: 'application/octet-stream' });

// An object whose every property reads as 1, for methods that read fields off
// a config argument (`config.nozzle_temp_min.toString()`). Serialises as {}.
const anyFields = () =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (typeof key === 'symbol' || key === 'toJSON' || key === 'then' ? undefined : 1),
  });

// Argument shapes tried in order until the method sends a request.
const ARG_STRATEGIES: Array<() => unknown[]> = [
  () => [1, 1, 1, 1, 1],
  () => ['x', 'x', 'x', 'x', 'x'],
  () => [1, {}, {}, {}, {}],
  () => [{}, {}, {}, {}, {}],
  () => [placeholderFile(), placeholderFile(), {}, {}, {}],
  () => [1, placeholderFile(), {}, {}, {}],
  () => [[1], [1], {}, {}, {}],
  () => [1, 1, 1, anyFields(), anyFields()],
  () => [anyFields(), anyFields(), anyFields(), anyFields(), anyFields()],
];

async function callAndRecord(fn: (...args: unknown[]) => unknown): Promise<Recorded[]> {
  for (const makeArgs of ARG_STRATEGIES) {
    recorded = [];
    let result: unknown;
    try {
      result = fn(...makeArgs());
      if (result instanceof Promise) {
        result = await Promise.race([
          result.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    } catch {
      // Placeholder args didn't fit; try the next shape.
    }
    if (recorded.length > 0) return recorded;
    // URL builders: a returned same-origin API URL is fetched by the browser
    // (img/src, download links), so it is part of the contract as a GET.
    if (typeof result === 'string' && result.includes(API_PREFIX)) {
      const url = new URL(result, 'http://localhost');
      return [{ method: 'GET', path: url.pathname }];
    }
  }
  return [];
}

const methodNames = Object.keys(api).filter(
  (name) => typeof (api as Record<string, unknown>)[name] === 'function',
);

describe('api client ↔ backend route contract', () => {
  it('has methods to check', () => {
    expect(methodNames.length).toBeGreaterThan(100);
  });

  it.each(methodNames)('%s calls a route the backend serves', async (name) => {
    const fn = (api as Record<string, (...args: unknown[]) => unknown>)[name];
    const requests = await callAndRecord(fn);

    if (NO_REQUEST_METHODS.has(name)) {
      expect(requests).toEqual([]);
      return;
    }

    expect(requests.length, `${name} sent no request; add it to NO_REQUEST_METHODS if that is intended`).toBeGreaterThan(0);
    for (const req of requests) {
      expect(matchesBackend(req), `${name} → ${req.method} ${req.path} matches no backend route`).toBe(true);
    }
  });
});
