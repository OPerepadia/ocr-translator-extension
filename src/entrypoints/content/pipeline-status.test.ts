import { describe, expect, it } from "vitest";
import {
  pipelineStatusMessage,
  pipelineStatusProgress,
  pipelineStatusShowsSpinner,
} from "./pipeline-status";

describe("pipelineStatusMessage", () => {
  it("describes each pipeline stage", () => {
    expect(pipelineStatusMessage({ stage: "loading" })).toBe("Loading…");
    expect(pipelineStatusMessage({ stage: "initializing" })).toBe(
      "Initializing…",
    );
    expect(pipelineStatusMessage({ stage: "recognizing" })).toBe(
      "Recognizing text…",
    );
    expect(
      pipelineStatusMessage({ stage: "recognizing", lineCount: 3 }),
    ).toBe("Recognizing text…");
    expect(pipelineStatusMessage({ stage: "translating" })).toBe(
      "Translating…",
    );
  });
});

describe("pipelineStatusProgress", () => {
  it("reports determinate recognition progress", () => {
    expect(
      pipelineStatusProgress({ stage: "recognizing", line: 2, lineCount: 4 }),
    ).toBe(0.5);
  });

  it("clamps progress to the valid range", () => {
    expect(
      pipelineStatusProgress({ stage: "recognizing", line: -1, lineCount: 4 }),
    ).toBe(0);
    expect(
      pipelineStatusProgress({ stage: "recognizing", line: 5, lineCount: 4 }),
    ).toBe(1);
  });

  it("leaves other stages without progress", () => {
    expect(pipelineStatusProgress({ stage: "translating" })).toBeUndefined();
    expect(pipelineStatusProgress({ stage: "initializing" })).toBeUndefined();
  });

  it("starts recognition at zero before the first line", () => {
    expect(pipelineStatusProgress({ stage: "recognizing" })).toBe(0);
    expect(
      pipelineStatusProgress({ stage: "recognizing", lineCount: 4 }),
    ).toBe(0);
  });
});

describe("pipelineStatusShowsSpinner", () => {
  it("hides the spinner only while recognizing", () => {
    expect(pipelineStatusShowsSpinner({ stage: "loading" })).toBe(true);
    expect(pipelineStatusShowsSpinner({ stage: "initializing" })).toBe(true);
    expect(
      pipelineStatusShowsSpinner({ stage: "recognizing", line: 1, lineCount: 4 }),
    ).toBe(false);
    expect(pipelineStatusShowsSpinner({ stage: "translating" })).toBe(true);
  });
});
