// Плей-офф и сводка темпа: сетка, публикация, продвижение, решения по
// несыгранным матчам, афиша, сайт; темп сезона и шорт-лист.
// Все таблицы и Telegram — в памяти. Запуск: node --experimental-vm-modules tests/playoff.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const sp = v => String(v || '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------ таблицы в памяти
const tables = new Map();
const put = (id, title, rows) => tables.set(id + '|' + title, structuredClone(rows));
const col = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
function rangeInfo(id, range) {
  const m = /^'?([^'!]+)'?!([A-Z]+)(\d*)?(?::([A-Z]+)(\d*)?)?$/.exec(range);
  if (!m) throw Error('Unsupported range ' + range);
  return { key: id + '|' + m[1], c1: col(m[2]), r1: Number(m[3] || 1) - 1, c2: col(m[4] || m[2]), r2: m[5] ? Number(m[5]) - 1 : (m[4] ? Infinity : Number(m[3] || 1) - 1) };
}
// Таблица с формулами: рядом с листом лежит «#f» — что видно при чтении
// формул (valueRenderOption FORMULA). Запись формулы считается просто:
// «место k» — id k (в A id совпадают с местами), остальные формулы — пусто.
const evalFormula = v => { const t = String(v ?? ''); if (!t.startsWith('=')) return v; const m = t.match(/MATCH\((\d+),/); return m ? m[1] : ''; };
const sheetsOf = spreadsheetId => [...tables.keys()].filter(k => k.startsWith(spreadsheetId + '|') && !k.endsWith('#f'));
const writeCells = (spreadsheetId, range, values) => {
  const r = rangeInfo(spreadsheetId, range), rows = tables.get(r.key) || [], f = tables.get(r.key + '#f');
  values.forEach((row, i) => { rows[r.r1 + i] ||= []; if (f) f[r.r1 + i] ||= []; row.forEach((v, j) => { rows[r.r1 + i][r.c1 + j] = f ? evalFormula(v) : v; if (f) f[r.r1 + i][r.c1 + j] = v; }); });
  tables.set(r.key, rows);
};
const google = { spreadsheets: {
  get: async ({ spreadsheetId }) => ({ data: { sheets: sheetsOf(spreadsheetId).map((k, i) => ({ properties: { title: k.split('|')[1], sheetId: i, gridProperties: { columnCount: 26 } } })) } }),
  batchUpdate: async ({ spreadsheetId, requestBody }) => {
    for (const r of requestBody.requests || []) {
      if (r.addSheet) put(spreadsheetId, r.addSheet.properties.title, []);
      if (r.copyPaste) {
        const key = sheetsOf(spreadsheetId)[r.copyPaste.source.sheetId], from = r.copyPaste.source.startRowIndex, to = r.copyPaste.destination.startRowIndex;
        for (const k of [key, key + '#f']) { const t = tables.get(k); if (t) t[to] = structuredClone(t[from] || []); }
      }
    }
    return { data: {} };
  },
  values: {
    get: async ({ spreadsheetId, range, valueRenderOption }) => { const r = rangeInfo(spreadsheetId, range), key = valueRenderOption === 'FORMULA' && tables.has(r.key + '#f') ? r.key + '#f' : r.key, rows = tables.get(key) || []; return { data: { values: rows.slice(r.r1, Number.isFinite(r.r2) ? r.r2 + 1 : undefined).map(x => (x || []).slice(r.c1, r.c2 + 1)) } }; },
    update: async ({ spreadsheetId, range, requestBody }) => { writeCells(spreadsheetId, range, requestBody.values); return { data: {} }; },
    batchUpdate: async ({ spreadsheetId, requestBody }) => { for (const d of requestBody.data || []) writeCells(spreadsheetId, d.range, d.values); return { data: {} }; },
    append: async ({ spreadsheetId, range, requestBody }) => { const r = rangeInfo(spreadsheetId, range), rows = tables.get(r.key) || []; rows.push(...structuredClone(requestBody.values)); tables.set(r.key, rows); return { data: {} }; }
  }
} };

// Дивизион A — одна группа из 6; W — две группы по 5. Места заданы таблицей.
const A = ['Ann', 'Ben', 'Cid', 'Dan', 'Eve', 'Fay'];
const W1 = ['Wa1', 'Wa2', 'Wa3', 'Wa4', 'Wa5'], W2 = ['Wb1', 'Wb2', 'Wb3', 'Wb4', 'Wb5'];
const all = [...A, ...W1, ...W2];
const applicants = all.map((n, i) => ({ telegram_id: String(100 + i), name: n, language: i % 2 ? 'ru' : 'en', telegram_username: n.toLowerCase() }));
// Строки «Match_Log» групп: несыгранная пара Eve–Fay (A) и Wa4–Wa5 (W1).
// Таблица A: круг на 6 мест (15 матчей), за ним строки плей-офф шаблона —
// полуфинал 1 по формулам мест, полуфинал 2 испорчен (id вписаны руками, как в
// реальных таблицах сезона 2), финал по формулам, строки матча за 3-е нет.
const PF = k => `=INDEX(Division_Tracker!$J$7:$J$14, MATCH(${k}, Division_Tracker!$W$7:$W$14, 0))`;
put('sheetA', 'Match_Log', [['match', 'p1_id', 'player_1', 'p2_id', 'player_2', 's1', 's2', 'P1 TechLoss', 'P2 TechLoss'], [14, 5, 'Eve', 6, 'Fay', '', '', '', ''],
  [1, 1, 'Ann', 2, 'Ben'], [2, 3, 'Cid', 4, 'Dan'],
  [16, 1, 'Ann', 4, 'Dan'], [17, 1, 'Ann', 5, 'Eve'], [18, '', '', '', '']]);
put('sheetA', 'Match_Log#f', [[], [], [], [],
  [16, PF(1), '=INDEX(...)', PF(4), '=INDEX(...)'], [17, 1, '=INDEX(...)', 5, '=INDEX(...)'], [18, '=IF(Y5="","",Y5)', '=IF(...)', '=IF(Y6="","",Y6)', '=IF(...)']]);
put('sheetW1', 'Match_Log', [['match', 'p1_id', 'player_1', 'p2_id', 'player_2', 's1', 's2', 'P1 TechLoss', 'P2 TechLoss'], [10, 4, 'Wa4', 5, 'Wa5', '', '', '', '']]);
put('master', 'Cross_Group_Match_Log', [['match_id', 'season', 'division', 'g1', 'p1', 'g2', 'p2', 'kind', 'score', 'winner', 'pp1', 'pp2', 'comment', 'status', 'date'],
  ['', '2', 'W', '2', 'Wb5', '1', 'Wa5', '', '', '', '', '', '', 'scheduled', '']]);
// Старые заготовки сетки W из сезона 2 — без игроков, их нужно переиспользовать.
put('master', 'Playoff', [['match_id', 'season', 'division', 'stage', 'slot', 'player_1', 'player_2', 'player_1_group', 'player_2_group', 'result_kind', 'score', 'winner', 'player_1_points', 'player_2_points', 'comment', 'status', 'date'],
  ...['QF1', 'QF2', 'QF3', 'QF4', 'SF1', 'SF2', '3rd', 'Final'].map(s => ['', '2', 'W', s.replace(/\d/, ''), s, '', '', '', '', '', '', '', '', '', '', 'scheduled', ''])]);

const settings = new Map(), sent = [], appended = new Map(), photos = [], published = [], bracketPreviews = [];
let schedule = { A: [{ row: 2, match: 14, p1: 'Eve', p2: 'Fay', played: false }], W1: [{ row: 2, match: 10, p1: 'Wa4', p2: 'Wa5', played: false }], W2: [] };
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const extraSheets = new Map();
const NOW = Date.parse('2026-11-04T05:00:00Z'); // 4 ноября, после дедлайна групп (3 ноя), до дедлайна A (5 ноя)

const context = vm.createContext({ console, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }, Math, JSON, Intl, Map, Set, Promise, Number, String, Boolean, Array, Object, Error, RegExp, URL, URLSearchParams, Buffer, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {} });
const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
const mods = {
  'config.js': syn({ LEAGUE_RESULTS_SHEET_ID: 'master', PUBLIC_URL: 'https://app.test', ADMIN_IDS: ['999'], TIMEZONE: 'Asia/Bangkok', SHEETS: { applicants: 'Applicants', events: 'Events' } }),
  'google.js': syn({ sheets: () => google }),
  'sheets.js': syn({
    sameName,
    getSetting: async k => settings.get(k) || '', setSetting: async (k, v) => { settings.set(k, v); },
    ensureExtraSheet: async (name) => { if (!extraSheets.has(name)) extraSheets.set(name, []); },
    getRows: async name => {
      if (name === 'Applicants') return { rows: applicants };
      if (name === 'Events') return { rows: [{ event_id: 'league_s2', event_type: 'league', start_date: '2026-09-14', end_date: '2026-11-08' }] };
      return { rows: (extraSheets.get(name) || []).map((r, i) => ({ ...r, _rowNumber: i + 2 })) };
    },
    appendObject: async (name, obj) => { extraSheets.set(name, [...(extraSheets.get(name) || []), obj]); },
    appendObjects: async (name, list) => { extraSheets.set(name, [...(extraSheets.get(name) || []), ...list]); },
    updateObjectByRow: async (name, row, patch) => { const l = extraSheets.get(name); Object.assign(l[row - 2], patch); },
    getSegmentContacts: async () => applicants
  }),
  'division.js': syn({
    divisionGroups: async l => (l === 'W' ? [{ group: '1' }, { group: '2' }] : []),
    divisionDisplayName: l => (l === 'W' ? 'Division W' : 'Division ' + l),
    availableDivisions: async () => ['A', 'W'],
    latestSeason: async () => '2',
    divisionSheetId: async (l, s, g) => (l === 'A' ? 'sheetA' : 'sheetW' + g),
    invalidateDivisionCache: () => {},
    seasonRoster: async () => ({ season: '2', players: [...A.map(n => ({ name: n, letter: 'A', group: '' })), ...W1.map(n => ({ name: n, letter: 'W', group: '1' })), ...W2.map(n => ({ name: n, letter: 'W', group: '2' }))] }),
    getDivisionTable: async (l, s, g) => ({ ok: true, players: (l === 'A' ? A : g === '1' ? W1 : W2).map((n, i) => ({ name: n, place: i + 1, points: 20 - i, matches: 5 })) })
  }),
  'withdraw.js': syn({ withdrawnList: async () => [] }),
  'results.js': syn({ getDivisionSchedule: async (l, s, g) => (l === 'A' ? schedule.A : schedule['W' + g]) || [], refreshAfterResult: async () => {},
    // Темп: у Ann сыграно 1 из 5, у остальных — всё, кроме одного матча.
    getUnplayedOpponents: async (l, name) => ({ known: true, total: 5, played: name === 'Ann' ? 1 : 4, names: name === 'Ann' ? ['Ben', 'Cid', 'Dan', 'Eve'] : ['Fay'] }) }),
  'telegram.js': syn({ sendDocumentBuffer: async (to, buf, name, opts) => { photos.push({ to: String(to), name, opts }); return { document: { file_id: 'doc' } }; }, sendMessage: async (to, text, opts) => { sent.push({ to: String(to), text, opts }); return {}; }, sendPhotoBuffer: async (to, buf, mime, opts) => { photos.push({ to, opts }); return { photo: [{ file_id: 'poster-file' }] }; }, sendPhoto: async () => ({}) }),
  'admin.js': syn({ getAdminChatId: async () => '' }),
  'matchesdb.js': syn({ normDate: v => { const t = String(v || '').trim(), m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : t.slice(0, 10); }, allSlots: async () => [] }),
  'broadcast.js': syn({ enqueueBroadcast: async ({ recipients, params }) => { appended.set('broadcast', params); return { recipients: recipients.length }; }, registerBroadcastKind: () => {} }),
  'matchcard.js': syn({ renderPlayoffSchedule: async () => Buffer.from('png') }),
  // Публикация картинок и предпросмотр сетки — свой модуль; здесь важно, что зовут его.
  'playoffmedia.js': syn({ adminChat: async () => 'admin-chat', previewBracket: async (l, s) => { bracketPreviews.push(l); return { ok: true }; },
    publishImage: async (buf, opts) => { published.push(opts); appended.set('broadcast', opts); return { ok: true, recipients: applicants.length }; } })
};
async function load(file) {
  const src = await fs.readFile(path.join(root, file), 'utf8');
  const m = new vm.SourceTextModule(src, { context, identifier: file, importModuleDynamically: async spec => {
    const key = spec.replace('./', '');
    if (key === 'tennis.js') return tennis; if (key === 'pace.js') return pace; if (key === 'playoff.js') return playoff;
    const d = mods[key]; if (!d) throw Error('no mock for ' + spec);
    if (d.status === 'unlinked') await d.link(() => {}); if (d.status === 'linked') await d.evaluate(); return d;
  } });
  await m.link(async spec => {
    const key = spec.replace('./', '');
    if (key === 'pace.js') return pace;
    if (key === 'tennis.js') return tennis;
    if (!mods[key]) throw Error('no mock for ' + spec);
    return mods[key];
  });
  await m.evaluate();
  return m;
}
const tennis = new vm.SourceTextModule(await fs.readFile(path.join(root, 'tennis.js'), 'utf8'), { context, identifier: 'tennis.js' });
await tennis.link(() => {}); await tennis.evaluate();
let pace = null, playoff = null;
pace = await load('pace.js');
playoff = await load('playoff.js');
const P = playoff.namespace, T = pace.namespace;

