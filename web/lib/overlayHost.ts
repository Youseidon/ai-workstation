/**
 * Where a popup should portal. A native modal <dialog> (the detail drawer as
 * a sheet, the mobile sidebar) sits in the browser's top layer and makes the
 * rest of the page inert, so a popup portalled to <body> would open beneath
 * it and could not be clicked. Portalling into the topmost open modal dialog
 * keeps the popup above it and interactive; `position: fixed` still covers
 * the viewport because dialogs are not transformed.
 */
export function overlayHost(): HTMLElement {
  const modals = [...document.querySelectorAll("dialog")].filter((node) => node.open && node.matches(":modal"));
  return modals.at(-1) ?? document.body;
}
