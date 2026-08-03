# Shrink the packaged PP-OCR models with weight-only int8 quantization.
# This is a one-time offline conversion: run it, check the result, commit the
# smaller models. It is not part of `npm run build`.
#
#   scripts/quantize-models.sh                    # convert all, write to .output/quantized
#   scripts/quantize-models.sh --in-place         # overwrite the packaged models
#   scripts/quantize-models.sh path/to/dir [...]  # convert explicit model dir(s)
#
# Conv/MatMul weights above MIN_WEIGHT_ELEMS are stored as per-output-channel
# int8 plus a DequantizeLinear node; smaller ones stay float32, where the added
# scale and zero-point tensors would cancel out the saving. Activations and the
# compute ops stay float32, so the graph is still a float graph and every
# execution provider that runs the
# original runs this one. That matters here: the WebGPU kernels ORT Web ships
# implement DequantizeLinear but not QuantizeLinear, ConvInteger or
# MatMulInteger, so the usual int8 recipes (quantize_dynamic, static QDQ) would
# push every Conv onto the WASM CPU backend and disable the WebGPU path in
# ort-env.ts. Weight-only int8 keeps it.
#
# Cost: ORT does not constant-fold the DequantizeLinear nodes, so weights are
# dequantized on each run (~15% slower detection, ~27% slower per recognized
# line on WASM) and stay int8 in memory.
#
# After converting: update the `Packaged file SHA-256` block in each model's
# SOURCES.md with the hashes printed below, then run `npm run verify:models`
# and `npm test`.

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper, version_converter

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = REPO_ROOT / "src/public/assets/ocr"
DEFAULT_DIRS = [
    ASSET_ROOT / "ppocrv6-small",
    ASSET_ROOT / "cyrillic-v5",
    ASSET_ROOT / "korean-v5",
    ASSET_ROOT / "arabic-v5",
    ASSET_ROOT / "devanagari-v5",
]

# Per-axis DequantizeLinear needs opset 13; the v5 recognizers export at 7.
TARGET_OPSET = 13
# Below this, the int8 weight plus its scale/zero-point tensors is not a win.
MIN_WEIGHT_ELEMS = 4096
# Smoke-test divergence bound. The packaged models measure 0.02-0.15 on the probe
# below; deliberately corrupting a scale tensor reaches 0.12-0.96. The overlap is
# why this only catches gross breakage — see check().
MAX_SMOKE_NRMSE = 0.5


def lift_constants(model):
    """Move Constant-node weights into initializers.

    The PP-OCRv5 exports keep every weight in a Constant node and have no
    initializers at all, which hides them from the weight matcher.
    """
    graph = model.graph
    kept = []
    moved = 0
    for node in graph.node:
        value = next(
            (a.t for a in node.attribute if a.name == "value"), None
        ) if node.op_type == "Constant" and len(node.output) == 1 else None
        if value is None:
            kept.append(node)
            continue
        tensor = TensorProto()
        tensor.CopyFrom(value)
        tensor.name = node.output[0]
        graph.initializer.append(tensor)
        moved += 1
    del graph.node[:]
    graph.node.extend(kept)
    return moved


def drop_identity(model):
    """Rewire consumers past Identity nodes.

    The v5 exports route MatMul weights through Identity chains. Left in place
    they hide ~50% of the Korean recognizer's weights from quantization.
    """
    graph = model.graph
    alias = {n.output[0]: n.input[0] for n in graph.node if n.op_type == "Identity"}

    def root(name):
        seen = set()
        while name in alias and name not in seen:
            seen.add(name)
            name = alias[name]
        return name

    graph_outputs = {o.name for o in graph.output}
    kept = []
    for node in graph.node:
        if node.op_type == "Identity" and node.output[0] not in graph_outputs:
            continue
        for i, name in enumerate(node.input):
            if name in alias:
                node.input[i] = root(name)
        kept.append(node)
    dropped = len(graph.node) - len(kept)
    del graph.node[:]
    graph.node.extend(kept)
    return dropped


def drop_unused_initializers(model):
    """Remove initializers no node consumes.

    Lifting Constants brings across scalars the v5 exports never reference.
    They are tiny, but ORT logs an "unused initializer" warning for each one
    every time a session is created.
    """
    graph = model.graph
    used = {name for node in graph.node for name in node.input}
    used.update(o.name for o in graph.output)
    used.update(i.name for i in graph.input)
    unused = [i for i in graph.initializer if i.name not in used]
    for initializer in unused:
        graph.initializer.remove(initializer)
    return len(unused)


