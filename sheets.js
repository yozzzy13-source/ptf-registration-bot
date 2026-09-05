import { sheets as sheetsClient } from './google.js';
import { SPREADSHEET_ID, SHEETS, PARTICIPANTS_SPREADSHEET_ID, PARTICIPANTS_SHEET_ID, WEBSITE_URL, WEBSITE_SPREADSHEET_ID, WEBSITE_PLAYERS_SHEET_ID } from './config.js';
import { nowISO, safe } from './util.js';

const cache = new Map();
const CACHE_MS = 20_000;

function colToA1(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

async function valuesGet(range) {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}
async function valuesUpdate(range, values) {
  await sheetsClient().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
}
async function valuesAppend(range, values) {
  const res = await sheetsClient().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  return res.data;
}

async function spreadsheetMeta() {
  const res = await sheetsClient().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return res.data;
}


async function valuesGetFromSpreadsheet(spreadsheetId, range) {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}
async function spreadsheetMetaFor(spreadsheetId) {
  const res = await sheetsClient().spreadsheets.get({ spreadsheetId });
  return res.data;
}
function normalizeHeader(value='') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}
function firstNonEmpty(row={}, keys=[]) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && String(v).trim()) return String(v).trim();
  }
  return '';
}
async function manualParticipantsSheetTitle() {
  const meta = await spreadsheetMetaFor(PARTICIPANTS_SPREADSHEET_ID);
  const sheets = meta.sheets || [];
  const byId = sheets.find(s => String(s.properties?.sheetId || '') === String(PARTICIPANTS_SHEET_ID));
  return byId?.properties?.title || sheets[0]?.properties?.title || 'Sheet1';
}
// ---------------------------------------------------------------------------
// Manual participants sheet (separate spreadsheet, filled by hand).
// Real layout of the sheet:
//   [note rows: "The division has not yet been formed..."]
//   [ blank | Players | Division Size ]
//   [ PRIME | 0 | 8 ]  [ Division A | 4 | 8 | active ] ... [ Division Woman | 8 | 8 ]
//   [ Name | ntrp | Division | status | ... contact columns ... ]
//   [ player rows ]
// Only public columns are exposed to the WebApp; contacts are never sent.
// ---------------------------------------------------------------------------
const PARTICIPANT_NAME_HEADERS = ['name','player','player_name','имя','имя_фамилия','фио','участник','игрок'];
const PARTICIPANT_PUBLIC_KEYS = new Set(['name','ntrp','ntrp_raketo','raketo','rating','рейтинг','division','дивизион','group','группа','status','статус']);
const DIVISION_LETTER_TO_NAME = { p:'PRIME', prime:'PRIME', w:'Division Woman', woman:'Division Woman', women:'Division Woman', ladies:'Division Woman', a:'Division A', b:'Division B', c:'Division C', d:'Division D', e:'Division E' };

