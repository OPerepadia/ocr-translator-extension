# cyrillic PP-OCRv5 mobile recognizer

Local model files for the Cyrillic OCR variant. This folder adds a Cyrillic
recognizer; it reuses the detector from `../ppocrv6-small/det.onnx`, since
detection finds text boxes and does not depend on the script.

Files in this folder:

```txt
manifest.json
rec.onnx
dict.txt
```

The detector is shared, so `manifest.json` points `detector.modelPath` at
`../ppocrv6-small/det.onnx`. See that folder's `SOURCES.md` for the detector's
own source and checksum.

Do not load model files from remote URLs at runtime. The files live here; their
original download URL and checksum are recorded below.

## Recognition Model

Source archive (official PaddlePaddle ONNX export):

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/cyrillic_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
3f5657de92e90edeb63483424aadcf19caee571b45d35af75a163a2ca576a260
```

Files used from the archive:

```txt
cyrillic_PP-OCRv5_mobile_rec_onnx_infer/inference.onnx -> rec.onnx
cyrillic_PP-OCRv5_mobile_rec_onnx_infer/inference.yml  -> source for dict.txt and recognizer settings in manifest.json
```

Packaged file SHA-256:

```txt
rec.onnx      5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5
dict.txt      db40aa52ceb112055be80c694afdf655d5d2c4f7873704524cc16a447ca913ba
manifest.json 9608c7d4ebaf05e60b5bd7358a3f687943bd6cd59cd317f3f8186d6c161e6243
```

`dict.txt` is the `PostProcess.character_dict` list from `inference.yml`, written
one character per line in the same order (850 entries: Latin, Greek, Cyrillic,
and common symbols). The recognizer emits 852 classes (CTC blank + 850 + space),
which `verify:models` confirms.

`manifest.json` mirrors the detector settings from `../ppocrv6-small/manifest.json`
(the shared detector) and uses the standard rec preprocessing (`imageHeight` 48,
mean/std 0.5). The model output is already softmaxed.

## Languages

Russian, Belarusian, Ukrainian, Serbian (Cyrillic), Bulgarian, Mongolian,
Macedonian, Kazakh, and other Cyrillic-script languages, plus English. See the
official model card: https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec

## Updating

1. Replace `rec.onnx` and `dict.txt` from the new archive (URL above).
2. Update `manifest.json` from the new model's `inference.yml`.
3. Refresh the checksums above (`sha256sum rec.onnx dict.txt manifest.json`).
4. Run `npm run verify:models -- src/public/assets/ocr/cyrillic-v5`.
5. Run `npm test && npm run build`.
