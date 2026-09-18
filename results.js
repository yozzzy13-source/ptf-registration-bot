// Зеркалирование подтверждённого счёта в таблицы лиги.
//
// Раньше это делал отдельный results-бот, читавший счёт из общего чата. Теперь счёт
// приходит из мини-приложения уже проверенным и подтверждённым соперником, а сюда
// попадает только на запись. Формат колонок сохранён прежний, чтобы существующие
// формулы и рейтинги продолжали работать.
//
// Если LEAGUE_RESULTS_SHEET_ID не задан, запись пропускается: результат всё равно
// сохранён в таблице матчей, ничего не теряется.
import { sheets as sheetsClient } from './google.js';
import { LEAGUE_RESULTS_SHEET_ID, LEAGUE_RESULTS_SHEETS, DIVISION_SPREADSHEETS, TIMEZONE } from './config.js';
import { scoreValues, detectSet3Mode, reverseScore, cellToScore, formatScore } from './tennis.js';
import { divisionSheetId, divisionLetter, getDivisionTable, recentFormBefore } from './division.js';
import { getSetting, sameName } from './sheets.js';
import { slotScope, sameScope } from './access.js';
import { buildFantasyCatalog, scoreFantasyMatch, fantasyPlayerKey } from './fantasy.js';
import { rememberCardContext } from './matchcard.js';

const DATA_START_ROW = 2;
const MASTER_START_ROW = 4;
const COL_P1_NAME = 9; // колонка I в Cross_Division_Match_Log
const CROSS_GROUP_SHEET = 'Cross_Group_Match_Log';
const CROSS_GROUP_HEADERS = ['match_id','season','division','player_1_group','player_1','player_2_group','player_2','result_kind','score','winner','player_1_points','player_2_points','comment','status','date'];
const PLAYOFF_SHEET = 'Playoff';
const PLAYOFF_HEADERS = ['match_id','season','division','stage','slot','player_1','player_2','player_1_group','player_2_group','result_kind','score','winner','player_1_points','player_2_points','comment','status','date'];
const W_CROSS_SCHEDULE=[
 ['Olga Sauer','Masha Geveling'],['Olga Sauer','Yana D'],['Marina Banatskaia','Elena Ian'],['Marina Banatskaia','Irina Strembitska'],
 ['Daria Kozitskaya','Tatiana Sokolova'],['Daria Kozitskaya','Xenia Hors'],['Hyunjung Moon','Masha Geveling'],['Hyunjung Moon','Irina Strembitska'],
 ['Anna Ermolina','Elena Ian'],['Anna Ermolina','Yana D'],['Maria Evangelista','Tatiana Sokolova'],['Maria Evangelista','Xenia Hors']
];

function norm(s = '') {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
}
function colToLetter(col) {
  let out = '';
  while (col > 0) { const rem = (col - 1) % 26; out = String.fromCharCode(65 + rem) + out; col = Math.floor((col - 1) / 26); }
  return out;
}
function coerceNumber(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}
// Google хранит даты числом; формула рейтинга ожидает именно его.
function localDateSerial(isoDate) {
  const d = isoDate ? new Date(`${isoDate}T12:00:00Z`) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);
  return Date.UTC(y, m - 1, day) / 86400000 + 25569;
}

