import { describe, expect, it, vi } from "vitest";
import type { BrowserApi } from "../shared/browser";
import {
  START_SELECTION_MENU_ID,
  startContextMenu,
} from "./context-menu";

describe("OCR context menu", () => {
  it("creates a menu item when the extension is installed", () => {
    let onInstalled: (() => void) | undefined;
    const create = vi.fn(() => START_SELECTION_MENU_ID);
    const api = createBrowserApi({
      onInstalled: (listener) => {
        onInstalled = listener;
      },
      create,
    });

    startContextMenu(api);
    onInstalled?.();

    expect(create).toHaveBeenCalledWith({
      id: START_SELECTION_MENU_ID,
      title: "Select region for OCR",
      contexts: ["all"],
    });
  });

  it("starts region selection in the clicked tab", async () => {
    let onClicked:
      | ((info: { menuItemId: string | number }, tab?: { id?: number }) => void)
      | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = createBrowserApi({
      onClicked: (listener) => {
        onClicked = listener;
      },
      sendMessage,
    });

    startContextMenu(api);
    onClicked?.({ menuItemId: START_SELECTION_MENU_ID }, { id: 7 });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(7, {
        type: "START_SELECTION",
      });
    });
  });

  it("ignores other menu items and clicks without a tab", () => {
    let onClicked:
      | ((info: { menuItemId: string | number }, tab?: { id?: number }) => void)
      | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = createBrowserApi({
      onClicked: (listener) => {
        onClicked = listener;
      },
      sendMessage,
    });

    startContextMenu(api);
    onClicked?.({ menuItemId: "another-menu-item" }, { id: 7 });
    onClicked?.({ menuItemId: START_SELECTION_MENU_ID });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function createBrowserApi(overrides: {
  onInstalled?: (listener: () => void) => void;
  onClicked?: (
    listener: (
      info: { menuItemId: string | number },
      tab?: { id?: number },
    ) => void,
  ) => void;
  create?: (properties: {
    id: string;
    title: string;
    contexts: ["all"];
  }) => string | number;
  sendMessage?: (tabId: number, message: { type: "START_SELECTION" }) => Promise<unknown>;
}): BrowserApi {
  return {
    runtime: {
      onInstalled: { addListener: overrides.onInstalled ?? vi.fn() },
    },
    contextMenus: {
      create: overrides.create ?? vi.fn(() => START_SELECTION_MENU_ID),
      onClicked: { addListener: overrides.onClicked ?? vi.fn() },
    },
    tabs: {
      sendMessage: overrides.sendMessage ?? vi.fn(async () => undefined),
    },
  } as unknown as BrowserApi;
}
