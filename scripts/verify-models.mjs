// Verify that the PP-OCR model assets still match the assumptions the paddle
// provider hard-codes. Run after swapping in a new PaddleOCR version:
//
//   npm run verify:models                       # checks all packaged OCR models
//   npm run verify:models -- path/to/dir [...]  # checks explicit model dir(s)
//
// It loads det.onnx + rec.onnx with onnxruntime-web (node), then checks:
//   1. detector output is a [1,1,H,W] probability map  (db-postprocess.ts)
//   2. recognizer class count == dict lines + 2 (blank + dict + space) and the
//      blank/space CTC layout still holds                (dict.ts / ctc.ts)
//   3. recognizer output is already softmaxed            (engine.ts flag)
//   4. script classifier output matches osd_labels.json  (script-classifier.ts)
// and prints the manifest values the code reads, so a config drift is visible.
//
// Exits non-zero if any hard assumption is violated.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as ort from "onnxruntime-web";

const DEFAULT_DIRS = [
  "src/public/assets/ocr/ppocrv6-small",
  "src/public/assets/ocr/cyrillic-v5",
  "src/public/assets/ocr/korean-v5",
  "src/public/assets/ocr/arabic-v5",
  "src/public/assets/ocr/devanagari-v5",
];
const SCRIPT_MODEL_DIR = path.resolve(
  "src/public/assets/script-identification",
);
const verifyScriptClassifier = process.argv.length <= 2;
const modelDirs = (process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_DIRS).map(
  (dir) => path.resolve(dir),
);

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const info = (msg) => console.log(`  • ${msg}`);

async function loadSession(modelDir, file) {
  const bytes = new Uint8Array(await readFile(path.join(modelDir, file)));
  return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
}

async function run(session, dims) {
  const data = new Float32Array(dims.reduce((a, b) => a * b, 1));
  // Non-degenerate values so the softmax check is meaningful.
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.013);
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", data, dims) };
  const results = await session.run(feeds);
  return results[session.outputNames[0]];
}

async function verifyModelDir(modelDir) {
  console.log(`Verifying models in ${modelDir}\n`);

  const manifest = JSON.parse(
    await readFile(path.join(modelDir, "model-manifest.json"), "utf8"),
  );
  const dictText = await readFile(path.join(modelDir, "dict.txt"), "utf8");
  const dictLines = dictText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const expectedClasses = dictLines.length + 2;

  console.log("Manifest (values the code reads):");
  info(`detector: maxSideLength=${manifest.detector.maxSideLength}, threshold=${manifest.detector.threshold}, boxThreshold=${manifest.detector.boxThreshold}, unclipRatio=${manifest.detector.unclipRatio}, minBoxSize=${manifest.detector.minBoxSize}, padding=${manifest.detector.padding}`);
  info(`detector: mean=${JSON.stringify(manifest.detector.mean)}, std=${JSON.stringify(manifest.detector.std)}`);
  info(`recognizer: imageHeight=${manifest.recognizer.imageHeight}, minImageWidth=${manifest.recognizer.minImageWidth}, maxImageWidth=${manifest.recognizer.maxImageWidth}`);
  info(`recognizer: mean=${JSON.stringify(manifest.recognizer.mean)}, std=${JSON.stringify(manifest.recognizer.std)}`);
  info(`dict.txt: ${dictLines.length} chars -> expected recognizer classes = ${expectedClasses}`);

  // --- Detector ---
  console.log("\nDetector (det.onnx):");
  const det = await loadSession(modelDir, manifest.detector.modelPath);
  info(`input=${JSON.stringify(det.inputNames)}, output=${JSON.stringify(det.outputNames)}`);
  const detOut = await run(det, [1, 3, 640, 640]);
  info(`output dims ${JSON.stringify(detOut.dims)}`);
  if (detOut.dims.length === 4 && detOut.dims[1] === 1) {
    pass("output is a [1,1,H,W] probability map (DB head) — db-postprocess.ts applies");
  } else {
    fail(`expected [1,1,H,W] probability map, got ${JSON.stringify(detOut.dims)} — db-postprocess.ts would not apply`);
  }

  // --- Recognizer ---
  console.log("\nRecognizer (rec.onnx):");
  const rec = await loadSession(modelDir, manifest.recognizer.modelPath);
  info(`input=${JSON.stringify(rec.inputNames)}, output=${JSON.stringify(rec.outputNames)}`);
  const recOut = await run(rec, [1, 3, manifest.recognizer.imageHeight, 320]);
  info(`output dims ${JSON.stringify(recOut.dims)}`);

  if (recOut.dims.length !== 3) {
    fail(`expected [1,T,C], got ${JSON.stringify(recOut.dims)}`);
  } else {
    const classes = recOut.dims[2];
    if (classes === expectedClasses) {
      pass(`class count ${classes} == dict(${dictLines.length}) + blank + space — dict.ts layout holds`);
    } else {
      fail(`class count ${classes} != dict(${dictLines.length}) + 2 = ${expectedClasses} (delta ${classes - expectedClasses}) — update dict.ts / ctc.ts`);
    }

    // Softmax check on the first timestep.
    const C = recOut.dims[2];
    const row = recOut.data.subarray(0, C);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of row) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const looksLikeProb = Math.abs(sum - 1) < 0.02 && min >= -1e-6 && max <= 1 + 1e-6;
    if (looksLikeProb) {
      pass(`output already softmaxed (row sum ${sum.toFixed(3)}) — engine.ts uses outputsAreProbabilities=true`);
    } else {
      fail(`output looks like logits (row sum ${sum.toFixed(2)}, range [${min.toFixed(2)}, ${max.toFixed(2)}]) — set outputsAreProbabilities=false in engine.ts`);
    }
  }

}

