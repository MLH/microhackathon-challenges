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
Plugin; `skills/start-challenge/SKILL.md` guides Pi. There is no challenge-owned
`mcp.json`: boothstrap provides `report_step` and `session_info` through its
own session MCP configuration.

The optional `setup` and `cleanup` hooks create a welcome note and remove a
challenge-owned state marker. They do **not** wipe `hello.txt` or the session:
boothstrap owns the session reset.

### Offline checks

Requires Node 26 or later and a POSIX shell; no npm install, credentials, or
model calls are needed.

```sh
node --test test/hello-world.test.mjs
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
  --skill "$repo/hello-world/skills/start-challenge/SKILL.md" \
  '/skill:start-challenge'
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
   the `start-challenge` skill in Pi.
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

## Local Vibe Coding

[`local-vibe-coding/`](local-vibe-coding/) turns a four-blank Mad Libs prompt
into a small web app. Make up the Theme, Subject, Audience, and Style yourself,
or roll physical d6/d6/d20/d20 dice and look up the results in the
[`dice sheet`](local-vibe-coding/dice-sheet.md). The sheet uses Vibecannon's
existing four tables; rolling is entirely optional. Pi creates one
self-contained `index.html`, you try it at a localhost URL, then ask for one
improvement and try again. Nothing is published.

### Run standalone

Install Pi and configure access to `google/gemini-3.8-flash`. From the repo
root, with an interactive terminal:

```sh
./local-vibe-coding/install
./local-vibe-coding/run
```

The launcher prints the workspace and preview URL and starts the guide
automatically. After Pi's welcome, a four-field form opens: Tab/Shift+Tab
move between fields, Enter advances to Build, and Build sends the previewed
prompt. Esc returns to chat without sending; `/mad-libs` reopens the form.
You can also type the complete sentence in Pi's ordinary editor. The physical
dice options are copied into the workspace as `dice-sheet.md`. Open the fixed
preview URL (`http://127.0.0.1:4321/`) in a browser yourself. If that port is
occupied, setup fails without stopping the other listener. On exit the
launcher stops only its own preview and keeps the app and saved Pi conversation
in the printed scratch root. It does **not** delete that folder;
inspect it and remove it yourself when appropriate. This is a manual,
potentially billable Pi run. Your submitted idea goes to the configured model;
the app and conversation stay in local scratch storage. `node --test` and the
syntax checks below never invoke a model.

Plain Pi has your normal filesystem and shell permissions. Run this only as a
supervised development activity on a machine you trust, not as an unattended
public kiosk. Do not enter secrets into the prompt. The package declares a
browser challenge, but boothstrap's browser launch and Pi extension-loading
contract are still under development; this local test is not a station trial.

```sh
node --test
sh -n hello-world/setup hello-world/cleanup \
  local-vibe-coding/setup local-vibe-coding/cleanup local-vibe-coding/install
bash -n local-vibe-coding/run
node --check local-vibe-coding/preview.mjs
node --check local-vibe-coding/mad-libs.mjs
node --check local-vibe-coding/prompt-flow.mjs
```
