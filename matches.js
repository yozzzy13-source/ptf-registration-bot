// Матчи между игроками PTF.
//
// Заявка = свободное окно игрока: НЕСКОЛЬКО дат, интервал времени и НЕСКОЛЬКО
// подходящих кортов. Отвечающий выбирает из этого конкретную дату и корт —
// поэтому «Играю» в чате дивизиона ведёт в мини-приложение, где нужно выбрать,
// а не назначает матч вслепую.
//
//   open   — заявка рассылается всем активным игрокам дивизиона, забрать может любой;
//   direct — та же заявка, адресованная конкретному сопернику.
//
// Окна не публикуются в общий чат: бот адресно рассылает их активным игрокам того же
// дивизиона в личку. Данные и журнал живут в ОТДЕЛЬНОЙ таблице (matchesdb.js).
import { withPriority } from './google.js';
import { sendMessage as telegramSendMessage, sendPhoto, sendPhotoBuffer, sendDocumentBuffer, editMessageMedia, editMessageText, deleteMessage, withBulkRetries, isChatDead } from './telegram.js';
import { getSetting, setSetting, findApplicantByTelegramId, getDivisionOpponents, getAllBotSubscribers, getWebsiteProfileUrl } from './sheets.js';
import { cellToScore, reverseScore, formatScore } from './tennis.js';
import { findSlot, updateSlot, cellToList, listToCell, logMatchEvent, awaitingSide, proposerSide, getCourts, courtCloseAt } from './matchesdb.js';
import { slotScope } from './access.js';
import { PUBLIC_URL, RESULTS_CHAT_ID, RESULTS_TOPIC_ID, WEBSITE_URL, TIMEZONE } from './config.js';
import { escapeHtml, nowISO } from './util.js';
import { getAdminChatId, getOrCreatePlayerTopic, notifyAdmin } from './admin.js';

const MATCH_BUTTON_EN = {"📲 Отправить в WhatsApp":"📲 Send via WhatsApp","📅 Google Календарь":"📅 Google Calendar","🍎 Apple Календарь":"🍎 Apple Calendar","🎾 Играю":"🎾 I’m in","📲 Забронировать корт":"📲 Book court","💬 Написать сопернику":"💬 Message opponent","👤 Профиль игрока":"👤 Player profile","🎾 Мои матчи":"🎾 My matches","✅ Выбрать время и принять":"✅ Choose time and respond","❌ Отклонить":"❌ Decline","📲 Отменить бронь корта":"📲 Cancel court booking","🎾 Создать окно":"🎾 Create slot","✅ Принять":"✅ Accept","🕐 Другое время":"🕐 Different time","📍 Другой корт":"📍 Different court","✅ Корт подтвердил":"✅ Court confirmed","🕐 Изменить время":"🕐 Change time","📲 Открыть WhatsApp":"📲 Open WhatsApp","📅 Добавить в календарь":"📅 Add to calendar","🎾 Матчи":"🎾 Matches","✅ Подходит":"✅ Works for me","❌ Не могу":"❌ Cannot play","🕐 Предложить снова":"🕐 Propose again","✅ Подтверждаю":"✅ Confirm","❌ Не согласен":"❌ Disagree","📅 Обновить в календаре":"📅 Update calendar","🕐 Предложить другое время":"🕐 Suggest another time","📝 Внести результат":"📝 Submit result","⏸ Матч не доигран":"⏸ Match unfinished","✅ Матч уже доигран":"✅ Match completed","✅ Записать всё равно":"✅ Record anyway","✖️ Отклонить":"✖️ Reject","📝 Внести заново":"📝 Resubmit","✖️ Отменить запрос":"✖️ Cancel request","✖️ Отменить матч":"✖️ Cancel match","🎯 Вызвать другого игрока":"🎯 Challenge another player"};
async function sendMessage(chatId,text,opts={}) {
  if (!opts.reply_markup || Number(chatId)<0) return telegramSendMessage(chatId,text,opts);
  const lang = (await findApplicantByTelegramId(chatId).catch(()=>null))?.language === 'ru' ? 'ru' : 'en';
  const markup = {...opts.reply_markup};
  if (markup.inline_keyboard) markup.inline_keyboard = markup.inline_keyboard.map(row=>row.map(button=>{
    const b = {...button, text:lang==='en'?(MATCH_BUTTON_EN[button.text] || button.text):button.text};
    if (b.web_app?.url?.includes('/cal?')) {
      const url = new URL(b.web_app.url);url.searchParams.set('lang',lang);b.web_app={url:url.toString()};
    }
    return b;
  }));
  if (markup.inline_keyboard) markup.inline_keyboard = packRows(markup.inline_keyboard);
  return telegramSendMessage(chatId,text,{...opts,reply_markup:markup});
}
// Кнопки по две в ряд: подряд идущие одиночные короткие кнопки ставим парами,
// чтобы под сообщением было меньше строк. Длинные подписи остаются на всю
// ширину — иначе Telegram их обрежет.
const SHORT_BUTTON = 20;
export function packRows(rows = []) {
  const out = [];
  let carry = null;
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) continue;
    const single = row.length === 1 && [...String(row[0].text || '')].length <= SHORT_BUTTON && !row[0].wide;
    if (single && carry) { out.push([carry, row[0]]); carry = null; continue; }
    if (single) { carry = row[0]; continue; }
    if (carry) { out.push([carry]); carry = null; }
    out.push(row.map(b => { const { wide, ...rest } = b; return rest; }));
  }
  if (carry) out.push([carry]);
  return out.map(r => r.map(b => { const { wide, ...rest } = b; return rest; }));
}

function playerLink(name, username) {
  const safeName = escapeHtml(name || 'Игрок');
  return username ? `<a href="https://t.me/${escapeHtml(String(username).replace(/^@/, ''))}">${safeName}</a>` : `<b>${safeName}</b>`;
}

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// Якорь ставим в полдень UTC: при чтении через getUTC* дата не съезжает на соседний
// день, как это происходит с полуночью и офсетом +07:00.
export function formatDate(iso,lang='ru') {
  if(lang==='en'){const d=new Date(`${iso}T12:00:00Z`);return Number.isNaN(d.getTime())?iso:d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});}
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Несколько дат показываем компактно, но полностью — соперник должен видеть весь выбор.
function datesLine(slot,lang="ru") {
  const list = cellToList(slot.dates);
  if (!list.length) return '';
  return list.map(d=>formatDate(d,lang)).join(' · ');
}
function courtsLine(slot) {
  const list = cellToList(slot.courts);
  if (!list.length) return '';
  return list.join(' · ');
}
function offerBlock(slot,lang="ru") {
  const time = slot.time_to && slot.time_to !== slot.time_from ? `${escapeHtml(slot.time_from)}–${escapeHtml(slot.time_to)}` : escapeHtml(slot.time_from);
  const dur = lang==="ru" ? ` · матч ${Number(slot.duration_min || 120)/60} ч` : ` · ${Number(slot.duration_min || 120)/60}h match`;
  const courts = courtsLine(slot);
  return `📅 <b>${escapeHtml(datesLine(slot,lang))}</b>\n🕐 <b>${time}</b>${dur}${courts ? `\n📍 ${escapeHtml(courts)}` : ''}`;
}
function isToday(isoDate) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  return String(isoDate || '') === today;
}
function endTime(start, durationMin) {
  if (!String(start || '').trim()) return '';
  const [h, m] = String(start || '').split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const total = h * 60 + (m || 0) + Number(durationMin || 120);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function agreedBlock(slot,lang="ru") {
  const start = slot.agreed_time || slot.time_from || '';
  const end = endTime(start, slot.duration_min);
  return `📅 <b>${escapeHtml(formatDate(slot.agreed_date,lang))}</b>\n🕐 <b>${escapeHtml(start)}${end ? '–' + escapeHtml(end) : ''}</b>${slot.agreed_court ? `\n📍 ${escapeHtml(slot.agreed_court)}` : ''}`;
}

export function openSlotText(slot,lang="ru") {
  const multi = cellToList(slot.dates).length > 1 || cellToList(slot.courts).length > 1;
  return `<b>🎾 ${lang==="ru"?"Ищу соперника на матч":"Looking for a match"}</b>

👤 ${playerLink(slot.from_name, slot.from_username)}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot,lang)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}

${lang==='en' ? 'Tap “I’m in” and choose a date, time and court from the available options.' : multi ? 'Нажми «Играю» и выбери дату, время и корт из предложенных.' : 'Нажми «Играю», и я свяжу вас напрямую.'}`;
}

export function takenSlotText(slot,lang="ru") {
  return `<b>✅ ${lang==="ru"?"Матч назначен":"Match agreed"}</b>

${playerLink(slot.from_name, slot.from_username)} — ${playerLink(slot.to_name, slot.to_username)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}
${agreedBlock(slot,lang)}

${lang==="ru"?"Окно закрыто.":"This slot is closed."}`;
}

// Окна больше не уходят в общий чат: бот рассылает их в личку каждому активному
// игроку того же дивизиона. Так игроки получают только релевантные окна, и не нужен
// ещё один общий чат. Автору своё окно не шлём.
let cachedBotUsername = '';
export function setBotUsername(u) { cachedBotUsername = String(u || '').replace(/^@/, ''); }

function openSlotKeyboard(slot) {
  return { inline_keyboard: [[{ text: '🎾 Играю', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}` } }]] };
}

// С кем автор окна уже сыграл в этом сезоне. Круговой турнир: каждая пара
// встречается один раз, и слать окно тому, с кем матч уже состоялся, — спам.
// Смотрим в два места: журнал дивизиона (там лежат и матчи, внесённые мимо
// бота) и собственные слоты бота (там матч виден сразу, ещё до того как
// журнал пересчитается). Пару считаем занятой и когда матч уже согласован, но
// ещё не сыгран: второй раз договариваться с тем же человеком незачем.
async function alreadyPairedNames(slot) {
  const { sameName } = await import('./sheets.js');
  const me = String(slot.from_name || '').trim();
  const myId = String(slot.from_telegram_id || '');
  const taken = [];
  const add = name => { const n = String(name || '').trim(); if (n && !taken.some(x => sameName(x, n))) taken.push(n); };
  try {
    const { divisionSheetId, readMatchLog } = await import('./division.js');
    const spreadsheetId = await divisionSheetId(slot.division, slot.season, slot.group).catch(() => '');
    if (spreadsheetId && me) {
      const { rows } = await readMatchLog(spreadsheetId);
      for (const r of rows) {
        const p1 = String(r.player_1 || ''), p2 = String(r.player_2 || '');
        if (!p1 || !p2) continue;
        // Строка расписания без результата — матч ещё не сыгран, пара свободна.
        const played = String(r.completed || '').trim().toLowerCase() === 'yes'
          || String(r.p1_techloss || '').trim() !== '' || String(r.p2_techloss || '').trim() !== '';
        if (!played) continue;
        if (sameName(p1, me)) add(p2); else if (sameName(p2, me)) add(p1);
      }
    }
  } catch (e) { console.error('paired names from division log failed:', e.message); }
  try {
    const { allSlots } = await import('./matchesdb.js');
    for (const r of await allSlots()) {
      if (String(r.challenge_id) === String(slot.challenge_id)) continue;
      const from = String(r.from_telegram_id || ''), to = String(r.to_telegram_id || '');
      if (!from || !to || (from !== myId && to !== myId)) continue;
      const status = String(r.status || '').toLowerCase();
      const result = String(r.result_status || '').toLowerCase();
      // Занята пара, если матч согласован или результат уже где-то зафиксирован.
      if (!['accepted'].includes(status) && !['pending', 'confirmed', 'disputed', 'unfinished'].includes(result)) continue;
      add(from === myId ? r.to_name : r.from_name);
    }
  } catch (e) { console.error('paired names from slots failed:', e.message); }
  return taken;
}

export async function publishOpenSlot(slot) {
  const all = await getDivisionOpponents(slot.division, slot.from_telegram_id, slot.season, slot.group).catch(e => {
    console.error('division recipients failed:', e.message);
    return [];
  });
  const { sameName } = await import('./sheets.js');
  const paired = await alreadyPairedNames(slot);
  const recipients = all.filter(r => !paired.some(n => sameName(n, r.name)));
  const skipped = all.length - recipients.length;
  const text = openSlotText(slot);
  const opts = { reply_markup: openSlotKeyboard(slot) };
  let sent = 0, failed = 0;
  const cards = [];
  for (const r of recipients) {
    try {
      const lang = await nudgeLang(r.telegram_id);
      const msg = await sendMessage(r.telegram_id, openSlotText(slot,lang), opts);
      if (msg?.message_id) cards.push([String(r.telegram_id), msg.message_id, lang]);
      sent++;
      await new Promise(res => setTimeout(res, 45)); // мягкий темп, чтобы не упереться в лимит Telegram
    } catch (e) {
      failed++;
      console.error(`open slot to ${r.telegram_id} failed:`, e.message);
    }
  }
  // Запоминаем разосланные сообщения: когда дни окна разберут или окно
  // закроется, бот поправит их у всех получателей.
  if (cards.length) {
    const { updateSlot } = await import('./matchesdb.js');
    await updateSlot(slot.challenge_id, { broadcast_msgs: JSON.stringify(cards) }).catch(e => console.error('broadcast ids save failed:', e.message));
    cardState.set(String(slot.challenge_id), cardSignature(slot));
  }
  await logMatchEvent('broadcast', slot, { telegram_id: slot.from_telegram_id, name: slot.from_name },
    `дивизион ${slot.division}: отправлено ${sent}, ошибок ${failed}, пропущено уже сыгранных ${skipped}`);

  // Автору — сводка, сколько игроков увидели окно.
  const ru=(await nudgeLang(slot.from_telegram_id))==='ru';
  await sendMessage(slot.from_telegram_id, !ru ? (sent ? `📣 Your slot was sent to <b>${sent}</b> division players. I’ll notify you when someone responds.` : '📣 Nobody left to send it to — you have already played or agreed a match with everyone in your group.') : sent
    ? `📣 Окно отправлено игрокам дивизиона: <b>${sent}</b>.\nКак только кто-то откликнется, я пришлю предложение.`
    : `📣 Отправлять окно некому: со всеми в группе вы уже сыграли или договорились.`,{reply_markup:{inline_keyboard:[[{text:ru?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]]}}).catch(() => {});

  await adminMatchCopy(slot, `<b>📣 Новое окно</b>\n\n${text}\n\nРазослано игрокам: <b>${sent}</b>`
    + (skipped ? `\nПропущено (уже сыграли или договорились): <b>${skipped}</b>` : ''));

  return { sent, failed, skipped };
}

// Окно рассылалось в личку многим игрокам. Когда в окне меняются дни или оно
// закрывается, бот правит эти сообщения: остались дни — в тексте только они
// и кнопка «Играю» работает; дней не осталось — «Окно закрыто», без кнопки.
async function closeSlotCard() { /* см. refreshSlotCards */ }
const cardState = new Map();      // окно → что сейчас написано в сообщениях
const cardTimers = new Map();
function liveDates(slot, now = Date.now()) {
  return cellToList(slot.dates).filter(d => {
    const end = Date.parse(`${d}T${String(slot.time_to || '23:59').slice(0, 5)}:00+07:00`);
    return !Number.isFinite(end) || end > now;
  });
}
function cardSignature(slot) {
  const open = String(slot.status || '').toLowerCase() === 'open' && liveDates(slot).length > 0;
  return open ? 'open:' + liveDates(slot).join(',') : 'closed';
}
export function closedSlotText(slot, lang = 'ru') {
  const ru = lang === 'ru';
  return `<b>⛔ ${ru ? 'Окно закрыто' : 'Slot closed'}</b>

👤 ${playerLink(slot.from_name, slot.from_username)}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}

${ru ? 'Все дни этого окна уже разобраны или автор его закрыл. Свободные окна дивизиона — в «Мои матчи» → «Вызовы».' : 'All days of this slot are taken or the author closed it. Open slots of your division are in My matches → Challenges.'}`;
}
// Несколько изменений подряд (отклик + правка окна) сводим в одну правку.
export function scheduleSlotCards(challengeId, delayMs = 2500) {
  const id = String(challengeId || '');
  if (!id) return;
  clearTimeout(cardTimers.get(id));
  const t = setTimeout(() => { cardTimers.delete(id); refreshSlotCards(id).catch(e => console.error('slot cards:', e.message)); }, delayMs);
  t.unref?.();
  cardTimers.set(id, t);
}
export async function refreshSlotCards(challengeId) {
  const { findSlot } = await import('./matchesdb.js');
  const slot = await findSlot(challengeId);
  if (!slot?.broadcast_msgs) return { edited: 0 };
  let cards = [];
  try { cards = JSON.parse(slot.broadcast_msgs) || []; } catch { return { edited: 0 }; }
  const sig = cardSignature(slot);
  if (cardState.get(String(slot.challenge_id)) === sig) return { edited: 0 };
  const open = sig !== 'closed';
  const view = open ? { ...slot, dates: listToCell(liveDates(slot)) } : slot;
  let edited = 0;
  for (const [chat, messageId, lang] of cards) {
    try {
      await editMessageText(chat, messageId, open ? openSlotText(view, lang || 'ru') : closedSlotText(slot, lang || 'ru'),
        open ? { reply_markup: translateKeyboard(openSlotKeyboard(slot), lang) } : { reply_markup: { inline_keyboard: [] } });
      edited++;
    } catch (e) {
      // «message is not modified» — текст уже такой; удалённое сообщение — пропускаем.
      if (!/not modified|message to edit not found|message can't be edited/i.test(String(e.message))) console.error(`slot card ${chat}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 40));
  }
  cardState.set(String(slot.challenge_id), sig);
  return { edited, open };
}
function translateKeyboard(markup, lang) {
  if (lang !== 'en') return markup;
  return { inline_keyboard: markup.inline_keyboard.map(row => row.map(b => ({ ...b, text: MATCH_BUTTON_EN[b.text] || b.text }))) };
}

