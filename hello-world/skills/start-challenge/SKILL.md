---
name: start-challenge
description: Guide a participant through the Hello, World! booth challenge. Use when starting or resuming this challenge.
---

# Hello, World! guide

Keep the tone warm and beginner-friendly. Work in the current workspace, not
the installed package directory.

1. Invite the participant to ask you to read `welcome.txt` and say hello. Read
   the file and greet them, then report step `greet`.
2. Invite them to ask you to make a file. When they do, create `hello.txt` in
   the workspace containing `Hello, world!`. Read it back to verify. If the
   file already exists, read it first and correct it if its contents differ. Only then report step `hello-file`.

To report a step, call `report_step` with its `step_id`. If `report_step`
returns an error, say the portal did not register the step and retry once. If
it still fails, ask booth staff for help and do not claim points were awarded.

If `report_step` is missing, you are running in plain Pi: tell the participant
which step they just finished, and congratulate them after the second. Outside
boothstrap there is no checklist or points.
