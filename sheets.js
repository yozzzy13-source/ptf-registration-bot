import { sheets as sheetsClient } from './google.js';
import { SPREADSHEET_ID, SHEETS } from './config.js';
import { langOf, nowISO, safe } from './util.js';

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

async function ensureHeaders(sheetName, requiredHeaders=[]) {
  const { headers } = await getRows(sheetName, { useCache:false });
  const missing = requiredHeaders.filter(h => h && !headers.includes(h));
  if (!missing.length) return headers;

  const nextHeaders = headers.concat(missing);
  const endCol = colToA1(nextHeaders.length);
  await valuesUpdate(`'${sheetName}'!A1:${endCol}1`, [nextHeaders]);
  cache.clear();
  return nextHeaders;
}

export async function getRows(sheetName, { useCache=true } = {}) {
  const key = `rows:${sheetName}`;
  const c = cache.get(key);
  if (useCache && c && Date.now() - c.t < CACHE_MS) return c.v;
  const values = await valuesGet(`'${sheetName}'!A:AZ`);
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
  await valuesAppend(`'${sheetName}'!A:AZ`, [row]);
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
    .filter(r => ['active','waitlist','live'].includes(safe(r.status)))
    .sort((a,b) => Number(a.sort_order || 999) - Number(b.sort_order || 999));
}

export async function getPaymentMethods() {
  const { rows } = await getRows(SHEETS.paymentMethods, { useCache:false });
  return rows.filter(r => safe(r.status) === 'active');
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

export async function upsertLeadFromTelegramUser(user={}, source='bot_start') {
  if (!user?.id) return null;

  const existing = await findApplicantByTelegramIdentity(user);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const username = String(user.username || existing?.telegram_username || '').replace(/^@/, '');
  const now = nowISO();

  const patch = {
    telegram_id: user.id,
    telegram_username: username,
    telegram: username ? `t.me/${username}` : existing?.telegram || '',
    language: existing?.language || langOf(user.language_code),
    source: existing?.source || source,
    updated_at: now,
    last_seen_at: now,
    crm_tags: existing?.crm_tags || 'bot_started',
    profile_completed: existing?.profile_completed || 'no'
  };

  if (!existing?.name && fullName) patch.name = fullName;

  await ensureHeaders(SHEETS.applicants, Object.keys(patch).concat([
    'first_seen_at',
    'last_seen_at',
    'profile_completed'
  ]));

  if (existing) {
    await updateObjectByRow(SHEETS.applicants, existing._rowNumber, patch);
    return { ...existing, ...patch, isNew:false };
  }

  const newRow = {
    date: now,
    created_at: now,
    first_seen_at: now,
    name: fullName,
    status: 'lead',
    division: 'pending',
    ntrp: '',
    experience: '',
    gender: '',
    age: '',
    country_of_origin: '',
    whatsapp: '',
    notes: '',
    last_application_event: '',
    selfie_status: 'optional_missing',
    selfie_file_id: '',
    application_count: 0,
    allow_match_challenges: 'yes',
    player_profile_url: '',
    ...patch
  };

  await appendObject(SHEETS.applicants, newRow);
  return { ...newRow, isNew:true };
}

export async function openAdminChatByTelegramId(telegramId, source='admin_outbound', admin={}) {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;

  const patch = {
    chat_status: 'open',
    chat_source: source,
    chat_opened_at: found.chat_status === 'open' && found.chat_opened_at ? found.chat_opened_at : nowISO(),
    chat_last_admin_contact_at: nowISO(),
    chat_admin_id: admin.id || '',
    chat_admin_name: admin.name || ''
  };

  await ensureHeaders(SHEETS.applicants, Object.keys(patch));
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, patch);
  return { ...found, ...patch };
}

export async function closeAdminChatByTelegramId(telegramId, source='user_navigation') {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;

  const patch = {
    chat_status: 'closed',
    chat_closed_at: nowISO(),
    chat_closed_by: source
  };

  await ensureHeaders(SHEETS.applicants, Object.keys(patch));
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, patch);
  return { ...found, ...patch };
}

export async function isAdminChatOpenByTelegramId(telegramId) {
  const found = await findApplicantByTelegramId(telegramId);
  return String(found?.chat_status || '').toLowerCase() === 'open';
}