// ------------------------------------------------------------ чистая логика сетки
{
  const groups = [{ group: '2', rows: W2.map((name, i) => ({ name, place: i + 1 })) }, { group: '1', rows: W1.map((name, i) => ({ name, place: i + 1 })) }];
  const plan = P.buildPlan({ grouped: true, groups });
  const at = s => plan.find(p => p.slot === s);
  check(at('QF1').player_1 === 'Wa1' && at('QF1').player_2 === 'Wb4', 'QF1: 1-е место группы 1 против 4-го группы 2');
  check(at('QF2').player_1 === 'Wb2' && at('QF2').player_2 === 'Wa3', 'QF2: 2Б–3А (верхняя половина)');
  check(at('QF3').player_1 === 'Wb1' && at('QF3').player_2 === 'Wa4', 'QF3: 1Б–4А');
  check(at('QF4').player_1 === 'Wa2' && at('QF4').player_2 === 'Wb3', 'QF4: 2А–3Б (нижняя половина)');
  check(P.feedsOf('SF1', true)[0][0] === 'QF1' && P.feedsOf('SF1', true)[1][0] === 'QF2', 'Полуфинал 1 — победители QF1 и QF2: лидеры групп разведены');
  check(at('SF1').player_1 === '' && at('Final').player_1 === '', 'Следующие раунды до результатов пустые');
  const single = P.buildPlan({ grouped: false, groups: [{ group: '', rows: A.map((name, i) => ({ name, place: i + 1 })) }] });
  check(single.find(p => p.slot === 'SF1').player_1 === 'Ann' && single.find(p => p.slot === 'SF1').player_2 === 'Dan', 'A: полуфинал 1–4');
  check(single.find(p => p.slot === 'SF2').player_1 === 'Ben' && single.find(p => p.slot === 'SF2').player_2 === 'Cid', 'A: полуфинал 2–3');
  check(!single.some(p => p.stage === 'QF'), 'В дивизионе с одной группой четвертьфиналов нет');
  const swapped = P.buildPlan({ grouped: false, groups: [{ group: '', rows: A.map((name, i) => ({ name, place: i + 1 })) }], overrides: { '0:4': 'Eve' } });
  check(swapped.find(p => p.slot === 'SF1').player_2 === 'Eve' && swapped.find(p => p.slot === 'SF2').player_2 === 'Cid', 'Замена: место 4 занимает Eve, остальные места не сдвигаются');
  const withdrawn = P.buildPlan({ grouped: false, groups: [{ group: '', rows: A.map((name, i) => ({ name, place: i + 1 })) }], skip: ['Ben'] });
  check(withdrawn.find(p => p.slot === 'SF2').player_1 === 'Cid' && withdrawn.find(p => p.slot === 'SF1').player_2 === 'Eve', 'Снявшийся в сетку не попадает, места подтягиваются');
  check(P.stageKey('Semifinal S2') === 'SF' && P.stageKey('QF') === 'QF' && P.stageKey('3rd Place S2') === '3rd' && P.stageKey('Final S1') === 'Final' && P.stageKey('2') === '', 'Стадия из подписи; номер раунда переговоров — не стадия');
  check(P.competitionLabel('SF', '2') === 'Semifinal S2' && P.competitionLabel('3rd', '2') === '3rd Place S2', 'Подпись соревнования для общего журнала');
  check(P.placeholderOf('Final', 0, false) === 'Winner SF1' && P.placeholderOf('3rd', 1, true) === 'Loser SF2', 'Подпись «кто здесь будет»');
}