def prepare(path):
    """Load a model and normalize it into a shape the quantizer can work on."""
    model = onnx.load(str(path))
    # Convert the opset first: the converter validates against graph.input, and
    # pre-IR4 exports do not list initializers there, so lifting first fails.
    current = next(
        (o.version for o in model.opset_import if o.domain in ("", "ai.onnx")), None
    )
    if current is not None and current < TARGET_OPSET:
        model = version_converter.convert_version(model, TARGET_OPSET)
    moved = lift_constants(model)
    drop_identity(model)
    if moved:
        model.ir_version = 9
    return model, moved


def quantize_per_channel(weight, axis):
    """Symmetric int8, one scale per output channel.

    A handful of channels carry weights around 1e-40, which would give a
    denormal scale. Denormal handling is implementation-defined in WGSL, so
    those channels get scale 1.0 instead and quantize to an exact zero. That
    shifts the weight by ~1e-40 — no different from zero in float32 arithmetic
    here — and makes the result identical on every backend.
    """
    moved = np.moveaxis(weight, axis, 0)
    flat = moved.reshape(moved.shape[0], -1)
    amax = np.abs(flat).max(axis=1)
    degenerate = amax < np.finfo(np.float32).tiny * 127.0
    scale = np.where(degenerate, 1.0, amax / 127.0).astype(np.float32)
    quantized = np.rint(flat / scale[:, None]).clip(-127, 127).astype(np.int8)
    return np.moveaxis(quantized.reshape(moved.shape), 0, axis), scale


def weight_only_int8(model):
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}

    # Output-channel axis differs per op: Conv weights are [O,I,kH,kW], a
    # MatMul's B operand is [K,N].
    targets = {}
    for node in graph.node:
        if node.op_type == "Conv" and len(node.input) >= 2:
            if node.input[1] in initializers:
                targets[node.input[1]] = 0
        elif node.op_type == "MatMul":
            for index, name in enumerate(node.input):
                if name in initializers:
                    targets[name] = 1 if index == 1 else 0

    dq_nodes = []
    converted = 0
    saved = 0
    for name, axis in targets.items():
        weight = numpy_helper.to_array(initializers[name])
        if weight.dtype != np.float32 or weight.size < MIN_WEIGHT_ELEMS:
            continue
        quantized, scale = quantize_per_channel(weight, axis)
        zero_point = np.zeros_like(scale, dtype=np.int8)

        tensors = [
            numpy_helper.from_array(quantized, name + "_i8"),
            numpy_helper.from_array(scale, name + "_scale"),
            numpy_helper.from_array(zero_point, name + "_zp"),
        ]
        graph.initializer.extend(tensors)
        dq_nodes.append(
            helper.make_node(
                "DequantizeLinear",
                inputs=[t.name for t in tensors],
                outputs=[name],
                name=name + "_dq",
                axis=axis,
            )
        )
        saved += weight.nbytes - quantized.nbytes - scale.nbytes - zero_point.nbytes
        converted += 1

    for node in dq_nodes:
        graph.initializer.remove(initializers[node.output[0]])

    # A DequantizeLinear has to precede the node it feeds.
    existing = list(graph.node)
    del graph.node[:]
    graph.node.extend(dq_nodes + existing)

    drop_unused_initializers(model)

    rebuilt = helper.make_model(graph, opset_imports=list(model.opset_import))
    rebuilt.ir_version = 9
    return rebuilt, converted, saved


def already_quantized(model):
    """True when Conv/MatMul weights already come from a DequantizeLinear."""
    produced = {out: node.op_type for node in model.graph.node for out in node.output}
    return any(
        produced.get(weight) == "DequantizeLinear"
        for node in model.graph.node
        if node.op_type in ("Conv", "MatMul")
        for weight in node.input[1:]
    )


def probe_input(height, width):
    """A white page with dark glyph-like blocks.

    Deterministic, and far better behaved than uniform noise: noise drives these
    models to a near-uniform softmax where the output moves a lot for reasons
    that have nothing to do with the conversion.
    """
    image = np.ones((height, width), np.float32)
    rng = np.random.RandomState(0)
    y = 6
    while y + 10 < height:
        x = 6
        while x + 6 < width:
            glyph = rng.randint(3, 7)
            if x + glyph < width and rng.rand() < 0.75:
                image[y : y + 10, x : x + glyph] = 0.05
            x += glyph + rng.randint(2, 4)
        y += 18
    stacked = np.repeat(image[None], 3, 0)[None]
    return ((stacked - 0.5) / 0.5).astype(np.float32)


