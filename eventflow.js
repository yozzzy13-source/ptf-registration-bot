// Ветка событий: карточка, рассылка, запись, счёт, оплата и отмена.
//
// Правила, о которых договорились:
//   • карточку события организатор один раз подтверждает перед рассылкой,
//     дальше заявки идут сами: есть места — сразу счёт, нет — лист ожидания;
//   • оплата с депозита списывается одной кнопкой, без скриншота;
//   • отмена раньше refund_hours возвращает деньги на депозит, позже — сгорают;
//   • при отмене спрашиваем, остаются ли гости;
//   • организатору по каждому игроку уходит ОДНО сообщение, которое дальше
//     редактируется, а не десяток новых.
import { sendMessage, editMessageText } from './telegram.js';
import { escapeHtml, safe } from './util.js';
import { PUBLIC_URL } from './config.js';
import { getSetting, setSetting, getPaymentMethods, playerGroup } from './sheets.js';
import {
  findEvent, listEvents, listSignups, findSignup, createSignup, updateSignup,
  takenSeats, priceFor, seatsOf, refundForCancel, hoursUntil, eventStartMs,
  addTransaction, getBalance, publishEvent, updateEvent, deleteEventRow, addRefund,
  SIGNUP_STATUS, CANCEL_LIMIT_HOURS
} from './events.js';

const ru = (lang) => lang === 'ru';

// Дата в карточке: год не нужен — события ближние, а вот день недели важен,
// по нему человек сразу понимает, попадает ли он.
const DOW_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDay(date, lang = 'ru') {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(safe(date));
  if (!m) return safe(date);
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  const dow = (ru(lang) ? DOW_RU : DOW_EN)[d.getUTCDay()];
  return `${dow}, ${m[1]}.${m[2]}`;
}

// Кнопки «добавить в календарь» — как в тренерском боте: Google открывается
// ссылкой, Apple через маленькую страницу, которая отдаёт .ics в системный
// календарь. Длительность события в таблице не хранится, берём два часа.
const EVENT_HOURS = 2;
function icsTimes(event) {
  const start = eventStartMs(event);
  if (!start) return null;
  const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { start: f(start), end: f(start + EVENT_HOURS * 3600000), startMs: start };
}
export function calendarButtons(event, lang = 'ru') {
  const t = icsTimes(event);
  if (!t) return null;
  const L = ru(lang);
  const title = (L ? event.title_ru : event.title_en) || event.title_ru || '';
  const details = (L ? event.description_ru : event.description_en) || '';
  const google = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(title)
    + '&dates=' + t.start + '/' + t.end
    + '&details=' + encodeURIComponent(details)
    + '&location=' + encodeURIComponent(event.place || '');
  const apple = `${PUBLIC_URL}/cal?e=${encodeURIComponent(event.event_id)}&l=${L ? 'ru' : 'en'}`;
  return [
    { text: L ? '📅 Google Календарь' : '📅 Google Calendar', url: google },
    { text: L ? '🍎 Apple Календарь' : '🍎 Apple Calendar', web_app: { url: apple } }
  ];
}
// Подтверждение участия: календарь и сразу отмена. Без отмены человек, который
// записался и передумал, остаётся в составе — кнопки у него нигде нет, только в
// мини-приложении или в напоминании накануне, а это уже поздно.
export function calendarKeyboard(event, lang = 'ru', signupId = '') {
  const rows = [];
  const row = calendarButtons(event, lang);
  if (row) rows.push(row);
  if (signupId) rows.push([{ text: ru(lang) ? '❌ Отменить участие' : '❌ Cancel', callback_data: `ev_cxl:${signupId}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Способы оплаты в батах из вкладки «Payment Methods». Крипта сюда не попадает:
// в USDT принимаем только участие в лиге, события — всегда баты.
export async function thbPaymentDetails() {
  const methods = await getPaymentMethods().catch(() => []);
  return methods
    .filter(m => String(m.method_type || '').toLowerCase() !== 'crypto')
    .filter(m => !String(m.currency || 'THB').trim() || String(m.currency).trim().toUpperCase() === 'THB')
    .filter(m => safe(m.recipient))
    .map(m => ({
      title: safe(m.display_name_ru) || safe(m.display_name_en) || 'Bank Transfer',
      recipient: safe(m.recipient)
    }));
}

// Страница, которая отдаёт .ics и сама нажимает на ссылку: системный календарь
// открывается без лишних шагов. Файл кладём прямо в ссылку, чтобы не хранить
// его на диске и не заботиться об уборке.
export function icsForEvent(event, lang = 'ru') {
  const L = ru(lang);
  const t = icsTimes(event);
  const title = (L ? event.title_ru : event.title_en) || event.title_ru || 'PTF';
  const clean = (v) => String(v || '').replace(/[\r\n,;]/g, ' ');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PTF//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.event_id || 'ptf'}@phukettennis`,
    `DTSTAMP:${stamp}`,
    t ? `DTSTART:${t.start}` : '',
    t ? `DTEND:${t.end}` : '',
    `SUMMARY:${clean(title)}`,
    event.place ? `LOCATION:${clean(event.place)}` : '',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  const href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  const when = `${fmtDay(event.date, lang)} ${escapeHtml(event.time || '')}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:40px 20px;background:#0A0A0B;color:#EFEBE4">
<h2 style="margin:0 0 6px">📅 ${L ? 'Добавить в календарь' : 'Add to calendar'}</h2>
<p style="color:#B9B1A5;margin:0">${escapeHtml(title)}<br>${when}</p>
<a id="dl" href="${href}" download="ptf-event.ics"
  style="display:inline-block;margin-top:22px;padding:15px 26px;background:#E8A45C;color:#191512;
  border-radius:12px;text-decoration:none;font-size:16px;font-weight:800">
  ${L ? 'Открыть в Календаре' : 'Open in Calendar'}</a>
<p style="margin-top:22px;color:#8A7F6F;font-size:13px">
  ${L ? 'Если не открылось само — нажми кнопку.' : 'If it did not open automatically, tap the button.'}</p>
<script>setTimeout(function(){try{document.getElementById('dl').click()}catch(e){}},400)</script>
</body></html>`;
}

// --- карточка события ------------------------------------------------------

// Формат взят из тренерского бота: эмодзи, место, дата, время, свободные места.
// lead — карточка уходит в рассылку: сверху ставим заголовок «НОВОЕ СОБЫТИЕ»,
// чтобы в ленте сообщений она сразу читалась как анонс. Название при этом идёт
// отдельной строкой без мячика — два подряд выглядят неряшливо.
export function eventCard(event, lang = 'ru', { taken = 0, lead = false } = {}) {
  const L = ru(lang);
  const title = (L ? event.title_ru : event.title_en) || event.title_ru || event.title_en;
  const desc = (L ? event.description_ru : event.description_en) || '';
  const lines = lead
    ? [L ? '🎾 <b>НОВОЕ СОБЫТИЕ</b>' : '🎾 <b>NEW EVENT</b>', '', `<b>${escapeHtml(title)}</b>`]
    : [`🎾 <b>${escapeHtml(title)}</b>`];
  // Описание идёт сразу под заголовком: сперва о чём событие, потом детали.
  if (desc) lines.push('', escapeHtml(desc), '');
  // Место — ссылкой, если она задана; сам адрес отдельной строкой не дублируем.
  if (event.place) {
    lines.push(event.place_url
      ? `📍 <a href="${escapeHtml(event.place_url)}">${escapeHtml(event.place)}</a>`
      : `📍 ${escapeHtml(event.place)}`);
  }
  if (event.date) lines.push(`📅 <b>${escapeHtml(fmtDay(event.date, lang))}</b>`);
  if (event.time) lines.push(`🕐 <b>${escapeHtml(event.time)}</b>`);
  if (event.capacity) {
    const left = Math.max(0, event.capacity - taken);
    lines.push(L ? `👥 Свободно мест: <b>${left} из ${event.capacity}</b>`
                 : `👥 Spots available: <b>${left} of ${event.capacity}</b>`);
  }
  if (event.payment_required && event.price_thb) {
    lines.push(L ? `💳 Участие: <b>${event.price_thb} ฿</b>` : `💳 Entry: <b>${event.price_thb} ฿</b>`);
    const gp = event.guest_price_thb === null ? event.price_thb : event.guest_price_thb;
    if (event.guests_allowed) lines.push(L ? `➕ Гость: <b>${gp} ฿</b>` : `➕ Guest: <b>${gp} ฿</b>`);
  } else if (event.payment_required === false) {
    lines.push(L ? '💳 Участие бесплатное' : '💳 Free entry');
  }
  if (event.signup_deadline) lines.push(L ? `⏳ Запись до ${escapeHtml(fmtDay(event.signup_deadline, lang))}` : `⏳ Sign-up until ${escapeHtml(fmtDay(event.signup_deadline, lang))}`);
  if (event.invite_only) lines.push(L ? '🔒 Только по приглашению' : '🔒 By invitation only');
  return lines.join('\n');
}

// Приглашён ли игрок на закрытое событие.
export function isInvited(event, telegramId) {
  return (event?.invited_ids || []).map(String).includes(String(telegramId));
}

export function signupKeyboard(event, lang = 'ru', { full = false } = {}) {
  const L = ru(lang);
  const text = full
    ? (L ? '⏳ В лист ожидания' : '⏳ Join the waitlist')
    : (L ? '✅ Записаться' : '✅ Sign up');
  return { inline_keyboard: [[{ text, callback_data: `ev_join:${event.event_id}` }]] };
}

// --- предпросмотр и публикация --------------------------------------------

export async function previewEventForAdmin(chatId, eventId) {
  const event = await findEvent(eventId);
  if (!event) return sendMessage(chatId, 'Событие не найдено.');
  const taken = await takenSeats(eventId);
  const { eventRecipients } = await import('./admin.js');
  const recipients = await eventRecipients(event).catch(() => []);
  const who = event.audience === 'personal'
    ? `лично выбранным: ${recipients.length}`
    : (event.audience === 'active' ? 'только активным игрокам' : 'всем в боте');
  const div = event.audience_division ? `, дивизион ${event.audience_division}` : '';
  const lock = event.invite_only ? '\n🔒 Только по приглашению: остальным событие не показывается.' : '';
  await sendMessage(chatId, `<b>Так карточка уйдёт в рассылку</b> (${who}${div}) — получателей: <b>${recipients.length}</b>.${lock}`);
  await sendMessage(chatId, eventCard(event, 'ru', { taken, lead: true }), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📣 Подтвердить и разослать', callback_data: `ev_pub:${eventId}` }],
        ...(event.status === 'published' ? [[{ text: '🔔 Напомнить незаписавшимся', callback_data: `ev_nudge:${eventId}` }]] : []),
        [{ text: '✏️ Отредактировать', callback_data: `ev_edit:${eventId}` }],
        [{ text: '🗑 Удалить', callback_data: `ev_drop:${eventId}` }]
      ]
    }
  });
}

