import {allSlots,pendingActionsFor} from './matchesdb.js';
import { sendMessage, editMessageText, answerCallbackQuery, copyMessage, webAppButton, setChatCommands, PLAYER_COMMANDS, MATCH_COMMANDS, ADMIN_COMMANDS, ADMIN_COMMAND_LIST, sendPhotoBuffer, withBulkRetries} from './telegram.js';
import { mainKeyboard, persistentKeyboard, menuAction, MENU_VERSION, textKeyboard, paymentKeyboard, cryptoKeyboard, contactOpenKeyboard, paymentEntryKeyboard, challengeKeyboard, directChatKeyboard, adminPanelKeyboard, languageKeyboard } from './keyboards.js';
import { getBotText, getSetting, setSetting, getActiveEvents, getAllEvents, getPaymentMethods, findApplication, updateApplication, logMessage, logPayment, updateApplicantStatusByTelegramId, findApplicantByTelegramId, findApplicantByAdminTopicId, isProfileCompleted, createMatchChallenge, updateMatchChallenge, updateApplicantByTelegramId, findLatestPayableApplicationByTelegramId, findLatestApplicationByTelegramId, setUserLanguage, getPlayerLeagueInfo, findMatchChallenge, isActiveLeaguePlayer, setResultsOptOut, isResultsMutedFor, invalidateLeagueCache, buttonsFor, keyboardForGroup } from './sheets.js';
import { t, tt } from './i18n.js';
import { findDestination, destinationLabel, linksCheatSheet } from './links.js';
import { nowISO, uid, escapeHtml, parseTestMatchInput, findRosterPlayer, findRosterPair, matchNameKey } from './util.js';
import { canAccessFantasyByTelegramId } from './fantasy.js';
import { DEFAULT_USDT_AMOUNT, PUBLIC_URL } from './config.js';
import { findSlot as findMatchSlot, listMySlots, listResultTasks, awaitingSide, acceptProposal, rejectProposal, cancelMatchmaking, confirmCourt, confirmResult, disputeResult, rejectResultByAdmin, proposeTimeChange, acceptTimeChange, rejectTimeChange, markMatchUnfinished, addMatchUnfinishedEvidence } from './matchesdb.js';
import { declineDirectChallenge, notifyMatchAgreed, notifyMatchCancelled, notifyProposalRejected, sendBookingHelper, notifyCourtConfirmed,
  notifyResultConfirmed, notifyResultDisputed, notifyCrossDivision, notifyResultRejected, notifyMatchUnfinished, broadcastResult,
  timeChoiceKeyboard, timeChoiceText, notifyTimeChange, notifyTimeChangeAccepted, notifyTimeChangeRejected } from './matches.js';
import { writeConfirmedResult, describeWrite, divisionPair, rollbackJournal } from './results.js';
import { invalidateDivisionCache } from './division.js';
import { notifyIncomingMessage, notifyPaymentProof, notifyPlayerMedia, notifyAboutPlayer, adminTopicTest, adminTopicSync, adminTopicBackfill, adminMatchTest, adminMatchesOverview, notifyAdmin, isAdminUser, handleAdminInit, adminStats, adminEvents, adminPending, adminMessages, adminProfile, adminWhois, adminIdCheck, adminPhotoCheck, startBroadcast, startBroadcastWithMenu, handleBroadcastMessage, handleBroadcastMenuMessage, handleBroadcastSegment, executeBroadcast, executeBroadcastWithMenu, sendRatingRequestTo, notifyAvatarVariant, pickAvatarVariant, showAvatarGallery, adminState, setApplicationStatus, setPaymentStatus, attachMediaToPayment, sendInvoiceToApplicant, paymentAutoOn, setPaymentAuto, activatePlayer, waitlistPlayer, eventPreview, eventPublish, eventDrop, eventDeleteDo, eventJoin, eventPayFromDeposit, eventCancelAsk, eventCancelDo, askAddToEvent, askRemoveFromEvent, eventAddDo, eventRemoveDo, getAdminChatId } from './admin.js';

import { sendDoublesTournaments, handlePairStart, handlePairCallback, isPairCallback } from './pairflow.js';
import { authorizeSlot, sameScope } from './access.js';
import { uiError } from './ui-errors.js';

export const userState = new Map();
const posterRuns = new Map();
const posterJobsInFlight = new Set();
function rememberPosterVariant(matchId, variant, data) {
  const key=String(matchId || '');
  const current=posterRuns.get(key) || {};
  current[String(variant)]=data;
  posterRuns.set(key,current);
  if(posterRuns.size > 30)posterRuns.delete(posterRuns.keys().next().value);
}
// Язык человека меняется раз в жизни, а спрашивали его у таблицы на каждое
// действие. Держим в памяти: ответ мгновенный, а таблица перечитывается только
// когда мы этого человека ещё не видели.
const langMemory = new Map();
function cachedLang(from = {}) { return langMemory.get(String(from.id || '')) || ''; }
export function rememberLang(telegramId, lang) {
  const value = String(lang || '').toLowerCase();
  if (telegramId && ['ru', 'en'].includes(value)) langMemory.set(String(telegramId), value);
}
async function userLang(from) {
  const known = cachedLang(from);
  if (known) return known;
  const saved = await findApplicantByTelegramId(from.id).catch(() => null);
  const value = String(saved?.language || '').toLowerCase();
  if (!['ru', 'en'].includes(value)) return null;
  rememberLang(from.id, value);
  return value;
}
function fallbackLang(lang) { return lang === 'ru' ? 'ru' : 'en'; }

async function preparePosterForAdmin({ chatId, threadId='', slot, comment='', onlyVariant=0 }) {
  const [{
    preparePosterJob,loadPosterSourcePhotos,generatePosterBackgrounds,composeMatchPoster,posterEnabled
  },{ winnerFirstScore }] = await Promise.all([
    import('./matchposter.js'),import('./matches.js')
  ]);
  const matchId=String(slot.challenge_id || slot.match_id || '');
  const lockKey=`${matchId}:${onlyVariant || 'all'}`;
  const opts=threadId?{message_thread_id:threadId}:{};
  if(posterJobsInFlight.has(lockKey)) {
    await sendMessage(chatId,'⏳ Этот вариант уже генерируется. Я пришлю его сюда после завершения.',opts);
    return null;
  }
  posterJobsInFlight.add(lockKey);
  try {
    const season=String(slot.season || await getSetting('season_number').catch(()=>'') || '').trim();
    const job=await preparePosterJob(slot,{winnerFirstScore,season,comment,variants:2});
    if(onlyVariant) {
      job.prompts=job.prompts.filter(x=>Number(x.variant)===Number(onlyVariant));
      job.variants=job.variants.filter(x=>Number(x.variant)===Number(onlyVariant));
    }
    const consent=job.consent.map(x=>{
      const value=x.value==='NO' ? 'NO' : (x.value==='NOT_ANSWERED' ? 'ответа нет — разрешено' : 'YES');
      return `${x.allowed?'✅':'⛔'} ${escapeHtml(x.name)}: <b>${escapeHtml(value)}</b>`;
    }).join('\n');
    if(job.status==='blocked_consent') {
      await sendMessage(chatId,`<b>🎨 Постер матча</b>\n\n⛔ Генерация заблокирована: один из игроков явно ответил NO. Его фотография не передана в OpenAI.\n\n<b>Согласия</b>\n${consent}`,{
        ...opts,
        reply_markup:{inline_keyboard:[[{text:'🔄 Проверить снова',callback_data:`poster:prepare:${matchId}`}]]}
      });
      return job;
    }
    if(!posterEnabled()) {
      await sendMessage(chatId,'⛔ OPENAI_API_KEY не задан. Добавьте переменную и перезапустите сервис.',opts);
      return job;
    }

    const count=job.prompts.length;
    await sendMessage(chatId,`⏳ <b>Генерирую ${count===1?'вариант':'два варианта'}</b>\n\n${escapeHtml(job.match.winner)} — ${escapeHtml(job.match.loser)}\nСчёт: <b>${escapeHtml(job.match.score)}</b>${job.comment?`\nКомментарий: <i>${escapeHtml(job.comment)}</i>`:''}\n\nОбычно это занимает несколько минут. Готовые PNG придут в этот топик.`,opts);

    const photos=await loadPosterSourcePhotos(job);
    const backgrounds=await generatePosterBackgrounds(job,photos);
    const sent=[];
    for(const item of backgrounds) {
      const finalBuffer=await composeMatchPoster(item.buffer,job.match);
      const variant=Number(item.variant || sent.length+1);
      const caption=`<b>🎨 Постер · вариант ${variant}</b>\n\n${escapeHtml(job.match.winner)} — ${escapeHtml(job.match.loser)}\nСчёт: <b>${escapeHtml(job.match.score)}</b>${job.comment?`\nКомментарий: <i>${escapeHtml(job.comment)}</i>`:''}\n\nФайл готов для сохранения из Telegram.`;
      const result=await sendPhotoBuffer(chatId,finalBuffer,'image/png',{
        ...opts,
        caption,
        reply_markup:{inline_keyboard:[
          [{text:`✅ Вариант ${variant} готов`,callback_data:`poster:ready:${variant}:${matchId}`}],
          [
            {text:'🔄 Ещё вариант',callback_data:`poster:regen:${variant}:${matchId}`},
            {text:'✍️ С комментарием',callback_data:`poster:comment:${matchId}`}
          ]
        ]}
      });
      const fileId=(result?.photo || result?.result?.photo || []).slice(-1)[0]?.file_id || '';
      rememberPosterVariant(matchId,variant,{fileId,comment:job.comment,createdAt:new Date().toISOString()});
      sent.push({variant,fileId});
    }
    if(sent.length > 1) {
      await sendMessage(chatId,`✅ Оба варианта готовы. Выберите нужный под изображением или перегенерируйте оба.`,{
        ...opts,
        reply_markup:{inline_keyboard:[
          [{text:'🔄 Новые 2 варианта',callback_data:`poster:prepare:${matchId}`}],
          [{text:'✍️ Новые с комментарием',callback_data:`poster:comment:${matchId}`}]
        ]}
      });
    }
    return {...job,status:'ready',sent};
  } catch(error) {
    console.error('poster generation failed:',matchId,error);
    await sendMessage(chatId,`⛔ <b>Постер не создан</b>\n\n${escapeHtml(error?.message || error)}\n\nМожно повторить запрос или добавить комментарий.`,{
      ...opts,
      reply_markup:{inline_keyboard:[
        [{text:'🔄 Повторить',callback_data:`poster:prepare:${matchId}`}],
        [{text:'✍️ С комментарием',callback_data:`poster:comment:${matchId}`}]
      ]}
    }).catch(()=>{});
    return {status:'failed',error:String(error?.message || error)};
  } finally {
    posterJobsInFlight.delete(lockKey);
  }
}

