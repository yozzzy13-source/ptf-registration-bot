// Плей-офф лиги: сетка, публикация, результаты, расписание финальных дней.
//
// Где живёт. Лист Playoff общего журнала лиги (тот же файл, что и
// Cross_Division_Match_Log) — одна строка на матч плей-офф, для всех
// дивизионов. Строку можно поправить руками в Google Sheets: бот и сайт
// перечитывают лист и подхватывают правку.
//
// Формат.
//   A, B, Prime (одна группа): полуфиналы 1–4 и 2–3, финал, матч за 3-е место.
//   C, W (две группы): четвертьфиналы между группами —
//     верхняя половина: 1А–4Б, 2Б–3А;  нижняя: 1Б–4А, 2А–3Б,
//   так победители групп встречаются только в финале; дальше полуфиналы,
//   финал и матч за 3-е.
//
// Черновик (до публикации) живёт в Google Sheets и меняется сам:
//   · A, B, Prime — строки после группового этапа в таблице дивизиона
//     (Match_Log): формулы «1-е против 4-го», «2-е против 3-го», финал и матч
//     за 3-е место — победители и проигравшие полуфиналов. Поправить пару —
//     вписать id игрока в ячейку P1 ID / P2 ID (или через интерфейс).
//   · C, W — лист Playoff: бот после каждого результата пересчитывает места в
//     группах и переписывает пары 1A–4B, 2B–3A, 1B–4A, 2A–3B. Строку, которую
//     поменяли руками, бот больше не трогает (draft_auto — что он писал сам);
//     очистить имена в строке — вернуть её под автоматику.
//   Таблицы дивизионов из шаблона сезона 1: строки после группы в таблицах
//   групп C и W нигде не читаются.
//
// Как идёт.
//   1. На последней неделе регулярки сайт показывает черновик с пометкой
//      «предварительно»: он меняется вместе с таблицами.
//   2. После дедлайна организатор в «Мои матчи → Контроль → Плей-офф» решает
//      судьбу несыгранных матчей (W/O одному или «не засчитывать») и жмёт
//      «Опубликовать». Пары фиксируются в листе Playoff, игроки получают
//      сообщение. Игрока можно заменить (по умолчанию — следующий по таблице).
//   3. Четвертьфиналы игроки назначают сами, как обычный матч; соперник по
//      четвертьфиналу появляется в их списке соперников. Полуфиналы и финалы —
//      в один день на одном корте, время ставит организатор.
//   4. Счёт плей-офф пишется только в лист Playoff и в общий журнал с
//      пометкой стадии («Semifinal S2») — регулярку не трогает. Победитель
//      сам проходит дальше; после полуфиналов заполняются финал и матч за 3-е.
//   5. Афиша дня: картинка и текст на английском, сначала предпросмотр
//      организатору, потом рассылка всем в боте.
import { sheets as sheetsClient } from './google.js';
import { LEAGUE_RESULTS_SHEET_ID, PUBLIC_URL, ADMIN_IDS, SHEETS } from './config.js';
import { sameName, getSetting, setSetting, ensureExtraSheet, getRows, appendObject } from './sheets.js';
import { seasonCalendar, deadlineFor, dayIn, addDays, dateText } from './pace.js';

const SHEET = 'Playoff';
export const PLAYOFF_COLUMNS = ['match_id', 'season', 'division', 'stage', 'slot', 'player_1', 'player_2', 'player_1_group', 'player_2_group',
  'result_kind', 'score', 'winner', 'player_1_points', 'player_2_points', 'comment', 'status', 'date',
  'time', 'court', 'seed_1', 'seed_2', 'published_at', 'updated_at', 'draft_auto'];
export const DEFAULT_COURT = 'The Peak Racquet Park';
const DECISIONS = 'Playoff Decisions';
const DECISION_HEADERS = ['season', 'division', 'group', 'player_1', 'player_2', 'decision', 'loser', 'by', 'at'];
const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (v = '') => txt(v).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '');
// Тот же ключ дивизиона, что и в division.js: «Division A» → A, «P» → PRIME.
export const letterKey = v => letterOf(v);
const letterOf = v => { const key = txt(v).replace(/^(division|дивизион)\s*/i, '').trim().toUpperCase(); return ({ P: 'PRIME', WOMAN: 'W', WOMEN: 'W' })[key] || key; };
const colA1 = n => { let s = ''; for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + (x - 1) % 26) + s; return s; };

// ------------------------------------------------------------ стадии
export const STAGE_NAMES = {
  QF: { ru: 'Четвертьфинал', en: 'Quarterfinal', log: 'Quarterfinal' },
  SF: { ru: 'Полуфинал', en: 'Semifinal', log: 'Semifinal' },
  '3rd': { ru: 'Матч за 3-е место', en: '3rd place match', log: '3rd Place' },
  Final: { ru: 'Финал', en: 'Final', log: 'Final' }
};
// «Semifinal S2», «sf», «QF» → SF/QF; номер раунда переговоров («1», «2») — не стадия.
export function stageKey(v = '') {
  const x = txt(v).toLowerCase().replace(/\bs\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '');
  if (/^(qf|quarterfinals?|quarter)$/.test(x)) return 'QF';
  if (/^(sf|semifinals?|semi)$/.test(x)) return 'SF';
  if (/^(3rd|third|thirdplace|bronze|3rdplace|3rdplacematch)$/.test(x)) return '3rd';
  if (/^(f|final|finals)$/.test(x)) return 'Final';
  return '';
}
// Подпись соревнования в общем журнале: «Semifinal S2».
export const competitionLabel = (stage, season) => `${STAGE_NAMES[stage]?.log || stage} S${season}`;
export const stageTitle = (stage, ru) => STAGE_NAMES[stage]?.[ru ? 'ru' : 'en'] || stage;

// Шаблон сетки и откуда в неё приходят игроки.
export function bracketTemplate(grouped) {
  const t = grouped ? [1, 2, 3, 4].map(i => ({ stage: 'QF', slot: 'QF' + i })) : [];
  return t.concat([{ stage: 'SF', slot: 'SF1' }, { stage: 'SF', slot: 'SF2' }, { stage: '3rd', slot: '3rd' }, { stage: 'Final', slot: 'Final' }]);
}
// Посев: [индекс группы, место]. Группа 0 — первая по номеру.
export function seedMap(grouped) {
  return grouped
    ? { QF1: [[0, 1], [1, 4]], QF2: [[1, 2], [0, 3]], QF3: [[1, 1], [0, 4]], QF4: [[0, 2], [1, 3]] }
    : { SF1: [[0, 1], [0, 4]], SF2: [[0, 2], [0, 3]] };
}
// Следующие раунды: [[матч-источник, 'W' победитель | 'L' проигравший], …].
export function feedsOf(slot, grouped) {
  if (slot === 'SF1') return grouped ? [['QF1', 'W'], ['QF2', 'W']] : null;
  if (slot === 'SF2') return grouped ? [['QF3', 'W'], ['QF4', 'W']] : null;
  if (slot === 'Final') return [['SF1', 'W'], ['SF2', 'W']];
  if (slot === '3rd') return [['SF1', 'L'], ['SF2', 'L']];
  return null;
}
export const seedLabel = (grouped, groups, gi, place) => grouped ? `${place}·${groups[gi]?.group ?? gi + 1}` : `#${place}`;

// ------------------------------------------------------------ план сетки
// groups: [{ group, rows:[{ name, place }] }] — таблицы, места по порядку.
// overrides: { 'gi:place': 'Имя' } — замены организатора до публикации.
// skip: имена, которых в сетке быть не может (снялись) — их место занимает следующий.
export function buildPlan({ grouped, groups = [], overrides = {}, skip = [] }) {
  const ordered = groups.slice().sort((a, b) => String(a.group).localeCompare(String(b.group), 'en', { numeric: true }));
  const pools = ordered.map(g => (g.rows || []).filter(r => txt(r.name) && !skip.some(s => sameName(s, r.name)))
    .sort((a, b) => Number(a.place) - Number(b.place)));
  // Место занимает игрок с этим местом в таблице (без снявшихся); организатор
  // может поставить на место другого — например, следующего по таблице, если
  // кто-то не играет плей-офф. Остальные места не сдвигаются.
  const seat = (gi, place) => {
    const key = `${gi}:${place}`;
    if (overrides[key]) return { name: overrides[key], override: true };
    const hit = (pools[gi] || [])[place - 1];
    return hit ? { name: hit.name } : { name: '' };
  };
  const seeds = seedMap(grouped);
  return bracketTemplate(grouped).map(t => {
    const s = seeds[t.slot];
    if (!s) return { ...t, player_1: '', player_2: '', seed_1: '', seed_2: '', group_1: '', group_2: '' };
    const [a, b] = s.map(([gi, place]) => ({ ...seat(gi, place), gi, place }));
    return {
      ...t, player_1: a.name, player_2: b.name,
      seed_1: seedLabel(grouped, ordered, a.gi, a.place), seed_2: seedLabel(grouped, ordered, b.gi, b.place),
      group_1: grouped ? String(ordered[a.gi]?.group ?? '') : '', group_2: grouped ? String(ordered[b.gi]?.group ?? '') : '',
      gi_1: a.gi, place_1: a.place, gi_2: b.gi, place_2: b.place,
      override_1: Boolean(a.override), override_2: Boolean(b.override)
    };
  });
}

// Победитель/проигравший сыгранного матча.
export function outcomeOf(row) {
  if (txt(row?.status).toLowerCase() !== 'confirmed') return null;
  const w = txt(row.winner);
  if (!w) return null;
  const p1 = txt(row.player_1), p2 = txt(row.player_2);
  if (sameName(w, p1)) return { W: p1, L: p2, Wg: txt(row.player_1_group), Lg: txt(row.player_2_group) };
  if (sameName(w, p2)) return { W: p2, L: p1, Wg: txt(row.player_2_group), Lg: txt(row.player_1_group) };
  return null;
}
// Что дописать в следующие раунды после результатов. Сыгранные матчи не трогаем.
export function advancePatches(rows = [], grouped) {
  const bySlot = new Map(rows.map(r => [txt(r.slot), r]));
  const patches = [];
  for (const r of rows) {
    const feeds = feedsOf(txt(r.slot), grouped);
    if (!feeds) continue;
    if (txt(r.status).toLowerCase() === 'confirmed') continue;
    const sides = feeds.map(([src, take]) => { const o = outcomeOf(bySlot.get(src)); return o ? { name: o[take], group: o[take + 'g'] || '' } : { name: '', group: '' }; });
    const want = { player_1: sides[0].name, player_2: sides[1].name, player_1_group: sides[0].group, player_2_group: sides[1].group };
    const status = want.player_1 && want.player_2 ? 'scheduled' : 'tbd';
    if (!sameName(want.player_1, r.player_1) || !sameName(want.player_2, r.player_2) || txt(r.player_1) !== want.player_1 || txt(r.player_2) !== want.player_2 || txt(r.status).toLowerCase() !== status) {
      patches.push({ slot: txt(r.slot), patch: { ...want, status } });
    }
  }
  return patches;
}
// Подпись «кто здесь будет», пока пары нет: «Winner SF1».
export function placeholderOf(slot, side, grouped) {
  const f = feedsOf(slot, grouped);
  if (!f) return 'TBD';
  const [src, take] = f[side];
  return `${take === 'W' ? 'Winner' : 'Loser'} ${src}`;
}

