import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog } from '../ui.js';

const LAST = 'familypro.shopping.list';

export default {
  id: 'shopping', title: 'Compra', icon: '🛒', module: 'shopping',
  async render(el) {
    let lists = [], current = Number(localStorage.getItem(LAST)) || null, items = [];
    const tabs = h('div.tabs');
    const listEl = h('ul.items');
    const doneEl = h('ul.items');
    const datalist = h('datalist#shopping-suggestions');
    const input = h('input', { placeholder: 'Añadir: leche, 2 huevos y pan…', list: 'shopping-suggestions', autocomplete: 'off' });
    const doneHead = h('div.row', { style: { marginTop: '1.25rem' } });

    const loadLists = async () => {
      lists = await api.get('/shopping/lists');
      if (!lists.some((l) => l.id === current)) current = lists[0]?.id;
      clear(tabs, lists.map((l) => h('span.chip', { class: l.id === current ? 'on' : '', onclick: () => { current = l.id; localStorage.setItem(LAST, l.id); refresh(); } },
        `${l.icon} ${l.name}`, l.pending ? h('span.badge', l.pending) : null)),
      h('span.chip', { onclick: newList }, '＋ Lista'));
    };
    const loadItems = async () => {
      items = await api.get(`/shopping/lists/${current}/items`);
      const pending = items.filter((i) => !i.checked), done = items.filter((i) => i.checked);
      clear(listEl, pending.length ? pending.map(itemRow) : h('li.empty', { style: { justifyContent: 'center' } }, 'La lista está vacía ✨'));
      clear(doneHead, done.length ? [h('h2', { style: { margin: 0 } }, `En el carro (${done.length})`), h('div.spacer'),
        h('button.btn.sm', { onclick: async () => { await api.post(`/shopping/lists/${current}/clear-checked`); refresh(); } }, 'Vaciar comprados')] : []);
      clear(doneEl, done.map(itemRow));
    };
    const refresh = () => loadLists().then(loadItems).catch(toastError);

    const itemRow = (i) => h('li', { class: i.checked ? 'done' : '' },
      h('input', { type: 'checkbox', checked: i.checked, onchange: async (e) => { await api.patch(`/shopping/items/${i.id}`, { checked: e.target.checked }).catch(toastError); refresh(); } }),
      h('span.name', { onclick: () => editItem(i) }, i.name, i.notes ? h('div.small.muted', i.notes) : null),
      i.quantity ? h('span.qty', i.quantity) : null,
      i.added_by_name ? h('span.small.muted', i.added_by_name) : null,
      h('button.btn.ghost.sm', { onclick: async () => { await api.del(`/shopping/items/${i.id}`); refresh(); }, 'aria-label': 'Eliminar' }, '✕'));

    const editItem = (i) => {
      const name = h('input', { value: i.name }), qty = h('input', { value: i.quantity }), notes = h('input', { value: i.notes });
      const listSel = h('select', lists.map((l) => h('option', { value: l.id, selected: l.id === i.list_id }, l.name)));
      modal('Editar producto', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        await api.patch(`/shopping/items/${i.id}`, { name: name.value, quantity: qty.value, notes: notes.value, listId: Number(listSel.value) }).catch(toastError);
        close(); refresh();
      } }, field('Producto', name), h('div.cols', field('Cantidad', qty), field('Lista', listSel)), field('Notas', notes),
      h('div.actions', h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', 'Guardar'))));
    };

    const newList = () => {
      const name = h('input', { placeholder: 'Farmacia, Bricolaje…' }), icon = h('input', { value: '🛒', style: { width: '4rem' } });
      modal('Nueva lista', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        try { const l = await api.post('/shopping/lists', { name: name.value, icon: icon.value }); current = l.id; close(); refresh(); } catch (err) { toastError(err); }
      } }, h('div.row', icon, h('div', { style: { flex: 1 } }, name)), h('div.actions', h('button.btn.primary', 'Crear'))));
    };

    const add = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        const r = await api.post(`/shopping/lists/${current}/items`, { text: input.value });
        if (r.skipped.length) toast(`Ya estaba: ${r.skipped.join(', ')}`);
        input.value = '';
        refresh();
      } catch (err) { toastError(err); }
    };

    const listActions = () => {
      const l = lists.find((x) => x.id === current);
      if (!l) return;
      const name = h('input', { value: l.name }), icon = h('input', { value: l.icon, style: { width: '4rem' } });
      modal('Lista', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault(); await api.patch(`/shopping/lists/${l.id}`, { name: name.value, icon: icon.value }).catch(toastError); close(); refresh();
      } }, h('div.row', icon, h('div', { style: { flex: 1 } }, name)),
      h('div.actions', h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!(await confirmDialog(`Eliminar la lista "${l.name}" y sus productos?`))) return;
        try { await api.del(`/shopping/lists/${l.id}`); close(); refresh(); } catch (err) { toastError(err); }
      } }, 'Eliminar lista'), h('div.spacer'), h('button.btn.primary', 'Guardar'))));
    };

    clear(el,
      h('div.page-head', h('h1', '🛒 Lista de la compra'), h('div.spacer'), h('button.btn', { onclick: listActions }, '⚙︎ Lista')),
      tabs,
      h('div.card', h('form.row', { onsubmit: add }, h('div', { style: { flex: 1 } }, input), h('button.btn.primary', 'Añadir')), datalist,
        listEl, doneHead, doneEl));
    await refresh();
    api.get('/shopping/suggestions').then((s) => clear(datalist, s.map((x) => h('option', { value: x })))).catch(() => {});
    input.focus();
    const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-bg')) refresh(); }, 15000);
    return () => clearInterval(timer);
  },
};
