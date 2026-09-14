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
import { MATCHES_SPREADSHEET_ID, DIVISIONS_SPREADSHEET_ID, MATCH_SHEETS, TIMEZONE } from './config.js';
import { nowISO, safe } from './util.js';
import { authorizeSlot, slotScope, sameScope } from './access.js';

const SLOT_HEADERS = [
  'challenge_id', 'match_type', 'status', 'division', 'season', 'group',
  'from_telegram_id', 'from_name', 'from_username',
  'to_telegram_id', 'to_name', 'to_username',
  'dates', 'time_from', 'time_to', 'duration_min', 'courts', 'comment',
  'agreed_date', 'agreed_time', 'agreed_court', 'pending_by', 'round', 'court_confirmed_at', 'court_confirmed_by', 'time_change',
  'chat_id', 'message_thread_id', 'message_id',
  'created_at', 'responded_at', 'cancelled_at',
  'result_status', 'result_by', 'result_winner', 'result_score', 'result_set3_mode',
  'result_photo_file_id', 'result_submitted_at', 'result_confirmed_at', 'result_note',
  'result_prompt_sent_at', 'reminder_sent', 'nudge_sent', 'result_nudge',
  'court_pending_at', 'court_nudge', 'score_nudge'
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
    if (merged.join('|') !== current.join('|')) {
      const props = (meta.data.sheets || []).find(s => s.properties?.title === title)?.properties;
      // Existing Match Slots may have exactly the old number of columns.
      if (props && merged.length > Number(props.gridProperties?.columnCount || current.length)) {
        await sheetsClient().spreadsheets.batchUpdate({
          spreadsheetId: MATCHES_SPREADSHEET_ID,
          requestBody: { requests: [{ updateSheetProperties: {
            properties: { sheetId: props.sheetId, gridProperties: { columnCount: merged.length } },
            fields: 'gridProperties.columnCount'
          } }] }
        });
      }
      await valuesUpdate(`'${title}'!A1:${colToA1(merged.length)}1`, [merged]);
    }
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
  if(title===MATCH_SHEETS.slots)emitMatchChange(null,obj);
}

