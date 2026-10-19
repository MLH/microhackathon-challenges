# Glitch Invaders: On-Call

Fly a patch drone in Chrome, trigger three intentional bugs while defending the
cluster, and debug each one with Sentry evidence and Pi. Each failure opens an
Incident Console with a stack trace, breadcrumbs, or a performance trace, asks
for the root cause, and applies your chosen patch so you can watch the fix work
in play.

The game runs in demo mode unless [live Sentry mode](#live-sentry-mode) is
set up: the Incident Console shows simulated Sentry evidence and no telemetry
leaves the machine.

## Files

| File | Purpose |
| --- | --- |
| `challenge.json`, `plugin.json` | Manifest and Agent Plugin metadata |
| `sentry.json` | Default public Sentry settings for live mode: DSN, org slug, project slug |
| `intro.md` | Intro screen text |
| `skills/start-challenge/SKILL.md` | The guide Pi follows |
| `monitor/SKILL.md` | Headless browser monitor skill |
| `setup`, `cleanup` | Start and stop the server (`server/setup.mjs`, `server/cleanup.mjs`) |
| `server/` | Local page server on `127.0.0.1:4373` |
| `shared/` | Progress validators |
| `game/` | Browser arcade game and Incident Console |

There is no `install` hook: the package has no dependencies beyond Node and
browser ES modules.

## How steps advance

The game shows a `glitch-state v1` line, and the headless monitor reports
`launch-game`, `fix-weapon`, `fix-shield`, and `fix-boss` from it, as
[monitor/SKILL.md](monitor/SKILL.md) describes. The game also saves
`glitch-progress.json` in the workspace so Pi can see which bug and stage
(`unseen`, `encountered`, `investigated`, `repaired`) the participant is on and
emit non-PII milestone events. Once all three bugs are `repaired`, Pi asks
which clue helped most and reports `debrief`.

The server listens on port 4373. Set `GLITCH_PORT` to use another port, though
the challenge manifest expects 4373.

## Live Sentry mode

Live mode needs both halves:

- **Public Sentry settings.** The DSN, org slug, and project slug are public
  values, so the package ships them in `sentry.json`. While any value there is
  still a `<placeholder>`, the game runs in demo mode. Once filled in, a
  malformed value fails setup naming it. An optional `apiUrl` replaces the
  Sentry API origin, `https://sentry.io`, with a subdomain of it or, for the
  tests' local stand-in, a loopback address; the token goes to no other host.
- **`SENTRY_AUTH_TOKEN` in the environment.** On a station, the event vault's
  `sentry` service sets it to a placeholder that the vault proxy swaps for the
  real token. `boothstrap dev` and a standalone run read the real token from
  your shell.

Sentry's own variables replace `sentry.json` when set: `SENTRY_DSN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, and optionally `SENTRY_URL` for `apiUrl`. They
pass the same checks. Setting any of the first three requires all three, and
setup fails naming the ones missing; an empty variable counts as unset. An
event points at its own Sentry project by setting them under
`challenge_env.glitch-invaders` in its config:

```json
{
  "challenge_env": {
    "glitch-invaders": {
      "SENTRY_DSN": "https://<public key>@o<org id>.ingest.us.sentry.io/<project id>",
      "SENTRY_ORG": "<org slug>",
      "SENTRY_PROJECT": "<project slug>"
    }
  }
}
```

These are public settings only: the token stays in the vault. A station
whose boothstrap predates `challenge_env` uses `sentry.json`.

`boothstrap dev` refuses to play the package unless `SENTRY_AUTH_TOKEN` or
`SENTRY_API_KEY` is set, because `vault_services` names `sentry`. Any value
keeps demo mode while the settings are placeholders, and `SENTRY_API_KEY`
satisfies dev but leaves the game in demo mode, since the package reads only
`SENTRY_AUTH_TOKEN`.

In live mode the page reports each failure to the DSN: an error event for the
weapon and the shield, and a `boss-spawn` transaction with one span per load for
the boss. The page server then reads Sentry's record of it from the Sentry API
(the issue, its stack trace or breadcrumbs, or the trace's spans) and the
Incident Console shows that, with a link to it in Sentry. The boss's
`boot_state` pills are the game's own state, labelled as such. Only requests
from the page itself are answered, and repeated requests for one report share a
single lookup. The token stays in the page server: it is never served to the
page or written anywhere. The page's CSP lets it contact only this server and
the DSN's ingest origin. If Sentry doesn't accept the report or can't return it
within about 15 seconds, that incident shows simulated evidence with a note
saying so. Setup prints `(live Sentry mode)` after the URL when live mode is on,
and a note when the settings are filled in but the token is missing.

Because `vault_services` names `sentry`, the event vault must hold a `sentry`
service, or the station lists the challenge as unavailable, on every boothstrap
version:

| Field | Value |
| --- | --- |
| Name | `sentry` |
| Auth | `bearer`, token `SENTRY_AUTH_TOKEN` |
| Host | `sentry.io` |

The token needs the `event:read`, `project:read`, and `org:read` scopes. The
station also needs a boothstrap that sets each `vault_services` credential in
the challenge's hooks. Release `0.1.0` predates that, so on it the challenge gets
no token and runs in demo mode.

## Run without boothstrap

Needs Node 26 and a `GEMINI_API_KEY`; export `SENTRY_AUTH_TOKEN` too for live
mode. The game reports to the project in `sentry.json` unless you export
`SENTRY_DSN`, `SENTRY_ORG`, and `SENTRY_PROJECT` for another, as
[Live Sentry mode](#live-sentry-mode) describes. Follow the standalone steps
in boothstrap.sh's `docs/authoring-challenges.md` to install Pi and load the
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
Without boothstrap there is no `report_step`, `session_info`, or `emit_event`,
so no monitor runs: the skill reads `glitch-progress.json` and acknowledges
finished steps in plain words.
