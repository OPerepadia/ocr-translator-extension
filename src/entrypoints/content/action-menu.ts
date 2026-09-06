import { t } from "@/shared/i18n";
import { MORE_ICON } from "./icons";

export interface ActionMenuItem {
  icon: string;
  label: string;
  separatorBefore?: boolean;
  onSelect(): void;
}

export interface ActionMenu {
  element: HTMLElement;
  itemElements: readonly HTMLButtonElement[];
  dispose(): void;
}

export function createActionMenu(config: {
  items: readonly ActionMenuItem[];
  overlay?: boolean;
}): ActionMenu {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-menu";
  if (config.overlay) {
    wrapper.classList.add("ocr-translate-overlay-menu");
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = config.overlay
    ? "ocr-translate-overlay-icon-button"
    : "ocr-translate-popup-icon-button";
  button.setAttribute("aria-label", t("commonMenu"));
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = t("commonMenu");
  button.innerHTML = MORE_ICON;

  const list = document.createElement("div");
  list.className = "ocr-translate-popup-menu-list";
  list.setAttribute("role", "menu");
  list.hidden = true;

  const close = (): void => {
    list.hidden = true;
    wrapper.classList.remove("is-open-above");
    button.setAttribute("aria-expanded", "false");
  };

  const itemElements = config.items.map((item) => {
    if (item.separatorBefore && list.childElementCount > 0) {
      const separator = document.createElement("div");
      separator.className = "ocr-translate-popup-menu-separator";
      separator.setAttribute("role", "separator");
      list.append(separator);
    }
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "ocr-translate-popup-menu-item";
    entry.setAttribute("role", "menuitem");

    const icon = document.createElement("span");
    icon.className = "ocr-translate-popup-menu-icon";
    icon.innerHTML = item.icon;

    const label = document.createElement("span");
    label.textContent = item.label;

    entry.append(icon, label);
    entry.addEventListener("click", () => {
      close();
      item.onSelect();
    });
    list.append(entry);
    return entry;
  });

  button.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    wrapper.classList.remove("is-open-above");
    if (
      open &&
      config.overlay &&
      list.getBoundingClientRect().bottom > window.innerHeight - 8
    ) {
      wrapper.classList.add("is-open-above");
    }
  });

  const handleOutsideClick = (event: MouseEvent): void => {
    if (!list.hidden && !event.composedPath().includes(wrapper)) {
      close();
    }
  };
  document.addEventListener("click", handleOutsideClick);

  wrapper.append(button, list);
  return {
    element: wrapper,
    itemElements,
    dispose: () => document.removeEventListener("click", handleOutsideClick),
  };
}