async function updateRow(title, headers, rowNumber, patch) {
  const head = await ensureSheet(title, headers);
  const rows = await readObjects(title, headers);
  const current = rows.find(r => r._rowNumber === rowNumber) || {};
  const merged = { ...current, ...patch };
  await valuesUpdate(`'${title}'!A${rowNumber}:${colToA1(head.length)}${rowNumber}`, [head.map(h => merged[h] ?? '')]);
  if(title===MATCH_SHEETS.slots)emitMatchChange(current,merged);
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

// --- реестр таблиц дивизионов ------------------------------------------------
// Лист Divisions в таблице матчей: одна строка — один дивизион одного сезона со
// ссылкой на его таблицу. Раньше ссылки лежали россыпью в Settings и их надо было
// заменять при смене сезона; здесь прошлые сезоны просто остаются строками, и
// история матчей всегда знает, в каком дивизионе матч был сыгран.
const REGISTRY_HEADERS = ['season', 'letter', 'group', 'group_title', 'title', 'title_en', 'sheet_url', 'status', 'order'];
let registryCache = { t: 0, v: null };
const REGISTRY_MS = 5 * 60 * 1000;

export function invalidateDivisionRegistry() { registryCache = { t: 0, v: null }; }

// Ссылку можно вставлять целиком — id вытащим сами. Голый id тоже принимаем.
export function spreadsheetIdFromUrl(value = '') {
  const v = safe(value);
  if (!v) return '';
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(v) ? v : '';
}

// Лист Divisions читаем как есть, без создания и правки: это таблица организатора.
// Колонок group / group_title в ней может не быть — тогда дивизион идёт одной
// таблицей, и это нормально.
async function readRegistryRows(spreadsheetId) {
  if (!spreadsheetId) return [];
  const res = await sheetsClient().spreadsheets.values.get({
    spreadsheetId, range: `'${MATCH_SHEETS.divisions}'!A:BZ`
  });
  const values = res.data.values || [];
  const head = (values[0] || []).map(h => safe(h).toLowerCase());
  if (!head.length) return [];
  return values.slice(1).map((r, i) => {
    const o = { _rowNumber: i + 2 };
    head.forEach((h, k) => { if (h) o[h] = r[k] ?? ''; });
    return o;
  });
}

export async function divisionRegistry() {
  if (registryCache.v && Date.now() - registryCache.t < REGISTRY_MS) return registryCache.v;
  let rows = [];
  try {
    rows = await readRegistryRows(DIVISIONS_SPREADSHEET_ID);
    // Если в таблице организатора листа нет, пробуем прежнее место — таблицу матчей бота.
    if (!rows.length && MATCHES_SPREADSHEET_ID && MATCHES_SPREADSHEET_ID !== DIVISIONS_SPREADSHEET_ID) {
      rows = await readObjects(MATCH_SHEETS.divisions, REGISTRY_HEADERS).catch(() => []);
    }
  } catch (e) {
    console.error('divisionRegistry failed:', e.message);
    registryCache = { t: Date.now(), v: [] };
    return [];
  }
  const out = rows
    .map(r => ({
      season: safe(r.season),
      letter: safe(r.letter).toUpperCase(),
      // Дивизион может идти двумя группами: две строки с одной буквой и разными
      // номерами групп, у каждой своя таблица. Пустая группа — обычный дивизион.
      group: safe(r.group),
      group_title: safe(r.group_title),
      group_title_en: safe(r.group_title_en),
      title: safe(r.title),
      title_en: safe(r.title_en || r.title),
      spreadsheet_id: spreadsheetIdFromUrl(r.sheet_url || r.url || r.link || r.sheet_id),
      status: safe(r.status).toLowerCase(),
      order: Number(safe(r.order)) || 0
    }))
    .filter(r => r.season && r.letter && r.spreadsheet_id)
    .filter(r => r.status !== 'off' && r.status !== 'hidden');
  out.sort((a, b) => (a.order - b.order) || a.letter.localeCompare(b.letter) || String(a.group).localeCompare(String(b.group)));
  registryCache = { t: Date.now(), v: out };
  return out;
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
    const access = await authorizeSlot(slot, taker, { joining: true });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
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
      pending_by: String(taker.telegram_id || ''), round: '1', nudge_sent: '',
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

export async function listOpenSlots(division, viewerTelegramId = '', season = '', group = '') {
  if (!division) return [];
  const rows = (await allSlots()).filter(r => String(r.status).toLowerCase() === 'open')
    .filter(r => !r.to_telegram_id || String(r.to_telegram_id) === String(viewerTelegramId))
    .filter(r => !isSlotPast(r));
  const out = [];
  for (const r of rows) {
    const scope = await slotScope(r);
    if (sameScope(scope, { division, season, group })) out.push(r);
  }
  return out.sort((a,b) => firstDateMillis(a) - firstDateMillis(b));
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
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
      round: String(round), nudge_sent: '',
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    const status = String(slot.status || '').toLowerCase();
    if (status === 'accepted') return { ok: false, reason: 'already_accepted', slot };
    if (status !== 'pending') return { ok: false, reason: 'not_pending', slot };
    const waiting = awaitingSide(slot);
    if (String(waiting.id) !== String(actor.telegram_id)) return { ok: false, reason: 'not_your_turn', slot };
    const patch = { status: 'accepted', responded_at: nowISO(), court_pending_at: nowISO(), court_nudge: '', reminder_sent: '', score_nudge: '' };
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    if (String(slot.status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    const waiting = awaitingSide(slot);
    if (String(waiting.id) !== String(actor.telegram_id)) return { ok: false, reason: 'not_your_turn', slot };
    const wasDirect = String(slot.match_type) === 'direct';
    const patch = wasDirect
      ? { status: 'declined', responded_at: nowISO() }
      : { status: 'open', to_telegram_id: '', to_name: '', to_username: '', agreed_date: '', agreed_time: '', agreed_court: '', pending_by: '', round: '', nudge_sent: '', responded_at: nowISO() };
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    if (String(slot.status || '').toLowerCase() !== 'accepted') return { ok: false, reason: 'not_accepted', slot };
    if (slot.court_confirmed_at) return { ok: false, reason: 'already_confirmed', slot };
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    if (String(actor.telegram_id)!==String(slot.from_telegram_id)) return {ok:false,reason:'not_booker',slot};
    const patch = { court_confirmed_at: nowISO(), court_confirmed_by: String(actor.telegram_id || '') };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('court_confirmed', merged, actor, merged.agreed_court || '');
    return { ok: true, slot: merged };
  });
}

// --- время матча -------------------------------------------------------------
// Единая точка расчёта начала и конца: дальше от неё зависят напоминания,
// проверка накладок и автозакрытие протухших окон.
export function slotStartMs(slot) {
  const date = slot.agreed_date || cellToList(slot.dates)[0] || '';
  const time = slot.agreed_time || slot.time_from || '00:00';
  const ms = Date.parse(`${date}T${time}:00+07:00`);
  return Number.isNaN(ms) ? null : ms;
}
export function slotEndMs(slot) {
  const start = slotStartMs(slot);
  return start === null ? null : start + Number(slot.duration_min || 120) * 60000;
}

// Накладка: у игрока уже есть согласованный матч, пересекающийся по времени.
// Два корта одновременно — самая обидная ошибка, ловим её до согласования.
export async function findTimeConflict(telegramId, date, time, durationMin, excludeId = '') {
  const start = Date.parse(`${date}T${time || '00:00'}:00+07:00`);
  if (Number.isNaN(start)) return null;
  const end = start + Number(durationMin || 120) * 60000;
  const id = String(telegramId);
  const rows = await allSlots();
  for (const r of rows) {
    if (String(r.challenge_id) === String(excludeId)) continue;
    if (String(r.status || '').toLowerCase() !== 'accepted') continue;
    if (![String(r.from_telegram_id), String(r.to_telegram_id)].includes(id)) continue;
    const s = slotStartMs(r), e = slotEndMs(r);
    if (s === null) continue;
    if (start < e && s < end) return r;   // интервалы пересекаются
  }
  return null;
}

// Окна с прошедшими датами закрываем сами — иначе они висят в списке вечно.
export async function expireStaleSlots() {
  const rows = await allSlots();
  const now = Date.now();
  const done = [];
  for (const r of rows) {
    const status = String(r.status || '').toLowerCase();
    if (!['open', 'pending'].includes(status)) continue;
    const dates = cellToList(r.dates);
    const last = dates.length ? dates[dates.length - 1] : r.agreed_date;
    const end = Date.parse(`${last}T23:59:00+07:00`);
    if (Number.isNaN(end) || end > now) continue;
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, r._rowNumber, { status: 'expired', cancelled_at: nowISO() });
    await logMatchEvent('expired', r, { telegram_id: r.from_telegram_id, name: r.from_name }, last);
    done.push(r);
  }
  return done;
}

// --- напоминания -------------------------------------------------------------
// Два письма на матч: за сутки и за три часа. Больше не нужно — лишние
// уведомления быстро приучают их не читать.
//
// Всё, что игрок вызвал сам или что случилось прямо сейчас — вызов, отклик,
// внесённый счёт — уходит мгновенно в любое время суток: отложенное уведомление
// рискует потеряться, а пропущенный вызов дороже разбудившего телефона.
//
// А вот ПОВТОРНЫЕ уведомления — те, что бот шлёт по своему таймеру, а не в ответ
// на действие человека — ночью придержим: после 22:30 они ждут восьми утра.
// Ничего не теряется, просто сдвигается: таймер продолжает идти, и утром
// приходит то, что накопилось.
export const NIGHT_FROM_MIN = 22 * 60 + 30;   // 22:30
export const NIGHT_TO_MIN = 8 * 60;           // 08:00

export function isNightHold(now = Date.now(), timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(now));
  const g = (t) => Number(p.find(x => x.type === t).value);
  const minutes = (g('hour') % 24) * 60 + g('minute');
  return minutes >= NIGHT_FROM_MIN || minutes < NIGHT_TO_MIN;
}

