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
- **Translation** — two options:
    - Google Translate (no API key needed)
    - LLM translation via a user-configured OpenAI-compatible endpoint (llama.cpp, LM Studio, or a cloud provider).
- **Text-to-speech** — Google TTS. Support for local TTS is planned.

> [!TIP]
> Enable GPU acceleration in settings for faster OCR. The extension falls back to CPU processing when WebGPU is unavailable.

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

The recognized text boxes are grouped into paragraphs using geometric heuristics. It accounts for spacing, box size, alignment, and reading direction, and tries to separate columns. Dense or irregular layouts can still confuse it:

- Tables or multi-column layouts: cells may get grouped or read in the wrong order.
- Dense manga or comic pages: sound effects and background text can get mixed into nearby speech bubbles.

If that happens, try selecting a smaller area with only the text you want to translate.

## Privacy

- Screenshots never leave your device. The captured image is processed locally.
- Recognized text is sent to the selected translation service.
- All settings, including API keys, stay in browser storage.

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
