import { api, getToken, setToken } from './api.js';
import { h, clear, toastError } from './ui.js';
import { pages } from './modules/index.js';

const root = document.getElementById('app');
export const state = { me: null, users: [], modules: [] };

async function boot() {
  if (!getToken()) return renderLogin();
  try {
    [state.me, state.users, state.modules] = await Promise.all([api.get('/me'), api.get('/users'), api.get('/modules')]);
  } catch (e) { return renderLogin(e.message); }
  renderShell();
  window.addEventListener('hashchange', route);
  route();
}

function renderLogin(error) {
  const input = h('input', { type: 'password', placeholder: 'fp_…', autocomplete: 'current-password' });
  const err = h('div.small', { style: { color: 'var(--danger)' } }, error || '');
  const submit = async (e) => {
    e.preventDefault();
    setToken(input.value.trim());
    try { await fetch('/api/me', { headers: { authorization: `Bearer ${input.value.trim()}` } }).then((r) => { if (!r.ok) throw new Error('Token no válido'); }); location.reload(); }
    catch (ex) { setToken(null); err.textContent = ex.message; }
  };
  clear(root, h('div.login', h('form.card', { onsubmit: submit },
    h('img', { src: '/icon.svg', alt: '' }),
    h('h1', { style: { textAlign: 'center' } }, 'FamilyPro'),
    h('p.muted.small', { style: { textAlign: 'center', margin: 0 } }, 'Introduce tu token personal de acceso.'),
    input, err, h('button.btn.primary', { type: 'submit' }, 'Entrar'))));
}

let main, navLinks;
function renderShell() {
  const visible = pages.filter((p) => !p.module || state.modules.some((m) => m.id === p.module));
  navLinks = visible.filter((p) => !p.hidden).map((p) => h('a', { href: `#/${p.id}`, 'data-id': p.id }, h('span.ico', p.icon), h('span', p.title)));
  main = h('main');
  clear(root, h('div.layout',
    h('nav.nav', h('div.brand', h('img', { src: '/icon.svg', alt: '' }), 'FamilyPro'), navLinks,
      h('div.user', `Conectado como ${state.me.name}`)),
    main));
}

let cleanup = null;
async function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const id = path || pages[0].id;
  const page = pages.find((p) => p.id === id) || pages[0];
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.id === page.id));
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  clear(main);
  try { cleanup = await page.render(main, { params: new URLSearchParams(qs || ''), state }); }
  catch (e) { toastError(e); }
}

export const logout = () => { setToken(null); location.hash = ''; location.reload(); };
boot();
