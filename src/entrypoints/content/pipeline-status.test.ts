import { describe, expect, it } from "vitest";
import {
  pipelineStatusMessage,
  pipelineStatusProgress,
} from "./pipeline-status";

describe("pipelineStatusMessage", () => {
  it("describes each pipeline stage", () => {
    expect(pipelineStatusMessage({ stage: "loading" })).toBe("Loading…");
    expect(pipelineStatusMessage({ stage: "initializing" })).toBe(
      "Initializing OCR engine…",
    );
    expect(pipelineStatusMessage({ stage: "recognizing" })).toBe(
      "Analyzing image…",
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

  it("leaves indeterminate stages without progress", () => {
    expect(pipelineStatusProgress({ stage: "translating" })).toBeUndefined();
    expect(
      pipelineStatusProgress({ stage: "recognizing", lineCount: 4 }),
    ).toBeUndefined();
  });
});
