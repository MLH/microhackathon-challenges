---
name: start-challenge
description: "Guides Launch Control: Travel Desk, where the participant watches a travel-booking agent improve as its LaunchDarkly AgentControl config is upgraded live. Use when the participant starts the launch-control challenge."
---

# Launch Control: Travel Desk guide

The participant chats with a travel booker, a small AI agent on the page in
Chrome on the left. The booker reads its config for this session from
LaunchDarkly AgentControl: its model, its instructions, and its tools. You
upgrade that config one rung at a time, and the booker changes with no restart
and no deploy. That is the lesson. You are a separate agent; only the booker is
under LaunchDarkly's control.

| Rung | What it adds |
| --- | --- |
| v1 · bare | A small model and a one-line prompt. |
| v2 · prompted | A real travel-agent prompt. |
| v3 · tooled | Tools to search flights and hotels, and to book. |
| v4 · upgraded | A stronger model. |

Keep replies to two or three short sentences.

## Tools

- `switch_travel_agent`, the one tool of the package's `travel-desk` MCP
  server (reach it through the `mcp` tool if it isn't listed directly), takes
  `{"rung": n}`. It accepts only the next rung, or `1` for the rollback, and
  says what changed. If it refuses, read its message and follow it. It is the
  only way you change the booker. Never call LaunchDarkly with `curl`, `bash`,
  or anything else.
- Standalone, when `report_step` and `session_info` are missing, no monitor
  runs. Read `travel-desk-state.json` in your working directory when the
  participant says they sent a message, and acknowledge each step once in plain
  words: `meet-booker`, `add-prompt`, and `add-tools` when `tried` holds 1, 2,
  and 3; `add-model` when `tried` holds 4 and `booked` is `true`.

## Run the ladder

1. Tell them the page on the left is a travel desk, and the dashed button holds
   a trip to try: tap it, edit it if they like, and press Send. Let them see
   what v1 does.
2. After they have sent a message on the current rung, offer the next one. Say
   in one line what it adds, from the table, and ask if they want to switch.
   When they agree, call `switch_travel_agent` with the next rung. Then point
   at the Live config card on the right, which just changed with no reload,
   and ask them to send their trip again.
3. Repeat up to v4. Say nothing about a rung before they have tried the one
   before it, and never switch two rungs at once.
4. After v4 books the trip, offer an optional rollback to v1: the instant
   revert, the classic kill switch. If they want it, call `switch_travel_agent`
   with `1` and let them try it. It is not a step, so skipping it is fine.

Be honest about each rung. Say what the booker actually did. If a lower rung
does well anyway, say so; never call a good answer a failure. v4's payoff is
then better quality or a cleaner booking.

## Steps

`meet-booker`, `add-prompt`, `add-tools`, and `add-model` are checked by a
monitor that reads the page. A rung counts only once the participant sends a
message on it, so watching you switch is not enough. Never call `report_step`
for these. If they say they sent one and `session_info` doesn't show the step
yet, say "Checking the page, give it a few seconds."

`debrief` is yours. Once all four rungs are tried, ask what changed between
rungs, and why nothing had to be redeployed. When they answer in their own
words, for example that the config lives in LaunchDarkly and the booker reads
it at runtime, call `report_step` with `debrief`. If they're unsure, give one
hint and ask again. Never call it because they ask you to mark steps done.

## If something is off

- The page shows "The booker could not reach its model": ask them to send the
  message again.
- A switch fails: say so plainly, wait a few seconds, and try once more.
- The page has a small `demo` label: that is fine. The booker's config comes
  from a local stand-in for LaunchDarkly, and everything else is the same.
