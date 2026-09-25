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
import { DIVISION_SPREADSHEETS, PUBLIC_URL, LEAGUE_RESULTS_SHEET_ID } from './config.js';
import { cellToScore, getSets, reverseScore } from './tennis.js';
import { getSetting, getMasterPhotos, publishedAvatars } from './sheets.js';
import { divisionRegistry } from './matchesdb.js';

const WIN_POINTS = 3;
const LOSS_POINTS = 1;
const TECH_WIN_POINTS = 3;
const WO_LABEL = 'W/O';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

export function invalidateDivisionCache() { cache.clear(); placesCache.clear(); }

function norm(v = '') {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function txt(v) { return String(v ?? '').trim(); }
function num(v) { const n = Number(txt(v)); return Number.isFinite(n) ? n : 0; }
// Ячейка технического поражения заполнена, даже если в ней ноль.
function filled(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function yes(v) { return txt(v).toLowerCase() === 'yes'; }

export function divisionLetter(division = '') {
  const key = String(division || '').replace(/^(division|дивизион)\s*/i, '').trim().toUpperCase();
  return ({ P:'PRIME', WOMAN:'W', WOMEN:'W' })[key] || key;
}

// Как дивизион называется в интерфейсе. Держим те же подписи, что и раньше:
// PRIME и женский дивизион пишутся не по шаблону «Division X».
const LETTER_TO_NAME = { P:'PRIME', PRIME:'PRIME', W:'Division W', WOMAN:'Division W', WOMEN:'Division W' };
export function divisionDisplayName(division = '') {
  const key = divisionLetter(division);
  if (!key) return '';
  if (LETTER_TO_NAME[key]) return LETTER_TO_NAME[key];
  return key.length <= 2 ? `Division ${key}` : key;
}

// Сезоны лиги. Список правится в Settings без деплоя:
//   league_seasons = 1:finished,2:upcoming
// Порядок в строке — порядок вкладок. Если строки нет, берём значение по умолчанию.
const DEFAULT_SEASONS = '1:finished,2:upcoming';
// Какому сезону принадлежат таблицы из division_*_sheet_id и переменных окружения.
const DEFAULT_SHEETS_SEASON = '1';

export async function getSeasons() {
  const raw = txt(await getSetting('league_seasons').catch(() => '')) || DEFAULT_SEASONS;
  const out = [];
  for (const part of raw.split(',')) {
    const [num, status] = part.split(':').map(x => txt(x));
    if (!num) continue;
    out.push({ number: num, label: `Season ${num}`, status: (status || 'upcoming').toLowerCase() });
  }
  return out.length ? out : [{ number: '1', label: 'Season 1', status: 'finished' }];
}

async function sheetsSeason() {
  return txt(await getSetting('division_sheets_season').catch(() => '')) || DEFAULT_SHEETS_SEASON;
}

// ID таблицы дивизиона. Сначала пробуем таблицу конкретного сезона
// (division_a_s2_sheet_id), затем общую — но только для того сезона, которому
// эти общие таблицы принадлежат, иначе новый сезон показал бы данные старого.
export async function divisionSheetId(letter, season = '', group = '') {
  const key = divisionLetter(letter);
  const low = key.toLowerCase();
  // Сначала реестр — лист Divisions в таблице матчей. Он главный источник:
  // там на каждый сезон своя строка со ссылкой, поэтому прошлые сезоны никуда
  // не деваются, когда начинается новый.
  const reg = await divisionRegistry().catch(() => []);
  const rows = reg.filter(r => r.letter === key && (!season || String(r.season) === String(season)));
  const hit = group
    ? rows.find(r => String(r.group) === String(group))
    : rows[0];
  if (hit) return hit.spreadsheet_id;
  if (group) return ''; // Never send group 2 to a legacy group-1 fallback.
  if (season && reg.some(r => String(r.season) === String(season))) return '';
  if (season) {
    const perSeason = await getSetting(`division_${low}_s${season}_sheet_id`).catch(() => '');
    if (txt(perSeason)) return txt(perSeason);
    if (String(season) !== String(await sheetsSeason())) return '';
  }
  const fromSettings = await getSetting(`division_${low}_sheet_id`).catch(() => '');
  return txt(fromSettings) || DIVISION_SPREADSHEETS[key] || '';
}

// Группы внутри дивизиона: две таблицы одного дивизиона в одном сезоне.
// Пустой список — обычный дивизион с одной таблицей.
export async function divisionGroups(letter, season = '') {
  const key = divisionLetter(letter);
  const reg = await divisionRegistry().catch(() => []);
  const rows = reg.filter(r => r.letter === key && (!season || String(r.season) === String(season)) && r.group);
  return rows.map(r => ({ group: r.group, title: r.group_title || '', title_en: r.group_title_en || '' }));
}

// Как называть дивизион в интерфейсе. Берём из реестра, если там задано имя,
// иначе обычное «Division X».
export async function divisionTitles(season = '') {
  const reg = await divisionRegistry().catch(() => []);
  const out = {};
  for (const r of reg) {
    if (season && String(r.season) !== String(season)) continue;
    if (r.title) out[r.letter] = r.title;
  }
  return out;
}

export async function availableDivisions(season = '') {
  const reg = await divisionRegistry().catch(() => []);
  const fromRegistry = reg
    .filter(r => !season || String(r.season) === String(season))
    .map(r => r.letter);
  if (fromRegistry.length) return [...new Set(fromRegistry)];
  const out = [];
  for (const letter of Object.keys(DIVISION_SPREADSHEETS)) {
    if (await divisionSheetId(letter, season)) out.push(letter);
  }
  // Дивизионы, добавленные только через Settings (женские, PRIME).
  for (const extra of ['PRIME', 'BW', 'CW', 'DW']) {
    if (out.includes(extra)) continue;
    if (await divisionSheetId(extra, season)) out.push(extra);
  }
  return out;
}

// ===========================================================================
// Состав дивизиона. Источник правды — лист Division_Tracker таблицы дивизиона:
// именно его организатор правит, когда переносит игрока. Блок со списком в
// разных таблицах стоит в разных колонках, поэтому ищем его по заголовку
// «Player» где угодно на листе, а не по фиксированному адресу. Если списка нет
// (старая таблица), откатываемся на имена из Match_Log.
const ROSTER_SHEET = 'Division_Tracker';
// Состав в сезоне — это одно чтение на дивизион. У Google лимит на чтения в
// минуту, а мини-приложение дёргает состав на каждый запрос, поэтому:
//   1) держим результат в кэше пару минут;
//   2) храним не значение, а обещание — пока идёт первое чтение, все
//      параллельные запросы ждут его, а не запускают своё.
// Без второго пункта один заход в приложение давал столько чтений, сколько
// дивизионов в сезоне, умноженное на число одновременных запросов.
const ROSTER_CACHE_MS = 2 * 60 * 1000;
const rosterCache = new Map();
const seasonMapCache = new Map();
export function invalidateRosterCache() { rosterCache.clear(); seasonMapCache.clear(); }

function cached(store, key, ttl, build) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = build().catch(e => { store.delete(key); throw e; });
  store.set(key, { t: Date.now(), p });
  return p;
}

// Подпись над списком — та же ячейка, что и в шапке перекрёстной сетки, поэтому
// список считаем закончившимся на двух пустых строках подряд.
function namesUnderPlayerHeader(values = []) {
  const found = [];
  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (norm(row[c]) !== 'player') continue;
      const names = [];
      let blanks = 0;
      for (let i = r + 1; i < values.length; i++) {
        const cell = txt((values[i] || [])[c]);
        if (!cell) { if (++blanks >= 2) break; continue; }
        blanks = 0;
        if (norm(cell) === 'player') break;
        names.push({ name: cell, row: i + 1 });
      }
      if (names.length) found.push({ column: c, headerRow: r + 1, names });
    }
  }
  if (!found.length) return [];
  // Если списков несколько (сводка + сетка), берём самый длинный — это состав.
  found.sort((a, b) => b.names.length - a.names.length);
  return found[0].names;
}

