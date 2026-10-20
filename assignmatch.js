// Матч, назначенный организатором.
//
// Организатор сам выбирает двух игроков, дату, время и корт. Корт — его бронь,
// поэтому матч сразу договорён и подтверждён: никаких «Корт подтвердил», никаких
// переговоров. Обоим игрокам приходит сообщение на их языке, матч висит у них
// в «Моих матчах» как обычный, со всеми напоминаниями и вводом счёта.
//
// Перенести и отменить такой матч может только организатор (match_type =
// assigned, assigned_by — кто назначил). У игроков вместо этих кнопок —
// «Связаться с организатором».
//
// Плей-офф: если пара — из опубликованной сетки, матч получает стадию, а дата,
// время и корт пишутся в строку листа Playoff (с номером матча — туда же потом
// ляжет счёт). И обратно: время полуфинала или финала, поставленное в разделе
// «Плей-офф», создаёт такой матч само (syncPlayoffAssigned).
import { MATCH_DURATION_MIN } from './config.js';
import { uid, nowISO, safe } from './util.js';
import { createSlot, findSlot, updateSlot, findTimeConflict, isAssigned, logMatchEvent } from './matchesdb.js';
import { getAllActiveLeaguePlayers, findApplicantByTelegramId, sameName } from './sheets.js';
import { notifyAssignedMatch, alreadyPairedNames } from './matches.js';