async function getValues(spreadsheetId, range) {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}
// journal — «журнал правок» для тестового прогона: перед каждой записью
// запоминаем, что в этих ячейках было, и потом можем вернуть всё как было.
// Читаем в режиме FORMULA: иначе откат подменил бы формулы их значениями.
async function batchUpdate(spreadsheetId, data, journal = null) {
  if (journal) {
    for (const item of data) {
      const before = await sheetsClient().spreadsheets.values
        .get({ spreadsheetId, range: item.range, valueRenderOption: 'FORMULA' })
        .then(r => r.data.values || []).catch(() => []);
      journal.push({ spreadsheetId, range: item.range, before });
    }
  }
  await sheetsClient().spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data }
  });
}
// Сколько строк и колонок в диапазоне: нужно, чтобы при откате дописать
// пустышки и вычистить ячейки, которых до записи вообще не существовало.
function rangeShape(range = '') {
  const m = /!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(String(range));
  if (!m) return null;
  const idx = letters => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
  const c1 = idx(m[1]), r1 = Number(m[2]);
  const c2 = m[3] ? idx(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
  return { rows: Math.max(1, r2 - r1 + 1), cols: Math.max(1, c2 - c1 + 1) };
}
export async function rollbackJournal(journal = []) {
  const done = [], failed = [];
  // В обратном порядке: последняя правка откатывается первой.
  for (const entry of [...journal].reverse()) {
    const shape = rangeShape(entry.range) || { rows: (entry.before || []).length || 1, cols: 1 };
    const values = [];
    for (let r = 0; r < shape.rows; r++) {
      const row = ((entry.before || [])[r] || []).slice(0, shape.cols);
      while (row.length < shape.cols) row.push('');
      values.push(row);
    }
    try {
      await sheetsClient().spreadsheets.values.update({
        spreadsheetId: entry.spreadsheetId, range: entry.range,
        valueInputOption: 'USER_ENTERED', requestBody: { values }
      });
      done.push(entry.range);
    } catch (e) { failed.push(`${entry.range}: ${e.message}`); }
  }
  await refreshAfterResult().catch(e => console.error('refresh after rollback failed:', e.message));
  return { restored: done.length, total: journal.length, done, failed };
}
function resultKind(slot = {}) { return String(slot.result_kind || 'played').toLowerCase(); }
function resultMarker(slot = {}, reversed = false) {
  const kind = resultKind(slot);
  if (kind === 'retired') return 'RET';
  if (kind !== 'technical') return '';
  const raw = String(slot.result_score || (slot.result_winner ? 'W/L' : 'L/L')).toUpperCase();
  if (!reversed) return raw;
  return raw === 'W/L' ? 'L/W' : raw === 'L/W' ? 'W/L' : raw;
}
function resultPoints(slot = {}, reversed = false) {
  const a = slot.result_points_from === '' || slot.result_points_from == null ? '' : coerceNumber(slot.result_points_from);
  const b = slot.result_points_to === '' || slot.result_points_to == null ? '' : coerceNumber(slot.result_points_to);
  return reversed ? [b, a] : [a, b];
}
function centralWrites(row, slot, parsed) {
  const kind = resultKind(slot), completed = kind === 'technical' ? '' : 'Yes';
  return [
    { range: `${LEAGUE_RESULTS_SHEETS.log}!K${row}:V${row}`, values: [scoreValues(parsed).map(coerceNumber)] },
    { range: `${LEAGUE_RESULTS_SHEETS.log}!W${row}:X${row}`, values: [[detectSet3Mode(parsed), completed]] },
    { range: `${LEAGUE_RESULTS_SHEETS.log}!AB${row}`, values: [[resultMarker(slot)]] },
    { range: `${LEAGUE_RESULTS_SHEETS.log}!AN${row}:AO${row}`, values: [resultPoints(slot)] }
  ];
}
async function matchLogHeaders(spreadsheetId) {
  const values = await getValues(spreadsheetId, 'Match_Log!A1:BZ5');
  // norm() выкидывает подчёркивания: «p1_id» превращается в «p1id». Искали же
  // строку заголовков по сырому «p1_id» — и не находили НИКОГДА, ни в одной
  // таблице. Из-за этого список колонок всегда приходил пустым, а с ним молча
  // отваливались все именованные записи: сезон (Competition), result_kind,
  // очки за матч и технические поражения. Сравниваем нормализованное с
  // нормализованным — и колонки находятся.
  const wanted = norm('p1_id');
  const rowIndex = values.findIndex(r => (r || []).map(norm).includes(wanted));
  if (rowIndex < 0) return { row: 1, headers: [] };
  return { row: rowIndex + 1, headers: (values[rowIndex] || []).map(norm) };
}
function namedWrite(headers, row, names, value) {
  for (const name of names) {
    const i = headers.indexOf(norm(name));
    if (i >= 0) return { range: `Match_Log!${colToLetter(i + 1)}${row}`, values: [[value]] };
  }
  return null;
}
async function ensureCrossGroupSheet() {
  const api = sheetsClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID });
  const exists = (meta.data.sheets || []).some(x => x.properties?.title === CROSS_GROUP_SHEET);
  if (!exists) await api.spreadsheets.batchUpdate({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, requestBody:{ requests:[{ addSheet:{ properties:{ title:CROSS_GROUP_SHEET } } }] } });
  let values = [];
  try { values = await getValues(LEAGUE_RESULTS_SHEET_ID, CROSS_GROUP_SHEET+'!A1:O1'); } catch {}
  if (!(values[0] || []).length) await api.spreadsheets.values.update({ spreadsheetId:LEAGUE_RESULTS_SHEET_ID, range:CROSS_GROUP_SHEET+'!A1:O1', valueInputOption:'RAW', requestBody:{ values:[CROSS_GROUP_HEADERS] } });
}
async function seedWomenCrossGroupSchedule(season){
  await ensureCrossGroupSheet();
  const api=sheetsClient(),values=await getValues(LEAGUE_RESULTS_SHEET_ID,CROSS_GROUP_SHEET+'!A1:O');
  const rows=values.slice(1),exists=(a,b)=>rows.some(r=>String(r[1]||'')===String(season)&&divisionLetter(r[2])==='W'&&((sameName(r[4],a)&&sameName(r[6],b))||(sameName(r[4],b)&&sameName(r[6],a))));
  const missing=W_CROSS_SCHEDULE.filter(([a,b])=>!exists(a,b)).map(([a,b])=>['',String(season),'W','2',a,'1',b,'','','','','','','','scheduled','']);
  if(missing.length)await api.spreadsheets.values.append({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:CROSS_GROUP_SHEET+'!A:O',valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',requestBody:{values:missing}});
}
function playoffStage(v='') {
  const x=String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
  if(['qf','quarterfinal','quarterfinals'].includes(x))return 'QF';
  if(['sf','semifinal','semifinals'].includes(x))return 'SF';
  if(['final','f'].includes(x))return 'Final';
  if(['3rd','third','thirdplace','bronze'].includes(x))return '3rd';
  return '';
}
async function ensurePlayoffSheet() {
  const api=sheetsClient(),meta=await api.spreadsheets.get({spreadsheetId:LEAGUE_RESULTS_SHEET_ID});
  const exists=(meta.data.sheets||[]).some(x=>x.properties?.title===PLAYOFF_SHEET);
  if(!exists)await api.spreadsheets.batchUpdate({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,requestBody:{requests:[{addSheet:{properties:{title:PLAYOFF_SHEET}}}]}});
  let values=[];try{values=await getValues(LEAGUE_RESULTS_SHEET_ID,PLAYOFF_SHEET+'!A1:Q1')}catch{}
  if(!(values[0]||[]).length)await api.spreadsheets.values.update({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:PLAYOFF_SHEET+'!A1:Q1',valueInputOption:'RAW',requestBody:{values:[PLAYOFF_HEADERS]}});
}
async function writePlayoffResult(pair,slot,stage) {
  await ensurePlayoffSheet();const values=await getValues(LEAGUE_RESULTS_SHEET_ID,PLAYOFF_SHEET+'!A1:Q'),rows=values.slice(1);
  const p1=String(slot.from_name||pair.a?.name||'').trim(),p2=String(slot.to_name||pair.b?.name||'').trim();let found=-1;
  for(let i=0;i<rows.length;i++){const r=rows[i]||[],same=String(r[1]||'')===String(pair.season)&&divisionLetter(r[2])===pair.d1&&String(r[3]||'').toLowerCase()===String(stage).toLowerCase();const names=(sameName(r[5],p1)&&sameName(r[6],p2))||(sameName(r[5],p2)&&sameName(r[6],p1));if(same&&names){found=i+2;break}}
  const winner=!slot.result_winner?'':String(slot.result_winner)===String(slot.from_telegram_id)?p1:p2;
  const row=[String(slot.challenge_id||''),String(pair.season||''),pair.d1,stage,String(slot.round_slot||''),p1,p2,String(pair.groupA||pair.a?.group||''),String(pair.groupB||pair.b?.group||''),resultKind(slot),String(slot.result_score||''),winner,...resultPoints(slot),String(slot.result_note||''),'confirmed',String(slot.agreed_date||'')];
  const api=sheetsClient();if(found>0)await api.spreadsheets.values.update({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:PLAYOFF_SHEET+'!A'+found+':Q'+found,valueInputOption:'USER_ENTERED',requestBody:{values:[row]}});else await api.spreadsheets.values.append({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:PLAYOFF_SHEET+'!A:Q',valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',requestBody:{values:[row]}});
  return{status:'saved',division:pair.d1,playoff:true,stage,row:found>0?found:rows.length+2,sheet:PLAYOFF_SHEET};
}

async function writeCrossGroupResult(pair, slot) {
  await seedWomenCrossGroupSchedule(pair.season);
  const values = await getValues(LEAGUE_RESULTS_SHEET_ID, CROSS_GROUP_SHEET+'!A1:O');
  const rows = values.slice(1), p1=String(slot.from_name||pair.a?.name||'').trim(), p2=String(slot.to_name||pair.b?.name||'').trim();
  let found = -1;
  for (let i=0;i<rows.length;i++) {
    const r=rows[i]||[], sameSeason=String(r[1]||'')===String(pair.season), sameDivision=divisionLetter(r[2])===pair.d1;
    const samePlayers=(sameName(r[4],p1)&&sameName(r[6],p2))||(sameName(r[4],p2)&&sameName(r[6],p1));
    if (sameSeason&&sameDivision&&samePlayers) { found=i+2; break; }
  }
  const winnerName=!slot.result_winner?'':String(slot.result_winner)===String(slot.from_telegram_id)?p1:p2;
  const row=[String(slot.challenge_id||''),String(pair.season||''),pair.d1,String(pair.groupA||''),p1,String(pair.groupB||''),p2,resultKind(slot),String(slot.result_score||''),winnerName,...resultPoints(slot),String(slot.result_note||''),'confirmed',String(slot.agreed_date||'')];
  const api=sheetsClient();
  if(found > 0) await api.spreadsheets.values.update({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:CROSS_GROUP_SHEET+'!A'+found+':O'+found,valueInputOption:'USER_ENTERED',requestBody:{values:[row]}});
  else await api.spreadsheets.values.append({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:CROSS_GROUP_SHEET+'!A:O',valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',requestBody:{values:[row]}});
  return {status:'saved',division:pair.d1,cross_group:true,row:found > 0 ? found : rows.length+2,sheet:CROSS_GROUP_SHEET};
}

async function nextEmptyRow(spreadsheetId, sheetName, col, startRow) {
  const letter = colToLetter(col);
  const values = await getValues(spreadsheetId, `${sheetName}!${letter}${startRow}:${letter}`);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i]?.[0] || '').trim() === '') return startRow + i;
  }
  return startRow + values.length;
}

// Players_Master: имя → { division }. Нужен, чтобы понять, в какую таблицу дивизиона писать.
async function playersIndex() {
  const values = await getValues(LEAGUE_RESULTS_SHEET_ID, `${LEAGUE_RESULTS_SHEETS.master}!A${MASTER_START_ROW}:C`);
  const index = {};
  for (const row of values) {
    const name = String(row[1] || '').trim();
    if (name) index[norm(name)] = { id: row[0], name, division: String(row[2] || '').trim() };
  }
  return index;
}

// Центральный лог бот заполнял наполовину: дата, имена и счёт писались, а сезон,
// ID игроков и дивизионы оставались пустыми. Между тем именно по этим ID витрина
// цепляет матч к профилям — без них матч не попадал ни в историю игрока, ни в
// сезонные цифры, и сезон приходилось проставлять руками.
// Пишем только в пустые ячейки: чужие пометки организатора не трогаем.
async function centralMetaWrites(row, { p1, p2, pair }) {
  const season = String(pair?.season || '').trim();
  const master = await playersIndex().catch(() => ({}));
  const idOf = name => master[norm(name)]?.id ?? '';
  const divisionOf = (name, letter) => letter || master[norm(name)]?.division || '';
  const wanted = [
    ['D', season ? `Season ${season}` : ''],
    ['E', idOf(p1)],
    ['F', divisionOf(p1, pair?.d1)],
    ['G', idOf(p2)],
    ['H', divisionOf(p2, pair?.d2)]
  ];
  const current = await getValues(LEAGUE_RESULTS_SHEET_ID, `${LEAGUE_RESULTS_SHEETS.log}!D${row}:H${row}`).catch(() => []);
  const have = current?.[0] || [];
  const out = [];
  wanted.forEach(([letter, value], i) => {
    if (value === '' || value === undefined || value === null) return;
    if (String(have[i] ?? '').trim()) return;
    out.push({ range: `${LEAGUE_RESULTS_SHEETS.log}!${letter}${row}`, values: [[value]] });
  });
  return out;
}

async function findDivisionRow(spreadsheetId, sheetName, p1, p2) {
  const values = await getValues(spreadsheetId, `${sheetName}!C2:E`);
  const t1 = norm(p1), t2 = norm(p2);
  for (let i = 0; i < values.length; i++) {
    const a = norm(values[i]?.[0]), b = norm(values[i]?.[2]);
    if (a === t1 && b === t2) return { row: i + 2, reversed: false };
    if (a === t2 && b === t1) return { row: i + 2, reversed: true };
  }
  return null;
}

// Защита от дублей.
// Старый results-бот продолжает разбирать счёт, вручную выложенный в тему результатов,
// и дописывает свою строку. Дату он ставит СЕГОДНЯШНЮЮ (день сообщения), а не день матча,
// поэтому сверять только по дате нельзя — ищем ту же пару в окне ±7 дней в любом порядке имён.
const DUPLICATE_WINDOW_DAYS = 7;

async function findExistingResultRow(p1, p2, dateSerial) {
  const values = await getValues(LEAGUE_RESULTS_SHEET_ID, `${LEAGUE_RESULTS_SHEETS.log}!B2:J`);
  const t1 = norm(p1), t2 = norm(p2);
  for (let i = 0; i < values.length; i++) {
    const row = values[i] || [];
    const a = norm(row[7]);   // колонка I
    const b = norm(row[8]);   // колонка J
    if (!a || !b) continue;
    const samePair = (a === t1 && b === t2) || (a === t2 && b === t1);
    if (!samePair) continue;
    const when = Number(row[0]);
    const close = !Number.isFinite(when) || !Number.isFinite(dateSerial)
      || Math.abs(when - dateSerial) <= DUPLICATE_WINDOW_DAYS;
    if (close) return { row: i + 2, date: when };
  }
  return null;
}

// Составы сезона определяют дивизион и группу для записи результата.
// Междивизионные матчи сохраняют существующее ручное подтверждение админом.
// Между группами одного дивизиона запись пока запрещена.
export async function divisionPair(p1, p2, slot = {}) {
  const { seasonRoster } = await import('./division.js');
  const scope = await slotScope(slot);
  const map = await seasonRoster(scope.season);
  const cross = scope.group === 'cross';
  const a = map.players.find(p => p.letter === scope.letter && (cross || String(p.group || '') === scope.group) && sameName(p.name, p1));
  const b = map.players.find(p => p.letter === scope.letter && (cross || String(p.group || '') === scope.group) && sameName(p.name, p2))
    || map.players.find(p => p.letter !== scope.letter && sameName(p.name, p2));
  if (!a || !b) return { known:false, season:scope.season, group:scope.group, reason:cross?'Players are not in the same division':'Players are not in the same division group' };
  const crossGroup = a.letter === b.letter && String(a.group || '') !== String(b.group || '');
  return { known:true, season:scope.season, group:crossGroup?'cross':scope.group, groupA:String(a.group||''), groupB:String(b.group||''), crossGroup, a, b, d1:divisionLetter(a.letter), d2:divisionLetter(b.letter) };
}

// Счёт в слоте всегда «от from_telegram_id», поэтому p1 = from_name.
// force: организатор разрешил записать междивизионный матч руками.
export async function writeConfirmedResult(slot, { force = false, journal = null } = {}) {
  if (!LEAGUE_RESULTS_SHEET_ID) return { status: 'skipped', reason: 'LEAGUE_RESULTS_SHEET_ID не задан' };
  const p1 = String(slot.from_name || '').trim();
  const p2 = String(slot.to_name || '').trim();
  if (!p1 || !p2) return { status: 'error', reason: 'нет имён игроков' };
  const parsed = cellToScore(slot.result_score);

  try {
    // Матч между разными дивизионами в зачёт не идёт. Раньше он молча уезжал в
    // общий лог и портил историю; теперь не пишем никуда, пока организатор не
    // подтвердит. Если игрока нет в Players_Master, дивизион неизвестен —
    // блокировать по незнанию нельзя, пишем как раньше.
    const pair = await divisionPair(p1, p2, slot);
    if (!pair.known) return {status:'error',reason:pair.reason};
    if (!force && pair.known && pair.d1 && pair.d2 && pair.d1 !== pair.d2) {
      return { status: 'cross_division_blocked', d1: pair.d1, d2: pair.d2, p1, p2 };
    }

    const dateSerial = localDateSerial(slot.agreed_date);
    // Если строка этой пары уже есть — не дописываем вторую. Скорее всего её внёс
    // старый бот из сообщения в чате; счёт из мини-приложения при этом подтверждён
    // обоими игроками, поэтому расхождение стоит проверить руками.
    const existing = await findExistingResultRow(p1, p2, dateSerial);
    if (existing) {
      await batchUpdate(LEAGUE_RESULTS_SHEET_ID,
        centralWrites(existing.row, slot, parsed).concat(await centralMetaWrites(existing.row, { p1, p2, pair })), journal);
      const division = await writeDivisionRow(p1, p2, parsed, pair, slot, journal).catch(e => ({ status: 'error', reason: e.message }));
      return { status: 'duplicate', row: existing.row, division };
    }
    const row = await nextEmptyRow(LEAGUE_RESULTS_SHEET_ID, LEAGUE_RESULTS_SHEETS.log, COL_P1_NAME, DATA_START_ROW);
    await batchUpdate(LEAGUE_RESULTS_SHEET_ID, [
      { range: `${LEAGUE_RESULTS_SHEETS.log}!B${row}`, values: [[dateSerial]] },
      { range: `${LEAGUE_RESULTS_SHEETS.log}!I${row}:J${row}`, values: [[p1, p2]] },
      ...centralWrites(row, slot, parsed),
      ...await centralMetaWrites(row, { p1, p2, pair })
    ], journal);

    const division = await writeDivisionRow(p1, p2, parsed, pair, slot, journal).catch(e => ({ status: 'error', reason: e.message }));
    return { status: 'saved', row, division };
  } catch (e) {
    console.error('writeConfirmedResult failed:', e.message);
    return { status: 'error', reason: e.message };
  }
}

async function writeDivisionRow(p1, p2, parsed, known = null, slot = {}, journal = null) {
  const pair = known && known.known !== undefined ? known : await divisionPair(p1, p2);
  if (!pair.known) return { status: 'player_not_found' };
  const { d1, d2 } = pair;
  if (!d1 || d1 !== d2) return { status: 'cross_division', d1, d2 };
  const stage=playoffStage(slot.round);
  const playoff=stage?await writePlayoffResult(pair,slot,stage):null;
  if (pair.crossGroup) return playoff || writeCrossGroupResult(pair, slot);
  // Таблицу берём из реестра Divisions: там на каждый дивизион сезона своя
  // строка со ссылкой, поэтому PRIME, W и любой будущий дивизион подключаются
  // добавлением строки, а не правкой переменных Railway. Переменные остались
  // запасным вариантом для A–D, если реестр ещё не заполнен.
  // Сезон берём тот же, в чьих составах нашли игроков, — иначе счёт уезжал в
  // таблицу прошлого сезона, если в настройках забыли переставить номер.
  let season = String(pair.season || '').trim();
  if (!season) {
    const { latestSeason } = await import('./division.js');
    season = String(await latestSeason().catch(() => '') || '').trim()
      || String(await getSetting('season_number').catch(() => '') || '').trim();
  }
  const spreadsheetId = (await divisionSheetId(d1, season, pair.group).catch(() => '')) || (!pair.group && DIVISION_SPREADSHEETS[d1]) || '';
  if (!spreadsheetId) return { status: 'config_missing', division: d1 };
  const info = await findDivisionRow(spreadsheetId, 'Match_Log', p1, p2);
  if (!info) return playoff || { status: 'row_not_found', division: d1, season };
  const p = info.reversed ? reverseScore(parsed) : parsed;
  const kind = resultKind(slot), points = resultPoints(slot, info.reversed), marker = resultMarker(slot, info.reversed);
  const writes = [
    { range: `Match_Log!F${info.row}:Q${info.row}`, values: [scoreValues(p).map(coerceNumber)] },
    { range: `Match_Log!R${info.row}:S${info.row}`, values: [[detectSet3Mode(p), kind === 'technical' ? '' : 'Yes']] }
  ];
  const { headers } = await matchLogHeaders(spreadsheetId).catch(() => ({ headers: [] }));
  const extra = [
    namedWrite(headers, info.row, ['result_kind','match_result_kind'], kind),
    namedWrite(headers, info.row, ['result_status','technical_result','result_marker'], marker),
    namedWrite(headers, info.row, ['p1_result_points','p1_points','player_1_points'], points[0]),
    namedWrite(headers, info.row, ['p2_result_points','p2_points','player_2_points'], points[1]),
    namedWrite(headers, info.row, ['result_note','comment'], String(slot.result_note || ''))
  ].filter(Boolean);
  // Сезон матча. Строки в Match_Log заводятся заранее, и колонка Competition в
  // них часто пустая — бот её не заполнял. Без неё матч терял сезон везде, где
  // он нужен: в Fantasy, в истории дивизионов, в строке идущего сезона.
  // Пишем только если колонка в таблице есть и в ней пусто — чужие подписи
  // («Playoff S2», ручные пометки организатора) не трогаем.
  let seasonWrite = { column: '', value: '', skipped: '' };
  if (season) {
    const cell = namedWrite(headers, info.row, ['competition','tournament'], `Season ${season}`)
      || namedWrite(headers, info.row, ['season','season_id','season_number'], season);
    if (!cell) seasonWrite.skipped = 'в Match_Log нет колонки Competition/Season';
    else {
      const had = await getValues(spreadsheetId, cell.range).catch(() => []);
      const current = String(had?.[0]?.[0] ?? '').trim();
      if (current) seasonWrite.skipped = `в ячейке уже стоит «${current}»`;
      else { extra.push(cell); seasonWrite = { column: cell.range, value: cell.values[0][0], skipped: '' }; }
    }
  } else seasonWrite.skipped = 'сезон матча не определён';
  if (kind === 'technical') {
    const winner = info.reversed
      ? (String(slot.result_winner) === String(slot.from_telegram_id) ? 'p2' : String(slot.result_winner) ? 'p1' : '')
      : (String(slot.result_winner) === String(slot.from_telegram_id) ? 'p1' : String(slot.result_winner) ? 'p2' : '');
    const p1Loss = winner === 'p2' || !winner ? points[0] : '';
    const p2Loss = winner === 'p1' || !winner ? points[1] : '';
    const a = namedWrite(headers, info.row, ['p1_techloss'], p1Loss);
    const b = namedWrite(headers, info.row, ['p2_techloss'], p2Loss);
    if (a) extra.push(a); if (b) extra.push(b);
  }
  // Снимок для карточки результата: место в дивизионе, форма и очки Fantasy
  // «до» этого матча. Снимаем строго перед записью — после неё это состояние
  // уже не восстановить простым чтением таблицы. Best-effort: карточка не
  // обязана блокировать сохранение самого счёта.
  await captureCardContext({ spreadsheetId, headers, info, p1, p2, parsed, pair, season, slot, d1 })
    .catch(e => console.error('card context capture failed:', e.message));
  await batchUpdate(spreadsheetId, writes.concat(extra), journal);
  // Результат записан — значит всё, что из него считается, устарело.
  // Без этого таблица дивизиона, места и профили жили старыми ещё пять минут.
  await refreshAfterResult().catch(e => console.error('refresh after result failed:', e.message));
  return { status: 'saved', division: d1, row: info.row, reversed: info.reversed, playoff:playoff||null,
    season, season_write: seasonWrite, columns: headers.length, spreadsheet_id: spreadsheetId };
}

// Счёт от лица конкретного игрока (p1=slot.from_name или его разворот) для
// Fantasy: то же правило, что и для записи в таблицу (RET/W-O — раздельная
// строка-маркер, обычный счёт форматируется из уже распарсенного объекта).
function scoreTextFor(slot, parsed, reversed) {
  const kind = resultKind(slot);
  if (kind === 'technical') return resultMarker(slot, reversed) || (slot.result_winner ? (reversed ? 'L/W' : 'W/L') : 'L/L');
  const p = reversed ? reverseScore(parsed) : parsed;
  const s = formatScore(p);
  return kind === 'retired' ? s + ' RET' : s;
}

// Снимок контекста карточки результата: место в дивизионе «до» этого матча,
// живая форма (W/L строго до него) и очки Fantasy за этот конкретный матч —
// для ОБОИХ игроков, даже если кто-то из них не в текущем roster-каталоге
// Fantasy: Костас хочет, чтобы очки считались всем, кто реально сыграл.
// Цена по умолчанию 10 (как для дебютанта), если игрока нет в каталоге.
async function captureCardContext({ spreadsheetId, headers, info, p1, p2, parsed, pair, season, slot, d1 }) {
  const matchIdx = headers.indexOf('match');
  let matchNumber = 0;
  if (matchIdx >= 0) {
    const cell = await getValues(spreadsheetId, `Match_Log!${colToLetter(matchIdx + 1)}${info.row}`).catch(() => []);
    matchNumber = Number(cell?.[0]?.[0] || 0);
  }
  // Форму собираем по матчам ДО этого (его строка ещё пустая — счёт пишется
  // ниже), а сам матч дописываем руками: Костас хочет видеть плашку даже у
  // дебютанта, у которого этот матч — первый.
  const previous = matchNumber ? matchNumber - 1 : 0;
  const [beforeTable, historyP1, historyP2] = await Promise.all([
    getDivisionTable(d1, season, pair.group).catch(() => null),
    recentFormBefore(spreadsheetId, p1, previous).catch(() => []),
    recentFormBefore(spreadsheetId, p2, previous).catch(() => [])
  ]);
  // Имена сверяем терпимо: «Yana D.» в составе и «Yana D» в матч-логе — один и
  // тот же человек, а строгое сравнение оставляло карточку без места.
  const findPlace = name => beforeTable?.ok
    ? beforeTable.players.find(x => sameName(x.name, name))?.place
    : undefined;
  const catalog = await buildFantasyCatalog({ mode: 'live' }).catch(() => null);
  const priceOf = name => catalog?.players?.find(p => fantasyPlayerKey(p.name) === fantasyPlayerKey(name))?.price ?? 10;
  const bothTechnical = resultKind(slot) === 'technical' && !slot.result_winner;
  const p1Won = !bothTechnical && String(slot.result_winner) === String(slot.from_telegram_id);
  const p2Won = !bothTechnical && !p1Won;
  const fp1 = bothTechnical ? 0 : scoreFantasyMatch({ score: scoreTextFor(slot, parsed, false), result: p1Won ? 'WIN' : 'LOSS' }, priceOf(p1), priceOf(p2)).total;
  const fp2 = bothTechnical ? 0 : scoreFantasyMatch({ score: scoreTextFor(slot, parsed, true), result: p2Won ? 'WIN' : 'LOSS' }, priceOf(p2), priceOf(p1)).total;
  // Двойное техническое поражение победителя не даёт — такой матч в форму не идёт.
  const withCurrent = (history, won) => (bothTechnical ? history : [...history, won ? 'W' : 'L']).slice(-5);
  rememberCardContext(slot.challenge_id, {
    p1: { name: p1, place: findPlace(p1), form: withCurrent(historyP1, p1Won) },
    p2: { name: p2, place: findPlace(p2), form: withCurrent(historyP2, p2Won) },
    fp: { p1: fp1, p2: fp2 },
    division: d1, season, group: pair.group
  });
}

// Сброс кешей и подталкивание витрины.
//
// Своё сбрасываем всегда: это мгновенно и ничего не стоит. Витрину профилей
// (та таблица, что собирается формулами IMPORTRANGE и кормит карточки игроков
// и Fantasy) Google пересчитывает по своему расписанию, до получаса. Заставить
// его можно единственным способом: переписать формулу той же строкой — тогда
// он идёт за данными заново. Делаем это только если организатор включил
// PROFILE_REFRESH в Settings, и только по тем ячейкам, что нашли сами.
// Ищем в витрине профилей ячейки с IMPORTRANGE и переписываем их той же самой
// формулой. Читаем и пишем строго одно и то же значение — содержимое таблицы
// не меняется, меняется только момент, когда Google сходит за данными.
//
// dryRun отдаёт список найденного, ничего не трогая: сначала смотрим глазами,
// потом включаем.
export async function pokeProfileImports({ dryRun = false } = {}) {
  const { WEBSITE_SPREADSHEET_ID } = await import('./config.js');
  if (!WEBSITE_SPREADSHEET_ID) return { ok: false, reason: 'no_sheet' };
  const api = sheetsClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: WEBSITE_SPREADSHEET_ID, fields: 'sheets.properties(title,sheetId)' });
  const titles = (meta.data.sheets || []).map(x => x.properties?.title).filter(Boolean);
  const found = [];
  for (const title of titles) {
    let values = [];
    try {
      const res = await api.spreadsheets.values.get({
        spreadsheetId: WEBSITE_SPREADSHEET_ID,
        range: `'${title}'!A1:Z60`,
        valueRenderOption: 'FORMULA'
      });
      values = res.data.values || [];
    } catch { continue; }
    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '');
        if (!/^=.*IMPORTRANGE/i.test(cell)) continue;
        found.push({ sheet: title, a1: `'${title}'!${colLetter(c + 1)}${r + 1}`, formula: cell });
      }
    }
  }
  if (dryRun || !found.length) return { ok: true, dryRun: true, cells: found };
  let poked = 0;
  for (const cell of found) {
    try {
      // Сначала пусто, потом та же формула обратно — это и заставляет пересчитать.
      await api.spreadsheets.values.update({ spreadsheetId: WEBSITE_SPREADSHEET_ID, range: cell.a1,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [['']] } });
      await api.spreadsheets.values.update({ spreadsheetId: WEBSITE_SPREADSHEET_ID, range: cell.a1,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [[cell.formula]] } });
      poked++;
    } catch (e) { console.error(`poke ${cell.a1} failed:`, e.message); }
  }
  console.log(`profile refresh: обновлено формул ${poked}/${found.length}`);
  return { ok: true, poked, cells: found };
}
function colLetter(col) {
  let out = '';
  while (col > 0) { const rem = (col - 1) % 26; out = String.fromCharCode(65 + rem) + out; col = Math.floor((col - 1) / 26); }
  return out;
}

