// Fechas "locales" sin zona horaria: 'YYYY-MM-DD' y 'YYYY-MM-DDTHH:MM'. Todo se opera en UTC para evitar saltos DST.

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isDateTime = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);

export function toUTC(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, hh, mm));
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const fmtDateTime = (d) => `${fmtDate(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

export function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

/** Suma meses respetando el fin de mes; devuelve null si el día no existe (p.ej. 31 en abril) para saltarlo. */
export function addMonthsStrict(d, n) {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()));
  return r.getUTCDate() === d.getUTCDate() ? r : null;
}

/**
 * Zona horaria de la casa. APP_TZ tiene prioridad porque en Vercel la variable TZ está reservada (siempre UTC).
 * Un TZ con formato raro (":UTC", ":/etc/localtime") se ignora.
 */
export function appTz() {
  const tz = process.env.APP_TZ || (process.env.TZ && !process.env.TZ.startsWith(':') && process.env.TZ !== 'UTC' ? process.env.TZ : '');
  return tz || 'Europe/Madrid';
}

/** Fecha de hoy en la zona horaria de la casa. */
export function today(tz = appTz()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function nowLocal(tz = appTz()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
