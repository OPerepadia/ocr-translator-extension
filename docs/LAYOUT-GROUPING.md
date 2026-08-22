# Text layout grouping

## Current implementation

The extension groups OCR lines before translation.

The pipeline is:

```text
source image
  -> PP-OCR text-line detection
  -> PP-OCR line recognition
  -> RT-DETR text-region detection
  -> assign recognized lines to regions
  -> order lines inside each region
  -> translate each assembled group
```

The region detector model is [`ogkalu/comic-text-and-bubble-detector`](https://huggingface.co/ogkalu/comic-text-and-bubble-detector), an RT-DETR-v2 model
trained on about 11,000 Manga, Webtoon, Manhua, and Western Comic style images.

This model was selected because it detects both text inside comic bubbles and
free text. The packaged INT8 ONNX export is licensed under Apache-2.0.
See [`layout-grouping/SOURCES.md`](../src/public/assets/layout-grouping/SOURCES.md)
for more details.

## Why grouping is a separate model

PP-OCR detects text lines. That is useful for recognition, but it is not enough
to decide which columns belong to the same caption or speech bubble.

The region model sees the complete source image and predicts larger semantic
text regions. The grouper then maps the already recognized OCR lines into those
regions. This keeps grouping independent of the source language, recognized
text, and translation provider.

The main implementation files are:

- `src/providers/ocr/paddle/region-grouper.ts`: model input, output filtering,
  NMS, and OCR-line assignment;
- `src/providers/ocr/paddle/assemble.ts`: ordering and joining lines inside a
  group;
- `src/providers/ocr/paddle/engine.ts`: OCR and grouping pipeline;
- `src/public/assets/layout-grouping/model-manifest.json`: runtime settings;
- `src/public/assets/layout-grouping/detector.onnx`: packaged weights.

## Runtime backend

The PP-OCR detector and recognizer may run with WebGPU. The region detector
always runs with WASM backend.

The current INT8 RT-DETR export cannot initialize with the WebGPU provider. Its
graph uses a `MaxPool` shape computation with `ceil_mode`, which ONNX Runtime
Web WebGPU does not support. Quantized operator coverage is another potential
problem.

Useful verification commands after runtime changes are:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser:firefox
npm run build:chrome
npm run test:browser:chrome
```
