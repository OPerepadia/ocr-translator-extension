# PP-OCRv6 Manga v0.2

Source: [Kellenok/PP-OCRv6_manga](https://huggingface.co/Kellenok/PP-OCRv6_manga),
revision `ba1d479e8a61a20e8318c9758c73fbbbd290b98d` (Apache-2.0).

The detector and recognizer were downloaded as the FP32 ONNX graphs. The
extension's `scripts/quantize-models.py` converted their weights to int8 while
keeping the compute graph in float32. The dictionary is byte-identical to the
packaged PP-OCRv6 small dictionary.

| File | Upstream SHA-256 | Packaged SHA-256 |
| --- | --- | --- |
| `det.onnx` | `d132078c46e292b226fb5a2ca52a7612ad319262dfdf493e7d8e3be435295978` | `ed2491f65d86e5ee0fb25c5829590cab0b68dfdb538c77b218a64f8c4729caca` |
| `rec.onnx` | `de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888` | `9d87ea8f0fdb2c9b6286d8597e9358839d75c2dbe78f4e3985a90943edcfd537` |
| `dict.txt` | same as PP-OCRv6 small | `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` |
| `model-manifest.json` | hand-authored from the source inference script | `52b056d2a43a5dfd868bf8f8a6df6cd2d76795d52b832c76ec2b174aacf8acde` |

The manifest uses the [source inference script's](https://huggingface.co/Kellenok/PP-OCRv6_manga/blob/ba1d479e8a61a20e8318c9758c73fbbbd290b98d/examples/onnx_openvino.py) detector thresholds and the recognizer's
48-pixel input height and 0.5 normalization. `npm run verify:models --
src/public/assets/ocr/ppocrv6-manga` checks the output shapes, dictionary
size, and recognizer softmax output.

The manifest sets `detector.splitThreshold` to `0.5`. This custom extension heuristic
helps separate text lines that the detector accidentally joins into one box, such as
adjacent vertical columns in a speech bubble. The recognizer expects one text line per crop.
