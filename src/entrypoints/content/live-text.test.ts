import { describe, expect, it } from "vitest";
import { comparisonKey, isReadable, isSameLine } from "./live-text";

describe("comparisonKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(comparisonKey("  Hello,   World! ")).toBe("helloworld");
  });

  it("folds full-width forms", () => {
    expect(comparisonKey("ＡＢＣ１２３")).toBe("abc123");
  });

  it("keeps letters from every script", () => {
    expect(comparisonKey("Привіт, світе!")).toBe("привітсвіте");
    expect(comparisonKey("こんにちは。")).toBe("こんにちは");
  });
});

describe("isReadable", () => {
  it("accepts ordinary text", () => {
    expect(isReadable("Good morning.")).toBe(true);
    expect(isReadable("はい")).toBe(true);
  });

  it("rejects empty reads and stray glyphs", () => {
    expect(isReadable("")).toBe(false);
    expect(isReadable("  ")).toBe(false);
    expect(isReadable("l")).toBe(false);
    expect(isReadable("- |")).toBe(false);
    expect(isReadable("...!?")).toBe(false);
  });
});

describe("isSameLine", () => {
  it("treats identical text as the same line", () => {
    expect(isSameLine("Where are you going?", "Where are you going?")).toBe(true);
  });

  it("ignores differences in case, spacing and punctuation", () => {
    expect(isSameLine("Where are you going?", "where are  you going.")).toBe(true);
  });

  it("absorbs a misread character in a longer line", () => {
    expect(
      isSameLine(
        "I will meet you at the station tomorrow",
        "I will meet you at the stat1on tomorrow",
      ),
    ).toBe(true);
  });

  it("tells different lines apart", () => {
    expect(isSameLine("Where are you going?", "I am going home.")).toBe(false);
  });

  it("does not merge short lines that differ", () => {
    expect(isSameLine("Yes.", "No.")).toBe(false);
    expect(isSameLine("I see.", "I saw.")).toBe(false);
  });

  it("treats a line that gains a few words as a new one", () => {
    expect(
      isSameLine("Where are you going?", "Where are you going with that?"),
    ).toBe(false);
  });

  it("treats two reads with nothing but punctuation as equal", () => {
    expect(isSameLine("...", "!!!")).toBe(true);
  });

  it("compares scripts without spaces", () => {
    expect(isSameLine("今日は天気がいいですね", "今日は天気がいいですね。")).toBe(true);
    expect(isSameLine("今日は天気がいいですね", "明日は雨になるでしょう")).toBe(false);
  });
});
