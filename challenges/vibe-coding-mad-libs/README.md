# Vibe Coding Mad Libs

A 10-minute terminal challenge. The participant fills four Mad Libs blanks,
Theme, Subject, Audience, and Style, by inventing answers or rolling physical
dice against [`dice-sheet.md`](dice-sheet.md). Pi builds a self-contained
`index.html` from the sentence, shows it in Chrome beside the station, and
then makes one change the participant asks for.

| File | Role |
| --- | --- |
| `mad-libs.mjs` | Pi extension: the four-blank form and `/mad-libs` |
| `prompt.mjs` | Assembles and checks the sentence |
| `preview.mjs` | Serves `index.html` on `http://127.0.0.1:4321/` with live reload |
| `install` | Installs the Pi packages the extension imports |
| `setup`, `cleanup` | Copy the dice sheet and start the preview; stop it |

## Run it standalone

Install Pi and the adapter at the versions boothstrap pins, as in
boothstrap's authoring guide, then, from this repo's root:

```sh
challenge="$PWD/vibe-coding-mad-libs"
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
yourself, and no points: Pi says which step you finished instead. Setup fails
if port 4321 is already in use.