async function profileUrlFor(telegramId) {
  const p = await findApplicantByTelegramId(telegramId).catch(() => null);
  return p?.player_profile_url || '';
}

// «сегодня в 21:26» / «tomorrow at 09:00» / «1 окт в 13:00» — по местному времени.
export function whenLabel(ms, lang = 'en', now = Date.now()) {
  if (!ms) return '';
  const ru = lang === 'ru';
  const day = t => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const target = day(ms);
  const when = target === day(now) ? (ru ? 'сегодня' : 'today')
    : target === day(now + 86400000) ? (ru ? 'завтра' : 'tomorrow')
    : new Intl.DateTimeFormat(ru ? 'ru-RU' : 'en-GB', { timeZone: TIMEZONE, day: 'numeric', month: 'short' }).format(new Date(ms)).replace('.', '');
  return `${when} ${ru ? 'в' : 'at'} ${time}`;
}
// «сегодня до 21:26» / «by 21:26 today» — для сроков.
export function deadlineLabel(ms, lang = 'en', now = Date.now()) {
  const w = whenLabel(ms, lang, now);
  if (!w) return '';
  const m = w.match(/^(.*) (?:в|at) (\d\d:\d\d)$/);
  if (!m) return w;
  return lang === 'ru' ? `${m[1]} до ${m[2]}` : `by ${m[2]} ${/^(today|tomorrow)$/.test(m[1]) ? m[1] : 'on ' + m[1]}`;
}
// Срок, до которого автор должен подтвердить корт. Если в слоте ещё нет
// отметки «ждём корт» (только что согласовали), считаем от текущего момента.
function courtDeadline(slot) {
  return courtCloseAt({ ...slot, court_pending_at: slot.court_pending_at || nowISO() });
}

export async function notifyMatchAgreed(slot) {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
  if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru',author=String(id)===String(slot.from_telegram_id),opp=opponentOf(slot,id);
  // Корт — обязательный последний шаг. Автору объясняем, что без него матч не
  // считается согласованным и снимется сам; сопернику — чего мы ждём и до
  // какого времени. Кнопка «Корт подтвердил» — прямо здесь, а не только после
  // «Забронировать корт».
  const until=deadlineLabel(courtDeadline(slot),lang);
  const rows=[];
  if(author){
    rows.push([{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}]);
    rows.push([{text:ru?'✅ Корт подтвердил':'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}]);
  }
  rows.push(await contactRow(slot,id,lang),[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]);
  const next=author
    ?(ru?'<b>Последний шаг за вами:</b> забронируйте корт и нажмите «✅ Корт подтвердил», когда площадка ответит. Пока корт не подтверждён, матч не считается согласованным и сопернику не придёт подтверждение.'+(until?'\n\n⏳ Если корт не подтвердить '+until+', согласование снимется автоматически.':'')
        :'<b>The last step is yours:</b> book the court and tap “✅ Court confirmed” once the venue replies. Until then the match is not final and your opponent won’t get a confirmation.'+(until?'\n\n⏳ If it isn’t confirmed '+until+', the match will be removed automatically.':''))
    :(ru?'Остался последний шаг: '+escapeHtml(opp.name||'автор вызова')+' бронирует корт. Как только бронь будет подтверждена, я пришлю подтверждение матча.'+(until?'\n\n⏳ Если корт не подтвердят '+until+', согласование снимется автоматически. Можно написать сопернику или напомнить ему в «Моих матчах».':'')
        :'One step left: '+escapeHtml(opp.name||'the challenge creator')+' is booking the court. I’ll send you the match confirmation as soon as the booking is confirmed.'+(until?'\n\n⏳ If the court isn’t confirmed '+until+', the match will be removed automatically. You can message your opponent or send a reminder from My matches.':''));
  await sendMessage(id,(ru?'<b>🎾 Матч согласован!</b>':'<b>🎾 Match agreed!</b>')+'\n\n'+playerLink(opp.name,opp.username)+'\n'+agreedBlock(slot,lang)+'\n\n'+next,{reply_markup:{inline_keyboard:rows.filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
 }
 await adminMatchCopy(slot,'<b>🎾 Матч согласован</b>\n'+takenSlotText(slot));
}

// Адресный вызов: соперник выбирает дату/корт в мини-приложении, поэтому кнопка ведёт туда.
export async function sendDirectChallenge(slot) {
  const lang=await nudgeLang(slot.to_telegram_id),ru=lang==='ru';
  const url = await profileUrlFor(slot.from_telegram_id);
  const rows = [[{ text: '✅ Выбрать время и принять', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}` } }],
                [{ text: '❌ Отклонить', callback_data: `match_decline:${slot.challenge_id}` }]];
  if (url) rows.push([{ text: '👤 Профиль игрока', url }]);
  const text = `<b>🎾 ${ru?"Вызов на матч":"Match challenge"}</b>

${playerLink(slot.from_name, slot.from_username)} ${ru?"предлагает сыграть":"invites you to play"}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot,lang)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}

${ru?`Выберите дату, время и корт из предложенных — после этого ${escapeHtml(slot.from_name||'соперник')} забронирует корт. Если не подходит, нажмите «Отклонить», чтобы соперник не ждал.`:`Pick a date, time and court from the options — then ${escapeHtml(slot.from_name||'your opponent')} books the court. If nothing suits you, tap “Decline” so they aren’t left waiting.`}`;
  const delivered = await sendMessage(slot.to_telegram_id, text, { reply_markup: { inline_keyboard: rows } });
  const ar=(await nudgeLang(slot.from_telegram_id))==='ru';
  const authorRows=[await contactRow(slot,slot.from_telegram_id,ar?'ru':'en'),[{text:ar?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ar?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length});
  await sendMessage(slot.from_telegram_id,(ar?'<b>🎯 Вызов отправлен</b>':'<b>🎯 Challenge sent</b>')+'\n\n'+playerLink(slot.to_name,slot.to_username)+'\n'+offerBlock(slot,ar?'ru':'en')+'\n\n'+(ar?'Ожидаем ответ соперника. Когда он выберет время и корт, бронировать корт будете вы. Если предложение потеряет актуальность, отмените его кнопкой ниже.':'Waiting for your opponent. Once they pick a time and court, you’ll book the court. Cancel below if the proposal is no longer relevant.'),{reply_markup:{inline_keyboard:authorRows}}).catch(function(){});
  return delivered;
}

export async function declineDirectChallenge(slot, actor = {}) {
  await updateSlot(slot.challenge_id, { status: 'declined', responded_at: nowISO() });
  await logMatchEvent('declined', slot, actor);
  const lang=await nudgeLang(slot.from_telegram_id);
  // Сразу подсказываем, что дальше: вызвать другого или открыть своё окно.
  await sendMessage(slot.from_telegram_id, lang==='en'?`❌ ${escapeHtml(slot.to_name || 'Player')} declined your challenge for ${escapeHtml(datesLine(slot,lang))}.\n\nYou can challenge another player or open a slot for your whole division.` : `❌ ${escapeHtml(slot.to_name || 'Игрок')} отклонил вызов на ${escapeHtml(datesLine(slot))}.\n\nМожно вызвать другого игрока или открыть окно для всего дивизиона.`,
    { reply_markup: { inline_keyboard: [[{ text: '🎯 Вызвать другого игрока', web_app: { url: `${PUBLIC_URL}/match?tab=new` } }],[{ text: '🎾 Мои матчи', web_app: { url: `${PUBLIC_URL}/match?tab=mine` } }]] } }).catch(() => {});
}

export async function cancelSlot(slot, actor = {}) {
  await updateSlot(slot.challenge_id, { status: 'cancelled', cancelled_at: nowISO() });
  await logMatchEvent('cancelled', slot, actor);
}

// Отмена уже согласованного матча — точка, дальше ничего не происходит.
// Соперник и админский топик узнают сразу, потому что корт, скорее всего, забронирован.
export async function notifyMatchCancelled(slot, actor = {}, { backToOpen = false } = {}) {
  const byId = String(actor.telegram_id || '');
  const byName = String(slot.from_telegram_id) === byId ? slot.from_name : slot.to_name;
  const agreed=String(slot.status||'').toLowerCase()==='accepted';
  const bookedNote = slot.court_confirmed_at
    ? '\n\n⚠️ Корт был забронирован — снимите бронь, площадка об отмене не знает.'
    : '';
  // Тому, кто бронировал, сразу даём готовое сообщение об отмене для площадки.
  const court = slot.court_confirmed_at ? await courtByName(slot.agreed_court) : null;
  const cancelText = court ? courtCancelMessage(slot) : '';
  const bookerId = String(slot.court_confirmed_by || '');
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    const lang=await nudgeLang(side),ru=lang==='ru';
    const mine = String(side) === byId;
    const opp = opponentOf(slot, side);
    const hasOpponent=Boolean(slot.to_telegram_id);
    const actionLine=hasOpponent?(ru?(mine?'Вы отменили '+(agreed?'матч':'запрос'):escapeHtml(byName||'Соперник')+' отменил '+(agreed?'матч':'запрос')):(mine?'You cancelled the '+(agreed?'match':'request'):escapeHtml(byName||'Opponent')+' cancelled the '+(agreed?'match':'request')))+(hasOpponent?': '+playerLink(opp.name,opp.username):''):(ru?'Вы сняли открытое окно.':'You withdrew the open slot.');
    const rows = [];
    if (court?.whatsapp && String(side) === bookerId) {
      rows.push([{ text: '📲 Отменить бронь корта', url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(cancelText)}` }]);
    }
    rows.push([{ text: '🎾 Создать окно', web_app: { url: `${PUBLIC_URL}/match?tab=new` } }]);
    await sendMessage(side, `<b>✖️ ${agreed?(ru?"Матч отменён":"Match cancelled"):(ru?"Запрос отменён":"Request cancelled")}</b>

${actionLine}
${slot.agreed_date?agreedBlock(slot,lang):offerBlock(slot,lang)}${ru?bookedNote:(slot.court_confirmed_at?'\n\n⚠️ The court was booked. Cancel the reservation with the venue.':'')}${court?.whatsapp && String(side) === bookerId ? `\n\n<code>${escapeHtml(cancelText)}</code>` : ''}

${backToOpen ? (ru?"Окно снова доступно другим соперникам.":"The original slot is available to other opponents again.") : (ru?"Договоритесь заново — создайте новое окно, когда будете готовы.":"Create a new slot when you are ready to arrange another match.")}`, {
      reply_markup: { inline_keyboard: rows }
    }).catch(() => {});
  }
  await adminMatchCopy(slot, `<b>✖️ ${agreed?'Матч':'Запрос'} отменён</b>\n\n${escapeHtml(slot.from_name)} — ${escapeHtml(slot.to_name)}\n${slot.agreed_date?agreedBlock(slot):offerBlock(slot)}\n\nОтменил: <b>${escapeHtml(byName || '')}</b>${slot.court_confirmed_at ? '\n⚠️ корт был подтверждён' : ''}`);
}