async function readRosterSheet(spreadsheetId) {
  try {
    const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range: `${ROSTER_SHEET}!A:BZ` });
    return namesUnderPlayerHeader(res.data.values || []);
  } catch (e) {
    // Листа может не быть вовсе — это не ошибка, просто откатываемся на Match_Log.
    return [];
  }
}

export async function divisionRoster(letter, season = '', group = '') {
  const key = divisionLetter(letter);
  const cacheId = `${season || '-'}:${key}:${group || '-'}`;
  return cached(rosterCache, cacheId, ROSTER_CACHE_MS, async () => {
    const spreadsheetId = await divisionSheetId(key, season, group);
    if (!spreadsheetId) return { ok: false, reason: 'not_configured', division: key, season, players: [] };

    let players = await readRosterSheet(spreadsheetId);
    let source = ROSTER_SHEET;
    if (!players.length) {
      // Запасной путь: имена из пар расписания, как считалась таблица дивизиона.
      try {
        const { rows } = await readMatchLog(spreadsheetId);
        const seen = new Map();
        for (const r of rows) {
          for (const n of [txt(r.player_1), txt(r.player_2)]) {
            if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), { name: n, row: 0 });
          }
        }
        players = [...seen.values()];
        source = 'Match_Log';
      } catch (e) {
        return { ok: false, reason: 'no_access', division: key, season, players: [] };
      }
    }
    return { ok: true, division: key, season, group, source, spreadsheet_id: spreadsheetId, players };
  });
}

