import { describe, expect, it } from "vitest";
import {
  isActivationPageSupported,
  isContentScriptUnavailableError,
} from "./activation";

describe("activation page support", () => {
  it("allows regular web pages", () => {
    expect(isActivationPageSupported("https://example.com/")).toBe(true);
    expect(isActivationPageSupported("http://localhost:3000/")).toBe(true);
  });

  it("blocks browser and extension pages", () => {
    expect(isActivationPageSupported("about:addons")).toBe(false);
    expect(isActivationPageSupported("about:preferences")).toBe(false);
    expect(isActivationPageSupported("moz-extension://example/options.html")).toBe(
      false,
    );
    expect(isActivationPageSupported("chrome://extensions")).toBe(false);
  });

  it("lets missing or malformed URLs fall through to messaging", () => {
    expect(isActivationPageSupported(undefined)).toBe(true);
    expect(isActivationPageSupported("not a url")).toBe(true);
  });
});

describe("content script availability errors", () => {
  it("recognizes missing receiver failures from tabs.sendMessage", () => {
    expect(
      isContentScriptUnavailableError(
        new Error("Could not establish connection. Receiving end does not exist."),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors as page support failures", () => {
    expect(isContentScriptUnavailableError(new Error("Unexpected failure"))).toBe(
      false,
    );
  });
});
