import { resolve } from "node:path";
import { defineConfig } from "wxt";
import { START_SELECTION_COMMAND } from "./src/shared/commands";

const packagedLegalFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;

// WXT configuration. Targets MV3 on both engines: Firefox gets an event-page
// background, Chrome a service worker.
// Entrypoints live in src/entrypoints; everything else under src/ is a module.
export default defineConfig({
  // Use onnxruntime-web's "external WASM" build (not the default bundle that
  // inlines the 26 MB .wasm as base64); the .wasm + glue are hosted in
  // src/public/ort/. Condition prepended to Vite's defaults.
  vite: () => ({
    resolve: {
      conditions: [
        "onnxruntime-web-use-extern-wasm",
        "module",
        "browser",
        "development|production",
      ],
    },
  }),
  srcDir: "src",
  // Static assets (OCR models, dicts) copied verbatim into the build root.
  publicDir: "src/public",
  // Exclude venv files for faster build
  watchOptions: {
    ignored: ["**/scripts/.venv/**"],
  },
  manifestVersion: 3,
  hooks: {
    "build:publicAssets": (wxt, files) => {
      for (const relativeDest of packagedLegalFiles) {
        files.push({
          absoluteSrc: resolve(wxt.config.root, relativeDest),
          relativeDest,
        });
      }
    },
    // The shadow-root UI (cssInjectionMode: "ui") makes WXT expose the content
    // script's CSS as a web-accessible resource, stamped with Chrome's
    // use_dynamic_url. Firefox doesn't understand that key and warns about it
    // on load. Chrome does, and randomizing the URL per session is worth
    // keeping there, so this only strips it for Firefox.
    "build:manifestGenerated": (wxt, manifest) => {
      if (wxt.config.browser !== "firefox") {
        return;
      }
      for (const entry of manifest.web_accessible_resources ?? []) {
        if (typeof entry === "object") {
          delete entry.use_dynamic_url;
        }
      }
    },
  },
  manifest: ({ browser }) => ({
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    homepage_url: "https://github.com/OPerepadia/ocr-translator-extension",
    permissions: [
      "activeTab",
      "contextMenus",
      "storage",
      // Chrome service workers cannot spawn the dedicated OCR worker, so on
      // Chrome the engine runs in an offscreen document instead.
      ...(browser === "firefox" ? [] : ["offscreen"]),
    ],
    host_permissions: ["<all_urls>"],
    // The content script's match_origin_as_fallback needs 119; the offscreen
    // API and WebGPU in dedicated workers both landed earlier.
    ...(browser !== "firefox" && { minimum_chrome_version: "119" }),
    action: {
      default_title: "__MSG_extensionName__",
    },
    commands: {
      [START_SELECTION_COMMAND]: {
        suggested_key: {
          default: "Ctrl+Shift+F",
        },
        description: "__MSG_commandTranslateScreenRegion__",
      },
    },
    // Local OCR engine (PaddleOCR) compiles packaged WASM at runtime and runs in a
    // packaged worker. No script, worker, or WASM file is fetched remotely.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'",
    },
    // Chrome logs an unrecognized-key warning for this and the Web Store can
    // flag it, so it ships only in the Firefox build.
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "{3a401e65-0f9c-46a5-bf00-8176a581d2c3}",
          strict_min_version: "140.0",
          // Extension uses Google Translate for translations, or OpenAI-compatible
          // LLM endpoint provided by the user
          data_collection_permissions: {
            required: ["websiteContent"],
          },
        },
      },
    }),
  }),
});
