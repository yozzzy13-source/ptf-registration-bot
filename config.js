export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const PORT = Number(process.env.PORT || 3000);
export const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig';
export const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '';
export const CLUB_CHAT_URL = process.env.CLUB_CHAT_URL || 'https://t.me/+mEkZr6wcpko4NmUy';
export const DEFAULT_USDT_AMOUNT = Number(process.env.DEFAULT_USDT_AMOUNT || 80);
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
export const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
export const ADMIN_CRM_CHAT_ID = process.env.ADMIN_CRM_CHAT_ID || '';
export const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 700);
export const RESULTS_BROADCAST_ENABLED = (process.env.RESULTS_BROADCAST_ENABLED || 'true') === 'true';
export const RESULTS_BROADCAST_DELAY_MS = Number(process.env.RESULTS_BROADCAST_DELAY_MS || 700);
export const RESULTS_MEDIA_PAIR_WINDOW_MS = Number(process.env.RESULTS_MEDIA_PAIR_WINDOW_MS || 180000);
export const RESULTS_MEDIA_WAIT_MS = Number(process.env.RESULTS_MEDIA_WAIT_MS || 120000);
export const RESULTS_WEBSITE_BASE_URL = (process.env.RESULTS_WEBSITE_BASE_URL || 'https://www.phukettennis.com').replace(/\/$/, '');
export const SHEETS = { applicants:'Applicants', leads:'Leads', events:'Events', applications:'Applications', messages:'Messages', broadcasts:'Broadcasts', broadcastLogs:'Broadcast Logs', resultBroadcastLogs:'Result Broadcast Logs', settings:'Settings', botTexts:'Bot Texts', payments:'Payments', paymentMethods:'Payment Methods', matchChallenges:'Match Challenges', botMenu:'Bot Menu' };

export const RESULTS = {
  sheetId: process.env.RESULTS_SHEET_ID || '1tisUxFOJZgaD95o8cQKSvWpH8ySY-ht3H4wdHCeCI0Q',
  localTimezone: process.env.RESULTS_TIMEZONE || process.env.LOCAL_TIMEZONE || 'Asia/Bangkok',
  targetChatId: Number(process.env.RESULTS_CHAT_ID || '-1003636628710'),
  targetTopicId: Number(process.env.RESULTS_TOPIC_ID || '5'),
  confirmInTopic: (process.env.RESULTS_CONFIRM_IN_TOPIC || 'true') === 'true',
  logSheetName: process.env.RESULTS_LOG_SHEET_NAME || 'Cross_Division_Match_Log',
  masterSheetName: process.env.RESULTS_MASTER_SHEET_NAME || 'Players_Master',
  debugSheetName: process.env.RESULTS_DEBUG_SHEET_NAME || 'Debug_Log',
  aliasesSheetName: process.env.RESULTS_ALIASES_SHEET_NAME || 'Player_Aliases',
  seasonName: process.env.RESULTS_SEASON_NAME || 'Season 1',
  defaultStage: process.env.RESULTS_DEFAULT_STAGE || 'Group Stage',
  websiteBaseUrl: RESULTS_WEBSITE_BASE_URL,
  playerProfilesSpreadsheetId: process.env.RESULTS_PLAYER_PROFILES_SPREADSHEET_ID || '1CZ2-B09kIxegOK1lYVl0KBucjbxxp1ZukMD0t1QQCiY',
  playerProfilesSheetName: process.env.RESULTS_PLAYER_PROFILES_SHEET_NAME || 'Frontend_Profile_All',
  divisionUrls: {
    A: process.env.RESULTS_DIVISION_A_URL || `${RESULTS_WEBSITE_BASE_URL}/division-a`,
    B: process.env.RESULTS_DIVISION_B_URL || `${RESULTS_WEBSITE_BASE_URL}/division-b`,
    C: process.env.RESULTS_DIVISION_C_URL || `${RESULTS_WEBSITE_BASE_URL}/division-c`,
    D: process.env.RESULTS_DIVISION_D_URL || `${RESULTS_WEBSITE_BASE_URL}/division-d`
  },
  divisionSpreadsheets: {
    A: { spreadsheetId: process.env.RESULTS_DIVISION_A_SPREADSHEET_ID || process.env.DIVISION_A_SPREADSHEET_ID || '', sheetName: 'Match_Log' },
    B: { spreadsheetId: process.env.RESULTS_DIVISION_B_SPREADSHEET_ID || process.env.DIVISION_B_SPREADSHEET_ID || '', sheetName: 'Match_Log' },
    C: { spreadsheetId: process.env.RESULTS_DIVISION_C_SPREADSHEET_ID || process.env.DIVISION_C_SPREADSHEET_ID || '', sheetName: 'Match_Log' },
    D: { spreadsheetId: process.env.RESULTS_DIVISION_D_SPREADSHEET_ID || process.env.DIVISION_D_SPREADSHEET_ID || '', sheetName: 'Match_Log' }
  }
};