async function sendLanguageChoice(chatId) {
  return sendMessage(chatId, t('en','choose_language'), { reply_markup: languageKeyboard() });
}

// Регистрация лида: строка в анкетах + своя тема в админской группе. Запускаем
// и не ждём — человек не должен смотреть в экран, пока мы пишем в таблицу.
// Любая ошибка остаётся в логе: его первый ответ важнее нашей отчётности.
function registerLead(from = {}, reason = 'start') {
  const id = from.id || from.telegram_id;
  if (!id) return;
  (async () => {
    const { ensureApplicantLead } = await import('./sheets.js');
    const profile = await ensureApplicantLead({ ...from, id }).catch(e => {
      console.error('registerLead: строка лида не завелась:', e.message); return null;
    });
    const { notifyNewLead } = await import('./admin.js');
    await notifyNewLead({ ...(profile || {}), ...from, telegram_id: id }, { reason });
  })().catch(e => console.error('registerLead failed:', e.message));
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
const attentionCounts=new Map();
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
  const count=pendingActionsFor(userId,await allSlots()).total;
  attentionCounts.set(String(userId),count);
  const showFantasy = await canAccessFantasyByTelegramId(userId).catch(e => { console.error('fantasy button access:',e.message); return false; });
  const kb = persistentKeyboard(lang, kind, userId, allow,count,showFantasy);
  const oneTap = kb.keyboard.flat().some(b => b.web_app) ? 'app' : 'txt';
  const sig = `v${MENU_VERSION}:${lang}:${kind}:${oneTap}:${count}:${showFantasy?'fantasy':''}:${(allow || []).join('.')}`;
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
    const hello = l === 'ru' ? `<b>${escapeHtml(st.profile?.name || '')}</b>, ты в лиге 🎾`.trim() : `<b>${escapeHtml(st.profile?.name || '')}</b>, you are in the league 🎾`.trim();
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
  fantasy:{ path:'/league?tab=fantasy', ru:'✨ Открыть Fantasy', en:'✨ Open Fantasy',
            tru:'Тестовая Fantasy League: соберите команду и проверьте правила.', ten:'Fantasy League test: build a squad and try the rules.' },
  league: { path:'/league',            ru:'🏆 Открыть лигу',      en:'🏆 Open the league',
            tru:'Таблицы, годовая гонка, игроки и история матчей.', ten:'Tables, Yearly Race, players and match history.' },
  squad:  { path:'/participants',      ru:'👥 Открыть состав',    en:'👥 Open the line-up',
            tru:'Предварительные составы дивизионов сезона.',       ten:'Preliminary division line-ups for the season.' },
  apply:  { path:'/apply?mode=event',  ru:'🎾 Подать заявку',     en:'🎾 Apply for the season',
            tru:'Заполни заявку — это пара минут.',                 ten:'Filling in the form takes a couple of minutes.' },
  waitlist:{ path:'/apply?mode=waitlist',ru:'📝 Лист ожидания',    en:'📝 Join waitlist',
            tru:'Заполните анкету для листа ожидания следующего сезона. Места в каждом сезоне ограничены, а участники листа получают информацию и приоритет раньше других.',ten:'Complete your profile for the next-season waitlist. Every season has limited places; waitlist players receive updates and priority first.' }
};
// Разделы, которые без анкеты всё равно не откроются. Раньше бот отправлял
// кнопку, приложение отвечало отказом — и человек оставался ни с чем. Теперь
// сразу объясняем, что первый шаг — анкета, и ведём на неё. Про Fantasy тут не
// говорим: он доступен только участникам лиги.
const NEEDS_PROFILE = new Set(['league','fantasy']);
async function sendProfileInvite(chatId, ru) {
  return sendMessage(chatId, ru
    ? '🎾 <b>Интерфейс лиги открывается после анкеты.</b>\n\nЗаполнение занимает пару минут. После него открываются:\n• витрина игроков с карточками и статистикой\n• таблицы дивизионов и годовая гонка\n• история матчей лиги\n• заявки на события и лист ожидания следующего сезона'
    : '🎾 <b>The League interface opens after your profile.</b>\n\nIt takes a couple of minutes. After that you get:\n• the player showcase with cards and statistics\n• division tables and the Yearly Race\n• league match history\n• event applications and the next-season waitlist',
    { reply_markup: { inline_keyboard: [[{ text: ru ? '📝 Заполнить анкету' : '📝 Complete the profile', web_app: { url: `${PUBLIC_URL}/apply?mode=profile` } }]] } });
}
async function sendOpenApp(chatId, lang, key) {
  const l = fallbackLang(lang);
  const d = OPEN_APP[key];
  if (!d) return sendMain(chatId, l, null);
  const ru = l === 'ru';
  if (NEEDS_PROFILE.has(key)) {
    try {
      const profile = await findApplicantByTelegramId(chatId);
      if (!isProfileCompleted(profile)) return sendProfileInvite(chatId, ru);
    } catch (e) { console.error('profile check failed:', e.message); }
  }
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
  if (isAdminHere) return sendMessage(chatId, adminHelpText(l));

  let active = false;
  try {
    const profile = await findApplicantByTelegramId(from?.id ?? chatId);
    if (profile) active = await isActiveLeaguePlayer({ ...profile, id: from?.id ?? chatId });
  } catch (e) { console.error('help league check failed:', e.message); }

  const lines = ru ? [
    '🎾 <b>Что умеет бот</b>',
    '',
    'Здесь ты подаёшь заявку в лигу, договариваешься о матчах, бронируешь корт и вносишь счёт.',
    '',
    '🏆 <b>Лига</b> — открывается кнопкой «Лига»',
    'Таблицы дивизионов, годовая гонка, карточки игроков со статистикой и историей матчей, расписание, результаты, события и партнёры.',
    '',
    '🎾 <b>Матчи</b>',
    ...(active
      ? ['/match — окна соперников, создать своё окно, мои матчи',
         '/result — внести счёт сыгранного матча (подтверждает соперник)',
         '/book — забронировать корт',
         '/doubles — парные турниры: записаться, выбрать партнёра из списка или позвать ссылкой']
      : ['<i>Матчи, результаты и бронь корта откроются после распределения по дивизионам.</i>']),
    '',
    ...(active ? ['✨ <b>Fantasy</b>', '/fantasy — собрать команду из игроков лиги и получать очки за их реальные матчи', ''] : []),
    '👤 <b>Личное</b>',
    '/menu — главное меню',
    '/results — лента результатов: включить или выключить',
    '/language — сменить язык',
    '/avatar — выбрать аватарку для карточки игрока',
    '/cancel — отменить текущее действие',
    '/help — этот список',
    '',
    '💬 Написать организатору — кнопка «Связаться» ниже.'
  ] : [
    '🎾 <b>What this bot does</b>',
    '',
    'Apply to the league, arrange matches, book a court and submit scores.',
    '',
    '🏆 <b>League</b> — open it with the «League» button',
    'Division tables, the Yearly Race, player cards with stats and match history, schedule, results, events and partners.',
    '',
    '🎾 <b>Matches</b>',
    ...(active
      ? ['/match — open slots, create your own, your matches',
         '/result — submit a match score (your opponent confirms it)',
         '/book — book a court',
         '/doubles — doubles tournaments: enter, pick a partner or invite by link']
      : ['<i>Matches, results and court booking open up once divisions are set.</i>']),
    '',
    ...(active ? ['✨ <b>Fantasy</b>', '/fantasy — build a squad of league players and score from their real matches', ''] : []),
    '👤 <b>Your account</b>',
    '/menu — main menu',
    '/results — results feed: on or off',
    '/language — change language',
    '/avatar — pick the photo for your player card',
    '/cancel — cancel current action',
    '/help — this list',
    '',
    '💬 To reach the organiser, use the «Contact» button below.'
  ];
  return sendMessage(chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: [
      [{ text: ru ? '📋 Главное меню' : '📋 Main menu', callback_data: 'main' }],
      [{ text: ru ? '💬 Связаться' : '💬 Contact', callback_data: 'contact' }]
    ] }
  });
}

