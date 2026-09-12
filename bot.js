import { sendMessage, editMessageText, answerCallbackQuery, copyMessage, webAppButton, setChatCommands, PLAYER_COMMANDS, MATCH_COMMANDS, ADMIN_COMMANDS, ADMIN_COMMAND_LIST } from './telegram.js';
import { mainKeyboard, persistentKeyboard, menuAction, MENU_VERSION, textKeyboard, paymentKeyboard, cryptoKeyboard, contactOpenKeyboard, paymentEntryKeyboard, challengeKeyboard, directChatKeyboard, adminPanelKeyboard, languageKeyboard } from './keyboards.js';
import { getBotText, getSetting, setSetting, getActiveEvents, getPaymentMethods, findApplication, updateApplication, logMessage, logPayment, updateApplicantStatusByTelegramId, findApplicantByTelegramId, findApplicantByAdminTopicId, isProfileCompleted, createMatchChallenge, updateMatchChallenge, updateApplicantByTelegramId, findLatestPayableApplicationByTelegramId, findLatestApplicationByTelegramId, setUserLanguage, isActiveLeaguePlayer, setResultsOptOut, isResultsMutedFor, invalidateLeagueCache, buttonsFor, keyboardForGroup } from './sheets.js';
import { t, tt } from './i18n.js';
import { findDestination, destinationLabel, linksCheatSheet } from './links.js';
import { nowISO, uid, escapeHtml } from './util.js';
import { DEFAULT_USDT_AMOUNT, PUBLIC_URL } from './config.js';
import { findSlot as findMatchSlot, listMySlots, listResultTasks, awaitingSide, acceptProposal, rejectProposal, confirmCourt, confirmResult, disputeResult, rejectResultByAdmin, proposeTimeChange, acceptTimeChange, rejectTimeChange } from './matchesdb.js';
import { declineDirectChallenge, notifyMatchAgreed, notifyProposalRejected, sendBookingHelper, notifyCourtConfirmed,
  notifyResultConfirmed, notifyResultDisputed, notifyCrossDivision, notifyResultRejected, broadcastResult,
  timeChoiceKeyboard, timeChoiceText, notifyTimeChange, notifyTimeChangeAccepted, notifyTimeChangeRejected } from './matches.js';
import { writeConfirmedResult, describeWrite } from './results.js';
import { invalidateDivisionCache } from './division.js';
import { notifyIncomingMessage, notifyPaymentProof, notifyPlayerMedia, notifyAboutPlayer, adminTopicTest, adminTopicSync, adminMatchTest, adminMatchesOverview, notifyAdmin, isAdminUser, handleAdminInit, adminStats, adminEvents, adminPending, adminMessages, adminProfile, adminWhois, adminIdCheck, adminPhotoCheck, startBroadcast, startBroadcastWithMenu, handleBroadcastMessage, handleBroadcastMenuMessage, handleBroadcastSegment, executeBroadcast, executeBroadcastWithMenu, startBroadcastPoll, handleBroadcastPollMessage, executeBroadcastPoll, adminPollStats, startMissingRatingBroadcast, executeMissingRatingBroadcast, sendRatingRequestTo, notifyAvatarVariant, pickAvatarVariant, showAvatarGallery, adminState, setApplicationStatus, setPaymentStatus, attachMediaToPayment, sendInvoiceToApplicant, paymentAutoOn, setPaymentAuto, activatePlayer, waitlistPlayer, eventPreview, eventPublish, eventDrop, eventDeleteDo, eventJoin, eventPayFromDeposit, eventCancelAsk, eventCancelDo, askAddToEvent, askRemoveFromEvent, eventAddDo, eventRemoveDo, getAdminChatId } from './admin.js';

export const userState = new Map();
async function userLang(from) {
  const saved = await findApplicantByTelegramId(from.id).catch(() => null);
  return ['ru','en'].includes(String(saved?.language || '').toLowerCase()) ? String(saved.language).toLowerCase() : null;
}
function fallbackLang(lang) { return lang === 'ru' ? 'ru' : 'en'; }
async function sendLanguageChoice(chatId) {
  return sendMessage(chatId, t('en','choose_language'), { reply_markup: languageKeyboard() });
}
// Состояние игрока определяет и набор кнопок, и то, показывать ли рассказ про
// PTF. Активному он не нужен — он уже всё знает, и повтор выглядит как спам.
async function playerState(userId) {
  const out = { kind:'lead', active:false, profile:null, app:null };
  try {
    out.profile = await findApplicantByTelegramId(userId);
    if (out.profile) out.active = await isActiveLeaguePlayer({ ...out.profile, id: userId });
  } catch (e) { console.error('player state failed:', e.message); }
  if (out.active) { out.kind = 'active'; return out; }
  // Состав берём из «Short Players list» (там дивизион и допуск к матчам),
  // а статус оплаты — из Applications. Это два разных источника, и путать их
  // нельзя: человек может быть оплачен, но ещё не расписан по дивизионам.
  try {
    out.app = await findLatestPayableApplicationByTelegramId(userId);
  } catch (e) { console.error('player state application failed:', e.message); }
  if (!out.app?.application_id) return out;
  const pay = String(out.app.payment_status || '').toLowerCase();
  const appSt = String(out.app.application_status || '').toLowerCase();
  // Оплатил, но в составе его пока нет: «Оплатить» показывать уже незачем,
  // а матчи ещё не открыть.
  if (pay === 'approved' || appSt === 'active' || appSt === 'payment_approved') out.kind = 'paid';
  else out.kind = 'unpaid';
  return out;
}

// Постоянная клавиатура не привязана к сообщению, поэтому её достаточно
// поставить один раз и обновлять только при смене состояния. Сигнатуру держим
// в памяти: лишняя перестановка на каждое сообщение мигает у человека экраном.
const menuSignature = new Map();
// Матчи, результат и бронь корта имеют смысл только игроку из действующего
// состава: остальным эти экраны всё равно откажут. Поэтому набор из админки
// пересекаем с тем, что человеку реально доступно.
const MATCH_ONLY = ['matches', 'result', 'court'];
async function keyboardFor(chatId, lang, kind, userId) {
  const key = String(chatId);
  let allow = null;
  try {
    allow = await keyboardForGroup(userId);
    if (kind !== 'active') allow = allow.filter(k => !MATCH_ONLY.includes(k));
  } catch (e) { console.error('keyboard set failed:', e.message); allow = null; }
  // В сигнатуру входит версия раскладки, набор кнопок и наличие персонального
  // токена: после деплоя или правки в админке клавиатура обязана обновиться у
  // всех, иначе люди остаются со старой и жмут кнопки, которых уже нет.
  const kb = persistentKeyboard(lang, kind, userId, allow);
  const oneTap = kb.keyboard.flat().some(b => b.web_app) ? 'app' : 'txt';
  const sig = `v${MENU_VERSION}:${lang}:${kind}:${oneTap}:${(allow || []).join('.')}`;
  if (menuSignature.get(key) === sig) return null;
  menuSignature.set(key, sig);
  return kb.keyboard.length ? kb : null;
}

// Короткая сводка для активного игрока: ближайший матч и то, чего от него ждут.
// Если сказать нечего — возвращаем пустую строку, и меню остаётся коротким.
// Навигационный блок кнопок под сообщением. Активному игроку он не нужен:
// у него внизу постоянное меню, и два одинаковых списка на экране только мешают.
// Кнопки-действия (оплатить, записаться) это правило не затрагивает — они живут
// в своих клавиатурах и остаются на месте.
// Какие кнопки видит этот человек. Набор задаётся в админке для каждой группы:
// активные, лист ожидания, заявка без оплаты, все остальные. Не смогли узнать —
// показываем всё, как было раньше.
async function allowedButtons(telegramId) {
  try { return await buttonsFor(telegramId); } catch (e) { console.error('menu buttons failed:', e.message); return null; }
}
async function menuMarkup(lang, telegramId, extra = {}) {
  const active = await isActiveLeaguePlayer({ id: telegramId, telegram_id: telegramId }).catch(() => false);
  if (active) return { ...extra };
  const allow = await allowedButtons(telegramId);
  const kb = mainKeyboard(lang, { allow });
  return kb.inline_keyboard.length ? { ...extra, reply_markup: kb } : { ...extra };
}

async function playerDigest(userId, lang) {
  const ru = lang === 'ru';
  const lines = [];
  try {
    const [slots, tasks] = await Promise.all([
      listMySlots(userId).catch(() => []),
      listResultTasks(userId).catch(() => [])
    ]);
    const next = slots.find(sl => sl.agreed_date && String(sl.status || '').toLowerCase() === 'accepted');
    if (next) {
      const me = String(userId);
      const opp = String(next.from_telegram_id) === me ? next.to_name : next.from_name;
      const when = [next.agreed_date, next.agreed_time].filter(Boolean).join(', ');
      const where = next.agreed_court ? ` · ${next.agreed_court}` : '';
      lines.push(`${ru ? '🎾 Ближайший матч' : '🎾 Next match'}: <b>${escapeHtml(opp || '')}</b> — ${escapeHtml(when)}${escapeHtml(where)}`);
    }
    const waiting = slots.filter(sl => String(sl.status || '').toLowerCase() === 'pending'
      && String(awaitingSide(sl).id) === String(userId));
    if (waiting.length) lines.push(ru ? `⏳ Ждут твоего ответа: <b>${waiting.length}</b>` : `⏳ Waiting for your answer: <b>${waiting.length}</b>`);
    if (tasks.length) lines.push(ru ? `📊 Не внесён счёт: <b>${tasks.length}</b>` : `📊 Result not submitted: <b>${tasks.length}</b>`);
  } catch (e) { console.error('player digest failed:', e.message); }
  return lines.join('\n');
}

// Перевыставляет постоянную клавиатуру, если она устарела (сменилось состояние
// игрока, поднялась версия раскладки или у человека висит текстовый вариант).
// Молчит, когда менять нечего.
async function refreshMenu(chatId, lang, from) {
  if (Number(chatId) < 0) return null;
  const userId = from?.id ?? chatId;
  const l = fallbackLang(lang);
  const st = await playerState(userId);
  const kb = await keyboardFor(chatId, l, st.kind, userId);
  if (!kb) return null;
  return sendMessage(chatId, l === 'ru' ? '⌨️ Обновил быстрые кнопки — теперь разделы открываются одним нажатием.' : '⌨️ Quick buttons updated — sections now open in one tap.', { reply_markup: kb });
}

