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

Packaged file SHA-256:

```txt
det.onnx d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e
```

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

Packaged file SHA-256:

```txt
rec.onnx      5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634
dict.txt      b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d
manifest.json 5163c6f8b2e4e62f8390752cfd062f95df4903aa118ec358a2c7d11348b60afe
```

`manifest.json` is a hand-authored config derived from each model's
`inference.yml`. Detector DB post-process values (`threshold` 0.2,
`boxThreshold` 0.45, `unclipRatio` 1.4) are taken from
`PP-OCRv6_small_det_onnx_infer/inference.yml` (`DBPostProcess`).

`dict.txt` contains the `PostProcess.character_dict` list from `inference.yml`.

## Updating to a new PaddleOCR version

1. Replace `det.onnx`, `rec.onnx`, `dict.txt` with the new files (see the URLs
   above for where each comes from).
2. Update `manifest.json` from the new models' `inference.yml`.
3. Refresh the checksums above (`sha256sum det.onnx rec.onnx dict.txt`).
4. Run `npm run verify:models`. It loads the models and confirms the three
   assumptions the provider relies on still hold: the detector emits a
   `[1,1,H,W]` probability map, the recognizer class count equals
   `dict lines + 2` (CTC blank + dict + space), and the recognizer output is
   already softmaxed. If any check fails it prints what to change in
   `src/providers/ocr/paddle/`.
5. Run `npm test && npm run build`.