export function remindersDue(slot, now = Date.now()) {
  const start = slotStartMs(slot);
  if (start === null) return '';
  const hours = (start - now) / 3600000;
  const sent = String(slot.reminder_sent || '').split(',').filter(Boolean);
  // За три часа до матча — всегда: матч в 08:00 нужно не проспать.
  if (hours >= 2.5 && hours <= 3.5 && !sent.includes('h3')) return 'h3';
  if (hours >= 3.5 && hours <= 28 && !sent.includes('day') && !isNightHold(now)) return 'day';
  return '';
}

export async function listMatchesNeedingReminder(now = Date.now()) {
  const rows = await allSlots();
  return rows
    .filter(r => String(r.status || '').toLowerCase() === 'accepted')
    .filter(r => String(r.result_status || '').toLowerCase() !== 'confirmed')
    .map(r => ({ slot: r, kind: remindersDue(r, now) }))
    .filter(x => x.kind);
}

export async function markReminderSent(challengeId, kind) {
  const slot = await findSlot(challengeId);
  if (!slot) return null;
  const sent = String(slot.reminder_sent || '').split(',').filter(Boolean);
  if (!sent.includes(kind)) sent.push(kind);
  return updateSlot(challengeId, { reminder_sent: sent.join(',') });
}

// Сводка для админа: что происходит с матчами прямо сейчас.
export async function matchesOverview(now = Date.now()) {
  const rows = await allSlots();
  const out = { upcoming: [], awaitingCourt: [], awaitingAnswer: [], awaitingResult: [], openSlots: [] };
  for (const r of rows) {
    const status = String(r.status || '').toLowerCase();
    const result = String(r.result_status || '').toLowerCase();
    if (status === 'open') { out.openSlots.push(r); continue; }
    if (status === 'pending') { out.awaitingAnswer.push(r); continue; }
    if (status !== 'accepted') continue;
    if (result === 'confirmed') continue;
    const start = slotStartMs(r);
    if (start !== null && start < now) {
      if (result === 'pending') out.awaitingResult.push({ ...r, _stage: 'verify' });
      else out.awaitingResult.push({ ...r, _stage: 'missing' });
      continue;
    }
    out.upcoming.push(r);
    if (!r.court_confirmed_at) out.awaitingCourt.push(r);
  }
  const byStart = (a, b) => (slotStartMs(a) || 0) - (slotStartMs(b) || 0);
  out.upcoming.sort(byStart); out.awaitingCourt.sort(byStart); out.awaitingResult.sort(byStart);
  return out;
}

