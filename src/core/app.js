import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import { coreMigrations, authMiddleware, requireAdmin, createToken, createUser, publicUser } from './auth.js';
import { HttpError, bad, input, intId, notFound } from './http.js';
import { buildICS } from '../lib/ics.js';
import { isDate, today, toUTC, addDays, fmtDate } from '../lib/dates.js';
import { modules as defaultModules } from '../modules/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db, { modules = defaultModules } = {}) {
  migrate(db, 'core', coreMigrations);
  const ctx = {
    db,
    users: () => db.prepare('SELECT id, name, color, is_admin, settings FROM users ORDER BY id').all().map(publicUser),
    modules,
  };
  for (const m of modules) migrate(db, m.id, m.migrations);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.text({ type: 'text/plain' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(authMiddleware(db));

  // ---------- Usuario y tokens ----------
  api.get('/me', (req, res) => res.json(req.user));
  api.patch('/me', (req, res) => {
    const { name, color, settings } = req.body || {};
    if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), req.user.id);
    if (color !== undefined) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(String(color), req.user.id);
    if (settings !== undefined) {
      const merged = { ...req.user.settings, ...settings };
      db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(merged), req.user.id);
    }
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  api.get('/users', (req, res) => res.json(ctx.users()));
  api.post('/users', requireAdmin, (req, res) => {
    const { name, color, isAdmin } = req.body || {};
    if (!name?.trim()) throw bad('Falta el nombre');
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name.trim())) throw bad('Ya existe un usuario con ese nombre');
    const id = createUser(db, { name: name.trim(), color, isAdmin });
    const token = createToken(db, id, 'inicial');
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), token });
  });
  api.delete('/users/:id', requireAdmin, (req, res) => {
    const id = intId(req.params.id);
    if (id === req.user.id) throw bad('No puedes eliminarte a ti mismo');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  const tokenOwner = (req, userId) => {
    if (!userId || Number(userId) === req.user.id) return req.user.id;
    if (!req.user.isAdmin) throw new HttpError(403, 'Solo administradores');
    return intId(userId);
  };
  api.get('/tokens', (req, res) => {
    const uid = tokenOwner(req, req.query.userId);
    res.json(db.prepare('SELECT id, name, hint, last_used_at, created_at FROM tokens WHERE user_id = ? ORDER BY id').all(uid)
      .map((t) => ({ ...t, current: t.id === req.user.tokenId })));
  });
  api.post('/tokens', (req, res) => {
    const uid = tokenOwner(req, req.body?.userId);
    const token = createToken(db, uid, String(req.body?.name || 'token').slice(0, 60));
    res.status(201).json({ token });
  });
  api.delete('/tokens/:id', (req, res) => {
    const id = intId(req.params.id);
    const t = db.prepare('SELECT user_id FROM tokens WHERE id = ?').get(id);
    if (!t) throw notFound();
    if (t.user_id !== req.user.id && !req.user.isAdmin) throw new HttpError(403, 'No permitido');
    db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- Módulos ----------
  api.get('/modules', (req, res) => res.json(modules.map((m) => ({
    id: m.id, name: m.name, icon: m.icon,
    calendar: m.calendar ? { label: m.calendar.label, color: m.calendar.color, defaultVisible: m.calendar.defaultVisible !== false } : null,
    quick: Object.entries(m.quick || {}).map(([k, q]) => ({ name: k, description: q.description, params: q.params })),
  }))));

  // ---------- Calendario principal (agrega todas las fuentes) ----------
  const calendarSources = (req) => {
    const all = modules.filter((m) => m.calendar);
    const wanted = req.query.sources ? String(req.query.sources).split(',') : null;
    return wanted ? all.filter((m) => wanted.includes(m.id)) : all;
  };
  api.get('/calendar', (req, res) => {
    const from = req.query.from || today();
    const to = req.query.to || fmtDate(addDays(toUTC(from), 41));
    if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
    if (toUTC(to) - toUTC(from) > 400 * 864e5) throw bad('Rango demasiado grande (máx. 400 días)');
    const items = calendarSources(req).flatMap((m) =>
      m.calendar.fetch(ctx, { from, to, user: req.user }).map((it) => ({
        color: m.calendar.color, ...it, source: m.id, sourceLabel: m.calendar.label,
      })));
    items.sort((a, b) => a.start.localeCompare(b.start) || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0));
    res.json(items);
  });
  api.get('/calendar.ics', (req, res) => {
    const items = calendarSources(req).flatMap((m) => (m.calendar.ics ? m.calendar.ics(ctx, { user: req.user }) : []));
    res.type('text/calendar; charset=utf-8').send(buildICS(items, { name: 'FamilyPro' }));
  });

  // ---------- Resumen para el panel ----------
  api.get('/dashboard', (req, res) => {
    res.json(modules.filter((m) => m.summary).map((m) => ({ module: m.id, icon: m.icon, ...m.summary(ctx, req.user) })));
  });

  // ---------- Acciones rápidas (atajos de iPhone / Siri / Wallet) ----------
  api.get('/quick', (req, res) => res.json(modules.flatMap((m) =>
    Object.entries(m.quick || {}).map(([k, q]) => ({ path: `/api/quick/${k}`, module: m.id, description: q.description, params: q.params })))));
  for (const m of modules) {
    for (const [name, q] of Object.entries(m.quick || {})) {
      api.all(`/quick/${name}`, async (req, res) => {
        const result = await q.handler(ctx, input(req), req.user);
        const wantsText = req.query.format === 'text' || req.get('accept') === 'text/plain';
        if (wantsText) return res.type('text/plain; charset=utf-8').send(result.message);
        res.json({ ok: true, ...result });
      });
    }
  }

  // Rutas propias de cada módulo en /api/<id>
  for (const m of modules) {
    if (!m.routes) continue;
    const r = express.Router();
    m.routes(r, ctx);
    api.use(`/${m.id}`, r);
  }

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada' }));

  // ---------- Web ----------
  const pub = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // Errores
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const msg = status >= 500 ? 'Error interno' : err.message;
    if (req.query?.format === 'text') return res.status(status).type('text/plain').send(msg);
    res.status(status).json({ ok: false, error: msg });
  });

  return app;
}
