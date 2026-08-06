import { describe, expect, it, vi } from "vitest";
import { createRequestId } from "./request-id";

describe("createRequestId", () => {
  it("uses randomUUID when available", () => {
    expect(
      createRequestId({
        randomUUID: () => "request-id",
      }),
    ).toBe("request-id");
  });

  it("falls back to getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((array: Uint8Array<ArrayBuffer>) => {
      array.set([
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
        0xcc, 0xdd, 0xee, 0xff,
      ]);
      return array;
    });

    expect(createRequestId({ getRandomValues })).toBe(
      "00112233-4455-4677-8899-aabbccddeeff",
    );
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("has a last-resort fallback", () => {
    expect(createRequestId({})).toMatch(/^req-[a-z0-9]+-[a-z0-9]+$/);
  });
});