export async function refreshAfterResult() {
  try {
    const { invalidateLeagueCache } = await import('./sheets.js');
    invalidateLeagueCache();
  } catch (e) { console.error('league cache reset failed:', e.message); }
  try {
    const { invalidateDivisionCache } = await import('./division.js');
    invalidateDivisionCache();
  } catch (e) { console.error('division cache reset failed:', e.message); }
  scheduleCache.clear();
  try {
    const mode = String(await getSetting('PROFILE_REFRESH').catch(() => '') || '').trim().toLowerCase();
    if (['1','on','yes','true'].includes(mode)) await pokeProfileImports();
  } catch (e) { console.error('profile refresh failed:', e.message); }
}

// Расписание дивизиона: кто с кем должен сыграть и что уже сыграно.
// Строки создаются заранее (круговая система), поэтому «осталось сыграть» —
// это строки без счёта, а не то, чего нет в таблице.
const scheduleCache = new Map();
const SCHEDULE_CACHE_MS = 120000;

export async function getDivisionSchedule(division, season = '', group = '') {
  const key = divisionLetter(division);
  season = season || await (await import('./division.js')).latestSeason();
  const cacheKey = [season,key,group].join(':');
  if (!key) return [];
  const cached = scheduleCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SCHEDULE_CACHE_MS) return cached.v;
  const spreadsheetId = (await divisionSheetId(key, season, group).catch(() => '')) || (!group && DIVISION_SPREADSHEETS[key]) || '';
  if (!spreadsheetId) return [];
  try {
    // C — первый игрок, E — второй, F.. — счёт, S — отметка «сыграно».
    const values = await getValues(spreadsheetId, 'Match_Log!A2:S');
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] || [];
      const p1 = String(row[2] || '').trim();
      const p2 = String(row[4] || '').trim();
      if (!p1 || !p2) continue;
      const hasScore = String(row[5] ?? '').trim() !== '' && String(row[6] ?? '').trim() !== '';
      out.push({ row: i + 2, match:Number(row[0]), p1, p2, played: hasScore });
    }
    const {divisionRoster}=await import('./division.js');
    const roster=await divisionRoster(key,season,group);
    const names=(roster.players||[]).map(p=>norm(p.name));
    const count=new Set(names).size;
    const regularMax=count*(count-1)/2;
    const unique=new Map();
    for(const m of out) {
      if(count && (!names.includes(norm(m.p1))||!names.includes(norm(m.p2))))continue;
      if(regularMax && m.match>regularMax)continue;
      if(norm(m.p1)===norm(m.p2))continue;
      const pair=[norm(m.p1),norm(m.p2)].sort().join('|');
      if(!unique.has(pair))unique.set(pair,m);
      else if(m.played)unique.get(pair).played=true;
    }
    const clean=[...unique.values()];
    scheduleCache.set(cacheKey, { t: Date.now(), v: clean });
    return clean;
  } catch (e) {
    console.error('getDivisionSchedule failed:', e.message);
    return [];
  }
}