function isLikelyDivisionHeader(value='') {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  return /^(prime|division\s*[a-z0-9]+|division\s*woman|women|woman|ladies|дивизион\s*[a-zа-я0-9]+)$/i.test(v);
}
function normalizeDivisionName(value='') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const v = raw.toLowerCase().replace(/^(division|дивизион)\s*/i, '').trim();
  if (DIVISION_LETTER_TO_NAME[v]) return DIVISION_LETTER_TO_NAME[v];
  if (isLikelyDivisionHeader(raw)) return raw;
  return raw.length <= 2 ? `Division ${raw.toUpperCase()}` : raw;
}
function normalizeRating(value='') {
  const v = String(value || '').trim().replace(/,/g, '.');
  if (!v || ['unknown','не знаю','n/a','na','-','?'].includes(v.toLowerCase())) return '';
  return v;
}
function normalizeStatus(value='') {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (['active','активен','активный','активна','подтвержден','подтверждён','confirmed','paid'].includes(v)) return 'active';
  if (['waitlist','wait list','waiting','лист ожидания','ожидание','pending'].includes(v)) return 'waitlist';
  return v;
}
function isGenericPlayerCell(value='') {
  const v = String(value || '').trim().toLowerCase();
  return !v || ['name','player','players','participant','participants','имя','игрок','игроки','участник','участники','ntrp','raketo','rating','рейтинг','status','статус','country','страна','telegram','whatsapp','phone','телефон','division','дивизион'].includes(v);
}
function findParticipantsHeaderRow(values=[]) {
  return values.findIndex(r => (r || []).some(c => PARTICIPANT_NAME_HEADERS.includes(normalizeHeader(c))));
}
function parseDivisionSummary(values=[], headerRowIndex=-1) {
  // Rows above the player table where column A is a division name and column B/C hold numbers.
  const limit = headerRowIndex >= 0 ? headerRowIndex : values.length;
  const divisions = [];
  let note = '';
  for (let r = 0; r < limit; r++) {
    const row = values[r] || [];
    const first = String(row[0] || '').trim();
    if (!note) {
      const long = row.map(c => String(c || '').trim()).find(c => c.length > 40 && !/^\d/.test(c));
      if (long) note = long;
    }
    if (!isLikelyDivisionHeader(first)) continue;
    const size = Number(String(row[2] || '').replace(/[^0-9]/g, '')) || 0;
    const declared = Number(String(row[1] || '').replace(/[^0-9]/g, '')) || 0;
    divisions.push({ division: normalizeDivisionName(first), size, declared_count: declared, order: divisions.length });
  }
  return { divisions, note };
}
function parseParticipantRows(values=[], headerRowIndex=0) {
  const headers = values[headerRowIndex] || [];
  const normHeaders = headers.map(normalizeHeader);
  const players = [];
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r] || [];
    const raw = {};
    headers.forEach((h, i) => { const key = normHeaders[i] || `col_${i+1}`; raw[key] = String(row[i] ?? '').trim(); });
    const name = firstNonEmpty(raw, PARTICIPANT_NAME_HEADERS);
    if (!name || isGenericPlayerCell(name)) continue;
    const divisionRaw = firstNonEmpty(raw, ['division','дивизион','group','группа']);
    const rating = normalizeRating(firstNonEmpty(raw, ['ntrp','ntrp_raketo','raketo','rating','рейтинг','рейтинг_ntrp']));
    const status = normalizeStatus(firstNonEmpty(raw, ['status','статус']));
    const fields = [];
    headers.forEach((h, i) => {
      const key = normHeaders[i];
      const label = String(h || '').trim();
      const value = String(row[i] ?? '').trim();
      if (label && value && PARTICIPANT_PUBLIC_KEYS.has(key)) fields.push({ key, label, value });
    });
    // telegram_id из таблицы участников (если колонка заведена) — точная привязка вместо
    // сопоставления по имени. В WebApp не отдаётся: остаётся только на сервере.
    const telegramId = firstNonEmpty(raw, ['telegram_id','telegramid','tg_id','telegram']).replace(/^https?:\/\/t\.me\//,'').replace(/^@/,'');
    players.push({ rowNumber: r + 1, name, division: normalizeDivisionName(divisionRaw), division_raw: divisionRaw, rating, status, telegram_id: /^\d+$/.test(telegramId) ? telegramId : '', fields });
  }
  return players;
}
function buildParticipantGroups(players=[], divisions=[]) {
  const byName = new Map();
  divisions.forEach(d => byName.set(d.division, { division: d.division, size: d.size || 0, order: d.order, players: [] }));
  let extraOrder = divisions.length;
  for (const p of players) {
    const key = p.division || '';
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { division: key, size: 0, order: extraOrder++, players: [] });
    byName.get(key).players.push(p);
  }
  const unassigned = players.filter(p => !p.division);
  const groups = [...byName.values()].sort((a,b) => a.order - b.order).map(g => ({
    division: g.division,
    size: g.size,
    count: g.players.length,
    active: g.players.filter(p => p.status === 'active').length,
    waitlist: g.players.filter(p => p.status === 'waitlist').length,
    players: g.players
  }));
  if (unassigned.length) groups.push({ division: '', size: 0, count: unassigned.length, active: unassigned.filter(p => p.status === 'active').length, waitlist: unassigned.filter(p => p.status === 'waitlist').length, players: unassigned, unassigned: true });
  return groups;
}
// ---------------------------------------------------------------------------
// Website player pages (read-only backend sheet of phukettennis.com).
// Used to make names in the participants list clickable and show avatars.
// ---------------------------------------------------------------------------
const WEBSITE_CACHE_MS = 5 * 60_000;
let websitePlayersCache = { t: 0, v: null };

function normalizePersonName(value='') {
  return String(value || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const FIRST_NAME_ALIASES = {
  alex:'alexander', alexandr:'alexander', aleksandr:'alexander', sasha:'alexander',
  ilya:'ilia', ilia:'ilia', misha:'michael', mikhail:'michael', mike:'michael',
  tim:'timofei', slava:'viacheslav', vyacheslav:'viacheslav', kostya:'kostas', konstantin:'kostas',
  dima:'dmitry', dmitriy:'dmitry', dmitrii:'dmitry', sergey:'sergei', serge:'sergei',
  andrey:'andrei', andrew:'andrei', evgeny:'evgenii', evgeniy:'evgenii', eugene:'evgenii',
  nick:'nikolai', nikolay:'nikolai', vlad:'vladislav', dasha:'daria', darya:'daria', masha:'maria', mariya:'maria',
  olya:'olga', anya:'anna', ksenia:'xenia', kseniya:'xenia', ira:'irina'
};
function nameKeys(value='') {
  const norm = normalizePersonName(value);
  if (!norm) return [];
  const parts = norm.split(' ');
  const keys = new Set([norm]);
  if (parts.length >= 2) {
    const first = FIRST_NAME_ALIASES[parts[0]] || parts[0];
    const last = parts[parts.length - 1];
    keys.add(`${first} ${last}`);
    keys.add(`${last} ${first}`);
    keys.add(`${first.slice(0,3)}* ${last}`);
  }
  return [...keys];
}

async function websitePlayersSheetTitle() {
  const meta = await spreadsheetMetaFor(WEBSITE_SPREADSHEET_ID);
  const sheets = meta.sheets || [];
  const byId = sheets.find(sh => String(sh.properties?.sheetId || '') === String(WEBSITE_PLAYERS_SHEET_ID));
  return byId?.properties?.title || null;
}

export async function getWebsitePlayers() {
  if (websitePlayersCache.v && Date.now() - websitePlayersCache.t < WEBSITE_CACHE_MS) return websitePlayersCache.v;
  const title = await websitePlayersSheetTitle();
  if (!title) return [];
  const values = await valuesGetFromSpreadsheet(WEBSITE_SPREADSHEET_ID, `'${title}'!A:AZ`);
  const headerRowIndex = values.findIndex(r => {
    const h = (r || []).map(normalizeHeader);
    return h.includes('player_name') && (h.includes('profile_url_by_id') || h.includes('profile_url_by_name') || h.includes('player_slug'));
  });
  if (headerRowIndex < 0) return [];
  const headers = values[headerRowIndex].map(normalizeHeader);
  const players = [];
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r] || [];
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = String(row[i] ?? '').trim(); });
    if (!obj.player_name) continue;
    const rel = obj.profile_url_by_id || obj.profile_url_by_name || (obj.player_id ? `/player-profile?playerId=${encodeURIComponent(obj.player_id)}&player=${encodeURIComponent(obj.player_name)}` : '');
    if (!rel) continue;
    players.push({
      player_id: obj.player_id || '',
      slug: obj.player_slug || '',
      name: obj.player_name,
      photo_url: obj.player_photo_url || '',
      division: obj.current_division || '',
      profile_url: /^https?:\/\//i.test(rel) ? rel : `${WEBSITE_URL}${rel.startsWith('/') ? '' : '/'}${rel}`
    });
  }
  websitePlayersCache = { t: Date.now(), v: players };
  return players;
}

