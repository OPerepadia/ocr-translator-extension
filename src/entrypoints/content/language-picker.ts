import type { LangCode } from "@/shared/types";
import { t, uiLanguage } from "@/shared/i18n";
import { CHEVRON_ICON } from "./icons";

let nextPickerId = 0;

export interface LanguagePill {
  element: HTMLElement;
  /** Detach document-level listeners owned by this picker. */
  dispose(): void;
}

export function createLanguagePill(args: {
  target: LangCode;
  languages: LangCode[];
  onChange(target: LangCode): void;
  position?: "below" | "auto";
  specialEntries?: Array<{ code: LangCode; name: string }>;
  title?: (name: string) => string;
  buttonLabel?: string;
}): LanguagePill {
  const { target, languages, onChange, position = "below" } = args;
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-langpill";

  const nameOf = (code: string): string =>
    args.specialEntries?.find((entry) => entry.code === code)?.name ??
    languageName(code);
  const currentName = nameOf(target);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-langpill-button";
  if (args.buttonLabel) {
    button.classList.add("is-compact");
  }
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.title = args.title
    ? args.title(currentName)
    : t("languageTargetTitle", currentName);
  button.setAttribute("aria-label", button.title);

  const label = document.createElement("span");
  label.textContent = args.buttonLabel ?? currentName;
  const chevron = document.createElement("span");
  chevron.className = "ocr-translate-popup-langpill-chevron";
  chevron.innerHTML = CHEVRON_ICON;
  button.append(label, chevron);

  const list = document.createElement("div");
  list.className = "ocr-translate-popup-langpill-list";
  list.hidden = true;

  function closeList(): void {
    list.hidden = true;
    wrapper.classList.remove("is-open-above");
    button.setAttribute("aria-expanded", "false");
    search?.setAttribute("aria-expanded", "false");
  }

  const codes = languages.length > 0 ? languages : [target];
  const specialEntries = args.specialEntries ?? [];
  const specialCodes = new Set(specialEntries.map(({ code }) => code));
  const options = [
    ...specialEntries,
    ...codes
      .filter((code) => !specialCodes.has(code))
      .map((code) => ({ code, name: languageName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];

  const search =
    options.length > 1 ? document.createElement("input") : undefined;
  if (search) {
    search.type = "text";
    search.className = "ocr-translate-popup-langpill-search";
    search.placeholder = t("languageSearchPlaceholder");
    search.setAttribute("aria-label", t("languageSearchLabel"));
    list.append(search);
  }

  const itemsBox = document.createElement("div");
  itemsBox.className = "ocr-translate-popup-langpill-items";
  itemsBox.id = `ocr-languages-${nextPickerId++}`;
  itemsBox.setAttribute("role", "listbox");
  itemsBox.setAttribute("aria-label", button.title);
  button.setAttribute("aria-controls", itemsBox.id);
  if (search) {
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-controls", itemsBox.id);
    search.setAttribute("aria-expanded", "false");
  }
  list.append(itemsBox);

  const entries: Array<{ element: HTMLElement; haystack: string }> = [];
  let activeItem: HTMLElement | undefined;

  function setActive(item: HTMLElement | undefined): void {
    activeItem?.classList.remove("is-active");
    activeItem = item;
    activeItem?.classList.add("is-active");
    if (activeItem) {
      search?.setAttribute("aria-activedescendant", activeItem.id);
      activeItem.scrollIntoView({ block: "nearest" });
    } else {
      search?.removeAttribute("aria-activedescendant");
    }
  }

  for (const option of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ocr-translate-popup-langpill-item";
    item.id = `${itemsBox.id}-${entries.length}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.code === target));
    item.textContent = option.name;
    if (option.code === target) {
      item.setAttribute("aria-selected", "true");
      item.classList.add("is-selected");
    }
    item.addEventListener("click", () => {
      closeList();
      button.focus();
      if (option.code !== target) {
        onChange(option.code);
      }
    });
    itemsBox.append(item);
    item.addEventListener("focus", () => setActive(item));

    const native = nativeLanguageName(option.code);
    const haystack =
      native.toLowerCase() === option.name.toLowerCase()
        ? `${option.name} ${option.code}`
        : `${option.name} ${option.code} ${native}`;
    entries.push({
      element: item,
      haystack: haystack.toLowerCase(),
    });
  }

  function applyFilter(): void {
    const query = search?.value.trim().toLowerCase() ?? "";
    for (const entry of entries) {
      entry.element.hidden = query !== "" && !entry.haystack.includes(query);
    }
    setActive(entries.find((entry) => !entry.element.hidden)?.element);
  }

  if (search) {
    search.addEventListener("input", applyFilter);
  }

  function openList(): void {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    search?.setAttribute("aria-expanded", "true");
    wrapper.classList.remove("is-open-above");
    if (
      position === "auto" &&
      list.getBoundingClientRect().bottom > window.innerHeight - 8
    ) {
      wrapper.classList.add("is-open-above");
    }
    if (search) {
      search.value = "";
      applyFilter();
      search.focus();
    }
    setActive(
      entries.find((entry) => entry.element.classList.contains("is-selected"))
        ?.element ?? entries[0]?.element,
    );
    if (!search) activeItem?.focus();
  }

  button.addEventListener("click", () => {
    if (list.hidden) openList();
    else closeList();
  });

  wrapper.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (list.hidden) {
        openList();
        return;
      }
      const visible = entries.filter((entry) => !entry.element.hidden);
      const index = visible.findIndex((entry) => entry.element === activeItem);
      const next = Math.max(
        0,
        Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      );
      setActive(visible[next]?.element);
      if (search) search.focus();
      else activeItem?.focus();
    } else if (
      !list.hidden &&
      event.key === "Enter" &&
      event.target !== button
    ) {
      event.preventDefault();
      event.stopPropagation();
      activeItem?.click();
    } else if (!list.hidden && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeList();
      button.focus();
    }
  });

  function handleOutsideClick(event: MouseEvent): void {
    if (!list.hidden && !event.composedPath().includes(wrapper)) {
      closeList();
    }
  }
  document.addEventListener("click", handleOutsideClick);

  wrapper.append(button, list);
  return {
    element: wrapper,
    dispose: () => document.removeEventListener("click", handleOutsideClick),
  };
}

export function languageName(code: string): string {
  try {
    const display = new Intl.DisplayNames([uiLanguage()], {
      type: "language",
    });
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

function nativeLanguageName(code: string): string {
  try {
    const display = new Intl.DisplayNames([code], { type: "language" });
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}
