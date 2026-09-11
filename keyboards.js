import { inlineKeyboard, webAppButton, urlButton, clubChatButton } from './telegram.js';
import { t } from './i18n.js';
import { PUBLIC_URL } from './config.js';
import { signWebAppToken } from './util.js';


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
// opts.allow — список кодов кнопок, которые видит эта группа игроков. Не задан —
// показываем всё, как было. Сами кнопки и их адреса не меняются: настраивается
// только видимость.
export function mainKeyboard(lang, opts={}) {
  const app = opts.noWebApp
    ? (text, path) => urlButton(text, `https://t.me/${(opts.botUsername || 'PTF1_BOT').replace(/^@/,'')}`)
    : webAppButton;
  const allow = Array.isArray(opts.allow) ? new Set(opts.allow) : null;
  const on = (code) => !allow || allow.has(code);
  const btn = {
    join_event: () => app(t(lang,'join_event'),'/apply?mode=event'),
    matches: () => app(t(lang,'matches'),'/match'),
    participants: () => app(t(lang,'participants'),'/participants'),
    league: () => app(t(lang,'league'),'/league'),
    about: () => ({text:t(lang,'about'),callback_data:'text:about_ptf'}),
    how: () => ({text:t(lang,'how'),callback_data:'text:how_league_works'}),
    yearly: () => ({text:t(lang,'yearly'),callback_data:'text:yearly_race'}),
    pass: () => ({text:t(lang,'pass'),callback_data:'payment_entry'}),
    contact: () => ({text:t(lang,'contact'),callback_data:'contact'})
  };
  // Парные ряды собираем из того, что осталось: если одна кнопка выключена,
  // вторая занимает всю строку, а не висит половинкой.
  const pair = (a, b) => [a, b].filter(code => on(code)).map(code => btn[code]());
  const rows = [
    on('join_event') ? [btn.join_event()] : null,
    (opts.matches && on('matches')) ? [btn.matches()] : null,
    on('participants') ? [btn.participants()] : null,
    on('league') ? [btn.league()] : null,
    pair('about', 'how'),
    pair('yearly', 'pass'),
    on('contact') ? [btn.contact()] : null
  ].filter(r => r && r.length);
  return inlineKeyboard(rows);
}
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
// Карточка заявки в админском топике. Кнопка «Выставить счёт» нужна, когда
// автовыставление выключено рубильником: организатор сначала смотрит, есть ли
// место в дивизионе, и только потом открывает игроку оплату.
export function adminApplicationKeyboard(applicationId, telegramId, withInvoice=false) {
  const rows = [];
  if (withInvoice) rows.push([{text:'💳 Выставить счёт',callback_data:`admin_invoice:${applicationId}`}]);
  rows.push([{text:'✅ Set Active',callback_data:`admin_status:${applicationId}:active`},{text:'⏳ Waitlist',callback_data:`admin_status:${applicationId}:waitlist`}]);
  rows.push([{text:'❌ Reject',callback_data:`admin_status:${applicationId}:rejected`},{text:'💬 Message',callback_data:`admin_reply:${telegramId}`}]);
  return inlineKeyboard(rows);
}
// В callback_data Telegram пропускает не больше 64 БАЙТ. Раньше сюда клали и
// application_id, и payment_id — вместе выходило 76 байт, и Telegram отвечал
// BUTTON_DATA_INVALID: карточка с чеком не отправлялась вообще, ни в тему, ни в
// General. Теперь передаём только заявку, а платёж находим по ней на сервере.
// Третья кнопка нужна, когда состав уже укомплектован: оплату принимаем, но
// участие подтвердить пока не можем — игрок уходит в лист ожидания с понятным
// объяснением, а «Set Active» жмётся позже, когда место появится.
export function adminPaymentKeyboard(applicationId, paymentId, telegramId) { return inlineKeyboard([[{text:'✅ Approve payment',callback_data:cb(`admin_payment:${applicationId}:approved`)}],[{text:'⏳ Оплата принята → Waitlist',callback_data:cb(`admin_payment:${applicationId}:waitlisted`)}],[{text:'❌ Reject payment',callback_data:cb(`admin_payment:${applicationId}:rejected`)}],[{text:'💬 Message player',callback_data:cb(`admin_reply:${telegramId}`)}]]); }
export function clubKeyboard(lang, url) { return inlineKeyboard([[clubChatButton(lang==='ru'?'💬 Вступить в клубный чат':'💬 Join Club Chat')]]); }

// Приветствие после подтверждения оплаты: разделы сразу кнопками, чтобы человек
// потрогал бота в первую же минуту, и приглашение в клубный чат последней строкой.
// В личке inline-кнопки мини-приложения разрешены, поэтому открываются в один тап.
export function welcomeKeyboard(lang) {
  const ru = lang === 'ru';
  return inlineKeyboard([
    [webAppButton(ru?'🎾 Матчи':'🎾 Matches','/match'), webAppButton(ru?'📅 Корт':'📅 Court','/match?tab=book')],
    [webAppButton(ru?'📊 Результат':'📊 Result','/match?tab=res'), webAppButton(ru?'🏆 Лига':'🏆 League','/league')],
    [webAppButton(ru?'👥 Состав':'👥 Line-up','/participants')],
    [clubChatButton(ru?'💬 Вступить в клубный чат':'💬 Join the club chat')]
  ]);
}
export function challengeKeyboard(lang, challengeId, profileUrl) { return inlineKeyboard([[{text:t(lang,'challenge_accept'),callback_data:`challenge_accept:${challengeId}`},{text:t(lang,'challenge_decline'),callback_data:`challenge_decline:${challengeId}`}],[{text:t(lang,'challenge_profile'),url:profileUrl}]]); }
export function directChatKeyboard(lang, username) { return inlineKeyboard([[urlButton(t(lang,'write_player'),`https://t.me/${String(username).replace(/^@/,'')}`)]]); }
export function adminPanelKeyboard(lang) { return inlineKeyboard([[{ text:'🛠 Open Admin Panel', web_app:{ url:`${PUBLIC_URL}/admin` } }]]); }

