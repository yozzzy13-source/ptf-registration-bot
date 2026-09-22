// Создаёт лист Courts в ТАБЛИЦЕ МАТЧЕЙ (MATCHES_SPREADSHEET_ID).
// Запуск один раз: npm run setup:courts
// Дальше список площадок правится руками прямо в таблице — деплой не нужен.
//
// Колонки: name — короткое название (оно попадает в выбор при создании заявки),
// address — адрес для сообщения о броне, whatsapp — номер площадки (можно с пробелами,
// бот оставит только цифры). Цены и депозиты добавим сюда же, когда подключим оплату.
import { sheets as sheetsClient } from '../google.js';
import { MATCHES_SPREADSHEET_ID, MATCH_SHEETS } from '../config.js';

const HEADERS = ['name', 'address', 'whatsapp'];

async function main() {
  if (!MATCHES_SPREADSHEET_ID) throw new Error('MATCHES_SPREADSHEET_ID не задан');
  const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: MATCHES_SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(s => s.properties?.title === MATCH_SHEETS.courts);
  if (!exists) {
    await sheetsClient().spreadsheets.batchUpdate({
      spreadsheetId: MATCHES_SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: MATCH_SHEETS.courts, gridProperties: { rowCount: 200, columnCount: 6, frozenRowCount: 1 } } } }] }
    });
  }
  const current = await sheetsClient().spreadsheets.values.get({ spreadsheetId: MATCHES_SPREADSHEET_ID, range: `'${MATCH_SHEETS.courts}'!A:C` }).catch(() => ({ data: {} }));
  if (!(current.data?.values || []).length) {
    await sheetsClient().spreadsheets.values.update({
      spreadsheetId: MATCHES_SPREADSHEET_ID,
      range: `'${MATCH_SHEETS.courts}'!A1:C1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] }
    });
    console.log(`Лист «${MATCH_SHEETS.courts}» создан. Заполните строки: ${HEADERS.join(' | ')}`);
    return;
  }
  console.log(`Лист «${MATCH_SHEETS.courts}» уже существует — строки не тронуты. Нужные колонки: ${HEADERS.join(' | ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
