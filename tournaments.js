// Турниры: одиночные и парные, группы и плей-офф, заявки и пары.
//
// Модель повторяет ту, что устоялась в турнирных системах (Toornament,
// brackets-model): турнир → стадия → группа → раунд → матч. Участник и заявка
// разведены нарочно: заявка (Entry) — это место в турнире, участником может
// быть как игрок, так и пара. Пара живёт своей жизнью ещё до того, как она
// собрана: «ищу партнёра» → «пригласил» → «согласовано».
//
// Два правила, вокруг которых собрано всё остальное:
//
//  1. Таблица — не источник места в таблице. Позиции, очки и сетка НИКОГДА не
//     хранятся: они считаются из матчей при каждом чтении. Поэтому исправление
//     счёта задним числом автоматически чинит всё, что ниже по течению, и
//     рассинхрона «в таблице одно, в карточке другое» не бывает в принципе.
//
//  2. Снятие игрока и результат матча — разные вещи. Снятие меняет статус
//     заявки; на матчи оно действует только через явный исход (WO, RET, DEF).
//     Так устроено в USTA/TennisLink, и это единственный способ не превратить
//     «человек уехал» в молчаливую порчу сыгранных матчей.
//
// Боевые и тестовые данные разделены суффиксом листа: в тестовом режиме все
// турнирные листы читаются и пишутся с пометкой TEST. Составы игроков и
// Players_Master при этом читаются настоящие и никогда не меняются — турнирный
// модуль не пишет ни в одну таблицу организатора.
import { getRows, appendObject, appendObjects, updateObjectByRow, ensureExtraSheet, invalidateSheetCache, sameName, getAllActiveLeaguePlayers, getAllApplicants } from './sheets.js';
import { seasonRoster, latestSeason, divisionLetter, divisionDisplayName } from './division.js';
import { uid, nowISO } from './util.js';

// --------------------------------------------------------------------- листы
const BASE = {
  tournaments:'Tournaments',
  entries:'Tournament Entries',
  pairs:'Tournament Pairs',
  invites:'Tournament Invites',
  stages:'Tournament Stages',
  matches:'Tournament Matches',
  log:'Tournament Log'
};
export const TEST_SUFFIX = ' TEST';
export const sheetName = (key, test = false) => `${BASE[key]}${test ? TEST_SUFFIX : ''}`;

const HEADERS = {
  tournaments:['tournament_id','name','name_en','kind','season','status','format','playoff_type','third_place',
    'group_count','advance_per_group','points_win','points_loss','points_walkover','entry_fee_thb','entry_fee_usdt',
    'max_entries','registration_opens','registration_closes','starts_on','ends_on','event_id','source','notes',
    'created_at','created_by','updated_at'],
  entries:['entry_id','tournament_id','entrant_type','player_id','player_name','pair_id','display_name','status',
    'seed','rating','division','group','checked_in_at','withdrawn_at','withdrawal_reason','replaced_by',
    'payment_status','note','created_at','updated_at'],
  pairs:['pair_id','tournament_id','player_a_id','player_a_name','player_b_id','player_b_name','status',
    'invite_code','payer','pair_name','rating','note','created_at','confirmed_at','updated_at'],
  invites:['invite_id','tournament_id','pair_id','from_id','from_name','to_id','to_name','to_contact','channel',
    'status','message_id','created_at','responded_at'],
  stages:['stage_id','tournament_id','kind','name','order_index','status','settings','created_at','updated_at'],
  matches:['match_id','tournament_id','stage_id','group','round','round_label','slot','entry_a','entry_a_name',
    'entry_b','entry_b_name','source_a','source_b','status','score','winner_entry','result_reason','scheduled_at',
    'court','reported_by','confirmed_by','note','created_at','updated_at'],
  log:['log_id','tournament_id','at','admin_id','admin_name','action','target','before','after','note']
};

const ensured = new Set();
async function sheet(key, test = false) {
  const name = sheetName(key, test);
  if (!ensured.has(name)) {
    await ensureExtraSheet(name, HEADERS[key]);
    ensured.add(name);
  }
  return name;
}
export async function ensureTournamentSheets(test = false) {
  for (const key of Object.keys(BASE)) await sheet(key, test);
  return Object.fromEntries(Object.keys(BASE).map(k => [k, sheetName(k, test)]));
}
async function rows(key, test = false, useCache = true) {
  const name = await sheet(key, test);
  const { rows } = await getRows(name, { useCache });
  return rows;
}
async function insert(key, obj, test = false) {
  const name = await sheet(key, test);
  return appendObject(name, obj);
}
async function insertMany(key, list = [], test = false) {
  const name = await sheet(key, test);
  return appendObjects(name, list);
}
async function patch(key, rowNumber, data, test = false) {
  const name = await sheet(key, test);
  return updateObjectByRow(name, rowNumber, { ...data, updated_at: nowISO() });
}

// ----------------------------------------------------------------- мелочёвка
const txt = v => String(v ?? '').trim();
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const lower = v => txt(v).toLowerCase();
const yes = v => ['yes','true','1','да','y'].includes(lower(v));

export const TOURNAMENT_KINDS = ['singles','doubles'];
export const TOURNAMENT_STATUS = ['draft','registration','running','completed','archived'];
// Заявка: путь от подачи до снятия. `replaced` — заменён другим участником.
export const ENTRY_STATUS = ['applied','accepted','waitlist','withdrawn','rejected','replaced'];
// Пара: собирается до того, как станет участником.
export const PAIR_STATUS = ['seeking','invite_pending','confirmed','dissolved'];
// Исход матча. Обычные — scheduled/completed. Остальные повторяют словарь
// теннисных систем: не сыгран вовсе (walkover), снялся по ходу (retired),
// снят решением (default), проход без игры (bye).
export const MATCH_STATUS = ['scheduled','completed','walkover','retired','default','bye','cancelled'];
export const WITHDRAWAL_REASONS = ['injury','travel','personal','no_show','other'];
export const FORMATS = ['groups_playoff','groups_only','playoff_only'];
export const PLAYOFF_TYPES = ['cross_1_4','cross_groups','seeded_bracket'];

const DEFAULTS = { points_win:3, points_loss:1, points_walkover:0 };
export function scoringOf(tournament = {}) {
  return {
    win: Number.isFinite(Number(tournament.points_win)) && txt(tournament.points_win) !== '' ? num(tournament.points_win) : DEFAULTS.points_win,
    loss: txt(tournament.points_loss) !== '' ? num(tournament.points_loss) : DEFAULTS.points_loss,
    walkover: txt(tournament.points_walkover) !== '' ? num(tournament.points_walkover) : DEFAULTS.points_walkover
  };
}

// --------------------------------------------------------------------- журнал
// Пишем каждое действие админа: что, над чем, что было и что стало. Это и есть
// «история правок», по которой потом видно, кто и когда поменял счёт.
export async function logAction(tournamentId, actor = {}, action = '', target = '', before = '', after = '', note = '', test = false) {
  try {
    await insert('log', {
      log_id: uid('tlog'), tournament_id: txt(tournamentId), at: nowISO(),
      admin_id: txt(actor.id || actor.telegram_id), admin_name: txt(actor.name),
      action, target: txt(target),
      before: typeof before === 'string' ? before : JSON.stringify(before),
      after: typeof after === 'string' ? after : JSON.stringify(after),
      note: txt(note)
    }, test);
  } catch (e) { console.error('tournament log failed:', e.message); }
}
export async function readLog(tournamentId, test = false, limit = 60) {
  const all = await rows('log', test).catch(() => []);
  return all.filter(r => txt(r.tournament_id) === txt(tournamentId))
    .sort((a, b) => txt(b.at).localeCompare(txt(a.at))).slice(0, limit);
}

