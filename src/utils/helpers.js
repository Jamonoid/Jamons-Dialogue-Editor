/** Generate a short unique ID */
export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
