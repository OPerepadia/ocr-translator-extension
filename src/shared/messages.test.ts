import { describe, expect, it } from "vitest";
import { isRuntimeMessage, serializeError } from "./messages";

describe("runtime message guards", () => {
  it("matches the requested message type", () => {
    expect(isRuntimeMessage({ type: "START_SELECTION" }, "START_SELECTION")).toBe(
      true,
    );
    expect(
      isRuntimeMessage({ type: "OCR_TRANSLATE_REQUEST" }, "START_SELECTION"),
    ).toBe(false);
    expect(isRuntimeMessage({ type: 123 }, "START_SELECTION")).toBe(false);
    expect(isRuntimeMessage(null, "START_SELECTION")).toBe(false);
  });
});

describe("serializeError", () => {
  it("keeps Error details", () => {
    const error = new Error("Something failed");

    expect(serializeError(error)).toMatchObject({
      message: "Something failed",
      name: "Error",
    });
  });

  it("serializes unknown thrown values", () => {
    expect(serializeError("plain failure")).toEqual({
      message: "plain failure",
    });
  });
});
