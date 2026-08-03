# Devanagari PP-OCRv5 mobile recognizer

Local Devanagari-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

Supports Hindi, Marathi, Nepali, Maithili, Bhojpuri, Magahi, Konkani, Sanskrit,
Haryanvi, and other Devanagari-script languages, plus English.

See `../README.md` for the archive conventions, the quantization the packaged
file went through, and how to update it.

## Recognition model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/devanagari_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
21cbdcb0c5656923500359ba053b814fc6089dbffa5e5017125d8654c0551817
```

Upstream `inference.onnx` SHA-256:

```txt
cb789212ce96c69d3e74728ae4309d179281d68cb3945d0616b67cafab41c986
```

Packaged file SHA-256:

```txt
rec.onnx      9da51e486186a10118a6189e5bbca79825c9a10669d8738a8d29d0ef574d5d10
dict.txt      09c7440bfc5477e5c41052304b6b185aff8c4a5e8b2b4c23c1c706f6fe1ee9fc
manifest.json 03d2285479f977552e215e44a6acdbfb899bc7a51e3ee5364ef1fb5e7673f92f
```

`dict.txt` has 568 entries, so the recognizer emits 570 classes.
