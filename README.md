# Screen OCR Translator

Browser extension that captures text from images, comics, scans, or any selected area of a web page using local OCR, then displays the translation in an overlay.
It uses Google Translate by default, or you can connect it to your own LLM endpoint.

<div style="display: flex; align-items: center; gap: 10px;">
  <a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/">
    <img src="media/firefox-badge.png" alt="Get the Firefox add-on" width="172" height="60">
  </a>
  
  <a href="https://chromewebstore.google.com/detail/screen-ocr-translator/legljemohhhablgapleoakcepoofloae">
    <img src="media/chrome-badge.png" alt="Get from Chrome Web Store" height="60">
  </a>
</div>

## Usage

Activate the extension from the browser toolbar, or the context menu, or by pressing `Ctrl+Shift+F`. Select an area of the page and click "Run OCR".

To translate an image directly, right-click it and select "Translate this image".

Translation appears over the original text. Hover over a text box to view the original text and its translation, which can be copied or read aloud. Use the extension toolbar to show or hide the translation overlay.

The default shortcut is `Ctrl+Shift+F`. To change it in Firefox, open `about:addons`, click the gear button, and select **Manage Extension Shortcuts**. In Chrome, open `chrome://extensions/shortcuts`.

> [!NOTE]
> On Firefox 153 and later, if you want to run this extension on local image files, open the add-on's **Permissions and data** settings and enable **Access local files on your computer**, then reload the image.

## How it works

- **OCR** — PaddleOCR, running locally in the browser.
- **Text grouping** — a local RT-DETR model detects speech bubbles and free-text regions before translation. See [Text layout grouping](docs/LAYOUT-GROUPING.md) for implementation details.
- **Translation** — two options:
    - Google Translate (no API key needed)
    - LLM translation via a user-configured OpenAI-compatible endpoint (llama.cpp, LM Studio, or a cloud provider).
- **Text-to-speech** — Google TTS. Support for local TTS is planned.

### WebGPU setup

> [!TIP]
> You can enable GPU acceleration in extension settings to run OCR faster.

On Linux, WebGPU is generally disabled by default. Follow the steps below to enable it.

#### Firefox

1. Open `about:config`.
2. Set `dom.webgpu.enabled` to `true`.
3. Restart the browser.

See the [Firefox guide on enableGPU.com](https://enablegpu.com/guides/firefox/)
for a walkthrough.

#### Chromium

1. Open `chrome://flags`
2. Enable both of these flags:
    - **Unsafe WebGPU Support** (`chrome://flags/#enable-unsafe-webgpu`)
    - **Vulkan** (`chrome://flags/#enable-vulkan`)
3. Restart the browser.

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
