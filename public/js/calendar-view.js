// Componente de calendario reutilizable (mes / semana / agenda) que consume /api/calendar.
import { api } from './api.js';
import { h, clear, ymd, parseYmd, addDays, pad, avatar, toastError, cap } from './ui.js';

const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7));

/**
 * opts: { sources: string[]|null, filters: {sources:{id:bool}, groups:{key:bool}}, onFiltersChange, onDayClick(date, time), onItemClick(item), view, storageKey }
 */
export function calendarView(opts) {
  const store = opts.storageKey ? JSON.parse(localStorage.getItem(opts.storageKey) || '{}') : {};
  const st = { view: store.view || (matchMedia('(max-width: 760px)').matches ? 'agenda' : 'month'), cursor: new Date(), items: [] };
  const el = h('div.calendar');
  const toolbar = h('div.cal-toolbar');
  const filtersEl = h('div.cal-filters');
  const body = h('div');
  el.append(toolbar, filtersEl, body);

  const range = () => {
    if (st.view === 'month') {
      const first = new Date(st.cursor.getFullYear(), st.cursor.getMonth(), 1);
      const s = startOfWeek(first);
      return [s, addDays(s, 41)];
    }
    if (st.view === 'week') { const s = startOfWeek(st.cursor); return [s, addDays(s, 6)]; }
    const s = new Date(st.cursor.getFullYear(), st.cursor.getMonth(), st.cursor.getDate());
    return [s, addDays(s, 30)];
  };

  const title = () => {
    if (st.view === 'month') { const t = st.cursor.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); }
    const [s, e] = range();
    const f = (d) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    return `${f(s)} – ${f(e)}`;
  };

  const move = (dir) => {
    const c = st.cursor;
    if (st.view === 'month') st.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
    else st.cursor = addDays(c, dir * (st.view === 'week' ? 7 : 30));
    load();
  };

  const setView = (v) => { st.view = v; if (opts.storageKey) localStorage.setItem(opts.storageKey, JSON.stringify({ view: v })); load(); };

  function renderToolbar() {
    clear(toolbar,
      h('button.btn', { onclick: () => { st.cursor = new Date(); load(); } }, 'Hoy'),
      h('button.btn.ghost', { onclick: () => move(-1), 'aria-label': 'Anterior' }, '‹'),
      h('button.btn.ghost', { onclick: () => move(1), 'aria-label': 'Siguiente' }, '›'),
      h('div.cal-title', title()),
      h('div.spacer'),
      h('div.seg', ['month', 'week', 'agenda'].map((v) =>
        h('button', { class: st.view === v ? 'on' : '', onclick: () => setView(v) }, { month: 'Mes', week: 'Semana', agenda: 'Agenda' }[v]))));
  }

  const isVisible = (it) => {
    const f = opts.filters || {};
    if (f.sources && f.sources[it.source] === false) return false;
    if (it.group && f.groups && f.groups[`${it.source}:${it.group.id}`] === false) return false;
    return true;
  };

  function renderFilters() {
    if (!opts.filters) return clear(filtersEl);
    const f = opts.filters;
    const chips = [];
    for (const s of opts.availableSources || []) {
      const on = f.sources?.[s.id] ?? s.defaultVisible;
      chips.push(h('span.chip', { class: on ? '' : 'off', onclick: () => { f.sources = { ...f.sources, [s.id]: !on }; opts.onFiltersChange?.(f); load(); } },
        h('span.dot', { style: { background: s.color } }), s.label));
      if (on) {
        const groups = new Map();
        st.items.filter((i) => i.source === s.id && i.group).forEach((i) => groups.set(i.group.id, i.group));
        for (const g of opts.groups?.[s.id] || []) groups.set(g.id, g);
        for (const g of groups.values()) {
          const key = `${s.id}:${g.id}`;
          const gon = f.groups?.[key] !== false;
          chips.push(h('span.chip', { class: gon ? '' : 'off', onclick: () => { f.groups = { ...f.groups, [key]: !gon }; opts.onFiltersChange?.(f); render(); } },
            h('span.dot', { style: { background: g.color } }), g.label));
        }
      }
    }
    clear(filtersEl, chips);
  }

  const evChip = (it, extra = {}) => h('span.ev', {
    class: it.allDay ? 'allday' : '', style: { '--c': it.color, ...(extra.style || {}) }, title: it.title,
    onclick: (e) => { e.stopPropagation(); opts.onItemClick?.(it); },
  }, it.allDay ? it.title : `${it.start.slice(11, 16)} ${it.title}`);

  const itemsOn = (date) => st.items.filter((i) => isVisible(i) && i.start.slice(0, 10) <= date && (i.end || i.start).slice(0, 10) >= date);

  function renderMonth() {
    const [s] = range();
    const todayStr = ymd(new Date());
    const cells = [...DOW.map((d) => h('div.dow', d))];
    for (let i = 0; i < 42; i++) {
      const d = addDays(s, i);
      const ds = ymd(d);
      const its = itemsOn(ds);
      const max = 3;
      cells.push(h('div.day', {
        class: `${d.getMonth() !== st.cursor.getMonth() ? 'other' : ''} ${ds === todayStr ? 'today' : ''}`,
        onclick: () => opts.onDayClick?.(ds),
      }, h('span.n', d.getDate()), its.slice(0, max).map((it) => evChip(it)), its.length > max ? h('div.more', `+${its.length - max} más`) : null));
    }
    clear(body, h('div.month', cells));
  }

  function renderWeek() {
    const [s] = range();
    const days = [...Array(7)].map((_, i) => addDays(s, i));
    const todayStr = ymd(new Date());
    const HOUR = 48; // px por hora (3rem)
    const grid = h('div.week');
    grid.append(h('div.wh', ''), ...days.map((d) => h('div.wh', { class: ymd(d) === todayStr ? 'today' : '', onclick: () => opts.onDayClick?.(ymd(d)) },
      `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()}`)));
    grid.append(h('div.wad', h('div.small.muted', { style: { fontSize: '.65rem', padding: '.3rem 0' } }, 'todo el día'),
      days.map((d) => h('div', itemsOn(ymd(d)).filter((i) => i.allDay).map((it) => evChip(it))))));
    grid.append(h('div.hours', [...Array(24)].map((_, i) => h('div.hour', i ? `${pad(i)}:00` : ''))));
    for (const d of days) {
      const ds = ymd(d);
      const col = h('div.col', { onclick: (e) => {
        const y = e.offsetY; const hr = Math.min(23, Math.floor(y / HOUR));
        opts.onDayClick?.(ds, `${pad(hr)}:00`);
      } });
      const timed = itemsOn(ds).filter((i) => !i.allDay);
      timed.forEach((it, idx) => {
        const st0 = it.start.slice(0, 10) < ds ? 0 : Number(it.start.slice(11, 13)) * 60 + Number(it.start.slice(14, 16));
        const en = (it.end || it.start).slice(0, 10) > ds ? 1440 : Number(it.end.slice(11, 13)) * 60 + Number(it.end.slice(14, 16));
        const overl = timed.filter((o, j) => j < idx && o.start < it.end && o.end > it.start).length;
        col.append(evChip(it, { style: { top: `${(st0 / 60) * HOUR}px`, height: `${Math.max(20, ((en - st0) / 60) * HOUR - 2)}px`, left: `${2 + overl * 12}px` } }));
      });
      if (ds === todayStr) { const n = new Date(); col.append(h('div.now', { style: { top: `${((n.getHours() * 60 + n.getMinutes()) / 60) * HOUR}px` } })); }
      grid.append(col);
    }
    clear(body, grid);
    grid.scrollTop = 7.5 * HOUR;
  }

  function renderAgenda() {
    const [s, e] = range();
    const blocks = [];
    for (let d = s; d <= e; d = addDays(d, 1)) {
      const ds = ymd(d);
      const its = itemsOn(ds);
      if (!its.length) continue;
      blocks.push(h('div.dayblock', h('h3', cap(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))),
        its.map((it) => h('div.item', { style: { '--c': it.color }, onclick: () => opts.onItemClick?.(it) },
          h('div.time', it.allDay ? 'Todo el día' : `${it.start.slice(11, 16)}–${(it.end || '').slice(11, 16)}`),
          h('div', { style: { flex: 1 } }, h('div', it.title, it.recurring ? ' 🔁' : ''),
            h('div.small.muted', [it.sourceLabel, it.group?.label, it.location].filter(Boolean).join(' · '))),
          it.assignees?.length ? h('div.avatars', it.assignees.map(avatar)) : null))));
    }
    clear(body, h('div.agenda', blocks.length ? blocks : h('div.empty', 'Nada en los próximos 30 días 🎉')));
  }

  function render() {
    renderToolbar();
    renderFilters();
    ({ month: renderMonth, week: renderWeek, agenda: renderAgenda })[st.view]();
  }

  async function load() {
    const [s, e] = range();
    const params = new URLSearchParams({ from: ymd(s), to: ymd(e) });
    const f = opts.filters;
    let sources = opts.sources;
    if (!sources && f) sources = (opts.availableSources || []).filter((x) => (f.sources?.[x.id] ?? x.defaultVisible)).map((x) => x.id);
    if (sources) params.set('sources', sources.join(',') || '_none');
    try { st.items = await api.get(`/calendar?${params}`); } catch (err) { toastError(err); st.items = []; }
    render();
  }

  load();
  return { el, reload: load, goTo: (date) => { st.cursor = parseYmd(date); load(); } };
}
