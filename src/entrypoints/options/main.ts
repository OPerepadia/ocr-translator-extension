import { TRANSLATION_PROVIDERS } from "@/providers/catalog";
import {
  baseUrlProblem,
  fetchAvailableModels,
  testLlmConnection,
} from "@/providers/translation/openai";
import { COMMON_TARGET_LANGUAGES } from "@/providers/translation/target-languages";
import {
  createLanguagePill,
  type LanguagePill,
} from "@/entrypoints/content/language-picker";
import {
  createSettingsRepository,
  getDisplayMode,
  setDisplayMode,
} from "@/shared/storage";
import {
  localizeMarkedElements,
  t,
  translationProviderLabel,
  uiLanguage,
} from "@/shared/i18n";
import type { Settings } from "@/shared/types";
import { hasWebGpuAdapter } from "@/shared/webgpu";
import "./index.css";

// The extra settings section each translation provider needs on this page.
const TRANSLATION_PROVIDER_SECTIONS: Partial<
  Record<string, "llm">
> = {
  openai: "llm",
};

const settingsRepository = createSettingsRepository();
const app = getOptionsRoot();
let statusTimeout: number | undefined;

localizeMarkedElements();
void initOptions();

async function initOptions(): Promise<void> {
  const settings = await settingsRepository.get();
  const elements = getOptionsElements();

  fillProviderSelect(
    elements.translationProviderSelect,
    TRANSLATION_PROVIDERS,
    settings.translation.providerId,
  );
  fillTargetLanguageSelect(
    elements.targetLangSelect,
    settings.translation.targetLang,
  );

  elements.llmBaseUrlInput.value = settings.translation.llm?.baseUrl ?? "";
  elements.llmApiKeyInput.value = settings.translation.llm?.apiKey ?? "";
  fillLlmModelSelect(
    elements.llmModelSelect,
    null,
    settings.translation.llm?.model ?? "",
  );
  elements.llmDisableThinkingInput.checked =
    settings.translation.llm?.disableThinking ?? true;
  const savedTimeoutMs = settings.translation.llm?.timeoutMs;
  elements.llmTimeoutInput.value = savedTimeoutMs
    ? String(Math.round(savedTimeoutMs / 1000))
    : "";

  elements.ocrWebGpuInput.checked = settings.ocr.backend === "webgpu";
  // The engine probes WebGPU in its worker and falls back on its own; this
  // note only warns early, from the options page, that the browser has no
  // usable adapter (the API can exist while requestAdapter returns null).
  void hasWebGpuAdapter().then((supported) => {
    elements.ocrWebGpuNote.hidden = supported;
    elements.ocrWebGpuStatus.textContent = supported
      ? t("commonAvailable")
      : t("commonNotAvailable");
    elements.ocrWebGpuStatus.classList.toggle("is-unavailable", !supported);
    elements.ocrWebGpuStatus.hidden = false;
    // A disabled checkbox is absent from FormData, so the next save also
    // clears a stale "webgpu" choice on a browser that can't run it.
    elements.ocrWebGpuInput.disabled = !supported;
  });

  // Display mode lives under its own storage key, separate from Settings.
  elements.displayModeSelect.value = await getDisplayMode();
  elements.displayModeSelect.addEventListener("change", () => {
    setDisplayMode(
      elements.displayModeSelect.value === "overlay" ? "overlay" : "panel",
    ).then(
      () => showStatus(t("commonSaved")),
      (error: unknown) => showSaveError(error),
    );
  });

  const syncProviderSections = (): void => {
    const section =
      TRANSLATION_PROVIDER_SECTIONS[elements.translationProviderSelect.value];

    elements.googleProviderNote.hidden =
      elements.translationProviderSelect.value !== "google";
    elements.llmSettings.hidden = section !== "llm";
  };

  // Flag URL paste mistakes while the user is still on this page, instead of
  // at translate time. An empty field just means "not configured yet".
  const syncLlmUrlError = (): void => {
    const baseUrl = elements.llmBaseUrlInput.value.trim();
    const problem = baseUrl ? baseUrlProblem(baseUrl) : undefined;
    elements.llmUrlError.textContent = problem ?? "";
    elements.llmUrlError.hidden = !problem;
  };

  syncProviderSections();
  syncLlmUrlError();
  elements.translationProviderSelect.addEventListener(
    "change",
    syncProviderSections,
  );
  elements.llmBaseUrlInput.addEventListener("change", syncLlmUrlError);
  elements.llmApiKeyToggle.addEventListener("click", () => {
    const isHidden = elements.llmApiKeyInput.type === "password";
    elements.llmApiKeyInput.type = isHidden ? "text" : "password";
    elements.llmApiKeyToggle.setAttribute(
      "aria-label",
      isHidden ? t("optionsHideApiKey") : t("optionsShowApiKey"),
    );
    elements.llmApiKeyToggle.setAttribute("aria-pressed", String(isHidden));
  });
  const saveSettings = async (): Promise<void> => {
    const formData = new FormData(elements.form);
    const nextSettings: Settings = {
      ocr: {
        providerId: settings.ocr.providerId,
        backend: formData.get("ocrWebGpu") !== null ? "webgpu" : undefined,
      },
      translation: {
        providerId: String(formData.get("translationProvider") ?? "google"),
        targetLang: String(formData.get("targetLang") ?? "en"),
        llm: readLlmSettings(formData),
      },
    };

    try {
      await settingsRepository.set(nextSettings);
      showStatus(t("commonSaved"));
    } catch (error) {
      showSaveError(error);
    }
  };

  elements.translationProviderSelect.addEventListener("change", () => {
    void saveSettings();
  });
  elements.targetLangSelect.addEventListener("change", () => {
    void saveSettings();
  });

  // The panel's searchable language picker replaces the native select, which
  // stays hidden as the form value holder. Recreated on each change so the
  // button label and selected item stay in sync; the old outside-click
  // listener is removed first because the component registers its own.
  elements.targetLangSelect.hidden = true;
  const targetLangCodes = Array.from(
    elements.targetLangSelect.options,
    (option) => option.value,
  );
  let languagePill: LanguagePill | undefined;
  const mountLanguagePill = (): void => {
    const previous = languagePill;
    if (previous) {
      document.removeEventListener("click", previous.handleOutsideClick);
    }
    const pill = createLanguagePill({
      target: elements.targetLangSelect.value,
      languages: targetLangCodes,
      onChange: (code) => {
        elements.targetLangSelect.value = code;
        mountLanguagePill();
        void saveSettings();
      },
    });
    if (previous) {
      previous.element.replaceWith(pill.element);
    } else {
      elements.targetLangSelect.after(pill.element);
    }
    languagePill = pill;
  };
  mountLanguagePill();
  for (const input of [
    elements.ocrWebGpuInput,
    elements.llmBaseUrlInput,
    elements.llmApiKeyInput,
    elements.llmModelSelect,
    elements.llmDisableThinkingInput,
    elements.llmTimeoutInput,
  ]) {
    input.addEventListener("change", () => {
      void saveSettings();
    });
  }
  elements.llmFetchModelsButton.addEventListener("click", () => {
    void loadLlmModels(elements);
  });
  elements.llmTestConnectionButton.addEventListener("click", () => {
    void testConnection(elements);
  });
}

