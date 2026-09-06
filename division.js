// Турнирная таблица дивизиона, перекрёстная сетка и плей-офф.
//
// Считаем из листа Match_Log таблицы дивизиона по той же логике, что и фронтенд
// сайта: победа 3 очка, поражение 1, при равенстве — очки, разница сетов, разница
// геймов, выигранные сеты. Читать готовый блок из таблицы нельзя: он собран
// вручную и в каждом сезоне может стоять в других ячейках, а лист матчей —
// стабильный. Цифры при этом совпадают с тем, что показывает сайт.
//
// Технические поражения (W/O): в колонке P1/P2 TechLoss стоит число очков для
// проигравшего (0 или 1), у соперника ячейка пустая — он получает техническую
// победу и 3 очка. Заполнены обе — двойное техническое, победителя нет.
import { sheets as sheetsClient } from './google.js';
import { DIVISION_SPREADSHEETS } from './config.js';
import { getSetting } from './sheets.js';

const WIN_POINTS = 3;
const LOSS_POINTS = 1;
const TECH_WIN_POINTS = 3;
const WO_LABEL = 'W/O';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

export function invalidateDivisionCache() { cache.clear(); }

function norm(v = '') {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function txt(v) { return String(v ?? '').trim(); }
function num(v) { const n = Number(txt(v)); return Number.isFinite(n) ? n : 0; }
// Ячейка технического поражения заполнена, даже если в ней ноль.
function filled(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function yes(v) { return txt(v).toLowerCase() === 'yes'; }

export function divisionLetter(division = '') {
  return String(division || '').replace(/^(division|дивизион)\s*/i, '').trim().toUpperCase();
}

// ID таблицы дивизиона: сначала Settings (меняется без деплоя при новом сезоне),
// потом переменные окружения.
async function divisionSheetId(letter) {
  const key = divisionLetter(letter);
  const fromSettings = await getSetting(`division_${key.toLowerCase()}_sheet_id`).catch(() => '');
  return txt(fromSettings) || DIVISION_SPREADSHEETS[key] || '';
}

export async function availableDivisions() {
  const out = [];
  for (const letter of Object.keys(DIVISION_SPREADSHEETS)) {
    if (await divisionSheetId(letter)) out.push(letter);
  }
  // Дивизионы, добавленные только через Settings (женские, PRIME).
  for (const extra of ['PRIME', 'BW', 'CW', 'DW']) {
    if (out.includes(extra)) continue;
    if (await divisionSheetId(extra)) out.push(extra);
  }
  return out;
}

async function readMatchLog(spreadsheetId) {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range: 'Match_Log!A:BZ' });
  const values = res.data.values || [];
  const headerRow = values.findIndex(r => (r || []).map(norm).includes('p1_id'));
  if (headerRow < 0) return { headers: [], rows: [] };
  const headers = values[headerRow].map(norm);
  const rows = values.slice(headerRow + 1).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
  return { headers, rows };
}

