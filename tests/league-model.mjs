// Модель лиги из общего журнала матчей (leaguemodel.js): разбор журнала,
// история и статистика игроков, резерв на таблицу профилей, сверка,
// хранение JSON, переключатель источника и подключение в сервер.
// Запуск: node tests/league-model.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.BOT_TOKEN ||= 'test';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lm = await import('../leaguemodel.js');
let checks = 0;
const check = (c, m) => { assert.ok(c, m); checks++; };

// Журнал: шапка как у Cross_Division_Match_Log, колонки на привычных местах.
const header = Array(41).fill('');
Object.assign(header, { 0: 'Match #', 1: 'Date', 3: 'Competition', 4: 'P1 ID', 5: 'P1 Division', 6: 'P2 ID', 7: 'P2 Division', 8: 'P1 Name', 9: 'P2 Name', 23: 'Completed?', 24: 'Winner ID' });
const row = ({ no, date, comp = '', p1, id1, p2, id2, div = 'C', sets = [], done = 'Yes', win = '', mark = '', pts = [] }) => {
  const r = Array(41).fill('');
  Object.assign(r, { 0: no, 1: date, 3: comp, 4: id1, 5: div, 6: id2, 7: div, 8: p1, 9: p2, 23: done, 24: win, 27: mark });
  sets.forEach((s, i) => { r[10 + i * 4] = s[0]; r[11 + i * 4] = s[1]; if (s.length > 2) { r[12 + i * 4] = s[2]; r[13 + i * 4] = s[3]; } });
  if (pts.length) { r[39] = pts[0]; r[40] = pts[1]; }
  return r;
};
const serial = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
const values = [header,
  row({ no: 1, date: serial('2025-05-10'), comp: 'Season 1', p1: 'Old Timer', id1: 9, p2: 'Dana Kolomoets', id2: 4, sets: [[6, 2], [6, 3]], win: 9 }),
  row({ no: 2, date: serial('2026-09-20'), comp: 'Season 2', p1: 'David Berov', id1: 7, p2: 'Ivan Petrov', id2: 5, sets: [[6, 4], [7, 6, 7, 3]], win: 7 }),
  row({ no: 3, date: serial('2026-09-27'), comp: '', p1: 'Max Moon', id1: 6, p2: 'David Berov', id2: 7, sets: [[6, 1], [4, 6], [10, 8]], win: 6 }),
  row({ no: 4, date: '05.10.2026', comp: 'Season 2', p1: 'David Berov', id1: 7, p2: 'Lev Lee', id2: 8, done: '', mark: 'W/L', pts: [3, 0] }),
  row({ no: 5, date: serial('2026-10-06'), comp: 'Season 2', p1: 'Ivan Petrov', id1: 5, p2: 'Lev Lee', id2: 8, done: '', mark: 'L/L', pts: [0, 0] }),
  row({ no: 6, date: serial('2026-10-07'), comp: 'Season 2', p1: 'Max Moon', id1: 6, p2: 'Ivan Petrov', id2: 5, sets: [[6, 4], [6, 7, 8, 10], [3, 1]], mark: 'RET', win: 6 }),
  row({ no: 7, date: '', comp: 'Season 2', p1: 'Lev Lee', id1: 8, p2: 'Max Moon', id2: 6, done: '' }),           // ещё не сыгран
  row({ no: 8, date: serial('2026-11-07'), comp: 'Semifinal S2', p1: 'Max Moon', id1: 6, p2: 'David Berov', id2: 7, sets: [[6, 3], [6, 3]], win: 6 })
];

