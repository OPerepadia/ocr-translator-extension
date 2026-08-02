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

Packaged file SHA-256 (after quantization, see below):

```txt
rec.onnx      7d7cddfb36496ca65ea6afd321c1b59ee94d06d7c6bcd979d3a5ecaca2b4cfec
dict.txt      7f92f7dbb9b75a4787a83bfb4f6d14a8ab515525130c9d40a9036f61cf6999e9
manifest.json 82dfc90051d898f6c5cfc062cce194b48401ee1c74ca492002e1a4e7ad5ac909
```

The unquantized `inference.onnx` from the archive is
`799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110`.

`dict.txt` contains the 747 `PostProcess.character_dict` entries from
`inference.yml`, in the same order. The recognizer emits 749 classes: CTC blank,
the dictionary entries, and space.

The model supports Arabic, Persian, Urdu, Pashto, Uyghur, Sindhi, Balochi,
Kurdish, and English.

## Quantization

The packaged `rec.onnx` is not the archive file verbatim. It is weight-only
int8: each Conv/MatMul weight over 4096 elements is stored as a
per-output-channel int8 tensor plus a `DequantizeLinear` node, while activations
and the compute ops stay float32. Smaller weights stay float32, since the scale
and zero-point tensors would cancel out the saving. This cuts the file from
8.00 MB to 2.18 MB and leaves the graph a float graph, so the WebGPU path in
`ort-env.ts` still runs. The conversion also rewrites the export from opset 7 to
13 and moves its `Constant`-node weights into initializers.

Run `npm run quantize:models` to reproduce it. See `../README.md` for why the
usual int8 recipes (`quantize_dynamic`, static QDQ) are not used here.

## Updating

1. Replace `rec.onnx` and regenerate `dict.txt` from the archive.
2. Update `manifest.json` if the model preprocessing changes.
3. Re-quantize: `npm run quantize:models -- --in-place src/public/assets/ocr/arabic-v5`.
4. Refresh the checksums above.
5. Run `npm run verify:models -- src/public/assets/ocr/arabic-v5`.
6. Run `npm test && npm run build`.
