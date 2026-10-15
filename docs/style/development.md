# Development style

Read this guide, then the topic guide for the file you're changing:
[testing](testing.md) or [Markdown](markdown.md). The code is plain JavaScript
(`.mjs`, ES modules) on Node, with no build step and no type checker; other
languages and formats follow the nearest existing file of that kind. Challenge
packages follow the contract in boothstrap.sh's
`docs/specs/2026-09-26-mvp-challenge-spec.md`, which wins over anything here.

## Core values

- **Self-documenting above all; it wins any conflict.** Prefer a clearer name
  or smaller unit to a comment, so the code carries the meaning and never
  surprises a reader.
- **Readability trumps compactness.** Separate logical beats with whitespace,
  especially guard clauses and the return.
- **Rigor scales with lifespan.** Maintained code meets the full standard.
  Genuine throwaway code may relax typing and tests only.
- **No backwards compatibility before 1.0.0.** Change or remove anything, with
  no shims, deprecations, or migrations.

## Comments and documentation

- **Inline comments earn their place only two ways:** explain **why**, never
  what, or warn of a non-obvious ordering, side-effect, or keep-in-sync trap.
- **No section-header comments, and none that restate code.** Extract the
  region into a named unit.
- **Never comment to skip a lint or type check.** Fix the issue, or change an
  incorrect rule in tool configuration; never suppress inline or per file.
- **Comments and undated docs describe the current state.** Leave out issue,
  PR, and requirement IDs, commits, dates, history, and who decided what; they
  belong in git, PRs, and dated docs. Cite an open issue only as a pointer to
  pending work.
- **Document every module and function, including private
  helpers.** A line suffices for a trivial contract; otherwise cover inputs,
  outputs, and errors.

## Naming

- **Always use fully descriptive names.** No single-letter names, including
  callback parameters and iterators. Use `_` only for a genuinely unused value.
- **A file doesn't repeat its folder's name:** `session/root.mjs`, not
  `session/session-root.mjs`.

## Structure and organization

- **Split by responsibility and cohesion, never line count.**
- **Package by feature, not layer.** Keep a capability's data, behavior, and
  boundary together; avoid generic `models/` and `utils/` buckets.
- **Imports go at the top of the file, always,** ordered standard library,
  external, then local. Import inside a function only when it is absolutely
  required or the alternative is extremely inconvenient.
- **Match the paradigm to the problem.** Pipelines for transforms, stateful
  types for services, procedural code for scripts.
- **Reject mutation and immutability dogma.** Choose what reads clearest; never
  surprise-mutate a caller's value.

## Errors and observability

- **Fail fast and loud.** Validate boundaries and fail early with a clear
  message. Don't catch what you can't handle, swallow failures, silently fall
  back, or encode errors as empty values.
- **Catch at the user-facing boundary.** The outermost layer emits a clean
  message and an unsuccessful status; detailed diagnostics wait for a debug or
  verbose mode.
- **Keep logging minimal.** Log only what the failure wouldn't surface.
  Progress and results are product output held to a UX bar.

## Design

- **DRY early.** Extract the second copy into one source of truth. Un-DRY only
  when copies diverge in reason to change.
- **Keep signatures small.** Group growing related parameters into an options
  object so call sites name each argument.
- **Name reused or tunable constants.** Leave obvious one-off literals inline.
- **Names carry the real domain.** Don't erase structure into strings or
  loose maps; parse input at the boundary into objects with named fields.

## Tooling and documentation

- **Tool-driven.** `npm run lint` checks Markdown, `npm run verify` checks
  every challenge package with the validator stations run, and `npm test`
  checks the repo's own tools. Encode disputed rules in configuration, not
  review. Gates, commits, and landing are in [AGENTS.md](../../AGENTS.md).
- **Package dependencies stay in the package.** A package installs what it
  needs through its own `install` hook; nothing is added at the repo root
  beyond the pinned validator.
- **The README is the front door:** orientation, quick start, and the docs
  index. Subsystem guidance goes in focused `docs/` files, one topic each.
- **A doc that lies is worse than none.** Fix or delete docs that drift from
  code.
