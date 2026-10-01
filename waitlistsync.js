// Лист ожидания → таблица участников («Short Players list», вкладка сезона).
//
// Кто встал в лист ожидания следующего сезона, сразу появляется строкой во
// вкладке этого сезона: имя, рейтинг из анкеты, статус «waitlist». Дивизион
// организатор проставляет сам, рейтинг потом калибрует — эти правки мы не
// трогаем.
//
// Порядок строк — порядок очереди: сначала те, кто уже играл в лиге, дальше
// новички; внутри каждой группы — по дате заявки. Человек отменил заявку или
// его отклонили — строка исчезает.
//
// Как устроена запись. Вкладку не вставляем и не удаляем построчно (это
// ломает выпадающие списки и формулы сводки сверху): читаем блок игроков,
// собираем список заново и переписываем только значения ячеек. Свои строки мы
// узнаём по telegram_id. Строки, которые организатор вписал руками (без
// telegram_id), сохраняются — в конце списка, в том же порядке.
import { sheets as sheetsClient } from './google.js';
import { PARTICIPANTS_SPREADSHEET_ID, SHEETS } from './config.js';
import { getRows, getAllEvents, getLeagueProfiles, sameName } from './sheets.js';

const colToA1 = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); } return s; };
const norm = (v = '') => String(v || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '');
const txt = v => String(v ?? '').trim();

const NAME_KEYS = ['name', 'player', 'player_name', 'имя', 'имя_фамилия', 'фио', 'участник', 'игрок'];
const RATING_KEYS = ['ntrp', 'ntrp_raketo', 'raketo', 'rating', 'рейтинг', 'рейтинг_ntrp'];
const DIVISION_KEYS = ['division', 'дивизион', 'group', 'группа'];
const STATUS_KEYS = ['status', 'статус'];
// Служебные колонки — справа от основных.
export const EXTRA_HEADERS = ['telegram_id', 'applied_at', 'league_player'];
const DROPPED = /cancel|reject|declin|withdraw|refund|inactive|deleted|removed|отмен|отклон/i;

export const seasonOfEvent = ev => {
  const m = String(ev?.event_id || '').match(/(\d+)/) || String(ev?.event_name_en || ev?.event_name || '').match(/(\d+)/);
  return m ? m[1] : '';
};
export const isWaitlistEvent = ev => String(ev?.status_code || ev?.status || '').toLowerCase() === 'waitlist';

// Вкладка сезона — строго та, в названии которой есть номер сезона. Никаких
// запасных вариантов: писать очередь сезона 3 во вкладку сезона 2 нельзя.
async function seasonTab(season) {
  const res = await sheetsClient().spreadsheets.get({
    spreadsheetId: PARTICIPANTS_SPREADSHEET_ID,
    fields: 'sheets(properties(title,sheetId),basicFilter(range))'
  });
  const want = String(season);
  return (res.data.sheets || []).find(s => (String(s.properties?.title || '').match(/\d+/g) || []).includes(want)) || null;
}

const cell = (row, i) => i >= 0 ? txt(row[i]) : '';

