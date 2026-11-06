import { api } from '../api.js';
import { h, clear, modal, field, toast, toastError, confirmDialog, copy } from '../ui.js';
import { logout } from '../app.js';

const showToken = (token, title = 'Token creado') => modal(title, (close) => h('div.form',
  h('p', 'Cópialo ahora: por seguridad no se volverá a mostrar.'),
  h('pre.code', token),
  h('div.actions', h('button.btn', { onclick: () => copy(token) }, 'Copiar'), h('button.btn.primary', { onclick: close }, 'Hecho'))));

const SHORTCUTS = (base) => [
  {
    title: '🛒 "Oye Siri, añade a la compra"',
    steps: [
      'Atajos → Nuevo atajo. Renómbralo a «Añade a la compra» (esa será la frase para Siri).',
      'Acción «Dictar texto» (o «Solicitar entrada» de tipo texto).',
      `Acción «Obtener contenido de URL»: URL ${base}/api/quick/shopping?format=text · Método POST · Cabeceras: Authorization = Bearer TU_TOKEN · Cuerpo de la solicitud: JSON, clave text = Texto dictado.`,
      'Acción «Mostrar resultado» o «Leer texto» con el «Contenido de URL».',
    ],
    curl: `curl -X POST "${base}/api/quick/shopping" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"text":"leche, 2 huevos y pan"}'`,
  },
  {
    title: '📋 "Oye Siri, qué falta en la compra"',
    steps: [`«Obtener contenido de URL» GET ${base}/api/quick/shopping-list?format=text con la cabecera Authorization, y después «Leer texto».`],
    curl: `curl "${base}/api/quick/shopping-list?format=text" -H "Authorization: Bearer TU_TOKEN"`,
  },
  {
    title: '💳 Automatización de Wallet (al pagar con el iPhone)',
    steps: [
      'Atajos → Automatización → Nueva → «Transacción» (Wallet). Elige tus tarjetas y marca «Ejecutar inmediatamente».',
      `Acción «Obtener contenido de URL»: ${base}/api/quick/expense · POST · Authorization = Bearer TU_TOKEN · Cuerpo JSON: amount = Importe, merchant = Comercio, card = Tarjeta (variables de «Entrada del atajo»), source = wallet.`,
      '(Opcional) «Mostrar notificación» con el «Contenido de URL» → campo message.',
      'La categoría se asigna sola por el comercio (configurable en Gastos → Categorías) y aprende de tus correcciones.',
    ],
    curl: `curl -X POST "${base}/api/quick/expense" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"amount":"23,40 €","merchant":"Mercadona","card":"Visa","source":"wallet"}'`,
  },
  {
    title: '🎙️ "Oye Siri, apunta un gasto"',
    steps: [
      'Nuevo atajo «Apunta un gasto» → «Dictar texto» (p.ej. «doce cincuenta en la farmacia» o «12,50 farmacia»).',
      `«Obtener contenido de URL» POST ${base}/api/quick/expense?format=text con JSON text = Texto dictado y source = siri → «Leer texto».`,
      'Si prefieres campos separados: «Solicitar número» (importe) + «Solicitar texto» (concepto) → amount y description.',
    ],
    curl: `curl -X POST "${base}/api/quick/expense?format=text" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"text":"12,50 farmacia","source":"siri"}'`,
  },
  {
    title: '⚖️ "Oye Siri, quién debe a quién"',
    steps: [
      'Nuevo atajo «Quién debe a quién» (esa será la frase para Siri).',
      `«Obtener contenido de URL» GET ${base}/api/quick/balance?format=text con la cabecera Authorization = Bearer TU_TOKEN → «Leer texto».`,
      'Responde con la lista mínima de pagos, p.ej. «Luis debe 12,30 € a Ana.», o «Estáis en paz» si nadie debe nada.',
      'Para apuntar un gasto solo tuyo (que no se reparte) añade personal = true (o shared = false) al atajo de gastos.',
    ],
    curl: `curl "${base}/api/quick/balance?format=text" -H "Authorization: Bearer TU_TOKEN"`,
  },
  {
    title: '📅 "Oye Siri, crea un evento familiar"',
    steps: [
      'Nuevo atajo → «Dictar texto» (p.ej. «mañana a las 17:30 dentista de Lucía»).',
      `«Obtener contenido de URL» POST ${base}/api/quick/event?format=text con JSON text = Texto dictado (opcional: calendar = Médicos) → «Leer texto».`,
      'También acepta title + date (fecha de Atajos en formato ISO 8601) + time + duration.',
    ],
    curl: `curl -X POST "${base}/api/quick/event?format=text" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"text":"viernes a las 18:00 piscina","calendar":"Familia"}'`,
  },
  {
    title: '🗓️ "Oye Siri, qué tenemos hoy"',
    steps: [`GET ${base}/api/quick/agenda?format=text (o &date=YYYY-MM-DD) → «Leer texto».`],
    curl: `curl "${base}/api/quick/agenda?format=text" -H "Authorization: Bearer TU_TOKEN"`,
  },
  {
    title: '✅ "Oye Siri, apunta una tarea"',
    steps: [
      'Nuevo atajo «Apunta una tarea» → «Dictar texto» (p.ej. «mañana sacar la basura para Luis» o «el viernes a las 18:00 llamar al fontanero»).',
      `«Obtener contenido de URL» POST ${base}/api/quick/task?format=text con JSON text = Texto dictado (opcional: assignee = nombre del responsable) → «Leer texto».`,
      `Para que Siri lea lo pendiente: GET ${base}/api/quick/tasks-list?format=text (las tuyas) o añade &all=true (las de toda la casa) → «Leer texto».`,
    ],
    curl: `curl -X POST "${base}/api/quick/task?format=text" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"text":"mañana sacar la basura","assignee":"Luis"}'`,
  },
  {
    title: '🍽️ "Oye Siri, qué hay para cenar"',
    steps: [
      `«Obtener contenido de URL» GET ${base}/api/quick/meal?format=text con la cabecera Authorization → «Leer texto». Dice lo planificado hoy para comer y cenar.`,
      'Para otro día añade &text=mañana (o &date=YYYY-MM-DD); para una sola comida, &meal=cena. También puedes «Dictar texto» y enviarlo como text («mañana para comer»).',
    ],
    curl: `curl "${base}/api/quick/meal?format=text&text=ma%C3%B1ana" -H "Authorization: Bearer TU_TOKEN"`,
  },
  {
    title: '📝 "Oye Siri, planifica la cena"',
    steps: [
      'Nuevo atajo → «Dictar texto» (p.ej. «mañana cena lasaña» o «el viernes para comer paella»).',
      `«Obtener contenido de URL» POST ${base}/api/quick/meal-plan?format=text con JSON text = Texto dictado → «Leer texto».`,
      'También acepta date (YYYY-MM-DD) + meal (desayuno, comida, merienda o cena) + text. Si el plato coincide con una receta, se enlaza para poder pasar sus ingredientes a la compra.',
    ],
    curl: `curl -X POST "${base}/api/quick/meal-plan?format=text" -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" -d '{"text":"mañana cena lasaña"}'`,
  },
];

