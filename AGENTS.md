# Agent instructions

Before working in this repository, read and follow [CLAUDE.md](CLAUDE.md) for
the shared repository-specific instructions.

## Naming branches

Name every branch after the work it carries, in the form
`claude/<type>/<short-kebab-summary>` (for example `claude/feat/spool-usage-chart`
or `claude/scratch/mqtt-reconnect-investigation`), so a reader can tell what
it is from the branch list alone. Do not use random or generated names. The
full convention and the list of types are in [CLAUDE.md](CLAUDE.md).

## Keeping branches up to date

Never merge `dev` (or `main`) into a feature branch. Always rebase it instead:
`git fetch origin && git rebase origin/dev`, then `git push --force-with-lease`.
Do not create merge commits to catch up with the base branch, and when
branches are stacked, rebase each one onto its base in turn (use
`git rebase --onto` if the base was squashed or rebased).
