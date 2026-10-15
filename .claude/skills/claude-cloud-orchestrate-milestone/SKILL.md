---
name: claude-cloud-orchestrate-milestone
description: microhackathon-challenges' adapter for the claude-cloud-* skills. Work through every open issue in a GitHub milestone with claude-cloud-orchestrator workers until each has a PR ready for review. Run in a Claude Code cloud session. Other repositories write their own adapter.
argument-hint: <milestone> ["notes"]
arguments: [milestone, notes]
disable-model-invocation: true
---

# Orchestrate a milestone

Orchestrate this repository's "$milestone" milestone on GitHub. Load and
follow the `claude-cloud-orchestrator` skill; the rules below add to it.

## Scope

- Your tasks are the milestone's open issues, except any labeled
  `needs-human`: skip those. This prompt is your standing assignment; don't
  wait for per-issue instructions.
- An issue is blocked until every issue whose output it uses is closed: its
  "Depends on" line plus any issue its Scope builds on. Out-of-scope mentions
  and references in the template's Working rules don't count.
- A "Depends on" line may name an issue in another repository, such as
  `MLH/boothstrap.sh#12`. That issue blocks until it is closed too; check its
  state in its own repository.
- Keep at most one open PR with the `lockfile` label.
- Run at most 3 workers at once.
- Dispatch first any issue that fixes a CI check failing on every PR, then
  whatever unblocks the most issues. Spikes usually do.
- Before your first dispatch, post the dependency order and your first three
  issues, then start.

## Worker task

Each worker's Task:

```text
Implement <issue URL>. The issue is your spec: meet its Acceptance, follow its
Working rules, stay inside its Owns paths.

Protect your context: give each subtask to a fresh subagent, picking the
model by difficulty (haiku for mechanical edits, sonnet for routine
implementation, opus for design and debugging). Before every push, have a
subagent that didn't write the code review the diff against the issue and
`docs/style/`; fix what it finds.
```

## Handoff

Hand PRs off to theycallmeswift. A check failing on every PR doesn't block
handoff if an open issue fixes it; name that issue in your message.

## Rules

- Bring these to me instead of deciding: merge conflicts whose resolution
  needs a design choice, spike findings that change a downstream issue's
  scope, and anything the repository's instructions say needs my
  confirmation.
- Challenge work reads boothstrap.sh's spec and authoring guide, which live in
  an internal repository. If your session lacks `MLH/boothstrap.sh`, attach it
  read-only with `add_repo`, and tell workers to do the same when their issue
  needs it.
- You're done when every milestone issue is closed, waits on my decision, or
  is labeled `needs-human`. Then post a status summary.
- My notes for this run, which override the rules above: $notes
