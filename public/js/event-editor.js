import { api } from './api.js';
import { h, modal, field, toast, toastError, confirmDialog, addDays, parseYmd, ymd } from './ui.js';
import { state } from './app.js';

let calendarsCache = null;
export const loadCalendars = async (force) => (calendarsCache && !force ? calendarsCache : (calendarsCache = await api.get('/events/calendars')));

/** Abre el editor de eventos. ev = evento existente (de /api/events/:id) o datos iniciales {start, allDay}. occurrenceDate: fecha de la ocurrencia pulsada. */
export async function openEventEditor(ev = {}, { onSaved, occurrenceDate } = {}) {
  const cals = await loadCalendars();
  const isNew = !ev.id;
  const allDay = h('input', { type: 'checkbox', checked: !!ev.all_day });
  const title = h('input', { value: ev.title || '', placeholder: 'Título', required: true });
  const sDate = h('input', { type: 'date', value: (ev.start || ymd(new Date())).slice(0, 10) });
  const sTime = h('input', { type: 'time', value: ev.start?.slice(11, 16) || '10:00' });
  const eDate = h('input', { type: 'date', value: (ev.end || ev.start || ymd(new Date())).slice(0, 10) });
  const eTime = h('input', { type: 'time', value: ev.end?.slice(11, 16) || (ev.start?.length > 10 ? addHour(ev.start.slice(11, 16)) : '11:00') });
  const cal = h('select', cals.map((c) => h('option', { value: c.id, selected: c.id === ev.calendar_id }, c.name)));
  const rec = h('select', [['none', 'No se repite'], ['daily', 'Cada día'], ['weekly', 'Cada semana'], ['monthly', 'Cada mes'], ['yearly', 'Cada año']]
    .map(([v, l]) => h('option', { value: v, selected: (ev.recurrence || 'none') === v }, l)));
  const interval = h('input', { type: 'number', min: 1, value: ev.recurrence_interval || 1, style: { width: '5rem' } });
  const until = h('input', { type: 'date', value: ev.recurrence_until || '' });
  const location_ = h('input', { value: ev.location || '', placeholder: 'Lugar' });
  const desc = h('textarea', { rows: 3, placeholder: 'Notas' }, ev.description || '');
  const assignees = new Set(ev.assignees || (isNew ? [state.me.id] : []));
  const people = h('div.row', state.users.map((u) => {
    const cb = h('input', { type: 'checkbox', checked: assignees.has(u.id), onchange: () => (cb.checked ? assignees.add(u.id) : assignees.delete(u.id)) });
    return h('label.check', cb, h('span.dot', { style: { background: u.color } }), u.name);
  }));
  const timeRow = [sTime, eTime];
  const recExtra = h('div.cols', field('Cada (intervalo)', interval), field('Hasta (opcional)', until));
  const sync = () => {
    timeRow.forEach((x) => (x.style.display = allDay.checked ? 'none' : ''));
    recExtra.style.display = rec.value === 'none' ? 'none' : '';
  };
  allDay.onchange = sync; rec.onchange = sync;
  sDate.onchange = () => { if (eDate.value < sDate.value) eDate.value = sDate.value; };

  modal(isNew ? 'Nuevo evento' : 'Editar evento', (close) => {
    const save = async (e) => {
      e.preventDefault();
      const body = {
        title: title.value, allDay: allDay.checked,
        start: allDay.checked ? sDate.value : `${sDate.value}T${sTime.value}`,
        end: allDay.checked ? eDate.value : `${eDate.value}T${eTime.value}`,
        calendarId: Number(cal.value), recurrence: rec.value, recurrenceInterval: Number(interval.value), recurrenceUntil: until.value || null,
        location: location_.value, description: desc.value, assignees: [...assignees], exdates: ev.exdates || [],
      };
      try {
        if (isNew) await api.post('/events', body); else await api.put(`/events/${ev.id}`, body);
        toast('Guardado'); close(); onSaved?.();
      } catch (err) { toastError(err); }
    };
    const del = async () => {
      if (ev.recurrence !== 'none' && occurrenceDate) {
        const choice = await new Promise((res) => modal('Evento recurrente', (c) => h('div',
          h('p', '¿Qué quieres eliminar?'),
          h('div.actions', h('button.btn', { onclick: () => { c(); res('one'); } }, 'Solo este'),
            h('button.btn.danger', { onclick: () => { c(); res('all'); } }, 'Toda la serie'),
            h('button.btn.ghost', { onclick: () => { c(); res(null); } }, 'Cancelar')))));
        if (!choice) return;
        if (choice === 'one') await api.post(`/events/${ev.id}/exclude`, { date: occurrenceDate });
        else await api.del(`/events/${ev.id}`);
      } else {
        if (!(await confirmDialog(`Se eliminará "${ev.title}".`))) return;
        await api.del(`/events/${ev.id}`);
      }
      toast('Eliminado'); close(); onSaved?.();
    };
    const form = h('form.form', { onsubmit: save },
      title,
      h('label.check', allDay, 'Todo el día'),
      h('div.cols', field('Empieza', h('div.row', sDate, sTime)), field('Termina', h('div.row', eDate, eTime))),
      h('div.cols', field('Calendario', cal), field('Repetición', rec)),
      recExtra,
      location_,
      field('Participantes', people),
      desc,
      h('div.actions', !isNew ? h('button.btn.danger', { type: 'button', onclick: () => del().catch(toastError) }, 'Eliminar') : null,
        h('div.spacer'), h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', { type: 'submit' }, 'Guardar')));
    sync();
    return form;
  });
}

const addHour = (t) => { const [hh, mm] = t.split(':').map(Number); return `${String(Math.min(23, hh + 1)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

/** Gestiona un clic sobre un elemento del calendario: abre el editor si es un evento o navega a su módulo. */
export async function handleCalendarItem(it, onSaved) {
  if (it.source === 'events' && it.eventId) {
    try {
      const ev = await api.get(`/events/${it.eventId}`);
      openEventEditor(ev, { onSaved, occurrenceDate: it.start.slice(0, 10) });
    } catch (e) { toastError(e); }
  } else if (it.href) location.hash = it.href;
}

export const newEventAt = (date, time, onSaved) =>
  openEventEditor(time ? { start: `${date}T${time}`, end: `${date}T${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00` } : { start: date, end: date, all_day: false }, { onSaved });

export { parseYmd };
