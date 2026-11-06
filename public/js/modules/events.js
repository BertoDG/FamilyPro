import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog } from '../ui.js';
import { calendarView } from '../calendar-view.js';
import { handleCalendarItem, newEventAt, openEventEditor, loadCalendars } from '../event-editor.js';

export default {
  id: 'events', title: 'Calendario', icon: '📅', module: 'events',
  async render(el, { params }) {
    const filters = { sources: { events: true }, groups: {} };
    const cals = await loadCalendars(true);
    const cal = calendarView({
      storageKey: 'familypro.events.cal', sources: ['events'], filters,
      availableSources: [{ id: 'events', label: 'Todos', color: '#4f7cff', defaultVisible: true }],
      groups: { events: cals.map((c) => ({ id: c.id, label: c.name, color: c.color })) },
      onDayClick: (d, t) => newEventAt(d, t, () => cal.reload()),
      onItemClick: (it) => handleCalendarItem(it, () => cal.reload()),
    });
    clear(el, h('div.page-head', h('h1', '📅 Calendario'), h('div.spacer'),
      h('button.btn', { onclick: () => manageCalendars(() => this.render(el, { params })) }, '⚙︎ Calendarios'),
      h('button.btn.primary', { onclick: () => newEventAt(new Date().toISOString().slice(0, 10), null, () => cal.reload()) }, '+ Evento')),
    cal.el,
    h('button.fab', { onclick: () => newEventAt(new Date().toISOString().slice(0, 10), null, () => cal.reload()) }, '+'));
    if (params.get('edit')) {
      try { openEventEditor(await api.get(`/events/${params.get('edit')}`), { onSaved: () => cal.reload(), occurrenceDate: params.get('date') }); }
      catch (e) { toastError(e); }
      history.replaceState(null, '', '#/events');
    }
  },
};

async function manageCalendars(onDone) {
  const cals = await loadCalendars(true);
  const list = h('div.form');
  const draw = (items) => clear(list, items.map((c) => {
    const name = h('input', { value: c.name });
    const color = h('input', { type: 'color', value: c.color });
    return h('div.row', color, h('div', { style: { flex: 1 } }, name),
      h('button.btn.sm', { onclick: async () => { await api.patch(`/events/calendars/${c.id}`, { name: name.value, color: color.value }).catch(toastError); toast('Guardado'); } }, 'Guardar'),
      h('button.btn.sm.danger', { onclick: async () => {
        if (!(await confirmDialog(`Eliminar el calendario "${c.name}"? Sus eventos quedarán sin calendario.`))) return;
        await api.del(`/events/calendars/${c.id}`); draw(await loadCalendars(true));
      } }, '✕'));
  }));
  draw(cals);
  const nn = h('input', { placeholder: 'Nuevo calendario' });
  const nc = h('input', { type: 'color', value: '#8b5cf6' });
  modal('Calendarios', (close) => h('div.form', list,
    h('div.row', nc, h('div', { style: { flex: 1 } }, nn), h('button.btn.primary.sm', { onclick: async () => {
      if (!nn.value.trim()) return;
      await api.post('/events/calendars', { name: nn.value, color: nc.value }).catch(toastError);
      nn.value = ''; draw(await loadCalendars(true));
    } }, 'Añadir')),
    h('div.actions', h('button.btn', { onclick: () => { close(); onDone(); } }, 'Hecho'))));
  void field;
}
