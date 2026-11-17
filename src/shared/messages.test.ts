import { describe, expect, it } from "vitest";
import { serializeError } from "./messages";

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
