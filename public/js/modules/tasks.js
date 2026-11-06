import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog, ymd, parseYmd, addDays, avatar, cap } from '../ui.js';

const FILTER = 'familypro.tasks.filter';
const PRIO = { high: 'Alta', normal: 'Normal', low: 'Baja' };
const REC = { none: 'No se repite', daily: 'Cada día', weekly: 'Cada semana', monthly: 'Cada mes' };
const UNIT = { daily: ['día', 'días'], weekly: ['semana', 'semanas'], monthly: ['mes', 'meses'] };

const recLabel = (t) => {
  if (t.recurrence === 'none') return '';
  const n = t.recurrence_interval || 1;
  return n === 1 ? REC[t.recurrence].toLowerCase() : `cada ${n} ${UNIT[t.recurrence][1]}`;
};

function dueLabel(t, today) {
  if (!t.due_date) return '';
  const tomorrow = ymd(addDays(parseYmd(today), 1)), yesterday = ymd(addDays(parseYmd(today), -1));
  let s;
  if (t.due_date === today) s = 'Hoy';
  else if (t.due_date === tomorrow) s = 'Mañana';
  else if (t.due_date === yesterday) s = 'Ayer';
  else s = cap(parseYmd(t.due_date).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }));
  return t.due_time ? `${s}, ${t.due_time}` : s;
}

