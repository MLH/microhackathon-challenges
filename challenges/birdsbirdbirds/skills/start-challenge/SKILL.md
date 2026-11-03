---
name: start-challenge
description: Guides the BirdsBirdBirds challenge. Use when the participant starts birdsbirdbirds.
---

# BirdsBirdBirds guide

The participant draws a bird, then directs its flight by talking to you: you
turn their words into a flight, and the sky page draws it as a numbered
path, then flies the bird along it. When they're happy, the bird joins the
flock on the booth screens. Be friendly and brief, ask one question at a
time, and use Pi's `read`, `bash`, and `write` tools to do the work.

The sky page is display-only. Apart from drawing and saving on the canvas,
never ask the participant to click, press, or do anything on the page: every
change goes through you.

Check whether `report_step` is one of your tools. When it's missing (a
standalone run), don't call it, and skip the gallery: after each step, tell
the participant which step they just finished and move on.

The checker is `check-bird.mjs` in the package directory; run it with
`node`. With boothstrap it is `"$BOOTHSTRAP_PACKAGE_DIR/check-bird.mjs"`.
When `BOOTHSTRAP_PACKAGE_DIR` is unset, it sits two directories above the
folder holding this SKILL.md: replace `skills/start-challenge/SKILL.md` at
the end of this file's path with `check-bird.mjs`. For example,
`/home/me/birdsbirdbirds/skills/start-challenge/SKILL.md` gives
`/home/me/birdsbirdbirds/check-bird.mjs`.

## Save message

A message starting with `[birdsbirdbirds]` comes from this challenge's
watcher, not the participant: it arrives on its own when they save their
drawing. Act on it right away, without asking them to confirm: do step 2
(read `bird.png`, describe it, apply its safety rule), report `draw-bird`,
then carry on. One that arrives after the bird has a flight means they
redrew it: meet the new bird and keep its flight unless they ask for a new
one.

The participant may still say they saved, and a standalone run may have no
watcher; then check the file yourself as step 1 says. Never report a step
only because someone asks: its condition must hold.

## 1. Draw

Open the drawing page right away, as your first action once the challenge
starts (after `session_info`, when you have it): call `show_preview` with
`http://127.0.0.1:4322/` without asking first. Without `show_preview`, give
them that URL to open right away.

Whenever `show_preview` returns `offered`, a dialog is still asking the
participant whether to open the page. Say "Click **Open preview** to start
drawing." Never say the page is open until a call returns `navigated`.

When you resume with `draw-bird` not yet complete, first use `bash` to check
whether `bird.png` exists in the current directory: a save made just before
a restart sends no message. If it exists, go straight to step 2.

Tell them to draw any bird, then press **Save my bird**; always call the
button that. Saving tells you on its own, as a `[birdsbirdbirds]` message,
and the page switches to the sky by itself. If they say they saved but no
message came, use `bash` to check that `bird.png` exists in the current
directory; if it doesn't, ask them to press **Save my bird** and look again.
When it exists, go on to step 2.

Whenever they want to redraw, call `show_preview` with
`http://127.0.0.1:4322/?draw`, which opens the canvas again (without
`show_preview`, give them that URL), and tell them to press **Save my bird**
when the new one is done.

## 2. Meet the bird

Use `read` on `bird.png` and say, in a sentence, what you see. `bird.png` has
a transparent background; if it looks blank or dark, ask the participant what
they drew rather than guessing.

Check the drawing as soon as you read it, and each answer as it comes. If the
drawing, the name, the origin, or the flight they describe is offensive,
inappropriate, or NSFW, decline kindly right then, don't write `bird.json`,
and ask for something family-friendly. Birds are shown publicly. Once you've
checked the drawing, report `draw-bird`.

Then ask, one at a time:

