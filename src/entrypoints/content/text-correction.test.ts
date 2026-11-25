import { describe, expect, it } from "vitest";
import { replaceTextLine, spreadText } from "./text-correction";

function spread(lines: string[], text: string): string[] {
  return spreadText(
    lines.map((line) => Array.from(line)),
    text,
  ).map((line) => line.join(""));
}

describe("replaceTextLine", () => {
  it("replaces only the given line", () => {
    expect(replaceTextLine("one\ntwo\nthree", 1, "2")).toBe("one\n2\nthree");
  });

  it("replaces a single line", () => {
    expect(replaceTextLine("one", 0, "1")).toBe("1");
  });
});

describe("spreadText", () => {
  it.each([
    ["lines joined with a space", ["sample", "text"], "sample text"],
    ["lines joined with nothing", ["見本", "文字"], "見本文字"],
    ["a word split with a hyphen", ["an exam-", "ple"], "an example"],
  ])("leaves %s unchanged", (_name, lines, text) => {
    const pieces = lines.map((line) => Array.from(line));
    expect(spreadText(pieces, text)).toBe(pieces);
  });

  it("puts a replaced character on its piece", () => {
    expect(
      spreadText(
        [
          ["s", "a", "m"],
          ["t", "e"],
        ],
        "sum te",
      ),
    ).toEqual([
      ["s", "u", "m"],
      ["t", "e"],
    ]);
  });

  it("keeps the pieces of a removed character, emptied", () => {
    expect(spreadText([["a", "x", "b"]], "ab")).toEqual([["a", "", "b"]]);
  });

  it("adds missing characters to the piece before them", () => {
    expect(spreadText([["a", "c"]], "abc")).toEqual([["ab", "c"]]);
  });

  it("adds text missing at the start to the first piece", () => {
    expect(spreadText([["b", "c"]], "abc")).toEqual([["ab", "c"]]);
  });

  it("keeps every line's own words", () => {
    expect(spread(["smple text", "on two lines"], "sample text on two lines")).toEqual([
      "sample text",
      "on two lines",
    ]);
    expect(spread(["sample", "taxt here"], "sample text here")).toEqual([
      "sample",
      "text here",
    ]);
  });

  it("adds a missing space", () => {
    expect(spread(["sampletext", "here"], "sample text here")).toEqual([
      "sample text",
      "here",
    ]);
  });

  it("puts text added at a line's end or start on that line", () => {
    expect(spread(["sample", "text"], "samples text")).toEqual(["samples", "text"]);
    expect(spread(["sample", "ext"], "sample text")).toEqual(["sample", "text"]);
  });

  it("corrects lines joined with nothing", () => {
    expect(spread(["見木", "文字"], "見本文字")).toEqual(["見本", "文字"]);
  });

  it("keeps the hyphen of a split word when another word is corrected", () => {
    expect(spread(["am exam-", "ple"], "an example")).toEqual(["an exam-", "ple"]);
  });

  it("puts the whole text on the lines when nothing matches", () => {
    expect(spread(["ab", "cd"], "wx yz").join(" ")).toBe("wx yz");
  });

  it("handles a line without pieces", () => {
    expect(spreadText([[]], "a")).toEqual([[]]);
  });
});
