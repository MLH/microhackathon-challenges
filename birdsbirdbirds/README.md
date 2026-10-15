# BirdsBirdBirds

Draw a bird in the browser, tell Pi how it should fly, and watch it cross the
sky. Pi writes the flight as a CSS keyframe animation in `bird.json`, and a
checker lets only safe animations through to the page. The bird can then be
published to the booth screens as a `birds-v1` gallery item.

## Files

| File | Purpose |
| --- | --- |
| `challenge.json`, `plugin.json` | Manifest and Agent Plugin metadata |
| `intro.md`, `icon.txt` | Intro screen text and tile icon |
| `skills/start-challenge/SKILL.md` | The guide Pi follows |
| `check-bird.mjs` | Checks `bird.json`; `node check-bird.mjs [path]` |
| `server.mjs` | Local page server on `127.0.0.1:4322` |
| `setup`, `cleanup` | Start and stop the server (hooks in `hooks/`) |
| `page/` | The drawing canvas and the sky |

There is no `install` hook: the package has no dependencies beyond Node.

The server listens on port 4322. Set `BIRDSBIRDBIRDS_PORT` to use another
port, though the skill and the challenge expect 4322.

## Run without boothstrap

Needs Node 26 and a `GEMINI_API_KEY`. Follow the standalone steps in boothstrap.sh's
`docs/authoring-challenges.md` to install Pi and load the package as an Agent
Plugin, then:

```sh
challenge=/absolute/path/to/birdsbirdbirds
mkdir /tmp/my-bird && cd /tmp/my-bird
"$challenge"/setup
```

Open `http://127.0.0.1:4322/`, then start Pi in the same folder:

```sh
pi --model google/gemini-3.8-flash \
  --skill "$challenge"/skills/start-challenge/SKILL.md \
  '/skill:start-challenge'
```

When done:

```sh
"$challenge"/cleanup
```

`cleanup` stops the server and removes `.birdsbirdbirds/`; it leaves
`bird.png` and `bird.json` alone. Without boothstrap there is no
`report_step` or `publish_gallery_item`, so the skill names each finished
step and skips the gallery.

## Gallery payload

An item is published with kind `bird` and renderer `birds-v1`. The image is
`files[0]`, a transparent PNG named `bird.png`. The payload is `bird.json`:

| Field | Type | Rules |
| --- | --- | --- |
| `bird_name` | string | Non-empty, at most 40 characters, no control characters |
| `origin` | string | Non-empty, at most 60 characters, no control characters |
| `animation.css_keyframes` | string | At most 4096 bytes; one `@keyframes` rule (see below) |
| `animation.animation_name` | string | Matches `[A-Za-z_][A-Za-z0-9_-]{0,63}`; equals the keyframes name |
| `animation.duration` | string | Seconds, `2s` to `60s`, such as `14s` |
| `animation.timing_function` | string | `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, or `cubic-bezier(n, n, n, n)` |

Payloads come from `check-bird.mjs`, but a display should still insert
`css_keyframes` only as text into a `<style>` element and set names with
`textContent`, never as HTML.

## What the checker allows

`animation.css_keyframes` must be exactly one `@keyframes <animation_name>`
rule holding frames. Each frame selects `from`, `to`, or a percentage from 0%
to 100%.

- Properties: `transform`, `opacity`, and `animation-timing-function`.
- `transform` values: `none`, or functions `translate`, `translateX`,
  `translateY`, `translate3d`, `rotate`, `rotateZ`, `scale`, `scaleX`,
  `scaleY`, `skew`, `skewX`, `skewY`, with numeric arguments in `vw`, `vh`,
  `px`, `%`, `deg`, `turn`, `em`, or `rem`.
- `opacity`: a number from 0 to 1.
- Rejected: `url(`, `@import`, a second at-rule, backslash escapes, quotes,
  `<`, comments, `!important`, unbalanced braces, and text after the rule.
- The whole `bird.json` is at most 8192 bytes.
