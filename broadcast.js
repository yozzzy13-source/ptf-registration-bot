// Устойчивая очередь рассылок.
//
// Раньше рассылка была циклом внутри HTTP-запроса: после каждого получателя
// писалась строка в Google Sheets (чтение + запись + сброс общего кэша). На
// 130 получателях это упиралось в лимит Google на чтения, запись «не отправлено»
// падала тоже, ошибка вылетала из цикла — и рассылка обрывалась на 15-м человеке.
//
// Теперь:
//  • запрос лишь ставит рассылку в очередь и сразу отвечает;
//  • очередь и прогресс лежат в Settings (ключ broadcast_jobs) — после
//    перезапуска сервера рассылка продолжается с того же места;
//  • отправка неторопливая (по одному сообщению раз в PACE_MS), ночью пауза;
//  • результаты пишутся в журнал пачками, а не по одному;
//  • временные ошибки (лимиты Telegram, сеть) — повтор позже, а не «не доставлено»;
//  • итог приходит организатору в чат с ботом.
import { withPriority } from './google.js';
import { sendMessage as tgSend, withBulkRetries } from './telegram.js';
import { SHEETS } from './config.js';
import { getRows, setSetting, logBroadcast, logBroadcastResults, updateBroadcastSummary } from './sheets.js';
import { nightWindow, isNightHold } from './matchesdb.js';
import { nowISO, uid, escapeHtml } from './util.js';

export const BROADCAST_JOBS_KEY = 'broadcast_jobs';
const PACE_MS = Number(process.env.BROADCAST_PACE_MS || 1500);      // пауза между получателями
const FLUSH_EVERY = 10;                                              // сколько результатов копим до записи
const FLUSH_MAX_MS = 25_000;                                         // ...или сколько по времени
const MAX_ATTEMPTS = 4;                                              // попыток на одного получателя
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];                  // ожидание между попытками
const NIGHT_POLL_MS = 5 * 60_000;                                    // как часто проверяем, кончилась ли ночь
const STORE_LIMIT = 45_000;                                          // лимит ячейки Sheets — 50 000 знаков
const MAX_FAILURES_KEPT = 40;
const SAME_ERROR_ABORT = 5;                                          // подряд одинаковых отказов «по содержимому»

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kinds = new Map();
let jobs = [];
let pumping = false;
let stopping = false;
let persistTail = Promise.resolve();

// kind: { make(params, job) => async send(contact), afterBatch?(contacts), paceMs?, flushEvery? }
export function registerBroadcastKind(name, def) { kinds.set(name, def); }

function trimContact(c = {}) {
  return {
    telegram_id: String(c.telegram_id || '').trim(),
    name: String(c.name || ''),
    telegram_username: String(c.telegram_username || ''),
    language: String(c.language || '')
  };
}

// ---- хранение ---------------------------------------------------------------
function persist() {
  const active = jobs.filter(j => j.status === 'running');
  const payload = active.length ? JSON.stringify(active) : '';
  // Записи идут строго по очереди: две одновременные затёрли бы друг друга.
  persistTail = persistTail.catch(() => {}).then(() =>
    setSetting(BROADCAST_JOBS_KEY, payload, 'Активные рассылки (служебное, пишется ботом)')
  );
  return persistTail;
}
async function safePersist() {
  try { await persist(); } catch (e) { console.error('broadcast: не удалось сохранить прогресс:', e.message); }
}

