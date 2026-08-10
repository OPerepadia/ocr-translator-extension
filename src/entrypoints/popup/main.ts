import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
} from "@/shared/activation";
import { browserApi } from "@/shared/browser";
import { localizeMarkedElements, t } from "@/shared/i18n";
import { isFirefoxLocalFileAccessDenied } from "@/shared/local-file-access";
import "./style.css";

localizeMarkedElements();
void initPopup();

async function initPopup(): Promise<void> {
  let activeTabUrl: string | undefined;

  try {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeTabUrl = tab?.url;

    if (typeof tab?.id !== "number") {
      showMessage(t("popupRestrictedPage"));
      return;
    }

    if (!isActivationPageSupported(tab.url)) {
      showMessage(t("popupRestrictedPage"));
      return;
    }

    await browserApi.tabs.sendMessage(
      tab.id,
      { type: "START_SELECTION" },
      { frameId: 0 },
    );
    window.close();
  } catch (error) {
    if (
      isContentScriptUnavailableError(error) &&
      (await isFirefoxLocalFileAccessDenied(browserApi, activeTabUrl))
    ) {
      showLocalFileAccessMessage();
      return;
    }

    if (isContentScriptUnavailableError(error)) {
      showMessage(t("popupRestrictedPage"));
      return;
    }

    console.error("[Screen OCR Translator] Failed to start selection", error);
    showMessage(t("popupCouldNotStart"));
  }
}

function showLocalFileAccessMessage(): void {
  showMessage(t("popupLocalFilePermission"));

  const button = document.querySelector<HTMLButtonElement>("#open-settings");
  if (!button) {
    return;
  }

  button.hidden = false;
  button.addEventListener("click", () => {
    button.disabled = true;
    void browserApi.runtime.openOptionsPage().then(
      () => window.close(),
      (error: unknown) => {
        button.disabled = false;
        console.error(
          "[Screen OCR Translator] Failed to open add-on settings",
          error,
        );
        showMessage(t("popupCouldNotOpenSettings"));
      },
    );
  });
}

function showMessage(message: string): void {
  const element = document.querySelector<HTMLElement>("#message");
  if (element) {
    element.textContent = message;
  }
}
