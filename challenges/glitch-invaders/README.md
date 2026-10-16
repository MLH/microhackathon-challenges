# Glitch Invaders: On-Call

Fly a patch drone in Chrome, trigger three intentional bugs while defending the
cluster, and debug each one with Sentry telemetry and Pi. Each failure opens an
Incident Console with a stack trace, breadcrumbs, or a performance trace, asks
for the root cause, and applies your chosen patch so you can watch the fix work
in play.

## Files

| File | Purpose |
| --- | --- |
| `challenge.json`, `plugin.json` | Manifest and Agent Plugin metadata |
| `intro.md` | Intro screen text |
| `skills/start-challenge/SKILL.md` | The guide Pi follows |
| `monitor/SKILL.md` | Headless browser monitor skill |
| `setup`, `cleanup` | Start and stop the server (`server/setup.mjs`, `server/cleanup.mjs`) |
| `server/` | Local page server on `127.0.0.1:4373` and live-config resolver |
| `shared/` | Progress and runtime configuration validators |
| `game/` | Browser arcade game, Incident Console, and Sentry envelope reporter |

There is no `install` hook: the package has no dependencies beyond Node and browser
ES modules.

## How steps advance

The browser game writes `#boothstrap-state` with a single-line marker such as:

```text
glitch-state v1 launched=yes weapon=repaired shield=unseen boss=unseen completed=no mode=demo
```

The headless monitor reads that marker from the page's accessibility tree and
reports `launch-game`, `fix-weapon`, `fix-shield`, and `fix-boss` as each step
reaches `yes` or `repaired`. The game also saves `glitch-progress.json` in the
workspace so Pi can see which bug and stage (`unseen`, `encountered`,
`investigated`, `repaired`) the participant is on and emit non-PII milestone
events. Once all three bugs are `repaired`, Pi asks which telemetry clue helped
most and reports `debrief`.

The server listens on port 4373. Set `GLITCH_PORT` to use another port, though
the challenge manifest expects 4373.

## Modes

- **Demo** (default): needs no Sentry credentials and renders deterministic
  simulated evidence in the Incident Console.
- **Live**: sends real error events (`WeaponConfigError`, `GameLogicError`) and
  a `boss-spawn` performance trace to Sentry over HTTP envelopes, and links
  directly to the issue or trace in Sentry. Set `GLITCH_SENTRY_DSN`,
  `GLITCH_SENTRY_ORG`, and `GLITCH_SENTRY_PROJECT` (plus optional
  `GLITCH_SENTRY_ENVIRONMENT`) in the environment, `.env`, or
  `live.config.json`. Set `GLITCH_MODE=demo` to force demo mode.

## Run without boothstrap

Needs Node 26 and a `GEMINI_API_KEY`. Follow the standalone steps in
boothstrap.sh's `docs/authoring-challenges.md` to install Pi and load the
package as an Agent Plugin, then:

```sh
challenge=/absolute/path/to/glitch-invaders
mkdir /tmp/my-glitch-run && cd /tmp/my-glitch-run
"$challenge"/setup
```

Open `http://127.0.0.1:4373/`, then start Pi in the same folder:

```sh
pi --model google/gemini-3.8-flash \
  --skill "$challenge"/skills/start-challenge/SKILL.md \
  '/skill:start-challenge'
```

When done:

```sh
"$challenge"/cleanup
```

`cleanup` stops the server and removes `.glitch/` and `glitch-progress.json`.
Without boothstrap there is no `report_step` or `emit_event`, so the skill
acknowledges finished steps in plain words.
