import { base64ToBlob, blobToBase64 } from "./image";
import type { WorkerRequest } from "../providers/ocr/paddle/protocol";
import type { EncodedImage } from "./types";

/** Port name the offscreen document answers OCR traffic on. */
export const OCR_RELAY_PORT = "ocr-inference";

/** A WorkerRequest as it crosses the port. Chrome serializes port messages as
 * JSON, so the capture travels base64-encoded; every other field survives
 * as-is, and worker responses carry no binary at all. */
export type RelayedRequest =
  | Exclude<WorkerRequest, { type: "recognize" }>
  | (Omit<Extract<WorkerRequest, { type: "recognize" }>, "image"> & {
      image: EncodedImage;
    });

export async function encodeRequest(
  message: WorkerRequest,
): Promise<RelayedRequest> {
  if (message.type !== "recognize") {
    return message;
  }
  return {
    ...message,
    image: {
      data: await blobToBase64(message.image),
      mediaType: message.image.type || "application/octet-stream",
    },
  };
}

export function decodeRequest(message: RelayedRequest): WorkerRequest {
  if (message.type !== "recognize") {
    return message;
  }
  return {
    ...message,
    image: base64ToBlob(message.image.data, message.image.mediaType),
  };
}