async function sendMain(chatId, lang, from=null) {
  closeContactSession(chatId); userState.delete(String(chatId));
  const l=fallbackLang(lang);
  const userId = from?.id ?? chatId;
  const st = await playerState(userId);
  await syncUserCommands(chatId, l, { active: st.active, admin: isAdminUser(userId) });
  // Отрицательный chat_id — это группа: там кнопки мини-приложения запрещены.
  const noWebApp = Number(chatId) < 0;
  const isPrivateChat = !noWebApp;

  // Активному игроку вместо рассказа про PTF — сводка по его матчам.
  let body;
  if (st.active) {
    const digest = await playerDigest(userId, l);
    const hello = l === 'ru' ? `<b>${escapeHtml(st.profile?.name || '')}</b>, ты в составе сезона 🎾`.trim() : `<b>${escapeHtml(st.profile?.name || '')}</b>, you are in the season line-up 🎾`.trim();
    body = digest ? `${hello}\n\n${digest}` : hello;
  } else {
    const txt = await getBotText('welcome_main', l);
    body = txt?.html_text || '<b>Welcome to Phuket Tennis Family</b> 🎾';
  }

  // У активного игрока внизу есть постоянное меню, и второй такой же список
  // кнопок под сообщением только загромождает экран — показываем его только тем,
  // кто ещё не в лиге и для кого это единственная навигация.
  let opts = {};
  if (!(st.active && isPrivateChat)) {
    const kb = mainKeyboard(l, { matches: st.active, noWebApp, allow: await allowedButtons(userId) });
    if (kb.inline_keyboard.length) opts = { reply_markup: kb };
  }
  await sendMessage(chatId, body, opts);
  // Постоянное меню ставим отдельным коротким сообщением — двух reply_markup
  // в одном сообщении Telegram не принимает.
  if (isPrivateChat) {
    const kb = await keyboardFor(chatId, l, st.kind, userId);
    if (kb) await sendMessage(chatId, l === 'ru' ? '⌨️ Быстрые кнопки внизу — они всегда под рукой.' : '⌨️ Quick buttons below — always at hand.', { reply_markup: kb }).catch(e => console.error('persistent keyboard failed:', e.message));
  }
}

// Подсказка команд в личке. Общий список короткий; команды матчей добавляются
// персонально тем, кто в активном составе, админу — полный админский список.
// Кэш сигнатуры, чтобы не дёргать Telegram на каждое /start.
const commandSignature = new Map();
async function syncUserCommands(chatId, lang, { active=false, admin=false } = {}) {
  const l = lang === 'ru' ? 'ru' : 'en';
  // Версия в подписи: когда список команд меняется, Telegram должен получить
  // новый — иначе у тех, кому уже выставляли команды, останется старое меню.
  const sig = `v2:${admin ? 'admin' : (active ? 'match' : 'base')}:${l}`;
  if (commandSignature.get(String(chatId)) === sig) return;
  const list = admin ? [...ADMIN_COMMANDS, ...MATCH_COMMANDS[l]]
    : (active ? [...MATCH_COMMANDS[l], ...PLAYER_COMMANDS[l]] : PLAYER_COMMANDS[l]);
  try {
    await setChatCommands(chatId, list);
    commandSignature.set(String(chatId), sig);
  } catch (e) { console.error('setChatCommands failed:', e.message); }
}

// /match, /result, /book — прямой вход в нужную вкладку мини-приложения.
// Доступны только активным игрокам состава: остальным кнопка всё равно не откроется.
// Ссылка-раздел (t.me/бот?start=go_<код>) разворачивается в нужный экран.
// Мини-приложение бот открыть сам не может — даёт кнопку в один тап;
// внутренние экраны открываются сразу.
async function openDestination(chatId, lang, from, code) {
  const dest = findDestination(code);
  if (!dest) return sendMain(chatId, lang, from);
  const l = fallbackLang(lang);
  if (dest.kind === 'callback') {
    if (dest.action === 'payment_entry') return sendPaymentEntry(chatId, from, l);
    if (dest.action === 'contact') {
      openContactSession(chatId, l);
      return sendMessage(chatId, t(l, 'contact_prompt'), { reply_markup: contactOpenKeyboard(l) });
    }
    if (dest.action.startsWith('text:')) return sendTextSection(chatId, l, dest.action.slice(5));
    return sendMain(chatId, l, from);
  }
  const label = destinationLabel(dest, l);
  return sendMessage(chatId, l === 'ru' ? `Открыть раздел: <b>${escapeHtml(label)}</b>` : `Open section: <b>${escapeHtml(label)}</b>`, {
    reply_markup: { inline_keyboard: [
      [{ text: label, web_app: { url: `${PUBLIC_URL}${dest.path}` } }],
      [{ text: t(l, 'main_menu'), callback_data: 'main' }]
    ] }
  });
}

// Кнопка постоянной клавиатуры не может открыть мини-приложение сама: Telegram
// не передаёт в него initData. Поэтому отвечаем сообщением с inline-кнопкой —
// у неё авторизация работает.
const OPEN_APP = {
  league: { path:'/league',            ru:'🏆 Открыть лигу',      en:'🏆 Open the league',
            tru:'Таблицы, годовая гонка, игроки и история матчей.', ten:'Tables, Yearly Race, players and match history.' },
  squad:  { path:'/participants',      ru:'👥 Открыть состав',    en:'👥 Open the line-up',
            tru:'Предварительные составы дивизионов сезона.',       ten:'Preliminary division line-ups for the season.' },
  apply:  { path:'/apply?mode=event',  ru:'🎾 Подать заявку',     en:'🎾 Apply for the season',
            tru:'Заполни заявку — это пара минут.',                 ten:'Filling in the form takes a couple of minutes.' }
};
async function sendOpenApp(chatId, lang, key) {
  const l = fallbackLang(lang);
  const d = OPEN_APP[key];
  if (!d) return sendMain(chatId, l, null);
  const ru = l === 'ru';
  return sendMessage(chatId, ru ? d.tru : d.ten, {
    reply_markup: { inline_keyboard: [[{ text: ru ? d.ru : d.en, web_app: { url: `${PUBLIC_URL}${d.path}` } }]] }
  });
}

async function sendMatchShortcut(chatId, lang, from, tab) {
  const l = fallbackLang(lang);
  let active = false;
  try {
    const profile = await findApplicantByTelegramId(from?.id ?? chatId);
    if (profile) active = await isActiveLeaguePlayer({ ...profile, id: from?.id ?? chatId });
  } catch (e) { console.error('match shortcut league check failed:', e.message); }
  if (!active && !isAdminUser(from?.id)) {
    return sendMessage(chatId, l === 'ru'
      ? '🎾 Матчи доступны игрокам действующего состава лиги. Если ты уже подал заявку — дождись распределения по дивизионам.'
      : '🎾 Matches are for players in the current league roster. If you have applied, wait until divisions are set.',
      await menuMarkup(l, from?.id ?? chatId));
  }
  const titles = {
    open: l === 'ru' ? '🎾 Матчи и вызовы' : '🎾 Matches and challenges',
    res:  l === 'ru' ? '📊 Внести результат матча' : '📊 Submit a match result',
    book: l === 'ru' ? '🎾 Забронировать корт' : '🎾 Book a court'
  };
  const buttons = {
    open: l === 'ru' ? '🎾 Открыть матчи' : '🎾 Open matches',
    res:  l === 'ru' ? '📊 Внести результат' : '📊 Submit result',
    book: l === 'ru' ? '🎾 Забронировать' : '🎾 Book'
  };
  return sendMessage(chatId, `<b>${titles[tab]}</b>`, {
    reply_markup: { inline_keyboard: [[{ text: buttons[tab], web_app: { url: `${PUBLIC_URL}/match?tab=${tab}` } }]] }
  });
}
// Справка. У игрока и у админа она разная: игроку — что бот умеет,
// админу — рабочие команды по группам. Список держим здесь, а не в i18n,
// потому что часть строк зависит от статуса игрока.
async function sendHelp(chatId, lang, from = {}, msg = {}) {
  const l = fallbackLang(lang);
  const ru = l === 'ru';
  const isAdminHere = isAdminUser(from.id)
    && (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup' || await getSetting('admin_chat_id') === String(chatId) || msg.chat?.type === 'private');
  if (isAdminHere) return sendMessage(chatId, adminHelpText());

  let active = false;
  try {
    const profile = await findApplicantByTelegramId(from?.id ?? chatId);
    if (profile) active = await isActiveLeaguePlayer({ ...profile, id: from?.id ?? chatId });
  } catch (e) { console.error('help league check failed:', e.message); }

  const lines = ru ? [
    '<b>🎾 Что умеет бот</b>',
    '',
    'Здесь ты подаёшь заявку в лигу, договариваешься о матчах, бронируешь корт и вносишь счёт.',
    '',
    '<b>Команды</b>',
    '/menu — главное меню',
    ...(active
      ? ['/match — матчи: окна соперников, создать своё, мои матчи',
         '/result — внести результат сыгранного матча',
         '/book — забронировать корт']
      : ['<i>Матчи, результаты и бронь корта откроются после распределения по дивизионам.</i>']),
    '/results — лента результатов: включить или выключить',
    '/language — сменить язык',
    '/cancel — отменить текущее действие',
    '/help — этот список'
  ] : [
    '<b>🎾 What this bot does</b>',
    '',
    'Apply to the league, arrange matches, book a court and submit scores.',
    '',
    '<b>Commands</b>',
    '/menu — main menu',
    ...(active
      ? ['/match — matches: open slots, create your own, your matches',
         '/result — submit a match result',
         '/book — book a court']
      : ['<i>Matches, results and court booking open up once divisions are set.</i>']),
    '/results — results feed: on or off',
    '/language — change language',
    '/cancel — cancel current action',
    '/help — this list'
  ];
  return sendMessage(chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: [
      [{ text: ru ? '📋 Главное меню' : '📋 Main menu', callback_data: 'main' }],
      [{ text: ru ? '💬 Связаться' : '💬 Contact', callback_data: 'contact' }]
    ] }
  });
}

