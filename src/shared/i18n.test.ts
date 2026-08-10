import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type MessageCatalog = Record<string, { message: string }>;

const localesRoot = resolve(import.meta.dirname, "../public/_locales");

function loadCatalog(locale: string): MessageCatalog {
  return JSON.parse(
    readFileSync(join(localesRoot, locale, "messages.json"), "utf8"),
  ) as MessageCatalog;
}

const english = loadCatalog("en");
const translations = readdirSync(localesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "en")
  .map((entry) => ({ locale: entry.name, messages: loadCatalog(entry.name) }));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return [".html", ".ts"].includes(extname(path)) &&
      !path.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

function referencedKeys(): Set<string> {
  const root = resolve(import.meta.dirname, "..");
  const files = [...sourceFiles(root), resolve(root, "../wxt.config.ts")];
  const keys = new Set<string>();
  const patterns = [
    /\b(?:t|messageKey):?\s*\(?(?:\s*)?["']([^"']+)["']/g,
    /\.getMessage\(\s*["']([^"']+)["']/g,
    /data-i18n(?:-[\w-]+)?=["']([^"']+)["']/g,
    /__MSG_([A-Za-z0-9_]+)__/g,
  ];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1] && !match[1].startsWith("@@")) {
          keys.add(match[1]);
        }
      }
    }
  }
  return keys;
}

describe("localization catalogs", () => {
  it("defines every referenced message in English", () => {
    const missing = [...referencedKeys()].filter((key) => !english[key]);
    expect(missing).toEqual([]);
  });

  it("contains no empty English messages", () => {
    const empty = Object.entries(english)
      .filter(([, value]) => !value.message)
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  describe.each(translations)("$locale catalog", ({ messages }) => {
    it("keeps keys within the English source catalog", () => {
      const unknown = Object.keys(messages).filter((key) => !english[key]);
      expect(unknown).toEqual([]);
    });

    it("contains no empty messages", () => {
      const empty = Object.entries(messages)
        .filter(([, value]) => !value.message)
        .map(([key]) => key);
      expect(empty).toEqual([]);
    });

    it("preserves substitutions", () => {
      const substitutions = (message: string) =>
        [...message.matchAll(/\$\d+/g)].map(([value]) => value).sort();

      const mismatches = Object.keys(messages).filter(
        (key) =>
          substitutions(english[key].message).join() !==
          substitutions(messages[key].message).join(),
      );
      expect(mismatches).toEqual([]);
    });
  });
});