// ---------------------------------------------------------------- журнал
const log = lm.normalizeLog(values);
check(log.matches.length === 7 && log.skipped === 1, 'Несыгранная строка пропускается, остальные 7 матчей читаются');
check(log.matches[0].date === '2025-05-10' && log.matches[3].date === '2026-10-05', 'Дата из сериала таблицы и из строки «05.10.2026» — в одном виде');
check(log.matches[2].season === '2', 'Пустая подпись сезона берётся у соседних строк журнала');
check(log.matches.find(m => m.no === '4').kind === 'technical' && log.matches.find(m => m.no === '4').winner === 'p1', 'Техпобеда W/L распознаётся');
check(log.matches.find(m => m.no === '5').kind === 'double' && !log.matches.find(m => m.no === '5').winner, 'Двойное техническое — победителя нет');
check(log.matches.find(m => m.no === '6').kind === 'retired' && log.matches.find(m => m.no === '6').winner === 'p1', 'Отказ (RET) — победитель по Winner ID');
// Снялся тот, кто вёл по счёту: Winner ID (по сетам) указывает на него, но
// победитель — соперник. Решают «кто снялся», затем очки за матч.
{const leader = row({ no: 9, date: serial('2026-10-29'), comp: 'Season 2', p1: 'Nik Tati', id1: 57, p2: 'Ilia Iz', id2: 26, sets: [[3, 4]], mark: 'RET', win: 26, pts: [3, 1] });
 const byQuit = [...leader]; byQuit[41] = 'P2'; byQuit[39] = ''; byQuit[40] = '';
 const h2 = [...header]; h2[41] = 'Retired Player';
 check(lm.normalizeLog([h2, leader]).matches[0].winner === 'p1', 'RET: снявшийся вёл по счёту — победитель по очкам за матч, не по сетам');
 check(lm.normalizeLog([h2, byQuit]).matches[0].winner === 'p1', 'RET: колонка «Retired Player» решает, кто победил');}
check(log.matches.find(m => m.no === '8').season === '2' && log.matches.find(m => m.no === '8').competition === 'Semifinal S2', 'Плей-офф: сезон из «Semifinal S2», подпись стадии сохраняется');
check(lm.scoreText(log.matches[2].sets) === '6:1 / 4:6 / TB 10:8' && lm.scoreText(log.matches[2].sets, { flip: true }) === '1:6 / 6:4 / TB 8:10', 'Счёт глазами каждого игрока, супертай-брейк как в сетке дивизиона');
check(lm.scoreText(log.matches[1].sets, { flip: true }) === '4:6 / 6:7 (3:7)', 'Тай-брейк сета переворачивается вместе со счётом');
check(lm.isoDate(46308) === '2026-10-13' && lm.isoDate('2026-10-13') === '2026-10-13' && lm.isoDate('') === '', 'Дата: сериал, ISO, пусто');

// ---------------------------------------------------------------- модель
const profiles = [
  { id: '107', name: 'David Berov', matches: 3, wins: 2, losses: 1, win_rate: '67', form: ['W'] },
  { id: '104', name: 'Dana Kolomoets', matches: 1, wins: 0, losses: 1 },
  { id: '105', name: 'Ivan Petrov', matches: 3, wins: 0, losses: 3 },
  { id: '106', name: 'Max Moon', matches: 4, wins: 4, losses: 0 },
  { id: '108', name: 'Lev Lee', matches: 2, wins: 0, losses: 2 },
  { id: '110', name: 'Ghost Player', matches: 2, wins: 1, losses: 1 },
  { id: '111', name: 'Only Sheet', matches: 1, wins: 1, losses: 0 }
];
// Таблица профилей: у Дэвида история пустая (как на скриншоте), у Ghost есть
// матчи сезона 2, которых журнал не знает, у Only Sheet — только сезон 0.
const sheetHistory = new Map([
  ['110', [{ match_no: '50', season: '2', result: 'WIN', opponent: 'X', score: '6:0 6:0' }, { match_no: '51', season: '2', result: 'LOST', opponent: 'Y', score: '0:6 0:6' }]],
  ['111', [{ match_no: '3', season: '0', result: 'WIN', opponent: 'Z', score: '6:1 6:1' }]],
  ['104', [{ match_no: '1', season: '1', result: 'LOST', opponent: 'Old Timer', score: '2:6 3:6' }]]
]);
const model = lm.buildModel(log.matches, profiles);
check(model.byPlayer.get('107').length === 4, 'У Дэвида 4 матча из журнала (3 регулярки + полуфинал), хотя в таблице профилей история пустая');
check(model.unmatched.some(u => u.name === 'Old Timer'), 'Имя из журнала без профиля попадает в список «без профиля»');
const applied = lm.applyModel(profiles, sheetHistory, model);
const david = applied.players.find(p => p.id === '107');
check(david.model && david.matches === 4 && david.wins === 2 && david.losses === 2 && david.win_rate === '50', 'Статистика Дэвида посчитана из журнала: 4 матча, 2–2, 50%');
check(JSON.stringify(david.form) === JSON.stringify(['W', 'L', 'W', 'L']) && david.seasons === 1, 'Форма по порядку журнала, один сезон');
const dh = applied.history.get('107');
check(dh[0].competition === 'Semifinal S2' && dh[0].result === 'LOST' && dh[0].opponent_id === '106', 'История — свежие сверху, соперник узнан по профилю (кликабелен)');
check(dh.some(m => m.score === 'W/O' && m.result === 'WIN') && !dh.some(m => '_k' in m), 'Техпобеда в истории — «W/O»; служебных полей наружу нет');
const ivan = applied.players.find(p => p.id === '105');
check(ivan.matches === 3 && ivan.wins === 0 && ivan.losses === 3, 'Двойное техническое и отказ считаются поражениями');
check(applied.players.find(p => p.id === '110') === profiles[5] && applied.fallback.includes('Ghost Player') && applied.history.get('110').length === 2, 'Игрок, которого журнал не знает, остаётся целиком на таблице профилей');
const dana = applied.players.find(p => p.id === '104');
check(dana.model && dana.matches === 1 && applied.history.get('104').length === 1, 'Сезон из журнала не дублируется таблицей: у Даны один матч сезона 1');
const only = applied.players.find(p => p.id === '111');
check(only.model && only.matches === 1 && applied.history.get('111')[0].season === '0', 'Сезон, которого в журнале нет совсем, берётся из таблицы профилей');