function adminHelpText() {
  // Текст собирается из того же списка, что и меню по слэшу: добавил команду
  // в ADMIN_COMMAND_LIST — она сама появилась и здесь, и там.
  const order = ['Лига', 'Матчи', 'Панель и рассылки', 'Настройка', 'Прочее'];
  const lines = ['<b>PTF — команды организатора</b>'];
  for (const group of order) {
    const items = ADMIN_COMMAND_LIST.filter(c => c.group === group);
    if (!items.length) continue;
    lines.push('', `<b>${group}</b>`);
    for (const c of items) {
      lines.push(`/${c.cmd}${c.args ? ' ' + c.args : ''} — ${c.help || c.short}`);
    }
  }
  lines.push('', '<b>Кнопки, а не команды</b>',
    '• На чеке за лигу три решения: <b>Approve</b> — участие подтверждено, <b>⏳ Оплата принята → Waitlist</b> — деньги приняли, место ждём, <b>Reject</b>.',
    '• Событие правится и удаляется в панели: удаление спрашивает, вернуть деньги на балансы или ты вернёшь переводом сам.',
    '• Возвраты переводом копятся во вкладке «Возвраты» — там же отмечаешь «отправил».',
    '• Касса: игрок выбирается из списка, пополнение/списание/возврат — кнопками, комментарий обязателен.',
    '• Вкладка «Кнопки» — что видит каждая группа игроков: вкладки мини-приложения, кнопки под сообщением и нижняя клавиатура в чате.',
    '• Там же «Прислать в бот» и «Открыть мини-апп» — посмотреть всё глазами выбранной группы, без второго аккаунта.',
    '', '<b>Дивизионы</b>',
    '• Дивизион игрока и список его соперников берутся из таблицы дивизиона последнего сезона, лист <b>Division_Tracker</b>, список под заголовком «Player». Переносишь игрока — правишь только там: убрал из одной таблицы, добавил в другую.',
    '• Статус (active / inactive) — из анкеты в Applicants. Нет статуса active — матчи закрыты, даже если игрок есть в сетке.',
    '• Таблица предварительного состава участвует только в странице «Состав» и в счётчике заявок на событиях. На матчи она больше не влияет.',
    '• <code>/match_test</code> показывает, из какой таблицы, листа и строки бот взял дивизион.',
    '', '<b>Где отвечает бот</b>',
    '• Всё по конкретному игроку — активация, счёт, правка состава события, возвраты — приходит в тему этого игрока в админской группе. Темы нет — заводится сама.',
    '• Аватарку игроку меняешь в панели, во вкладке «Игроки», кнопкой «Аватар» в его строке.',
    '• Твой личный чат с ботом работает как у обычного игрока: там видно ровно то, что видит он.',
    '• Команды выше отвечают там, где ты их набрал.',
    '', '<i>Команды игрока (/match, /result, /book, /results) у вас тоже работают.</i>',
    '<i>Ответ игроку: Reply под его сообщением в топике.</i>');
  return lines.join('\n');
}

// Экран настроек ленты результатов. Показывается и по команде /results,
// и сразу после нажатия «Stop results» — чтобы человек понимал, что именно отключил.
async function sendResultsSettings(chatId, lang, telegramId, event = '') {
  const l = fallbackLang(lang);
  const muted = await isResultsMutedFor(telegramId).catch(() => false);
  const ru = l === 'ru';
  const explain = ru
    ? 'Лента результатов — это счёт чужих матчей лиги. Уведомления о ваших собственных матчах, вызовах, оплате и ответах организатора приходят всегда и не отключаются.'
    : 'The results feed is other players’ match scores. Notifications about your own matches, challenges, payments and organiser replies always come through and cannot be turned off.';
  const head = event === 'just_muted'
    ? (ru ? '<b>🔕 Результаты матчей отключены</b>' : '<b>🔕 Match results turned off</b>')
    : event === 'just_unmuted'
      ? (ru ? '<b>🔔 Результаты матчей включены</b>' : '<b>🔔 Match results turned on</b>')
      : (ru ? '<b>📊 Лента результатов</b>' : '<b>📊 Results feed</b>');
  const state = muted
    ? (ru ? 'Сейчас: <b>выключена</b>' : 'Now: <b>off</b>')
    : (ru ? 'Сейчас: <b>включена</b>' : 'Now: <b>on</b>');
  const button = muted
    ? { text: ru ? '🔔 Включить результаты' : '🔔 Turn results on', callback_data: 'results_unmute' }
    : { text: ru ? '🔕 Отключить результаты' : '🔕 Turn results off', callback_data: 'results_mute' };
  return sendMessage(chatId, `${head}\n\n${explain}\n\n${state}`, {
    reply_markup: { inline_keyboard: [[button]] }
  });
}


async function sendTextSection(chatId, lang, key, editMsgId=null) { let txt=await getBotText(key,lang); if(key==='about_ptf' && !txt?.html_text) txt=await getBotText('welcome_main',lang); const body=txt?.html_text || `<b>${escapeHtml(key)}</b>`; let opts={reply_markup:textKeyboard(lang,key,{noWebApp:Number(chatId)<0})}; if(key==='yearly_race'){ opts={reply_markup:{inline_keyboard:[[webAppButton(lang==='ru'?'📊 Посмотреть рейтинг':'📊 View Ranking','/league?tab=race')],[{text:t(lang,'how'),callback_data:'text:how_league_works'}],[{text:t(lang,'back'),callback_data:'main'}]]}}; } if(editMsgId) await editMessageText(chatId,editMsgId,body,opts); else await sendMessage(chatId,body,opts); }
function cleanPaymentAmount(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\s*(THB|USDT|USD|฿|\$)\s*/gi, '').trim();
}

function formatPaymentAmounts(lang, amountThb, amountUsdt) {
  return lang === 'ru'
    ? `

<b>Сумма к оплате</b>
Bank Transfer: <b>${escapeHtml(amountThb || '-')} THB</b>
USDT: <b>${escapeHtml(amountUsdt || '-')} USDT</b>`
    : `

<b>Payment amount</b>
Bank Transfer: <b>${escapeHtml(amountThb || '-')} THB</b>
USDT: <b>${escapeHtml(amountUsdt || '-')} USDT</b>`;
}

async function paymentAmountsForApplication(app) {
  const events = await getActiveEvents().catch(() => []);
  const event = events.find(e => String(e.event_id || '') === String(app?.event_id || '')) || null;
  const amountThb = cleanPaymentAmount(event?.price_thb) || cleanPaymentAmount(app?.payment_amount_thb) || cleanPaymentAmount(app?.price_thb) || cleanPaymentAmount(app?.payment_amount) || '';
  const amountUsdt = cleanPaymentAmount(event?.price_usdt) || cleanPaymentAmount(event?.usdt_amount) || cleanPaymentAmount(app?.payment_amount_usdt) || cleanPaymentAmount(app?.price_usdt) || cleanPaymentAmount(DEFAULT_USDT_AMOUNT) || '';
  if (app?.application_id) {
    const patch = {};
    if (amountThb && String(app.payment_amount_thb || '') !== String(amountThb)) patch.payment_amount_thb = amountThb;
    if (amountThb && String(app.price_thb || '') !== String(amountThb)) patch.price_thb = amountThb;
    if (amountUsdt && String(app.payment_amount_usdt || '') !== String(amountUsdt)) patch.payment_amount_usdt = amountUsdt;
    if (amountUsdt && String(app.price_usdt || '') !== String(amountUsdt)) patch.price_usdt = amountUsdt;
    if (Object.keys(patch).length) await updateApplication(app.application_id, patch).catch(e => console.error('payment amount sync failed:', e.message));
  }
  return { amountThb, amountUsdt };
}

async function handlePaymentMenu(chatId, lang, applicationId) {
  const app = await findApplication(applicationId).catch(() => null);
  if (!app) return sendMessage(chatId, 'Application not found.');
  const { amountThb, amountUsdt } = await paymentAmountsForApplication(app);
  await sendMessage(chatId, `${t(lang,'payment_section')}${formatPaymentAmounts(lang, amountThb, amountUsdt)}`, { reply_markup: paymentKeyboard(lang,applicationId) });
}

async function sendPaymentInstructions(chatId, lang, applicationId, methodId) {
  const app = await findApplication(applicationId);
  if (!app) return sendMessage(chatId,'Application not found.');
  const methods = await getPaymentMethods();
  const method = methods.find(m => m.method_id === methodId);
  if (!method) return sendMessage(chatId,'Payment method not found.');
  const { amountThb, amountUsdt } = await paymentAmountsForApplication(app);
  const paymentId = uid('payment');
  const isCrypto = method.method_type === 'crypto';
  const amount = isCrypto ? (amountUsdt || DEFAULT_USDT_AMOUNT) : (amountThb || 2490);
  const currency = isCrypto ? 'USDT' : (method.currency || 'THB');
  const network = method.network || '';
  const recipient = method.recipient || '';
  await logPayment({ payment_id:paymentId, application_id:applicationId, telegram_id:app.telegram_id, player_name:app.player_name, event_id:app.event_id, event_name:app.event_name, method:method.display_name_en||methodId, network, amount, currency, invoice_text:`${methodId} ${amount} ${currency}`, status:'invoice_created' });
  await updateApplication(applicationId, { application_status:'waiting_payment', payment_status:'waiting_payment', payment_id:paymentId, payment_method:isCrypto?'USDT':'Bank Transfer', payment_network:network, payment_amount:amount, payment_currency:currency, payment_amount_thb:amountThb, payment_amount_usdt:amountUsdt, price_thb:amountThb, price_usdt:amountUsdt });
  await updateApplicantStatusByTelegramId(app.telegram_id,'waiting_payment');
  userState.set(String(chatId), { mode:'awaiting_payment_proof', applicationId, paymentId, methodId });
  let text;
  if (isCrypto) {
    text = lang === 'ru'
      ? `<b>💵 Оплата USDT ${escapeHtml(network)}</b>

Сумма: <b>${escapeHtml(amount)} USDT</b>

Адрес кошелька ${escapeHtml(network)}:
<code>${escapeHtml(recipient)}</code>

⚠️ Убедитесь, что вы выбрали правильную сеть: <b>${escapeHtml(network)}</b>.

${escapeHtml(t(lang,'payment_refund_note'))}

${t(lang,'send_proof')}`
      : `<b>💵 USDT ${escapeHtml(network)} payment</b>

Amount: <b>${escapeHtml(amount)} USDT</b>

Wallet address ${escapeHtml(network)}:
<code>${escapeHtml(recipient)}</code>

⚠️ Make sure you use the correct network: <b>${escapeHtml(network)}</b>.

${escapeHtml(t(lang,'payment_refund_note'))}

${t(lang,'send_proof')}`;
  } else {
    text = lang === 'ru'
      ? `<b>🏦 Bank Transfer</b>

Сумма: <b>${escapeHtml(amount)} THB</b>

Реквизиты:
<code>${escapeHtml(recipient)}</code>

${escapeHtml(t(lang,'payment_refund_note'))}

${t(lang,'send_proof')}`
      : `<b>🏦 Bank Transfer</b>

Amount: <b>${escapeHtml(amount)} THB</b>

Bank details:
<code>${escapeHtml(recipient)}</code>

${escapeHtml(t(lang,'payment_refund_note'))}

${t(lang,'send_proof')}`;
  }
  await sendMessage(chatId, text);
}

