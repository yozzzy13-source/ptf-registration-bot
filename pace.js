// Темп сезона: кто отстаёт по матчам и что ему написать.
//
// Раз в неделю (суббота, 13:00 по Пхукету) организатору приходит сводка:
//   · какая идёт неделя сезона, сколько дней до дедлайна регулярки;
//   · по каждому дивизиону — сколько матчей сыграно, назначено, ждут ответа
//     и ещё не договорено;
//   · шорт-лист отстающих: «было → стало» с прошлой сводки;
//   · по отдельному сообщению на каждого отстающего — готовый текст в блоке,
//     который копируется одним нажатием, на языке игрока.
//
// Даты сезона берём из листа Events (строка лиги: event_type = league,
// start_date — старт, end_date — последний день сезона, то есть финалы).
// Дедлайн регулярки считается от конца сезона: за 3 дня для дивизионов с
// одной группой (A, B, Prime) и за 5 дней для дивизионов с группами (C, W):
// у них между регуляркой и финальными выходными ещё четвертьфинал.
// Оба отступа можно поменять в Settings: pace_deadline_days и
// pace_grouped_deadline_days. Так сводка работает из сезона в сезон без правок
// кода — достаточно завести новую строку сезона в Events.
//
// Норма — не «ровно матч в неделю», а доля всех матчей игрока, равная доле
// прошедшего времени: у кого 7 матчей и прошла половина срока, к этому дню
// должно быть 3–4 сыгранных или назначенных. Так одна формула подходит любому
// дивизиону, в том числе W с межгрупповыми парами.
//
// Шорт-лист живёт в листе Pace Watch нашей таблицы. Первое сообщение игроку —
// подробное; если ему уже писали, следующее — короткое и дружеское, в одном из
// нескольких вариантов, чтобы не выглядело рассылкой.
import { TIMEZONE, ADMIN_IDS, SHEETS } from './config.js';
import { getRows, getSetting, setSetting, ensureExtraSheet, appendObjects, updateObjectByRow, sameName } from './sheets.js';
import { normDate } from './matchesdb.js';

const DAY = 86400000;
const SHEET = 'Pace Watch';
const HEADERS = ['season', 'player', 'division', 'group', 'telegram_id', 'added_on', 'base_played', 'base_secured',
  'last_check', 'last_played', 'last_secured', 'messages', 'last_message_on', 'status'];
