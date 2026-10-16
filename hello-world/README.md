# hello-world

The 5-minute first challenge. Pi reads a seeded `welcome.txt`, greets the
participant, then creates `hello.txt` containing `Hello, world!`.

## Run it standalone in Pi

The commands follow boothstrap.sh's `docs/authoring-challenges.md`. This
package has no `install` hook, no Pi extensions, and no MCP servers. Export
`GEMINI_API_KEY`, then set the package path:

```sh
challenge=/absolute/path/to/microhackathon-challenges/hello-world
```

Install Pi and the adapter, at the versions boothstrap pins:

```sh
npm install -g @earendil-works/pi-coding-agent@1.0.4
pi install npm:pi-mcp-adapter@5.2.0
```

Load the package by adding its absolute path to `settings.agentPluginPaths` in
`~/.pi/agent/mcp-adapter.json`, or in `$PI_CODING_AGENT_DIR/mcp-adapter.json`:

```json
{
  "settings": {
    "agentPluginPaths": ["/absolute/path/to/microhackathon-challenges/hello-world"]
  }
}
```

Seed a scratch folder, then start Pi in it:

```sh
mkdir /tmp/hello-world-attempt && cd /tmp/hello-world-attempt
"$challenge"/setup
pi --model google/gemini-3.8-flash \
  --skill "$challenge"/skills/start-challenge/SKILL.md \
  '/skill:start-challenge'
```

Clean up when done:

```sh
"$challenge"/cleanup
```

Without boothstrap there is no `report_step`, so the skill tells the
participant which step they finished instead.
