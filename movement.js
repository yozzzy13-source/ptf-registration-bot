// Переходы между дивизионами по итогам регулярки (с сезона 2).
//
// Решает регулярный сезон, а не плей-офф: плей-офф определяет чемпиона и
// награды. Обычные смешанные дивизионы: #1 — автоматическое повышение, #2 —
// стыковой матч с #7 дивизиона выше, #7 — стыковой матч с #2 дивизиона ниже,
// #8 — автоматический вылет. Prime ↔ A: #1 A и #8 Prime меняются местами без
// стыков. Дивизион из двух групп: для повышения сравниваются первые 2 места
// обеих групп, для вылета — последние 2 обеих групп, по обычным критериям
// таблицы; число переходов задаёт граница между дивизионами, а не число групп.
// Из C вылет в D есть всегда: D собирается заново каждый сезон (в сезоне, где
// D нет, — только автоматический вылет худшего, без стыка). W: общий #1 может
// по желанию перейти в C.
//
// Стыковые матчи: на следующий день после финалов бот составляет пары по
// итоговым таблицам и присылает организатору; после подтверждения игроки
// договариваются о матче сами, счёт идёт через бота (стадия «Promotion»).
// Пары и итоги лежат в Settings (promotion_matches). Срок — до начала
// следующего сезона: игрокам напоминание раз в 5 дней, организатору — сводка
// по понедельникам.
import { PUBLIC_URL, ADMIN_IDS } from './config.js';
import { sameName, getSetting, setSetting } from './sheets.js';
import { seasonCalendar, dayIn, addDays, dateText } from './pace.js';

export const MOVEMENT_FROM_SEASON = 2;
const LADDER = ['PRIME', 'A', 'B', 'C', 'D'];
// Вылет из C в D есть всегда: D формируется к каждому сезону.
const RELEGATES_INTO = { C: 'D' };
// Женский дивизион: общий #1 может перейти в этот дивизион.
const WOMEN_UP_TO = 'C';
// Зоны: 2 верхних и 2 нижних места каждой группы (общий #1 и #2 всегда среди них).
export const RACE_SIZE = 2;
export const PROMOTION_STAGE = 'Promotion';
const STORE_KEY = 'promotion_matches';
const PLAYER_REMIND_DAYS = 5;

const txt = v => String(v ?? '').trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nk = s => txt(s).toLowerCase().replace(/\s+/g, ' ');
const letterOf = d => { const k = txt(d).replace(/^(division|дивизион)\s*/i, '').toUpperCase(); return ({ P: 'PRIME', WOMEN: 'W', WOMAN: 'W' })[k] || k; };
export const divTitle = L => (L === 'PRIME' ? 'Prime' : `Division ${L}`);
export const isPromotionSlot = (slot = {}) => /^promo/i.test(txt(slot.stage));
const seasonOk = s => num(s) >= MOVEMENT_FROM_SEASON;

// Стандартные критерии таблицы: очки → победы → разница сетов → разница
// геймов → выигранные сеты.
export const rankPlayers = (a, b) => num(b.points) - num(a.points) || num(b.wins) - num(a.wins)
  || num(b.setDiff) - num(a.setDiff) || num(b.gameDiff) - num(a.gameDiff) || num(b.setsWon) - num(a.setsWon)
  || txt(a.name).localeCompare(txt(b.name));

const rowOf = (p, group) => ({
  name: txt(p.name), photo: txt(p.photo), group: txt(group), place: num(p.place),
  matches: num(p.matches), wins: num(p.wins), losses: num(p.losses), points: num(p.points),
  setDiff: num(p.setDiff ?? (num(p.setsWon) - num(p.setsLost))), gameDiff: num(p.gameDiff ?? (num(p.gamesWon) - num(p.gamesLost))),
  setsWon: num(p.setsWon)
});
const byPlace = list => list.slice().sort((a, b) => a.place - b.place);

// div: { letter, grouped, groups: [{ group, players }] }
function topOf(div) {
  if (!div.grouped) return byPlace(div.groups[0].players.map(p => rowOf(p, '')));
  return div.groups.flatMap(g => byPlace(g.players.map(p => rowOf(p, g.group))).slice(0, RACE_SIZE)).sort(rankPlayers);
}
function bottomOf(div) {
  if (!div.grouped) return byPlace(div.groups[0].players.map(p => rowOf(p, '')));
  return div.groups.flatMap(g => byPlace(g.players.map(p => rowOf(p, g.group))).slice(-RACE_SIZE)).sort(rankPlayers);
}
const placeLabel = (r, ru = true) => r.group ? (ru ? `гр. ${r.group} · #${r.place}` : `gr. ${r.group} · #${r.place}`) : `#${r.place}`;

