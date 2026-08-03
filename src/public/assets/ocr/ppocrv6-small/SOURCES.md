# PP-OCRv6 Small assets

The shared text detector (`det.onnx`) plus the default recognizer, covering
Latin scripts, Chinese, and Japanese. Every other folder points its manifest at
this `det.onnx`.

See `../README.md` for the archive conventions, the quantization the packaged
files went through, and how to update them.

## Detection model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar
```

Archive SHA-256:

```txt
d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4
```

Upstream `inference.onnx` SHA-256:

```txt
d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e
```

Packaged file SHA-256:

```txt
det.onnx 914c768d3987c50ee14c718ecbe3d765736c0958e66c872e58ce2490416284e2
```

This archive's `inference.yml` is also the source of the detector settings in
every folder's `manifest.json`, not just this one, and it carries no dictionary —
`dict.txt` comes from the recognizer archive below. Replacing the detector
therefore touches all five folders; see `Updating the shared detector` in
`../README.md`.

## Recognition model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1
```

Upstream `inference.onnx` SHA-256:

```txt
5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634
```

Packaged file SHA-256:

```txt
rec.onnx      05d3020e86aaa3b361adc8f8c9d0438fe8f9e5299daf4173a13e6acbfc09cb47
dict.txt      b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d
manifest.json 5163c6f8b2e4e62f8390752cfd062f95df4903aa118ec358a2c7d11348b60afe
```

`dict.txt` has 18,708 entries, so the recognizer emits 18,710 classes.