function contactName(from){return [from.first_name,from.last_name].filter(Boolean).join(' ')}
function messageType(msg={}) {
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.video_note) return 'video_note';
  if (msg.video) return 'video';
  if (msg.photo?.length) return 'photo';
  if (msg.document) return 'document';
  if (msg.sticker) return 'sticker';
  return 'text';
}
function paymentProofMedia(msg={}) {
  if (msg.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, type: 'photo' };
  if (msg.document) return { fileId: msg.document.file_id, type: 'document' };
  if (msg.video) return { fileId: msg.video.file_id, type: 'video' };
  if (msg.voice) return { fileId: msg.voice.file_id, type: 'voice' };
  if (msg.audio) return { fileId: msg.audio.file_id, type: 'audio' };
  if (msg.video_note) return { fileId: msg.video_note.file_id, type: 'video_note' };
  if (msg.sticker) return { fileId: msg.sticker.file_id, type: 'sticker' };
  return null;
}

// Оплата «висит», если у последней заявки взнос ещё не подтверждён. Подтверждённая
// оплата, уже отправленный чек и активное участие сюда не попадают — по ним чек
// не ждут, и присланная картинка чеком не является.
const PENDING_PAYMENT = new Set(['payment_required', 'waiting_payment', 'rejected']);
async function hasPendingPayment(telegramId) {
  try {
    const app = await findLatestApplicationByTelegramId(telegramId);
    if (!app?.application_id) return false;
    const pay = String(app.payment_status || '').toLowerCase();
    const appSt = String(app.application_status || '').toLowerCase();
    if (['approved', 'proof_received', 'refunded'].includes(pay)) return false;
    if (['active', 'rejected', 'refunded'].includes(appSt)) return false;
    return PENDING_PAYMENT.has(pay) || appSt === 'waiting_payment';
  } catch (e) {
    console.error('pending payment check failed:', e.message);
    return false;
  }
}

async function handlePaymentProofSubmission(msg, lang, state=null) {
  const proofMedia = paymentProofMedia(msg);
  if (!proofMedia) return false;
  const from = msg.from || {};
  const applicationId = state?.applicationId || '';
  let app = applicationId
    ? await findApplication(applicationId).catch(() => null)
    : await findLatestPayableApplicationByTelegramId(from.id).catch(() => null);

  // Robust fallback: if the bot process restarted or an old application row has a non-standard
  // payment status, still attach the proof to the latest event application for this player.
  if (!app?.application_id && !applicationId) {
    const latest = await findLatestApplicationByTelegramId(from.id).catch(() => null);
    const appStatus = String(latest?.application_status || '').toLowerCase();
    const payStatus = String(latest?.payment_status || '').toLowerCase();
    const canAcceptProof = latest?.application_id
      && !['active','rejected','refunded'].includes(appStatus)
      && !['approved','rejected','refunded'].includes(payStatus)
      && String(latest?.event_id || '').trim();
    if (canAcceptProof) app = latest;
  }
  // Без явной платёжной цепочки (state пустой) чек принимаем, только если взнос
  // действительно не подтверждён. Иначе картинка из обычного диалога сбивала бы
  // активному игроку статус на proof_received.
  if (!applicationId && app?.application_id) {
    const pay = String(app.payment_status || '').toLowerCase();
    const appSt = String(app.application_status || '').toLowerCase();
    if (['approved', 'refunded'].includes(pay) || ['active', 'refunded'].includes(appSt)) return false;
  }
  if (!app?.application_id) return false;

  const paymentId = state?.paymentId || app.payment_id || uid('payment');
  const updatedApp = await updateApplication(app.application_id, {
    application_status:'proof_received',
    payment_status:'proof_received',
    payment_proof_status:'proof_received',
    payment_proof_file_id:proofMedia.fileId,
    payment_proof_type:proofMedia.type,
    payment_id: paymentId
  });
  await updateApplicantStatusByTelegramId(from.id, 'proof_received');
  await logPayment({
    payment_id:paymentId,
    application_id:app.application_id,
    telegram_id:from.id,
    player_name:app.player_name,
    event_id:app.event_id,
    event_name:app.event_name,
    method:app.payment_method || state?.methodId || '',
    network:app.payment_network || '',
    amount:app.payment_amount || '',
    currency:app.payment_currency || '',
    proof_file_id:proofMedia.fileId,
    proof_type:proofMedia.type,
    proof_received_at:nowISO(),
    status:'proof_received'
  });
  userState.delete(String(msg.chat.id));

  // Admin notification must never block the player-side confirmation. Previously, if Telegram
  // failed to copy the screenshot to the topic, the handler threw and the player got dropped back
  // to the main menu without the "proof received" message.
  await notifyPaymentProof({
    app: updatedApp || { ...app, application_status:'proof_received', payment_status:'proof_received', payment_id:paymentId },
    payment:{ payment_id:paymentId, method:app.payment_method || state?.methodId || '', network:app.payment_network || '', amount:app.payment_amount || '', currency:app.payment_currency || '' },
    from,
    originalMessage:msg
  }).catch(e => console.error('notify payment proof failed:', e.message));

  await sendMessage(msg.chat.id, t(lang, 'proof_received'));
  return true;
}
async function forwardContactMessage(msg,lang){const from=msg.from||{}; const type=messageType(msg); const text=msg.text||msg.caption||(type==='text'?'':'[media]'); await logMessage({message_id:uid('msg'),telegram_id:from.id,telegram_username:from.username||'',name:contactName(from),direction:'incoming',message_type:type,message_text:text,timestamp:nowISO(),status:'new',telegram_message_id:msg.message_id}); await notifyIncomingMessage({id:from.id,username:from.username,name:contactName(from)},text,msg.message_id,msg.chat.id,msg); return null;}
const contactTimers = new Map();
function openContactSession(chatId, lang) {
  const key = String(chatId);
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  const oldTimer = contactTimers.get(key);
  if (oldTimer) clearTimeout(oldTimer);
  userState.set(key, { mode:'contact', expiresAt, lang });
  const timer = setTimeout(async () => {
    const state = userState.get(key);
    if (state?.mode === 'contact' && Number(state.expiresAt || 0) <= Date.now()) {
      userState.delete(key);
      contactTimers.delete(key);
      await sendMessage(chatId, t(state.lang || lang, 'contact_expired'), { reply_markup: mainKeyboard(state.lang || lang) }).catch(() => {});
    }
  }, 2 * 60 * 60 * 1000 + 1000);
  contactTimers.set(key, timer);
}
function closeContactSession(chatId) {
  const key = String(chatId);
  const timer = contactTimers.get(key);
  if (timer) clearTimeout(timer);
  contactTimers.delete(key);
  userState.delete(key);
}
async function handleContactMessage(msg, state, lang) {
  if (Number(state.expiresAt || 0) <= Date.now()) {
    closeContactSession(msg.chat.id);
    return sendMessage(msg.chat.id, t(lang, 'contact_expired'), { reply_markup: mainKeyboard(lang) });
  }
  return forwardContactMessage(msg, lang);
}
async function sendPaymentEntry(chatId, from, lang) {
  const profile = await findApplicantByTelegramId(from.id);
  const hasProfile = isProfileCompleted(profile);
  if (!hasProfile) return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_no_profile')}`, { reply_markup: paymentEntryKeyboard(lang, { hasProfile:false }) });
  const app = await findLatestPayableApplicationByTelegramId(from.id);
  if (!app) return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_no_application')}`, { reply_markup: paymentEntryKeyboard(lang, { hasProfile:true }) });
  const pStatus = String(app.payment_status || '').toLowerCase();
  const aStatus = String(app.application_status || '').toLowerCase();
  if (aStatus === 'active') return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_active')}`, await menuMarkup(lang, from.id));
  if (pStatus === 'approved' || aStatus === 'payment_approved') return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_already_paid')}`, await menuMarkup(lang, from.id));
  if (pStatus === 'proof_received' || aStatus === 'proof_received') return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_already_proof')}`, await menuMarkup(lang, from.id));
  const { amountThb, amountUsdt } = await paymentAmountsForApplication(app);
  return sendMessage(chatId, `${t(lang,'payment_section')}${formatPaymentAmounts(lang, amountThb, amountUsdt)}`, { reply_markup: paymentKeyboard(lang, app.application_id) });
}

