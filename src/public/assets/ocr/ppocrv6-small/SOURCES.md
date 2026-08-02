# PP-OCRv6 Small Assets

This folder is for local model files used by the `paddle` OCR provider.

Expected files:

```txt
manifest.json
det.onnx
rec.onnx
dict.txt
```

Do not load model files from remote URLs at runtime. Add the local files here, then record the original download URL and checksum for each file in this document.

The provider runs the detector first, crops detected text lines, then runs the recognizer for each line.

## Detection Model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar
```

Archive SHA-256:

```txt
d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4
```

Files used from the archive:

```txt
PP-OCRv6_small_det_onnx_infer/inference.onnx -> det.onnx
PP-OCRv6_small_det_onnx_infer/inference.yml  -> source for detector settings in manifest.json
```

Packaged file SHA-256 (after quantization, see below):

```txt
det.onnx 914c768d3987c50ee14c718ecbe3d765736c0958e66c872e58ce2490416284e2
```

The unquantized `inference.onnx` from the archive is
`d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e`.

## Recognition Model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1
```

Files used from the archive:

```txt
PP-OCRv6_small_rec_onnx_infer/inference.onnx -> rec.onnx
PP-OCRv6_small_rec_onnx_infer/inference.yml  -> source for dict.txt
```

Packaged file SHA-256 (after quantization, see below):

```txt
rec.onnx      05d3020e86aaa3b361adc8f8c9d0438fe8f9e5299daf4173a13e6acbfc09cb47
dict.txt      b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d
manifest.json 5163c6f8b2e4e62f8390752cfd062f95df4903aa118ec358a2c7d11348b60afe
```

The unquantized `inference.onnx` from the archive is
`5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634`.

`manifest.json` is a hand-authored config derived from each model's
`inference.yml`. Detector DB post-process values (`threshold` 0.2,
`boxThreshold` 0.45, `unclipRatio` 1.4) are taken from
`PP-OCRv6_small_det_onnx_infer/inference.yml` (`DBPostProcess`).

`dict.txt` contains the `PostProcess.character_dict` list from `inference.yml`.

## Quantization

The packaged `det.onnx` and `rec.onnx` are not the archive files verbatim. Both
are weight-only int8: each Conv/MatMul weight over 4096 elements is stored as a
per-output-channel int8 tensor plus a `DequantizeLinear` node, while activations
and the compute ops stay float32. Smaller weights stay float32, since the scale
and zero-point tensors would cancel out the saving. This cuts the two files from
31.0 MB to 8.5 MB and leaves the graph a float graph, so the WebGPU path in
`ort-env.ts` still runs.

Run `npm run quantize:models` to reproduce it. See `../README.md` for why the
usual int8 recipes (`quantize_dynamic`, static QDQ) are not used here.

## Updating to a new PaddleOCR version

1. Replace `det.onnx`, `rec.onnx`, `dict.txt` with the new files (see the URLs
   above for where each comes from).
2. Update `manifest.json` from the new models' `inference.yml`.
3. Re-quantize: `npm run quantize:models -- --in-place`.
4. Refresh the checksums above (`sha256sum det.onnx rec.onnx dict.txt`).
5. Run `npm run verify:models`. It loads the models and confirms the three
   assumptions the provider relies on still hold: the detector emits a
   `[1,1,H,W]` probability map, the recognizer class count equals
   `dict lines + 2` (CTC blank + dict + space), and the recognizer output is
   already softmaxed. If any check fails it prints what to change in
   `src/providers/ocr/paddle/`.
6. Run `npm test && npm run build`.