const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ------------------------------------------------------------- календарь
export const dayIn = (ms = Date.now(), timeZone = TIMEZONE) => new Intl.DateTimeFormat('en-CA',
  { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const isoMs = iso => Date.parse(`${iso}T12:00:00Z`);
export const addDays = (iso, n) => new Date(isoMs(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((isoMs(b) - isoMs(a)) / DAY);

// Строка сезона из Events → календарь. today — ГГГГ-ММ-ДД по Пхукету.
// Берём сезон, который идёт сейчас; если ни один не идёт — последний начавшийся.
export function seasonCalendarFrom(rows = [], today = dayIn(), { deadlineDays = 3, groupedDeadlineDays = 5 } = {}) {
  const seasons = (rows || []).map(r => {
    const type = txt(r.event_type).toLowerCase();
    const id = txt(r.event_id), name = txt(r.event_name_en || r.event_name || r.event_name_ru);
    if (type !== 'league' && !/league|season/i.test(id + ' ' + name)) return null;
    const m = id.match(/(\d+)/) || name.match(/season\s*(\d+)/i);
    const start = normDate(r.start_date), end = normDate(r.end_date);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) return null;
    return { season: m[1], start, end };
  }).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start));
  if (!seasons.length) return null;
  const live = seasons.filter(s => s.start <= today && today <= s.end).pop();
  const pick = live || seasons.filter(s => s.start <= today).pop() || seasons[0];
  const regularEnd = addDays(pick.end, -num(deadlineDays));
  const groupedEnd = addDays(pick.end, -num(groupedDeadlineDays));
  return {
    ...pick, regularEnd, groupedEnd,
    // Финальные выходные — два последних дня сезона.
    finalsStart: addDays(pick.end, -1),
    week: Math.max(1, Math.floor(daysBetween(pick.start, today) / 7) + 1),
    weeks: Math.ceil((daysBetween(pick.start, pick.end) + 1) / 7),
    live: Boolean(live)
  };
}
export async function seasonCalendar(now = Date.now()) {
  const [{ rows }, a, b] = await Promise.all([
    getRows(SHEETS.events, { maxAge: 60_000 }).catch(() => ({ rows: [] })),
    getSetting('pace_deadline_days').catch(() => ''),
    getSetting('pace_grouped_deadline_days').catch(() => '')
  ]);
  return seasonCalendarFrom(rows, dayIn(now), {
    deadlineDays: txt(a) !== '' && Number.isFinite(Number(a)) ? Number(a) : 3,
    groupedDeadlineDays: txt(b) !== '' && Number.isFinite(Number(b)) ? Number(b) : 5
  });
}
// Дедлайн регулярки для дивизиона: у дивизионов с группами — раньше.
export const deadlineFor = (cal, grouped) => (grouped ? cal.groupedEnd : cal.regularEnd);

// ------------------------------------------------------------------ темп
// total — все матчи регулярки игрока, played — сыграны (или W/O),
// pending — счёт внесён и ждёт подтверждения, agreed — назначены на будущее.
export function paceOf({ total = 0, played = 0, pending = 0, agreed = 0 } = {}, cal, deadline, today = dayIn()) {
  const span = Math.max(1, daysBetween(cal.start, deadline));
  const passed = Math.min(1, Math.max(0, daysBetween(cal.start, today) / span));
  const expected = Math.round(total * passed * 10) / 10;
  const done = played + pending;
  const secured = Math.min(total, done + agreed);
  const left = Math.max(0, total - done);
  const daysLeft = Math.max(0, daysBetween(today, deadline));
  const behind = Math.round((expected - secured) * 10) / 10;
  // Под конец срока зазор меньше: за две недели до дедлайна хватает и одного матча.
  const threshold = daysLeft <= 14 ? 1 : 2;
  const lagging = left > 0 && behind >= threshold;
  return { total, played, pending, agreed, done, secured, left, expected, behind, daysLeft, lagging, threshold };
}

// ------------------------------------------------------------- подписи
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
export function timeLeftText(days, ru) {
  if (days <= 0) return ru ? 'последний день' : 'the last day';
  if (days >= 14) { const w = Math.round(days / 7); return ru ? `${w} ${plural(w, 'неделя', 'недели', 'недель')}` : `${w} weeks`; }
  return ru ? `${days} ${plural(days, 'день', 'дня', 'дней')}` : `${days} day${days === 1 ? '' : 's'}`;
}
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dateText = (iso, ru) => { const [, m, d] = iso.split('-').map(Number); return ru ? `${d} ${MONTHS_RU[m - 1]}` : `${d} ${MONTHS_EN[m - 1]}`; };
const firstName = name => txt(name).split(/\s+/)[0] || txt(name);

// Текст игроку. first=true — первое, подробное; иначе короткое и дружеское.
// variant выбирает один из вариантов, чтобы недели не повторяли друг друга.
export function paceMessage({ name, ru, pace, deadline, opponents = [], first = false, variant = 0 }) {
  const n = firstName(name), when = dateText(deadline, ru), left = timeLeftText(pace.daysLeft, ru);
  const agreedRu = pace.agreed ? ` (${pace.agreed} уже ${pace.agreed === 1 ? 'назначен' : 'назначены'})` : '';
  const agreedEn = pace.agreed ? ` (${pace.agreed} already scheduled)` : '';
  const doneLine = ru ? `${pace.done} из ${pace.total}` : `${pace.done} of ${pace.total}`;
  // Сколько нужно в неделю, чтобы успеть: от оставшихся матчей и оставшегося времени.
  const perWeek = pace.left / Math.max(1, pace.daysLeft / 7);
  const rateRu = perWeek <= 1.2 ? 'в среднем нужно около матча в неделю' : `в среднем нужно ${Math.ceil(perWeek)} ${plural(Math.ceil(perWeek), 'матч', 'матча', 'матчей')} в неделю`;
  const rateEn = perWeek <= 1.2 ? 'roughly a match a week' : `about ${Math.ceil(perWeek)} matches a week`;
  if (first) {
    const who = opponents.length ? (ru ? `\nЕщё не сыграны матчи с: ${opponents.join(', ')}.` : `\nStill to play: ${opponents.join(', ')}.`) : '';
    return ru
      ? `Привет, ${n}! Как продвигаются матчи в лиге? 🎾\n`
        + `У тебя сыграно ${doneLine}, осталось ${pace.left}${agreedRu}. Регулярка заканчивается ${when} — это ${left}, так что ${rateRu}.`
        + who
        + `\nНазначить матч можно в боте — «Мои матчи». Если что-то мешает или нужна помощь с соперником — напиши мне.`
      : `Hi ${n}! How are your league matches going? 🎾\n`
        + `You've played ${doneLine}, ${pace.left} to go${agreedEn}. The regular season ends on ${when} — that's ${left}, so ${rateEn}.`
        + who
        + `\nYou can set up a match in the bot under "My matches". If anything is getting in the way or you need help with an opponent, just message me.`;
  }
  const ruV = [
    `Привет, ${n}! Как там с матчами? У тебя ${doneLine}, осталось ${pace.left}${agreedRu}, до конца регулярки ${left} (до ${when}). Если что-то уже договорено — дай знать 🙂`,
    `${n}, привет! Быстрый чек по лиге: сыграно ${doneLine}, впереди ещё ${pace.left}${agreedRu}. Времени — ${left}, до ${when}. Как планы на ближайшие игры?`,
    `Привет! Напоминаю по лиге: ${doneLine} сыграно, осталось ${pace.left}${agreedRu}. До ${when} — ${left}. Получится сыграть на этой неделе? 🎾`
  ];
  const enV = [
    `Hi ${n}! How are the matches going? You're on ${doneLine}, ${pace.left} left${agreedEn}, and ${left} until the regular season ends (${when}). If something's already arranged, let me know 🙂`,
    `Hey ${n}! Quick league check-in: ${doneLine} played, ${pace.left} still to go${agreedEn}. That's ${left} until ${when}. What are your plans for the next games?`,
    `Hi! A little league reminder: ${doneLine} played, ${pace.left} left${agreedEn}. ${left} to go until ${when}. Can you fit a match in this week? 🎾`
  ];
  const list = ru ? ruV : enV;
  return list[Math.abs(variant) % list.length];
}

// ------------------------------------------------------------ данные
// Все игроки сезона с их темпом. Отдельной выборкой, чтобы проверять без отправки.
export async function collectPace(now = Date.now(), cal = null) {
  cal = cal || await seasonCalendar(now);
  if (!cal) return { ok: false, reason: 'no_season' };
  const today = dayIn(now);
  const { seasonRoster, divisionGroups } = await import('./division.js');
  const { getUnplayedOpponents, getDivisionSchedule } = await import('./results.js');
  const { allSlots } = await import('./matchesdb.js');
  const { withdrawnList } = await import('./withdraw.js');
  const roster = await seasonRoster(cal.season);
  const season = String(roster.season || cal.season);
  const [slots, gone, applicants] = await Promise.all([
    allSlots().catch(() => []),
    withdrawnList().catch(() => []),
    getRows(SHEETS.applicants).then(x => x.rows).catch(() => [])
  ]);
  const seasonSlots = slots.filter(s => !txt(s.season) || txt(s.season) === season);
  const groupedCache = new Map();
  const isGrouped = async letter => {
    if (!groupedCache.has(letter)) groupedCache.set(letter, (await divisionGroups(letter, season).catch(() => [])).length > 1);
    return groupedCache.get(letter);
  };
  const players = [];
  for (const p of roster.players || []) {
    if (gone.some(r => txt(r.season) === season && sameName(r.player, p.name))) continue;
    const grouped = await isGrouped(p.letter);
    const deadline = deadlineFor(cal, grouped);
    const left = await getUnplayedOpponents(p.letter, p.name, season, p.group).catch(() => null);
    if (!left?.known) continue;
    const mine = seasonSlots.filter(s => sameName(s.from_name, p.name) || sameName(s.to_name, p.name));
    const open = s => !['confirmed'].includes(txt(s.result_status).toLowerCase());
    const pending = mine.filter(s => txt(s.result_status).toLowerCase() === 'pending'
      && left.names.some(o => sameName(o, sameName(s.from_name, p.name) ? s.to_name : s.from_name))).length;
    const agreed = mine.filter(s => txt(s.status).toLowerCase() === 'accepted' && open(s) && !txt(s.result_status)
      && normDate(s.agreed_date) >= today).length;
    const negotiating = mine.filter(s => txt(s.status).toLowerCase() === 'pending').length;
    const pace = paceOf({ total: left.total, played: left.played, pending, agreed: Math.min(agreed, Math.max(0, left.names.length - pending)) }, cal, deadline, today);
    const a = applicants.find(x => sameName(x.name, p.name));
    players.push({
      name: p.name, letter: p.letter, group: txt(p.group), division: p.division, grouped, deadline,
      telegram_id: txt(a?.telegram_id), username: txt(a?.telegram_username || a?.username).replace(/^@/, ''),
      ru: /^ru/i.test(txt(a?.language)), negotiating,
      opponents: left.names, pace
    });
  }
  // Дивизионы целиком: пары и сколько из них закрыто.
  const divisions = [];
  const seen = new Set();
  for (const p of roster.players || []) {
    const key = p.letter + '|' + txt(p.group);
    if (seen.has(key)) continue; seen.add(key);
    const sched = await getDivisionSchedule(p.letter, season, txt(p.group)).catch(() => []);
    const mates = players.filter(x => x.letter === p.letter && x.group === txt(p.group));
    divisions.push({
      letter: p.letter, group: txt(p.group), division: p.division,
      total: sched.length, played: sched.filter(m => m.played).length,
      // Назначено/ждёт ответа — по игрокам, делим пополам: матч считается у обоих.
      agreed: Math.round(mates.reduce((s, x) => s + x.pace.agreed, 0) / 2),
      negotiating: Math.round(mates.reduce((s, x) => s + x.negotiating, 0) / 2),
      lagging: mates.filter(x => x.pace.lagging).length
    });
  }
  return { ok: true, cal, today, season, players, divisions };
}

// ------------------------------------------------------------ шорт-лист
// Первый шорт-лист — 22 игрока, которым организатор написал 10 октября.
// Заводится один раз, при первой сводке сезона 2: их «было» — темп на момент
// заведения, а первое сообщение уже считается отправленным.
const SEED = { season: '2', on: '2026-10-10', players: ['Roman Vengerak', 'Nikita Secret', 'Michael Gofshteyn', 'Ramon Puchades',
  'Vid Randelovic', 'Ilia Izotov', 'Gerardo Tay', 'Nikita Tati', 'Vlad Konov', 'Dana Kolomoets', 'Nico', 'David Berov',
  'Philipp Meyer-Galow', 'Louie Murray', 'Andrew Petukhov', 'Sergei Sokolov', 'Francois', 'Denys Baranevych',
  'Chris Mitchell', 'Thibault Salaun', 'Elena Ian', 'Masha Geveling'] };

export async function readWatch() {
  await ensureExtraSheet(SHEET, HEADERS).catch(() => {});
  const { rows } = await getRows(SHEET, { useCache: false }).catch(() => ({ rows: [] }));
  return (rows || []).filter(r => txt(r.player));
}

// Что поменять в шорт-листе после сводки. Чистая функция — её проверяют тесты.
//   rows    — строки Pace Watch этого сезона;
//   players — collectPace().players.
// Возвращает: tracked (с прошлой сводки: было → стало), fresh (новые в листе),
// messages (кому писать и каким тоном), updates/appends для таблицы.
export function planWatch(rows = [], players = [], { season, today }) {
  const mine = rows.filter(r => txt(r.season) === String(season));
  const find = name => mine.find(r => sameName(r.player, name));
  const tracked = [], fresh = [], messages = [], updates = [], appends = [];
  for (const r of mine) {
    const p = players.find(x => sameName(x.name, r.player));
    if (!p) continue;
    const before = { played: num(r.last_played || r.base_played), secured: num(r.last_secured || r.base_secured) };
    const was = txt(r.status) || 'active';
    tracked.push({ player: p, before, wasActive: was === 'active', since: txt(r.added_on) });
    const status = p.pace.lagging ? 'active' : 'ok';
    const messaged = num(r.messages);
    const patch = { last_check: today, last_played: p.pace.done, last_secured: p.pace.secured, status };
    if (p.pace.lagging) {
      messages.push({ player: p, first: messaged === 0, variant: messaged });
      patch.messages = messaged + 1; patch.last_message_on = today;
    }
    updates.push({ row: r._rowNumber, patch });
  }
  for (const p of players) {
    if (!p.pace.lagging || find(p.name)) continue;
    fresh.push(p);
    messages.push({ player: p, first: true, variant: 0 });
    appends.push({ season: String(season), player: p.name, division: p.letter, group: p.group, telegram_id: p.telegram_id,
      added_on: today, base_played: p.pace.done, base_secured: p.pace.secured, last_check: today,
      last_played: p.pace.done, last_secured: p.pace.secured, messages: 1, last_message_on: today, status: 'active' });
  }
  return { tracked, fresh, messages, updates, appends };
}

// Первый шорт-лист (22 игрока от 10 октября) — если листа ещё нет.
export function seedRows(rows = [], players = [], { season, today }) {
  if (String(season) !== SEED.season || rows.some(r => txt(r.season) === SEED.season)) return [];
  return SEED.players.map(name => {
    const p = players.find(x => sameName(x.name, name));
    if (!p) return null;
    return { season: SEED.season, player: p.name, division: p.letter, group: p.group, telegram_id: p.telegram_id,
      added_on: SEED.on, base_played: p.pace.done, base_secured: p.pace.secured, last_check: today,
      last_played: p.pace.done, last_secured: p.pace.secured, messages: 1, last_message_on: SEED.on, status: 'active' };
  }).filter(Boolean);
}

// Заводим первый шорт-лист сразу после деплоя, а не в день первой сводки:
// так «было» в сводке — состояние на момент отправки первых сообщений,
// а не через неделю. Повторный вызов ничего не делает.
export async function ensurePaceSeed(now = Date.now()) {
  const cal = await seasonCalendar(now);
  if (!cal || String(cal.season) !== SEED.season) return { ok: false, reason: 'not_needed' };
  const rows = await readWatch();
  if (rows.some(r => txt(r.season) === SEED.season)) return { ok: true, seeded: 0 };
  const data = await collectPace(now, cal);
  if (!data.ok) return data;
  const seed = seedRows(rows, data.players, { season: data.season, today: dayIn(now) });
  if (seed.length) await appendObjects(SHEET, seed);
  return { ok: true, seeded: seed.length, missing: SEED.players.filter(n => !seed.some(r => sameName(r.player, n))) };
}

// --------------------------------------------------------------- сводка
const divName = d => (d.letter === 'PRIME' || d.letter === 'P' ? 'Prime' : d.letter) + (d.group ? d.group : '');
export function digestHeader({ cal, today, divisions, tracked = [], fresh = [], preview = false }) {
  const days = d => Math.max(0, daysBetween(today, d));
  const single = divisions.filter(d => !d.group), grouped = divisions.filter(d => d.group);
  const lines = [];
  lines.push(`<b>📋 Темп сезона ${esc(cal.season)} · неделя ${cal.week} из ${cal.weeks}</b>${preview ? ' · <i>предпросмотр</i>' : ''}`);
  const dl = [];
  if (single.length) dl.push(`${dateText(cal.regularEnd, true)} — ${[...new Set(single.map(divName))].join(', ')} (${timeLeftText(days(cal.regularEnd), true)})`);
  if (grouped.length) dl.push(`${dateText(cal.groupedEnd, true)} — ${[...new Set(grouped.map(d => d.letter))].join(', ')} (${timeLeftText(days(cal.groupedEnd), true)})`);
  if (dl.length) lines.push('Дедлайн регулярки: ' + dl.join(' · '));
  lines.push('');
  lines.push('<b>По дивизионам</b> (сыграно / назначено / ждут ответа / не договорено):');
  for (const d of divisions) {
    const rest = Math.max(0, d.total - d.played - d.agreed - d.negotiating);
    lines.push(`• ${esc(divName(d))}: ${d.played}/${d.total} · ${d.agreed} · ${d.negotiating} · ${rest}${d.lagging ? ` — отстают ${d.lagging}` : ''}`);
  }
  if (tracked.length) {
    lines.push('');
    lines.push('<b>Шорт-лист — с прошлой сводки</b> (сыграно, в скобках — с назначенными):');
    const sorted = tracked.slice().sort((a, b) => Number(b.player.pace.lagging) - Number(a.player.pace.lagging) || a.player.name.localeCompare(b.player.name));
    for (const t of sorted) {
      const p = t.player.pace, up = p.done > t.before.played;
      const mark = !t.player.pace.lagging ? '✅ в норме' : up ? '↗️ двигается' : '⚠️ стоит';
      lines.push(`• ${esc(t.player.name)} (${esc(divName(t.player))}): ${t.before.played} → ${p.done} из ${p.total} (${t.before.secured} → ${p.secured}) ${mark}`);
    }
  }
  if (fresh.length) {
    lines.push('');
    lines.push('<b>Новые в шорт-листе:</b> ' + fresh.map(p => esc(p.name)).join(', '));
  }
  return lines.join('\n');
}
export function digestPlayerMessage(m, { cal } = {}) {
  const p = m.player;
  const link = p.telegram_id ? `<a href="tg://user?id=${esc(p.telegram_id)}">${esc(p.name)}</a>` : esc(p.name);
  const handle = p.username ? ` · @${esc(p.username)}` : '';
  const head = `${m.first ? '🆕' : '🔁'} ${link}${handle} · ${esc(divName(p))} · ${p.pace.done}/${p.pace.total}, назначено ${p.pace.agreed}, норма ~${p.pace.expected} · ${p.ru ? 'RU' : 'EN'}`;
  const text = paceMessage({ name: p.name, ru: p.ru, pace: p.pace, deadline: p.deadline, opponents: p.opponents, first: m.first, variant: m.variant });
  return `${head}\n<pre>${esc(text)}</pre>`;
}

// Суббота, 13:00 по Пхукету; с конца первой недели и до дедлайна регулярки.
export function paceDue(now = Date.now(), cal = null, timeZone = TIMEZONE) {
  if (!cal) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(now));
  const weekday = parts.find(x => x.type === 'weekday')?.value || '';
  const hour = Number(parts.find(x => x.type === 'hour')?.value || -1);
  const today = dayIn(now, timeZone);
  const last = cal.regularEnd > cal.groupedEnd ? cal.regularEnd : cal.groupedEnd;
  return weekday === 'Sat' && hour === 13 && today >= addDays(cal.start, 6) && today <= last;
}

