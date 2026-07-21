// Typed errors translation providers throw so the pipeline can turn them into
// a retryable translationStatus instead of a generic failure that would
// replace the whole result panel.

/** A remote translation request failed (network error or non-OK HTTP status).
 * Carries a user-facing message. The pipeline reports it as a "failed" status so
 * the recognized text stays on screen with a retry, instead of throwing and
 * replacing the whole panel with an error. */
export class RemoteTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTranslationError";
  }
}

export function isRemoteTranslationError(
  error: unknown,
): error is RemoteTranslationError {
  return error instanceof RemoteTranslationError;
}
