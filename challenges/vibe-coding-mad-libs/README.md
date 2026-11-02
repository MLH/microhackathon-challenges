# Vibe Coding Mad Libs

A 10-minute terminal challenge. The participant fills four Mad Libs blanks,
Theme, Subject, Audience, and Style, by inventing answers or rolling physical
dice and looking each roll up under Roll dice in the form, which shows the
tables in [`dice-sheet.md`](dice-sheet.md). Pi builds a self-contained
`index.html` from the sentence, offers to show it in Chrome beside the
station, and then makes one change the participant asks for. With the
participant's yes, a screenshot of the app and their sentence are published
to the booth screens as a `mad-libs-v1` gallery item.

| File | Role |
| --- | --- |
| `mad-libs.mjs` | Pi extension: the four-blank form, its Roll dice tables, and `/mad-libs` |
| `prompt.mjs` | Assembles and checks the sentence |
| `dice.mjs` | Parses `dice-sheet.md` into the Roll dice tables |
| `preview.mjs` | Serves `index.html` on `http://127.0.0.1:4321/` with live reload |
| `screenshot.mjs` | Saves the preview's first screen as `screenshot.png` for the gallery |
| `install` | Installs the Pi packages the extension imports |
| `setup`, `cleanup` | Copy the dice sheet and start the preview; stop it |

## Run it standalone

Install Pi and the adapter at the versions boothstrap pins, as in
boothstrap's authoring guide, then, from this repo's root:

```sh
challenge="$PWD/challenges/vibe-coding-mad-libs"
"$challenge/install"
mkdir -p tmp/mad-libs && cd tmp/mad-libs
"$challenge/setup"
GEMINI_API_KEY=... pi --model google/gemini-3.8-flash \
  --skill "$challenge/skills/start-challenge/SKILL.md" \
  --extension "$challenge/mad-libs.mjs" \
  '/skill:start-challenge'
"$challenge/cleanup"
```

`setup` and `cleanup` treat the current directory as the workspace. Without
boothstrap there's no `show_preview`, so Pi gives the preview URL to open
yourself, no gallery, and no points: Pi says which step you finished instead.
Setup fails if port 4321 is already in use.

## Gallery payload

After the participant tries their improved app, Pi asks whether to show it on
the booth screens and, on a yes, runs `screenshot.mjs`, then publishes an item
with kind `app`, renderer `mad-libs-v1`, and the title `<Theme> about
<Subject>`. The image is `files[0]`, `screenshot.png`: a 1280x800 PNG of the
app's first screen in the preview. The payload is:

```json
{
  "prompt": "Build a game about cats for kids in retro style.",
  "blanks": {
    "theme": "game",
    "subject": "cats",
    "audience": "kids",
    "style": "retro"
  }
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `prompt` | string | The participant's whole sentence, as sent |
| `blanks.theme` | string | The kind of app, as filled in |
| `blanks.subject` | string | What it is about, as filled in |
| `blanks.audience` | string | Who it is for, as filled in |
| `blanks.style` | string | How it looks, as filled in |

Pi fills the payload from the participant's own words, so a display should set
every field with `textContent`, never as HTML.

`screenshot.mjs` runs Google Chrome headless with a throwaway profile in
`TMPDIR` and captures the page over the DevTools protocol. It uses the Chrome
at `CHROME_PATH`, else Google Chrome's standard install on macOS or Linux, and
fails, writing nothing, when the preview isn't answering or Chrome is missing.
To try it standalone, run `node "$challenge/screenshot.mjs" [url]` in the
workspace while the preview runs; the URL defaults to the preview.
