# Packaged OCR models

One folder per recognizer, each with its own `manifest.json`, `dict.txt`,
`rec.onnx`, and a `SOURCES.md` recording where the model came from and its
checksum. `ppocrv6-small` also holds `det.onnx`, the text detector, which every
recognizer shares — detection finds text boxes and does not depend on the
script. The provider runs the detector first, crops the detected text lines,
then runs the recognizer on each one.

`src/providers/ocr/paddle/` loads these files at runtime.
`src/providers/catalog.ts` maps each language to the folder that handles it.

## Where the files come from

All six models are official PaddlePaddle ONNX exports, downloaded as `.tar`
archives.

Every archive contains `inference.onnx` and `inference.yml`. The `.onnx`
becomes `det.onnx` or `rec.onnx`, after the quantization below. What the `.yml`
feeds depends on which kind of archive it came from:

- A recognizer archive's `inference.yml` is the source for `dict.txt` — its
  `PostProcess.character_dict` list, one entry per line, in the same order — and
  for the recognizer block of the hand-authored `manifest.json`.
- The detector archive (`PP-OCRv6_small_det_onnx_infer`) has no dictionary and
  no `dict.txt` of its own. Its `inference.yml` is the source for the detector
  block, which every folder's `manifest.json` repeats.

Each `SOURCES.md` records its archive URL and three checksums: the archive,
the upstream `inference.onnx`, and the packaged files.

The official model cards license these PaddlePaddle models under Apache-2.0.
See the top-level `THIRD_PARTY_NOTICES.md`.

The recognizers emit `dict.txt` lines + 2 classes: the CTC blank, the dictionary
entries, then space. Their output is already softmaxed.

The manifests are near-identical by design. Each carries the same detector block,
since the detector is shared — its DB post-process values (`threshold` 0.2,
`boxThreshold` 0.45, `unclipRatio` 1.4) come from `DBPostProcess` in
`PP-OCRv6_small_det_onnx_infer/inference.yml` — and the same recognizer
preprocessing (`imageHeight` 48, mean/std 0.5). Only `version` and
`detector.modelPath` differ between them.

## Quantization

The models are stored weight-only int8 and are not the upstream archive files
verbatim. Each Conv/MatMul weight over 4096 elements is a per-output-channel
int8 tensor plus a `DequantizeLinear` node, while activations
and the compute ops stay float32. Smaller weights (94 tensors, 459 KB across the
six files) stay float32, since the scale and zero-point tensors would cancel out
the saving. For the four PP-OCRv5 recognizers the conversion also rewrites the
export from opset 7 to 13 and moves their `Constant`-node weights into
initializers.

`scripts/quantize-models.py` does the conversion; `scripts/quantize-models.sh`
runs it in `scripts/.venv`, creating the virtualenv from
`scripts/requirements-quantize.txt` on first use.

```sh
npm run quantize:models                 # convert all, write to .output/quantized
npm run quantize:models -- --in-place   # overwrite the packaged models
```

This is a one-time offline step, not part of `npm run build`. Re-running it on
already-converted models is a no-op.

## Updating a recognizer

1. Replace `rec.onnx` with the new archive's `inference.onnx`, and regenerate
   `dict.txt` from its `inference.yml`.
2. Update the recognizer block of `manifest.json` from that same `inference.yml`.
3. Re-quantize: `npm run quantize:models -- --in-place <dir>`.
4. Refresh that folder's `SOURCES.md`: the archive's SHA-256, the upstream
   `inference.onnx` SHA-256, and the `Packaged file SHA-256` block
   (`sha256sum rec.onnx dict.txt manifest.json`).
5. Run `npm run verify:models -- <dir>`. It loads the models and confirms the
   three assumptions the provider relies on still hold: the detector emits a
   `[1,1,H,W]` probability map, the recognizer class count equals `dict lines + 2`
   (CTC blank + dict + space), and the recognizer output is already softmaxed.
6. Run `npm test && npm run build`.

Both scripts default to every packaged model when given no directory.

## Updating the shared detector

`det.onnx` is not `ppocrv6-small`'s alone: all five folders point at it and all
five manifests carry a copy of its settings. Replacing it is the procedure above
applied to `ppocrv6-small` — minus `dict.txt`, which the detector archive does
not supply — plus three things it does not cover.

- Diff the new archive's `inference.yml` against the detector block and copy any
  changed value into **all five** `manifest.json` files. `verify:models` prints
  these values but never compares them against `inference.yml` or across folders,
  so a manifest still holding the old detector's `DBPostProcess` thresholds
  passes every check and silently degrades detection.
- Refresh `det.onnx` in `ppocrv6-small/SOURCES.md` (`sha256sum det.onnx`, on top
  of the recognizer hashes), and the `manifest.json` hash in every folder whose
  manifest you touched.
- Run `npm run verify:models` with no directory, so every folder loads the new
  detector through its own relative path.

## Why not the standard int8 recipes

Do not switch to `quantize_dynamic` or static QDQ. Those are the recipes in
ONNX Runtime's quantization guide[^1], which targets server and mobile CPU/GPU
and has no ORT Web section. The WebGPU kernels ORT Web ships implement
`DequantizeLinear` but not `QuantizeLinear`, `ConvInteger` or `MatMulInteger`,
so those recipes push every Conv onto the WASM CPU backend and silently disable
the WebGPU path in `ort-env.ts` — for worse accuracy than the weight-only
scheme.

Keeping the compute in float32 is the point: the graph stays a float graph, so
any execution provider that ran the original runs this too. The cost is that ORT
does not constant-fold the `DequantizeLinear` nodes, so weights are dequantized
on each run — roughly 15% slower detection and 27% slower per recognized line on
WASM, with weights staying int8 in memory.

[^1]: https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html