// ---- уведомления организатору -----------------------------------------------
async function tell(job, text) {
  const chatId = job.admin?.chatId || job.admin?.id;
  if (!chatId) return;
  try { await tgSend(chatId, text); }
  catch (e) { console.error('broadcast: не удалось написать организатору:', e.message); }
}
// Тихие часы. BROADCAST_QUIET_HOURS=off отключает паузу (для тестов).
function inQuiet(win) {
  if (process.env.BROADCAST_QUIET_HOURS === 'off') return false;
  return win ? isNightHold(Date.now(), undefined, win) : false;
}
function clock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---- классификация ошибок -----------------------------------------------------
export function classifyError(e) {
  const msg = String(e?.message || e || '');
  const code = Number(e?.telegram?.error_code || (msg.match(/"error_code":(\d+)/) || [])[1] || 0);
  const desc = String(e?.telegram?.description || (msg.match(/"description":"([^"]*)"/) || [])[1] || msg);
  const retryAfter = Number(e?.telegram?.parameters?.retry_after || (msg.match(/"retry_after":(\d+)/) || [])[1] || 0);
  if (code === 429 || /too many requests/i.test(desc)) return { kind: 'transient', code: 429, wait: (retryAfter || 30) * 1000 + 2000, desc };
  if (code >= 500 || /bad gateway|gateway timeout|internal server error|service unavailable/i.test(desc)) return { kind: 'transient', code, wait: 0, desc };
  if (!code && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket|network|timeout|timed out|aborted/i.test(msg)) return { kind: 'transient', code: 0, wait: 0, desc };
  // 403 — человек заблокировал бота или удалил аккаунт; 400 chat not found — не начинал диалог.
  if (code === 403 || /blocked|deactivated|chat not found|user not found|PEER_ID_INVALID|have no rights|kicked/i.test(desc)) return { kind: 'gone', code, desc };
  return { kind: 'content', code, desc };
}
function shortReason(c) {
  if (/blocked/i.test(c.desc)) return 'бот заблокирован игроком';
  if (/deactivated/i.test(c.desc)) return 'аккаунт удалён';
  if (/chat not found|user not found|PEER_ID_INVALID/i.test(c.desc)) return 'игрок не запускал бота';
  return String(c.desc || 'ошибка').slice(0, 120);
}

// ---- постановка в очередь ---------------------------------------------------
// admin: { id, name, chatId }. Возвращает { id, recipients } сразу.
export async function enqueueBroadcast({ kind, params = {}, recipients = [], segment = '', messageText = '', mediaType = 'text', admin = {} }) {
  if (!kinds.has(kind)) throw new Error(`Неизвестный вид рассылки: ${kind}`);
  const seen = new Set();
  const contacts = [];
  for (const c of recipients) {
    const t = trimContact(c);
    if (!t.telegram_id || seen.has(t.telegram_id)) continue;
    seen.add(t.telegram_id);
    contacts.push(t);
  }
  if (!contacts.length) throw new Error('Некому отправлять: список получателей пуст');
  const job = {
    id: uid('broadcast'), kind, params, contacts, next: 0, sent: 0, failed: 0, failures: [],
    segment: String(segment || ''), mediaType, status: 'running', createdAt: nowISO(),
    admin: { id: String(admin.id || ''), name: String(admin.name || ''), chatId: String(admin.chatId || admin.id || '') },
    told: {}
  };
  const size = JSON.stringify(job).length + JSON.stringify(jobs.filter(j => j.status === 'running')).length;
  if (size > STORE_LIMIT) throw new Error('Рассылка слишком большая для очереди: сократите текст или число получателей');
  jobs.push(job);
  // Итоговая строка в «Broadcasts» появляется сразу — в «Истории» видно, что рассылка идёт.
  await logBroadcast({
    broadcast_id: job.id, created_at: job.createdAt, admin_id: job.admin.id, admin_name: job.admin.name,
    segment_filter: job.segment, language: 'mixed', message_text: String(messageText || '').slice(0, 4000),
    media_type: mediaType, recipients_count: contacts.length, sent_count: 0, failed_count: 0, status: 'queued'
  }).catch(e => console.error('broadcast: строка истории не записана:', e.message));
  try { await persist(); }   // если сохранить очередь не вышло — честно вернём ошибку, а не «принято»
  catch (e) {
    jobs = jobs.filter(j => j.id !== job.id);
    await updateBroadcastSummary(job.id, { status: 'not_started', notes: 'очередь не сохранилась' }).catch(() => {});
    throw new Error('Не удалось поставить рассылку в очередь (таблица не отвечает). Попробуйте через минуту — ничего не отправлено.');
  }
  const win = await nightWindow().catch(() => null);
  const night = inQuiet(win);
  const minutes = Math.max(1, Math.ceil(contacts.length * (kinds.get(kind).paceMs || PACE_MS) / 60000));
  await tell(job, `📨 <b>Рассылка принята</b>\n\nПолучателей: <b>${contacts.length}</b>\nОтправка идёт в фоне, около ${minutes} мин. Закрывать окно и бота можно — рассылка не прервётся, а после перезапуска сервера продолжится сама.`
    + (night ? `\n\n🌙 Сейчас тихие часы — начну в ${clock(win.to)} (время Пхукета).` : '')
    + `\n\nИтог пришлю сюда.`);
  pump();
  return { id: job.id, recipients: contacts.length, night };
}

// ---- рабочий цикл ------------------------------------------------------------
export function pump() {
  if (pumping || stopping) return;
  pumping = true;
  // Рассылка — фон: в очереди к Google Таблицам она уступает действиям людей.
  withPriority('low', async () => {
    try {
      while (!stopping) {
        const job = jobs.find(j => j.status === 'running');
        if (!job) break;
        await runJob(job);
      }
    } catch (e) {
      console.error('broadcast worker crashed:', e.message);
    } finally {
      pumping = false;
      // Что-то могло прийти, пока цикл заканчивался.
      if (!stopping && jobs.some(j => j.status === 'running')) setTimeout(pump, 5000);
    }
  });
}

async function waitForDay(job) {
  let announced = false;
  for (;;) {
    if (stopping) return false;
    const win = await nightWindow().catch(() => null);
    if (!inQuiet(win)) return true;
    if (!announced && !job.told.night) {
      job.told.night = true;
      await tell(job, `🌙 Тихие часы: рассылка на паузе, продолжу в ${clock(win.to)} (время Пхукета). Уже отправлено ${job.sent}, осталось ${job.contacts.length - job.next}.`);
      await safePersist();
    }
    announced = true;
    await sleep(NIGHT_POLL_MS);
  }
}

async function runJob(job) {
  const def = kinds.get(job.kind);
  if (!def) { await finish(job, 'aborted', `Неизвестный вид рассылки «${job.kind}», остановлена.`); return; }
  let send;
  try { send = await def.make(job.params, job); }
  catch (e) { await finish(job, 'aborted', `Не удалось подготовить рассылку: ${escapeHtml(e.message)}`); return; }

  const pace = def.paceMs || PACE_MS;
  const flushEvery = def.flushEvery || FLUSH_EVERY;
  let buffer = [];           // строки для журнала
  let fresh = [];            // получатели, у которых отправка удалась, — для afterBatch
  let lastFlush = Date.now();
  let sameErr = { text: '', n: 0 };

  const flush = async (force = false) => {
    if (!force && buffer.length < flushEvery && Date.now() - lastFlush < FLUSH_MAX_MS) return;
    lastFlush = Date.now();
    if (buffer.length) {
      try { await logBroadcastResults(buffer); buffer = []; }
      catch (e) { console.error('broadcast: журнал не записан, повторим позже:', e.message); }
    }
    if (fresh.length && def.afterBatch) {
      const batch = fresh; fresh = [];
      try { await def.afterBatch(batch, job); } catch (e) { console.error('broadcast afterBatch:', e.message); }
    } else fresh = [];
    await safePersist();
  };

  while (job.next < job.contacts.length) {
    if (stopping) { await flush(true); return; }
    if (!(await waitForDay(job))) { await flush(true); return; }
    const c = job.contacts[job.next];
    let outcome = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !stopping; attempt++) {
      try {
        await withBulkRetries(() => send(c));
        outcome = { ok: true };
        break;
      } catch (e) {
        const info = classifyError(e);
        if (info.kind === 'transient') {
          outcome = { ok: false, info, gaveUp: true };
          if (attempt < MAX_ATTEMPTS - 1) {
            const wait = Math.max(info.wait || 0, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
            await flush(true);
            await sleep(wait);
            continue;
          }
        } else { outcome = { ok: false, info }; }
        break;
      }
    }
    if (stopping && !outcome?.ok) { await flush(true); return; }
    const ts = nowISO();
    if (outcome?.ok) {
      job.sent++; sameErr = { text: '', n: 0 };
      buffer.push({ broadcast_id: job.id, telegram_id: c.telegram_id, name: c.name, telegram_username: c.telegram_username, status: 'sent', sent_at: ts, error: '', language: c.language, segment_filter: job.segment });
      fresh.push(c);
    } else {
      job.failed++;
      const reason = outcome.gaveUp ? `временная ошибка, не удалось после ${MAX_ATTEMPTS} попыток: ${shortReason(outcome.info)}` : shortReason(outcome.info);
      if (job.failures.length < MAX_FAILURES_KEPT) job.failures.push({ id: c.telegram_id, name: c.name, error: reason });
      buffer.push({ broadcast_id: job.id, telegram_id: c.telegram_id, name: c.name, telegram_username: c.telegram_username, status: 'failed', sent_at: ts, error: reason, language: c.language, segment_filter: job.segment });
      if (outcome.info.kind === 'content') {
        sameErr = sameErr.text === outcome.info.desc ? { text: sameErr.text, n: sameErr.n + 1 } : { text: outcome.info.desc, n: 1 };
      } else sameErr = { text: '', n: 0 };
    }
    job.next++;
    // Одна и та же ошибка «по содержимому» подряд — дело не в получателях, а в тексте.
    if (sameErr.n >= SAME_ERROR_ABORT) {
      await flush(true);
      await finish(job, 'aborted', `Остановил рассылку: ${SAME_ERROR_ABORT} отказов подряд с одной причиной — «${escapeHtml(sameErr.text.slice(0, 160))}». Похоже, проблема в самом сообщении (например, в разметке или кнопке). Исправьте и запустите снова.`);
      return;
    }
    await flush();
    if (job.next < job.contacts.length) await sleep(pace + Math.floor(Math.random() * 400));
  }
  await flush(true);
  for (let i = 0; i < 3 && buffer.length; i++) { await sleep(20_000); await flush(true); }
  await finish(job, 'done');
}

async function finish(job, status, note = '') {
  job.status = status;
  await safePersist();
  const left = job.contacts.length - job.next;
  await updateBroadcastSummary(job.id, {
    sent_count: job.sent, failed_count: job.failed,
    status: status === 'done' ? 'sent' : status,
    notes: (note ? note.replace(/<[^>]+>/g, '') : '').slice(0, 300)
  }).catch(e => console.error('broadcast: итог не записан в историю:', e.message));
  if (status === 'done') {
    const lines = [`✅ <b>Рассылка завершена</b>`, '', `Доставлено: <b>${job.sent}</b> из ${job.contacts.length}`, `Не доставлено: <b>${job.failed}</b>`];
    if (job.failures.length) {
      lines.push('', ...job.failures.slice(0, 25).map(f => `• ${escapeHtml(f.name || f.id)} — ${escapeHtml(f.error)}`));
      if (job.failed > 25) lines.push(`…и ещё ${job.failed - 25} — полный список во вкладке «История».`);
    }
    await tell(job, lines.join('\n'));
  } else {
    await tell(job, `⚠️ <b>Рассылка остановлена</b>\n\nДоставлено: <b>${job.sent}</b>, не доставлено: <b>${job.failed}</b>, осталось: <b>${left}</b>.\n${note}`);
  }
  jobs = jobs.filter(j => j.id !== job.id);
}

// ---- запуск, перезапуск, остановка ---------------------------------------------
// Вызывается на старте сервера: подхватывает незаконченные рассылки.
export async function resumeBroadcasts() {
  let raw = '';
  try {
    const { rows } = await getRows(SHEETS.settings, { useCache: false });
    raw = String(rows.find(r => r.key === BROADCAST_JOBS_KEY)?.value || '').trim();
  } catch (e) { console.error('broadcast: очередь не прочитана:', e.message); return 0; }
  if (!raw) return 0;
  let saved = [];
  try { saved = JSON.parse(raw); } catch { console.error('broadcast: очередь повреждена, пропускаю'); return 0; }
  let count = 0;
  for (const j of Array.isArray(saved) ? saved : []) {
    if (!j?.id || j.status !== 'running' || !kinds.has(j.kind) || jobs.some(x => x.id === j.id)) continue;
    j.told = j.told || {}; j.failures = j.failures || [];
    jobs.push(j);
    count++;
    await tell(j, `🔄 <b>Рассылка продолжается после перезапуска сервера</b>\n\nУже отправлено: ${j.sent}, осталось: ${j.contacts.length - j.next}.`);
  }
  if (count) pump();
  return count;
}

// Перед остановкой сервера (деплой): дописываем прогресс, чтобы после запуска
// продолжить ровно с того места и не слать никому дважды.
export async function flushBroadcasts() {
  stopping = true;
  const deadline = Date.now() + 6000;
  while (pumping && Date.now() < deadline) await sleep(100);
  await safePersist();
}

// Дождаться, пока очередь опустеет и прогресс сохранён (для тестов и остановки).
export async function whenBroadcastsIdle() {
  while (pumping) await sleep(0);
  await persistTail.catch(() => {});
}
export function activeBroadcasts() { return jobs.filter(j => j.status === 'running').map(j => ({ id: j.id, kind: j.kind, next: j.next, total: j.contacts.length })); }
// Для тестов.
export function __resetBroadcastsForTest() { jobs = []; pumping = false; stopping = false; }
