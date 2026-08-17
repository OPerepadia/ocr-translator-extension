# Screen OCR Translator

Browser extension that uses optical character recognition (OCR) to capture text from any selected area of a web page and translate it.

<a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the add-on" width="172" height="60"></a>

## Installation

Firefox: install from [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/screen-ocr-translator/).

Chrome: download zip from the [latest release](https://github.com/OPerepadia/ocr-translator-extension/releases/latest) and load it manually:

1. Unpack the zip.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the unpacked folder.

## Usage

Activate the extension from the browser toolbar, or the context menu, or by pressing `Ctrl+Shift+F`. Select an area of the page and click "Run OCR".

To translate an image directly, right-click it and select "Translate this image".

The translation appears over the original text. Hover over a text box to view the original text and its translation, which can be copied or read aloud. Use the extension toolbar to show or hide the translation overlay.

> [!NOTE]
> On Firefox 153 and later, using this extension on local files require separate permission.
> Open the add-on's **Permissions and data** settings and enable **Access local files on your computer**, then reload the local file.

## Keyboard shortcut

The default shortcut is `Ctrl+Shift+F`. To change it in Firefox, open `about:addons`, click the gear button, and select **Manage Extension Shortcuts**. In Chrome, open `chrome://extensions/shortcuts`.

## How it works

- **OCR** — PaddleOCR, running locally in the browser.
- **Text grouping** — a local RT-DETR model detects speech bubbles and free-text regions before translation. See [Text layout grouping](docs/LAYOUT-GROUPING.md) for implementation details.
- **Translation** — two options:
    - Google Translate (no API key needed)
    - LLM translation via a user-configured OpenAI-compatible endpoint (llama.cpp, LM Studio, or a cloud provider).
- **Text-to-speech** — Google TTS. Support for local TTS is planned.

> [!TIP]
> Enable GPU acceleration in settings for faster OCR. The extension falls back
> to CPU processing when WebGPU is unavailable.

## Supported languages

The extension bundles several recognizers. By default, it uses [PP-OCRv6](https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html), which supports 50 languages and offers the best accuracy. Scripts that PP-OCRv6 doesn't cover (Cyrillic, Korean and others) use PP-OCRv5 recognizers.

| Script model | Recognized languages |
|---|---|
| Latin / Chinese / Japanese *(default)* | Afrikaans, Albanian, Azerbaijani, Basque, Bosnian, Catalan, Chinese (Simplified & Traditional), Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Hungarian, Icelandic, Indonesian, Irish, Italian, Japanese, Latvian, Lithuanian, Malay, Norwegian, Polish, Portuguese, Romanian, Serbian (Latin), Slovak, Slovenian, Spanish, Swahili, Swedish, Tagalog, Turkish, Uzbek, Vietnamese, Welsh |
| Cyrillic | Belarusian, Bulgarian, Kazakh, Macedonian, Mongolian, Russian, Serbian (Cyrillic), Ukrainian |
| Korean | Korean |
| Arabic | Arabic, Pashto, Persian, Urdu |
| Devanagari | Hindi, Marathi, Nepali |

Translations can target any of 70+ languages supported by Google Translate, or any language your configured LLM supports.

## Limitations

Recognized text lines are grouped into regions using a bundled RT-DETR model.
It may still miss or incorrectly group very small text, tables, or dense
multi-column layouts. Selecting a smaller area can improve results.

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

Both engines run MV3, but the background differs: Firefox uses an event page that hosts the OCR engine directly, while Chrome uses an offscreen document because its service worker cannot create the dedicated OCR worker.

Run the test suite and type checks with:

```sh
npm test
npm run typecheck
```

The Chrome OCR host also has a real-browser smoke test:

```sh
npx playwright install chromium
npm run test:browser
```

## License

Screen OCR Translator is licensed under the [MIT License](LICENSE).
Bundled libraries, runtime files, and OCR models retain their original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