// ------------------------------------------------------------------ постоянное меню
// Обычная клавиатура (не inline) — она не привязана к сообщению и не уезжает
// вверх вместе с историей. is_persistent держит её раскрытой.
// Набор кнопок зависит от состояния игрока: новичку не нужен «Результат»,
// активному — «Оплатить».
export const MENU_LABELS = {
  ru: { matches:'🎾 Мои матчи', result:'📊 Результат', court:'📅 Корт', league:'🏆 Лига',
        pay:'💳 Оплатить', apply:'🎾 Заявка', squad:'👥 Состав',
        menu:'🏠 Меню', contact:'💬 Связаться' },
  en: { matches:'🎾 My matches', result:'📊 Result', court:'📅 Court', league:'🏆 League',
        pay:'💳 Pay', apply:'🎾 Apply', squad:'👥 Line-up',
        menu:'🏠 Menu', contact:'💬 Contact' }
};

// Мини-приложение, запущенное из обычной (reply) клавиатуры, получает пустой
// initData: Telegram отдаёт его только inline-кнопкам, кнопке Menu и прямым
// ссылкам. Раньше из-за этого сервер отвечал «Telegram WebApp user not found».
// Решение — персональный токен в адресе кнопки: клавиатура строится под
// конкретного человека, токен подписан секретом бота и живёт 90 дней.
// Так раздел открывается в ОДИН тап и при этом знает, кто пришёл.
const MENU_PATHS = {
  matches:'/match', result:'/match?tab=res', court:'/match?tab=book',
  league:'/league', apply:'/apply?mode=event', squad:'/participants'
};

// «Состав» нужен всем без исключения, в том числе тем, кто уже в сезоне: люди
// следят за тем, кто с ними играет, пока дивизионы ещё добираются.
const MENU_LAYOUTS = {
  active: [['matches','result'], ['court','league'], ['squad','contact'], ['menu']],
  // Оплата подтверждена, но дивизион ещё не назначен: матчей нет, платить нечего.
  paid:   [['league','squad'], ['menu','contact']],
  unpaid: [['pay','league'], ['squad','contact'], ['menu']],
  lead:   [['apply','league'], ['squad','contact']]
};

// Версия раскладки. Постоянная клавиатура живёт у человека в чате до тех пор,
// пока бот её не перевыставит, а перевыставляем мы только при смене состояния.
// Значит после любой правки набора кнопок или адресов номер надо поднять —
// иначе у старых игроков останется прежняя клавиатура (в том числе текстовая,
// без мгновенного открытия мини-приложения).
export const MENU_VERSION = 5;

// allow — набор кнопок для группы игрока (настраивается в админке). Не задан —
// берём прежнюю раскладку по состоянию. Кнопки раскладываем по две в ряд, а
// нечётную последнюю оставляем во всю ширину: так ничего не висит половинкой.
export function persistentKeyboard(lang, kind='lead', telegramId='', allow=null) {
  const l = lang === 'ru' ? 'ru' : 'en';
  const labels = MENU_LABELS[l];
  const token = telegramId ? signWebAppToken(telegramId) : '';
  const make = (key) => {
    const text = labels[key];
    if (!text) return null;
    const path = MENU_PATHS[key];
    // Без токена (нет BOT_TOKEN или id) кнопка остаётся текстовой — бот ответит
    // сообщением с inline-кнопкой. Хуже на один тап, но работает всегда.
    if (!path || !token) return { text };
    const sep = path.includes('?') ? '&' : '?';
    return { text, web_app: { url: `${PUBLIC_URL}${path}${sep}t=${encodeURIComponent(token)}` } };
  };
  let rows;
  if (Array.isArray(allow)) {
    const keys = allow.filter(k => labels[k]);
    rows = [];
    for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map(make).filter(Boolean));
  } else {
    rows = (MENU_LAYOUTS[kind] || MENU_LAYOUTS.lead).map(row => row.map(make).filter(Boolean));
  }
  rows = rows.filter(r => r.length);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// Текст кнопки → действие. Собираем на обоих языках сразу: человек мог
// переключить язык, а клавиатура у него осталась со старыми подписями.
const ACTION_BY_LABEL = new Map();
for (const l of ['ru','en']) {
  for (const [key, text] of Object.entries(MENU_LABELS[l])) ACTION_BY_LABEL.set(text.toLowerCase(), key);
}
// Подписи менялись, а клавиатура живёт у человека в чате до следующего
// сообщения боту. Старые надписи продолжаем понимать, иначе нажатие уходит в
// бота обычным текстом и остаётся без ответа.
const LEGACY_LABELS = { '🎾 матчи': 'matches', '🎾 matches': 'matches' };
for (const [text, key] of Object.entries(LEGACY_LABELS)) {
  if (!ACTION_BY_LABEL.has(text)) ACTION_BY_LABEL.set(text, key);
}
export function menuAction(text='') {
  return ACTION_BY_LABEL.get(String(text).trim().toLowerCase()) || '';
}
