import { t } from "@/shared/i18n";
import { CHECK_ICON, CHEVRON_ICON, MORE_ICON } from "./icons";

export interface ActionMenuItem {
  icon: string;
  label: string;
  separatorBefore?: boolean;
  onSelect(): void;
}

export interface ActionMenuChoice {
  label: string;
  isChecked(): boolean;
  onSelect(): void;
}

/** A row that opens a short list of choices in place. */
export interface ActionMenuChoiceGroup {
  icon: string;
  label: string;
  separatorBefore?: boolean;
  /** Shown on the row. Read again when the menu opens and after each choice. */
  currentLabel(): string;
  choices: readonly ActionMenuChoice[];
}

export interface ActionMenu {
  element: HTMLElement;
  itemElements: readonly HTMLButtonElement[];
  dispose(): void;
}

export function createActionMenu(config: {
  items: ReadonlyArray<ActionMenuItem | ActionMenuChoiceGroup>;
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

  const refreshers: Array<() => void> = [];
  const collapsers: Array<() => void> = [];

  const refresh = (): void => {
    for (const refreshGroup of refreshers) {
      refreshGroup();
    }
  };

  // Open the list above the button when it would run off the bottom.
  const placeList = (): void => {
    wrapper.classList.remove("is-open-above");
    if (
      config.overlay &&
      list.getBoundingClientRect().bottom > window.innerHeight - 8
    ) {
      wrapper.classList.add("is-open-above");
    }
  };

  const close = (): void => {
    list.hidden = true;
    wrapper.classList.remove("is-open-above");
    button.setAttribute("aria-expanded", "false");
    for (const collapse of collapsers) {
      collapse();
    }
  };

  const createRow = (iconMarkup: string, text: string): HTMLButtonElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ocr-translate-popup-menu-item";

    const icon = document.createElement("span");
    icon.className = "ocr-translate-popup-menu-icon";
    icon.innerHTML = iconMarkup;

    const label = document.createElement("span");
    label.textContent = text;

    row.append(icon, label);
    return row;
  };

  const addItem = (item: ActionMenuItem): HTMLButtonElement => {
    const row = createRow(item.icon, item.label);
    row.setAttribute("role", "menuitem");
    row.addEventListener("click", () => {
      close();
      item.onSelect();
    });
    list.append(row);
    return row;
  };

  const addGroup = (group: ActionMenuChoiceGroup): HTMLButtonElement => {
    const head = createRow(group.icon, group.label);
    head.classList.add("ocr-translate-popup-menu-group");
    head.setAttribute("role", "menuitem");
    head.setAttribute("aria-haspopup", "true");
    head.setAttribute("aria-expanded", "false");

    const value = document.createElement("span");
    value.className = "ocr-translate-popup-menu-value";
    const chevron = document.createElement("span");
    chevron.className = "ocr-translate-popup-menu-chevron";
    chevron.innerHTML = CHEVRON_ICON;
    head.append(value, chevron);

    const choices = document.createElement("div");
    choices.className = "ocr-translate-popup-menu-choices";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", group.label);
    choices.hidden = true;

    const setExpanded = (expanded: boolean): void => {
      choices.hidden = !expanded;
      head.setAttribute("aria-expanded", String(expanded));
    };

    // The check mark is always there and only hidden by style, so choosing an
    // item never replaces the element that was clicked. The menu stays open and
    // the group folds back, with the new choice shown on its row.
    const choiceRows = group.choices.map((choice) => {
      const row = createRow(CHECK_ICON, choice.label);
      row.setAttribute("role", "menuitemradio");
      row.addEventListener("click", () => {
        choice.onSelect();
        refresh();
        setExpanded(false);
      });
      choices.append(row);
      return { row, choice };
    });

    head.addEventListener("click", () => {
      const expand = head.getAttribute("aria-expanded") !== "true";
      setExpanded(expand);
      if (expand) {
        placeList();
      }
    });

    const refreshGroup = (): void => {
      value.textContent = group.currentLabel();
      for (const { row, choice } of choiceRows) {
        row.setAttribute("aria-checked", String(choice.isChecked()));
      }
    };
    refreshers.push(refreshGroup);
    collapsers.push(() => setExpanded(false));
    refreshGroup();

    list.append(head, choices);
    return head;
  };

  const itemElements = config.items.map((item) => {
    if (item.separatorBefore && list.childElementCount > 0) {
      const separator = document.createElement("div");
      separator.className = "ocr-translate-popup-menu-separator";
      separator.setAttribute("role", "separator");
      list.append(separator);
    }
    return "choices" in item ? addGroup(item) : addItem(item);
  });

  button.addEventListener("click", () => {
    if (!list.hidden) {
      close();
      return;
    }
    refresh();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    placeList();
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
