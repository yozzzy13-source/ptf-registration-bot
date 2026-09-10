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
import { getSetting, setSetting } from './sheets.js';
import {
  findEvent, listEvents, listSignups, findSignup, createSignup, updateSignup,
  takenSeats, priceFor, seatsOf, refundForCancel, hoursUntil,
  addTransaction, getBalance, publishEvent, updateEvent,
  SIGNUP_STATUS, CANCEL_LIMIT_HOURS
} from './events.js';

const ru = (lang) => lang === 'ru';

// --- карточка события ------------------------------------------------------

// Формат взят из тренерского бота: эмодзи, место, дата, время, свободные места.
export function eventCard(event, lang = 'ru', { taken = 0 } = {}) {
  const L = ru(lang);
  const title = (L ? event.title_ru : event.title_en) || event.title_ru || event.title_en;
  const desc = (L ? event.description_ru : event.description_en) || '';
  const lines = [`🎾 <b>${escapeHtml(title)}</b>`];
  // Описание идёт сразу под заголовком: сперва о чём событие, потом детали.
  if (desc) lines.push('', escapeHtml(desc), '');
  // Место — ссылкой, если она задана; сам адрес отдельной строкой не дублируем.
  if (event.place) {
    lines.push(event.place_url
      ? `📍 <a href="${escapeHtml(event.place_url)}">${escapeHtml(event.place)}</a>`
      : `📍 ${escapeHtml(event.place)}`);
  }
  if (event.date) lines.push(`📅 <b>${escapeHtml(event.date)}</b>`);
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
  if (event.signup_deadline) lines.push(L ? `⏳ Запись до ${escapeHtml(event.signup_deadline)}` : `⏳ Sign-up until ${escapeHtml(event.signup_deadline)}`);
  if (event.invite_only) lines.push(L ? '🔒 Только по приглашению' : '🔒 By invitation only');
  return lines.join('\n');
}

// Приглашён ли игрок на закрытое событие.
export function isInvited(event, telegramId) {
  return (event?.invited_ids || []).map(String).includes(String(telegramId));
}