// ------------------------------------------------------------ несыгранные матчи
{
  const list = await P.unplayedMatches('W', '2');
  check(list.length === 2 && list.some(m => m.kind === 'group' && m.p1 === 'Wa4') && list.some(m => m.kind === 'cross'), 'Несыгранные: строка группы и межгрупповая пара');
  const g = list.find(m => m.kind === 'group');
  const r1 = await P.decideUnplayed('W', '2', g.key, 'loss_p2', { name: 'Kostas' });
  check(r1.ok && tables.get('sheetW1|Match_Log')[1][8] === 0 && !tables.get('sheetW1|Match_Log')[1][7], 'W/O: 0 в колонку TechLoss проигравшего (второй в строке)');
  check(sent.some(m => m.to === String(100 + all.indexOf('Wa5')) && /W\/O|техническ|walkover/i.test(m.text)), 'Игрокам приходит сообщение о W/O');
  const c = (await P.unplayedMatches('W', '2')).find(m => m.kind === 'cross');
  const r2 = await P.decideUnplayed('W', '2', c.key, 'loss_p1', {});
  const cross = tables.get('master|Cross_Group_Match_Log')[1];
  check(r2.ok && cross[7] === 'technical' && cross[9] === 'Wa5' && cross[10] === 0 && cross[11] === 3 && cross[13] === 'confirmed', 'Межгрупповой W/O: победитель и очки 0:3');
  const a = (await P.unplayedMatches('A', '2'))[0];
  const r3 = await P.decideUnplayed('A', '2', a.key, 'none', {});
  check(r3.ok && !(await P.unplayedMatches('A', '2')).length, '«Не засчитывать» — матч больше не просят решить');
  check(!tables.get('sheetA|Match_Log')[1][7] && !tables.get('sheetA|Match_Log')[1][8], '«Не засчитывать» в таблицу ничего не пишет');
  schedule = { A: [], W1: [], W2: [] };
}

