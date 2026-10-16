# microhackathon-challenges

Portable challenge packages for MLH microhackathons. Each package under
`challenges/` is one challenge package that boothstrap.sh stations and
`boothstrap dev` can run. The repo is plain JavaScript (`.mjs`) on Node 26, and
every PR is checked by the same package validator stations run.

## Autonomy

- **Freely reversible: just do it.** Edits, local commands, scratch files,
  branches.
- **Consequential: state intent, then proceed.** Pushing a branch, opening a
  PR, adding a dependency.
- **Irreversible: always confirm first.** Force-pushes, deleting branches
  or data, anything posted outside the repo.

## Decision principles

- **Propose, then confirm.** For design choices, present 2–3 options with a
  recommendation before writing code.
- **Action over asking.** Exhaust reversible options (read the code, run a
  small experiment) before asking.
- **Simple over clever.** Question whether a concept needs to exist before
  adding one.
- **Concise over verbose.** Lead with the point; cut preamble.

## Conventions

- Ask one question at a time.
- Follow existing patterns in the file you're touching.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Before claiming work is done, run `npm run verify`, `npm test`, and
  `npm run lint` and show the output.
- Keep `docs/` current: read the relevant doc before changing architecture,
  and update it in the same PR.

## Challenge packages

- Each directory under `challenges/` holding a `challenge.json` is one
  package, named after its `id`; grouping folders such as
  `challenges/beginner/<id>` are allowed. Event configs list `challenges/<id>`
  (or the nested path). A `challenge.json` at the repo root, directly in
  `challenges/`, or in another top-level directory fails verify.
  No two packages share an id.
- The contract is boothstrap.sh's `docs/specs/2026-09-26-mvp-challenge-spec.md`,
  with `docs/authoring-challenges.md` for the workflow. The spec wins over this
  repo's docs. boothstrap.sh is internal: in a cloud session, attach
  `MLH/boothstrap.sh` read-only to read them.
- Each package's standalone Pi run must keep working, so check a change
  against the authoring guide's standalone flow.
- A package's dependencies install through its own `install` hook, never at
  the repo root. The root `package.json` has one devDependency,
  `@mlhacks/boothstrap`, pinned exactly; bumping it is a one-line PR.
- In-repo symlinks are followed: a symlinked directory under `challenges/`
  holding a `challenge.json` is a package. A symlink at the repo root or under
  `challenges/` that is absolute, dangling, looping, or points outside the
  repo fails verify, as the station refuses it. `npm run lint` also lints
  Markdown inside packages, so the house Markdown rules apply there.
- `npm run verify` runs `boothstrap dev --verify` on every package. Add no rule
  the station doesn't enforce.
- Test rules, including the network rule, are in
  [docs/style/testing.md](docs/style/testing.md).

## Environment

- Needs Node ≥ 26.4. In Claude Code cloud sessions, a SessionStart hook puts
  `/opt/node26/bin` first on `PATH`. Elsewhere, if `node -v` is older and
  `/opt/node26/bin` exists, prefix every `node`, `npm`, and `npx` command with
  `PATH="/opt/node26/bin:$PATH"`. Why: shell state, including `export`, may
  not persist between commands.
- Run `npm ci` when `node_modules` is missing or `package-lock.json` changed.
- `npm run lint` runs markdownlint through `npx`, so it needs the registry.
- `npm run verify` and `npm test` need no credentials. Cloud setup:
  `docs/cloud-agents.md`.

## Landing changes

- Open every PR as a draft from `.github/pull_request_template.md`. Mark it
  ready yourself once every Ready gate row has evidence. If CI fails after
  that, convert it back to a draft, fix it, and mark it ready again.
- The PR body carries no process narrative and no line-number citations.
- Every PR lands on `main` as one squash commit, through GitHub's merge only.
  Never push to or rewrite `main`. Update a branch by merging `main` into
  it, since `.claude/settings.json` denies force-pushes; the squash keeps
  history linear.

## Project structure

- `challenges/<id>/`: one challenge package per directory, with a
  `challenge.json` and its own `README.md`.
- `tools/`: scripts run with `node`; `verify.mjs` runs the validator over every
  package.
- `test/`: `*.test.mjs` files, run by `npm test` through
  `node --test 'test/*.test.mjs'`. `test/<id>.test.mjs` covers each challenge
  package's hooks, servers, and extensions; `test/verify.test.mjs` covers
  `tools/verify.mjs`. `test/fixtures/` holds fixture repos, whose Markdown is
  test data.
- `docs/*.md`: undated guides, one per feature or setup, indexed in
  `README.md`.
- `docs/style/`: how code, tests, and docs are written.
- `.claude/`: Claude Code settings, the Node `PATH` hook, and the
  `claude-cloud-orchestrate-milestone` adapter skill.
- `.github/`: the CI workflow and the PR template.

## References

Load on demand, not at session start.

- `docs/style/development.md`: code style. Read before changing source, tests,
  or docs, then the guide it names.
- `docs/cloud-agents.md`: cloud agent setup.
- `README.md`: human-facing overview and the index of challenges.
