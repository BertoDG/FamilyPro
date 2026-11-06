import { toUTC, addDays, fmtDate, today } from './dates.js';

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Extrae fecha/hora de un texto en español: "mañana a las 17:30 dentista", "el viernes cena", "12/11 a las 9 ITV",
 * "15 de diciembre cumple de Ana". Devuelve { date, time|null, title }.
 */
export function parseSpanishDate(text, base = today()) {
  let s = ` ${norm(String(text))} `;
  const original = ` ${String(text)} `;
  let date = null, time = null;
  const cut = (re) => {
    const m = s.match(re);
    if (!m) return null;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return m;
  };
  const b = toUTC(base);

  let m;
  if ((m = cut(/\s(pasado manana)\s/))) date = fmtDate(addDays(b, 2));
  else if ((m = cut(/\s(manana)\s/))) date = fmtDate(addDays(b, 1));
  else if ((m = cut(/\s(hoy)\s/))) date = base;
  else if ((m = cut(/\s(\d{4})-(\d{2})-(\d{2})\s/))) date = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = cut(/\s(?:el\s)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s/))) {
    let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : b.getUTCFullYear();
    const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (!m[3] && d < b) d.setUTCFullYear(y + 1);
    date = fmtDate(d);
  } else if ((m = cut(new RegExp(`\\s(?:el\\s)?(\\d{1,2})\\sde\\s(${MONTHS.join('|')})(?:\\sde\\s(\\d{4}))?\\s`)))) {
    const y = m[3] ? Number(m[3]) : b.getUTCFullYear();
    const d = new Date(Date.UTC(y, MONTHS.indexOf(m[2]), Number(m[1])));
    if (!m[3] && d < b) d.setUTCFullYear(y + 1);
    date = fmtDate(d);
  } else if ((m = cut(new RegExp(`\\s(?:el\\s|este\\s|el proximo\\s|proximo\\s)?(${WEEKDAYS.join('|')})(?:\\sque viene)?\\s`)))) {
    const target = WEEKDAYS.indexOf(m[1]);
    let diff = (target - b.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    date = fmtDate(addDays(b, diff));
  }

  if ((m = cut(/\s(?:a\s)?(?:las?|la)\s(\d{1,2})(?:[:.h](\d{2}))?\s*(?:h|horas)?\s*(de la manana|de la tarde|de la noche|y media|y cuarto|menos cuarto)?\s/))) {
    let h = Number(m[1]), min = Number(m[2] || 0);
    if (m[3] === 'y media') min = 30;
    if (m[3] === 'y cuarto') min = 15;
    if (m[3] === 'menos cuarto') { h -= 1; min = 45; }
    if ((m[3] === 'de la tarde' || m[3] === 'de la noche') && h < 12) h += 12;
    else if (!m[3] && h >= 1 && h <= 7) h += 12; // "a las 5" → 17:00 en contexto doméstico
    time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  } else if ((m = cut(/\s(\d{1,2})[:.](\d{2})\s/))) {
    time = `${m[1].padStart(2, '0')}:${m[2]}`;
  }

  // Recupera el título con mayúsculas/acentos originales usando las palabras que quedan
  const leftover = s.trim().split(/\s+/).filter(Boolean);
  const origWords = original.trim().split(/\s+/);
  const title = origWords.filter((w) => leftover.includes(norm(w))).join(' ').replace(/^(el|la|de|a)\s+/i, '').trim();
  return { date, time, title: title ? title.charAt(0).toUpperCase() + title.slice(1) : '' };
}
