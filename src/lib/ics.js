// Generación mínima de iCalendar (RFC 5545) para suscribirse desde el calendario del iPhone.
const esc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);
const compact = (s) => s.replace(/[-:]/g, '');

function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

const RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

function nextDay(d) {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** items: [{uid, title, description, location, start, end, allDay, recurrence, recurrenceInterval, recurrenceUntil}] */
export function buildICS(items, { name = 'FamilyPro', tz = process.env.TZ || 'Europe/Madrid' } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyPro//ES', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${tz}`];
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${it.uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(it.title)}`);
    if (it.allDay) {
      const s = it.start.slice(0, 10);
      const e = (it.end || it.start).slice(0, 10);
      lines.push(`DTSTART;VALUE=DATE:${compact(s)}`, `DTEND;VALUE=DATE:${compact(nextDay(e))}`);
    } else {
      lines.push(`DTSTART;TZID=${tz}:${compact(it.start)}00`);
      lines.push(`DTEND;TZID=${tz}:${compact(it.end || it.start)}00`);
    }
    if (it.recurrence && RRULE[it.recurrence]) {
      let r = `RRULE:FREQ=${RRULE[it.recurrence]};INTERVAL=${it.recurrenceInterval || 1}`;
      if (it.recurrenceUntil) r += `;UNTIL=${compact(it.recurrenceUntil.slice(0, 10))}T235959Z`;
      lines.push(r);
    }
    for (const ex of it.exdates || []) {
      lines.push(it.allDay ? `EXDATE;VALUE=DATE:${compact(ex)}` : `EXDATE;TZID=${tz}:${compact(ex)}T${compact(it.start.slice(11))}00`);
    }
    if (it.description) lines.push(`DESCRIPTION:${esc(it.description)}`);
    if (it.location) lines.push(`LOCATION:${esc(it.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