// Adds profile_url / photo_url to manual participants when a website page exists for the same person.
export async function attachWebsiteProfiles(players=[]) {
  let site = [];
  try { site = await getWebsitePlayers(); } catch (e) { console.error('website players load failed:', e.message); return players; }
  if (!site.length) return players;
  const exact = new Map();
  const loose = new Map();
  for (const sp of site) {
    const keys = nameKeys(sp.name);
    if (keys[0]) exact.set(keys[0], sp);
    keys.slice(1).forEach(k => { if (!loose.has(k)) loose.set(k, sp); });
  }
  for (const p of players) {
    const keys = nameKeys(p.name);
    const hit = (keys[0] && exact.get(keys[0])) || keys.slice(1).map(k => loose.get(k)).find(Boolean) || null;
    if (hit) { p.profile_url = hit.profile_url; p.photo_url = hit.photo_url; p.website_player_id = hit.player_id; }
  }
  return players;
}

export async function getManualParticipants() {
  const title = await manualParticipantsSheetTitle();
  const values = await valuesGetFromSpreadsheet(PARTICIPANTS_SPREADSHEET_ID, `'${title}'!A:BZ`);
  const parsed = parseManualParticipantsValues(values);
  await attachWebsiteProfiles(parsed.players); // groups reference the same player objects
  return parsed;
}
export function parseManualParticipantsValues(values=[]) {
  if (!values.length) return { players: [], groups: [], divisions: [], note: '', totals: { total:0, active:0, waitlist:0 } };
  const headerRowIndex = findParticipantsHeaderRow(values);
  const { divisions, note } = parseDivisionSummary(values, headerRowIndex);
  const players = headerRowIndex >= 0 ? parseParticipantRows(values, headerRowIndex) : [];
  const groups = buildParticipantGroups(players, divisions);
  const totals = { total: players.length, active: players.filter(p => p.status === 'active').length, waitlist: players.filter(p => p.status === 'waitlist').length };
  return { players, groups, divisions, note, totals };
}

async function ensureSheetWithHeaders(sheetName, headers, sheetId=null) {
  const meta = await spreadsheetMeta();
  const exists = meta.sheets?.some(s => s.properties?.title === sheetName);
  if (!exists) {
    const props = { title: sheetName, gridProperties: { rowCount: 1000, columnCount: Math.max(headers.length, 20), frozenRowCount: 1 } };
    if (sheetId) props.sheetId = sheetId;
    await sheetsClient().spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ addSheet: { properties: props } }] } });
  }
  const values = await valuesGet(`'${sheetName}'!A1:BZ1`).catch(() => []);
  const current = values[0] || [];
  const merged = [...current];
  for (const h of headers) if (!merged.includes(h)) merged.push(h);
  if (merged.length && merged.join('|') !== current.join('|')) await valuesUpdate(`'${sheetName}'!A1:${colToA1(merged.length)}1`, [merged]);
  cache.clear();
  return merged;
}

export async function getRows(sheetName, { useCache=true } = {}) {
  const key = `rows:${sheetName}`;
  const c = cache.get(key);
  if (useCache && c && Date.now() - c.t < CACHE_MS) return c.v;
  const values = await valuesGet(`'${sheetName}'!A:BZ`);
  const headers = values[0] || [];
  const rows = values.slice(1).map((r, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => obj[h] = r[i] ?? '');
    return obj;
  });
  const out = { headers, rows, values };
  cache.set(key, { t: Date.now(), v: out });
  return out;
}

export async function appendObject(sheetName, obj) {
  const { headers } = await getRows(sheetName, { useCache:false });
  const row = headers.map(h => obj[h] ?? '');
  await valuesAppend(`'${sheetName}'!A:BZ`, [row]);
  cache.clear();
}

export async function updateObjectByRow(sheetName, rowNumber, patch) {
  const { headers, rows } = await getRows(sheetName, { useCache:false });
  const current = rows.find(r => r._rowNumber === rowNumber) || {};
  const merged = { ...current, ...patch };
  const values = headers.map(h => merged[h] ?? '');
  const endCol = colToA1(headers.length);
  await valuesUpdate(`'${sheetName}'!A${rowNumber}:${endCol}${rowNumber}`, [values]);
  cache.clear();
}

