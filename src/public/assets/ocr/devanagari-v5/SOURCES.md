# Devanagari PP-OCRv5 mobile recognizer

Local Devanagari-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

## Recognition model

Official PaddlePaddle ONNX export:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/devanagari_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
21cbdcb0c5656923500359ba053b814fc6089dbffa5e5017125d8654c0551817
```

Files used from the archive:

```txt
devanagari_PP-OCRv5_mobile_rec_onnx_infer/inference.onnx -> rec.onnx
devanagari_PP-OCRv5_mobile_rec_onnx_infer/inference.yml  -> dict.txt and recognizer settings
```

Packaged file SHA-256 (after quantization, see below):

```txt
rec.onnx      9da51e486186a10118a6189e5bbca79825c9a10669d8738a8d29d0ef574d5d10
dict.txt      09c7440bfc5477e5c41052304b6b185aff8c4a5e8b2b4c23c1c706f6fe1ee9fc
manifest.json 03d2285479f977552e215e44a6acdbfb899bc7a51e3ee5364ef1fb5e7673f92f
```

The unquantized `inference.onnx` from the archive is
`cb789212ce96c69d3e74728ae4309d179281d68cb3945d0616b67cafab41c986`.

`dict.txt` contains the 568 `PostProcess.character_dict` entries from
`inference.yml`, in the same order. The recognizer emits 570 classes: CTC blank,
the dictionary entries, and space.

The model supports Hindi, Marathi, Nepali, Maithili, Bhojpuri, Magahi, Konkani,
Sanskrit, Haryanvi, and other Devanagari-script languages, plus English.

## Quantization

The packaged `rec.onnx` is not the archive file verbatim. It is weight-only
int8: each Conv/MatMul weight over 4096 elements is stored as a
per-output-channel int8 tensor plus a `DequantizeLinear` node, while activations
and the compute ops stay float32. Smaller weights stay float32, since the scale
and zero-point tensors would cancel out the saving. This cuts the file from
7.91 MB to 2.16 MB and leaves the graph a float graph, so the WebGPU path in
`ort-env.ts` still runs. The conversion also rewrites the export from opset 7 to
13 and moves its `Constant`-node weights into initializers.

Run `npm run quantize:models` to reproduce it. See `../README.md` for why the
usual int8 recipes (`quantize_dynamic`, static QDQ) are not used here.

## Updating

1. Replace `rec.onnx` and regenerate `dict.txt` from the archive.
2. Update `manifest.json` if the model preprocessing changes.
3. Re-quantize: `npm run quantize:models -- --in-place src/public/assets/ocr/devanagari-v5`.
4. Refresh the checksums above.
5. Run `npm run verify:models -- src/public/assets/ocr/devanagari-v5`.
6. Run `npm test && npm run build`.