// ------------------------------------------------------------ черновик в Google Sheets
{
  // A (одна группа): строки плей-офф в таблице дивизиона.
  const chk = await P.checkTableBrackets('2');
  const a = chk.divisions.find(d => d.letter === 'A'), w = chk.divisions.find(d => d.letter === 'W');
  check(a.issues.some(i => /полуфинал 2: первый/.test(i)) && a.issues.some(i => /полуфинал 2: второй/.test(i)) && a.issues.some(i => /нет строки матча за 3-е/.test(i)), 'Проверка таблицы: испорченный полуфинал 2 и нет матча за 3-е место');
  check(!a.issues.some(i => /полуфинал 1|финал:/.test(i)) && w.grouped && !w.issues.length, 'Правильные строки не трогаются; у C и W строки таблиц групп не проверяются');
  check(/playoff_sheets fix/.test(P.tableCheckText(chk)), 'Отчёт предлагает исправить');
  let st = await P.playoffState('2');
  check(st.divisions.find(d => d.letter === 'A').preview.find(p => p.slot === 'SF2').player_1 === 'Ann', 'До починки черновик A — ровно то, что в таблице (даже испорченное)');
  check(!(await P.publishBracket('A', '2', {})).ok, 'Испорченную сетку (Ann в двух парах) опубликовать нельзя');
  const fixed = await P.checkTableBrackets('2', { fix: true });
  const fa = tables.get('sheetA|Match_Log#f');
  check(fixed.divisions.find(d => d.letter === 'A').fixed > 0 && fa[5][1] === P.placeFormula(2) && fa[5][3] === P.placeFormula(3), 'fix: полуфинал 2 — формулы мест 2 и 3');
  check(tables.get('sheetA|Match_Log')[7][0] === 19 && fa[7][1] === '=IF(Y5="","",IF(Y5=B5,D5,B5))' && fa[7][3] === '=IF(Y6="","",IF(Y6=B6,D6,B6))', 'fix: добавлена строка матча за 3-е место — проигравшие полуфиналов');
  check(!(await P.checkTableBrackets('2')).divisions.find(d => d.letter === 'A').issues.length, 'После fix проверка чистая');
  st = await P.playoffState('2');
  const pa = st.divisions.find(d => d.letter === 'A');
  check(pa.draft_source === 'table' && pa.preview.find(p => p.slot === 'SF1').player_2 === 'Dan' && pa.preview.find(p => p.slot === 'SF2').player_1 === 'Ben' && pa.preview.find(p => p.slot === 'SF2').player_2 === 'Cid', 'Черновик A из таблицы: 1–4 и 2–3');

  // W (две группы): бот сам ведёт черновик в листе Playoff.
  const sync = await P.syncDrafts('2', { only: 'W' });
  let rows = await P.divisionRows('W', '2', { fresh: true });
  check(sync.ok && rows.length === 8 && rows.find(r => r.slot === 'QF1').player_1 === 'Wa1' && rows.find(r => r.slot === 'QF1').player_2 === 'Wb4' && rows.find(r => r.slot === 'QF1').status === 'draft', 'Черновик W записан в лист Playoff: пары 1A–4B и т.д., статус «draft», без новых строк');
  check(!P.isPublished(rows) && !(await P.playoffState('2')).divisions.find(d => d.letter === 'W').published, 'Черновик с именами — не опубликованная сетка');
  // Правка руками в листе: бот её не затирает.
  const sheet = tables.get('master|Playoff'), qf2 = sheet.findIndex(r => r && r[4] === 'QF2');
  sheet[qf2][5] = 'Wb5';
  await P.syncDrafts('2', { only: 'W' });
  rows = await P.divisionRows('W', '2', { fresh: true });
  const pre = (await P.playoffState('2')).divisions.find(d => d.letter === 'W').preview.find(p => p.slot === 'QF2');
  check(rows.find(r => r.slot === 'QF2').player_1 === 'Wb5' && pre.locked && pre.player_1 === 'Wb5', 'Строка, поправленная руками, остаётся как есть и видна в черновике');
  sheet[qf2][5] = ''; sheet[qf2][6] = '';
  await P.syncDrafts('2', { only: 'W' });
  check((await P.divisionRows('W', '2', { fresh: true })).find(r => r.slot === 'QF2').player_1 === 'Wb2', 'Очистил имена — строка снова под автоматикой');
  const preview = await P.sitePreview('W', '2', [{ group: '1', players: W1.map((n, i) => ({ name: n, place: i + 1 })) }, { group: '2', players: W2.map((n, i) => ({ name: n, place: i + 1 })) }]);
  check(preview && preview.preview && preview.deadline === '2026-11-03' && preview.qf.length === 4 && preview.qf[0].first.name === 'Wa1', 'Сайт: черновик W с пометкой «предварительно» и дедлайном');
}