// ------------------------------------------------------------ лист Playoff
let rowsCache = { t: 0, rows: null };
const ROWS_MS = 30_000;
export function forgetPlayoffRows() { rowsCache = { t: 0, rows: null }; }
async function ensureColumns() {
  const api = sheetsClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID });
  const props = (meta.data.sheets || []).find(s => s.properties?.title === SHEET)?.properties;
  if (!props) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: SHEET, gridProperties: { columnCount: PLAYOFF_COLUMNS.length + 2 } } } }] } });
  } else if (Number(props.gridProperties?.columnCount || 0) < PLAYOFF_COLUMNS.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, requestBody: { requests: [{ updateSheetProperties: {
      properties: { sheetId: props.sheetId, gridProperties: { columnCount: PLAYOFF_COLUMNS.length + 2 } }, fields: 'gridProperties.columnCount' } }] } });
  }
  const head = (await api.spreadsheets.values.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${SHEET}!A1:Z1` }).catch(() => null))?.data?.values?.[0] || [];
  if (PLAYOFF_COLUMNS.some((h, i) => txt(head[i]) !== h)) {
    await api.spreadsheets.values.update({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${SHEET}!A1:${colA1(PLAYOFF_COLUMNS.length - 1)}1`, valueInputOption: 'RAW', requestBody: { values: [PLAYOFF_COLUMNS] } });
  }
}
let columnsReady = null;
// Последнее удачное чтение: если Google на минуту отказал («лимит»), сайт и
// бот работают с ним, а не откатываются на старые правила сезона 1.
let lastGoodRows = null;
export async function readPlayoff({ fresh = false } = {}) {
  if (!LEAGUE_RESULTS_SHEET_ID) return [];
  if (!fresh && rowsCache.rows && Date.now() - rowsCache.t < ROWS_MS) return rowsCache.rows;
  let res;
  try {
    if (!columnsReady) columnsReady = ensureColumns().catch(e => { columnsReady = null; throw e; });
    await columnsReady;
    res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${SHEET}!A2:${colA1(PLAYOFF_COLUMNS.length - 1)}` });
  } catch (e) {
    if (lastGoodRows) { console.warn('Playoff: Google не ответил, беру последнюю копию:', e.message); return lastGoodRows; }
    throw e;
  }
  const rows = (res.data.values || []).map((v, i) => {
    const o = { _row: i + 2 };
    PLAYOFF_COLUMNS.forEach((h, j) => { o[h] = txt(v[j]); });
    // Старые строки: стадия «QF», слот «QF1» или просто «1».
    o.stage = stageKey(o.stage) || o.stage;
    if (/^\d+$/.test(o.slot)) o.slot = (o.stage === 'QF' || o.stage === 'SF') ? o.stage + o.slot : o.stage;
    if (!o.slot) o.slot = o.stage === 'Final' || o.stage === '3rd' ? o.stage : '';
    return o;
  });
  rowsCache = { t: Date.now(), rows };
  lastGoodRows = rows;
  return rows;
}
export async function divisionRows(letter, season, opts = {}) {
  const L = letterOf(letter);
  return (await readPlayoff(opts)).filter(r => txt(r.season) === String(season) && letterOf(r.division) === L);
}
// Опубликована — с отметкой публикации или если матч плей-офф уже сыгран
// (счёт внесён до публикации). Черновые строки с именами — это черновик.
export const isPublished = rows => rows.some(r => txt(r.published_at) || txt(r.status).toLowerCase() === 'confirmed');
// Строку черновика поменяли руками: имена не совпадают с тем, что писал бот.
export const isLocked = r => { const cur = `${txt(r.player_1)}|${txt(r.player_2)}`; return cur !== '|' && cur !== txt(r.draft_auto); };

async function writeRow(row, patch) {
  const merged = { ...row, ...patch, updated_at: new Date().toISOString() };
  const values = [PLAYOFF_COLUMNS.map(h => merged[h] ?? '')];
  const api = sheetsClient();
  if (row._row) await api.spreadsheets.values.update({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${SHEET}!A${row._row}:${colA1(PLAYOFF_COLUMNS.length - 1)}${row._row}`, valueInputOption: 'RAW', requestBody: { values } });
  else await api.spreadsheets.values.append({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${SHEET}!A:${colA1(PLAYOFF_COLUMNS.length - 1)}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
  forgetPlayoffRows();
  // Таблица дивизиона на сайте держит сетку в своём кэше — сбрасываем.
  import('./division.js').then(m => m.invalidateDivisionCache()).catch(() => {});
  return merged;
}

// ------------------------------------------------------------ данные лиги
async function divisionMeta(letter, season) {
  letter = letterOf(letter);
  const { divisionGroups, divisionDisplayName } = await import('./division.js');
  const groups = await divisionGroups(letter, season).catch(() => []);
  return { grouped: groups.length > 1, groups: groups.length > 1 ? groups : [{ group: '' }], title: divisionDisplayName(letter) };
}
async function standingsFor(letter, season, meta) {
  const { getDivisionTable } = await import('./division.js');
  const out = [];
  for (const g of meta.groups) {
    const t = await getDivisionTable(letter, season, g.group).catch(() => null);
    out.push({ group: String(g.group || ''), title: g.title || '', rows: (t?.players || []).map(p => ({ name: p.name, place: p.place, points: p.points, matches: p.matches, wins: p.wins })) });
  }
  return out;
}
async function withdrawnNames(season) {
  const { withdrawnList } = await import('./withdraw.js');
  return (await withdrawnList().catch(() => [])).filter(r => txt(r.season) === String(season)).map(r => r.player);
}
const OVERRIDES_KEY = 'playoff_overrides';
async function readOverrides() { try { return JSON.parse(txt(await getSetting(OVERRIDES_KEY)) || '{}'); } catch { return {}; } }
const overrideKey = (season, letter) => `${season}:${letterOf(letter)}`;

// ------------------------------------------------------------ таблица дивизиона (одна группа)
// Строки плей-офф в Match_Log таблицы дивизиона идут сразу после группового
// этапа: полуфинал 1, полуфинал 2, финал, матч за 3-е место. Имена в них
// считают формулы по местам (лист Division_Tracker), id игрока можно вписать
// руками. Номер — сразу после последнего матча круга (8 мест → 28 матчей).
const TRACKER_IDS = 'Division_Tracker!$J$7:$J$14', TRACKER_PLACES = 'Division_Tracker!$W$7:$W$14', TRACKER_NAMES = 'Division_Tracker!$K$7:$K$14';
export const placeFormula = k => `=INDEX(${TRACKER_IDS}, MATCH(${k}, ${TRACKER_PLACES}, 0))`;
const nameFormula = (col, r) => `=IF(${col}${r}="","",INDEX(${TRACKER_NAMES},${col}${r}))`;
const winnerFormula = r => `=IF(Y${r}="","",Y${r})`;
const loserFormula = r => `=IF(Y${r}="","",IF(Y${r}=B${r},D${r},B${r}))`;
const TABLE_SLOTS = ['SF1', 'SF2', 'Final', '3rd'];
// Место в сетке ↔ ячейка: 1 и 4 — полуфинал 1, 2 и 3 — полуфинал 2.
const SEAT_CELL = { 1: ['SF1', 1], 4: ['SF1', 2], 2: ['SF2', 1], 3: ['SF2', 2] };
const isFormula = v => txt(v).startsWith('=');
// Разделитель аргументов зависит от региона таблицы: в русском и европейских
// регионах формулы пишутся через «;», в английском — через «,». Внутри
// кавычек ничего не меняем. Сравнение формул от разделителя не зависит.
function swapSep(f, from, to) {
  let quoted = false, out = '';
  for (const ch of String(f ?? '')) { if (ch === '"') quoted = !quoted; out += !quoted && ch === from ? to : ch; }
  return out;
}
const commaForm = f => swapSep(f, ';', ',');
export const formulaIn = (f, sep) => sep === ';' ? swapSep(commaForm(f), ',', ';') : commaForm(f);
export const sameFormula = (a, b) => commaForm(txt(a)).replace(/\s+/g, '').toLowerCase() === commaForm(txt(b)).replace(/\s+/g, '').toLowerCase();
// Ячейка, где Google не смог прочитать формулу (или неизвестная функция).
const isBrokenShown = v => /^#(ERROR!|NAME\?)/.test(txt(v));

export function tableBracketFrom(values = [], formulas = [], spreadsheetId = '') {
  const head = values.findIndex(r => (r || []).some(c => norm(c) === 'p1_id'));
  const start = head >= 0 ? head + 1 : 1;
  const rows = [], ids = new Map();
  let maxId = 0;
  for (let i = start; i < values.length; i++) {
    const r = values[i] || [], f = formulas[i] || [];
    const no = Number(txt(r[0]));
    if (!(no > 0)) continue;
    rows.push({ sheetRow: i + 1, no, id1: txt(r[1]).replace(/\.0+$/, ''), n1: txt(r[2]), id2: txt(r[3]).replace(/\.0+$/, ''), n2: txt(r[4]), f1: f[1] ?? r[1], f2: f[3] ?? r[3], fc1: f[2] ?? r[2], fc2: f[4] ?? r[4] });
  }
  for (const r of rows) for (const [id, n] of [[r.id1, r.n1], [r.id2, r.n2]]) {
    const k = Number(id);
    if (k > 0) { maxId = Math.max(maxId, k); if (n && !ids.has(String(k))) ids.set(String(k), n); }
  }
  const regularMax = maxId > 1 ? maxId * (maxId - 1) / 2 : 0;
  const slots = {};
  TABLE_SLOTS.forEach((slot, i) => {
    const r = rows.find(x => x.no === regularMax + i + 1) || null;
    slots[slot] = r ? { ...r, p1: ids.get(r.id1) || r.n1, p2: ids.get(r.id2) || r.n2 } : null;
  });
  return { spreadsheetId, regularMax, slots, ids, rows, lastRow: rows.length ? rows[rows.length - 1].sheetRow : start };
}
const tableCache = new Map();
export function forgetTableBracket() { tableCache.clear(); }
export async function readTableBracket(letter, season, { fresh = false } = {}) {
  const { divisionSheetId, divisionGroups } = await import('./division.js');
  // C и W (две группы): сетка живёт в листе Playoff, строки-заготовки в
  // таблицах групп не читаем и не пишем.
  if ((await divisionGroups(letterOf(letter), season).catch(() => [])).length > 1) return null;
  const spreadsheetId = await divisionSheetId(letterOf(letter), season, '').catch(() => '');
  if (!spreadsheetId) return null;
  const hit = tableCache.get(spreadsheetId);
  if (!fresh && hit && Date.now() - hit.t < 60_000) return hit.v;
  const api = sheetsClient();
  const [vals, forms] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A1:E' }),
    api.spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A1:E', valueRenderOption: 'FORMULA' })
  ]);
  const v = tableBracketFrom(vals.data.values || [], forms.data.values || [], spreadsheetId);
  tableCache.set(spreadsheetId, { t: Date.now(), v });
  return v;
}
const idOfName = (b, name) => [...(b?.ids || new Map())].find(([, n]) => sameName(n, name))?.[0] || '';
// План одной группы — из строк таблицы. Замены (id вписан руками) видны как
// override_1/override_2: интерфейс помечает их так же, как раньше.
export function tablePlan(bracket, standings = []) {
  const place = name => (standings[0]?.rows || []).find(r => sameName(r.name, name))?.place;
  const seat = { SF1: [1, 4], SF2: [2, 3] };
  return bracketTemplate(false).map(t => {
    const r = bracket?.slots?.[t.slot];
    const p1 = r?.p1 || '', p2 = r?.p2 || '';
    const [a, b] = seat[t.slot] || [0, 0];
    return { ...t, player_1: p1, player_2: p2,
      seed_1: p1 && place(p1) ? `#${place(p1)}` : '', seed_2: p2 && place(p2) ? `#${place(p2)}` : '',
      group_1: '', group_2: '', gi_1: 0, place_1: a, gi_2: 0, place_2: b,
      override_1: Boolean(r && a && !isFormula(r.f1) && txt(r.f1)), override_2: Boolean(r && b && !isFormula(r.f2) && txt(r.f2)),
      source: 'table', table_row: r?.sheetRow || 0 };
  });
}
// Регион таблицы → разделитель формул («;» там, где десятичная запятая).
const sepCache = new Map();
export async function formulaSep(spreadsheetId) {
  if (sepCache.has(spreadsheetId)) return sepCache.get(spreadsheetId);
  let sep = ',';
  try {
    const r = await sheetsClient().spreadsheets.get({ spreadsheetId, fields: 'properties.locale' });
    const loc = txt(r?.data?.properties?.locale).replace('_', '-');
    if (loc && new Intl.NumberFormat(loc).format(1.5).includes(',')) sep = ';';
  } catch {}
  sepCache.set(spreadsheetId, sep);
  return sep;
}
const isFormulaValue = v => typeof v === 'string' && v.startsWith('=');
async function putCells(spreadsheetId, cells, sep) {
  if (!cells.length) return;
  await sheetsClient().spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED',
    data: cells.map(([a1, v]) => ({ range: `Match_Log!${a1}`, values: [[isFormulaValue(v) ? formulaIn(v, sep) : v]] })) } });
}
// Какие из записанных формул таблица показывает ошибкой (#ERROR!, #NAME?).
async function brokenCells(spreadsheetId, cells) {
  const list = cells.filter(([a1, v]) => isFormulaValue(v) && /^[A-E]\d+$/.test(a1));
  if (!list.length) return [];
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A1:E' });
  const vals = res?.data?.values || [];
  return list.filter(([a1]) => isBrokenShown(vals[Number(a1.slice(1)) - 1]?.[a1.charCodeAt(0) - 65]));
}
// Запись с проверкой: после записи бот смотрит, что показывают ячейки. Ошибка
// формулы — пробует другой разделитель; не помогло — возвращает как было.
async function putVerified(spreadsheetId, cells) {
  const sep = await formulaSep(spreadsheetId);
  await putCells(spreadsheetId, cells, sep);
  const bad = await brokenCells(spreadsheetId, cells);
  if (!bad.length) return [];
  const other = sep === ';' ? ',' : ';';
  await putCells(spreadsheetId, bad, other);
  const still = await brokenCells(spreadsheetId, bad);
  if (still.length < bad.length) sepCache.set(spreadsheetId, other);
  return still;
}
async function writeTableCells(bracket, cells) {
  if (!cells.length) return { ok: true, written: 0, bad: [] };
  const id = bracket.spreadsheetId;
  try {
    const bad = await putVerified(id, cells);
    if (!bad.length) return { ok: true, written: cells.length, bad: [] };
    const old = new Map();
    for (const r of bracket.rows || []) for (const [c, v] of [['B', r.f1], ['C', r.fc1], ['D', r.f2], ['E', r.fc2]]) old.set(`${c}${r.sheetRow}`, v ?? '');
    await putVerified(id, cells.map(([a1]) => [a1, old.get(a1) ?? ''])).catch(e => console.error('playoff table restore failed:', e.message));
    console.error('playoff table write rolled back:', bad.map(([a1]) => a1).join(', '));
    return { ok: false, written: 0, bad: bad.map(([a1]) => a1) };
  } finally {
    forgetTableBracket();
    import('./division.js').then(m => m.invalidateDivisionCache()).catch(() => {});
  }
}

