import { describe, expect, it, vi } from "vitest";
import type { BrowserApi } from "./browser";
import { isFirefoxLocalFileAccessDenied } from "./local-file-access";

describe("Firefox local file access", () => {
  it("reports denied access on local files in Firefox 153 and later", async () => {
    const getBrowserInfo = vi.fn(async () => ({
      name: "Firefox",
      version: "153.0.1",
    }));
    const isAllowedFileSchemeAccess = vi.fn(async () => false);
    const api = createBrowserApi({
      getBrowserInfo,
      isAllowedFileSchemeAccess,
    });

    await expect(
      isFirefoxLocalFileAccessDenied(api, "file:///tmp/sample.html"),
    ).resolves.toBe(true);
    expect(getBrowserInfo).toHaveBeenCalledOnce();
    expect(isAllowedFileSchemeAccess).toHaveBeenCalledOnce();
  });

  it("does not report denied access when the user allowed local files", async () => {
    const api = createBrowserApi({
      getBrowserInfo: async () => ({ name: "Firefox", version: "153" }),
      isAllowedFileSchemeAccess: async () => true,
    });

    await expect(
      isFirefoxLocalFileAccessDenied(api, "file:///tmp/sample.html"),
    ).resolves.toBe(false);
  });

  it("ignores the unreliable result from Firefox versions before 153", async () => {
    const isAllowedFileSchemeAccess = vi.fn(async () => false);
    const api = createBrowserApi({
      getBrowserInfo: async () => ({ name: "Firefox", version: "152.0" }),
      isAllowedFileSchemeAccess,
    });

    await expect(
      isFirefoxLocalFileAccessDenied(api, "file:///tmp/sample.html"),
    ).resolves.toBe(false);
    expect(isAllowedFileSchemeAccess).not.toHaveBeenCalled();
  });

  it("does not check file access for web pages or other browsers", async () => {
    const getBrowserInfo = vi.fn(async () => ({
      name: "Firefox",
      version: "153",
    }));
    const isAllowedFileSchemeAccess = vi.fn(async () => false);
    const api = createBrowserApi({
      getBrowserInfo,
      isAllowedFileSchemeAccess,
    });

    await expect(
      isFirefoxLocalFileAccessDenied(api, "https://example.com/"),
    ).resolves.toBe(false);
    expect(getBrowserInfo).not.toHaveBeenCalled();

    const otherBrowserApi = createBrowserApi({
      getBrowserInfo: async () => ({ name: "Chrome", version: "153" }),
      isAllowedFileSchemeAccess,
    });
    await expect(
      isFirefoxLocalFileAccessDenied(
        otherBrowserApi,
        "file:///tmp/sample.html",
      ),
    ).resolves.toBe(false);
  });

  it("falls back when the browser APIs are unavailable or fail", async () => {
    await expect(
      isFirefoxLocalFileAccessDenied(
        { runtime: {} } as BrowserApi,
        "file:///tmp/sample.html",
      ),
    ).resolves.toBe(false);

    const api = createBrowserApi({
      getBrowserInfo: async () => {
        throw new Error("Unavailable");
      },
      isAllowedFileSchemeAccess: async () => false,
    });
    await expect(
      isFirefoxLocalFileAccessDenied(api, "file:///tmp/sample.html"),
    ).resolves.toBe(false);
  });
});

function createBrowserApi(overrides: {
  getBrowserInfo: () => Promise<{ name: string; version: string }>;
  isAllowedFileSchemeAccess: () => Promise<boolean>;
}): BrowserApi {
  return {
    runtime: {
      getBrowserInfo: overrides.getBrowserInfo,
    },
    extension: {
      isAllowedFileSchemeAccess: overrides.isAllowedFileSchemeAccess,
    },
  } as BrowserApi;
}
