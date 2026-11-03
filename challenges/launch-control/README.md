# Launch Control: Travel Desk

A 10-minute browser challenge built on LaunchDarkly AgentControl. The
participant chats with a travel booker, a small AI agent on a local page, and
asks it to plan the same trip at each of four rungs. Pi, the guide, upgrades
the booker's config one rung at a time, and the booker gets better with no
restart and no deploy. The lesson: you can change an AI agent's model, tools,
and instructions in production without redeploying.

| Rung | Variation | What it adds | Model |
| --- | --- | --- | --- |
| v1 | `bare` | A one-line prompt, no tools | `gemini-2.5-flash-lite` |
| v2 | `prompted` | A real travel-agent prompt | `gemini-2.5-flash-lite` |
| v3 | `tooled` | `search_flights`, `search_hotels`, `book_trip` | `gemini-2.5-flash-lite` |
| v4 | `upgraded` | A stronger model | `gemini-3.8-flash` |

The **ladder** is these four variations of one AgentControl config, in
[ladder.json](ladder.json); a **rung** is one of them. The **travel booker**
is the agent on the page; **the guide** is Pi in the terminal. Only the
booker is under LaunchDarkly's control.

## Files

| File | Purpose |
| --- | --- |
| `challenge.json`, `plugin.json` | Manifest and Agent Plugin metadata |
| `mcp.json`, `mcp/` | The `travel-desk` MCP server and its one tool, `switch_travel_agent` |
| `ladder.json` | The four variations: model, instructions, and tool schemas |
| `inventory.json` | The made-up cities, flights, and hotels the tools search |
| `launchdarkly.json` | Public settings for live mode: project, environment, and config keys |
| `provision.mjs` | Creates or updates the config in a LaunchDarkly project from `ladder.json` |
| `intro.md`, `icon.txt` | Intro screen text and tile icon |
| `skills/start-challenge/SKILL.md` | The guide Pi follows |
| `monitor/SKILL.md` | Headless browser monitor skill |
| `install` | Installs LaunchDarkly's SDKs into the package's `node_modules` |
| `setup`, `cleanup` | Start and stop the page server (`server/setup.mjs`, `server/cleanup.mjs`) |
| `server/` | Page server on `127.0.0.1:4374`, the booker's agent loop, and the demo stand-in |
| `page/` | The travel desk page: chat and Live config card |

## How it works

The page server resolves the AgentControl config for the context
`{ kind: "user", key: BOOTHSTRAP_SESSION_ID }` with `@launchdarkly/ai-server`
over a streaming SDK client, with analytics and diagnostic events off. It runs
the booker's agent loop on whatever the SDK returns: that model, through the
vault's `gemini` service, those instructions, and only those tools, against
the fake inventory. `book_trip` writes `itinerary.json` to the workspace and
nothing else. No real travel API, payment, or personal data is involved.

`switch_travel_agent({ rung })` changes only this session's individual target
on the config, with an `addTargets` and `removeTargets` semantic patch. It
accepts only the next rung, or `1` to roll back, and never touches the
default rule or another context key. The SDK sees the change in about a
second, and the page's config card updates in place.

`setup` removes any target this session left behind and confirms that the
session resolves to v1. `cleanup` removes the session's target; a session
with no target is left alone, so it is safe to run twice and after a crash.

## How steps advance

The page keeps a hidden line, `booker-state v1 rung=<n> tried=<rungs>
booked=<yes|no> mode=<live|demo>`, and the headless monitor reports
`meet-booker`, `add-prompt`, `add-tools`, and `add-model` from it, as
[monitor/SKILL.md](monitor/SKILL.md) describes. A rung counts as tried only
once the booker has answered a message sent while it was live, and `booked`
turns `yes` only when v4 books a trip, so a lucky booking on a lower rung
never completes `add-model`. Each rung starts the booker on a fresh model
conversation, so it answers the request on its own, while the page keeps the
whole chat. Once all four
are tried, Pi asks what changed and why nothing was redeployed, and reports
`debrief`. The page server also writes the same state to
`travel-desk-state.json` for a standalone run.