export async function setAdminTopicByTelegramId(telegramId, patch={}) {
  const found = await findApplicantByTelegramId(telegramId);
  if (!found) return null;

  const safePatch = {
    admin_topic_id: patch.admin_topic_id || found.admin_topic_id || '',
    admin_topic_name: patch.admin_topic_name || found.admin_topic_name || '',
    admin_topic_chat_id: patch.admin_topic_chat_id || found.admin_topic_chat_id || '',
    admin_topic_created_at: patch.admin_topic_created_at || found.admin_topic_created_at || nowISO(),
    admin_topic_last_used_at: nowISO()
  };

  await ensureHeaders(SHEETS.applicants, Object.keys(safePatch));
  await updateObjectByRow(SHEETS.applicants, found._rowNumber, safePatch);
  return { ...found, ...safePatch };
}

export async function findApplicantByAdminTopic(topicId, chatId='') {
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  const tid = String(topicId || '');
  const cid = String(chatId || '');

  return rows.find(r => {
    if (String(r.admin_topic_id || '') !== tid) return false;
    if (!cid || !r.admin_topic_chat_id) return true;
    return String(r.admin_topic_chat_id) === cid;
  });
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
    language: profile.language,
    source: profile.source || 'registration_bot',
    updated_at: nowISO(),
    last_application_event: profile.last_application_event,
    selfie_status: profile.selfie_status || existing?.selfie_status || 'optional_missing',
    selfie_file_id: profile.selfie_file_id || existing?.selfie_file_id || '',
    crm_tags: profile.crm_tags || existing?.crm_tags || 'league_interested',
    application_count: Number(existing?.application_count || 0) + 1,
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

function cleanTelegramId(v) {
  const s = String(v || '').trim();
  return /^\d+$/.test(s) ? s : '';
}

function mergeContact(map, source, row={}) {
  const telegramId = cleanTelegramId(row.telegram_id);
  if (!telegramId) return;

  const existing = map.get(telegramId) || { telegram_id: telegramId, sources: [] };
  const name = row.name || row.player_name || existing.name || '';
  const username = row.telegram_username || existing.telegram_username || '';
  const status = row.status || row.application_status || existing.status || '';
  const division = row.division || existing.division || '';
  const language = row.language || existing.language || '';
  const selfieStatus = row.selfie_status || existing.selfie_status || '';
  const lastEvent = row.last_application_event || row.event_name || existing.last_application_event || '';
  const country = row.country_of_origin || existing.country_of_origin || '';
  const whatsapp = row.whatsapp || existing.whatsapp || '';
  const crmTags = row.crm_tags || existing.crm_tags || '';

  map.set(telegramId, {
    ...existing,
    name,
    telegram_username: username,
    status,
    division,
    language,
    selfie_status: selfieStatus,
    last_application_event: lastEvent,
    country_of_origin: country,
    whatsapp,
    crm_tags: crmTags,
    sources: existing.sources.includes(source) ? existing.sources : existing.sources.concat(source)
  });
}

export async function getBroadcastContacts() {
  const map = new Map();

  const applicants = (await getRows(SHEETS.applicants, { useCache:false })).rows;
  applicants.forEach(r => mergeContact(map, 'Applicants', r));

  const applications = (await getRows(SHEETS.applications, { useCache:false })).rows;
  applications.forEach(r => mergeContact(map, 'Applications', r));

  const messages = (await getRows(SHEETS.messages, { useCache:false })).rows;
  messages.forEach(r => mergeContact(map, 'Messages', r));

  const broadcastLogs = (await getRows(SHEETS.broadcastLogs, { useCache:false })).rows;
  broadcastLogs.forEach(r => mergeContact(map, 'Broadcast Logs', r));

  return [...map.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function getSegmentContacts(segment='all') {
  const rows = await getBroadcastContacts();
  return rows.filter(r => {
    if (!r.telegram_id) return false;
    if (segment === 'all') return true;
    if (segment === 'active') return r.status === 'active';
    if (segment === 'waitlist') return r.status === 'waitlist';
    if (segment === 'payment') return ['waiting_payment','proof_received','payment_approved'].includes(r.status);
    if (segment === 'missing_selfie') return String(r.status).toLowerCase() === 'active' && String(r.selfie_status || '').toLowerCase() !== 'received';
    if (segment === 'ru') return r.language === 'ru';
    if (segment === 'en') return r.language !== 'ru';
    if (segment === 'season2') return String(r.last_application_event || '').includes('Season 2') || String(r.last_application_event || '').includes('league_s2');
    return String(r.crm_tags || '').includes(segment) || r.status === segment;
  });
}


export function isProfileCompleted(row={}) {
  return Boolean(row.telegram_id && row.name && row.gender && row.country_of_origin && row.experience && row.whatsapp && !['inactive','declined','refunded'].includes(String(row.status || '').toLowerCase()));
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
