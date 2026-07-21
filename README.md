# Screen OCR Translator

Firefox extension that uses optical character recognition (OCR) to extract text from any selected area on a web page and show its translation in an overlay. You can switch between translation and original text, copy it to your clipboard, or listen to it using text-to-speech.

<a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the add-on" width="172" height="60"></a>

## How it works

Activate the add-on from the browser toolbar or context menu. Then select an area on the page and press **Run OCR**. The selected area is captured as an image and passed to an OCR worker. The recognized text is then sent to a translation engine and rendered in the overlay.

- **OCR** — PaddleOCR, running in the browser. Uses WASM by default; GPU acceleration (WebGPU) can be enabled in settings.
- **Translation** — unofficial Google Translate API (no API key required), or a user-configured OpenAI-compatible LLM endpoint (e.g. llama.cpp, LM Studio, or a cloud provider).

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
