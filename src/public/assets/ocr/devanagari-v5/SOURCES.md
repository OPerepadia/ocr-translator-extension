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

Packaged file SHA-256:

```txt
rec.onnx      cb789212ce96c69d3e74728ae4309d179281d68cb3945d0616b67cafab41c986
dict.txt      09c7440bfc5477e5c41052304b6b185aff8c4a5e8b2b4c23c1c706f6fe1ee9fc
manifest.json 03d2285479f977552e215e44a6acdbfb899bc7a51e3ee5364ef1fb5e7673f92f
```

`dict.txt` contains the 568 `PostProcess.character_dict` entries from
`inference.yml`, in the same order. The recognizer emits 570 classes: CTC blank,
the dictionary entries, and space.

The model supports Hindi, Marathi, Nepali, Maithili, Bhojpuri, Magahi, Konkani,
Sanskrit, Haryanvi, and other Devanagari-script languages, plus English.

## Updating

1. Replace `rec.onnx` and regenerate `dict.txt` from the archive.
2. Update `manifest.json` if the model preprocessing changes.
3. Refresh the checksums above.
4. Run `npm run verify:models -- src/public/assets/ocr/devanagari-v5`.
5. Run `npm test && npm run build`.
