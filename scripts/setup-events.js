import { sheets as sheetsClient } from '../google.js';
import { SPREADSHEET_ID, SHEETS } from '../config.js';

const EXTRA_HEADERS = [
  'card_badges_en',
  'card_badges_ru',
  'status_label_en',
  'status_label_ru',
  'start_label_en',
  'start_label_ru',
  'end_label_en',
  'end_label_ru',
  'duration_label_en',
  'duration_label_ru',
  'venue_en',
  'venue_ru',
  'show_price',
  'payment_enabled',
  'selectable'
];

async function valuesGet(range) {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}
async function valuesUpdate(range, values) {
  await sheetsClient().spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', requestBody: { values } });
}
function colToA1(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}
async function ensureEventHeaders() {
  const values = await valuesGet(`'${SHEETS.events}'!A1:AZ`);
  const headers = values[0] || [];
  const merged = [...headers];
  for (const h of EXTRA_HEADERS) if (!merged.includes(h)) merged.push(h);
  await valuesUpdate(`'${SHEETS.events}'!A1:${colToA1(merged.length)}1`, [merged]);
  return merged;
}
async function upsertLeagueSeason2(headers) {
  const values = await valuesGet(`'${SHEETS.events}'!A1:AZ`);
  const rows = values.slice(1);
  let idx = rows.findIndex(r => String(r[0] || '') === 'league_s2');
  if (idx < 0) idx = rows.length;
  const row = new Array(headers.length).fill('');
  const set = (key, value) => { const i = headers.indexOf(key); if (i >= 0) row[i] = value; };
  set('event_id','league_s2');
  set('event_name_en','League Season 2');
  set('event_name_ru','League Season 2');
  set('event_type','league');
  set('status','active');
  set('start_date','2026-08-20');
  set('end_date','2026-10-20');
  set('price_thb','2490');
  set('currency','THB');
  set('description_en','Applications are open for League Season 2. Final spots will be confirmed after registration closes. Priority goes to players with previous PTF experience.');
  set('description_ru','Открыт приём заявок во Второй сезон. Финальное количество мест определим после завершения регистрации. Приоритет получают игроки с предыдущим опытом участия в PTF.');
  set('registration_deadline','');
  set('sort_order','1');
  set('notes','Edit this row to change the event card in the WebApp.');
  set('card_badges_en','Registration open | Limited spots | Start: mid–late August | 2 months');
  set('card_badges_ru','Открыта регистрация | Limited spots | Старт: середина–конец августа | 2 месяца');
  set('status_label_en','Registration open');
  set('status_label_ru','Открыта регистрация');
  set('start_label_en','Start: mid–late August');
  set('start_label_ru','Старт: середина–конец августа');
  set('duration_label_en','2 months');
  set('duration_label_ru','2 месяца');
  set('venue_en','');
  set('venue_ru','');
  set('show_price','yes');
  set('payment_enabled','yes');
  set('selectable','yes');
  await valuesUpdate(`'${SHEETS.events}'!A${idx+2}:${colToA1(headers.length)}${idx+2}`, [row]);
}
async function main() {
  const headers = await ensureEventHeaders();
  await upsertLeagueSeason2(headers);
  console.log('Events sheet prepared. Edit Events row league_s2 to control the WebApp event card.');
}
main().catch(err => { console.error(err); process.exit(1); });