// Расчёт по таблицам сезона. divs: { LETTER: div }. Возвращает отметки для
// таблиц, списки «борьбы» для дивизионов с группами и пары стыковых матчей.
export function movementFrom(divs = {}, season = '') {
  if (!seasonOk(season)) return null;
  const has = L => divs[L] && divs[L].groups.some(g => g.players.length);
  const mixed = LADDER.filter(has);
  const out = {};
  const poUp = {}, poDown = {};
  const make = L => (out[L] ||= { letter: L, grouped: Boolean(divs[L]?.grouped), marks: {}, top: null, bottom: null, showTop: false, showBottom: false, notes: [] });
  const mark = (L, r, k, to) => { if (!r) return; const m = make(L); if (m.marks[nk(r.name)]) return; m.marks[nk(r.name)] = { k, to }; r.mark = k; r.to = to; };
  mixed.forEach((L, i) => {
    const div = divs[L], m = make(L);
    const above = mixed[i - 1] || '', belowReal = mixed[i + 1] || '', below = belowReal || RELEGATES_INTO[L] || '';
    const top = topOf(div), bottom = div.grouped ? bottomOf(div) : top;
    if (above) {
      mark(L, top[0], 'up', above);
      if (above !== 'PRIME' && top[1]) { mark(L, top[1], 'po_up', above); poUp[L] = top[1]; }
    }
    if (below && bottom.length > 1) {
      const last = bottom[bottom.length - 1], second = bottom[bottom.length - 2];
      mark(L, last, 'down', below);
      if (L !== 'PRIME' && belowReal) { mark(L, second, 'po_down', below); poDown[L] = second; }
    }
    // Зоны подъёма и вылета: группы — 2 верхних / 2 нижних места каждой группы
    // в общем порядке; одна таблица — 2 верхних и 2 нижних места.
    m.top = div.grouped ? top : top.slice(0, RACE_SIZE);
    m.bottom = div.grouped ? bottom : bottom.slice(-RACE_SIZE);
    m.showTop = Boolean(above);
    m.showBottom = true;
    if (L === 'PRIME') m.notes.push('prime');
    if (L === 'A' && above === 'PRIME') m.notes.push('a_prime');
    if (div.grouped) m.notes.push('groups');
    if (!below) m.notes.push('lowest');
    if (RELEGATES_INTO[L] && !belowReal) m.notes.push('forms_' + RELEGATES_INTO[L]);
  });
  if (has('W')) {
    const div = divs.W, m = make('W'), top = topOf(div);
    mark('W', top[0], 'opt', WOMEN_UP_TO);
    m.top = div.grouped ? top : top.slice(0, RACE_SIZE);
    m.showTop = true;
    m.notes.push('women');
    if (div.grouped) m.notes.push('groups');
  }
  const duels = [];
  for (let i = 0; i + 1 < mixed.length; i++) {
    const upper = mixed[i], lower = mixed[i + 1];
    if (upper === 'PRIME' || !poDown[upper] || !poUp[lower]) continue;
    const u = poDown[upper], l = poUp[lower];
    duels.push({ key: `${upper}-${lower}`, upper, lower,
      upper_player: u.name, upper_photo: u.photo, upper_label: placeLabel(u), upper_label_en: placeLabel(u, false),
      lower_player: l.name, lower_photo: l.photo, lower_label: placeLabel(l), lower_label_en: placeLabel(l, false) });
  }
  return { season: String(season), divisions: out, duels };
}

