# AGENTS.md

## Extension architecture

Firefox: MV3 event page; OCR worker runs directly.
Chrome: MV3 service worker + offscreen document.

Content UI runs in a WXT shadow root; keep styles in `src/entrypoints/content/style.css`.

## Tests

Use generic, fictional text in test fixtures. Do not add real names, places, quoted dialogue, news excerpts, or text copied from screenshots or other source material; common greetings and neutral examples are fine.

## Localization

Use i18n helpers for user-facing text.

## OCR models

Read `src/public/assets/ocr/README.md` before replacing or re-converting packaged models.

## Extension icons

SVG sources and generated PNGs are in `src/public/icon`.
Generate the 16px and 32px icons from `ocr_icon_small.svg` and the 48px and 128px icons from `ocr_icon_big.svg`:

```sh
cd src/public/icon
rsvg-convert -w 16 -h 16 ocr_icon_small.svg -o 16.png
rsvg-convert -w 32 -h 32 ocr_icon_big.svg -o 32.png
rsvg-convert -w 48 -h 48 ocr_icon_big.svg -o 48.png
rsvg-convert -w 128 -h 128 ocr_icon_big.svg -o 128.png
```

## Commit attribution

Credit AI assistance with `Assisted-by:` trailer, not `Co-Authored-By:`.
The format is `Assisted-by: AGENT_NAME:MODEL_VERSION`, for example:

```
Assisted-by: Codex:gpt-5
```
