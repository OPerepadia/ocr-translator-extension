# korean PP-OCRv5 mobile recognizer

Local model files for the Korean OCR variant. This folder adds a Korean
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
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/korean_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
568ed8b43a260adc9f484d92105e425ea8cddf8ce16940c177bc12864cfb0eb0
```

Files used from the archive:

```txt
korean_PP-OCRv5_mobile_rec_onnx_infer/inference.onnx -> rec.onnx
korean_PP-OCRv5_mobile_rec_onnx_infer/inference.yml  -> source for dict.txt and recognizer settings in manifest.json
```

Packaged file SHA-256:

```txt
rec.onnx      92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08
dict.txt      a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7
manifest.json 1de7a367248664e99d3631edd140a29ee50a7185223ebed98ad1b7bb9247d38b
```

`dict.txt` is the `PostProcess.character_dict` list from `inference.yml`, written
one character per line in the same order (11,945 entries: Hangul, Latin,
numbers, and common symbols). The recognizer emits 11,947 classes (CTC blank +
11,945 + space), which `verify:models` confirms.

`manifest.json` mirrors the detector settings from `../ppocrv6-small/manifest.json`
(the shared detector) and uses the standard rec preprocessing (`imageHeight` 48,
mean/std 0.5). The model output is already softmaxed.

## Languages

Korean, plus English and common symbols. See the official model card:
https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec

## Updating

1. Replace `rec.onnx` and `dict.txt` from the new archive (URL above).
2. Update `manifest.json` from the new model's `inference.yml`.
3. Refresh the checksums above (`sha256sum rec.onnx dict.txt manifest.json`).
4. Run `npm run verify:models -- src/public/assets/ocr/korean-v5`.
5. Run `npm test && npm run build`.