// Весь сезон одним списком: имя → дивизион. Собираем один раз и держим в кэше,
// чтобы на каждый вопрос «в каком дивизионе игрок» не ходить по всем таблицам.
export async function seasonRoster(season = '') {
  const use = season || await latestSeason();
  return cached(seasonMapCache, use || '-', ROSTER_CACHE_MS, async () => {
    const letters = await availableDivisions(use).catch(() => []);
    const players = [];
    for (const letter of letters) {
      const groups = await divisionGroups(letter, use).catch(() => []);
      const variants = groups.length ? groups.map(g => g.group) : [''];
      for (const group of variants) {
        const roster = await divisionRoster(letter, use, group).catch(() => null);
        if (!roster?.ok) continue;
        for (const p of roster.players) {
          players.push({
            name: p.name, row: p.row, letter, group,
            division: divisionDisplayName(letter),
            source: roster.source, spreadsheet_id: roster.spreadsheet_id
          });
        }
      }
    }
    return { season: use, players };
  });
}

// Самый свежий сезон — максимальный номер в реестре дивизионов. Именно его
// составы считаются действующими: матчи формируются по ним.
export async function latestSeason() {
  const reg = await divisionRegistry().catch(() => []);
  const nums = reg.map(r => Number(r.season)).filter(n => Number.isFinite(n) && n > 0);
  if (nums.length) return String(Math.max(...nums));
  const seasons = await getSeasons().catch(() => []);
  const fromSettings = seasons.map(s => Number(s.number)).filter(n => Number.isFinite(n) && n > 0);
  return fromSettings.length ? String(Math.max(...fromSettings)) : '';
}

// В каком дивизионе игрок сейчас. Идём по всем таблицам последнего сезона и
// ищем имя в составе. Совпадение по имени — другого ключа в этих таблицах нет.
export async function findPlayerDivision(name, matchName, season = '') {
  const target = txt(name);
  if (!target) return { found: false };
  const map = await seasonRoster(season).catch(() => null);
  if (!map) return { found: false, season: season || '' };
  const hit = map.players.find(p => matchName(p.name, target));
  if (!hit) return { found: false, season: map.season };
  return { found: true, season: map.season, ...hit };
}