// ------------------------------------------------------------------ турниры
export async function listTournaments(test = false) {
  const all = await rows('tournaments', test).catch(() => []);
  return all.filter(r => txt(r.tournament_id))
    .sort((a, b) => txt(b.created_at).localeCompare(txt(a.created_at)));
}
export async function getTournament(tournamentId, test = false) {
  const all = await listTournaments(test);
  return all.find(r => txt(r.tournament_id) === txt(tournamentId)) || null;
}
export async function createTournament(data = {}, actor = {}, test = false) {
  const name = txt(data.name);
  if (!name) throw new Error('Нужно название турнира');
  const kind = TOURNAMENT_KINDS.includes(lower(data.kind)) ? lower(data.kind) : 'singles';
  const format = FORMATS.includes(lower(data.format)) ? lower(data.format) : 'groups_playoff';
  const playoff = PLAYOFF_TYPES.includes(lower(data.playoff_type)) ? lower(data.playoff_type) : 'cross_1_4';
  const row = {
    tournament_id: uid('trn'), name, name_en: txt(data.name_en) || name, kind,
    season: txt(data.season) || await latestSeason().catch(() => ''),
    status: TOURNAMENT_STATUS.includes(lower(data.status)) ? lower(data.status) : 'draft',
    format, playoff_type: playoff, third_place: yes(data.third_place) ? 'yes' : 'no',
    group_count: txt(data.group_count) || '1',
    advance_per_group: txt(data.advance_per_group) || '4',
    points_win: txt(data.points_win) || String(DEFAULTS.points_win),
    points_loss: txt(data.points_loss) || String(DEFAULTS.points_loss),
    points_walkover: txt(data.points_walkover) || String(DEFAULTS.points_walkover),
    entry_fee_thb: txt(data.entry_fee_thb), entry_fee_usdt: txt(data.entry_fee_usdt),
    max_entries: txt(data.max_entries),
    registration_opens: txt(data.registration_opens), registration_closes: txt(data.registration_closes),
    starts_on: txt(data.starts_on), ends_on: txt(data.ends_on),
    event_id: txt(data.event_id), source: txt(data.source), notes: txt(data.notes),
    created_at: nowISO(), created_by: txt(actor.id || actor.telegram_id), updated_at: nowISO()
  };
  await insert('tournaments', row, test);
  await logAction(row.tournament_id, actor, 'tournament_created', row.tournament_id, '', { name, kind, format }, '', test);
  return row;
}
export async function updateTournament(tournamentId, data = {}, actor = {}, test = false) {
  const all = await rows('tournaments', test, false);
  const row = all.find(r => txt(r.tournament_id) === txt(tournamentId));
  if (!row) throw new Error('Турнир не найден');
  const allowed = HEADERS.tournaments.filter(h => !['tournament_id','created_at','created_by'].includes(h));
  const next = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(data, key)) next[key] = txt(data[key]);
  if (!Object.keys(next).length) return row;
  await patch('tournaments', row._rowNumber, next, test);
  await logAction(tournamentId, actor, 'tournament_updated', tournamentId,
    Object.fromEntries(Object.keys(next).map(k => [k, row[k]])), next, '', test);
  return { ...row, ...next };
}

// ------------------------------------------------------------------- заявки
export async function listEntries(tournamentId, test = false, useCache = true) {
  const all = await rows('entries', test, useCache).catch(() => []);
  return all.filter(r => txt(r.tournament_id) === txt(tournamentId) && txt(r.entry_id));
}
export const activeEntries = list => list.filter(e => ['applied','accepted','waitlist'].includes(lower(e.status)));
export const playingEntries = list => list.filter(e => lower(e.status) === 'accepted');

export async function addEntry(tournamentId, data = {}, actor = {}, test = false) {
  const tournament = await getTournament(tournamentId, test);
  if (!tournament) throw new Error('Турнир не найден');
  const entrantType = lower(tournament.kind) === 'doubles' ? 'pair' : 'player';
  const existing = await listEntries(tournamentId, test, false);
  if (entrantType === 'player') {
    const playerId = txt(data.player_id);
    const playerName = txt(data.player_name);
    if (!playerId && !playerName) throw new Error('Нужен игрок');
    const twin = existing.find(e => lower(e.status) !== 'withdrawn'
      && ((playerId && txt(e.player_id) === playerId) || (!playerId && sameName(e.player_name, playerName))));
    if (twin) return twin;
  } else if (txt(data.pair_id)) {
    const twin = existing.find(e => txt(e.pair_id) === txt(data.pair_id) && lower(e.status) !== 'withdrawn');
    if (twin) return twin;
  }
  const row = {
    entry_id: uid('ent'), tournament_id: txt(tournamentId), entrant_type: entrantType,
    player_id: txt(data.player_id), player_name: txt(data.player_name),
    pair_id: txt(data.pair_id), display_name: txt(data.display_name) || txt(data.player_name),
    status: ENTRY_STATUS.includes(lower(data.status)) ? lower(data.status) : 'applied',
    seed: txt(data.seed), rating: txt(data.rating),
    division: txt(data.division), group: txt(data.group),
    checked_in_at: '', withdrawn_at: '', withdrawal_reason: '', replaced_by: '',
    payment_status: txt(data.payment_status), note: txt(data.note),
    created_at: nowISO(), updated_at: nowISO()
  };
  await insert('entries', row, test);
  await logAction(tournamentId, actor, 'entry_added', row.entry_id, '', { name: row.display_name, status: row.status }, '', test);
  return row;
}

export async function updateEntry(entryId, data = {}, actor = {}, test = false) {
  const all = await rows('entries', test, false);
  const row = all.find(r => txt(r.entry_id) === txt(entryId));
  if (!row) throw new Error('Заявка не найдена');
  const allowed = ['status','seed','rating','division','group','display_name','payment_status','note','checked_in_at'];
  const next = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(data, key)) next[key] = txt(data[key]);
  if (next.status && !ENTRY_STATUS.includes(lower(next.status))) throw new Error('Неизвестный статус заявки');
  if (!Object.keys(next).length) return row;
  await patch('entries', row._rowNumber, next, test);
  await logAction(row.tournament_id, actor, 'entry_updated', entryId,
    Object.fromEntries(Object.keys(next).map(k => [k, row[k]])), next, '', test);
  return { ...row, ...next };
}

// Массовое назначение: один вызов на весь экран состава. Так админ двигает
// сразу несколько человек между группами и не ждёт запись на каждого.
export async function assignEntries(tournamentId, items = [], actor = {}, test = false) {
  const all = await rows('entries', test, false);
  const byId = new Map(all.map(r => [txt(r.entry_id), r]));
  const changed = [];
  for (const item of items) {
    const row = byId.get(txt(item.entry_id));
    if (!row || txt(row.tournament_id) !== txt(tournamentId)) continue;
    const next = {};
    for (const key of ['division','group','seed','status']) {
      if (Object.prototype.hasOwnProperty.call(item, key) && txt(item[key]) !== txt(row[key])) next[key] = txt(item[key]);
    }
    if (!Object.keys(next).length) continue;
    await patch('entries', row._rowNumber, next, test);
    changed.push({ entry_id: row.entry_id, before: Object.fromEntries(Object.keys(next).map(k => [k, row[k]])), after: next });
  }
  if (changed.length) await logAction(tournamentId, actor, 'entries_assigned', `${changed.length} заявок`, '', changed, '', test);
  return changed;
}

