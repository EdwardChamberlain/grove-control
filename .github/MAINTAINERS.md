# Maintainer Guide

This document provides setup instructions for repository maintainers.

## Branch Protection Setup

To protect the `main` branch, go to **Settings > Rules > Rulesets > New ruleset > New branch ruleset**.

### Step 1: Basic Settings

| Field | Value |
|-------|-------|
| Ruleset name | `Protect main` |
| Enforcement status | `Active` |

### Step 2: Bypass List (optional)

Add yourself to bypass if you want to push directly in emergencies.
Set "Always" or "Pull requests only" based on preference.

### Step 3: Target Branches

Click **Add target** > **Include by pattern** and enter: `main`

### Step 4: Branch Rules

Enable these rules:

**Restrict deletions** - Prevents branch deletion

**Require a pull request before merging**
- Required approvals: `1`
- [x] Dismiss stale pull request approvals when new commits are pushed
- [ ] Require review from Code Owners (optional)
- [x] Require approval of the most recent reviewable push

**Require status checks to pass**
- [x] Require branches to be up to date before merging
- Add these status checks (they appear after CI runs once):
  - `Release PR Route`
  - `Release Version`
  - `Backend Lint`
  - `Backend Tests`
  - `Frontend Lint`
  - `Frontend Type Check`
  - `Frontend Tests`
  - `Frontend Build`
  - `Docker Build`

**Block force pushes** - Prevents history rewriting

### Optional (stricter)

- [ ] Require conversation resolution before merging
- [ ] Require signed commits
- [ ] Require linear history

## CI Workflow

The CI workflow (`.github/workflows/ci.yml`) runs on:
- All pull requests to `main`
- All pushes to `main`

### Jobs

| Job | Purpose | Required for PR |
|-----|---------|-----------------|
| `backend-lint` | Ruff linting + format check | Yes |
| `backend-tests` | Unit tests | Yes |
| `frontend-lint` | ESLint | Yes |
| `frontend-typecheck` | TypeScript compilation | Yes |
| `frontend-tests` | Vitest unit tests | Yes |
| `frontend-build` | Vite production build | Yes |
| `docker-build` | Docker image builds | Yes |

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
npm run test:run
# Fix failing tests
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
   image; the release workflow uses its source SHA and version so the Git tag
   matches the image even if `main` advances before the downstream workflow runs.

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
publisher workflow and image-push step, validates the deployed commit and
version, and prints the planned tag and release notes; it never writes a tag or
release.

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