// Ask the endpoint for its model list and turn the model dropdown into real
// choices. Reads the URL/key inputs live, so it works before they are saved.
async function loadLlmModels(elements: OptionsElements): Promise<void> {
  const baseUrl = elements.llmBaseUrlInput.value.trim();
  if (!baseUrl) {
    elements.llmModelsStatus.textContent = t("optionsSetEndpointFirst");
    elements.llmModelsStatus.classList.add("is-error");
    return;
  }

  elements.llmFetchModelsButton.disabled = true;
  elements.llmModelsStatus.textContent = t("optionsFetchingModels");
  elements.llmModelsStatus.classList.remove("is-error", "is-success");
  try {
    const models = await fetchAvailableModels({
      baseUrl,
      apiKey: elements.llmApiKeyInput.value.trim() || undefined,
    });
    fillLlmModelSelect(
      elements.llmModelSelect,
      models,
      elements.llmModelSelect.value,
    );
    elements.llmModelsStatus.textContent =
      models.length === 0
        ? t("optionsNoModels")
        : models.length === 1
          ? t("optionsOneModelFound")
          : t("optionsModelsFound", String(models.length));
    if (models.length > 0) {
      elements.llmModelsStatus.classList.add("is-success");
    }
  } catch (error) {
    elements.llmModelsStatus.textContent =
      error instanceof Error ? error.message : String(error);
    elements.llmModelsStatus.classList.add("is-error");
  } finally {
    elements.llmFetchModelsButton.disabled = false;
  }
}