export async function getSetting(key) {
  const { rows } = await getRows(SHEETS.settings);
  return rows.find(r => r.key === key)?.value || '';
}
export async function setSetting(key, value, description='') {
  const { rows } = await getRows(SHEETS.settings, { useCache:false });
  const found = rows.find(r => r.key === key);
  if (found) await updateObjectByRow(SHEETS.settings, found._rowNumber, { value, updated_at: nowISO(), description: description || found.description });
  else await appendObject(SHEETS.settings, { key, value, description, updated_at: nowISO() });
}

export async function getBotText(text_key, language='en') {
  const lang = language === 'ru' ? 'ru' : 'en';
  const { rows } = await getRows(SHEETS.botTexts);
  return rows.find(r => r.text_key === text_key && r.language === lang) || rows.find(r => r.text_key === text_key && r.language === 'en') || null;
}

export async function getActiveEvents() {
  const { rows } = await getRows(SHEETS.events, { useCache:false });
  return rows
    .filter(r => ['active','open','registration_open'].includes(safe(r.status)))
    .sort((a,b) => Number(a.sort_order || 999) - Number(b.sort_order || 999));
}

export async function getPaymentMethods() {
  const { rows } = await getRows(SHEETS.paymentMethods, { useCache:false });
  return rows.filter(r => safe(r.status) === 'active');
}


function normKey(value='') {
  return String(value || '').trim().toLowerCase();
}

