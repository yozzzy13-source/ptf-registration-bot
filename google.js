import { google } from 'googleapis';
import { GOOGLE_CREDENTIALS } from './config.js';

let sheetsClient = null;

function getAuth() {
  if (!GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS env is empty');
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

export function sheets() {
  if (!sheetsClient) sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
  return sheetsClient;
}