// ---------------------------------------------------------------------------
// Незавершённые этапы: 20 минут, 2 часа, 4 часа, сутки; завершение через 28 часов.
// n1/n2 сохранены для совместимости с уже отправленными напоминаниями.
export const NUDGE_FIRST_H = 2;
export const NUDGE_SECOND_H = 4;
export const NUDGE_CLOSE_H = 28;
const NUDGE_STAGES = [['m20',1/3],['n1',2],['n2',4],['d1',24]];
const marks = cell => String(cell || '').split(',').filter(Boolean);
export function hoursBetween(fromMs,toMs) {
  return Number.isFinite(fromMs)&&Number.isFinite(toMs)?(toMs-fromMs)/3600000:0;
}
export function stageFor(hours,done=[]) {
  if(hours>=NUDGE_CLOSE_H)return done.includes('close')?'':'close';
  // Only the latest due stage: no burst of old reminders after the night hold.
  const due=NUDGE_STAGES.filter(([,h])=>hours>=h).at(-1);
  return due&&!done.includes(due[0])?due[0]:'';
}
function markedThrough(done,stage) {
  const pos=NUDGE_STAGES.findIndex(([name])=>name===stage);
  return [...new Set([...done,...(stage==='close'?NUDGE_STAGES:NUDGE_STAGES.slice(0,pos+1)).map(([name])=>name),stage])].join(',');
}
const nudgeField = scope => ({result:'result_nudge',court:'court_nudge',score:'score_nudge'})[scope]||'nudge_sent';
function courtReset(slot) {
  return slot.court_confirmed_at?{}:{court_pending_at:nowISO(),court_nudge:''};
}
export function reminderStep(slot,scope) {
  const base=[slot.status,slot.result_status,scope];
  if(scope==='negotiation')base.push(slot.responded_at||slot.created_at,slot.pending_by,slot.round,slot.to_telegram_id);
  if(scope==='time')base.push(...String(slot.time_change||'').split('|').slice(0,3));
  if(scope==='court')base.push(slot.court_pending_at||slot.responded_at||slot.created_at,slot.court_confirmed_at,slot.result_status,slot.agreed_date,slot.agreed_time,slot.time_change);
  if(scope==='result')base.push(slot.result_status,slot.result_submitted_at,slot.result_by,slot.result_score);
  if(scope==='score')base.push(slot.result_status,slot.result_prompt_sent_at,slot.agreed_date,slot.agreed_time);
  return JSON.stringify(base.map(v=>String(v??'')));
}
export function stuckItem(slot,now=Date.now()) {
  const status=String(slot.status||'').toLowerCase();
  let item=null,since='',done=[];
  if(status==='pending'||(status==='open'&&slot.match_type==='direct'&&slot.to_telegram_id)) {
    const first=status==='open';
    item={slot,scope:'negotiation',initial:first,
      waiting:first?{id:String(slot.to_telegram_id),name:slot.to_name,username:slot.to_username}:awaitingSide(slot),
      proposer:first?{id:String(slot.from_telegram_id),name:slot.from_name,username:slot.from_username}:proposerSide(slot)};
    since=slot.responded_at||slot.created_at;done=marks(slot.nudge_sent);
  } else if(status==='accepted'&&slot.result_status!=='confirmed') {
    const waitingFor=id=>String(id)===String(slot.from_telegram_id)?slot.to_telegram_id:slot.from_telegram_id;
    const proposal=parseTimeChange(slot.time_change);
    if(slot.result_status==='pending') {
      item={slot,scope:'result',waitingId:waitingFor(slot.result_by)};
      since=slot.result_submitted_at;done=marks(slot.result_nudge);
    } else if(proposal) {
      item={slot,scope:'time',proposal,waitingId:waitingFor(proposal.by)};
      since=proposal.at;done=marks(String(slot.time_change).split('|')[3]);
    } else if(!slot.court_confirmed_at&&slot.match_type!=='manual'&&!slot.result_status) {
      item={slot,scope:'court'};since=slot.court_pending_at||slot.responded_at||slot.created_at;done=marks(slot.court_nudge);
    } else if(slot.result_prompt_sent_at&&!slot.result_status) {
      item={slot,scope:'score'};since=slot.result_prompt_sent_at;done=marks(slot.score_nudge);
    }
  }
  if(!item)return null;
  const stage=stageFor(hoursBetween(Date.parse(since||''),now),done);
  return stage?{...item,stage,step:reminderStep(slot,item.scope)}:null;
}
export async function listStuck(now=Date.now()) {
  if(isNightHold(now))return [];
  return (await allSlots()).map(s=>stuckItem(s,now)).filter(Boolean);
}
export async function isStuckCurrent(item) {
  const slot=await findSlot(item.slot.challenge_id);
  return !!slot&&reminderStep(slot,item.scope)===item.step;
}
export async function markStuckNudge(challengeId,scope,stage,expected=null) {
  return withClaimLock(challengeId,async()=>{
    const slot=await findSlot(challengeId);
    if(!slot||(expected&&reminderStep(slot,scope)!==expected.step))return null;
    if(scope==='time') {
      const [time,by,at,sent]=String(slot.time_change||'').split('|');
      if(!time)return null;
      return updateSlot(challengeId,{time_change:[time,by,at,markedThrough(marks(sent),stage)].join('|')});
    }
    const field=nudgeField(scope);
    return updateSlot(challengeId,{[field]:markedThrough(marks(slot[field]),stage)});
  });
}
// Unconfirmed matchmaking may close; played results are never auto-cancelled.
export async function closeStuckSlot(challengeId,{scope='negotiation',expected=null,now=Date.now()}={}) {
  return withClaimLock(challengeId,async()=>{
    const slot=await findSlot(challengeId);
    if(!slot)return {ok:false,reason:'not_found'};
    if(expected&&reminderStep(slot,scope)!==expected.step)return {ok:false,reason:'stale'};
    const eligible=scope==='court'
      ?slot.status==='accepted'&&!slot.court_confirmed_at&&!slot.result_status&&!slot.time_change
      :slot.status==='pending'||(slot.status==='open'&&slot.match_type==='direct');
    if(!eligible)return {ok:false,reason:'not_pending',slot};
    const dates=cellToList(slot.dates).filter(d=>{
      const end=Date.parse(d+'T'+(slot.time_to||'23:59')+':00+07:00');
      return Number.isFinite(end)&&end>now;
    });
    const backToOpen=slot.match_type==='open'&&dates.length>0;
    const patch=backToOpen?{
      status:'open',dates:listToCell(dates),to_telegram_id:'',to_name:'',to_username:'',
      agreed_date:'',agreed_time:'',agreed_court:'',pending_by:'',round:'',nudge_sent:'',
      court_pending_at:'',court_nudge:'',court_confirmed_at:'',court_confirmed_by:'',
      time_change:'',reminder_sent:'',result_prompt_sent_at:'',score_nudge:'',responded_at:nowISO()
    }:{status:'expired',cancelled_at:nowISO()};
    await updateRow(MATCH_SHEETS.slots,SLOT_HEADERS,slot._rowNumber,patch);
    await logMatchEvent(backToOpen?'claim_expired':'challenge_expired',slot,
      {telegram_id:slot.from_telegram_id,name:slot.from_name},scope==='court'?'корт не подтверждён':'без ответа');
    return {ok:true,slot:{...slot,...patch},previous:slot,backToOpen,scope};
  });
}
export async function dropStuckTimeChange(challengeId,expected=null) {
  return withClaimLock(challengeId,async()=>{
    const slot=await findSlot(challengeId);
    if(!slot||(expected&&reminderStep(slot,'time')!==expected.step))return {ok:false};
    const proposal=parseTimeChange(slot.time_change);if(!proposal)return {ok:false};
    const patch={time_change:'',...courtReset(slot)};
    await updateSlot(challengeId,patch);
    await logMatchEvent('time_change_expired',slot,{telegram_id:proposal.by,name:''},proposal.time);
    return {ok:true,slot:{...slot,...patch},proposal};
  });
}

