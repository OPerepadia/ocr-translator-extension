# OSD script classifier sources

The packaged files come from
[`ogkalu/image-script-identification`](https://huggingface.co/ogkalu/image-script-identification)
revision `82c21077f798b80def944eec379b06569c7d48e7`.

The publisher identifies the repository as Apache-2.0. `comic-translate`
describes `osd_lstm.onnx` as the Tesseract OSD LSTM model ported to ONNX and
documents the input normalization and CTC decoding in its
[`ScriptDetector`](https://github.com/ogkalu2/comic-translate/blob/93bb1edd7425e76f2cd70c89ea5d2eafb63e8f9c/modules/detection/script_detection.py).

The extension packages both upstream files without changing them:

```text
b18e0c1479d9eb67394993098f7e1079c9a93ef6f7b0416ee333fccb865c6e72  osd_lstm.onnx
a1888156b005065039c356e13a7bbef1ec454b45bf6aaf18c11f4a59b1ee35c5  osd_labels.json
```
