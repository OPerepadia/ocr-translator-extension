import { t } from "@/shared/i18n";
import type { PipelineStatus } from "@/shared/types";

export function pipelineStatusMessage(status: PipelineStatus): string {
  switch (status.stage) {
    case "loading":
      return t("statusLoadingImage");
    case "initializing":
      return t("statusInitializingOcr");
    case "recognizing":
      return status.lineCount && status.lineCount > 0
        ? t("statusRecognizingText")
        : t("statusAnalyzingImage");
    case "translating":
      return t("statusTranslating");
  }
}

/** Fraction of recognized lines, or undefined when progress is indeterminate. */
export function pipelineStatusProgress(
  status: PipelineStatus,
): number | undefined {
  if (status.stage !== "recognizing") {
    return undefined;
  }
  const { line, lineCount } = status;
  if (line === undefined || !lineCount || lineCount <= 0) {
    return undefined;
  }
  return Math.min(Math.max(line / lineCount, 0), 1);
}