async function handleChallengeStart(chatId,from,lang,targetTelegramId){const challenger=await findApplicantByTelegramId(from.id); if(!isProfileCompleted(challenger)) return sendMessage(chatId,t(lang,'challenge_needs_profile'),{reply_markup:mainKeyboard(lang)}); if(String(from.id)===String(targetTelegramId)) return sendMessage(chatId,t(lang,'challenge_self')); const target=await findApplicantByTelegramId(targetTelegramId); if(!target?.telegram_id) return sendMessage(chatId,t(lang,'challenge_target_missing')); const challengeId=uid('challenge'); const profileUrl=challenger.player_profile_url || await getSetting('website_players') || await getSetting('website_url') || 'https://phukettennis.com/'; await createMatchChallenge({challenge_id:challengeId,from_telegram_id:challenger.telegram_id,from_name:challenger.name,from_username:challenger.telegram_username,from_player_profile_url:profileUrl,to_telegram_id:target.telegram_id,to_name:target.name,to_username:target.telegram_username,status:'pending',created_at:nowISO(),direct_chat_available:challenger.telegram_username?'yes':'no',match_chat_mode:challenger.telegram_username?'direct':'bot_fallback'}); const targetLang=target.language==='ru'?'ru':'en'; await sendMessage(target.telegram_id,tt(targetLang,'challenge_received',{name:challenger.name}),{reply_markup:challengeKeyboard(targetLang,challengeId,profileUrl)}); return sendMessage(chatId,t(lang,'challenge_sent'));}
async function acceptChallenge(chatId,from,lang,challengeId){const ch=await updateMatchChallenge(challengeId,{status:'accepted',responded_at:nowISO()}); if(!ch) return sendMessage(chatId,'Challenge not found.'); const fromLang=(await findApplicantByTelegramId(ch.from_telegram_id))?.language||'en'; const targetName=ch.to_name||contactName(from); if(ch.from_username){ await sendMessage(chatId,t(lang,'challenge_accepted_to_target'),{reply_markup:directChatKeyboard(lang,ch.from_username)}); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_accepted_to_from',{name:targetName}),ch.to_username?{reply_markup:directChatKeyboard(fromLang,ch.to_username)}:{});} else {userState.set(String(chatId),{mode:'challenge_chat',challengeId,peerId:ch.from_telegram_id}); userState.set(String(ch.from_telegram_id),{mode:'challenge_chat',challengeId,peerId:chatId}); await sendMessage(chatId,t(lang,'fallback_chat_opened')); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_accepted_to_from',{name:targetName})+'\n\n'+t(fromLang,'fallback_chat_opened'));}}
async function declineChallenge(chatId,from,lang,challengeId){const ch=await updateMatchChallenge(challengeId,{status:'declined',responded_at:nowISO()}); if(!ch) return sendMessage(chatId,'Challenge not found.'); const fromLang=(await findApplicantByTelegramId(ch.from_telegram_id))?.language||'en'; await sendMessage(chatId,t(lang,'challenge_declined_to_target')); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_declined_to_from',{name:ch.to_name||contactName(from)}));}
async function forwardChallengeChat(msg,state){const from=msg.from||{}; const text=msg.text||msg.caption||'[media]'; await sendMessage(state.peerId,`<b>💬 Message from ${escapeHtml(contactName(from)||from.username||from.id)}</b>\n\n${escapeHtml(text)}`); await logMessage({message_id:uid('msg'),telegram_id:from.id,name:contactName(from),direction:'challenge_chat',message_type:'text',message_text:text,timestamp:nowISO(),related_event:state.challengeId,status:'sent'});}

async function forwardAdminTopicMessageToPlayer(msg, player) {
  if (!player?.telegram_id) return false;
  const text = msg.text || msg.caption || '';
  try {
    if (msg.photo?.length || msg.document || msg.video || msg.voice || msg.audio || msg.sticker) {
      await copyMessage(player.telegram_id, msg.chat.id, msg.message_id);
    } else if (text) {
      await sendMessage(player.telegram_id, text);
    } else {
      return false;
    }
    await logMessage({ message_id:uid('msg'), telegram_id:player.telegram_id, telegram_username:player.telegram_username || '', name:player.name || '', direction:'outgoing', message_type: messageType(msg), message_text:text || '[media]', timestamp:nowISO(), admin_id:msg.from?.id || '', admin_name:msg.from?.username || msg.from?.first_name || '', status:'sent', admin_thread_id:msg.message_thread_id || '' });
    return true;
  } catch (e) {
    console.error('forwardAdminTopicMessageToPlayer failed:', e.message);
    return false;
  }
}

export async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const storedLang = await userLang(from);
  const lang = fallbackLang(storedLang);
  const text = (msg.text || '').trim();
  const isPrivate = msg.chat.type === 'private';

  if (text === '/cancel') {
    closeContactSession(chatId);
    userState.delete(String(chatId));
    adminState.delete(String(from.id));
    return sendMessage(chatId, t(lang, 'cancelled'));
  }

  if (text.startsWith('/start')) {
    const param = text.split(/\s+/)[1] || '';
    if (!storedLang && isPrivate) {
      userState.set(String(chatId), { mode:'awaiting_language', pendingStartParam:param });
      return sendLanguageChoice(chatId);
    }
    if (param.startsWith('challenge_')) return handleChallengeStart(chatId, from, lang, param.replace('challenge_', ''));
    // Ссылка «Играю» из чата дивизиона: открываем мини-приложение сразу на этой заявке.
    if (param.startsWith('match_')) {
      const slotId = param.replace(/^match_/, '');
      return sendMessage(chatId, lang === 'ru'
        ? '🎾 Выберите удобные дату и корт из предложенных соперником.'
        : '🎾 Pick a date and court from what your opponent offered.', {
        reply_markup: { inline_keyboard: [[{ text: lang === 'ru' ? '🎾 Выбрать и принять' : '🎾 Choose and accept', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slotId)}` } }]] }
      });
    }
    // Ссылка-раздел из рассылки: t.me/бот?start=go_<код>.
    if (param.startsWith('go_')) return openDestination(chatId, lang, from, param.replace(/^go_/, ''));
    if (!isPrivate) return null;
    return sendMain(chatId, lang, from);
  }

  if (text === '/language' && isPrivate) return sendLanguageChoice(chatId);

  if (!storedLang && isPrivate && !isAdminUser(from.id)) {
    return sendLanguageChoice(chatId);
  }

  // Быстрые команды вместо похода через /start и меню.
  if (text === '/menu' && isPrivate) return sendMain(chatId, lang, from);
  if (text === '/avatar' && isPrivate) return showAvatarGallery(chatId, from.id);
  if (text === '/results' && isPrivate) return sendResultsSettings(chatId, lang, from.id);
  if (text === '/match' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'open');
  if (text === '/result' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'res');
  if (text === '/book' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'book');

  if (text === '/help') return sendHelp(chatId, lang, from, msg);
  if (text === '/links') {
    if (!isAdminUser(from.id)) return sendMessage(chatId, t(lang, 'admin_only'));
    return sendMessage(chatId, linksCheatSheet(), msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
  }

  if (text === '/admin_init') {
    if (!isAdminUser(from.id)) return sendMessage(chatId, t(lang, 'admin_only'));
    // В админском чате подсказываем полный список админских команд.
    await setChatCommands(chatId, ADMIN_COMMANDS).catch(e => console.error('admin commands failed:', e.message));
    return handleAdminInit(msg);
  }
  if (text === '/admin') {
    if (!isAdminUser(from.id)) return sendMessage(chatId, t(lang, 'admin_only'));
    await syncUserCommands(chatId, lang, { admin: true });
    return sendMessage(chatId, '<b>PTF Admin Panel</b>\n\nOpen the admin WebApp to filter players, send broadcasts, request selfies and message players.', { reply_markup: adminPanelKeyboard(lang) });
  }

  if (isAdminUser(from.id)) {
    if (text === '/stats') return adminStats(chatId);
    // Рубильник автосчёта по сезону: /payment_auto — показать, /payment_auto off — выключить.
    if (text === '/payment_auto' || text.startsWith('/payment_auto ')) {
      const arg = text.replace('/payment_auto', '').trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        await setPaymentAuto(arg === 'on');
        return sendMessage(chatId, arg === 'on'
          ? '💳 Автосчёт <b>включён</b>: заявка сразу открывает игроку оплату.'
          : '🛑 Автосчёт <b>выключен</b>: игрок получает «проверяем места», а в его топике появляется кнопка «Выставить счёт».');
      }
      const on = await paymentAutoOn();
      return sendMessage(chatId, `Автосчёт сейчас: <b>${on ? 'включён' : 'выключен'}</b>.\n\n/payment_auto on — включить\n/payment_auto off — выключить`);
    }
    if (text === '/topic_test') return adminTopicTest(msg);
    if (text === '/topic_sync') return adminTopicSync(msg);
    if (text === '/match_test') return adminMatchTest(msg);
    if (text === '/overview' || text === '/matches') return adminMatchesOverview(msg);
    if (text === '/league') {
      return sendMessage(chatId, '<b>🏆 Лига — тест нового интерфейса</b>\n\nГодовая гонка, список игроков и карточка игрока. Пока видно только вам.', {
        reply_markup: { inline_keyboard: [[{ text: '🏆 Открыть', web_app: { url: `${PUBLIC_URL}/league` } }]] }
      });
    }
    // Выполняется прямо в той группе и теме, куда должны падать результаты.
    if (text === '/results_here') {
      await setSetting('results_chat_id', String(msg.chat.id), 'Группа для ленты результатов матчей');
      await setSetting('results_topic_id', String(msg.message_thread_id || ''), 'Тема для ленты результатов матчей');
      return sendMessage(chatId, `✅ Лента результатов привязана.\n\nchat_id: <code>${escapeHtml(msg.chat.id)}</code>${msg.message_thread_id ? `\ntopic: <code>${escapeHtml(msg.message_thread_id)}</code>` : ''}`, msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
    }
    if (text === '/events') return adminEvents(chatId);
    if (text === '/pending') return adminPending(chatId);
    if (text === '/messages') return adminMessages(chatId);
    // Рассылка «уточните свой уровень»: показывает два охвата и ждёт выбора.
    if (text.startsWith('/rating_to')) return sendRatingRequestTo(chatId, text.replace('/rating_to','').trim());
    if (text === '/rating' || text === '/rating_broadcast') return startMissingRatingBroadcast(chatId, from.id);
    if (text.startsWith('/profile')) return adminProfile(chatId, text);
    if (text.startsWith('/whois')) return adminWhois(chatId, text);
    if (text === '/id_check') return adminIdCheck(chatId);
    if (text === '/photos') return adminPhotoCheck(chatId);

    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && msg.message_thread_id && !text.startsWith('/')) {
      const topicPlayer = await findApplicantByAdminTopicId(msg.message_thread_id).catch(() => null);
      if (topicPlayer) {
        await forwardAdminTopicMessageToPlayer(msg, topicPlayer);
        return null;
      }
    }

    const aState = adminState.get(String(from.id));
    if (aState?.mode === 'reply_waiting') {
      const replyText = msg.text || msg.caption || '';
      if (paymentProofMedia(msg)) await copyMessage(aState.targetTelegramId, msg.chat.id, msg.message_id);
      else if (replyText) await sendMessage(aState.targetTelegramId, replyText);
      else return sendMessage(chatId, 'Send text or media to forward to the player.');
      await logMessage({ message_id:uid('msg'), telegram_id:aState.targetTelegramId, direction:'outgoing', message_type:messageType(msg), message_text:replyText || '[media]', timestamp:nowISO(), admin_id:from.id, admin_name:from.username || from.first_name || '', status:'sent' });
      adminState.delete(String(from.id));
      return null;
    }
    if (aState?.mode === 'broadcast_message') return handleBroadcastMessage(msg, aState);
    if (aState?.mode === 'broadcast_menu_message') return handleBroadcastMenuMessage(msg, aState);
    if (aState?.mode === 'broadcast_poll_message') return handleBroadcastPollMessage(msg, aState);

    if (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) {
      const body = msg.reply_to_message.text || msg.reply_to_message.caption || '';
      const match = body.match(/TGID:\s*(?:<code>)?(\d+)/i) || body.match(/TGID:\s*(\d+)/i);
      if (match && text) {
        await sendMessage(match[1], text);
        await logMessage({ message_id:uid('msg'), telegram_id:match[1], direction:'outgoing', message_type:'text', message_text:text, timestamp:nowISO(), admin_id:from.id, admin_name:from.username || from.first_name || '', status:'sent' });
        return null;
      }
    }
  }

  // Кнопки постоянного меню приходят обычным текстом. Разбираем их ДО режимов
  // «связаться» и «чат с соперником» — иначе нажатие уйдёт собеседнику текстом.
  if (isPrivate && text) {
    const act = menuAction(text);
    // Текст от кнопки меню приходит только со СТАРОЙ клавиатуры: у новой кнопки
    // открывают мини-приложение сразу и боту ничего не шлют. Значит человек
    // сидит на прошлой раскладке — тихо подменяем её на актуальную, чтобы
    // следующее нажатие открывало раздел в один тап.
    if (act) await refreshMenu(chatId, lang, from).catch(() => {});
    if (act === 'menu') return sendMain(chatId, lang, from);
    if (act === 'pay') return sendPaymentEntry(chatId, from, lang);
    if (act === 'contact') {
      openContactSession(chatId, lang);
      return sendMessage(chatId, t(lang, 'contact_prompt'), { reply_markup: contactOpenKeyboard(lang) });
    }
    // Разделы с проверкой состава открываем через общий шорткат — он сам
    // объяснит, если человек ещё не в составе.
    if (act === 'matches') return sendMatchShortcut(chatId, lang, from, 'open');
    if (act === 'result') return sendMatchShortcut(chatId, lang, from, 'res');
    if (act === 'court') return sendMatchShortcut(chatId, lang, from, 'book');
    // Открытые разделы: одно короткое сообщение с inline-кнопкой запуска.
    if (act === 'league') return sendOpenApp(chatId, lang, 'league');
    if (act === 'squad') return sendOpenApp(chatId, lang, 'squad');
    if (act === 'apply') return sendOpenApp(chatId, lang, 'apply');
  }

  const state = userState.get(String(chatId));
  if (state?.mode === 'selfie_upload') {
    if (!msg.photo?.length) return sendMessage(chatId, t(lang, 'selfie_prompt'));
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await updateApplicantByTelegramId(from.id, { selfie_status:'received', selfie_file_id:fileId, selfie_received_at:nowISO() });
    userState.delete(String(chatId));
    await notifyAboutPlayer(from.id, `<b>📸 Selfie received</b>\n\nTGID: <code>${escapeHtml(from.id)}</code>\nFrom: <b>${escapeHtml(from.first_name || '')}</b> ${from.username ? '@' + escapeHtml(from.username) : ''}`);
    return sendMessage(chatId, t(lang, 'selfie_received'), await menuMarkup(lang, from.id));
  }

  if (state?.mode === 'awaiting_payment_proof') {
    const handled = await handlePaymentProofSubmission(msg, lang, state).catch(e => {
      console.error('payment proof handling failed:', e.message);
      return false;
    });
    if (handled) return null;
    return sendMessage(chatId, t(lang, 'send_proof'));
  }

  // Открытый разговор с организатором важнее любых догадок: картинка в диалоге —
  // это вложение к разговору, а не чек. Раньше платёжная ветка перехватывала её
  // раньше, и у активного игрока статус откатывался в proof_received.
  if (state?.mode === 'contact') return handleContactMessage(msg, state, lang);
  if (state?.mode === 'challenge_chat') return forwardChallengeChat(msg, state);

  // Восстановление после перезапуска: игрок выбрал способ оплаты, бот перезапустился
  // и потерял состояние в памяти. Срабатывает ТОЛЬКО когда оплата реально висит —
  // иначе обычное фото в чате засчитывалось как чек и сбивало статус.
  if (msg.chat.type === 'private' && paymentProofMedia(msg) && await hasPendingPayment(from.id)) {
    const handled = await handlePaymentProofSubmission(msg, lang, null).catch(e => {
      console.error('payment proof recovery failed:', e.message);
      return false;
    });
    if (handled) return null;
  }

  // Чек на пополнение депозита: игрок сам назвал сумму, поэтому распознаётся
  // однозначно и проверяется первым.
  if (isPrivate && paymentProofMedia(msg)) {
    const proof = paymentProofMedia(msg);
    const { handleTopupProof } = await import('./eventflow.js');
    const topupAdmin = await getAdminChatId().catch(() => '');
    const done = await handleTopupProof({
      telegramId: from.id, name: contactName(from), lang,
      fileId: proof.fileId, fileType: proof.type, chatId, adminChatId: topupAdmin
    }).catch(e => { console.error('topup proof failed:', e.message); return false; });
    if (done) return null;
  }

  // Чек за участие в событии. Стоит ПОСЛЕ платёжной ветки лиги и срабатывает
  // только когда у игрока висит неоплаченный счёт за событие — поэтому приём
  // скриншотов для лиги эта развилка не задевает.
  if (isPrivate && paymentProofMedia(msg)) {
    const proof = paymentProofMedia(msg);
    const { handleEventProof } = await import('./eventflow.js');
    const evAdminChat = await getAdminChatId().catch(() => '');
    const taken = await handleEventProof({
      telegramId: from.id, lang, fileId: proof.fileId, fileType: proof.type, chatId, adminChatId: evAdminChat
    }).catch(e => { console.error('event proof failed:', e.message); return false; });
    if (taken) return null;
  }

  // Catch-all: media sent in a private chat outside any flow must still reach the player's admin topic.
  if (isPrivate && paymentProofMedia(msg)) {
    const type = messageType(msg);
    await logMessage({ message_id:uid('msg'), telegram_id:from.id, telegram_username:from.username || '', name:contactName(from), direction:'incoming', message_type:type, message_text:msg.caption || '[media]', timestamp:nowISO(), status:'new', telegram_message_id:msg.message_id }).catch(e => console.error('log media failed:', e.message));
    await notifyPlayerMedia({ id:from.id, username:from.username, name:contactName(from) }, msg, 'Sent outside payment/contact flow').catch(e => console.error('notify player media failed:', e.message));
    return sendMessage(chatId, lang === 'ru' ? '✅ Файл получен и передан организатору.' : '✅ File received and forwarded to the organizer.', await menuMarkup(lang, from.id));
  }
  // В группе главное меню не показываем: оно личное, и вываливать его при
  // каждом сообщении в общем чате — шум для всех остальных.
  if (!isPrivate) return null;
  return sendMain(chatId, lang, from);
}

// Что считается личным экраном: главное меню, тексты, оплата, связь, язык,
// настройки ленты результатов. Админские (admin_*, bc*) и матчевые кнопки
// сюда не входят — им место в группе по замыслу.
const PERSONAL_CALLBACKS = new Set(['main', 'website_menu', 'payment_entry', 'contact', 'close_contact', 'results_mute', 'results_unmute']);
const PERSONAL_PREFIXES = ['text:', 'lang_select:', 'pay:', 'crypto:', 'paylater:', 'payment_menu:'];
function isPersonalCallback(data = '') {
  const d = String(data);
  return PERSONAL_CALLBACKS.has(d) || PERSONAL_PREFIXES.some(p => d.startsWith(p));
}

export async function handleCallback(q) {
  const data = q.data || '';
  const msg = q.message;
  const chatId = msg.chat.id;
  const from = q.from || {};
  const storedLang = await userLang(from);
  const lang = fallbackLang(storedLang);

  // Личные экраны — только в личке. Если игрок нажал кнопку на сообщении бота
  // в общем чате (лига, админская группа), его меню, оплата и переписка не
  // должны вываливаться туда у всех на виду. Отвечаем всплывающей подсказкой.
  const inGroup = ['group', 'supergroup', 'channel'].includes(String(msg.chat.type || ''));
  if (inGroup && isPersonalCallback(data)) {
    return answerCallbackQuery(q.id, lang === 'ru'
      ? 'Это личный раздел — откройте его в чате с ботом.'
      : 'This is a personal section — open it in your chat with the bot.', true).catch(() => {});
  }
  await answerCallbackQuery(q.id).catch(() => {});

  if (data.startsWith('lang_select:')) {
    const selected = data.split(':')[1] === 'ru' ? 'ru' : 'en';
    const state = userState.get(String(chatId));
    await setUserLanguage(from, selected);
    userState.delete(String(chatId));
    await sendMessage(chatId, t(selected, 'language_saved'));
    const param = state?.pendingStartParam || '';
    if (param.startsWith('challenge_')) return handleChallengeStart(chatId, from, selected, param.replace('challenge_', ''));
    return sendMain(chatId, selected, from);
  }

  if (!storedLang && msg.chat.type === 'private' && !isAdminUser(from.id)) {
    return sendLanguageChoice(chatId);
  }

  // Аватарка: выбор варианта и запрос ещё одного. Действует сам игрок.
  if (data.startsWith('avpick:')) {
    const res = await pickAvatarVariant(from.id, data.split(':')[1]);
    return sendMessage(chatId, res.ok
      ? `✅ Вариант ${res.index} выбран — он уже стоит в твоём профиле лиги.`
      : `Не получилось: ${res.error}`);
  }
  if (data === 'avmore') {
    const { requestAnotherAvatar } = await import('./avatars.js');
    const res = await requestAnotherAvatar(from.id);
    return sendMessage(chatId, res.ok
      ? '🔄 Делаю ещё вариант — пришлю через минуту.'
      : res.error);
  }
  if (data === 'main') return sendMain(chatId, lang, from);
  // Раздел «О PTF» убран — старые сообщения с этой кнопкой ведут в главное меню.
  if (data === 'website_menu') return sendMain(chatId, lang, from);
  if (data.startsWith('text:')) return sendTextSection(chatId, lang, data.slice(5), msg.message_id);
  if (data === 'payment_entry') return sendPaymentEntry(chatId, from, lang);
  if (data === 'contact') {
    openContactSession(chatId, lang);
    return sendMessage(chatId, t(lang, 'contact_prompt'), { reply_markup: contactOpenKeyboard(lang) });
  }
  if (data === 'close_contact') {
    closeContactSession(chatId);
    return sendMessage(chatId, t(lang, 'contact_closed'), await menuMarkup(lang, from.id));
  }
  if (data === 'upload_selfie') {
    userState.set(String(chatId), { mode:'selfie_upload' });
    return sendMessage(chatId, t(lang, 'selfie_prompt'));
  }
  if (data.startsWith('payment_menu:')) return handlePaymentMenu(chatId, lang, data.split(':')[1]);
  if (data.startsWith('crypto:')) {
    const methods = await getPaymentMethods().catch(() => []);
    return sendMessage(chatId, t(lang, 'choose_crypto_network'), { reply_markup: cryptoKeyboard(lang, data.split(':')[1], methods) });
  }
  if (data.startsWith('paylater:')) return sendMessage(chatId, t(lang, 'payment_later'), await menuMarkup(lang, from.id));
  if (data.startsWith('pay:')) {
    const [, applicationId, methodId] = data.split(':');
    return sendPaymentInstructions(chatId, lang, applicationId, methodId);
  }
  // Подтверждение предложенных даты/корта — матч назначен.
  if (data.startsWith('match_ok:')) {
    const r = await acceptProposal(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
    if (!r.ok) {
      const ru = lang === 'ru';
      const texts = { already_accepted: ru ? 'Матч уже подтверждён.' : 'Already confirmed.',
        not_pending: ru ? 'Предложение больше неактуально.' : 'No longer pending.',
        not_your_turn: ru ? 'Сейчас ход соперника.' : 'It is your opponent\'s turn.',
        not_found: ru ? 'Заявка не найдена.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || 'Unavailable', true).catch(() => {});
    }
    await notifyMatchAgreed(r.slot).catch(e => console.error('notifyMatchAgreed failed:', e.message));
    return null;
  }
  // Отказ: для открытого окна оно снова свободно, для адресного вызова — закрыт.
  if (data.startsWith('match_no:')) {
    const r = await rejectProposal(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
    if (!r.ok) return answerCallbackQuery(q.id, lang === 'ru' ? 'Уже неактуально.' : 'No longer pending.', true).catch(() => {});
    await notifyProposalRejected(r.slot, r.previous).catch(e => console.error('notifyProposalRejected failed:', e.message));
    return sendMessage(chatId, lang === 'ru' ? 'Предложение отклонено.' : 'Proposal declined.').catch(() => {});
  }
  // Подготовка сообщения для брони корта в WhatsApp.
  if (data.startsWith('match_book:')) {
    const slot = await findMatchSlot(data.split(':')[1]);
    if (!slot) return null;
    if (![String(slot.from_telegram_id), String(slot.to_telegram_id)].includes(String(from.id))) return null;
    return sendBookingHelper(chatId, slot).catch(e => console.error('sendBookingHelper failed:', e.message));
  }

  // Соперник подтверждает счёт — только теперь результат идёт в таблицы лиги.
  if (data.startsWith('res_ok:')) {
    const r = await confirmResult(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
    if (!r.ok) {
      const ru = lang === 'ru';
      const texts = { not_pending: ru ? 'Результат уже обработан.' : 'Already processed.',
        own_result: ru ? 'Подтверждает соперник, а не тот, кто вносил счёт.' : 'The opponent confirms, not the submitter.',
        not_a_player: ru ? 'Вы не участник этого матча.' : 'Not your match.',
        not_found: ru ? 'Матч не найден.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || 'Unavailable', true).catch(() => {});
    }
    const write = await writeConfirmedResult(r.slot).catch(e => ({ status:'error', reason:e.message }));
    // Междивизионный матч в зачёт не идёт: счёт никуда не записан, решает организатор.
    // Игрокам про это не пишем — для них матч просто ждёт проверки.
    if (write.status === 'cross_division_blocked') {
      await notifyCrossDivision(r.slot, write).catch(e => console.error('notifyCrossDivision failed:', e.message));
      const ru = lang === 'ru';
      return sendMessage(chatId, ru
        ? 'Счёт принят и отправлен организатору на проверку: соперники из разных дивизионов.'
        : 'Score accepted and sent to the organiser: the players are in different divisions.').catch(() => {});
    }
    // Счёт ушёл в таблицы лиги — витрина должна показать новые цифры сразу.
    invalidateLeagueCache();
    invalidateDivisionCache();
    await notifyResultConfirmed(r.slot, describeWrite(write)).catch(e => console.error('notifyResultConfirmed failed:', e.message));
    // Лента лиги: общая группа + личная рассылка активным игрокам.
    broadcastResult(r.slot).catch(e => console.error('broadcastResult failed:', e.message));
    return null;
  }
  if (data.startsWith('res_no:')) {
    const r = await disputeResult(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
    if (!r.ok) return answerCallbackQuery(q.id, lang === 'ru' ? 'Уже обработано.' : 'Already processed.', true).catch(() => {});
    await notifyResultDisputed(r.previous).catch(e => console.error('notifyResultDisputed failed:', e.message));
    return sendMessage(chatId, lang === 'ru'
      ? 'Понял. Договоритесь с соперником и внесите согласованный счёт.'
      : 'Got it. Agree with your opponent and submit the corrected score.').catch(() => {});
  }

  // Площадка подтвердила бронь — матч активен для обоих игроков.
  if (data.startsWith('match_court_ok:')) {
    const r = await confirmCourt(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
    if (!r.ok) {
      const ru = lang === 'ru';
      const texts = { already_confirmed: ru ? 'Корт уже подтверждён.' : 'Already confirmed.',
        not_accepted: ru ? 'Матч ещё не согласован.' : 'Match is not agreed yet.',
        not_a_player: ru ? 'Вы не участник этого матча.' : 'Not your match.',
        not_found: ru ? 'Матч не найден.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || 'Unavailable', true).catch(() => {});
    }
    await notifyCourtConfirmed(r.slot).catch(e => console.error('notifyCourtConfirmed failed:', e.message));
    return null;
  }

  // Отписка от ленты результатов и возврат обратно.
  // Отключаются ТОЛЬКО результаты чужих матчей: всё, что касается самого игрока,
  // продолжает приходить — иначе люди пропустят свои же вызовы и оплату.
  if (data === 'results_mute' || data === 'results_unmute') {
    const mute = data === 'results_mute';
    await setResultsOptOut(from.id, mute).catch(e => console.error('setResultsOptOut failed:', e.message));
    await answerCallbackQuery(q.id, mute ? 'Результаты отключены' : 'Результаты включены').catch(() => {});
    return sendResultsSettings(chatId, lang, from.id, mute ? 'just_muted' : 'just_unmuted');
  }

  // Перенос времени на том же корте: площадка дала соседний слот.
  // Меняет тот, кто бронирует; применяется после «Подходит» от соперника.
  if (data.startsWith('match_retime:')) {
    const slot = await findMatchSlot(data.split(':')[1]);
    if (!slot) return answerCallbackQuery(q.id, lang === 'ru' ? 'Матч не найден.' : 'Not found.', true).catch(() => {});
    if (![String(slot.from_telegram_id), String(slot.to_telegram_id)].includes(String(from.id))) return null;
    if (slot.court_confirmed_by && String(slot.court_confirmed_by) !== String(from.id)) {
      return answerCallbackQuery(q.id, lang === 'ru' ? 'Время меняет тот, кто бронировал корт.' : 'Only the player who booked can change the time.', true).catch(() => {});
    }
    return sendMessage(chatId, timeChoiceText(slot), { reply_markup: timeChoiceKeyboard(slot) }).catch(() => {});
  }
  if (data.startsWith('mt_set:')) {
    const [, id, ...rest] = data.split(':');
    const newTime = rest.join(':');
    const r = await proposeTimeChange(id, { telegram_id: from.id, name: from.first_name || '' }, newTime);
    if (!r.ok) {
      const ru = lang === 'ru';
      const texts = { not_booker: ru ? 'Время меняет тот, кто бронировал корт.' : 'Only the booker can change the time.',
        not_accepted: ru ? 'Матч ещё не согласован.' : 'Match is not agreed yet.',
        same_time: ru ? 'Это и есть текущее время.' : 'That is the current time.',
        bad_time: ru ? 'Некорректное время.' : 'Bad time.',
        not_a_player: ru ? 'Вы не участник этого матча.' : 'Not your match.',
        not_found: ru ? 'Матч не найден.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || 'Unavailable', true).catch(() => {});
    }
    await notifyTimeChange(r.slot, newTime, from.id);
    return sendMessage(chatId, lang === 'ru'
      ? `🕐 Отправил сопернику новое время: <b>${escapeHtml(newTime)}</b>. Как только он подтвердит, оно станет основным.`
      : `🕐 Sent the new time to your opponent: <b>${escapeHtml(newTime)}</b>. It becomes final once they confirm.`).catch(() => {});
  }
  if (data.startsWith('mt_ok:')) {
    const [, id, ...rest] = data.split(':');
    const r = await acceptTimeChange(id, { telegram_id: from.id, name: from.first_name || '' }, rest.join(':'));
    if (!r.ok) {
      const ru = lang === 'ru';
      const texts = { stale: ru ? 'Это предложение уже неактуально.' : 'This proposal is no longer current.',
        own_proposal: ru ? 'Подтверждает соперник.' : 'The opponent confirms.',
        not_a_player: ru ? 'Вы не участник этого матча.' : 'Not your match.',
        not_found: ru ? 'Матч не найден.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || 'Unavailable', true).catch(() => {});
    }
    await notifyTimeChangeAccepted(r.slot, r.previousTime).catch(e => console.error('notifyTimeChangeAccepted failed:', e.message));
    return null;
  }
  if (data.startsWith('mt_no:')) {
    const [, id, ...rest] = data.split(':');
    const time = rest.join(':');
    const r = await rejectTimeChange(id, { telegram_id: from.id, name: from.first_name || '' }, time);
    if (!r.ok) return answerCallbackQuery(q.id, lang === 'ru' ? 'Уже неактуально.' : 'No longer current.', true).catch(() => {});
    const proposer = String(r.slot.from_telegram_id) === String(from.id) ? r.slot.to_telegram_id : r.slot.from_telegram_id;
    await notifyTimeChangeRejected(r.slot, r.rejectedTime || time, proposer).catch(() => {});
    return sendMessage(chatId, lang === 'ru'
      ? 'Понял, время осталось прежним. Сообщил сопернику.'
      : 'Got it — the time stays as it was. Your opponent has been told.').catch(() => {});
  }

  if (data.startsWith('match_decline:')) {
    const slot = await findMatchSlot(data.split(':')[1]);
    if (!slot) return null;
    if (String(slot.to_telegram_id) !== String(from.id)) return null;
    await declineDirectChallenge(slot, { telegram_id: from.id, name: from.first_name || '' }).catch(e => console.error('declineDirectChallenge failed:', e.message));
    return sendMessage(chatId, lang === 'ru' ? 'Вызов отклонён.' : 'Challenge declined.').catch(() => {});
  }

  // События: запись, оплата с депозита, отмена. Кнопки видит любой игрок.
  if (data.startsWith('ev_take:') || data.startsWith('ev_pass:')) {
    const { takeOffer, passOffer } = await import('./eventflow.js');
    const signupId = data.split(':')[1];
    const evAdmin = await getAdminChatId().catch(() => '');
    return data.startsWith('ev_take:')
      ? takeOffer({ signupId, telegramId: from.id, lang, chatId, adminChatId: evAdmin })
      : passOffer({ signupId, lang, chatId, adminChatId: evAdmin });
  }
  if (data.startsWith('ev_pf:')) {
    const { attachStoredProof } = await import('./eventflow.js');
    return attachStoredProof({
      signupId: data.split(':')[1], telegramId: from.id, lang, chatId,
      adminChatId: await getAdminChatId().catch(() => '')
    });
  }
  if (data.startsWith('ev_join:')) return eventJoin({ chatId, from, lang, eventId: data.split(':')[1] });
  if (data.startsWith('ev_dep:')) return eventPayFromDeposit({ chatId, from, lang, signupId: data.split(':')[1] });
  if (data.startsWith('ev_cxl:')) return eventCancelAsk({ chatId, lang, signupId: data.split(':')[1] });
  if (data.startsWith('ev_cyes:')) return eventCancelDo({ chatId, from, lang, signupId: data.split(':')[1], keepGuests: true });
  if (data.startsWith('ev_cno:')) return eventCancelDo({ chatId, from, lang, signupId: data.split(':')[1], keepGuests: false });
  if (data.startsWith('ev_keep:')) return sendMessage(chatId, lang === 'ru' ? '👍 Участие сохранено.' : '👍 Your spot is kept.');

  if (data.startsWith('challenge_accept:')) return acceptChallenge(chatId, from, lang, data.split(':')[1]);
  if (data.startsWith('challenge_decline:')) return declineChallenge(chatId, from, lang, data.split(':')[1]);

  if (isAdminUser(from.id)) {
    if (data.startsWith('admin_reply:')) {
      const targetTelegramId = data.split(':')[1];
      adminState.set(String(from.id), { mode:'reply_waiting', targetTelegramId });
      return sendMessage(chatId, `Write reply to TGID <code>${escapeHtml(targetTelegramId)}</code>.`);
    }
    // Междивизионный матч: организатор решает, записывать его или нет.
    if (data.startsWith('res_force:')) {
      const slot = await findMatchSlot(data.split(':')[1]);
      if (!slot) return sendMessage(chatId, 'Матч не найден.');
      const write = await writeConfirmedResult(slot, { force: true }).catch(e => ({ status:'error', reason:e.message }));
      invalidateLeagueCache();
      invalidateDivisionCache();
      await notifyResultConfirmed(slot, describeWrite(write)).catch(() => {});
      broadcastResult(slot).catch(e => console.error('broadcastResult failed:', e.message));
      return sendMessage(chatId, `Записал: <i>${escapeHtml(describeWrite(write))}</i>`);
    }
    if (data.startsWith('res_drop:')) {
      const r = await rejectResultByAdmin(data.split(':')[1], { telegram_id: from.id, name: from.first_name || '' });
      if (!r.ok) return sendMessage(chatId, 'Матч не найден.');
      await notifyResultRejected(r.slot).catch(() => {});
      return sendMessage(chatId, 'Результат отклонён, игрокам сообщил.');
    }
    // Организатор смотрит чек на пополнение депозита.
    if (data.startsWith('ev_tok:') || data.startsWith('ev_tno:')) {
      const { reviewTopup } = await import('./eventflow.js');
      const parts = data.split(':');
      const target = parts[1];
      const player = await findApplicantByTelegramId(target).catch(() => null);
      const r = await reviewTopup({
        telegramId: target, amount: parts[2] || 0, approve: data.startsWith('ev_tok:'),
        name: player?.name || '', adminChatId: await getAdminChatId().catch(() => '')
      });
      return sendMessage(chatId, r.message);
    }
    // Организатор смотрит чек за событие.
    if (data.startsWith('ev_pok:') || data.startsWith('ev_pno:')) {
      const { reviewEventProof } = await import('./eventflow.js');
      const r = await reviewEventProof({
        signupId: data.split(':')[1],
        approve: data.startsWith('ev_pok:'),
        adminChatId: await getAdminChatId().catch(() => '')
      });
      return sendMessage(chatId, r.message);
    }
    // Правка состава события: организатор решает, что делать с оплатой и возвратом.
    if (data.startsWith('evadd:')) {
      const [, eventId, telegramId, mode] = data.split(':');
      return eventAddDo(chatId, eventId, telegramId, mode);
    }
    if (data.startsWith('evrm:')) {
      const [, signupId, mode] = data.split(':');
      return eventRemoveDo(chatId, signupId, mode);
    }
    if (data.startsWith('ev_nudge:')) {
      const { remindUnregistered } = await import('./eventflow.js');
      return remindUnregistered(chatId, data.split(':')[1]);
    }
    if (data.startsWith('ev_pub:')) return eventPublish(chatId, data.split(':')[1]);
    if (data.startsWith('ev_drop:')) return eventDrop(chatId, data.split(':')[1]);
    if (data.startsWith('evdel:')) {
      const [, eventId, mode] = data.split(':');
      return eventDeleteDo(chatId, eventId, mode);
    }
    if (data.startsWith('ev_pv:')) return eventPreview(chatId, data.split(':')[1]);
    if (data.startsWith('ev_edit:')) return sendMessage(chatId, 'Открой админ-панель и поправь карточку — потом нажми «Предпросмотр» ещё раз.');
    // Подтверждение участия руками: работает и без топика, и без заявки.
    if (data.startsWith('admin_activate:')) return activatePlayer({ chatId, telegramId: data.split(':')[1] });
    if (data.startsWith('admin_wait:')) return waitlistPlayer({ chatId, telegramId: data.split(':')[1] });
    if (data.startsWith('admin_invoice:')) {
      const applicationId = data.split(':')[1];
      return sendInvoiceToApplicant({ chatId, applicationId });
    }
    if (data.startsWith('admin_status:')) {
      const [, applicationId, status] = data.split(':');
      return setApplicationStatus({ chatId, applicationId, status });
    }
    if (data.startsWith('admin_attach_pay:')) {
      const telegramId = data.split(':')[1];
      return attachMediaToPayment({ chatId, telegramId });
    }
    if (data.startsWith('admin_payment:')) {
      // Новый формат admin_payment:<заявка>:<решение>; старые кнопки из истории
      // приходят в виде admin_payment:<заявка>:<платёж>:<решение> — принимаем оба.
      const parts = data.split(':');
      const applicationId = parts[1] || '';
      const status = parts[parts.length - 1] || '';
      const paymentId = parts.length > 3 ? parts[2] : '';
      return setPaymentStatus({ chatId, applicationId, paymentId, status });
    }
    if (data.startsWith('bcseg:')) return handleBroadcastSegment(q, data.split(':')[1]);
    if (data === 'bcconfirm') return executeBroadcast(q);
    if (data === 'bcconfirm_menu') return executeBroadcastWithMenu(q);
    if (data === 'bcconfirm_poll') return executeBroadcastPoll(q);
    if (data === 'bcconfirm_missing_rating') return executeMissingRatingBroadcast(q);
    if (data === 'bcconfirm_rating_recheck') return executeMissingRatingBroadcast(q, 'recheck');
    if (data === 'bccancel') {
      adminState.delete(String(from.id));
      return sendMessage(chatId, 'Broadcast cancelled.');
    }
  }
}

export async function sendPaymentStart(chatId, lang, applicationId) {
  const app = await findApplication(applicationId).catch(() => null);
  const amounts = app ? await paymentAmountsForApplication(app) : { amountThb:'', amountUsdt:'' };
  await sendMessage(chatId, `${t(lang,'application_received')}${formatPaymentAmounts(lang, amounts.amountThb, amounts.amountUsdt)}`, { reply_markup: paymentKeyboard(lang, applicationId) });
}
