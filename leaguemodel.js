// Модель лиги из общего журнала матчей.
//
// Источник правды — общий журнал Cross_Division_Match_Log: туда бот пишет
// КАЖДЫЙ подтверждённый матч (группы, межгрупповые, плей-офф, прошлые сезоны).
// Из него код сам считает то, что раньше собирали формулы таблицы профилей:
// историю матчей игрока, матчи / победы / поражения / процент побед за всё
// время, форму и число сезонов.
//
// Таблица профилей (Frontend_Profile_All, Match_History_All) остаётся:
//   · анкетой — фото, NTRP, страна, опыт, достижения берутся оттуда, как раньше;
//   · резервом — если журнал не прочитался или игрока в журнале нет;
//   · проверкой — раз в сутки бот сравнивает свои цифры с ней.
//
// Переключатель — Settings → league_source: live (журнал) или sheets (как было).
// По умолчанию sheets. Откат — сменить значение, деплой не нужен.
//
// Готовый снимок витрины сохраняется в JSON: файл на Google Диске (если задан
// Settings → league_model_file_id) или лист League_Model в таблице бота.
// После перезапуска сервера страница берёт его сразу, без долгой сборки.
import { Readable } from 'node:stream';
import * as googleApi from './google.js';
// Через пространство имён: в тестах google.js подменяется заглушкой без Диска.
const sheetsClient = () => googleApi.sheets();
const drive = () => googleApi.drive();
import { LEAGUE_RESULTS_SHEET_ID, LEAGUE_RESULTS_SHEETS, SPREADSHEET_ID, GOOGLE_CREDENTIALS, TIMEZONE } from './config.js';
import { parseSeasonNumber } from './util.js';

const txt = v => String(v ?? '').trim();
const up = v => txt(v).toUpperCase();

// ------------------------------------------------------------- переключатель
export const SOURCE_SETTING = 'league_source';
export const FILE_SETTING = 'league_model_file_id';
export function normalizeSource(v = '') { return txt(v).toLowerCase() === 'live' ? 'live' : 'sheets'; }
const sourceMemo = { v: '', t: 0, busy: null };
export async function leagueSource() {
  const { getSetting } = await import('./sheets.js');
  const v = normalizeSource(await getSetting(SOURCE_SETTING).catch(() => ''));
  sourceMemo.v = v; sourceMemo.t = Date.now();
  return v;
}
// Без ожидания: последнее известное значение, а свежее подтягивается в фоне
// (раз в 30 секунд). Открытие страницы не ждёт чтения Settings.
export function peekSource() {
  if ((!sourceMemo.t || Date.now() - sourceMemo.t > 30 * 1000) && !sourceMemo.busy) {
    sourceMemo.busy = leagueSource().catch(() => '').finally(() => { sourceMemo.busy = null; });
  }
  return sourceMemo.v || 'sheets';
}

// ------------------------------------------------------------- журнал
// Дата в журнале — число-сериал таблицы (так её пишет бот) или строка, если
// строку вносили руками. На выходе всегда YYYY-MM-DD.
export function isoDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(txt(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 20000 || n > 80000) return '';
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  }
  const s = txt(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return s;
}

// Колонки журнала: ищем по подписи в шапке, иначе — привычное место (буквы
// те же, что пишет results.js: B дата, D соревнование, E/G id, F/H дивизион,
// I/J имена, K–V счёт, W режим 3-го сета, X Completed?, Y Winner ID,
// AB пометка техрезультата, AN/AO очки техрезультата).
export function logColumns(header = []) {
  const head = header.map(h => txt(h).toLowerCase());
  const at = (labels, fallback) => { for (const l of labels) { const i = head.indexOf(l); if (i >= 0) return i; } return fallback; };
  return {
    no: at(['match #', 'match no', 'match_no', 'match', '#'], 0),
    date: at(['date', 'match date', 'match_date'], 1),
    comp: at(['competition', 'tournament'], 3),
    p1id: at(['p1 id', 'p1_id'], 4), p1div: at(['p1 division', 'p1 div', 'p1_division'], 5),
    p2id: at(['p2 id', 'p2_id'], 6), p2div: at(['p2 division', 'p2 div', 'p2_division'], 7),
    p1: at(['p1 name', 'player 1', 'p1_name'], 8), p2: at(['p2 name', 'player 2', 'p2_name'], 9),
    score: 10, done: at(['completed?', 'completed'], 23), winner: at(['winner id', 'winner_id'], 24),
    mark: 27, pts1: 39, pts2: 40
  };
}

