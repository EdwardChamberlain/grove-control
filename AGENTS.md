# Agent instructions

Instructions for AI coding agents (Claude Code, Codex and others) working in
this repository. `CLAUDE.md` only points here, so this is the one agent file.

Anything a human contributor would also need (setup, branching model, commit
style, code style, testing, CI, coverage floors, PRs) lives in
[CONTRIBUTING.md](CONTRIBUTING.md). Read it before you start; this file only
adds what is specific to agents.

## Branch names

Name branches `<agent>/<type>/<short-kebab-summary>`, where `<agent>` is the
agent responsible for the work: `claude/` for Claude, `codex/` for Codex, and so
on. Use the agent's own name, never another agent's. Types and the summary
format are in [Branch Naming](CONTRIBUTING.md#branch-naming).

```text
claude/feat/spool-usage-chart
claude/scratch/mqtt-reconnect-investigation
codex/fix/queue-bulk-delete-403
```

Never use random or generated names such as `claude/trusting-edison-11syu7`. If
the environment assigns a branch name you cannot change, use it and put the
description in the PR title instead.

## Pull requests

- Raise PRs as **open**, never as drafts, even if a tool or environment
  defaults to draft. A PR is either ready to be raised or it isn't; if it isn't
  ready, keep working on the branch.
- Target `dev`, and fill in the PR template.
- Never approve or merge a PR.

## Before you push

Work through the [pre-push checklist](CONTRIBUTING.md#pre-push-checklist). The
two items agents most often miss:

- **Changelog:** a user-visible change needs a bullet under `## Unreleased` in
  `CHANGELOG.md` in the same PR. See [Changelog](CONTRIBUTING.md#changelog).
- **User-facing strings:** add every new string to **every** locale file in
  `frontend/src/i18n/locales/`, then run `npm run check:i18n`. Never hardcode
  visible text.

Write commit messages in the conventional style described in
[Commit Messages](CONTRIBUTING.md#commit-messages).

## When to stop and ask

Ask the user before you:

- lower a coverage floor, add a coverage exclusion, or skip, disable or delete a
  test to get a check passing;
- change CI workflows (`.github/workflows/`), release tooling, `VERSION`, or
  the security-advisory allowances;
- add, remove or upgrade a dependency;
- change the database schema or migrations, or the authentication and
  permission model;
- do anything destructive or hard to reverse: force-pushing a branch you did
  not create, deleting branches or data, rewriting shared history;
- expand the scope beyond what was asked, or when the request conflicts with
  something in these docs.

If a request is ambiguous in a way that changes what you would build, ask
instead of guessing.
