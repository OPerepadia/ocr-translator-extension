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
import {
  PICK_IMAGE_ICON,
  SETTINGS_ICON,
} from "@/entrypoints/content/icons";
import { languageName } from "@/entrypoints/content/language-picker";
import { createRequestId } from "@/shared/request-id";
import { START_SELECTION_COMMAND } from "@/shared/commands";
import "./style.css";

const settingsRepository = createSettingsRepository();
let currentSettings: Settings;
let pendingSave: Promise<void> = Promise.resolve();

localizeMarkedElements();
void initPopup();

async function initPopup(): Promise<void> {
  const elements = getPopupElements();
  elements.openSettings.innerHTML = SETTINGS_ICON;
  elements.pickImage.insertAdjacentHTML("afterbegin", PICK_IMAGE_ICON);
  elements.openSettings.addEventListener("click", () => {
    void openSettings(elements);
  });
  elements.shortcutKey.addEventListener("click", () => {
    void openShortcutSettings(elements);
  });
  void showShortcutHint(elements);

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
      void startPageAction(elements, "START_SELECTION");
    });
    elements.pickImage.addEventListener("click", () => {
      void startPageAction(elements, "START_IMAGE_PICKER");
    });
    elements.selectArea.disabled = false;
    elements.pickImage.disabled = false;

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

async function showShortcutHint(elements: PopupElements): Promise<void> {
  try {
    const commands = await browserApi.commands.getAll();
    const shortcut = commands.find(
      ({ name }) => name === START_SELECTION_COMMAND,
    )?.shortcut;
    if (shortcut) {
      elements.shortcutKeyLabel.textContent = shortcut
        .split("+")
        .map((key) => key.trim())
        .join(" + ");
    } else {
      elements.shortcutPrefix.textContent = t("popupShortcutNotSet");
      elements.shortcutKeyLabel.textContent = t("popupSetShortcut");
      elements.shortcutSuffix.textContent = "";
      const label = t("popupEditShortcut");
      elements.shortcutKey.setAttribute("aria-label", label);
      elements.shortcutKey.title = label;
    }
    elements.shortcutHint.hidden = false;
  } catch {
    elements.shortcutHint.hidden = true;
  }
}

async function openShortcutSettings(elements: PopupElements): Promise<void> {
  try {
    if (browserApi.commands.openShortcutSettings) {
      await browserApi.commands.openShortcutSettings();
    } else {
      const openedTab = browserApi.tabs.create?.({
        url: "chrome://extensions/shortcuts",
      });
      if (!openedTab) {
        throw new Error("Shortcut settings are unavailable");
      }
      await openedTab;
    }
    window.close();
  } catch (error) {
    console.error(
      "[Screen OCR Translator] Failed to open shortcut settings",
      error,
    );
    showMessage(elements, t("popupCouldNotOpenShortcutSettings"));
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

async function startPageAction(
  elements: PopupElements,
  type: "START_SELECTION" | "START_IMAGE_PICKER",
): Promise<void> {
  elements.selectArea.disabled = true;
  elements.pickImage.disabled = true;
  elements.openSettings.disabled = true;
  elements.controls.disabled = true;
  showMessage(
    elements,
    t(
      type === "START_SELECTION"
        ? "popupStartingSelection"
        : "popupStartingImagePicker",
    ),
    false,
  );

  try {
    await pendingSave;
  } catch {
    elements.selectArea.disabled = false;
    elements.pickImage.disabled = false;
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
    if (type === "START_IMAGE_PICKER") {
      await browserApi.tabs.sendMessage(tab.id, {
        type,
        sessionId: createRequestId(),
      });
    } else {
      await browserApi.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
    }
    window.close();
  } catch (error) {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (isContentScriptUnavailableError(error)) {
      let message: string;
      if (await isFirefoxLocalFileAccessDenied(browserApi, tab?.url)) {
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
    elements.pickImage.disabled = false;
    elements.openSettings.disabled = false;
    elements.controls.disabled = false;
    showMessage(elements, t("popupCouldNotStart"));
  }
}

async function openSettings(elements: PopupElements): Promise<void> {
  const selectAreaWasDisabled = elements.selectArea.disabled;
  const pickImageWasDisabled = elements.pickImage.disabled;
  elements.openSettings.disabled = true;
  elements.selectArea.disabled = true;
  elements.pickImage.disabled = true;
  elements.controls.disabled = true;
  try {
    await pendingSave;
  } catch {
    elements.openSettings.disabled = false;
    elements.selectArea.disabled = selectAreaWasDisabled;
    elements.pickImage.disabled = pickImageWasDisabled;
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
    elements.pickImage.disabled = pickImageWasDisabled;
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
  elements.pickImage.disabled = true;
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
  pickImage: HTMLButtonElement;
  message: HTMLParagraphElement;
  shortcutHint: HTMLParagraphElement;
  shortcutPrefix: HTMLElement;
  shortcutKey: HTMLButtonElement;
  shortcutKeyLabel: HTMLElement;
  shortcutSuffix: HTMLElement;
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
    pickImage: requiredElement("pick-image", HTMLButtonElement),
    message: requiredElement("message", HTMLParagraphElement),
    shortcutHint: requiredElement("shortcut-hint", HTMLParagraphElement),
    shortcutPrefix: requiredElement("shortcut-prefix", HTMLElement),
    shortcutKey: requiredElement("shortcut-key", HTMLButtonElement),
    shortcutKeyLabel: requiredElement("shortcut-key-label", HTMLElement),
    shortcutSuffix: requiredElement("shortcut-suffix", HTMLElement),
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
