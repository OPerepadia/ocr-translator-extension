import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const popoverSource = await readFile(new URL("overlay-popover.ts", contentDir), "utf8");
const iconsSource = await readFile(new URL("icons.ts", contentDir), "utf8");
const css = await readFile(new URL("style.css", contentDir), "utf8");
const { code } = await transformWithOxc(
  [
    "const t = (key: string) => key;",
    "const rotatedBounds = (rect: any) => rect;",
    "const isSpeaking = () => false, requestSpeak = () => {}, stopSpeaking = () => {};",
    iconsSource,
    popoverSource,
  ]
    .join("\n")
    .replace(/^import [^;]*;\n/gm, ""),
  "overlay-popover.ts",
);

// Two boxes. `line` is unset for the combined box, which has the whole text.
const setupScript = `${code}
  window.start = (contents, combined, y) => {
    const host = document.querySelector("#host");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    const container = document.createElement("div");
    container.className = "ocr-translate-overlay";
    // Stands for the captured image under the boxes.
    const snapshot = document.createElement("div");
    snapshot.style.cssText = "position:absolute;inset:0;pointer-events:auto";
    container.append(snapshot);
    shadow.append(style, container);
    window.events = [];
    const createBoxes = (view) => contents.map((content, index) => {
      const element = document.createElement("div");
      element.className = "ocr-translate-overlay-box ocr-translate-overlay-frame-box";
      element.dataset.view = view;
      element.tabIndex = 0;
      // Far apart, so one box's popover does not cover the other.
      const rect = { x: 40 + index * 500, y, width: 200, height: 40 };
      element.style.cssText = \`left:\${rect.x}px;top:\${rect.y}px;width:\${rect.width}px;height:\${rect.height}px\`;
      element.hidden = view === "original";
      container.append(element);
      return { element, rect, angle: 0, content, line: combined ? undefined : index };
    });
    const boxes = { translation: createBoxes("translation"), original: createBoxes("original") };
    let view = "translation";
    window.popover = createOverlayPopover({
      container,
      speechOwner: "test",
      getState: () => ({
        boxes: boxes[view],
        mode: view,
        hasTranslation: true,
        canEdit: true,
        sourceLang: "en",
        targetLang: "uk",
        selectingFromPopover: false,
      }),
      beginSelection: () => {},
      endSelection: () => {},
      onEditingChange: (editing) => {
        view = editing ? "original" : "translation";
        for (const [name, list] of Object.entries(boxes)) {
          list.forEach((box) => { box.element.hidden = name !== view; });
        }
        window.events.push(editing ? "editing" : "reading");
      },
      onCorrect: (box, text) => window.events.push([box.line ?? "all", text]),
    });
    for (const list of Object.values(boxes)) {
      list.forEach((box, index) => window.popover.attach(box.element, index));
    }
  };
`;