const idOf = v => txt(v).replace(/\.0+$/, '');
const numOrNull = v => (txt(v) === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function setsFromRow(r, c) {
  const sets = [];
  for (let i = 0; i < 3; i++) {
    const a = numOrNull(r[c.score + i * 4]), b = numOrNull(r[c.score + i * 4 + 1]);
    if (a === null || b === null) continue;
    sets.push({ a, b, tba: numOrNull(r[c.score + i * 4 + 2]), tbb: numOrNull(r[c.score + i * 4 + 3]) });
  }
  return sets;
}

// Счёт глазами игрока: «6:4 / 7:6 (7:3) / TB 10:8», как в сетке дивизиона.
export function scoreText(sets = [], { flip = false, retired = false } = {}) {
  const out = sets.map((s, i) => {
    const a = flip ? s.b : s.a, b = flip ? s.a : s.b;
    const ta = flip ? s.tbb : s.tba, tb = flip ? s.tba : s.tbb;
    if (i === 2 && (a >= 10 || b >= 10)) return `TB ${a}:${b}`;
    return `${a}:${b}` + (ta !== null && tb !== null && ta !== undefined && tb !== undefined ? ` (${ta}:${tb})` : '');
  }).join(' / ');
  return retired && out ? `${out} RET` : out;
}

// Строки журнала → список матчей. Несыгранные и пустые строки пропускаются.
export function normalizeLog(values = []) {
  if (!values.length) return { matches: [], skipped: 0, header: [] };
  const c = logColumns(values[0] || []);
  const matches = [];
  let skipped = 0;
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const n1 = txt(r[c.p1]), n2 = txt(r[c.p2]);
    if (!n1 || !n2) continue;
    const sets = setsFromRow(r, c);
    const mark = up(r[c.mark]);
    const done = /^yes$/i.test(txt(r[c.done]));
    const p1id = idOf(r[c.p1id]), p2id = idOf(r[c.p2id]);
    let kind = 'played', winner = '';
    if (mark === 'W/L' || mark === 'L/W' || mark === 'L/L') {
      kind = mark === 'L/L' ? 'double' : 'technical';
      winner = mark === 'W/L' ? 'p1' : mark === 'L/W' ? 'p2' : '';
    } else {
      if (mark === 'RET') kind = 'retired';
      const w = idOf(r[c.winner]);
      if (w && p1id && w === p1id) winner = 'p1';
      else if (w && p2id && w === p2id) winner = 'p2';
      if (!winner && sets.length) {
        let a = 0, b = 0;
        for (const s of sets) { if (s.a > s.b) a++; else if (s.b > s.a) b++; }
        if (a !== b && (done || Math.max(a, b) >= 2)) winner = a > b ? 'p1' : 'p2';
      }
      if (!winner) {
        // Техрезультат старого образца: счёта нет, победитель — у кого больше очков.
        const x = numOrNull(r[c.pts1]), y = numOrNull(r[c.pts2]);
        if (x !== null && y !== null && x !== y && (!sets.length || kind === 'retired')) {
          winner = x > y ? 'p1' : 'p2';
          if (!sets.length) kind = 'technical';
        }
      }
      if (!winner) { skipped++; continue; }
    }
    matches.push({
      row: i + 1,
      no: txt(r[c.no]) || String(i),
      date: isoDate(r[c.date]),
      competition: txt(r[c.comp]),
      season: parseSeasonNumber(r[c.comp]),
      kind, winner, sets,
      p1: { name: n1, id: p1id, division: txt(r[c.p1div]) },
      p2: { name: n2, id: p2id, division: txt(r[c.p2div]) }
    });
  }
  // Пустая подпись сезона: берём сезон соседних строк — журнал идёт по порядку.
  let last = '';
  for (const m of matches) { if (m.season) last = m.season; else if (last) m.season = last; }
  let next = '';
  for (let i = matches.length - 1; i >= 0; i--) { if (matches[i].season) next = matches[i].season; else if (next) matches[i].season = next; }
  return { matches, skipped, header: values[0] || [] };
}