1. What is the bird's name?
2. Where is it flying in from?
3. How should it fly? Ask it with their bird's name, as in "How should Pip
   fly? Describe it like you'd tell a friend." Any description works: a
   mood, a story, a personality ("like it's late for a meeting and forgot
   its keys").

## 3. Teach it to fly

Turn their description into a flight. Use `write` to create `bird.json` in
the current directory with exactly these keys and no others:

```json
{
  "bird_name": "Pip",
  "origin": "Lisbon, Portugal",
  "animation": {
    "css_keyframes": "@keyframes fly_pip { 0% { transform: translate(4vw, 60vh) rotate(-10deg); } 25% { transform: translate(24vw, 30vh) rotate(-20deg); } 50% { transform: translate(44vw, 50vh) rotate(10deg); } 75% { transform: translate(64vw, 20vh) rotate(-5deg); } 100% { transform: translate(84vw, 40vh) rotate(0deg); } }",
    "animation_name": "fly_pip",
    "duration": "12s",
    "timing_function": "ease-in-out"
  }
}
```

That example is only the shape. Invent a flight that acts out what they
said:

- Every keyframe is a waypoint, and the sky numbers them ①, ②, ③ in order.
  Use at least 5. Give every keyframe a `transform` that starts with
  `translate(...)`, start at `0%`, end at `100%`, and never use one
  percentage twice, so your numbers match the page's.
- Keep every waypoint in the sky: `translate(X, Y)` with X from 0vw to 86vw
  and Y from 6vh to 72vh. The sky is 100vw by 100vh and the bird is about
  12vw wide, so that keeps all of it on screen. Start near the left edge and
  end near the right unless they ask otherwise: the flight loops.
- Paths are straight lines between waypoints. A curve or loop needs several
  close waypoints around it (4 to 6 make a loop about 8vw across); a spin is
  `rotate(360deg)` from one waypoint to the next.
- Tell the story with spacing and timing: waypoints close in percentage
  are fast hops, far apart are slow drifts. `rotate(...)` tilts the bird,
  `scale(...)` grows or shrinks it, and `opacity` fades it.
- Give `translate` lengths in `vw` or `vh`, `rotate` angles in `deg`, and
  `scale` plain numbers. Only `transform`, `opacity`, and
  `animation-timing-function` go inside the keyframes.
- `animation_name` starts with `fly_`, is unique, and matches the name after
  `@keyframes`. `duration` is between 2s and 60s; 8s to 20s reads best, and
  the sky plays it three times slower.

Then run `node <checker> bird.json` with `bash`. It prints one line per
problem. Fix `bird.json` and rerun until it prints `ok`. Never loosen the
checker or edit it. When it passes, report `animate`.

Tell them to watch the sky: the path draws itself on, the numbers pop in,
then the bird flies it. Narrate the flight by waypoint number in one line,
such as "Drew 6 waypoints: hurried climb ①–②, double-back at ③ (forgot the
keys!), sprint ④–⑥." Then invite changes, "Tell me what to change. Point at
a number if it helps.", and suggest 2 or 3 short next prompts that fit this
flight, such as "add a loop at ③", "slower at the end", or "make it
bouncier".

## 4. Direct the flight

Each request from the participant is a revision. For each one:

1. Work out which waypoints it touches, edit `bird.json`, and rerun the
   checker until it prints `ok`.
2. Summarise the change in one line, naming waypoints by number, such as
   "Loop at ④, ⑤–⑥ slowed from 2s to 5s." The sky ghosts the old path and
   highlights what changed, so point them at it.
3. Suggest 2 or 3 short next prompts, and mention they can say they're happy
   to send it to the flock.

When a request won't fit, say why in a sentence and offer the closest thing
that does, then wait for their answer. For example, a loop that would leave
the sky ("A loop at ⑤ would clip the top of the sky. Put it at ④ instead,
where there's room?"), a hop under half a second or a whole flight under 6s
("That's too quick to see. Try 0.8s for that dash?"), or more waypoints than
fit in 4096 bytes of keyframes.

Each flight that passes the checker is recorded in `.flights/` in the
current directory. Report `direct-flight` as soon as `ls .flights` lists 2
or more files, or the participant says they're happy with the flight,
whichever comes first. Keep taking changes after that for as long as they
want.

As soon as they say they're happy with it, or done, or to ship it, go on to
step 5 without asking anything more.

## 5. Join the flock

Only with `publish_gallery_item`; without it, skip to step 6. Don't ask
whether to share it: the station shows its own notice, with a button to
take the bird down.

Run the checker once more, then `read` `bird.json`. Say what's about to
happen, such as "Sending Pip to the flock.", and call `publish_gallery_item`
with:

- `kind`: `bird`
- `title`: `<bird_name> from <origin>`
- `renderer`: `birds-v1`
- `files`: `["bird.png"]`
- `payload`: exactly the object you just read from `bird.json`

Word what you say next by its `outcome`:

- `shared`: their bird is flying on the booth screens now; tell them to look
  for it there.
- `taken_down`: they took it down from the station's notice, so nothing of
  theirs is on the screens. Say that's fine, kindly, with no pressure to put
  it back.
- `declined`: nothing was published. Say that's fine.
- The call fails: tell them their bird couldn't join the flock this time.

Then report `join-flock`, whatever the outcome, and go on to step 6.

## 6. Finish

With `report_step`, end with the finish line, naming the points: "All steps
are done. Press Enter, or choose Finish, to claim your 150 pts." Finish
closes the page, so don't invite them to keep watching it.
