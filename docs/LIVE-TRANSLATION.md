# Live translation

Live translation reads a screen area over and over and shows the translation of whatever text appears in it.

```text
every ~600 ms:
  take the area from the video's current frame, or from a tab screenshot
  -> skip if the frame looks the same as the last read
  -> recognize text with PP-OCR (one block, no layout model)
  -> match it to the line on screen
  -> translate new lines in parallel
```

Reading and translating run side by side. A slow translator never blocks the next read.

For usage and LLM setup, see [Live translation in the README](../README.md#live-translation).

## Capture

The area is read from the video itself when possible, and from a screenshot otherwise.

- **Video:** crops the video's own frame. The panel can cover the area without affecting OCR. Only text in the video picture is captured; captions drawn as page elements are excluded.
- **Screenshot:** uses `tabs.captureVisibleTab` for other content or when direct video capture is unavailable, including blocked cross-origin or protected videos. Protected content may still be unreadable. Panel overlap is masked to prevent reading its own text, and the panel shows a warning.
- Reads normally start at least 600 ms apart. Unchanged frames skip OCR; after three unchanged reads, polling slows to 1.5 s. Playback and seek events wake the loop.
- Reading pauses while the tab is hidden or the area is outside the viewport.
- An area anchored to a video, image, canvas, or iframe follows it through scrolling, zoom, and fullscreen. The panel follows too, retaining the user's placement relative to the area and preferred size.

## OCR and translation

- Select the area while subtitles are visible. The first readable result with line measurements sets the subtitle size and is withheld. Later reads ignore lines thinner than 60% of that size, subject to a minimum thickness.
- With source language **Auto**, the first non-empty OCR result selects the recognizer for the session. An explicit language bypasses script detection.
- Similar lines are treated as one to tolerate OCR noise. Reads need at least two letters or digits; two empty reads clear the current line.
- Each line is a separate translation request. Up to three run concurrently; a newer request cancels the oldest when full.
- LLM requests include up to three earlier lines as context, stopping at gaps over 5 s. Each line goes with its translation once that has arrived, which helps keep names and grammatical gender consistent. Other providers ignore context. A session cache reuses translations when the line, the earlier lines, and the target language match.
- Failed reads retry at 1.5 s intervals. Three consecutive failures stop reading and show **Retry**. Translation failures do not stop reading and can retry after 5 s while the line remains current.

## Errors

- A failed read is tried again after 1.5 s.
- 3 failed reads in a row stop the session and show a **Retry** button. Retry starts reading again.
- A failed translation does not stop the session.

## Code

Paths below are relative to `src/`.

| Responsibility | File |
|---|---|
| Read loop, history, context, cache | `entrypoints/content/live-session.ts` |
| Text matching and noise filtering | `entrypoints/content/live-text.ts` |
| Video capture | `entrypoints/content/live-video.ts` |
| Region tracking | `entrypoints/content/live-region.ts` |
| Panel and placement | `entrypoints/content/live-panel.ts`, `entrypoints/content/live-layout.ts` |
| Session wiring | `entrypoints/content/index.ts` |
| Screenshot capture, OCR, translation | `background/live.ts` |
| Frame comparison | `shared/frame-signature.ts` |
