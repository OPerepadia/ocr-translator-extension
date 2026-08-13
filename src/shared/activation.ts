const UNSUPPORTED_ACTIVATION_PROTOCOLS = new Set([
  "about:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "moz-extension:",
  "opera:",
  "resource:",
  "view-source:",
]);

export function isActivationPageSupported(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return !UNSUPPORTED_ACTIVATION_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

export function isContentScriptUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /could not establish connection|receiving end does not exist|no receiver|cannot access|cannot be scripted|missing host permission/i.test(
    message,
  );
}
