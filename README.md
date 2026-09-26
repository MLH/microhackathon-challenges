# microhackathon-challenges

Portable challenge packages for MLH microhackathons. Each challenge is a
top-level directory. An event config pins this repository to a commit and
lists the challenge directories offered by a boothstrap station.

The author-facing contract is in
[boothstrap's challenge spec](https://github.com/MLH/boothstrap.sh/blob/main/docs/specs/2026-09-26-mvp-challenge-spec.md).

## Hello, World

[`hello-world/`](hello-world/) is a two-step terminal challenge: meet Pi and
create a file containing `Hello, world!`. Its `challenge.json` is for
boothstrap (steps, model, points); `plugin.json` identifies the portable Agent
Plugin; `skills/hello-world/SKILL.md` guides Pi. There is no challenge-owned
`mcp.json`: boothstrap provides `report_step` and `session_info` through its
own session MCP configuration.

The optional `setup` and `cleanup` hooks create a welcome note and remove a
challenge-owned state marker. They do **not** wipe `hello.txt` or the session:
boothstrap owns the session reset.

### Offline checks

Requires Node 26 or later and a POSIX shell; no npm install, credentials, or
model calls are needed.

```sh
node --test
sh -n hello-world/setup hello-world/cleanup
```

These checks cover the package's basic shape and hook behavior, not the full
external Agent Plugins schema or a live Pi run.

### Run in plain Pi

Pi must be installed and configured with access to the manifest's model. This
is a manual, potentially billable run; the offline checks above never run it.
From this repository root:

```sh
repo=$PWD
workspace=$(mktemp -d)
cd "$workspace"
"$repo/hello-world/setup"
pi --model google/gemini-3.8-flash \
  --skill "$repo/hello-world/skills/hello-world/SKILL.md" \
  '/skill:hello-world'
"$repo/hello-world/cleanup"
```

Pi starts the guide immediately; you do not need to type the skill command.
With no boothstrap MCP, the skill acknowledges completed steps in chat; it
cannot award points. The hooks use the current directory when
`BOOTHSTRAP_WORKSPACE` is unset. The scratch workspace remains after this
example so you can inspect `hello.txt`; remove it when you are done.

### Boothstrap integration checklist (pending)

The boothstrap runtime is being developed separately. Once it exists, use a
throwaway test station and an explicitly approved live model run to check:

1. Pin a repo ref that contains `hello-world` in the event config. Confirm the
   portal shows its intro, two steps, and 50 points, then launches and primes
   the `hello-world` skill in Pi.
2. Complete both steps. Confirm each `report_step` updates the checklist and
   Finish stays locked until both are done. Finish and confirm the cleanup
   marker is gone but `hello.txt` still exists until session reset.
3. End the session. Confirm boothstrap removes the session root (including
   `welcome.txt` and `hello.txt`), verifies the reset, and starts the next
   participant with a fresh workspace. The challenge package must remain.
4. Repeat with Leave (then explicitly end the session), idle timeout, and
   kill-and-relaunch recovery during an active attempt. Confirm cleanup is
   safe to repeat and no prior workspace files remain after the verified
   reset. Check token revocation, process termination, clipboard, scrollback,
   and Downloads/Desktop sweeps in the boothstrap integration suite—not in
   this package's offline tests.

No boothstrap reset behavior has been verified by this repository yet.