export function signupKeyboard(event, lang = 'ru') {
  const L = ru(lang);
  return { inline_keyboard: [[{ text: L ? '✅ Записаться' : '✅ Sign up', callback_data: `ev_join:${event.event_id}` }]] };
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
  await sendMessage(chatId, eventCard(event, 'ru', { taken }), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📣 Подтвердить и разослать', callback_data: `ev_pub:${eventId}` }],
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
  let ok = 0, fail = 0;
  for (const c of contacts) {
    const lang = (c.language || 'en') === 'ru' ? 'ru' : 'en';
    try {
      await sendMessage(c.telegram_id, eventCard(event, lang, { taken }), { reply_markup: signupKeyboard(event, lang) });
      ok++;
    } catch { fail++; }
  }
  return sendMessage(chatId, `📣 Событие опубликовано.\nОтправлено: <b>${ok}</b>${fail ? `\nОшибок: <b>${fail}</b>` : ''}`);
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

export async function joinEvent({ telegramId, name, lang = 'ru', eventId, guests = 0, adminChatId = '' }) {
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
  const existing = await findSignup(eventId, telegramId);
  if (existing) return { ok: false, message: L ? 'Ты уже записан на это событие.' : 'You are already signed up.' };

  const wantSeats = 1 + (event.guests_allowed ? Math.min(guests, event.max_guests) : 0);
  const taken = await takenSeats(eventId);
  const noRoom = event.capacity > 0 && taken + wantSeats > event.capacity;
  const amount = priceFor(event, wantSeats - 1);

  const status = noRoom ? SIGNUP_STATUS.waitlist
    : (event.payment_required && amount > 0 ? SIGNUP_STATUS.invoiced : SIGNUP_STATUS.confirmed);
  const signup = await createSignup({
    event, telegramId, name, guests: wantSeats - 1, status, amount: noRoom ? 0 : amount
  });

  let message;
  if (noRoom) {
    message = L
      ? `Мест на «${event.title_ru}» сейчас нет — ты в листе ожидания. Если кто-то откажется, напишу тебе первым. Деньги пока не переводи.`
      : `“${event.title_en}” is full — you are on the waitlist. If a spot frees up, I will write to you first. Do not pay yet.`;
  } else if (status === SIGNUP_STATUS.confirmed) {
    message = L
      ? `Заявка на «${event.title_ru}» принята. Ты в списке участников.\n📅 ${event.date} ${event.time}\n📍 ${event.place}`
      : `You are in for “${event.title_en}”.\n📅 ${event.date} ${event.time}\n📍 ${event.place}`;
  } else {
    message = null; // счёт отправит invoiceSignup
  }
  if (adminChatId) await notifyOrganizer(signup, event, adminChatId).catch(() => {});
  return { ok: true, signup, event, message, needsInvoice: status === SIGNUP_STATUS.invoiced, amount };
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
  return { ok: true, message: L
    ? `✅ Оплачено с депозита: <b>${signup.amount_thb} ฿</b>. Остаток: <b>${left} ฿</b>\nТы в списке участников.`
    : `✅ Paid from deposit: <b>${signup.amount_thb} ฿</b>. Remaining: <b>${left} ฿</b>\nYou are on the list.` };
}

// --- отмена ----------------------------------------------------------------

export function cancelWarning(event, signup, lang = 'ru', now = Date.now()) {
  const L = ru(lang);
  const hours = event.refund_hours ?? CANCEL_LIMIT_HOURS;
  const left = hoursUntil(event, now);
  const late = hours > 0 && left !== null && left < hours;
  if (!signup.paid_thb) {
    return L ? 'Отменить участие?' : 'Cancel your spot?';
  }
  if (late) {
    return L
      ? `⚠️ До события меньше ${hours} ч. По правилам поздней отмены оплата <b>не возвращается</b>. Всё равно отменить?`
      : `⚠️ Less than ${hours} h before the event. Under the late cancellation rule the payment is <b>not refunded</b>. Cancel anyway?`;
  }
  return L
    ? `Отменить участие? До события больше ${hours} ч — оплата вернётся на депозит.`
    : `Cancel your spot? More than ${hours} h before the event — the payment returns to your deposit.`;
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
    const extra = decision.refund > 0 ? `↩️ Возврат на депозит: <b>${decision.refund} ฿</b>`
      : (decision.burned > 0 ? `🔥 Поздняя отмена, удержано: <b>${decision.burned} ฿</b>` : '');
    await notifyOrganizer({ ...signup, ...updated, status: keepGuests ? signup.status : SIGNUP_STATUS.cancelled }, event, adminChatId, extra).catch(() => {});
  }

  let message;
  if (decision.refund > 0) {
    message = L
      ? `↩️ Участие отменено. Возвращено на депозит: <b>${decision.refund} ฿</b>. Остаток: <b>${left} ฿</b>`
      : `↩️ Cancelled. Returned to your deposit: <b>${decision.refund} ฿</b>. Balance: <b>${left} ฿</b>`;
  } else if (decision.burned > 0) {
    message = L
      ? `Участие отменено. Отмена позже срока — оплата <b>${decision.burned} ฿</b> удержана.`
      : `Cancelled. Late cancellation — <b>${decision.burned} ฿</b> is withheld.`;
  } else {
    message = L ? 'Участие отменено.' : 'Your spot is cancelled.';
  }
  if (keepGuests && signup.guests > 0) {
    message += L ? `\nГости (${signup.guests}) остаются в списке.` : `\nYour guests (${signup.guests}) stay on the list.`;
  }
  return { ok: true, message, refund: decision.refund, burned: decision.burned };
}

// --- витрина ---------------------------------------------------------------

// Что показать игроку во вкладке «События».
export async function eventsForViewer(telegramId = '', isActivePlayer = false) {
  const events = await listEvents();
  const mine = telegramId ? await listSignups() : [];
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
      my_paid: signup?.paid_thb || 0
    });
  }
  return out;
}
