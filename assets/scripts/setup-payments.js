import { sheets as sheetsClient } from '../google.js';
import { SPREADSHEET_ID, SHEETS } from '../config.js';

const PAYMENT_SUMMARY_TITLE = 'Payment Summary';
const PAYMENT_SUMMARY_SHEET_ID = 210001012;

async function valuesUpdate(range, values) {
  await sheetsClient().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
}

async function metadata() {
  const res = await sheetsClient().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return res.data;
}

async function ensurePaymentSummarySheet() {
  const meta = await metadata();
  const exists = meta.sheets?.some(s => s.properties?.title === PAYMENT_SUMMARY_TITLE);
  if (exists) return;
  await sheetsClient().spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { sheetId: PAYMENT_SUMMARY_SHEET_ID, title: PAYMENT_SUMMARY_TITLE, index: 12, gridProperties: { rowCount: 80, columnCount: 8, frozenRowCount: 1 } } } }] }
  });
}

async function main() {
  await ensurePaymentSummarySheet();

  await valuesUpdate(`'${SHEETS.paymentMethods}'!A1:L5`, [
    ['method_id','method_type','display_name_en','display_name_ru','status','currency','network','recipient','qr_file_id','instructions_en','instructions_ru','notes'],
    ['thai_bank','bank','Thai bank transfer','Перевод на тайский банк','active','THB','','Bangkok Bank 766-0-177366','','Transfer to the Thai bank account shown below and upload a payment screenshot.','Сделайте перевод на указанный тайский банковский счёт и загрузите скриншот оплаты.','Edit recipient to change bank account without redeploy.'],
    ['crypto_usdt_bep20','crypto','USDT BEP20','USDT BEP20','active','USDT','BEP20','0xc93e61979a6a151207094c305c01de5c5e77e0f5','','Choose this network only if your wallet supports BEP20. Upload a payment screenshot after sending.','Выбирайте эту сеть только если ваш кошелёк поддерживает BEP20. После отправки загрузите скриншот оплаты.','Active USDT network.'],
    ['crypto_usdt_trc20','crypto','USDT TRC20','USDT TRC20','active','USDT','TRC20','TE5XrUeZUZGN7286pXXFw9dsFf8tQWjVPZ','','Choose this network only if your wallet supports TRC20. Upload a payment screenshot after sending.','Выбирайте эту сеть только если ваш кошелёк поддерживает TRC20. После отправки загрузите скриншот оплаты.','Active USDT network.'],
    ['crypto_usdt_erc20','crypto','USDT ERC20','USDT ERC20','active','USDT','ERC20','0xc93e61979a6a151207094c305c01de5c5e77e0f5','','Choose this network only if your wallet supports ERC20. Upload a payment screenshot after sending.','Выбирайте эту сеть только если ваш кошелёк поддерживает ERC20. После отправки загрузите скриншот оплаты.','Active USDT network.']
  ]);

  await valuesUpdate(`'${PAYMENT_SUMMARY_TITLE}'!A1:B12`, [
    ['Metric','Value'],
    ['Payment required / waiting','=COUNTIF(Applications!I:I,"payment_required")+COUNTIF(Applications!I:I,"waiting_payment")'],
    ['Proof received / needs review','=COUNTIF(Applications!I:I,"proof_received")'],
    ['Approved payments','=COUNTIF(Applications!I:I,"approved")'],
    ['Rejected payments','=COUNTIF(Applications!I:I,"rejected")'],
    ['Not required','=COUNTIF(Applications!I:I,"not_required")'],
    ['Approved THB amount','=SUMIFS(Payments!I:I,Payments!J:J,"THB",Payments!L:L,"approved")'],
    ['Approved USDT amount','=SUMIFS(Payments!I:I,Payments!J:J,"USDT",Payments!L:L,"approved")'],
    ['Proofs in Payments','=COUNTIF(Payments!L:L,"proof_received")'],
    ['Approved rows in Payments','=COUNTIF(Payments!L:L,"approved")'],
    ['Rejected rows in Payments','=COUNTIF(Payments!L:L,"rejected")'],
    ['Last updated', new Date().toISOString()]
  ]);

  await sheetsClient().spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [
      { repeatCell: { range: { sheetId: PAYMENT_SUMMARY_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.78, blue: 0.55 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
      { autoResizeDimensions: { dimensions: { sheetId: PAYMENT_SUMMARY_SHEET_ID, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 } } }
    ] }
  });

  console.log('Payment Methods and Payment Summary configured.');
}

main().catch(err => { console.error(err); process.exit(1); });
