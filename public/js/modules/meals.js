import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog, ymd, parseYmd, addDays, cap, fmtLongDate, avatar } from '../ui.js';

const MEALS = [
  { id: 'desayuno', label: 'Desayuno', icon: '☕', extra: true },
  { id: 'comida', label: 'Comida', icon: '🥘' },
  { id: 'merienda', label: 'Merienda', icon: '🍪', extra: true },
  { id: 'cena', label: 'Cena', icon: '🌙' },
];
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const PREFS = 'familypro.meals';
const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ingLine = (i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name);

export default {
  id: 'meals', title: 'Menú', icon: '🍽️', module: 'meals',
  async render(el, { params, state }) {
    const prefs = JSON.parse(localStorage.getItem(PREFS) || '{}');
    let tab = params.get('tab') === 'recipes' ? 'recipes' : 'week';
    let week = startOfWeek(params.get('date') ? parseYmd(params.get('date')) : new Date());
    let showAll = !!prefs.showAll;
    let recipes = [], plan = [], q = '';
    const savePrefs = () => localStorage.setItem(PREFS, JSON.stringify({ showAll }));

    const seg = h('div.seg');
    const body = h('div');

    const loadRecipes = async () => { recipes = await api.get('/meals/recipes'); };
    const loadPlan = async () => { plan = await api.get(`/meals/plan?from=${ymd(week)}&to=${ymd(addDays(week, 6))}`); };
    const refresh = async () => {
      try {
        await Promise.all([loadRecipes(), tab === 'week' ? loadPlan() : null]);
        render();
      } catch (e) { toastError(e); }
    };

    const render = () => {
      clear(seg, [['week', '📅 Semana'], ['recipes', '📖 Recetas']].map(([id, label]) =>
        h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; refresh(); } }, label)));
      tab === 'week' ? renderWeek() : renderRecipes();
    };

    // ---------- Vista semanal ----------
    const slotOf = (date, meal) => plan.find((p) => p.date === date && p.meal === meal);

    const slotContent = (p) => [
      h('div.meal-title', p.title),
      p.notes ? h('div.small.muted.meal-notes', p.notes) : null,
      p.cook_name ? h('div.meal-cook', avatar({ name: p.cook_name, color: p.cook_color }), h('span.small.muted', p.cook_name)) : null,
    ];

    const renderWeek = () => {
      const days = [...Array(7)].map((_, i) => addDays(week, i));
      const todayStr = ymd(new Date());
      const meals = MEALS.filter((m) => showAll || !m.extra);
      const f = (d) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

      const toolbar = h('div.cal-toolbar',
        h('button.btn', { onclick: () => { week = startOfWeek(new Date()); refresh(); } }, 'Hoy'),
        h('button.btn.ghost', { onclick: () => { week = addDays(week, -7); refresh(); }, 'aria-label': 'Semana anterior' }, '‹'),
        h('button.btn.ghost', { onclick: () => { week = addDays(week, 7); refresh(); }, 'aria-label': 'Semana siguiente' }, '›'),
        h('div.cal-title', `${f(days[0])} – ${f(days[6])}`),
        h('div.spacer'),
        h('span.chip', { class: showAll ? 'on-soft' : '', onclick: () => { showAll = !showAll; savePrefs(); render(); } }, '☕ Desayuno y merienda'));

      const actions = h('div.row.meals-actions',
        h('button.btn', { onclick: copyPrevious }, '⧉ Copiar semana anterior'),
        h('button.btn.primary', { onclick: exportShopping }, '🛒 Añadir ingredientes de la semana a la compra'));

      const cell = (ds, m) => {
        const p = slotOf(ds, m.id);
        return h('button.meal-slot', { type: 'button', class: p ? 'filled' : '', onclick: () => editSlot(ds, m, p), 'aria-label': `${m.label} ${fmtLongDate(ds)}` },
          p ? slotContent(p) : h('span.meal-add', '+'));
      };

      // Escritorio: columnas = días, filas = comidas
      const grid = h('div.meals-week', { style: { '--rows': meals.length } },
        h('div.mw-corner'),
        days.map((d) => h('div.mw-day', { class: ymd(d) === todayStr ? 'today' : '' }, h('span', DOW[(d.getDay() + 6) % 7]), h('strong', d.getDate()))),
        meals.map((m) => [
          h('div.mw-meal', h('span', m.icon), m.label),
          days.map((d) => h('div.mw-cell', { class: ymd(d) === todayStr ? 'today' : '' }, cell(ymd(d), m))),
        ]));

      // Móvil: lista por días
      const list = h('div.meals-days', days.map((d) => {
        const ds = ymd(d);
        return h('div.meals-dayblock', { class: ds === todayStr ? 'today' : '' },
          h('h3', cap(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' })), ds === todayStr ? h('span.badge', 'hoy') : null),
          meals.map((m) => h('div.meals-line', h('span.meals-line-label', `${m.icon} ${m.label}`), cell(ds, m))));
      }));

      const count = plan.length;
      clear(body, toolbar, actions, grid, list,
        h('p.small.muted', { style: { marginTop: '.75rem' } },
          count ? `${count} ${count === 1 ? 'comida planificada' : 'comidas planificadas'} esta semana.` : 'Aún no hay nada planificado esta semana. Toca un hueco para empezar.'));
    };

    const editSlot = (date, m, cur) => {
      let recipeId = cur?.recipe_id ?? null;
      const search = h('input', { type: 'search', placeholder: 'Buscar receta…', autocomplete: 'off' });
      const results = h('div.recipe-pick');
      const text = h('input', { placeholder: 'Ej.: Sobras, pizza, cena fuera…', value: cur && !cur.recipe_id ? cur.text : '' });
      const notes = h('input', { placeholder: 'Opcional', value: cur?.notes || '' });
      const cook = h('select', h('option', { value: '' }, '—'),
        state.users.map((u) => h('option', { value: u.id, selected: cur?.cook_id === u.id }, u.name)));

      const drawResults = () => {
        const nq = norm(search.value);
        const list = recipes.filter((r) => !nq || norm(`${r.name} ${r.tags.join(' ')}`).includes(nq));
        clear(results, recipes.length
          ? (list.length ? list.slice(0, 30).map((r) => h('button.chip', {
            type: 'button', class: r.id === recipeId ? 'on' : '',
            onclick: () => { recipeId = r.id === recipeId ? null : r.id; if (recipeId) text.value = ''; drawResults(); },
          }, r.name)) : h('span.small.muted', 'Ninguna receta coincide.'))
          : h('span.small.muted', 'Todavía no hay recetas. Escribe el plato abajo o créalas en la pestaña Recetas.'));
      };
      search.addEventListener('input', drawResults);
      text.addEventListener('input', () => { if (text.value.trim() && recipeId) { recipeId = null; drawResults(); } });
      drawResults();

      modal(`${m.icon} ${m.label} · ${fmtLongDate(date)}`, (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        if (!recipeId && !text.value.trim()) return toast('Elige una receta o escribe qué hay', 'err');
        try {
          await api.put(`/meals/plan/${date}/${m.id}`, { recipeId, text: recipeId ? '' : text.value, notes: notes.value, cookId: cook.value ? Number(cook.value) : null });
          close(); refresh();
        } catch (err) { toastError(err); }
      } },
      field('Receta', search), results,
      field('… o texto libre', text),
      h('div.cols', field('Quién cocina', cook), field('Notas', notes)),
      h('div.actions',
        cur ? h('button.btn.danger', { type: 'button', onclick: async () => {
          try { await api.del(`/meals/plan/${date}/${m.id}`); close(); refresh(); } catch (err) { toastError(err); }
        } }, 'Quitar') : null,
        h('div.spacer'),
        h('button.btn', { type: 'button', onclick: close }, 'Cancelar'),
        h('button.btn.primary', 'Guardar'))));
      search.focus();
    };

    const copyPrevious = async () => {
      if (plan.length && !(await confirmDialog('Se rellenarán solo los huecos vacíos de esta semana con lo de la semana anterior.', 'Copiar'))) return;
      try {
        const r = await api.post('/meals/plan/copy', { from: ymd(addDays(week, -7)), to: ymd(week) });
        toast(r.copied ? `Copiadas ${r.copied} comidas${r.skipped ? ` (${r.skipped} huecos ya estaban ocupados)` : ''}` : (r.skipped ? 'Los huecos ya estaban ocupados' : 'La semana anterior está vacía'));
        refresh();
      } catch (e) { toastError(e); }
    };

    const exportShopping = async () => {
      const run = async (listId) => {
        try {
          const r = await api.post('/meals/plan/shopping', { from: ymd(week), to: ymd(addDays(week, 6)), ...(listId ? { listId } : {}) });
          toast(r.message, r.added.length || r.skipped.length ? '' : 'err');
        } catch (e) { toastError(e); }
      };
      let lists = [];
      try { lists = await api.get('/shopping/lists'); } catch { /* el módulo de compra podría no estar activo */ }
      if (lists.length <= 1) return run(lists[0]?.id);
      const sel = h('select', lists.map((l) => h('option', { value: l.id }, `${l.icon} ${l.name}`)));
      modal('Añadir a la compra', (close) => h('form.form', { onsubmit: (e) => { e.preventDefault(); close(); run(Number(sel.value)); } },
        h('p.small.muted', { style: { margin: 0 } }, 'Se añadirán los ingredientes de las recetas planificadas esta semana. Lo que ya esté pendiente en la lista no se duplica.'),
        field('Lista', sel), h('div.actions', h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', 'Añadir'))));
    };

    // ---------- Recetas ----------
    const renderRecipes = () => {
      const listEl = h('ul.items.recipes');
      const draw = () => {
        const nq = norm(q);
        const list = recipes.filter((r) => !nq || norm(`${r.name} ${r.tags.join(' ')} ${r.ingredients.map((i) => i.name).join(' ')}`).includes(nq));
        clear(listEl, list.length ? list.map((r) => h('li', { onclick: () => editRecipe(r) },
          h('span.name', h('strong', r.name),
            h('div.small.muted', [`${r.ingredients.length} ${r.ingredients.length === 1 ? 'ingrediente' : 'ingredientes'}`, r.servings ? `${r.servings} raciones` : null].filter(Boolean).join(' · ')),
            r.tags.length ? h('div.recipe-tags', r.tags.map((t) => h('span.chip', t))) : null),
          r.url ? h('a.btn.ghost.sm', { href: r.url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), 'aria-label': 'Abrir enlace' }, '🔗') : null,
          h('span.muted', '›')))
          : h('li.empty', { style: { justifyContent: 'center' } }, recipes.length ? 'Ninguna receta coincide.' : 'Aún no hay recetas. Crea la primera ✨'));
      };
      const search = h('input', { type: 'search', placeholder: 'Buscar por nombre, etiqueta o ingrediente…', value: q, oninput: (e) => { q = e.target.value; draw(); } });
      draw();
      clear(body, h('div.card',
        h('div.row', { style: { marginBottom: '.5rem' } }, h('div', { style: { flex: 1, minWidth: '12rem' } }, search),
          h('button.btn.primary', { onclick: () => editRecipe() }, '+ Receta')),
        listEl));
    };

    const editRecipe = (r = {}) => {
      const name = h('input', { value: r.name || '', placeholder: 'Lasaña de verduras' });
      const servings = h('input', { type: 'number', min: 1, value: r.servings ?? '', placeholder: '4' });
      const url = h('input', { inputmode: 'url', autocapitalize: 'off', value: r.url || '', placeholder: 'https://…' });
      const tags = h('input', { value: (r.tags || []).join(', '), placeholder: 'pasta, horno, rápida' });
      const ingredients = h('textarea', { rows: 7, placeholder: '2 cebollas\n500 g de carne picada\nplacas de lasaña' });
      ingredients.value = (r.ingredients || []).map(ingLine).join('\n');
      const notes = h('textarea', { rows: 5, placeholder: 'Pasos, trucos…' });
      notes.value = r.notes || '';
      modal(r.id ? 'Editar receta' : 'Nueva receta', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        const payload = { name: name.value, servings: servings.value ? Number(servings.value) : null, url: url.value, tags: tags.value, notes: notes.value,
          ingredients: ingredients.value.split('\n').map((x) => x.trim()).filter(Boolean) };
        try {
          await (r.id ? api.put(`/meals/recipes/${r.id}`, payload) : api.post('/meals/recipes', payload));
          close(); refresh();
        } catch (err) { toastError(err); }
      } },
      field('Nombre', name),
      h('div.cols', field('Raciones', servings), field('Etiquetas (separadas por comas)', tags)),
      field('Enlace', url),
      field('Ingredientes (uno por línea, con cantidad delante)', ingredients),
      field('Preparación / notas', notes),
      h('div.actions',
        r.id ? h('button.btn.danger', { type: 'button', onclick: async () => {
          if (!(await confirmDialog(`¿Eliminar la receta "${r.name}"? Lo ya planificado se conserva como texto.`))) return;
          try { await api.del(`/meals/recipes/${r.id}`); close(); refresh(); } catch (err) { toastError(err); }
        } }, 'Eliminar') : null,
        h('div.spacer'),
        h('button.btn', { type: 'button', onclick: close }, 'Cancelar'),
        h('button.btn.primary', r.id ? 'Guardar' : 'Crear'))));
    };

    clear(el, h('div.page-head', h('h1', '🍽️ Menú semanal'), h('div.spacer'), seg), body);
    await refresh();
  },
};