// ---------------------------------------------------------------------------
// Перенос времени на том же корте.
//
// Площадка в переписке часто предлагает соседний слот. Менять время может только
// тот, кто бронирует, но применяется оно лишь после «Подходит» от соперника —
// поэтому предложение живёт в одной колонке time_change как «HH:MM|кто|когда»,
// а не отдельным статусом. Так же отсекаются устаревшие кнопки: если предложение
// успели заменить, старая кнопка вернёт stale, а не перепишет время задним числом.
// ---------------------------------------------------------------------------
export function parseTimeChange(cell = '') {
  const [time = '', by = '', at = ''] = String(cell || '').split('|');
  return time ? { time, by, at } : null;
}

export async function proposeTimeChange(challengeId, actor = {}, newTime = '') {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    if (String(slot.status || '').toLowerCase() !== 'accepted') return { ok: false, reason: 'not_accepted', slot };
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    const me = String(actor.telegram_id || '');
    if (!sides.includes(me)) return { ok: false, reason: 'not_a_player', slot };
    // Корт бронирует один человек — он же и переносит. До подтверждения корта
    // кнопка есть только у него, после — только у того, кто подтвердил.
    if (String(slot.from_telegram_id) !== me) {
      return { ok: false, reason: 'not_booker', slot };
    }
    if (!/^\d{2}:\d{2}$/.test(String(newTime))) return { ok: false, reason: 'bad_time', slot };
    if (String(newTime) === String(slot.agreed_time || '')) return { ok: false, reason: 'same_time', slot };
    const patch = { time_change: `${newTime}|${me}|${nowISO()}` };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('time_change_proposed', merged, actor, `${slot.agreed_time || '—'} → ${newTime}`);
    return { ok: true, slot: merged, newTime };
  });
}

