# Screen OCR Translator

Firefox extension that uses optical character recognition (OCR) to extract text from any selected area on a web page and show its translation in an overlay. Read the whole capture at once with the translation drawn over it, or switch to the picture itself and pull up any paragraph's text with a click. Copy either text or listen to it using text-to-speech.

<a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the add-on" width="172" height="60"></a>

## How it works

Activate the add-on from the browser toolbar or context menu. Then select an area on the page and click 'Run OCR'. You can also right-click any image and choose 'Translate this image'. The translation is rendered as an overlay on the captured area (default mode), or as a panel in the bottom-right corner.

- **OCR** — PaddleOCR, running in the browser. Uses WASM by default; GPU acceleration (WebGPU) can be enabled in settings.
- **Translation** — unofficial Google Translate API (no API key required), or a user-configured OpenAI-compatible LLM endpoint (e.g. llama.cpp, LM Studio, or a cloud provider).

### Two ways to read the overlay

The switch in the overlay toolbar picks between them, and the one you used last is the one the next capture opens in.

**Translation** paints the translated text over the image, so the whole capture reads at a glance.

**Original** leaves the image alone behind transparent frames, and the text is read from the popover or selected straight off the picture.

Either view opens a popover carrying both texts for one paragraph, each with its own copy and read-aloud button. The translation leads and the recognized text follows below it, muted, in both views — so the two rows stay where you last found them, whichever view you opened the popover from.

Rest the pointer on a frame, or on a painted box, to open its popover. It waits for the pointer to stop, so crossing a page of small regions doesn't flash one open per region. It opens right against the box, so moving onto its buttons never drops the hover, and closes as soon as the pointer leaves both. A popover that is reading aloud or holding a text selection stays until you click elsewhere. With the keyboard, focus a box and press Enter or Space to pin it open.

Over a painted box the popover carries the whole translation, including what a box too small to fit it had to cut, and gives you the paragraph's recognized text without leaving the view.

The toolbar menu has copy and text-to-speech actions for the entire selected region, in either view.

### Selecting text on the image

In the original view you can select the recognized text right where it sits in the picture, and the highlight follows the image's own characters. Each recognized paragraph gets an invisible, selectable copy of its text laid over the glyphs — the same trick a PDF viewer uses for scanned pages.

A selection stays inside whatever it started in. Dragging across the image text selects only that; dragging in the popover selects only the popover, without the range spilling onto the page underneath.

The positions come from the recognizer itself. Its output is a sequence of timesteps spread evenly across each detected line, so the timestep that produced a character says where along the line that character sits. Those become per-character boxes, and each character is placed and stretched to its own box. Positions are approximate: the model reports where it saw a character, not its exact outline, so a highlight can sit a fraction of a character off.

> [!TIP]
> Enable GPU acceleration in settings for faster OCR. The extension falls back to CPU processing when WebGPU is unavailable.

## Privacy

- Screenshots never leave your device. The captured image is processed locally.
- Recognized text is sent to the configured translation service.
- Text-to-speech is provided by Google TTS. Support for local TTS is planned.
- All settings, including API keys, stay in browser storage.

## Development

Built with [WXT](https://wxt.dev/) and TypeScript.

```sh
npm ci
npm run build
```

The build generates an unpacked extension in `.output/firefox-mv3`. Load that directory as a temporary add-on. See [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Run the test suite and type checks with:

```sh
npm test
npm run typecheck
```
