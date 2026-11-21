import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const menuSource = await readFile(new URL("action-menu.ts", contentDir), "utf8");
const iconsSource = await readFile(new URL("icons.ts", contentDir), "utf8");
const css = await readFile(new URL("style.css", contentDir), "utf8");
const { code } = await transformWithOxc(
  ["const t = (key: string) => key;", iconsSource, menuSource]
    .join("\n")
    .replace(/^import .*;\n/gm, ""),
  "action-menu.ts",
);

// One plain item and one group with two choices.
const setupScript = `${code}
  let choice = "a";
  window.events = [];
  const menu = createActionMenu({
    overlay: true,
    items: [
      { icon: "<i></i>", label: "Plain", onSelect: () => window.events.push("plain") },
      {
        icon: "<i></i>",
        label: "Group",
        separatorBefore: true,
        currentLabel: () => (choice === "a" ? "Label A" : "Label B"),
        choices: [
          {
            label: "Label A",
            isChecked: () => choice === "a",
            onSelect: () => { choice = "a"; window.events.push("a"); },
          },
          {
            label: "Label B",
            isChecked: () => choice === "b",
            onSelect: () => { choice = "b"; window.events.push("b"); },
          },
        ],
      },
    ],
  });
  document.querySelector("main").append(menu.element);
`;

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  test(`${name}: a group opens in place, folds back after a choice and shows the current choice`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage();
      await page.setContent("<main></main><p id='outside'>Outside</p>");
      await page.addScriptTag({ type: "module", content: setupScript });

      const toggle = page.locator(".ocr-translate-popup-menu > button").first();
      const head = page.locator(".ocr-translate-popup-menu-group");
      const choices = page.locator(".ocr-translate-popup-menu-choices");
      const choiceRows = page.locator("[role='menuitemradio']");
      const read = () =>
        page.evaluate(() => ({
          menuHidden: document.querySelector("[role='menu']").hidden,
          choicesHidden: document.querySelector(".ocr-translate-popup-menu-choices").hidden,
          expanded: document
            .querySelector(".ocr-translate-popup-menu-group")
            .getAttribute("aria-expanded"),
          value: document.querySelector(".ocr-translate-popup-menu-value").textContent,
          checked: [...document.querySelectorAll("[role='menuitemradio']")].map((row) =>
            row.getAttribute("aria-checked"),
          ),
        }));

      await toggle.click();
      assert.deepEqual(await read(), {
        menuHidden: false,
        choicesHidden: true,
        expanded: "false",
        value: "Label A",
        checked: ["true", "false"],
      });

      await head.click();
      assert.deepEqual(await read(), {
        menuHidden: false,
        choicesHidden: false,
        expanded: "true",
        value: "Label A",
        checked: ["true", "false"],
      });
      assert.equal(await choices.getAttribute("role"), "group");

      // Choosing keeps the menu open, folds the group back and shows the new
      // choice on its row.
      await choiceRows.nth(1).click();
      assert.deepEqual(await page.evaluate(() => window.events), ["b"]);
      assert.deepEqual(await read(), {
        menuHidden: false,
        choicesHidden: true,
        expanded: "false",
        value: "Label B",
        checked: ["false", "true"],
      });

      // The group can be opened again, and the menu opens folded after closing.
      await head.click();
      assert.equal((await read()).choicesHidden, false);
      await page.locator("#outside").click();
      assert.equal((await read()).menuHidden, true);
      await toggle.click();
      assert.deepEqual(await read(), {
        menuHidden: false,
        choicesHidden: true,
        expanded: "false",
        value: "Label B",
        checked: ["false", "true"],
      });

      // A plain item still runs and closes the menu.
      await page.locator("[role='menuitem']").first().click();
      assert.deepEqual(await page.evaluate(() => window.events), ["b", "plain"]);
      assert.equal((await read()).menuHidden, true);
    } finally {
      await browser.close();
    }
  });

  test(`${name}: expanding a group opens the list upward when it no longer fits below`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 500, height: 420 } });
      await page.setContent("<main></main>");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ type: "module", content: setupScript });

      const toggle = page.locator(".ocr-translate-popup-menu > button").first();
      const wrapper = page.locator(".ocr-translate-popup-menu");

      // Leave room for the closed list below the button, but not the open one.
      await toggle.click();
      const sizes = await page.evaluate(() => ({
        button: document.querySelector(".ocr-translate-popup-menu > button").offsetHeight,
        list: document.querySelector("[role='menu']").offsetHeight,
      }));
      await toggle.click();
      await page.evaluate(({ button, list }) => {
        const main = document.querySelector("main");
        main.style.cssText = `position:fixed;right:20px;top:${
          window.innerHeight - 8 - 6 - button - list - 10
        }px`;
      }, sizes);

      await toggle.click();
      assert.equal(await wrapper.evaluate((el) => el.classList.contains("is-open-above")), false);
      await page.locator(".ocr-translate-popup-menu-group").click();
      assert.equal(await wrapper.evaluate((el) => el.classList.contains("is-open-above")), true);
    } finally {
      await browser.close();
    }
  });
}