// ------------------------------------------------------------ публикация и сетка
const mid = n => String(100 + all.indexOf(n));
{
  const st = await P.playoffState('2');
  const w = st.divisions.find(d => d.letter === 'W'), a = st.divisions.find(d => d.letter === 'A');
  check(w && a && !w.published && !a.published, 'Старые пустые заготовки не считаются опубликованной сеткой');
  check(w.deadline === '2026-11-03' && a.deadline === '2026-11-05' && w.deadline_passed && !a.deadline_passed, 'Дедлайны из Events: группы — за 5 дней, остальные — за 3');
  const before = (tables.get('master|Playoff') || []).length;
  const pub = await P.publishBracket('W', '2', { actor: { name: 'Kostas' } });
  const rows = await P.divisionRows('W', '2', { fresh: true });
  check(pub.ok && rows.length === 8 && (tables.get('master|Playoff') || []).length === before, 'Публикация переиспользует заготовки, а не дописывает дубли');
  check(bracketPreviews.includes('W'), 'После публикации картинка сетки уходит на утверждение в админский чат');
  check(rows.find(r => r.slot === 'QF1').player_1 === 'Wa1' && rows.find(r => r.slot === 'QF1').status === 'scheduled', 'Пары четвертьфиналов записаны');
  check(rows.find(r => r.slot === 'SF1').status === 'tbd' && rows.find(r => r.slot === 'SF1').date === '2026-11-07' && rows.find(r => r.slot === 'Final').date === '2026-11-08', 'Полуфиналы — 7 ноября, финал — 8, пока без игроков');
  check(rows.find(r => r.slot === 'SF1').court === P.DEFAULT_COURT, 'Корт по умолчанию — The Peak Racquet Park');
  const qfMsg = sent.find(m => m.to === mid('Wb4') && /четвертьфинал|quarterfinal/i.test(m.text));
  check(qfMsg && /Wa1/.test(qfMsg.text) && qfMsg.opts?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url.includes('opponent=' + mid('Wa1')), 'Игрок четвертьфинала получает соперника и кнопку «Назначить матч»');
  check(/6 ноября|6 November/.test(qfMsg.text), 'Срок четвертьфинала — день перед финалами');
  const opp = await P.playoffOpponentsFor('Wb4', '2');
  check(opp.length === 1 && opp[0].name === 'Wa1' && opp[0].stage === 'QF', 'Соперник по четвертьфиналу появляется в списке соперников');
  const sentBefore = sent.length;
  const again = await P.publishBracket('W', '2', {});
  check(again.ok && again.changed === 0 && sent.length === sentBefore + 1, 'Повторная публикация без изменений никому из игроков не пишет');
  // Определение стадии у матча, назначенного игроками.
  check(await P.detectStage({ division: 'Division W', season: '2', from_name: 'Wb4', to_name: 'Wa1', agreed_date: '2026-11-05' }) === 'QF', 'Матч пары четвертьфинала после дедлайна — это четвертьфинал');
  check(await P.detectStage({ division: 'Division W', season: '2', from_name: 'Wb4', to_name: 'Wa1', agreed_date: '2026-10-20' }) === '', 'Тот же матч до дедлайна — регулярка');
  check(await P.detectStage({ division: 'W', round: '2', from_name: 'Wa2', to_name: 'Wa3', agreed_date: '2026-11-05' }) === '', 'Пара не из сетки — регулярка');
}

// ------------------------------------------------------------ результаты и продвижение
const win = (from, to, score, extra = {}) => ({ challenge_id: 'm-' + from + '-' + to, from_name: from, to_name: to, from_telegram_id: mid(from), to_telegram_id: mid(to), result_winner: mid(from), result_score: score, result_kind: 'played', agreed_date: '2026-11-05', ...extra });
{
  // Счёт приходит со стороны from (здесь — второго в строке): в листе он со стороны player_1.
  // Победители встают в следующий круг — назначенный матч у игроков следом (assignmatch.js).
  const hooked = [];
  P.setAssignHook(async (l, s, slot) => { hooked.push(l + ':' + slot); return { status: 'waiting' }; });
  const r = await P.recordPlayoffResult(win('Wb4', 'Wa1', '6:4 6:3'), 'QF', '2', 'W');
  let rows = await P.divisionRows('W', '2', { fresh: true });
  const qf1 = rows.find(x => x.slot === 'QF1');
  check(r.status === 'saved' && qf1.status === 'confirmed' && qf1.winner === 'Wb4' && sp(qf1.score) === '4:6 3:6', 'Результат QF1: победитель и счёт со стороны player_1');
  check(rows.find(x => x.slot === 'SF1').player_1 === 'Wb4' && rows.find(x => x.slot === 'SF1').status === 'tbd', 'Победитель QF1 прошёл в SF1, пара ещё неполная');
  await P.recordPlayoffResult(win('Wb2', 'Wa3', '6:1 6:1'), 'QF', '2', 'W');
  await P.recordPlayoffResult(win('Wa4', 'Wb1', '7:6 (7:3) 6:4'), 'QF', '2', 'W');
  await P.recordPlayoffResult(win('Wa2', 'Wb3', '6:0 6:0'), 'QF', '2', 'W');
  rows = await P.divisionRows('W', '2', { fresh: true });
  check(rows.find(x => x.slot === 'SF1').player_1 === 'Wb4' && rows.find(x => x.slot === 'SF1').player_2 === 'Wb2' && rows.find(x => x.slot === 'SF1').status === 'scheduled', 'SF1 = победители QF1 и QF2');
  check(rows.find(x => x.slot === 'SF2').player_1 === 'Wa4' && rows.find(x => x.slot === 'SF2').player_2 === 'Wa2', 'SF2 = победители QF3 и QF4');
  check(hooked.includes('W:SF1') && hooked.includes('W:SF2'), 'Пара полуфинала сложилась — назначенный матч проверяется (время могло стоять заранее)');
  P.setAssignHook(null);
  check(!(await P.playoffOpponentsFor('Wb4', '2')).length, 'После сыгранного четвертьфинала соперник из списка уходит');
  // Исправление счёта четвертьфинала — та же строка.
  await P.recordPlayoffResult(win('Wb4', 'Wa1', '6:4 7:5'), 'QF', '2', 'W');
  rows = await P.divisionRows('W', '2', { fresh: true });
  check(rows.filter(x => x.slot.startsWith('QF')).length === 4 && sp(rows.find(x => x.slot === 'QF1').score) === '4:6 5:7', 'Исправление счёта пишется в ту же строку');
  await P.recordPlayoffResult(win('Wb2', 'Wb4', '6:3 6:3', { challenge_id: 'sf1', agreed_date: '2026-11-07' }), 'SF', '2', 'W');
  await P.recordPlayoffResult(win('Wa4', 'Wa2', '3:6 6:3 10:7', { challenge_id: 'sf2', agreed_date: '2026-11-07' }), 'SF', '2', 'W');
  rows = await P.divisionRows('W', '2', { fresh: true });
  const fin = rows.find(x => x.slot === 'Final'), third = rows.find(x => x.slot === '3rd');
  check(fin.player_1 === 'Wb2' && fin.player_2 === 'Wa4' && fin.status === 'scheduled', 'Финал — победители полуфиналов');
  check(third.player_1 === 'Wb4' && third.player_2 === 'Wa2', 'Матч за 3-е — проигравшие полуфиналов');
  await P.recordPlayoffResult(win('Wa4', 'Wb2', '6:4 6:4', { challenge_id: 'final', agreed_date: '2026-11-08' }), 'Final', '2', 'W');
  check(settings.get('playoff_champion_2_W') === 'Wa4' && sent.some(m => m.to === '999' && /Чемпион Division W: Wa4/.test(m.text)), 'Финал сыгран — чемпион записан, организатору сводка');
  rows = await P.divisionRows('W', '2', { fresh: true });
  const site = P.sitePlayoff({ rows, grouped: true });
  check(site.published && !site.preview && site.qf.length === 4 && site.champion.name === 'Wa4', 'Сайт: опубликованная сетка и чемпион');
  check(site.final.winner_id === 'Wa4' && sp(site.final.score) === '6:4 6:4', 'Сайт: счёт финала со стороны победителя');
  check(sp(site.qf[0].score) === '6:4 7:5', 'Сайт: счёт четвертьфинала тоже со стороны победителя');
}

