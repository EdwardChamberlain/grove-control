# Contributing to Grove Control

Thank you for your interest in contributing to Grove Control! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Before You Start](#before-you-start)
- [Product Direction](#product-direction)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Repository Layout](#repository-layout)
- [Making Changes](#making-changes)
- [Code Style](#code-style)
- [Internationalization (i18n)](#internationalization-i18n)
- [Authentication & Permissions](#authentication--permissions)
- [Testing](#testing)
- [CI Pipeline](#ci-pipeline)
- [Submitting Changes](#submitting-changes)
- [Bugs and Feature Requests](#bugs-and-feature-requests)

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) to keep our community welcoming and respectful.

## Before You Start

**Every contribution starts with an issue.** Before writing any code or opening a pull request:

1. **Open a new issue** or **comment on an existing one** describing what you'd like to work on
2. **Wait for agreement** — discuss the approach with a maintainer so we're aligned on scope and direction
3. **Get assigned** — once we agree, a maintainer will assign the issue to you
4. **Then start coding** — only open a PR for an issue that is assigned to you

**No assigned issue = no PR.** Pull requests without a corresponding assigned issue will be closed.

**GitHub is the source of truth.** The issue captures intent (the problem, the
scope and the decisions made) and the PR captures the implementation. Keep
status, decisions and follow-ups in issue and PR threads rather than in chat or
local notes, and open a new issue for anything you find that is out of scope.

This keeps everyone on the same page, avoids wasted effort on changes that may not fit the project's direction, and prevents multiple contributors from working on the same thing.

## Product Direction

Grove Control is intentionally narrower than Bambuddy. When proposing or reviewing changes, use these questions to keep the project focused:

- Does this improve a core printing or fleet-management workflow?
- Does it make common tasks clearer or reduce manual steps?
- Are its states, failures, and recovery behaviour understandable?
- Can we test and maintain it with the project's available resources?
- Does it remove complexity, or only add another option?
- If adapting an upstream change, what are we deliberately leaving out?

Prefer the smallest useful version. New functionality should have a clear user benefit and a clear maintenance boundary. Feature parity with Bambuddy is not a goal; selective adaptation is expected.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/grove-control.git
   cd grove-control
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/EdwardChamberlain/grove-control.git
   ```

## Development Setup

### Prerequisites

- Python 3.11+
- Node.js 20+
- npm

### Quick setup

From the repository root, run the QuickStart script to create or reuse the
Python virtual environment, install backend and frontend dependencies, and
install the pre-commit hook:

```bash
./quickstart.sh
```

The script is safe to run again when dependencies need to be refreshed. It
leaves the environment ready for the development and test commands below; it
cannot activate the virtual environment in the calling shell, so activate it
afterward with:

```bash
source venv/bin/activate
```

Start the backend and frontend development servers in separate terminals:

```bash
# Terminal 1 (from the repository root)
DEBUG=true uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173` and will proxy API requests to the backend.

## Repository Layout

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

## Making Changes

1. **Create a branch** from `origin/dev` (see [Branching](#branching)):
   ```bash
   git fetch origin
   git checkout -b feat/spool-usage-chart origin/dev
   ```

2. **Make your changes** following our code style guidelines

3. **Test your changes** thoroughly. Run the tests for what you touch while you work, and the full suites once before you push

4. **Commit your changes** using the [commit message style](#commit-messages) below

5. **Work through the [pre-push checklist](#pre-push-checklist)**, then [open a pull request](#submitting-changes)

### Branching

- `dev` is the default and integration branch; `main` only holds releases.
  Cut every branch from `origin/dev` and merge it back through a PR against
  `dev`.
- **There are no release or hotfix branches.** A release is a `dev` → `main`
  PR, and urgent fixes go through `dev` like everything else. The
  `Release PR Route` check rejects any PR into `main` whose source isn't `dev`,
  so a feature or hotfix PR aimed at `main` will never go green.
- **Base, review and compare against `origin/dev`,** never `main`, which can be
  hundreds of commits behind. Older clones may still have `origin/HEAD`
  pointing at `main`; if `git log --oneline HEAD..origin/dev` lists more than
  a handful of commits, your branch is missing most of `dev` and is on a stale
  base. Fix the clone with `git remote set-head origin --auto` and re-cut the
  branch from `origin/dev`.
- **Keep branches up to date by rebasing, never by merging.** Do not merge
  `dev` (or `main`) into a feature branch and do not create merge commits to
  catch up with the base branch:
  `git fetch origin && git rebase origin/dev`, then
  `git push --force-with-lease`. When branches are stacked, rebase each one onto
  its base in turn (use `git rebase --onto` if the base was squashed or
  rebased).

### Branch Naming

Name a branch after the work it carries, so the branch list alone tells you what
each one is: `<type>/<short-kebab-summary>`.

- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions or fixes
- `chore/` - Maintenance, dependencies and tooling
- `scratch/` - Investigations and spikes that may never become a PR

Keep the summary to 2-5 words about the change itself (`feat/spool-usage-chart`,
`fix/queue-bulk-delete-403`), not about the tooling or session that produced it.
Branches created by AI agents carry a prefix naming the responsible agent; see
[AGENTS.md](AGENTS.md).

### Commit Messages

Use conventional commits: `type(scope): summary`.

- `type` is one of `feat`, `fix`, `docs`, `refactor`, `test` or `chore`.
- `scope` is the area touched, such as `queue`, `history`, `i18n` or `ci`.
- The summary is a short, lower-case, imperative description with no trailing
  period.

```text
feat(history): calendar in its own card, full-width stats
fix(queue): label icon-only bulk buttons and add changelog entry
test(history): cover opening a print from the calendar day detail
chore(i18n): remove the unused queue.reorderHint string
```

### Changelog

Any change a user, API consumer or administrator would notice (new features,
changed behaviour, API or permission changes, removals and notable fixes) needs
a bullet under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the same PR.
Write it from the user's point of view as `Area: what changed`, and reference
the issue or PR number where there is one. Documentation-only, test-only and
internal refactoring changes don't need an entry.

## Code Style

### Backend (Python)

We use [Ruff](https://github.com/astral-sh/ruff) for linting and formatting. Configuration is in `pyproject.toml`.

```bash
# Check linting
ruff check backend/

# Auto-fix issues
ruff check --fix backend/

# Format code
ruff format backend/

# Check formatting without changes
ruff format --check backend/
```

### Frontend (TypeScript/React)

We use ESLint for linting and TypeScript for type checking:

```bash
cd frontend

# Lint
npm run lint

# Type check (app, tests, e2e and config files)
npm run typecheck
```

### Pre-commit Hooks

Pre-commit hooks run automatically on `git commit` and include Ruff linting/formatting, trailing whitespace fixes, YAML/JSON validation, and import shadowing checks. To run manually:

```bash
pre-commit run --all-files
```

## Internationalization (i18n)

The frontend uses [react-i18next](https://react.i18next.com/) for all user-facing text. **Never hardcode user-visible strings** — always use translation keys.

### Locale Files

Translations live in `frontend/src/i18n/locales/`, one file per language, with
`en.ts` as the primary. List the directory for the current set of languages.

### Adding New Strings

1. Add the key to the appropriate section in **every** locale file
2. Use the `useTranslation` hook in your component:

```tsx
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  return <span>{t('section.myNewKey')}</span>;
}
```

3. Keys are organized by feature (e.g., `spoolman.`, `nav.`, `common.`)

### Important Notes

- Every locale file must use the **same key structure** — same nesting, same key paths
- Always add keys to every locale to maintain parity; `npm run check:i18n` (part of `npm run test:run`) fails if they drift apart
- If you find structural inconsistencies between locales, fix them — different key paths cause silent fallback to English

## Authentication & Permissions

Grove Control has an optional authentication system. When auth is enabled, API endpoints are protected by granular permissions.

### How It Works

Authentication is **opt-in** — when disabled, all endpoints are open. The system uses `RequirePermissionIfAuthEnabled` which:

- Checks if auth is enabled in settings
- If disabled: allows the request through (no-op)
- If enabled: validates JWT token/API key and checks the user has the required permission

### Adding Auth to New Endpoints

Use the `RequirePermissionIfAuthEnabled` dependency in your route:

```python
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission

@router.get("/my-resource")
async def get_my_resource(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.RESOURCE_READ),
):
    ...
```

### Permission Convention

Permissions follow the `resource:action` pattern (e.g., `filaments:read`, `printers:control`). Standard actions:

| Action | Usage |
|--------|-------|
| `read` | View/list resources |
| `create` | Create new resources |
| `update` | Modify existing resources |
| `delete` | Remove resources |

Some resources have additional actions. Examples: `printers:control` for live printer controls
such as stop/pause/resume, `printers:files` for printer storage access, `queue:create` for
creating queue items that may dispatch immediately when scheduled ASAP, `library:upload` for
File Manager uploads/imports, and `archives:reprint_own` / `archives:reprint_all` for archive
reprint eligibility. Archive reprint still needs `queue:create` before it can enqueue a job.

### Adding New Permissions

1. Add the permission to the `Permission` enum in `backend/app/core/permissions.py`
2. Add it to the appropriate category in `PERMISSION_CATEGORIES`
3. Add it to the relevant default groups (`Administrators` gets all, `Operators` and `Viewers` as appropriate)
4. Use it in your route with `RequirePermissionIfAuthEnabled`

### Default Groups

| Group | Access Level |
|-------|-------------|
| **Administrators** | All permissions |
| **Operators** | Full control of printers, own items in archives/queue, read-only settings |
| **Viewers** | Read-only access to all resources |

## Testing

The easiest way to run tests is with the provided scripts in the project root:

```bash
./test_frontend.sh    # TypeScript check + ESLint + Vitest + Playwright (installs Chromium on first run)
./test_backend.sh     # Ruff lint/format + pytest (parallel)
./test_docker.sh      # Full Docker build, unit tests, and integration tests
./test_all.sh         # All of the above (frontend → backend → docker)
./test_security.sh    # Security scans (bandit, pip-audit, npm-audit)
```

`test_docker.sh` supports flags like `--backend-only`, `--skip-integration`, `--fresh` — run with `--help` for details.

`test_security.sh` runs fast scans by default. Use `--full` for the complete suite (CodeQL, Trivy, etc.) or specify individual scans like `./test_security.sh bandit codeql`.

### Running Tests Individually

**Backend** — tests are in `backend/tests/` with `unit/` and `integration/` subdirectories. Run them from `backend/` with the repo-root virtualenv (`../venv`). A fresh clone or git worktree has none; create it from the **repo root** first:

```bash
python3 -m venv venv && venv/bin/pip install -r requirements.txt -r requirements-dev.txt
```

```bash
cd backend
../venv/bin/python -m pytest tests/ -n auto                                   # All tests (parallel)
../venv/bin/python -m pytest tests/unit/                                      # Unit tests only
../venv/bin/python -m pytest tests/integration/test_print_queue_api.py        # One file
../venv/bin/python -m pytest tests/ -k "queue and start"                      # By name
../venv/bin/python -m pytest tests/ -n auto --cov=app --cov-report=term-missing:skip-covered  # With coverage, as CI measures it
```

- `tests/unit/services/test_bambu_ftp.py` runs the FTP client against a local
  mock FTPS server (no hardware). It is slow, so leave it out of quick runs with
  `--ignore` if you like; CI always runs it.
- CI shards the suite with `pytest-split` using `backend/.test_durations`.
  Refresh it occasionally so shards stay balanced (new tests are fine without
  it, they just get an average duration):
  `cd backend && ../venv/bin/python -m pytest tests/ -n auto --store-durations`

**Frontend** — tests use [Vitest](https://vitest.dev/) and are in `frontend/src/__tests__/`:

```bash
cd frontend
npm run test:run       # Single run with coverage thresholds + i18n parity (what CI runs)
npm test               # Watch mode
npx vitest run src/__tests__/pages/QueuePage.test.tsx  # One file
npx vitest related src/pages/QueuePage.tsx --run       # Tests that import a file
npm run test:browser   # Playwright browser tests in frontend/e2e/ (run `npm run setup:browser` once)
```

`npm run typecheck` (`tsc -b`) type-checks the app, the tests (`src/__tests__/`, `e2e/`) and the
`*.config.ts` files, through the projects referenced from `frontend/tsconfig.json`. Test fixtures must
match the real API types. A new top-level TypeScript folder must be added to one of those projects'
`include`; `scripts/check-typecheck-coverage.mjs` fails the check if a project lists no files of its own.

### Writing Backend Tests

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
- **Structural guard tests** run with the suite and fail with instructions:
  every route needs an auth dependency, the frontend's route snapshot
  (`frontend/src/__tests__/api/backend-routes.json`) must match the backend
  routes, and there are guards against hardcoded secrets and unsafe path joins.
  Follow the failure message rather than working around the guard.

### Writing Frontend Tests

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
- New user-facing strings go in every locale file (see
  [Internationalization](#internationalization-i18n)).
- Playwright tests in `frontend/e2e/` stub the API and WebSocket
  (`e2e/mockWebSocket.ts`); they test the UI, not the backend.

### Coverage

CI enforces coverage floors for the backend and frontend, so untested code can
fail the build on its own. The config is the source of truth for the figures:
the backend line floor is in the `Backend Coverage` job of
`.github/workflows/ci.yml` (mirrored in `test_backend.sh`), and the frontend
floors are in `coverage.thresholds` in `frontend/vitest.config.ts`. Branch
coverage is reported but not gated.

- When your change raises coverage, raise the floors in the same PR to the new
  figure, rounded down (backend to one decimal place, frontend to whole
  numbers). Never lower a floor to get a PR through.
- Pull requests also have their new and changed lines checked (`diff-cover`,
  in the job summary). PRs that change only docs, config or tests pass.

#### Coverage exclusions

Exclusions hide code from the floors, so they are rare and always explained.
Only exclude code that cannot run in the test environment (it needs a real GPU
or WebGL, blocks forever by design, or only runs on a platform the tests don't
use). Code that is hard or tedious to test is not excluded: write the test.
Mark individual lines or blocks, never files or patterns, and state the reason
on the same line:

```python
except AttributeError:  # pragma: no cover - unreachable on Python 3.11+, which the app requires
```

```ts
/* v8 ignore next -- jsdom has no WebGL context to create */
```

`backend/tests/unit/test_coverage_exclusions.py` enforces the rules. Call out
new exclusions in the PR description so a reviewer checks them.

## CI Pipeline

Pull requests run the checks in `.github/workflows/ci.yml`: backend lint and
tests, frontend lint, type check, tests and build, a security audit, and a
Docker smoke test. [.github/MAINTAINERS.md](.github/MAINTAINERS.md) lists every
job and which ones are required before merging. Run `./test_all.sh` locally
before pushing to catch issues early.

## Submitting Changes

### Pre-push Checklist

Before you push, check that:

1. The branch is rebased on `origin/dev` with no merge commits.
2. Lint and types are clean: `ruff check backend/ && ruff format --check backend/` from the repo root, and `npm run lint && npm run typecheck` in `frontend/`.
3. The tests for what you touched pass, and you have run the full suites once (`./test_backend.sh`, `./test_frontend.sh`).
4. New user-facing strings are in every locale file (`npm run check:i18n`).
5. Coverage floors are raised if your change raised coverage, never lowered, and any new exclusion is explained on its line.
6. User-visible changes have a [changelog](#changelog) entry.
7. Frontend UI changes have before/after screenshots ready for the PR.

### Opening the Pull Request

1. **Push your branch** to your fork (agents push to the repository directly):
   ```bash
   git push -u origin feat/your-feature-name
   ```

2. **Create a Pull Request** on GitHub:
   - **Always target the `dev` branch** as the base branch (not `main`)
   - Use a clear, descriptive title
   - Fill out the PR template completely
   - Link any related issues
   - Include before/after screenshots for any visual changes
   - **Open it as a regular PR, not a draft.** A PR is either ready for review or it isn't ready to be raised yet. Drafts only add an extra step, so keep the work on your branch until it is ready, then open the PR.

3. **Wait for review** - maintainers will review your PR and may request changes

### PR Guidelines

- Keep PRs focused and reasonably sized
- One feature or fix per PR
- Update documentation if needed
- Add tests for new functionality
- Ensure all tests pass
- Follow the existing code style
- **Visual changes require screenshots** — if your PR changes any frontend UI, include before/after screenshots showing the old and new appearance

## Bugs and Feature Requests

Open an issue using the [bug report](https://github.com/EdwardChamberlain/grove-control/issues/new?template=bug_report.yml)
or [feature request](https://github.com/EdwardChamberlain/grove-control/issues/new?template=feature_request.yml)
template; the templates say what to include.

## Questions?

- Open a [Discussion](https://github.com/EdwardChamberlain/grove-control/discussions)
- Review existing [Issues](https://github.com/EdwardChamberlain/grove-control/issues)

---

Thank you for contributing to Grove Control!