const doneLabel = (t) => {
  if (!t.completed_at) return '';
  const d = new Date(t.completed_at.replace(' ', 'T') + 'Z');
  const when = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${t.completed_by_name ? `${t.completed_by_name}, ` : ''}${when}`;
};

export default {
  id: 'tasks', title: 'Tareas', icon: '✅', module: 'tasks',
  async render(el, { state, params }) {
    let filter = localStorage.getItem(FILTER) === 'all' ? 'all' : 'mine';
    let tasks = [];
    const me = state.me;
    const users = state.users;
    const seg = h('div.seg');
    const groupsEl = h('div.task-groups');
    const input = h('input', { placeholder: 'Añadir: mañana sacar la basura, el viernes llamar al fontanero…', autocomplete: 'off', enterkeyhint: 'done' });

    const renderSeg = () => clear(seg, [['mine', 'Mías'], ['all', 'Todas']].map(([v, l]) =>
      h('button', { class: filter === v ? 'on' : '', onclick: () => { filter = v; localStorage.setItem(FILTER, v); renderSeg(); load(); } }, l)));

    const load = async () => {
      try {
        const since = ymd(addDays(new Date(), -7));
        const qs = new URLSearchParams({ status: 'all', doneSince: since, ...(filter === 'mine' ? { mine: '1' } : {}) });
        tasks = await api.get(`/tasks?${qs}`);
        renderGroups();
      } catch (e) { toastError(e); }
    };

    const renderGroups = () => {
      const today = ymd(new Date());
      const pending = tasks.filter((t) => !t.done);
      const groups = [
        ['late', 'Atrasadas', pending.filter((t) => t.due_date && t.due_date < today)],
        ['today', 'Hoy', pending.filter((t) => t.due_date === today)],
        ['next', 'Próximas', pending.filter((t) => t.due_date && t.due_date > today)],
        ['nodate', 'Sin fecha', pending.filter((t) => !t.due_date)],
        ['done', 'Hechas recientes', tasks.filter((t) => t.done).slice(0, 20)],
      ].filter(([, , list]) => list.length);
      if (!pending.length && !groups.length) {
        return clear(groupsEl, h('div.card.empty', filter === 'mine' ? 'No tienes tareas pendientes 🎉' : 'No hay tareas pendientes 🎉'));
      }
      clear(groupsEl,
        !pending.length ? h('div.card.empty', 'Todo hecho 🎉') : null,
        groups.map(([key, label, list]) => h('section.card.task-group', { class: `g-${key}` },
          h('h2', label, h('span.badge', list.length)),
          h('ul.items.tasks', list.map((t) => taskRow(t, today))))));
    };

    const taskRow = (t, today) => {
      const meta = [];
      if (t.done) meta.push(h('span', `✓ ${doneLabel(t)}`));
      else if (t.due_date) meta.push(h('span.due', { class: t.due_date < today ? 'late' : '' }, `📅 ${dueLabel(t, today)}`));
      if (t.recurring) meta.push(h('span', `🔁 ${recLabel(t)}${t.rotation.length > 1 ? ' · rota' : ''}`));
      if (t.notes) meta.push(h('span.notes', t.notes));
      const assignee = users.find((u) => u.id === t.assignee_id);
      return h('li', { class: [t.done ? 'done' : '', `p-${t.priority}`].join(' ') },
        h('input', { type: 'checkbox', checked: t.done, 'aria-label': t.done ? 'Marcar como pendiente' : 'Completar', onchange: (e) => toggle(t, e.target.checked) }),
        h('div.name', { onclick: () => openEditor(t) },
          h('div.task-title', t.priority === 'high' ? h('span.prio', { title: 'Prioridad alta' }, '!') : null, t.title),
          meta.length ? h('div.task-meta', meta) : null),
        t.priority === 'low' && !t.done ? h('span.small.muted', 'baja') : null,
        assignee ? avatar(assignee) : null);
    };

    const toggle = async (t, checked) => {
      try {
        if (!checked) { await api.post(`/tasks/${t.id}/uncomplete`); return load(); }
        const r = await api.post(`/tasks/${t.id}/complete`);
        if (t.recurring) {
          const who = users.find((u) => u.id === r.assignee_id);
          toast(h('span', `Hecho. Próxima: ${dueLabel(r, ymd(new Date())).toLowerCase()}${who ? ` (${who.name})` : ''} `,
            h('button.btn.sm', { onclick: async (e) => { e.target.closest('.toast')?.remove(); await api.post(`/tasks/${t.id}/uncomplete`).catch(toastError); load(); } }, 'Deshacer')));
        }
        load();
      } catch (e) { toastError(e); load(); }
    };

    const add = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      try {
        // En "Mías" la tarea se asigna a ti salvo que digas "… para Luis"
        const body = { text, ...(filter === 'mine' && !/\spara\s+\S+\s*$/i.test(text) ? { assignee: me.id } : {}) };
        const r = await api.post('/quick/task', body);
        toast(r.message);
        input.value = '';
        load();
      } catch (err) { toastError(err); }
    };

    const openEditor = (t = {}) => {
      const isNew = !t.id;
      const title = h('input', { value: t.title || '', placeholder: 'Qué hay que hacer', required: true });
      const notes = h('textarea', { rows: 2, placeholder: 'Notas' }, t.notes || '');
      const date = h('input', { type: 'date', value: t.due_date || '' });
      const time = h('input', { type: 'time', value: t.due_time || '' });
      const prio = h('select', Object.entries(PRIO).map(([v, l]) => h('option', { value: v, selected: (t.priority || 'normal') === v }, l)));
      const defAssignee = isNew ? (filter === 'mine' ? me.id : null) : t.assignee_id;
      const who = h('select', h('option', { value: '' }, 'Sin asignar'),
        users.map((u) => h('option', { value: u.id, selected: u.id === defAssignee }, u.name)));
      const rec = h('select', Object.entries(REC).map(([v, l]) => h('option', { value: v, selected: (t.recurrence || 'none') === v }, l)));
      const interval = h('input', { type: 'number', min: 1, max: 365, value: t.recurrence_interval || 1 });
      const rotation = new Set(t.rotation || []);
      const rotEl = h('div.row', users.map((u) => {
        const cb = h('input', { type: 'checkbox', checked: rotation.has(u.id), onchange: () => (cb.checked ? rotation.add(u.id) : rotation.delete(u.id)) });
        return h('label.check', cb, h('span.dot', { style: { background: u.color } }), u.name);
      }));
      const recExtra = h('div.form',
        field('Cada (intervalo)', interval),
        field('Rotación: al completarla pasa al siguiente', rotEl),
        h('p.small.muted', { style: { margin: 0 } }, 'Al completar una tarea recurrente su fecha salta a la siguiente repetición y, si hay rotación, cambia el responsable.'));
      const sync = () => {
        recExtra.style.display = rec.value === 'none' ? 'none' : '';
        time.disabled = !date.value;
      };
      rec.onchange = sync; date.oninput = sync;

      modal(isNew ? 'Nueva tarea' : 'Editar tarea', (close) => {
        const save = async (e) => {
          e.preventDefault();
          const body = {
            title: title.value, notes: notes.value, dueDate: date.value || null, dueTime: date.value ? time.value || null : null,
            priority: prio.value, assigneeId: who.value ? Number(who.value) : null,
            recurrence: rec.value, recurrenceInterval: Number(interval.value) || 1,
            rotation: rec.value === 'none' ? [] : users.map((u) => u.id).filter((id) => rotation.has(id)),
          };
          try {
            if (isNew) await api.post('/tasks', body); else await api.put(`/tasks/${t.id}`, body);
            toast('Guardado'); close(); load();
          } catch (err) { toastError(err); }
        };
        const del = async () => {
          if (!(await confirmDialog(`Se eliminará "${t.title}".`))) return;
          try { await api.del(`/tasks/${t.id}`); toast('Eliminada'); close(); load(); } catch (err) { toastError(err); }
        };
        const form = h('form.form', { onsubmit: save },
          title,
          h('div.cols', field('Fecha límite', date), field('Hora (opcional)', time)),
          h('div.cols', field('Responsable', who), field('Prioridad', prio)),
          field('Repetición', rec),
          recExtra,
          notes,
          t.recurring && t.completed_at ? h('p.small.muted', { style: { margin: 0 } }, `Última vez: ${doneLabel(t)}`) : null,
          h('div.actions', !isNew ? h('button.btn.danger', { type: 'button', onclick: del }, 'Eliminar') : null,
            h('div.spacer'), h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), h('button.btn.primary', { type: 'submit' }, 'Guardar')));
        sync();
        return form;
      });
    };

    renderSeg();
    clear(el,
      h('div.page-head', h('h1', '✅ Tareas'), h('div.spacer'), seg, h('button.btn.primary', { onclick: () => openEditor() }, '+ Tarea')),
      h('div.card.task-add', h('form.row', { onsubmit: add }, h('div', { style: { flex: 1, minWidth: '12rem' } }, input), h('button.btn.primary', 'Añadir')),
        h('p.small.muted', { style: { margin: '.5rem 0 0' } }, 'Entiende fechas como «hoy», «mañana», «el viernes», «15 de diciembre», «a las 18:00» y «… para Luis».')),
      groupsEl);
    await load();

    const editId = Number(params.get('edit'));
    if (editId) {
      const t = tasks.find((x) => x.id === editId) || await api.get(`/tasks/${editId}`).catch(() => null);
      if (t) openEditor(t);
      history.replaceState(null, '', '#/tasks');
    }
    const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-bg')) load(); }, 30000);
    return () => clearInterval(timer);
  },
};
