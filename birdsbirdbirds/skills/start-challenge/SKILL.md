---
name: start-challenge
description: Guides the BirdsBirdBirds challenge. Use when the participant starts birdsbirdbirds.
---

# BirdsBirdBirds guide

The participant draws a bird, you give it a flight, and they watch it cross
the sky. Work through the steps below in order, one question at a time, in a
friendly, brief voice. Pi's `read`, `bash`, and `write` tools do the work.

Check whether `report_step` is one of your tools. When it's missing (a
standalone run), don't call it, and skip the gallery at the end: after each
step, tell the participant which step they just finished and move on.

The package directory is the one holding `skills/`, two directories up from
this file. With boothstrap it is `$BOOTHSTRAP_PACKAGE_DIR`; without it, work
it out from this skill file's path. The checker is
`"$BOOTHSTRAP_PACKAGE_DIR/check-bird.mjs"`, or `check-bird.mjs` in the
package directory when the variable is unset. Run it with `node`.

## 1. Draw

Tell the participant a drawing page is ready at `http://127.0.0.1:4322/` and
ask if they'd like it open. On yes, call `show_preview` with that URL. Without
`show_preview`, give them the URL to open.

Tell them to draw any bird, then press Save. Once they say they're done, use
`bash` to check that `bird.png` exists in the current directory. If it
doesn't, ask them to press Save and look again. When it exists, report
`draw-bird`.

## 2. Meet the bird

Use `read` on `bird.png` and say, in a sentence, what you see. Then ask three
things, one at a time:

1. What is the bird's name?
2. Where is it flying in from?
3. How should it fly: swooping, fluttering, gliding, bouncing?

## 3. Animate

Safety first. If the drawing, name, or origin is offensive, inappropriate, or
NSFW, decline kindly, don't write `bird.json`, and ask for a family-friendly
bird or text. Birds can be shown publicly.

Otherwise use `write` to create `bird.json` in the current directory with
exactly these keys and no others:

```json
{
  "bird_name": "Pip",
  "origin": "Lisbon, Portugal",
  "animation": {
    "css_keyframes": "@keyframes fly_pip { from { transform: translate(-20vw, 40vh); } to { transform: translate(120vw, 40vh); } }",
    "animation_name": "fly_pip",
    "duration": "14s",
    "timing_function": "ease-in-out"
  }
}
```

That example is only the shape. Don't copy its flight; invent a unique one
for this bird:

- `animation_name` is unique and matches the name after `@keyframes`.
- Start at `translate(-20vw, Y)` and end at `translate(120vw, Y)`, where Y is
  between 10vh and 90vh.
- Use at least 5 keyframe percentages (for example 0%, 20%, 50%, 80%, 100%)
  with varying heights and `rotate(...)` angles.
- Pick a flight character that fits the bird and what the participant asked.
- `duration` is between 2s and 60s. The sky page slows it down a little.
- Only `transform`, `opacity`, and `animation-timing-function` are allowed
  inside the keyframes.

Then run `node <checker> bird.json` with `bash`. It prints one line per
problem. Fix `bird.json` and rerun until it prints `ok`. Never loosen the
checker or edit it. When it passes, report `animate`.

## 4. Watch

The drawing page switches to the sky on its own once a valid `bird.json`
exists. Tell the participant to look at it (call `show_preview` again if the
page was closed). They can press "Draw again" to redraw; if they do, start
again at step 1.

Ask how the flight looks and offer one tweak, such as faster, higher, or
more wobbly. If they want it, edit `bird.json`, rerun the checker, and let
them watch again. When they say they've watched it fly, report `fly`.

## 5. Gallery

Only with `publish_gallery_item`. Use the display name from `session_info`
and ask: "Want this on the booth screens? It'll show with your name,
[display name], and staff can remove it at any time."

On a yes, call `publish_gallery_item` with:

- `kind`: `bird`
- `title`: `<bird_name> from <origin>`
- `renderer`: `birds-v1`
- `files`: `["bird.png"]`
- `payload`: the contents of `bird.json`, as an object

On a no, move on without publishing.