// План сетки до публикации. Две группы — расчёт по таблицам групп, поверх —
// строки черновика, поправленные руками. Одна группа — строки таблицы дивизиона.
async function autoPlan(letter, season, meta, standings) {
  const overrides = (await readOverrides())[overrideKey(season, letter)] || {};
  const skip = await withdrawnNames(season);
  return { overrides, plan: buildPlan({ grouped: meta.grouped, groups: standings, overrides, skip }) };
}
export async function previewPlan(letter, season, { meta = null, standings = null } = {}) {
  meta = meta || await divisionMeta(letter, season);
  standings = standings || await standingsFor(letter, season, meta);
  if (!meta.grouped) {
    const bracket = await readTableBracket(letter, season).catch(e => { console.error('playoff table read failed:', e.message); return null; });
    const plan = tablePlan(bracket, standings);
    const overrides = {};
    for (const p of plan) {
      if (p.override_1) overrides[`0:${p.place_1}`] = p.player_1;
      if (p.override_2) overrides[`0:${p.place_2}`] = p.player_2;
    }
    return { meta, standings, overrides, plan, source: 'table' };
  }
  const { overrides, plan: auto } = await autoPlan(letter, season, meta, standings);
  const rows = await divisionRows(letter, season).catch(() => []);
  const plan = isPublished(rows) ? auto : auto.map(p => {
    const r = rows.find(x => x.slot === p.slot);
    if (!r || !isLocked(r)) return p;
    return { ...p, player_1: txt(r.player_1), player_2: txt(r.player_2), locked: true,
      override_1: !sameName(r.player_1, p.player_1), override_2: !sameName(r.player_2, p.player_2) };
  });
  return { meta, standings, overrides, plan, source: 'sheet' };
}

// ------------------------------------------------------------ черновик C, W в листе Playoff
// Пары четвертьфиналов пишутся в лист сами и меняются вместе с местами в
// группах. Строку, поправленную руками, не трогаем. После публикации — тишина.
export async function syncDrafts(season = '', { only = '' } = {}) {
  const { availableDivisions, latestSeason } = await import('./division.js');
  const s = txt(season) || txt(await latestSeason().catch(() => ''));
  if (!s || !LEAGUE_RESULTS_SHEET_ID) return { ok: false, reason: 'no_season' };
  const done = [];
  for (const letter of await availableDivisions(s).catch(() => [])) {
    if (only && letterOf(only) !== letterOf(letter)) continue;
    const meta = await divisionMeta(letter, s);
    if (!meta.grouped) continue;
    const rows = await divisionRows(letter, s, { fresh: true });
    if (isPublished(rows)) continue;
    const standings = await standingsFor(letter, s, meta);
    if (!standings.some(g => g.rows.length)) continue;
    const { plan } = await autoPlan(letter, s, meta, standings);
    let changed = 0;
    for (const p of plan) {
      const r = rows.find(x => x.slot === p.slot);
      if (r && isLocked(r)) continue;
      const want = { season: String(s), division: letterOf(letter), stage: p.stage, slot: p.slot,
        player_1: p.player_1, player_2: p.player_2, player_1_group: p.group_1 || '', player_2_group: p.group_2 || '',
        seed_1: p.seed_1 || '', seed_2: p.seed_2 || '', status: 'draft', draft_auto: `${p.player_1}|${p.player_2}` };
      if (r && Object.entries(want).every(([k, v]) => txt(r[k]) === txt(v))) continue;
      await writeRow(r || {}, want);
      changed++;
    }
    done.push({ letter: letterOf(letter), changed });
  }
  return { ok: true, season: s, divisions: done };
}
// После каждого результата — с задержкой и не чаще раза в минуту.
let syncTimer = null, syncAt = 0;
export function syncDraftsSoon() {
  if (syncTimer) return;
  const wait = Math.max(5_000, 60_000 - (Date.now() - syncAt));
  syncTimer = setTimeout(async () => {
    syncTimer = null; syncAt = Date.now();
    try {
      const { withPriority } = await import('./google.js');
      await (withPriority ? withPriority('low', () => syncDrafts()) : syncDrafts());
    } catch (e) { console.error('playoff drafts sync failed:', e.message); }
  }, wait);
  syncTimer.unref?.();
}

