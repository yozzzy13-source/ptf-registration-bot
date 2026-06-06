export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const PORT = Number(process.env.PORT || 3000);
export const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig';
export const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '';
export const CLUB_CHAT_URL = process.env.CLUB_CHAT_URL || 'https://t.me/+mEkZr6wcpko4NmUy';
export const DEFAULT_USDT_AMOUNT = Number(process.env.DEFAULT_USDT_AMOUNT || 80);
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
export const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const SHEETS = {
  applicants: 'Applicants',
  events: 'Events',
  applications: 'Applications',
  messages: 'Messages',
  broadcasts: 'Broadcasts',
  broadcastLogs: 'Broadcast Logs',
  settings: 'Settings',
  botTexts: 'Bot Texts',
  payments: 'Payments',
  paymentMethods: 'Payment Methods'
};
