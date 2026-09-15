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
import { sendMessage as telegramSendMessage, sendPhoto, sendPhotoBuffer } from './telegram.js';
import { getSetting, setSetting, findApplicantByTelegramId, getDivisionOpponents, getAllBotSubscribers, getWebsiteProfileUrl } from './sheets.js';
import { cellToScore, reverseScore, formatScore } from './tennis.js';
import { findSlot, updateSlot, cellToList, logMatchEvent, awaitingSide, proposerSide, getCourts } from './matchesdb.js';
import { slotScope } from './access.js';
import { PUBLIC_URL, RESULTS_CHAT_ID, RESULTS_TOPIC_ID, WEBSITE_URL } from './config.js';
import { escapeHtml, nowISO } from './util.js';
import { getAdminChatId, getOrCreatePlayerTopic } from './admin.js';

const MATCH_BUTTON_EN = {"🎾 Играю":"🎾 I’m in","📲 Забронировать корт":"📲 Book court","💬 Написать сопернику":"💬 Message opponent","👤 Профиль игрока":"👤 Player profile","🎾 Мои матчи":"🎾 My matches","✅ Выбрать время и принять":"✅ Choose time and respond","❌ Отклонить":"❌ Decline","📲 Отменить бронь корта":"📲 Cancel court booking","🎾 Создать окно":"🎾 Create slot","✅ Принять":"✅ Accept","🕐 Другое время":"🕐 Different time","📍 Другой корт":"📍 Different court","✅ Корт подтвердил":"✅ Court confirmed","🕐 Изменить время":"🕐 Change time","📲 Открыть WhatsApp":"📲 Open WhatsApp","📅 Добавить в календарь":"📅 Add to calendar","🎾 Матчи":"🎾 Matches","✅ Подходит":"✅ Works for me","❌ Не могу":"❌ Cannot play","🕐 Предложить снова":"🕐 Propose again","✅ Подтверждаю":"✅ Confirm","❌ Не согласен":"❌ Disagree","📅 Обновить в календаре":"📅 Update calendar","🕐 Предложить другое время":"🕐 Suggest another time","📝 Внести результат":"📝 Submit result","✅ Записать всё равно":"✅ Record anyway","✖️ Отклонить":"✖️ Reject","📝 Внести заново":"📝 Resubmit","✖️ Отменить запрос":"✖️ Cancel request","✖️ Отменить матч":"✖️ Cancel match"};
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
  return telegramSendMessage(chatId,text,{...opts,reply_markup:markup});
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

export async function publishOpenSlot(slot) {
  const recipients = await getDivisionOpponents(slot.division, slot.from_telegram_id, slot.season, slot.group).catch(e => {
    console.error('division recipients failed:', e.message);
    return [];
  });
  const text = openSlotText(slot);
  const opts = { reply_markup: openSlotKeyboard(slot) };
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await sendMessage(r.telegram_id, openSlotText(slot,await nudgeLang(r.telegram_id)), opts);
      sent++;
      await new Promise(res => setTimeout(res, 45)); // мягкий темп, чтобы не упереться в лимит Telegram
    } catch (e) {
      failed++;
      console.error(`open slot to ${r.telegram_id} failed:`, e.message);
    }
  }
  await logMatchEvent('broadcast', slot, { telegram_id: slot.from_telegram_id, name: slot.from_name },
    `дивизион ${slot.division}: отправлено ${sent}, ошибок ${failed}`);

  // Автору — сводка, сколько игроков увидели окно.
  const ru=(await nudgeLang(slot.from_telegram_id))==='ru';
  await sendMessage(slot.from_telegram_id, !ru ? (sent ? `📣 Your slot was sent to <b>${sent}</b> division players. I’ll notify you when someone responds.` : '📣 There are no eligible opponents with Telegram in your group yet.') : sent
    ? `📣 Окно отправлено игрокам дивизиона: <b>${sent}</b>.\nКак только кто-то откликнется, я пришлю предложение.`
    : `📣 В вашем дивизионе пока некому отправить окно — нет активных игроков с Telegram.`,{reply_markup:{inline_keyboard:[[{text:ru?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]]}}).catch(() => {});

  await adminMatchCopy(slot, `<b>📣 Новое окно</b>\n\n${text}\n\nРазослано игрокам: <b>${sent}</b>`);

  return { sent, failed };
}

// Окно рассылалось в личку многим игрокам, поэтому «закрывать карточку» негде.
// Тем, кто откроет мини-приложение, оно уже покажет, что окно занято.
async function closeSlotCard() { /* больше не требуется */ }

