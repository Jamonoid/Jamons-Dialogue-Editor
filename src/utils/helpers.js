/** Generate a short unique ID (counter prevents collisions during batch creation) */
let _uidCounter = 0;
export const uid = () =>
  Date.now().toString(36) + ((_uidCounter++) % 1000).toString(36) + Math.random().toString(36).slice(2, 9);

/** querySelector shortcut */
export const $ = (sel, root = document) => root.querySelector(sel);

/** querySelectorAll shortcut (returns real Array) */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape HTML to prevent XSS in templates */
export function esc(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
