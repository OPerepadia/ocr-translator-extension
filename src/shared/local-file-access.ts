import type { BrowserApi } from "./browser";

// https://blog.mozilla.org/addons/2026/07/23/firefox-153-webextensions-api-updates/
const FIREFOX_FILE_ACCESS_PERMISSION_VERSION = 153;

export async function isFirefoxLocalFileAccessDenied(
  api: BrowserApi,
  url: string | undefined,
): Promise<boolean> {
  if (!isLocalFileUrl(url)) {
    return false;
  }

  const getBrowserInfo = api.runtime.getBrowserInfo;
  const checkAccess = api.extension?.isAllowedFileSchemeAccess;
  if (!getBrowserInfo || !checkAccess) {
    return false;
  }

  try {
    const browserInfo = await getBrowserInfo.call(api.runtime);
    const majorVersion = Number.parseInt(browserInfo.version, 10);

    // Before Firefox 153 this API always returned false, even with file access.
    if (
      browserInfo.name !== "Firefox" ||
      !Number.isFinite(majorVersion) ||
      majorVersion < FIREFOX_FILE_ACCESS_PERMISSION_VERSION
    ) {
      return false;
    }

    return !(await checkAccess.call(api.extension));
  } catch {
    return false;
  }
}

function isLocalFileUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}
