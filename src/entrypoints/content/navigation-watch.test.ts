import { describe, expect, it } from "vitest";
import { hasNavigatedAway } from "./navigation-watch";

function navigated(previous: string, current: string): boolean {
  return hasNavigatedAway(new URL(previous), new URL(current));
}

describe("hasNavigatedAway", () => {
  it("detects a path change", () => {
    expect(navigated("https://example.com/a", "https://example.com/b")).toBe(
      true,
    );
  });

  it("detects a query change", () => {
    expect(
      navigated(
        "https://example.com/list?page=1",
        "https://example.com/list?page=2",
      ),
    ).toBe(true);
  });

  it("detects an origin change", () => {
    expect(navigated("https://example.com/a", "https://example.org/a")).toBe(
      true,
    );
  });

  it("ignores an in-page anchor jump", () => {
    expect(
      navigated("https://example.com/docs", "https://example.com/docs#part-2"),
    ).toBe(false);
  });
});
