import { api } from '../api.js';
import { h, clear, toastError } from '../ui.js';
import { calendarView } from '../calendar-view.js';
import { handleCalendarItem, newEventAt, loadCalendars } from '../event-editor.js';

export default {
  id: 'home', title: 'Inicio', icon: '🏠',
  async render(el, { state }) {
    const cards = h('div.grid.cards');
    const filters = state.me.settings.calendarFilters || { sources: {}, groups: {} };
    const available = state.modules.filter((m) => m.calendar).map((m) => ({ id: m.id, ...m.calendar }));
    let saveTimer;
    const cal = calendarView({
      storageKey: 'familypro.home.cal',
      availableSources: available,
      groups: { events: (await loadCalendars()).map((c) => ({ id: c.id, label: c.name, color: c.color })) },
      filters,
      onFiltersChange: (f) => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => api.patch('/me', { settings: { calendarFilters: f } }).then((u) => (state.me = u)).catch(toastError), 400);
      },
      onDayClick: (date, time) => newEventAt(date, time, () => cal.reload()),
      onItemClick: (it) => handleCalendarItem(it, () => cal.reload()),
    });
    clear(el,
      h('div.page-head', h('h1', `Hola, ${state.me.name} 👋`), h('div.spacer'),
        h('button.btn.primary', { onclick: () => newEventAt(new Date().toISOString().slice(0, 10), null, () => cal.reload()) }, '+ Evento')),
      cards,
      h('h2', { style: { marginTop: '1.5rem' } }, 'Calendario familiar'),
      h('p.small.muted', { style: { marginTop: '-.5rem' } }, 'Elige qué fuentes ver con los filtros. Se guarda en tu perfil.'),
      cal.el,
      h('button.fab', { onclick: () => newEventAt(new Date().toISOString().slice(0, 10), null, () => cal.reload()), 'aria-label': 'Nuevo evento' }, '+'));
    api.get('/dashboard').then((items) => clear(cards, items.map((s) =>
      h('a.card.stat', { href: s.href }, h('div.t', `${s.icon} ${s.title}`), h('div.v', s.value), h('div.t', s.subtitle))))).catch(toastError);
  },
};