const CONTENTS = [
  { original: "ofd sample", translated: "first" },
  { original: "other text", translated: "second" },
];

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  const withPopover = (label, run, { contents = CONTENTS, combined = false, y = 40 } = {}) =>
    test(`${name}: ${label}`, async () => {
      const browser = await browserType.launch({
        headless: true,
        executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
      });
      try {
        const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
        await page.setContent("<div id='host'></div>");
        await page.addScriptTag({ type: "module", content: setupScript });
        await page.waitForFunction(() => Boolean(window.start));
        await page.evaluate(([contents, combined, y]) => {
          window.start(contents, combined, y);
        }, [contents, combined, y]);
        const popover = page.locator(".ocr-translate-overlay-popover");
        const ui = {
          page,
          popover,
          editor: popover.locator("textarea"),
          edit: popover.getByRole("button", { name: "overlayEditText" }),
          cancel: popover.getByRole("button", { name: "commonCancel" }),
          save: popover.getByRole("button", { name: "commonSave" }),
          events: () => page.evaluate(() => window.events),
          hover: async (index) => {
            await page.mouse.move(60 + index * 500, y + 15);
            await page.mouse.move(61 + index * 500, y + 15);
          },
          openEditor: async (index = 0) => {
            await ui.hover(index);
            await ui.edit.click();
          },
        };
        await run(ui);
      } finally {
        await browser.close();
      }
    });

  withPopover("a corrected line is sent with Save", async (ui) => {
    await ui.openEditor();
    assert.equal(await ui.editor.inputValue(), "ofd sample");
    assert.equal(
      await ui.editor.evaluate((editor) => editor.getRootNode().activeElement === editor),
      true,
    );
    assert.equal(await ui.save.isDisabled(), true);
    assert.deepEqual(await ui.events(), ["editing"]);

    // The editor takes real keys.
    await ui.page.keyboard.press("Home");
    await ui.page.keyboard.press("ArrowRight");
    await ui.page.keyboard.press("Delete");
    await ui.page.keyboard.type("l");
    assert.equal(await ui.editor.inputValue(), "old sample");
    assert.equal(await ui.save.isDisabled(), false);

    // Enter neither sends the text nor starts a new line.
    await ui.page.keyboard.press("End");
    for (const key of ["Enter", "Shift+Enter", "Control+Enter"]) {
      await ui.page.keyboard.press(key);
    }
    assert.equal(await ui.editor.inputValue(), "old sample");
    assert.deepEqual(await ui.events(), ["editing"]);

    // Save can be reached with the keyboard.
    await ui.page.keyboard.press("Tab");
    await ui.page.keyboard.press("Tab");
    await ui.page.keyboard.press("Enter");
    assert.deepEqual(await ui.events(), ["editing", "reading", [0, "old sample"]]);
    assert.equal(await ui.popover.isHidden(), true);
  });

  withPopover("a correction of the second box is sent as one line", async (ui) => {
    await ui.openEditor(1);
    // Pasted line breaks would shift the other boxes' lines.
    await ui.editor.fill("  another \n text ");
    await ui.save.click();
    assert.deepEqual(await ui.events(), ["editing", "reading", [1, "another text"]]);
  });

  withPopover("nothing is sent for unchanged or empty text", async (ui) => {
    await ui.openEditor();
    await ui.editor.fill("  ");
    assert.equal(await ui.save.isDisabled(), true);

    await ui.editor.fill("ofd sample ");
    assert.equal(await ui.save.isDisabled(), true);
  });

  withPopover("Cancel and Escape go back to reading, and Escape then closes", async (ui) => {
    await ui.openEditor();
    await ui.editor.fill("changed");
    await ui.cancel.click();
    assert.equal(await ui.editor.count(), 0);
    assert.equal(await ui.popover.getByText("ofd sample").isVisible(), true);
    assert.equal(
      await ui.edit.evaluate((button) => button.getRootNode().activeElement === button),
      true,
    );

    await ui.edit.click();
    assert.equal(await ui.editor.inputValue(), "ofd sample");
    // The overlay calls this on Escape.
    assert.equal(await ui.page.evaluate(() => window.popover.dismiss()), true);
    assert.equal(await ui.popover.isVisible(), true);
    assert.equal(await ui.page.evaluate(() => window.popover.dismiss()), true);
    assert.equal(await ui.popover.isHidden(), true);
    assert.equal(await ui.page.evaluate(() => window.popover.dismiss()), false);
    assert.deepEqual(await ui.events(), ["editing", "reading", "editing", "reading"]);
  });

  withPopover("an edit survives the pointer and clicks elsewhere", async (ui) => {
    await ui.openEditor();
    // Enter the editor first, so that leaving it is seen.
    await ui.editor.hover();
    await ui.page.mouse.move(800, 560);
    await ui.page.waitForTimeout(400);
    assert.equal(await ui.editor.isVisible(), true);
    await ui.hover(1);
    await ui.page.waitForTimeout(300);
    assert.equal(await ui.editor.inputValue(), "ofd sample");

    await ui.editor.fill("changed");
    await ui.page.mouse.click(800, 560);
    assert.equal(await ui.editor.inputValue(), "changed");
    await ui.page.locator(".ocr-translate-overlay-box[data-view='original']").nth(1).press("Enter");
    assert.equal(await ui.editor.inputValue(), "changed");

    // Without changes a click outside closes the popover and shows the cards again.
    await ui.editor.fill("ofd sample");
    await ui.page.mouse.click(800, 560);
    assert.equal(await ui.popover.isHidden(), true);
    assert.deepEqual(await ui.events(), ["editing", "reading"]);
    const open = await ui.page
      .locator(".ocr-translate-overlay-box.is-active")
      .count();
    assert.equal(open, 0);
  });

  withPopover("input methods can use Enter", async (ui) => {
    await ui.openEditor();
    const kept = await ui.editor.evaluate((editor) =>
      [true, false].map((isComposing) =>
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", isComposing, cancelable: true }),
        ),
      ),
    );
    assert.deepEqual(kept, [true, false]);
  });

  withPopover(
    "Enter starts a new line in the whole text",
    async (ui) => {
      await ui.openEditor();
      await ui.editor.press("End");
      await ui.page.keyboard.press("Enter");
      await ui.page.keyboard.type("new line");
      assert.equal(await ui.editor.inputValue(), "one line\nnew line");
      await ui.save.click();
      assert.deepEqual(await ui.events(), ["editing", "reading", ["all", "one line\nnew line"]]);
    },
    { contents: [{ original: "one line", translated: "first" }], combined: true },
  );

  withPopover("the editor is not much wider than short text", async (ui) => {
    const width = () => ui.popover.evaluate((popover) => popover.offsetWidth);
    await ui.hover(0);
    const reading = await width();
    await ui.edit.click();
    assert.equal(await width(), 320);
    await ui.editor.fill("sample text ".repeat(20));
    assert.equal(await width(), 320);
    await ui.cancel.click();
    assert.equal(await width(), reading);
  });

  withPopover(
    "the editor is as wide as long text",
    async (ui) => {
      const width = () => ui.popover.evaluate((popover) => popover.offsetWidth);
      await ui.hover(0);
      const reading = await width();
      assert.ok(reading > 320, `width ${reading}`);
      await ui.edit.click();
      assert.equal(await width(), reading);
    },
    { contents: [{ original: "sample text ".repeat(20), translated: "first" }] },
  );

  withPopover(
    "the editor stays on its side while typing",
    async (ui) => {
      const place = () =>
        ui.popover.evaluate((el) => ({
          x: el.offsetLeft,
          y: el.offsetTop,
          bottom: el.offsetTop + el.offsetHeight,
        }));
      await ui.openEditor();
      let last = await place();
      assert.equal(last.y, 440);
      for (let i = 0; i < 50; i++) {
        await ui.page.keyboard.type(" more text");
        const next = await place();
        assert.equal(next.x, last.x);
        // Up by a line at most, when there is no more room below.
        assert.ok(last.y - next.y <= 24, `${last.y} -> ${next.y}`);
        assert.ok(next.bottom <= 592, `bottom ${next.bottom}`);
        last = next;
      }
      // The best side is chosen again when the page scrolls.
      await ui.page.evaluate(() => window.popover.reposition());
      assert.ok(last.y - (await place()).y > 24);
    },
    // The text fits below at first.
    { y: 400 },
  );

  withPopover(
    "the editor grows with its text, then scrolls inside the popover",
    async (ui) => {
      await ui.openEditor();
      const height = () => ui.editor.evaluate((editor) => editor.offsetHeight);
      const oneLine = await height();
      await ui.editor.fill("sample text ".repeat(20));
      assert.ok((await height()) > oneLine * 1.5);

      await ui.editor.fill("sample text ".repeat(300));
      // A caret at the end stays in view while typing.
      await ui.editor.press("Control+End");
      await ui.page.keyboard.type("end");
      await ui.page.waitForTimeout(100);
      const layout = await ui.popover.evaluate((popover) => {
        const editor = popover.querySelector("textarea");
        const actions = popover.querySelector(".ocr-translate-overlay-popover-actions");
        const box = popover.getBoundingClientRect();
        return {
          inView: box.top >= 0 && box.bottom <= innerHeight,
          scrolls: editor.scrollHeight > editor.clientHeight,
          atEnd: editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 8,
          actionsInside: actions.getBoundingClientRect().bottom <= box.bottom,
          tall: editor.offsetHeight,
        };
      });
      assert.deepEqual(
        { ...layout, tall: layout.tall > 60 },
        { inView: true, scrolls: true, atEnd: true, actionsInside: true, tall: true },
      );
    },
  );

  withPopover("selecting text past the popover keeps it open", async (ui) => {
    await ui.hover(0);
    const text = await ui.popover.getByText("ofd sample").boundingBox();
    await ui.page.mouse.move(text.x + 4, text.y + text.height / 2);
    await ui.page.mouse.down();
    await ui.page.mouse.move(text.x + 600, text.y + 300, { steps: 4 });
    await ui.page.mouse.up();
    assert.equal(await ui.popover.isVisible(), true);
    await ui.page.mouse.click(800, 560);
    assert.equal(await ui.popover.isHidden(), true);
  });

  withPopover("text can be selected in the editor with the mouse", async (ui) => {
    await ui.openEditor();
    const box = await ui.editor.boundingBox();
    await ui.page.mouse.move(box.x + 12, box.y + box.height / 2);
    await ui.page.mouse.down();
    await ui.page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
    await ui.page.mouse.up();
    const selected = await ui.editor.evaluate(
      (editor) => editor.selectionEnd - editor.selectionStart,
    );
    assert.ok(selected > 2, `selected ${selected}`);

    // Releasing the mouse past the editor is not a click outside it. Start
    // without a selection, or the text itself would be dragged.
    await ui.page.mouse.click(box.x + 12, box.y + box.height / 2);
    await ui.page.mouse.down();
    await ui.page.mouse.move(box.x + 600, box.y + 300, { steps: 4 });
    await ui.page.mouse.up();
    assert.equal(await ui.editor.isVisible(), true);
    await ui.page.mouse.click(box.x + 600, box.y + 300);
    assert.equal(await ui.popover.isHidden(), true);
  });
}
