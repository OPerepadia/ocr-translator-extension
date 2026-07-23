import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
  UNSUPPORTED_ACTIVATION_MESSAGE,
} from "@/shared/activation";
import { browserApi } from "@/shared/browser";
import "./style.css";

void initPopup();

async function initPopup(): Promise<void> {
  try {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
    });

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
    if (isContentScriptUnavailableError(error)) {
      showMessage(UNSUPPORTED_ACTIVATION_MESSAGE);
      return;
    }

    console.error("[Screen OCR Translator] Failed to start selection", error);
    showMessage("Screen OCR Translator could not start on this page.");
  }
}

function showMessage(message: string): void {
  const element = document.querySelector<HTMLElement>("#message");
  if (element) {
    element.textContent = message;
  }
}
