# microhackathon-challenges

Portable challenge packages for MLH microhackathons.

## Challenges

Each top-level directory is one challenge package, named after its `id`. Every
row links to the package's own README.

| Challenge | Description |
| --- | --- |
| None yet. | |

Challenges follow the contract in boothstrap.sh's challenge spec and
authoring guide; agents working here start from [AGENTS.md](AGENTS.md).

## Checks

CI runs on every pull request and on every push to `main`, on Ubuntu with
Node 26. It runs `npm ci`, then:

- `npm run verify`: runs `boothstrap dev --verify` on every package and fails
  when two packages share an id.
- `npm test`: the repo's own tests (`test/*.test.mjs`), which run offline with
  no model calls or credentials.
- `npm run lint`: markdownlint over every Markdown file.

To run them locally, use Node ≥ 26.4 and, from the repository root:

```bash
npm ci
npm run verify
npm test
npm run lint
```

A package's dependencies install through its own `install` hook, never at the
root.

## Docs

- [docs/cloud-agents.md](docs/cloud-agents.md): set up a cloud agent.
- [docs/style/development.md](docs/style/development.md): code style.
- [docs/style/markdown.md](docs/style/markdown.md): Markdown style.
- [docs/style/testing.md](docs/style/testing.md): test style.
