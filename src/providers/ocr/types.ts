import type {
  LangCode,
  PipelineOcrResult,
  PipelineStatus,
} from "../../shared/types";

/** Status an OCR provider can report while recognizing: the steps it owns,
 * a subset of the pipeline-wide PipelineStatus. */
export type OcrStatus = Extract<
  PipelineStatus,
  { stage: "initializing" | "recognizing" }
>;

export interface OcrProvider {
  readonly id: string;

  recognize(
    input: OcrInput,
    signal?: AbortSignal,
    onStatus?: (status: OcrStatus) => void,
  ): Promise<OcrResult>;

  preload?(signal?: AbortSignal): Promise<void>;

  dispose?(): Promise<void>;
}

export interface OcrInput {
  image: Blob | ImageData;
  sourceLang?: LangCode | "auto";
  /** "single" reads all lines as one paragraph and skips layout analysis,
   * which is faster for a strip of text such as subtitles. Defaults to
   * "layout". */
  grouping?: "layout" | "single";
  /** Lines thinner than this are skipped before they are read, which drops
   * interface text around what matters. It is the short side of a detected
   * line's box in image pixels: the `oriented.rect.height` of a result block
   * measures the same thing. */
  minLineThickness?: number;
}

export interface OcrResult extends PipelineOcrResult {}

export interface OcrProviderFactory<TConfig = unknown> {
  (config?: TConfig): OcrProvider;
}

