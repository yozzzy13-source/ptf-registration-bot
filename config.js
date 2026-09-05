export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const PORT = Number(process.env.PORT || 3000);
export const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig';
export const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '';
export const CLUB_CHAT_URL = process.env.CLUB_CHAT_URL || 'https://t.me/+mEkZr6wcpko4NmUy';
export const DEFAULT_USDT_AMOUNT = Number(process.env.DEFAULT_USDT_AMOUNT || 80);
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
export const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
export const SHEETS = { applicants:'Applicants', events:'Events', applications:'Applications', messages:'Messages', broadcasts:'Broadcasts', broadcastLogs:'Broadcast Logs', settings:'Settings', botTexts:'Bot Texts', payments:'Payments', paymentMethods:'Payment Methods', matchChallenges:'Match Challenges', courts:'Courts', botMenu:'Bot Menu', pollResults:'Poll Results' };
export const PARTICIPANTS_SPREADSHEET_ID = process.env.PARTICIPANTS_SPREADSHEET_ID || process.env.MANUAL_PARTICIPANTS_SPREADSHEET_ID || '161O5DWEJU-ik3XoDaUjWeTlm7T2Je98IFd_-DFhRBu8';
export const PARTICIPANTS_SHEET_ID = process.env.PARTICIPANTS_SHEET_ID || process.env.MANUAL_PARTICIPANTS_SHEET_ID || '1662536073';
export const WEBSITE_URL = (process.env.WEBSITE_URL || 'https://www.phukettennis.com').replace(/\/$/, '');
// Website backend (read-only): sheet with Player ID / Player Name / Profile URL columns.
export const WEBSITE_SPREADSHEET_ID = process.env.WEBSITE_SPREADSHEET_ID || '1CZ2-B09kIxegOK1lYVl0KBucjbxxp1ZukMD0t1QQCiY';
export const WEBSITE_PLAYERS_SHEET_ID = process.env.WEBSITE_PLAYERS_SHEET_ID || '1001';
// Лиговая супергруппа с топиками по дивизионам — туда падают открытые окна матчей.
// Если не задана, окна уходят в админский чат (чтобы ничего не терялось на этапе настройки).
// Отдельная таблица под матчи: заявки и журнал лиги живут вне основной таблицы PTF.
export const MATCHES_SPREADSHEET_ID = process.env.MATCHES_SPREADSHEET_ID || '';
export const MATCH_SHEETS = { slots:'Match Slots', log:'Match Log' };
export const LEAGUE_CHAT_ID = process.env.LEAGUE_CHAT_ID || '';
export const MATCH_HORIZON_DAYS = Number(process.env.MATCH_HORIZON_DAYS || 21);