function compactKey(value='') {
  return normKey(value).replace(/[^a-zа-яё0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function eventAliases(event={}) {
  const aliases = new Set();
  [event.event_id, event.event_name, event.event_name_en, event.event_name_ru, event.title, event.name]
    .filter(Boolean)
    .forEach(v => {
      aliases.add(compactKey(v));
      aliases.add(normKey(v));
    });
  const id = normKey(event.event_id);
  if (id === 'league_s2' || id.includes('season2') || id.includes('s2')) {
    ['league s2','league_s2','season 2','season2','second season','second league season','второй сезон','2 сезон','сезон 2']
      .forEach(v => aliases.add(compactKey(v)));
  }
  return [...aliases].filter(Boolean);
}

function rowMatchesEvent(row={}, event={}) {
  const aliases = eventAliases(event);
  const eventId = normKey(event.event_id);
  if (eventId && normKey(row.event_id) === eventId) return true;
  const hay = compactKey([
    row.event_id,
    row.event_name,
    row.last_application_event,
    row.crm_tags,
    row.notes,
    row.source_event,
    row.event
  ].filter(Boolean).join(' '));
  if (!hay) return false;
  return aliases.some(a => a && (hay === compactKey(a) || hay.includes(compactKey(a))));
}

function applicantKey(row={}) {
  const tg = String(row.telegram_id || '').trim();
  if (tg) return `tg:${tg}`;
  const username = String(row.telegram_username || row.telegram || '').replace(/^https?:\/\/t\.me\//,'').replace(/^t\.me\//,'').replace(/^@/,'').trim().toLowerCase();
  if (username) return `u:${username}`;
  const name = compactKey(row.name || row.player_name || '');
  return name ? `n:${name}` : '';
}

export async function getEventPlayers(event={}) {
  const [{ rows: applications }, { rows: applicants }] = await Promise.all([
    getRows(SHEETS.applications, { useCache:false }),
    getRows(SHEETS.applicants, { useCache:false })
  ]);

  const applicantsByKey = new Map();
  for (const a of applicants) {
    const key = applicantKey(a);
    if (key) applicantsByKey.set(key, a);
    const tg = String(a.telegram_id || '').trim();
    if (tg) applicantsByKey.set(`tg:${tg}`, a);
    const username = String(a.telegram_username || a.telegram || '').replace(/^https?:\/\/t\.me\//,'').replace(/^t\.me\//,'').replace(/^@/,'').trim().toLowerCase();
    if (username) applicantsByKey.set(`u:${username}`, a);
  }

  const out = new Map();
  const add = (row={}, source='applications') => {
    const key = applicantKey(row);
    if (!key) return;
    const profile = applicantsByKey.get(key) || (row.telegram_id ? applicantsByKey.get(`tg:${row.telegram_id}`) : null) || row;
    const name = String(profile.name || row.player_name || row.name || '').trim();
    if (!name) return;
    const prev = out.get(key) || {};
    out.set(key, {
      telegram_id: profile.telegram_id || row.telegram_id || prev.telegram_id || '',
      telegram_username: profile.telegram_username || row.telegram_username || prev.telegram_username || '',
      name,
      status: profile.status || row.application_status || prev.status || '',
      application_status: row.application_status || prev.application_status || '',
      payment_status: row.payment_status || prev.payment_status || '',
      source
    });
  };

  applications.filter(r => rowMatchesEvent(r, event)).forEach(r => add(r, 'applications'));
  applicants.filter(r => rowMatchesEvent(r, event)).forEach(r => add(r, 'applicants'));

  return [...out.values()]
    .filter(p => p.name)
    .sort((a,b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity:'base' }));
}

export async function enrichEventsWithStats(events=[]) {
  let manualPlayers = [];
  try { const data = await getManualParticipants(); manualPlayers = Array.isArray(data) ? data : (data.players || []); } catch (e) { manualPlayers = []; }
  const manualCount = manualPlayers.length;
  const enriched = [];
  for (const ev of events) {
    enriched.push({ ...ev, applications_count: manualCount, players_count: manualCount });
  }
  return enriched;
}


let applicantAdminColumnsReady = null;
export async function ensureApplicantAdminColumns() {
  // Header check hits the Sheets metadata API; do it once per process.
  if (!applicantAdminColumnsReady) {
    applicantAdminColumnsReady = ensureSheetWithHeaders(SHEETS.applicants, ['admin_topic_id','admin_topic_name','admin_topic_created_at'])
      .catch(e => { applicantAdminColumnsReady = null; throw e; });
  }
  return applicantAdminColumnsReady;
}

// Minimal lead row so every Telegram user has exactly one Applicants row that can hold admin_topic_id.
export async function ensureApplicantLead(user={}) {
  const telegramId = user.id || user.telegram_id || '';
  if (!telegramId) return null;
  const username = user.username || user.telegram_username || '';
  const existing = await findApplicantByTelegramIdentity({ id: telegramId, username });
  if (existing) return existing;
  const name = user.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || '';
  const newRow = {
    date: nowISO(), created_at: nowISO(), updated_at: nowISO(),
    name, status: 'lead', division: 'pending',
    telegram_id: telegramId, telegram_username: username, telegram: username ? `t.me/${username}` : '',
    language: ['ru','en'].includes(String(user.language || '').toLowerCase()) ? String(user.language).toLowerCase() : '',
    source: 'telegram_lead', crm_tags: 'lead', profile_completed: 'no', selfie_status: 'optional_missing'
  };
  await appendObject(SHEETS.applicants, newRow);
  return { ...newRow, _rowNumber: null };
}

export async function findApplicantByAdminTopicId(topicId) {
  await ensureApplicantAdminColumns();
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  return rows.find(r => String(r.admin_topic_id || '') === String(topicId));
}

export async function updateApplicantAdminTopic(telegramId, patch, user={}) {
  await ensureApplicantAdminColumns();
  const found = await findApplicantByTelegramId(telegramId) || (user?.username ? await findApplicantByTelegramIdentity({ id: telegramId, username: user.username }) : null);
  if (!found) return null;
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, { ...patch, updated_at: nowISO() });
  return { ...found, ...patch };
}

export async function findApplicantByTelegramId(telegramId) {
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  return rows.find(r => String(r.telegram_id) === String(telegramId));
}

export async function findApplicantByTelegramIdentity(userOrProfile={}) {
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  const telegramId = userOrProfile.id || userOrProfile.telegram_id || '';
  const usernameRaw = userOrProfile.username || userOrProfile.telegram_username || '';
  const username = String(usernameRaw || '').replace(/^@/,'').toLowerCase();
  if (telegramId) {
    const byId = rows.find(r => String(r.telegram_id) === String(telegramId));
    if (byId) return byId;
  }
  if (username) {
    return rows.find(r => {
      const u1 = String(r.telegram_username || '').replace(/^@/,'').toLowerCase();
      const u2 = String(r.telegram || '').replace(/^https?:\/\/t\.me\//,'').replace(/^t\.me\//,'').replace(/^@/,'').toLowerCase();
      return u1 === username || u2 === username;
    });
  }
  return null;
}

export async function setUserLanguage(user={}, language='en') {
  const lang = language === 'ru' ? 'ru' : 'en';
  const telegramId = user.id || user.telegram_id || '';
  const username = user.username || user.telegram_username || '';
  const name = user.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || '';
  const existing = await findApplicantByTelegramIdentity({ id: telegramId, username });
  if (existing) {
    await updateObjectByRow(SHEETS.applicants, existing._rowNumber, { language: lang, telegram_id: telegramId || existing.telegram_id, telegram_username: username || existing.telegram_username, telegram: username ? `t.me/${username}` : existing.telegram, updated_at: nowISO() });
    return { ...existing, language: lang };
  }
  const newRow = {
    date: nowISO(),
    created_at: nowISO(),
    updated_at: nowISO(),
    name,
    status: 'lead',
    division: 'pending',
    telegram_id: telegramId,
    telegram_username: username,
    telegram: username ? `t.me/${username}` : '',
    language: lang,
    source: 'telegram_language_select',
    crm_tags: 'language_selected',
    profile_completed: 'no',
    selfie_status: 'optional_missing'
  };
  await appendObject(SHEETS.applicants, newRow);
  return newRow;
}

export async function upsertApplicant(profile) {
  const existing = await findApplicantByTelegramIdentity(profile);
  const patch = {
    name: profile.name,
    ntrp: profile.ntrp,
    status: profile.status || existing?.status || 'lead',
    experience: profile.experience,
    gender: profile.gender,
    age: profile.gender === 'female' ? '' : profile.age,
    country_of_origin: profile.country_of_origin,
    telegram: profile.telegram || profile.telegram_username || '',
    whatsapp: profile.whatsapp,
    notes: profile.notes,
    telegram_id: profile.telegram_id,
    telegram_username: profile.telegram_username,
    language: profile.language || existing?.language || '',
    source: profile.source || 'registration_bot',
    updated_at: nowISO(),
    last_application_event: profile.last_application_event,
    selfie_status: profile.selfie_status || existing?.selfie_status || 'optional_missing',
    selfie_file_id: profile.selfie_file_id || existing?.selfie_file_id || '',
    crm_tags: profile.crm_tags || existing?.crm_tags || 'league_interested',
    application_count: Number(existing?.application_count || 0) + (profile.increment_application_count ? 1 : 0),
    profile_completed: 'yes',
    allow_match_challenges: profile.allow_match_challenges || existing?.allow_match_challenges || 'yes',
    player_profile_url: profile.player_profile_url || existing?.player_profile_url || ''
  };
  if (existing) {
    await updateObjectByRow(SHEETS.applicants, existing._rowNumber, patch);
    return { ...existing, ...patch, _rowNumber: existing._rowNumber, isNew:false };
  }
  const newRow = { division:'pending', date: nowISO(), created_at: nowISO(), ...patch };
  await appendObject(SHEETS.applicants, newRow);
  return { ...newRow, isNew:true };
}

export async function createApplication(app) {
  await appendObject(SHEETS.applications, app);
  return app;
}

export async function findApplicationByTelegramEvent(telegramId, eventId) {
  const { rows } = await getRows(SHEETS.applications, { useCache:false });
  return rows
    .filter(r => String(r.telegram_id) === String(telegramId) && String(r.event_id) === String(eventId))
    .sort((a,b) => Number(b._rowNumber || 0) - Number(a._rowNumber || 0))[0] || null;
}


export async function findLatestApplicationByTelegramId(telegramId) {
  const { rows } = await getRows(SHEETS.applications, { useCache:false });
  return rows
    .filter(r => String(r.telegram_id) === String(telegramId))
    .sort((a,b) => Number(b._rowNumber || 0) - Number(a._rowNumber || 0))[0] || null;
}

export async function findLatestPayableApplicationByTelegramId(telegramId) {
  const { rows } = await getRows(SHEETS.applications, { useCache:false });
  const statuses = new Set(['payment_required','waiting_payment','proof_received','approved']);
  return rows
    .filter(r => String(r.telegram_id) === String(telegramId))
    .filter(r => statuses.has(String(r.payment_status || '').toLowerCase()) || ['waiting_payment','proof_received','payment_approved','active'].includes(String(r.application_status || '').toLowerCase()))
    .sort((a,b) => Number(b._rowNumber || 0) - Number(a._rowNumber || 0))[0] || null;
}

export async function createOrUpdateApplication(app) {
  const existing = await findApplicationByTelegramEvent(app.telegram_id, app.event_id);
  if (existing) {
    const existingAppStatus = String(existing.application_status || '').toLowerCase();
    const existingPaymentStatus = String(existing.payment_status || '').toLowerCase();
    const protectedAppStatus = ['active','payment_approved','proof_received'].includes(existingAppStatus);
    const protectedPaymentStatus = ['approved','proof_received'].includes(existingPaymentStatus);
    const patch = {
      ...app,
      application_id: existing.application_id || app.application_id,
      submitted_at: existing.submitted_at || app.submitted_at,
      updated_at: nowISO()
    };
    if (protectedAppStatus) patch.application_status = existing.application_status;
    if (protectedPaymentStatus) patch.payment_status = existing.payment_status;
    if (existing.payment_proof_status) patch.payment_proof_status = existing.payment_proof_status;
    if (existing.payment_proof_file_id) patch.payment_proof_file_id = existing.payment_proof_file_id;
    await updateObjectByRow(SHEETS.applications, existing._rowNumber, patch);
    return { ...existing, ...patch, isUpdated:true };
  }
  await appendObject(SHEETS.applications, app);
  return { ...app, isUpdated:false };
}

export async function findApplication(applicationId) {
  const { rows } = await getRows(SHEETS.applications, { useCache:false });
  return rows.find(r => r.application_id === applicationId);
}

export async function updateApplication(applicationId, patch) {
  const { rows } = await getRows(SHEETS.applications, { useCache:false });
  const found = rows.find(r => r.application_id === applicationId);
  if (!found) return null;
  await updateObjectByRow(SHEETS.applications, found._rowNumber, patch);
  return { ...found, ...patch };
}

export async function updateApplicantStatusByTelegramId(telegramId, status) {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, { status, updated_at: nowISO() });
  return { ...found, status };
}

export async function logMessage(row) { return appendObject(SHEETS.messages, row); }
export async function logPayment(row) { return appendObject(SHEETS.payments, row); }
export async function logBroadcast(row) { return appendObject(SHEETS.broadcasts, row); }
export async function logBroadcastResult(row) { return appendObject(SHEETS.broadcastLogs, row); }

export async function updatePayment(paymentId, patch) {
  const { rows } = await getRows(SHEETS.payments, { useCache:false });
  const found = rows.find(r => r.payment_id === paymentId);
  if (!found) return null;
  await updateObjectByRow(SHEETS.payments, found._rowNumber, patch);
  return { ...found, ...patch };
}


function isMissingRatingValue(value='') {
  const rating = String(value || '').trim().toLowerCase();
  return !rating || ['unknown','не знаю','dont know','don\'t know','n/a','na','-'].includes(rating);
}

export function hasMissingRating(row={}) {
  return isMissingRatingValue(row.ntrp || row.racket_rating || '');
}

export async function getMissingRatingContacts() {
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  return rows.filter(r => {
    if (!r.telegram_id) return false;
    if (!hasMissingRating(r)) return false;
    if (['inactive','declined','rejected','refunded'].includes(String(r.status || '').toLowerCase())) return false;
    // Avoid pure language-only leads with no actual profile data.
    return Boolean(r.name || r.telegram_username || r.whatsapp || r.experience || r.country_of_origin || r.gender);
  });
}

export async function getSegmentContacts(segment='all') {
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  return rows.filter(r => {
    if (!r.telegram_id) return false;
    if (segment === 'all') return true;
    if (segment === 'active') return r.status === 'active';
    if (segment === 'waitlist') return r.status === 'waitlist';
    if (segment === 'payment') return ['waiting_payment','proof_received','payment_approved'].includes(r.status);
    if (segment === 'missing_rating') return hasMissingRating(r);
    if (segment === 'missing_selfie') return String(r.status).toLowerCase() === 'active' && String(r.selfie_status || '').toLowerCase() !== 'received';
    if (segment === 'ru') return r.language === 'ru';
    if (segment === 'en') return r.language !== 'ru';
    if (segment === 'season2') return String(r.last_application_event || '').includes('Season 2') || String(r.last_application_event || '').includes('league_s2');
    return String(r.crm_tags || '').includes(segment) || r.status === segment;
  });
}


const POLL_HEADERS = [
  'poll_id','broadcast_id','question','option_1','votes_1','option_2','votes_2','option_3','votes_3','option_4','votes_4','option_5','votes_5','option_6','votes_6','option_7','votes_7','option_8','votes_8','option_9','votes_9','option_10','votes_10','total_votes','sent_count','last_updated','status'
];

function pollPatch({ poll_id, broadcast_id='', question='', options=[], total_votes=0, sent_count='', status='open' }) {
  const patch = { poll_id, broadcast_id, question, total_votes, sent_count, last_updated: nowISO(), status };
  options.slice(0, 10).forEach((o, idx) => {
    patch[`option_${idx+1}`] = o.text || o;
    patch[`votes_${idx+1}`] = o.voter_count ?? o.votes ?? 0;
  });
  return patch;
}

export async function upsertPollResult(row) {
  await ensureSheetWithHeaders(SHEETS.pollResults, POLL_HEADERS, 210001013);
  const { rows } = await getRows(SHEETS.pollResults, { useCache:false });
  const found = rows.find(r => String(r.poll_id) === String(row.poll_id));
  const patch = pollPatch(row);
  if (found) {
    if (!row.broadcast_id) delete patch.broadcast_id;
    if (!row.sent_count) delete patch.sent_count;
    if (!row.question) delete patch.question;
    await updateObjectByRow(SHEETS.pollResults, found._rowNumber, patch);
  }
  else await appendObject(SHEETS.pollResults, patch);
  return patch;
}

export async function findPollResultsByBroadcastId(broadcastId) {
  await ensureSheetWithHeaders(SHEETS.pollResults, POLL_HEADERS, 210001013);
  const { rows } = await getRows(SHEETS.pollResults, { useCache:false });
  return rows.filter(r => String(r.broadcast_id) === String(broadcastId));
}

export function summarizePollRows(rows=[]) {
  const totals = { total_votes:0, options:[] };
  for (let i=1; i<=10; i++) {
    const label = rows.find(r => r[`option_${i}`])?.[`option_${i}`] || '';
    if (!label) continue;
    const votes = rows.reduce((sum,r) => sum + Number(r[`votes_${i}`] || 0), 0);
    totals.options.push({ text: label, votes });
  }
  totals.total_votes = totals.options.reduce((sum,o) => sum + Number(o.votes || 0), 0);
  return totals;
}


export function isProfileCompleted(row={}) {
  const rating = String(row.ntrp || row.racket_rating || '').trim().toLowerCase();
  return Boolean(row.telegram_id && row.name && row.gender && row.country_of_origin && row.experience && row.whatsapp && rating && rating !== 'unknown' && !['inactive','declined','refunded'].includes(String(row.status || '').toLowerCase()));
}

export async function createMatchChallenge(row) {
  await appendObject(SHEETS.matchChallenges, row);
  return row;
}

export async function findMatchChallenge(challengeId) {
  const { rows } = await getRows(SHEETS.matchChallenges, { useCache:false });
  return rows.find(r => r.challenge_id === challengeId);
}

export async function updateMatchChallenge(challengeId, patch) {
  const { rows } = await getRows(SHEETS.matchChallenges, { useCache:false });
  const found = rows.find(r => r.challenge_id === challengeId);
  if (!found) return null;
  await updateObjectByRow(SHEETS.matchChallenges, found._rowNumber, patch);
  return { ...found, ...patch };
}

export async function updateApplicantByTelegramId(telegramId, patch) {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, { ...patch, updated_at: nowISO() });
  return { ...found, ...patch };
}

export async function getAllApplicants() {
  return (await getRows(SHEETS.applicants, { useCache:false })).rows;
}

export async function markSelfieRequested(telegramId) {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;
  const currentCount = Number(found.selfie_reminder_count || 0);
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, {
    selfie_status: found.selfie_status === 'received' ? 'received' : 'requested',
    selfie_requested_at: nowISO(),
    selfie_reminder_count: currentCount + 1,
    updated_at: nowISO()
  });
  return { ...found, selfie_status: found.selfie_status === 'received' ? 'received' : 'requested', selfie_requested_at: nowISO(), selfie_reminder_count: currentCount + 1 };
}

export async function getBotMenuRows(parent='main', language='en'){try{const {rows}=await getRows(SHEETS.botMenu,{useCache:false});const lang=language==='ru'?'ru':'en';return rows.filter(r=>String(r.status||'active').toLowerCase()==='active'&&String(r.parent||'main')===String(parent)&&String(r.language||'en')===lang).sort((a,b)=>Number(a.row||999)-Number(b.row||999)||Number(a.sort_order||999)-Number(b.sort_order||999));}catch(e){return []}}


// ===========================================================================
// МАТЧИ МЕЖДУ ИГРОКАМИ
// Открытое окно: игрок публикует своё свободное время в топик своего дивизиона,
// любой из этого дивизиона может его забрать. Адресный вызов: то же окно, но
// сразу закреплённое за конкретным соперником.
// Обе формы живут в одном листе Match Challenges (колонка match_type).
// ===========================================================================
export async function getCourts() {
  try {
    const { rows } = await getRows(SHEETS.courts, { useCache:false });
    return rows
      .filter(r => (r.name || r.court || r.title) && String(r.status || 'active').toLowerCase() !== 'inactive')
      .map(r => ({
        name: safe(r.name || r.court || r.title),
        area: safe(r.area || r.district || r.location),
        address: safe(r.address),
        // номер для брони в WhatsApp: только цифры, в международном формате
        whatsapp: safe(r.whatsapp || r.phone || r.contact).replace(/[^0-9]/g, ''),
        price: safe(r.price || r.price_thb),
        currency: safe(r.currency) || 'THB',
        notes: safe(r.notes)
      }));
  } catch (e) {
    // Листа Courts может не быть — интерфейс тогда разрешает ввести площадку текстом.
    return [];
  }
}

// Кто игрок в лиге: дивизион и статус из ручной таблицы участников (она — источник
// правды по составам). Сначала пробуем точную привязку по telegram_id, если колонка
// заведена; иначе — сопоставление по имени, как для страниц игроков на сайте.
export async function getPlayerLeagueInfo(profile = {}) {
  const telegramId = String(profile.telegram_id || profile.id || '').trim();
  const name = String(profile.name || '').trim();
  let data;
  try { data = await getManualParticipants(); }
  catch (e) { console.error('league info failed:', e.message); return { found:false, division:'', status:'', matched_by:'' }; }
  const players = data.players || [];

  if (telegramId) {
    const byId = players.find(p => p.telegram_id && String(p.telegram_id) === telegramId);
    if (byId) return { found:true, division: byId.division || '', status: byId.status || '', name: byId.name, matched_by:'telegram_id' };
  }
  if (name) {
    const keys = nameKeys(name);
    const byName = players.find(p => nameKeys(p.name).some(k => keys.includes(k)));
    // Если у строки участника уже проставлен telegram_id и он не наш — это чужая строка,
    // совпало лишь имя. Пускать нельзя.
    if (byName && byName.telegram_id && telegramId && String(byName.telegram_id) !== telegramId) {
      return { found:false, division:'', status:'', matched_by:'name_conflict' };
    }
    if (byName) return { found:true, division: byName.division || '', status: byName.status || '', name: byName.name, matched_by:'name' };
  }
  return { found:false, division:'', status:'', matched_by:'' };
}

export async function getPlayerDivision(profile = {}) {
  return (await getPlayerLeagueInfo(profile)).division;
}

// Доступ к матчам — только у активных игроков текущего состава.
export async function isActiveLeaguePlayer(profile = {}) {
  const info = await getPlayerLeagueInfo(profile);
  return info.found && String(info.status || '').toLowerCase() === 'active' && Boolean(info.division);
}

// Соперники: участники того же дивизиона, у которых есть telegram_id в Applicants.
export async function getDivisionOpponents(division, excludeTelegramId = '') {
  if (!division) return [];
  const [data, { rows: applicants }] = await Promise.all([
    getManualParticipants().catch(() => ({ players: [] })),
    getRows(SHEETS.applicants, { useCache:false })
  ]);
  const byKey = new Map();
  for (const a of applicants) {
    if (!a.telegram_id) continue;
    for (const k of nameKeys(a.name || '')) if (!byKey.has(k)) byKey.set(k, a);
  }
  const out = [];
  for (const p of (data.players || [])) {
    if (p.division !== division) continue;
    if (String(p.status || '').toLowerCase() !== 'active') continue; // вызвать можно только активного
    const hit = (p.telegram_id && applicants.find(a => String(a.telegram_id) === String(p.telegram_id)))
      || nameKeys(p.name).map(k => byKey.get(k)).find(Boolean);
    if (!hit || String(hit.telegram_id) === String(excludeTelegramId)) continue;
    if (out.some(o => String(o.telegram_id) === String(hit.telegram_id))) continue;
    out.push({
      telegram_id: String(hit.telegram_id),
      name: p.name,
      username: hit.telegram_username || '',
      rating: p.rating || '',
      status: p.status || '',
      profile_url: p.profile_url || '',
      photo_url: p.photo_url || ''
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity:'base' }));
}
