// Сайт лиги: тот же интерфейс, что в мини-приложении, но в обычном браузере.
//
// Вход — только через Telegram (официальная кнопка Telegram Login). Своих
// паролей и регистраций у сайта нет: человек подтверждает вход в Telegram, и
// дальше он ровно тот же пользователь, что и в боте, — тот же telegram_id,
// та же анкета, те же права. Анкета заполняется в боте, не на сайте.
//
// Как это устроено. После входа сайт кладёт в браузер защищённую куку с тем же
// подписанным токеном, каким бот открывает мини-приложение из постоянной
// клавиатуры (util.js → signWebAppToken). Прослойка ниже подставляет этот токен
// в запросы к /api, если в них нет данных Telegram. Поэтому ни одна ручка
// сервера не знает, пришёл человек из Telegram или с сайта, — права и логика
// одни на оба входа, и расходиться им негде.
import crypto from 'node:crypto';
import { BOT_TOKEN, ADMIN_IDS } from './config.js';
import { signWebAppToken, verifyWebAppToken } from './util.js';

export const WEB_COOKIE = 'ptf_web';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// Подпись Telegram живёт сутки: старую ссылку входа повторно не примем.
const LOGIN_MAX_AGE_S = 24 * 60 * 60;
const LOGIN_FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];

let botName = '';
export function setWebBotName(name) { botName = String(name || '').replace(/^@/, '').trim(); }
export const webBotName = () => botName;

// Проверка данных от кнопки Telegram Login — строго по документации Telegram:
// ключ — SHA-256 от токена бота, подписывается строка «поле=значение» по
// алфавиту через перевод строки, без самого hash.
export function verifyTelegramLogin(query = {}, now = Date.now()) {
  if (!BOT_TOKEN) return { ok: false, reason: 'no_bot_token' };
  const hash = String(query.hash || '');
  if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, reason: 'bad_hash' };
  const fields = LOGIN_FIELDS.filter(k => query[k] !== undefined && query[k] !== '');
  const check = fields.slice().sort().map(k => `${k}=${query[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
  let same = false;
  try { same = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash.toLowerCase(), 'hex')); } catch { same = false; }
  if (!same) return { ok: false, reason: 'bad_signature' };
  const authDate = Number(query.auth_date || 0);
  if (!authDate || now / 1000 - authDate > LOGIN_MAX_AGE_S) return { ok: false, reason: 'expired' };
  if (!/^\d+$/.test(String(query.id || ''))) return { ok: false, reason: 'bad_id' };
  return {
    ok: true,
    user: {
      id: String(query.id),
      first_name: String(query.first_name || ''),
      last_name: String(query.last_name || ''),
      username: String(query.username || ''),
      photo_url: String(query.photo_url || '')
    }
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
// telegram_id из куки сайта или ''.
export function sessionUserId(req) {
  const tok = parseCookies(req.headers?.cookie)[WEB_COOKIE] || '';
  return tok ? verifyWebAppToken(tok) : '';
}
function sessionToken(req) {
  const tok = parseCookies(req.headers?.cookie)[WEB_COOKIE] || '';
  return tok && verifyWebAppToken(tok) ? tok : '';
}
function cookieFlags(req) {
  const secure = req.secure || String(req.headers?.['x-forwarded-proto'] || '').includes('https');
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export function setSessionCookie(req, res, telegramId) {
  const tok = signWebAppToken(telegramId, SESSION_MS);
  res.append('Set-Cookie', `${WEB_COOKIE}=${encodeURIComponent(tok)}; Max-Age=${Math.floor(SESSION_MS / 1000)}; ${cookieFlags(req)}`);
  // Подсказка для страницы «вошёл / гость» — по ней телефон выбирает свою
  // сохранённую копию витрины. Секрета в ней нет, сам вход — в куке выше.
  res.append('Set-Cookie', `ptf_web_in=1; Max-Age=${Math.floor(SESSION_MS / 1000)}; ${cookieFlags(req).replace('; HttpOnly', '')}`);
}
export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${WEB_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
  res.append('Set-Cookie', `ptf_web_in=; Max-Age=0; ${cookieFlags(req).replace('; HttpOnly', '')}`);
}

// Запрос пришёл с этой же страницы? Для POST по куке это обязательно: чужой
// сайт не должен суметь сделать что-то от имени вошедшего человека.
function sameOrigin(req) {
  const origin = String(req.headers?.origin || req.headers?.referer || '');
  if (!origin) return false;
  try { return new URL(origin).host === String(req.headers?.host || ''); } catch { return false; }
}

// Прослойка для /api: нет данных Telegram — берём вход с сайта.
export function webSessionMiddleware(req, res, next) {
  try {
    if (!String(req.path || '').startsWith('/api/')) return next();
    const q = req.query || {}, b = req.body || {};
    if (q.initData || b.initData || q.t || b.t) return next();
    const tok = sessionToken(req);
    if (!tok) return next();
    if (req.method === 'GET' || req.method === 'HEAD') { req.query.t = tok; return next(); }
    if (!sameOrigin(req)) return next();
    req.body = { ...(req.body && typeof req.body === 'object' ? req.body : {}), t: tok };
  } catch (e) { console.error('web session:', e.message); }
  return next();
}

// Куда вернуть человека после входа: только своя страница, никаких внешних адресов.
export function safeNext(value = '') {
  const v = String(value || '');
  return /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/';
}

export function registerWebAuthRoutes(app, { onLogin } = {}) {
  // Сюда Telegram возвращает человека после подтверждения входа.
  app.get('/auth/telegram', async (req, res) => {
    const check = verifyTelegramLogin(req.query || {});
    const next = safeNext(req.query.next);
    if (!check.ok) {
      console.error('web login rejected:', check.reason);
      return res.redirect(302, next + (next.includes('?') ? '&' : '?') + 'login=failed');
    }
    setSessionCookie(req, res, check.user.id);
    if (onLogin && !ADMIN_IDS.includes(String(check.user.id))) {
      Promise.resolve(onLogin(check.user)).catch(e => console.error('web login hook:', e.message));
    }
    res.redirect(302, next);
  });
  app.get('/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.redirect(302, safeNext(req.query.next));
  });
  // Что нужно странице, чтобы нарисовать кнопку входа.
  app.get('/api/web/session', (req, res) => {
    const id = sessionUserId(req);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, logged_in: Boolean(id), bot_username: botName });
  });
}
