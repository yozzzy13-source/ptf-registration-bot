// Снятие игрока с сезона лиги.
//
// Игрок сыграл часть матчей и выбыл. Что делаем:
//   · все его НЕсыгранные матчи — в группе и межгрупповые (W) — записываем
//     как W/O: сопернику победа и 3 очка, снявшемуся поражение и 0, сеты и
//     геймы никому не идут. В таблице дивизиона это колонки P1/P2 TechLoss
//     (тот же механизм, что у технического результата), в шахматке матчей
//     клетка показывает «W/O»;
//   · в общий журнал лиги эти матчи НЕ пишем: матч не сыгран, поэтому в
//     истории матчей игроков, на сайте и в Fantasy его нет — он живёт только
//     в турнирной таблице;
//   · сыгранные матчи остаются как есть;
//   · игрок выключается из матчей: его окна и незавершённые договорённости
//     отменяются, из списков соперников и напоминаний он пропадает;
//   · соперникам — короткое сообщение о W/O, организатору — сводка.
//
// Отметка «снялся» хранится в отдельном листе League Withdrawals нашей
// таблицы: из Players_Master и состава дивизиона игрока не убираем — на них
// завязаны история, Fantasy и сайт.
import { sheets as sheetsClient } from './google.js';
import { LEAGUE_RESULTS_SHEET_ID } from './config.js';
import { ensureExtraSheet, getRows, appendObject, sameName, getAllActiveLeaguePlayers, findApplicantByTelegramId } from './sheets.js';
import { seasonRoster, divisionSheetId, latestSeason, divisionLetter, invalidateDivisionCache } from './division.js';
import { sendMessage } from './telegram.js';
import { nowISO } from './util.js';

const SHEET = 'League Withdrawals';
const HEADERS = ['season', 'player', 'telegram_id', 'division', 'group', 'withdrawn_at', 'by', 'walkovers', 'reason'];
const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (v = '') => txt(v).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '');
const colLetter = n => { let s = ''; for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + (x - 1) % 26) + s; return s; };

// ---------------------------------------------------------------- реестр
let registry = { t: 0, rows: null };
const REGISTRY_MS = 60_000;
export async function withdrawnList({ fresh = false } = {}) {
  if (!fresh && registry.rows && Date.now() - registry.t < REGISTRY_MS) return registry.rows;
  await ensureExtraSheet(SHEET, HEADERS).catch(() => {});
  const { rows } = await getRows(SHEET, { useCache: !fresh }).catch(() => ({ rows: [] }));
  registry = { t: Date.now(), rows: (rows || []).filter(r => txt(r.player)) };
  return registry.rows;
}
// Снялся ли игрок в этом сезоне. Сезон не задан — смотрим текущий.
export async function isWithdrawn(name, season = '') {
  if (!txt(name)) return false;
  const s = txt(season) || txt(await latestSeason().catch(() => ''));
  // Строго по сезону: снятие в сезоне 2 ни на что не влияет в сезоне 3.
  if (!s) return false;
  return (await withdrawnList().catch(() => [])).some(r => txt(r.season) === s && sameName(r.player, name));
}

