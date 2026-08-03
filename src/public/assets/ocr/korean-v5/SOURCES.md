# Korean PP-OCRv5 mobile recognizer

Local Korean-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

Supports Korean, plus English and common symbols. Model card:
https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec

See `../README.md` for the archive conventions, the quantization the packaged
file went through, and how to update it.

## Recognition model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/korean_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
568ed8b43a260adc9f484d92105e425ea8cddf8ce16940c177bc12864cfb0eb0
```

Upstream `inference.onnx` SHA-256:

```txt
92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08
```

Packaged file SHA-256:

```txt
rec.onnx      3b2f9aa0dc9adc6db612100b31b8e35d3b7e0609bfc4e85c7c84feab6cf0bd72
dict.txt      a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7
manifest.json 1de7a367248664e99d3631edd140a29ee50a7185223ebed98ad1b7bb9247d38b
```

`dict.txt` has 11,945 entries — Hangul, Latin, numbers, and common symbols — so
the recognizer emits 11,947 classes.
