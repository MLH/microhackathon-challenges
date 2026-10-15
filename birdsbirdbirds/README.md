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
| `workspace-file.mjs` | Reads `bird.json` and `bird.png` only as capped regular files |
| `setup`, `cleanup` | Start and stop the server (hooks in `hooks/`) |
| `page/` | The drawing canvas and the sky |

There is no `install` hook: the package has no dependencies beyond Node.

The server listens on port 4322. Set `BIRDSBIRDBIRDS_PORT` to use another
port, though the skill and the challenge expect 4322.

## Run without boothstrap

Needs Node 26 and a `GEMINI_API_KEY`. Follow the standalone steps in
boothstrap.sh's `docs/authoring-challenges.md` to install Pi and load the
package as an Agent Plugin, then:

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
| `bird_name` | string | At most 40 characters of visible text (see below) |
| `origin` | string | At most 60 characters of visible text (see below) |
| `animation.css_keyframes` | string | At most 4096 bytes; one `@keyframes` rule (see below) |
| `animation.animation_name` | string | Matches `fly_[A-Za-z0-9_-]{1,60}`; equals the keyframes name |
| `animation.duration` | string | Seconds, `2s` to `60s`, such as `14s` |
| `animation.timing_function` | string | `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, or `cubic-bezier(x1, y1, x2, y2)` with plain numbers and x1, x2 from 0 to 1 |

`bird_name` and `origin` hold at least one visible letter, digit, symbol, or
punctuation mark, and at most 4 accent marks stacked on a letter. They hold
no control characters, no format characters (Unicode `Cf`, such as bidi
controls, zero-width spaces, soft hyphens, and tag characters U+E0000 to
U+E007F), no line or paragraph separators (U+2028, U+2029), and no blank
letters: the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille
blank (U+2800). The zero-width non-joiner and joiner (U+200C, U+200D) and the
emoji variation selector (U+FE0F) are allowed, since real names and emoji
need them.

The `fly_` prefix keeps a bird's keyframes from colliding with CSS keywords
or with the sky page's own `flap` keyframes.

The keyframes alone place the bird. In the sky page the bird's wrapper sits
at `top: 0; left: 0`, so `translate(x, y)` is measured from the top-left
corner of the sky with no extra offset. A gallery renderer should place the
bird the same way.

Payloads come from `check-bird.mjs`, but a display should still load
`css_keyframes` only as CSS text, as the sky page does with a constructed
`CSSStyleSheet` (`replaceSync`), and set names with `textContent`, never as
HTML.

## What the checker allows

`animation.css_keyframes` must be exactly one `@keyframes <animation_name>`
rule holding frames. Each frame selects `from`, `to`, or a percentage from 0%
to 100%.

- Properties: `transform`, `opacity`, and `animation-timing-function`.
- `transform` values: `none`, or these functions with comma-separated
  arguments, where only 0 may go without a unit:
  - `translate`, `translateX`, `translateY`, `translate3d`: lengths in `vw`,
    `vh`, `px`, `em`, `rem`, or `%`; the z length of `translate3d` can't be
    `%`.
  - `rotate`, `rotateZ`, `skew`, `skewX`, `skewY`: angles in `deg` or `turn`.
  - `scale`, `scaleX`, `scaleY`: plain numbers with no unit.
- `opacity`: a number from 0 to 1.
- `animation-timing-function`: the same values as `timing_function`.
- Numbers are plain decimals such as `1000px`, never exponents like `1e3px`.
  Units are lowercase.
- The keyframes name starts with `fly_`.
- Rejected: `url(`, `@import`, a second at-rule, backslash escapes, quotes,
  `<`, comments, `!important`, unbalanced braces, text after the rule, and a
  name without the `fly_` prefix.
- The whole `bird.json` is at most 8192 bytes.