// Таблицы сезона из таблиц дивизионов (кэш getDivisionTable — минута).
async function loadSeason(season) {
  const { availableDivisions, divisionGroups, getDivisionTable } = await import('./division.js');
  const divs = {};
  for (const raw of await availableDivisions(season).catch(() => [])) {
    const L = letterOf(raw);
    const groups = await divisionGroups(raw, season).catch(() => []);
    if (groups.length > 1) {
      const parts = [];
      for (const g of groups) {
        const t = await getDivisionTable(raw, season, g.group).catch(() => null);
        if (t?.ok) parts.push({ group: txt(g.group), players: (t.players || []).filter(p => txt(p.name)) });
      }
      if (parts.length) divs[L] = { letter: L, grouped: true, groups: parts };
    } else {
      const t = await getDivisionTable(raw, season).catch(() => null);
      if (t?.ok) divs[L] = { letter: L, grouped: false, groups: [{ group: '', players: (t.players || []).filter(p => txt(p.name)) }] };
    }
  }
  return divs;
}
const cache = new Map();
export async function seasonMovement(season = '', { fresh = false } = {}) {
  const { latestSeason } = await import('./division.js');
  const s = txt(season) || txt(await latestSeason().catch(() => ''));
  if (!seasonOk(s)) return null;
  const hit = cache.get(s);
  if (!fresh && hit && Date.now() - hit.t < 60_000) return hit.v;
  const v = movementFrom(await loadSeason(s), s);
  cache.set(s, { t: Date.now(), v });
  return v;
}
export function forgetMovement() { cache.clear(); }

// ------------------------------------------------------------ хранилище пар
export async function readStore() {
  try { return JSON.parse(txt(await getSetting(STORE_KEY)) || '{}') || {}; } catch { return {}; }
}
async function writeStore(store) {
  await setSetting(STORE_KEY, JSON.stringify(store), 'Стыковые матчи: пары и итоги (пишет бот)');
  forgetMovement();
}
export async function seasonPairs(season) {
  const store = await readStore();
  return store[String(season)]?.pairs || [];
}

// Стыки для сайта: после составления пар — настоящие (статус, счёт, время),
// до того — предварительные по текущим таблицам.
export async function siteDuels(season, mv = null) {
  const real = await seasonPairs(season);
  if (real.length) {
    const slots = await import('./matchesdb.js').then(m => m.allSlots()).catch(() => []);
    return real.map(p => {
      const live = slots.find(s => isPromotionSlot(s) && txt(s.status).toLowerCase() === 'accepted' && !txt(s.result_status)
        && ((sameName(s.from_name, p.upper_player) && sameName(s.to_name, p.lower_player)) || (sameName(s.from_name, p.lower_player) && sameName(s.to_name, p.upper_player))));
      return { ...p, preview: false, date: txt(live?.agreed_date), time: txt(live?.agreed_time), court: txt(live?.agreed_court) };
    });
  }
  return ((mv || await seasonMovement(season))?.duels || []).map(d => ({ ...d, preview: true, status: 'preview' }));
}

// Итоги сезона для «Повышений / Понижений»: автоматические переходы, итоги
// стыков и wildcard (не в Prime).
export async function seasonResults(season, { wildcards = [] } = {}) {
  const mv = await seasonMovement(season);
  if (!mv) return null;
  const promoted = [], relegated = [], pending = [];
  for (const d of Object.values(mv.divisions)) {
    const rows = [...(d.top || []), ...(d.bottom || [])];
    for (const [key, m] of Object.entries(d.marks)) {
      const r = rows.find(x => nk(x.name) === key) || { name: key };
      if (m.k === 'up') promoted.push({ name: r.name, photo: r.photo || '', from: d.letter, to: m.to, via: 'auto' });
      if (m.k === 'opt') promoted.push({ name: r.name, photo: r.photo || '', from: d.letter, to: m.to, via: 'optional' });
      if (m.k === 'down') relegated.push({ name: r.name, photo: r.photo || '', from: d.letter, to: m.to, via: 'auto' });
    }
  }
  for (const p of await seasonPairs(season)) {
    if (!p.winner) { pending.push(p); continue; }
    const upWon = sameName(p.winner, p.upper_player);
    if (!upWon) {
      promoted.push({ name: p.lower_player, photo: p.lower_photo || '', from: p.lower, to: p.upper, via: 'playoff' });
      relegated.push({ name: p.upper_player, photo: p.upper_photo || '', from: p.upper, to: p.lower, via: 'playoff' });
    }
  }
  for (const w of wildcards) {
    if (!w.to || w.to === 'PRIME' || promoted.some(x => sameName(x.name, w.name))) continue;
    promoted.push({ ...w, via: 'wildcard', wildcard: true });
  }
  return { promoted, relegated, pending };
}