def check(original_path, quantized_path, is_detector):
    """Smoke test: the quantized model loads, runs, keeps its output shape, and
    does not diverge catastrophically from the original.

    This does not certify accuracy. Measured on a single probe input, a
    correctly converted model and a subtly corrupted one overlap, so only gross
    breakage is caught here. Judge quality by decoding real text with both
    models and comparing, not by this number.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        return "onnxruntime not installed, skipped"

    options = ort.SessionOptions()
    options.log_severity_level = 3
    height, width = (640, 640) if is_detector else (48, 320)
    sample = probe_input(height, width)

    try:
        sessions = [
            ort.InferenceSession(str(p), options, providers=["CPUExecutionProvider"])
            for p in (original_path, quantized_path)
        ]
        outputs = [
            s.run(None, {s.get_inputs()[0].name: sample})[0].astype(np.float32)
            for s in sessions
        ]
    except Exception as error:  # noqa: BLE001 - report, do not abort the batch
        return f"FAILED to run: {error}"

    reference, converted = outputs
    if reference.shape != converted.shape:
        return f"FAILED shape {reference.shape} != {converted.shape}"
    if not np.isfinite(converted).all():
        nans = int(np.isnan(converted).sum())
        infs = int(np.isinf(converted).sum())
        return f"FAILED non-finite output ({nans} NaN, {infs} Inf)"

    scale = float(np.linalg.norm(reference))
    nrmse = float(np.linalg.norm(reference - converted) / max(scale, 1e-12))
    if nrmse > MAX_SMOKE_NRMSE:
        return f"FAILED diverged from original (nrmse {nrmse:.3f} > {MAX_SMOKE_NRMSE})"
    return f"smoke ok, shape {tuple(converted.shape)}, nrmse {nrmse:.3f}"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mb(path):
    return Path(path).stat().st_size / 1e6


def main():
    parser = argparse.ArgumentParser(
        description="Weight-only int8 quantization for the packaged PP-OCR models."
    )
    parser.add_argument("dirs", nargs="*", type=Path, help="model dirs (default: all packaged)")
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="overwrite the packaged models instead of writing to --out-dir",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=REPO_ROOT / ".output/quantized",
        help="where to write converted models (default: .output/quantized)",
    )
    parser.add_argument("--no-check", action="store_true", help="skip the load-and-run check")
    args = parser.parse_args()

    model_dirs = [d.resolve() for d in (args.dirs or DEFAULT_DIRS)]
    rows = []
    hashes = []
    skipped = []

    for model_dir in model_dirs:
        if not model_dir.is_dir():
            print(f"! {model_dir} is not a directory", file=sys.stderr)
            return 1
        # A model dir may share the detector with ppocrv6-small; only convert
        # the files it actually owns.
        names = [n for n in ("det.onnx", "rec.onnx") if (model_dir / n).is_file()]
        if not names:
            print(f"! {model_dir} has no det.onnx or rec.onnx", file=sys.stderr)
            return 1

        for name in names:
            source = model_dir / name
            label = f"{model_dir.name}/{name}"
            print(f"Converting {label} ...", flush=True)

            model, moved = prepare(source)
            if already_quantized(model):
                print(f"  {label} is already weight-only int8, nothing to do")
                skipped.append(label)
                continue

            model, converted, saved = weight_only_int8(model)
            if converted == 0:
                print(f"  ! no Conv/MatMul weights matched in {label}", file=sys.stderr)
                return 1

            if args.in_place:
                destination = source
            else:
                destination = args.out_dir / model_dir.name / name
                destination.parent.mkdir(parents=True, exist_ok=True)
            staged = destination.with_suffix(".onnx.tmp")
            onnx.save(model, str(staged))

            status = "checked skipped" if args.no_check else check(
                source, staged, name == "det.onnx"
            )
            if status.startswith("FAILED"):
                staged.unlink(missing_ok=True)
                print(f"  ! {label}: {status}", file=sys.stderr)
                return 1

            before = mb(source)
            shutil.move(str(staged), str(destination))
            after = mb(destination)
            rows.append((label, before, after, moved, converted, status))
            hashes.append((label, sha256(destination)))

    if not rows:
        print(f"\nNothing to convert: all {len(skipped)} model(s) are already "
              f"weight-only int8.")
        return 0

    print(f"\n{'model':28s} {'before':>8s} {'after':>8s} {'saved':>7s}  weights  check")
    total_before = total_after = 0.0
    for label, before, after, moved, converted, status in rows:
        total_before += before
        total_after += after
        print(
            f"{label:28s} {before:8.2f} {after:8.2f} {100 * (1 - after / before):6.1f}% "
            f"{converted:8d}  {status}"
        )
    print(
        f"{'TOTAL':28s} {total_before:8.2f} {total_after:8.2f} "
        f"{100 * (1 - total_after / total_before):6.1f}%"
    )

    print("\nSHA-256 for the SOURCES.md `Packaged file` blocks:")
    for label, digest in hashes:
        print(f"  {label:28s} {digest}")

    if not args.in_place:
        print(f"\nWrote to {args.out_dir}. Re-run with --in-place to replace the packaged models.")
    print("Next: update each SOURCES.md, then `npm run verify:models && npm test`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
