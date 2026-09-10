// События лиги: тренировки, турниры, вечеринки — всё, на что игрок записывается
// и, если надо, платит. Живёт отдельно от сезонной заявки: ту ветку оплаты мы
// не трогаем, у неё свои листы и свои статусы.
//
// Листы в главной таблице PTF:
//   Event_Registry — карточки событий, по строке на событие;
//   Event_Signups  — записи игроков: гости, статус, сколько заплатил;
//   Transactions   — журнал денег (тот же набор колонок, что в тренерском боте);
//   Balances       — витрина балансов, бот пересчитывает её сам по журналу.
//
// Баланс считаем суммой по журналу, а не храним как единственную правду: строку
// в таблице могут поправить руками, и тогда витрина разъедется, а журнал — нет.
import { ensureExtraSheet, getRows, appendObject, updateObjectByRow } from './sheets.js';
import { nowISO, safe } from './util.js';

// Короткий идентификатор: в callback_data Telegram всего 64 байта.
function uid(n = 8) { return Math.random().toString(36).slice(2, 2 + n) + Date.now().toString(36).slice(-3); }

export const EVENT_SHEETS = {
  registry: 'Event_Registry',
  signups: 'Event_Signups',
  transactions: 'Transactions',
  balances: 'Balances'
};

export const REGISTRY_HEADERS = [
  'event_id', 'status', 'title_ru', 'title_en', 'description_ru', 'description_en',
  'date', 'time', 'place', 'place_url', 'price_thb', 'guest_price_thb', 'capacity', 'signup_deadline',
  'payment_required', 'guests_allowed', 'max_guests', 'refund_hours',
  // Кому уходит карточка: all — всем в боте, active — только активным игрокам,
  // personal — поимённо тем, кто перечислен в invited_ids. Плюс необязательный
  // фильтр по дивизиону. invite_only прячет событие от всех, кроме приглашённых.
  'audience', 'audience_division', 'invite_only', 'invited_ids',
  'created_at', 'published_at', 'created_by'
];
export const SIGNUP_HEADERS = [
  'signup_id', 'event_id', 'telegram_id', 'player_name', 'guests', 'guest_names',
  'status', 'amount_thb', 'paid_thb', 'paid_from', 'created_at', 'updated_at', 'note'
];
export const TX_HEADERS = ['date', 'telegram_id', 'name', 'type', 'amount', 'balance', 'description'];
export const BALANCE_HEADERS = ['telegram_id', 'name', 'balance_thb', 'updated_at'];

// Статусы записи. Новых сущностей не плодим: их ровно столько, сколько шагов
// проходит игрок.
export const SIGNUP_STATUS = {
  pending: 'pending',       // записан, ждёт счёта (когда мест ещё нет или оплата ручная)
  invoiced: 'invoiced',     // счёт выставлен, ждём оплату
  paid: 'paid',             // оплачено и подтверждено
  confirmed: 'confirmed',   // бесплатное событие: место закреплено сразу
  waitlist: 'waitlist',
  cancelled: 'cancelled'
};
const ACTIVE = [SIGNUP_STATUS.pending, SIGNUP_STATUS.invoiced, SIGNUP_STATUS.paid, SIGNUP_STATUS.confirmed];

export const CANCEL_LIMIT_HOURS = 12;

function yes(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'да' || s === '1' || s === 'on';
}
function num(v) { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }

export async function ensureEventSheets() {
  await ensureExtraSheet(EVENT_SHEETS.registry, REGISTRY_HEADERS);
  await ensureExtraSheet(EVENT_SHEETS.signups, SIGNUP_HEADERS);
  await ensureExtraSheet(EVENT_SHEETS.transactions, TX_HEADERS);
  await ensureExtraSheet(EVENT_SHEETS.balances, BALANCE_HEADERS);
  return true;
}

// --- события ---------------------------------------------------------------

function mapEvent(r) {
  return {
    event_id: safe(r.event_id),
    status: safe(r.status).toLowerCase() || 'draft',
    title_ru: safe(r.title_ru), title_en: safe(r.title_en || r.title_ru),
    description_ru: safe(r.description_ru), description_en: safe(r.description_en || r.description_ru),
    date: safe(r.date), time: safe(r.time), place: safe(r.place), place_url: safe(r.place_url),
    price_thb: num(r.price_thb),
    guest_price_thb: String(r.guest_price_thb ?? '').trim() === '' ? null : num(r.guest_price_thb),
    capacity: num(r.capacity),
    signup_deadline: safe(r.signup_deadline),
    payment_required: yes(r.payment_required),
    guests_allowed: yes(r.guests_allowed),
    max_guests: num(r.max_guests) || (yes(r.guests_allowed) ? 1 : 0),
    refund_hours: String(r.refund_hours ?? '').trim() === '' ? CANCEL_LIMIT_HOURS : num(r.refund_hours),
    audience: safe(r.audience).toLowerCase() || 'all',
    audience_division: safe(r.audience_division).toUpperCase(),
    invite_only: yes(r.invite_only),
    // Список приглашённых храним строкой через запятую — отдельный лист ради
    // десятка id заводить незачем.
    invited_ids: safe(r.invited_ids).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean),
    created_at: safe(r.created_at), published_at: safe(r.published_at),
    _rowNumber: r._rowNumber
  };
}

