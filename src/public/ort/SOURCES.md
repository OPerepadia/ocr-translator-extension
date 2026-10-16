# ONNX Runtime Web WASM Assets

These files are the WebAssembly runtime for the `paddle` OCR provider. They are
loaded locally — `ort.env.wasm.wasmPaths` points at this folder's runtime URL, so
no WASM is fetched from a remote source.

## Source

Copied verbatim from the `onnxruntime-web` npm package (pinned in `package.json`):

```txt
node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm -> ort-wasm-simd-threaded.asyncify.wasm
node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs  -> ort-wasm-simd-threaded.asyncify.mjs
```

Package version: `onnxruntime-web@1.30.0`

Source repository: https://github.com/microsoft/onnxruntime/tree/v1.30.0

ONNX Runtime is licensed under the MIT License. Its license and Microsoft's
full upstream notice file for version 1.30.0 are included in the top-level
`THIRD_PARTY_NOTICES.md`.

The `.asyncify` build is the one `onnxruntime-web/webgpu` loads. It serves both
the WASM provider and the native WebGPU execution provider.

## Checksums (SHA-256)

```txt
ort-wasm-simd-threaded.asyncify.wasm 39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da
ort-wasm-simd-threaded.asyncify.mjs  3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28
```

## Updating

When bumping `onnxruntime-web`, re-copy both files from the package's `dist/` and
update the version and checksums above.
