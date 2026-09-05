// Хранилище матчей — ОТДЕЛЬНАЯ Google-таблица (MATCHES_SPREADSHEET_ID).
//
// Почему отдельно: заявки на матчи и их история растут быстрее всего остального и
// нужны для статистики сезона. Держать их в основной таблице PTF — значит смешивать
// операционные данные (анкеты, оплаты) с журналом лиги. Здесь свои листы, свой лог,
// своя чистка; основная таблица не затрагивается.
//
// Листы:
//   Match Slots — активные и завершённые заявки, одна строка на заявку;
//   Match Log   — журнал только на дозапись: кто, что и когда сделал.
//
// Заявка может нести НЕСКОЛЬКО дат и НЕСКОЛЬКО кортов (хранятся строкой через запятую).
// Отвечающий выбирает конкретную дату и корт — они пишутся в agreed_*.
import { sheets as sheetsClient } from './google.js';
import { MATCHES_SPREADSHEET_ID, MATCH_SHEETS } from './config.js';
import { nowISO, safe } from './util.js';

const SLOT_HEADERS = [
  'challenge_id', 'match_type', 'status', 'division',
  'from_telegram_id', 'from_name', 'from_username',
  'to_telegram_id', 'to_name', 'to_username',
  'dates', 'time_from', 'time_to', 'duration_min', 'courts', 'comment',
  'agreed_date', 'agreed_time', 'agreed_court', 'pending_by', 'round', 'court_confirmed_at', 'court_confirmed_by',
  'chat_id', 'message_thread_id', 'message_id',
  'created_at', 'responded_at', 'cancelled_at',
  'result_status', 'result_by', 'result_winner', 'result_score', 'result_set3_mode',
  'result_photo_file_id', 'result_submitted_at', 'result_confirmed_at', 'result_note',
  'result_prompt_sent_at'
];
const LOG_HEADERS = ['timestamp', 'challenge_id', 'action', 'actor_telegram_id', 'actor_name', 'division', 'details'];

function assertConfigured() {
  if (!MATCHES_SPREADSHEET_ID) {
    throw new Error('MATCHES_SPREADSHEET_ID не задан. Создайте отдельную таблицу для матчей и добавьте её ID в переменные Railway.');
  }
}

function colToA1(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}

async function valuesGet(range) {
  assertConfigured();
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: MATCHES_SPREADSHEET_ID, range });
  return res.data.values || [];
}
async function valuesUpdate(range, values) {
  assertConfigured();
  await sheetsClient().spreadsheets.values.update({
    spreadsheetId: MATCHES_SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', requestBody: { values }
  });
}
async function valuesAppend(range, values) {
  assertConfigured();
  await sheetsClient().spreadsheets.values.append({
    spreadsheetId: MATCHES_SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS', requestBody: { values }
  });
}

// Листы создаём при первом обращении — руками ничего заводить не нужно.
const ready = new Map();
async function ensureSheet(title, headers) {
  if (ready.has(title)) return ready.get(title);
  const task = (async () => {
    assertConfigured();
    const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: MATCHES_SPREADSHEET_ID });
    const exists = (meta.data.sheets || []).some(s => s.properties?.title === title);
    if (!exists) {
      await sheetsClient().spreadsheets.batchUpdate({
        spreadsheetId: MATCHES_SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 2000, columnCount: Math.max(headers.length, 12), frozenRowCount: 1 } } } }] }
      });
    }
    const first = await valuesGet(`'${title}'!A1:BZ1`).catch(() => []);
    const current = first[0] || [];
    const merged = [...current];
    for (const h of headers) if (!merged.includes(h)) merged.push(h);
    if (merged.join('|') !== current.join('|')) await valuesUpdate(`'${title}'!A1:${colToA1(merged.length)}1`, [merged]);
    return merged;
  })().catch(e => { ready.delete(title); throw e; });
  ready.set(title, task);
  return task;
}

async function readObjects(title, headers) {
  await ensureSheet(title, headers);
  const values = await valuesGet(`'${title}'!A:BZ`);
  const head = values[0] || [];
  return values.slice(1).map((r, i) => {
    const o = { _rowNumber: i + 2 };
    head.forEach((h, k) => { o[h] = r[k] ?? ''; });
    return o;
  });
}

