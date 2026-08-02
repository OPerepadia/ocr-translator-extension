# Packaged OCR models

One folder per recognizer, each with its own `manifest.json`, `dict.txt`,
`rec.onnx`, and a `SOURCES.md` recording where the model came from and its
checksum. `ppocrv6-small` also holds `det.onnx`, the text detector, which every
recognizer shares — detection finds text boxes and does not depend on the
script, so the other folders point at it with a relative path.

`src/providers/ocr/paddle/` reads these; `src/providers/catalog.ts` lists which
folder backs which language.

## Quantization

The models are stored weight-only int8 and are **not** the upstream archive
files verbatim. Each Conv/MatMul weight over 4096 elements is a
per-output-channel int8 tensor plus a `DequantizeLinear` node, while activations
and the compute ops stay float32. Smaller weights (94 tensors, 459 KB across the
six files) stay float32, since the scale and zero-point tensors would cancel out
the saving. This takes the six files from 68.4 MB to 18.7 MB.

`scripts/quantize-models.py` does the conversion; `scripts/quantize-models.sh`
runs it in `scripts/.venv`, creating the virtualenv from
`scripts/requirements-quantize.txt` on first use.

```sh
npm run quantize:models                 # convert all, write to .output/quantized
npm run quantize:models -- --in-place   # overwrite the packaged models
```

This is a one-time offline step, not part of `npm run build`. Re-running it on
already-converted models is a no-op. After running it with `--in-place`, update
the `Packaged file SHA-256` block in each model's `SOURCES.md` with the hashes
the script prints, then run `npm run verify:models` and `npm test`.

## Why not the standard int8 recipes

Do not switch to `quantize_dynamic` or static QDQ. Those are the recipes in
ONNX Runtime's quantization guide[^1], which targets server and mobile CPU/GPU
and has no ORT Web section. The WebGPU kernels ORT Web ships implement
`DequantizeLinear` but not `QuantizeLinear`, `ConvInteger` or `MatMulInteger`,
so those recipes push every Conv onto the WASM CPU backend and silently disable
the WebGPU path in `ort-env.ts` — for worse accuracy than the weight-only
scheme.

Keeping the compute in float32 is the point: the graph stays a float graph, so
any execution provider that ran the original runs this too. The cost is that ORT
does not constant-fold the `DequantizeLinear` nodes, so weights are dequantized
on each run — roughly 15% slower detection and 27% slower per recognized line on
WASM, with weights staying int8 in memory.

[^1]: https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html
