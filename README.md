# Screen OCR Translator

<p>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/actions/workflows/ci.yml"><img src="https://github.com/OPerepadia/ocr-translator-extension/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/releases"><img src="https://img.shields.io/github/v/release/OPerepadia/ocr-translator-extension?label=latest%20release" alt="Latest release"></a>
  <a href="https://github.com/OPerepadia/ocr-translator-extension/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue.svg" alt="MPL-2.0 license"></a>
</p>

Browser extension that uses local OCR to extract text from images, comics, scans, or any selected area of a web page, then displays the translation in an overlay or in a panel. It uses Google Translate by default, or you can connect it to your own LLM endpoint.

<div style="display: flex; align-items: center; gap: 10px;">
  <a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the Firefox add-on" width="172" height="60"></a>
  <a href="https://chromewebstore.google.com/detail/screen-ocr-translator/legljemohhhablgapleoakcepoofloae"><img src="media/chrome-badge.png" alt="Get from Chrome Web Store" height="60"></a>
</div>

## Features

- Select any area of a web page and translate it in place.
- Translate images directly from the context menu.
- Run OCR locally in your browser using bundled [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) models.
- Recognize multilingual text with automatic script detection. See [supported languages](#text-recognition).
- Group text lines using speech-bubble and free-text regions detected by a [local layout model](docs/LAYOUT-GROUPING.md).
- Translate recognized text with Google Translate (no API key required) or an OpenAI-compatible LLM endpoint (local or remote).
- Copy or listen to the original and translated text, or view them side by side.

## Usage

Activate the extension from the browser toolbar or context menu, or press `Ctrl+Shift+F`. Select an area of the page and click "Recognize text".

To translate an image directly, right-click it and select "Translate this image".

By default, translations appear over the original text. You can switch to showing a panel from the toolbar's context menu.

The default shortcut is `Ctrl+Shift+F`. To change it in Firefox, open `about:addons`, click the gear button, and select **Manage Extension Shortcuts**. In Chrome, open `chrome://extensions/shortcuts`.

> [!NOTE]
> To use the extension on local image files, you need to grant access to local files.
> - Firefox: open the add-on's **Permissions and data** settings and enable **Access local files on your computer**.
> - Chrome: open the extension details and enable **Allow access to file URLs**.
>
> After granting the permission, reload the image and try again.

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

Recognized text can be translated into any language supported by Google Translate, or any language supported by your configured LLM endpoint.

If Ollama returns HTTP 403, enable **Remove Origin header** in the LLM endpoint settings.

## Limitations

Recognized text lines are grouped into regions using a bundled RT-DETR model.
It may still miss or incorrectly group very small text, tables, or dense
multi-column layouts. Selecting a smaller area can improve results.

## WebGPU setup

> [!WARNING]
> GPU acceleration is experimental. Depending on your browser, OS and hardware, it may make text recognition faster or slower. You can enable it in settings.

On Linux, WebGPU is generally disabled by default. Follow the steps below to enable it.

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

## License

Screen OCR Translator is licensed under the [Mozilla Public License 2.0](LICENSE).
Bundled libraries, runtime files, and OCR models retain their original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