// ------------------------------------------------------------ проверка таблиц A, B, Prime
// Строки плей-офф в таблицах из шаблона сезона 1 оказались испорчены: во втором
// полуфинале вписаны случайные id, в первом — «4» вместо «4-го места», строки
// матча за 3-е место нет. Проверка показывает, что не так; fix — чинит: места
// формулами, финал и 3-е место — победители и проигравшие полуфиналов.
export async function checkTableBrackets(season = '', { fix = false } = {}) {
  const { availableDivisions, latestSeason } = await import('./division.js');
  const s = txt(season) || txt(await latestSeason().catch(() => ''));
  const out = [];
  for (const letter of await availableDivisions(s).catch(() => [])) {
    const meta = await divisionMeta(letter, s);
    if (meta.grouped) { out.push({ letter: letterOf(letter), title: meta.title, grouped: true, issues: [], fixed: 0 }); continue; }
    const published = isPublished(await divisionRows(letter, s).catch(() => []));
    const b = await readTableBracket(letter, s, { fresh: true }).catch(e => ({ error: e.message }));
    const item = { letter: letterOf(letter), title: meta.title, grouped: false, published, issues: [], fixed: 0 };
    out.push(item);
    if (!b || b.error) { item.issues.push(`таблица не прочиталась${b?.error ? ': ' + b.error : ''}`); continue; }
    const [sf1, sf2, fin, third] = TABLE_SLOTS.map(x => b.slots[x]);
    if (!sf1 || !sf2 || !fin) { item.issues.push(`нет строк полуфиналов и финала после матча №${b.regularMax}`); continue; }
    const cells = [];
    // Неверная формула — или верная, но таблица показывает ошибку (не прочиталась).
    const want = (r, col, f, label) => {
      const cur = col === 'B' ? r.f1 : r.f2, shown = col === 'B' ? r.id1 : r.id2;
      if (sameFormula(cur, f) && !isBrokenShown(shown)) return;
      cells.push([`${col}${r.sheetRow}`, f]);
      item.issues.push(sameFormula(cur, f) ? label.replace(/ не «.*»$/, ': ошибка формулы в ячейке') : label);
    };
    // Пары полуфиналов чиним только до публикации: после неё в ячейках стоят
    // зафиксированные id опубликованных пар.
    if (!published) {
      want(sf1, 'B', placeFormula(1), 'полуфинал 1: первый игрок не «1-е место»');
      want(sf1, 'D', placeFormula(4), 'полуфинал 1: второй игрок не «4-е место»');
      want(sf2, 'B', placeFormula(2), 'полуфинал 2: первый игрок не «2-е место»');
      want(sf2, 'D', placeFormula(3), 'полуфинал 2: второй игрок не «3-е место»');
    }
    want(fin, 'B', winnerFormula(sf1.sheetRow), 'финал: первый игрок не «победитель полуфинала 1»');
    want(fin, 'D', winnerFormula(sf2.sheetRow), 'финал: второй игрок не «победитель полуфинала 2»');
    let addThird = false;
    if (!third) { item.issues.push('нет строки матча за 3-е место'); addThird = true; }
    else {
      want(third, 'B', loserFormula(sf1.sheetRow), 'матч за 3-е: первый игрок не «проигравший полуфинала 1»');
      want(third, 'D', loserFormula(sf2.sheetRow), 'матч за 3-е: второй игрок не «проигравший полуфинала 2»');
      // Имена в строке матча за 3-е место бот вписывал сам — их тоже проверяем.
      for (const [col, cur, shown, src] of [['C', third.fc1, third.n1, 'B'], ['E', third.fc2, third.n2, 'D']]) {
        if (!txt(cur) || (isBrokenShown(shown) && !/^=\s*arrayformula/i.test(txt(cur)))) {
          cells.push([`${col}${third.sheetRow}`, nameFormula(src, third.sheetRow)]);
          item.issues.push(`матч за 3-е: имя ${src === 'B' ? 'первого' : 'второго'} игрока не считается`);
        }
      }
    }
    if (!fix || (!cells.length && !addThird)) continue;
    const api = sheetsClient();
    if (addThird) {
      // Строка-копия финала (все формулы строки: сеты, победитель, счёт), затем
      // номер матча и игроки — проигравшие полуфиналов.
      const r = fin.sheetRow + 1;
      if (b.rows.some(x => x.sheetRow === r)) { item.issues.push(`строка ${r} занята — матч за 3-е не добавлен`); }
      else {
        const meta2 = await api.spreadsheets.get({ spreadsheetId: b.spreadsheetId });
        const sheetId = (meta2.data.sheets || []).find(x => x.properties?.title === 'Match_Log')?.properties?.sheetId;
        await api.spreadsheets.batchUpdate({ spreadsheetId: b.spreadsheetId, requestBody: { requests: [{ copyPaste: {
          source: { sheetId, startRowIndex: fin.sheetRow - 1, endRowIndex: fin.sheetRow, startColumnIndex: 0, endColumnIndex: 40 },
          destination: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: 0, endColumnIndex: 40 }, pasteType: 'PASTE_NORMAL' } }] } });
        cells.push([`A${r}`, b.regularMax + 4], [`B${r}`, loserFormula(sf1.sheetRow)], [`C${r}`, nameFormula('B', r)],
          [`D${r}`, loserFormula(sf2.sheetRow)], [`E${r}`, nameFormula('D', r)]);
        for (const col of ['F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S']) cells.push([`${col}${r}`, '']);
      }
    }
    const w = await writeTableCells(b, cells);
    item.fixed = w.written;
    item.failed = w.bad;
    // Что теперь показывает таблица — для отчёта.
    const after = await readTableBracket(letter, s, { fresh: true }).catch(() => null);
    item.pairs = TABLE_SLOTS.map(slot => { const r = after?.slots?.[slot]; return { slot, p1: txt(r?.p1), p2: txt(r?.p2) }; });
  }
  return { ok: true, season: s, divisions: out };
}
export function tableCheckText(r, { fixed = false } = {}) {
  const lines = [`🏆 <b>Строки плей-офф в таблицах дивизионов · сезон ${esc(r.season)}</b>`];
  for (const d of r.divisions) {
    if (d.grouped) { lines.push(`• ${esc(d.title)}: две группы — черновик в листе Playoff, строки после группы в таблицах групп не используются`); continue; }
    if (!d.issues.length) { lines.push(`• ${esc(d.title)}: ✅ всё по местам`); continue; }
    lines.push(`• ${esc(d.title)}${d.published ? ' (сетка опубликована)' : ''}:`);
    for (const i of d.issues) lines.push(`   – ${esc(i)}`);
    if (fixed && d.failed?.length) lines.push(`   ❌ таблица не приняла формулы (${esc(d.failed.join(', '))}) — вернул как было, нужно смотреть руками`);
    else if (fixed) lines.push(`   ✅ исправлено ячеек: ${d.fixed}`);
    if (fixed && d.pairs) {
      const label = { SF1: 'Полуфинал 1', SF2: 'Полуфинал 2', Final: 'Финал', '3rd': 'За 3-е место' };
      for (const p of d.pairs) {
        const pair = p.p1 || p.p2 ? `${esc(p.p1 || '—')} — ${esc(p.p2 || '—')}` : 'ждёт полуфиналов';
        lines.push(`   ${label[p.slot]}: ${pair}${isBrokenShown(p.p1) || isBrokenShown(p.p2) ? ' ⚠️' : ''}`);
      }
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ несыгранные матчи
// Пары регулярки без результата: в группе (Match_Log без счёта и без W/O) и
// межгрупповые W. Решённые «не засчитывать» в список не попадают.
export async function unplayedMatches(letter, season, meta = null) {
  meta = meta || await divisionMeta(letter, season);
  const L = letterOf(letter);
  const { getDivisionSchedule } = await import('./results.js');
  const decided = await readDecisions().catch(() => []);
  const skip = await withdrawnNames(season);
  const isDecided = (g, a, b) => decided.some(d => txt(d.season) === String(season) && letterOf(d.division) === L && txt(d.group) === g
    && ((sameName(d.player_1, a) && sameName(d.player_2, b)) || (sameName(d.player_1, b) && sameName(d.player_2, a))));
  const out = [];
  for (const g of meta.groups) {
    const group = String(g.group || '');
    for (const m of await getDivisionSchedule(L, season, group).catch(() => [])) {
      if (m.played || skip.some(n => sameName(n, m.p1) || sameName(n, m.p2)) || isDecided(group, m.p1, m.p2)) continue;
      out.push({ kind: 'group', group, row: m.row, p1: m.p1, p2: m.p2 });
    }
  }
  if (L === 'W' && LEAGUE_RESULTS_SHEET_ID) {
    const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: 'Cross_Group_Match_Log!A1:O' }).catch(() => null);
    (res?.data?.values || []).forEach((r = [], i) => {
      if (i === 0 || txt(r[1]) !== String(season) || letterOf(r[2]) !== 'W') return;
      if (/^confirmed$/i.test(txt(r[13])) || txt(r[8])) return;
      if (skip.some(n => sameName(n, r[4]) || sameName(n, r[6])) || isDecided('cross', r[4], r[6])) return;
      out.push({ kind: 'cross', group: 'cross', row: i + 1, p1: txt(r[4]), p2: txt(r[6]), g1: txt(r[3]), g2: txt(r[5]) });
    });
  }
  return out.map(m => ({ ...m, key: [m.kind, m.group, m.row, norm(m.p1), norm(m.p2)].join('|') }));
}
async function readDecisions() {
  await ensureExtraSheet(DECISIONS, DECISION_HEADERS).catch(() => {});
  return ((await getRows(DECISIONS, { useCache: false }).catch(() => ({ rows: [] }))).rows || []);
}
// decision: 'none' — не засчитывать никому; 'loss_p1' / 'loss_p2' — W/O, проиграл p1 / p2.
export async function decideUnplayed(letter, season, key, decision, actor = {}) {
  const list = await unplayedMatches(letter, season);
  const m = list.find(x => x.key === key);
  if (!m) return { ok: false, reason: 'not_found' };
  if (!['none', 'loss_p1', 'loss_p2'].includes(decision)) return { ok: false, reason: 'bad_decision' };
  const L = letterOf(letter);
  const loser = decision === 'loss_p1' ? m.p1 : decision === 'loss_p2' ? m.p2 : '';
  const winner = decision === 'loss_p1' ? m.p2 : decision === 'loss_p2' ? m.p1 : '';
  if (decision !== 'none') {
    const api = sheetsClient();
    if (m.kind === 'group') {
      const { divisionSheetId } = await import('./division.js');
      const spreadsheetId = await divisionSheetId(L, season, m.group);
      const head = ((await api.spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A1:BZ1' })).data.values?.[0] || []).map(norm);
      const t1 = head.indexOf('p1_techloss'), t2 = head.indexOf('p2_techloss');
      if (t1 < 0 || t2 < 0) return { ok: false, reason: 'no_columns' };
      // В строке расписания игрок, проигравший W/O, может стоять и первым, и вторым.
      const row = (await api.spreadsheets.values.get({ spreadsheetId, range: `Match_Log!C${m.row}:E${m.row}` })).data.values?.[0] || [];
      const col = sameName(row[0], loser) ? t1 : sameName(row[2], loser) ? t2 : -1;
      if (col < 0) return { ok: false, reason: 'row_moved' };
      await api.spreadsheets.values.update({ spreadsheetId, range: `Match_Log!${colA1(col)}${m.row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[0]] } });
    } else {
      const today = dayIn();
      const firstLost = sameName(m.p1, loser);
      await api.spreadsheets.values.update({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `Cross_Group_Match_Log!H${m.row}:O${m.row}`, valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['technical', 'W/O', winner, firstLost ? 0 : 3, firstLost ? 3 : 0, `W/O: не сыгран до дедлайна`, 'confirmed', today]] } });
    }
  }
  await appendObject(DECISIONS, { season: String(season), division: L, group: m.group, player_1: m.p1, player_2: m.p2, decision, loser,
    by: txt(actor.name || actor.telegram_id || actor.id), at: new Date().toISOString() });
  try { (await import('./results.js')).refreshAfterResult(); } catch {}
  // Игрокам — короткое сообщение, что решили с их матчем.
  if (decision !== 'none') {
    const people = await peopleIndex();
    for (const [name, lost] of [[m.p1, sameName(m.p1, loser)], [m.p2, sameName(m.p2, loser)]]) {
      const p = people.find(x => sameName(x.name, name));
      if (!p?.telegram_id) continue;
      const other = sameName(name, m.p1) ? m.p2 : m.p1, ru = /^ru/i.test(p.language);
      const text = ru
        ? (lost ? `<b>🎾 Матч не сыгран до дедлайна</b>\n\nМатч с ${esc(other)} засчитан как техническое поражение (W/O): сопернику +3 очка, тебе 0.` : `<b>🎾 Техническая победа (W/O)</b>\n\nМатч с ${esc(other)} не был сыгран до дедлайна и засчитан тебе как победа: +3 очка.`)
        : (lost ? `<b>🎾 Match not played before the deadline</b>\n\nYour match with ${esc(other)} counts as a walkover loss: +3 points to your opponent, 0 to you.` : `<b>🎾 Walkover win (W/O)</b>\n\nYour match with ${esc(other)} wasn't played before the deadline and counts as your win: +3 points.`);
      const { sendMessage } = await import('./telegram.js');
      await sendMessage(p.telegram_id, text).catch(() => {});
    }
  }
  return { ok: true, match: m, decision, loser };
}

async function peopleIndex() {
  return ((await getRows(SHEETS.applicants).catch(() => ({ rows: [] }))).rows || []).filter(a => txt(a.telegram_id) && txt(a.name));
}

// ------------------------------------------------------------ состояние для админки
export async function playoffState(season = '', now = Date.now()) {
  const cal = await seasonCalendar(now);
  const { latestSeason, availableDivisions } = await import('./division.js');
  const s = txt(season) || txt(cal?.season) || txt(await latestSeason().catch(() => ''));
  const letters = await availableDivisions(s).catch(() => []);
  const today = dayIn(now);
  const divisions = [];
  for (const letter of letters) {
    const meta = await divisionMeta(letter, s);
    const pre = await previewPlan(letter, s, { meta });
    const rows = await divisionRows(letter, s);
    const published = isPublished(rows);
    const deadline = cal ? deadlineFor(cal, meta.grouped) : '';
    divisions.push({
      letter: letterOf(letter), title: meta.title, grouped: meta.grouped,
      groups: meta.groups.map(g => ({ group: String(g.group || ''), title: g.title || '' })),
      deadline, deadline_passed: Boolean(deadline) && today > deadline,
      standings: pre.standings, overrides: pre.overrides, preview: pre.plan, draft_source: pre.source,
      published, rows: published ? orderRows(rows) : [],
      unplayed: await unplayedMatches(letter, s, meta).catch(() => []),
      template: bracketTemplate(meta.grouped).map(t => ({ ...t, from: feedsOf(t.slot, meta.grouped) }))
    });
  }
  return { ok: true, season: s, today, cal, court: DEFAULT_COURT, divisions,
    poster_days: cal ? [cal.finalsStart, cal.end] : [] };
}
const ORDER = { QF1: 1, QF2: 2, QF3: 3, QF4: 4, SF1: 5, SF2: 6, '3rd': 7, Final: 8 };
const orderRows = rows => rows.slice().sort((a, b) => (ORDER[a.slot] || 9) - (ORDER[b.slot] || 9));

// ------------------------------------------------------------ действия организатора
// Замена в предварительной сетке: место (группа, номер) займёт другой игрок.
// Одна группа — пишем id игрока прямо в строку полуфинала таблицы дивизиона
// (пустое имя — вернуть формулу места). Две группы — замена хранится у бота,
// а черновик в листе Playoff тут же переписывается.
export async function setOverride(letter, season, gi, place, name) {
  const meta = await divisionMeta(letter, season);
  if (!meta.grouped) {
    const b = await readTableBracket(letter, season, { fresh: true });
    const seat = SEAT_CELL[Number(place)];
    const r = seat && b?.slots?.[seat[0]];
    if (!r) return { ok: false, reason: 'no_table_row' };
    const id = txt(name) ? idOfName(b, name) : '';
    if (txt(name) && !id) return { ok: false, reason: 'not_in_table' };
    const w = await writeTableCells(b, [[`${seat[1] === 1 ? 'B' : 'D'}${r.sheetRow}`, id ? Number(id) : placeFormula(Number(place))]]);
    if (!w.ok) return { ok: false, reason: 'table_write_failed' };
    const pre = await previewPlan(letter, season, { meta });
    return { ok: true, overrides: pre.overrides };
  }
  const all = await readOverrides();
  const key = overrideKey(season, letter);
  const cur = { ...(all[key] || {}) };
  if (txt(name)) cur[`${Number(gi)}:${Number(place)}`] = txt(name); else delete cur[`${Number(gi)}:${Number(place)}`];
  all[key] = cur;
  if (!Object.keys(cur).length) delete all[key];
  await setSetting(OVERRIDES_KEY, JSON.stringify(all), 'Замены в сетке плей-офф до публикации (пишет бот)');
  await syncDrafts(season, { only: letter }).catch(e => console.error('playoff drafts sync failed:', e.message));
  return { ok: true, overrides: cur };
}

// Публикация: пары фиксируются в листе Playoff, игроки получают сообщение.
// Пока в дивизионе нет ни одного сыгранного матча плей-офф, публикацию можно
// повторить (таблица поменялась) — сообщения уйдут только тем, у кого
// поменялась пара.
export async function publishBracket(letter, season, { actor = {}, notify = true, now = Date.now() } = {}) {
  const cal = await seasonCalendar(now);
  const { meta, plan } = await previewPlan(letter, season);
  const existing = await divisionRows(letter, season, { fresh: true });
  if (existing.some(r => txt(r.status).toLowerCase() === 'confirmed')) return { ok: false, reason: 'already_played' };
  const firstStage = meta.grouped ? 'QF' : 'SF';
  if (plan.filter(p => p.stage === firstStage).some(p => !p.player_1 || !p.player_2)) return { ok: false, reason: 'not_enough_players' };
  // Один игрок в двух местах — испорченные строки таблицы (строки плей-офф в таблице дивизиона).
  const seated = plan.filter(p => p.stage === firstStage).flatMap(p => [p.player_1, p.player_2]);
  if (seated.some((n, i) => seated.findIndex(x => sameName(x, n)) !== i)) return { ok: false, reason: 'duplicate_player' };
  const stamp = new Date().toISOString();
  const changed = [];
  for (const p of plan) {
    const old = existing.find(r => r.slot === p.slot) || {};
    const seeded = Boolean(p.player_1 || p.player_2);
    const date = p.stage === 'QF' ? '' : (txt(old.date) || (cal ? (p.stage === 'SF' ? cal.finalsStart : cal.end) : ''));
    const row = {
      ...old, match_id: txt(old.match_id), season: String(season), division: letterOf(letter), stage: p.stage, slot: p.slot,
      player_1: p.player_1, player_2: p.player_2, player_1_group: p.group_1 || '', player_2_group: p.group_2 || '',
      result_kind: '', score: '', winner: '', player_1_points: '', player_2_points: '', comment: txt(old.comment),
      status: seeded ? 'scheduled' : 'tbd', date, time: txt(old.time), court: txt(old.court) || (p.stage === 'QF' ? '' : DEFAULT_COURT),
      seed_1: p.seed_1, seed_2: p.seed_2, published_at: txt(old.published_at) || stamp, draft_auto: ''
    };
    // Черновые строки (без публикации) — это новая пара для игроков, даже если имена совпали.
    if (seeded && (!txt(old.published_at) || !sameName(old.player_1, p.player_1) || !sameName(old.player_2, p.player_2))) changed.push(row);
    await writeRow(old, row);
  }
  // Новая публикация не помнит замен до неё: они уже вошли в сетку.
  await setOverrideAll(letter, season, {});
  // Одна группа: пары полуфиналов в таблице дивизиона фиксируем id игроков —
  // таблица больше не гуляет вместе с местами, а счёт ляжет в эти же строки.
  if (!meta.grouped) await freezeTablePairs(letter, season, plan).catch(e => console.error('playoff table freeze failed:', e.message));
  const notified = notify ? await notifyPairs(changed, { cal, grouped: meta.grouped, title: meta.title }) : 0;
  // Первая публикация: остальным игрокам дивизиона — объявление (через очередь
  // рассылок: ночью ждёт утра).
  if (notify && !isPublished(existing)) await announcePublished(letter, season, plan, meta, cal).catch(e => console.error('playoff publish notice failed:', e.message));
  await logAdmin(`🏆 <b>Сетка плей-офф опубликована: ${esc(meta.title)}</b>\n` + changed.map(r => `• ${esc(r.slot)}: ${esc(r.player_1)} — ${esc(r.player_2)}`).join('\n') + (notify ? `\nСообщений игрокам: ${notified}` : ''), actor);
  // Сразу — картинка сетки на утверждение (разослать всем / в сторис).
  if (notify) await import('./playoffmedia.js').then(m => m.previewBracket(letter, season)).catch(e => console.error('bracket preview failed:', e.message));
  return { ok: true, rows: (await divisionRows(letter, season, { fresh: true })), changed: changed.length, notified };
}
async function announcePublished(letter, season, plan, meta, cal) {
  const { getAllActiveLeaguePlayers } = await import('./sheets.js');
  const seated = plan.flatMap(p => [p.player_1, p.player_2]).filter(Boolean);
  const rest = (await getAllActiveLeaguePlayers().catch(() => []))
    .filter(p => letterOf(p.division) === letterOf(letter) && String(p.season || season) === String(season) && !seated.some(n => sameName(n, p.name)));
  if (!rest.length) return 0;
  const days = cal ? `${dateText(cal.finalsStart, true)}–${dateText(cal.end, true)}` : '';
  const daysEn = cal ? `${dateText(cal.finalsStart, false)}–${dateText(cal.end, false)}` : '';
  const { queueLeagueNotice } = await import('./notices.js');
  const r = await queueLeagueNotice({ recipients: rest, label: `Плей-офф опубликован: ${meta.title}`,
    ru: `🏆 <b>Регулярка в ${esc(meta.title)} закончена</b>\n\nОпубликована окончательная сетка плей-офф${days ? `, финальные дни — ${days}` : ''}. Пары, итоговая таблица и переходы между дивизионами — на странице таблиц. Спасибо за сезон! 🎾`,
    en: `🏆 <b>The ${esc(meta.title)} regular season is over</b>\n\nThe final playoff bracket is published${daysEn ? `, finals days ${daysEn}` : ''}. Pairs, the final table and division movement are on the tables page. Thanks for the season! 🎾` });
  return r.recipients;
}
async function freezeTablePairs(letter, season, plan) {
  const b = await readTableBracket(letter, season, { fresh: true });
  if (!b) return;
  const cells = [];
  for (const slot of ['SF1', 'SF2']) {
    const r = b.slots[slot], p = plan.find(x => x.slot === slot);
    if (!r || !p) continue;
    for (const [col, name, f] of [['B', p.player_1, r.f1], ['D', p.player_2, r.f2]]) {
      const id = idOfName(b, name);
      if (id && txt(f) !== id) cells.push([`${col}${r.sheetRow}`, Number(id)]);
    }
  }
  await writeTableCells(b, cells);
}
async function setOverrideAll(letter, season, value) {
  const all = await readOverrides();
  delete all[overrideKey(season, letter)];
  if (value && Object.keys(value).length) all[overrideKey(season, letter)] = value;
  await setSetting(OVERRIDES_KEY, JSON.stringify(all), 'Замены в сетке плей-офф до публикации (пишет бот)').catch(() => {});
}

// Замена игрока в уже опубликованной паре (пока матч не сыгран).
export async function replacePlayer(letter, season, slot, side, name, { actor = {}, notify = true } = {}) {
  const rows = await divisionRows(letter, season, { fresh: true });
  const row = rows.find(r => r.slot === slot);
  if (!row) return { ok: false, reason: 'not_found' };
  if (txt(row.status).toLowerCase() === 'confirmed') return { ok: false, reason: 'already_played' };
  if (!txt(name)) return { ok: false, reason: 'no_name' };
  const { seasonRoster } = await import('./division.js');
  const p = (await seasonRoster(season)).players.find(x => letterOf(x.letter) === letterOf(letter) && sameName(x.name, name));
  if (!p) return { ok: false, reason: 'not_in_division' };
  const k = Number(side) === 2 ? 2 : 1;
  const patch = { [`player_${k}`]: p.name, [`player_${k}_group`]: txt(p.group) };
  const merged = { ...row, ...patch };
  merged.status = txt(merged.player_1) && txt(merged.player_2) ? 'scheduled' : 'tbd';
  await writeRow(row, merged);
  const cal = await seasonCalendar();
  const meta = await divisionMeta(letter, season);
  // Одна группа: тот же игрок — и в строку таблицы дивизиона.
  if (!meta.grouped) {
    const b = await readTableBracket(letter, season, { fresh: true }).catch(() => null);
    const r = b?.slots?.[slot], id = idOfName(b, p.name);
    if (r && id) await writeTableCells(b, [[`${k === 1 ? 'B' : 'D'}${r.sheetRow}`, Number(id)]]).catch(e => console.error('playoff table replace failed:', e.message));
  }
  const notified = notify && merged.status === 'scheduled' ? await notifyPairs([merged], { cal, grouped: meta.grouped, title: meta.title }) : 0;
  await logAdmin(`🔁 Плей-офф ${esc(meta.title)}, ${esc(slot)}: ${esc(row[`player_${k}`] || '—')} → <b>${esc(p.name)}</b>`, actor);
  return { ok: true, row: merged, notified };
}

// Время и корт матча финальных дней.
// match_id — назначенный организатором матч этой строки (туда потом ляжет
// счёт); не передан — остаётся прежним.
export async function setSchedule(letter, season, slot, { date = '', time = '', court = '', match_id } = {}) {
  const rows = await divisionRows(letter, season, { fresh: true });
  const row = rows.find(r => r.slot === slot);
  if (!row) return { ok: false, reason: 'not_found' };
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'bad_date' };
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) return { ok: false, reason: 'bad_time' };
  const patch = { date: txt(date) || row.date, time: time ? time.padStart(5, '0') : '', court: txt(court) || row.court || DEFAULT_COURT };
  if (match_id !== undefined) patch.match_id = txt(match_id);
  return { ok: true, row: await writeRow(row, patch) };
}
// Назначенный матч у игроков подтягивается за временем и парой строки
// (assignmatch.js). Подключает index.js; в тестах — пусто.
let assignHook = null;
export function setAssignHook(fn) { assignHook = fn; }
export async function syncAssigned(letter, season, slot) {
  if (!assignHook) return null;
  try { return await assignHook(letterOf(letter), String(season), slot); }
  catch (e) { console.error('playoff assigned sync failed:', e.message); return { status: 'error', reason: e.message }; }
}

// ------------------------------------------------------------ результат
// Какая стадия у матча, если в слоте её нет: пара совпадает с опубликованной
// и не сыгранной парой плей-офф, а матч сыгран после дедлайна регулярки
// (или создан как четвертьфинал). Так счёт четвертьфинала, назначенного
// игроками, не перезапишет их матч регулярки.
export async function detectStage(slot = {}) {
  const own = stageKey(slot.stage) || (/^\d+$/.test(txt(slot.round)) ? '' : stageKey(slot.round));
  if (own) return own;
  const { latestSeason } = await import('./division.js');
  const season = txt(slot.season) || txt(await latestSeason().catch(() => ''));
  const rows = await divisionRows(slot.division, season).catch(() => []);
  if (!rows.length) return '';
  const pair = r => (sameName(r.player_1, slot.from_name) && sameName(r.player_2, slot.to_name)) || (sameName(r.player_1, slot.to_name) && sameName(r.player_2, slot.from_name));
  // Черновик сетки — ещё не пары плей-офф.
  const hit = rows.find(r => pair(r) && txt(r.status).toLowerCase() !== 'draft' && (txt(r.match_id) === txt(slot.challenge_id) || txt(r.status).toLowerCase() !== 'confirmed'));
  if (!hit) return '';
  if (txt(hit.match_id) && txt(hit.match_id) === txt(slot.challenge_id)) return hit.stage;
  const cal = await seasonCalendar().catch(() => null);
  const meta = await divisionMeta(slot.division, season).catch(() => ({ grouped: false }));
  const deadline = cal ? deadlineFor(cal, meta.grouped) : '';
  const { normDate } = await import('./matchesdb.js');
  const played = normDate(slot.agreed_date || '');
  return deadline && played && played > deadline ? hit.stage : '';
}

// Запись результата матча плей-офф в его строку листа Playoff. Счёт в листе —
// со стороны player_1 этой строки. Потом — продвижение по сетке.
export async function recordPlayoffResult(slot = {}, stage, season, letter) {
  const { cellToScore, reverseScore, formatScore } = await import('./tennis.js');
  const rows = await divisionRows(letter, season, { fresh: true });
  const pair = r => (sameName(r.player_1, slot.from_name) && sameName(r.player_2, slot.to_name)) || (sameName(r.player_1, slot.to_name) && sameName(r.player_2, slot.from_name));
  let row = rows.find(r => r.stage === stage && txt(r.match_id) && txt(r.match_id) === txt(slot.challenge_id))
    || rows.find(r => r.stage === stage && pair(r) && txt(r.status).toLowerCase() !== 'confirmed')
    || rows.find(r => r.stage === stage && pair(r));
  // Пары нет, сетка не опубликована: счёт встаёт в строку черновика с одним из
  // игроков (а не отдельной строкой рядом с черновиком). Имена в ней — реальная
  // пара, поэтому бот её больше не перепишет.
  let fromDraft = false;
  if (!row && !rows.some(r => txt(r.published_at))) {
    const share = r => [r.player_1, r.player_2].some(n => txt(n) && (sameName(n, slot.from_name) || sameName(n, slot.to_name)));
    row = rows.find(r => r.stage === stage && txt(r.status).toLowerCase() !== 'confirmed' && share(r)) || null;
    fromDraft = Boolean(row);
  }
  const fromFirst = row && !fromDraft ? sameName(row.player_1, slot.from_name) : true;
  const winnerName = !slot.result_winner ? '' : String(slot.result_winner) === String(slot.from_telegram_id) ? txt(slot.from_name) : txt(slot.to_name);
  const kind = txt(slot.result_kind || 'played').toLowerCase();
  let score = txt(slot.result_score);
  if (kind !== 'technical') { const p = cellToScore(score); score = formatScore(fromFirst ? p : reverseScore(p)) + (/\bRET\b/i.test(score) ? ' RET' : ''); }
  else if (!fromFirst) score = score === 'W/L' ? 'L/W' : score === 'L/W' ? 'W/L' : score;
  const pts = [slot.result_points_from, slot.result_points_to].map(v => (v === '' || v == null) ? '' : String(v));
  const patch = {
    match_id: txt(slot.challenge_id), result_kind: kind, score, winner: winnerName,
    player_1_points: fromFirst ? pts[0] : pts[1], player_2_points: fromFirst ? pts[1] : pts[0],
    comment: txt(slot.result_note) || (row ? row.comment : ''), status: 'confirmed', date: txt(slot.agreed_date) || (row ? row.date : '')
  };
  if (fromDraft) Object.assign(patch, { player_1: txt(slot.from_name), player_2: txt(slot.to_name), player_1_group: '', player_2_group: '', seed_1: '', seed_2: '' });
  if (!row) {
    // Пары в сетке нет (матч внесён руками до публикации) — отдельной строкой.
    const slotName = stage === 'Final' || stage === '3rd' ? stage : stage + (rows.filter(r => r.stage === stage).length + 1);
    row = { season: String(season), division: letterOf(letter), stage, slot: slotName, player_1: txt(slot.from_name), player_2: txt(slot.to_name) };
  }
  const saved = await writeRow(row, patch);
  const advanced = await advanceBracket(letter, season).catch(e => { console.error('playoff advance failed:', e.message); return []; });
  return { status: 'saved', playoff: true, stage, slot: saved.slot, row: row._row || 0, sheet: SHEET, division: letterOf(letter), advanced };
}
// Продвижение по сетке: победители и проигравшие встают в следующие матчи.
export async function advanceBracket(letter, season) {
  const meta = await divisionMeta(letter, season);
  const rows = await divisionRows(letter, season, { fresh: true });
  const patches = advancePatches(rows, meta.grouped);
  for (const p of patches) {
    const row = rows.find(r => r.slot === p.slot);
    if (row) await writeRow(row, p.patch);
  }
  // В матч встали победители (или пара поменялась после правки счёта) — если
  // время уже стоит, игрокам назначается матч.
  for (const p of patches) await syncAssigned(letter, season, p.slot);
  // Финал сыгран — чемпион. Организатору — короткая сводка.
  const final = (await divisionRows(letter, season, { fresh: true })).find(r => r.slot === 'Final');
  const o = outcomeOf(final);
  if (o) {
    const key = `playoff_champion_${season}_${letterOf(letter)}`;
    if (txt(await getSetting(key).catch(() => '')) !== o.W) {
      await setSetting(key, o.W, 'Чемпион дивизиона (пишет бот)').catch(() => {});
      await logAdmin(`🏆 <b>Чемпион ${esc(meta.title)}: ${esc(o.W)}</b>\nФинал: ${esc(final.player_1)} — ${esc(final.player_2)} ${esc(final.score)}`);
    }
  }
  return patches;
}

// Ввод счёта организатором живёт в index.js (там весь путь подтверждённого
// результата: запись, карточка, сообщения). Команда бота зовёт его отсюда.
let adminResultHandler = null;
export function setAdminResultHandler(fn) { adminResultHandler = fn; }
export async function adminResult(letter, season, body, viewer) {
  if (!adminResultHandler) return { ok: false, reason: 'сервер ещё запускается' };
  return adminResultHandler(letter, season, body, viewer);
}

// ------------------------------------------------------------ соперник по четвертьфиналу
// Для списка соперников: опубликованный и не сыгранный четвертьфинал игрока.
export async function playoffOpponentsFor(name, season) {
  if (!txt(name)) return [];
  const rows = (await readPlayoff().catch(() => [])).filter(r => txt(r.season) === String(season) && r.stage === 'QF' && txt(r.status).toLowerCase() === 'scheduled');
  return rows.flatMap(r => sameName(r.player_1, name) ? [{ name: r.player_2, group: r.player_2_group, mine: r.player_1_group, stage: 'QF', slot: r.slot, division: letterOf(r.division) }]
    : sameName(r.player_2, name) ? [{ name: r.player_1, group: r.player_1_group, mine: r.player_2_group, stage: 'QF', slot: r.slot, division: letterOf(r.division) }] : []);
}

// ------------------------------------------------------------ сообщения
async function logAdmin(text) {
  try {
    const { sendMessage } = await import('./telegram.js');
    const to = ADMIN_IDS[0] || txt(await (await import('./admin.js')).getAdminChatId().catch(() => ''));
    if (to) await sendMessage(to, text);
  } catch (e) { console.error('playoff admin note failed:', e.message); }
}
async function notifyPairs(rows, { cal, grouped, title }) {
  const people = await peopleIndex();
  const { sendMessage } = await import('./telegram.js');
  let sent = 0;
  for (const r of rows) {
    for (const [me, opp, mySeed, oppSeed] of [[r.player_1, r.player_2, r.seed_1, r.seed_2], [r.player_2, r.player_1, r.seed_2, r.seed_1]]) {
      const p = people.find(x => sameName(x.name, me));
      if (!p?.telegram_id) continue;
      const o = people.find(x => sameName(x.name, opp));
      const ru = /^ru/i.test(p.language);
      const days = cal ? `${dateText(cal.finalsStart, ru)}–${dateText(cal.end, ru)}` : '';
      const qfBy = cal ? dateText(addDays(cal.finalsStart, -1), ru) : '';
      let text, markup;
      if (r.stage === 'QF') {
        text = ru
          ? `🏆 <b>Ты в плей-офф!</b>\n\n${esc(title)}, четвертьфинал: соперник — <b>${esc(opp)}</b>${oppSeed ? ` (${esc(seedText(oppSeed, true))})` : ''}.\n\nДоговоритесь о матче и сыграйте его до ${qfBy} включительно — так же, как обычный матч, через «Мои матчи». Формат: 2 сета и супертай-брейк.\nПолуфиналы и финалы — ${days}, ${DEFAULT_COURT}.`
          : `🏆 <b>You're in the playoffs!</b>\n\n${esc(title)}, quarterfinal: your opponent is <b>${esc(opp)}</b>${oppSeed ? ` (${esc(seedText(oppSeed, false))})` : ''}.\n\nArrange the match and play it by ${qfBy} — just like a regular match, through "My matches". Format: 2 sets and a super tie-break.\nSemifinals and finals: ${days}, ${DEFAULT_COURT}.`;
        if (o?.telegram_id && PUBLIC_URL) markup = { inline_keyboard: [[{ text: ru ? '🎾 Назначить матч' : '🎾 Arrange the match', web_app: { url: `${PUBLIC_URL}/match?opponent=${encodeURIComponent(o.telegram_id)}` } }]] };
      } else {
        text = ru
          ? `🏆 <b>Ты в плей-офф!</b>\n\n${esc(title)}, ${esc(stageTitle(r.stage, true).toLowerCase())}: соперник — <b>${esc(opp)}</b>.\n\nПолуфиналы и финалы пройдут ${days} на ${DEFAULT_COURT}. Время матча пришлём отдельно.`
          : `🏆 <b>You're in the playoffs!</b>\n\n${esc(title)}, ${esc(stageTitle(r.stage, false).toLowerCase())}: your opponent is <b>${esc(opp)}</b>.\n\nSemifinals and finals take place ${days} at ${DEFAULT_COURT}. We'll send your match time separately.`;
      }
      try { await sendMessage(p.telegram_id, text, markup ? { reply_markup: markup } : {}); sent++; }
      catch (e) { console.error('playoff notify failed:', e.message); }
      await new Promise(res => setTimeout(res, 60));
    }
  }
  return sent;
}
export function seedText(seed, ru) {
  const m = txt(seed).match(/^(\d+)·(.+)$/);
  if (m) return ru ? `${m[1]}-е место, группа ${m[2]}` : `#${m[1]}, group ${m[2]}`;
  const k = txt(seed).match(/^#(\d+)$/);
  return k ? (ru ? `${k[1]}-е место` : `#${k[1]}`) : txt(seed);
}

// ------------------------------------------------------------ афиша дня
export async function dayMatches(date, season = '') {
  const cal = await seasonCalendar().catch(() => null);
  const s = txt(season) || txt(cal?.season);
  const rows = (await readPlayoff({ fresh: true })).filter(r => txt(r.season) === s && txt(r.date) === date && r.stage !== 'QF');
  const groupedOf = new Map();
  const out = [];
  for (const r of rows) {
    const L = letterOf(r.division);
    if (!groupedOf.has(L)) groupedOf.set(L, (await divisionMeta(L, s)).grouped);
    const g = groupedOf.get(L);
    out.push({ ...r, time: txt(r.time), divisionLabel: L === 'PRIME' ? 'PRIME' : L,
      p1: txt(r.player_1) || placeholderOf(r.slot, 0, g), p2: txt(r.player_2) || placeholderOf(r.slot, 1, g) });
  }
  return out.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || (ORDER[a.slot] || 9) - (ORDER[b.slot] || 9));
}
export function posterCaption(date, matches, venue = DEFAULT_COURT) {
  const d = new Date(`${date}T12:00:00+07:00`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Bangkok' });
  const lines = matches.map(m => `${m.time || 'TBA'} · Division ${m.divisionLabel} · ${stageTitle(m.stage, false)} — ${m.p1} vs ${m.p2}`);
  return `🏆 <b>PTF Playoffs — ${esc(day)}</b>\n📍 ${esc(venue)}\n\n${lines.map(esc).join('\n')}\n\nCome and support the players! 🎾`;
}
const posterStore = new Map();   // ключ → { date, fileId, caption, at }
// Предпросмотр афиши — в админский чат файлом (без пережатия) с кнопкой
// «Разослать всем». Никому больше не уходит.
export async function previewPoster(date, chatId = '') {
  const matches = await dayMatches(date);
  if (!matches.length) return { ok: false, reason: 'no_matches' };
  const { renderPlayoffSchedule } = await import('./matchcard.js');
  const png = await renderPlayoffSchedule({ date, venue: DEFAULT_COURT, matches: matches.map(m => ({ time: m.time, division: m.divisionLabel, stage: m.stage, p1: m.p1, p2: m.p2 })) });
  const caption = posterCaption(date, matches);
  const { getSegmentContacts } = await import('./sheets.js');
  const count = (await getSegmentContacts('all').catch(() => [])).length;
  const key = Math.random().toString(36).slice(2, 10);
  const to = txt(chatId) || await (await import('./playoffmedia.js')).adminChat();
  const missing = matches.filter(m => !m.time).length;
  const { sendDocumentBuffer } = await import('./telegram.js');
  await sendDocumentBuffer(to, png, `playoff-day-${date}.png`, { caption: caption + (missing ? `\n\n⚠️ Без времени: ${missing}` : '') + '\n\nНикому не отправлено.', parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: `📣 Разослать всем (${count})`, callback_data: 'po_send:' + key }]] } });
  posterStore.set(key, { date, buffer: png, caption, at: Date.now(), matches });
  posterStore.set('last:' + date, posterStore.get(key));
  return { ok: true, key, count, matches: matches.length, missing_time: missing };
}
// Рассылка афиши: лента + все в боте, и каждому игроку дня — личное сообщение
// с его временем. Повторно по той же кнопке не уходит.
export async function sendPoster(keyOrDate, admin = {}) {
  const job = posterStore.get(keyOrDate) || posterStore.get('last:' + keyOrDate);
  if (!job?.buffer) return { ok: false, reason: 'no_preview' };
  if (job.sent) return { ok: false, reason: 'already_sent' };
  job.sent = true;
  const { publishImage } = await import('./playoffmedia.js');
  const q = await publishImage(job.buffer, { caption: job.caption, caption_ru: job.caption, label: 'schedule' });
  const personal = await notifyDayPlayers(job.matches || []).catch(e => { console.error('playoff day notices failed:', e.message); return 0; });
  return { ok: true, recipients: q.recipients, personal };
}
async function notifyDayPlayers(matches) {
  const people = await peopleIndex();
  const { sendMessage } = await import('./telegram.js');
  let sent = 0;
  for (const m of matches) {
    for (const [me, opp] of [[m.player_1, m.player_2], [m.player_2, m.player_1]]) {
      if (!txt(me)) continue;
      const p = people.find(x => sameName(x.name, me));
      if (!p?.telegram_id) continue;
      const ru = /^ru/i.test(p.language);
      const when = `${dateText(m.date, ru)}${m.time ? (ru ? ', ' : ', ') + m.time : ''}`;
      const text = ru
        ? `🏆 <b>Твой матч плей-офф</b>\n\n${esc(stageTitle(m.stage, true))}, Division ${esc(m.divisionLabel)}\n📅 ${esc(when)}\n📍 ${esc(m.court || DEFAULT_COURT)}\nСоперник: <b>${esc(txt(opp) || (ru ? 'определится по результатам полуфиналов' : ''))}</b>\n\nУдачи! 🎾`
        : `🏆 <b>Your playoff match</b>\n\n${esc(stageTitle(m.stage, false))}, Division ${esc(m.divisionLabel)}\n📅 ${esc(when)}\n📍 ${esc(m.court || DEFAULT_COURT)}\nOpponent: <b>${esc(txt(opp) || 'decided by the semifinals')}</b>\n\nGood luck! 🎾`;
      await sendMessage(p.telegram_id, text).then(() => sent++).catch(() => {});
      await new Promise(res => setTimeout(res, 60));
    }
  }
  return sent;
}
let posterKindReady = false;
export async function ensurePosterKind() {
  if (posterKindReady) return;
  const { registerBroadcastKind } = await import('./broadcast.js');
  const { sendPhoto } = await import('./telegram.js');
  registerBroadcastKind('playoff_poster', {
    // Подпись — на языке получателя (если есть русская).
    async make(params) { return async (c) => { await sendPhoto(c.telegram_id, params.fileId, { caption: String(c.language || '').toLowerCase() === 'ru' && params.caption_ru ? params.caption_ru : params.caption }); }; }
  });
  posterKindReady = true;
}