export async function readCentralLog() {
  if (!LEAGUE_RESULTS_SHEET_ID) throw new Error('LEAGUE_RESULTS_SHEET_ID не задан');
  const res = await sheetsClient().spreadsheets.values.get({
    spreadsheetId: LEAGUE_RESULTS_SHEET_ID, range: `${LEAGUE_RESULTS_SHEETS.log}!A1:AO`,
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  return normalizeLog(res?.data?.values || []);
}

// ------------------------------------------------------------- модель
// Имя в журнале → id игрока в таблице профилей. Сначала по имени (терпимо),
// потом по совпадению id: в журнал пишется id из Players_Master.
function resolver(profiles = [], sameName) {
  const memo = new Map();
  return (name, id) => {
    const key = txt(name).toLowerCase() + '|' + txt(id);
    if (memo.has(key)) return memo.get(key);
    let hit = profiles.find(p => sameName(p.name, name));
    if (!hit && id) hit = profiles.find(p => txt(p.id) === txt(id));
    const out = hit ? { id: txt(hit.id), name: hit.name } : null;
    memo.set(key, out);
    return out;
  };
}

export function buildModel(matches = [], profiles = [], { sameName = (a, b) => txt(a).toLowerCase() === txt(b).toLowerCase() } = {}) {
  const who = resolver(profiles, sameName);
  const byPlayer = new Map();
  const unmatched = new Map();
  const seasons = new Set();
  for (const m of matches) {
    if (m.season) seasons.add(String(m.season));
    const sides = [['p1', 'p2'], ['p2', 'p1']];
    for (const [me, op] of sides) {
      const self = who(m[me].name, m[me].id);
      if (!self) { unmatched.set(m[me].name, (unmatched.get(m[me].name) || 0) + 1); continue; }
      const opp = who(m[op].name, m[op].id);
      const won = m.winner === me;
      const item = {
        match_no: m.no,
        date: m.date,
        competition: m.competition,
        opponent_id: opp ? opp.id : '',
        opponent: opp ? opp.name : m[op].name,
        opponent_photo: '',
        opponent_division: m[op].division,
        division: m[me].division,
        season: String(m.season || ''),
        result: won ? 'WIN' : 'LOST',
        score: m.kind === 'technical' || m.kind === 'double' ? 'W/O' : scoreText(m.sets, { flip: me === 'p2', retired: m.kind === 'retired' }),
        source: 'log',
        _k: m.row
      };
      if (!byPlayer.has(self.id)) byPlayer.set(self.id, []);
      byPlayer.get(self.id).push(item);
    }
  }
  return { byPlayer, seasons, unmatched: [...unmatched.entries()].map(([name, count]) => ({ name, count })) };
}

const seasonNo = m => Number(m.season || 0) || 0;
// Хронология: сезон, потом порядок строк журнала (или номер матча из таблицы).
function chrono(list = []) {
  return [...list].sort((a, b) => seasonNo(a) - seasonNo(b) || (Number(a._k) || 0) - (Number(b._k) || 0));
}
export function statsOf(list = []) {
  const ordered = chrono(list);
  const wins = ordered.filter(m => m.result === 'WIN').length;
  const matches = ordered.length;
  return {
    matches, wins, losses: matches - wins,
    win_rate: matches ? String(Math.round(wins / matches * 100)) : '',
    form: ordered.slice(-5).map(m => (m.result === 'WIN' ? 'W' : 'L')),
    seasons: new Set(ordered.map(m => String(m.season || '')).filter(Boolean)).size
  };
}

// Модель поверх таблицы профилей. Сезоны, которых в журнале нет совсем,
// берутся из истории таблицы (на случай, если старый сезон туда не попал).
// Игрок, которого журнал не узнал, остаётся целиком на таблице — так ничего
// не пропадает, а расхождение покажет сверка.
export function applyModel(profiles = [], sheetHistory = new Map(), model = { byPlayer: new Map(), seasons: new Set() }) {
  const history = new Map();
  const fallback = [];
  let fromLog = 0;
  const players = profiles.map(p => {
    const id = txt(p.id);
    const mine = model.byPlayer.get(id) || [];
    const sheet = (sheetHistory.get(id) || []).map(m => ({ ...m, _k: Number(m.match_no) || 0 }));
    const sheetInLogSeasons = sheet.filter(m => model.seasons.has(String(m.season || '')));
    if (!mine.length && sheetInLogSeasons.length) {
      fallback.push(p.name);
      if (sheet.length) history.set(id, sheet.map(({ _k, ...m }) => m));
      return p;
    }
    const merged = [...mine, ...sheet.filter(m => !model.seasons.has(String(m.season || '')))];
    if (!merged.length) return p;
    fromLog++;
    history.set(id, chrono(merged).reverse().map(({ _k, ...m }) => m));
    return { ...p, ...statsOf(merged), model: true };
  });
  return { players, history, fallback, fromLog };
}

// Сверка: таблица профилей против журнала.
export function diffModel(profiles = [], sheetHistory = new Map(), applied = { players: [], history: new Map() }) {
  const out = [];
  const byId = new Map(applied.players.map(p => [txt(p.id), p]));
  for (const p of profiles) {
    const id = txt(p.id);
    const live = byId.get(id) || p;
    const sheetProfile = Number(p.matches) || 0;
    const sheetHist = (sheetHistory.get(id) || []).length;
    const model = live.model ? Number(live.matches) || 0 : null;
    if (model === null) {
      if (sheetProfile || sheetHist) out.push({ name: p.name, sheetProfile, sheetHist, model: null });
      continue;
    }
    if (model !== sheetProfile || model !== sheetHist) out.push({ name: p.name, sheetProfile, sheetHist, model });
  }
  return out.sort((a, b) => Math.abs((b.model ?? 0) - b.sheetHist) - Math.abs((a.model ?? 0) - a.sheetHist) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- сборка
const state = {
  build: null,          // последняя сборка: когда, сколько длилась, что получилось
  error: '',
  store: { kind: '', at: '', bytes: 0, error: '', hash: '' },
  loaded: null,         // откуда и когда взят сохранённый снимок при старте
  boots: []             // время последних открытий страницы, мс
};

export async function buildLiveLeague(profiles = [], sheetHistory = new Map()) {
  const started = Date.now();
  try {
    const { sameName } = await import('./sheets.js');
    const log = await readCentralLog();
    const model = buildModel(log.matches, profiles, { sameName });
    const applied = applyModel(profiles, sheetHistory, model);
    state.build = {
      at: new Date().toISOString(), ms: Date.now() - started,
      rows: log.matches.length, skipped: log.skipped,
      seasons: [...model.seasons].sort(), players: applied.fromLog,
      fallback: applied.fallback, unmatched: model.unmatched
    };
    state.error = '';
    console.log(`league model: журнал ${log.matches.length} матчей, игроков из журнала ${applied.fromLog}, на таблице ${applied.fallback.length}, не узнаны ${model.unmatched.length}, ${state.build.ms} мс`);
    return { ...applied, model, log };
  } catch (e) {
    state.error = e.message;
    throw e;
  }
}

// ------------------------------------------------------------- хранение
const STORE_SHEET = 'League_Model';
const CHUNK = 40000;   // в ячейке Google не больше 50 000 символов
export function chunkText(text = '', size = CHUNK) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}
function hashOf(text = '') {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + text.length;
}
async function fileIdSetting() {
  const { getSetting } = await import('./sheets.js');
  return txt(await getSetting(FILE_SETTING).catch(() => ''));
}
export function botEmail() {
  try { return JSON.parse(GOOGLE_CREDENTIALS || '{}').client_email || ''; } catch { return ''; }
}

async function writeSheet(text) {
  const { ensureExtraSheet } = await import('./sheets.js');
  await ensureExtraSheet(STORE_SHEET, ['league_model']);
  const parts = chunkText(text);
  await sheetsClient().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${STORE_SHEET}!A1:C${parts.length + 1}`, valueInputOption: 'RAW',
    requestBody: { values: [['league_model', parts.length, new Date().toISOString()], ...parts.map(p => [p, '', ''])] }
  });
}
async function readSheet() {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${STORE_SHEET}!A1:B` });
  const values = res?.data?.values || [];
  const count = Number(values?.[0]?.[1] || 0);
  if (!count) return '';
  return values.slice(1, count + 1).map(r => String(r?.[0] ?? '')).join('');
}
async function writeDrive(fileId, text) {
  await drive().files.update({
    fileId, supportsAllDrives: true,
    media: { mimeType: 'application/json', body: Readable.from(Buffer.from(text)) }
  });
}
async function readDrive(fileId) {
  const res = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

let lastWriteAt = 0;
export async function storeSnapshot(snapshot, { force = false } = {}) {
  if (!snapshot) return { ok: false, reason: 'empty' };
  const body = JSON.stringify(snapshot);
  const hash = hashOf(body);
  if (!force && hash === state.store.hash) return { ok: true, unchanged: true };
  if (!force && Date.now() - lastWriteAt < 60 * 1000) return { ok: false, reason: 'too_soon' };
  lastWriteAt = Date.now();
  const text = JSON.stringify({ version: 1, saved_at: new Date().toISOString(), snapshot });
  const fileId = await fileIdSetting();
  let kind = '', error = '';
  if (fileId) {
    try { await writeDrive(fileId, text); kind = 'drive'; }
    catch (e) { error = `Диск: ${e.message}`; }
  }
  if (!kind) {
    try { await writeSheet(text); kind = 'sheet'; }
    catch (e) { error = (error ? error + '; ' : '') + `лист: ${e.message}`; }
  }
  state.store = { kind, at: new Date().toISOString(), bytes: text.length, error, hash: kind ? hash : state.store.hash };
  if (!kind) console.error('league model store failed:', error);
  return { ok: Boolean(kind), kind, error };
}

export function parseStored(text = '') {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const s = j?.snapshot;
    if (!s || !Array.isArray(s.players) || !s.matches) return null;
    return { snapshot: s, saved_at: j.saved_at || '' };
  } catch { return null; }
}
export async function loadStoredSnapshot() {
  const fileId = await fileIdSetting();
  const started = Date.now();
  let got = null, from = '';
  if (fileId) { got = parseStored(await readDrive(fileId).catch(() => '')); from = 'drive'; }
  if (!got) { got = parseStored(await readSheet().catch(() => '')); from = 'sheet'; }
  if (!got) return null;
  state.loaded = { from, saved_at: got.saved_at, ms: Date.now() - started, at: new Date().toISOString() };
  state.store.hash = hashOf(JSON.stringify(got.snapshot));
  console.log(`league model: снимок взят из ${from === 'drive' ? 'файла на Диске' : 'листа League_Model'} (сохранён ${got.saved_at}), ${state.loaded.ms} мс`);
  return got.snapshot;
}

// ------------------------------------------------------------- скорость и статус
export function noteBootstrap(ms, source = '') {
  state.boots.push({ ms: Math.round(ms), source, at: Date.now() });
  if (state.boots.length > 200) state.boots.shift();
}
function bootStats(source) {
  const day = Date.now() - 24 * 3600 * 1000;
  const list = state.boots.filter(b => b.at >= day && (!source || b.source === source)).map(b => b.ms).sort((a, b) => a - b);
  if (!list.length) return null;
  return { count: list.length, median: list[Math.floor(list.length / 2)], max: list[list.length - 1] };
}

let rebuildHandler = null;
export function setRebuildHandler(fn) { rebuildHandler = fn; }
export async function rebuildNow() {
  if (!rebuildHandler) throw new Error('пересборка недоступна');
  return rebuildHandler();
}

const fmtTime = iso => {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('ru-RU', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
  catch { return iso; }
};
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function statusText() {
  const source = await leagueSource().catch(() => 'sheets');
  const fileId = await fileIdSetting();
  const b = state.build;
  const lines = [
    '🧮 <b>Модель лиги</b>',
    `Источник сейчас: <b>${source === 'live' ? 'live — журнал матчей' : 'sheets — таблица профилей'}</b> (Settings → <code>${SOURCE_SETTING}</code>)`
  ];
  if (b) {
    lines.push(`Последняя сборка: ${fmtTime(b.at)}, ${b.ms} мс`);
    lines.push(`В журнале матчей: ${b.rows} (пропущено несыгранных строк: ${b.skipped}), сезоны: ${b.seasons.join(', ') || '—'}`);
    lines.push(`Игроков из журнала: ${b.players}; на таблице (журнал их не узнал): ${b.fallback.length}`);
    if (b.unmatched.length) lines.push(`Имена из журнала без профиля: ${b.unmatched.slice(0, 8).map(u => esc(u.name)).join(', ')}${b.unmatched.length > 8 ? ' …' : ''}`);
  } else lines.push(source === 'live' ? 'Сборки ещё не было.' : 'Журнал не используется, пока источник — sheets.');
  if (state.error) lines.push(`⚠️ Ошибка сборки: ${esc(state.error)}`);
  const st = state.store;
  lines.push(`Хранение: ${fileId ? 'файл на Диске' + (st.kind === 'sheet' ? ' (не записался — запасной лист League_Model)' : '') : 'лист League_Model в таблице бота'}${st.at ? `, записан ${fmtTime(st.at)}, ${Math.round(st.bytes / 1024)} КБ` : ''}`);
  if (st.error) lines.push(`⚠️ ${esc(st.error)}`);
  if (state.loaded) lines.push(`При старте снимок взят из ${state.loaded.from === 'drive' ? 'файла' : 'листа'} за ${state.loaded.ms} мс`);
  for (const [label, src] of [['live', 'live'], ['sheets', 'sheets']]) {
    const s = bootStats(src);
    if (s) lines.push(`Открытия страницы (${label}, сутки): ${s.count}, обычно ${s.median} мс, самое долгое ${s.max} мс`);
  }
  if (!fileId) lines.push(`\nЧтобы хранить в файле: загрузите на Диск файл <code>ptf-league-model.json</code>, дайте доступ редактора <code>${esc(botEmail())}</code> и впишите id файла в Settings → <code>${FILE_SETTING}</code>.`);
  lines.push('\n<code>/league_model rebuild</code> — пересобрать сейчас\n<code>/league_model diff</code> — сверка с таблицей профилей');
  return lines.join('\n');
}

// ------------------------------------------------------------- сверка
export async function diffNow() {
  const { getLeagueProfiles, getLeagueMatchHistory } = await import('./sheets.js');
  const [profiles, sheetHistory] = await Promise.all([getLeagueProfiles(), getLeagueMatchHistory().catch(() => new Map())]);
  const live = await buildLiveLeague(profiles, sheetHistory);
  return { rows: diffModel(profiles, sheetHistory, live), unmatched: live.model.unmatched, total: profiles.length };
}
export function diffText(d, { limit = 30 } = {}) {
  const lines = ['🔎 <b>Сверка: журнал матчей ↔ таблица профилей</b>'];
  if (!d.rows.length && !d.unmatched.length) { lines.push(`Расхождений нет (игроков: ${d.total}).`); return lines.join('\n'); }
  lines.push('Формат: профиль / история в таблице → журнал');
  for (const r of d.rows.slice(0, limit)) {
    lines.push(`• ${esc(r.name)}: ${r.sheetProfile} / ${r.sheetHist} → ${r.model === null ? 'нет в журнале' : r.model}`);
  }
  if (d.rows.length > limit) lines.push(`… и ещё ${d.rows.length - limit}`);
  if (d.unmatched.length) lines.push(`\nВ журнале, но без профиля: ${d.unmatched.slice(0, 15).map(u => `${esc(u.name)} (${u.count})`).join(', ')}`);
  return lines.join('\n');
}

// Раз в сутки, в 10:00 по Пхукету — расхождения организатору. Нет расхождений — молчим.
export function diffDue(now = Date.now(), timeZone = TIMEZONE) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(new Date(now)));
  return hour >= 10;
}
export async function runDailyDiff(now = Date.now(), chatId = '') {
  if (!chatId || !diffDue(now)) return { ok: false, reason: 'not_due' };
  const { getSetting, setSetting } = await import('./sheets.js');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date(now));
  if (txt(await getSetting('league_model_diff_last').catch(() => '')) === day) return { ok: false, reason: 'already_done' };
  await setSetting('league_model_diff_last', day, 'Дата последней сверки модели лиги с таблицей профилей');
  const d = await diffNow();
  if (!d.rows.length && !d.unmatched.length) return { ok: true, clean: true };
  const { sendMessage } = await import('./telegram.js');
  await sendMessage(chatId, diffText(d, { limit: 20 }) + '\n\nПодробно — <code>/league_model diff</code>');
  return { ok: true, rows: d.rows.length };
}
