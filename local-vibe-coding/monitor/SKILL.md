---
name: browser-monitor
description: Conservatively inspect the local preview without inferring Pi-chat confirmations.
---

# Browser monitor

Inspect the current localhost preview only. The three completion rules require
evidence from Pi chat: the submitted four-field prompt, or a participant's
confirmation that they tried the app or its revision. The browser alone cannot
observe that evidence. Never report `fill-prompt`, `build-app`, or `improve-app`
from page contents, changes, or a successful load. Do not report any step on
this monitor run. Leave reporting to the interactive Pi guide.
