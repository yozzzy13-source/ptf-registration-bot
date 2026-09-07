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

// ------------------------------------------------------- вход по подписанной ссылке
// Мини-приложение, открытое из постоянной клавиатуры, не получает initData:
// Telegram отдаёт его только inline-кнопкам, кнопке Menu и прямым ссылкам.
// Чтобы кнопка открывала раздел в ОДИН тап и при этом знала, кто пришёл,
// бот вшивает в её адрес короткий токен, подписанный секретом бота.
// Клавиатура персональная — этот адрес видит только её владелец.
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function tokenSecret() {
  return crypto.createHmac('sha256', 'PTFWebAppLink').update(BOT_TOKEN || '').digest();
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function signWebAppToken(telegramId, ttlMs = TOKEN_TTL_MS) {
  const id = String(telegramId || '');
  if (!id || !BOT_TOKEN) return '';
  const exp = Date.now() + ttlMs;
  const payload = `${id}.${exp}`;
  const sig = b64url(crypto.createHmac('sha256', tokenSecret()).update(payload).digest()).slice(0, 27);
  return `${payload}.${sig}`;
}

// Возвращает telegram_id или '' — при неверной подписи, просрочке и любом мусоре.
export function verifyWebAppToken(token = '') {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 3) return '';
  const [id, exp, sig] = parts;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(exp)) return '';
  if (Number(exp) < Date.now()) return '';
  const expected = b64url(crypto.createHmac('sha256', tokenSecret()).update(`${id}.${exp}`).digest()).slice(0, 27);
  if (expected.length !== sig.length) return '';
  try { if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return ''; }
  catch { return ''; }
  return id;
}