export async function getDivisionTable(letter) {
  const key = divisionLetter(letter);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  const spreadsheetId = await divisionSheetId(key);
  if (!spreadsheetId) return { ok: false, reason: 'not_configured', division: key };

  let rows = [];
  try { ({ rows } = await readMatchLog(spreadsheetId)); }
  catch (e) {
    console.error(`division ${key} read failed:`, e.message);
    return { ok: false, reason: 'no_access', division: key };
  }

  // Фото игроков лежат сбоку отдельным списком: имя → ссылка.
  const photos = new Map();
  for (const r of rows) {
    const n = txt(r.name1), u = txt(r.url || r.pic);
    if (n && u) photos.set(n, u);
  }

  const players = new Map();
  const ensure = (id, name) => {
    if (!id) return;
    if (!players.has(id)) {
      players.set(id, {
        id, name, photo: photos.get(name) || '',
        matches: 0, wins: 0, losses: 0, points: 0,
        setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0
      });
      return;
    }
    const ex = players.get(id);
    if (!ex.name && name) ex.name = name;
    if (!ex.photo && photos.get(name)) ex.photo = photos.get(name);
  };

  const withNums = rows.filter(r => num(r.match) > 0);
  for (const r of withNums) {
    ensure(num(r.p1_id), txt(r.player_1));
    ensure(num(r.p2_id), txt(r.player_2));
  }

  // Круговая система: n игроков → n(n-1)/2 матчей группы, дальше плей-офф.
  const n = players.size;
  const regularMax = n > 1 ? (n * (n - 1)) / 2 : 0;
  const isGroup = (r) => { const m = num(r.match); return m >= 1 && m <= regularMax; };

  const matrix = {};
  const setCell = (a, b, v) => { matrix[`${a}-${b}`] = v; };

  for (const r of withNums) {
    if (!isGroup(r)) continue;
    const p1 = num(r.p1_id), p2 = num(r.p2_id);
    if (!p1 || !p2) continue;
    const a = players.get(p1), b = players.get(p2);
    if (!a || !b) continue;

    const techA = filled(r.p1_techloss), techB = filled(r.p2_techloss);
    const isTech = (techA || techB) && !yes(r.completed);

    if (isTech) {
      a.matches++; b.matches++;
      if (techA && techB) { a.points += num(r.p1_techloss); b.points += num(r.p2_techloss); a.losses++; b.losses++; }
      else if (techA) { b.wins++; b.points += TECH_WIN_POINTS; a.points += num(r.p1_techloss); a.losses++; }
      else { a.wins++; a.points += TECH_WIN_POINTS; b.points += num(r.p2_techloss); b.losses++; }
      setCell(p1, p2, WO_LABEL); setCell(p2, p1, WO_LABEL);
      continue;
    }
    if (!yes(r.completed)) continue;

    const winner = num(r.winner_id);
    const s1 = num(r.p1_sets_won), s2 = num(r.p2_sets_won);
    const g1 = num(r.p1_games_won), g2 = num(r.p2_games_won);

    a.matches++; b.matches++;
    if (winner === p1) { a.wins++; b.losses++; a.points += WIN_POINTS; b.points += LOSS_POINTS; }
    else if (winner === p2) { b.wins++; a.losses++; b.points += WIN_POINTS; a.points += LOSS_POINTS; }

    a.setsWon += s1; a.setsLost += s2; b.setsWon += s2; b.setsLost += s1;
    a.gamesWon += g1; a.gamesLost += g2; b.gamesWon += g2; b.gamesLost += g1;

    if (txt(r.display_p1)) setCell(p1, p2, txt(r.display_p1));
    if (txt(r.display_p2)) setCell(p2, p1, txt(r.display_p2));
  }

  const table = [...players.values()].map(p => ({
    ...p,
    setDiff: p.setsWon - p.setsLost,
    gameDiff: p.gamesWon - p.gamesLost,
    winRate: p.matches ? Math.round((p.wins / p.matches) * 1000) / 10 : 0
  })).sort((a, b) =>
    b.points - a.points ||
    b.wins - a.wins ||
    b.setDiff - a.setDiff ||
    b.gameDiff - a.gameDiff ||
    b.setsWon - a.setsWon ||
    a.name.localeCompare(b.name)
  ).map((p, i) => ({
    ...p,
    place: i + 1,
    // Зоны те же, что прописаны в таблице: 1–4 плей-офф, 5–6 добор, 7–8 вылет.
    zone: i < 4 ? 'playoff' : (i < 6 ? 'extra' : 'relegation')
  }));

  // Плей-офф: три матча сразу после группового этапа.
  const byNum = (x) => withNums.find(r => num(r.match) === x);
  const pair = (r) => {
    if (!r) return null;
    const p1 = num(r.p1_id), p2 = num(r.p2_id);
    const a = players.get(p1), b = players.get(p2);
    if (!a && !b) return null;
    return {
      first: a ? { id: a.id, name: a.name, photo: a.photo } : null,
      second: b ? { id: b.id, name: b.name, photo: b.photo } : null,
      score: txt(r.display_p1) || txt(r.display_p2) || '',
      winner_id: num(r.winner_id) || 0,
      played: yes(r.completed)
    };
  };
  const sf1 = pair(byNum(regularMax + 1));
  const sf2 = pair(byNum(regularMax + 2));
  const final = pair(byNum(regularMax + 3));
  let champion = null;
  if (final?.winner_id) {
    const c = players.get(final.winner_id);
    if (c) champion = { id: c.id, name: c.name, photo: c.photo };
  }

  const value = {
    ok: true, division: key, players: table, matrix,
    playoff: { sf1, sf2, final, champion },
    regular_matches: regularMax
  };
  cache.set(key, { t: Date.now(), v: value });
  return value;
}
