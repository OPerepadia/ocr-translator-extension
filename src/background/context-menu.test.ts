import { describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../shared/messages";
import {
  START_SELECTION_MENU_ID,
  TRANSLATE_IMAGE_MENU_ID,
  startContextMenu,
  type ContextMenuApi,
} from "./context-menu";

type MenuClickListener = (
  info: { menuItemId: string | number; srcUrl?: string; frameId?: number },
  tab?: { id?: number },
) => void;

describe("OCR context menu", () => {
  it("skips registration when context menus are unavailable on Firefox Android", () => {
    const api = createContextMenuApi({});
    delete api.contextMenus;

    expect(() => startContextMenu(api)).not.toThrow();
  });

  it("creates a menu item when the extension is installed", () => {
    let onInstalled: (() => void) | undefined;
    const create = vi.fn(() => START_SELECTION_MENU_ID);
    const api = createContextMenuApi({
      onInstalled: (listener) => {
        onInstalled = listener;
      },
      create,
    });

    startContextMenu(api);
    onInstalled?.();

    const documentUrlPatterns = ["http://*/*", "https://*/*", "file:///*"];
    expect(create).toHaveBeenCalledWith({
      id: START_SELECTION_MENU_ID,
      title: "Translate a screen region…",
      contexts: ["page"],
      documentUrlPatterns,
    });
    expect(create).toHaveBeenCalledWith({
      id: TRANSLATE_IMAGE_MENU_ID,
      title: "Translate this image",
      contexts: ["image"],
      documentUrlPatterns,
    });
  });

  it("starts region selection in the clicked tab", async () => {
    let onClicked: MenuClickListener | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = createContextMenuApi({
      onClicked: (listener) => {
        onClicked = listener;
      },
      sendMessage,
    });

    startContextMenu(api);
    onClicked?.({ menuItemId: START_SELECTION_MENU_ID }, { id: 7 });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        7,
        { type: "START_SELECTION" },
        { frameId: 0 },
      );
    });
  });

  it("translates an image clicked inside a frame", async () => {
    let onClicked: MenuClickListener | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = createContextMenuApi({
      onClicked: (listener) => {
        onClicked = listener;
      },
      sendMessage,
    });

    startContextMenu(api);
    onClicked?.(
      {
        menuItemId: TRANSLATE_IMAGE_MENU_ID,
        srcUrl: "file:///tmp/sample.png",
        frameId: 4,
      },
      { id: 7 },
    );
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        7,
        {
          type: "START_IMAGE_TRANSLATION",
          imageUrl: "file:///tmp/sample.png",
        },
        { frameId: 4 },
      );
    });
  });

  it("ignores other menu items and clicks without a tab", () => {
    let onClicked: MenuClickListener | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = createContextMenuApi({
      onClicked: (listener) => {
        onClicked = listener;
      },
      sendMessage,
    });

    startContextMenu(api);
    onClicked?.({ menuItemId: "another-menu-item" }, { id: 7 });
    onClicked?.({ menuItemId: TRANSLATE_IMAGE_MENU_ID }, { id: 7 });
    onClicked?.({ menuItemId: START_SELECTION_MENU_ID });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function createContextMenuApi(overrides: {
  onInstalled?: (listener: () => void) => void;
  onClicked?: (listener: MenuClickListener) => void;
  create?: (properties: {
    id: string;
    title: string;
    contexts: Array<"page" | "image">;
    documentUrlPatterns?: string[];
  }) => string | number;
  sendMessage?: (
    tabId: number,
    message: RuntimeMessage,
    options?: { frameId?: number },
  ) => Promise<unknown>;
}): ContextMenuApi {
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
    i18n: {
      getMessage: (key: string) =>
        key === "contextTranslateImage"
          ? "Translate this image"
          : "Translate a screen region…",
    },
  } as ContextMenuApi;
}
