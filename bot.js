import { sendMessage, editMessageText, answerCallbackQuery, copyMessage, setChatCommands, PLAYER_COMMANDS, MATCH_COMMANDS, ADMIN_COMMANDS } from './telegram.js';
import { mainKeyboard, textKeyboard, paymentKeyboard, cryptoKeyboard, contactOpenKeyboard, paymentEntryKeyboard, websiteKeyboard, challengeKeyboard, directChatKeyboard, adminPanelKeyboard, languageKeyboard } from './keyboards.js';
import { getBotText, getSetting, setSetting, getActiveEvents, getPaymentMethods, findApplication, updateApplication, logMessage, logPayment, updateApplicantStatusByTelegramId, findApplicantByTelegramId, findApplicantByAdminTopicId, isProfileCompleted, createMatchChallenge, updateMatchChallenge, updateApplicantByTelegramId, findLatestPayableApplicationByTelegramId, findLatestApplicationByTelegramId, setUserLanguage, getManualParticipants, isActiveLeaguePlayer, setResultsOptOut, isResultsMutedFor } from './sheets.js';
import { t, tt } from './i18n.js';
import { nowISO, uid, escapeHtml } from './util.js';
import { DEFAULT_USDT_AMOUNT, PUBLIC_URL } from './config.js';
import { findSlot as findMatchSlot, acceptProposal, rejectProposal, confirmCourt, confirmResult, disputeResult, proposeTimeChange, acceptTimeChange, rejectTimeChange } from './matchesdb.js';
import { declineDirectChallenge, notifyMatchAgreed, notifyProposalRejected, sendBookingHelper, notifyCourtConfirmed,
  notifyResultConfirmed, notifyResultDisputed, broadcastResult,
  timeChoiceKeyboard, timeChoiceText, notifyTimeChange, notifyTimeChangeAccepted, notifyTimeChangeRejected } from './matches.js';
import { writeConfirmedResult, describeWrite } from './results.js';
import { notifyIncomingMessage, notifyPaymentProof, notifyPlayerMedia, adminTopicTest, adminMatchTest, adminMatchesOverview, notifyAdmin, isAdminUser, handleAdminInit, adminStats, adminEvents, adminPending, adminMessages, adminProfile, startBroadcast, startBroadcastWithMenu, handleBroadcastMessage, handleBroadcastMenuMessage, handleBroadcastSegment, executeBroadcast, executeBroadcastWithMenu, startBroadcastPoll, handleBroadcastPollMessage, executeBroadcastPoll, adminPollStats, startMissingRatingBroadcast, executeMissingRatingBroadcast, adminState, setApplicationStatus, setPaymentStatus } from './admin.js';

export const userState = new Map();
async function userLang(from) {
  const saved = await findApplicantByTelegramId(from.id).catch(() => null);
  return ['ru','en'].includes(String(saved?.language || '').toLowerCase()) ? String(saved.language).toLowerCase() : null;
}
function fallbackLang(lang) { return lang === 'ru' ? 'ru' : 'en'; }
async function sendLanguageChoice(chatId) {
  return sendMessage(chatId, t('en','choose_language'), { reply_markup: languageKeyboard() });
}
async function sendMain(chatId, lang, from=null) {
  closeContactSession(chatId); userState.delete(String(chatId));
  const l=fallbackLang(lang);
  const txt=await getBotText('welcome_main',l);
  // Кнопка матчей показывается только активным игрокам состава — остальным она
  // всё равно ничего не откроет, а в меню создаёт лишний шум.
  let showMatches=false;
  try {
    const profile = await findApplicantByTelegramId(from?.id ?? chatId);
    if (profile) showMatches = await isActiveLeaguePlayer({ ...profile, id: from?.id ?? chatId });
  } catch(e) { console.error('main menu league check failed:', e.message); }
  await syncUserCommands(chatId, l, { active: showMatches, admin: isAdminUser(from?.id ?? chatId) });
  await sendMessage(chatId, txt?.html_text || '<b>Welcome to Phuket Tennis Family</b> 🎾', {reply_markup:mainKeyboard(l,{matches:showMatches})});
}