export async function acceptTimeChange(challengeId, actor = {}, expectedTime = '') {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    const proposal = parseTimeChange(slot.time_change);
    if (!proposal) return { ok: false, reason: 'stale', slot };
    if (expectedTime && proposal.time !== String(expectedTime)) return { ok: false, reason: 'stale', slot };
    const me = String(actor.telegram_id || '');
    const sides = [String(slot.from_telegram_id), String(slot.to_telegram_id)];
    if (!sides.includes(me)) return { ok: false, reason: 'not_a_player', slot };
    // Подтверждает всегда вторая сторона — не тот, кто перенёс.
    if (String(proposal.by) === me) return { ok: false, reason: 'own_proposal', slot };
    const previousTime = slot.agreed_time || '';
    const patch = { agreed_time: proposal.time, time_change: '', reminder_sent:'', ...courtReset(slot) };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('time_changed', merged, actor, `${previousTime || '—'} → ${proposal.time}`);
    return { ok: true, slot: merged, previousTime };
  });
}

export async function rejectTimeChange(challengeId, actor = {}, expectedTime = '') {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    const proposal = parseTimeChange(slot.time_change);
    if (!proposal) return { ok: false, reason: 'stale', slot };
    if (expectedTime && proposal.time !== String(expectedTime)) return { ok: false, reason: 'stale', slot };
    const me = String(actor.telegram_id || '');
    if (String(proposal.by) === me) return { ok: false, reason: 'own_proposal', slot };
    const patch = {time_change:'',...courtReset(slot)};
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    const merged = { ...slot, ...patch };
    await logMatchEvent('time_change_rejected', merged, actor, proposal.time);
    return { ok: true, slot: merged, rejectedTime: proposal.time };
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
    if (r.result_status || r.time_change || (!r.court_confirmed_at && r.match_type!=='manual')) return false;
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
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
      result_confirmed_at: '', result_nudge: '', score_nudge: ''
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
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
    const access = await authorizeSlot(slot, actor, { joining: false });
    if (!access.ok) return access;
    if (!slot.season || !Object.hasOwn(slot, 'group') || (access.scope.group && !slot.group)) {
      await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, { season:access.scope.season, group:access.scope.group });
      Object.assign(slot, { season:access.scope.season, group:access.scope.group });
    }
    if (String(slot.result_status || '').toLowerCase() !== 'pending') return { ok: false, reason: 'not_pending', slot };
    if (String(slot.result_by) === String(actor.telegram_id)) return { ok: false, reason: 'own_result', slot };
    const previous = { ...slot };
    const patch = { result_status: 'disputed', result_confirmed_at: '' };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    await logMatchEvent('result_disputed', slot, actor, slot.result_score);
    return { ok: true, slot: { ...slot, ...patch }, previous };
  });
}

