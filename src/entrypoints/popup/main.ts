import {
  COMMON_OCR_SOURCE_LANGUAGES,
  TRANSLATION_PROVIDERS,
} from "@/providers/catalog";
import { COMMON_TARGET_LANGUAGES } from "@/providers/translation/target-languages";
import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
} from "@/shared/activation";
import { browserApi } from "@/shared/browser";
import {
  localizeMarkedElements,
  t,
  translationProviderLabel,
} from "@/shared/i18n";
import { isFirefoxLocalFileAccessDenied } from "@/shared/local-file-access";
import {
  createSettingsRepository,
  getDisplayMode,
  setDisplayMode,
  type DisplayMode,
} from "@/shared/storage";
import type { Settings } from "@/shared/types";
import { languageName } from "@/entrypoints/content/language-picker";
import "./style.css";

const settingsRepository = createSettingsRepository();
let currentSettings: Settings;
let pendingSave: Promise<void> = Promise.resolve();

localizeMarkedElements();
void initPopup();

async function initPopup(): Promise<void> {
  const elements = getPopupElements();
  elements.openSettings.addEventListener("click", () => {
    void openSettings(elements);
  });

  try {
    const [settings, displayMode, [activeTab]] = await Promise.all([
      settingsRepository.get(),
      getDisplayMode(),
      browserApi.tabs.query({ active: true, currentWindow: true }),
    ]);
    currentSettings = settings;

    fillLanguageSelect(
      elements.sourceLanguage,
      COMMON_OCR_SOURCE_LANGUAGES.map(({ id }) => id),
      settings.ocr.sourceLang ?? "auto",
      true,
    );
    fillLanguageSelect(
      elements.targetLanguage,
      COMMON_TARGET_LANGUAGES,
      settings.translation.targetLang,
    );
    fillProviderSelect(
      elements.translationProvider,
      settings.translation.providerId,
    );
    elements.displayMode.value = displayMode;

    elements.controls.addEventListener("change", () => {
      currentSettings = {
        ...currentSettings,
        ocr: {
          ...currentSettings.ocr,
          sourceLang: elements.sourceLanguage.value,
        },
        translation: {
          ...currentSettings.translation,
          targetLang: elements.targetLanguage.value,
          providerId: elements.translationProvider.value,
        },
      };
      queuePopupSave(elements);
    });

    elements.selectArea.addEventListener("click", () => {
      void startSelection(elements);
    });
    elements.selectArea.disabled = false;

    if (
      !isActivationPageSupported(activeTab?.url) ||
      typeof activeTab?.id !== "number"
    ) {
      disableSelection(elements, t("popupRestrictedPage"));
    } else if (
      await isFirefoxLocalFileAccessDenied(browserApi, activeTab.url)
    ) {
      disableSelection(elements, t("popupLocalFilePermission"));
    }
  } catch (error) {
    console.error("[Screen OCR Translator] Failed to initialize popup", error);
    disableSelection(elements, t("popupCouldNotStart"));
  }
}