// Снятие. Матчи не трогаем: сыгранное остаётся сыгранным. Несыгранные матчи
// участника получают явный исход — по умолчанию walkover в пользу соперника.
export async function withdrawEntry(entryId, { reason = 'other', applyWalkover = true, replacedBy = '' } = {}, actor = {}, test = false) {
  const entryRows = await rows('entries', test, false);
  const row = entryRows.find(r => txt(r.entry_id) === txt(entryId));
  if (!row) throw new Error('Заявка не найдена');
  const tournamentId = txt(row.tournament_id);
  await patch('entries', row._rowNumber, {
    status: replacedBy ? 'replaced' : 'withdrawn',
    withdrawn_at: nowISO(),
    withdrawal_reason: WITHDRAWAL_REASONS.includes(lower(reason)) ? lower(reason) : 'other',
    replaced_by: txt(replacedBy)
  }, test);

  const touched = [];
  if (applyWalkover && !replacedBy) {
    const matchRows = await rows('matches', test, false);
    for (const m of matchRows) {
      if (txt(m.tournament_id) !== tournamentId) continue;
      if (lower(m.status) !== 'scheduled') continue;
      const isA = txt(m.entry_a) === txt(entryId), isB = txt(m.entry_b) === txt(entryId);
      if (!isA && !isB) continue;
      const opponent = isA ? txt(m.entry_b) : txt(m.entry_a);
      await patch('matches', m._rowNumber, {
        status: 'walkover', winner_entry: opponent, result_reason: 'withdrawal',
        score: opponent ? 'W/O' : '', confirmed_by: txt(actor.id || actor.telegram_id)
      }, test);
      touched.push(txt(m.match_id));
    }
  }
  // Замена: новый участник встаёт на то же место в группе, посев и матчи
  // переходят к нему. Именно так это делают в теннисных системах — не новый
  // круг, а подстановка в уже сделанную сетку.
  if (replacedBy) {
    const replacement = entryRows.find(r => txt(r.entry_id) === txt(replacedBy));
    if (!replacement) throw new Error('Замена не найдена');
    await patch('entries', replacement._rowNumber, {
      status: 'accepted', division: txt(row.division), group: txt(row.group), seed: txt(row.seed)
    }, test);
    const matchRows = await rows('matches', test, false);
    for (const m of matchRows) {
      if (txt(m.tournament_id) !== tournamentId) continue;
      if (lower(m.status) !== 'scheduled') continue;
      const next = {};
      if (txt(m.entry_a) === txt(entryId)) { next.entry_a = txt(replacedBy); next.entry_a_name = txt(replacement.display_name || replacement.player_name); }
      if (txt(m.entry_b) === txt(entryId)) { next.entry_b = txt(replacedBy); next.entry_b_name = txt(replacement.display_name || replacement.player_name); }
      if (!Object.keys(next).length) continue;
      await patch('matches', m._rowNumber, next, test);
      touched.push(txt(m.match_id));
    }
  }
  await logAction(tournamentId, actor, replacedBy ? 'entry_replaced' : 'entry_withdrawn', entryId,
    { status: row.status }, { reason, replacedBy, matches: touched }, '', test);
  return { entry_id: entryId, matches: touched };
}

// -------------------------------------------------------------------- пары
export async function listPairs(tournamentId, test = false, useCache = true) {
  const all = await rows('pairs', test, useCache).catch(() => []);
  return all.filter(r => txt(r.tournament_id) === txt(tournamentId) && txt(r.pair_id));
}
export async function findPair(pairId, test = false) {
  const all = await rows('pairs', test, false).catch(() => []);
  return all.find(r => txt(r.pair_id) === txt(pairId)) || null;
}
export const pairLabel = pair => {
  if (!pair) return '';
  if (txt(pair.pair_name)) return txt(pair.pair_name);
  const a = txt(pair.player_a_name), b = txt(pair.player_b_name);
  return b ? `${a} / ${b}` : a;
};

// Запись в парный турнир. Партнёра может не быть вовсе — тогда пара живёт в
// состоянии «ищу партнёра» и видна остальным на доске поиска.
export async function createPair(tournamentId, { playerAId, playerAName, playerBId = '', playerBName = '', payer = '', note = '' } = {}, actor = {}, test = false) {
  const tournament = await getTournament(tournamentId, test);
  if (!tournament) throw new Error('Турнир не найден');
  if (lower(tournament.kind) !== 'doubles') throw new Error('Это не парный турнир');
  if (!txt(playerAId) && !txt(playerAName)) throw new Error('Нужен игрок');
  const existing = await listPairs(tournamentId, test, false);
  const mine = existing.find(p => lower(p.status) !== 'dissolved'
    && (txt(p.player_a_id) === txt(playerAId) || txt(p.player_b_id) === txt(playerAId)));
  if (mine) return mine;
  const row = {
    pair_id: uid('pair'), tournament_id: txt(tournamentId),
    player_a_id: txt(playerAId), player_a_name: txt(playerAName),
    player_b_id: txt(playerBId), player_b_name: txt(playerBName),
    status: txt(playerBId) || txt(playerBName) ? 'invite_pending' : 'seeking',
    invite_code: Math.random().toString(36).slice(2, 10), payer: txt(payer), pair_name: '',
    rating: '', note: txt(note), created_at: nowISO(), confirmed_at: '', updated_at: nowISO()
  };
  await insert('pairs', row, test);
  await logAction(tournamentId, actor, 'pair_created', row.pair_id, '', { a: row.player_a_name, b: row.player_b_name, status: row.status }, '', test);
  return row;
}

export async function updatePair(pairId, data = {}, actor = {}, test = false) {
  const all = await rows('pairs', test, false);
  const row = all.find(r => txt(r.pair_id) === txt(pairId));
  if (!row) throw new Error('Пара не найдена');
  const allowed = ['player_b_id','player_b_name','status','payer','pair_name','rating','note','confirmed_at'];
  const next = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(data, key)) next[key] = txt(data[key]);
  if (next.status && !PAIR_STATUS.includes(lower(next.status))) throw new Error('Неизвестный статус пары');
  if (!Object.keys(next).length) return row;
  await patch('pairs', row._rowNumber, next, test);
  await logAction(row.tournament_id, actor, 'pair_updated', pairId,
    Object.fromEntries(Object.keys(next).map(k => [k, row[k]])), next, '', test);
  return { ...row, ...next };
}