// ------------------------------------------------------------ A: замена, время, афиша, счёт организатора
{
  await P.setOverride('A', '2', 0, 4, 'Eve');
  let st = await P.playoffState('2');
  check(st.divisions.find(d => d.letter === 'A').preview.find(p => p.slot === 'SF1').player_2 === 'Eve', 'Замена до публикации видна в предварительной сетке');
  check(tables.get('sheetA|Match_Log#f')[4][3] === 5, 'Замена в A пишется в таблицу дивизиона: id Eve в ячейке второго игрока полуфинала 1');
  const pub = await P.publishBracket('A', '2', {});
  let rows = await P.divisionRows('A', '2', { fresh: true });
  check(pub.ok && rows.find(r => r.slot === 'SF1').player_2 === 'Eve' && !rows.some(r => r.stage === 'QF'), 'Публикация A: полуфиналы с заменой, без четвертьфиналов');
  check(!JSON.parse(settings.get('playoff_overrides') || '{}')['2:A'], 'После публикации замены до неё очищены');
  check(tables.get('sheetA|Match_Log#f')[4][1] === 1 && tables.get('sheetA|Match_Log#f')[5][1] === 2 && tables.get('sheetA|Match_Log#f')[5][3] === 3, 'Публикация фиксирует пары полуфиналов в таблице id игроков — таблица больше не гуляет');
  const semiMsg = sent.find(m => m.to === mid('Ann') && /полуфинал|semifinal/i.test(m.text));
  check(semiMsg && /Eve/.test(semiMsg.text) && !semiMsg.opts?.reply_markup, 'Полуфиналистам — сообщение без кнопки назначения: время ставит организатор');
  const rep = await P.replacePlayer('A', '2', 'SF1', 2, 'Fay', {});
  rows = await P.divisionRows('A', '2', { fresh: true });
  check(rep.ok && rows.find(r => r.slot === 'SF1').player_2 === 'Fay' && sent.some(m => m.to === mid('Fay')), 'Замена после публикации: новый игрок получает сообщение');
  check(tables.get('sheetA|Match_Log#f')[4][3] === 6, 'Замена после публикации — и в строке таблицы дивизиона');
  check(!(await P.replacePlayer('A', '2', 'SF1', 1, 'Nobody', {})).ok, 'Игрока не из дивизиона поставить нельзя');
  check((await P.setSchedule('A', '2', 'SF1', { date: '2026-11-07', time: '9:00', court: '' })).row.time === '09:00', 'Время матча сохраняется в формате ЧЧ:ММ');
  await P.setSchedule('A', '2', 'SF2', { date: '2026-11-07', time: '10:30' });
  check((await P.setSchedule('A', '2', 'SF2', { date: '2026-11-07', time: '10:30', match_id: 'm-sf2' })).row.match_id === 'm-sf2'
    && (await P.setSchedule('A', '2', 'SF2', { date: '2026-11-07', time: '10:30' })).row.match_id === 'm-sf2', 'Номер назначенного матча пишется в строку и не теряется при правке времени');
  await P.setSchedule('A', '2', 'SF2', { date: '2026-11-07', time: '10:30', match_id: '' });
  const day = await P.dayMatches('2026-11-07');
  check(day.length === 4 && day[0].slot === 'SF1' && day.some(m => m.divisionLabel === 'W'), 'Афиша дня: все полуфиналы дня, по времени');
  const cap = P.posterCaption('2026-11-07', day);
  check(/PTF Playoffs — Saturday 7 November/.test(cap) && /09:00 · Division A · Semifinal — Ann vs Fay/.test(cap) && !/[а-я]/i.test(cap), 'Текст афиши — только английский, с расписанием');
  const pre = await P.previewPoster('2026-11-07');
  check(pre.ok && photos.length === 1 && photos[0].to === 'admin-chat' && photos[0].opts.reply_markup.inline_keyboard[0][0].callback_data === 'po_send:' + pre.key, 'Предпросмотр афиши — в админский чат, файлом, с кнопкой «Разослать всем»');
  check(/Никому не отправлено/.test(photos[0].opts.caption) && !published.length, 'До кнопки афиша никому не уходит');
  const out = await P.sendPoster(pre.key, { id: '999' });
  check(out.ok && out.recipients === applicants.length && published[0].label === 'schedule' && /PTF Playoffs/.test(published[0].caption), 'Рассылка афиши всем в боте (картинка + английский текст)');
  check(out.personal >= 6 && sent.some(m => m.to === mid('Fay') && /09:00/.test(m.text)), 'Игроки дня получают личное сообщение со своим временем');
  check(!(await P.sendPoster(pre.key, {})).ok && published.length === 1, 'Повторное нажатие «Разослать» второй раз не отправляет');
  check(!(await P.sendPoster('2099-01-01', {})).ok, 'Без предпросмотра рассылки нет');
  check((await P.publishBracket('A', '2', {})).ok, 'До первого результата сетку можно пересобрать');
  await P.recordPlayoffResult(win('Ann', 'Dan', '6:2 6:2'), 'SF', '2', 'A');
  check(!(await P.publishBracket('A', '2', {})).ok, 'После первого результата пересобрать сетку нельзя');
}