// Соперники игрока, с которыми матч ещё не сыгран.
export async function getUnplayedOpponents(division, playerName, season = '', group = '') {
  const schedule = await getDivisionSchedule(division, season, group);
  if (!schedule.length) return { known: false, names: [], total: 0, played: 0 };
  const me = norm(playerName);
  const mine = schedule.filter(m => norm(m.p1) === me || norm(m.p2) === me);
  if (!mine.length) return { known: false, names: [], total: 0, played: 0 };
  const names = mine.filter(m => !m.played).map(m => (norm(m.p1) === me ? m.p2 : m.p1));
  return { known: true, names, total: mine.length, played: mine.length - names.length };
}

export function describeWrite(result) {
  if (!result) return '';
  if (result.status === 'skipped') return 'таблицы лиги не подключены';
  if (result.status === 'error') return `ошибка записи: ${result.reason}`;
  if (result.status === 'cross_division_blocked') {
    return `междивизионный матч (${result.d1} — ${result.d2}): не записан, ждёт вашего решения`;
  }
  if (result.status === 'duplicate') {
    return `в общем логе уже есть строка этой пары (строка ${result.row}) — вторую не добавлял, счёт дивизиона обновлён. Проверьте, совпадает ли счёт.`;
  }
  const d = result.division;
  if (d?.status === 'saved') return `записано в общий лог и в таблицу Division ${d.division}, строка ${d.row}`;
  if (d?.status === 'cross_division') return 'междивизионный матч — только общий лог';
  if (d?.status === 'row_not_found') {
    return `в таблице Division ${d.division}${d.season ? ` (сезон ${d.season})` : ''} нет строки этой пары — счёт лёг только в общий лог`;
  }
  if (d?.status === 'player_not_found') return 'игроков нет в составах дивизионов — счёт лёг только в общий лог';
  if (d?.status === 'config_missing') return `не задан ID таблицы Division ${d.division}`;
  return 'записано в общий лог';
}