// ---------------------------------------------------------- что снимаем
// Несыгранные матчи игрока: строки его группы без счёта и без W/O плюс
// межгрупповые пары без подтверждённого результата.
export async function planWithdrawal(name, season = '') {
  const s = txt(season) || txt(await latestSeason().catch(() => ''));
  const roster = await seasonRoster(s);
  const me = (roster?.players || []).find(p => sameName(p.name, name));
  if (!me) return { ok: false, reason: 'not_found', season: s };
  if (await isWithdrawn(me.name, s)) return { ok: false, reason: 'already', season: s, player: me };
  const letter = divisionLetter(me.letter || me.division);
  const group = txt(me.group);
  const spreadsheetId = await divisionSheetId(letter, s, group).catch(() => '');
  if (!spreadsheetId) return { ok: false, reason: 'no_sheet', season: s, player: me };

  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A1:BZ' });
  const values = res.data.values || [];
  const head = (values[0] || []).map(norm);
  const idx = keys => head.findIndex(h => keys.includes(h));
  const c = {
    match: idx(['match', 'match_no', 'match_']), p1id: idx(['p1_id']), p2id: idx(['p2_id']),
    p1: idx(['player_1', 'p1_name']), p2: idx(['player_2', 'p2_name']),
    s1a: idx(['set_1_p1', 's1p1']), s1b: idx(['set_1_p2', 's1p2']), done: idx(['completed']),
    t1: idx(['p1_techloss']), t2: idx(['p2_techloss'])
  };
  if (c.t1 < 0 || c.t2 < 0 || c.p1 < 0 || c.p2 < 0) return { ok: false, reason: 'no_columns', season: s, player: me };
  // Граница группового этапа — по местам сетки (шаблон на 8 мест), как в таблице дивизиона.
  const slots = new Set();
  for (const r of values.slice(1)) { if (!(Number(r?.[c.match]) > 0)) continue; for (const k of [c.p1id, c.p2id]) { const v = Number(r?.[k]); if (v > 0) slots.add(v); } }
  const regularMax = slots.size > 1 ? slots.size * (slots.size - 1) / 2 : 0;
  const names = (roster.players || []).filter(p => divisionLetter(p.letter || p.division) === letter && txt(p.group) === group).map(p => p.name);
  const has = v => txt(v) !== '';
  const matches = [];
  const seen = new Set();
  values.forEach((r = [], i) => {
    if (i === 0) return;
    const no = Number(r[c.match]);
    if (!(no > 0) || (regularMax && no > regularMax)) return;
    const a = txt(r[c.p1]), b = txt(r[c.p2]);
    const mine = sameName(a, me.name) ? 'p1' : sameName(b, me.name) ? 'p2' : '';
    if (!mine) return;
    const opponent = mine === 'p1' ? b : a;
    if (!opponent || sameName(opponent, me.name) || !names.some(n => sameName(n, opponent))) return;
    const key = norm(opponent);
    const played = (has(r[c.s1a]) && has(r[c.s1b])) || /^yes$/i.test(txt(r[c.done])) || has(r[c.t1]) || has(r[c.t2]);
    if (played) { seen.add(key); return; }
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ kind: 'group', opponent, row: i + 1, cell: `Match_Log!${colLetter(mine === 'p1' ? c.t1 : c.t2)}${i + 1}` });
  });
  // Межгрупповые пары (W): строка без подтверждённого результата.
  if (letter === 'W' && LEAGUE_RESULTS_SHEET_ID) {
    const cross = await sheetsClient().spreadsheets.values.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: 'Cross_Group_Match_Log!A1:O' }).catch(() => null);
    const rows = cross?.data?.values || [];
    rows.forEach((r = [], i) => {
      if (i === 0 || txt(r[1]) !== s || divisionLetter(r[2]) !== 'W') return;
      const done = /^confirmed$/i.test(txt(r[13])) || has(r[8]);
      if (done) return;
      const side = sameName(r[4], me.name) ? 1 : sameName(r[6], me.name) ? 2 : 0;
      if (!side) return;
      matches.push({ kind: 'cross', opponent: txt(side === 1 ? r[6] : r[4]), row: i + 1, side, groups: [txt(r[3]), txt(r[5])] });
    });
  }
  return { ok: true, season: s, player: me, letter, group, spreadsheetId, matches };
}