export async function readMatchLog(spreadsheetId) {
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

// Живая «форма» игрока (W/L) из Match_Log, а не из витрины профилей: та
// обновляется формулами IMPORTRANGE с задержкой до получаса и сразу после
// подтверждения счёта показала бы устаревшую последовательность.
//
// upTo — включительно: текущий матч в форму входит, поэтому даже у дебютанта
// после первой игры на карточке появляется одна плашка, а не пустое место.
// Имена сверяем терпимо: точка или регистр в таблицах не должны ничего ломать.
export async function recentFormBefore(spreadsheetId, playerName, upTo, limit = 5) {
  const { rows } = await readMatchLog(spreadsheetId);
  const target = txt(playerName);
  if (!target) return [];
  const { sameName } = await import('./sheets.js');
  const out = [];
  for (const r of rows) {
    const m = num(r.match);
    if (!m || (upTo && m > upTo)) continue;
    const isP1 = sameName(r.player_1, target), isP2 = sameName(r.player_2, target);
    if (!isP1 && !isP2) continue;
    const techA = filled(r.p1_techloss), techB = filled(r.p2_techloss);
    const isTech = (techA || techB) && !yes(r.completed);
    let win;
    if (isTech) {
      if (techA && techB) continue; // двойное техническое — победителя нет, в форму не считаем
      win = techA ? isP2 : isP1;
    } else if (yes(r.completed)) {
      const winner = num(r.winner_id);
      if (!winner) continue;
      win = (isP1 && winner === num(r.p1_id)) || (isP2 && winner === num(r.p2_id));
    } else continue;
    out.push({ match: m, win });
  }
  out.sort((a, b) => a.match - b.match);
  return out.slice(-limit).map(x => (x.win ? 'W' : 'L'));
}

async function readCrossGroupRows(letter, season) {
  if (!LEAGUE_RESULTS_SHEET_ID) return [];
  try {
    const res=await sheetsClient().spreadsheets.values.get({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:'Cross_Group_Match_Log!A:O'});
    const values=res.data.values||[],headers=(values[0]||[]).map(norm);
    return values.slice(1).map(r=>{const o={};headers.forEach((h,i)=>{if(h)o[h]=r[i]??''});return o})
      .filter(r=>String(r.season)===String(season)&&divisionLetter(r.division)===divisionLetter(letter));
  } catch { return []; }
}

async function readPlayoffRows(letter,season){
  if(!LEAGUE_RESULTS_SHEET_ID)return[];try{const res=await sheetsClient().spreadsheets.values.get({spreadsheetId:LEAGUE_RESULTS_SHEET_ID,range:'Playoff!A:Q'}),values=res.data.values||[],headers=(values[0]||[]).map(norm);return values.slice(1).map(r=>{const o={};headers.forEach((h,i)=>{if(h)o[h]=r[i]??''});return o}).filter(r=>String(r.season)===String(season)&&divisionLetter(r.division)===divisionLetter(letter))}catch{return[]}
}

// Карта «имя игрока → его место в дивизионе» по всем дивизионам сезона.
//
// Раньше место бралось из витрины профилей, и после матча оно висело старым,
// пока не пересчитается импорт. Здесь считаем из тех же журналов, что и сама
// таблица дивизиона: обновляется сразу. Результат кешируется вместе с таблицами
// и сбрасывается общим invalidateDivisionCache().
const placesCache = new Map();
const PLACES_CACHE_MS = 60 * 1000;
export const placeKey = (v = '') => norm(v);
export async function livePlaces(season = '') {
  const key = `places:${season || '-'}`;
  const hit = placesCache.get(key);
  if (hit && Date.now() - hit.t < PLACES_CACHE_MS) return hit.v;
  const out = new Map();
  try {
    for (const letter of await availableDivisions(season).catch(() => [])) {
      const groups = await divisionGroups(letter, season).catch(() => []);
      for (const group of (groups.length ? groups : [''])) {
        const table = await getDivisionTable(letter, season, group).catch(() => null);
        if (!table?.ok || !Array.isArray(table.table)) continue;
        for (const row of table.table) {
          const name = norm(row.name);
          if (!name || out.has(name)) continue;
          out.set(name, { place: row.place, division: letter, group: group || '', matches: row.matches, wins: row.wins, losses: row.losses, points: row.points });
        }
      }
    }
  } catch (e) { console.error('livePlaces failed:', e.message); }
  placesCache.set(key, { t: Date.now(), v: out });
  return out;
}

export async function getDivisionTable(letter, season = '', group = '') {
  const key = divisionLetter(letter);
  const cacheId = `${season || '-'}:${key}:${group || '-'}`;
  const hit = cache.get(cacheId);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  const spreadsheetId = await divisionSheetId(key, season, group);
  if (!spreadsheetId) return { ok: false, reason: 'not_configured', division: key, season };

  let rows = [];
  try { ({ rows } = await readMatchLog(spreadsheetId)); }
  catch (e) {
    console.error(`division ${key} read failed:`, e.message);
    return { ok: false, reason: 'no_access', division: key };
  }

  // Shared portrait priority: Applicants.avatar_file_id, then Players_Master.
  const photos = await getMasterPhotos().catch(() => new Map());
  const avatars = await publishedAvatars().catch(() => new Map());
  const portrait = name => {
    const key = txt(name).toLowerCase();
    const id = avatars.get(key);
    return id ? PUBLIC_URL+'/avatar/'+encodeURIComponent(id)+'.png'
      : [...photos].find(([n]) => txt(n).toLowerCase()===key)?.[1] || '';
  };
  const grouped = (await divisionGroups(key,season)).length > 1;

  const players = new Map();
  const ensure = (id, name) => {
    if (!id) return;
    if (!players.has(id)) {
      players.set(id, {
        id, name, photo: portrait(name),
        matches: 0, wins: 0, losses: 0, points: 0,
        setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0
      });
      return;
    }
    const ex = players.get(id);
    if (!ex.name && name) ex.name = name;
    if (!ex.photo) ex.photo = portrait(name);
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

  // Строка без имени — незаполненное место в расписании дивизиона. Показывать
  // её незачем: в таблице она выглядела как игрок «?» с нулями.
  const crossMatches = grouped ? await readCrossGroupRows(key, season) : [];
  const byName = name => [...players.values()].find(p => txt(p.name).toLowerCase() === txt(name).toLowerCase());
  for (const r of crossMatches.filter(x => txt(x.status).toLowerCase() === 'confirmed')) {
    const first=byName(r.player_1),second=byName(r.player_2),local=first||second;
    if(!local)continue;
    const localFirst=Boolean(first),winner=txt(r.winner),kind=txt(r.result_kind).toLowerCase();
    local.matches++;
    const won=winner&&txt(winner).toLowerCase()===txt(local.name).toLowerCase();
    if(won)local.wins++;else local.losses++;
    const explicit=localFirst?r.player_1_points:r.player_2_points;
    local.points+=filled(explicit)?num(explicit):(won?WIN_POINTS:LOSS_POINTS);
    if(kind==='technical')continue;
    let parsed=cellToScore(r.score);if(!localFirst)parsed=reverseScore(parsed);
    for(const set of getSets(parsed)){
      if(set.a>set.b)local.setsWon++;else if(set.b>set.a)local.setsLost++;
      const mtb=set.a>=10||set.b>=10;if(!mtb){local.gamesWon+=num(set.a);local.gamesLost+=num(set.b)}
    }
  }

  const table = [...players.values()].filter(p => txt(p.name)).map(p => ({
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
    zone: grouped ? (i < 4 ? 'playoff' : '') : (i < 4 ? 'playoff' : (i < 6 ? 'extra' : 'relegation'))
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
  const third = pair(byNum(regularMax + 4));
  let champion = null;
  if (final?.winner_id) {
    const c = players.get(final.winner_id);
    if (c) champion = { id: c.id, name: c.name, photo: c.photo };
  }
  let playoff={qf:[],sf:[sf1,sf2].filter(Boolean),sf1,sf2,final,third,champion};
  if(grouped){
    const raw=await readPlayoffRows(key,season),make=r=>{const firstName=txt(r.player_1),secondName=txt(r.player_2),winner=txt(r.winner);return{first:firstName?{id:firstName,name:firstName,photo:portrait(firstName)}:null,second:secondName?{id:secondName,name:secondName,photo:portrait(secondName)}:null,score:txt(r.score),winner_id:winner,played:txt(r.status).toLowerCase()==='confirmed'||Boolean(txt(r.score)),slot:txt(r.slot),stage:txt(r.stage)}};
    const stage=x=>raw.filter(r=>txt(r.stage).toLowerCase()===x).sort((a,b)=>num(a.slot)-num(b.slot)).map(make);
    const qf=stage('qf'),sf=stage('sf'),fin=stage('final')[0]||null,bronze=stage('3rd')[0]||null;
    const champ=fin&&fin.winner_id?{id:fin.winner_id,name:fin.winner_id,photo:portrait(fin.winner_id)}:null;
    playoff={qf,sf,sf1:sf[0]||null,sf2:sf[1]||null,final:fin,third:bronze,champion:champ};
  }

  const value = {
    ok: true, division: key, season, grouped, players: table, matrix, cross_matches: crossMatches,
    playoff,
    regular_matches: regularMax
  };
  cache.set(cacheId, { t: Date.now(), v: value });
  return value;
}