// Организатор отклонил уже подтверждённый счёт — например, выяснилось, что матч
// междивизионный. Возвращаем результат в спор, чтобы игроки внесли его заново,
// а не потеряли молча.
export async function rejectResultByAdmin(challengeId, actor = {}) {
  return withClaimLock(challengeId, async () => {
    const slot = await findSlot(challengeId);
    if (!slot) return { ok: false, reason: 'not_found' };
    const patch = { result_status: 'disputed', result_confirmed_at: '', result_note: 'отклонён организатором' };
    await updateRow(MATCH_SHEETS.slots, SLOT_HEADERS, slot._rowNumber, patch);
    await logMatchEvent('result_rejected_admin', slot, actor, slot.result_score);
    return { ok: true, slot: { ...slot, ...patch } };
  });
}

export { SLOT_HEADERS, LOG_HEADERS };

// Расписание согласованных матчей: только то, что впереди. Прошедшее живёт в
// истории лиги, поэтому сюда не попадает даже с внесённым счётом.
// Корт берём отсюда же — это единственное место, где он вообще хранится.
export async function agreedSchedule(now = Date.now()) {
  const rows = await allSlots();
  return rows
    .filter(r => String(r.status || '').toLowerCase() === 'accepted')
    .filter(r => {
      const start = slotStartMs(r);
      return start !== null && start >= now;
    })
    .map(r => ({
      id: r.challenge_id || '',
      date: r.agreed_date || '',
      time: r.agreed_time || r.time_from || '',
      start: slotStartMs(r),
      end: slotEndMs(r),
      court: r.agreed_court || '',
      court_confirmed: Boolean(r.court_confirmed_at),
      division: r.division || '',
      round: r.round || '',
      p1: { id: String(r.from_telegram_id || ''), name: r.from_name || '' },
      p2: { id: String(r.to_telegram_id || ''), name: r.to_name || '' }
    }))
    .sort((a, b) => (a.start || 0) - (b.start || 0));
}

