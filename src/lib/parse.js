/**
 * Convierte importes de texto a céntimos. Acepta "12,50 €", "€12.50", "1.234,56", "-3", 12.5...
 * Devuelve null si no hay número.
 */
export function parseAmountToCents(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = String(input).replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    // "1,234,567" (miles) vs "12,5" (decimal)
    s = (s.split(',').length > 2) ? s.split(',').join('') : s.replace(',', '.');
  } else if (s.split('.').length > 2) {
    s = s.split('.').join('');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100);
}

/**
 * Separa un texto libre en elementos: "leche, 2 huevos y pan\npapel" → ["leche","2 huevos","pan","papel"].
 */
export function splitItems(input) {
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .flatMap((x) => String(x ?? '').split(/[,;\n]|\s+y\s+|\s+e\s+|\s+and\s+/i))
    .map((x) => x.trim().replace(/[.]+$/, ''))
    .filter(Boolean);
}

/** "2 huevos" → {name:'huevos', quantity:'2'}; "leche x3" → {name:'leche', quantity:'3'} */
export function parseItem(text) {
  let m = text.match(/^(\d+(?:[.,]\d+)?\s*(?:kg|g|gr|l|ml|uds?|unidades|paquetes?|botellas?|latas?|docenas?)?)\s+(?:de\s+)?(.+)$/i);
  if (m) return { name: capitalize(m[2].trim()), quantity: m[1].trim() };
  m = text.match(/^(.+?)\s*x\s*(\d+)$/i);
  if (m) return { name: capitalize(m[1].trim()), quantity: m[2] };
  return { name: capitalize(text.trim()), quantity: '' };
}

export function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "12,50 mercadona compra semanal" → {cents:1250, text:'mercadona compra semanal'} */
export function parseExpenseText(text) {
  const m = String(text ?? '').match(/-?\d[\d.,]*/);
  if (!m) return { cents: null, text: String(text ?? '').trim() };
  const cents = parseAmountToCents(m[0]);
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/€|euros?|eur\b/gi, '').replace(/\s+/g, ' ').trim()
    .replace(/^(en|de)\s+/i, '');
  return { cents, text: rest };
}

export const formatEuros = (cents) =>
  (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: process.env.CURRENCY || 'EUR' });
