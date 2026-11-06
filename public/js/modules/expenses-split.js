// Reparto de gastos: editor de partes, tarjeta de balance, liquidaciones y proporción por defecto.
import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog, euros, ymd, avatar } from '../ui.js';

/** "12,50 €" → 1250 (null si no hay número). */
export function toCents(v) {
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const centsInput = (c) => (c || c === 0 ? (c / 100).toFixed(2).replace('.', ',') : '');
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/** Mismo algoritmo que el servidor: mayor resto y desempate por id de usuario. */
export function allocate(total, entries) {
  const list = entries.map((e) => ({ userId: e.userId, w: BigInt(Math.max(0, Math.round(Number(e.weight) * 10000))) }))
    .filter((e) => e.w > 0n).sort((a, b) => a.userId - b.userId);
  if (!list.length || !total) return list.map((e) => ({ userId: e.userId, cents: 0 }));
  const W = list.reduce((s, e) => s + e.w, 0n), T = BigInt(total);
  const rows = list.map((e) => ({ userId: e.userId, q: (T * e.w) / W, r: (T * e.w) % W }));
  let left = T - rows.reduce((s, x) => s + x.q, 0n);
  [...rows].sort((a, b) => (a.r === b.r ? a.userId - b.userId : (b.r > a.r ? 1 : -1))).forEach((x) => { if (left > 0n) { x.q += 1n; left -= 1n; } });
  return rows.map((x) => ({ userId: x.userId, cents: Number(x.q) }));
}

const seg = (options, get, set) => {
  const el = h('div.seg');
  const draw = () => clear(el, options.map(([v, label]) => h('button', { type: 'button', class: get() === v ? 'on' : '', onclick: () => { set(v); draw(); } }, label)));
  draw();
  return el;
};

/**
 * Editor de reparto para el modal de gasto.
 * Devuelve { el, value() } → { shared, splits } listo para POST/PATCH.
 */
export function splitEditor({ expense = {}, users, settings, amountInput }) {
  const saved = expense.splits || [];
  let shared = expense.shared === undefined ? true : !!expense.shared;
  let custom = saved.length > 0;
  let kind = saved.length && saved.every((s) => s.amount_cents !== null && s.amount_cents !== undefined) ? 'amount' : 'weight';
  const inputs = new Map(users.map((u) => [u.id, h('input', { inputmode: 'decimal', oninput: () => preview() })]));
  const fill = () => {
    for (const u of users) {
      const s = saved.find((x) => x.userId === u.id);
      const def = settings?.weights?.find((w) => w.userId === u.id);
      const inp = inputs.get(u.id);
      if (kind === 'amount') { inp.value = s && s.amount_cents != null ? centsInput(s.amount_cents) : ''; inp.placeholder = '0,00 €'; }
      else { inp.value = s && s.weight != null ? String(s.weight).replace('.', ',') : (saved.length ? '' : String(settings?.mode === 'weights' ? def?.weight ?? 0 : 1)); inp.placeholder = 'peso'; }
    }
  };
  fill();

  const box = h('div.split-box');
  const prev = h('div.split-preview.small');
  const entries = () => users.map((u) => ({ userId: u.id, weight: num(inputs.get(u.id).value) })).filter((e) => e.weight > 0);
  const defaults = () => {
    const d = (settings?.weights || []).filter((w) => w.percent > 0).map((w) => ({ userId: w.userId, weight: w.percent }));
    return d.length ? d : users.map((u) => ({ userId: u.id, weight: 1 }));
  };
  const name = (id) => users.find((u) => u.id === id)?.name || '?';
  function preview() {
    const total = Math.abs(toCents(amountInput?.value) || 0);
    if (!shared) return clear(prev, 'Solo para quien lo paga: no entra en el balance.');
    if (custom && kind === 'amount') {
      const sum = users.reduce((s, u) => s + (toCents(inputs.get(u.id).value) || 0), 0);
      const diff = total - sum;
      return clear(prev, diff === 0 ? h('span.ok', '✓ Cuadra con el total') : h('span.warn', diff > 0 ? `Faltan ${euros(diff)} por repartir` : `Te pasas en ${euros(-diff)}`));
    }
    const shares = allocate(total, custom ? entries() : defaults());
    clear(prev, shares.length ? shares.map((s) => h('span.chip', `${name(s.userId)} ${euros(s.cents)}`)) : h('span.warn', 'Indica al menos un peso'));
  }
  amountInput?.addEventListener('input', preview);

  const draw = () => {
    clear(box,
      h('div.row', seg([[true, '👥 Compartido'], [false, '👤 Personal']], () => shared, (v) => { shared = v; draw(); }),
        shared ? h('label.check', h('input', { type: 'checkbox', checked: custom, onchange: (e) => { custom = e.target.checked; draw(); } }), 'Reparto personalizado') : null),
      shared && custom ? h('div.split-custom',
        h('div.row', h('span.small.muted', 'Repartir por'), seg([['amount', 'Importes'], ['weight', 'Pesos / %']], () => kind, (v) => { kind = v; fill(); draw(); })),
        users.map((u) => h('div.split-line', avatar(u), h('span.n', u.name), inputs.get(u.id)))) : null,
      shared && !custom ? h('div.small.muted', settings?.mode === 'weights' ? 'Según la proporción por defecto' : 'A partes iguales entre todos') : null,
      prev);
    preview();
  };
  draw();

  return {
    el: box,
    value() {
      if (!shared) return { shared: false, splits: null };
      if (!custom) return { shared: true, splits: null };
      const splits = users.map((u) => {
        const v = inputs.get(u.id).value.trim();
        if (!v) return null;
        return kind === 'amount' ? { userId: u.id, amount: v } : { userId: u.id, weight: num(v) };
      }).filter((s) => s && (s.amount !== undefined ? toCents(s.amount) > 0 : s.weight > 0));
      return { shared: true, splits };
    },
  };
}

/** Modal para registrar un pago entre miembros (liquidación). */
export function settleDialog({ users, debt = {}, onDone }) {
  const sel = (v) => h('select', users.map((u) => h('option', { value: u.id, selected: u.id === v }, u.name)));
  const from = sel(debt.from ?? users[0]?.id), to = sel(debt.to ?? users[1]?.id);
  const amount = h('input', { inputmode: 'decimal', value: centsInput(debt.amount_cents), placeholder: '0,00 €', required: true });
  const date = h('input', { type: 'date', value: ymd(new Date()) });
  const notes = h('input', { placeholder: 'Bizum, transferencia, efectivo…' });
  modal('Registrar pago', (close) => h('form.form', { onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      await api.post('/expenses/settlements', { from: Number(from.value), to: Number(to.value), amount: amount.value, date: date.value, notes: notes.value });
      toast('Pago registrado'); close(); onDone?.();
    } catch (err) { toastError(err); }
  } },
  h('div.cols', field('Paga', from), field('Recibe', to)),
  h('div.cols', field('Importe', amount), field('Fecha', date)),
  field('Notas', notes),
  h('div.actions', h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', 'Saldar'))));
}

/** Modal de proporción por defecto (iguales o pesos por miembro). */
export async function splitSettingsDialog({ onDone } = {}) {
  let s;
  try { s = await api.get('/expenses/split-settings'); } catch (e) { return toastError(e); }
  let mode = s.mode;
  const inputs = new Map(s.weights.map((w) => [w.userId, h('input', { inputmode: 'decimal', value: String(mode === 'weights' ? w.weight : 1).replace('.', ','), oninput: () => draw() })]));
  const body = h('div.form');
  const draw = () => {
    const W = s.weights.reduce((a, w) => a + num(inputs.get(w.userId).value), 0);
    clear(body,
      h('p.small.muted', 'Se aplica a los gastos compartidos que no tienen un reparto personalizado. Pon 0 a quien no participa (p.ej. los peques).'),
      seg([['equal', 'A partes iguales'], ['weights', 'Proporción (pesos)']], () => mode, (v) => { mode = v; draw(); }),
      mode === 'weights' ? h('div.split-custom', s.weights.map((w) => {
        const v = num(inputs.get(w.userId).value);
        return h('div.split-line', avatar({ name: w.name, color: w.color }), h('span.n', w.name), inputs.get(w.userId),
          h('span.small.muted.pct', W ? `${Math.round((v / W) * 1000) / 10} %` : '—'));
      })) : h('div.small', s.weights.map((w) => h('span.chip', `${w.name} ${Math.round(1000 / s.weights.length) / 10} %`))));
  };
  draw();
  modal('Proporción del reparto', (close) => h('div.form', body,
    h('div.actions', h('button.btn', { onclick: close }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
      try {
        await api.put('/expenses/split-settings', { mode, weights: s.weights.map((w) => ({ userId: w.userId, weight: num(inputs.get(w.userId).value) })) });
        toast('Proporción guardada'); close(); onDone?.();
      } catch (err) { toastError(err); }
    } }, 'Guardar'))));
}

