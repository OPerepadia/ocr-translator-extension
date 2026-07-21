import { createPaddleOcrProvider } from "./paddle";
import type { OcrProviderFactory } from "./types";

export const ocrRegistry = {
  paddle: createPaddleOcrProvider,
} satisfies Record<string, OcrProviderFactory>;

export type OcrProviderId = keyof typeof ocrRegistry;