// ------------------------------------------------------------ сетка для сайта
// rows — строки Playoff дивизиона; preview — план до публикации.
export function sitePlayoff({ rows = [], plan = null, grouped = false, portrait = () => '' }) {
  const src = rows.length ? orderRows(rows) : (plan || []);
  if (!src.length) return null;
  const side = name => txt(name) ? { id: txt(name), name: txt(name), photo: portrait(txt(name)) } : null;
  const flip = s => txt(s).replace(/(\d+)\s*:\s*(\d+)/g, (_, a, b) => `${b}:${a}`);
  const make = r => {
    const o = outcomeOf(r);
    // Счёт — со стороны победителя: в листе он со стороны player_1.
    const score = o && sameName(o.W, r.player_2) ? flip(r.score) : txt(r.score);
    return { first: side(r.player_1), second: side(r.player_2), score, winner_id: o ? o.W : '', played: Boolean(o),
      slot: r.slot, stage: r.stage, date: txt(r.date), time: txt(r.time), seed_1: txt(r.seed_1), seed_2: txt(r.seed_2),
      label_1: txt(r.player_1) ? '' : placeholderOf(r.slot, 0, grouped), label_2: txt(r.player_2) ? '' : placeholderOf(r.slot, 1, grouped) };
  };
  const at = slot => { const r = src.find(x => x.slot === slot); return r ? make(r) : null; };
  const qf = ['QF1', 'QF2', 'QF3', 'QF4'].map(at).filter(Boolean);
  const sf1 = at('SF1'), sf2 = at('SF2'), final = at('Final'), third = at('3rd');
  const champion = final && final.played ? side(final.winner_id) : null;
  return { qf, sf: [sf1, sf2].filter(Boolean), sf1, sf2, final, third, champion, preview: !rows.length, published: Boolean(rows.length) };
}
// Предварительная сетка для сайта по уже прочитанным таблицам групп.
// tables: [{ group, players:[{ name, place, photo }] }]. Возвращает null, если
// сетка уже опубликована или ещё рано (не последняя неделя регулярки).
export async function sitePreview(letter, season, tables = [], { now = Date.now() } = {}) {
  const cal = await seasonCalendar(now).catch(() => null);
  if (!cal) return null;
  season = txt(season) || String(cal.season);
  if (String(cal.season) !== String(season)) return null;
  const grouped = tables.length > 1;
  if (!previewWindow(cal, grouped, dayIn(now))) return null;
  if (isPublished(await divisionRows(letter, season).catch(() => []))) return null;
  const standings = tables.map(t => ({ group: String(t.group || ''), rows: (t.players || []).map(p => ({ name: p.name, place: p.place })) }));
  const meta = { grouped, groups: grouped ? tables.map(t => ({ group: t.group })) : [{ group: '' }], title: '' };
  const { plan } = await previewPlan(letter, season, { meta, standings });
  const photos = new Map(tables.flatMap(t => (t.players || []).map(p => [norm(p.name), p.photo || ''])));
  const site = sitePlayoff({ plan, grouped, portrait: n => photos.get(norm(n)) || '' });
  return site ? { ...site, preview: true, published: false, deadline: deadlineFor(cal, grouped) } : null;
}
// Показывать ли предварительную сетку на сайте: за две недели до дедлайна
// регулярки и до публикации — чтобы игроки видели, за что борются.
export const PREVIEW_DAYS = 14;
export function previewWindow(cal, grouped, today = dayIn()) {
  if (!cal) return false;
  const deadline = deadlineFor(cal, grouped);
  return today >= addDays(deadline, -PREVIEW_DAYS) && today <= cal.end;
}