// Эмодзи у раздела — чтобы в длинном списке было видно, где что, а не сплошная
// стена команд. Раздел берётся из ADMIN_COMMAND_LIST: добавил команду — она сама
// встала и сюда, и в меню по слэшу.
const ADMIN_HELP_ICON = { 'Лига':'🏆', 'Матчи':'🎾', 'Турниры':'🥇', 'Панель и рассылки':'📣', 'Настройка':'⚙️', 'Прочее':'🧰' };
const ADMIN_HELP_GROUP_EN = { 'Лига':'League and players', 'Матчи':'Matches and results', 'Турниры':'Tournaments', 'Панель и рассылки':'Panel and broadcasts', 'Настройка':'Setup', 'Прочее':'Other' };
const ADMIN_HELP_TAIL = {
  ru: [
    '', '👉 <b>Кнопками, а не командами</b>',
    '• На чеке за лигу три решения: <b>Approve</b> — участие подтверждено, <b>⏳ Оплата принята → Waitlist</b> — деньги приняли, место ждём, <b>Reject</b>.',
    '• Событие правится и удаляется в панели: удаление спрашивает, вернуть деньги на балансы или ты вернёшь переводом сам.',
    '• Возвраты переводом копятся во вкладке «Возвраты» — там же отмечаешь «отправил».',
    '• Рассылка умеет слать записанным на событие: во вкладке «Рассылка» переключи «Кому» на «По событию», выбери ивент и кого из записанных (все / участвуют / лист ожидания / не оплатили). Счётчик покажет число получателей до отправки. В тексте работают подстановки <code>{событие}</code>, <code>{дата}</code>, <code>{время}</code>, <code>{место}</code>.',
    '• Касса: игрок выбирается из списка, пополнение/списание/возврат — кнопками, комментарий обязателен.',
    '• Вкладка «Кнопки» — что видит каждая группа игроков: вкладки мини-приложения, кнопки под сообщением и нижняя клавиатура в чате. Там же «Прислать в бот» и «Открыть мини-апп» — посмотреть всё глазами выбранной группы, без второго аккаунта.',
    '', '🥇 <b>Турниры</b>',
    '• <code>/tournaments</code> — отдельное приложение: турниры, заявки, группы, сетка, правка счёта, журнал. Внутри админки его нет намеренно — это другой инструмент.',
    '• Позиции и таблица нигде не хранятся: они считаются из матчей при каждом открытии. Поэтому исправление счёта задним числом само чинит и таблицу, и сетку.',
    '• Снятие игрока и результат матча — разные вещи. Снятие меняет статус заявки; несыгранные матчи получают явный W/O, а сыгранные остаются как есть.',
    '• Парная запись идёт у игрока командой <code>/doubles</code>: можно записаться без партнёра, выбрать его из списка или позвать ссылкой. Отказ не убивает заявку.',
    '', '📊 <b>Дивизионы и результаты</b>',
    '• Дивизион игрока и список соперников берутся из таблицы дивизиона последнего сезона, лист <b>Division_Tracker</b>, список под заголовком «Player». Переносишь игрока — правишь только там.',
    '• Статус active/inactive — из анкеты. Нет active — матчи закрыты, даже если игрок есть в сетке.',
    '• Подтверждённый счёт уходит в два места: строка в общий <b>Cross_Division_Match_Log</b> и счёт в строку пары в <b>Match_Log</b> дивизиона. Нет строки пары — счёт ляжет только в общий лог, бот скажет об этом в отчёте.',
    '• <code>/match_test</code> показывает, из какой таблицы, листа и строки бот взял дивизион.',
    '', '💬 <b>Где отвечает бот</b>',
    '• Всё по конкретному игроку приходит в его тему в админской группе. Темы нет — заводится сама. Ответ игроку — Reply под его сообщением.',
    '• Твой личный чат с ботом работает как у обычного игрока: видно ровно то, что видит он.',
    '', '<i>Команды игрока (/match, /result, /book, /results) у вас тоже работают.</i>'
  ],
  en: [
    '', '👉 <b>Buttons, not commands</b>',
    '• A league payment slip offers three decisions: <b>Approve</b>, <b>⏳ Paid → Waitlist</b>, <b>Reject</b>.',
    '• Events are edited and deleted in the panel; deleting asks whether to refund to balances or by transfer.',
    '• Transfer refunds collect in the «Refunds» tab, where you mark them as sent.',
    '• Broadcasts can target an event: switch «To» to «By event», pick the event and who from it (all / playing / waitlist / unpaid). The counter shows the recipients before sending. Placeholders <code>{event}</code>, <code>{date}</code>, <code>{time}</code>, <code>{venue}</code> work in the text.',
    '• Balance: pick a player, then top up, charge or refund by buttons; a comment is required.',
    '• The «Buttons» tab shows what each player group sees, and lets you preview it without a second account.',
    '', '📊 <b>Divisions and results</b>',
    '• A player’s division and opponents come from the latest season division sheet, tab <b>Division_Tracker</b>, the list under «Player».',
    '• Status active/inactive comes from the application. Without active, matches stay closed.',
    '• A confirmed score goes to two places: a row in <b>Cross_Division_Match_Log</b> and the pair row in the division <b>Match_Log</b>.',
    '• <code>/match_test</code> shows which spreadsheet, sheet and row the division came from.',
    '', '💬 <b>Where the bot replies</b>',
    '• Everything about a player lands in that player’s topic in the admin group. Reply under their message to answer.',
    '', '<i>Player commands (/match, /result, /book, /results) work for you too.</i>'
  ]
};
function adminHelpText(lang = 'ru') {
  const ru = lang !== 'en';
  const order = ['Лига', 'Матчи', 'Панель и рассылки', 'Настройка', 'Прочее'];
  const lines = [ru ? '🎾 <b>PTF — команды организатора</b>' : '🎾 <b>PTF — organiser commands</b>'];
  for (const group of order) {
    const items = ADMIN_COMMAND_LIST.filter(c => c.group === group);
    if (!items.length) continue;
    const title = ru ? group : (ADMIN_HELP_GROUP_EN[group] || group);
    lines.push('', `${ADMIN_HELP_ICON[group] || '•'} <b>${title}</b>`);
    for (const c of items) {
      const text = ru ? (c.help || c.short) : (c.help_en || c.short_en || c.help || c.short);
      // Подсказку по аргументам экранируем: в ней есть «<id сообщения>», и без
      // экранирования Telegram считает это HTML-тегом и молча съедает кусок строки.
      const args = ru ? c.args : (c.args_en || c.args);
      lines.push(`/${c.cmd}${args ? ' ' + escapeHtml(args) : ''} — ${text}`);
    }
  }
  lines.push(...ADMIN_HELP_TAIL[ru ? 'ru' : 'en']);
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
  // По просьбе Костаса: после отключения явно называем команду, которой лента
  // включается обратно, а не только кнопку — кнопка может потеряться в чате.
  const howToReenable = event === 'just_muted'
    ? (ru ? '\n\nЧтобы включить обратно в любой момент — нажмите кнопку ниже или отправьте команду /results.' : '\n\nTo turn it back on anytime — tap the button below or send the /results command.')
    : '';
  return sendMessage(chatId, `${head}\n\n${explain}\n\n${state}${howToReenable}`, {
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
  // Цену ищем среди всех событий, а не только среди тех, куда открыт набор:
  // у идущего сезона регистрация закрыта, а счета по нему ещё выставляются.
  const events = await getAllEvents().catch(() => []);
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

async function handleChallengeStart(chatId,from,lang,targetTelegramId) {
  const mine = await getPlayerLeagueInfo({telegram_id:from.id});
  const other = await getPlayerLeagueInfo({telegram_id:targetTelegramId});
  if (!(mine.member || mine.admin) || !mine.found || !other.member || !other.found || !sameScope(mine,other)) {
    return sendMessage(chatId,uiError('different_group',lang));
  }
  return sendMessage(chatId,lang==='ru'?'Выберите удобные даты, время и корты.':'Choose your dates, time window and courts.',{
    reply_markup:{inline_keyboard:[[{text:lang==='ru'?'🎾 Создать вызов':'🎾 Create challenge',web_app:{url:PUBLIC_URL+'/match?tab=new&opponent='+encodeURIComponent(targetTelegramId)}}]]}
  });
}
async function acceptChallenge(chatId,from,lang,challengeId){const ch=await updateMatchChallenge(challengeId,{status:'accepted',responded_at:nowISO()}); if(!ch) return sendMessage(chatId,'Challenge not found.'); const fromLang=(await findApplicantByTelegramId(ch.from_telegram_id))?.language||'en'; const targetName=ch.to_name||contactName(from); if(ch.from_username){ await sendMessage(chatId,t(lang,'challenge_accepted_to_target'),{reply_markup:directChatKeyboard(lang,ch.from_username)}); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_accepted_to_from',{name:targetName}),ch.to_username?{reply_markup:directChatKeyboard(fromLang,ch.to_username)}:{});} else {userState.set(String(chatId),{mode:'challenge_chat',challengeId,peerId:ch.from_telegram_id}); userState.set(String(ch.from_telegram_id),{mode:'challenge_chat',challengeId,peerId:chatId}); await sendMessage(chatId,t(lang,'fallback_chat_opened')); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_accepted_to_from',{name:targetName})+'\n\n'+t(fromLang,'fallback_chat_opened'));}}
async function declineChallenge(chatId,from,lang,challengeId){const ch=await updateMatchChallenge(challengeId,{status:'declined',responded_at:nowISO()}); if(!ch) return sendMessage(chatId,'Challenge not found.'); const fromLang=(await findApplicantByTelegramId(ch.from_telegram_id))?.language||'en'; await sendMessage(chatId,t(lang,'challenge_declined_to_target')); await sendMessage(ch.from_telegram_id,tt(fromLang,'challenge_declined_to_from',{name:ch.to_name||contactName(from)}));}
async function forwardChallengeChat(msg,state){const from=msg.from||{}; const text=msg.text||msg.caption||'[media]'; await sendMessage(state.peerId,`<b>💬 Message from ${escapeHtml(contactName(from)||from.username||from.id)}</b>\n\n${escapeHtml(text)}`); await logMessage({message_id:uid('msg'),telegram_id:from.id,name:contactName(from),direction:'challenge_chat',message_type:'text',message_text:text,timestamp:nowISO(),related_event:state.challengeId,status:'sent'});}

function unfinishedResultMarkup(challengeId,lang='en') {
  const ru=lang==='ru';
  return {inline_keyboard:[
    [{text:ru?'✅ Матч уже доигран':'✅ Match completed',web_app:{url:PUBLIC_URL+'/match?result='+encodeURIComponent(challengeId)}}],
    [{text:ru?'Без комментария':'Skip comment',callback_data:'match_unfinished_skip:'+challengeId}]
  ]};
}
async function handleUnfinishedEvidence(msg,state,lang) {
  const ru=lang==='ru',from=msg.from||{};
  if(Number(state.expiresAt||0)<=Date.now()) {
    userState.delete(String(msg.chat.id));
    return sendMessage(msg.chat.id,ru?'Срок добавления сообщения истёк. Статус матча сохранён, результат можно внести позже.':'The message window expired. The match status is saved and you can submit the result later.',
      {reply_markup:unfinishedResultMarkup(state.challengeId,lang)});
  }
  const photoFileId=msg.photo?.length?msg.photo[msg.photo.length-1].file_id:'';
  const note=safe(msg.text||msg.caption||'').slice(0,1500);
  if(!photoFileId&&!note) return sendMessage(msg.chat.id,ru?'Отправьте фотографию или обычное текстовое сообщение.':'Send a photo or a regular text message.');
  const saved=await addMatchUnfinishedEvidence(state.challengeId,{telegram_id:from.id,name:contactName(from)},{note,photoFileId});
  if(!saved.ok) {
    userState.delete(String(msg.chat.id));
    return sendMessage(msg.chat.id,ru?'Статус матча уже изменился. Откройте «Мои матчи».':'The match status has changed. Open My matches.');
  }
  const delivered=await notifyMatchUnfinished(saved.slot,{actorId:from.id,evidenceOnly:true}).catch(()=>null);
  userState.delete(String(msg.chat.id));
  return sendMessage(msg.chat.id,delivered
    ?(ru?'✅ Сообщение передано организатору. Напоминания остановлены. Когда матч завершится, внесите результат.':'✅ Your message was sent to the organiser. Reminders are paused. Submit the result when the match is completed.')
    :(ru?'Напоминания остановлены, но сообщение организатору не доставлено. Пожалуйста, свяжитесь с ним напрямую.':'Reminders are paused, but the organiser notification was not delivered. Please contact the organiser directly.'),
    {reply_markup:unfinishedResultMarkup(state.challengeId,lang)});
}

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

// ---------------------------------------------------------------------------
// Боевой тестовый прогон матча: /test_match Победитель | Проигравший | 6:4 6:3
//
// Проходит ровно ту же цепочку, что и настоящий подтверждённый результат:
// пишет счёт в общий лог и в таблицу дивизиона, заполняет сезон, снимает место
// «до», форму и очки Fantasy, пересчитывает таблицы и собирает карточку. Разница
// в двух вещах: в ленту и игрокам НИЧЕГО не уходит (карточка приходит только
// сюда), и каждая запись заносится в журнал, поэтому одной кнопкой всё
// возвращается как было — вместе с формулами, а не их значениями.
const testRuns = new Map();
const TEST_RUN_TTL = 6 * 60 * 60 * 1000;
function rememberTestRun(id, data) {
  testRuns.set(id, { ...data, at: Date.now() });
  for (const [key, value] of testRuns) if (Date.now() - value.at > TEST_RUN_TTL) testRuns.delete(key);
}
const TEST_MATCH_USAGE = 'Как пользоваться — годится любой из вариантов:\n'
  + '<code>/test_match Ilia Izotov | Viacheslav Poniiatovsky | 6:4 6:3</code>\n'
  + '<code>/test_match Izotov - Poniiatovsky 6:4 6:3</code>\n'
  + '<code>/test_match izotov poniiatovsky 6:4 6:7 (8:10) 10:8</code>\n\n'
  + 'Первым идёт ПОБЕДИТЕЛЬ, счёт всегда от него. Хватит фамилии, регистр не важен. '
  + 'Счёт запишется в таблицы по-настоящему, карточка придёт только вам, в ленту и игрокам ничего не уйдёт, '
  + 'под карточкой будет кнопка «Откатить».\n\n'
  + 'Отправьте <code>/test_match</code> без всего — покажу готовые команды на несыгранных парах.';

// Если имя не сошлось — показываем похожих, чтобы было что скопировать.
function tmSuggest(players, head) {
  const words = String(head || '').split(/\s+/).map(matchNameKey).filter(w => w.length >= 3);
  const hit = players.filter(p => words.some(w => matchNameKey(p.name).includes(w)));
  return (hit.length ? hit : players).slice(0, 14)
    .map(p => '• <code>' + escapeHtml(p.name) + '</code> — ' + escapeHtml(p.division || p.letter) + (p.group ? ' гр. ' + escapeHtml(p.group) : ''))
    .join('\n');
}
// Готовые команды на ещё не сыгранных парах: скопировал и отправил.
async function tmSuggestPairs(season) {
  try {
    const { availableDivisions, divisionGroups } = await import('./division.js');
    const { getDivisionSchedule } = await import('./results.js');
    const out = [];
    for (const letter of await availableDivisions(season).catch(() => [])) {
      const groups = await divisionGroups(letter, season).catch(() => []);
      for (const g of (groups.length ? groups.map(x => x.group) : [''])) {
        for (const m of await getDivisionSchedule(letter, season, g).catch(() => [])) {
          if (m.played || out.length >= 6) continue;
          out.push(`<code>/test_match ${escapeHtml(m.p1)} | ${escapeHtml(m.p2)} | 6:4 6:3</code>`);
        }
        if (out.length >= 6) break;
      }
      if (out.length >= 6) break;
    }
    return out;
  } catch { return []; }
}

async function adminTestMatch(msg, text) {
  const chatId = msg.chat.id;
  const parsed = parseTestMatchInput(text);
  try {
    const { seasonRoster, latestSeason } = await import('./division.js');
    const season = String(await latestSeason().catch(() => '') || '');
    const roster = await seasonRoster(season);
    const players = roster.players || [];

    if (!parsed || !parsed.head) {
      const pairs = await tmSuggestPairs(season);
      return sendMessage(chatId, TEST_MATCH_USAGE
        + (pairs.length ? '\n\n<b>Несыгранные пары сезона ' + escapeHtml(season) + ':</b>\n' + pairs.join('\n') : ''));
    }
    if (!parsed.score) return sendMessage(chatId, '⛔ Не вижу счёта — он идёт после имён, например <code>6:4 6:3</code>.\n\n' + TEST_MATCH_USAGE);

    // Сначала по кускам (если разделитель был), иначе ищем обоих в слитной строке.
    let a = null, b = null, many = null;
    if (parsed.parts.length >= 2) {
      const first = findRosterPlayer(players, parsed.parts[0]), second = findRosterPlayer(players, parsed.parts[1]);
      many = first.many || second.many || null;
      a = first.player || null; b = second.player || null;
    }
    if (!a || !b) {
      const pair = findRosterPair(players, parsed.head);
      if (pair.length === 2) { a = pair[0]; b = pair[1]; many = null; }
    }
    if (many && (!a || !b)) {
      return sendMessage(chatId, '⛔ Под это подходит несколько игроков, уточните:\n'
        + many.slice(0, 10).map(p => '• <code>' + escapeHtml(p.name) + '</code>').join('\n'));
    }
    if (!a || !b) {
      return sendMessage(chatId, '⛔ Не нашёл обоих игроков в составах сезона ' + escapeHtml(season) + '.\n\n'
        + '<b>Кто есть в составах:</b>\n' + tmSuggest(players, parsed.head)
        + '\n\nСкопируйте имя целиком: <code>/test_match Имя | Имя | ' + escapeHtml(parsed.score) + '</code>');
    }
    if (matchNameKey(a.name) === matchNameKey(b.name)) return sendMessage(chatId, '⛔ Это один и тот же игрок. Первым — победитель, вторым — проигравший.');

    const winner = a.name, loser = b.name, score = parsed.score;
    await sendMessage(chatId, `Понял так: победитель <b>${escapeHtml(winner)}</b>, проигравший <b>${escapeHtml(loser)}</b>, счёт <b>${escapeHtml(score)}</b>.`);
    const slot = {
      challenge_id: 'test-' + uid('tm'),
      from_name: winner, to_name: loser,
      from_telegram_id: 'test-winner', to_telegram_id: 'test-loser',
      result_winner: 'test-winner', result_kind: 'played', result_score: score,
      result_status: 'confirmed', result_note: '',
      division: a.letter, group: a.group || '', season,
      agreed_date: nowISO().slice(0, 10), agreed_court: ''
    };
    const pair = await divisionPair(winner, loser, slot);
    if (!pair.known) return sendMessage(chatId, '⛔ ' + escapeHtml(pair.reason) + '\n\nПроверьте имена: они должны совпадать с составом дивизиона.');
    if (pair.crossGroup) return sendMessage(chatId, '⛔ Это кросс-групповая пара. Тестовый прогон с откатом работает только на обычном матче регулярки внутри одной группы.');
    slot.division = pair.d1; slot.group = pair.group === 'cross' ? slot.group : pair.group; slot.season = pair.season;

    await sendMessage(chatId, `🧪 Пишу по-настоящему в <b>Division ${escapeHtml(pair.d1)}</b>${pair.group ? ', группа ' + escapeHtml(pair.group) : ''}, сезон <b>${escapeHtml(pair.season)}</b>. Публикаций не будет.`);
    const journal = [];
    const write = await writeConfirmedResult(slot, { journal });
    const d = write.division || {};
    if (write.status === 'error' || d.status === 'error') {
      await rollbackJournal(journal).catch(() => {});
      return sendMessage(chatId, '⛔ Записать не удалось: ' + escapeHtml(describeWrite(write)) + '\nЧто успело записаться — откатил.');
    }
    invalidateLeagueCache(); invalidateDivisionCache();

    // Что бот снял перед записью — именно это и рисуется на карточке.
    const { peekCardContext, cardForSlot } = await import('./matchcard.js');
    const { winnerFirstScore } = await import('./matches.js');
    const ctx = peekCardContext(slot.challenge_id);
    const line = (who, name) => {
      const side = ctx?.[who];
      if (!side) return `• <b>${escapeHtml(name)}</b>: снимок не снялся`;
      return `• <b>${escapeHtml(name)}</b>: место до <b>${side.place ?? '—'}</b>, форма <b>${(side.form || []).join(' ') || '—'}</b>, Fantasy <b>+${ctx.fp?.[who] ?? '—'}</b>`;
    };
    const seasonNote = d.season_write?.column
      ? `✅ сезон записан: <code>${escapeHtml(d.season_write.value)}</code> → ${escapeHtml(d.season_write.column)}`
      : `⚠️ сезон не записан — ${escapeHtml(d.season_write?.skipped || 'причина неизвестна')}`;
    const report = '🧪 <b>Тестовый прогон</b>\n\n'
      + `Дивизион: <b>${escapeHtml(d.division || pair.d1)}</b>${pair.group ? ' · группа ' + escapeHtml(pair.group) : ''} · сезон <b>${escapeHtml(pair.season)}</b>\n`
      + `Общий лог: строка <b>${escapeHtml(write.row || '—')}</b> (${escapeHtml(write.status)})\n`
      + `Таблица дивизиона: строка <b>${escapeHtml(d.row || '—')}</b>, колонок найдено <b>${escapeHtml(d.columns ?? 0)}</b>\n`
      + seasonNote + '\n\n'
      + '<b>Снимок до матча</b>\n' + line('p1', winner) + '\n' + line('p2', loser) + '\n\n'
      + `Записано ячеек: <b>${journal.length}</b>\n` + journal.map(j => '• <code>' + escapeHtml(j.range) + '</code>').join('\n')
      + (write.status === 'duplicate' ? '\n\n⚠️ У этой пары уже была строка в общем логе — я переписал её тестовым счётом. Обязательно откатите.' : '')
      + '\n\n⚠️ Пока не нажали «Откатить», в таблицах лежит тестовый счёт.';
    await sendMessage(chatId, report);

    const buffer = await cardForSlot(slot, { winnerFirstScore, season: String(pair.season || '') });
    const { sendPhotoBuffer } = await import('./telegram.js');
    rememberTestRun(slot.challenge_id, { journal, winner, loser });
    await sendPhotoBuffer(chatId, buffer, 'image/png', {
      caption: 'Так карточка уйдёт в ленту. Никому, кроме вас, она не отправлена.',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Откатить запись', callback_data: 'tm_undo:' + slot.challenge_id }]] }
    });
    return;
  } catch (e) {
    console.error('test match failed:', e);
    return sendMessage(chatId, '⛔ ' + escapeHtml(e.message) + '\n\n' + TEST_MATCH_USAGE);
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
    // Человек только что пришёл — заводим ему строку и тему сразу, не дожидаясь
    // анкеты. Иначе он есть в таблице, но в админке его не видно.
    if (isPrivate && !isAdminUser(from.id)) registerLead(from, 'start');
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
    // Ссылка-приглашение в пару: t.me/бот?start=pair_<id приглашения>.
    if (param.startsWith('pair_')) return handlePairStart(chatId, from, lang, param.replace(/^pair_/, ''));
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
  if (text === '/fantasy' && isPrivate) return sendOpenApp(chatId, lang, 'fantasy');
  if (text === '/match' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'open');
  if (text === '/result' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'res');
  if (text === '/book' && isPrivate) return sendMatchShortcut(chatId, lang, from, 'book');
  // Парные турниры: отдельное событие со своей цепочкой записи.
  if (text === '/doubles' && isPrivate) return sendDoublesTournaments(chatId, from, lang);

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
    if (text.startsWith('/topic_backfill')) return adminTopicBackfill(msg);
    if (text.startsWith('/profile_refresh')) {
      // Сухой прогон: показать, какие формулы бот нашёл и собирается трогать.
      // С аргументом «go» — выполнить обновление один раз, вручную.
      try {
        const { pokeProfileImports } = await import('./results.js');
        const go = /\bgo\b/i.test(text);
        const res = await pokeProfileImports({ dryRun: !go });
        if (!res.ok) return sendMessage(chatId, '⛔ Таблица витрины профилей не настроена.');
        const cells = res.cells || [];
        if (!cells.length) return sendMessage(chatId, 'Формул IMPORTRANGE в витрине не нашёл. Проверьте, та ли таблица указана в WEBSITE_SPREADSHEET_ID.');
        const list = cells.slice(0, 25).map(c => `• <code>${escapeHtml(c.a1)}</code>`).join('\n');
        const head = go
          ? `✅ Обновил формул: <b>${res.poked}</b> из ${cells.length}.`
          : `🔍 Нашёл формул IMPORTRANGE: <b>${cells.length}</b>. Ничего не тронул.`;
        return sendMessage(chatId, `${head}\n\n${list}${cells.length > 25 ? `\n… и ещё ${cells.length - 25}` : ''}`
          + (go ? '' : '\n\nЗапустить по-настоящему: <code>/profile_refresh go</code>\nВключить обновление после каждого матча: строка <code>PROFILE_REFRESH</code> = <code>on</code> в Settings.'));
      } catch (e) { return sendMessage(chatId, '⛔ ' + escapeHtml(e.message)); }
    }
    if (text.startsWith('/places')) {
      // Почему в карточке игрока нет места в дивизионе: показать, что бот видит
      // в живых таблицах сезона и совпали ли имена с витриной профилей.
      try {
        const { livePlaces, placeKey, latestSeason, availableDivisions, invalidateDivisionCache } = await import('./division.js');
        const { getLeagueProfiles, invalidateLeagueCache } = await import('./sheets.js');
        invalidateDivisionCache(); invalidateLeagueCache();
        const arg = String(text.split(/\s+/)[1] || '').trim();
        const season = arg || String(await latestSeason().catch(() => '') || '');
        const divs = await availableDivisions(season).catch(() => []);
        const places = await livePlaces(season);
        const profiles = await getLeagueProfiles().catch(() => []);
        let matched = 0;
        const missing = [];
        for (const p of profiles) {
          if (places.get(placeKey(p.name))) matched++; else missing.push(p.name);
        }
        const sample = [...places.entries()].slice(0, 8)
          .map(([k, v]) => `• <code>${escapeHtml(k)}</code> — ${escapeHtml(String(v.division))} #${v.place} (${v.matches} м, ${v.wins}–${v.losses})`).join('\n');
        return sendMessage(chatId,
          `<b>Живые места, сезон ${escapeHtml(season || '—')}</b>\n`
          + `Дивизионы: ${divs.length ? escapeHtml(divs.join(', ')) : '<i>ни одного</i>'}\n`
          + `Строк в таблицах: <b>${places.size}</b>\n`
          + `Совпало с витриной: <b>${matched}</b> из ${profiles.length}\n\n`
          + (sample || '<i>таблицы пустые</i>')
          + (missing.length ? `\n\nБез места (${missing.length}): ${escapeHtml(missing.slice(0, 10).join(', '))}` : ''));
      } catch (e) { return sendMessage(chatId, '⛔ ' + escapeHtml(e.message)); }
    }
// Матч ищем сначала по challenge_id (как раньше), а если это не он — по имени
// игрока: challenge_id нигде не показывается человеку, а имя — то, что видно
// в самой карточке результата. Матчей на разных языках может быть много, поэтому
// при неоднозначности просим уточнить, а не берём случайный.

function findConfirmedSlot(done, wanted) {
  if (!wanted) return { slot: done.sort((a, b) => String(b.result_confirmed_at || '').localeCompare(String(a.result_confirmed_at || '')))[0] || null };
  const byId = done.find(r => String(r.challenge_id) === wanted);
  if (byId) return { slot: byId };
  const needle = wanted.trim().toLowerCase();
  const byName = done.filter(r => String(r.from_name || '').toLowerCase().includes(needle) || String(r.to_name || '').toLowerCase().includes(needle));
  if (byName.length === 1) return { slot: byName[0] };
  if (byName.length > 1) return { slot: null, many: byName };
  return { slot: null };
}
    if (text.startsWith('/test_match')) return adminTestMatch(msg, text);
    if (text.startsWith('/poster_test')) {
      // Полный безопасный тест на последнем подтверждённом матче: не публикует
      // результат повторно и присылает оба постера только в текущий админский чат.
      try {
        const wanted=String(text.replace(/^\/poster_test(?:@\w+)?\s*/i,'')).trim();
        const rows=await allSlots();
        const done=rows.filter(r=>String(r.result_status || '').toLowerCase()==='confirmed');
        const {slot,many}=findConfirmedSlot(done,wanted);
        if(many)return sendMessage(chatId,`Нашёл несколько матчей на «${escapeHtml(wanted)}», уточните имя:\n`+many.slice(0,10).map(m=>`• <code>${escapeHtml(m.from_name || '')} — ${escapeHtml(m.to_name || '')}</code>`).join('\n'));
        if(!slot)return sendMessage(chatId,wanted?'Матч не найден. Укажите имя игрока или запустите /poster_test без аргумента — возьму последний подтверждённый матч.':'Подтверждённых результатов пока нет.');
        await sendMessage(chatId,`🧪 <b>Тест постера</b>\n\n${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}\n\nРезультат матча повторно не публикуется. Два постера придут только сюда.`,msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
        return preparePosterForAdmin({chatId,threadId:msg.message_thread_id||'',slot,comment:''});
      } catch(error) {
        return sendMessage(chatId,`⛔ ${escapeHtml(error?.message || error)}`,msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
      }
    }
    if (text.startsWith('/result_test')) {
      // Предпросмотр карточки результата на настоящем матче. Лента и подписчики
      // не трогаются — всё уходит только сюда.
      try {
        const { previewResultPost } = await import('./matches.js');
        const wanted = String(text.split(/\s+/)[1] || '').trim();
        const rows = await allSlots();
        const done = rows.filter(r => String(r.result_status || '').toLowerCase() === 'confirmed');
        const { slot, many } = findConfirmedSlot(done, wanted);
        if (many) return sendMessage(chatId, `Нашёл несколько матчей на «${escapeHtml(wanted)}», уточните имя:\n` + many.slice(0, 10).map(m => `• <code>${escapeHtml(m.from_name || '')} — ${escapeHtml(m.to_name || '')}</code>`).join('\n'));
        if (!slot) return sendMessage(chatId, wanted ? 'Матч не найден. Укажите имя игрока (как в карточке результата) или ничего — возьму последний.' : 'Подтверждённых результатов пока нет.');
        await sendMessage(chatId, `🧪 Предпросмотр: <b>${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}</b>. Никому, кроме вас, это не уходит.`);
        await previewResultPost(slot, chatId, { withButtons: msg.chat?.type === 'private' });
        return;
      } catch (e) { return sendMessage(chatId, '⛔ ' + escapeHtml(e.message)); }
    }
    if (text.startsWith('/fix_result')) {
      // Перевыпуск карточки в ленте: /fix_result <id сообщения> [id матча].
      // Id сообщения берётся из ссылки на пост — это последнее число в ней.
      const parts = text.split(/\s+/).slice(1);
      const messageId = Number(parts[0] || 0);
      if (!messageId) return sendMessage(chatId, 'Как пользоваться: <code>/fix_result 1234</code> — номер сообщения из ссылки на пост в ленте. Вторым аргументом можно указать имя игрока из этого матча, иначе беру последний результат.');
      try {
        const { refreshResultPost } = await import('./matches.js');
        const wanted = String(parts[1] || '').trim();
        const rows = await allSlots();
        const done = rows.filter(r => String(r.result_status || '').toLowerCase() === 'confirmed');
        const { slot, many } = findConfirmedSlot(done, wanted);
        if (many) return sendMessage(chatId, `Нашёл несколько матчей на «${escapeHtml(wanted)}», уточните имя:\n` + many.slice(0, 10).map(m => `• <code>${escapeHtml(m.from_name || '')} — ${escapeHtml(m.to_name || '')}</code>`).join('\n'));
        if (!slot) return sendMessage(chatId, wanted ? 'Матч не найден. Укажите имя игрока (как в карточке результата) или ничего — возьму последний.' : 'Подтверждённых результатов нет.');
        await refreshResultPost(slot, messageId, chatId);
        return sendMessage(chatId, `✅ Обновил карточку: <b>${escapeHtml(slot.from_name || '')} — ${escapeHtml(slot.to_name || '')}</b>.`);
      } catch (e) {
        const hint = /message can't be edited|MESSAGE_ID_INVALID|not found/i.test(e.message)
          ? '\n\nПроверьте номер сообщения. И помните: Telegram разрешает боту править своё сообщение только первые 48 часов.'
          : '';
        return sendMessage(chatId, '⛔ ' + escapeHtml(e.message) + hint);
      }
    }
    if (text === '/match_test') return adminMatchTest(msg);
    if (text === '/matches') return adminMatchesOverview(msg);
    if (text === '/league') {
      return sendMessage(chatId, '<b>🏆 Лига — тест нового интерфейса</b>\n\nГодовая гонка, список игроков и карточка игрока. Пока видно только вам.', {
        reply_markup: { inline_keyboard: [[{ text: '🏆 Открыть', web_app: { url: `${PUBLIC_URL}/league` } }]] }
      });
    }
    // Турнирная админка: отдельное приложение, не вкладка внутри админки.
    if (text === '/tournaments') {
      return sendMessage(chatId, '<b>🏆 Турниры</b>\n\nСоздание турниров, заявки, группы, сетка плей-офф, правка результатов и парные заявки.\n\nПереключатель «Тест» в шапке пишет всё в листы с пометкой TEST — боевые таблицы при этом не меняются.', {
        reply_markup: { inline_keyboard: [[{ text: '🏆 Открыть админку турниров', web_app: { url: `${PUBLIC_URL}/tournaments` } }]] }
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
    if (text.startsWith('/profile')) return adminProfile(chatId, text);
    if (text.startsWith('/whois')) return adminWhois(chatId, text);
    if (text === '/id_check') return adminIdCheck(chatId);
    if (text === '/photos') return adminPhotoCheck(chatId);

    const posterState=adminState.get(String(from.id));
    if (posterState?.mode === 'poster_comment') {
      if (!text) return sendMessage(chatId,'Напишите комментарий к постеру текстом или отправьте /cancel.',msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
      const slot=await findMatchSlot(posterState.challengeId);
      if (!slot) {
        adminState.delete(String(from.id));
        return sendMessage(chatId,'Матч не найден.',msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
      }
      adminState.delete(String(from.id));
      return preparePosterForAdmin({chatId,threadId:msg.message_thread_id||'',slot,comment:text});
    }

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
    if (act === 'fantasy') return sendOpenApp(chatId, lang, 'fantasy');
    if (act === 'events') return openDestination(chatId,lang,from,'events');
    if (act === 'squad') return sendOpenApp(chatId, lang, 'squad');
    if (act === 'apply') return sendOpenApp(chatId, lang, 'apply');
    if (act === 'waitlist') return sendOpenApp(chatId, lang, 'waitlist');
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

  if (state?.mode === 'unfinished_evidence') return handleUnfinishedEvidence(msg,state,lang);

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
const PERSONAL_PREFIXES = ['text:', 'lang_select:', 'pay:', 'crypto:', 'paylater:', 'payment_menu:', 'pr:'];
function isPersonalCallback(data = '') {
  const d = String(data);
  return PERSONAL_CALLBACKS.has(d) || PERSONAL_PREFIXES.some(p => d.startsWith(p));
}

export async function handleCallback(q) {
  const data = q.data || '';
  const msg = q.message;
  const chatId = msg.chat.id;
  const from = q.from || {};
  // Крутилка на кнопке гаснет только после ответа Телеграму, поэтому отвечаем
  // ПЕРВЫМ делом. Раньше перед этим читался лист анкет ради языка — и человек
  // смотрел на крутилку ровно столько, сколько шёл поход в Google. Для мгновенной
  // подсказки берём язык из памяти (или из настроек самого Телеграма), а точный
  // язык дочитываем уже после ответа, когда ждать никому не нужно.
  const inGroup = ['group', 'supergroup', 'channel'].includes(String(msg.chat.type || ''));
  if (inGroup && isPersonalCallback(data)) {
    const quick = fallbackLang(cachedLang(from) || String(from.language_code || '').slice(0, 2));
    return answerCallbackQuery(q.id, quick === 'ru'
      ? 'Это личный раздел — откройте его в чате с ботом.'
      : 'This is a personal section — open it in your chat with the bot.', true).catch(() => {});
  }
  answerCallbackQuery(q.id).catch(() => {});

  const storedLang = await userLang(from);
  const lang = fallbackLang(storedLang);

  // Парная цепочка живёт отдельным файлом: здесь только перенаправление.
  if (isPairCallback(data)) return handlePairCallback(q, lang);

  if (data.startsWith('lang_select:')) {
    const selected = data.split(':')[1] === 'ru' ? 'ru' : 'en';
    const state = userState.get(String(chatId));
    await setUserLanguage(from, selected);
    rememberLang(from.id, selected);
    // Если /start прилетел не к нам (старая сессия, перезапуск) — тема заведётся
    // здесь. Повторной карточки не будет: notifyNewLead смотрит на admin_topic_id.
    if (!isAdminUser(from.id)) registerLead({ ...from, language: selected }, 'language');
    userState.delete(String(chatId));
    await sendMessage(chatId, t(selected, 'language_saved'));
    const param = state?.pendingStartParam || '';
    if (param.startsWith('challenge_')) return handleChallengeStart(chatId, from, selected, param.replace('challenge_', ''));
    return sendMain(chatId, selected, from);
  }

  if (!storedLang && msg.chat.type === 'private' && !isAdminUser(from.id)) {
    return sendLanguageChoice(chatId);
  }

  // Every old Telegram button follows the same server policy as the mini app.
  if (/^(match_|res_ok:|res_no:|mt_)/.test(data)) {
    const slot = await findMatchSlot(data.split(':')[1]);
    const access = await authorizeSlot(slot,{telegram_id:from.id});
    if (!access.ok) return sendMessage(chatId,uiError(access.reason,lang));
  }
  if (/^challenge_(accept|decline):/.test(data)) {
    const old = await findMatchChallenge(data.split(':')[1]);
    if (!old || String(old.to_telegram_id)!==String(from.id)) return sendMessage(chatId,uiError('not_a_player',lang));
    const mine = await getPlayerLeagueInfo({telegram_id:from.id});
    const other = await getPlayerLeagueInfo({telegram_id:old.from_telegram_id});
    if (!(mine.member || mine.admin) || !mine.found || !other.member || !sameScope(mine,other)) return sendMessage(chatId,uiError('different_group',lang));
  }
  // Аватарка: выбор варианта и запрос ещё одного. Действует сам игрок.
  if (data.startsWith('avpick:')) {
    const res = await pickAvatarVariant(from.id, data.split(':')[1]);
    return sendMessage(chatId, res.ok
      ? (lang==='ru'?`✅ Вариант ${res.index} выбран — он уже стоит в твоём профиле лиги.`:`✅ Option ${res.index} selected — it is now on your league profile.`)
      : uiError(res.error,lang));
  }
  if (data === 'avmore') {
    const { requestAnotherAvatar } = await import('./avatars.js');
    const res = await requestAnotherAvatar(from.id);
    return sendMessage(chatId, res.ok
      ? (lang==='ru'?'🔄 Делаю ещё вариант — пришлю через минуту.':'🔄 Creating another option — I will send it shortly.')
      : uiError(res.error,lang));
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
  if (data.startsWith('match_unfinished:')) {
    const id=data.split(':')[1],slot=await findMatchSlot(id);
    if(!slot)return sendMessage(chatId,lang==='ru'?'Матч не найден.':'Match not found.');
    const ru=lang==='ru';
    return sendMessage(chatId,(ru?'<b>⏸ Отметить матч как недоигранный?</b>':'<b>⏸ Mark this match unfinished?</b>')+'\n\n'
      +(ru?'После подтверждения напоминания остановятся, а организатор получит уведомление. Когда матч завершится, результат можно будет внести обычным способом.':'After confirmation, reminders will stop and the organiser will be notified. You can submit the result normally after the match is completed.'),
      {reply_markup:{inline_keyboard:[
        [{text:ru?'Да, матч не доигран':'Yes, match unfinished',callback_data:'match_unfinished_ok:'+id}],
        [{text:ru?'Назад':'Back',callback_data:'match_unfinished_cancel:'+id}]
      ]}});
  }
  if (data.startsWith('match_unfinished_cancel:')) {
    return sendMessage(chatId,lang==='ru'?'Действие отменено.':'Action cancelled.');
  }
  if (data.startsWith('match_unfinished_ok:')) {
    const id=data.split(':')[1],ru=lang==='ru';
    const saved=await markMatchUnfinished(id,{telegram_id:from.id,name:contactName(from)});
    if(!saved.ok) {
      const errors={already_confirmed:ru?'Результат уже подтверждён.':'The result is already confirmed.',result_started:ru?'По матчу уже внесён результат.':'A result has already been submitted.',match_not_ended:ru?'Матч ещё не должен был завершиться.':'The match is not due to finish yet.',not_accepted:ru?'Матч больше не активен.':'The match is no longer active.'};
      return sendMessage(chatId,errors[saved.reason]||(ru?'Не удалось изменить статус матча.':'Could not update the match.'));
    }
    const delivered=saved.already?true:await notifyMatchUnfinished(saved.slot,{actorId:from.id}).catch(()=>null);
    userState.set(String(chatId),{mode:'unfinished_evidence',challengeId:id,lang,expiresAt:Date.now()+24*60*60*1000});
    return sendMessage(chatId,(delivered
      ?(ru?'✅ Матч отмечен как недоигранный. Организатор уведомлён, напоминания остановлены.':'✅ The match is marked unfinished. The organiser was notified and reminders are paused.')
      :(ru?'Матч отмечен как недоигранный, напоминания остановлены. Уведомление организатору не доставлено — свяжитесь с ним напрямую.':'The match is marked unfinished and reminders are paused. The organiser notification was not delivered; please contact them directly.'))
      +'\n\n'+(ru?'Если нужно, отправьте сейчас фотографию или напишите сообщение — оно будет передано организатору.':'If needed, send a photo or write a message now; it will be forwarded to the organiser.'),
      {reply_markup:unfinishedResultMarkup(id,lang)});
  }
  if (data.startsWith('match_unfinished_skip:')) {
    const id=data.split(':')[1],state=userState.get(String(chatId));
    if(state?.mode==='unfinished_evidence'&&state.challengeId===id)userState.delete(String(chatId));
    return sendMessage(chatId,lang==='ru'?'Готово. Напоминания остановлены. После завершения матча внесите результат.':'Done. Reminders are paused. Submit the result after the match is completed.',
      {reply_markup:{inline_keyboard:[[{text:lang==='ru'?'✅ Матч уже доигран':'✅ Match completed',web_app:{url:PUBLIC_URL+'/match?result='+encodeURIComponent(id)}}]]}});
  }
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
      return answerCallbackQuery(q.id, texts[r.reason] || uiError(r.reason,lang), true).catch(() => {});
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
      return answerCallbackQuery(q.id, texts[r.reason] || uiError(r.reason,lang), true).catch(() => {});
    }
    // Счёт от организатора требует подписи обоих игроков. Пока подписал один,
    // в таблицы ничего не пишем — только отмечаем и ждём второго.
    if (r.waiting) {
      const { notifyResultHalfConfirmed } = await import('./matches.js');
      await notifyResultHalfConfirmed(r.slot, String(from.id)).catch(e => console.error('half confirm notice:', e.message));
      return null;
    }
    const write = await writeConfirmedResult(r.slot).catch(e => ({ status:'error', reason:e.message }));
    // Междивизионный матч в зачёт не идёт: счёт никуда не записан, решает организатор.
    // Игрокам про это не пишем — для них матч просто ждёт проверки.
    if (write.status === 'error' || (write.division && write.division.status !== 'saved')) {
      await notifyAdmin('Не удалось записать результат '+r.slot.challenge_id+': '+describeWrite(write));
      return sendMessage(chatId,lang==='ru'?'Счёт подтверждён. Организатор проверит запись в таблицы.':'Score confirmed. The organiser will check the table update.');
    }
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
      const texts = { not_booker: ru ? 'Бронь подтверждает автор вызова.' : 'Only the challenge creator confirms the booking.', already_confirmed: ru ? 'Корт уже подтверждён.' : 'Already confirmed.',
        not_accepted: ru ? 'Матч ещё не согласован.' : 'Match is not agreed yet.',
        not_a_player: ru ? 'Вы не участник этого матча.' : 'Not your match.',
        not_found: ru ? 'Матч не найден.' : 'Not found.' };
      return answerCallbackQuery(q.id, texts[r.reason] || uiError(r.reason,lang), true).catch(() => {});
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
    await answerCallbackQuery(q.id, lang==='ru'?(mute?'Результаты отключены':'Результаты включены'):(mute?'Results turned off':'Results turned on')).catch(() => {});
    return sendResultsSettings(chatId, lang, from.id, mute ? 'just_muted' : 'just_unmuted');
  }

  // Перенос времени на том же корте: площадка дала соседний слот.
  // Меняет тот, кто бронирует; применяется после «Подходит» от соперника.
  if (data.startsWith('match_retime:')) {
    const slot = await findMatchSlot(data.split(':')[1]);
    if (!slot) return answerCallbackQuery(q.id, lang === 'ru' ? 'Матч не найден.' : 'Not found.', true).catch(() => {});
    if (![String(slot.from_telegram_id), String(slot.to_telegram_id)].includes(String(from.id))) return null;
    if (String(slot.from_telegram_id) !== String(from.id)) {
      return answerCallbackQuery(q.id, lang === 'ru' ? 'Время меняет тот, кто бронировал корт.' : 'Only the player who booked can change the time.', true).catch(() => {});
    }
    return sendMessage(chatId, timeChoiceText(slot,lang), { reply_markup: timeChoiceKeyboard(slot) }).catch(() => {});
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
      return answerCallbackQuery(q.id, texts[r.reason] || uiError(r.reason,lang), true).catch(() => {});
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
      return answerCallbackQuery(q.id, texts[r.reason] || uiError(r.reason,lang), true).catch(() => {});
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

  if (data.startsWith('match_cancel:')) {
    const id=data.split(':')[1];
    const result=await cancelMatchmaking(id,{telegram_id:from.id,name:from.first_name||''});
    if(!result.ok){
      const errors={not_found:lang==='ru'?'Запрос не найден.':'Request not found.',not_a_player:lang==='ru'?'Это не ваш запрос.':'This is not your request.',already_closed:lang==='ru'?'Запрос уже закрыт.':'Request is already closed.',result_started:lang==='ru'?'Результат уже внесён.':'A result has already been submitted.'};
      return answerCallbackQuery(q.id,errors[result.reason]||uiError(result.reason,lang),true).catch(()=>{});
    }
    await notifyMatchCancelled(result.previous,{telegram_id:from.id,name:from.first_name||''},{backToOpen:result.backToOpen}).catch(e=>console.error('notifyMatchCancelled failed:',e.message));
    return answerCallbackQuery(q.id,result.backToOpen?(lang==='ru'?'Запрос отменён, окно снова открыто.':'Request cancelled; the slot is open again.'):(lang==='ru'?'Запрос отменён.':'Request cancelled.')).catch(()=>{});
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
    if (data.startsWith('poster:ready:')) {
      const rest=data.slice('poster:ready:'.length);
      const split=rest.indexOf(':');
      const variant=Number(rest.slice(0,split));
      const challengeId=rest.slice(split+1);
      const run=posterRuns.get(challengeId) || {};
      run.selected=variant;
      posterRuns.set(challengeId,run);
      await answerCallbackQuery(q.id,`Вариант ${variant} отмечен готовым`).catch(()=>{});
      return sendMessage(chatId,`✅ <b>Вариант ${variant} отмечен готовым.</b>\n\nОн остаётся в этом топике, откуда его можно сохранить. Кнопку публикации в Instagram подключим отдельным этапом.`,msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
    }
    if (data.startsWith('poster:regen:')) {
      const rest=data.slice('poster:regen:'.length);
      const split=rest.indexOf(':');
      const variant=Number(rest.slice(0,split));
      const challengeId=rest.slice(split+1);
      const slot=await findMatchSlot(challengeId);
      if(!slot)return sendMessage(chatId,'Матч не найден.');
      await answerCallbackQuery(q.id,'Запустил генерацию').catch(()=>{});
      return preparePosterForAdmin({chatId,threadId:msg.message_thread_id||'',slot,comment:'',onlyVariant:variant});
    }
    if (data.startsWith('poster:comment:')) {
      const challengeId=data.slice('poster:comment:'.length);
      const slot=await findMatchSlot(challengeId);
      if(!slot)return sendMessage(chatId,'Матч не найден.');
      adminState.set(String(from.id),{mode:'poster_comment',challengeId});
      return sendMessage(chatId,'<b>Комментарий к постеру</b>\n\nНапишите одним сообщением, что изменить или добавить в промпт: например «полуфинал», «бывший чемпион» или нужное настроение.\n\nОтмена: /cancel',msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{});
    }
    if (data.startsWith('poster:prepare:')) {
      const challengeId=data.slice('poster:prepare:'.length);
      const slot=await findMatchSlot(challengeId);
      if(!slot)return sendMessage(chatId,'Матч не найден.');
      return preparePosterForAdmin({chatId,threadId:msg.message_thread_id||'',slot,comment:''});
    }
    if (data.startsWith('admin_reply:')) {
      const targetTelegramId = data.split(':')[1];
      adminState.set(String(from.id), { mode:'reply_waiting', targetTelegramId });
      return sendMessage(chatId, `${lang==='ru'?'Напиши ответ игроку':'Write a reply to'} <code>${escapeHtml(targetTelegramId)}</code>.`);
    }
    // Междивизионный матч: организатор решает, записывать его или нет.
    // Откат тестового прогона: возвращаем в таблицы ровно то, что там было.
    if (data.startsWith('tm_undo:')) {
      const id = data.split(':')[1];
      const run = testRuns.get(id);
      if (!run) return sendMessage(chatId, 'Этот прогон уже откачен или бот перезапускался — журнал правок потерялся. Проверьте таблицу руками.');
      testRuns.delete(id);
      const res = await rollbackJournal(run.journal).catch(e => ({ restored: 0, total: run.journal.length, failed: [e.message] }));
      const { forgetCardContext } = await import('./matchcard.js');
      forgetCardContext(id);
      invalidateLeagueCache(); invalidateDivisionCache();
      return sendMessage(chatId, `↩️ Откатил <b>${escapeHtml(run.winner)}</b> — <b>${escapeHtml(run.loser)}</b>: вернул <b>${res.restored}</b> из ${res.total} диапазонов.`
        + (res.failed?.length ? '\n\n⚠️ Не вернулось:\n' + res.failed.map(x => '• ' + escapeHtml(x)).join('\n') : '\n\nТаблицы в исходном состоянии.'));
    }
    if (data.startsWith('res_force:')) {
      const slot = await findMatchSlot(data.split(':')[1]);
      if (!slot) return sendMessage(chatId, 'Матч не найден.');
      const write = await writeConfirmedResult(slot, { force: true }).catch(e => ({ status:'error', reason:e.message }));
      if (write.status==='error' || (write.division && !['saved','cross_division'].includes(write.division.status))) {
        return sendMessage(chatId,lang==='ru'?'Не удалось записать результат. '+escapeHtml(describeWrite(write)):'Could not save the result. Please check the table configuration.');
      }
      invalidateLeagueCache();
      invalidateDivisionCache();
      await notifyResultConfirmed(slot, describeWrite(write)).catch(() => {});
      broadcastResult(slot).catch(e => console.error('broadcastResult failed:', e.message));
      return sendMessage(chatId,lang==='ru'?`Записал: <i>${escapeHtml(describeWrite(write))}</i>`:'Result saved.');
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
    if (data === 'bcconfirm') return withBulkRetries(() => executeBroadcast(q));
    if (data === 'bcconfirm_menu') return withBulkRetries(() => executeBroadcastWithMenu(q));
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

const attentionQueue=new Set();let attentionTimer=null;
export function queueMatchAttention(ids,previous={}) {
 for(const id of ids)if(!attentionCounts.has(String(id))&&previous[id]!==undefined)attentionCounts.set(String(id),previous[id]);
 ids.forEach(id=>attentionQueue.add(String(id)));
 if(attentionTimer)return;
 attentionTimer=setTimeout(async()=>{
  attentionTimer=null;const batch=[...attentionQueue];attentionQueue.clear();
  for(const id of batch) {
   const previousCount=attentionCounts.get(id);
   try {
    const p=await findApplicantByTelegramId(id);if(!p)continue;
    const n=pendingActionsFor(id,await allSlots()).total;
    if(n===(attentionCounts.get(id)??0))continue;
    const lang=p.language==='ru'?'ru':'en',st=await playerState(id);
    const kb=await keyboardFor(id,lang,st.kind,id);if(!kb)continue;
    await sendMessage(id,n?(lang==='ru'?'🔴 Мои матчи: ждут вашего действия — '+n:'🔴 My matches: actions waiting for you — '+n):(lang==='ru'?'✅ В матчах нет действий, ожидающих вашего ответа.':'✅ No match actions are waiting for your response.'),{reply_markup:kb,disable_notification:true});
   }catch(e){if(previousCount===undefined)attentionCounts.delete(id);else attentionCounts.set(id,previousCount);menuSignature.delete(id);console.error('attention refresh:',e.message);}
  }
 },1500);
}
