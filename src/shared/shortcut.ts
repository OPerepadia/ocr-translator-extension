import { browser } from "wxt/browser";
import {
  START_LIVE_SELECTION_COMMAND,
  START_SELECTION_COMMAND,
} from "./commands";

export function getStartSelectionShortcut(): Promise<string | undefined> {
  return getCommandShortcut(START_SELECTION_COMMAND);
}

export function getStartLiveSelectionShortcut(): Promise<string | undefined> {
  return getCommandShortcut(START_LIVE_SELECTION_COMMAND);
}

async function getCommandShortcut(
  command: string,
): Promise<string | undefined> {
  const commands = await browser.commands.getAll();
  const shortcut = commands.find(({ name }) => name === command)?.shortcut;
  return shortcut
    ? shortcut
        .split("+")
        .map((key) => key.trim())
        .join(" + ")
    : undefined;
}

export async function openShortcutSettings(): Promise<void> {
  const commands = browser.commands as typeof browser.commands & {
    openShortcutSettings?: () => Promise<void>;
  };
  if (commands.openShortcutSettings) {
    await commands.openShortcutSettings();
    return;
  }
  const openedTab = browser.tabs.create?.({
    url: "chrome://extensions/shortcuts",
  });
  if (!openedTab) {
    throw new Error("Shortcut settings are unavailable");
  }
  await openedTab;
}
