# Cloud agents

Set up a Linux cloud VM so a coding agent can build and verify this repo.

## What the VM needs

- **Node ≥ 26.4,** installed beside the image's own.
- **Network access** to `nodejs.org` (the setup script) and
  `registry.npmjs.org` (`npm ci` and `npm run lint`). Allow
  `codeload.github.com` only if a test needs it.
- **No secrets.** `npm run verify`, `npm test`, and `npm run lint` need no
  credentials. `GEMINI_API_KEY` is optional, only for a manual standalone
  playthrough of a package with `boothstrap dev`; no check reads it. That
  playthrough also needs `generativelanguage.googleapis.com`, the Gemini API
  host.
- **boothstrap.sh, read-only,** attached to the session when the task needs
  the challenge spec or authoring guide: `MLH/boothstrap.sh` is internal.

## 1. Setup script

Paste this into the service's setup-script field. It runs as root, installs
Node 26 into `/opt/node26` with its checksum verified, and is safe to run
twice. A failed download exits non-zero and stops the session, since a
session without its tools can't verify anything.

```bash
#!/bin/bash
set -euo pipefail

NODE_DIR=/opt/node26
RELEASES=https://nodejs.org/dist/latest-v26.x

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

# Node's Linux binaries link against libatomic, which minimal images omit.
if ! ldconfig -p | grep -q 'libatomic\.so\.1'; then
  apt-get update -qq && apt-get install -y -qq libatomic1
fi

if [ ! -x "$NODE_DIR/bin/node" ]; then
  download_dir="$(mktemp -d)"
  cd "$download_dir"
  curl -fsSLO "$RELEASES/SHASUMS256.txt"
  tarball="$(awk -v name="linux-$arch.tar.xz" '$2 ~ name "$" { print $2 }' SHASUMS256.txt)"
  curl -fsSLO "$RELEASES/$tarball"
  grep " $tarball\$" SHASUMS256.txt | sha256sum -c -
  mkdir -p "$NODE_DIR"
  tar -xJf "$tarball" -C "$NODE_DIR" --strip-components=1
  cd /
  rm -rf "$download_dir"
fi

ln -sf "$NODE_DIR/bin/node" "$NODE_DIR/bin/npm" "$NODE_DIR/bin/npx" /usr/local/bin/
"$NODE_DIR/bin/node" --version
```

## 2. Each session

Dependencies track the lockfile, which changes after the image is cached, so
install them in each session from the repository root:

```bash
node --version
npm ci
```

A package's own dependencies are not installed here; each package's `install`
hook handles them. If `node --version` prints something older than 26.4,
prefix each command that reaches Node with `PATH="/opt/node26/bin:$PATH"`,
since agent shells may drop an `export` between commands.

## 3. Verify

```bash
npm run verify
npm test
npm run lint
```

All three pass without credentials once steps 1 and 2 are done.

## Claude Code on the web

Configure the environment at [claude.ai/code](https://claude.ai/code); the
[cloud environments](https://code.claude.com/docs/en/cloud-environments) page
is the reference.

- **Setup script:** paste step 1. Its result is cached for later sessions
  until the script or network settings change. Keep it under about five
  minutes.
- **Node on `PATH`:** the image's own Node comes first on `PATH`. The
  SessionStart hook
  [`claude-cloud-node26-path.sh`](../.claude/hooks/claude-cloud-node26-path.sh)
  puts Node 26 first in cloud sessions only.
- **Network access:** the default **Trusted** level allows `nodejs.org` and
  `registry.npmjs.org`. Unless the level is **Full**, also allow
  `codeload.github.com` if a test comes to need it.
- **Gemini API host:** the checks never need it. For a manual playthrough,
  allow `generativelanguage.googleapis.com` unless the level is **Full** or
  already covers it.
- **Environment variables:** leave them empty. Add `GEMINI_API_KEY` only for a
  manual standalone playthrough; the checks never read it. Anyone who can use
  the environment can read its variables, `GEMINI_API_KEY` included.

### Orchestrating cloud sessions

One cloud session can work a milestone: it hands each issue to a worker
session and reviews the pull requests, through the `claude-cloud-orchestrator`
and `claude-cloud-worker` skills from the `core` plugin of
[theycallmeswift/skills](https://github.com/theycallmeswift/skills), which
[`.claude/settings.json`](../.claude/settings.json) enables. Neither skill
depends on this repository; its own values, such as who PRs go to, the
`needs-human` skip, the one-`lockfile`-PR limit, and the cap of three workers,
live in the
[`claude-cloud-orchestrate-milestone`](../.claude/skills/claude-cloud-orchestrate-milestone/SKILL.md)
adapter.
