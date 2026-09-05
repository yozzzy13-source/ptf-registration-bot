// Создаёт лист Courts со списком площадок для окон матчей.
// Запуск один раз: npm run setup:courts
// Дальше список правится руками прямо в таблице — деплой не нужен.
import { sheets as sheetsClient } from '../google.js';
import { SPREADSHEET_ID, SHEETS } from '../config.js';

const HEADERS = ['name', 'area', 'address', 'whatsapp', 'price', 'currency', 'status', 'notes'];
// whatsapp — номер площадки в международном формате без плюса (например 66812345678),
// именно он подставляется в ссылку брони. Пустой номер = кнопка брони не появится.
const SEED = [
  ['Thanyapura', 'Thalang', '', '', '500', 'THB', 'active', 'Хардовые корты, есть освещение'],
  ['Laguna Tennis', 'Bang Tao', '', '', '400', 'THB', 'active', ''],
  ['Phuket Country Club', 'Kathu', '', '', '350', 'THB', 'active', '']
];

async function main() {
  const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(s => s.properties?.title === SHEETS.courts);
  if (!exists) {
    await sheetsClient().spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEETS.courts, gridProperties: { rowCount: 200, columnCount: 8, frozenRowCount: 1 } } } }] }
    });
  }
  const current = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEETS.courts}'!A:H` }).catch(() => ({ data: {} }));
  const values = current.data?.values || [];
  if (!values.length) {
    await sheetsClient().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEETS.courts}'!A1:H${SEED.length + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS, ...SEED] }
    });
    console.log(`Лист «${SHEETS.courts}» создан и заполнен примерами. Отредактируйте список площадок в таблице.`);
    return;
  }
  console.log(`Лист «${SHEETS.courts}» уже существует — строки не тронуты. Колонки: ${HEADERS.join(' | ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
