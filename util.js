import crypto from 'crypto';
import { DateTime } from 'luxon';
import { BOT_TOKEN, TIMEZONE } from './config.js';

export const nowISO = () => DateTime.now().setZone(TIMEZONE).toISO({ suppressMilliseconds: true });
export const safe = (v) => String(v ?? '').trim();
export const uid = (prefix='id') => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
export const langOf = (code) => String(code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
export const escapeHtml = (s='') => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

export function parseInitData(initData='') {
  const params = new URLSearchParams(initData);
  const userRaw = params.get('user');
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch {}
  return { params, user };
}

export function verifyTelegramInitData(initData='') {
  if (!BOT_TOKEN || !initData) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash)); }
  catch { return false; }
}

export function chunk(arr, n) {
  const out = [];
  for (let i=0; i<arr.length; i+=n) out.push(arr.slice(i, i+n));
  return out;
}
