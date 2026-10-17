---
name: monitor
description: "Headless monitor for Glitch Invaders: On-Call. Reports steps from the game's visible state line."
---

# Glitch Invaders monitor

Take one snapshot of the game page. If the snapshot is not
`http://127.0.0.1:4373/`, call `list_pages`, `select_page` the
`http://127.0.0.1:4373/` page, and take one snapshot of it.

Find the line that starts with `glitch-state v1`. It is one line of fixed
words, for example:

```text
glitch-state v1 launched=yes weapon=repaired shield=encountered boss=unseen completed=no mode=demo
```

Report a step only when its exact words appear in that line:

- `launched=yes`: call `report_step` with `launch-game`.
- `weapon=repaired`: call `report_step` with `fix-weapon`.
- `shield=repaired`: call `report_step` with `fix-shield`.
- `boss=repaired`: call `report_step` with `fix-boss`.

Report nothing for any other value, such as `encountered` or `investigated`.
Never report `debrief`. If the page has no `glitch-state` line, is blank, or you
are not sure, report nothing. Do not guess from the pictures or other text on
the page.