// ------------------------------------------------------------ сообщения
async function people() {
  const { getRows } = await import('./sheets.js');
  const { SHEETS } = await import('./config.js');
  return ((await getRows(SHEETS.applicants).catch(() => ({ rows: [] }))).rows || []).filter(a => txt(a.telegram_id) && txt(a.name));
}
async function adminSay(text, extra = {}) {
  try {
    const { sendMessage } = await import('./telegram.js');
    const to = ADMIN_IDS[0] || txt(await (await import('./admin.js')).getAdminChatId().catch(() => ''));
    if (to) await sendMessage(to, text, extra);
  } catch (e) { console.error('promotion admin note failed:', e.message); }
}
const nextSeasonStart = async () => {
  const cal = await seasonCalendar().catch(() => null);
  const { getRows } = await import('./sheets.js');
  const { SHEETS } = await import('./config.js');
  const { normDate } = await import('./matchesdb.js');
  const rows = (await getRows(SHEETS.events, { maxAge: 60_000 }).catch(() => ({ rows: [] }))).rows || [];
  const starts = rows.filter(r => /league|season/i.test(`${r.event_type} ${r.event_id} ${r.event_name_en || r.event_name}`))
    .map(r => normDate(r.start_date)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!cal || d > cal.end)).sort();
  return starts[0] || '';
};
function playerText(p, me, ru, until) {
  const iAmUpper = sameName(me, p.upper_player);
  const opp = iAmUpper ? p.lower_player : p.upper_player;
  const oppDiv = divTitle(iAmUpper ? p.lower : p.upper);
  const oppLabel = iAmUpper ? (ru ? p.lower_label : p.lower_label_en) : (ru ? p.upper_label : p.upper_label_en);
  const by = until ? (ru ? `до начала следующего сезона (${dateText(until, true)})` : `before the next season starts (${dateText(until, false)})`) : (ru ? 'до начала следующего сезона' : 'before the next season starts');
  return ru
    ? `🎾 <b>Стыковой матч</b>\n\nПо итогам регулярки ты играешь стыковой матч с <b>${esc(opp)}</b> (${esc(oppDiv)}, ${esc(oppLabel)}).\n\nПобедитель играет в следующем сезоне в <b>${esc(divTitle(p.upper))}</b>, проигравший — в <b>${esc(divTitle(p.lower))}</b>.\n\nДоговоритесь о времени и корте и внесите счёт через бота — как в обычном матче. Сыграть нужно ${by}.`
    : `🎾 <b>Promotion playoff</b>\n\nBased on the regular season you play a promotion playoff against <b>${esc(opp)}</b> (${esc(oppDiv)}, ${esc(oppLabel)}).\n\nThe winner plays next season in <b>${esc(divTitle(p.upper))}</b>, the loser in <b>${esc(divTitle(p.lower))}</b>.\n\nAgree on the time and court and submit the score through the bot, just like a regular match. Play it ${by}.`;
}
async function tellPlayers(p, make) {
  const { sendMessage } = await import('./telegram.js');
  const all = await people();
  let sent = 0;
  for (const [me, opp] of [[p.upper_player, p.lower_player], [p.lower_player, p.upper_player]]) {
    const a = all.find(x => sameName(x.name, me));
    if (!a) continue;
    const o = all.find(x => sameName(x.name, opp));
    const ru = /^ru/i.test(a.language);
    const markup = o && PUBLIC_URL ? { reply_markup: { inline_keyboard: [[{ text: ru ? '🎾 Назначить матч' : '🎾 Arrange the match', web_app: { url: `${PUBLIC_URL}/match?opponent=${encodeURIComponent(o.telegram_id)}` } }]] } } : {};
    const text = await make(me, ru);
    if (!text) continue;
    await sendMessage(a.telegram_id, text, markup).then(() => sent++).catch(e => console.error('promotion notice failed:', e.message));
  }
  return sent;
}
const pairLine = p => `• ${esc(divTitle(p.upper))} ${esc(p.upper_label)} <b>${esc(p.upper_player)}</b> — ${esc(divTitle(p.lower))} ${esc(p.lower_label)} <b>${esc(p.lower_player)}</b>`;

