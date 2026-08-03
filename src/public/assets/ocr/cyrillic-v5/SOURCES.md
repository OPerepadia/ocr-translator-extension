# Cyrillic PP-OCRv5 mobile recognizer

Local Cyrillic-script recognizer. It reuses the detector from
`../ppocrv6-small/det.onnx`.

Supports Russian, Belarusian, Ukrainian, Serbian (Cyrillic), Bulgarian,
Mongolian, Macedonian, Kazakh, and other Cyrillic-script languages, plus
English. Model card:
https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec

See `../README.md` for the archive conventions, the quantization the packaged
file went through, and how to update it.

## Recognition model

Source archive:

```txt
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/cyrillic_PP-OCRv5_mobile_rec_onnx_infer.tar
```

Archive SHA-256:

```txt
3f5657de92e90edeb63483424aadcf19caee571b45d35af75a163a2ca576a260
```

Upstream `inference.onnx` SHA-256:

```txt
5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5
```

Packaged file SHA-256:

```txt
rec.onnx      3873c7da60d186d4eda418228c37e961a1136c03e94ff25376fe7f7c261e315a
dict.txt      db40aa52ceb112055be80c694afdf655d5d2c4f7873704524cc16a447ca913ba
manifest.json 9608c7d4ebaf05e60b5bd7358a3f687943bd6cd59cd317f3f8186d6c161e6243
```

`dict.txt` has 850 entries — Latin, Greek, Cyrillic, and common symbols — so the
recognizer emits 852 classes.