export async function listEvents({ includeDrafts = false } = {}) {
  await ensureEventSheets();
  const { rows } = await getRows(EVENT_SHEETS.registry, { useCache: false });
  return rows
    .filter(r => safe(r.event_id))
    .map(mapEvent)
    .filter(e => includeDrafts || (e.status !== 'draft' && e.status !== 'cancelled'));
}

export async function findEvent(eventId) {
  const all = await listEvents({ includeDrafts: true });
  return all.find(e => e.event_id === String(eventId)) || null;
}

export async function createEvent(data, createdBy = '') {
  await ensureEventSheets();
  const row = {
    event_id: 'evt_' + uid(8),
    status: 'draft',
    title_ru: safe(data.title_ru), title_en: safe(data.title_en),
    description_ru: safe(data.description_ru), description_en: safe(data.description_en),
    date: safe(data.date), time: safe(data.time), place: safe(data.place), place_url: safe(data.place_url),
    price_thb: data.price_thb ?? '', guest_price_thb: data.guest_price_thb ?? '',
    capacity: data.capacity ?? '', signup_deadline: safe(data.signup_deadline),
    payment_required: data.payment_required ? 'TRUE' : 'FALSE',
    guests_allowed: data.guests_allowed ? 'TRUE' : 'FALSE',
    max_guests: data.max_guests ?? '',
    refund_hours: data.refund_hours ?? '',
    audience: safe(data.audience) || 'all',
    audience_division: safe(data.audience_division).toUpperCase(),
    invite_only: data.invite_only ? 'TRUE' : 'FALSE',
    invited_ids: Array.isArray(data.invited_ids) ? data.invited_ids.join(',') : safe(data.invited_ids),
    created_at: nowISO(), published_at: '', created_by: String(createdBy || '')
  };
  await appendObject(EVENT_SHEETS.registry, row, { uniqueBy: 'event_id' });
  return mapEvent(row);
}

export async function updateEvent(eventId, patch) {
  const { rows } = await getRows(EVENT_SHEETS.registry, { useCache: false });
  const row = rows.find(r => safe(r.event_id) === String(eventId));
  if (!row?._rowNumber) return null;
  await updateObjectByRow(EVENT_SHEETS.registry, row._rowNumber, patch);
  return { ...mapEvent(row), ...patch };
}

export async function publishEvent(eventId) {
  return updateEvent(eventId, { status: 'published', published_at: nowISO() });
}

// --- записи ----------------------------------------------------------------

function mapSignup(r) {
  return {
    signup_id: safe(r.signup_id), event_id: safe(r.event_id),
    telegram_id: safe(r.telegram_id), player_name: safe(r.player_name),
    guests: num(r.guests), guest_names: safe(r.guest_names),
    status: safe(r.status).toLowerCase(),
    amount_thb: num(r.amount_thb), paid_thb: num(r.paid_thb),
    paid_from: safe(r.paid_from),
    created_at: safe(r.created_at), updated_at: safe(r.updated_at), note: safe(r.note),
    _rowNumber: r._rowNumber
  };
}

export async function listSignups(eventId = '') {
  await ensureEventSheets();
  const { rows } = await getRows(EVENT_SHEETS.signups, { useCache: false });
  return rows
    .filter(r => safe(r.signup_id))
    .map(mapSignup)
    .filter(s => !eventId || s.event_id === String(eventId));
}

export async function findSignup(eventId, telegramId) {
  const list = await listSignups(eventId);
  return list.find(s => String(s.telegram_id) === String(telegramId) && s.status !== SIGNUP_STATUS.cancelled) || null;
}

// Сколько мест занято: сам игрок плюс его гости. Отменённые не считаются.
export async function takenSeats(eventId) {
  const list = await listSignups(eventId);
  return list
    .filter(s => ACTIVE.includes(s.status))
    .reduce((sum, s) => sum + 1 + (s.guests || 0), 0);
}

export function seatsOf(signup) { return 1 + (signup?.guests || 0); }

// Стоимость участия: сам игрок плюс гости по своей цене (если она задана).
export function priceFor(event, guests = 0) {
  if (!event?.payment_required) return 0;
  const guestPrice = event.guest_price_thb === null ? event.price_thb : event.guest_price_thb;
  return event.price_thb + guestPrice * (guests || 0);
}

export async function createSignup({ event, telegramId, name, guests = 0, guestNames = '', status, amount }) {
  await ensureEventSheets();
  const row = {
    signup_id: 'sg_' + uid(8),
    event_id: event.event_id,
    telegram_id: String(telegramId),
    player_name: safe(name),
    guests: guests || 0,
    guest_names: safe(guestNames),
    status,
    amount_thb: amount || 0,
    paid_thb: 0,
    paid_from: '',
    created_at: nowISO(), updated_at: nowISO(), note: ''
  };
  await appendObject(EVENT_SHEETS.signups, row, { uniqueBy: 'signup_id' });
  return mapSignup(row);
}

