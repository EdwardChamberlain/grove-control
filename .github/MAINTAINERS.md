# Maintainer Guide

This document provides setup instructions for repository maintainers.

## Branch Protection Setup

Both protected branches use repository rulesets (**Settings > Rules > Rulesets**).
Each one restricts deletion, blocks force pushes, requires a pull request, and
requires the status checks listed below. Status checks only appear in the
picker after CI has run once.

### `dev` (Dev Branch Protection)

Feature and fix PRs target `dev`. Required status checks:

- `Backend Lint`
- `Backend Tests (shard 1/4)` … `Backend Tests (shard 4/4)`
- `Backend Coverage`
- `Frontend Lint`
- `Frontend Type Check`
- `Frontend Tests`
- `Frontend Build`
- `Frontend Security Audit`

### `main` (Main Branch Protection)

`main` only accepts release PRs from `dev`. Required status check:

- `Release PR Route` (rejects any PR whose head is not `dev`)

### Optional (stricter)

- [ ] Require approvals
- [ ] Require conversation resolution before merging
- [ ] Require signed commits
- [ ] Require linear history

## CI Workflows

`.github/workflows/ci.yml` runs on pull requests to `dev` and `main`, and on
pushes to both.

| Job | Purpose | Required on `dev` |
|-----|---------|-------------------|
| `Release Workflow Tests` | Release-script unit tests, workflow YAML parse | No |
| `Version Consistency` | `scripts/check_version.py` | No |
| `Backend Lint` | Ruff lint + format check | Yes |
| `Backend Tests (shard N/4)` | pytest, split across 4 shards | Yes |
| `Backend Coverage` | Full pytest run with `--cov-fail-under` | Yes |
| `Frontend Lint` | ESLint | Yes |
| `Frontend Security Audit` | `npm audit --audit-level=high` | Yes |
| `Frontend Type Check` | `tsc --noEmit` | Yes |
| `Frontend Tests` | Vitest with coverage thresholds, i18n parity, Playwright browser tests | Yes |
| `Frontend Build` | Vite production build | Yes |
| `Docker Smoke Test` | Builds the image, checks imports, static files and `/health` | No |

Other workflows:

| Workflow | Runs on |
|---|---|
| `release-pr-route.yml` (`Release PR Route`, `Release Version`) | PRs to `main` |
| `codeql.yml` | PRs and pushes to `main`, weekly schedule |
| `docker-publish-dev.yml` | After CI succeeds on `dev` (publishes `:dev`) |
| `docker-publish.yml` | After CI succeeds on `main` (publishes `:latest` and `X.Y.Z`) |
| `create-github-release.yml` | After Docker Publish succeeds (tags and releases) |
| `readme-screenshots.yml` | Manual dispatch, `dev` only |

### Coverage floors

- Backend: `--cov-fail-under` in the `Backend Coverage` job (mirrored in
  `test_backend.sh`).
- Frontend: `coverage.thresholds` in `frontend/vitest.config.ts`.

Keep the floors about one point below measured coverage, and raise them when
coverage improves.

### Fixing CI Failures

**Backend lint failures:**
```bash
ruff check --fix backend/
ruff format backend/
```

**Frontend lint failures:**
```bash
cd frontend
npm run lint -- --fix
```

**Frontend type errors:**
```bash
cd frontend
npx tsc --noEmit
# Fix the errors shown
```

**Frontend test failures:**
```bash
cd frontend
npm run test:run       # Vitest + coverage thresholds + i18n parity
npm run test:browser   # Playwright (run `npm run setup:browser` once)
```

**Backend test or coverage failures:**
```bash
cd backend
../venv/bin/python -m pytest tests/ -n auto --cov=app --cov-report=term-missing:skip-covered
```

## CODEOWNERS

The `CODEOWNERS` file automatically requests reviews from `@EdwardChamberlain` for all changes.

To add more code owners:
1. Edit `.github/CODEOWNERS`
2. Add GitHub usernames with `@` prefix
3. Assign specific paths to specific owners

## Release Process

1. Update `VERSION` on `dev` and run `python scripts/check_version.py`.
2. Open a release PR from `dev` to `main`.
3. Wait for `Release PR Route`, `Release Version`, and the normal CI checks to pass.
   `Release Version` requires a stable `X.Y.Z` value greater than the current
   `main` version and validates the repository's version metadata.
4. Merge the release PR. CI runs again for the resulting `main` commit.
5. After that CI run succeeds, the Docker Publish workflow builds the tested
   commit and publishes both of these GHCR tags:
   - `latest`
   - `X.Y.Z`, using the version in `VERSION`
6. After the Docker Publish workflow completes successfully, Create GitHub
   Release verifies that the GHCR publication job succeeded, creates the
   lightweight Git tag `vX.Y.Z` at the deployed commit, and publishes a GitHub
   Release with generated notes, the deployed commit SHA, and upgrade guidance.
   Docker Publish uploads a 90-day metadata artifact after pushing the
   image; it records the source branch, SHA, and version so the release workflow
   can verify the image came from `main` even though Docker Publish itself runs
   from the default branch. The Git tag stays matched to the image if `main`
   advances before the downstream workflow runs.

The source tag convention is `vX.Y.Z`. This is separate from the bare `X.Y.Z`
GHCR version tag; the development `:dev` publisher does not create stable tags
or releases.

### First release check

Before the first public release, require the `Release Workflow Tests` check to
pass. It exercises successful publication, version validation, release-note
generation, tag conflicts, and reruns against a fake GitHub API, without
creating a real tag or release. To inspect a real deployment candidate without
publishing anything, manually run `Create GitHub Release` from `main` and enter
the successful `Docker Publish` workflow run ID. The dry run checks the
publisher workflow and image-push step, validates the deployed source branch,
commit, and version, and prints the planned tag and upgrade guidance. GitHub
generates release notes when publishing; the dry run uses read-only permission
and does not call the release-notes API or write a tag or release.

### Reruns and recovery

If tag creation succeeds but release creation or update fails, rerun the failed
`Create GitHub Release` workflow run while its publisher metadata artifact is
available (90 days). It verifies that the existing `vX.Y.Z` tag still points
to the deployed commit, then creates or updates the release. Repeated runs
update the same release and do not create duplicate releases.
If a version tag already points at another commit, the workflow stops without
moving the tag or publishing a release. Treat that as a release-integrity
failure: verify which commit was deployed and resolve the version before
retrying; never force-move a published version tag.

The GitHub Release body records the deployed full commit SHA and `VERSION`,
links the stable GHCR tags, and points to the backup, upgrade, and database
migration instructions in `UPDATING.md`.

## Dependabot (Optional)

To enable automated dependency updates, create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "pip"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      python-dependencies:
        patterns:
          - "*"

  - package-ecosystem: "npm"
    directory: "/frontend"
    schedule:
      interval: "weekly"
    groups:
      npm-dependencies:
        patterns:
          - "*"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```