// Приглашение партнёра. Живёт до ответа: отказ не убивает заявку — пара
// возвращается в «ищу партнёра» и зовёт следующего.
export async function invitePartner(pairId, { toId = '', toName = '', toContact = '', channel = 'telegram' } = {}, actor = {}, test = false) {
  const pair = await findPair(pairId, test);
  if (!pair) throw new Error('Пара не найдена');
  if (lower(pair.status) === 'confirmed') throw new Error('Пара уже собрана');
  const invites = await rows('invites', test, false).catch(() => []);
  const open = invites.find(i => txt(i.pair_id) === txt(pairId) && lower(i.status) === 'pending');
  if (open) await patch('invites', open._rowNumber, { status: 'cancelled', responded_at: nowISO() }, test);
  const row = {
    invite_id: uid('inv'), tournament_id: txt(pair.tournament_id), pair_id: txt(pairId),
    from_id: txt(pair.player_a_id), from_name: txt(pair.player_a_name),
    to_id: txt(toId), to_name: txt(toName), to_contact: txt(toContact),
    channel: ['telegram','link','whatsapp'].includes(lower(channel)) ? lower(channel) : 'telegram',
    status: 'pending', message_id: '', created_at: nowISO(), responded_at: ''
  };
  await insert('invites', row, test);
  await updatePair(pairId, { player_b_id: txt(toId), player_b_name: txt(toName), status: 'invite_pending' }, actor, test);
  await logAction(pair.tournament_id, actor, 'pair_invited', pairId, '', { to: toName || toContact, channel: row.channel }, '', test);
  return row;
}

export async function findInvite(inviteId, test = false) {
  const all = await rows('invites', test, false).catch(() => []);
  return all.find(r => txt(r.invite_id) === txt(inviteId)) || null;
}
export async function pendingInvitesFor(playerId, test = false) {
  const all = await rows('invites', test, false).catch(() => []);
  return all.filter(r => lower(r.status) === 'pending' && txt(r.to_id) === txt(playerId));
}

// Согласие. Здесь же срабатывает встречное приглашение: если тот, кого зовут,
// сам уже позвал звавшего, это считается согласием обеих сторон.
export async function acceptInvite(inviteId, { playerId = '', playerName = '' } = {}, actor = {}, test = false) {
  const all = await rows('invites', test, false);
  const row = all.find(r => txt(r.invite_id) === txt(inviteId));
  if (!row) throw new Error('Приглашение не найдено');
  if (lower(row.status) !== 'pending') throw new Error('Приглашение уже обработано');
  const pair = await findPair(row.pair_id, test);
  if (!pair) throw new Error('Пара не найдена');
  await patch('invites', row._rowNumber, { status: 'accepted', responded_at: nowISO(), to_id: txt(playerId) || txt(row.to_id), to_name: txt(playerName) || txt(row.to_name) }, test);

  // Собственная заявка принявшего, если она была, растворяется в общей паре.
  const pairs = await rows('pairs', test, false);
  for (const p of pairs) {
    if (txt(p.tournament_id) !== txt(row.tournament_id)) continue;
    if (txt(p.pair_id) === txt(pair.pair_id)) continue;
    if (lower(p.status) === 'dissolved') continue;
    if (txt(p.player_a_id) !== txt(playerId) && txt(p.player_b_id) !== txt(playerId)) continue;
    await patch('pairs', p._rowNumber, { status: 'dissolved', note: `объединено с ${pair.pair_id}` }, test);
  }
  const updated = await updatePair(pair.pair_id, {
    player_b_id: txt(playerId) || txt(row.to_id),
    player_b_name: txt(playerName) || txt(row.to_name),
    status: 'confirmed', confirmed_at: nowISO()
  }, actor, test);
  const entry = await addEntry(row.tournament_id, {
    pair_id: pair.pair_id, display_name: pairLabel(updated), status: 'applied'
  }, actor, test);
  await logAction(row.tournament_id, actor, 'pair_confirmed', pair.pair_id, '', { entry_id: entry.entry_id }, '', test);
  return { invite: { ...row, status: 'accepted' }, pair: updated, entry };
}

export async function declineInvite(inviteId, actor = {}, test = false) {
  const all = await rows('invites', test, false);
  const row = all.find(r => txt(r.invite_id) === txt(inviteId));
  if (!row) throw new Error('Приглашение не найдено');
  if (lower(row.status) !== 'pending') return row;
  await patch('invites', row._rowNumber, { status: 'declined', responded_at: nowISO() }, test);
  // Заявка не умирает: пара снова ищет партнёра.
  await updatePair(row.pair_id, { player_b_id: '', player_b_name: '', status: 'seeking' }, actor, test);
  await logAction(row.tournament_id, actor, 'pair_invite_declined', row.pair_id, '', { to: row.to_name }, '', test);
  return { ...row, status: 'declined' };
}

// Встречное приглашение засчитываем как согласие: два человека позвали друг
// друга — спрашивать больше нечего.
export async function matchMutualInvites(tournamentId, test = false) {
  const invites = (await rows('invites', test, false).catch(() => []))
    .filter(i => txt(i.tournament_id) === txt(tournamentId) && lower(i.status) === 'pending');
  const done = [];
  for (const a of invites) {
    const b = invites.find(x => txt(x.from_id) === txt(a.to_id) && txt(x.to_id) === txt(a.from_id) && txt(x.invite_id) !== txt(a.invite_id));
    if (!b) continue;
    if (done.some(d => d.includes(txt(b.invite_id)))) continue;
    await acceptInvite(a.invite_id, { playerId: txt(a.to_id), playerName: txt(a.to_name) }, {}, test);
    await patch('invites', b._rowNumber, { status: 'accepted', responded_at: nowISO() }, test).catch(() => {});
    done.push([txt(a.invite_id), txt(b.invite_id)]);
  }
  return done;
}

// --------------------------------------------------------------------- стадии
export async function listStages(tournamentId, test = false, useCache = true) {
  const all = await rows('stages', test, useCache).catch(() => []);
  return all.filter(r => txt(r.tournament_id) === txt(tournamentId) && txt(r.stage_id))
    .sort((a, b) => num(a.order_index) - num(b.order_index));
}
export async function createStage(tournamentId, { kind = 'group', name = '', settings = {} } = {}, actor = {}, test = false) {
  const existing = await listStages(tournamentId, test, false);
  const row = {
    stage_id: uid('stg'), tournament_id: txt(tournamentId),
    kind: ['group','playoff'].includes(lower(kind)) ? lower(kind) : 'group',
    name: txt(name) || (lower(kind) === 'playoff' ? 'Плей-офф' : 'Групповой этап'),
    order_index: String(existing.length + 1), status: 'draft',
    settings: JSON.stringify(settings || {}), created_at: nowISO(), updated_at: nowISO()
  };
  await insert('stages', row, test);
  await logAction(tournamentId, actor, 'stage_created', row.stage_id, '', { kind: row.kind, name: row.name }, '', test);
  return row;
}
export async function setStageStatus(stageId, status, actor = {}, test = false) {
  const all = await rows('stages', test, false);
  const row = all.find(r => txt(r.stage_id) === txt(stageId));
  if (!row) throw new Error('Стадия не найдена');
  if (!['draft','active','validated'].includes(lower(status))) throw new Error('Неизвестный статус стадии');
  await patch('stages', row._rowNumber, { status: lower(status) }, test);
  await logAction(row.tournament_id, actor, 'stage_status', stageId, { status: row.status }, { status: lower(status) }, '', test);
  return { ...row, status: lower(status) };
}
export const stageSettings = stage => { try { return JSON.parse(txt(stage?.settings) || '{}'); } catch { return {}; } };