/** Pinta la tarjeta de balance (saldos + deudas simplificadas). */
export function renderBalance(el, { balances: b, users, onChange }) {
  const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  clear(el,
    h('div.row', h('h2', { style: { margin: 0 } }, '⚖️ Balance'), h('div.spacer'),
      h('button.btn.sm', { onclick: () => splitSettingsDialog({ onDone: onChange }) }, 'Proporción')),
    h('div.small.muted', { style: { margin: '.25rem 0 .6rem' } }, `Gastos compartidos: ${euros(b.totalShared)}`),
    h('div.bal-users', b.users.filter((u) => u.paid || u.share || u.sent || u.received).map((u) => h('div.bal-user',
      avatar(u), h('div.who', h('strong', u.name), h('div.small.muted', `pagó ${euros(u.paid)} · le toca ${euros(u.share)}`)),
      h('span.bal-net', { class: sign(u.net) }, `${u.net > 0 ? '+' : ''}${euros(u.net)}`)))),
    b.debts.length ? h('div.debts', b.debts.map((d) => h('div.debt',
      h('span', h('strong', d.fromName), ' debe ', h('strong', euros(d.amount_cents)), ' a ', h('strong', d.toName)),
      h('div.spacer'),
      h('button.btn.sm.primary', { onclick: () => settleDialog({ users, debt: d, onDone: onChange }) }, 'Saldar'))))
      : h('div.debt.even', '✓ Estáis en paz: nadie debe nada'));
}

