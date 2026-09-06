import { t } from "@/shared/i18n";
import type { LangCode } from "@/shared/types";
import type { ContentControls } from "./content-controls";
import { createLanguagePill } from "./language-picker";
import { createOptionPicker } from "./option-picker";

export interface ContentControlPicker {
  element: HTMLElement;
  dispose(): void;
}

interface PickerOptions {
  position?: "below" | "auto";
  compact?: boolean;
}

export function createOcrSourceLanguagePicker(
  controls: ContentControls,
  options: PickerOptions = {},
): ContentControlPicker | undefined {
  if (controls.ocrSourceLanguages.length < 2) {
    return undefined;
  }

  return createLanguagePill({
    target: controls.currentOcrSourceLanguageId,
    languages: controls.ocrSourceLanguages
      .map(({ id }) => id)
      .filter((id) => id !== "auto"),
    specialEntries: [
      {
        code: "auto",
        name:
          controls.ocrSourceLanguages.find(({ id }) => id === "auto")?.label ??
          t("commonAuto"),
      },
    ],
    position: options.position,
    buttonLabel: options.compact
      ? compactLanguageLabel(controls.currentOcrSourceLanguageId)
      : undefined,
    title: (name) => t("panelSourceLanguage", name),
    onChange: controls.selectOcrSourceLanguage,
  });
}

export function createTargetLanguagePicker(args: {
  controls: ContentControls;
  target: LangCode | undefined;
  position?: "below" | "auto";
  compact?: boolean;
  onSelect(target: LangCode): void;
}): ContentControlPicker | undefined {
  if (!args.target) {
    return undefined;
  }

  return createLanguagePill({
    target: args.target,
    languages: args.controls.targetLanguages,
    position: args.position,
    buttonLabel: args.compact
      ? compactLanguageLabel(args.target)
      : undefined,
    onChange: (target) => {
      args.onSelect(target);
      args.controls.selectTargetLanguage(target);
    },
  });
}

function compactLanguageLabel(code: LangCode): string {
  return code === "auto" ? t("commonAuto") : code.toUpperCase();
}

export function createTranslationProviderPicker(
  controls: ContentControls,
  options: { overlay?: boolean } = {},
): ContentControlPicker | undefined {
  return createOptionPicker({
    options: controls.translationProviders,
    currentId: controls.currentTranslationProviderId,
    overlay: options.overlay,
    title: (current) => t("panelTranslationProvider", current.label),
    onSelect: controls.selectTranslationProvider,
  });
}