The server listens on port 4374. Set `LAUNCH_CONTROL_PORT` to use another
port, though the manifest and the monitor expect 4374.

## Demo and live modes

Live mode needs both LaunchDarkly keys and real settings. Otherwise the
challenge runs in demo mode: the identical flow against a local stand-in for
LaunchDarkly, mounted on the page server, that serves `ladder.json`. The page
then shows a small `demo` label. The booker calls Gemini in both modes.

The settings live in [launchdarkly.json](launchdarkly.json) as
`<placeholder>` values. `LAUNCHDARKLY_PROJECT_KEY`,
`LAUNCHDARKLY_ENVIRONMENT_KEY`, and `LAUNCHDARKLY_AI_CONFIG_KEY` in the
environment replace them, so an event can set them in its `challenge_env`.

## Event vault services

The event vault needs these three services. Each credential is the variable
the package reads; none starts with `LD_`.

| Service | Auth | Credential | Host | Read by |
| --- | --- | --- | --- | --- |
| `gemini` | `api-key`, header `x-goog-api-key` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | The page server and Pi |
| `launchdarkly-sdk` | `api-key`, header `Authorization` | `LAUNCHDARKLY_SDK_API_KEY` | `stream.launchdarkly.com` | The page server only |
| `launchdarkly-api` | `api-key`, header `Authorization` | `LAUNCHDARKLY_API_AUTH_TOKEN` | `app.launchdarkly.com` | `setup`, `cleanup`, and the MCP tool |

- `launchdarkly-sdk` holds the environment's server-side SDK key (`sdk-…`).
  With events off, the SDK needs only the streaming host.
- `launchdarkly-api` holds an access token that can write the config's
  targeting. It is `api-key`, not `bearer`, because LaunchDarkly's REST API
  takes the bare token in `Authorization` and refuses `Bearer api-…`.
- The page server never receives the API token: `setup` leaves it out of the
  server's environment.

## Provision a LaunchDarkly project

Run this once per LaunchDarkly project, with an access token that can write AI
Configs, from the package directory:

```sh
LAUNCHDARKLY_API_AUTH_TOKEN=api-... \
LAUNCHDARKLY_PROJECT_KEY=<project> \
LAUNCHDARKLY_ENVIRONMENT_KEY=<environment> \
LAUNCHDARKLY_AI_CONFIG_KEY=launch-control-travel-booker \
node provision.mjs
```

It creates or updates the three tools, the agent-mode config, its four
variations, and a default rule serving `bare` in that environment. A second
run creates nothing twice. Then fill the same three keys into
`launchdarkly.json`.

## Run without boothstrap

Needs Node 26 and a `GEMINI_API_KEY`; for live mode, export the two
LaunchDarkly keys and settings too. Follow the standalone steps in
boothstrap.sh's `docs/authoring-challenges.md` to install Pi and
pi-mcp-adapter and load the package as an Agent Plugin, which mounts its
`travel-desk` MCP server. Then:

```sh
challenge=/absolute/path/to/launch-control
"$challenge"/install
mkdir /tmp/my-launch-control-run && cd /tmp/my-launch-control-run
"$challenge"/setup
```

Open `http://127.0.0.1:4374/`, then start Pi in the same folder:

```sh
pi --model google/gemini-3.8-flash \
  --skill "$challenge"/skills/start-challenge/SKILL.md \
  '/skill:start-challenge'
```

When done:

```sh
"$challenge"/cleanup
```

`cleanup` stops the server, removes the session's target in live mode, and
removes `.launch-control/`, `travel-desk-state.json`, and `itinerary.json`.
Without boothstrap there is no `report_step` or `session_info`, so no monitor
runs: the skill reads `travel-desk-state.json` and acknowledges finished steps
in plain words.
