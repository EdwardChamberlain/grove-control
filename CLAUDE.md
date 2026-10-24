# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) for full setup and conventions.

## Workflow

- **Branching (git-flow style, simplified):** `dev` is the default and
  integration branch; `main` only holds releases. Cut `feature/`, `fix/`,
  `docs/`, `refactor/` or `test/` branches from `origin/dev` and merge them
  back via PR against `dev`.
- **There are no release or hotfix branches.** A release is a `dev` → `main`
  PR, and urgent fixes go through `dev` like everything else. The
  `Release PR Route` check rejects any PR into `main` whose source isn't `dev`,
  so a feature or hotfix PR aimed at `main` will never go green.
- **Base, review and compare against `origin/dev`,** never `main`, which can be
  hundreds of commits behind. Older clones may still have `origin/HEAD`
  pointing at `main`; if `git log --oneline origin/dev..HEAD` shows a long
  history you didn't write, you're on a stale base. Fix the clone with
  `git remote set-head origin --auto`.
- Every change ships with tests. CI enforces coverage floors (see below), so
  untested code can fail the build on its own.
- Run the tests for what you touched while you work; run the full suites once
  before you push.

## Layout

| Path | What it is |
|---|---|
| `backend/app/api/routes/` | FastAPI routers, one module per area |
| `backend/app/services/` | Business logic, printer comms (MQTT/FTP), integrations |
| `backend/app/models/`, `schemas/` | SQLAlchemy models, Pydantic schemas |
| `backend/tests/unit/`, `integration/` | pytest suites |
| `frontend/src/pages/`, `components/` | React UI |
| `frontend/src/api/client.ts` | Typed API client used by every page |
| `frontend/src/__tests__/` | Vitest suites, mirroring `src/` |
| `frontend/e2e/` | Playwright browser tests (mocked API) |

## Running tests

### Backend

Tests run from `backend/` using the virtualenv at the repo root (`../venv`). A
fresh clone or git worktree has none; create it from the **repo root** first:

```bash
python3 -m venv venv && venv/bin/pip install -r requirements.txt -r requirements-dev.txt
```

```bash
cd backend
../venv/bin/python -m pytest tests/integration/test_print_queue_api.py   # one file
../venv/bin/python -m pytest tests/ -k "queue and start"                 # by name
../venv/bin/python -m pytest tests/ -n auto                              # everything (a few minutes)
```

- `tests/unit/services/test_bambu_ftp.py` is slow (~60s); CI's coverage job
  skips it. Leave it out of quick runs with `--ignore`.
- Lint and format: `ruff check backend/ && ruff format --check backend/`
  (from the repo root).

### Frontend

Run from `frontend/`:

```bash
npx vitest run src/__tests__/pages/QueuePage.test.tsx   # one file
npx vitest related src/pages/QueuePage.tsx --run        # tests that import a file
npx tsc --noEmit && npm run lint                        # types + lint
npm run test:run                                        # full suite + coverage + i18n parity
npm run test:browser                                    # Playwright (run `npm run setup:browser` once)
```

### Everything

`./test_backend.sh` and `./test_frontend.sh` mirror CI. `./test_all.sh` also
runs the Docker and security suites.

## Writing backend tests

- **API behaviour → `tests/integration/`.** Use the `async_client` fixture
  (an `httpx.AsyncClient` on the real app) and `db_session` (an isolated
  in-memory SQLite database per test). Assert on status codes *and* response
  bodies.
- **Pure logic → `tests/unit/`.** Mock I/O; don't start the app.
- **Factories** in `backend/tests/conftest.py`: `printer_factory`,
  `archive_factory`, `smart_plug_factory`, `notification_provider_factory`.
  Prefer them over building models by hand.
- **Never reach real hardware or networks.** Use `mock_mqtt_client`,
  `mock_ftp_client`, `mock_httpx_client`, `mock_printer_manager`, and the
  Tasmota/Home Assistant mocks. Printer connections are already stubbed in
  `async_client`.
- **Auth is off by default.** To test an authenticated route, call
  `POST /api/v1/auth/setup` with `auth_enabled: true` and an admin, log in, and
  send `Authorization: Bearer <token>`. See `_enable_auth_with_admin` in
  `tests/integration/test_queue_start_user_attribution.py`.
- **Every new route needs an auth dependency.**
  `tests/unit/test_route_auth_coverage.py` fails otherwise; adding a public
  route means adding it to that file's allowlist with a reason.
- **Adding, removing or renaming a route** means regenerating the frontend's
  copy of the route table, `frontend/src/__tests__/api/backend-routes.json`,
  which the API contract test checks every client call against.
  `tests/unit/test_api_route_snapshot.py` fails until you do:

  ```bash
  cd backend && UPDATE_ROUTE_SNAPSHOT=1 ../venv/bin/python -m pytest tests/unit/test_api_route_snapshot.py
  ```

  Commit the updated JSON with the route change.
- Other structural guards will catch you too: `test_no_hardcoded_secrets.py`,
  `test_no_unsafe_path_joins.py`, `test_no_fail_open_in_auth.py`,
  `test_code_quality.py`.

## Writing frontend tests

- Put tests under `frontend/src/__tests__/` mirroring the source path
  (`pages/FooPage.tsx` → `__tests__/pages/FooPage.test.tsx`).
- Import `render` from `src/__tests__/utils.tsx`, not straight from Testing
  Library; it wraps the component in the app's providers (React Query, router,
  auth, theme, toasts). i18n and MSW are set up in `src/__tests__/setup.ts`.
- The network is mocked with MSW. Default handlers live in
  `src/__tests__/mocks/handlers.ts`; override per test with
  `server.use(http.get('*/api/v1/...', () => HttpResponse.json(...)))`.
- Query by role or label text and drive interactions with `userEvent`. Assert on
  what the user sees and on the requests sent.
- New user-facing strings go in every locale file; `npm run check:i18n`
  (part of `test:run`) fails if the locales drift apart.
- Playwright tests in `frontend/e2e/` stub the API and WebSocket
  (`e2e/mockWebSocket.ts`); they test the UI, not the backend.

## CI and required checks

Pull requests to `dev` must pass: Backend Lint, Backend Tests (4 shards),
Backend Coverage, Frontend Lint, Frontend Type Check, Frontend Tests (Vitest,
coverage thresholds, i18n parity, Playwright), Frontend Build and Frontend
Security Audit.

Coverage floors:

- Backend: `--cov-fail-under` in the Backend Coverage job of
  `.github/workflows/ci.yml` (mirrored in `test_backend.sh`).
- Frontend: `coverage.thresholds` in `frontend/vitest.config.ts`.

When your change raises coverage meaningfully, raise the floors in the same PR.
Never lower a floor to get a PR through.