export async function updateSignup(signupId, patch) {
  const { rows } = await getRows(EVENT_SHEETS.signups, { useCache: false });
  const row = rows.find(r => safe(r.signup_id) === String(signupId));
  if (!row?._rowNumber) return null;
  const merged = { ...patch, updated_at: nowISO() };
  await updateObjectByRow(EVENT_SHEETS.signups, row._rowNumber, merged);
  return { ...mapSignup(row), ...merged };
}

// --- деньги ----------------------------------------------------------------

export async function getBalance(telegramId) {
  await ensureEventSheets();
  const { rows } = await getRows(EVENT_SHEETS.transactions, { useCache: false });
  return rows
    .filter(r => String(r.telegram_id || '').trim() === String(telegramId))
    .reduce((sum, r) => sum + num(r.amount), 0);
}

export async function allBalances() {
  await ensureEventSheets();
  const { rows } = await getRows(EVENT_SHEETS.transactions, { useCache: false });
  const byId = new Map();
  for (const r of rows) {
    const id = String(r.telegram_id || '').trim();
    if (!id) continue;
    const cur = byId.get(id) || { telegram_id: id, name: safe(r.name), balance: 0 };
    cur.balance += num(r.amount);
    if (safe(r.name)) cur.name = safe(r.name);
    byId.set(id, cur);
  }
  return [...byId.values()].filter(b => b.balance !== 0).sort((a, b) => b.balance - a.balance);
}

export async function transactionsOf(telegramId, limit = 20) {
  await ensureEventSheets();
  const { rows } = await getRows(EVENT_SHEETS.transactions, { useCache: false });
  return rows
    .filter(r => String(r.telegram_id || '').trim() === String(telegramId))
    .map(r => ({ date: safe(r.date), type: safe(r.type), amount: num(r.amount), balance: num(r.balance), description: safe(r.description) }))
    .reverse()
    .slice(0, limit);
}

// Одна операция по балансу. amount со знаком: плюс — пришло, минус — ушло.
export async function addTransaction({ telegramId, name, type, amount, description = '' }) {
  await ensureEventSheets();
  const before = await getBalance(telegramId);
  const after = before + Number(amount || 0);
  await appendObject(EVENT_SHEETS.transactions, {
    date: nowISO(), telegram_id: String(telegramId), name: safe(name),
    type: safe(type), amount: Number(amount || 0), balance: after, description: safe(description)
  });
  await refreshBalanceRow(String(telegramId), safe(name), after);
  return after;
}

// Витрина балансов: чтобы организатору не считать журнал глазами.
async function refreshBalanceRow(telegramId, name, balance) {
  const { rows } = await getRows(EVENT_SHEETS.balances, { useCache: false });
  const row = rows.find(r => String(r.telegram_id || '').trim() === String(telegramId));
  const patch = { telegram_id: String(telegramId), name, balance_thb: balance, updated_at: nowISO() };
  if (row?._rowNumber) await updateObjectByRow(EVENT_SHEETS.balances, row._rowNumber, patch);
  else await appendObject(EVENT_SHEETS.balances, patch, { uniqueBy: 'telegram_id' });
}

// --- отмена ----------------------------------------------------------------

// Сколько часов осталось до начала. Дата в карточке — «14.09.2026», время «18:00».
export function hoursUntil(event, now = Date.now()) {
  const [d, m, y] = String(event?.date || '').split(/[.\-/]/).map(Number);
  if (!d || !m) return null;
  const [hh, mm] = String(event?.time || '').split(':').map(Number);
  const year = y > 2000 ? y : new Date(now).getFullYear();
  const start = new Date(year, m - 1, d, hh || 0, mm || 0).getTime();
  return (start - now) / 3600000;
}

// Возврат по правилу тренерского бота: раньше срока — деньги на депозит,
// позже — сгорают. refund_hours = 0 означает «возвращаем всегда».
export function refundDecision(event, signup, now = Date.now()) {
  const paid = signup?.paid_thb || 0;
  if (paid <= 0) return { refund: 0, burned: 0, late: false };
  const limit = event?.refund_hours ?? CANCEL_LIMIT_HOURS;
  if (limit === 0) return { refund: paid, burned: 0, late: false };
  const left = hoursUntil(event, now);
  if (left === null) return { refund: paid, burned: 0, late: false };
  const late = left < limit;
  return late ? { refund: 0, burned: paid, late: true } : { refund: paid, burned: 0, late: false };
}

// Отмена с гостями: если гости остаются, возвращаем только долю игрока.
export function refundForCancel(event, signup, keepGuests, now = Date.now()) {
  const base = refundDecision(event, signup, now);
  if (!keepGuests || !signup?.guests) return { ...base, keptGuests: 0 };
  const guestPrice = event.guest_price_thb === null ? event.price_thb : event.guest_price_thb;
  const guestsPart = guestPrice * signup.guests;
  const own = Math.max(0, (signup.paid_thb || 0) - guestsPart);
  if (base.late) return { refund: 0, burned: signup.paid_thb || 0, late: true, keptGuests: signup.guests };
  return { refund: own, burned: 0, late: false, keptGuests: signup.guests };
}