async function appendObject(title, headers, obj) {
  const head = await ensureSheet(title, headers);
  await valuesAppend(`'${title}'!A:BZ`, [head.map(h => obj[h] ?? '')]);
}

async function updateRow(title, headers, rowNumber, patch) {
  const head = await ensureSheet(title, headers);
  const rows = await readObjects(title, headers);
  const current = rows.find(r => r._rowNumber === rowNumber) || {};
  const merged = { ...current, ...patch };
  await valuesUpdate(`'${title}'!A${rowNumber}:${colToA1(head.length)}${rowNumber}`, [head.map(h => merged[h] ?? '')]);
}

// --- корты -------------------------------------------------------------------
// Лист Courts в таблице матчей. Нужны только название, адрес и номер WhatsApp —
// цены и депозиты появятся здесь же, когда подключим оплату; лишние колонки не мешают.
export async function getCourts() {
  try {
    const rows = await readObjects(MATCH_SHEETS.courts, ['name', 'address', 'whatsapp']);
    return rows
      .filter(r => (r.name || r.court || r.title))
      .filter(r => !['false','no','0','inactive','нет'].includes(String(r.active ?? r.status ?? 'true').trim().toLowerCase()))
      .map(r => ({
        name: safe(r.name || r.court || r.title),
        address: safe(r.address || r.location),
        // номер вставляют как удобно («66 64 471 8080») — оставляем только цифры
        whatsapp: safe(r.whatsapp || r.phone || r.contact).replace(/[^0-9]/g, ''),
        type: safe(r.type)
      }));
  } catch (e) {
    console.error('getCourts failed:', e.message);
    return [];
  }
}

// --- журнал -----------------------------------------------------------------
export async function logMatchEvent(action, slot = {}, actor = {}, details = '') {
  try {
    await appendObject(MATCH_SHEETS.log, LOG_HEADERS, {
      timestamp: nowISO(),
      challenge_id: slot.challenge_id || '',
      action,
      actor_telegram_id: String(actor.telegram_id || actor.id || ''),
      actor_name: safe(actor.name),
      division: slot.division || '',
      details: safe(details)
    });
  } catch (e) {
    // Журнал не должен ломать основной сценарий.
    console.error('logMatchEvent failed:', e.message);
  }
}

// --- список значений через запятую ------------------------------------------
export function listToCell(list = []) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map(v => String(v || '').trim()).filter(Boolean).join(', ');
}
export function cellToList(cell = '') {
  return String(cell || '').split(',').map(v => v.trim()).filter(Boolean);
}

// --- заявки -----------------------------------------------------------------
export async function createSlot(slot) {
  await appendObject(MATCH_SHEETS.slots, SLOT_HEADERS, slot);
  await logMatchEvent('created', slot, { telegram_id: slot.from_telegram_id, name: slot.from_name },
    `${slot.match_type} · ${slot.dates} ${slot.time_from}-${slot.time_to} · ${slot.courts || 'любой корт'}`);
  return slot;
}

export async function allSlots() {
  return (await readObjects(MATCH_SHEETS.slots, SLOT_HEADERS)).filter(r => r.challenge_id);
}

export async function findSlot(challengeId) {
  const rows = await allSlots();
  return rows.find(r => String(r.challenge_id) === String(challengeId)) || null;
}

export async function updateSlot(challengeId, patch) {
  const rows = await allSlots();
  const found = rows.find(r => String(r.challenge_id) === String(challengeId));
  if (!found) return null;
  await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, found._rowNumber, patch);
  return { ...found, ...patch };
}

// Замок по заявке: два одновременных «Играю» иначе оба прочитают статус open
// и оба запишут себя — окно достанется двоим.
const claimLocks = new Map();
async function withClaimLock(key, fn) {
  const k = String(key || '');
  const prev = claimLocks.get(k) || Promise.resolve();
  let release;
  const cur = new Promise(r => { release = r; });
  claimLocks.set(k, prev.then(() => cur, () => cur));
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    setTimeout(() => { if (claimLocks.get(k) === cur) claimLocks.delete(k); }, 30000).unref?.();
  }
}

