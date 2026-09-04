import { sheets as sheetsClient } from './google.js';
import { SPREADSHEET_ID, SHEETS } from './config.js';
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
  const enriched = [];
  for (const ev of events) {
    const players = await getEventPlayers(ev);
    enriched.push({ ...ev, applications_count: players.length, players_count: players.length });
  }
  return enriched;
}


export async function ensureApplicantAdminColumns() {
  return ensureSheetWithHeaders(SHEETS.applicants, ['admin_topic_id','admin_topic_name','admin_topic_created_at']);
}

export async function findApplicantByAdminTopicId(topicId) {
  await ensureApplicantAdminColumns();
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  return rows.find(r => String(r.admin_topic_id || '') === String(topicId));
}

export async function updateApplicantAdminTopic(telegramId, patch) {
  await ensureApplicantAdminColumns();
  const found = await findApplicantByTelegramId(telegramId);
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
