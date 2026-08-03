# Arabic PP-OCRv5 mobile recognizer

Local Arabic-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

Supports Arabic, Persian, Urdu, Pashto, Uyghur, Sindhi, Balochi, Kurdish, and
English.

See `../README.md` for the archive conventions, the quantization the packaged
file went through, and how to update it.

## Recognition model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/arabic_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
9bd3ac8530211c961a173496059b6d12917ef2fb587f3014f128d99ac8422731
```

Upstream `inference.onnx` SHA-256:

```txt
799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110
```

Packaged file SHA-256:

```txt
rec.onnx      7d7cddfb36496ca65ea6afd321c1b59ee94d06d7c6bcd979d3a5ecaca2b4cfec
dict.txt      7f92f7dbb9b75a4787a83bfb4f6d14a8ab515525130c9d40a9036f61cf6999e9
manifest.json 82dfc90051d898f6c5cfc062cce194b48401ee1c74ca492002e1a4e7ad5ac909
```

`dict.txt` has 747 entries, so the recognizer emits 749 classes.
