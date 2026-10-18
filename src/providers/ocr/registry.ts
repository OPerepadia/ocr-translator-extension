import { createPaddleOcrProvider } from "./paddle";
import type { OcrProviderFactory } from "./types";

export const ocrRegistry = {
  paddle: createPaddleOcrProvider,
  // The background passes the manga recognizer as this provider's model.
  "paddle-manga": createPaddleOcrProvider,
} satisfies Record<string, OcrProviderFactory>;

export type OcrProviderId = keyof typeof ocrRegistry;