// Читаем вкладку: где заголовки, с какой строки идут игроки и какие колонки чьи.
async function readTab(tab) {
  const title = tab.properties.title;
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: PARTICIPANTS_SPREADSHEET_ID, range: `'${title}'!A:Z` });
  const values = res.data.values || [];
  const headerIdx = values.findIndex(r => (r || []).some(c => NAME_KEYS.includes(norm(c))));
  if (headerIdx < 0) throw new Error(`Во вкладке «${title}» нет строки заголовков с колонкой Name`);
  const header = [...(values[headerIdx] || [])];
  const find = keys => header.findIndex(h => keys.includes(norm(h)));
  // Служебные колонки дописываем в первые свободные ячейки строки заголовков.
  const added = [];
  for (const h of EXTRA_HEADERS) {
    if (header.findIndex(x => norm(x) === h) >= 0) continue;
    let at = header.length;
    for (let i = 0; i < header.length; i++) if (!txt(header[i])) { at = i; break; }
    header[at] = h; added.push(at);
  }
  // Под заголовками в шаблоне бывает строка фильтра — пустая строка, с которой
  // начинается фильтр таблицы. Игроков пишем под ней.
  const filterStart = tab.basicFilter?.range?.startRowIndex;
  const dataIdx = Number.isInteger(filterStart) && filterStart > headerIdx ? filterStart + 1 : headerIdx + 1;
  const cols = {
    name: find(NAME_KEYS), rating: find(RATING_KEYS), division: find(DIVISION_KEYS), status: find(STATUS_KEYS),
    telegram_id: header.findIndex(x => norm(x) === 'telegram_id'),
    applied_at: header.findIndex(x => norm(x) === 'applied_at'),
    league_player: header.findIndex(x => norm(x) === 'league_player')
  };
  const rows = [];
  for (let r = dataIdx; r < values.length; r++) {
    const row = values[r] || [];
    rows.push({
      name: cell(row, cols.name), rating: cell(row, cols.rating), division: cell(row, cols.division), status: cell(row, cols.status),
      telegram_id: cell(row, cols.telegram_id).replace(/\D+/g, ''), applied_at: cell(row, cols.applied_at), league_player: cell(row, cols.league_player)
    });
  }
  return { title, header, headerIdx, dataIdx, cols, rows, added };
}

// Кто уже играл в лиге: есть сыгранные матчи или сезоны на сайте лиги.
async function leaguePlayerTest() {
  const profiles = await getLeagueProfiles().catch(() => []);
  const played = profiles.filter(p => Number(p.matches || 0) > 0 || Number(p.seasons || 0) > 0).map(p => p.name);
  return name => played.some(n => sameName(n, name));
}

// Кто сейчас в листе ожидания сезона: живые заявки на события листа ожидания
// этого сезона. Один человек — одна строка, по самой ранней заявке.
async function waitlistEntries(season) {
  const events = (await getAllEvents()).filter(e => isWaitlistEvent(e) && seasonOfEvent(e) === String(season));
  const ids = new Set(events.map(e => e.event_id));
  if (!ids.size) return null;
  const [{ rows: apps }, { rows: applicants }] = await Promise.all([getRows(SHEETS.applications), getRows(SHEETS.applicants)]);
  const byTg = new Map();
  for (const a of apps) {
    if (!ids.has(a.event_id)) continue;
    const tg = txt(a.telegram_id).replace(/\D+/g, '');
    if (!tg || DROPPED.test(txt(a.application_status))) continue;
    const at = txt(a.submitted_at) || txt(a.created_at) || txt(a.updated_at);
    const cur = byTg.get(tg);
    if (!cur || (at && at < cur.applied_at)) byTg.set(tg, { telegram_id: tg, name: txt(a.player_name), applied_at: at });
  }
  for (const e of byTg.values()) {
    const p = applicants.find(r => txt(r.telegram_id) === e.telegram_id);
    if (p?.name) e.name = txt(p.name);
    e.rating = txt(p?.ntrp || p?.racket_rating || '').replace(/^unknown$/i, '');
  }
  return [...byTg.values()];
}

// Порядок очереди: игроки лиги → новички; внутри — по дате заявки.
export function orderWaitlist(list = []) {
  return list.slice().sort((a, b) => {
    const la = a.league_player === 'yes' ? 0 : 1, lb = b.league_player === 'yes' ? 0 : 1;
    if (la !== lb) return la - lb;
    return String(a.applied_at || '9999').localeCompare(String(b.applied_at || '9999'));
  });
}

