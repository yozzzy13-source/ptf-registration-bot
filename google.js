import { google } from 'googleapis';
import { GOOGLE_CREDENTIALS } from './config.js';

let sheetsClient = null;

function getAuth() {
  if (!GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS env is empty');
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

// У Google лимит на чтения в минуту. Когда в него упираемся, ответ приходит с
// кодом 429 и текстом про quota — это не поломка, а «подожди секунду». Ждём и
// пробуем ещё раз: пользователю лучше увидеть страницу на секунду позже, чем
// красную ошибку про quota metric.
const RETRY_DELAYS_MS = [700, 1800, 4000];
function isQuotaError(e) {
  const code = Number(e?.code || e?.response?.status || 0);
  if (code === 429) return true;
  if (code === 403) return /quota|rate limit|userRateLimit/i.test(String(e?.message || ''));
  return false;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, args) {
  let last;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try { return await fn(...args); }
    catch (e) {
      last = e;
      if (!isQuotaError(e) || attempt === RETRY_DELAYS_MS.length) break;
      // Небольшой разброс, чтобы параллельные запросы не ломились разом.
      await sleep(RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 300));
    }
  }
  throw last;
}

// Оборачиваем только методы чтения/записи значений и метаданных: у клиента
// googleapis это обычные функции на объектах, подменяем их на обёртки.
function wrap(client) {
  const ss = client.spreadsheets;
  for (const key of ['get', 'batchUpdate']) {
    const orig = ss[key]?.bind(ss);
    if (orig) ss[key] = (...args) => withRetry(orig, args);
  }
  const values = ss.values;
  for (const key of ['get', 'update', 'append', 'batchGet', 'batchUpdate']) {
    const orig = values?.[key]?.bind(values);
    if (orig) values[key] = (...args) => withRetry(orig, args);
  }
  return client;
}

export function sheets() {
  if (!sheetsClient) sheetsClient = wrap(google.sheets({ version: 'v4', auth: getAuth() }));
  return sheetsClient;
}