// Составить пары по итоговым таблицам и отдать организатору на подтверждение.
export async function proposePairs(season) {
  const mv = await seasonMovement(season, { fresh: true });
  const duels = mv?.duels || [];
  const store = await readStore();
  if (store[String(season)]?.pairs?.length) return { ok: false, reason: 'exists' };
  if (!duels.length) return { ok: false, reason: 'no_pairs' };
  store[String(season)] = { created_at: new Date().toISOString(), pairs: duels.map(d => ({ ...d, status: 'proposed', winner: '', score: '', wo: false, challenge_id: '' })) };
  await writeStore(store);
  await adminSay(`🎾 <b>Стыковые матчи · сезон ${esc(season)}</b>\n\nПары по итоговым таблицам регулярки:\n${store[String(season)].pairs.map(pairLine).join('\n')}\n\nПосле подтверждения игроки получат сообщение и сами договорятся о времени и корте.`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить и разослать', callback_data: `promo_ok:${season}` }]] } });
  return { ok: true, pairs: store[String(season)].pairs };
}
export async function confirmPairs(season, actor = {}) {
  const store = await readStore();
  const s = store[String(season)];
  if (!s?.pairs?.length) return { ok: false, reason: 'no_pairs' };
  if (s.confirmed_at) return { ok: false, reason: 'already' };
  s.confirmed_at = new Date().toISOString();
  s.confirmed_by = txt(actor.telegram_id || actor.id);
  const today = dayIn();
  for (const p of s.pairs) { p.status = 'confirmed'; p.reminded_on = today; }
  await writeStore(store);
  const until = await nextSeasonStart().catch(() => '');
  let sent = 0;
  for (const p of s.pairs) sent += await tellPlayers(p, (me, ru) => playerText(p, me, ru, until));
  return { ok: true, pairs: s.pairs, sent };
}

// Счёт стыкового матча (вызывается при записи подтверждённого результата).
export async function recordPromotionResult(slot = {}) {
  const store = await readStore();
  const winnerName = !slot.result_winner ? '' : String(slot.result_winner) === String(slot.from_telegram_id) ? slot.from_name : slot.to_name;
  for (const [season, s] of Object.entries(store)) {
    const p = (s.pairs || []).find(x => (sameName(x.upper_player, slot.from_name) && sameName(x.lower_player, slot.to_name)) || (sameName(x.upper_player, slot.to_name) && sameName(x.lower_player, slot.from_name)));
    if (!p) continue;
    p.winner = txt(winnerName); p.score = txt(slot.result_score); p.wo = false;
    p.challenge_id = txt(slot.challenge_id); p.played_at = txt(slot.agreed_date) || dayIn(); p.status = 'done';
    await writeStore(store);
    await adminSay(`🎾 Стыковой матч сыгран: <b>${esc(p.winner)}</b> ${esc(p.score)} · победитель играет в ${esc(divTitle(p.upper))}.`);
    return { ok: true, season, pair: p };
  }
  return { ok: false, reason: 'no_pair' };
}
// Неявка или отказ: техническая победа одному из пары (организатор).
export async function walkoverPair(season, key, side, actor = {}) {
  const store = await readStore();
  const p = (store[String(season)]?.pairs || []).find(x => x.key === key);
  if (!p) return { ok: false, reason: 'no_pair' };
  if (p.winner) return { ok: false, reason: 'done', pair: p };
  p.winner = side === 'upper' ? p.upper_player : p.lower_player;
  p.score = 'W/O'; p.wo = true; p.status = 'done'; p.played_at = dayIn(); p.decided_by = txt(actor.telegram_id || actor.id);
  await writeStore(store);
  await tellPlayers(p, (me, ru) => {
    const won = sameName(me, p.winner);
    const next = divTitle(won ? p.upper : p.lower);
    return ru
      ? `🎾 <b>Стыковой матч</b>\n\nОрганизатор засчитал техническую ${won ? 'победу тебе' : 'победу сопернику'} (W/O).\nВ следующем сезоне ты играешь в <b>${esc(next)}</b>.`
      : `🎾 <b>Promotion playoff</b>\n\nThe organiser recorded a walkover ${won ? 'in your favour' : 'for your opponent'}.\nNext season you play in <b>${esc(next)}</b>.`;
  });
  return { ok: true, pair: p };
}

// Раз в 15 минут из общего прохода: составить пары на следующий день после
// финалов, напомнить игрокам и организатору о несыгранных стыках.
export async function runPromotionSweep(now = Date.now()) {
  const cal = await seasonCalendar(now).catch(() => null);
  const today = dayIn(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(new Date(now)));
  if (cal && seasonOk(cal.season) && today >= addDays(cal.end, 1) && hour >= 10) {
    const store = await readStore();
    if (!store[String(cal.season)]) await proposePairs(cal.season).catch(e => console.error('promotion pairs failed:', e.message));
  }
  const store = await readStore();
  const open = [];
  for (const [season, s] of Object.entries(store)) {
    if (!s.confirmed_at) continue;
    for (const p of s.pairs || []) if (!p.winner) open.push({ season, p });
  }
  if (!open.length) return { ok: true, open: 0 };
  const slots = await import('./matchesdb.js').then(m => m.allSlots()).catch(() => []);
  const agreedFor = p => slots.find(s => txt(s.status).toLowerCase() === 'accepted' && !txt(s.result_status)
    && ((sameName(s.from_name, p.upper_player) && sameName(s.to_name, p.lower_player)) || (sameName(s.from_name, p.lower_player) && sameName(s.to_name, p.upper_player))));
  let changed = false;
  // Игрокам — раз в 5 дней, днём, пока матч не договорён.
  if (hour >= 11 && hour < 20) {
    const until = await nextSeasonStart().catch(() => '');
    for (const { p } of open) {
      if (agreedFor(p)) continue;
      if (p.reminded_on && addDays(p.reminded_on, PLAYER_REMIND_DAYS) > today) continue;
      p.reminded_on = today; changed = true;
      await tellPlayers(p, (me, ru) => (ru ? '⏰ <b>Напоминание</b>\n\n' : '⏰ <b>Reminder</b>\n\n') + playerText(p, me, ru, until).replace(/^🎾 <b>[^<]+<\/b>\n\n/, ''));
    }
  }
  // Организатору — по понедельникам, сводка висящих стыков.
  const monday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(new Date(now)) === 'Mon';
  const s0 = store.__admin || {};
  if (monday && hour >= 10 && s0.summary_on !== today) {
    store.__admin = { ...s0, summary_on: today }; changed = true;
    const all = await people();
    const contact = name => { const a = all.find(x => sameName(x.name, name)); return a?.telegram_username ? `https://t.me/${txt(a.telegram_username).replace(/^@/, '')}` : ''; };
    const lines = open.map(({ season, p }) => {
      const a = agreedFor(p);
      const since = p.confirmed_at || store[season]?.confirmed_at || '';
      const days = since ? Math.max(0, Math.round((Date.parse(today) - Date.parse(since.slice(0, 10))) / 86400000)) : 0;
      return `${pairLine(p)}\n   ${a ? `назначен: ${esc(a.agreed_date)} ${esc(a.agreed_time)}` : 'не договорились'} · висит ${days} дн.`;
    });
    const kb = [];
    for (const { season, p } of open) {
      const row = [];
      for (const name of [p.upper_player, p.lower_player]) { const u = contact(name); if (u) row.push({ text: `✉️ ${name.split(' ')[0]}`, url: u }); }
      if (row.length) kb.push(row);
      kb.push([{ text: `W/O → ${p.upper_player.split(' ')[0]}`, callback_data: `promo_wo:${season}:${p.key}:upper` }, { text: `W/O → ${p.lower_player.split(' ')[0]}`, callback_data: `promo_wo:${season}:${p.key}:lower` }]);
    }
    await adminSay(`🎾 <b>Стыковые матчи ещё не сыграны</b>\n\n${lines.join('\n')}\n\nИгрокам напоминаю раз в ${PLAYER_REMIND_DAYS} дней. Неявка или отказ — W/O кнопкой ниже.`, { reply_markup: { inline_keyboard: kb } });
  }
  if (changed) await writeStore(store);
  return { ok: true, open: open.length };
}

// Для страницы дивизиона: отметки, «борьба» групп и стыки этого дивизиона.
export async function movementFor(letter, season) {
  const mv = await seasonMovement(season).catch(e => { console.error('movement failed:', e.message); return null; });
  if (!mv) return null;
  const L = letterOf(letter), d = mv.divisions[L];
  if (!d) return null;
  const duels = (await siteDuels(mv.season, mv).catch(() => [])).filter(x => x.upper === L || x.lower === L);
  return { ...d, season: mv.season, duels };
}

// Пара из подтверждённых стыковых матчей (в любом сезоне хранилища).
export async function isPromotionPair(a, b) {
  const store = await readStore();
  return Object.values(store).some(s => s?.confirmed_at && (s.pairs || []).some(p =>
    (sameName(p.upper_player, a) && sameName(p.lower_player, b)) || (sameName(p.upper_player, b) && sameName(p.lower_player, a))));
}