const txt = v => String(v ?? '').trim();
const STAGES = ['QF', 'SF', 'Final', '3rd'];
const hhmm = v => { const m = txt(v).match(/^(\d{1,2})[:.](\d{2})$/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
const addMin = (t, min) => { const [h, m] = t.split(':').map(Number); const x = h * 60 + m + Number(min || 0); return String(Math.floor(x / 60) % 24).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const todayBkk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const live = s => s && String(s.status || '').toLowerCase() === 'accepted' && !txt(s.result_status);
const letterOf = d => txt(d).replace(/^division\s+/i, '').toUpperCase();

async function usernameOf(id, fallback = '') {
  if (txt(fallback)) return txt(fallback).replace(/^@/, '');
  const a = await findApplicantByTelegramId(id).catch(() => null);
  return txt(a?.telegram_username || a?.username).replace(/^@/, '');
}
async function person(p) {
  return { telegram_id: String(p.telegram_id), name: txt(p.name), username: await usernameOf(p.telegram_id, p.username) };
}

// Строка листа Playoff для пары: только опубликованная сетка (черновик ещё
// поменяется) и не сыгранный матч.
async function playoffRowFor(slot, stage) {
  if (!stage) return null;
  try {
    const po = await import('./playoff.js');
    const rows = await po.divisionRows(letterOf(slot.division), slot.season, { fresh: true });
    const pair = r => (sameName(r.player_1, slot.from_name) && sameName(r.player_2, slot.to_name)) || (sameName(r.player_1, slot.to_name) && sameName(r.player_2, slot.from_name));
    return rows.find(r => r.stage === stage && pair(r) && !['draft', 'confirmed'].includes(txt(r.status).toLowerCase())) || null;
  } catch (e) { console.error('assigned: playoff row lookup failed:', e.message); return null; }
}
async function writePlayoffTime(slot, row, { clear = false } = {}) {
  if (!row) return false;
  try {
    const po = await import('./playoff.js');
    const r = await po.setSchedule(letterOf(slot.division), slot.season, row.slot, clear
      ? { date: row.date, time: '', court: row.court, match_id: '' }
      : { date: slot.agreed_date, time: slot.agreed_time, court: slot.agreed_court, match_id: slot.challenge_id });
    return Boolean(r?.ok);
  } catch (e) { console.error('assigned: playoff schedule write failed:', e.message); return false; }
}

// Предупреждения: у игрока на это время уже матч; пара уже играла или
// договорилась в этом сезоне. Организатор может назначить всё равно (force).
async function warningsFor(slot, { excludeId = '', checkPair = true } = {}) {
  const out = [];
  for (const [id, name] of [[slot.from_telegram_id, slot.from_name], [slot.to_telegram_id, slot.to_name]]) {
    const c = await findTimeConflict(id, slot.agreed_date, slot.agreed_time, slot.duration_min || MATCH_DURATION_MIN, excludeId).catch(() => null);
    if (c) {
      const other = String(c.from_telegram_id) === String(id) ? c.to_name : c.from_name;
      out.push({ code: 'time_clash', name, with: other || '', date: c.agreed_date, time: c.agreed_time });
    }
  }
  if (checkPair) {
    const paired = await alreadyPairedNames({ ...slot, challenge_id: excludeId || slot.challenge_id }).catch(() => []);
    if (paired.some(n => sameName(n, slot.to_name))) out.push({ code: 'already_paired', name: slot.from_name, with: slot.to_name });
  }
  return out;
}

// Создать или перенести матч. body: from_telegram_id, to_telegram_id, date,
// time, court, comment, stage ('' — авто, 'regular' — регулярка, QF/SF/Final/3rd),
// challenge_id (перенос уже назначенного), force (назначить, несмотря на предупреждения).
export async function assignMatch(body = {}, actor = {}) {
  const date = txt(body.date), time = hhmm(body.time), court = txt(body.court);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'bad_date' };
  if (!time) return { ok: false, reason: 'bad_time' };
  if (!court) return { ok: false, reason: 'no_court' };
  if (date < todayBkk()) return { ok: false, reason: 'past_date' };
  const force = body.force === true || body.force === 'true' || body.force === 1;

  // Перенос: игроки те же, меняются дата, время, корт и комментарий.
  if (txt(body.challenge_id)) {
    const prev = await findSlot(body.challenge_id);
    if (!prev) return { ok: false, reason: 'not_found' };
    if (!isAssigned(prev)) return { ok: false, reason: 'not_assigned' };
    if (!live(prev)) return { ok: false, reason: 'closed' };
    const patch = { agreed_date: date, agreed_time: time, agreed_court: court, dates: date, time_from: time,
      time_to: addMin(time, prev.duration_min || MATCH_DURATION_MIN), courts: court,
      comment: body.comment === undefined ? prev.comment : safe(body.comment),
      reminder_sent: '', result_prompt_sent_at: '', nudge_sent: '', score_nudge: '' };
    const moved = prev.agreed_date !== date || prev.agreed_time !== time || prev.agreed_court !== court;
    const next = { ...prev, ...patch };
    if (moved) {
      const warnings = await warningsFor(next, { excludeId: prev.challenge_id, checkPair: false });
      if (warnings.length && !force) return { ok: false, reason: 'confirm', warnings };
    }
    const saved = await updateSlot(prev.challenge_id, patch);
    await logMatchEvent('assigned_moved', saved, actor, `${prev.agreed_date} ${prev.agreed_time} ${prev.agreed_court} → ${date} ${time} ${court}`).catch(() => {});
    const row = saved.stage ? await playoffRowFor(saved, saved.stage) : null;
    const playoff = row ? await writePlayoffTime(saved, row) : false;
    const notified = moved ? await notifyAssignedMatch(saved, { kind: 'moved', previous: prev }) : 0;
    return { ok: true, slot: saved, moved, notified, playoff };
  }

  // Новый матч.
  const all = await getAllActiveLeaguePlayers().catch(() => []);
  const byId = new Map(all.map(p => [String(p.telegram_id), p]));
  const a = byId.get(String(body.from_telegram_id || '')), b = byId.get(String(body.to_telegram_id || ''));
  if (!a || !b) return { ok: false, reason: 'pick_players' };
  if (String(a.telegram_id) === String(b.telegram_id)) return { ok: false, reason: 'same_player' };
  if (letterOf(a.division) !== letterOf(b.division)) return { ok: false, reason: 'other_division' };
  const from = await person(a), to = await person(b);
  const group = String(a.group || '') === String(b.group || '') ? String(a.group || '') : 'cross';
  const slot = {
    challenge_id: uid('match'), match_type: 'assigned', status: 'accepted',
    division: a.division, season: String(a.season || b.season || ''), group,
    from_telegram_id: from.telegram_id, from_name: from.name, from_username: from.username,
    to_telegram_id: to.telegram_id, to_name: to.name, to_username: to.username,
    dates: date, time_from: time, time_to: addMin(time, MATCH_DURATION_MIN), duration_min: MATCH_DURATION_MIN,
    courts: court, comment: safe(body.comment),
    agreed_date: date, agreed_time: time, agreed_court: court,
    court_confirmed_at: nowISO(), court_confirmed_by: String(actor.telegram_id || ''),
    created_at: nowISO(), responded_at: nowISO(),
    assigned_by: String(actor.telegram_id || ''), assigned_contact: await usernameOf(actor.telegram_id, actor.username)
  };
  // Стадия: выбрана руками или по сетке плей-офф (пара из опубликованной
  // сетки, день — после дедлайна регулярки).
  const wanted = txt(body.stage);
  let stage = STAGES.includes(wanted) ? wanted : '';
  if (!wanted) stage = await import('./playoff.js').then(po => po.detectStage({ ...slot, agreed_date: date })).catch(() => '');
  if (stage) slot.stage = stage;
  const warnings = await warningsFor(slot, { checkPair: !stage });
  if (warnings.length && !force) return { ok: false, reason: 'confirm', warnings };
  await createSlot(slot);
  await logMatchEvent('assigned', slot, actor, `${date} ${time} · ${court}${stage ? ' · ' + stage : ''}`).catch(() => {});
  const row = await playoffRowFor(slot, stage);
  const playoff = row ? await writePlayoffTime(slot, row) : false;
  const notified = await notifyAssignedMatch(slot, { kind: 'new' });
  return { ok: true, slot, created: true, notified, stage, playoff };
}

// Отмена назначенного матча организатором: оба игрока получают сообщение.
export async function cancelAssigned(challengeId, actor = {}, { notify = true } = {}) {
  const slot = await findSlot(challengeId);
  if (!slot) return { ok: false, reason: 'not_found' };
  if (!isAssigned(slot)) return { ok: false, reason: 'not_assigned' };
  if (!live(slot)) return { ok: false, reason: 'closed' };
  const saved = await updateSlot(slot.challenge_id, { status: 'cancelled', cancelled_at: nowISO() });
  await logMatchEvent('assigned_cancelled', slot, actor, 'отменён организатором').catch(() => {});
  if (slot.stage) {
    const row = await playoffRowFor(slot, slot.stage);
    if (row && txt(row.match_id) === txt(slot.challenge_id)) await writePlayoffTime(slot, row, { clear: true });
  }
  const notified = notify ? await notifyAssignedMatch(saved, { kind: 'cancelled', previous: slot }) : 0;
  return { ok: true, slot: saved, notified };
}

// Время матча плей-офф из раздела «Плей-офф» → назначенный матч у игроков.
// Зовётся после «Время → Сохранить», после замены игрока и когда в матч
// встают победители предыдущего круга. Возвращает, что сделано:
//   created / moved / unchanged — матч создан, перенесён, уже такой;
//   waiting — игроки этого матча ещё не известны; no_time — время не задано;
//   own — пара договорилась сама, её матч не трогаем; no_telegram — у кого-то
//   нет Telegram в анкете; played — матч уже сыгран.
export async function syncPlayoffAssigned(letter, season, slotKey, actor = {}) {
  const po = await import('./playoff.js');
  const row = (await po.divisionRows(letter, season, { fresh: true })).find(r => r.slot === slotKey);
  if (!row) return { status: 'not_found' };
  if (txt(row.status).toLowerCase() === 'confirmed') return { status: 'played' };
  const linked = txt(row.match_id) ? await findSlot(row.match_id).catch(() => null) : null;
  const mine = linked && isAssigned(linked) && live(linked) ? linked : null;
  const samePair = s => s && ((sameName(s.from_name, row.player_1) && sameName(s.to_name, row.player_2)) || (sameName(s.from_name, row.player_2) && sameName(s.to_name, row.player_1)));
  // Пара поменялась (замена, исправленный счёт) — старый матч снимаем.
  if (mine && !samePair(mine)) await cancelAssigned(mine.challenge_id, actor);
  if (!txt(row.player_1) || !txt(row.player_2)) return { status: 'waiting' };
  if (!txt(row.date) || !hhmm(row.time)) return { status: 'no_time' };
  if (linked && !isAssigned(linked) && live(linked) && samePair(linked)) return { status: 'own' };
  const all = await getAllActiveLeaguePlayers().catch(() => []);
  const find = n => all.find(p => sameName(p.name, n));
  const p1 = find(row.player_1), p2 = find(row.player_2);
  if (!p1 || !p2) return { status: 'no_telegram', names: [!p1 ? row.player_1 : '', !p2 ? row.player_2 : ''].filter(Boolean) };
  const court = txt(row.court) || po.DEFAULT_COURT;
  if (mine && samePair(mine)) {
    if (mine.agreed_date === row.date && mine.agreed_time === hhmm(row.time) && mine.agreed_court === court) return { status: 'unchanged', slot: mine };
    const r = await assignMatch({ challenge_id: mine.challenge_id, date: row.date, time: row.time, court, force: true }, actor);
    return r.ok ? { status: 'moved', slot: r.slot, notified: r.notified } : { status: 'error', reason: r.reason };
  }
  const r = await assignMatch({ from_telegram_id: p1.telegram_id, to_telegram_id: p2.telegram_id, date: row.date, time: row.time, court, stage: row.stage, force: true }, actor);
  return r.ok ? { status: 'created', slot: r.slot, notified: r.notified } : { status: 'error', reason: r.reason };
}

// Подпись для ответа организатору.
export function playoffSyncText(r = {}, ru = true) {
  const n = r.notified || 0;
  switch (r.status) {
    case 'created': return ru ? `Матч назначен игрокам, сообщений: ${n}` : `Match scheduled for the players, messages sent: ${n}`;
    case 'moved': return ru ? `Матч у игроков перенесён, сообщений: ${n}` : `Players’ match moved, messages sent: ${n}`;
    case 'unchanged': return ru ? 'У игроков уже стоит это время' : 'The players already have this time';
    case 'waiting': return ru ? 'Игроки ещё не известны — матч назначится сам, когда они определятся' : 'Players not known yet — the match will be scheduled once they are';
    case 'own': return ru ? 'Пара договорилась сама — их матч не трогаю' : 'The pair arranged it themselves — their match is left as is';
    case 'no_telegram': return ru ? `Нет Telegram в анкете: ${(r.names || []).join(', ')} — матч в боте не создан` : `No Telegram in the profile: ${(r.names || []).join(', ')} — no match created in the bot`;
    case 'played': return ru ? 'Матч уже сыгран' : 'Already played';
    case 'error': return ru ? 'Матч у игроков не создан: ' + (r.reason || '') : 'Players’ match not created: ' + (r.reason || '');
    default: return '';
  }
}
