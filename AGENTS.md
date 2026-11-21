# Agent instructions

Instructions for AI coding agents (Claude Code, Codex and others) working in
this repository. `CLAUDE.md` only points here, so this is the one agent file.

Anything a human contributor would also need (setup, branching model, commit
style, code style, testing, CI, coverage floors, PRs) lives in
[CONTRIBUTING.md](CONTRIBUTING.md). Read it before you start; this file only
adds what is specific to agents.

## GitHub is the source of truth

- **Work to an issue.** The issue captures intent and the PR captures the
  implementation, so find the issue before you start and link it from the PR
  (`Fixes #123`). If you are asked to do a task that has no issue, raise one
  first (the problem, the scope and what done looks like) so the work is
  tracked, and tell the user.
- **Keep state on GitHub.** Decisions, findings and follow-ups belong in the
  issue, the PR description or PR comments, not only in chat or local files,
  which are lost when the session ends. Raise an issue for anything out of scope
  that you notice. If GitHub and your notes disagree, GitHub wins.

## Branch names

Name branches `<agent>/<type>/<short-kebab-summary>`, where `<agent>` is the
agent responsible for the work: `claude/` for Claude, `codex/` for Codex, and so
on. Use your own name, never another agent's. Types and the summary format are
in [Branch Naming](CONTRIBUTING.md#branch-naming).

```text
claude/feat/spool-usage-chart
claude/scratch/mqtt-reconnect-investigation
codex/fix/queue-bulk-delete-403
```

Never use random or generated names such as `claude/trusting-edison-11syu7`. If
the environment assigns a branch name you cannot change, use it and put the
description in the PR title instead.

## Pull requests

- Open PRs as regular PRs, never as drafts, even if a tool or environment
  defaults to draft. See
  [Opening the Pull Request](CONTRIBUTING.md#opening-the-pull-request).
- Approve or merge a PR only when the user has explicitly asked you to do so for
  that PR. Consent for one PR does not carry over to the next.

## Before you push

Work through the [pre-push checklist](CONTRIBUTING.md#pre-push-checklist) and
write commit messages in the [conventional style](CONTRIBUTING.md#commit-messages).
The two items agents most often miss:

- **Changelog:** add a bullet under `## Unreleased` in `CHANGELOG.md` for any
  user-visible change ([Changelog](CONTRIBUTING.md#changelog)).
- **User-facing strings:** add each new string to every locale file, never
  hardcode visible text ([i18n](CONTRIBUTING.md#internationalization-i18n)).

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