// Луи «сыграл сам с собой»: соперника нет в профилях, а его id из
// Players_Master совпал с id Луи в профилях. Теперь — только по имени.
{
  const lp = [{ id: '7', name: 'Louie Murray' }, { id: '8', name: 'Philipp Meyer-Galow' }];
  const rows = lm.normalizeLog([header,
    row({ no: 193, date: serial('2026-10-17'), comp: 'Season 2', p1: 'Louie Murray', id1: 3, p2: 'Sergei Sokolov', id2: 7, sets: [[6, 4], [1, 6], [10, 7]], win: 3 }),
    row({ no: 194, date: serial('2026-10-18'), comp: 'Season 2', p1: 'Louie Murray', id1: 3, p2: 'Louie Murray', id2: 3, sets: [[6, 0], [6, 0]], win: 3 }),
    row({ no: 195, date: serial('2026-10-18'), comp: 'Season 2', p1: 'Philipp Meyer-Galow', id1: 8, p2: 'Louie Murray', id2: 7, sets: [[6, 2], [6, 2]], win: 8 })
  ]).matches;
  const m2 = lm.buildModel(rows, lp, { sameName: (a, b) => a.toLowerCase() === b.toLowerCase() });
  const louie = m2.byPlayer.get('7') || [];
  check(louie.length === 2 && !louie.some(x => x.opponent_id === '7' || x.opponent === 'Louie Murray'), 'Луи не играет сам с собой: соперник не подменяется по совпавшему id');
  check(louie.find(x => x.match_no === '193')?.opponent === 'Sergei Sokolov' && louie.find(x => x.match_no === '193')?.opponent_id === '', 'Соперник без профиля — по имени из журнала, без ссылки на чужую карточку');
  check(m2.unmatched.some(u => u.name === 'Sergei Sokolov') && m2.selfMatches.length === 1 && m2.selfMatches[0].no === '194', 'Неузнанное имя и строка «сам с собой» попадают в отчёт, матч не учитывается');
  const loose = lm.buildModel(lm.normalizeLog([header, row({ no: 1, date: serial('2026-10-01'), comp: 'Season 2', p1: 'Alex Kim', id1: 1, p2: 'Sam Lee', id2: 2, sets: [[6, 1], [6, 1]], win: 1 })]).matches,
    [{ id: '1', name: 'Alex Kim' }, { id: '2', name: 'Alexander Kim' }], { sameName: () => true });
  check((loose.byPlayer.get('1') || []).length === 1 && !(loose.byPlayer.get('2') || []).length, 'Точное имя важнее похожего; неоднозначная похожесть не угадывается');
}

