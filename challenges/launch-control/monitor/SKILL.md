---
name: monitor
description: "Headless monitor for Launch Control: Travel Desk. Reports steps from the page's booker-state line, visually hidden but present in the page's accessibility snapshot."
---

# Launch Control monitor

Take one snapshot of the travel desk page. If the snapshot is not
`http://127.0.0.1:4374/`, call `list_pages`, `select_page` the
`http://127.0.0.1:4374/` page, and take one snapshot of it.

Find the line that starts with `booker-state v1`. It is visually hidden, so
look for it in the snapshot, not on screen. It is one line of fixed words, for
example:

```text
booker-state v1 rung=3 tried=1,2,3 booked=no mode=demo
```

`tried=` is a comma-separated list of rung numbers, or `none`. Report a step
only when the line says exactly this:

- `tried=` lists `1`: call `report_step` with `meet-booker`.
- `tried=` lists `2`: call `report_step` with `add-prompt`.
- `tried=` lists `3`: call `report_step` with `add-tools`.
- `tried=` lists `4` and the line contains `booked=yes`: call `report_step`
  with `add-model`.

`rung=` alone never completes a step. Never report `debrief`. If the page has
no `booker-state` line, is blank, or you are not sure, report nothing. Do not
guess from the chat or other text on the page.