// Подсказка команд в личке. Общий список короткий; команды матчей добавляются
// персонально тем, кто в активном составе, админу — полный админский список.
// Кэш сигнатуры, чтобы не дёргать Telegram на каждое /start.
const commandSignature = new Map();
async function syncUserCommands(chatId, lang, { active=false, admin=false } = {}) {
  const l = lang === 'ru' ? 'ru' : 'en';
  const sig = `${admin ? 'admin' : (active ? 'match' : 'base')}:${l}`;
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
      { reply_markup: mainKeyboard(l) });
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
  return [
    '<b>PTF — команды организатора</b>',
    '',
    '<b>Лига</b>',
    '/overview — сводка: назначенные матчи, где не подтверждён корт, кто не ответил, где нет счёта, открытые окна',
    '/stats — заявки, оплаты, статусы',
    '/pending — заявки, ждущие проверки оплаты',
    '/events — активные события',
    '/messages — последние сообщения от игроков',
    '',
    '<b>Панель и рассылки</b>',
    '/admin — админ-панель: игроки, фильтры, рассылки, опросы и их статистика',
    '',
    '<b>Настройка</b>',
    '/admin_init — привязать текущий чат как админский (один раз, в нужной группе)',
    '/results_here — привязать ленту результатов к текущей теме',
    '/match_test — проверка таблиц матчей и таблиц лиги',
    '/topic_test — проверка вебхука и топиков игроков',
    '/profile telegram_id — карточка игрока',
    '',
    '<b>Прочее</b>',
    '/menu, /cancel, /help',
    '',
    '<i>Команды игрока (/match, /result, /book, /results) у вас тоже работают.</i>',
    '<i>Ответ игроку: Reply под его сообщением в топике.</i>'
  ].join('\n');
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

function siteUrls(settings={}) { const home=settings.website_url || 'https://www.phukettennis.com/'; const base=home.replace(/\/$/,''); return {home, matches:settings.website_matches||`${base}/matches`, divisions:settings.website_divisions||`${base}/divisions`, yearlyRace:settings.website_yearly_race||`${base}/yearly-race`, players:settings.website_players||`${base}/players`, regulations:settings.website_regulations||`${base}/regulations`}; }

// Ссылка на страницу конкретного дивизиона строится по шаблону из Settings —
// так адрес правится в таблице без деплоя, когда на сайте меняется маршрут или сезон.
// {division} — «Division A», {letter} — «A», {season} — номер сезона из Settings.
function divisionUrl(template, base, division, season) {
  const letter = String(division || '').replace(/^(Division|Дивизион)\s*/i, '').trim();
  const tpl = template || `${base}/divisions?division={division}`;
  return tpl
    .replace(/\{division\}/g, encodeURIComponent(division || ''))
    .replace(/\{letter\}/g, encodeURIComponent(letter))
    .replace(/\{slug\}/g, encodeURIComponent(String(division || '').toLowerCase().replace(/\s+/g, '-')))
    .replace(/\{season\}/g, encodeURIComponent(season || ''));
}
async function sendWebsiteMenu(chatId, lang, editMsgId=null) {
  const settings={website_url: await getSetting('website_url') || 'https://www.phukettennis.com/', website_matches: await getSetting('website_matches'), website_divisions: await getSetting('website_divisions'), website_yearly_race: await getSetting('website_yearly_race'), website_players: await getSetting('website_players')};
  const urls=siteUrls(settings);
  const txt=await getBotText('website_button',lang);
  const body=txt?.html_text || (lang==='ru'?'<b>ℹ️ О PTF</b>\n\nЗдесь собрана главная информация о лиге: составы дивизионов текущего сезона, матчи, годовая гонка и игроки.':'<b>ℹ️ About PTF</b>\n\nMain league info: current-season division standings, matches, Yearly Race and players.');
  // Дивизионы берём из таблицы участников — в меню ровно те, что есть в этом сезоне.
  let divisions=[];
  try { const data=await getManualParticipants(); divisions=(data.groups||[]).filter(g=>g.division&&!g.unassigned).map(g=>g.division); } catch(e) { console.error('divisions for menu failed:', e.message); }
  const template=await getSetting('website_division_url_template');
  const season=await getSetting('season_number');
  const divisionLinks=divisions.map(d=>({ text:(lang==='ru'?d.replace(/^Division\s+/,'Дивизион '):d), url:divisionUrl(template, urls.home.replace(/\/$/,''), d, season) }));
  const opts={reply_markup:websiteKeyboard(lang,urls,divisionLinks)};
  if(editMsgId) await editMessageText(chatId,editMsgId,body,opts); else await sendMessage(chatId,body,opts);
}
async function sendTextSection(chatId, lang, key, editMsgId=null) { const txt=await getBotText(key,lang); const body=txt?.html_text || `<b>${escapeHtml(key)}</b>`; let opts={reply_markup:textKeyboard(lang,key)}; if(key==='yearly_race'){ const ratingUrl=await getSetting('website_yearly_race') || (await getSetting('website_url') || 'https://phukettennis.com/').replace(/\/$/,'') + '/yearly-race'; opts={reply_markup:{inline_keyboard:[[{text:lang==='ru'?'📊 Посмотреть рейтинг':'📊 View Ranking',url:ratingUrl}],[{text:t(lang,'how'),callback_data:'text:how_league_works'}],[{text:t(lang,'back'),callback_data:'main'}]]}}; } if(editMsgId) await editMessageText(chatId,editMsgId,body,opts); else await sendMessage(chatId,body,opts); }
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

