import { CHEVRON_ICON } from "./icons";

export function createOptionPicker(config: {
  options: ReadonlyArray<{ id: string; label: string }>;
  currentId: string | undefined;
  title: (current: { id: string; label: string }) => string;
  onSelect: (id: string) => void;
  overlay?: boolean;
}): { element: HTMLElement; dispose: () => void } | undefined {
  if (config.options.length < 2) {
    return undefined;
  }

  const current =
    config.options.find((option) => option.id === config.currentId) ??
    config.options[0];
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-langpill";
  if (config.overlay) {
    wrapper.classList.add("ocr-translate-overlay-provider");
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-langpill-button";
  if (config.overlay) {
    button.classList.add("ocr-translate-overlay-provider-button");
  }
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.title = config.title(current);

  const label = document.createElement("span");
  if (config.overlay) {
    label.className = "ocr-translate-overlay-provider-label";
  }
  label.textContent = current.label;

  const chevron = document.createElement("span");
  chevron.className = "ocr-translate-popup-langpill-chevron";
  chevron.innerHTML = CHEVRON_ICON;
  button.append(label, chevron);

  const list = document.createElement("div");
  list.className = "ocr-translate-popup-langpill-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  const closeList = (): void => {
    list.hidden = true;
    wrapper.classList.remove("is-open-above");
    button.setAttribute("aria-expanded", "false");
  };

  const itemsBox = document.createElement("div");
  itemsBox.className = "ocr-translate-popup-langpill-items";
  for (const option of config.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ocr-translate-popup-langpill-item";
    item.setAttribute("role", "option");
    item.textContent = option.label;
    if (option.id === current.id) {
      item.setAttribute("aria-selected", "true");
      item.classList.add("is-selected");
    }
    item.addEventListener("click", () => {
      closeList();
      if (option.id !== current.id) {
        config.onSelect(option.id);
      }
    });
    itemsBox.append(item);
  }
  list.append(itemsBox);

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
      closeList();
    }
  };
  document.addEventListener("click", handleOutsideClick);

  wrapper.append(button, list);
  return {
    element: wrapper,
    dispose: () => document.removeEventListener("click", handleOutsideClick),
  };
}
