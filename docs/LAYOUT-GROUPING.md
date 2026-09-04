# Text layout grouping

The extension groups recognized lines into text regions before translating them:

```text
source image
  -> detect and recognize text lines with PP-OCR
  -> detect larger text regions with RT-DETR
  -> assign and order lines within each region
  -> translate each group
```

The region detector is [`ogkalu/comic-text-and-bubble-detector`](https://huggingface.co/ogkalu/comic-text-and-bubble-detector), an RT-DETR-v2 model
trained on about 11,000 Manga, Webtoon, Manhua, and Western Comic style images.

This model was selected because it detects both text inside comic bubbles and
free text. The packaged INT8 ONNX export is licensed under Apache-2.0.
See [`layout-grouping/SOURCES.md`](../src/public/assets/layout-grouping/SOURCES.md).

## Runtime backend

The region detector always runs with WASM backend. The packaged
INT8 model cannot run with ONNX Runtime Web's WebGPU provider because its graph
contains an unsupported `MaxPool` shape computation with `ceil_mode`, which ONNX Runtime
Web WebGPU does not support.

Useful verification commands after runtime changes are:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser:firefox
npm run build:chrome
npm run test:browser:chrome
```