// Отклик на окно = предложение конкретных даты/корта. Матч назначается только
// после подтверждения второй стороной (как заявка на тренировку у тренера).
// allowSelf — тестовый режим для админа: позволяет откликнуться на собственное окно,
// чтобы прогнать всю цепочку (отклик → встречное → подтверждение → бронь) в одиночку.
export async function claimSlot(challengeId, taker = {}, choice = {}, opts = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const status = String(slot.status || '').toLowerCase();
    if (status === 'accepted') {
      return { ok: false, reason: String(slot.to_telegram_id) === String(taker.telegram_id) ? 'already_yours' : 'taken', slot };
    }
    if (['cancelled', 'declined', 'expired'].includes(status)) return { ok: false, reason: 'closed', slot };
    if (!opts.allowSelf && String(slot.from_telegram_id) === String(taker.telegram_id)) return { ok: false, reason: 'own', slot };
    if (slot.to_telegram_id && String(slot.to_telegram_id) !== String(taker.telegram_id)) return { ok: false, reason: 'not_for_you', slot };

    const dates = cellToList(slot.dates);
    const courts = cellToList(slot.courts);
    const date = String(choice.date || '').trim() || dates[0] || '';
    if (dates.length && !dates.includes(date)) return { ok: false, reason: 'bad_date', slot };
    const court = String(choice.court || '').trim() || (courts.length === 1 ? courts[0] : '');
    if (courts.length && court && !courts.includes(court)) return { ok: false, reason: 'bad_court', slot };
    // Время выбирает отвечающий, но только внутри интервала автора и так, чтобы
    // матч целиком в него помещался.
    const toMin = (v) => { const [h, mm] = String(v || '').split(':').map(Number); return (h || 0) * 60 + (mm || 0); };
    const time = String(choice.time || '').trim() || slot.time_from || '';
    const dur = Number(slot.duration_min || 120);
    const lo = toMin(slot.time_from || '00:00');
    const hi = toMin(slot.time_to || slot.time_from || '23:59');
    const t = toMin(time);
    if (t < lo || (hi > lo && t + dur > hi)) return { ok: false, reason: 'bad_time', slot };

    const patch = {
      status: 'pending',
      to_telegram_id: String(taker.telegram_id || ''),
      to_name: safe(taker.name),
      to_username: safe(taker.username),
      agreed_date: date, agreed_court: court, agreed_time: time,
      pending_by: String(taker.telegram_id || ''), round: '1',
      responded_at: nowISO()
    };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('proposed', merged, taker, `${date} ${time}${court ? ' · ' + court : ''}`);
    return { ok: true, slot: merged };
  });
}

// --- выборки ----------------------------------------------------------------
function lastDateMillis(slot = {}) {
  const dates = cellToList(slot.dates);
  const last = dates[dates.length - 1] || '';
  const t = String(slot.time_to || slot.time_from || '23:59');
  const ms = Date.parse(`${last}T${t}:00+07:00`);
  return Number.isNaN(ms) ? 0 : ms;
}
function firstDateMillis(slot = {}) {
  const dates = cellToList(slot.dates);
  const ms = Date.parse(`${dates[0] || ''}T${slot.time_from || '00:00'}:00+07:00`);
  return Number.isNaN(ms) ? 0 : ms;
}
export function isSlotPast(slot = {}) {
  const ms = lastDateMillis(slot);
  return ms > 0 && ms < Date.now();
}

export async function listOpenSlots(division, viewerTelegramId = '') {
  const rows = await allSlots();
  return rows
    .filter(r => String(r.status || '').toLowerCase() === 'open')
    .filter(r => !division || !r.division || r.division === division)
    .filter(r => !r.to_telegram_id || String(r.to_telegram_id) === String(viewerTelegramId))
    .filter(r => !isSlotPast(r))
    .sort((a, b) => firstDateMillis(a) - firstDateMillis(b));
}

export async function listMySlots(telegramId) {
  const id = String(telegramId);
  const rows = await allSlots();
  return rows
    .filter(r => String(r.from_telegram_id) === id || String(r.to_telegram_id) === id)
    .filter(r => !['cancelled', 'declined'].includes(String(r.status || '').toLowerCase()))
    .filter(r => !isSlotPast(r))
    .sort((a, b) => firstDateMillis(a) - firstDateMillis(b));
}

