// Справочник разделов бота для рассылок и внешних ссылок.
//
// Задача: админ пишет текст рассылки и ставит в нём короткий код раздела —
// {оплата}, {игроки}, {заявка}. Бот вырезает коды из текста и превращает их
// в кнопки под сообщением с человеческим названием на языке получателя.
// Код с восклицательным знаком — {!гонка} — остаётся внутри текста обычной
// ссылкой, чтобы можно было вписать раздел прямо в предложение.
//
// Тот же справочник обслуживает deep-ссылки вида t.me/<бот>?start=go_<код>:
// они работают где угодно — в группе, в WhatsApp, на сайте.
import { PUBLIC_URL } from './config.js';
import { getMe } from './telegram.js';

// kind:'webapp' — открывает мини-приложение по пути path.
// kind:'callback' — открывает экран внутри бота (то же, что нажать кнопку меню).
export const DESTINATIONS = [
  {code:'events',aliases:['события','событие'],ru:'📆 События',en:'📆 Events',kind:'webapp',path:'/league?tab=events'},
  { code:'pay',          aliases:['оплата','оплатить','взнос','payment'], ru:'💳 Оплатить взнос',      en:'💳 Pay the fee',        kind:'callback', action:'payment_entry' },
  { code:'apply',        aliases:['заявка','записаться','join'],          ru:'🎾 Заявка на сезон',     en:'🎾 Join the season',    kind:'webapp',   path:'/apply?mode=event' },
  { code:'avatar',       aliases:['аватар','аватарка','селфи','photo'],     ru:'🖼 Сделать аватарку',    en:'🖼 Create my avatar',   kind:'webapp',   path:'/league?player=me' },
  { code:'rating',       aliases:['уровень','тест','ntrp','level'],        ru:'🎾 Указать уровень',     en:'🎾 Set my level',       kind:'webapp',   path:'/apply?mode=rating' },
  { code:'profile',      aliases:['анкета','профиль'],                    ru:'📝 Заполнить анкету',    en:'📝 Fill in the profile',kind:'webapp',   path:'/apply?mode=profile' },
  { code:'match',        aliases:['матчи','матч','matches'],              ru:'🎾 Матчи и вызовы',      en:'🎾 Matches & challenges',kind:'webapp',  path:'/match' },
  { code:'result',       aliases:['результат','счёт','счет','score'],     ru:'📊 Внести результат',    en:'📊 Submit a result',    kind:'webapp',   path:'/match?tab=res' },
  { code:'court',        aliases:['корт','бронь','book'],                 ru:'📅 Забронировать корт',  en:'📅 Book a court',       kind:'webapp',   path:'/match?tab=book' },
  { code:'league',       aliases:['лига'],                                ru:'🏆 Лига',                en:'🏆 League',             kind:'webapp',   path:'/league' },
  { code:'divisions',    aliases:['дивизионы','дивизион','division'],     ru:'🏆 Дивизионы',           en:'🏆 Divisions',          kind:'webapp',   path:'/league?tab=div' },
  { code:'race',         aliases:['гонка','рейтинг','ranking'],           ru:'⭐ Годовая гонка',       en:'⭐ Yearly Race',        kind:'webapp',   path:'/league?tab=race' },
  { code:'players',      aliases:['игроки','список'],                     ru:'👥 Игроки лиги',         en:'👥 League players',     kind:'webapp',   path:'/league?tab=players' },
  { code:'schedule',     aliases:['расписание','календарь'],     ru:'📆 Матчи лиги',          en:'📆 League matches',     kind:'webapp',   path:'/league?tab=matches' },
  { code:'participants', aliases:['состав','участники'],                  ru:'👥 Состав сезона',       en:'👥 Season line-up',     kind:'webapp',   path:'/participants' },
  { code:'rules',        aliases:['правила','как','how'],                 ru:'📖 Как работает лига',   en:'📖 How the league works',kind:'callback',action:'text:how_league_works' },
  { code:'contact',      aliases:['связаться','вопрос','support'],        ru:'💬 Связаться с нами',    en:'💬 Contact us',         kind:'callback', action:'contact' },
  { code:'menu',         aliases:['меню','главная'],                      ru:'🎾 Открыть меню',        en:'🎾 Open menu',          kind:'callback', action:'main' }
];

const norm = v => String(v || '').trim().toLowerCase().replace(/ё/g, 'е');
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BY_KEY = new Map();
for (const d of DESTINATIONS) {
  BY_KEY.set(norm(d.code), d);
  for (const a of d.aliases) BY_KEY.set(norm(a), d);
}

export function findDestination(code) { return BY_KEY.get(norm(code)) || null; }
export function destinationLabel(dest, lang) { return (lang === 'ru' ? dest.ru : dest.en) || dest.en; }

// Имя бота нужно только для ссылок внутри текста. Спрашиваем один раз за процесс.
let botUsername = '';
export async function getBotUsername() {
  if (botUsername) return botUsername;
  try { botUsername = (await getMe())?.username || ''; }
  catch (e) { console.error('getMe for deep links failed:', e.message); }
  return botUsername;
}
export function deepLink(code, username) {
  const u = username || botUsername;
  return u ? `https://t.me/${u}?start=go_${encodeURIComponent(code)}` : '';
}

