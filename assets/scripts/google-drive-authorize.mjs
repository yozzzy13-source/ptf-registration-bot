import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';

const credentialPath = process.argv[2];
const spreadsheetId = process.env.SPREADSHEET_ID || '1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig';
const port = Number(process.env.GOOGLE_DRIVE_OAUTH_PORT || 53682);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

if (!credentialPath) {
  console.error('Usage: npm run drive:authorize -- C:\\path\\to\\desktop-oauth-client.json');
  process.exit(1);
}

const raw = JSON.parse(await readFile(credentialPath, 'utf8'));
const client = raw.installed || raw.web || raw;
if (!client.client_id || !client.client_secret) {
  throw new Error('The file does not contain a Google OAuth client_id and client_secret.');
}

const auth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
const scopes = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets'
];
const authUrl = auth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: true,
  scope: scopes
});

function bangkokIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+07:00`;
}

async function ensureRootFolder() {
  const drive = google.drive({ version: 'v3', auth });
  const name = 'PTF Match Cards Archive';
  const escaped = name.replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive', fields: 'files(id,name,webViewLink)', pageSize: 10
  });
  if (found.data.files?.[0]) return found.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id,name,webViewLink'
  });
  return created.data;
}

async function saveFolderSetting(folderId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const range = 'Settings!A:D';
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = current.data.values || [];
  const rowIndex = rows.findIndex(row => String(row?.[0] || '').trim() === 'match_cards_drive_folder_id');
  const values = [[
    'match_cards_drive_folder_id',
    folderId,
    'Google Drive folder for Active and Instagram match card archive.',
    bangkokIso()
  ]];
  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Settings!A${rowIndex + 1}:D${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', redirectUri);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error') || 'Google did not return an authorization code.');
    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke the old grant and run the command again.');
    auth.setCredentials(tokens);
    const folder = await ensureRootFolder();
    await saveFolderSetting(folder.id);
    const runtimeCredentials = JSON.stringify({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('PTF Match Cards Archive connected. You may close this tab.');
    console.log('\nConnected successfully.');
    console.log(`Folder: ${folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`}`);
    console.log('Settings!match_cards_drive_folder_id was updated automatically.');
    console.log('\nAdd this single variable to Railway and restart the service:');
    console.log(`GOOGLE_DRIVE_OAUTH_CREDENTIALS=${runtimeCredentials}`);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Connection failed: ${error.message}`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Open this URL in your browser and sign in as the Google Drive owner:\n');
  console.log(authUrl);
  console.log(`\nWaiting for Google at ${redirectUri}`);
});