// Кто сейчас ждёт ответа: сторона, которая НЕ делала последнее предложение.
export function awaitingSide(slot = {}) {
  const by = String(slot.pending_by || '');
  return by && String(slot.from_telegram_id) === by
    ? { id: String(slot.to_telegram_id), name: slot.to_name, username: slot.to_username }
    : { id: String(slot.from_telegram_id), name: slot.from_name, username: slot.from_username };
}
export function proposerSide(slot = {}) {
  const by = String(slot.pending_by || '');
  return by && String(slot.from_telegram_id) === by
    ? { id: String(slot.from_telegram_id), name: slot.from_name, username: slot.from_username }
    : { id: String(slot.to_telegram_id), name: slot.to_name, username: slot.to_username };
}

// Контрпредложение: другая сторона предлагает свои дату/время/корт. Ходы считаем,
// чтобы переписка не превратилась в бесконечный пинг-понг.
const MAX_ROUNDS = 6;
export async function counterSlot(challengeId, actor = {}, offer = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    const waiting = awaitingSide(slot);
    if (String(waiting.id) !== String(actor.telegram_id)) return { ok: false, reason: 'not_your_turn', slot };
    const round = Number(slot.round || 1) + 1;
    if (round > MAX_ROUNDS) return { ok: false, reason: 'too_many_rounds', slot };
    const patch = {
      agreed_date: String(offer.date || slot.agreed_date || '').trim(),
      agreed_time: String(offer.time || slot.agreed_time || '').trim(),
      agreed_court: String(offer.court ?? slot.agreed_court ?? '').trim(),
      pending_by: String(actor.telegram_id || ''),
      round: String(round),
      responded_at: nowISO()
    };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('countered', merged, actor, `${patch.agreed_date} ${patch.agreed_time}${patch.agreed_court ? ' · ' + patch.agreed_court : ''}`);
    return { ok: true, slot: merged };
  });
}

// Подтверждение последнего предложения — матч назначен.
export async function acceptProposal(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const status = String(slot.status || '').toLowerCase();
    if (status === 'accepted') return { ok: false, reason: 'already_accepted', slot };
    if (status !== 'pending') return { ok: false, reason: 'not_pending', slot };
    const waiting = awaitingSide(slot);
    if (String(waiting.id) !== String(actor.telegram_id)) return { ok: false, reason: 'not_your_turn', slot };
    const patch = { status: 'accepted', responded_at: nowISO() };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('accepted', merged, actor, `${slot.agreed_date} ${slot.agreed_time}${slot.agreed_court ? ' · ' + slot.agreed_court : ''}`);
    return { ok: true, slot: merged };
  });
}

// Отказ от предложения: окно снова свободно и висит в дивизионе.
export async function rejectProposal(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    const waiting = awaitingSide(slot);
    if (String(waiting.id) !== String(actor.telegram_id)) return { ok: false, reason: 'not_your_turn', slot };
    const wasDirect = String(slot.match_type) === 'direct';
    const patch = wasDirect
      ? { status: 'declined', responded_at: nowISO() }
      : { status: 'open', to_telegram_id: '', to_name: '', to_username: '', agreed_date: '', agreed_time: '', agreed_court: '', pending_by: '', round: '', responded_at: nowISO() };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('rejected', { ...slot }, actor);
    return { ok: true, slot: merged, previous: slot };
  });
}

// Корт подтвердил бронь — матч становится полностью активным.
export async function confirmCourt(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.status || '').toLowerCase() !== 'accepted') return { ok: false, reason: 'not_accepted', slot };
    if (slot.court_confirmed_at) return { ok: false, reason: 'already_confirmed', slot };
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    if (!sides.includes(String(actor.telegram_id))) return { ok: false, reason: 'not_a_player', slot };
    const patch = { court_confirmed_at: nowISO(), court_confirmed_by: String(actor.telegram_id || '') };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('court_confirmed', merged, actor, merged.agreed_court || '');
    return { ok: true, slot: merged };
  });
}

// ---------------------------------------------------------------------------
// Результаты матчей.
// Внёсший счёт указывает победителя и сет-счёт; матч засчитывается только после
// подтверждения соперником. Счёт всегда хранится «от игрока from_telegram_id».
// ---------------------------------------------------------------------------