// ---------------------------------------------------------------------------
// Переговоры. Отклик и контрпредложение приходят второй стороне в личку с теми же
// кнопками, что у заявки на тренировку в боте тренера: принять, другое время,
// другой корт, отклонить.
// ---------------------------------------------------------------------------
function proposalKeyboard(slot) {
  return { inline_keyboard: [
    [{ text: '✅ Принять', callback_data: `match_ok:${slot.challenge_id}` },
     { text: '❌ Отклонить', callback_data: `match_no:${slot.challenge_id}` }],
    [{ text: '🕐 Другое время', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=time` } },
     { text: '📍 Другой корт', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=court` } }],
    [{ text: '✖️ Отменить запрос', callback_data: `match_cancel:${slot.challenge_id}` }]
  ] };
}

export async function notifyProposal(slot, { isCounter = false } = {}) {
  const to = awaitingSide(slot);
  const by = proposerSide(slot);
  if (!to.id) return null;
  const lang=await nudgeLang(to.id),ru=lang==='ru';
  const head = !ru?(isCounter?'<b>🔄 Counterproposal</b>':'<b>🎾 Response to your slot</b>'): isCounter ? '<b>🔄 Встречное предложение</b>' : '<b>🎾 Отклик на ваше окно</b>';
  // Кто бронирует корт после принятия — всегда автор окна/вызова.
  const iBook=String(to.id)===String(slot.from_telegram_id);
  const bookNote=ru?(iBook?'После принятия корт бронируете вы.':'После принятия корт бронирует '+escapeHtml(slot.from_name||'автор окна')+'.')
    :(iBook?'Once you accept, you book the court.':'Once you accept, '+escapeHtml(slot.from_name||'the slot creator')+' books the court.');
  const text = `${head}

${playerLink(by.name, by.username)} ${ru?"предлагает сыграть:":"proposes a match:"}
${agreedBlock(slot,lang)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}

${ru?"Подтвердите или предложите своё.":"Accept or suggest an alternative."} ${bookNote}`;
  const delivered=await sendMessage(to.id, text, { reply_markup: proposalKeyboard(slot) }).catch(e => console.error('notifyProposal failed:', e.message));
  if(by.id){const pr=(await nudgeLang(by.id))==='ru';const rows=[await contactRow(slot,by.id,pr?'ru':'en'),[{text:pr?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:pr?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length});await sendMessage(by.id,(pr?'<b>✅ Предложение отправлено</b>':'<b>✅ Proposal sent</b>')+'\n\n'+agreedBlock(slot,pr?'ru':'en')+'\n\n'+(pr?'Ожидаем ответ соперника.'+(String(by.id)===String(slot.from_telegram_id)?' После принятия корт бронируете вы.':' После принятия корт бронирует '+escapeHtml(slot.from_name||'автор окна')+'.'):'Waiting for your opponent.'+(String(by.id)===String(slot.from_telegram_id)?' Once accepted, you book the court.':' Once accepted, '+escapeHtml(slot.from_name||'the slot creator')+' books the court.')),{reply_markup:{inline_keyboard:rows}}).catch(function(){})}
  return delivered;
}

export async function notifyProposalRejected(slot, previous = {}) {
  const rejectedFor = String(previous.pending_by || '');
  if (!rejectedFor) return null;
  const reopened = String(slot.status || '').toLowerCase() === 'open';
  const lang=await nudgeLang(rejectedFor);
  const text = lang==='en'?(reopened?`❌ The proposal for ${escapeHtml(formatDate(previous.agreed_date,'en'))} was declined. The slot is available again; you can propose another time.`:'❌ Your challenge was declined.'):reopened
    ? `❌ Предложение на ${escapeHtml(formatDate(previous.agreed_date))} отклонено. Окно снова свободно — можно предложить другое время.`
    : `❌ ${escapeHtml(previous.from_name || 'Игрок')} отклонил вызов.`;
  return sendMessage(rejectedFor, text).catch(() => {});
}

// ---------------------------------------------------------------------------
// Бронь корта в WhatsApp. Номер площадки берём из листа Courts основной таблицы.
// Бот НИЧЕГО не отправляет сам — только готовит текст и ссылку, отправляет игрок.
// ---------------------------------------------------------------------------
export async function courtByName(name) {
  if (!name) return null;
  const list = await getCourts().catch(() => []);
  const norm = (v) => String(v || '').trim().toLowerCase();
  return list.find(c => norm(c.name) === norm(name)) || null;
}

export function bookingMessage(slot, court) {
  const dur = Number(slot.duration_min || 120);
  const start = slot.agreed_time || slot.time_from || '';
  const end = endTime(start, dur);
  const d = new Date(`${slot.agreed_date}T12:00:00Z`);
  const human = Number.isNaN(d.getTime()) ? slot.agreed_date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Пишем напрямую администратору площадки, поэтому корт и число игроков не повторяем.
  // Пометка PTF нужна, чтобы админ понимал, от какой организации бронь.
  return [
    'Hello! I would like to book a court for a PTF match.',
    '',
    `Date: ${human}`,
    `Time: ${start}${end ? '–' + end : ''} (${dur / 60}h)`,
    '',
    'Is it available? Thank you!'
  ].join('\n');
}

export async function sendBookingHelper(chatId, slot) {
  const lang = (await findApplicantByTelegramId(chatId))?.language==='ru'?'ru':'en';
  if(String(chatId)!==String(slot.from_telegram_id)||slot.status!=='accepted')return sendMessage(chatId,lang==='ru'?'Корт бронирует автор согласованного вызова.':'The creator of the agreed challenge handles court booking.');
  const court = await courtByName(slot.agreed_court);
  const text = bookingMessage(slot, court);
  if(lang==='en'){
    const rows=[];
    if(court?.whatsapp)rows.push([{text:'📲 Send via WhatsApp',wide:true,url:'https://wa.me/'+court.whatsapp+'?text='+encodeURIComponent(text)}]);
    rows.push([{text:'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}],[{text:'🕐 Change time',callback_data:'match_retime:'+slot.challenge_id}],[{text:'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);
    const untilEn=deadlineLabel(courtDeadline(slot),'en');
    return sendMessage(chatId,'<b>📲 Court booking</b>\n\n'+escapeHtml(court?.name || slot.agreed_court || '')+'\n'+(court?.whatsapp?'“Send via WhatsApp” opens the chat with the venue with the booking text already filled in — just tap Send. After the venue agrees, tap “Court confirmed”.':'Copy the message and send it to the venue. After confirmation, tap “Court confirmed”.')+'\nThis is the final step: your opponent gets the match confirmation only after it.'+(untilEn?' If it isn’t confirmed '+untilEn+', the match will be removed automatically.':'')+'\n\n<code>'+escapeHtml(text)+'</code>',{reply_markup:{inline_keyboard:rows}});
  }
  const confirmRow = [{ text: '✅ Корт подтвердил', callback_data: `match_court_ok:${slot.challenge_id}` }];
  // Площадка часто даёт соседний слот — время правится тут же, не выходя из диалога.
  const retimeRow = [{ text: '🕐 Изменить время', callback_data: `match_retime:${slot.challenge_id}` }];
  const cancelRow = [{ text: '✖️ Отменить матч', callback_data: `match_cancel:${slot.challenge_id}` }];
  if (!court?.whatsapp) {
    return sendMessage(chatId, `<b>📲 Сообщение для брони корта</b>

${slot.agreed_court ? `Для площадки «${escapeHtml(slot.agreed_court)}» не указан номер WhatsApp в листе Courts, поэтому кнопки нет — скопируйте текст и отправьте сами.` : 'Площадка не выбрана — укажите её в переписке с соперником.'}

<code>${escapeHtml(text)}</code>`, { reply_markup: { inline_keyboard: [confirmRow, retimeRow, cancelRow] } });
  }
  return sendMessage(chatId, `<b>📲 Бронь корта</b>

Площадка: <b>${escapeHtml(court.name)}</b>${court.address ? `\n${escapeHtml(court.address)}` : ''}
Кнопка «Отправить в WhatsApp» откроет чат с площадкой, текст брони уже будет вставлен — останется нажать «Отправить». Когда площадка ответит согласием — нажмите «Корт подтвердил».
Это последний шаг: сопернику подтверждение матча придёт только после него.${courtDeadline(slot)?` Если не подтвердить ${deadlineLabel(courtDeadline(slot),'ru')}, согласование снимется автоматически.`:''}

<code>${escapeHtml(text)}</code>`, {
    reply_markup: { inline_keyboard: [
      [{ text: '📲 Отправить в WhatsApp', wide: true, url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(text)}` }],
      confirmRow,
      retimeRow,
      cancelRow
    ] }
  });
}

// Матч подтверждён окончательно: корт забронирован, обе стороны уведомлены,
// каждому — ссылка на добавление события в календарь.
export function matchCalendarUrl(slot) {
  const start = slot.agreed_time || slot.time_from || '00:00';
  const end = endTime(start, slot.duration_min);
  const title = `🎾 PTF: ${slot.from_name} — ${slot.to_name}`;
  const params = new URLSearchParams({
    t: title,
    s: `${slot.agreed_date}T${start}:00+07:00`,
    e: `${slot.agreed_date}T${end}:00+07:00`,
    l: slot.agreed_court || ''
  });
  return `${PUBLIC_URL}/cal?${params.toString()}`;
}
// Google Календарь: ссылка сразу открывает новое событие с заполненными
// названием, временем и кортом — остаётся нажать «Сохранить».
export function googleCalendarUrl(slot) {
  const start = slot.agreed_time || slot.time_from || '00:00';
  const end = endTime(start, slot.duration_min);
  const stamp = (d, t) => String(d || '').replace(/-/g, '') + 'T' + String(t || '00:00').replace(':', '') + '00';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `🎾 PTF: ${slot.from_name} — ${slot.to_name}`,
    dates: `${stamp(slot.agreed_date, start)}/${stamp(slot.agreed_date, end)}`,
    ctz: 'Asia/Bangkok',
    location: slot.agreed_court || '',
    details: 'Phuket Tennis Family'
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
// Две кнопки календаря: Google открывает событие в Google Календаре,
// Apple — файл события, который iPhone сам предлагает добавить.
export function calendarRow(slot) {
  return [
    { text: '📅 Google Календарь', url: googleCalendarUrl(slot) },
    { text: '🍎 Apple Календарь', web_app: { url: matchCalendarUrl(slot) } }
  ];
}

export async function notifyCourtConfirmed(slot) {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
  if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru';
  const rows=[calendarRow(slot),await contactRow(slot,id,lang)];
  if(String(id)===String(slot.from_telegram_id))rows.push([{text:ru?'🕐 Изменить время':'🕐 Change time',callback_data:'match_retime:'+slot.challenge_id}]);
  rows.push([{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);
  await sendMessage(id,(ru?'<b>✅ Корт забронирован — матч подтверждён</b>':'<b>✅ Court booked — match confirmed</b>')+'\n\n'+agreedBlock(slot,lang)+'\n\n'+(ru?'Оба игрока уведомлены. Добавьте матч в календарь.':'Both players have been notified. Add the match to your calendar.'),{reply_markup:{inline_keyboard:rows.filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
 }
 await adminMatchCopy(slot,'<b>✅ Корт подтверждён</b>\n'+takenSlotText(slot));
}

// Текст отмены брони — тем же языком и форматом, что и запрос на бронь.
export function courtCancelMessage(slot) {
  const start = slot.agreed_time || slot.time_from || '';
  const end = endTime(start, slot.duration_min);
  const d = new Date(`${slot.agreed_date}T12:00:00Z`);
  const human = Number.isNaN(d.getTime()) ? slot.agreed_date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return [
    'Hello! I need to cancel our court booking for PTF match.',
    '',
    `Date: ${human}`,
    `Time: ${start}${end ? `–${end}` : ''}`,
    '',
    'Sorry for the inconvenience, and thank you!'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Напоминания о матче: накануне и перед выездом.
// Бот и так знает время — молчать до самого конца и вспоминать только «внесите
// счёт» неправильно, большая часть неявок именно от забывчивости.
// ---------------------------------------------------------------------------
export async function notifyMatchReminder(slot,kind='day') {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
 if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru',author=String(id)===String(slot.from_telegram_id);
 // 'eve' — вечернее предупреждение об утреннем матче: три часа до него попадают
 // в тихие часы, поэтому говорим накануне, а не будим в пять утра.
 const at=String(slot.agreed_time||slot.time_from||'').trim();
 const head=kind==='day'
   ?(isToday(slot.agreed_date)?(ru?'Сегодня матч':'Match today'):(ru?'Завтра матч':'Match tomorrow'))
   :kind==='eve'
     ?(ru?('Завтра матч'+(at?' в '+at:'')):('Match tomorrow'+(at?' at '+at:'')))
     :(ru?'Матч через 3 часа':'Match in 3 hours');
 const until=slot.court_confirmed_at?'':deadlineLabel(courtCloseAt(slot),lang);
 const tail=slot.court_confirmed_at?(ru?'Корт подтверждён. Если планы изменились — предупредите соперника.':'Court confirmed. Let your opponent know if your plans change.'):(author?(ru?'⚠️ Корт ещё не подтверждён. Проверьте ответ площадки и нажмите «Корт подтвердил» — без этого матч не считается согласованным.':'⚠️ The court isn’t confirmed yet. Check the venue’s reply and tap “Court confirmed” — until then the match isn’t final.'):(ru?'⚠️ Корт ещё не подтверждён: ждём бронь от автора вызова. Можно написать ему.':'⚠️ The court isn’t confirmed yet: waiting for the challenge creator to book it. You can message them.'))
   +(until?'\n⏳ '+(ru?'Если корт не подтвердить '+until+', матч снимется автоматически.':'If the court isn’t confirmed '+until+', the match will be removed automatically.'):'');
 const courtRow=!slot.court_confirmed_at&&author&&slot.match_type!=='manual'?[{text:'✅ Корт подтвердил',callback_data:'match_court_ok:'+slot.challenge_id}]:[];
 await sendMessage(id,'<b>🎾 '+head+'</b>\n\n'+agreedBlock(slot,lang)+'\n\n'+tail,{reply_markup:{inline_keyboard:[courtRow,await contactRow(slot,id,lang),[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
 }return {start:slot.agreed_time||slot.time_from||''};
}

// Напоминание о дедлайне сезона: сколько матчей осталось и сколько дней.
export async function notifyDeadline(telegramId, { names = [], daysLeft = null, division = '' } = {}) {
  if (!telegramId || !names.length) return null;
  const ru=(await nudgeLang(telegramId))==='ru';
  if(!ru)return sendMessage(telegramId,`<b>🎾 Remaining matches${division?' · '+escapeHtml(division):''}</b>\n\nStill to play: <b>${names.length}</b>\n${names.map(n=>'• '+escapeHtml(n)).join('\n')}${daysLeft===null?'':'\n\n'+(daysLeft>0?'Days left in the season: '+daysLeft:'The deadline has passed. Please arrange your matches.')}\n\nCreate a slot so opponents can respond.`,{reply_markup:{inline_keyboard:[[{text:'🎾 Create slot',web_app:{url:PUBLIC_URL+'/match?tab=new'}}]]}});
  const list = names.slice(0, 8).map(n => `• ${escapeHtml(n)}`).join('\n');
  const more = names.length > 8 ? `\n…и ещё ${names.length - 8}` : '';
  const when = daysLeft === null ? '' : (daysLeft > 0
    ? `\n\n⏳ До конца сезона осталось <b>${daysLeft}</b> ${plural(daysLeft, 'день', 'дня', 'дней')}.`
    : '\n\n⚠️ Срок уже вышел — сыграйте как можно скорее.');
  return sendMessage(telegramId, `<b>🎾 Незакрытые матчи${division ? ` · ${escapeHtml(division)}` : ''}</b>

Осталось сыграть: <b>${names.length}</b>
${list}${more}${when}

Откройте окно — соперники увидят его и откликнутся.`, {
    reply_markup: { inline_keyboard: [[{ text: '🎾 Создать окно', web_app: { url: `${PUBLIC_URL}/match?tab=new` } }]] }
  }).catch(() => null);
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------------------------------------------------------------------------
// Подталкивание застрявших заявок: 2 часа → ещё 2 → закрытие.
// Кнопки повторяют исходное сообщение, чтобы отвечать можно было прямо отсюда.
// ---------------------------------------------------------------------------
async function nudgeLang(id) {
  return (await findApplicantByTelegramId(id).catch(()=>null))?.language==='ru'?'ru':'en';
}
function nudgeDetails(slot,lang,offer=false) {
  const ru=lang==='ru';
  const date=offer?cellToList(slot.dates).join(', '):slot.agreed_date;
  const time=offer?[slot.time_from,slot.time_to].filter(Boolean).join('–'):slot.agreed_time;
  const court=offer?cellToList(slot.courts).join(', '):slot.agreed_court;
  return [escapeHtml(slot.from_name)+' — '+escapeHtml(slot.to_name||''),
    (ru?'Дата: ':'Date: ')+escapeHtml(date||'—'),
    (ru?'Время: ':'Time: ')+escapeHtml(time||'—'),
    (ru?'Корт: ':'Court: ')+escapeHtml(court||'—')].join('\n');
}
function nudgeWarning(stage,ru,invite=false) {
  if(invite) {
    return stage==='d1'?(ru?'Это последнее напоминание: без ответа вызов будет снят.':'Final reminder: the challenge will be withdrawn without an answer.')
      :stage==='n2'?(ru?'Ответьте, пожалуйста, чтобы вызов не пропал.':'Please answer so the challenge does not expire.') : '';
  }
  return stage==='d1'?(ru?'Это последнее напоминание: неподтверждённое предложение будет снято.':'Final reminder: the unconfirmed proposal will expire.')
    :stage==='n2'?(ru?'Завершите этот этап, чтобы предложение не закрылось.':'Complete this step before the proposal expires.') : '';
}
export async function notifyStuckNegotiation({slot,stage,waiting,proposer,initial=false}) {
  if(!waiting?.id)return null;
  const ru=(await nudgeLang(waiting.id))==='ru';
  const rows=initial?[
    [{text:ru?'✅ Выбрать время и принять':'✅ Choose time and respond',web_app:{url:PUBLIC_URL+'/match?slot='+encodeURIComponent(slot.challenge_id)}}],
    [{text:ru?'❌ Отклонить':'❌ Decline',callback_data:'match_decline:'+slot.challenge_id}]
  ]:[
    [{text:ru?'✅ Принять':'✅ Accept',callback_data:'match_ok:'+slot.challenge_id}],
    [{text:ru?'🕐 Другое время':'🕐 Different time',web_app:{url:PUBLIC_URL+'/match?counter='+encodeURIComponent(slot.challenge_id)}}],
    [{text:ru?'❌ Отклонить':'❌ Decline',callback_data:'match_no:'+slot.challenge_id}],
    [{text:ru?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}]
  ];
  const head=initial
    ?(ru?'<b>🎾 Вас вызвали на матч</b>':'<b>🎾 You have a match challenge</b>')
    :(ru?'<b>⏳ Согласование матча не завершено</b>':'<b>⏳ Your match still needs an answer</b>');
  const ask=initial
    ?(ru?'Соперник предложил сыграть. Выберите удобные дату, время и корт из предложенных — или откажитесь, чтобы он не ждал.':'Your opponent suggested a match. Pick a date, time and court that suit you — or decline, so they are not left waiting.')
    :(ru?'Ответьте на вызов: подтвердите условия или предложите свои.':'Respond to the challenge: confirm the details or suggest your own.');
  await sendMessage(waiting.id,head+'\n\n'
    +(initial&&proposer?.name?(ru?'От кого: ':'From: ')+playerLink(proposer.name,proposer.username)+'\n':'')
    +nudgeDetails(slot,ru?'ru':'en',initial)+'\n\n'+ask
    +'\n'+nudgeWarning(stage,ru,initial),{reply_markup:{inline_keyboard:rows}});
  // Только когда переговоры уже шли. По непринятому вызову автору не пишем:
  // никакого «этапа» у него нет, а подтолкнуть соперника он может кнопкой
  // «Напомнить» в своих матчах.
  if(stage==='n2'&&!initial&&proposer?.id) {
    const pr=(await nudgeLang(proposer.id))==='ru';
    await sendMessage(proposer.id,initial
      ?(pr?'⏳ Соперник ещё не открывал ваш вызов. Можно написать ему напрямую.':'⏳ Your opponent has not opened your challenge yet. You can contact them directly.')
      :(pr?'⏳ Соперник пока не ответил. Можно написать ему напрямую.':'⏳ Your opponent has not replied yet. You can contact them directly.'),
      {reply_markup:{inline_keyboard:[await contactRow(slot,proposer.id,pr?'ru':'en'),[{text:pr?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:pr?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length})}}).catch(()=>{});
  }
  return true;
}
export async function notifyNegotiationExpired(slot,{backToOpen=false,scope='negotiation'}={}) {
  for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
    if(!id)continue;const ru=(await nudgeLang(id))==='ru';
    const booker=String(id)===String(slot.from_telegram_id);
    const reason=scope==='court'&&!booker
      ?(ru?escapeHtml(slot.from_name||'Автор вызова')+' не подтвердил бронь корта, поэтому матч снят. Можно договориться заново.':escapeHtml(slot.from_name||'The challenge creator')+' didn’t confirm the court booking, so the match has been removed. You can arrange it again.')
      :scope==='court'
      ?(ru?'Бронь корта не подтверждена. Матч снят. Если вы уже забронировали площадку в WhatsApp, свяжитесь с ней и проверьте или отмените бронь самостоятельно.':'The court booking was not confirmed. The match has been removed. If you booked through WhatsApp, contact the venue to check or cancel the booking yourself.')
      :(ru?'Предложение снято: ответ не получен.':'The proposal expired without a reply.');
    const next=backToOpen
      ?(ru?'Свободное окно снова доступно другим соперникам.':'The open slot is available to other opponents again.')
      :(ru?'При необходимости создайте новый вызов.':'Create a new challenge when ready.');
    await sendMessage(id,'<b>⌛ '+(ru?'Согласование завершено без подтверждения':'Unconfirmed matchmaking closed')+'</b>\n\n'
      +nudgeDetails(slot,ru?'ru':'en')+'\n\n'+reason+'\n'+next,
      {reply_markup:{inline_keyboard:[[{text:ru?'🎾 Матчи':'🎾 Matches',web_app:{url:PUBLIC_URL+'/match'}}]]}}).catch(()=>{});
  }
}
export async function notifyStuckCourt({slot,stage}) {
  for(const id of [slot.from_telegram_id]) {
    if(!id)continue;const ru=(await nudgeLang(id))==='ru';
    await sendMessage(id,(ru?'<b>📲 Бронирование матча не завершено</b>':'<b>📲 Your match booking is incomplete</b>')+'\n\n'
      +nudgeDetails(slot,ru?'ru':'en')+'\n\n'
      +(ru?'Проверьте ответ площадки в WhatsApp. Если бронь одобрена, нажмите «Корт подтвердил». Если время не подходит, согласуйте другое с соперником.':'Check the venue’s reply in WhatsApp. If the booking is approved, tap “Court confirmed”. Otherwise, agree a different time with your opponent.')
      +'\n'+(ru?'Пока корт не подтверждён, матч не считается согласованным, а соперник ждёт подтверждения.':'Until the court is confirmed, the match is not final and your opponent is still waiting.')
      +(courtCloseAt(slot)?'\n⏳ '+(ru?'Если не подтвердить корт '+deadlineLabel(courtCloseAt(slot),'ru')+', матч снимется автоматически.':'If the court isn’t confirmed '+deadlineLabel(courtCloseAt(slot),'en')+', the match will be removed automatically.'):'')
      +'\n'+nudgeWarning(stage,ru),{reply_markup:{inline_keyboard:[
        [{text:ru?'✅ Корт подтвердил':'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}],
        [{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}],
        [{text:ru?'🕐 Изменить время':'🕐 Change time',callback_data:'match_retime:'+slot.challenge_id}],
        [{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]
      ]}});
  }
  // Последнее напоминание автору — заодно предупреждаем соперника: он ждёт
  // подтверждения и может сам написать автору, пока матч не снялся.
  const oppId=slot.to_telegram_id;
  if(stage==='d1'&&oppId){
    const lang=await nudgeLang(oppId),ru=lang==='ru',author=opponentOf(slot,oppId),until=deadlineLabel(courtCloseAt(slot),lang);
    await sendMessage(oppId,(ru?'<b>⏳ Корт по вашему матчу ещё не подтверждён</b>':'<b>⏳ The court for your match isn’t confirmed yet</b>')+'\n\n'
      +nudgeDetails(slot,lang)+'\n\n'
      +(ru?escapeHtml(author.name||'Автор вызова')+' ещё не подтвердил бронь корта. Пока этого нет, матч не считается согласованным'+(until?' и снимется автоматически '+until:'')+'. Напишите сопернику, если хотите сохранить матч.'
          :escapeHtml(author.name||'The challenge creator')+' hasn’t confirmed the court booking yet. Until then the match isn’t final'+(until?' and will be removed automatically '+until:'')+'. Message your opponent if you want to keep it.'),
      {reply_markup:{inline_keyboard:[await contactRow(slot,oppId,lang),[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(r=>r.length)}}).catch(e=>console.error('stuck court opponent notice:',e.message));
  }
}
export async function notifyStuckTimeChange({slot,stage,proposal,waitingId}) {
  if(!waitingId)return null;const ru=(await nudgeLang(waitingId))==='ru';
  return sendMessage(waitingId,(ru?'<b>🕐 Подтвердите новое время</b>':'<b>🕐 Confirm the proposed time</b>')+'\n\n'
    +nudgeDetails(slot,ru?'ru':'en')+'\n'+(ru?'Предложено: ':'Proposed: ')+escapeHtml(proposal.time)+'\n\n'
    +(ru?'Без ответа предложение будет снято, прежнее время сохранится.':'Without an answer, the proposal will expire and the original time will remain.'),
    {reply_markup:{inline_keyboard:[[
      {text:ru?'✅ Подходит':'✅ Works for me',callback_data:'mt_ok:'+slot.challenge_id+':'+proposal.time},
      {text:ru?'❌ Не могу':'❌ Cannot play',callback_data:'mt_no:'+slot.challenge_id+':'+proposal.time}
    ],[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]]}});
}

export async function notifyTimeChangeExpired(slot, proposal) {
  const by = String(proposal?.by || '');
  if (!by) return null;
  const ru=(await nudgeLang(by))==='ru';
  return sendMessage(by,!ru?`<b>⌛ No response to the proposed time</b>\n\nThe proposal for <b>${escapeHtml(proposal.time)}</b> has expired. The match remains at <b>${escapeHtml(slot.agreed_time||'—')}</b>.`: `<b>⌛ Соперник не ответил на новое время</b>

Предложение <b>${escapeHtml(proposal.time)}</b> снято, время матча осталось прежним: <b>${escapeHtml(slot.agreed_time || '—')}</b>.`, {
    reply_markup: { inline_keyboard: [[{ text: '🕐 Предложить снова', callback_data: `match_retime:${slot.challenge_id}` }],[{text:'✖️ Отменить матч',callback_data:'match_cancel:'+slot.challenge_id}]] }
  }).catch(() => null);
}

export async function notifyStuckResult({slot,stage,waitingId,waitingIds}) {
  const targets=(Array.isArray(waitingIds)&&waitingIds.length?waitingIds:[waitingId]).filter(Boolean);
  if(targets.length>1) {
    for(const id of targets)await notifyStuckResult({slot,stage,waitingId:id}).catch(()=>{});
    return true;
  }
  const only=targets[0];
  if(!only)return null;const ru=(await nudgeLang(only))==='ru';
  return sendMessage(only,(ru?'<b>⏳ Счёт ждёт вашего подтверждения</b>':'<b>⏳ The score needs your confirmation</b>')+'\n\n'
    +nudgeDetails(slot,ru?'ru':'en')+'\n'+resultLine(slot)+'\n\n'
    +(ru?'Подтвердите счёт или сообщите о несогласии.':'Confirm the score or dispute it.')
    +(stage==='d1'?(ru?' Без ответа вопрос будет передан организатору.':' Without a reply, the organiser will be asked to review it.') : ''),
    {reply_markup:{inline_keyboard:[[
      {text:ru?'✅ Подтверждаю':'✅ Confirm',callback_data:'res_ok:'+slot.challenge_id},
      {text:ru?'❌ Не согласен':'❌ Disagree',callback_data:'res_no:'+slot.challenge_id}
    ]]}});
}
export async function notifyStuckScore({slot,stage}) {
  for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
    if(!id)continue;const ru=(await nudgeLang(id))==='ru';
    await sendMessage(id,(ru?'<b>📊 Результат матча ещё не внесён</b>':'<b>📊 Your match result is still missing</b>')+'\n\n'
      +nudgeDetails(slot,ru?'ru':'en')+'\n\n'
      +(ru?'Внесите счёт, чтобы соперник мог подтвердить его. Если матч ещё не завершён, отметьте его как недоигранный.':'Enter the score so your opponent can confirm it. If the match is not finished, mark it as unfinished.'),
      {reply_markup:{inline_keyboard:[[{text:ru?'📝 Внести результат':'📝 Submit result',web_app:{url:PUBLIC_URL+'/match?result='+encodeURIComponent(slot.challenge_id)}}],[{text:ru?'⏸ Матч не доигран':'⏸ Match unfinished',callback_data:'match_unfinished:'+slot.challenge_id}]]}});
  }
}
export async function notifyScoreStalled(slot) {
  const chatId=await getAdminChatId();if(!chatId)return;
  return sendMessage(chatId,'<b>⚠️ Результат не внесён более 28 часов</b>\n\n'+nudgeDetails(slot,'ru')+'\n\nУточните у игроков, состоялся ли матч. Автоматически матч не отменён.');
}

// Счёт не отменяем и не засчитываем сами — эскалируем организатору.
// Копии активности по матчам в админский топик. По умолчанию ВЫКЛЮЧЕНЫ:
// организатору нужны обращения игроков, чеки и заявки, а не вся их переписка
// между собой. Включить при необходимости: Settings → admin_match_copies = on.
// Эскалации (счёт висит без подтверждения, спор по счёту) идут всегда — это
// просьба вмешаться, а не фоновый шум.
let matchCopyFlag = { t: 0, v: false };
async function adminCopiesOn() {
  if (Date.now() - matchCopyFlag.t < 60000) return matchCopyFlag.v;
  const raw = String(await getSetting('admin_match_copies').catch(() => '')).trim().toLowerCase();
  matchCopyFlag = { t: Date.now(), v: ['on', 'yes', 'true', '1'].includes(raw) };
  return matchCopyFlag.v;
}
async function adminMatchCopy(slot, body, { photo = '' } = {}) {
  if (!await adminCopiesOn()) return null;
  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (!chatId) return null;
    const opts = topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {};
    if (photo) return sendPhoto(chatId, photo, { caption: body, ...opts }).catch(() => sendMessage(chatId, body, opts));
    return sendMessage(chatId, body, opts);
  } catch (e) { console.error('admin match copy failed:', e.message); return null; }
}

export async function notifyResultStalled(slot) {
  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (!chatId) return null;
    return sendMessage(chatId, `<b>⚠️ Счёт висит без подтверждения</b>

${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${resultDateBlock(slot)}

${resultBlock(slot)}

Соперник не подтверждает счёт более 28 часов. Нужно разобраться вручную.`,
      topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {});
  } catch (e) { console.error('notifyResultStalled failed:', e.message); return null; }
}

// ---------------------------------------------------------------------------
// Перенос времени на том же корте
// ---------------------------------------------------------------------------
// Клавиатура выбора: полный игровой день с шагом 30 минут, по 4 в ряд.
export function timeChoiceKeyboard(slot, lang = 'ru') {
  const rows = [];
  let row = [];
  for (let m = 6 * 60; m <= 22 * 60; m += 30) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (hhmm === String(slot.agreed_time || '')) continue; // текущее время предлагать незачем
    row.push({ text: hhmm, callback_data: `mt_set:${slot.challenge_id}:${hhmm}` });
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  // Уходит через bot.js, мимо перевода кнопок в этом файле, — язык задаём сами.
  rows.push([{text:lang==='ru'?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);
  return { inline_keyboard: rows };
}

export function timeChoiceText(slot,lang='ru') {
  if(lang==='en')return '<b>🕐 New match time</b>\n\n'+escapeHtml(formatDate(slot.agreed_date,'en'))+' · '+escapeHtml(slot.agreed_court || '')+'\nCurrent: <b>'+escapeHtml(slot.agreed_time || '—')+'</b>\n\nChoose the time offered by the venue. Your opponent must confirm it.';
  return `<b>🕐 Новое время матча</b>

${escapeHtml(formatDate(slot.agreed_date))}${slot.agreed_court ? ` · ${escapeHtml(slot.agreed_court)}` : ''}
Сейчас: <b>${escapeHtml(slot.agreed_time || '—')}</b>

Выберите время, которое дала площадка. Соперник подтвердит — и оно станет основным.`;
}

// Новое время уходит сопернику на подтверждение: корт мог дать слот, в который он не успевает.
export async function notifyTimeChange(slot, newTime, proposerId) {
  const to = opponentOf(slot, proposerId);
  if (!to.id) return null;
  const lang=await nudgeLang(to.id),ru=lang==='ru';
  const by = opponentOf(slot, to.id);
  const end = endTime(newTime, slot.duration_min);
  return sendMessage(to.id, `<b>🕐 ${ru?"Площадка предлагает другое время":"The venue offers a different time"}</b>

${playerLink(by.name, by.username)} ${ru?"бронирует корт":"is booking the court"}${slot.agreed_court ? ` «${escapeHtml(slot.agreed_court)}»` : ''} ${ru?"и просит перенести:":"and proposes:"}

📅 ${escapeHtml(formatDate(slot.agreed_date,lang))}
${ru?"Было:":"Previous:"} <b>${escapeHtml(slot.agreed_time || '—')}</b>
${ru?"Станет:":"Proposed:"} <b>${escapeHtml(newTime)}${end ? '–' + escapeHtml(end) : ''}</b>

${ru?"Корт и дата те же — меняется только время.":"The date and court stay the same; only the time changes."}`, {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Подходит', callback_data: `mt_ok:${slot.challenge_id}:${newTime}` },
      { text: '❌ Не могу', callback_data: `mt_no:${slot.challenge_id}:${newTime}` }
    ],[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]] }
  }).catch(e => { console.error('notifyTimeChange failed:', e.message); return null; });
}

// Соперник согласился: время новое, матч остаётся активным, календарь пересобираем.
export async function notifyTimeChangeAccepted(slot,previousTime='') {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
 if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru',author=String(id)===String(slot.from_telegram_id);
 const tail=slot.court_confirmed_at?(ru?'Обновите матч в календаре.':'Update the match in your calendar.'):(author?(ru?'Когда площадка подтвердит, нажмите «Корт подтвердил» — это последний шаг.':'Once the venue confirms, tap “Court confirmed” — it’s the final step.'):(ru?'Ожидайте подтверждения брони от автора вызова.':'Wait for the challenge creator to confirm the court booking.'));
 const rows=[await contactRow(slot,id,lang)];rows.push([{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);if(slot.court_confirmed_at)rows.push(calendarRow(slot));else if(author)rows.push([{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}],[{text:ru?'✅ Корт подтвердил':'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}]);
 await sendMessage(id,(ru?'<b>✅ Время матча изменено</b>':'<b>✅ Match time updated</b>')+'\n\n'+agreedBlock(slot,lang)+(previousTime?'\n'+(ru?'Было: ':'Previous: ')+escapeHtml(previousTime):'')+'\n\n'+tail,{reply_markup:{inline_keyboard:rows.filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
 }await adminMatchCopy(slot,'<b>🕐 Время изменено</b>\n'+takenSlotText(slot));
}

// Соперник не может: время остаётся прежним, бронирующий пробует другой слот.
export async function notifyTimeChangeRejected(slot, rejectedTime, toId) {
  if (!toId) return null;
  const ru=(await nudgeLang(toId))==='ru';
  return sendMessage(toId,!ru?`<b>❌ Your opponent cannot play at ${escapeHtml(rejectedTime)}</b>\n\nThe match time stays at <b>${escapeHtml(slot.agreed_time||'—')}</b>. Ask the venue for another slot and propose it again.`: `<b>❌ Соперник не может в ${escapeHtml(rejectedTime)}</b>

Время матча осталось прежним: <b>${escapeHtml(slot.agreed_time || '—')}</b>.
Спросите у площадки другой слот и предложите его снова.`, {
    reply_markup: { inline_keyboard: [[{ text: '🕐 Предложить другое время', callback_data: `match_retime:${slot.challenge_id}` }],[{text:'✖️ Отменить матч',callback_data:'match_cancel:'+slot.challenge_id}]] }
  }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Результаты
// ---------------------------------------------------------------------------
function opponentOf(slot, telegramId) {
  return String(slot.from_telegram_id) === String(telegramId)
    ? { id: String(slot.to_telegram_id), name: slot.to_name, username: slot.to_username }
    : { id: String(slot.from_telegram_id), name: slot.from_name, username: slot.from_username };
}

// «Матч закончен — внесите результат». Уходит обоим после времени окончания.
export async function notifyResultPrompt(slot) {
  const kb = { inline_keyboard: [[{ text: '📝 Внести результат', web_app: { url: `${PUBLIC_URL}/match?result=${encodeURIComponent(slot.challenge_id)}` } }],[{ text: '⏸ Матч не доигран', callback_data: `match_unfinished:${slot.challenge_id}` }]] };
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    const lang=await nudgeLang(side),ru=lang==='ru';
    const opp = opponentOf(slot, side);
    await sendMessage(side, `<b>🎾 ${ru?"Матч сыгран?":"Match played?"}</b>

${ru?"Соперник:":"Opponent:"} ${playerLink(opp.name, opp.username)}
${resultDateBlock(slot,lang)}

${ru?"Счёт вносит кто-то один из вас — второй получит его на подтверждение, и матч попадёт в статистику лиги. Если соперник уже внёс счёт, просто подтвердите его.":"Only one of you needs to enter the score — the other will get it to confirm, and then it is recorded in the league standings. If your opponent has already entered it, just confirm."}`, { reply_markup: kb }).catch(e => console.error('result prompt failed:', e.message));
  }
}

// Уведомление организатору отправляется всегда, независимо от настройки
// фоновых копий матчей. Другой игрок получает одно сообщение без повторов.
export async function notifyMatchUnfinished(slot,{actorId='',evidenceOnly=false}={}) {
  const reporterId=String(actorId||slot.unfinished_by||'');
  const reporter=String(slot.from_telegram_id)===reporterId
    ?{id:reporterId,name:slot.from_name,username:slot.from_username}
    :{id:reporterId,name:slot.to_name,username:slot.to_username};
  const note=String(slot.unfinished_note||'').trim();
  const photo=String(slot.unfinished_photo_file_id||'').trim();
  let adminDelivery=null;
  try {
    const topic=await getOrCreatePlayerTopic({telegram_id:reporter.id,name:reporter.name,username:reporter.username});
    const chatId=topic?.chatId||await getAdminChatId();
    if(chatId) {
      const body='<b>'+(evidenceOnly?'📎 Дополнение: матч не доигран':'⏸ Матч не доигран')+'</b>\n\n'
        +escapeHtml(slot.from_name||'')+' — '+escapeHtml(slot.to_name||'')
        +(slot.division?' · '+escapeHtml(slot.division):'')+'\n'
        +resultDateBlock(slot,'ru')+'\n\n'
        +'Сообщил: <b>'+escapeHtml(reporter.name||reporter.id||'Игрок')+'</b>'
        +(note?'\nКомментарий: <i>'+escapeHtml(note)+'</i>':'\nКомментарий не добавлен.')
        +'\n\nАвтоматические напоминания остановлены. После завершения игроки смогут внести результат.';
      const opts=topic?.message_thread_id?{message_thread_id:topic.message_thread_id}:{};
      adminDelivery=photo
        ?await sendPhoto(chatId,photo,{caption:body,...opts}).catch(()=>sendMessage(chatId,body,opts))
        :await sendMessage(chatId,body,opts);
    }
  } catch(e) { console.error('unfinished match admin notification failed:',e.message); }
  if(!evidenceOnly) {
    const other=opponentOf(slot,reporterId);
    if(other.id) {
      const lang=await nudgeLang(other.id),ru=lang==='ru';
      await sendMessage(other.id,(ru?'<b>⏸ Матч отмечен как недоигранный</b>':'<b>⏸ Match marked unfinished</b>')+'\n\n'
        +resultDateBlock(slot,lang)+'\n\n'
        +(ru
          ?escapeHtml(reporter.name||'Соперник')+' сообщил, что матч ещё не завершён. Напоминания остановлены. После завершения любой из вас сможет внести результат.'
          :escapeHtml(reporter.name||'Your opponent')+' reported that the match is not finished. Reminders are paused. Either player can submit the result after the match is completed.'),
        {reply_markup:{inline_keyboard:[[{text:ru?'✅ Матч уже доигран':'✅ Match completed',web_app:{url:PUBLIC_URL+'/match?result='+encodeURIComponent(slot.challenge_id)}}]]}}).catch(()=>null);
    }
  }
  return adminDelivery;
}

// Стороны матча в порядке «победитель — проигравший».
function resultSides(slot) {
  const winnerIsFrom = String(slot.result_winner) === String(slot.from_telegram_id);
  return {
    winner: { name: winnerIsFrom ? slot.from_name : slot.to_name, username: winnerIsFrom ? slot.from_username : slot.to_username, telegramId: winnerIsFrom ? slot.from_telegram_id : slot.to_telegram_id },
    loser:  { name: winnerIsFrom ? slot.to_name : slot.from_name, username: winnerIsFrom ? slot.to_username : slot.from_username, telegramId: winnerIsFrom ? slot.to_telegram_id : slot.from_telegram_id }
  };
}

// Одна строка: победитель, счёт, проигравший — как это выглядело в старом боте.
function resultLine(slot) {
  if (String(slot.result_kind || '') === 'technical' && !slot.result_winner) {
    return `<b>${escapeHtml(slot.from_name || '')}</b>  L/L  <b>${escapeHtml(slot.to_name || '')}</b>`;
  }
  const { winner, loser } = resultSides(slot);
  return `<b>${escapeHtml(winner.name || '')}</b>  ${escapeHtml(winnerFirstScore(slot))}  ${escapeHtml(loser.name || '')}`;
}

function resultBlock(slot,lang="ru") {
  const note=String(slot.result_note||'').trim();
  return `🏆 ${resultLine(slot)}${note?`\n💬 <i>${escapeHtml(note)}</i>`:''}`;
}

// В карточках результата время и корт не показываем: матч уже сыгран,
// а при ручном вводе их вообще не спрашиваем.
function resultDateBlock(slot,lang="ru") {
  return slot.agreed_date ? `📅 ${escapeHtml(formatDate(slot.agreed_date,lang))}` : '';
}

// Повторная отправка просьбы подтвердить одному человеку. Нужна, когда игрок
// полез вносить счёт заново, не заметив уведомления: одно и то же сообщение
// шлём не чаще раза в несколько минут, иначе от трёх нажатий подряд прилетит
// три одинаковых письма.
const confirmResent = new Map();
const RESEND_GAP_MS = 5 * 60 * 1000;
function resendAllowed(challengeId, who) {
  const key = `${challengeId}:${who}`, now = Date.now();
  for (const [k, t] of confirmResent) if (now - t > RESEND_GAP_MS) confirmResent.delete(k);
  if (confirmResent.has(key)) return false;
  confirmResent.set(key, now);
  return true;
}

// Счёт внесён одной стороной — вторая подтверждает или оспаривает.
// only — прислать только этому человеку (повтор по его же просьбе).
export async function notifyResultForVerification(slot, { only = '' } = {}) {
  const { isOrganiserResult, resultConfirmationsLeft } = await import('./matchesdb.js');
  // Счёт от организатора подтверждают оба игрока: он не был на корте, и просить
  // подпись только у одного из них — значит лишить второго права возразить.
  // Автором счёта в таком случае честно называем организатора, а не игрока.
  const organiser = isOrganiserResult(slot);
  let targets = organiser
    ? resultConfirmationsLeft(slot).map(id => ({ id }))
    : [opponentOf(slot, slot.result_by)];
  // Страховка: автор счёта подтверждать себя не должен никогда, даже если
  // result_by по какой-то причине окажется неверным.
  targets = targets.filter(t => String(t?.id || '') && String(t.id) !== String(slot.result_by || ''));
  if (only) {
    targets = targets.filter(t => String(t.id) === String(only));
    if (!targets.length || !resendAllowed(slot.challenge_id, only)) return null;
  }
  const by = String(slot.result_by) === String(slot.from_telegram_id)
    ? { name: slot.from_name, username: slot.from_username }
    : { name: slot.to_name, username: slot.to_username };
  let delivered = null;
  for (const to of targets) {
    if (!to?.id) continue;
    const lang=await nudgeLang(to.id),ru=lang==='ru';
    const author = organiser
      ? (ru?'<b>Организатор</b> внёс счёт вашего матча:':'<b>The organiser</b> submitted your match score:')
      : `${playerLink(by.name, by.username)} ${ru?"внёс счёт:":"submitted the score:"}`;
    const tail = organiser
      ? (ru?"Подтвердить должны оба игрока. Если счёт неверен — нажмите «Не согласен», и организатор разберётся."
          :"Both players must confirm. If the score is wrong, tap “Disagree” and the organiser will look into it.")
      : (ru?"Если всё верно — подтвердите. Если нет — нажмите «Не согласен» и внесите свой вариант."
          :"Confirm if correct. Otherwise, tap “Disagree” and submit your version.");
    const text = `<b>📊 ${ru?"Подтвердите результат матча":"Confirm the match result"}</b>

${author}
${resultDateBlock(slot,lang)}

${resultBlock(slot,lang)}

${tail}`;
    const kb = { inline_keyboard: [
      [{ text: ru?'✅ Подтверждаю':'✅ Confirm', callback_data: `res_ok:${slot.challenge_id}` }],
      [{ text: ru?'❌ Не согласен':'❌ Disagree', callback_data: `res_no:${slot.challenge_id}` }]
    ] };
    const sent = slot.result_photo_file_id
      ? await sendPhoto(to.id, slot.result_photo_file_id, { caption: text, reply_markup: kb })
          .catch(async e => { console.error('result photo failed:', e.message); return sendMessage(to.id, text, { reply_markup: kb }); })
      : await sendMessage(to.id, text, { reply_markup: kb });
    delivered = delivered || sent;
  }
  return delivered;
}

// Первая подпись из двух: подтвердившему — что ждём второго, второму — что от
// него ждут ответа. Без этого первый думает, что всё готово, и уходит.
export async function notifyResultHalfConfirmed(slot, confirmedId) {
  const { resultConfirmationsLeft } = await import('./matchesdb.js');
  const left = resultConfirmationsLeft(slot);
  const other = left.find(id => String(id) !== String(confirmedId));
  if (confirmedId) {
    const ru=(await nudgeLang(confirmedId))==='ru';
    await sendMessage(confirmedId, `<b>✅ ${ru?'Ваше подтверждение принято':'Your confirmation is recorded'}</b>\n\n`
      + (ru?'Ждём подтверждение соперника — тогда результат уйдёт в таблицу.':'Waiting for your opponent — the result goes into the table once both confirm.')).catch(()=>{});
  }
  if (other) await notifyResultForVerification({ ...slot }).catch(()=>{});
  return true;
}

// Междивизионный матч: в зачёт он не идёт, поэтому счёт никуда не записан и ждёт
// решения организатора. Уведомление идёт всегда, даже если копии матчей выключены —
// иначе результат зависнет молча.
export async function notifyCrossDivision(slot, info = {}) {
  const chatId = await getAdminChatId().catch(() => '');
  if (!chatId) return null;
  let opts = {};
  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    if (topic?.message_thread_id) opts = { message_thread_id: topic.message_thread_id };
  } catch (e) { /* топика может не быть — пишем в общий админ-чат */ }
  const text = `<b>⚠️ Матч между разными дивизионами</b>

${escapeHtml(slot.from_name || '')} (${escapeHtml(info.d1 || '?')}) — ${escapeHtml(slot.to_name || '')} (${escapeHtml(info.d2 || '?')})
${resultDateBlock(slot)}

${resultBlock(slot)}

Счёт подтверждён обоими игроками, но <b>никуда не записан</b>: в зачёт дивизиона такой матч не идёт.
Записать его в общий журнал лиги или отклонить?`;
  return sendMessage(chatId, text, {
    ...opts,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Записать всё равно', callback_data: `res_force:${slot.challenge_id}` }],
      [{ text: '✖️ Отклонить', callback_data: `res_drop:${slot.challenge_id}` }]
    ] }
  }).catch(e => { console.error('notifyCrossDivision failed:', e.message); return null; });
}

// Организатор отклонил счёт — игрокам надо об этом сказать, иначе они будут ждать.
export async function notifyResultRejected(slot) {
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    const lang=await nudgeLang(side),ru=lang==='ru';
    await sendMessage(side, `<b>⚠️ ${ru?"Результат не засчитан":"Result not recorded"}</b>

${resultBlock(slot,lang)}

${ru?"Организатор не принял этот матч в зачёт. Свяжитесь с ним, если это ошибка.":"The organiser did not accept this match for the standings. Contact them if this is a mistake."}`).catch(() => {});
  }
}

export async function notifyResultConfirmed(slot, writeInfo = '') {
  const text = (opp,lang) => `<b>✅ ${lang==="ru"?"Результат засчитан":"Result recorded"}</b>

${lang==="ru"?"Соперник:":"Opponent:"} ${escapeHtml(opp.name || '')}
${resultDateBlock(slot,lang)}

${resultBlock(slot,lang)}`;
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    await sendMessage(side, text(opponentOf(slot, side),await nudgeLang(side))).catch(() => {});
  }
  await adminMatchCopy(slot, `<b>✅ Результат матча</b>\n\n${escapeHtml(slot.from_name)} — ${escapeHtml(slot.to_name)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}\n${resultDateBlock(slot)}\n\n${resultBlock(slot)}${writeInfo ? `\n\n<i>${escapeHtml(writeInfo)}</i>` : ''}`, { photo: slot.result_photo_file_id || '' });
}

export async function notifyResultDisputed(slot) {
  const to = String(slot.result_by || '');
  if (!to) return null;
  const lang=await nudgeLang(to),ru=lang==='ru';
  const opp = opponentOf(slot, to);
  return sendMessage(to, `<b>❌ ${ru?"Соперник не согласен со счётом":"Your opponent disputes the score"}</b>

${escapeHtml(opp.name || 'Соперник')} ${ru?"оспорил результат:":"disputed the result:"}
${resultBlock(slot,lang)}

${ru?"Свяжитесь и внесите согласованный счёт заново.":"Contact each other and resubmit the agreed score."}`, {
    reply_markup: { inline_keyboard: [[{ text: '📝 Внести заново', web_app: { url: `${PUBLIC_URL}/match?result=${encodeURIComponent(slot.challenge_id)}` } }]] }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Лента результатов: подтверждённый матч уходит ВСЕМ живым пользователям бота —
// не только текущему составу дивизионов, чтобы каждый видел, что лига идёт, —
// плюс копией одним сообщением в общую группу игроков. Участникам матча повторно
// не шлём: они уже получили персональную карточку.
// ---------------------------------------------------------------------------
async function resultsChat() {
  const chatId = RESULTS_CHAT_ID || await getSetting('results_chat_id');
  const topicId = RESULTS_TOPIC_ID || await getSetting('results_topic_id');
  return chatId ? { chatId, topicId: topicId ? Number(topicId) : null } : null;
}

// Счёт в таблице хранится «от автора заявки», а в ленте пары идут «победитель — проигравший».
// Если победил второй игрок, счёт нужно перевернуть, иначе 6:4 в тексте читается наоборот.
export function winnerFirstScore(slot) {
  const raw = String(slot.result_score || '');
  if (!raw) return '';
  if (String(slot.result_kind || '') === 'technical') return slot.result_winner ? 'W/L' : 'L/L';
  const retired=/\bRET\b/i.test(raw);
  const score=String(slot.result_winner) === String(slot.from_telegram_id) ? formatScore(cellToScore(raw)) : formatScore(reverseScore(cellToScore(raw)));
  return score+(retired?' RET':'');
}

// Первое имя — всегда победитель, счёт развёрнут в его сторону.
// Заголовок, дивизион и сезон, одна строка «победитель — счёт — проигравший».
// Всё, что кликается, ведёт внутрь приложения: карточки игроков и таблица того
// дивизиона, где сыгран матч. Ссылок на сайт в ленте больше нет.
async function feedCard(slot, lang='en') {
  const { winner, loser } = resultSides(slot);
  let season = String(slot.season || '');
  try {
    const { latestSeason } = await import('./division.js');
    if (!season) season = String(await latestSeason().catch(() => '') || '').trim();
  } catch { /* the registry may be unavailable */ }
  if (!season) season = String(await getSetting('season_number').catch(() => '') || '').trim();

  // Костас: имена в ленте вели в личку к игроку, а должны вести внутрь лиги.
  //
  // Прямая ссылка на мини-приложение (t.me/<бот>/<приложение>?startapp=...)
  // открывается прямо в Telegram и работает даже в группе, где кнопки web_app
  // запрещены. Короткое имя приложения задаётся в BotFather и хранится в
  // Settings; пока его нет, ссылки ведут на обычный адрес — как раньше.
  const appShort = String(await getSetting('MINIAPP_SHORT_NAME').catch(() => '') || '').trim().replace(/^@/, '');
  const pack = (value) => Buffer.from(String(value || ''), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const miniApp = (payload) => (cachedBotUsername && appShort)
    ? 'https://t.me/' + cachedBotUsername + '/' + appShort + '?startapp=' + payload : '';
  const playerUrl = (player) => {
    const deep = miniApp('p_' + pack(player?.name || ''));
    if (deep) return deep;
    const p = new URL(PUBLIC_URL + '/league');
    p.searchParams.set('player_name', player?.name || '');
    return p.toString();
  };
  const telegramLink = (player) => {
    const name = '<b>' + escapeHtml(player?.name || 'Player') + '</b>';
    if (!player?.name) return name;
    const deep = miniApp('p_' + pack(player.name));
    return deep ? '<a href="' + escapeHtml(deep) + '">' + name + '</a>' : name;
  };
  const subtitle = [slot.division, slot.group ? 'Group '+slot.group : '', season ? 'Season '+season : ''].filter(Boolean).join(' · ');
  const technicalBoth = String(slot.result_kind || '') === 'technical' && !slot.result_winner;
  const line = technicalBoth
    ? telegramLink({name:slot.from_name,username:slot.from_username,telegramId:slot.from_telegram_id})+'  L/L  '+telegramLink({name:slot.to_name,username:slot.to_username,telegramId:slot.to_telegram_id})
    : '🏆 '+telegramLink(winner)+'  <b>'+escapeHtml(winnerFirstScore(slot))+'</b>  '+telegramLink(loser);
  const text = '🎾 <b>Match Result</b>'+(subtitle ? '\n'+escapeHtml(subtitle) : '')+'\n\n'+line
    +(String(slot.result_note||'').trim() ? '\n💬 <i>'+escapeHtml(String(slot.result_note).trim())+'</i>' : '');
  const winnerLabel=technicalBoth?(slot.from_name||'Player'):(winner.name||'Player');
  const loserLabel=technicalBoth?(slot.to_name||'Player'):(loser.name||'Player');
  const winnerSide=technicalBoth?{name:slot.from_name}:winner, loserSide=technicalBoth?{name:slot.to_name}:loser;
  const standings=lang==='ru'?'📊 Таблица дивизиона':'📊 Division standings';
  // В ленте кнопок нет вовсе: имена в тексте и так кликаются и ведут в лигу, а
  // «отключить результаты» — настройка личная, ей место в личном сообщении.
  // Заодно снимается ограничение Telegram: кнопки мини-приложения в группах
  // не работают.
  const appBtn=(label,query)=>({text:label,web_app:{url:PUBLIC_URL+'/league'+query}});
  const dmButtons={ inline_keyboard:[
    [appBtn('🏆 '+winnerLabel,'?player_name='+encodeURIComponent(winnerSide?.name||'')),
     appBtn('👤 '+loserLabel,'?player_name='+encodeURIComponent(loserSide?.name||''))],
    [appBtn(standings,'?tab=div&division='+encodeURIComponent(slot.division||''))],
    [{text:lang==='ru'?'🔕 Отключить результаты':'🔕 Stop results',callback_data:'results_mute'}]
  ]};
  return { text, reply_markup: null, dm_reply_markup: dmButtons };
}

// Карточка результата создаётся всегда. Фото матча отправляется дополнительно.
// После первой загрузки карточки повторно используем Telegram file_id.
async function resultMedia(slot) {
  try {
    const { cardForSlot } = await import('./matchcard.js');
    const season = String(slot.season || await getSetting('season_number').catch(() => '') || '').trim();
    const buffer = await cardForSlot(slot, { winnerFirstScore, season });
    // Фото не нашлось из-за сбоя (а не потому, что его нет) — карточка всё
    // равно уходит, с инициалами, но админ должен об этом знать.
    const missing = buffer?.missingPhotos || [];
    if (missing.length) {
      const list = missing.map(x => `• ${escapeHtml(x.name)} — ${escapeHtml(String(x.reason).slice(0, 160))}`).join('\n');
      notifyAdmin(`<b>🖼 Карточка ушла без фото</b>\n\n${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}\n${list}\n\nЧаще всего это лимит запросов Google в момент рассылки. Пост в ленте можно перевыпустить с фото: <code>/fix_result номер_сообщения</code>.`)
        .catch(e => console.error('missing photo notice failed:', e.message));
    }
    return { buffer, season, kind:'card' };
  } catch (e) {
    console.error('match card failed:', e.message);
    return { kind:'none' };
  }
}
// Перевыпуск уже опубликованной карточки результата.
//
// Нужен, когда сообщение ушло с испорченной картинкой или старыми ссылками:
// переотправлять в ленту второй раз — значит спамить всех, поэтому правим на
// месте. Картинку Telegram принимает только по file_id, поэтому сначала
// отправляем свежую карточку в админский чат, забираем оттуда id и сразу
// удаляем временное сообщение.
//
// Ограничение Telegram: править своё сообщение бот может первые 48 часов.
export async function refreshResultPost(slot, messageId, adminChatId) {
  const chat = await resultsChat();
  if (!chat) throw new Error('Лента результатов не настроена.');
  const scope = await slotScope(slot);
  const full = { ...slot, season: scope.season, group: scope.group };
  const card = await feedCard(full, 'en');
  const media = await resultMedia(full);
  // Перевыпущенная карточка заменяет и сохранённую — в подборку уйдёт новая.
  if (media.buffer) await archiveResultCard(full, media.buffer);
  let fileId = media.fileId || '';
  let temp = null;
  if (!fileId && media.buffer) {
    temp = await sendPhotoBuffer(adminChatId, media.buffer, 'image/png', { caption: '⏳ Обновляю карточку…' });
    fileId = (temp?.photo || temp?.result?.photo || []).slice(-1)[0]?.file_id || '';
  }
  if (!fileId) throw new Error('Не удалось собрать карточку.');
  await editMessageMedia(chat.chatId, messageId,
    { type: 'photo', media: fileId, caption: card.text, parse_mode: 'HTML' },
    { reply_markup: card.reply_markup || { inline_keyboard: [] } });
  const tempId = temp?.message_id || temp?.result?.message_id;
  if (tempId) await deleteMessage(adminChatId, tempId).catch(() => {});
  return true;
}

// Предпросмотр результата «как уйдёт людям», но только заказчику.
//
// Ни лента, ни подписчики не затрагиваются: это способ посмотреть на карточку
// и текст на настоящем матче до того, как это увидят все. Показываем оба
// варианта — тот, что идёт в группу, и тот, что уходит в личку.
export async function previewResultPost(slot, chatId, { withButtons = true } = {}) {
  const scope = await slotScope(slot);
  const full = { ...slot, season: scope.season, group: scope.group };
  const group = await feedCard(full, 'en');
  const dm = await feedCard(full, 'ru');
  const media = await resultMedia(full);
  const send = async (caption, opts) => {
    if (media.fileId) return sendPhoto(chatId, media.fileId, { caption, ...opts });
    if (media.buffer) {
      const res = await sendPhotoBuffer(chatId, media.buffer, 'image/png', { caption, ...opts });
      const id = (res?.photo || res?.result?.photo || []).slice(-1)[0]?.file_id;
      if (id) media.fileId = id;
      return res;
    }
    return telegramSendMessage(chatId, caption, opts);
  };
  await telegramSendMessage(chatId, '1️⃣ <b>Так уйдёт в ленту результатов</b>');
  await send(group.text, group.reply_markup ? { reply_markup: group.reply_markup } : {});
  await telegramSendMessage(chatId, '2️⃣ <b>Так уйдёт каждому в личку</b>');
  // Кнопки мини-приложения Telegram принимает только в личной переписке.
  await send(dm.text, withButtons ? { reply_markup: dm.dm_reply_markup } : {})
    .catch(async () => { await send(dm.text, {}); await telegramSendMessage(chatId, '<i>Кнопки не показаны: в группе Telegram их не принимает. Запустите команду в личке с ботом.</i>'); });
  return true;
}

// Карточку результата сохраняем в момент, когда она собрана с правильными
// данными: форма и место на момент матча живут в памяти сервера всего пару
// часов, и пересобранная через неделю карточка показывала бы сегодняшнее
// состояние игроков. Файл отправляем в админский чат ФАЙЛОМ (оригинальное
// качество, без пережатия), забираем его id и тут же удаляем сообщение — в
// чате ничего не остаётся, а файл у Telegram живёт бессрочно.
export async function archiveResultCard(slot, buffer) {
  if (!buffer?.length || !slot?.challenge_id) return '';
  const chatId = await getAdminChatId().catch(() => '');
  if (!chatId) return '';
  try {
    const sent = await sendDocumentBuffer(chatId, buffer, `card-${slot.challenge_id}.png`, { disable_notification: true });
    const fileId = sent?.document?.file_id || sent?.result?.document?.file_id || '';
    if (sent?.message_id) await deleteMessage(chatId, sent.message_id).catch(() => {});
    if (fileId) await updateSlot(slot.challenge_id, { result_card_file_id: fileId });
    return fileId;
  } catch (e) {
    console.error('result card archive failed:', e.message);
    return '';
  }
}

// Список подписчиков для личной рассылки результата. Google иногда отвечает
// «лимит запросов» (обычно когда параллельно идёт большая рассылка) — тогда
// раньше личные сообщения молча не уходили никому. Теперь ждём и пробуем ещё
// раз; если не вышло и после этого — пишем админу, чей результат не разослан.
const SUBSCRIBER_RETRY_MS = [30_000, 60_000, 120_000];
async function subscribersWithRetry(slot, delays = SUBSCRIBER_RETRY_MS, load = getAllBotSubscribers) {
  let last = null;
  for (let i = 0; i <= delays.length; i++) {
    try { return await load(); }
    catch (e) {
      last = e;
      console.warn(`results subscribers read failed (try ${i + 1}):`, e.message);
      if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  await notifyAdmin(`<b>⚠️ Результат не разослан в личку</b>\n\n${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}\nСчёт: <b>${escapeHtml(winnerFirstScore(slot))}</b>\n\nGoogle не отдал список игроков после ${delays.length + 1} попыток: ${escapeHtml(String(last?.message || '').slice(0, 200))}\nПост в общей группе ушёл. Личные сообщения участникам матча отправлены.`)
    .catch(e => console.error('results retry notice failed:', e.message));
  return [];
}
export const __subscribersWithRetry = subscribersWithRetry;

// Рассылка результата — фон: она не должна отнимать лимит Google у тех, кто
// прямо сейчас вносит или подтверждает счёт.
export function broadcastResult(slot) { return withPriority('low', () => broadcastResultNow(slot)); }
async function broadcastResultNow(slot) {
  const scope = await slotScope(slot);
  slot = {...slot,season:scope.season,group:scope.group};
  const cards = { ru: await feedCard(slot, 'ru'), en: await feedCard(slot, 'en') };
  // Лента — общий английский фид, поэтому и карточка для группы английская.
  // В личку каждый получает свой язык (см. ниже).
  const { text, reply_markup } = cards.en;
  const media = await resultMedia(slot);
  if (media.buffer) await archiveResultCard(slot, media.buffer);
  const extraPhoto = slot.result_photo_file_id || '';
  // Первая отправка загружает файл, остальные — уже по file_id.
  const sendWith = async (chatId, caption, opts) => {
    if (media.fileId) return sendPhoto(chatId, media.fileId, { caption, ...opts });
    if (media.buffer) {
      const res = await sendPhotoBuffer(chatId, media.buffer, 'image/png', { caption, ...opts });
      const id = (res?.photo || res?.result?.photo || []).slice(-1)[0]?.file_id;
      if (id) media.fileId = id;
      return res;
    }
    return sendMessage(chatId, caption, opts);
  };

  // 1. Общая группа — одно сообщение вместо десятков личных.
  const chat = await resultsChat();
  if (chat) {
    const opts = { ...(chat.topicId ? { message_thread_id: chat.topicId } : {}), ...(reply_markup ? { reply_markup } : {}) };
    try {
      if (extraPhoto) await sendPhoto(chat.chatId, extraPhoto, { ...(chat.topicId ? {message_thread_id:chat.topicId} : {}) });
      await sendWith(chat.chatId, text, opts);
    }
    catch (e) { console.error('results group post failed:', e.message); }
  }

  // 2. Личная рассылка всем живым пользователям бота — на языке игрока и с той
  // же картинкой. Самих участников матча НЕ пропускаем: своё подтверждение они
  // уже получили, но карточку и ленту должны видеть наравне со всеми.
  let sent = 0, failed = 0;
  try {
    // Копию, а не исходный массив: список подписчиков кешируется.
    const players = [], seen = new Set();
    for (const p of await subscribersWithRetry(slot)) {
      if (!p?.telegram_id || seen.has(String(p.telegram_id))) continue;
      seen.add(String(p.telegram_id));
      players.push(p);
    }
    // Участники обязаны получить ленту, даже если в списке подписчиков их почему-то
    // нет — дописываем вручную.
    for (const id of [slot.from_telegram_id, slot.to_telegram_id]) {
      if (!id || seen.has(String(id))) continue;
      const who = await findApplicantByTelegramId(id).catch(() => null);
      players.push({ telegram_id: id, language: who?.language || 'ru' });
      seen.add(String(id));
    }
    // Массовая часть: здесь ожидание лимитов включено — сообщения важнее скорости.
    await withBulkRetries(async () => {
    for (const p of players) {
      // Заблокировал бота или удалил аккаунт — не тратим на него ни запроса.
      if (isChatDead(p.telegram_id)) { failed++; continue; }
      const card = String(p.language || '').toLowerCase() === 'en' ? cards.en : cards.ru;
      const opts = { reply_markup: card.dm_reply_markup };
      try {
        if (extraPhoto) {
          const gone = await sendPhoto(p.telegram_id, extraPhoto).then(() => false).catch(e => {
            if (e?.telegram?.error_code === 403) return true;   // заблокировал — карточку тоже не шлём
            console.error('extra match photo failed:', e.message); return false;
          });
          if (gone) { failed++; continue; }
        }
        await sendWith(p.telegram_id, card.text, opts)
          .catch(() => sendMessage(p.telegram_id, card.text, opts));
        sent++;
        await new Promise(r => setTimeout(r, 45));
      } catch (e) { failed++; }
    }
    });
  } catch (e) { console.error('results broadcast failed:', e.message); }
  const posterId=String(slot.challenge_id || slot.match_id || '');
  if (posterId) {
    await notifyAdmin(`<b>🎨 Постер матча</b>\n\n${escapeHtml(slot.from_name || 'Player 1')} — ${escapeHtml(slot.to_name || 'Player 2')}\nСчёт: <b>${escapeHtml(winnerFirstScore(slot))}</b>\n\nМожно сразу создать два варианта постера через OpenAI. Готовые PNG придут в этот админский топик.`, {
      reply_markup:{ inline_keyboard:[
        [{ text:'🎨 Создать 2 варианта', callback_data:`poster:prepare:${posterId}` }],
        [{ text:'✍️ Добавить комментарий', callback_data:`poster:comment:${posterId}` }]
      ] }
    }).catch(e => console.error('poster admin offer failed:',e.message));
  }
  await logMatchEvent('result_broadcast', slot, { telegram_id: slot.result_by, name: '' },
    `лента: ${chat ? 'группа + ' : ''}личных ${sent}, ошибок ${failed}`);
  return { sent, failed, group: Boolean(chat) };
}

// ---------------------------------------------------------------------------
// Свободная бронь корта: игрок выбирает дату, время, длительность и несколько
// площадок — бот выдаёт по сообщению на каждую с готовой ссылкой в WhatsApp.
// Бот сам ничего не отправляет: отправляет игрок.
// ---------------------------------------------------------------------------
export function courtRequestMessage({ date, time, durationMin }, lang = 'en') {
  const end = endTime(time, durationMin);
  const d = new Date(`${date}T12:00:00Z`);
  const human = Number.isNaN(d.getTime()) ? date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return [
    'Hello! I would like to book a tennis court.',
    '',
    `Date: ${human}`,
    `Time: ${time}${end ? '–' + end : ''} (${Number(durationMin) / 60}h)`,
    '',
    'Is it available? Thank you!'
  ].join('\n');
}

export async function sendCourtRequests(chatId, lang, form, courtsList) {
  const ru = lang === 'ru';
  const text = courtRequestMessage(form, lang);
  const chosen = (courtsList || []).filter(c => (form.courts || []).includes(c.name));
  if (!chosen.length) return { sent: 0 };

  await sendMessage(chatId, ru
    ? `<b>📲 Запросы на бронь готовы</b>\n\n📅 <b>${escapeHtml(formatDate(form.date,lang))}</b>\n🕐 <b>${escapeHtml(form.time)}–${escapeHtml(endTime(form.time, form.durationMin))}</b>\n\nНиже — по сообщению на каждую площадку. Откройте WhatsApp и отправьте; текст уже подставлен.`
    : `<b>📲 Booking requests ready</b>\n\n📅 <b>${escapeHtml(formatDate(form.date,lang))}</b>\n🕐 <b>${escapeHtml(form.time)}–${escapeHtml(endTime(form.time, form.durationMin))}</b>\n\nBelow is one message per venue. Open WhatsApp and send — the text is prefilled.`);

  let sent = 0;
  for (const court of chosen) {
    const rows = [];
    if (court.whatsapp) rows.push([{ text: ru ? `📲 Написать ${court.name}` : `📲 Message ${court.name}`, url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(text)}` }]);
    const body = `<b>${escapeHtml(court.name)}</b>${court.address ? `\n${escapeHtml(court.address)}` : ''}${court.whatsapp ? '' : `\n<i>${ru ? 'Номер WhatsApp не заполнен в листе Courts — скопируйте текст и отправьте вручную.' : 'No WhatsApp number in the Courts sheet — copy the text and send it manually.'}</i>`}\n\n<code>${escapeHtml(text)}</code>`;
    try {
      await sendMessage(chatId, body, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
      sent++;
      await new Promise(r => setTimeout(r, 45));
    } catch (e) { console.error('court request failed:', e.message); }
  }
  await logMatchEvent('court_request', { challenge_id: '', division: '' }, { telegram_id: chatId, name: '' },
    `${form.date} ${form.time} · ${Number(form.durationMin) / 60}ч · ${chosen.map(c => c.name).join(', ')}`);
  return { sent };
}

export { findSlot };

export async function matchContact(slot,viewerId) {
 const opp=opponentOf(slot,viewerId);if(!opp.id)return null;
 const applicant=await findApplicantByTelegramId(opp.id).catch(()=>null);
 const username=String(applicant?.telegram_username || applicant?.username || opp.username || "").replace(/^@/,"");
 return {id:opp.id,name:opp.name,username,url:username?`https://t.me/${username}`:`tg://user?id=${encodeURIComponent(opp.id)}`};
}
async function contactRow(slot,id,lang) {const c=await matchContact(slot,id);return c?[{text:lang==="ru"?"💬 Написать":"💬 Message",url:c.url}]:[];}


