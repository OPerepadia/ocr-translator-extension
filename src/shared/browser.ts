import type { RuntimeMessage } from "./messages";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
) => Promise<unknown> | unknown;

interface BrowserTab {
  id?: number;
  url?: string;
}

interface BrowserEvent<TListener> {
  addListener(listener: TListener): void;
}

export interface BrowserApi {
  runtime: {
    sendMessage<TResponse = unknown>(message: RuntimeMessage): Promise<TResponse>;
    onMessage: {
      addListener(listener: RuntimeListener): void;
    };
    onInstalled: BrowserEvent<() => void>;
    // Called periodically while a download runs to reset the event page idle
    // timer (keepalive). Any awaited extension API would do; this one is cheap.
    getPlatformInfo(): Promise<unknown>;
    getURL(path: string): string;
    // Opens the extension's options page.
    openOptionsPage(): Promise<void>;
  };
  storage: {
    local: {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    captureVisibleTab(
      windowId?: number | null,
      options?: { format?: "jpeg" | "png"; quality?: number },
    ): Promise<string>;
    query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<BrowserTab[]>;
    sendMessage<TResponse = unknown>(tabId: number, message: RuntimeMessage): Promise<TResponse>;
  };
  contextMenus: {
    create(properties: {
      id: string;
      title: string;
      contexts: ["all"];
    }): string | number;
    onClicked: BrowserEvent<
      (info: { menuItemId: string | number }, tab?: BrowserTab) => void
    >;
  };
  i18n: {
    // Firefox's built-in (local) language detector (CLD). No permission needed.
    detectLanguage(text: string): Promise<{
      isReliable: boolean;
      languages: Array<{ language: string; percentage: number }>;
    }>;
  };
}

type GlobalWithBrowser = typeof globalThis & {
  browser?: BrowserApi;
  chrome?: BrowserApi;
};

export function getBrowserApi(): BrowserApi {
  const global = globalThis as GlobalWithBrowser;
  const api = global.browser ?? global.chrome;

  if (!api) {
    throw new Error("Browser extension API is not available.");
  }

  return api;
}

export const browserApi = new Proxy({} as BrowserApi, {
  get(_target, property: keyof BrowserApi) {
    return getBrowserApi()[property];
  },
});