// ------------------------------------------------------------ фоновые напоминания
// Раз в 15 минут из общего прохода. Каждое напоминание — один раз (отметка в Settings).
export async function runPlayoffSweep(now = Date.now()) {
  const cal = await seasonCalendar(now);
  if (!cal || !cal.live) return { ok: false, reason: 'no_live_season' };
  // Черновик C, W в листе Playoff — подтягиваем к текущим таблицам.
  await syncDrafts(cal.season).catch(e => console.error('playoff drafts sync failed:', e.message));
  const today = dayIn(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(new Date(now)));
  const once = async (key, fn) => {
    const k = `playoff_note_${cal.season}_${key}`;
    if (txt(await getSetting(k).catch(() => ''))) return false;
    await setSetting(k, today, 'Отметка напоминания по плей-офф (пишет бот)');
    await fn();
    return true;
  };
  const button = PUBLIC_URL ? { reply_markup: { inline_keyboard: [[{ text: '🏆 Открыть плей-офф', web_app: { url: `${PUBLIC_URL}/match?tab=admin&po=1` } }]] } } : {};
  const say = async text => {
    const { sendMessage } = await import('./telegram.js');
    const to = ADMIN_IDS[0] || txt(await (await import('./admin.js')).getAdminChatId().catch(() => ''));
    if (to) await sendMessage(to, text, button).catch(e => console.error('playoff sweep note:', e.message));
  };
  const types = [['single', cal.regularEnd, 'A, B, Prime'], ['grouped', cal.groupedEnd, 'C, W']];
  for (const [type, deadline, who] of types) {
    // За две недели до дедлайна, в полдень: предварительная сетка уже на сайте.
    if (today === addDays(deadline, -PREVIEW_DAYS) && hour >= 12) await once(`preview_${type}`, () => say(`🏆 <b>До конца регулярки две недели (${who})</b>\n\nНа сайте открыта предварительная сетка плей-офф — она пересчитывается после каждого матча. Дедлайн: ${dateText(deadline, true)}.`));
    // Вечер дня дедлайна: итоговая сетка, несыгранные матчи и кнопка публикации.
    if (today === deadline && hour >= 21) await once(`deadline_${type}`, () => deadlineNote(cal, type, who, now, say));
  }
  // Четвертьфиналы без договорённости — каждый день в 11:00, до дня перед финалами.
  if (hour >= 11 && today <= addDays(cal.finalsStart, -1) && today >= cal.groupedEnd) {
    await once(`qf_${today}`, () => remindQuarterfinals(cal, now));
  }
  return { ok: true };
}
// Итог регулярки организатору: сетка по итоговым таблицам, несыгранные матчи
// и кнопка «Опубликовать» на каждый дивизион. После публикации пары получают
// личные сообщения, остальные игроки дивизиона — объявление.
async function deadlineNote(cal, type, who, now, say) {
  const st = await playoffState(cal.season, now).catch(() => null);
  const list = (st?.divisions || []).filter(d => (type === 'grouped') === d.grouped);
  const blocks = list.map(d => {
    const head = `<b>${esc(d.title)}</b>${d.published ? ' · сетка опубликована' : ''}${d.unplayed.length ? ` · несыгранных матчей: ${d.unplayed.length}` : ''}`;
    const pairs = (d.published ? d.rows : d.preview).filter(m => m.stage === (d.grouped ? 'QF' : 'SF'))
      .map(m => `• ${esc(m.slot)}: ${esc(txt(m.player_1) || '—')} — ${esc(txt(m.player_2) || '—')}`);
    const left = d.unplayed.map(m => `   ⚠️ ${esc(m.p1)} — ${esc(m.p2)}`);
    return [head, ...pairs, ...left].join('\n');
  });
  const kb = list.filter(d => !d.published).map(d => [{ text: `✅ Опубликовать: ${d.title}`, callback_data: `po_pub:${d.letter}:${cal.season}` }]);
  if (PUBLIC_URL) kb.push([{ text: '🏆 Открыть плей-офф', web_app: { url: `${PUBLIC_URL}/match?tab=admin&po=1` } }]);
  const { sendMessage } = await import('./telegram.js');
  const to = ADMIN_IDS[0] || txt(await (await import('./admin.js')).getAdminChatId().catch(() => ''));
  const text = `⏰ <b>Регулярка закрыта (${who})</b>\n\nИтоговая сетка по таблицам:\n\n${blocks.join('\n\n')}\n\n`
    + (list.some(d => d.unplayed.length) ? 'Сначала решите несыгранные матчи (W/O одному или «не засчитывать») в разделе «Плей-офф» — сетка пересчитается. ' : '')
    + 'Публикация: пары получат личные сообщения, остальные игроки дивизиона — объявление.';
  if (to) await sendMessage(to, text, { reply_markup: { inline_keyboard: kb } }).catch(e => console.error('playoff deadline note:', e.message));
}
async function remindQuarterfinals(cal, now) {
  const rows = (await readPlayoff({ fresh: true })).filter(r => txt(r.season) === String(cal.season) && r.stage === 'QF' && txt(r.status).toLowerCase() === 'scheduled');
  if (!rows.length) return;
  const { allSlots } = await import('./matchesdb.js');
  const slots = await allSlots().catch(() => []);
  const people = await peopleIndex();
  const { sendMessage } = await import('./telegram.js');
  const pending = [];
  for (const r of rows) {
    const agreed = slots.some(s => txt(s.status).toLowerCase() === 'accepted' && !['confirmed'].includes(txt(s.result_status).toLowerCase())
      && ((sameName(s.from_name, r.player_1) && sameName(s.to_name, r.player_2)) || (sameName(s.from_name, r.player_2) && sameName(s.to_name, r.player_1))));
    if (agreed) continue;
    pending.push(r);
    for (const [me, opp] of [[r.player_1, r.player_2], [r.player_2, r.player_1]]) {
      const p = people.find(x => sameName(x.name, me)), o = people.find(x => sameName(x.name, opp));
      if (!p?.telegram_id) continue;
      const ru = /^ru/i.test(p.language), by = dateText(addDays(cal.finalsStart, -1), ru);
      const markup = o?.telegram_id && PUBLIC_URL ? { reply_markup: { inline_keyboard: [[{ text: ru ? '🎾 Назначить матч' : '🎾 Arrange the match', web_app: { url: `${PUBLIC_URL}/match?opponent=${encodeURIComponent(o.telegram_id)}` } }]] } } : {};
      await sendMessage(p.telegram_id, ru
        ? `🏆 Напоминание: четвертьфинал с <b>${esc(opp)}</b> ещё не назначен. Его нужно сыграть до ${by} включительно.`
        : `🏆 Reminder: your quarterfinal with <b>${esc(opp)}</b> isn't scheduled yet. It needs to be played by ${by}.`, markup).catch(() => {});
    }
  }
  if (pending.length) await logAdmin(`🏆 Четвертьфиналы без договорённости: ${pending.map(r => `${esc(letterOf(r.division))} ${esc(r.slot)} (${esc(r.player_1)} — ${esc(r.player_2)})`).join('; ')}. Игрокам напомнил.`);
}