// Получатель — личка организатора (первый из ADMIN_IDS): тексты он пересылает
// сам, в общем админском чате они только мешают. Нет ADMIN_IDS — админский чат.
async function digestChat() {
  if (ADMIN_IDS[0]) return ADMIN_IDS[0];
  const { getAdminChatId } = await import('./admin.js');
  return txt(await getAdminChatId().catch(() => ''));
}

// force — ручной запуск (/pace). save=false — предпросмотр: шорт-лист не меняется.
export async function runPaceDigest(now = Date.now(), { force = false, save = true, chatId = '' } = {}) {
  const cal = await seasonCalendar(now);
  if (!cal) return { ok: false, reason: 'no_season' };
  if (!force && !paceDue(now, cal)) return { ok: false, reason: 'not_due' };
  const today = dayIn(now);
  if (!force) {
    if (txt(await getSetting('pace_digest_last').catch(() => '')) === today) return { ok: false, reason: 'already_done' };
    await setSetting('pace_digest_last', today, 'Дата последней сводки темпа сезона');
  }
  const to = chatId || await digestChat();
  if (!to) return { ok: false, reason: 'no_chat' };
  const data = await collectPace(now, cal);
  if (!data.ok) return data;
  let rows = await readWatch();
  const seed = seedRows(rows, data.players, { season: data.season, today });
  if (seed.length) {
    if (save) { await appendObjects(SHEET, seed); rows = await readWatch(); }
    else rows = rows.concat(seed.map((r, i) => ({ ...r, _rowNumber: -1 - i })));
  }
  const plan = planWatch(rows, data.players, { season: data.season, today });
  const { sendMessage } = await import('./telegram.js');
  await sendMessage(to, digestHeader({ ...data, tracked: plan.tracked, fresh: plan.fresh, preview: !save }));
  // Порядок: сначала повторные (шорт-лист), потом новые — по дивизионам.
  const ordered = plan.messages.slice().sort((a, b) => Number(a.first) - Number(b.first)
    || String(a.player.letter + a.player.group).localeCompare(String(b.player.letter + b.player.group)) || a.player.name.localeCompare(b.player.name));
  for (const m of ordered) {
    await sendMessage(to, digestPlayerMessage(m, data)).catch(e => console.error('pace message failed:', e.message));
    await new Promise(r => setTimeout(r, 80));
  }
  if (!ordered.length) await sendMessage(to, '✅ Отстающих нет — писать никому не нужно.');
  if (save) {
    for (const u of plan.updates) if (u.row > 0) await updateObjectByRow(SHEET, u.row, u.patch).catch(e => console.error('pace watch update failed:', e.message));
    if (plan.appends.length) await appendObjects(SHEET, plan.appends).catch(e => console.error('pace watch append failed:', e.message));
  }
  return { ok: true, sent: ordered.length, tracked: plan.tracked.length, fresh: plan.fresh.length, saved: save };
}
