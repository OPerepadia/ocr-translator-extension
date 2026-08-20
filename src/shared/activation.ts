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

const UNSUPPORTED_ACTIVATION_HOSTS = new Set([
  "chromewebstore.google.com",
  "addons.mozilla.org",
]);

export function isActivationPageSupported(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  return (
    !UNSUPPORTED_ACTIVATION_PROTOCOLS.has(parsed.protocol) &&
    !UNSUPPORTED_ACTIVATION_HOSTS.has(parsed.hostname)
  );
}

export function isContentScriptUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /could not establish connection|receiving end does not exist|no receiver|cannot access|cannot be scripted|missing host permission/i.test(
    message,
  );
}
