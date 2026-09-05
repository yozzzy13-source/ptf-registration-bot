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
import { scoreValues, detectSet3Mode, reverseScore, cellToScore } from './tennis.js';

const DATA_START_ROW = 2;
const MASTER_START_ROW = 4;
const COL_P1_NAME = 9; // колонка I в Cross_Division_Match_Log

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
async function batchUpdate(spreadsheetId, data) {
  await sheetsClient().spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data }
  });
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

// Счёт в слоте всегда «от from_telegram_id», поэтому p1 = from_name.
export async function writeConfirmedResult(slot) {
  if (!LEAGUE_RESULTS_SHEET_ID) return { status: 'skipped', reason: 'LEAGUE_RESULTS_SHEET_ID не задан' };
  const p1 = String(slot.from_name || '').trim();
  const p2 = String(slot.to_name || '').trim();
  if (!p1 || !p2) return { status: 'error', reason: 'нет имён игроков' };
  const parsed = cellToScore(slot.result_score);

  try {
    const dateSerial = localDateSerial(slot.agreed_date);
    // Если строка этой пары уже есть — не дописываем вторую. Скорее всего её внёс
    // старый бот из сообщения в чате; счёт из мини-приложения при этом подтверждён
    // обоими игроками, поэтому расхождение стоит проверить руками.
    const existing = await findExistingResultRow(p1, p2, dateSerial);
    if (existing) {
      const division = await writeDivisionRow(p1, p2, parsed).catch(e => ({ status: 'error', reason: e.message }));
      return { status: 'duplicate', row: existing.row, division };
    }
    const row = await nextEmptyRow(LEAGUE_RESULTS_SHEET_ID, LEAGUE_RESULTS_SHEETS.log, COL_P1_NAME, DATA_START_ROW);
    await batchUpdate(LEAGUE_RESULTS_SHEET_ID, [
      { range: `${LEAGUE_RESULTS_SHEETS.log}!B${row}`, values: [[dateSerial]] },
      { range: `${LEAGUE_RESULTS_SHEETS.log}!I${row}:J${row}`, values: [[p1, p2]] },
      { range: `${LEAGUE_RESULTS_SHEETS.log}!K${row}:V${row}`, values: [scoreValues(parsed).map(coerceNumber)] },
      { range: `${LEAGUE_RESULTS_SHEETS.log}!W${row}:X${row}`, values: [[detectSet3Mode(parsed), 'Yes']] }
    ]);

    const division = await writeDivisionRow(p1, p2, parsed).catch(e => ({ status: 'error', reason: e.message }));
    return { status: 'saved', row, division };
  } catch (e) {
    console.error('writeConfirmedResult failed:', e.message);
    return { status: 'error', reason: e.message };
  }
}

async function writeDivisionRow(p1, p2, parsed) {
  const index = await playersIndex();
  const a = index[norm(p1)], b = index[norm(p2)];
  if (!a || !b) return { status: 'player_not_found' };
  const d1 = String(a.division || '').trim().toUpperCase();
  const d2 = String(b.division || '').trim().toUpperCase();
  if (!d1 || d1 !== d2) return { status: 'cross_division', d1, d2 };
  const spreadsheetId = DIVISION_SPREADSHEETS[d1];
  if (!spreadsheetId) return { status: 'config_missing', division: d1 };
  const info = await findDivisionRow(spreadsheetId, 'Match_Log', p1, p2);
  if (!info) return { status: 'row_not_found', division: d1 };
  const p = info.reversed ? reverseScore(parsed) : parsed;
  await batchUpdate(spreadsheetId, [
    { range: `Match_Log!F${info.row}:Q${info.row}`, values: [scoreValues(p).map(coerceNumber)] },
    { range: `Match_Log!R${info.row}:S${info.row}`, values: [[detectSet3Mode(p), 'Yes']] }
  ]);
  return { status: 'saved', division: d1, row: info.row, reversed: info.reversed };
}

// Расписание дивизиона: кто с кем должен сыграть и что уже сыграно.
// Строки создаются заранее (круговая система), поэтому «осталось сыграть» —
// это строки без счёта, а не то, чего нет в таблице.
const scheduleCache = new Map();
const SCHEDULE_CACHE_MS = 120000;

export async function getDivisionSchedule(division) {
  const key = String(division || '').trim().toUpperCase().replace(/^(DIVISION|ДИВИЗИОН)\s*/, '');
  if (!key) return [];
  const cached = scheduleCache.get(key);
  if (cached && Date.now() - cached.t < SCHEDULE_CACHE_MS) return cached.v;
  const spreadsheetId = DIVISION_SPREADSHEETS[key];
  if (!spreadsheetId) return [];
  try {
    // C — первый игрок, E — второй, F.. — счёт, S — отметка «сыграно».
    const values = await getValues(spreadsheetId, 'Match_Log!C2:S');
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i] || [];
      const p1 = String(row[0] || '').trim();
      const p2 = String(row[2] || '').trim();
      if (!p1 || !p2) continue;
      const hasScore = String(row[3] ?? '').trim() !== '' && String(row[4] ?? '').trim() !== '';
      out.push({ row: i + 2, p1, p2, played: hasScore });
    }
    scheduleCache.set(key, { t: Date.now(), v: out });
    return out;
  } catch (e) {
    console.error('getDivisionSchedule failed:', e.message);
    return [];
  }
}

// Соперники игрока, с которыми матч ещё не сыгран.
export async function getUnplayedOpponents(division, playerName) {
  const schedule = await getDivisionSchedule(division);
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
  if (result.status === 'duplicate') {
    return `в общем логе уже есть строка этой пары (строка ${result.row}) — вторую не добавлял, счёт дивизиона обновлён. Проверьте, совпадает ли счёт.`;
  }
  const d = result.division;
  if (d?.status === 'saved') return `записано в Division ${d.division}`;
  if (d?.status === 'cross_division') return 'междивизионный матч — только общий лог';
  if (d?.status === 'row_not_found') return `в таблице Division ${d.division} нет строки этой пары`;
  if (d?.status === 'config_missing') return `не задан ID таблицы Division ${d.division}`;
  return 'записано в общий лог';
}