// Матч сыгран (время закончилось), результата ещё нет, напоминание не отправляли.
export async function listMatchesNeedingResultPrompt() {
  const rows = await allSlots();
  return rows.filter(r => {
    if (String(r.status || '').toLowerCase() !== 'accepted') return false;
    if (r.result_status) return false;
    if (r.result_prompt_sent_at) return false;
    const end = Date.parse(`${r.agreed_date}T${r.agreed_time || r.time_from || '00:00'}:00+07:00`);
    if (Number.isNaN(end)) return false;
    return Date.now() > end + Number(r.duration_min || 120) * 60000;
  });
}

export async function markResultPromptSent(challengeId) {
  return updateSlot(challengeId, { result_prompt_sent_at: nowISO() });
}

// Матчи, по которым игрок может внести или подтвердить результат.
export async function listResultTasks(telegramId) {
  const id = String(telegramId);
  const rows = await allSlots();
  return rows.filter(r => {
    if (![String(r.from_telegram_id), String(r.to_telegram_id)].includes(id)) return false;
    if (String(r.status || '').toLowerCase() !== 'accepted') return false;
    const st = String(r.result_status || '').toLowerCase();
    if (st === 'confirmed') return false;
    if (st === 'pending') return true;           // ждёт подтверждения одной из сторон
    const end = Date.parse(`${r.agreed_date}T${r.agreed_time || r.time_from || '00:00'}:00+07:00`);
    return !Number.isNaN(end) && Date.now() > end + Number(r.duration_min || 120) * 60000;
  }).sort((a, b) => String(b.agreed_date).localeCompare(String(a.agreed_date)));
}

// Ручной матч: игроки договорились вне бота. Сразу создаётся согласованным,
// результат так же уходит сопернику на подтверждение.
export async function createManualMatch(row) {
  await appendObject(MATCH_SHEETS.slots, SLOT_HEADERS, row);
  await logMatchEvent('manual_created', row, { telegram_id: row.from_telegram_id, name: row.from_name },
    `${row.agreed_date} ${row.result_score}`);
  return row;
}

export async function submitResult(challengeId, actor = {}, result = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.status || '').toLowerCase() !== 'accepted') return { ok: false, reason: 'not_accepted', slot };
    if (String(slot.result_status || '').toLowerCase() === 'confirmed') return { ok: false, reason: 'already_confirmed', slot };
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    if (!sides.includes(String(actor.telegram_id))) return { ok: false, reason: 'not_a_player', slot };
    const patch = {
      result_status: 'pending',
      result_by: String(actor.telegram_id || ''),
      result_winner: String(result.winner || ''),
      result_score: String(result.score || ''),
      result_set3_mode: String(result.set3Mode || ''),
      result_photo_file_id: String(result.photoFileId || slot.result_photo_file_id || ''),
      result_note: String(result.note || ''),
      result_submitted_at: nowISO(),
      result_confirmed_at: ''
    };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('result_submitted', merged, actor, `${patch.result_score} · победил ${patch.result_winner}`);
    return { ok: true, slot: merged };
  });
}

export async function confirmResult(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.result_status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    // Подтверждает всегда ВТОРАЯ сторона — не та, что вносила счёт.
    if (String(slot.result_by) === String(actor.telegram_id)) return { ok: false, reason: 'own_result', slot };
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    if (!sides.includes(String(actor.telegram_id))) return { ok: false, reason: 'not_a_player', slot };
    const patch = { result_status: 'confirmed', result_confirmed_at: nowISO() };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('result_confirmed', merged, actor, merged.result_score);
    return { ok: true, slot: merged };
  });
}

export async function disputeResult(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    if (String(slot.result_status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    if (String(slot.result_by) === String(actor.telegram_id)) return { ok: false, reason: 'own_result', slot };
    const previous = { ...slot };
    const patch = { result_status: 'disputed', result_confirmed_at: '' };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    await logMatchEvent('result_disputed', slot, actor, slot.result_score);
    return { ok: true, slot: { ...slot, ...patch }, previous };
  });
}

export { SLOT_HEADERS, LOG_HEADERS };