async function verifyScriptModel(modelDir) {
  console.log(`\n---\n\nVerifying script classifier in ${modelDir}\n`);
  const labels = JSON.parse(
    await readFile(path.join(modelDir, "osd_labels.json"), "utf8"),
  );
  const session = await loadSession(modelDir, "osd_lstm.onnx");
  const output = await run(session, [1, 1, 48, 320]);
  info(
    `input=${JSON.stringify(session.inputNames)}, output=${JSON.stringify(session.outputNames)}`,
  );
  info(`output dims ${JSON.stringify(output.dims)}`);

  if (
    output.dims.length === 2 &&
    output.dims[1] === labels.length &&
    labels[0] === "NULL" &&
    labels[2] === "Broken"
  ) {
    pass(`output classes match ${labels.length} labels and CTC special ids`);
  } else {
    fail(`expected [T,${labels.length}] with NULL=0 and Broken=2`);
  }

  const row = output.data.subarray(0, output.dims[1]);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of row) {
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (Math.abs(sum - 1) < 0.02 && min >= -1e-6 && max <= 1 + 1e-6) {
    pass(`output is softmaxed (row sum ${sum.toFixed(3)})`);
  } else {
    fail(`output is not softmaxed (row sum ${sum.toFixed(2)})`);
  }
}

async function main() {
  // Match the runtime: default onnxruntime-web import + locally hosted jsep wasm.
  ort.env.wasm.wasmPaths =
    path.resolve("node_modules/onnxruntime-web/dist") + "/";
  ort.env.wasm.numThreads = 1;

  for (const [index, modelDir] of modelDirs.entries()) {
    if (index > 0) {
      console.log("\n---\n");
    }
    await verifyModelDir(modelDir);
  }
  if (verifyScriptClassifier) {
    await verifyScriptModel(SCRIPT_MODEL_DIR);
  }

  console.log(
    failures === 0
      ? "\n✓ All model assumptions hold."
      : `\n✗ ${failures} assumption(s) violated — see above.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nverify:models failed to run:", error.message);
  process.exit(1);
});
