# Screen OCR Translator

Firefox extension that uses optical character recognition (OCR) to capture text from any selected area of a web page and translate it.

<a href="https://addons.mozilla.org/firefox/addon/screen-ocr-translator/"><img src="media/firefox-badge.png" alt="Get the add-on" width="172" height="60"></a>

## How it works

Activate the add-on from the browser toolbar or the context menu, then select an area of the page and click 'Run OCR'. To translate an image directly, right-click it and choose 'Translate this image'. Once recognition finishes, the translation appears as an overlay drawn on top of the original text. Hover over a text box to see the original text and the translation, which can be copied or read aloud. The overlay can be toggled from the toolbar.

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

## Keyboard shortcut

Press `Ctrl+Shift+F` to select a screen region for translation. To change the shortcut, open `about:addons`, click the gear button, and select **Manage Extension Shortcuts**.

## Privacy

- Screenshots never leave your device. The captured image is processed locally.
- Recognized text is sent to the selected translation service.
- All settings, including API keys, stay in browser storage.

## Development

Built with [WXT](https://wxt.dev/) and TypeScript.

```sh
npm ci
npm run dev
```

Dev mode launches Firefox with the extension installed and reloads it on changes.

To test a production build, run:

```sh
npm run build
```

The build generates an unpacked extension in `.output/firefox-mv3`. Load that directory as a temporary add-on. See [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Run the test suite and type checks with:

```sh
npm test
npm run typecheck
```
