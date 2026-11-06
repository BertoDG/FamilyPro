import { toUTC, addDays, addMonthsStrict, fmtDate, fmtDateTime } from './dates.js';

/**
 * Expande un evento (posiblemente recurrente) en ocurrencias que solapan [from, to] (fechas 'YYYY-MM-DD', inclusive).
 * event: { start, end, all_day, recurrence: 'none'|'daily'|'weekly'|'monthly'|'yearly', recurrence_interval, recurrence_until, exdates[] }
 */
export function expandOccurrences(event, from, to, max = 1000) {
  const allDay = !!event.all_day;
  const fmt = allDay ? fmtDate : fmtDateTime;
  const start = toUTC(event.start);
  const end = event.end ? toUTC(event.end) : start;
  const duration = Math.max(0, end - start);
  const rangeStart = toUTC(from);
  const rangeEnd = addDays(toUTC(to), 1); // exclusivo
  const until = event.recurrence_until ? addDays(toUTC(event.recurrence_until.slice(0, 10)), 1) : null;
  const interval = Math.max(1, Number(event.recurrence_interval) || 1);
  const rec = event.recurrence || 'none';
  const exdates = new Set(event.exdates || []);
  const out = [];

  const overlaps = (s) => {
    const e = new Date(s.getTime() + duration);
    // los eventos de día completo con end inclusivo ocupan hasta el final del día
    const eEff = allDay ? addDays(e, 1) : (duration === 0 ? new Date(s.getTime() + 1) : e);
    return s < rangeEnd && eEff > rangeStart;
  };
  const push = (s) => {
    if (exdates.has(fmtDate(s))) return;
    if (overlaps(s)) out.push({ start: fmt(s), end: fmt(new Date(s.getTime() + duration)) });
  };

  if (rec === 'none') { push(start); return out; }

  for (let i = 0, n = 0; n < max; i++) {
    let s;
    if (rec === 'daily') s = addDays(start, i * interval);
    else if (rec === 'weekly') s = addDays(start, i * 7 * interval);
    else if (rec === 'monthly') s = addMonthsStrict(start, i * interval);
    else if (rec === 'yearly') s = addMonthsStrict(start, i * 12 * interval);
    else break;
    if (i > 5000) break;
    if (!s) continue; // p.ej. día 31 en un mes de 30
    if (s >= rangeEnd || (until && s >= until)) break;
    push(s);
    n++;
  }
  return out;
}
