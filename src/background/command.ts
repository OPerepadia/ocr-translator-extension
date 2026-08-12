import { browserApi, type BrowserApi } from "../shared/browser";
import { START_SELECTION_COMMAND } from "../shared/commands";

export function startKeyboardCommand(api: BrowserApi = browserApi): void {
  api.commands.onCommand.addListener((command) => {
    if (command !== START_SELECTION_COMMAND) {
      return;
    }

    void api.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (typeof tab?.id !== "number") {
          return;
        }
        return api.tabs.sendMessage(
          tab.id,
          { type: "START_SELECTION" },
          { frameId: 0 },
        );
      })
      .catch((error) =>
        console.error(
          "[Screen OCR Translator] Failed to start selection from shortcut",
          error,
        ),
      );
  });
}
