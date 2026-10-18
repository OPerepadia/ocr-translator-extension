import {
  findOcrSourceLanguage,
  OCR_PROVIDERS,
  ocrSourceLanguagesForProvider,
  TRANSLATION_PROVIDERS,
} from "@/providers/catalog";
import {
  resolveTargetLanguage,
  translationTargetLanguages,
} from "@/providers/translation/target-languages";
import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
  isTabActivatable,
} from "@/shared/activation";
import { browser } from "wxt/browser";
import {
  initializeI18n,
  localizeMarkedElements,
  ocrProviderLabel,
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
import {
  LIVE_ICON,
  SETTINGS_ICON,
  translationProviderIcon,
} from "@/entrypoints/content/icons";
import { languageName } from "@/entrypoints/content/language-picker";
import { replaceSelectWithOptionPicker } from "@/entrypoints/content/option-picker";
import {
  getStartLiveSelectionShortcut,
  getStartSelectionShortcut,
} from "@/shared/shortcut";
import "./style.css";

const settingsRepository = createSettingsRepository();
let currentSettings: Settings;
let pendingSave: Promise<void> = Promise.resolve();

void initPopup();

async function initPopup(): Promise<void> {
  await initializeI18n();
  localizeMarkedElements();
  const elements = getPopupElements();
  elements.openSettings.innerHTML = SETTINGS_ICON;
  elements.liveTranslate.insertAdjacentHTML("afterbegin", LIVE_ICON);
  elements.openSettings.addEventListener("click", () => {
    void openSettings(elements);
  });
  void showShortcutHint(elements);

  try {
    const [settings, displayMode, [activeTab]] = await Promise.all([
      settingsRepository.get(),
      getDisplayMode(),
      browser.tabs.query({ active: true, currentWindow: true }),
    ]);
    currentSettings = settings;

    fillLanguageSelect(
      elements.sourceLanguage,
      ocrSourceLanguagesForProvider(settings.ocr.providerId).map(({ id }) => id),
      settings.ocr.sourceLang ?? "auto",
      true,
    );
    fillOcrProviderSelect(elements.ocrProvider, settings.ocr.providerId);
    replaceSelectWithOptionPicker(elements.ocrProvider, {
      title: (current) => t("panelOcrModel", current.label),
    });
    fillLanguageSelect(
      elements.targetLanguage,
      translationTargetLanguages(settings.translation.providerId),
      settings.translation.targetLang,
    );
    fillProviderSelect(
      elements.translationProvider,
      settings.translation.providerId,
    );
    replaceSelectWithOptionPicker(elements.translationProvider, {
      icon: translationProviderIcon,
      title: (current) => t("panelTranslationProvider", current.label),
    });
    for (const input of elements.displayModeInputs) {
      input.checked = input.value === displayMode;
    }

    elements.controls.addEventListener("change", () => {
      const ocrProviderId = elements.ocrProvider.value;
      if (ocrProviderId !== currentSettings.ocr.providerId) {
        // Keep the language when the new model can read it.
        fillLanguageSelect(
          elements.sourceLanguage,
          ocrSourceLanguagesForProvider(ocrProviderId).map(({ id }) => id),
          findOcrSourceLanguage(elements.sourceLanguage.value, ocrProviderId)
            ? elements.sourceLanguage.value
            : "auto",
          true,
        );
      }
      const supportedLanguages = translationTargetLanguages(
        elements.translationProvider.value,
      );
      fillLanguageSelect(
        elements.targetLanguage,
        supportedLanguages,
        resolveTargetLanguage(elements.targetLanguage.value, supportedLanguages),
      );
      currentSettings = {
        ...currentSettings,
        ocr: {
          ...currentSettings.ocr,
          providerId: ocrProviderId,
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
      void startPageAction(elements, "START_SELECTION");
    });
    elements.liveTranslate.addEventListener("click", () => {
      void startPageAction(elements, "START_LIVE_SELECTION");
    });
    elements.selectArea.disabled = false;
    elements.liveTranslate.disabled = false;

    if (
      typeof activeTab?.id !== "number" ||
      !(await isTabActivatable(activeTab, (tabId, message, options) =>
        browser.tabs.sendMessage(tabId, message, options),
      ))
    ) {
      disableSelection(elements, t("popupRestrictedPage"));
    } else if (
      await isFirefoxLocalFileAccessDenied(browser, activeTab.url)
    ) {
      disableSelection(elements, t("popupLocalFilePermission"));
    }
  } catch (error) {
    console.error("[Screen OCR Translator] Failed to initialize popup", error);
    disableSelection(elements, t("popupCouldNotStart"));
  }
}

async function showShortcutHint(elements: PopupElements): Promise<void> {
  const hints = [
    [elements.shortcutKey, getStartSelectionShortcut],
    [elements.liveShortcutKey, getStartLiveSelectionShortcut],
  ] as const;
  await Promise.all(
    hints.map(async ([key, getShortcut]) => {
      try {
        const shortcut = await getShortcut();
        if (shortcut) {
          key.textContent = shortcut;
          key.hidden = false;
        }
      } catch {
        key.hidden = true;
      }
    }),
  );
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

function fillOcrProviderSelect(
  select: HTMLSelectElement,
  selected: string,
): void {
  select.replaceChildren(
    ...OCR_PROVIDERS.map(({ id }) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = ocrProviderLabel(id);
      option.selected = id === selected;
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
  const nextDisplayMode: DisplayMode = elements.displayModeInputs.some(
    (input) => input.checked && input.value === "panel",
  )
    ? "panel"
    : "overlay";
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

async function startPageAction(
  elements: PopupElements,
  type: "START_SELECTION" | "START_LIVE_SELECTION",
): Promise<void> {
  elements.selectArea.disabled = true;
  elements.liveTranslate.disabled = true;
  elements.openSettings.disabled = true;
  elements.controls.disabled = true;
  showMessage(elements, t("popupStartingSelection"), false);

  try {
    await pendingSave;
  } catch {
    elements.selectArea.disabled = false;
    elements.liveTranslate.disabled = false;
    elements.openSettings.disabled = false;
    elements.controls.disabled = false;
    showSettingsSaveError();
    return;
  }

  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    // A hidden URL may still be a usable page, e.g. blob:. Let messaging decide.
    if (
      typeof tab?.id !== "number" ||
      (tab.url && !isActivationPageSupported(tab.url))
    ) {
      disableSelection(elements, t("popupRestrictedPage"));
      return;
    }
    await browser.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
    window.close();
  } catch (error) {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (isContentScriptUnavailableError(error)) {
      let message: string;
      if (await isFirefoxLocalFileAccessDenied(browser, tab?.url)) {
        message = t("popupLocalFilePermission");
      } else if (!tab || !isActivationPageSupported(tab.url)) {
        // A known restricted page (chrome://, devtools://, …) where a content
        // script can never run, or a tab we can no longer identify.
        message = t("popupRestrictedPage");
      } else {
        // A regular web page without our content script, e.g. a tab that was
        // opened before the extension was installed. Reloading injects it.
        message = t("popupReloadPage");
      }
      disableSelection(elements, message);
      return;
    }

    console.error("[Screen OCR Translator] Failed to start popup action", error);
    elements.selectArea.disabled = false;
    elements.liveTranslate.disabled = false;
    elements.openSettings.disabled = false;
    elements.controls.disabled = false;
    showMessage(elements, t("popupCouldNotStart"));
  }
}

async function openSettings(elements: PopupElements): Promise<void> {
  const selectAreaWasDisabled = elements.selectArea.disabled;
  const liveTranslateWasDisabled = elements.liveTranslate.disabled;
  elements.openSettings.disabled = true;
  elements.selectArea.disabled = true;
  elements.liveTranslate.disabled = true;
  elements.controls.disabled = true;
  try {
    await pendingSave;
  } catch {
    elements.openSettings.disabled = false;
    elements.selectArea.disabled = selectAreaWasDisabled;
    elements.liveTranslate.disabled = liveTranslateWasDisabled;
    elements.controls.disabled = false;
    showSettingsSaveError();
    return;
  }

  await browser.runtime.openOptionsPage();
  window.close();
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
  elements.liveTranslate.disabled = true;
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
  ocrProvider: HTMLSelectElement;
  translationProvider: HTMLSelectElement;
  displayModeInputs: HTMLInputElement[];
  openSettings: HTMLButtonElement;
  selectArea: HTMLButtonElement;
  liveTranslate: HTMLButtonElement;
  message: HTMLParagraphElement;
  shortcutKey: HTMLElement;
  liveShortcutKey: HTMLElement;
}

function getPopupElements(): PopupElements {
  return {
    controls: requiredElement("controls", HTMLFieldSetElement),
    sourceLanguage: requiredElement("source-language", HTMLSelectElement),
    targetLanguage: requiredElement("target-language", HTMLSelectElement),
    ocrProvider: requiredElement("ocr-provider", HTMLSelectElement),
    translationProvider: requiredElement(
      "translation-provider",
      HTMLSelectElement,
    ),
    displayModeInputs: Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[name="display-mode"]',
      ),
    ),
    openSettings: requiredElement("open-settings", HTMLButtonElement),
    selectArea: requiredElement("select-area", HTMLButtonElement),
    liveTranslate: requiredElement("live-translate", HTMLButtonElement),
    message: requiredElement("message", HTMLParagraphElement),
    shortcutKey: requiredElement("shortcut-key", HTMLElement),
    liveShortcutKey: requiredElement("live-shortcut-key", HTMLElement),
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
