# Arabic PP-OCRv5 mobile recognizer

Local Arabic-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

## Recognition model

Official PaddlePaddle ONNX export:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/arabic_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
9bd3ac8530211c961a173496059b6d12917ef2fb587f3014f128d99ac8422731
```

Files used from the archive:

```txt
arabic_PP-OCRv5_mobile_rec_onnx_infer/inference.onnx -> rec.onnx
arabic_PP-OCRv5_mobile_rec_onnx_infer/inference.yml  -> dict.txt and recognizer settings
```

Packaged file SHA-256:

```txt
rec.onnx      799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110
dict.txt      7f92f7dbb9b75a4787a83bfb4f6d14a8ab515525130c9d40a9036f61cf6999e9
manifest.json 82dfc90051d898f6c5cfc062cce194b48401ee1c74ca492002e1a4e7ad5ac909
```

`dict.txt` contains the 747 `PostProcess.character_dict` entries from
`inference.yml`, in the same order. The recognizer emits 749 classes: CTC blank,
the dictionary entries, and space.

The model supports Arabic, Persian, Urdu, Pashto, Uyghur, Sindhi, Balochi,
Kurdish, and English.

## Updating

1. Replace `rec.onnx` and regenerate `dict.txt` from the archive.
2. Update `manifest.json` if the model preprocessing changes.
3. Refresh the checksums above.
4. Run `npm run verify:models -- src/public/assets/ocr/arabic-v5`.
5. Run `npm test && npm run build`.
