export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, msg);

/** Junta query + body (JSON o formulario) para que los atajos puedan usar GET o POST indistintamente. */
export const input = (req) => {
  const body = req.body;
  if (typeof body === 'string') return { ...(req.query || {}), ...(body.trim() ? { text: body.trim() } : {}) };
  return { ...(req.query || {}), ...(body && typeof body === 'object' ? body : {}) };
};

export const intId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('id no válido');
  return n;
};
