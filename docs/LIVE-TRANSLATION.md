# Live translation

Live translation reads a screen area over and over and shows the translation of whatever text appears in it.

```text
every ~600 ms:
  capture the area from a tab screenshot
  -> skip if the frame looks the same as the last read
  -> recognize text with PP-OCR (one block, no layout model)
  -> match it to the line on screen
  -> translate new lines in parallel
```

Reading and translating run side by side. A slow translator never blocks the next read.

## Capture

- The area is cropped from a `tabs.captureVisibleTab` screenshot, so it works on any page element, including video.
- Chrome limits screenshots to two per second, so reads start at least 600 ms apart. Firefox uses the same spacing. If OCR takes longer, the next read starts as soon as it ends.
- Nothing is read while the tab is in the background or the area is scrolled out of view.
- The panel sits beside the area. If it has to overlap, that part is painted grey first, so the panel does not read its own text.
- If the area is over a video or another picture (image, canvas, iframe), it follows the picture when the page scrolls, zooms, or goes full screen.

## Filtering reads

- **Unchanged frames.** Each capture gets a coarse brightness fingerprint. If it matches the last frame that was read, OCR is skipped. This is what a paused video looks like.
- **Idle polling.** After 3 unchanged reads in a row, the interval grows to 1.5 s. A read with the area out of view counts as unchanged.
- **Same line.** Two reads count as one line if they are at least 85% alike, ignoring case and punctuation. OCR noise does not start a new line.
- **Noise.** A read needs at least two letters or digits. The panel clears the current line after two empty reads in a row.

## Subtitle size

The first read that finds text sets the subtitle size. From then on, lines thinner than 60% of it are ignored. This removes logos, watermarks, and player controls. It also ignores a very small text (less than 12 px).

Select the area while a subtitle is on screen. The first read only sets the size and is not shown.

## Translation

- Up to 3 translations run at once. When a fourth starts, the oldest is dropped and its line is marked as skipped.
- Each line is sent with up to 3 earlier lines as context. Lines more than 5 s apart are treated as different scenes and not linked.
- The LLM endpoint uses the context. Other providers ignore it.
- Results are cached by line, context, and target language (last 100). The same line is not translated again.
- A failed translation is retried every 5 s while its line is on screen.

Every line is its own request. Lines can then be translated in parallel or skipped, and the context stays small in long sessions. It is also why llama.cpp's prompt cache only grows memory use. See the note in the [README](../README.md#live-translation).

## Errors

- A failed read is tried again after 1.5 s.
- 3 failed reads in a row stop the session and show a **Retry** button. Retry starts reading again.
- A failed translation does not stop the session.

## Code

| Part | File |
|---|---|
| Read loop, lines, context, cache | `src/entrypoints/content/live-session.ts` |
| Same-line and noise checks | `src/entrypoints/content/live-text.ts` |
| Following the video | `src/entrypoints/content/live-region.ts` |
| Panel and placement | `src/entrypoints/content/live-panel.ts`, `src/entrypoints/content/live-layout.ts` |
| Startup and wiring | `src/entrypoints/content/index.ts` |
| Capture, OCR, and translation requests | `src/background/live.ts` |
