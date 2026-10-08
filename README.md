# Screen OCR Translator

<p>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/actions/workflows/ci.yml"><img src="https://github.com/OPerepadia/ocr-translator-extension/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/releases"><img src="https://img.shields.io/github/v/release/OPerepadia/ocr-translator-extension?label=latest%20release" alt="Latest release"></a>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue.svg" alt="MPL-2.0 license"></a>
</p>

Browser extension that uses local OCR to extract text from images, comics, scans, or any selected area of a web page, then displays the translation in an overlay or in a panel. It uses Google Translate by default, or you can use DeepL with your own API key or connect your own LLM endpoint.

<div style="display: flex; align-items: center; gap: 10px;">
  <a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the Firefox add-on" width="172" height="60"></a>
  <a href="https://chromewebstore.google.com/detail/screen-ocr-translator/legljemohhhablgapleoakcepoofloae"><img src="media/chrome-badge.png" alt="Get from Chrome Web Store" height="60"></a>
</div>

## Features

- Select any area of a web page and translate it in place.
- Translate images directly from the context menu.
- Translate a screen area live, for example hardcoded video subtitles.
- Run OCR locally in your browser using bundled [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) models.
- Recognize multilingual text with automatic script detection. See [supported languages](#text-recognition).
- Group text lines using speech-bubble and free-text regions detected by a [local layout model](docs/LAYOUT-GROUPING.md).
- Support for several translation providers:
    - Google Translate (no API key is required)
    - DeepL (requires your own [DeepL API key](https://www.deepl.com/your-account/keys))
    - OpenAI-compatible LLM endpoint (local or remote).
- Copy or listen to the original and translated text, or view them side by side.

## Usage

Open the extension from the toolbar or context menu, or press `Ctrl+Shift+F`. Drag to select an area, or click an image to translate it.

To move or resize the area before recognition starts, enable **Adjust selection before recognition** in the extension settings.

You can also right-click an image and choose "Translate this image". If clicking doesn't pick an image, for example one inside an embedded frame, use **Translate an image** from the extension popup.

In the overlay view, press `Shift` to switch between the translation and the original.

By default, the translation appears in an overlay. You can switch to the panel view from the toolbar context menu, or change the default view in the extension settings.

### Local image files
To use the extension on local image files, you need to grant access to local files.
  - Firefox: open the add-on's **Permissions and data** settings and enable **Access local files on your computer**.
  - Chrome: open the extension details and enable **Allow access to file URLs**.
After granting the permission, reload the image and try again.

## Live translation

Use it for text that keeps changing on screen, such as hardcoded video subtitles.

1. Click **Live translation** in the extension popup.
2. Drag over the area with the text you want to translate.
3. The translation appears in a small panel next to the selected area.

Things to know:

- A fast provider works best, such as a local LLM or DeepL. Google Translate also works, but its quality and speed may vary.
- Select the smallest area that fits the subtitles, so that logos and other text stay outside it. Do it while a subtitle is on screen, because the extension learns the subtitle size from the first lines it reads. Text much smaller than that, such as a watermark or player controls, is ignored.
- The area stays on the video when you scroll, zoom, or switch to full screen.
- When an LLM endpoint is used, the previous few lines are sent as context to achieve a better translation.
- It may not work with DRM-protected videos.

> [!NOTE]
> If you notice growing RAM usage during live translation while using **llama.cpp**, start the server with `--cache-ram 0`.
> This turns off llama.cpp's prompt cache, which keeps copies of earlier prompts in RAM.
> Every line is its own request by design, so lines can be translated in parallel or skipped, and the context stays small in long sessions.

## Supported languages

### Text recognition

The extension bundles several recognizer models. The general recognizer is [PP-OCRv6](https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html). It's a multilingual model that supports 50 languages and provides the best accuracy. Other scripts use separate PP-OCRv5 recognizers.

| Model | Recognized languages |
|---|---|
| PP-OCRv6 (multilingual) | Afrikaans, Albanian, Azerbaijani, Basque, Bosnian, Catalan, Chinese (Simplified & Traditional), Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Hungarian, Icelandic, Indonesian, Irish, Italian, Japanese, Latvian, Lithuanian, Malay, Norwegian, Polish, Portuguese, Romanian, Serbian (Latin), Slovak, Slovenian, Spanish, Swahili, Swedish, Tagalog, Turkish, Uzbek, Vietnamese, Welsh |
| Cyrillic-PP-OCRv5 | Belarusian, Bulgarian, Kazakh, Macedonian, Mongolian, Russian, Serbian (Cyrillic), Ukrainian |
| Korean-PP-OCRv5 | Korean |
| Arabic-PP-OCRv5 | Arabic, Pashto, Persian, Urdu |
| Devanagari-PP-OCRv5 | Hindi, Marathi, Nepali |

When the source language is set to Auto, a local classifier detects the script and selects the matching recognizer.

### Translation

Recognized text can be translated into any language supported by your chosen translation provider.

If Ollama returns HTTP 403, enable **Remove Origin header** in the LLM endpoint settings.

## Limitations

Recognized text lines are grouped into regions using a bundled RT-DETR model.
It may still miss or incorrectly group very small text, tables, or dense
multi-column layouts. Selecting a smaller area can improve results.

## WebGPU setup

> [!WARNING]
> GPU acceleration is experimental. Depending on your browser, OS and hardware, it may make text recognition faster or slower.
> The flags below enable WebGPU for all websites and can cause crashes or instability, so use them at your own risk.

### Firefox

1. Open `about:config`.
2. Set `dom.webgpu.enabled` to `true`.
3. Restart the browser.

See the [Firefox guide on enableGPU.com](https://enablegpu.com/guides/firefox/)
for a walkthrough.

### Chromium

1. Open `chrome://flags`.
2. Enable both of these flags:
    - **Unsafe WebGPU Support** (`chrome://flags/#enable-unsafe-webgpu`)
    - **Vulkan** (`chrome://flags/#enable-vulkan`)
3. Restart the browser.

## Privacy

- Captured images are processed locally.
- Recognized text is sent to the selected translation provider for translation.
- Settings and API keys are stored locally. An API key is sent only to the
  endpoint configured by the user.

See the [Privacy Policy](PRIVACY.md) for details.

## Development

Built with [WXT](https://wxt.dev/) and TypeScript.

```sh
npm ci
npm run dev         # Firefox
npm run dev:chrome  # Chrome
```

Dev mode launches the browser with the extension installed and reloads it on changes.

To test a production build, run:

```sh
npm run build         # Firefox
npm run build:chrome  # Chrome
```

The builds generate unpacked extensions in `.output/firefox-mv3` and `.output/chrome-mv3`.

- Firefox: load the directory as a temporary add-on. See [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).
- Chrome: load the directory via **Load unpacked** on `chrome://extensions` with Developer mode on.

Run the test suite and type checks with:

```sh
npm test
npm run typecheck
```

## Localization

Translations are stored in `src/public/_locales/<locale>/messages.json`.

Some locales were initially machine-translated and may need improvement. Contributions and corrections from native speakers are welcome.

## License

Screen OCR Translator is licensed under the [Mozilla Public License 2.0](LICENSE).
Bundled libraries, runtime files, and OCR models retain their original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