// --------------------------------------------------------------------- матчи
export async function listMatches(tournamentId, test = false, useCache = true) {
  const all = await rows('matches', test, useCache).catch(() => []);
  return all.filter(r => txt(r.tournament_id) === txt(tournamentId) && txt(r.match_id));
}
export async function findMatch(matchId, test = false) {
  const all = await rows('matches', test, false).catch(() => []);
  return all.find(r => txt(r.match_id) === txt(matchId)) || null;
}
async function insertMatches(list = [], test = false) {
  const out = [];
  for (const m of list) { await insert('matches', m, test); out.push(m); }
  return out;
}

// Круговая система «каруселью»: классический алгоритм, где один участник стоит
// на месте, а остальные проворачиваются. Даёт ровные туры без повторов.
export function roundRobinPairs(ids = []) {
  const list = ids.slice();
  if (list.length < 2) return [];
  if (list.length % 2) list.push(null);
  const n = list.length, roundsCount = n - 1, half = n / 2;
  const order = list.slice();
  const rounds = [];
  for (let r = 0; r < roundsCount; r++) {
    const pairs = [];
    for (let i = 0; i < half; i++) {
      const a = order[i], b = order[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    const fixed = order[0], rest = order.slice(1);
    rest.unshift(rest.pop());
    order.splice(0, order.length, fixed, ...rest);
  }
  return rounds;
}

// Змейка: 1-2-3-4 / 4-3-2-1. Стандарт распределения посева по группам — так
// сильные не собираются в одной группе.
export function snakeDistribute(seededIds = [], groupCount = 2) {
  const groups = Array.from({ length: Math.max(1, groupCount) }, () => []);
  seededIds.forEach((id, index) => {
    const row = Math.floor(index / groups.length);
    const col = index % groups.length;
    groups[row % 2 ? groups.length - 1 - col : col].push(id);
  });
  return groups;
}
export const groupNameByIndex = i => String.fromCharCode(65 + i);

// Распределение состава по группам. Метод выбирает админ: по рейтингу (змейка
// от сильного к слабому), случайно, или вручную — тогда трогаем только тех,
// у кого группа ещё не проставлена.
export async function distributeGroups(tournamentId, { groupCount = 2, method = 'rating', division = '' } = {}, actor = {}, test = false) {
  const entries = playingEntries(await listEntries(tournamentId, test, false))
    .filter(e => !division || txt(e.division) === txt(division));
  if (!entries.length) throw new Error('Нет принятых заявок');
  let ordered = entries.slice();
  if (lower(method) === 'random') ordered.sort(() => Math.random() - 0.5);
  else if (lower(method) === 'seed') ordered.sort((a, b) => (num(a.seed) || 999) - (num(b.seed) || 999));
  else ordered.sort((a, b) => num(b.rating) - num(a.rating) || txt(a.display_name).localeCompare(txt(b.display_name)));
  const groups = snakeDistribute(ordered.map(e => txt(e.entry_id)), groupCount);
  const items = [];
  groups.forEach((ids, index) => ids.forEach((entryId, place) => {
    items.push({ entry_id: entryId, group: groupNameByIndex(index), seed: String(place + 1), division: txt(division) });
  }));
  await assignEntries(tournamentId, items, actor, test);
  await logAction(tournamentId, actor, 'groups_distributed', division || 'все', '', { groupCount, method }, '', test);
  return items;
}

// Расписание группового этапа. Существующие матчи стадии сначала убираем —
// иначе повторная генерация наплодит дубли.
export async function generateGroupMatches(tournamentId, stageId, actor = {}, test = false) {
  const entries = playingEntries(await listEntries(tournamentId, test, false));
  const byGroup = new Map();
  for (const e of entries) {
    const key = txt(e.group) || '—';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(e);
  }
  const existing = (await listMatches(tournamentId, test, false)).filter(m => txt(m.stage_id) === txt(stageId));
  const played = existing.filter(m => lower(m.status) !== 'scheduled');
  if (played.length) throw new Error(`В этой стадии уже есть ${played.length} сыгранных матчей — сгенерировать заново нельзя`);
  const rowsAll = await rows('matches', test, false);
  for (const m of existing) {
    const found = rowsAll.find(r => txt(r.match_id) === txt(m.match_id));
    if (found) await patch('matches', found._rowNumber, { status: 'cancelled', note: 'пересобрано' }, test);
  }
  const created = [];
  for (const [group, list] of byGroup) {
    const sorted = list.slice().sort((a, b) => (num(a.seed) || 999) - (num(b.seed) || 999));
    const rounds = roundRobinPairs(sorted.map(e => txt(e.entry_id)));
    const nameOf = id => txt(sorted.find(e => txt(e.entry_id) === id)?.display_name || '');
    rounds.forEach((pairs, roundIndex) => pairs.forEach((pairIds, slot) => {
      created.push({
        match_id: uid('tm'), tournament_id: txt(tournamentId), stage_id: txt(stageId),
        group, round: String(roundIndex + 1), round_label: `Тур ${roundIndex + 1}`, slot: String(slot + 1),
        entry_a: pairIds[0], entry_a_name: nameOf(pairIds[0]),
        entry_b: pairIds[1], entry_b_name: nameOf(pairIds[1]),
        source_a: '', source_b: '', status: 'scheduled', score: '', winner_entry: '', result_reason: '',
        scheduled_at: '', court: '', reported_by: '', confirmed_by: '', note: '',
        created_at: nowISO(), updated_at: nowISO()
      });
    }));
  }
  await insertMatches(created, test);
  await setStageStatus(stageId, 'active', actor, test).catch(() => {});
  await logAction(tournamentId, actor, 'group_matches_generated', stageId, '', { matches: created.length }, '', test);
  return created;
}

// --------------------------------------------------------------- таблица групп
// Считается всегда из матчей. Ничего не хранится — правка счёта чинит таблицу
// сама. Порядок тай-брейков тот же, что в лиге: очки → победы → сеты → геймы.
export function parseScore(score = '') {
  const raw = txt(score).toUpperCase();
  if (!raw || /^(W\/O|L\/W|W\/L|L\/L)$/.test(raw)) return [];
  const sets = [];
  for (const token of raw.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)) {
    const m = token.match(/^(\d{1,2})[:\-](\d{1,2})$/);
    if (m) sets.push({ a: Number(m[1]), b: Number(m[2]) });
  }
  return sets;
}
export function standingsFor(entries = [], matches = [], scoring = DEFAULTS) {
  const table = new Map();
  const ensure = e => {
    const id = txt(e.entry_id);
    if (!table.has(id)) table.set(id, {
      entry_id: id, name: txt(e.display_name || e.player_name), group: txt(e.group), seed: num(e.seed),
      status: lower(e.status), played: 0, wins: 0, losses: 0, points: 0,
      setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0
    });
    return table.get(id);
  };
  entries.forEach(ensure);
  for (const m of matches) {
    const status = lower(m.status);
    if (['scheduled','cancelled','bye'].includes(status)) continue;
    const a = table.get(txt(m.entry_a)), b = table.get(txt(m.entry_b));
    if (!a || !b) continue;
    const winner = txt(m.winner_entry);
    a.played++; b.played++;
    const wa = winner === a.entry_id, wb = winner === b.entry_id;
    if (wa) { a.wins++; b.losses++; } else if (wb) { b.wins++; a.losses++; }
    if (status === 'walkover' || status === 'default') {
      if (wa) { a.points += scoring.win; b.points += scoring.walkover; }
      else if (wb) { b.points += scoring.win; a.points += scoring.walkover; }
      else { a.points += scoring.walkover; b.points += scoring.walkover; }
      continue;
    }
    if (wa) { a.points += scoring.win; b.points += scoring.loss; }
    else if (wb) { b.points += scoring.win; a.points += scoring.loss; }
    for (const set of parseScore(m.score)) {
      if (set.a > set.b) { a.setsWon++; b.setsLost++; } else if (set.b > set.a) { b.setsWon++; a.setsLost++; }
      const superTb = set.a >= 10 || set.b >= 10;
      if (!superTb) { a.gamesWon += set.a; a.gamesLost += set.b; b.gamesWon += set.b; b.gamesLost += set.a; }
    }
  }
  const list = [...table.values()].map(x => ({ ...x, setDiff: x.setsWon - x.setsLost, gameDiff: x.gamesWon - x.gamesLost }));
  const byGroup = new Map();
  for (const x of list) {
    const key = x.group || '—';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(x);
  }
  const out = [];
  for (const [group, players] of byGroup) {
    players.sort((a, b) => b.points - a.points || b.wins - a.wins || b.setDiff - a.setDiff
      || b.gameDiff - a.gameDiff || b.setsWon - a.setsWon || a.name.localeCompare(b.name));
    players.forEach((p, i) => out.push({ ...p, group, place: i + 1 }));
  }
  return out;
}

// ------------------------------------------------------------------ плей-офф
// Три схемы. cross_1_4 — одна группа, 1-4 и 2-3. cross_groups — две группы
// накрест: A1-B2, B1-A2. seeded_bracket — обычная сетка по посеву с байями.
export function buildPlayoffPlan(standings = [], { type = 'cross_1_4', advance = 4, thirdPlace = false } = {}) {
  const byGroup = new Map();
  for (const s of standings) {
    const key = s.group || '—';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(s);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.place - b.place);
  const groups = [...byGroup.keys()].sort();
  const seedOf = (group, place) => byGroup.get(group)?.find(x => x.place === place) || null;
  const semis = [];

  if (type === 'cross_groups' && groups.length >= 2) {
    const [g1, g2] = groups;
    semis.push({ label: 'Полуфинал 1', a: seedOf(g1, 1), b: seedOf(g2, 2), source_a: `${g1}#1`, source_b: `${g2}#2` });
    semis.push({ label: 'Полуфинал 2', a: seedOf(g2, 1), b: seedOf(g1, 2), source_a: `${g2}#1`, source_b: `${g1}#2` });
  } else if (type === 'seeded_bracket') {
    const pool = groups.flatMap(g => (byGroup.get(g) || []).slice(0, advance))
      .sort((a, b) => b.points - a.points || b.setDiff - a.setDiff || b.gameDiff - a.gameDiff);
    let size = 2; while (size < pool.length) size *= 2;
    for (let i = 0; i < size / 2; i++) {
      const a = pool[i] || null, b = pool[size - 1 - i] || null;
      semis.push({ label: `Матч ${i + 1}`, a, b, source_a: `#${i + 1}`, source_b: `#${size - i}` });
    }
  } else {
    const g = groups[0];
    semis.push({ label: 'Полуфинал 1', a: seedOf(g, 1), b: seedOf(g, 4), source_a: `${g}#1`, source_b: `${g}#4` });
    semis.push({ label: 'Полуфинал 2', a: seedOf(g, 2), b: seedOf(g, 3), source_a: `${g}#2`, source_b: `${g}#3` });
  }
  const rounds = [{ round: 1, label: semis.length > 2 ? 'Четвертьфиналы' : 'Полуфиналы', matches: semis }];
  let previous = semis;
  let roundNo = 2;
  while (previous.length > 1) {
    const next = [];
    for (let i = 0; i < previous.length; i += 2) {
      next.push({ label: previous.length === 2 ? 'Финал' : `Матч раунда ${roundNo}`, a: null, b: null,
        source_a: `W:${roundNo - 1}.${i + 1}`, source_b: `W:${roundNo - 1}.${i + 2}` });
    }
    rounds.push({ round: roundNo, label: next.length === 1 ? 'Финал' : `Раунд ${roundNo}`, matches: next });
    previous = next;
    roundNo++;
  }
  if (thirdPlace && semis.length === 2) {
    rounds.push({ round: roundNo, label: 'Матч за 3-е место', matches: [
      { label: 'Матч за 3-е место', a: null, b: null, source_a: 'L:1.1', source_b: 'L:1.2' }
    ] });
  }
  return rounds;
}

export async function generatePlayoff(tournamentId, { stageId = '', type = '', advance = 4, thirdPlace = null } = {}, actor = {}, test = false) {
  const tournament = await getTournament(tournamentId, test);
  if (!tournament) throw new Error('Турнир не найден');
  const stages = await listStages(tournamentId, test, false);
  const groupStage = stages.find(s => lower(s.kind) === 'group');
  if (!groupStage) throw new Error('Сначала нужен групповой этап');
  const entries = playingEntries(await listEntries(tournamentId, test, false));
  const groupMatches = (await listMatches(tournamentId, test, false)).filter(m => txt(m.stage_id) === txt(groupStage.stage_id));
  const unfinished = groupMatches.filter(m => lower(m.status) === 'scheduled');
  const table = standingsFor(entries, groupMatches, scoringOf(tournament));
  let stage = stages.find(s => lower(s.kind) === 'playoff' && (!stageId || txt(s.stage_id) === txt(stageId)));
  if (!stage) stage = await createStage(tournamentId, { kind: 'playoff', name: 'Плей-офф' }, actor, test);

  const existing = (await listMatches(tournamentId, test, false)).filter(m => txt(m.stage_id) === txt(stage.stage_id));
  const played = existing.filter(m => lower(m.status) !== 'scheduled' && lower(m.status) !== 'cancelled');
  if (played.length) throw new Error(`В плей-офф уже есть ${played.length} сыгранных матчей — пересобрать нельзя`);
  const rowsAll = await rows('matches', test, false);
  for (const m of existing) {
    const found = rowsAll.find(r => txt(r.match_id) === txt(m.match_id));
    if (found) await patch('matches', found._rowNumber, { status: 'cancelled', note: 'пересобрано' }, test);
  }
  const plan = buildPlayoffPlan(table, {
    type: type || lower(tournament.playoff_type) || 'cross_1_4',
    advance: advance || num(tournament.advance_per_group) || 4,
    thirdPlace: thirdPlace === null ? lower(tournament.third_place) === 'yes' : Boolean(thirdPlace)
  });
  const created = [];
  for (const round of plan) {
    round.matches.forEach((m, index) => {
      created.push({
        match_id: uid('tm'), tournament_id: txt(tournamentId), stage_id: txt(stage.stage_id),
        group: '', round: String(round.round), round_label: round.label, slot: String(index + 1),
        entry_a: txt(m.a?.entry_id), entry_a_name: txt(m.a?.name),
        entry_b: txt(m.b?.entry_id), entry_b_name: txt(m.b?.name),
        source_a: txt(m.source_a), source_b: txt(m.source_b),
        status: 'scheduled', score: '', winner_entry: '', result_reason: '',
        scheduled_at: '', court: '', reported_by: '', confirmed_by: '', note: '',
        created_at: nowISO(), updated_at: nowISO()
      });
    });
  }
  await insertMatches(created, test);
  await setStageStatus(stage.stage_id, 'active', actor, test).catch(() => {});
  await logAction(tournamentId, actor, 'playoff_generated', stage.stage_id, '',
    { matches: created.length, unfinished: unfinished.length }, '', test);
  return { stage, matches: created, warning: unfinished.length ? `В группе ещё ${unfinished.length} несыгранных матчей — сетка собрана по текущей таблице` : '' };
}

// Победитель уезжает в следующий раунд. Источник записан в самом матче
// (`W:1.2` — победитель второго матча первого раунда), поэтому продвижение —
// это просто заполнение пустого слота, а не отдельная структура.
async function propagateWinners(tournamentId, stageId, test = false) {
  const all = await rows('matches', test, false);
  const stageMatches = all.filter(m => txt(m.tournament_id) === txt(tournamentId) && txt(m.stage_id) === txt(stageId));
  const at = (round, slot) => stageMatches.find(m => num(m.round) === round && num(m.slot) === slot && lower(m.status) !== 'cancelled');
  const resolve = source => {
    const m = txt(source).match(/^([WL]):(\d+)\.(\d+)$/);
    if (!m) return null;
    const src = at(Number(m[2]), Number(m[3]));
    if (!src || !txt(src.winner_entry)) return null;
    const winner = txt(src.winner_entry);
    if (m[1] === 'W') return { id: winner, name: winner === txt(src.entry_a) ? txt(src.entry_a_name) : txt(src.entry_b_name) };
    const loser = winner === txt(src.entry_a) ? txt(src.entry_b) : txt(src.entry_a);
    if (!loser) return null;
    return { id: loser, name: loser === txt(src.entry_a) ? txt(src.entry_a_name) : txt(src.entry_b_name) };
  };
  for (const m of stageMatches) {
    if (lower(m.status) !== 'scheduled') continue;
    const next = {};
    if (!txt(m.entry_a) && txt(m.source_a)) { const r = resolve(m.source_a); if (r) { next.entry_a = r.id; next.entry_a_name = r.name; } }
    if (!txt(m.entry_b) && txt(m.source_b)) { const r = resolve(m.source_b); if (r) { next.entry_b = r.id; next.entry_b_name = r.name; } }
    if (Object.keys(next).length) await patch('matches', m._rowNumber, next, test);
  }
}

// -------------------------------------------------------- результат и правка
// Один вход и для первичного внесения, и для исправления. Правка — обычная
// запись с журналом: ничего не блокируется, потому что человек с телефона
// ошибается, и запрет на правку тут вреднее, чем польза от «защиты».
export async function setMatchResult(matchId, data = {}, actor = {}, test = false) {
  const all = await rows('matches', test, false);
  const row = all.find(r => txt(r.match_id) === txt(matchId));
  if (!row) throw new Error('Матч не найден');
  const status = MATCH_STATUS.includes(lower(data.status)) ? lower(data.status) : 'completed';
  const sides = [txt(row.entry_a), txt(row.entry_b)].filter(Boolean);
  let winner = txt(data.winner_entry);
  if (winner && !sides.includes(winner)) throw new Error('Победитель не из этого матча');
  const score = txt(data.score);

  if (status === 'completed') {
    const sets = parseScore(score);
    if (!sets.length) throw new Error('Нужен счёт вида 6:4 7:5');
    if (!winner) {
      let a = 0, b = 0;
      for (const s of sets) { if (s.a > s.b) a++; else if (s.b > s.a) b++; }
      if (a === b) throw new Error('По счёту не видно победителя — укажите его явно');
      winner = a > b ? sides[0] : sides[1];
    }
  }
  if (['walkover','default'].includes(status) && !winner) throw new Error('Для W/O и DEF нужен победитель');

  const before = { status: row.status, score: row.score, winner_entry: row.winner_entry, result_reason: row.result_reason };
  const next = {
    status, score, winner_entry: winner,
    result_reason: txt(data.result_reason), note: txt(data.note) || txt(row.note),
    scheduled_at: Object.prototype.hasOwnProperty.call(data, 'scheduled_at') ? txt(data.scheduled_at) : txt(row.scheduled_at),
    court: Object.prototype.hasOwnProperty.call(data, 'court') ? txt(data.court) : txt(row.court),
    reported_by: txt(data.reported_by) || txt(row.reported_by),
    confirmed_by: txt(actor.id || actor.telegram_id)
  };
  await patch('matches', row._rowNumber, next, test);
  const corrected = txt(row.status) && lower(row.status) !== 'scheduled';
  await logAction(row.tournament_id, actor, corrected ? 'result_corrected' : 'result_entered', matchId, before, next, '', test);
  await propagateWinners(row.tournament_id, row.stage_id, test).catch(e => console.error('propagate failed:', e.message));
  return { ...row, ...next, corrected };
}

// Ручное действие над слотом сетки — то же меню, что в теннисных системах:
// подменить участника, поставить проход без игры, снять.
export async function slotAction(matchId, { side = 'a', action = 'swap', entryId = '' } = {}, actor = {}, test = false) {
  const all = await rows('matches', test, false);
  const row = all.find(r => txt(r.match_id) === txt(matchId));
  if (!row) throw new Error('Матч не найден');
  const key = lower(side) === 'b' ? 'b' : 'a';
  const before = { entry: row[`entry_${key}`], name: row[`entry_${key}_name`], status: row.status };
  const next = {};
  if (action === 'swap') {
    if (!txt(entryId)) throw new Error('Не выбран участник');
    const entries = await listEntries(row.tournament_id, test, false);
    const entry = entries.find(e => txt(e.entry_id) === txt(entryId));
    if (!entry) throw new Error('Участник не найден');
    next[`entry_${key}`] = txt(entryId);
    next[`entry_${key}_name`] = txt(entry.display_name || entry.player_name);
  } else if (action === 'clear') {
    next[`entry_${key}`] = ''; next[`entry_${key}_name`] = '';
  } else if (action === 'bye') {
    const other = key === 'a' ? txt(row.entry_b) : txt(row.entry_a);
    next[`entry_${key}`] = ''; next[`entry_${key}_name`] = 'BYE';
    next.status = 'bye'; next.winner_entry = other; next.score = 'BYE';
  } else throw new Error('Неизвестное действие');
  await patch('matches', row._rowNumber, next, test);
  await logAction(row.tournament_id, actor, 'slot_action', matchId, before, { action, ...next }, '', test);
  await propagateWinners(row.tournament_id, row.stage_id, test).catch(() => {});
  return { ...row, ...next };
}

export async function createManualTournamentMatch(tournamentId, data = {}, actor = {}, test = false) {
  const entries = await listEntries(tournamentId, test, false);
  const pick = id => entries.find(e => txt(e.entry_id) === txt(id));
  const a = pick(data.entry_a), b = pick(data.entry_b);
  if (!a || !b) throw new Error('Выберите двух участников');
  if (txt(a.entry_id) === txt(b.entry_id)) throw new Error('Участники должны быть разными');
  const stages = await listStages(tournamentId, test, false);
  const stageId = txt(data.stage_id) || txt(stages.find(s => lower(s.kind) === 'group')?.stage_id) || txt(stages[0]?.stage_id);
  const row = {
    match_id: uid('tm'), tournament_id: txt(tournamentId), stage_id: stageId,
    group: txt(data.group) || (txt(a.group) === txt(b.group) ? txt(a.group) : 'cross'),
    round: txt(data.round) || '0', round_label: txt(data.round_label) || 'Дополнительный матч', slot: '0',
    entry_a: txt(a.entry_id), entry_a_name: txt(a.display_name || a.player_name),
    entry_b: txt(b.entry_id), entry_b_name: txt(b.display_name || b.player_name),
    source_a: '', source_b: '', status: 'scheduled', score: '', winner_entry: '', result_reason: '',
    scheduled_at: txt(data.scheduled_at), court: txt(data.court), reported_by: '', confirmed_by: '',
    note: txt(data.note), created_at: nowISO(), updated_at: nowISO()
  };
  await insert('matches', row, test);
  await logAction(tournamentId, actor, 'match_created', row.match_id, '', { a: row.entry_a_name, b: row.entry_b_name }, '', test);
  if (txt(data.score) || (data.status && lower(data.status) !== 'scheduled')) {
    invalidateSheetCache();
    return setMatchResult(row.match_id, data, actor, test);
  }
  return row;
}

// ------------------------------------------------------------------- сборка
// Всё состояние турнира одним чтением: админке нужны сразу и заявки, и пары,
// и сетка, и таблица. Отдельными запросами это было бы четыре круга к Google.
export async function tournamentState(tournamentId, test = false) {
  const tournament = await getTournament(tournamentId, test);
  if (!tournament) throw new Error('Турнир не найден');
  // Каждый лист читаем со своей страховкой: если один недоступен, экран всё
  // равно откроется, а не встретит человека пустой ошибкой.
  const safe = (promise, fallback) => promise.catch(e => { console.error('tournament state:', e.message); return fallback; });
  const doubles = lower(tournament.kind) === 'doubles';
  const [entries, pairs, stages, matches, inviteRows] = await Promise.all([
    safe(listEntries(tournamentId, test), []),
    doubles ? safe(listPairs(tournamentId, test), []) : Promise.resolve([]),
    safe(listStages(tournamentId, test), []),
    safe(listMatches(tournamentId, test), []),
    doubles ? safe(rows('invites', test), []) : Promise.resolve([])
  ]);
  const invites = inviteRows.filter(i => txt(i.tournament_id) === txt(tournamentId));
  const groupStage = stages.find(s => lower(s.kind) === 'group');
  const groupMatches = groupStage ? matches.filter(m => txt(m.stage_id) === txt(groupStage.stage_id) && lower(m.status) !== 'cancelled') : [];
  const standings = standingsFor(playingEntries(entries), groupMatches, scoringOf(tournament));
  return {
    tournament, entries, pairs, invites, stages, standings,
    matches: matches.filter(m => lower(m.status) !== 'cancelled'),
    counts: {
      entries: entries.length,
      accepted: playingEntries(entries).length,
      withdrawn: entries.filter(e => lower(e.status) === 'withdrawn').length,
      played: matches.filter(m => !['scheduled','cancelled'].includes(lower(m.status))).length,
      scheduled: matches.filter(m => lower(m.status) === 'scheduled').length
    }
  };
}

// Кандидаты в участники: активные игроки лиги плюс состав текущего сезона.
// Ничего никуда не пишем — это просто список, из которого админ выбирает.
export async function candidatePlayers(season = '') {
  const [league, roster, applicants] = await Promise.all([
    getAllActiveLeaguePlayers().catch(() => []),
    seasonRoster(season).catch(() => ({ players: [] })),
    getAllApplicants().catch(() => [])
  ]);
  // Рейтинг берём из анкеты: в составе сезона его нет, а распределение по
  // группам без метрики превращается в лотерею.
  const ratingOf = name => txt(applicants.find(a => sameName(a.name, name))?.ntrp || '');
  const out = new Map();
  for (const p of league) {
    const key = txt(p.telegram_id) || lower(p.name);
    if (!key) continue;
    out.set(key, {
      telegram_id: txt(p.telegram_id), name: txt(p.name),
      division: txt(p.division), group: txt(p.group), rating: ratingOf(p.name), season: txt(p.season)
    });
  }
  for (const p of roster.players || []) {
    const hit = [...out.values()].find(x => sameName(x.name, p.name));
    if (hit) { hit.division = hit.division || divisionDisplayName(p.letter); hit.group = hit.group || txt(p.group); continue; }
    out.set(lower(p.name), {
      telegram_id: '', name: txt(p.name), division: divisionDisplayName(p.letter),
      group: txt(p.group), rating: ratingOf(p.name), season: txt(roster.season)
    });
  }
  return [...out.values()].sort((a, b) => txt(a.division).localeCompare(txt(b.division))
    || txt(a.group).localeCompare(txt(b.group)) || txt(a.name).localeCompare(txt(b.name)));
}

// Перенос действующего сезона лиги в турнир. Таблицы организатора только
// читаются: состав копируется в турнирные листы, дальше турнир живёт своей
// жизнью. Это и есть безопасный способ пощупать плей-офф на реальных людях.
export async function importSeason(season = '', { division = '', name = '' } = {}, actor = {}, test = false) {
  const use = season || await latestSeason();
  const roster = await seasonRoster(use);
  let players = roster.players || [];
  if (division) players = players.filter(p => divisionLetter(p.letter) === divisionLetter(division));
  if (!players.length) throw new Error('В этом сезоне состав не найден');
  const groups = new Set(players.map(p => txt(p.group)).filter(Boolean));
  const tournament = await createTournament({
    name: name || `Сезон ${use}${division ? ` · дивизион ${divisionLetter(division)}` : ''}`,
    kind: 'singles', season: use, status: 'running',
    format: 'groups_playoff', playoff_type: groups.size > 1 ? 'cross_groups' : 'cross_1_4',
    group_count: String(Math.max(1, groups.size)), advance_per_group: '4',
    source: `season:${use}${division ? `:${divisionLetter(division)}` : ''}`
  }, actor, test);
  const stage = await createStage(tournament.tournament_id, { kind: 'group', name: 'Групповой этап' }, actor, test);
  const league = await getAllActiveLeaguePlayers().catch(() => []);
  const idOf = name => txt(league.find(p => sameName(p.name, name))?.telegram_id || '');
  // Одним запросом, а не по строке на человека: тридцать отдельных записей
  // подряд Google обслуживает медленно, и ответ успевает оборваться.
  const rows = players.map((p, index) => ({
    entry_id: uid('ent'), tournament_id: tournament.tournament_id, entrant_type: 'player',
    player_id: idOf(p.name), player_name: txt(p.name), pair_id: '', display_name: txt(p.name),
    status: 'accepted', seed: String(index + 1), rating: '',
    division: divisionDisplayName(p.letter), group: txt(p.group) || groupNameByIndex(0),
    checked_in_at: '', withdrawn_at: '', withdrawal_reason: '', replaced_by: '',
    payment_status: '', note: '', created_at: nowISO(), updated_at: nowISO()
  }));
  await insertMany('entries', rows, test);
  await logAction(tournament.tournament_id, actor, 'season_imported', use, '', { players: players.length, division }, '', test);
  return { tournament, stage, players: players.length };
}
