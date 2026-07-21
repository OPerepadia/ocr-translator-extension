import { describe, expect, it } from "vitest";
import { classCount, makeCharAt, parseDict } from "./dict";

describe("parseDict", () => {
  it("splits one character per line and drops a trailing newline", () => {
    expect(parseDict("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("preserves internal blank lines", () => {
    expect(parseDict("a\n\nc")).toEqual(["a", "", "c"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseDict("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("makeCharAt", () => {
  const dict = ["a", "b", "c"]; // length 3 -> classes: blank(0) a(1) b(2) c(3) space(4)
  const charAt = makeCharAt(dict);

  it("maps blank to null", () => {
    expect(charAt(0)).toBeNull();
  });

  it("maps the first and last dict entries", () => {
    expect(charAt(1)).toBe("a");
    expect(charAt(3)).toBe("c");
  });

  it("maps the trailing space class", () => {
    expect(charAt(4)).toBe(" ");
  });

  it("returns null for out-of-range indices", () => {
    expect(charAt(5)).toBeNull();
  });
});

describe("classCount", () => {
  it("is dict length plus blank and space", () => {
    expect(classCount(["a", "b", "c"])).toBe(5);
  });
});
