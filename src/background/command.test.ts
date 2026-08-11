import { describe, expect, it, vi } from "vitest";
import type { BrowserApi } from "../shared/browser";
import { START_SELECTION_COMMAND } from "../shared/commands";
import { startKeyboardCommand } from "./command";

describe("keyboard command", () => {
  it("starts selection immediately in the active tab", async () => {
    let onCommand: ((command: string) => void) | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const api = {
      commands: {
        onCommand: {
          addListener: (listener: (command: string) => void) => {
            onCommand = listener;
          },
        },
      },
      tabs: {
        query: vi.fn(async () => [{ id: 7 }]),
        sendMessage,
      },
    } as unknown as BrowserApi;

    startKeyboardCommand(api);
    onCommand?.(START_SELECTION_COMMAND);

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        7,
        { type: "START_SELECTION" },
        { frameId: 0 },
      );
    });
  });

  it("ignores other commands and tabs without an id", async () => {
    let onCommand: ((command: string) => void) | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const query = vi.fn(async () => [{}]);
    const api = {
      commands: {
        onCommand: {
          addListener: (listener: (command: string) => void) => {
            onCommand = listener;
          },
        },
      },
      tabs: { query, sendMessage },
    } as unknown as BrowserApi;

    startKeyboardCommand(api);
    onCommand?.("another-command");
    expect(query).not.toHaveBeenCalled();

    onCommand?.(START_SELECTION_COMMAND);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
