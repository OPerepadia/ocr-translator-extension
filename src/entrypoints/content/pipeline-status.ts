import { t } from "@/shared/i18n";
import type { PipelineStatus } from "@/shared/types";

export function pipelineStatusMessage(status: PipelineStatus): string {
  switch (status.stage) {
    case "loading":
      return t("statusLoadingImage");
    case "initializing":
      return t("statusInitializingOcr");
    case "recognizing":
      return t("statusRecognizingText");
    case "translating":
      return t("statusTranslating");
  }
}

/** Fraction of recognized lines, or undefined outside recognition. */
export function pipelineStatusProgress(
  status: PipelineStatus,
): number | undefined {
  if (status.stage !== "recognizing") {
    return undefined;
  }
  const { line, lineCount } = status;
  if (line === undefined || !lineCount || lineCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(line / lineCount, 0), 1);
}

/** False while recognizing: an animated spinner makes Chrome composite every
 * frame, which slows down WebGPU recognition. */
export function pipelineStatusShowsSpinner(status: PipelineStatus): boolean {
  return status.stage !== "recognizing";
}