/** Pinta la lista de liquidaciones con borrar. */
export function renderSettlements(el, { settlements, users, onChange }) {
  clear(el,
    h('div.row', { style: { marginBottom: '.5rem' } }, h('h2', { style: { margin: 0 } }, '🤝 Pagos entre miembros'), h('div.spacer'),
      h('button.btn.sm', { onclick: () => settleDialog({ users, onDone: onChange }) }, '+ Pago')),
    settlements.length ? h('ul.settle-list', settlements.slice(0, 12).map((s) => h('li',
      h('span.small.muted.d', new Date(`${s.date}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })),
      h('span.t', `${s.from_name} → ${s.to_name}`, s.notes ? h('span.small.muted', ` · ${s.notes}`) : null),
      h('strong', euros(s.amount_cents)),
      h('button.btn.sm.ghost.danger', { 'aria-label': 'Borrar pago', onclick: async () => {
        if (!(await confirmDialog(`Borrar el pago de ${euros(s.amount_cents)} de ${s.from_name} a ${s.to_name}?`))) return;
        try { await api.del(`/expenses/settlements/${s.id}`); onChange?.(); } catch (e) { toastError(e); }
      } }, '✕'))))
      : h('div.empty', { style: { padding: '1rem' } }, 'Aún no hay pagos registrados'));
}
