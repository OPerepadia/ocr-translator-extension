import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
  UNSUPPORTED_ACTIVATION_MESSAGE,
} from "@/shared/activation";
import { browserApi } from "@/shared/browser";
import { isFirefoxLocalFileAccessDenied } from "@/shared/local-file-access";
import "./style.css";

const LOCAL_FILE_ACCESS_MESSAGE =
  'This extension needs a permission to access local files. In add-on settings, select "Permissions and data" and enable "Access local files on your computer", then reload this file.';

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
      showMessage(UNSUPPORTED_ACTIVATION_MESSAGE);
      return;
    }

    if (!isActivationPageSupported(tab.url)) {
      showMessage(UNSUPPORTED_ACTIVATION_MESSAGE);
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
      showMessage(UNSUPPORTED_ACTIVATION_MESSAGE);
      return;
    }

    console.error("[Screen OCR Translator] Failed to start selection", error);
    showMessage("Screen OCR Translator could not start on this page.");
  }
}

function showLocalFileAccessMessage(): void {
  showMessage(LOCAL_FILE_ACCESS_MESSAGE);

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
        showMessage("Could not open add-on settings. Open about:addons manually.");
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