// {код} или {код|своя подпись}; с «!» — ссылка внутри текста, без — кнопка снизу.
const TAG = /\{(!)?\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}/g;

// Разбор шаблона рассылки. Возвращает всё, что нужно и для предпросмотра,
// и для отправки, но НЕ решает, на каком языке показывать — это делается
// отдельно для каждого получателя.
export function parseTemplate(raw = '') {
  const source=String(raw).trimStart();
  if(/^\[(RU|EN)\]\s*\n/i.test(source)){
    const variants={};const pattern=/(?:^|\n)\[(RU|EN)\][ \t]*(?:\r?\n|$)([\s\S]*?)(?=\r?\n\[(?:RU|EN)\][ \t]*(?:\r?\n|$)|$)/gi;
    for(const m of source.matchAll(pattern))variants[m[1].toLowerCase()]=parseTemplate(m[2]);
    return {variants,text:source,buttons:[],inline:[],unknown:[],hasLinks:true};
  }
  const buttons = [];
  const inline = [];
  const unknown = [];
  const seen = new Set();
  const text = String(raw).replace(TAG, (full, bang, code, label) => {
    const dest = findDestination(code);
    if (!dest) { unknown.push(String(code).trim()); return full; }
    const custom = label ? String(label).trim() : '';
    if (bang) { inline.push({ dest, custom }); return `«§${inline.length - 1}§»`; }
    const key = `${dest.code}|${custom}`;
    if (seen.has(key)) return '';
    seen.add(key);
    buttons.push({ dest, custom });
    return '';
  });
  return {
    text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    buttons, inline, unknown,
    hasLinks: Boolean(buttons.length || inline.length)
  };
}

// Текст под конкретного получателя: подставляем названия разделов на его языке.
export function renderText(parsed, lang, username = '') {
  if(parsed.variants)return renderText(broadcastVariant(parsed,lang),lang,username);
  return parsed.text.replace(/«§(\d+)§»/g, (_, i) => {
    const item = parsed.inline[Number(i)];
    if (!item) return '';
    // Внутри предложения эмодзи от названия кнопки выглядит инородно — убираем.
    const plain = item.custom || destinationLabel(item.dest, lang).replace(/^[^\p{L}\p{N}]+/u, '');
    const label = esc(plain);
    const url = deepLink(item.dest.code, username);
    return url ? `<a href="${url}">${label}</a>` : label;
  });
}

// Кнопки под конкретного получателя. По одной в ряд: названия длинные,
// в два столбца обрезаются на узких экранах.
export function renderButtons(parsed, lang) {
  if(parsed.variants)return renderButtons(broadcastVariant(parsed,lang),lang);
  if (!parsed.buttons.length) return null;
  const rows = parsed.buttons.map(({ dest, custom }) => {
    const text = custom || destinationLabel(dest, lang);
    if (dest.kind === 'webapp') return [{ text, web_app: { url: `${PUBLIC_URL}${dest.path}` } }];
    return [{ text, callback_data: dest.action }];
  });
  return { inline_keyboard: rows };
}

// Шпаргалка для админа: список кодов с названиями.
export function linksCheatSheet() {
  const lines = DESTINATIONS.map(d => {
    const alias = d.aliases[0] ? ` · {${d.aliases[0]}}` : '';
    return `<code>{${d.code}}</code>${alias} — ${d.ru}`;
  });
  return `<b>Разделы для рассылок</b>

Ставь код в тексте — он превратится в кнопку под сообщением:
<code>{оплата}</code>

Своя подпись на кнопке:
<code>{оплата|Оплатить до пятницы}</code>

Ссылка прямо внутри предложения — код с восклицательным знаком:
<code>Проверь свою позицию в {!гонка}</code>

Название на кнопке подставляется на языке получателя.

${lines.join('\n')}`;
}

export function broadcastVariant(parsed,lang){
 const key=lang==='ru'?'ru':'en';if(!parsed.variants)return parsed;
 const variant=parsed.variants[key];if(!variant||!variant.text.trim())throw Error('Missing broadcast text: '+key.toUpperCase());
 return variant;
}
export function validateBroadcastLanguages(parsed,contacts){
 const langs=new Set(contacts.map(c=>String(c.language||'').toLowerCase()==='ru'?'ru':'en'));
 for(const lang of langs){
  if(parsed.variants){broadcastVariant(parsed,lang);continue;}
  // Legacy messages have no language field: do not send their single-language
  // text to a mixed audience. Media with no caption carries no template text.
  if(!parsed.text.trim())continue;
  const detected=/[а-яё]/i.test(parsed.text)?'ru':'en';
  if(lang!==detected)throw Error('Missing broadcast text: '+lang.toUpperCase());
 }
}
export function panelBroadcastText(body={}){
 if(Object.hasOwn(body,'message_ru')||Object.hasOwn(body,'message_en'))return '[RU]\n'+String(body.message_ru||'').trim()+'\n[EN]\n'+String(body.message_en||'').trim();
 return String(body.message||'').trim();
}

export function broadcastPreview(parsed,username=''){
 if(!parsed.variants)return renderText(parsed,'ru',username);
 return ['ru','en'].filter(lang=>parsed.variants[lang]?.text.trim()).map(lang=>'<b>'+lang.toUpperCase()+'</b>\n'+renderText(parsed,lang,username)).join('\n\n');
}