// Сколько матчей прошло на каждом корте. Считаем по сыгранным слотам, а не по
// согласованным: назначенный, но отменённый матч корт не занимал.
export async function courtUsage(now = Date.now()) {
  const rows = await allSlots();
  const tally = new Map();
  for (const r of rows) {
    if (String(r.status || '').toLowerCase() !== 'accepted') continue;
    const court = String(r.agreed_court || '').trim();
    if (!court) continue;
    const start = slotStartMs(r);
    const played = String(r.result_status || '').toLowerCase() === 'confirmed' || (start !== null && start < now);
    if (!played) continue;
    const cur = tally.get(court) || { court, played: 0, with_score: 0, last: '' };
    cur.played += 1;
    if (String(r.result_status || '').toLowerCase() === 'confirmed') cur.with_score += 1;
    if (r.agreed_date && r.agreed_date > cur.last) cur.last = r.agreed_date;
    tally.set(court, cur);
  }
  return [...tally.values()].sort((a, b) => b.played - a.played);
}

// Поиска накладок здесь больше нет. Он сравнивал поле «корт», а туда попадает
// НАЗВАНИЕ КЛУБА — кортов в клубе несколько, и два матча в один час это норма.
// Проверка давала ложную тревогу на каждом втором вечере.

// Корт по сыгранным матчам, ключ — «дата + пара имён» в любом порядке.
// В журнал результатов корт не пишется, поэтому история лиги его не знает;
// здесь он есть, и этого достаточно, чтобы подставить его на фронте, не трогая
// формулы в таблице результатов.
export async function courtsByPlayedMatch() {
  const rows = await allSlots();
  const map = new Map();
  const norm = (v) => String(v || '').trim().toLowerCase();
  for (const r of rows) {
    const court = String(r.agreed_court || '').trim();
    if (!court || !r.agreed_date) continue;
    if (String(r.status || '').toLowerCase() !== 'accepted') continue;
    const a = norm(r.from_name), b = norm(r.to_name);
    if (!a || !b) continue;
    map.set(`${r.agreed_date}|${[a, b].sort().join('|')}`, court);
  }
  return map;
}
export function courtKey(date, nameA, nameB) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  return `${String(date || '').trim()}|${[norm(nameA), norm(nameB)].sort().join('|')}`;
}

// The same action projection drives Telegram and the mini app.
export function pendingActionsFor(telegramId,rows,now=Date.now()) {
 const id=String(telegramId),items=[],seen=new Set();
 for(const s of rows||[]) {
  if(!s.challenge_id||seen.has(s.challenge_id)||![String(s.from_telegram_id),String(s.to_telegram_id)].includes(id))continue;
  const status=String(s.status||'').toLowerCase();let tab='';
  if(status==='open'&&s.match_type==='direct'&&String(s.to_telegram_id)===id&&!isSlotPast(s))tab='open';
  else if(status==='pending'&&String(awaitingSide(s).id)===id&&!isSlotPast(s))tab='open';
  else if(status==='accepted'&&s.result_status!=='confirmed') {
   const proposal=parseTimeChange(s.time_change);
   if(s.result_status==='pending') {if(String(s.result_by)!==id)tab='res';}
   else if(s.result_status==='disputed') {if(String(s.result_by)===id)tab='res';}
   else if(proposal) {if(String(proposal.by)!==id)tab='mine';}
   else if(!s.court_confirmed_at&&s.match_type!=='manual') {if(String(s.from_telegram_id)===id)tab='mine';}
   else if(slotEndMs(s)!==null&&slotEndMs(s)<=now)tab='res';
  }
  if(tab){seen.add(s.challenge_id);items.push({challenge_id:s.challenge_id,tab});}
 }
 return {total:items.length,open:items.filter(x=>x.tab==='open').length,mine:items.filter(x=>x.tab==='mine').length,res:items.filter(x=>x.tab==='res').length,items};
}
let matchChangeHandler=null;
export function setMatchChangeHandler(handler){matchChangeHandler=handler;}
function emitMatchChange(before,after){
 if(!matchChangeHandler)return;
 const ids=[...new Set([before?.from_telegram_id,before?.to_telegram_id,after?.from_telegram_id,after?.to_telegram_id].filter(Boolean).map(String))];
 // Nudge timestamps and log writes do not trigger keyboard refreshes.
 if(ids.every(id=>JSON.stringify(pendingActionsFor(id,before?[before]:[]))===JSON.stringify(pendingActionsFor(id,[after]))))return;
 try{matchChangeHandler(ids,Object.fromEntries(ids.map(id=>[id,pendingActionsFor(id,before?[before]:[]).total])));}catch(e){console.error('match attention:',e.message);}
}
