# Comic text and bubble region detector

The packaged model is the INT8 ONNX export published by `ogkalu`:

```txt
https://huggingface.co/ogkalu/comic-text-and-bubble-detector
https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/16e8a622f91fabc6b5b65c96d32d1183f8843546/detector-v4-s_int8.onnx
```

The model repository identifies the model family as RT-DETR-v2 and licenses
the weights under Apache-2.0. Its model card describes training on about 11,000
Manga, Webtoon, Manhua, and Western Comic style images.

The upstream classes are:

```txt
0 bubble
1 text_bubble
2 text_free
```

The extension uses classes 1 and 2 as text regions. It removes cross-class
duplicates with class-agnostic NMS, assigns OCR lines to the remaining regions,
and keeps uncovered OCR lines as individual groups. Class 0 is not used because
it duplicates the outer speech-bubble boundary around class 1.

The upstream preprocessing configuration resizes directly to 640 by 640,
rescales RGB values by 1/255, and does not apply mean/std normalization. The
export expects `orig_target_sizes` in width-height order.

The extension runs this INT8 model through the WASM execution provider. ONNX
Runtime Web's WebGPU provider cannot initialize the export because its graph
contains a `MaxPool` shape computation with `ceil_mode`. OCR detection and
recognition may still use WebGPU in a separate session.

Packaged file SHA-256:

```txt
detector.onnx       5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79
model-manifest.json 0aaad780510d672a87ebb114e4b5a92844206a7faeac1905507c7f5e74c58ba8
```
