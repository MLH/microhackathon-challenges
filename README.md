# microhackathon-challenges

Portable challenge packages for MLH microhackathons.

## Challenges

Packages live under `challenges/`, one directory per package, named after its
`id`; grouping folders such as `challenges/beginner/<id>` also work. Every row
links to the package's own README.

| Challenge | Description |
| --- | --- |
| [hello-world](challenges/hello-world/README.md) | Meet your AI guide and make your first file. |
| [vibe-coding-mad-libs](challenges/vibe-coding-mad-libs/README.md) | Fill four blanks, and Pi builds the web app you described. |
| [birdsbirdbirds](challenges/birdsbirdbirds/README.md) | Draw a bird and watch it fly across the sky. |
| [glitch-invaders](challenges/glitch-invaders/README.md) | Shoot the bugs, then debug the three that fight back using Sentry evidence. |

Challenges follow the contract in boothstrap.sh's challenge spec and
authoring guide; agents working here start from [AGENTS.md](AGENTS.md).

## Checks

CI runs on every pull request and on every push to `main`, on Ubuntu with
Node 26. It runs `npm ci`, then:

- `npm run verify`: runs `boothstrap dev --verify` on every package under
  `challenges/` and fails when two packages share an id or a package sits at
  the repo root or in another top-level directory instead of under
  `challenges/`.
- `npm test`: the tests (`test/*.test.mjs`); their rules are in
  [docs/style/testing.md](docs/style/testing.md).
- `npm run lint`: markdownlint over every Markdown file.

To run them locally, use Node ≥ 26.4 and, from the repository root:

```bash
npm ci
npm run verify
npm test
npm run lint
```

To try one package alone, run `npx boothstrap dev challenges/hello-world`. A
package's dependencies install through its own `install` hook, never at the
root.

## Docs

- [docs/cloud-agents.md](docs/cloud-agents.md): set up a cloud agent.
- [docs/style/development.md](docs/style/development.md): code style.
- [docs/style/markdown.md](docs/style/markdown.md): Markdown style.
- [docs/style/testing.md](docs/style/testing.md): test style.