// Рассылка карточки. Получателей берём из той же выборки, что и обычные
// рассылки бота, чтобы фильтры вели себя одинаково.
export async function broadcastEvent(chatId, eventId, contacts = []) {
  const event = await findEvent(eventId);
  if (!event) return sendMessage(chatId, 'Событие не найдено.');
  await publishEvent(eventId);
  const taken = await takenSeats(eventId);
  const full = event.capacity > 0 && taken >= event.capacity;
  let ok = 0, fail = 0;
  // Запоминаем, куда именно ушла карточка: дальше она правится на месте, когда
  // места разбирают, — иначе у всех навсегда остаётся снимок на момент рассылки.
  const sent = [];
  for (const c of contacts) {
    const lang = (c.language || 'en') === 'ru' ? 'ru' : 'en';
    try {
      const res = await sendMessage(c.telegram_id, eventCard(event, lang, { taken, lead: true }), { reply_markup: signupKeyboard(event, lang, { full }) });
      const mid = res?.result?.message_id || res?.message_id;
      if (mid) sent.push(`${c.telegram_id}:${mid}:${lang}`);
      ok++;
    } catch { fail++; }
  }
  await rememberCards(eventId, sent).catch(e => console.error('remember cards failed:', e.message));
  return sendMessage(chatId, `📣 Событие опубликовано.\nОтправлено: <b>${ok}</b>${fail ? `\nОшибок: <b>${fail}</b>` : ''}`);
}

// --- живая карточка --------------------------------------------------------
//
// Разосланная карточка правится на месте: строка «Свободно мест» и подпись
// кнопки всегда показывают текущее состояние. Правки копятся полминуты и уходят
// одной пачкой — иначе на сотне получателей Telegram начнёт резать по лимитам.
const CARDS_KEY = (eventId) => `ev_msgs_${eventId}`;
const CARD_REFRESH_MS = 30000;
const EDIT_PAUSE_MS = 60;
const dirtyCards = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function rememberCards(eventId, list = []) {
  if (!list.length) return;
  const prev = await getSetting(CARDS_KEY(eventId)).catch(() => '');
  const all = [...new Set([...String(prev || '').split(',').filter(Boolean), ...list])];
  await setSetting(CARDS_KEY(eventId), all.join(','), 'служебное: разосланные карточки события');
}

