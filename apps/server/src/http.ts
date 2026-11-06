import type { Context } from 'hono';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
export const cleanName = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 100 ? v.trim() : null);
export const notFound = (c: Context) => c.json({ error: 'not found' }, 404);
export const forbidden = (c: Context, message = 'you do not have permission to do that') => c.json({ error: message }, 403);