function fillLanguageSelect(
  select: HTMLSelectElement,
  languages: readonly string[],
  selected: string,
  includeAuto = false,
): void {
  const entries = languages
    .filter((code) => code !== "auto")
    .map((code) => ({ code, label: languageName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (includeAuto) {
    entries.unshift({ code: "auto", label: t("commonAuto") });
  }
  if (!entries.some(({ code }) => code === selected)) {
    entries.unshift({ code: selected, label: languageName(selected) });
  }

  select.replaceChildren(
    ...entries.map(({ code, label }) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      option.selected = code === selected;
      return option;
    }),
  );
}

function fillProviderSelect(
  select: HTMLSelectElement,
  selected: string,
): void {
  const providers = TRANSLATION_PROVIDERS.map(({ id }) => id);
  if (!providers.includes(selected as (typeof providers)[number])) {
    providers.unshift(selected as (typeof providers)[number]);
  }
  select.replaceChildren(
    ...providers.map((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = translationProviderLabel(id);
      option.selected = id === selected;
      return option;
    }),
  );
}

function queuePopupSave(elements: PopupElements): void {
  const nextSettings = currentSettings;
  const nextDisplayMode: DisplayMode =
    elements.displayMode.value === "panel" ? "panel" : "overlay";
  pendingSave = pendingSave.catch(() => {}).then(async () => {
    await settingsRepository.set(nextSettings);
    await setDisplayMode(nextDisplayMode);
  });
  void pendingSave.then(clearSaveError, (error: unknown) => {
    console.error(
      "[Screen OCR Translator] Failed to save popup settings",
      error,
    );
    showSettingsSaveError();
  });
}

async function startSelection(elements: PopupElements): Promise<void> {
  elements.selectArea.disabled = true;
  elements.openSettings.disabled = true;
  elements.controls.disabled = true;
  showMessage(elements, t("popupStartingSelection"), false);

  try {
    await pendingSave;
  } catch {
    elements.selectArea.disabled = false;
    elements.openSettings.disabled = false;
    elements.controls.disabled = false;
    showSettingsSaveError();
    return;
  }

  try {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (
      typeof tab?.id !== "number" ||
      !isActivationPageSupported(tab.url)
    ) {
      disableSelection(elements, t("popupRestrictedPage"));
      return;
    }
    await browserApi.tabs.sendMessage(
      tab.id,
      { type: "START_SELECTION" },
      { frameId: 0 },
    );
    window.close();
  } catch (error) {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (
      isContentScriptUnavailableError(error) &&
      (await isFirefoxLocalFileAccessDenied(browserApi, tab?.url))
    ) {
      disableSelection(elements, t("popupLocalFilePermission"));
      return;
    }
    if (isContentScriptUnavailableError(error)) {
      disableSelection(elements, t("popupRestrictedPage"));
      return;
    }

    console.error("[Screen OCR Translator] Failed to start selection", error);
    elements.selectArea.disabled = false;
    elements.openSettings.disabled = false;
    elements.controls.disabled = false;
    showMessage(elements, t("popupCouldNotStart"));
  }
}

async function openSettings(elements: PopupElements): Promise<void> {
  const selectAreaWasDisabled = elements.selectArea.disabled;
  elements.openSettings.disabled = true;
  elements.selectArea.disabled = true;
  elements.controls.disabled = true;
  try {
    await pendingSave;
  } catch {
    elements.openSettings.disabled = false;
    elements.selectArea.disabled = selectAreaWasDisabled;
    elements.controls.disabled = false;
    showSettingsSaveError();
    return;
  }

  try {
    await browserApi.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    console.error("[Screen OCR Translator] Failed to open settings", error);
    elements.openSettings.disabled = false;
    elements.selectArea.disabled = selectAreaWasDisabled;
    elements.controls.disabled = false;
    showMessage(elements, t("popupCouldNotOpenSettings"));
  }
}

function showSettingsSaveError(): void {
  showMessage(
    getPopupElements(),
    t("popupCouldNotSaveSettings"),
    true,
    "save",
  );
}

function clearSaveError(): void {
  const { message } = getPopupElements();
  if (message.dataset.kind === "save") {
    message.hidden = true;
    delete message.dataset.kind;
  }
}

function disableSelection(elements: PopupElements, message: string): void {
  elements.selectArea.disabled = true;
  elements.openSettings.disabled = false;
  elements.controls.disabled = false;
  showMessage(elements, message);
}

function showMessage(
  elements: PopupElements,
  message: string,
  isError = true,
  kind?: string,
): void {
  elements.message.textContent = message;
  elements.message.hidden = false;
  elements.message.classList.toggle("is-neutral", !isError);
  if (kind) {
    elements.message.dataset.kind = kind;
  } else {
    delete elements.message.dataset.kind;
  }
}

interface PopupElements {
  controls: HTMLFieldSetElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  translationProvider: HTMLSelectElement;
  displayMode: HTMLSelectElement;
  openSettings: HTMLButtonElement;
  selectArea: HTMLButtonElement;
  message: HTMLParagraphElement;
}

function getPopupElements(): PopupElements {
  return {
    controls: requiredElement("controls", HTMLFieldSetElement),
    sourceLanguage: requiredElement("source-language", HTMLSelectElement),
    targetLanguage: requiredElement("target-language", HTMLSelectElement),
    translationProvider: requiredElement(
      "translation-provider",
      HTMLSelectElement,
    ),
    displayMode: requiredElement("display-mode", HTMLSelectElement),
    openSettings: requiredElement("open-settings", HTMLButtonElement),
    selectArea: requiredElement("select-area", HTMLButtonElement),
    message: requiredElement("message", HTMLParagraphElement),
  };
}

function requiredElement<T extends Element>(
  id: string,
  constructor: { new (): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element;
}