// ------------------------------------------------------------ предварительная сетка на сайте
{
  // A уже опубликован — предварительной нет; «ранний» сезон — тоже нет.
  check(await P.sitePreview('A', '2', [{ group: '', players: A.map((n, i) => ({ name: n, place: i + 1 })) }]) === null, 'Опубликованная сетка не подменяется предварительной');
  const cal = T.seasonCalendarFrom([{ event_id: 'league_s2', event_type: 'league', start_date: '2026-09-14', end_date: '2026-11-08' }], '2026-10-20');
  check(!P.previewWindow(cal, false, '2026-10-20') && P.previewWindow(cal, false, '2026-10-29') && P.previewWindow(cal, true, '2026-10-27'), 'Предварительная сетка — с последней недели перед дедлайном');
}

// ------------------------------------------------------------ темп сезона
{
  const ev = [{ event_id: 'current_s1', event_type: 'league', start_date: '2026-06-01', end_date: '2026-06-28' }, { event_id: 'league_s2', event_type: 'league', start_date: '14.09.2026', end_date: '08.11.2026' }, { event_id: 'league_s3', event_type: 'league', start_date: 'November-December' }];
  const cal = T.seasonCalendarFrom(ev, '2026-10-17');
  check(cal.season === '2' && cal.regularEnd === '2026-11-05' && cal.groupedEnd === '2026-11-03' && cal.finalsStart === '2026-11-07', 'Календарь сезона из Events: дедлайны и финальные дни');
  check(cal.week === 5 && cal.weeks === 8, 'Неделя сезона и сколько их всего');
  const next = T.seasonCalendarFrom([...ev, { event_id: 'league_s3', event_type: 'league', start_date: '2026-11-23', end_date: '2027-01-17' }], '2026-12-01');
  check(next.season === '3' && next.regularEnd === '2027-01-14', 'Следующий сезон подхватывается из новой строки Events');
  const behind = T.paceOf({ total: 7, played: 1 }, cal, cal.regularEnd, '2026-10-10');
  const ok = T.paceOf({ total: 7, played: 2, agreed: 1 }, cal, cal.regularEnd, '2026-10-10');
  check(behind.lagging && !ok.lagging, 'Норма пропорционально времени: 1 из 7 к середине — отстаёт, 2 + 1 назначенный — нет');
  check(T.paceOf({ total: 7, played: 4 }, cal, cal.regularEnd, '2026-10-28').lagging && !T.paceOf({ total: 7, played: 4 }, cal, cal.regularEnd, '2026-10-14').lagging, 'За неделю до дедлайна хватает отставания на один матч');
  check(!T.paceOf({ total: 7, played: 7 }, cal, cal.regularEnd, '2026-11-01').lagging, 'Всё сыграно — не отстаёт');
  const first = T.paceMessage({ name: 'Roman V', ru: true, pace: behind, deadline: cal.regularEnd, opponents: ['A', 'B'], first: true });
  check(/Привет, Роман!/.test(first) && /1 из 7/.test(first) && /5 ноября/.test(first) && /A, B/.test(first), 'Первое сообщение: сыграно, осталось, дедлайн, соперники');
  const v = [0, 1, 2].map(i => T.paceMessage({ name: 'Roman V', ru: true, pace: behind, deadline: cal.regularEnd, variant: i }));
  check(new Set(v).size === 3 && v.every(x => x.length < first.length && /1 из 7/.test(x)), 'Повторные сообщения короче и чередуются');
  check(!/[а-я]/i.test(T.paceMessage({ name: 'Tom', ru: false, pace: behind, deadline: cal.regularEnd, variant: 1 })), 'Английская версия для EN-игроков');
  check(/^Hi Roman!/.test(T.paceMessage({ name: 'Roman V', ru: false, pace: behind, deadline: cal.regularEnd, opponents: [], first: true })), 'Иностранцу — обращение как в таблице, латиницей');
  check(T.ruFirstName('Kostas Coconut') === 'Костас' && T.ruFirstName('Masha Geveling') === 'Маша' && T.ruFirstName('Aksinya') === 'Аксинья' && T.ruFirstName('Andrew Petukhov') === 'Андрей', 'Русскоязычным — привычная русская форма имени');
  check(T.ruFirstName('Gerardo Tay') === 'Герардо' && T.ruFirstName('Nikolay X') === 'Николай' && T.ruFirstName('Иван Петров') === 'Иван', 'Имени нет в словаре — транслитерация; кириллица остаётся как есть');
  check(/Маша, привет!/.test(T.paceMessage({ name: 'Masha Geveling', ru: true, pace: behind, deadline: cal.regularEnd, variant: 1 })), 'Повторное сообщение тоже с русским обращением');
  check(await T.digestChat() === '999', 'Админский чат не настроен — сводка уходит организатору в личку');
  check(/const admin = txt\(await getAdminChatId\(\)[^;]*\);\s*return admin \|\| txt\(ADMIN_IDS\[0\]\)/.test(await fs.readFile(path.join(root, 'pace.js'), 'utf8')), 'Сводка темпа приходит в админский чат, а не в личку бота');
  check(T.timeLeftText(21, true) === '3 недели' && T.timeLeftText(5, true) === '5 дней' && T.timeLeftText(1, false) === '1 day', 'Сколько осталось — по-русски с правильным склонением');
  const players = [
    { name: 'Lag One', letter: 'A', group: '', telegram_id: '1', ru: true, pace: behind, deadline: cal.regularEnd, opponents: [] },
    { name: 'Fine Two', letter: 'A', group: '', telegram_id: '2', ru: false, pace: ok, deadline: cal.regularEnd, opponents: [] },
    { name: 'Lag New', letter: 'W', group: '1', telegram_id: '3', ru: false, pace: behind, deadline: cal.groupedEnd, opponents: [] }
  ];
  const seed = T.seedRows([], [{ ...players[0], name: 'Roman Vengerak' }], { season: '2', today: '2026-10-12' });
  check(seed.length === 1 && seed[0].added_on === '2026-10-10' && seed[0].messages === 1, 'Первый шорт-лист: игроки от 10 октября, первое сообщение уже отправлено');
  check(!T.seedRows([{ season: '2', player: 'x' }], players, { season: '2', today: 'x' }).length, 'Шорт-лист заводится один раз');
  const rows = [{ season: '2', player: 'Lag One', base_played: 0, last_played: 0, last_secured: 0, messages: 1, status: 'active', _rowNumber: 2 },
    { season: '2', player: 'Fine Two', base_played: 1, last_played: 1, last_secured: 1, messages: 1, status: 'active', _rowNumber: 3 }];
  const plan = T.planWatch(rows, players, { season: '2', today: '2026-10-17' });
  check(plan.messages.length === 2 && plan.messages.find(m => m.player.name === 'Lag One').first === false && plan.messages.find(m => m.player.name === 'Lag New').first === true, 'Повторно — дружеское сообщение, новому — подробное');
  check(plan.updates.find(u => u.row === 3).patch.status === 'ok' && !plan.messages.some(m => m.player.name === 'Fine Two'), 'Вышел в норму — сообщения нет, статус «ok»');
  check(plan.appends.length === 1 && plan.appends[0].player === 'Lag New', 'Новые отстающие попадают в шорт-лист сами');
  const head = T.digestHeader({ cal, today: '2026-10-17', divisions: [{ letter: 'A', group: '', total: 28, played: 14, agreed: 3, negotiating: 1, lagging: 2 }, { letter: 'W', group: '1', total: 10, played: 4, agreed: 1, negotiating: 0, lagging: 1 }], tracked: plan.tracked, fresh: plan.fresh });
  check(/неделя 5 из 8/.test(head) && /5 ноября — A/.test(head) && /3 ноября — W/.test(head) && /A: 14\/28 · 3 · 1 · 10/.test(head), 'Заголовок сводки: неделя, дедлайны, дивизионы');
  check(/Lag One \(A\): 0 → 1 из 7/.test(head) && /Fine Two.*✅ в норме/.test(head), 'Шорт-лист «было → стало»');
  const msg = T.digestPlayerMessage(plan.messages[0], { cal });
  check(/<pre>/.test(msg) && /tg:\/\/user\?id=/.test(msg), 'Сообщение игроку — блоком для копирования, имя — ссылка на чат');
  check(T.paceDue(Date.parse('2026-10-17T06:10:00Z'), cal) && !T.paceDue(Date.parse('2026-10-17T08:10:00Z'), cal) && !T.paceDue(Date.parse('2026-10-18T06:10:00Z'), cal), 'Сводка — по субботам в 13:00 по Пхукету');
  check(!T.paceDue(Date.parse('2026-11-07T06:10:00Z'), cal), 'После дедлайна регулярки сводки нет');
}

