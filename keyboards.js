import { inlineKeyboard, webAppButton, urlButton, clubChatButton } from './telegram.js';
import { t } from './i18n.js';
import { PUBLIC_URL } from './config.js';


// Единственное место, где проверяется лимит Telegram на callback_data.
// Молча обрезать нельзя — кнопка перестанет работать, поэтому громко пишем в лог.
export function cb(data) {
  const s = String(data);
  if (Buffer.byteLength(s, 'utf8') > 64) console.error(`callback_data > 64 bytes (${Buffer.byteLength(s,'utf8')}): ${s}`);
  return s;
}

export function languageKeyboard() { return inlineKeyboard([[{text:'🇷🇺 Русский',callback_data:'lang_select:ru'},{text:'🇬🇧 English',callback_data:'lang_select:en'}]]); }

// Кнопки web_app Telegram принимает только в личке. В группе такая клавиатура
// возвращает BUTTON_TYPE_INVALID и сообщение не уходит вовсе, поэтому там же
// показываем обычные ссылки на бота.
export function mainKeyboard(lang, opts={}) {
  const app = opts.noWebApp
    ? (text, path) => urlButton(text, `https://t.me/${(opts.botUsername || 'PTF1_BOT').replace(/^@/,'')}`)
    : webAppButton;
  return inlineKeyboard([
  [app(t(lang,'join_event'),'/apply?mode=event')],
  ...(opts.matches ? [[app(t(lang,'matches'),'/match')]] : []),
  [app(t(lang,'participants'),'/participants')],
  [app(t(lang,'league'),'/league')],
  [{text:t(lang,'how'),callback_data:'text:how_league_works'}],
  [{text:t(lang,'yearly'),callback_data:'text:yearly_race'},{text:t(lang,'pass'),callback_data:'payment_entry'}],
  [{text:t(lang,'contact'),callback_data:'contact'}]
]); }
export function textKeyboard(lang,key,opts={}) { const app=opts.noWebApp?((text)=>urlButton(text,`https://t.me/${(opts.botUsername||'PTF1_BOT').replace(/^@/,'')}`)):webAppButton; const rows=[[app(t(lang,'join_event'),'/apply?mode=event')],[app(t(lang,'participants'),'/participants')]]; if(key!=='how_league_works') rows.push([{text:t(lang,'how'),callback_data:'text:how_league_works'}]); if(key!=='yearly_race') rows.push([{text:t(lang,'yearly'),callback_data:'text:yearly_race'}]); rows.push([app(t(lang,'league'),'/league')]); rows.push([{text:t(lang,'contact'),callback_data:'contact'},{text:t(lang,'back'),callback_data:'main'}]); return inlineKeyboard(rows); }
export function contactOpenKeyboard(lang) { return inlineKeyboard([[{text:t(lang,'main_menu'),callback_data:'main'},{text:t(lang,'close_chat'),callback_data:'close_contact'}]]); }
export function paymentKeyboard(lang, applicationId) { return inlineKeyboard([[{text:t(lang,'bank'),callback_data:`pay:${applicationId}:thai_bank`}],[{text:t(lang,'crypto'),callback_data:`crypto:${applicationId}`}],[{text:t(lang,'pay_later'),callback_data:`paylater:${applicationId}`}],[{text:t(lang,'call_admin'),callback_data:'contact'}]]); }
export function cryptoKeyboard(lang, applicationId, methods=[]) {
  const rows = methods
    .filter(m => String(m.method_type || '').toLowerCase() === 'crypto' && String(m.currency || '').toUpperCase() === 'USDT' && String(m.status || 'active').toLowerCase() === 'active')
    .map(m => [{ text: m[lang === 'ru' ? 'display_name_ru' : 'display_name_en'] || `USDT ${m.network || ''}`.trim(), callback_data: `pay:${applicationId}:${m.method_id}` }]);
  if (!rows.length) rows.push([{ text:'USDT TRC20', callback_data:`pay:${applicationId}:crypto_usdt_trc20` }], [{ text:'USDT ERC20', callback_data:`pay:${applicationId}:crypto_usdt_erc20` }]);
  rows.push([{text:t(lang,'back'),callback_data:`payment_menu:${applicationId}`}]);
  return inlineKeyboard(rows);
}
export function paymentEntryKeyboard(lang, { hasProfile=false, applicationId='', status='' } = {}) {
  if (!hasProfile) return inlineKeyboard([[webAppButton(t(lang,'join'),'/apply?mode=profile')],[{text:t(lang,'back'),callback_data:'main'}]]);
  if (applicationId && ['payment_required','waiting_payment',''].includes(String(status || '').toLowerCase())) return inlineKeyboard([[{text:t(lang,'pay_now'),callback_data:`payment_menu:${applicationId}`}],[{text:t(lang,'join_event'),web_app:{url:`${PUBLIC_URL}/apply?mode=event`}}],[{text:t(lang,'back'),callback_data:'main'}]]);
  return inlineKeyboard([[webAppButton(t(lang,'join_event'),'/apply?mode=event')],[{text:t(lang,'back'),callback_data:'main'}]]);
}
export function adminApplicationKeyboard(applicationId, telegramId) { return inlineKeyboard([[{text:'✅ Set Active',callback_data:`admin_status:${applicationId}:active`},{text:'⏳ Waitlist',callback_data:`admin_status:${applicationId}:waitlist`}],[{text:'❌ Reject',callback_data:`admin_status:${applicationId}:rejected`},{text:'💬 Message',callback_data:`admin_reply:${telegramId}`}]]); }
// В callback_data Telegram пропускает не больше 64 БАЙТ. Раньше сюда клали и
// application_id, и payment_id — вместе выходило 76 байт, и Telegram отвечал
// BUTTON_DATA_INVALID: карточка с чеком не отправлялась вообще, ни в тему, ни в
// General. Теперь передаём только заявку, а платёж находим по ней на сервере.
export function adminPaymentKeyboard(applicationId, paymentId, telegramId) { return inlineKeyboard([[{text:'✅ Approve payment',callback_data:cb(`admin_payment:${applicationId}:approved`)}],[{text:'❌ Reject payment',callback_data:cb(`admin_payment:${applicationId}:rejected`)}],[{text:'💬 Message player',callback_data:cb(`admin_reply:${telegramId}`)}]]); }
export function clubKeyboard(lang, url) { return inlineKeyboard([[clubChatButton(lang==='ru'?'💬 Вступить в клубный чат':'💬 Join Club Chat')]]); }
export function challengeKeyboard(lang, challengeId, profileUrl) { return inlineKeyboard([[{text:t(lang,'challenge_accept'),callback_data:`challenge_accept:${challengeId}`},{text:t(lang,'challenge_decline'),callback_data:`challenge_decline:${challengeId}`}],[{text:t(lang,'challenge_profile'),url:profileUrl}]]); }
export function directChatKeyboard(lang, username) { return inlineKeyboard([[urlButton(t(lang,'write_player'),`https://t.me/${String(username).replace(/^@/,'')}`)]]); }
export function adminPanelKeyboard(lang) { return inlineKeyboard([[{ text:'🛠 Open Admin Panel', web_app:{ url:`${PUBLIC_URL}/admin` } }]]); }