${t(lang,'payment_active')}`, { reply_markup: mainKeyboard(lang) });
  if (pStatus === 'approved' || aStatus === 'payment_approved') return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_already_paid')}`, { reply_markup: mainKeyboard(lang) });
  if (pStatus === 'proof_received' || aStatus === 'proof_received') return sendMessage(chatId, `${t(lang,'payment_section')}

${t(lang,'payment_already_proof')}`, { reply_markup: mainKeyboard(lang) });
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
    return sendMain(chatId, lang, from);
  }

  if (text === '/language' && isPrivate) return sendLanguageChoice(chatId);

  if (!storedLang && isPrivate && !isAdminUser(from.id)) {
    return sendLanguageChoice(chatId);
  }

  // Быстрые команды вместо похода через /start и меню.
  if (text === '/menu' && isPrivate) return sendMain(chatId, lang, from);
  if (text === '/results' && isPrivate) return sendResultsSettings(chatId, lang, from.id);
  if (text === '/match' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'open');
  if (text === '/result' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'res');
  if (text === '/book' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'book');

  if (text === '/help') return sendHelp(chatId, lang, from, msg);

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
    if (text === '/topic_test') return adminTopicTest(msg);
    if (text === '/match_test') return adminMatchTest(msg);
    if (text === '/overview' || text === '/matches') return adminMatchesOverview(msg);
    // Выполняется прямо в той группе и теме, куда должны падать результаты.
    if (text === '/results_here') {
      await setSetting('results_chat_id', String(msg.chat.id), 'Группа для ленты результатов матчей');
      await setSetting('results_topic_id', String(msg.message_thread_id || ''), 'Тема для ленты результатов матчей');
      return sendMessage(chatId, `✅ Лента результатов привязана.\n\nchat_id: <code>${escapeHtml(msg.chat.id)}</code>${msg.message_thread_id ? `\ntopic: <code>${escapeHtml(msg.message_thread_id)}</code>` : ''}`, msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
    }
    if (text === '/events') return adminEvents(chatId);
    if (text === '/pending') return adminPending(chatId);
    if (text === '/messages') return adminMessages(chatId);
    if (text.startsWith('/profile')) return adminProfile(chatId, text);

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

  const state = userState.get(String(chatId));
  if (state?.mode === 'selfie_upload') {
    if (!msg.photo?.length) return sendMessage(chatId, t(lang, 'selfie_prompt'));
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await updateApplicantByTelegramId(from.id, { selfie_status:'received', selfie_file_id:fileId, selfie_received_at:nowISO() });
    userState.delete(String(chatId));
    await notifyAdmin(`<b>📸 Selfie received</b>\n\nTGID: <code>${escapeHtml(from.id)}</code>\nFrom: <b>${escapeHtml(from.first_name || '')}</b> ${from.username ? '@' + escapeHtml(from.username) : ''}`);
    return sendMessage(chatId, t(lang, 'selfie_received'), { reply_markup: mainKeyboard(lang) });
  }

  if (state?.mode === 'awaiting_payment_proof') {
    const handled = await handlePaymentProofSubmission(msg, lang, state).catch(e => {
      console.error('payment proof handling failed:', e.message);
      return false;
    });
    if (handled) return null;
    return sendMessage(chatId, t(lang, 'send_proof'));
  }

  // If the bot was restarted after the player selected a payment method, in-memory state can be lost.
  // Keep payment proof recovery before contact/chat fallback: this was the last confirmed
  // working path for screenshots sent after choosing a payment method. Do not refactor it.
  if (msg.chat.type === 'private' && paymentProofMedia(msg)) {
    const handled = await handlePaymentProofSubmission(msg, lang, null).catch(e => {
      console.error('payment proof recovery failed:', e.message);
      return false;
    });
    if (handled) return null;
  }

  if (state?.mode === 'contact') return handleContactMessage(msg, state, lang);
  if (state?.mode === 'challenge_chat') return forwardChallengeChat(msg, state);

  // Catch-all: media sent in a private chat outside any flow must still reach the player's admin topic.
  if (isPrivate && paymentProofMedia(msg)) {
    const type = messageType(msg);
    await logMessage({ message_id:uid('msg'), telegram_id:from.id, telegram_username:from.username || '', name:contactName(from), direction:'incoming', message_type:type, message_text:msg.caption || '[media]', timestamp:nowISO(), status:'new', telegram_message_id:msg.message_id }).catch(e => console.error('log media failed:', e.message));
    await notifyPlayerMedia({ id:from.id, username:from.username, name:contactName(from) }, msg, 'Sent outside payment/contact flow').catch(e => console.error('notify player media failed:', e.message));
    return sendMessage(chatId, lang === 'ru' ? '✅ Файл получен и передан организатору.' : '✅ File received and forwarded to the organizer.', { reply_markup: mainKeyboard(lang) });
  }
  return sendMain(chatId, lang, from);
}

