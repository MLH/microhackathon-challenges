# BirdsBirdBirds

Draw a bird in the browser, describe how it should fly, and direct the
flight by talking to Pi. Pi writes the flight as a CSS keyframe animation in
`bird.json`, and a checker lets only safe animations through. The sky page
draws each flight as a numbered path, then flies the bird along it, so the
participant can point at waypoints ("add a loop at 3"). When they're happy,
Pi publishes the bird to the booth screens as a `birds-v1` gallery item.

## Files

| File | Purpose |
| --- | --- |
| `challenge.json`, `plugin.json` | Manifest and Agent Plugin metadata |
| `intro.md`, `icon.txt` | Intro screen text and tile icon |
| `skills/start-challenge/SKILL.md` | The guide Pi follows |
| `extension.mjs` | Pi extension: tells Pi about each saved drawing (see below) |
| `bird-watcher.mjs` | Watches the workspace for a new `bird.png` |
| `check-bird.mjs` | Checks `bird.json`; `node check-bird.mjs [path]` |
| `flight-path.mjs` | Turns a checked flight into waypoints on the gallery's stage |
| `flight-history.mjs` | Records each new passing flight in `.flights/` |
| `flock.mjs` | Fetches the booth flock for the sky, or falls back to the practice flock |
| `flock/` | The practice flock: SVG birds and their flights in the feed's shape |
| `server.mjs` | Local page server on `127.0.0.1:4322` |
| `workspace-file.mjs` | Reads `bird.json` and `bird.png` only as capped regular files |
| `setup`, `cleanup` | Start and stop the server (hooks in `hooks/`) |
| `page/` | The drawing canvas and the display-only sky |

There is no `install` hook: the package, extension included, has no
dependencies beyond Node.

## How steps advance

Pi opens the drawing page with `show_preview` as soon as the challenge
starts. The extension watches the workspace and sends Pi a hidden message
starting with `[birdsbirdbirds]` when the participant saves a new `bird.png`.
It starts a turn when Pi is idle and follows the current turn otherwise. The
skill then reads the drawing and reports `draw-bird`, so nobody has to tell
Pi they saved. A `bird.png` already in the workspace when Pi starts, and a
save with the same content, send nothing. Pi writes `bird.json` and runs the
checker itself, so `animate` needs no message. Pi counts the files in
`.flights/` (see Flight history) to report `direct-flight`, and reports
`join-flock` once `publish_gallery_item` answers, without asking first: the
station's own notice lets the participant take the bird down.

The server listens on port 4322. Set `BIRDSBIRDBIRDS_PORT` to use another
port, though the skill and the challenge expect 4322.

## The page

The page opens on the drawing canvas until a drawing is saved, and on the sky
after. A save switches to the sky by itself. For a redraw, Pi opens
`http://127.0.0.1:4322/?draw`, which shows the canvas again.

The sky takes no input: the participant directs the flight by talking to Pi.
It is the gallery's 1000 by 850 stage, scaled to fit the window, with each
bird in the gallery's 120px box, flights slowed 3 times, and flock birds
started 2.3 s apart, so the flight looks as it will on the booth screens.
When a new flight arrives, its path draws itself on as a dotted line of
straight segments, as CSS moves the bird between keyframes, then its numbered
waypoints pop in, then the bird flies it. After a revision the previous path
stays as a faint ghost, with the changed waypoints and the segments touching
them highlighted. A chip names the bird and its origin.

## Flight history

While the page server runs, each `bird.json` that passes the checker and
differs from the last recorded flight is copied to
`<workspace>/.flights/NNN.json`, numbered from `001`. The server checks on
any change in the workspace, debounced, and again whenever the page asks, so
it never depends on what `fs.watch` reports.

`GET /flight.json` answers `{ current, previous, changed }`. `current` and
`previous` are the two latest recorded flights, or `null`:

| Field | Meaning |
| --- | --- |
| `version` | The flight's number in `.flights/` |
| `bird_name`, `origin` | From `bird.json` |
| `duration_s` | `animation.duration` in seconds, unslowed; the page plays it 3 times slower, as the gallery does |
| `timing_function` | `animation.timing_function` |
| `waypoints` | `{ n, offset, x, y }`, plus `rotate` (degrees), `scale`, `opacity`, and `easing` when set |

Waypoints are numbered from 1, one per keyframe offset that sets a
`transform`, in offset order. `x` and `y` are the bird box's top-left corner
in pixels on the gallery's 1000 by 850 stage: 1vw is 10px and 1vh is 8.5px,
as the gallery converts them, and a translate percentage is a share of the
120px bird box. `changed` lists the current waypoints whose position or
transform differs from the previous flight's waypoint of the same number.

## The flock

The other attendees' published birds fly dimmed behind the participant's.
The page server reads the gallery's URL from `BOOTHSTRAP_GALLERY_URL`, or
else from `BIRDSBIRDBIRDS_GALLERY_URL`, which an event can set in its
`challenge_env`. It fetches `<url>/birds.json`:

```json
{
  "items": [{
    "id": "…", "bird_name": "…", "origin": "…", "display_name": "…",
    "stored_at": "…", "image_url": "/gallery/{slug}/items/{id}/files/bird.png",
    "keyframes": [{ "offset": 0, "transform": "translate(120px, 300px) rotate(5deg)", "opacity": 1, "easing": "ease-in" }],
    "duration_s": 14, "timing_function": "ease-in-out"
  }]
}
```

`image_url` is a path on the gallery's origin, transforms are in stage
pixels, and `duration_s` is the bird's own stated duration (2 to 60 s,
unslowed); the page slows it 3 times at playback, as the gallery does. Each
transform and timing function must pass the checker's grammar and is written
out again; a bird that fails any check, or whose image is on another origin,
is dropped. The booth API serves its files same-origin only, so the page
server proxies the feed at `GET /flock.json` and each PNG at
`GET /flock/images/<key>.png`, keeping copies in
`$TMPDIR/birdsbirdbirds-flock/` and asking the gallery for the feed again
after 30 s.

With no URL, or when the gallery is offline, errs, answers 404, or sends no
valid feed, `/flock.json` sends the practice flock in `flock/` instead, its
SVGs served at `GET /flock/demo/<name>.svg`. Its `source` field is `live` or
`demo`, and the page labels the flock to match.

## Preview the page

To see the sky open on a revision, with a ghost path and highlighted
changes, seed a workspace with a sample drawing and two flights, then run the
command the script prints, from the repository root:

```sh
node tools/seed-birds-workspace.mjs /tmp/bird-preview
```

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
  --extension "$challenge"/extension.mjs \
  '/skill:start-challenge'
```

When done:

```sh
"$challenge"/cleanup
```

`cleanup` stops the server and removes `.birdsbirdbirds/`; it leaves
`bird.png`, `bird.json`, and `.flights/` alone. Without boothstrap there is no
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

The keyframes alone place the bird. In the sky page the bird's box sits at
the top-left corner of the 1000 by 850 stage, so `translate(x, y)` is
measured from there with no extra offset. A gallery renderer should place the
bird the same way.

Payloads come from `check-bird.mjs`, but a display should still never insert
`css_keyframes` as HTML, and should set names with `textContent`. The sky
page takes neither: it gets waypoint numbers from `/flight.json`.

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