let chain = Promise.resolve();
// Пересобрать лист ожидания сезона во вкладке участников. Безопасно звать
// сколько угодно раз: результат зависит только от заявок и самой вкладки.
export function syncWaitlistSeason(season) {
  const job = chain.catch(() => {}).then(() => doSync(String(season || '')));
  chain = job;
  return job;
}
async function doSync(season) {
  if (!season) return { ok: false, reason: 'no_season' };
  const entries = await waitlistEntries(season);
  if (!entries) return { ok: false, reason: 'no_waitlist_event' };
  const tab = await seasonTab(season);
  if (!tab) return { ok: false, reason: 'no_tab' };
  const sheet = await readTab(tab);
  const isLeague = await leaguePlayerTest();
  const current = new Map(sheet.rows.filter(r => r.telegram_id).map(r => [r.telegram_id, r]));
  const managed = entries.map(e => {
    const was = current.get(e.telegram_id);
    // Рейтинг, дивизион и статус в таблице — уже правка организатора: не трогаем.
    return {
      telegram_id: e.telegram_id,
      name: was?.name || e.name,
      rating: was?.rating || e.rating,
      division: was?.division || '',
      status: was?.status || 'waitlist',
      applied_at: e.applied_at,
      league_player: isLeague(e.name) || (was?.name && isLeague(was.name)) ? 'yes' : ''
    };
  });
  const manual = sheet.rows.filter(r => !r.telegram_id && r.name);
  const out = [...orderWaitlist(managed), ...manual];
  const width = Math.max(sheet.header.length, ...Object.values(sheet.cols).map(i => i + 1));
  const toRow = r => {
    const row = Array(width).fill(null);
    const set = (k, v) => { if (sheet.cols[k] >= 0) row[sheet.cols[k]] = v ?? ''; };
    set('name', r.name); set('rating', r.rating); set('division', r.division); set('status', r.status);
    set('telegram_id', r.telegram_id); set('applied_at', r.applied_at); set('league_player', r.league_player);
    return row;
  };
  // Хвост, который освободился (кто-то ушёл из листа), очищаем.
  const total = Math.max(out.length, sheet.rows.filter(r => r.name || r.telegram_id).length, sheet.rows.length);
  const body = [];
  for (let i = 0; i < total; i++) body.push(i < out.length ? toRow(out[i]) : toRow({}));
  const data = [];
  if (sheet.added.length) data.push({ range: `'${sheet.title}'!A${sheet.headerIdx + 1}:${colToA1(sheet.header.length)}${sheet.headerIdx + 1}`, values: [sheet.header.map(h => h ?? '')] });
  // Пишем только наши колонки — остальные (если там что-то своё) не задеваем.
  const ours = ['name', 'rating', 'division', 'status', 'telegram_id', 'applied_at', 'league_player'].map(k => sheet.cols[k]).filter(i => i >= 0);
  const first = sheet.dataIdx + 1;
  for (const c of ours) {
    if (!body.length) break;
    data.push({ range: `'${sheet.title}'!${colToA1(c + 1)}${first}:${colToA1(c + 1)}${first + body.length - 1}`, values: body.map(r => [r[c] ?? '']) });
  }
  if (data.length) {
    await sheetsClient().spreadsheets.values.batchUpdate({
      spreadsheetId: PARTICIPANTS_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return { ok: true, tab: sheet.title, waitlist: managed.length, manual: manual.length };
}

// После заявки или смены её статуса: пересобираем сезон, к которому относится
// событие. Не событие листа ожидания — ничего не делаем.
export async function syncWaitlistEntry(eventOrId) {
  let ev = eventOrId;
  if (typeof eventOrId === 'string') ev = (await getAllEvents()).find(e => e.event_id === eventOrId) || null;
  if (!ev || !isWaitlistEvent(ev)) return { ok: false, reason: 'not_waitlist' };
  return syncWaitlistSeason(seasonOfEvent(ev));
}

// Все сезоны, у которых сейчас открыт лист ожидания (команда админа и запуск).
export async function syncAllWaitlists() {
  const seasons = [...new Set((await getAllEvents()).filter(isWaitlistEvent).map(seasonOfEvent).filter(Boolean))];
  const out = [];
  for (const s of seasons) out.push({ season: s, ...(await syncWaitlistSeason(s).catch(e => ({ ok: false, reason: e.message }))) });
  return out;
}
