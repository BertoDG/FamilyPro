/** Mini helper para crear DOM: h('div.card#id', {onclick}, ...hijos) */
export function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

export function toast(msg, type = '') {
  const t = h('div.toast', { class: type }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
export const toastError = (e) => toast(e.message || String(e), 'err');

/** Abre un modal. content puede ser un nodo o una función (close) => nodo. Devuelve close(). */
export function modal(title, content) {
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  const bg = h('div.modal-bg', { onclick: (e) => e.target === bg && close() },
    h('div.modal', h('div.row', h('h2', title), h('div.spacer'), h('button.btn.ghost', { onclick: close, 'aria-label': 'Cerrar' }, '✕')),
      typeof content === 'function' ? content(close) : content));
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  bg.querySelector('input, textarea, select')?.focus();
  return close;
}

export function confirmDialog(text, okLabel = 'Eliminar') {
  return new Promise((resolve) => {
    let done = false;
    const close = modal('¿Seguro?', (c) => h('div', h('p', text), h('div.actions',
      h('button.btn', { onclick: () => { done = true; c(); resolve(false); } }, 'Cancelar'),
      h('button.btn.primary', { onclick: () => { done = true; c(); resolve(true); } }, okLabel))));
    void close; void done;
  });
}

export const field = (label, input) => h('label.field', label, input);

export const euros = (cents) => (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const fmtLongDate = (s) => parseYmd(s).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
export const initials = (name = '') => name.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
export const avatar = (u) => h('span.avatar', { style: { background: u.color }, title: u.name }, initials(u.name));

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); } catch { prompt('Copia el texto:', text); }
}