// --------------------------------------------------------------- снятие
export async function applyWithdrawal(name, { season = '', actor = {}, notify = true } = {}) {
  const plan = await planWithdrawal(name, season);
  if (!plan.ok) return plan;
  const { player, spreadsheetId, matches } = plan;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  // 1) W/O в таблицу группы: снявшемуся 0 в его колонку TechLoss.
  const groupWrites = matches.filter(m => m.kind === 'group').map(m => ({ range: m.cell, values: [[0]] }));
  if (groupWrites.length) {
    await sheetsClient().spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: groupWrites } });
  }
  // 2) Межгрупповые W/O: результат «технический», сопернику 3, снявшемуся 0.
  const cross = matches.filter(m => m.kind === 'cross');
  if (cross.length) {
    const data = cross.map(m => ({
      range: `Cross_Group_Match_Log!H${m.row}:O${m.row}`,
      values: [['technical', 'W/O', m.opponent, m.side === 1 ? 0 : 3, m.side === 1 ? 3 : 0, `W/O: ${player.name} снялся`, 'confirmed', today]]
    }));
    await sheetsClient().spreadsheets.values.batchUpdate({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data } });
  }
  // 3) Отметка «снялся» — до рассылок: с этого момента он ни в каких списках.
  const people = await getAllActiveLeaguePlayers().catch(() => []);
  const tgOf = n => people.find(p => sameName(p.name, n))?.telegram_id || '';
  const myTg = tgOf(player.name);
  await ensureExtraSheet(SHEET, HEADERS).catch(() => {});
  await appendObject(SHEET, {
    season: plan.season, player: player.name, telegram_id: myTg, division: plan.letter, group: plan.group,
    withdrawn_at: nowISO(), by: txt(actor.name || actor.telegram_id || actor.id), walkovers: matches.map(m => m.opponent).join(', '), reason: 'withdrawn'
  });
  registry = { t: 0, rows: null };
  invalidateDivisionCache();
  try { (await import('./sheets.js')).invalidateLeagueCache(); } catch {}
  try { (await import('./results.js')).refreshAfterResult?.(); } catch {}
  // 4) Его окна и договорённости.
  const { cancelPlayerMatchmaking } = await import('./matchesdb.js');
  const cancelled = myTg ? await cancelPlayerMatchmaking(myTg, { telegram_id: actor.telegram_id || actor.id, name: actor.name }).catch(e => { console.error('withdraw cancel slots:', e.message); return []; }) : [];
  // 5) Сообщения.
  const sent = [];
  if (notify) {
    for (const m of matches) {
      const id = tgOf(m.opponent);
      if (!id) continue;
      const ru = (await findApplicantByTelegramId(id).catch(() => null))?.language === 'ru';
      const text = ru
        ? `<b>🎾 Техническая победа (W/O)</b>\n\n${esc(player.name)} снялся с турнира. Ваш матч с ним засчитан как техническая победа: +3 очка в таблицу дивизиона.\n\nВ историю матчей W/O не идёт — матч не был сыгран.`
        : `<b>🎾 Walkover win (W/O)</b>\n\n${esc(player.name)} has withdrawn from the season. Your match against them counts as a walkover win: +3 points in the division table.\n\nA walkover does not appear in match history — the match was not played.`;
      await sendMessage(id, text).then(() => sent.push(m.opponent)).catch(e => console.error('withdraw notice:', e.message));
    }
    for (const sl of cancelled) {
      const other = String(sl.from_telegram_id) === String(myTg) ? sl.to_telegram_id : sl.from_telegram_id;
      if (!other) continue;
      const ru = (await findApplicantByTelegramId(other).catch(() => null))?.language === 'ru';
      await sendMessage(other, ru
        ? `<b>✖️ Матч отменён</b>\n\n${esc(player.name)} снялся с турнира, поэтому ваша договорённость о матче снята.`
        : `<b>✖️ Match cancelled</b>\n\n${esc(player.name)} has withdrawn from the season, so your match arrangement is cancelled.`).catch(() => {});
    }
  }
  return { ok: true, season: plan.season, player, letter: plan.letter, group: plan.group, matches, cancelled: cancelled.length, notified: sent };
}

// Текст предпросмотра и сводки — один на бота и на турнирную админку.
export function withdrawalSummary(r, { applied = false } = {}) {
  if (!r?.ok) {
    const why = { not_found: 'игрок не найден в составах сезона', already: 'игрок уже снят', no_sheet: 'не найдена таблица его дивизиона', no_columns: 'в Match_Log нет колонок P1/P2 TechLoss' }[r?.reason] || r?.reason || 'ошибка';
    return `⛔ ${why}.`;
  }
  const where = `Division ${r.letter}${r.group ? ' · группа ' + r.group : ''} · сезон ${r.season}`;
  const list = r.matches.length ? r.matches.map(m => `• ${esc(m.opponent)}${m.kind === 'cross' ? ' (межгрупповой)' : ''} — W/O, ему 3 : 0`).join('\n') : '— несыгранных матчей нет';
  return applied
    ? `<b>✅ ${esc(r.player.name)} снят с турнира</b>\n${where}\n\nЗаписано W/O:\n${list}\n\nОтменено окон и договорённостей: <b>${r.cancelled}</b>\nСообщения соперникам: <b>${r.notified.length}</b>`
    : `<b>🚪 Снять ${esc(r.player.name)} с турнира?</b>\n${where}\n\nБудут засчитаны технические победы (W/O):\n${list}\n\nСыгранные матчи остаются. Соперникам — 3 очка, ему — 0, сеты и геймы не идут. В историю матчей W/O не попадает. Его окна и договорённости отменятся, соперникам придёт сообщение.`;
}
