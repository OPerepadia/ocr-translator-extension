# ONNX Runtime Web WASM Assets

These files are the WebAssembly runtime for the `paddle` OCR provider. They are
loaded locally — `ort.env.wasm.wasmPaths` points at this folder's runtime URL, so
no WASM is fetched from a remote source.

## Source

Copied verbatim from the `onnxruntime-web` npm package (pinned in `package.json`):

```txt
node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm -> ort-wasm-simd-threaded.jsep.wasm
node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs  -> ort-wasm-simd-threaded.jsep.mjs
```

Package version: `onnxruntime-web@1.26.0`

Source repository: https://github.com/microsoft/onnxruntime/tree/v1.26.0

ONNX Runtime is licensed under the MIT License. Its license and Microsoft's
full upstream notice file for version 1.26.0 are included in the top-level
`THIRD_PARTY_NOTICES.md`.

The `.jsep` build serves both the WASM and WebGPU execution providers. We run the
WASM provider for now (`executionProviders: ["wasm"]`); adding WebGPU later is a
one-line change in `src/providers/ocr/paddle/ort-env.ts` and reuses the same files.

## Checksums (SHA-256)

```txt
ort-wasm-simd-threaded.jsep.wasm 411b39a77bb006ce0cf17b30c978c66a130ebb2ba39c8dfdbdc9c1c5a251ae76
ort-wasm-simd-threaded.jsep.mjs  33949a3310b723a3ee14dc2da989e55060de26a75e2346095a150a042c9aad4e
```

## Updating

When bumping `onnxruntime-web`, re-copy both files from the package's `dist/` and
update the version and checksums above.