export default {
  id: 'settings', title: 'Ajustes', icon: '⚙️',
  async render(el, { state }) {
    const base = location.origin;
    const tokensEl = h('div');
    const usersEl = h('div');

    const loadTokens = async () => {
      const tokens = await api.get('/tokens');
      clear(tokensEl, h('table', h('thead', h('tr', h('th', 'Nombre'), h('th', 'Termina en'), h('th', 'Último uso'), h('th', ''))),
        h('tbody', tokens.map((t) => h('tr', h('td', t.name, t.current ? h('span.badge', { style: { marginLeft: '.4rem' } }, 'esta sesión') : null),
          h('td', h('code', `…${t.hint}`)), h('td.small.muted', t.last_used_at || 'nunca'),
          h('td.num', h('button.btn.sm.danger', { onclick: async () => {
            if (!(await confirmDialog(`Revocar el token "${t.name}"? Los atajos que lo usen dejarán de funcionar.`, 'Revocar'))) return;
            await api.del(`/tokens/${t.id}`); t.current ? logout() : loadTokens();
          } }, 'Revocar')))))));
    };
    const newToken = () => {
      const name = h('input', { placeholder: 'iPhone de Ana, Atajos, Calendario…' });
      modal('Nuevo token', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        try { const { token } = await api.post('/tokens', { name: name.value || 'token' }); close(); showToken(token); loadTokens(); } catch (err) { toastError(err); }
      } }, field('Para qué lo vas a usar', name), h('p.small.muted', 'Usa un token distinto para cada dispositivo o atajo: así puedes revocarlos por separado.'),
      h('div.actions', h('button.btn.primary', 'Crear'))));
    };

    const loadUsers = async () => {
      if (!state.me.isAdmin) return;
      state.users = await api.get('/users');
      clear(usersEl, h('table', h('tbody', state.users.map((u) => h('tr',
        h('td', h('span.dot', { style: { background: u.color, marginRight: '.4rem' } }), u.name, u.isAdmin ? h('span.badge', { style: { marginLeft: '.4rem' } }, 'admin') : null),
        h('td.num', h('button.btn.sm', { onclick: async () => { const { token } = await api.post('/tokens', { userId: u.id, name: 'nuevo' }); showToken(token, `Token para ${u.name}`); } }, 'Nuevo token'), ' ',
          u.id !== state.me.id ? h('button.btn.sm.danger', { onclick: async () => {
            if (!(await confirmDialog(`Eliminar a ${u.name}? Se revocan sus tokens.`))) return;
            await api.del(`/users/${u.id}`); loadUsers();
          } }, 'Eliminar') : null))))));
    };
    const newUser = () => {
      const name = h('input', { placeholder: 'Nombre' }), color = h('input', { type: 'color', value: '#22a06b' }), admin = h('input', { type: 'checkbox' });
      modal('Nuevo miembro', (close) => h('form.form', { onsubmit: async (e) => {
        e.preventDefault();
        try { const r = await api.post('/users', { name: name.value, color: color.value, isAdmin: admin.checked }); close(); showToken(r.token, `Token para ${r.user.name}`); loadUsers(); }
        catch (err) { toastError(err); }
      } }, h('div.row', color, h('div', { style: { flex: 1 } }, name)), h('label.check', admin, 'Administrador'),
      h('div.actions', h('button.btn.primary', 'Crear'))));
    };

    const pName = h('input', { value: state.me.name }), pColor = h('input', { type: 'color', value: state.me.color });

    const icsBtn = h('button.btn', { onclick: async () => {
      const { token } = await api.post('/tokens', { name: 'Suscripción calendario' });
      const url = `${base.replace(/^http/, 'webcal')}/api/calendar.ics?token=${token}`;
      modal('Suscribirse en el iPhone', (close) => h('div.form',
        h('p', 'Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Añadir calendario suscrito, y pega esta URL (o ábrela desde el iPhone):'),
        h('pre.code', url), h('p.small.muted', 'Añade &sources=events para incluir solo eventos. El iPhone refresca las suscripciones periódicamente.'),
        h('div.actions', h('a.btn', { href: url }, 'Abrir'), h('button.btn', { onclick: () => copy(url) }, 'Copiar'), h('button.btn.primary', { onclick: close }, 'Hecho'))));
      loadTokens();
    } }, 'Generar URL de suscripción');

    clear(el,
      h('div.page-head', h('h1', '⚙️ Ajustes'), h('div.spacer'), h('button.btn', { onclick: logout }, 'Cerrar sesión')),
      h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' } },
        h('div.card', h('h2', 'Mi perfil'), h('form.form', { onsubmit: async (e) => {
          e.preventDefault();
          try { state.me = await api.patch('/me', { name: pName.value, color: pColor.value }); toast('Guardado'); } catch (err) { toastError(err); }
        } }, h('div.row', pColor, h('div', { style: { flex: 1 } }, pName), h('button.btn.primary', 'Guardar')))),
        h('div.card', h('h2', '📆 Calendario en el iPhone'), h('p.small.muted', 'Ve el calendario familiar dentro de la app Calendario de iOS (solo lectura).'), icsBtn)),
      h('div.card', { style: { marginTop: '1rem' } }, h('div.row', h('h2', { style: { margin: 0 } }, '🔑 Mis tokens'), h('div.spacer'), h('button.btn.primary.sm', { onclick: newToken }, '+ Token')),
        h('div', { style: { overflowX: 'auto', marginTop: '.5rem' } }, tokensEl)),
      state.me.isAdmin ? h('div.card', { style: { marginTop: '1rem' } }, h('div.row', h('h2', { style: { margin: 0 } }, '👨‍👩‍👧 Miembros de la casa'), h('div.spacer'),
        h('button.btn.primary.sm', { onclick: newUser }, '+ Miembro')), usersEl) : null,
      h('div.card', { style: { marginTop: '1rem' } }, h('h2', '⚡ Atajos de iPhone, Siri y Wallet'),
        h('p.small.muted', 'Todas las acciones rápidas aceptan GET o POST, el token en la cabecera «Authorization: Bearer …» (recomendado) o como ?token=, y responden JSON con un campo message. Añade ?format=text para recibir solo la frase (ideal para «Leer texto»).'),
        SHORTCUTS(base).map((s) => h('details', { style: { borderTop: '1px solid var(--line)', padding: '.6rem 0' } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, s.title),
          h('ol.small', s.steps.map((x) => h('li', x))),
          h('div.row', h('pre.code', { style: { flex: 1, margin: 0 } }, s.curl), h('button.btn.sm', { onclick: () => copy(s.curl) }, 'Copiar'))))));
    await Promise.all([loadTokens(), loadUsers()]).catch(toastError);
  },
};
