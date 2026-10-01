import { google } from 'googleapis';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GOOGLE_CREDENTIALS } from './config.js';

let sheetsClient = null;
let driveClient = null;

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
    // Диск — только чтение: галерея сайта берёт фото из папки «PTF Gallery».
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
  );
}

// ---------------------------------------------------------------------------
// Очередь к Google Таблицам.
//
// У Google лимит: столько-то чтений и записей в минуту на весь бот (по
// умолчанию 60). Раньше каждый запрос шёл сразу, и когда лимит кончался,
// падало то, что попадёт под руку, — в том числе сохранение счёта.
//
// Теперь каждый запрос сначала берёт «талон» у диспетчера. Диспетчер считает
// запросы за последнюю минуту и не выпускает больше лимита. Нет талонов —
// запрос ждёт в очереди, а очередь идёт по важности:
//   high   — действие человека: счёт, подтверждение, заявка, кнопка в боте;
//   normal — открытие экранов;
//   low    — фон: пересборка витрины, рассылки, напоминания, перенос листа.
// Фону достаётся не весь лимит (70%), экранам — 90%: у действий людей всегда
// остаётся запас.
//
// Лимит задаётся переменными Railway SHEETS_READS_PER_MIN и
// SHEETS_WRITES_PER_MIN. Подняли квоту в Google Cloud — поднимите и их.
// ---------------------------------------------------------------------------
const priorityStore = new AsyncLocalStorage();
const RANK = { high: 0, normal: 1, low: 2 };
const SHARE = { high: 1, normal: 0.9, low: 0.7 };
export function withPriority(priority, fn) {
  const p = RANK[priority] !== undefined ? priority : 'normal';
  return priorityStore.run({ p }, fn);
}
export const currentPriority = () => priorityStore.getStore()?.p || 'normal';

// Окно — минута, как у Google (переменная нужна только тестам).
const WINDOW_MS = Math.max(50, Number(process.env.SHEETS_WINDOW_MS || 60_000));
const envLimit = (name, fallback) => {
  const n = Number(process.env[name] || 0);
  return Number.isFinite(n) && n >= 5 ? Math.floor(n) : fallback;
};
// Чуть ниже официальных 60: у Google своё окно, и наши часы с ним не совпадают.
const READ_LIMIT = () => envLimit('SHEETS_READS_PER_MIN', 55);
const WRITE_LIMIT = () => envLimit('SHEETS_WRITES_PER_MIN', 55);

function makeLimiter(name, limit) {
  const stamps = [];      // когда выданы талоны за последнюю минуту
  const queue = [];       // ждущие: { p, seq, resolve }
  let timer = null;
  let pausedUntil = 0;    // после ответа «лимит» ждём, а не долбим Google
  let seq = 0;
  const prune = now => { while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift(); };
  const schedule = ms => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(20, ms));
    timer.unref?.();
  };
  function pump() {
    const now = Date.now();
    prune(now);
    if (now < pausedUntil) { schedule(pausedUntil - now); return; }
    queue.sort((a, b) => RANK[a.p] - RANK[b.p] || a.seq - b.seq);
    while (queue.length) {
      const next = queue[0];
      const cap = Math.max(1, Math.floor(limit() * SHARE[next.p]));
      if (stamps.length >= cap) break;
      queue.shift();
      stamps.push(now);
      next.resolve();
    }
    if (queue.length) schedule(stamps.length ? WINDOW_MS - (now - stamps[0]) + 25 : 250);
  }
  return {
    acquire(p = 'normal') {
      return new Promise(resolve => { queue.push({ p, seq: seq++, resolve }); pump(); });
    },
    // Google сказал «лимит» — ставим паузу для всех, чтобы следом не ушла
    // пачка таких же обречённых запросов.
    penalize(ms) { pausedUntil = Math.max(pausedUntil, Date.now() + ms); },
    stats() { prune(Date.now()); return { name, used: stamps.length, limit: limit(), waiting: queue.length, paused: Math.max(0, pausedUntil - Date.now()) }; }
  };
}
const readLimiter = makeLimiter('read', READ_LIMIT);
const writeLimiter = makeLimiter('write', WRITE_LIMIT);
export const sheetsQueueStats = () => ({ read: readLimiter.stats(), write: writeLimiter.stats() });

