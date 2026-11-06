import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog, euros, ymd, cap } from '../ui.js';
import { state } from '../app.js';
import { splitEditor, renderBalance, renderSettlements, splitSettingsDialog } from './expenses-split.js';

const SRC = { web: '🖥️', wallet: '💳', siri: '🎙️', shortcut: '⚡' };
const monthLabel = (m) => cap(new Date(`${m}-01T12:00:00`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
const shiftMonth = (m, n) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export default {
  id: 'expenses', title: 'Gastos', icon: '💶', module: 'expenses',
  async render(el) {
    let month = ymd(new Date()).slice(0, 7), cats = [], q = '', catFilter = '', splitSettings = null;
    const head = h('div.page-head');
    const stats = h('div.grid.cards');
    const breakdown = h('div.card');
    const side = h('div.grid');
    const table = h('div.card');
    const balanceCard = h('div.card.balance');
    const settleCard = h('div.card');

    const load = async () => {
      try {
        const qs = new URLSearchParams({ month, ...(q ? { q } : {}), ...(catFilter ? { category: catFilter } : {}) });
        const [sum, rows, c, bal, settl, ss] = await Promise.all([api.get(`/expenses/summary?month=${month}`), api.get(`/expenses?${qs}`), api.get('/expenses/categories'),
          api.get('/expenses/balances'), api.get('/expenses/settlements'), api.get('/expenses/split-settings')]);
        cats = c; splitSettings = ss;
        renderHead(); renderStats(sum); renderBreakdown(sum); renderSide(sum); renderTable(rows);
        renderBalance(balanceCard, { balances: bal, users: state.users, onChange: load });
        renderSettlements(settleCard, { settlements: settl, users: state.users, onChange: load });
      } catch (e) { toastError(e); }
    };

    const renderHead = () => clear(head, h('h1', '💶 Gastos'), h('div.spacer'),
      h('button.btn.ghost', { onclick: () => { month = shiftMonth(month, -1); load(); } }, '‹'),
      h('strong', { style: { minWidth: '9rem', textAlign: 'center' } }, monthLabel(month)),
      h('button.btn.ghost', { onclick: () => { month = shiftMonth(month, 1); load(); } }, '›'),
      h('button.btn', { onclick: manageCategories }, '⚙︎ Categorías'),
      h('button.btn', { onclick: () => splitSettingsDialog({ onDone: load }) }, '⚖︎ Reparto'),
      h('button.btn', { onclick: exportCsv }, '⬇︎ CSV'),
      h('button.btn.primary', { onclick: () => editExpense() }, '+ Gasto'));

    const renderStats = (s) => {
      const days = month === ymd(new Date()).slice(0, 7) ? new Date().getDate() : new Date(...month.split('-').map(Number), 0).getDate();
      const prev = s.history.at(-2)?.total || 0;
      const diff = prev ? Math.round(((s.total - prev) / prev) * 100) : null;
      clear(stats,
        h('div.card.stat', h('div.t', 'Total del mes'), h('div.v', euros(s.total)), h('div.t', diff === null ? '—' : `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}% vs mes anterior`)),
        h('div.card.stat', h('div.t', 'Movimientos'), h('div.v', s.count), h('div.t', `${euros(s.count ? Math.round(s.total / s.count) : 0)} de media`)),
        h('div.card.stat', h('div.t', 'Gasto diario'), h('div.v', euros(Math.round(s.total / days))), h('div.t', `en ${days} días`)));
    };

    const renderBreakdown = (s) => clear(breakdown, h('h2', 'Por categoría'),
      s.byCategory.length ? s.byCategory.map((c) => {
        const pct = c.budget_cents ? Math.min(100, (c.total / c.budget_cents) * 100) : (s.total ? (c.total / s.total) * 100 : 0);
        const over = c.budget_cents && c.total > c.budget_cents;
        return h('div', { style: { marginBottom: '.7rem', cursor: 'pointer' }, onclick: () => { catFilter = catFilter == c.id ? '' : String(c.id); load(); } },
          h('div.row', h('span', `${c.icon} ${c.name}`), catFilter == c.id ? h('span.badge', 'filtrado') : null, h('div.spacer'),
            h('strong', euros(c.total)), c.budget_cents ? h('span.small.muted', `/ ${euros(c.budget_cents)}`) : null),
          h('div.bar', h('span', { style: { width: `${pct}%`, background: over ? 'var(--danger)' : c.color } })));
      }) : h('div.empty', 'Sin gastos este mes'));

    const renderSide = (s) => {
      const max = Math.max(1, ...s.history.map((x) => x.total));
      clear(side,
        h('div.card', h('h2', 'Últimos 6 meses'), h('div.hbars', s.history.map((x) =>
          h('div.b', { class: x.month === month ? 'cur' : '', title: euros(x.total) }, h('small', euros(x.total).replace(/,\d+/, '')),
            h('span', { style: { height: `${(x.total / max) * 80}%` } }),
            new Date(`${x.month}-01T12:00:00`).toLocaleDateString('es-ES', { month: 'short' }))))),
        h('div.card', h('h2', 'Quién ha pagado'), s.byUser.map((u) => h('div.row', { style: { marginBottom: '.4rem' } },
          h('span.dot', { style: { background: u.color } }), u.name, h('div.spacer'), h('strong', euros(u.total)),
          h('span.small.muted', { title: 'Lo que le corresponde (su parte de los compartidos + sus gastos personales)' }, `le toca ${euros(u.share || 0)}`)))));
    };

    const renderTable = (rows) => {
      const search = h('input', { type: 'search', placeholder: 'Buscar…', value: q, oninput: (e) => { q = e.target.value; clearTimeout(search._t); search._t = setTimeout(load, 300); } });
      clear(table, h('div.row', { style: { marginBottom: '.5rem' } }, h('h2', { style: { margin: 0 } }, 'Movimientos'), h('div.spacer'), h('div', { style: { width: '220px' } }, search)),
        rows.length ? h('div', { style: { overflowX: 'auto' } }, h('table',
          h('thead', h('tr', h('th', 'Fecha'), h('th', 'Concepto'), h('th', 'Categoría'), h('th', 'Pagó'), h('th.num', 'Importe'))),
          h('tbody', rows.map((r) => h('tr', { style: { cursor: 'pointer' }, onclick: () => editExpense(r) },
            h('td.small', new Date(`${r.date}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })),
            h('td', h('span', { title: r.source }, SRC[r.source] || '•'), ' ', r.description, r.card ? h('span.small.muted', ` · ${r.card}`) : null,
              !r.shared ? h('span.badge.split-tag', 'personal') : r.splits?.length ? h('span.badge.split-tag', { title: r.shares.map((x) => `${state.users.find((u) => u.id === x.userId)?.name || '?'}: ${euros(x.cents)}`).join(' · ') }, 'a medida') : null),
            h('td', h('span.chip', h('span.dot', { style: { background: r.category_color || '#999' } }), r.category_name || '—')),
            h('td.small', r.paid_by_name || '—'),
            h('td.num', h('strong', euros(r.amount_cents)))))))) : h('div.empty', 'No hay movimientos'));
      if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
    };

    const editExpense = (e = {}) => {
      const isNew = !e.id;
      const amount = h('input', { inputmode: 'decimal', value: e.amount_cents ? (e.amount_cents / 100).toFixed(2).replace('.', ',') : '', placeholder: '0,00 €', required: true });
      const desc = h('input', { value: e.description || '', placeholder: 'Concepto' });
      const merchant = h('input', { value: e.merchant || '', placeholder: 'Comercio (opcional)' });
      const date = h('input', { type: 'date', value: e.date || ymd(new Date()) });
      const cat = h('select', h('option', { value: '' }, 'Automática'), cats.map((c) => h('option', { value: c.id, selected: c.id === e.category_id }, `${c.icon} ${c.name}`)));
      const paid = h('select', state.users.map((u) => h('option', { value: u.id, selected: u.id === (e.paid_by ?? state.me.id) }, u.name)));
      const notes = h('input', { value: e.notes || '', placeholder: 'Notas' });
      const split = splitEditor({ expense: e, users: state.users, settings: splitSettings, amountInput: amount });
      modal(isNew ? 'Nuevo gasto' : 'Editar gasto', (close) => h('form.form', { onsubmit: async (ev) => {
        ev.preventDefault();
        const body = { amount: amount.value, description: desc.value, merchant: merchant.value, date: date.value, paidBy: Number(paid.value), notes: notes.value, ...split.value() };
        try {
          if (isNew) await api.post('/expenses', { ...body, category: cat.value || undefined });
          else await api.patch(`/expenses/${e.id}`, { ...body, categoryId: cat.value ? Number(cat.value) : null });
          toast('Guardado'); close(); load();
        } catch (err) { toastError(err); }
      } },
      h('div.cols', field('Importe', amount), field('Fecha', date)),
      field('Concepto', desc), field('Comercio', merchant),
      h('div.cols', field('Categoría', cat), field('Pagado por', paid)),
      h('div.field-group', h('div.small.muted', 'Reparto'), split.el), notes,
      !isNew ? h('div.small.muted', `Origen: ${SRC[e.source] || ''} ${e.source}`) : null,
      h('div.actions', !isNew ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!(await confirmDialog('Eliminar este gasto?'))) return;
        await api.del(`/expenses/${e.id}`); close(); load();
      } }, 'Eliminar') : null, h('div.spacer'), h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', 'Guardar'))));
    };

    const manageCategories = () => {
      const list = h('div.form');
      const draw = () => clear(list, cats.map((c) => {
        const icon = h('input', { value: c.icon, style: { width: '3.2rem' } });
        const name = h('input', { value: c.name });
        const color = h('input', { type: 'color', value: c.color });
        const budget = h('input', { inputmode: 'decimal', placeholder: 'Presupuesto/mes', value: c.budget_cents ? String(c.budget_cents / 100).replace('.', ',') : '' });
        const kw = h('input', { value: c.keywords, placeholder: 'palabras clave separadas por comas (comercios)' });
        return h('div.card', { style: { padding: '.6rem' } },
          h('div.row', icon, color, h('div', { style: { flex: 1 } }, name), h('div', { style: { width: '8rem' } }, budget)),
          h('div.row', { style: { marginTop: '.4rem' } }, h('div', { style: { flex: 1 } }, kw),
            h('button.btn.sm', { onclick: async () => {
              await api.patch(`/expenses/categories/${c.id}`, { icon: icon.value, name: name.value, color: color.value, budget: budget.value, keywords: kw.value }).catch(toastError);
              toast('Guardado');
            } }, 'Guardar'),
            h('button.btn.sm.danger', { onclick: async () => {
              if (!(await confirmDialog(`Eliminar "${c.name}"?`))) return;
              await api.del(`/expenses/categories/${c.id}`); cats = await api.get('/expenses/categories'); draw();
            } }, '✕')));
      }));
      draw();
      const nn = h('input', { placeholder: 'Nueva categoría' });
      modal('Categorías y presupuestos', (close) => h('div.form',
        h('p.small.muted', 'Las palabras clave sirven para clasificar automáticamente los gastos que llegan desde Wallet/Siri según el comercio.'),
        list,
        h('div.row', h('div', { style: { flex: 1 } }, nn), h('button.btn.primary.sm', { onclick: async () => {
          if (!nn.value.trim()) return;
          await api.post('/expenses/categories', { name: nn.value }).catch(toastError);
          nn.value = ''; cats = await api.get('/expenses/categories'); draw();
        } }, 'Añadir')),
        h('div.actions', h('button.btn', { onclick: () => { close(); load(); } }, 'Hecho'))));
    };

    const exportCsv = async () => {
      const res = await api('/expenses/export.csv', { raw: true });
      const url = URL.createObjectURL(await res.blob());
      h('a', { href: url, download: 'gastos.csv' }).click();
      URL.revokeObjectURL(url);
    };

    clear(el, head, stats, h('div.grid.split-grid', { style: { marginTop: '1rem' } }, balanceCard, settleCard),
      h('div.grid.two-col', { style: { marginTop: '1rem' } }, breakdown, side), h('div', { style: { height: '1rem' } }), table,
      h('button.fab', { onclick: () => editExpense() }, '+'));
    await load();
  },
};