// ------------------------------------------------------------ сводка для /playoff
export function stateSummary(st) {
  const lines = [`🏆 <b>Плей-офф · сезон ${esc(st.season)}</b>`];
  for (const d of st.divisions) {
    lines.push('', `<b>${esc(d.title)}</b> · дедлайн ${d.deadline ? dateText(d.deadline, true) : '—'} · ${d.published ? 'опубликована' : `черновик (${d.grouped ? 'лист Playoff' : 'таблица дивизиона'})`}${d.unplayed.length ? ` · несыгранных: ${d.unplayed.length}` : ''}`);
    const list = d.published ? d.rows : d.preview;
    for (const m of list) {
      if (!txt(m.player_1) && !txt(m.player_2) && !d.published) continue;
      const a = txt(m.player_1) || placeholderOf(m.slot, 0, d.grouped), b = txt(m.player_2) || placeholderOf(m.slot, 1, d.grouped);
      const res = txt(m.status).toLowerCase() === 'confirmed' ? ` — <b>${esc(m.winner)}</b> ${esc(m.score)}` : (m.time ? ` · ${esc(m.date)} ${esc(m.time)}` : '');
      lines.push(`• ${esc(m.slot)}: ${esc(a)} — ${esc(b)}${res}${m.locked ? ' ✋' : ''}`);
    }
  }
  return lines.join('\n');
}