export async function handleCallback(q) {
  const data = q.data || '';
  const msg = q.message;
  const chatId = msg.chat.id;
  const from = q.from || {};
  const storedLang = await userLang(from);
  const lang = fallbackLang(storedLang);
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

  if (data === 'main') return sendMain(chatId, lang, from);
  if (data === 'website_menu') return sendWebsiteMenu(chatId, lang, msg.message_id);
  if (data.startsWith('text:')) return sendTextSection(chatId, lang, data.slice(5), msg.message_id);
  if (data === 'payment_entry') return sendPaymentEntry(chatId, from, lang);
  if (data === 'contact') {
    openContactSession(chatId, lang);
    return sendMessage(chatId, t(lang, 'contact_prompt'), { reply_markup: contactOpenKeyboard(lang) });
  }
  if (data === 'close_contact') {
    closeContactSession(chatId);
    return sendMessage(chatId, t(lang, 'contact_closed'), { reply_markup: mainKeyboard(lang) });
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
  if (data.startsWith('paylater:')) return sendMessage(chatId, t(lang, 'payment_later'), { reply_markup: mainKeyboard(lang) });
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

  if (data.startsWith('challenge_accept:')) return acceptChallenge(chatId, from, lang, data.split(':')[1]);
  if (data.startsWith('challenge_decline:')) return declineChallenge(chatId, from, lang, data.split(':')[1]);

  if (isAdminUser(from.id)) {
    if (data.startsWith('admin_reply:')) {
      const targetTelegramId = data.split(':')[1];
      adminState.set(String(from.id), { mode:'reply_waiting', targetTelegramId });
      return sendMessage(chatId, `Write reply to TGID <code>${escapeHtml(targetTelegramId)}</code>.`);
    }
    if (data.startsWith('admin_status:')) {
      const [, applicationId, status] = data.split(':');
      return setApplicationStatus({ chatId, applicationId, status });
    }
    if (data.startsWith('admin_payment:')) {
      const [, applicationId, paymentId, status] = data.split(':');
      return setPaymentStatus({ chatId, applicationId, paymentId, status });
    }
    if (data.startsWith('bcseg:')) return handleBroadcastSegment(q, data.split(':')[1]);
    if (data === 'bcconfirm') return executeBroadcast(q);
    if (data === 'bcconfirm_menu') return executeBroadcastWithMenu(q);
    if (data === 'bcconfirm_poll') return executeBroadcastPoll(q);
    if (data === 'bcconfirm_missing_rating') return executeMissingRatingBroadcast(q);
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