function contactsKeyboard(username, profileUrl, slot) {
  const rows = [];
  if (slot?.challenge_id) rows.push([{ text: '📲 Забронировать корт', callback_data: `match_book:${slot.challenge_id}` }]);
  if (username) rows.push([{ text: '💬 Написать сопернику', url: `https://t.me/${String(username).replace(/^@/, '')}` }]);
  if (profileUrl) rows.push([{ text: '👤 Профиль игрока', url: profileUrl }]);
  rows.push([{ text: '🎾 Мои матчи', web_app: { url: `${PUBLIC_URL}/match?tab=mine` } }]);
  return { inline_keyboard: rows };
}

async function profileUrlFor(telegramId) {
  const p = await findApplicantByTelegramId(telegramId).catch(() => null);
  return p?.player_profile_url || '';
}

export async function notifyMatchAgreed(slot) {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
  if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru',author=String(id)===String(slot.from_telegram_id),opp=opponentOf(slot,id);
  const rows=[];if(author)rows.push([{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}]);
  rows.push(await contactRow(slot,id,lang),[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]);
  await sendMessage(id,(ru?'<b>🎾 Матч согласован!</b>':'<b>🎾 Match agreed!</b>')+'\n\n'+playerLink(opp.name,opp.username)+'\n'+agreedBlock(slot,lang)+'\n\n'+(author?(ru?'Забронируйте корт и нажмите «Корт подтвердил» после ответа площадки.':'Book the court and tap “Court confirmed” after the venue agrees.'):(ru?'Автор вызова бронирует корт. Я сообщу вам, когда бронь будет подтверждена.':'The challenge creator will book the court. I’ll notify you when it is confirmed.')),{reply_markup:{inline_keyboard:rows.filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
 }
 await adminMatchCopy(slot,'<b>🎾 Матч согласован</b>\n'+takenSlotText(slot));
}

// Адресный вызов: соперник выбирает дату/корт в мини-приложении, поэтому кнопка ведёт туда.
export async function sendDirectChallenge(slot) {
  const lang=await nudgeLang(slot.to_telegram_id),ru=lang==='ru';
  const url = await profileUrlFor(slot.from_telegram_id);
  const rows = [[{ text: '✅ Выбрать время и принять', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}` } }],
                [{ text: '❌ Отклонить', callback_data: `match_decline:${slot.challenge_id}` }],
                [{ text: '✖️ Отменить запрос', callback_data: `match_cancel:${slot.challenge_id}` }]];
  if (url) rows.push([{ text: '👤 Профиль игрока', url }]);
  const text = `<b>🎾 ${ru?"Вызов на матч":"Match challenge"}</b>

${playerLink(slot.from_name, slot.from_username)} ${ru?"предлагает сыграть":"invites you to play"}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot,lang)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}`;
  const delivered = await sendMessage(slot.to_telegram_id, text, { reply_markup: { inline_keyboard: rows } });
  const ar=(await nudgeLang(slot.from_telegram_id))==='ru';
  const authorRows=[await contactRow(slot,slot.from_telegram_id,ar?'ru':'en'),[{text:ar?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ar?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length});
  await sendMessage(slot.from_telegram_id,(ar?'<b>🎯 Вызов отправлен</b>':'<b>🎯 Challenge sent</b>')+'\n\n'+playerLink(slot.to_name,slot.to_username)+'\n'+offerBlock(slot,ar?'ru':'en')+'\n\n'+(ar?'Ожидаем ответ соперника. Если предложение потеряет актуальность, отмените его кнопкой ниже.':'Waiting for your opponent. Cancel below if the proposal is no longer relevant.'),{reply_markup:{inline_keyboard:authorRows}}).catch(function(){});
  return delivered;
}

export async function declineDirectChallenge(slot, actor = {}) {
  await updateSlot(slot.challenge_id, { status: 'declined', responded_at: nowISO() });
  await logMatchEvent('declined', slot, actor);
  const lang=await nudgeLang(slot.from_telegram_id);
  await sendMessage(slot.from_telegram_id, lang==='en'?`❌ ${escapeHtml(slot.to_name || 'Player')} declined your challenge for ${escapeHtml(datesLine(slot,lang))}.` : `❌ ${escapeHtml(slot.to_name || 'Игрок')} отклонил вызов на ${escapeHtml(datesLine(slot))}.`).catch(() => {});
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
    [{ text: '✅ Принять', callback_data: `match_ok:${slot.challenge_id}` }],
    [{ text: '🕐 Другое время', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=time` } },
     { text: '📍 Другой корт', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=court` } }],
    [{ text: '❌ Отклонить', callback_data: `match_no:${slot.challenge_id}` }],
    [{ text: '✖️ Отменить запрос', callback_data: `match_cancel:${slot.challenge_id}` }]
  ] };
}

export async function notifyProposal(slot, { isCounter = false } = {}) {
  const to = awaitingSide(slot);
  const by = proposerSide(slot);
  if (!to.id) return null;
  const lang=await nudgeLang(to.id),ru=lang==='ru';
  const head = !ru?(isCounter?'<b>🔄 Counterproposal</b>':'<b>🎾 Response to your slot</b>'): isCounter ? '<b>🔄 Встречное предложение</b>' : '<b>🎾 Отклик на твоё окно</b>';
  const text = `${head}

${playerLink(by.name, by.username)} ${ru?"предлагает сыграть:":"proposes a match:"}
${agreedBlock(slot,lang)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}

${ru?"Подтверди или предложи своё.":"Accept or suggest an alternative."}`;
  const delivered=await sendMessage(to.id, text, { reply_markup: proposalKeyboard(slot) }).catch(e => console.error('notifyProposal failed:', e.message));
  if(by.id){const pr=(await nudgeLang(by.id))==='ru';const rows=[await contactRow(slot,by.id,pr?'ru':'en'),[{text:pr?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:pr?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length});await sendMessage(by.id,(pr?'<b>✅ Предложение отправлено</b>':'<b>✅ Proposal sent</b>')+'\n\n'+agreedBlock(slot,pr?'ru':'en')+'\n\n'+(pr?'Ожидаем ответ соперника.':'Waiting for your opponent.'),{reply_markup:{inline_keyboard:rows}}).catch(function(){})}
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
    if(court?.whatsapp)rows.push([{text:'📲 Open WhatsApp',url:'https://wa.me/'+court.whatsapp+'?text='+encodeURIComponent(text)}]);
    rows.push([{text:'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}],[{text:'🕐 Change time',callback_data:'match_retime:'+slot.challenge_id}],[{text:'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);
    return sendMessage(chatId,'<b>📲 Court booking</b>\n\n'+escapeHtml(court?.name || slot.agreed_court || '')+'\n'+(court?.whatsapp?'Open WhatsApp and send the request. After the venue agrees, tap “Court confirmed”.':'Copy the message and send it to the venue. After confirmation, tap “Court confirmed”.')+'\n\n<code>'+escapeHtml(text)+'</code>',{reply_markup:{inline_keyboard:rows}});
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
Откройте WhatsApp и отправьте сообщение. Когда площадка ответит согласием — нажмите «Корт подтвердил».

<code>${escapeHtml(text)}</code>`, {
    reply_markup: { inline_keyboard: [
      [{ text: '📲 Открыть WhatsApp', url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(text)}` }],
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

export async function notifyCourtConfirmed(slot) {
 for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
  if(!id)continue;const lang=await nudgeLang(id),ru=lang==='ru';
  const rows=[[{text:ru?'📅 Добавить в календарь':'📅 Add to calendar',web_app:{url:matchCalendarUrl(slot)}}],await contactRow(slot,id,lang)];
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
 const head=kind==='day'?(isToday(slot.agreed_date)?(ru?'Сегодня матч':'Match today'):(ru?'Завтра матч':'Match tomorrow')):(ru?'Матч через 3 часа':'Match in 3 hours');
 const tail=slot.court_confirmed_at?(ru?'Корт подтверждён. Если планы изменились — предупредите соперника.':'Court confirmed. Let your opponent know if your plans change.'):(author?(ru?'Проверьте ответ площадки и подтвердите бронь корта.':'Check the venue’s reply and confirm your court booking.'):(ru?'Ожидается подтверждение брони от автора вызова.':'Waiting for the challenge creator to confirm the court booking.'));
 await sendMessage(id,'<b>🎾 '+head+'</b>\n\n'+agreedBlock(slot,lang)+'\n\n'+tail,{reply_markup:{inline_keyboard:[await contactRow(slot,id,lang),[{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}],[{text:ru?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(r=>r.length)}}).catch(e=>console.error('player match notice:',e.message));
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
function nudgeWarning(stage,ru) {
  return stage==='d1'?(ru?'Это последнее напоминание: неподтверждённое предложение будет снято.':'Final reminder: the unconfirmed proposal will expire.')
    :stage==='n2'?(ru?'Завершите этот этап, чтобы предложение не закрылось.':'Complete this step before the proposal expires.') : '';
}
export async function notifyStuckNegotiation({slot,stage,waiting,proposer,initial=false}) {
  if(!waiting?.id)return null;
  const ru=(await nudgeLang(waiting.id))==='ru';
  const rows=initial?[
    [{text:ru?'✅ Выбрать время и принять':'✅ Choose time and respond',web_app:{url:PUBLIC_URL+'/match?slot='+encodeURIComponent(slot.challenge_id)}}],
    [{text:ru?'❌ Отклонить':'❌ Decline',callback_data:'match_decline:'+slot.challenge_id}],
    [{text:ru?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}]
  ]:[
    [{text:ru?'✅ Принять':'✅ Accept',callback_data:'match_ok:'+slot.challenge_id}],
    [{text:ru?'🕐 Другое время':'🕐 Different time',web_app:{url:PUBLIC_URL+'/match?counter='+encodeURIComponent(slot.challenge_id)}}],
    [{text:ru?'❌ Отклонить':'❌ Decline',callback_data:'match_no:'+slot.challenge_id}],
    [{text:ru?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}]
  ];
  await sendMessage(waiting.id,(ru?'<b>⏳ Согласование матча не завершено</b>':'<b>⏳ Your match still needs an answer</b>')+'\n\n'
    +nudgeDetails(slot,ru?'ru':'en',initial)+'\n\n'
    +(ru?'Ответьте на вызов: подтвердите условия или предложите свои.':'Respond to the challenge: confirm the details or suggest your own.')
    +'\n'+nudgeWarning(stage,ru),{reply_markup:{inline_keyboard:rows}});
  if(stage==='n2'&&proposer?.id) {
    const pr=(await nudgeLang(proposer.id))==='ru';
    await sendMessage(proposer.id,(pr?'⏳ Соперник пока не ответил. Можно написать ему напрямую.':'⏳ Your opponent has not replied yet. You can contact them directly.'),
      {reply_markup:{inline_keyboard:[await contactRow(slot,proposer.id,pr?'ru':'en'),[{text:pr?'✖️ Отменить запрос':'✖️ Cancel request',callback_data:'match_cancel:'+slot.challenge_id}],[{text:pr?'🎾 Мои матчи':'🎾 My matches',web_app:{url:PUBLIC_URL+'/match?tab=mine'}}]].filter(function(r){return r.length})}}).catch(()=>{});
  }
  return true;
}
export async function notifyNegotiationExpired(slot,{backToOpen=false,scope='negotiation'}={}) {
  for(const id of [slot.from_telegram_id,slot.to_telegram_id]) {
    if(!id)continue;const ru=(await nudgeLang(id))==='ru';
    const reason=scope==='court'
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
      +'\n'+nudgeWarning(stage,ru),{reply_markup:{inline_keyboard:[
        [{text:ru?'✅ Корт подтвердил':'✅ Court confirmed',callback_data:'match_court_ok:'+slot.challenge_id}],
        [{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}],
        [{text:ru?'🕐 Изменить время':'🕐 Change time',callback_data:'match_retime:'+slot.challenge_id}],
        [{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]
      ]}});
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

export async function notifyStuckResult({slot,stage,waitingId}) {
  if(!waitingId)return null;const ru=(await nudgeLang(waitingId))==='ru';
  return sendMessage(waitingId,(ru?'<b>⏳ Счёт ждёт вашего подтверждения</b>':'<b>⏳ The score needs your confirmation</b>')+'\n\n'
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
      +(ru?'Внесите счёт, чтобы соперник мог подтвердить его. Если матч не состоялся, сообщите организатору.':'Enter the score so your opponent can confirm it. If the match did not take place, contact the organiser.'),
      {reply_markup:{inline_keyboard:[[{text:ru?'📝 Внести результат':'📝 Submit result',web_app:{url:PUBLIC_URL+'/match?tab=res'}}]]}});
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
export function timeChoiceKeyboard(slot) {
  const rows = [];
  let row = [];
  for (let m = 6 * 60; m <= 22 * 60; m += 30) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (hhmm === String(slot.agreed_time || '')) continue; // текущее время предлагать незачем
    row.push({ text: hhmm, callback_data: `mt_set:${slot.challenge_id}:${hhmm}` });
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{text:'✖️ Отменить матч',callback_data:'match_cancel:'+slot.challenge_id}]);
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
 const tail=slot.court_confirmed_at?(ru?'Обновите матч в календаре.':'Update the match in your calendar.'):(author?(ru?'После ответа площадки подтвердите бронь корта.':'Confirm the court booking after the venue agrees.'):(ru?'Ожидайте подтверждения брони от автора вызова.':'Wait for the challenge creator to confirm the court booking.'));
 const rows=[await contactRow(slot,id,lang)];rows.push([{text:ru?'✖️ Отменить матч':'✖️ Cancel match',callback_data:'match_cancel:'+slot.challenge_id}]);if(slot.court_confirmed_at)rows.push([{text:ru?'📅 Обновить в календаре':'📅 Update calendar',web_app:{url:matchCalendarUrl(slot)}}]);else if(author)rows.push([{text:ru?'📲 Забронировать корт':'📲 Book court',callback_data:'match_book:'+slot.challenge_id}]);
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
  const kb = { inline_keyboard: [[{ text: '📝 Внести результат', web_app: { url: `${PUBLIC_URL}/match?result=${encodeURIComponent(slot.challenge_id)}` } }]] };
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    const lang=await nudgeLang(side),ru=lang==='ru';
    const opp = opponentOf(slot, side);
    await sendMessage(side, `<b>🎾 ${ru?"Матч сыгран?":"Match played?"}</b>

${ru?"Соперник:":"Opponent:"} ${playerLink(opp.name, opp.username)}
${resultDateBlock(slot,lang)}

${ru?"Внесите счёт — соперник подтвердит, и матч попадёт в статистику лиги.":"Enter the score. Your opponent will confirm it before it is recorded in the league standings."}`, { reply_markup: kb }).catch(e => console.error('result prompt failed:', e.message));
  }
}

// Стороны матча в порядке «победитель — проигравший».
function resultSides(slot) {
  const winnerIsFrom = String(slot.result_winner) === String(slot.from_telegram_id);
  return {
    winner: { name: winnerIsFrom ? slot.from_name : slot.to_name, username: winnerIsFrom ? slot.from_username : slot.to_username },
    loser:  { name: winnerIsFrom ? slot.to_name : slot.from_name, username: winnerIsFrom ? slot.to_username : slot.from_username }
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
  return `🏆 ${resultLine(slot)}${slot.result_set3_mode === 'Match TB' ? (lang==='ru'?'\n<i>чемпионский тай-брейк</i>':'\n<i>match tie-break</i>') : ''}${note?`\n💬 <i>${escapeHtml(note)}</i>`:''}`;
}

// В карточках результата время и корт не показываем: матч уже сыгран,
// а при ручном вводе их вообще не спрашиваем.
function resultDateBlock(slot,lang="ru") {
  return slot.agreed_date ? `📅 ${escapeHtml(formatDate(slot.agreed_date,lang))}` : '';
}

// Счёт внесён одной стороной — вторая подтверждает или оспаривает.
export async function notifyResultForVerification(slot) {
  const to = opponentOf(slot, slot.result_by);
  const by = String(slot.result_by) === String(slot.from_telegram_id)
    ? { name: slot.from_name, username: slot.from_username }
    : { name: slot.to_name, username: slot.to_username };
  if (!to.id) return null;
  const lang=await nudgeLang(to.id),ru=lang==='ru';
  const text = `<b>📊 ${ru?"Подтвердите результат матча":"Confirm the match result"}</b>

${playerLink(by.name, by.username)} ${ru?"внёс счёт:":"submitted the score:"}
${resultDateBlock(slot,lang)}

${resultBlock(slot,lang)}

${ru?"Если всё верно — подтвердите. Если нет — нажмите «Не согласен» и внесите свой вариант.":"Confirm if correct. Otherwise, tap “Disagree” and submit your version."}`;
  const kb = { inline_keyboard: [
    [{ text: ru?'✅ Подтверждаю':'✅ Confirm', callback_data: `res_ok:${slot.challenge_id}` }],
    [{ text: ru?'❌ Не согласен':'❌ Disagree', callback_data: `res_no:${slot.challenge_id}` }]
  ] };
  if (slot.result_photo_file_id) {
    return sendPhoto(to.id, slot.result_photo_file_id, { caption: text, reply_markup: kb })
      .catch(async e => { console.error('result photo failed:', e.message); return sendMessage(to.id, text, { reply_markup: kb }); });
  }
  return sendMessage(to.id, text, { reply_markup: kb }).catch(e => console.error('verify request failed:', e.message));
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
async function feedCard(slot, lang = 'ru') {
  const { winner, loser } = resultSides(slot);
  let season = String(slot.season || '');
  try {
    const { latestSeason } = await import('./division.js');
    if (!season) season = String(await latestSeason().catch(() => '') || '').trim();
  } catch { /* реестра может не быть */ }
  if (!season) season = String(await getSetting('season_number').catch(() => '') || '').trim();

  const ru = String(lang || 'ru').toLowerCase() !== 'en';
  const subtitle = [slot.division, slot.group ? `${ru ? 'Группа' : 'Group'} ${slot.group}` : '', season ? `${ru ? 'Сезон' : 'Season'} ${season}` : ''].filter(Boolean).join(' · ');

  const text = `🎾 <b>${ru ? 'Результат матча' : 'Match Result'}</b>${subtitle ? `\n${escapeHtml(subtitle)}` : ''}

${resultLine(slot)}${slot.result_set3_mode === 'Match TB' ? `\n<i>${ru ? 'чемпионский тай-брейк' : 'match tie-break'}</i>` : ''}${slot.result_note?`\n💬 <i>${escapeHtml(slot.result_note)}</i>`:''}`;

  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || (ru ? 'игрок' : 'player');
  const playerLink = (name) => `${PUBLIC_URL}/league?tab=players&player_name=${encodeURIComponent(String(name || ''))}`;
  const letter = String(slot.division || '').replace(/^(division|дивизион)\s*/i, '').trim();
  const tableLink = `${PUBLIC_URL}/league?tab=div`
    + (letter ? `&division=${encodeURIComponent(letter)}` : '')
    + (letter && season ? `&season=${encodeURIComponent(season)}` : '');

  const keyboard = [];
  const row = [];
  if (winner.name) row.push({ text: `🏆 ${firstName(winner.name)}`, web_app: { url: playerLink(winner.name) } });
  if (loser.name) row.push({ text: `👤 ${firstName(loser.name)}`, web_app: { url: playerLink(loser.name) } });
  if (row.length) keyboard.push(row);
  keyboard.push([{ text: ru ? '📊 Таблица дивизиона' : '📊 Division standings', web_app: { url: tableLink } }]);
  // В группе кнопка отписки бессмысленна — она только для личной рассылки.
  const dmKeyboard = [...keyboard, [{ text: ru ? '🔕 Не присылать результаты' : '🔕 Stop results', callback_data: 'results_mute' }]];
  // Кнопки мини-приложения Telegram разрешает только в личных чатах: в группе
  // такое сообщение он просто отклонит. Поэтому в ленту группы уходит один
  // текст с фотографией, а кнопки — в личную рассылку.
  return { text, reply_markup: undefined, dm_reply_markup: { inline_keyboard: dmKeyboard } };
}

// Карточка результата создаётся всегда. Фото матча отправляется дополнительно.
// После первой загрузки карточки повторно используем Telegram file_id.
async function resultMedia(slot) {
  try {
    const { cardForSlot } = await import('./matchcard.js');
    const season = String(slot.season || await getSetting('season_number').catch(() => '') || '').trim();
    const buffer = await cardForSlot(slot, { winnerFirstScore, season });
    return { buffer, kind: 'card' };
  } catch (e) {
    console.error('match card failed:', e.message);
    return { kind: 'none' };
  }
}

export async function broadcastResult(slot) {
  const scope = await slotScope(slot);
  slot = {...slot,season:scope.season,group:scope.group};
  const cards = { ru: await feedCard(slot, 'ru'), en: await feedCard(slot, 'en') };
  const { text, reply_markup } = cards.ru;
  const media = await resultMedia(slot);
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
      await sendWith(chat.chatId, text, opts);
      if (extraPhoto) await sendPhoto(chat.chatId, extraPhoto, { ...(chat.topicId ? {message_thread_id:chat.topicId} : {}) });
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
    for (const p of await getAllBotSubscribers()) {
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
    for (const p of players) {
      const card = String(p.language || '').toLowerCase() === 'en' ? cards.en : cards.ru;
      const opts = { reply_markup: card.dm_reply_markup };
      try {
        await sendWith(p.telegram_id, card.text, opts)
          .catch(() => sendMessage(p.telegram_id, card.text, opts));
        if (extraPhoto) await sendPhoto(p.telegram_id, extraPhoto).catch(e => console.error('extra match photo failed:', e.message));
        sent++;
        await new Promise(r => setTimeout(r, 45));
      } catch (e) { failed++; }
    }
  } catch (e) { console.error('results broadcast failed:', e.message); }
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
