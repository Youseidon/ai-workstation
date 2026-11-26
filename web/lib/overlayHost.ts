export function overlayHost(): HTMLElement {
  const modals = [...document.querySelectorAll("dialog")].filter((node) => node.open && node.matches(":modal"));
  return modals.at(-1) ?? document.body;
}
