// Image preprocessing math for PP-OCRv6. The resize math and the RGBA → NCHW
// tensor builder are pure (no browser APIs) so they are unit-testable; the
// actual canvas resize lives in crop.ts.

export type Rgb = [number, number, number];

export interface DetSize {
  targetW: number;
  targetH: number;
  /** Multiply a detector-space x by this to map back to original-image x. */
  scaleX: number;
  /** Multiply a detector-space y by this to map back to original-image y. */
  scaleY: number;
}

/** Round to the nearest positive multiple of `step`. */
function roundToMultiple(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

/** Detector input size: downscale so the longer side <= maxSide, round both
 * dims to a multiple of 32 (DB requirement), plus factors to map coords back. */
export function computeDetSize(
  width: number,
  height: number,
  maxSide: number,
): DetSize {
  const longest = Math.max(width, height);
  const ratio = longest > maxSide ? maxSide / longest : 1;
  const targetW = roundToMultiple(width * ratio, 32);
  const targetH = roundToMultiple(height * ratio, 32);
  return {
    targetW,
    targetH,
    scaleX: width / targetW,
    scaleY: height / targetH,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Recognizer input width for a crop, keeping aspect at the fixed height. */
export function computeRecWidth(
  cropWidth: number,
  cropHeight: number,
  imageHeight: number,
  minWidth: number,
  maxWidth: number,
): number {
  const scaled = Math.round((imageHeight * cropWidth) / Math.max(1, cropHeight));
  return clamp(scaled, minWidth, maxWidth);
}

/**
 * Convert RGBA pixel data into a planar NCHW Float32 tensor [1, 3, H, W],
 * normalized as (channel/255 - mean) / std. Alpha is ignored.
 */
export function imageDataToNchw(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mean: Rgb,
  std: Rgb,
): Float32Array {
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    out[i] = (r - mean[0]) / std[0];
    out[plane + i] = (g - mean[1]) / std[1];
    out[plane * 2 + i] = (b - mean[2]) / std[2];
  }
  return out;
}