// Пометить событие «изменилось». Сама правка — через полминуты, чтобы десяток
// записей подряд стоил одной пачки правок, а не десяти.
export function touchEventCards(eventId) {
  if (!eventId || dirtyCards.has(eventId)) return;
  const timer = setTimeout(() => {
    dirtyCards.delete(eventId);
    refreshEventCards(eventId).catch(e => console.error('card refresh failed:', e.message));
  }, CARD_REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  dirtyCards.set(eventId, timer);
}

// text = null — берём обычную карточку; иначе подставляем свой текст (например
// «событие отменено») и снимаем кнопки.
export async function refreshEventCards(eventId, { text = null, keyboard = undefined } = {}) {
  const raw = await getSetting(CARDS_KEY(eventId)).catch(() => '');
  if (!raw) return { edited: 0, gone: 0 };
  const event = text ? await findEvent(eventId).catch(() => null) : await findEvent(eventId);
  if (!event && !text) return { edited: 0, gone: 0 };
  const taken = event ? await takenSeats(eventId).catch(() => 0) : 0;
  const full = Boolean(event?.capacity) && taken >= event.capacity;
  let edited = 0, gone = 0;
  const keep = [];
  for (const part of String(raw).split(',').filter(Boolean)) {
    const [cid, mid, lg] = part.split(':');
    if (!cid || !mid) continue;
    const lang = lg === 'ru' ? 'ru' : 'en';
    const body = text ? (typeof text === 'function' ? text(lang) : text) : eventCard(event, lang, { taken, lead: true });
    const markup = text ? keyboard : signupKeyboard(event, lang, { full });
    try {
      await editMessageText(cid, Number(mid), body, markup ? { reply_markup: markup } : { reply_markup: { inline_keyboard: [] } });
      edited++; keep.push(part);
    } catch (e) {
      // «not modified» значит, что карточка и так актуальна — сообщение живо.
      if (/not modified/i.test(e?.message || '')) keep.push(part);
      else gone++;
    }
    await sleep(EDIT_PAUSE_MS);
  }
  if (keep.length !== String(raw).split(',').filter(Boolean).length) {
    await setSetting(CARDS_KEY(eventId), keep.join(','), 'служебное: разосланные карточки события').catch(() => {});
  }
  return { edited, gone };
}

export async function forgetEventCards(eventId) {
  await setSetting(CARDS_KEY(eventId), '', 'служебное: разосланные карточки события').catch(() => {});
}

// --- сводное уведомление организатору --------------------------------------

// Один игрок — одно сообщение в админском чате, которое дальше редактируется.
// Так вместо ленты «записался / оплатил / отменил» видно текущее состояние.
const noteKey = (signupId) => `ev_note_${signupId}`;

export async function notifyOrganizer(signup, event, adminChatId, extra = '') {
  if (!adminChatId) return null;
  const taken = await takenSeats(event.event_id);
  const statusText = {
    [SIGNUP_STATUS.pending]: '🕐 записался, ждёт счёта',
    [SIGNUP_STATUS.invoiced]: '💳 выставлен счёт',
    [SIGNUP_STATUS.paid]: '✅ оплачено',
    [SIGNUP_STATUS.confirmed]: '✅ участвует',
    [SIGNUP_STATUS.waitlist]: '⏳ лист ожидания',
    [SIGNUP_STATUS.cancelled]: '❌ отменил участие'
  }[signup.status] || signup.status;
  const title = event.title_ru || event.title_en;
  const text = [
    `<b>${escapeHtml(title)}</b>`,
    `👤 ${escapeHtml(signup.player_name || signup.telegram_id)}${signup.guests ? ` +${signup.guests}` : ''}`,
    `Статус: <b>${statusText}</b>`,
    signup.paid_thb ? `Оплачено: <b>${signup.paid_thb} ฿</b>${signup.paid_from ? ` (${escapeHtml(signup.paid_from)})` : ''}` : '',
    event.capacity ? `Занято мест: <b>${taken} из ${event.capacity}</b>` : '',
    extra
  ].filter(Boolean).join('\n');

  const stored = await getSetting(noteKey(signup.signup_id)).catch(() => '');
  if (stored) {
    const [cid, mid] = String(stored).split(':');
    try { await editMessageText(cid, Number(mid), text); return { edited: true }; } catch { /* сообщение могли удалить */ }
  }
  const res = await sendMessage(adminChatId, text);
  const mid = res?.result?.message_id || res?.message_id;
  if (mid) await setSetting(noteKey(signup.signup_id), `${adminChatId}:${mid}`, 'служебное: сообщение организатора по записи').catch(() => {});
  return { edited: false };
}

// --- запись ----------------------------------------------------------------

// Кто может записаться. Решает поле «Кому» у самого события:
//   «всем»            — активные и те, кто из листа ожидания уже оплатил;
//   «только активным» — только активные;
// все, кто вне лиги, получают приглашение подать заявку. Проверка стоит здесь,
// а не только в интерфейсе: карточка уже разослана, и кнопку на ней жмут ещё
// долго после того, как состав закрылся.
export function eventAccessDenial(event, group, lang = 'ru') {
  const L = ru(lang);
  if (group === 'active') return null;
  if (group === 'waitlist') {
    if (event?.audience !== 'active') return null;
    return {
      message: L
        ? 'Это событие только для активных участников лиги. Как только твоё участие подтвердят, запись откроется.'
        : 'This event is for confirmed league members only. As soon as your participation is confirmed, sign-up will open.'
    };
  }
  return {
    message: L
      ? 'Записаться на события могут только участники Лиги. Ты ещё можешь успеть подать заявку.'
      : 'Only league members can sign up for events. You can still make it — send your application.',
    markup: { inline_keyboard: [[{ text: L ? '🎾 Подать заявку' : '🎾 Apply', web_app: { url: `${PUBLIC_URL}/apply?mode=event` } }]] }
  };
}

export async function joinEvent({ telegramId, name, lang = 'ru', eventId, guests = 0, adminChatId = '', group = '' }) {
  const L = ru(lang);
  const event = await findEvent(eventId);
  if (!event || event.status !== 'published') {
    return { ok: false, message: L ? 'Событие больше не активно.' : 'This event is no longer active.' };
  }
  // Закрытое событие: кнопка есть только у приглашённых, но callback можно
  // подобрать — поэтому проверяем ещё раз здесь.
  if (event.invite_only && !isInvited(event, telegramId)) {
    return { ok: false, message: L ? 'Это событие только по приглашению.' : 'This event is by invitation only.' };
  }
  const who = group || await playerGroup(telegramId).catch(() => 'guest');
  const denied = eventAccessDenial(event, who, lang);
  if (denied) return { ok: false, ...denied };
  const existing = await findSignup(eventId, telegramId);
  // Уже записан — не просто отказ: рядом та же кнопка отмены, иначе человек
  // жмёт «Записаться» второй раз именно потому, что не нашёл, где отписаться.
  if (existing) {
    return { ok: false,
      message: L ? 'Ты уже записан на это событие.' : 'You are already signed up.',
      markup: calendarKeyboard(event, lang, existing.signup_id) };
  }

  const wantSeats = 1 + (event.guests_allowed ? Math.min(guests, event.max_guests) : 0);
  const taken = await takenSeats(eventId);
  const noRoom = event.capacity > 0 && taken + wantSeats > event.capacity;
  const amount = priceFor(event, wantSeats - 1);

  const status = noRoom ? SIGNUP_STATUS.waitlist
    : (event.payment_required && amount > 0 ? SIGNUP_STATUS.invoiced : SIGNUP_STATUS.confirmed);
  const signup = await createSignup({
    event, telegramId, name, guests: wantSeats - 1, status, amount: noRoom ? 0 : amount
  });

  let message, markup;
  if (noRoom) {
    // Сразу говорим номер в очереди и сколько будет времени на решение —
    // чтобы человек знал, чего ждать, и не пропустил окно.
    const queue = await listSignups().catch(() => []);
    const pos = waitlistPosition(queue, event.event_id, telegramId);
    const window = offerWindowHours(event);
    message = L
      ? `Мест на «${event.title_ru}» сейчас нет — ты в листе ожидания${pos ? `, <b>${pos}-й в очереди</b>` : ''}.
Если кто-то откажется, напишу первым. На решение будет <b>${window} ч</b>, потом место уйдёт следующему.
Деньги пока не переводи.`
      : `“${event.title_en}” is full — you are on the waitlist${pos ? `, <b>#${pos} in line</b>` : ''}.
If a spot frees up, I will write to you first. You will have <b>${window} h</b> to decide, then the spot goes to the next person.
Do not pay yet.`;
  } else if (status === SIGNUP_STATUS.confirmed) {
    markup = calendarKeyboard(event, lang, signup.signup_id);
    message = L
      ? `Заявка на «${event.title_ru}» принята. Ты в списке участников.\n📅 ${fmtDay(event.date, lang)} ${event.time}\n📍 ${event.place}`
      : `You are in for “${event.title_en}”.\n📅 ${event.date} ${event.time}\n📍 ${event.place}`;
  } else {
    message = null; // счёт отправит invoiceSignup
  }
  if (adminChatId) await notifyOrganizer(signup, event, adminChatId).catch(() => {});
  touchEventCards(event.event_id);
  return { ok: true, signup, event, message, markup, needsInvoice: status === SIGNUP_STATUS.invoiced, amount };
}

// Счёт на участие. Если на депозите хватает — предлагаем списать одной кнопкой.
export async function invoiceText(event, signup, lang = 'ru', balance = 0) {
  const L = ru(lang);
  const title = L ? event.title_ru : event.title_en;
  const lines = [
    L ? `💳 <b>Счёт на «${escapeHtml(title)}»</b>` : `💳 <b>Invoice for “${escapeHtml(title)}”</b>`,
    L ? `Сумма: <b>${signup.amount_thb} ฿</b>${signup.guests ? ` (ты + ${signup.guests})` : ''}`
      : `Amount: <b>${signup.amount_thb} ฿</b>${signup.guests ? ` (you + ${signup.guests})` : ''}`
  ];
  if (balance > 0) {
    lines.push(L ? `💰 На депозите: <b>${balance} ฿</b>` : `💰 Deposit: <b>${balance} ฿</b>`);
  }
  // Реквизиты прямо в счёте: без них игроку некуда переводить. Для событий
  // берём только батовые способы — крипта остаётся для участия в лиге.
  const bank = await thbPaymentDetails().catch(() => []);
  for (const b of bank) {
    lines.push('', L ? `🏦 <b>${escapeHtml(b.title)}</b>` : `🏦 <b>${escapeHtml(b.title)}</b>`);
    lines.push(`<code>${escapeHtml(b.recipient)}</code>`);
  }
  lines.push('', L
    ? 'После перевода пришли сюда скриншот — я передам организатору, он подтвердит, и ты появишься в списке участников.'
    : 'After the transfer send the screenshot here — I will pass it to the organizer for confirmation.');
  const hours = event.refund_hours ?? CANCEL_LIMIT_HOURS;
  if (hours > 0) lines.push('', L
    ? `ℹ️ Отмена за ${hours} ч и более — деньги вернутся на депозит. Позже — оплата удерживается.`
    : `ℹ️ Cancel ${hours} h or more before — the money returns to your deposit. Later it is withheld.`);
  return lines.join('\n');
}

export function invoiceKeyboard(event, signup, lang = 'ru', balance = 0) {
  const L = ru(lang);
  const rows = [];
  if (balance >= signup.amount_thb && signup.amount_thb > 0) {
    rows.push([{ text: L ? `💰 Оплатить с депозита (${signup.amount_thb} ฿)` : `💰 Pay from deposit (${signup.amount_thb} ฿)`, callback_data: `ev_dep:${signup.signup_id}` }]);
  }
  rows.push([{ text: L ? '❌ Отменить участие' : '❌ Cancel', callback_data: `ev_cxl:${signup.signup_id}` }]);
  return { inline_keyboard: rows };
}

// Оплата с депозита: списываем и сразу подтверждаем участие.
export async function payFromDeposit({ signupId, telegramId, name, lang = 'ru', adminChatId = '' }) {
  const L = ru(lang);
  const all = await listSignups();
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return { ok: false, message: L ? 'Запись не найдена.' : 'Signup not found.' };
  const event = await findEvent(signup.event_id);
  const balance = await getBalance(telegramId);
  if (balance < signup.amount_thb) {
    return { ok: false, message: L
      ? `На депозите ${balance} ฿, а нужно ${signup.amount_thb} ฿ — не хватает.`
      : `Your deposit is ${balance} ฿ but ${signup.amount_thb} ฿ is needed.` };
  }
  const left = await addTransaction({
    telegramId, name, type: 'расход', amount: -signup.amount_thb,
    description: `Участие: ${event?.title_ru || signup.event_id}`
  });
  const updated = await updateSignup(signup.signup_id, {
    status: SIGNUP_STATUS.paid, paid_thb: signup.amount_thb, paid_from: 'депозит'
  });
  if (adminChatId) await notifyOrganizer({ ...signup, ...updated }, event, adminChatId).catch(() => {});
  return { ok: true, markup: calendarKeyboard(event, lang, signup.signup_id), message: L
    ? `✅ Оплачено с депозита: <b>${signup.amount_thb} ฿</b>. Остаток: <b>${left} ฿</b>\nТы в списке участников.`
    : `✅ Paid from deposit: <b>${signup.amount_thb} ฿</b>. Remaining: <b>${left} ฿</b>\nYou are on the list.` };
}

// --- отмена ----------------------------------------------------------------

export function cancelWarning(event, signup, lang = 'ru', now = Date.now()) {
  const L = ru(lang);
  const hours = event.refund_hours ?? CANCEL_LIMIT_HOURS;
  const left = hoursUntil(event, now);
  const late = hours > 0 && left !== null && left < hours;
  // Правило проговариваем цифрами: сколько часов осталось, сколько вернётся или
  // сгорит. «По правилам» без объяснения игроку ничего не говорит.
  const title = (L ? event.title_ru : event.title_en) || event.title_ru;
  const head = L ? `⚠️ <b>Отменить участие в «${escapeHtml(title)}»?</b>` : `⚠️ <b>Cancel your spot for “${escapeHtml(title)}”?</b>`;
  const leftLine = left === null ? '' : (L
    ? `\nДо события: <b>${Math.max(0, Math.round(left))} ч</b>.`
    : `\nTime until the event: <b>${Math.max(0, Math.round(left))} h</b>.`);
  if (!signup.paid_thb) {
    return L
      ? `${head}${leftLine}\n\nОплаты по этой записи не было, возвращать нечего. Место освободится для других.`
      : `${head}${leftLine}\n\nNothing was paid for this spot, so there is nothing to refund. The spot will be freed up.`;
  }
  if (late) {
    return L
      ? `${head}${leftLine}\n\nПравило отмены: вернуть деньги можно не позже чем за <b>${hours} ч</b>. Сейчас этот срок уже прошёл, поэтому оплата <b>${signup.paid_thb} ฿ не возвращается</b> — она удерживается как плата за позднюю отмену.\n\nВсё равно отменить?`
      : `${head}${leftLine}\n\nCancellation rule: a refund is possible no later than <b>${hours} h</b> before the event. That deadline has passed, so your <b>${signup.paid_thb} ฿ is not refunded</b> — it is withheld as a late cancellation fee.\n\nCancel anyway?`;
  }
  return L
    ? `${head}${leftLine}\n\nПравило отмены: до события больше <b>${hours} ч</b>, значит отмена без потерь — <b>${signup.paid_thb} ฿</b> вернутся на твой депозит и их можно потратить на другое событие.\n\nПодтверждаешь отмену?`
    : `${head}${leftLine}\n\nCancellation rule: more than <b>${hours} h</b> left, so this is a free cancellation — <b>${signup.paid_thb} ฿</b> returns to your deposit and can be spent on another event.\n\nConfirm cancellation?`;
}

export function cancelKeyboard(signup, event, lang = 'ru') {
  const L = ru(lang);
  const rows = [];
  if (signup.guests > 0) {
    rows.push([{ text: L ? '👥 Гости остаются' : '👥 Guests stay', callback_data: `ev_cyes:${signup.signup_id}` }]);
    rows.push([{ text: L ? '🚫 Отменяем всех' : '🚫 Cancel everyone', callback_data: `ev_cno:${signup.signup_id}` }]);
  } else {
    rows.push([{ text: L ? '✅ Да, отменить' : '✅ Yes, cancel', callback_data: `ev_cno:${signup.signup_id}` }]);
  }
  rows.push([{ text: L ? '↩️ Нет, оставить' : '↩️ No, keep it', callback_data: `ev_keep:${signup.signup_id}` }]);
  return { inline_keyboard: rows };
}

export async function cancelSignup({ signupId, keepGuests = false, telegramId, name, lang = 'ru', adminChatId = '', now = Date.now() }) {
  const L = ru(lang);
  const all = await listSignups();
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return { ok: false, message: L ? 'Запись не найдена.' : 'Signup not found.' };
  if (signup.status === SIGNUP_STATUS.cancelled) {
    return { ok: false, message: L ? 'Участие уже отменено.' : 'Already cancelled.' };
  }
  const event = await findEvent(signup.event_id);
  const decision = refundForCancel(event, signup, keepGuests, now);

  let updated;
  if (keepGuests && signup.guests > 0) {
    // Игрок не идёт, гости остаются: запись живёт дальше, но без него.
    updated = await updateSignup(signup.signup_id, {
      paid_thb: Math.max(0, signup.paid_thb - decision.refund),
      note: 'игрок отменил участие, гости остаются'
    });
  } else {
    updated = await updateSignup(signup.signup_id, { status: SIGNUP_STATUS.cancelled });
  }

  let left = null;
  if (decision.refund > 0) {
    left = await addTransaction({
      telegramId, name, type: 'возврат', amount: decision.refund,
      description: `Отмена: ${event?.title_ru || signup.event_id}`
    });
  }
  if (adminChatId) {
    // Организатору — своей строкой, чтобы по ленте было видно, ранняя отмена
    // или поздняя, и что стало с деньгами.
    const extra = decision.refund > 0
      ? `↩️ Отменил рано — возвращено на депозит: <b>${decision.refund} ฿</b>`
      : (decision.burned > 0
        ? `⚠️ Отменил поздно — <b>${decision.burned} ฿</b> удержаны`
        : 'Отменил, оплаты не было');
    await notifyOrganizer({ ...signup, ...updated, status: keepGuests ? signup.status : SIGNUP_STATUS.cancelled }, event, adminChatId, extra).catch(() => {});
  }

  let message;
  // Итог всегда с цифрами: с какого события сняли, сколько вернули и что стало
  // с депозитом. Сухое «участие отменено» вызывает только новые вопросы.
  const title = (L ? event?.title_ru : event?.title_en) || event?.title_ru || '';
  const head = L ? `✅ Ты снят с события «${escapeHtml(title)}».` : `✅ You are removed from “${escapeHtml(title)}”.`;
  const hours = event?.refund_hours ?? CANCEL_LIMIT_HOURS;
  if (decision.refund > 0) {
    message = L
      ? `${head}\n↩️ Возвращено на депозит: <b>${decision.refund} ฿</b>. Остаток: <b>${left} ฿</b>`
      : `${head}\n↩️ Returned to your deposit: <b>${decision.refund} ฿</b>. Balance: <b>${left} ฿</b>`;
  } else if (decision.burned > 0) {
    message = L
      ? `${head}\n💳 Отмена менее чем за ${hours} ч — оплата <b>${decision.burned} ฿ удержана</b> как плата за позднюю отмену.`
      : `${head}\n💳 Cancelled less than ${hours} h before — <b>${decision.burned} ฿ is withheld</b> as a late cancellation fee.`;
  } else {
    message = L
      ? `${head}\nОплаты по этой записи не было — возвращать нечего.`
      : `${head}\nNothing was paid for this spot, so there is nothing to refund.`;
  }
  if (keepGuests && signup.guests > 0) {
    message += L ? `\nГости (${signup.guests}) остаются в списке.` : `\nYour guests (${signup.guests}) stay on the list.`;
  }
  // Место освободилось — сразу предлагаем первому в очереди.
  await runWaitlistOffers(now, adminChatId).catch(() => {});
  touchEventCards(signup.event_id);
  return { ok: true, message, refund: decision.refund, burned: decision.burned };
}

// --- витрина ---------------------------------------------------------------

// Что показать игроку во вкладке «События».
// --- касса игрока -----------------------------------------------------------
// Пополнение по той же цепочке, что и всё остальное: счёт по тайским реквизитам,
// игрок присылает чек, организатор подтверждает — только после этого баланс
// растёт. Крипту здесь не принимаем.
export const TOPUP_MIN = 1000;
export const TOPUP_PRESETS = [1000, 3000, 5000];
const topupKey = (telegramId) => `ev_topup_${telegramId}`;

export async function startTopup({ telegramId, name, amount, lang = 'ru', chatId }) {
  const L = ru(lang);
  const sum = Math.round(Number(amount) || 0);
  if (!Number.isFinite(sum) || sum < TOPUP_MIN) {
    return sendMessage(chatId, L
      ? `⚠️ Минимальная сумма пополнения — <b>${TOPUP_MIN} ฿</b>. Введи сумму числом, например: 3000`
      : `⚠️ The minimum top-up is <b>${TOPUP_MIN} ฿</b>. Enter the amount as a number, for example: 3000`);
  }
  await setSetting(topupKey(telegramId), String(sum), 'Ожидаемое пополнение депозита').catch(() => {});
  const bank = await thbPaymentDetails().catch(() => []);
  const lines = [
    L ? '💳 <b>Пополнение депозита</b>' : '💳 <b>Deposit top-up</b>',
    L ? `Сумма: <b>${sum} ฿</b>` : `Amount: <b>${sum} ฿</b>`
  ];
  for (const b of bank) {
    lines.push('', `🏦 <b>${escapeHtml(b.title)}</b>`, `<code>${escapeHtml(b.recipient)}</code>`);
  }
  lines.push('', L
    ? 'После перевода пришли сюда скриншот — организатор подтвердит, и деньги появятся на депозите.'
    : 'After the transfer send the screenshot here — the organizer will confirm it and the money will appear on your deposit.');
  return sendMessage(chatId, lines.join('\n'));
}

// Чек на пополнение: уходит организатору с суммой и кнопками подтверждения.
export async function handleTopupProof({ telegramId, name, lang = 'ru', fileId, fileType = 'photo', chatId, adminChatId = '' }) {
  const raw = await getSetting(topupKey(telegramId)).catch(() => '');
  const sum = Math.round(Number(raw) || 0);
  if (!sum) return false;
  await setSetting(topupKey(telegramId), '', 'Чек на пополнение отправлен').catch(() => {});
  const caption = `<b>💰 Чек на пополнение депозита</b>

👤 ${escapeHtml(name || String(telegramId))}
Сумма: <b>${sum} ฿</b>`;
  const markup = { reply_markup: { inline_keyboard: [
    [{ text: `✅ Зачислить ${sum} ฿`, callback_data: `ev_tok:${telegramId}:${sum}` }],
    [{ text: '❌ Отклонить', callback_data: `ev_tno:${telegramId}` }]
  ] } };
  if (adminChatId) {
    let to = adminChatId, opts = {};
    try {
      const { getOrCreatePlayerTopic } = await import('./admin.js');
      const topic = await getOrCreatePlayerTopic({ telegram_id: telegramId, name });
      if (topic?.chatId) to = topic.chatId;
      if (topic?.message_thread_id) opts = { message_thread_id: topic.message_thread_id };
    } catch (e) { /* темы нет — пишем в общий чат */ }
    const { sendPhoto } = await import('./telegram.js');
    if (fileType === 'photo') {
      await sendPhoto(to, fileId, { caption, ...opts, ...markup })
        .catch(() => sendMessage(to, caption, { ...opts, ...markup }));
    } else {
      await sendMessage(to, caption, { ...opts, ...markup }).catch(() => {});
    }
  }
  const L = ru(lang);
  await sendMessage(chatId, L
    ? `✅ Запрос на пополнение <b>${sum} ฿</b> отправлен организатору. Депозит пополнится после подтверждения оплаты.`
    : `✅ Top-up request for <b>${sum} ฿</b> sent to the organizer. Your deposit will grow once the payment is confirmed.`);
  return true;
}

export async function reviewTopup({ telegramId, amount, approve, name = '', adminChatId = '' }) {
  if (!approve) {
    await sendMessage(telegramId, '⚠️ Пополнение не подтверждено. Проверь перевод и пришли чек ещё раз.').catch(() => {});
    return { ok: true, message: `Пополнение отклонено: <b>${escapeHtml(name || String(telegramId))}</b>.` };
  }
  const sum = Math.round(Number(amount) || 0);
  if (sum <= 0) return { ok: false, message: 'Сумма не распознана.' };
  const left = await addTransaction({
    telegramId, name, type: 'пополнение', amount: sum, description: 'Пополнение депозита'
  });
  await sendMessage(telegramId,
    `💳 Депозит пополнен на <b>${sum} ฿</b>. Текущий баланс: <b>${left} ฿</b>`).catch(() => {});
  return { ok: true, message: `✅ Зачислено <b>${sum} ฿</b>, баланс: <b>${left} ฿</b>.` };
}

// Ручные операции организатора: пополнить или списать с причиной.
export async function adminBalanceChange({ telegramId, name, amount, reason = '', chatId }) {
  const sum = Math.round(Number(amount) || 0);
  if (!sum) return sendMessage(chatId, 'Сумма не распознана.');
  const left = await addTransaction({
    telegramId, name,
    type: sum > 0 ? 'пополнение' : 'списание',
    amount: sum,
    description: reason || (sum > 0 ? 'Пополнение организатором' : 'Списание организатором')
  });
  const tail = reason ? ` (${escapeHtml(reason)})` : '';
  await sendMessage(telegramId, sum > 0
    ? `💳 Депозит пополнен на <b>${sum} ฿</b>${tail}. Текущий баланс: <b>${left} ฿</b>`
    : `💳 С депозита списано <b>${Math.abs(sum)} ฿</b>${tail}. Текущий баланс: <b>${left} ฿</b>`).catch(() => {});
  return sendMessage(chatId, `✅ Баланс <b>${escapeHtml(name || String(telegramId))}</b>: <b>${left} ฿</b>.`);
}

// --- напоминания незаписавшимся ---------------------------------------------
// Тем, кто получил карточку, но не отреагировал: два автоматических письма —
// за 3 суток и за сутки до конца записи. Тем, кто отменился, не пишем: это был
// осознанный отказ. Максимум два письма на событие, тихие часы соблюдаем.
const nudgeKey = (eventId, key) => `ev_nudge_${key}_${eventId}`;
const manualKey = (eventId) => `ev_nudge_manual_${eventId}`;
const QUIET_FROM_H = 21;
const QUIET_TO_H = 9;

// Час по Пхукету: письма в три ночи никому не нужны.
function phuketHour(now) {
  return new Date(now + 7 * 3600000).getUTCHours();
}
export function isQuietHour(now = Date.now()) {
  const h = phuketHour(now);
  return h >= QUIET_FROM_H || h < QUIET_TO_H;
}

// Момент закрытия записи: срок записи, а если его нет — начало события.
export function signupClosesMs(event) {
  const d = safe(event?.signup_deadline);
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 16, 59);
  return startMs(event);
}

// Кто получил карточку, но так и не записался.
export async function pendingInvitees(event) {
  const { eventRecipients } = await import('./admin.js');
  const contacts = await eventRecipients(event).catch(() => []);
  const all = await listSignups().catch(() => []);
  const busy = new Set(all
    .filter(s => s.event_id === event.event_id)
    .map(s => String(s.telegram_id)));
  return contacts.filter(c => !busy.has(String(c.telegram_id)));
}

async function sendNudge(event, contacts) {
  const taken = await takenSeats(event.event_id);
  let sent = 0;
  for (const c of contacts) {
    const lang = (c.language || 'en') === 'ru' ? 'ru' : 'en';
    const head = lang === 'ru' ? '👀 <b>Ещё можно записаться</b>' : '👀 <b>You can still join</b>';
    try {
      await sendMessage(c.telegram_id, `${head}\n\n${eventCard(event, lang, { taken })}`,
        { reply_markup: signupKeyboard(event, lang) });
      sent++;
    } catch { /* заблокировал бота — не наша забота */ }
  }
  return sent;
}

export async function runSignupNudges(now = Date.now()) {
  if (isQuietHour(now)) return { sent: 0, quiet: true };
  const events = await listEvents().catch(() => []);
  let sent = 0;
  for (const event of events) {
    if (!isSignupOpen(event, now)) continue;
    if (event.remind_unregistered === false) continue;
    const taken = await takenSeats(event.event_id);
    // Мест нет — звать некуда.
    if (event.capacity && taken >= event.capacity) continue;
    const closes = signupClosesMs(event);
    if (!closes) continue;
    const hoursLeft = (closes - now) / 3600000;
    for (const step of [{ key: 'd3', hours: 72 }, { key: 'd1', hours: 24 }]) {
      if (hoursLeft > step.hours || hoursLeft < step.hours - 12) continue;
      if (await getSetting(nudgeKey(event.event_id, step.key)).catch(() => '')) continue;
      const list = await pendingInvitees(event).catch(() => []);
      if (!list.length) { await setSetting(nudgeKey(event.event_id, step.key), 'нет адресатов', 'Напоминание незаписавшимся').catch(() => {}); continue; }
      sent += await sendNudge(event, list);
      await setSetting(nudgeKey(event.event_id, step.key), new Date(now).toISOString(), 'Напоминание незаписавшимся отправлено').catch(() => {});
    }
  }
  return { sent };
}

// Ручная перерассылка: работает независимо от автоматических, но не чаще раза
// в сутки на событие — чтобы двойное нажатие не превратилось в спам.
export async function remindUnregistered(chatId, eventId, now = Date.now()) {
  const event = await findEvent(eventId);
  if (!event) return sendMessage(chatId, 'Событие не найдено.');
  const last = await getSetting(manualKey(eventId)).catch(() => '');
  if (last && now - Date.parse(last) < 24 * 3600000) {
    const hours = Math.ceil((24 * 3600000 - (now - Date.parse(last))) / 3600000);
    return sendMessage(chatId, `Напоминание по этому событию уже уходило сегодня. Следующее можно через <b>${hours} ч</b>.`);
  }
  const list = await pendingInvitees(event).catch(() => []);
  if (!list.length) return sendMessage(chatId, 'Все, кому уходила карточка, уже записались или отказались.');
  const sent = await sendNudge(event, list);
  await setSetting(manualKey(eventId), new Date(now).toISOString(), 'Ручное напоминание незаписавшимся').catch(() => {});
  return sendMessage(chatId, `📣 Напомнил незаписавшимся: <b>${sent}</b>.`);
}

// --- лист ожидания ----------------------------------------------------------
// Место освободилось — предлагаем первому в очереди и держим его за ним:
// 2 часа, если до события больше суток, и 1 час, если день в день. Не ответил —
// уходит в конец очереди, место предлагается следующему.
// Пока место держится, запись стоит в статусе pending: он уже считается занятым
// местом, поэтому новый статус заводить не пришлось.
const holdKey = (signupId) => `ev_hold_${signupId}`;
const MISSED_NOTE = 'пропустил окно, в конце очереди';

export function offerWindowHours(event, now = Date.now()) {
  const left = hoursUntil(event, now);
  if (left === null) return 2;
  return left > 24 ? 2 : 1;
}

// Очередь: кто раньше записался, тот выше. Пропустивший своё окно — в конец.
export function waitlistQueue(all, eventId) {
  return all
    .filter(s => s.event_id === eventId && s.status === SIGNUP_STATUS.waitlist)
    .sort((a, b) => {
      const am = String(a.note || '').includes('пропустил') ? 1 : 0;
      const bm = String(b.note || '').includes('пропустил') ? 1 : 0;
      return am - bm || String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
}

export function waitlistPosition(all, eventId, telegramId) {
  const q = waitlistQueue(all, eventId);
  const i = q.findIndex(s => String(s.telegram_id) === String(telegramId));
  return i < 0 ? 0 : i + 1;
}

async function offerSeat(signup, event, adminChatId, now) {
  const hours = offerWindowHours(event, now);
  const until = Math.min(now + hours * 3600000, startMs(event) || Infinity);
  await updateSignup(signup.signup_id, { status: SIGNUP_STATUS.pending, note: 'предложено место' });
  await setSetting(holdKey(signup.signup_id), String(until), 'До какого момента держим место').catch(() => {});
  touchEventCards(event.event_id);
  const title = event.title_ru || event.title_en;
  await sendMessage(signup.telegram_id, `🎉 <b>Освободилось место — «${escapeHtml(title)}»</b>

📅 ${escapeHtml(event.date)} ${escapeHtml(event.time)}${event.place ? `\n📍 ${escapeHtml(event.place)}` : ''}
${event.payment_required && event.price_thb ? `💳 Участие: <b>${event.price_thb} ฿</b>\n` : ''}
Место держится за тобой <b>${hours} ч</b>. Если не ответишь, оно уйдёт следующему в очереди.`, {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Занять место', callback_data: `ev_take:${signup.signup_id}` }],
      [{ text: '✖️ Отказаться', callback_data: `ev_pass:${signup.signup_id}` }]
    ] }
  }).catch(() => {});
  if (adminChatId) {
    await notifyOrganizer({ ...signup, status: SIGNUP_STATUS.pending }, event, adminChatId,
      `⏳ Предложено место из листа ожидания, окно ${hours} ч`).catch(() => {});
  }
}

// Один проход: снимаем протухшие удержания и раздаём свободные места.
export async function runWaitlistOffers(now = Date.now(), adminChatId = '') {
  const events = await listEvents().catch(() => []);
  let offered = 0, expired = 0;
  for (const event of events) {
    const start = startMs(event);
    if (start && start < now) continue;
    let all = await listSignups().catch(() => []);

    // Протухшие окна: место возвращается в оборот, игрок — в конец очереди.
    for (const s of all.filter(x => x.event_id === event.event_id && x.status === SIGNUP_STATUS.pending)) {
      const raw = await getSetting(holdKey(s.signup_id)).catch(() => '');
      if (!raw) continue;
      if (Number(raw) > now) continue;
      await updateSignup(s.signup_id, { status: SIGNUP_STATUS.waitlist, note: MISSED_NOTE });
      await setSetting(holdKey(s.signup_id), '', 'Окно истекло').catch(() => {});
      touchEventCards(event.event_id);
      expired++;
    }

    if (!isSignupOpen(event, now)) continue;
    all = await listSignups().catch(() => []);
    const taken = all.filter(s => s.event_id === event.event_id
      && [SIGNUP_STATUS.pending, SIGNUP_STATUS.invoiced, SIGNUP_STATUS.paid, SIGNUP_STATUS.confirmed].includes(s.status))
      .reduce((sum, s) => sum + seatsOf(s), 0);
    let free = event.capacity ? event.capacity - taken : 0;
    if (free <= 0) continue;
    for (const s of waitlistQueue(all, event.event_id)) {
      if (free <= 0) break;
      await offerSeat(s, event, adminChatId, now);
      free -= seatsOf(s);
      offered++;
    }
  }
  return { offered, expired };
}

// Игрок принял предложение: платное событие — счёт, бесплатное — сразу в составе.
export async function takeOffer({ signupId, telegramId, lang = 'ru', chatId, adminChatId = '' }) {
  const L = ru(lang);
  const all = await listSignups().catch(() => []);
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return sendMessage(chatId, L ? 'Запись не найдена.' : 'Signup not found.');
  if (signup.status !== SIGNUP_STATUS.pending) {
    return sendMessage(chatId, L
      ? 'Это предложение уже неактуально — место ушло дальше по очереди.'
      : 'This offer is no longer valid — the spot went to the next person.');
  }
  const event = await findEvent(signup.event_id);
  await setSetting(holdKey(signup.signup_id), '', 'Место занято').catch(() => {});
  const amount = priceFor(event, signup.guests || 0);
  if (event?.payment_required && amount > 0) {
    const updated = await updateSignup(signup.signup_id, {
      status: SIGNUP_STATUS.invoiced, amount_thb: amount, note: 'принял место из листа ожидания'
    });
    const balance = await getBalance(telegramId).catch(() => 0);
    await sendMessage(chatId, await invoiceText(event, { ...signup, ...updated, amount_thb: amount }, lang, balance),
      { reply_markup: invoiceKeyboard(event, signup, lang, balance) }).catch(() => {});
    if (adminChatId) await notifyOrganizer({ ...signup, status: SIGNUP_STATUS.invoiced, amount_thb: amount }, event, adminChatId, '✅ Принял место из листа ожидания').catch(() => {});
    return null;
  }
  await updateSignup(signup.signup_id, { status: SIGNUP_STATUS.confirmed, note: 'принял место из листа ожидания' });
  if (adminChatId) await notifyOrganizer({ ...signup, status: SIGNUP_STATUS.confirmed }, event, adminChatId, '✅ Принял место из листа ожидания').catch(() => {});
  return sendMessage(chatId, L
    ? `✅ Место твоё — «${escapeHtml(event?.title_ru || '')}».\n📅 ${escapeHtml(fmtDay(event?.date, lang))} ${escapeHtml(event?.time || '')}`
    : `✅ The spot is yours — “${escapeHtml(event?.title_en || '')}”.\n📅 ${escapeHtml(fmtDay(event?.date, lang))} ${escapeHtml(event?.time || '')}`,
    { reply_markup: calendarKeyboard(event, lang, signup.signup_id) });
}

// Игрок отказался или вышел из очереди — держать место больше не нужно.
export async function passOffer({ signupId, lang = 'ru', chatId, adminChatId = '' }) {
  const L = ru(lang);
  const all = await listSignups().catch(() => []);
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return sendMessage(chatId, L ? 'Запись не найдена.' : 'Signup not found.');
  const event = await findEvent(signup.event_id);
  await setSetting(holdKey(signup.signup_id), '', 'Отказался').catch(() => {});
  await updateSignup(signup.signup_id, { status: SIGNUP_STATUS.cancelled, note: 'вышел из листа ожидания' });
  touchEventCards(signup.event_id);
  if (adminChatId) {
    await notifyOrganizer({ ...signup, status: SIGNUP_STATUS.cancelled }, event, adminChatId, '✖️ Отказался от места').catch(() => {});
  }
  // Место освободилось прямо сейчас — сразу предлагаем следующему.
  await runWaitlistOffers(Date.now(), adminChatId).catch(() => {});
  return sendMessage(chatId, L
    ? 'Понял, место не занимаем. Ты вышел из листа ожидания.'
    : 'Got it, the spot is released. You are out of the waitlist.');
}

// --- чек за участие в событии ----------------------------------------------
// Ветку приёма чеков за лигу не трогаем: эта развилка стоит после неё и
// срабатывает только когда у игрока висит неоплаченный счёт за событие.
const proofKey = (telegramId) => `ev_proof_${telegramId}`;

function unpaidSignupsOf(all, telegramId) {
  return all.filter(s => String(s.telegram_id) === String(telegramId)
    && (s.status === SIGNUP_STATUS.invoiced || s.status === SIGNUP_STATUS.pending));
}

// Возвращает true, если чек разобран здесь и дальше по цепочке идти не нужно.
export async function handleEventProof({ telegramId, lang = 'ru', fileId, fileType = 'photo', chatId, adminChatId = '' }) {
  const L = ru(lang);
  const all = await listSignups().catch(() => []);
  const mine = unpaidSignupsOf(all, telegramId);
  if (!mine.length) return false;

  if (mine.length > 1) {
    // Несколько неоплаченных событий — пусть игрок скажет, за какое платил.
    await setSetting(proofKey(telegramId), `${fileType}:${fileId}`, 'Чек за событие ждёт выбора события').catch(() => {});
    const rows = [];
    for (const s of mine) {
      const e = await findEvent(s.event_id);
      const title = (L ? e?.title_ru : e?.title_en) || e?.title_ru || s.event_id;
      rows.push([{ text: `${title} · ${s.amount_thb} ฿`.slice(0, 60), callback_data: `ev_pf:${s.signup_id}` }]);
    }
    await sendMessage(chatId, L
      ? 'Спасибо! За какое событие этот перевод?'
      : 'Thanks! Which event is this payment for?', { reply_markup: { inline_keyboard: rows } });
    return true;
  }

  await attachEventProof({ signup: mine[0], telegramId, lang, fileId, fileType, chatId, adminChatId });
  return true;
}

// Игрок выбрал событие из списка — берём отложенный чек и привязываем.
export async function attachStoredProof({ signupId, telegramId, lang = 'ru', chatId, adminChatId = '' }) {
  const L = ru(lang);
  const stored = await getSetting(proofKey(telegramId)).catch(() => '');
  const all = await listSignups().catch(() => []);
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return sendMessage(chatId, L ? 'Запись не найдена.' : 'Signup not found.');
  const idx = String(stored).indexOf(':');
  const fileType = idx > 0 ? String(stored).slice(0, idx) : 'photo';
  const fileId = idx > 0 ? String(stored).slice(idx + 1) : '';
  if (!fileId) {
    return sendMessage(chatId, L
      ? 'Чек потерялся — пришли его ещё раз, пожалуйста.'
      : 'The receipt is gone — please send it again.');
  }
  await setSetting(proofKey(telegramId), '', 'Чек за событие обработан').catch(() => {});
  return attachEventProof({ signup, telegramId, lang, fileId, fileType, chatId, adminChatId });
}

async function attachEventProof({ signup, telegramId, lang = 'ru', fileId, fileType, chatId, adminChatId }) {
  const L = ru(lang);
  const event = await findEvent(signup.event_id);
  const title = event?.title_ru || event?.title_en || signup.event_id;
  await updateSignup(signup.signup_id, { note: 'чек прислан, ждёт подтверждения' }).catch(() => {});

  const caption = `<b>💳 Чек за событие</b>

🎾 <b>${escapeHtml(title)}</b>
👤 ${escapeHtml(signup.player_name || String(telegramId))}
📅 ${escapeHtml(event?.date || '')} ${escapeHtml(event?.time || '')}
Сумма по счёту: <b>${signup.amount_thb} ฿</b>`;
  const markup = { reply_markup: { inline_keyboard: [
    [{ text: '✅ Подтвердить оплату', callback_data: `ev_pok:${signup.signup_id}` }],
    [{ text: '❌ Отклонить', callback_data: `ev_pno:${signup.signup_id}` }]
  ] } };

  if (adminChatId) {
    // Чек кладём в тему игрока, если она есть; нет темы — в общий админ-чат.
    let to = adminChatId, opts = {};
    try {
      const { getOrCreatePlayerTopic } = await import('./admin.js');
      const topic = await getOrCreatePlayerTopic({ telegram_id: telegramId, name: signup.player_name });
      if (topic?.chatId) to = topic.chatId;
      if (topic?.message_thread_id) opts = { message_thread_id: topic.message_thread_id };
    } catch (e) { /* темы нет — пишем в общий чат, чек не теряется */ }
    const { sendPhoto } = await import('./telegram.js');
    if (fileType === 'photo') {
      await sendPhoto(to, fileId, { caption, ...opts, ...markup })
        .catch(() => sendMessage(to, caption, { ...opts, ...markup }));
    } else {
      await sendMessage(to, caption, { ...opts, ...markup }).catch(() => {});
    }
  }
  return sendMessage(chatId, L
    ? `✅ Чек за «${escapeHtml(title)}» получен и передан организатору. Как подтвердит — появишься в списке участников.`
    : `✅ Receipt for “${escapeHtml(title)}” received and passed to the organizer. Once confirmed, you will appear in the participants list.`);
}

// Организатор подтвердил или отклонил чек за событие.
export async function reviewEventProof({ signupId, approve, adminChatId = '' }) {
  const all = await listSignups().catch(() => []);
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return { ok: false, message: 'Запись не найдена.' };
  const event = await findEvent(signup.event_id);
  const title = event?.title_ru || signup.event_id;
  if (!approve) {
    await updateSignup(signup.signup_id, { note: 'чек отклонён организатором' }).catch(() => {});
    await sendMessage(signup.telegram_id,
      `⚠️ Оплата за «${escapeHtml(title)}» не подтверждена. Проверь перевод и пришли чек ещё раз.`).catch(() => {});
    return { ok: true, message: `Чек отклонён: <b>${escapeHtml(signup.player_name || signup.telegram_id)}</b>.` };
  }
  const amount = signup.amount_thb || 0;
  const updated = await updateSignup(signup.signup_id, {
    status: SIGNUP_STATUS.paid, paid_thb: amount, paid_from: 'перевод', note: 'оплата подтверждена'
  });
  await sendMessage(signup.telegram_id, `✅ Оплата за «${escapeHtml(title)}» подтверждена. Ты в составе!
📅 ${escapeHtml(fmtDay(event?.date, 'ru'))} ${escapeHtml(event?.time || '')}`,
    { reply_markup: calendarKeyboard(event, 'ru', signup.signup_id) }).catch(() => {});
  if (adminChatId) {
    await notifyOrganizer({ ...signup, ...updated, status: SIGNUP_STATUS.paid, paid_thb: amount },
      event, adminChatId, '💰 Оплата подтверждена').catch(() => {});
  }
  return { ok: true, message: `✅ Оплата зачтена: <b>${escapeHtml(signup.player_name || signup.telegram_id)}</b>, ${amount} ฿.` };
}

// --- напоминания ------------------------------------------------------------
// Работают как напоминания о матчах: проход по расписанию раз в 15 минут, отметка
// об отправке лежит в Settings, поэтому одно и то же письмо не уходит дважды.
const REMINDERS = [
  { key: 'd1', hours: 24, ru: 'Завтра', en: 'Tomorrow' },
  { key: 'h2', hours: 2,  ru: 'Сегодня', en: 'Today' }
];
const sentKey = (signupId, key) => `ev_rem_${key}_${signupId}`;

function whenLine(event, lang) {
  const L = ru(lang);
  const place = event.place_url
    ? `<a href="${escapeHtml(event.place_url)}">${escapeHtml(event.place)}</a>`
    : escapeHtml(event.place || '');
  return [
    `📅 ${escapeHtml(fmtDay(event.date, lang))} ${escapeHtml(event.time)}`,
    place ? `📍 ${place}` : ''
  ].filter(Boolean).join('\n');
}

export async function runEventReminders(now = Date.now()) {
  const events = await listEvents().catch(() => []);
  if (!events.length) return { sent: 0 };
  const signups = await listSignups().catch(() => []);
  let sent = 0;
  for (const event of events) {
    const start = startMs(event);
    if (!start || start < now) continue;
    const hoursLeft = (start - now) / 3600000;
    const mine = signups.filter(s => s.event_id === event.event_id
      && s.status !== SIGNUP_STATUS.cancelled && s.status !== SIGNUP_STATUS.waitlist);

    for (const rem of REMINDERS) {
      // Окно в час: проход идёт раз в 15 минут, точное совпадение не поймать.
      if (hoursLeft > rem.hours || hoursLeft < rem.hours - 1) continue;
      for (const s of mine) {
        const key = sentKey(s.signup_id, rem.key);
        if (await getSetting(key).catch(() => '')) continue;
        const L = true;
        const title = event.title_ru || event.title_en;
        await sendMessage(s.telegram_id, `⏰ <b>${escapeHtml(rem.ru)} — ${escapeHtml(title)}</b>

${whenLine(event, 'ru')}${s.guests ? `\n👥 С тобой гостей: <b>${s.guests}</b>` : ''}`, {
          reply_markup: { inline_keyboard: [[{ text: '❌ Отменить участие', callback_data: `ev_cxl:${s.signup_id}` }]] }
        }).catch(() => {});
        await setSetting(key, new Date(now).toISOString(), 'Напоминание о событии отправлено').catch(() => {});
        sent++;
      }
    }

    // Неоплаченным — одно напоминание за сутки до конца записи.
    if (isSignupOpen(event, now) && hoursLeft <= 48) {
      for (const s of mine) {
        if (s.status !== SIGNUP_STATUS.invoiced && s.status !== SIGNUP_STATUS.pending) continue;
        const key = sentKey(s.signup_id, 'pay');
        if (await getSetting(key).catch(() => '')) continue;
        const balance = await getBalance(s.telegram_id).catch(() => 0);
        await sendMessage(s.telegram_id, await invoiceText(event, s, 'ru', balance),
          { reply_markup: invoiceKeyboard(event, s, 'ru', balance) }).catch(() => {});
        await setSetting(key, new Date(now).toISOString(), 'Напоминание об оплате события отправлено').catch(() => {});
        sent++;
      }
    }
  }
  return { sent };
}

// Организатор поменял дату, время или место — записавшимся надо сказать.
export async function notifyEventChanged(event, changes = [], adminChatId = '') {
  if (!event || !changes.length) return { sent: 0 };
  const signups = (await listSignups().catch(() => []))
    .filter(s => s.event_id === event.event_id && s.status !== SIGNUP_STATUS.cancelled);
  let sent = 0;
  for (const s of signups) {
    await sendMessage(s.telegram_id, `⚠️ <b>Изменение: ${escapeHtml(event.title_ru || event.title_en)}</b>

${changes.map(c => `• ${escapeHtml(c)}`).join('\n')}

${whenLine(event, 'ru')}`, {
      reply_markup: { inline_keyboard: [[{ text: '❌ Отменить участие', callback_data: `ev_cxl:${s.signup_id}` }]] }
    }).catch(() => {});
    sent++;
  }
  if (adminChatId && sent) {
    await sendMessage(adminChatId, `📣 Об изменении сообщил участникам: <b>${sent}</b>.`).catch(() => {});
  }
  return { sent };
}

// Что именно поменялось — человеческим языком, только то, что важно игроку.
export function describeEventChanges(before = {}, after = {}) {
  const out = [];
  const pairs = [
    ['date', 'Дата'], ['time', 'Время'], ['place', 'Место'], ['signup_deadline', 'Запись до']
  ];
  for (const [field, label] of pairs) {
    const a = safe(before[field]), b = safe(after[field]);
    if (a !== b && b) out.push(`${label}: ${a || '—'} → ${b}`);
  }
  return out;
}

// --- правка состава организатором ------------------------------------------
// mode: 'inv' — выставить счёт, 'paid' — засчитать оплаченным, 'free' — событие
// бесплатное, просто подтверждаем.
export async function addToEvent({ eventId, telegramId, name, lang = 'ru', mode = 'inv', adminChatId = '' }) {
  const event = await findEvent(eventId);
  if (!event) return { ok: false, message: 'Событие не найдено.' };
  const existing = await findSignup(eventId, telegramId);
  if (existing) return { ok: false, message: `<b>${escapeHtml(name)}</b> уже в составе.` };

  const amount = priceFor(event, 0);
  // mode === 'dep' — оплачиваем сразу с депозита игрока, если денег хватает.
  if (mode === 'dep' && event.payment_required && amount > 0) {
    const balance = await getBalance(telegramId).catch(() => 0);
    if (balance < amount) {
      return { ok: false, message: `На депозите <b>${balance} ฿</b>, а нужно <b>${amount} ฿</b> — не хватает.` };
    }
  }
  const paying = mode === 'inv' && event.payment_required && amount > 0;
  const status = paying ? SIGNUP_STATUS.invoiced
    : ((mode === 'paid' || mode === 'dep') ? SIGNUP_STATUS.paid : SIGNUP_STATUS.confirmed);
  const signup = await createSignup({
    event, telegramId, name, guests: 0, status,
    amount: paying ? amount : 0
  });
  if (mode === 'paid') {
    await updateSignup(signup.signup_id, { paid_thb: amount, paid_from: 'добавлен организатором' });
  }
  let depositLeft = null;
  if (mode === 'dep' && event.payment_required && amount > 0) {
    depositLeft = await addTransaction({
      telegramId, name, type: 'расход', amount: -amount,
      description: `Участие: ${event.title_ru || event.event_id}`
    });
    await updateSignup(signup.signup_id, { paid_thb: amount, paid_from: 'депозит' });
  }

  const L = ru(lang);
  if (paying) {
    const balance = await getBalance(telegramId).catch(() => 0);
    await sendMessage(telegramId, L
      ? `Организатор добавил тебя на «${escapeHtml(event.title_ru)}». Осталось оплатить участие.`
      : `The organizer added you to “${escapeHtml(event.title_en)}”. Please pay for your spot.`).catch(() => {});
    await sendMessage(telegramId, await invoiceText(event, signup, lang, balance),
      { reply_markup: invoiceKeyboard(event, signup, lang, balance) }).catch(() => {});
  } else {
    const dep = depositLeft === null ? '' : (L
      ? `\n💳 Списано с депозита: <b>${amount} ฿</b>. Остаток: <b>${depositLeft} ฿</b>`
      : `\n💳 Charged to your deposit: <b>${amount} ฿</b>. Balance: <b>${depositLeft} ฿</b>`);
    await sendMessage(telegramId, L
      ? `✅ Ты в составе на «${escapeHtml(event.title_ru)}».\n📅 ${escapeHtml(fmtDay(event.date, lang))} ${escapeHtml(event.time)}${dep}`
      : `✅ You are in for “${escapeHtml(event.title_en)}”.\n📅 ${escapeHtml(fmtDay(event.date, lang))} ${escapeHtml(event.time)}${dep}`,
      { reply_markup: calendarKeyboard(event, lang, signup.signup_id) }).catch(() => {});
  }
  if (adminChatId) await notifyOrganizer({ ...signup, status }, event, adminChatId, 'добавлен организатором').catch(() => {});
  touchEventCards(event.event_id);
  const what = paying ? 'счёт отправлен'
    : (mode === 'dep' ? `оплачено с депозита, остаток ${depositLeft} ฿`
      : (mode === 'paid' ? 'засчитан оплаченным' : 'участие подтверждено'));
  return { ok: true, message: `✅ <b>${escapeHtml(name)}</b> в составе — ${what}.` };
}

// mode: 'full' — вернуть всё, 'rule' — по правилу отмены, 'none' — без возврата.
export async function removeFromEvent({ signupId, mode = 'rule', adminChatId = '' }) {
  const all = await listSignups();
  const signup = all.find(s => s.signup_id === String(signupId));
  if (!signup) return { ok: false, message: 'Запись не найдена.' };
  if (signup.status === SIGNUP_STATUS.cancelled) return { ok: false, message: 'Уже не в составе.' };
  const event = await findEvent(signup.event_id);
  const paid = signup.paid_thb || 0;

  let refund = 0;
  if (paid > 0) {
    if (mode === 'full') refund = paid;
    else if (mode === 'rule') refund = refundForCancel(event, signup, false).refund;
  }
  await updateSignup(signup.signup_id, { status: SIGNUP_STATUS.cancelled, note: 'снят организатором' });
  touchEventCards(signup.event_id);
  let left = null;
  if (refund > 0) {
    left = await addTransaction({
      telegramId: signup.telegram_id, name: signup.player_name, type: 'возврат', amount: refund,
      description: `Снят организатором: ${event?.title_ru || signup.event_id}`
    });
  }
  await sendMessage(signup.telegram_id, refund > 0
    ? `Организатор снял тебя с «${escapeHtml(event?.title_ru || '')}». Возврат на депозит: <b>${refund} ฿</b>.`
    : `Организатор снял тебя с «${escapeHtml(event?.title_ru || '')}».`).catch(() => {});
  if (adminChatId) {
    await notifyOrganizer({ ...signup, status: SIGNUP_STATUS.cancelled }, event, adminChatId,
      refund > 0 ? `↩️ Возврат: <b>${refund} ฿</b>` : '🚫 Без возврата').catch(() => {});
  }
  // Освободившееся место сразу уходит в лист ожидания.
  await runWaitlistOffers(Date.now(), adminChatId).catch(() => {});
  const tail = refund > 0 ? ` Возврат: <b>${refund} ฿</b>${left != null ? `, депозит: <b>${left} ฿</b>` : ''}.` : '';
  return { ok: true, message: `✅ <b>${escapeHtml(signup.player_name || signup.telegram_id)}</b> снят с события.${tail}` };
}

// --- удаление события -------------------------------------------------------
//
// Событие уходит насовсем: строка стирается из реестра, разосланные карточки
// превращаются в «событие отменено», записавшимся приходит уведомление, деньги
// возвращаются. Способ возврата организатор выбирает один раз на всё событие:
//   balance — сразу на депозит в боте;
//   manual  — вернёт переводом сам, бот только ведёт список долгов.
// Заметка в тему игрока в админском чате. Импорт ленивый: admin.js сам тянет
// eventflow.js, и обычный import замкнул бы их друг на друга.
async function topicNote(adminChatId, telegramId, text) {
  const { replyInPlayerTopic, getAdminChatId } = await import('./admin.js');
  const chat = adminChatId || await getAdminChatId().catch(() => '');
  if (!chat) return null;
  return replyInPlayerTopic(chat, telegramId, text);
}

export async function deleteEvent({ eventId, refundMode = 'balance', adminChatId = '' }) {
  const event = await findEvent(eventId);
  if (!event) return { ok: false, message: 'Событие не найдено.' };
  const all = await listSignups().catch(() => []);
  const mine = all.filter(s => s.event_id === eventId && s.status !== SIGNUP_STATUS.cancelled);
  const title = event.title_ru || event.title_en || eventId;

  let refunded = 0, refundSum = 0, owed = 0, told = 0;
  for (const s of mine) {
    const lang = 'ru';
    const paid = s.paid_thb || 0;
    const waiting = s.status === SIGNUP_STATUS.waitlist;
    let tail = '';
    if (paid > 0) {
      if (refundMode === 'manual') {
        await addRefund({
          eventId, eventTitle: title, telegramId: s.telegram_id, name: s.player_name,
          amount: paid, reason: 'событие отменено'
        }).catch(e => console.error('refund note failed:', e.message));
        owed += paid;
        tail = `\n↩️ Возвращаем <b>${paid} ฿</b> переводом — напишу, как отправлю.`;
        // Долг видно и в теме игрока: иначе он живёт только в списке в админке.
        await topicNote(adminChatId, s.telegram_id,
          `🏦 <b>Нужно вернуть ${paid} ฿ вручную</b>\nСобытие отменено: ${escapeHtml(title)}`).catch(() => {});
      } else {
        const left = await addTransaction({
          telegramId: s.telegram_id, name: s.player_name, type: 'возврат', amount: paid,
          description: `Событие отменено: ${title}`
        }).catch(() => null);
        refundSum += paid;
        tail = left === null
          ? `\n↩️ Возвращаем <b>${paid} ฿</b>.`
          : `\n↩️ Возвращено на депозит: <b>${paid} ฿</b>. Остаток: <b>${left} ฿</b>`;
      }
      refunded++;
    }
    await updateSignup(s.signup_id, { status: SIGNUP_STATUS.cancelled, note: 'событие удалено' }).catch(() => {});
    await setSetting(holdKey(s.signup_id), '', 'Событие удалено').catch(() => {});
    const head = waiting
      ? `❌ Событие «${escapeHtml(title)}» отменено — лист ожидания больше не нужен.`
      : `❌ Событие «${escapeHtml(title)}» отменено организатором.`;
    const sent = await sendMessage(s.telegram_id, `${head}${tail}`).catch(() => null);
    if (sent) told++;
  }

  // Карточки в чатах: текст меняем, кнопку снимаем — жать больше нечего.
  await refreshEventCards(eventId, {
    text: (lang) => ru(lang)
      ? `❌ <b>СОБЫТИЕ ОТМЕНЕНО</b>\n\n<b>${escapeHtml(title)}</b>`
      : `❌ <b>EVENT CANCELLED</b>\n\n<b>${escapeHtml(event.title_en || title)}</b>`
  }).catch(e => console.error('cancel cards failed:', e.message));
  await forgetEventCards(eventId).catch(() => {});
  await deleteEventRow(eventId).catch(e => console.error('event row delete failed:', e.message));

  const parts = [`🗑 Событие «${escapeHtml(title)}» удалено.`];
  if (mine.length) parts.push(`Оповещено: <b>${told}</b> из ${mine.length}.`);
  if (refundMode === 'manual' && owed > 0) parts.push(`К возврату вручную: <b>${owed} ฿</b> (${refunded} чел.) — список в админке.`);
  else if (refundSum > 0) parts.push(`Возвращено на депозиты: <b>${refundSum} ฿</b> (${refunded} чел.).`);
  else parts.push('Возвращать было нечего.');
  const message = parts.join('\n');
  if (adminChatId) await sendMessage(adminChatId, message).catch(() => {});
  return { ok: true, message, told, refunded, refundSum, owed };
}

// Кто уже записан. Состав виден всем участникам — это часть карточки, — но
// telegram_id отдаём только организатору: он им правит состав.
const LIVE_SIGNUP = new Set([
  SIGNUP_STATUS.pending, SIGNUP_STATUS.invoiced, SIGNUP_STATUS.paid, SIGNUP_STATUS.confirmed
]);
function participantsOf(all, eventId, isAdmin) {
  return all
    .filter(s => s.event_id === eventId && s.status !== SIGNUP_STATUS.cancelled)
    .map(s => ({
      name: s.player_name || String(s.telegram_id),
      status: s.status,
      guests: s.guests || 0,
      paid: s.status === SIGNUP_STATUS.paid || s.status === SIGNUP_STATUS.confirmed,
      waitlist: s.status === SIGNUP_STATUS.waitlist,
      signup_id: isAdmin ? s.signup_id : '',
      telegram_id: isAdmin ? String(s.telegram_id) : ''
    }))
    .sort((a, b) => Number(a.waitlist) - Number(b.waitlist) || a.name.localeCompare(b.name, 'ru'));
}

// Лист ожидания карточки: по порядку очереди, с номерами.
function queueOf(all, eventId, isAdmin) {
  return waitlistQueue(all, eventId).map((s, i) => ({
    name: s.player_name || String(s.telegram_id),
    place: i + 1,
    guests: s.guests || 0,
    signup_id: isAdmin ? s.signup_id : '',
    telegram_id: isAdmin ? String(s.telegram_id) : ''
  }));
}

export async function eventsForViewer(telegramId = '', isActivePlayer = false, isAdmin = false) {
  const events = await listEvents();
  const mine = await listSignups();
  const out = [];
  for (const e of events) {
    if (e.audience === 'active' && !isActivePlayer) continue;
    const signup = mine.find(s => s.event_id === e.event_id
      && String(s.telegram_id) === String(telegramId)
      && s.status !== SIGNUP_STATUS.cancelled) || null;
    // Событие «только по приглашению» для остальных просто не существует.
    // Уже записавшегося не выкидываем, даже если его убрали из списка.
    if (e.invite_only && !signup && !isInvited(e, telegramId)) continue;
    const taken = await takenSeats(e.event_id);
    out.push({
      ...e,
      taken,
      seats_left: e.capacity ? Math.max(0, e.capacity - taken) : null,
      my_status: signup?.status || '',
      my_signup_id: signup?.signup_id || '',
      my_guests: signup?.guests || 0,
      my_paid: signup?.paid_thb || 0,
      // Свой номер в очереди и окно на решение — чтобы человек видел, чего ждёт.
      my_queue: signup?.status === SIGNUP_STATUS.waitlist ? waitlistPosition(mine, e.event_id, telegramId) : 0,
      offer_window_hours: offerWindowHours(e),
      participants: participantsOf(mine, e.event_id, isAdmin).filter(p => !p.waitlist),
      waitlist: queueOf(mine, e.event_id, isAdmin),
      // Открыта ли запись прямо сейчас: по этому признаку вкладка «События»
      // подсвечивается, чтобы люди не пропускали новое.
      open_now: isSignupOpen(e) && (!e.capacity || Math.max(0, e.capacity - taken) > 0) && !signup
    });
  }
  // Ближайшее сверху: событие через неделю важнее того, что через месяц.
  return out.sort((a, b) => (startMs(a) || Infinity) - (startMs(b) || Infinity));
}

// Дата и время события в миллисекундах. Считает events.js, чтобы у напоминаний
// и у правила отмены был один и тот же момент старта.
export function startMs(event) {
  return eventStartMs(event) || 0;
}

// Запись открыта, пока не прошёл срок записи, а если он не задан — пока не
// началось само событие.
export function isSignupOpen(event, now = Date.now()) {
  if (!event || event.status !== 'published') return false;
  const d = safe(event.signup_deadline);
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d);
  if (m) return now <= Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 16, 59);
  const start = startMs(event);
  return !start || now <= start;
}