// ---------------------------------------------------------------- сверка
const diff = lm.diffModel(profiles, sheetHistory, applied);
const dDavid = diff.find(r => r.name === 'David Berov');
check(dDavid && dDavid.sheetProfile === 3 && dDavid.sheetHist === 0 && dDavid.model === 4, 'Сверка показывает Дэвида: профиль 3 / история 0 → журнал 4');
check(diff.find(r => r.name === 'Ghost Player')?.model === null, 'Сверка показывает тех, кого журнал не знает');
check(!diff.some(r => r.name === 'Only Sheet'), 'Совпадающих игроков в сверке нет');
const txt = lm.diffText({ rows: diff, unmatched: model.unmatched, total: profiles.length });
check(/David Berov: 3 \/ 0 → 4/.test(txt) && /нет в журнале/.test(txt) && /Old Timer/.test(txt), 'Текст сверки читается: профиль / история → журнал');
check(/Расхождений нет/.test(lm.diffText({ rows: [], unmatched: [], total: 5 })), 'Без расхождений — короткое «расхождений нет»');

// ---------------------------------------------------------------- хранение и переключатель
const big = 'x'.repeat(95000);
const parts = lm.chunkText(big);
check(parts.length === 3 && parts.every(p => p.length <= 40000) && parts.join('') === big, 'JSON режется на куски по ячейкам (в ячейке ≤ 50 000 символов) и собирается обратно');
const snap = { players: [{ id: '1', name: 'A' }], matches: { 1: [] }, source: 'live' };
check(lm.parseStored(JSON.stringify({ version: 1, saved_at: 'x', snapshot: snap }))?.snapshot.source === 'live', 'Сохранённый снимок читается обратно');
check(lm.parseStored('{oops') === null && lm.parseStored(JSON.stringify({ snapshot: { foo: 1 } })) === null, 'Битый или чужой файл не подхватывается');
check(lm.normalizeSource('live') === 'live' && lm.normalizeSource('LIVE ') === 'live' && lm.normalizeSource('') === 'sheets' && lm.normalizeSource('xyz') === 'sheets', 'Источник по умолчанию — sheets; live только явно');
check(!lm.diffDue(Date.parse('2026-10-17T02:00:00Z')) && lm.diffDue(Date.parse('2026-10-17T04:00:00Z')), 'Ежедневная сверка — не раньше 10:00 по Пхукету');

// ---------------------------------------------------------------- подключение
const index = await fs.readFile(path.join(root, 'index.js'), 'utf8');
check(/source === 'live'\) \{\s*const live = await buildLiveLeague\(sheetPlayers, sheetHistory\)/.test(index), 'Витрина берёт модель только при league_source = live');
check(/modelFailed = true; return null;/.test(index) && /rawPlayers = sheetPlayers, history = sheetHistory/.test(index), 'Журнал не прочитался — страница остаётся на таблице профилей');
check(/const switched = Boolean\(leagueSnapshot\.v\) && \(leagueSnapshot\.v\.source \|\| 'sheets'\) !== source/.test(index), 'Смена источника в Settings пересобирает снимок без деплоя');
check(/loadStoredSnapshot\(\)/.test(index) && /storeSnapshot\(v\)/.test(index), 'Снимок сохраняется в JSON и берётся при старте');
check(/runDailyDiff\(Date\.now\(\), diffChat\)/.test(index), 'Ежедневная сверка подключена к планировщику');
check((index.match(/await leagueHistorySource\(\)/g) || []).length === 2, 'Лента матчей и сводка сезонов тоже идут из выбранного источника');
const bot = await fs.readFile(path.join(root, 'bot.js'), 'utf8');
const tg = await fs.readFile(path.join(root, 'telegram.js'), 'utf8');
const g = await fs.readFile(path.join(root, 'google.js'), 'utf8');
check(/auth\/drive'\]/.test(g), 'Доступ к Диску позволяет перезаписать файл модели');

console.log(`PASS: ${checks} league model checks — journal parsing, stats, fallback, diff, JSON storage, source switch.`);
process.exit(0);
