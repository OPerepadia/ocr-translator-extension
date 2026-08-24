import { browser } from "wxt/browser";
import { START_SELECTION_COMMAND } from "../shared/commands";

export type CommandApi = {
  commands: {
    onCommand: Pick<typeof browser.commands.onCommand, "addListener">;
  };
  tabs: Pick<typeof browser.tabs, "query" | "sendMessage">;
};

export function startKeyboardCommand(api: CommandApi = browser): void {
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