async function testConnection(elements: OptionsElements): Promise<void> {
  const llm = readLlmSettings(new FormData(elements.form));

  elements.llmTestConnectionButton.disabled = true;
  elements.llmModelsStatus.textContent = t("optionsTestingConnection");
  elements.llmModelsStatus.classList.remove("is-error", "is-success");
  try {
    await testLlmConnection({
      baseUrl: llm?.baseUrl ?? "",
      apiKey: llm?.apiKey,
      model: llm?.model,
      disableThinking: llm?.disableThinking,
      timeoutMs: llm?.timeoutMs,
    });
    elements.llmModelsStatus.textContent = t("commonConnected");
    elements.llmModelsStatus.classList.add("is-success");
  } catch (error) {
    elements.llmModelsStatus.textContent =
      error instanceof Error ? error.message : String(error);
    elements.llmModelsStatus.classList.add("is-error");
  } finally {
    elements.llmTestConnectionButton.disabled = false;
  }
}

/** Rebuild the model dropdown without silently changing the saved choice. */
function fillLlmModelSelect(
  select: HTMLSelectElement,
  models: string[] | null,
  selected: string,
): void {
  select.textContent = "";

  if (!selected) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("commonNotSet");
    placeholder.selected = true;
    select.append(placeholder);
  } else if (!models?.includes(selected)) {
    const current = document.createElement("option");
    current.value = selected;
    current.textContent = models
      ? t("optionsModelNotFound", selected)
      : selected;
    current.selected = true;
    select.append(current);
  }

  for (const model of models ?? []) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selected;
    select.append(option);
  }
}

function readLlmSettings(formData: FormData): Settings["translation"]["llm"] {
  const baseUrl = String(formData.get("llmBaseUrl") ?? "").trim();
  const apiKey = String(formData.get("llmApiKey") ?? "").trim();
  const model = String(formData.get("llmModel") ?? "").trim();
  // Unchecked checkboxes are absent from FormData.
  const disableThinking = formData.get("llmDisableThinking") !== null;
  // Empty or invalid means "use the provider default" and stays unset.
  const timeoutSeconds = Number(String(formData.get("llmTimeout") ?? "").trim());
  const timeoutMs =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.round(timeoutSeconds * 1000)
      : undefined;

  // A checked box is the default, so the whole section is "untouched" when
  // everything else is empty too.
  if (!baseUrl && !apiKey && !model && disableThinking && !timeoutMs) {
    return undefined;
  }
  return {
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    model: model || undefined,
    // Thinking is disabled by default; only an explicit re-enable is stored.
    disableThinking: disableThinking ? undefined : false,
    timeoutMs,
  };
}

function fillProviderSelect(
  select: HTMLSelectElement,
  providers: ReadonlyArray<{
    id: string;
    disabled?: boolean;
  }>,
  selectedProviderId: string,
): void {
  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = translationProviderLabel(provider.id);
    option.disabled = provider.disabled === true;
    option.selected = provider.id === selectedProviderId;
    select.append(option);
  }
}

function fillTargetLanguageSelect(
  select: HTMLSelectElement,
  selectedLang: string,
): void {
  let hasSelectedLanguage = false;

  for (const language of getTargetLanguages()) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = `${language.name} (${language.code})`;
    option.selected = language.code === selectedLang;
    hasSelectedLanguage ||= option.selected;
    select.append(option);
  }

  if (!hasSelectedLanguage) {
    const option = document.createElement("option");
    option.value = selectedLang;
    option.textContent = t("commonCurrentValue", selectedLang);
    option.selected = true;
    select.prepend(option);
  }
}

function getTargetLanguages(): Array<{ code: string; name: string }> {
  const languages = new Map<string, string>();
  const displayNames = new Intl.DisplayNames([uiLanguage()], {
    type: "language",
  });
  for (const code of COMMON_TARGET_LANGUAGES) {
    languages.set(code, languages.get(code) ?? displayNames.of(code) ?? code);
  }

  return [...languages]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function showSaveError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  showStatus(t("optionsSaveFailed", detail), { isError: true });
}

function showStatus(
  message: string,
  { isError = false }: { isError?: boolean } = {},
): void {
  const status = app.querySelector<HTMLElement>("[role='status']");

  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle("is-error", isError);
  if (statusTimeout !== undefined) {
    clearTimeout(statusTimeout);
    statusTimeout = undefined;
  }
  // Errors stay visible until the next save attempt replaces them.
  if (!isError) {
    statusTimeout = window.setTimeout(() => {
      status.textContent = "";
      statusTimeout = undefined;
    }, 2000);
  }
}

function getOptionsRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#app");

  if (!root) {
    throw new Error("Options root element was not found.");
  }

  return root;
}

type OptionsElements = ReturnType<typeof getOptionsElements>;

function getOptionsElements(): {
  form: HTMLFormElement;
  translationProviderSelect: HTMLSelectElement;
  googleProviderNote: HTMLElement;
  targetLangSelect: HTMLSelectElement;
  displayModeSelect: HTMLSelectElement;
  ocrWebGpuInput: HTMLInputElement;
  ocrWebGpuNote: HTMLElement;
  ocrWebGpuStatus: HTMLElement;
  llmSettings: HTMLFieldSetElement;
  llmBaseUrlInput: HTMLInputElement;
  llmUrlError: HTMLElement;
  llmApiKeyInput: HTMLInputElement;
  llmApiKeyToggle: HTMLButtonElement;
  llmModelSelect: HTMLSelectElement;
  llmFetchModelsButton: HTMLButtonElement;
  llmTestConnectionButton: HTMLButtonElement;
  llmModelsStatus: HTMLElement;
  llmDisableThinkingInput: HTMLInputElement;
  llmTimeoutInput: HTMLInputElement;
} {
  const form = app.querySelector<HTMLFormElement>("form");
  const translationProviderSelect = app.querySelector<HTMLSelectElement>(
    "select[name='translationProvider']",
  );
  const googleProviderNote = app.querySelector<HTMLElement>(
    ".google-provider-note",
  );
  const targetLangSelect = app.querySelector<HTMLSelectElement>(
    "select[name='targetLang']",
  );
  const displayModeSelect = app.querySelector<HTMLSelectElement>(
    "select[name='displayMode']",
  );
  const ocrWebGpuInput = app.querySelector<HTMLInputElement>(
    "input[name='ocrWebGpu']",
  );
  const ocrWebGpuNote = app.querySelector<HTMLElement>(".ocr-webgpu-note");
  const ocrWebGpuStatus = app.querySelector<HTMLElement>(".ocr-webgpu-status");
  const llmSettings = app.querySelector<HTMLFieldSetElement>(".llm-settings");
  const llmBaseUrlInput = app.querySelector<HTMLInputElement>(
    "input[name='llmBaseUrl']",
  );
  const llmUrlError = app.querySelector<HTMLElement>(".llm-url-error");
  const llmApiKeyInput = app.querySelector<HTMLInputElement>(
    "input[name='llmApiKey']",
  );
  const llmApiKeyToggle = app.querySelector<HTMLButtonElement>(
    ".llm-api-key-toggle",
  );
  const llmModelSelect = app.querySelector<HTMLSelectElement>(
    "select[name='llmModel']",
  );
  const llmFetchModelsButton = app.querySelector<HTMLButtonElement>(
    ".llm-fetch-models",
  );
  const llmTestConnectionButton = app.querySelector<HTMLButtonElement>(
    ".llm-test-connection",
  );
  const llmModelsStatus = app.querySelector<HTMLElement>(".llm-models-status");
  const llmDisableThinkingInput = app.querySelector<HTMLInputElement>(
    "input[name='llmDisableThinking']",
  );
  const llmTimeoutInput = app.querySelector<HTMLInputElement>(
    "input[name='llmTimeout']",
  );

  if (
    !form ||
    !translationProviderSelect ||
    !googleProviderNote ||
    !targetLangSelect ||
    !displayModeSelect ||
    !ocrWebGpuInput ||
    !ocrWebGpuNote ||
    !ocrWebGpuStatus ||
    !llmSettings ||
    !llmBaseUrlInput ||
    !llmUrlError ||
    !llmApiKeyInput ||
    !llmApiKeyToggle ||
    !llmModelSelect ||
    !llmFetchModelsButton ||
    !llmTestConnectionButton ||
    !llmModelsStatus ||
    !llmDisableThinkingInput ||
    !llmTimeoutInput
  ) {
    throw new Error("Options form was not found.");
  }

  return {
    form,
    translationProviderSelect,
    googleProviderNote,
    targetLangSelect,
    displayModeSelect,
    ocrWebGpuInput,
    ocrWebGpuNote,
    ocrWebGpuStatus,
    llmSettings,
    llmBaseUrlInput,
    llmUrlError,
    llmApiKeyInput,
    llmApiKeyToggle,
    llmModelSelect,
    llmFetchModelsButton,
    llmTestConnectionButton,
    llmModelsStatus,
    llmDisableThinkingInput,
    llmTimeoutInput,
  };
}