export function isQuotaError(e) {
  const code = Number(e?.code || e?.response?.status || 0);
  if (code === 429) return true;
  if (code === 403) return /quota|rate limit|userRateLimit/i.test(String(e?.message || ''));
  return false;
}
// Сеть моргнула или у Google временный сбой — тоже стоит повторить один раз.
function isTransient(e) {
  const code = Number(e?.code || e?.response?.status || 0);
  if ([500, 502, 503, 504].includes(code)) return true;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(e?.code || '') + ' ' + String(e?.message || ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Сколько ждать при «лимите». Действие человека (счёт!) ждёт дольше всех —
// за это время минутное окно Google точно освободится. Фон сдаётся быстрее:
// он и так повторится по своему расписанию.
const QW = Math.max(1, Number(process.env.SHEETS_QUOTA_WAIT_SCALE || 1));
const QUOTA_WAITS = { high: [12_000, 20_000, 30_000].map(x => x / QW), normal: [12_000, 20_000].map(x => x / QW), low: [20_000].map(x => x / QW) };

async function limited(kind, fn, args) {
  const limiter = kind === 'write' ? writeLimiter : readLimiter;
  const p = currentPriority();
  const waits = QUOTA_WAITS[p] || QUOTA_WAITS.normal;
  let netRetry = 1;
  for (let attempt = 0; ; attempt++) {
    await limiter.acquire(p);
    try { return await fn(...args); }
    catch (e) {
      if (isQuotaError(e) && attempt < waits.length) {
        limiter.penalize(waits[attempt]);
        console.warn(`sheets ${kind}: лимит Google, пауза ${Math.round(waits[attempt] / 1000)} с (${p}, попытка ${attempt + 1})`);
        continue;   // талон возьмём заново — очередь сама выдержит паузу
      }
      if (isTransient(e) && netRetry-- > 0) { await sleep(800); continue; }
      throw e;
    }
  }
}

// Оборачиваем методы клиента googleapis: чтения и записи идут через диспетчер.
// Встроенные быстрые повторы библиотеки выключены (retry:false): они делали
// три запроса за 4 секунды и только сильнее съедали минутный лимит.
function wrap(client) {
  const ss = client.spreadsheets;
  const kinds = { get: 'read', batchUpdate: 'write' };
  for (const key of Object.keys(kinds)) {
    const orig = ss[key]?.bind(ss);
    if (orig) ss[key] = (...args) => limited(kinds[key], orig, args);
  }
  const values = ss.values;
  const vkinds = { get: 'read', batchGet: 'read', update: 'write', append: 'write', batchUpdate: 'write', clear: 'write' };
  for (const key of Object.keys(vkinds)) {
    const orig = values?.[key]?.bind(values);
    if (orig) values[key] = (...args) => limited(vkinds[key], orig, args);
  }
  return client;
}

// Для тестов: обернуть поддельный клиент тем же диспетчером.
export const __wrapForTest = client => wrap(client);

export function sheets() {
  if (!sheetsClient) sheetsClient = wrap(google.sheets({ version: 'v4', auth: getAuth(), retry: false }));
  return sheetsClient;
}

// Google Диск (только чтение). Сейчас им пользуется галерея сайта. У Диска
// свой лимит, поэтому очередь Таблиц он не занимает.
export function drive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: getAuth() });
    const files = driveClient.files;
    for (const key of ['list', 'get']) {
      const orig = files[key]?.bind(files);
      if (orig) files[key] = async (...args) => {
        for (let attempt = 0; ; attempt++) {
          try { return await orig(...args); }
          catch (e) { if (!isQuotaError(e) || attempt >= 2) throw e; await sleep(1500 * (attempt + 1)); }
        }
      };
    }
  }
  return driveClient;
}