// ------------------------------------------------------------ сводка темпа целиком
{
  // На 4 ноября для A (дедлайн 5-го) норма почти все 5 матчей: Ann (1 из 5) отстаёт.
  const before = sent.length;
  const r = await T.runPaceDigest(NOW, { force: true, save: true, chatId: '999' });
  const mine = sent.slice(before);
  check(r.ok && r.sent >= 1 && mine[0].to === '999' && /Темп сезона 2/.test(mine[0].text), 'Сводка приходит организатору: сначала заголовок');
  const ann = mine.find(m => /Ann/.test(m.text) && /<pre>/.test(m.text));
  check(ann && /1 из 5|1 of 5/.test(ann.text), 'По отстающему — готовое сообщение');
  const watch = (extraSheets.get('Pace Watch') || []);
  check(watch.some(w => w.player === 'Ann' && Number(w.messages) === 1 && w.status === 'active'), 'Отстающий записан в шорт-лист');
  const again = await T.runPaceDigest(NOW, { force: true, save: false, chatId: '999' });
  const last = sent.slice(-again.sent - 1);
  check(again.ok && /предпросмотр/.test(sent[sent.length - again.sent - 1].text) && last.some(m => /🔁/.test(m.text) && /Ann/.test(m.text)), 'Через неделю тому же игроку — повторное (короткое) сообщение');
  check(Number(watch.find(w => w.player === 'Ann').messages) === 1, 'Предпросмотр шорт-лист не меняет');
}

console.log(`PASS: ${checks} playoff + pace checks; all Sheets and Telegram operations were mocked.`);
