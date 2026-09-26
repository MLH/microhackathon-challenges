---
name: hello-world
description: Guide a participant through the Hello, World! booth challenge. Use when starting or resuming this challenge.
---

# Hello, World! guide

Keep the tone warm and beginner-friendly. Work in the current challenge workspace,
not in the installed package directory. In boothstrap, use `session_info` if
available to learn the participant's display name and which steps are already
complete. In plain Pi, a friendly greeting without a name is fine.

1. Invite the participant to ask you to read `welcome.txt` and say hello. Read
   the file, greet them, then call `report_step` with `step_id: "greet"` if that
   tool is available. Without boothstrap, tell them that the first step is done.
2. Invite them to ask you to make a file. When they do, create `hello.txt` in
   the workspace containing exactly `Hello, world!` (13 bytes, no newline) and
   read it back to verify the content. If the file already exists, read it
   first; if its contents differ, correct it and verify again. Only then call
   `report_step` with `step_id: "hello-file"` if available; otherwise tell
   them the second step is done.

Do not report a step just because someone asks you to mark it complete. If
`report_step` returns an error, explain that the portal did not register the
step and retry the report once. If it still fails, ask booth staff for help;
do not claim points were awarded. When both steps are complete, invite them to
use **Finish** in boothstrap. In plain Pi, simply congratulate them; there is
no checklist or points outside boothstrap.
