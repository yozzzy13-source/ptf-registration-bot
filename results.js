import { RESULTS, RESULTS_BROADCAST_ENABLED, RESULTS_BROADCAST_DELAY_MS, RESULTS_MEDIA_PAIR_WINDOW_MS, RESULTS_MEDIA_WAIT_MS } from './config.js';
import { sheets as sheetsClient } from './google.js';
import { sendMessage, sendPhoto, answerCallbackQuery, setMessageReaction } from './telegram.js';
import { getResultBroadcastContacts, logResultBroadcast, markTelegramBlocked, setResultsNotifications } from './sheets.js';

const MASTER_START_ROW = 4;
const ALIAS_START_ROW = 2;
const DATA_START_ROW = 2;
const COL_MATCH_DATE = 2;
const COL_FORMAT = 3;
const COL_COMPETITION = 4;
const COL_P1_ID = 5;
const COL_P1_DIVISION = 6;
const COL_P2_ID = 7;
const COL_P2_DIVISION = 8;
const COL_P1_NAME = 9;
const COL_P2_NAME = 10;
const COL_SCORES_START = 11;
const COL_SET3MODE = 23;
const COL_STATUS = 24;
const SUGGESTIONS_LIMIT = 8;
const PAIR_SUGGESTIONS_LIMIT = 8;
const SUGGESTION_MIN_SCORE = 65;
const PENDING_TTL_MS = 5 * 60 * 1000;

const pendingSessions = new Map();
const seenMessages = new Map();
const recentStandalonePhotos = new Map();
const pendingResultBroadcasts = new Map();
const sheetIdCache = new Map();
let playerProfileUrlCache = { expiresAt: 0, map: new Map() };

function sheets() {
  return sheetsClient();
}

export function isResultsMessage(msg) {
  if (!msg?.chat) return false;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || 0;
  return chatId === RESULTS.targetChatId && (!RESULTS.targetTopicId || threadId === RESULTS.targetTopicId);
}

export function isResultsCallback(callbackQuery) {
  const data = String(callbackQuery?.data || '');
  return data.startsWith('PTF|') || data.startsWith('RESNOTIFY|');
}

export async function handleResultsMessage(msg) {
  const text = msg.text || msg.caption || '';
  const chatId = msg.chat?.id;
  const threadId = msg.message_thread_id || 0;
  const userId = msg.from?.id;
  const messageId = msg.message_id;

  await debugLog('01 received', { message: msg });

  if (!text) {
    if (msg.photo?.length) {
      if (!claimMessageOnce(chatId, messageId)) return;
      await debugLog('06 dedup result', { claimed: true, chatId, messageId });
      await handleStandaloneResultPhoto(msg);
      return;
    }
    await debugLog('03 stopped no text/caption', { chatId, threadId, userId, messageId });
    return;
  }

  if (!claimMessageOnce(chatId, messageId)) return;
  await debugLog('06 dedup result', { claimed: true, chatId, messageId });
  await debugLog('02 message parsed', { chatId, threadId, userId, messageId, text });

  if (!looksLikeMatchSubmission(text)) {
    if (msg.photo?.length) await handleStandaloneResultPhoto(msg);
    await debugLog('07 ignored non-result message', { chatId, threadId, userId, messageId, text });
    return;
  }

  const parsed = parseMatchMessageV2(text);
  await debugLog('07 parsed', parsed);

  if (!parsed.hasScore) {
    await debugLog('08 stopped no score', { text });
    await safeSendMessage(
      userId,
      "I couldn't find a match score in your message.\n\nPlease delete the old message in the Results topic and resend the match there with full player names."
    );
    return;
  }

  const scoreValidation = validateMatchScore(parsed);
  await debugLog('08 score validation', scoreValidation);

  if (!scoreValidation.ok) {
    await safeSendMessage(
      userId,
      `Match score looks incomplete or invalid.\nScore: ${formatScore(parsed)}\n\n${scoreValidation.message}\n\nPlease delete the old message in the Results topic and resend the full correct score there.`
    );
    return;
  }

  const playersList = await getPlayersList();
  const aliasMap = await getPlayerAliases(playersList);
  const r1 = resolvePlayer(parsed.p1Raw, playersList, aliasMap);
  const r2 = resolvePlayer(parsed.p2Raw, playersList, aliasMap);

  await debugLog('09 resolved players', {
    p1Raw: parsed.p1Raw,
    p2Raw: parsed.p2Raw,
    r1,
    r2,
    score: formatScore(parsed)
  });

  const needsInteractiveChoice =
    !r1.name || !r2.name || r1.needsConfirmation || r2.needsConfirmation || r1.conflict || r2.conflict;

  if (needsInteractiveChoice) {
    await startInteractiveSelection(userId, chatId, threadId, parsed, playersList, aliasMap, r1, r2, msg);
    return;
  }

  await saveMatchAndNotify(userId, chatId, threadId, r1.name, r2.name, parsed, msg);
}

export async function handleResultsCallback(callbackQuery) {
  const userId = callbackQuery.from?.id;
  const data = callbackQuery.data || '';
  await answerCallbackQuery(callbackQuery.id, data.startsWith('RESNOTIFY|') ? '' : 'Selection received').catch(() => {});

  if (!userId) return;
  const lang = String(callbackQuery.from?.language_code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';

  if (data === 'RESNOTIFY|off') {
    await setResultsNotifications(userId, false).catch(err => debugLog('RESULT NOTIFY OFF ERROR', stackDetails(err)));
    await safeSendMessage(
      userId,
      lang === 'ru'
        ? '🔕 Уведомления о результатах матчей отключены.\n\nЧтобы включить их снова, откройте меню и выберите /results.'
        : '🔕 Match result notifications are off.\n\nTo turn them back on, open Menu and choose /results.'
    );
    return;
  }

  if (data === 'RESNOTIFY|on') {
    await setResultsNotifications(userId, true).catch(err => debugLog('RESULT NOTIFY ON ERROR', stackDetails(err)));
    await safeSendMessage(
      userId,
      lang === 'ru'
        ? '✅ Уведомления о результатах матчей включены.'
        : '✅ Match result notifications are on.'
    );
    return;
  }

  const parts = data.split('|');
  if (parts.length < 3 || parts[0] !== 'PTF') return;

  const token = parts[1];
  const action = parts[2];
  const pending = cacheGetPending(userId, token);

  if (!pending) {
    await safeSendMessage(userId, 'Your selection session expired. Please send the result again in the Results topic.');
    return;
  }

  if (action === 'cancel') {
    cacheDeletePending(userId, token);
    await safeSendMessage(userId, 'Cancelled. Please delete the old message in Results and resend the match there when ready.');
    return;
  }

  if (action !== 'pair') return;

  const choiceIndex = Number(parts[3]);
  if (!Number.isInteger(choiceIndex)) {
    cacheDeletePending(userId, token);
    await safeSendMessage(userId, 'Invalid selection. Please resend the result again in the Results topic.');
    return;
  }

  const choice = pending.pairChoices?.[choiceIndex];
  const playersList = await getPlayersList();

  if (!choice?.p1 || !choice?.p2 || !playersList.includes(choice.p1) || !playersList.includes(choice.p2)) {
    cacheDeletePending(userId, token);
    await safeSendMessage(userId, 'This pair no longer matches Players_Master. Please resend the result again in the Results topic.');
    return;
  }

  await safeSendMessage(userId, `Pair selected:\n${choice.p1} vs ${choice.p2}`);
  await saveMatchAndNotify(userId, pending.chatId, pending.threadId, choice.p1, choice.p2, pending.parsed, pending.sourceMessage || null);
  cacheDeletePending(userId, token);
}

async function startInteractiveSelection(userId, chatId, threadId, parsed, playersList, aliasMap, r1, r2, sourceMessage=null) {
  const token = randomToken();
  const p1Options = buildPlayerOptionsForSelection(parsed.p1Raw, r1, playersList, aliasMap, SUGGESTIONS_LIMIT);
  const p2Options = buildPlayerOptionsForSelection(parsed.p2Raw, r2, playersList, aliasMap, SUGGESTIONS_LIMIT);

  if (p1Options.length === 0 && p2Options.length === 0) {
    await safeSendMessage(
      userId,
      `I couldn't confidently find either player:\nPlayer 1: "${parsed.p1Raw}"\nPlayer 2: "${parsed.p2Raw}"\n\nPlease delete the old message in the Results topic and resend the match there with full player names.`
    );
    return;
  }

  if (p1Options.length === 0) {
    await sendPlayerNotFoundMessage(userId, parsed.p1Raw);
    return;
  }

  if (p2Options.length === 0) {
    await sendPlayerNotFoundMessage(userId, parsed.p2Raw);
    return;
  }

  const pairChoices = buildPairChoices(p1Options, p2Options, PAIR_SUGGESTIONS_LIMIT);
  if (pairChoices.length === 0) {
    await safeSendMessage(
      userId,
      'I found possible names, but could not build a valid pair.\nPlease delete the old message in the Results topic and resend the match there with full player names.'
    );
    return;
  }

  cachePutPending(userId, token, {
    token,
    createdAt: Date.now(),
    chatId,
    threadId,
    userId,
    parsed,
    sourceMessage,
    step: 'pair',
    pairChoices
  });

  const title =
    `I couldn't confidently confirm the player names.\n` +
    `Please choose the correct pair by tapping a button:\n\n` +
    `Typed:\n${parsed.p1Raw} vs ${parsed.p2Raw}\n\nScore: ${formatScore(parsed)}`;

  await sendPairChoiceButtons(userId, title, token, pairChoices);
}

async function saveMatchAndNotify(userId, chatId, threadId, p1Name, p2Name, parsed, sourceMessage=null) {
  await debugLog('10 writing main match', { p1Name, p2Name, score: formatScore(parsed) });
  const mainMatchRow = await writeMatchRow(p1Name, p2Name, parsed);
  const mainMatchContext = await getMainMatchContext(mainMatchRow).catch(err => {
    debugLog('MAIN MATCH CONTEXT ERROR', stackDetails(err));
    return {};
  });
  await debugLog('11 main match written', { p1Name, p2Name, score: formatScore(parsed), row: mainMatchRow, mainMatchContext });

  const divisionWriteResult = await writeDivisionMatchRow(p1Name, p2Name, parsed, mainMatchContext);
  await markResultSavedWithReaction(chatId, sourceMessage);
  await queueResultBroadcast({ p1Name, p2Name, parsed, divisionWriteResult, sourceMessage, mainMatchContext });
}

async function markResultSavedWithReaction(chatId, sourceMessage) {
  const targetChatId = sourceMessage?.chat?.id || chatId;
  const messageId = sourceMessage?.message_id;
  if (!targetChatId || !messageId) {
    await debugLog('RESULT REACTION SKIPPED', { chatId: targetChatId, messageId });
    return;
  }

  const reactionEmojis = ['\u2705', '\u{1F44D}'];

  for (const emoji of reactionEmojis) {
    try {
      await setMessageReaction(targetChatId, messageId, emoji);
      await debugLog('RESULT REACTION SET', { chatId: targetChatId, messageId, emoji });
      return;
    } catch (err) {
      const error = stackDetails(err);
      await debugLog('RESULT REACTION ERROR', {
        chatId: targetChatId,
        messageId,
        emoji,
        error
      });

      if (!/REACTION_INVALID/i.test(error)) return;
    }
  }
}

async function queueResultBroadcast(payload) {
  if (!RESULTS_BROADCAST_ENABLED) return;

  const sourceMessage = attachNearbyStandalonePhoto(payload.sourceMessage);
  if (getResultPhoto(sourceMessage)) {
    await broadcastSavedResult({ ...payload, sourceMessage });
    return;
  }

  const key = resultMediaKey(sourceMessage);
  if (!key || RESULTS_MEDIA_WAIT_MS <= 0) {
    await broadcastSavedResult(payload);
    return;
  }

  const existing = pendingResultBroadcasts.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
    pendingResultBroadcasts.delete(key);
    await debugLog('RESULT MEDIA WAIT FLUSHED BY NEXT SCORE', {
      key,
      messageId: existing.payload.sourceMessage?.message_id
    });
    await broadcastSavedResult(existing.payload);
  }

  const timer = setTimeout(async () => {
    const pending = pendingResultBroadcasts.get(key);
    if (!pending || pending.timer !== timer) return;
    pendingResultBroadcasts.delete(key);
    try {
      await debugLog('RESULT MEDIA WAIT EXPIRED', {
        key,
        messageId: pending.payload.sourceMessage?.message_id,
        waitMs: RESULTS_MEDIA_WAIT_MS
      });
      await broadcastSavedResult(pending.payload);
    } catch (err) {
      await debugLog('RESULT DELAYED BROADCAST ERROR', stackDetails(err));
    }
  }, RESULTS_MEDIA_WAIT_MS);

  pendingResultBroadcasts.set(key, {
    payload: { ...payload, sourceMessage },
    createdAt: Date.now(),
    timer
  });
  await debugLog('RESULT WAITING FOR SEPARATE PHOTO', {
    key,
    messageId: sourceMessage?.message_id,
    waitMs: RESULTS_MEDIA_WAIT_MS,
    pairWindowMs: RESULTS_MEDIA_PAIR_WINDOW_MS
  });
}

async function handleStandaloneResultPhoto(msg) {
  const key = resultMediaKey(msg);
  const photo = getResultPhoto(msg);
  if (!key || !photo) return;

  cleanupRecentStandalonePhotos();
  const pending = pendingResultBroadcasts.get(key);
  if (pending && messagesAreNear(pending.payload.sourceMessage, msg)) {
    clearTimeout(pending.timer);
    pendingResultBroadcasts.delete(key);
    const sourceMessage = { ...pending.payload.sourceMessage, photo: msg.photo };
    await debugLog('RESULT SEPARATE PHOTO MATCHED AFTER SCORE', {
      key,
      scoreMessageId: pending.payload.sourceMessage?.message_id,
      photoMessageId: msg.message_id
    });
    await broadcastSavedResult({ ...pending.payload, sourceMessage });
    return;
  }

  recentStandalonePhotos.set(key, { message: msg, storedAt: Date.now() });
  await debugLog('RESULT STANDALONE PHOTO STORED', {
    key,
    photoMessageId: msg.message_id,
    pairWindowMs: RESULTS_MEDIA_PAIR_WINDOW_MS
  });
}

function attachNearbyStandalonePhoto(msg) {
  const key = resultMediaKey(msg);
  if (!key || getResultPhoto(msg)) return msg;
  cleanupRecentStandalonePhotos();
  const recent = recentStandalonePhotos.get(key);
  if (!recent || !messagesAreNear(msg, recent.message)) return msg;
  recentStandalonePhotos.delete(key);
  debugLog('RESULT SEPARATE PHOTO MATCHED BEFORE SCORE', {
    key,
    photoMessageId: recent.message.message_id,
    scoreMessageId: msg?.message_id
  });
  return { ...msg, photo: recent.message.photo };
}

function resultMediaKey(msg) {
  const chatId = msg?.chat?.id;
  const threadId = msg?.message_thread_id || 0;
  const userId = msg?.from?.id;
  if (!chatId || !userId) return '';
  return `${chatId}:${threadId}:${userId}`;
}

function messageTimeMs(msg) {
  const telegramTime = Number(msg?.date || 0);
  return telegramTime > 0 ? telegramTime * 1000 : Date.now();
}

function messagesAreNear(a, b) {
  return Math.abs(messageTimeMs(a) - messageTimeMs(b)) <= RESULTS_MEDIA_PAIR_WINDOW_MS;
}

function cleanupRecentStandalonePhotos() {
  const cutoff = Date.now() - RESULTS_MEDIA_PAIR_WINDOW_MS;
  for (const [key, item] of recentStandalonePhotos) {
    if (item.storedAt < cutoff) recentStandalonePhotos.delete(key);
  }
}

async function broadcastSavedResult({ p1Name, p2Name, parsed, divisionWriteResult, sourceMessage, mainMatchContext={} }) {
  if (!RESULTS_BROADCAST_ENABLED) return;

  const recipients = await getResultBroadcastContacts().catch(err => {
    debugLog('RESULT BROADCAST CONTACTS ERROR', stackDetails(err));
    return [];
  });
  if (!recipients.length) return;

  const broadcastId = randomToken();
  const scoreText = formatScoreForCard(parsed);
  const matchText = `${p1Name} vs ${p2Name}`;
  const media = getResultPhoto(sourceMessage);
  const mediaType = media ? 'photo' : 'text';
  const profileUrls = await getPlayerProfileUrlMap().catch(err => {
    debugLog('PLAYER PROFILE URLS ERROR', stackDetails(err));
    return new Map();
  });

  await debugLog('RESULT BROADCAST START', {
    broadcastId,
    recipients: recipients.length,
    match: matchText,
    score: scoreText,
    mediaType
  });

  for (const recipient of recipients) {
    const lang = recipient.language === 'ru' ? 'ru' : 'en';
    const card = buildResultCardData({ p1Name, p2Name, parsed, divisionWriteResult, mainMatchContext });
    const winnerUrl = profileUrls.get(norm(card.winnerName)) || '';
    const loserUrl = profileUrls.get(norm(card.loserName)) || '';
    const text = buildResultCardText({ card, winnerUrl, loserUrl, lang });
    const opts = {
      reply_markup: {
        inline_keyboard: [[{
          text: lang === 'ru' ? 'Не присылать результаты матчей' : 'Stop match results',
          callback_data: 'RESNOTIFY|off'
        }]]
      }
    };

    const tableUrl = getDivisionTableUrl(divisionWriteResult, mainMatchContext);
    opts.reply_markup.inline_keyboard = buildResultKeyboard({ lang, tableUrl, card, winnerUrl, loserUrl });

    try {
      if (media) await sendPhoto(recipient.telegram_id, media.file_id, { caption: text, ...opts });
      else await sendMessage(recipient.telegram_id, text, opts);

      await logResultBroadcast({
        broadcast_id: broadcastId,
        created_at: nowISOForResults(),
        telegram_id: recipient.telegram_id,
        name: recipient.name,
        telegram_username: recipient.telegram_username,
        language: lang,
        source: (recipient.sources || []).join(', '),
        match: matchText,
        score: scoreText,
        media_type: mediaType,
        status: 'sent',
        error: ''
      });
    } catch (err) {
      const message = String(err?.message || err);
      if (/bot was blocked|Forbidden/i.test(message)) {
        await markTelegramBlocked(recipient.telegram_id, message).catch(e => debugLog('MARK BLOCKED ERROR', stackDetails(e)));
      }
      await logResultBroadcast({
        broadcast_id: broadcastId,
        created_at: nowISOForResults(),
        telegram_id: recipient.telegram_id,
        name: recipient.name,
        telegram_username: recipient.telegram_username,
        language: lang,
        source: (recipient.sources || []).join(', '),
        match: matchText,
        score: scoreText,
        media_type: mediaType,
        status: 'failed',
        error: message
      }).catch(e => debugLog('RESULT BROADCAST LOG ERROR', stackDetails(e)));
    }

    await delay(RESULTS_BROADCAST_DELAY_MS);
  }
}

function buildResultBroadcastText(lang, { p1Name, p2Name, scoreText, divisionWriteResult }) {
  const division =
    divisionWriteResult?.status === 'saved'
      ? `Division ${divisionWriteResult.division}`
      : divisionWriteResult?.status === 'cross_division'
        ? 'Cross-division match'
        : '';

  if (lang === 'ru') {
    return [
      '<b>Результат матча</b>',
      division,
      `${escapeHtmlLocal(p1Name)} vs ${escapeHtmlLocal(p2Name)}`,
      `Счёт: <b>${escapeHtmlLocal(scoreText)}</b>`
    ].filter(Boolean).join('\n');
  }

  return [
    '<b>Match result</b>',
    division,
    `${escapeHtmlLocal(p1Name)} vs ${escapeHtmlLocal(p2Name)}`,
    `Score: <b>${escapeHtmlLocal(scoreText)}</b>`
  ].filter(Boolean).join('\n');
}

function getResultPhoto(msg) {
  if (!msg?.photo?.length) return null;
  return msg.photo[msg.photo.length - 1];
}

function looksLikeMatchSubmission(text) {
  const s = String(text || '').trim();
  if (!s) return false;

  const scoreCount = countScoreLikeTokens(s);
  if (scoreCount >= 2) return /\p{L}/u.test(s);

  if (scoreCount === 1) {
    const hasNameSeparator = /\bvs\b|\bv\b|\bagainst\b|\s[-—]\s/i.test(s);
    const hasDivision = /\b(?:div|division)\s+(?:prime|a|b|c|d)\b/i.test(s);
    return /\p{L}/u.test(s) && (hasNameSeparator || hasDivision);
  }

  return false;
}

function countScoreLikeTokens(text) {
  const scoreRegex = /(\d{1,2})\s*[:\-\/]\s*(\d{1,2})(?:\s*[\(\[]\s*(\d{1,2})\s*[:\-\/]\s*(\d{1,2})\s*[\)\]])?/g;
  return [...String(text || '').matchAll(scoreRegex)].length;
}

function buildResultCardText({ card, winnerUrl, loserUrl, lang }) {
  const lines = [
    `<b>${lang === 'ru' ? '🎾 Результат матча' : '🎾 Match Result'}</b>`,
    escapeHtmlLocal(formatDivisionSeasonTitle(card, lang))
  ];
  const stageLabel = formatResultStage(card.stage, lang);
  if (stageLabel) lines.push(`<b>${escapeHtmlLocal(stageLabel)}</b>`);
  lines.push(
    '',
    `${formatPlayerLink(card.winnerName, winnerUrl)} ${escapeHtmlLocal(card.scoreText)} ${formatPlayerLink(card.loserName, loserUrl)}`
  );
  return lines.join('\n');
}

function formatResultStage(stage, lang) {
  const normalized = normalizeStageHint(stage);
  if (!normalized || normalized === 'group') return '';

  if (lang === 'ru') {
    if (normalized === 'semifinal') return 'Полуфинал';
    if (normalized === 'final') return 'Финал';
    if (normalized === 'playoff') return 'Плей-офф';
  }

  if (normalized === 'semifinal') return 'Semifinal';
  if (normalized === 'final') return 'Final';
  if (normalized === 'playoff') return 'Playoff';
  return '';
}

function buildResultKeyboard({ lang, tableUrl, card, winnerUrl, loserUrl }) {
  const rows = [];
  const profileRow = [];
  if (winnerUrl) {
    profileRow.push({
      text: `🏆 ${lang === 'ru' ? 'Профиль' : 'Profile'} ${shortPlayerName(card.winnerName)}`,
      url: winnerUrl
    });
  }
  if (loserUrl) {
    profileRow.push({
      text: `👤 ${lang === 'ru' ? 'Профиль' : 'Profile'} ${shortPlayerName(card.loserName)}`,
      url: loserUrl
    });
  }
  if (profileRow.length) rows.push(profileRow);

  const actionRow = [];
  if (tableUrl) {
    actionRow.push({
      text: lang === 'ru' ? '📊 Таблица' : '📊 Standings',
      url: tableUrl
    });
  }
  actionRow.push({
    text: lang === 'ru' ? '🔕 Не присылать' : '🔕 Stop results',
    callback_data: 'RESNOTIFY|off'
  });
  rows.push(actionRow);

  return rows;
}

function buildResultCardData({ p1Name, p2Name, parsed, divisionWriteResult, mainMatchContext={} }) {
  const validation = validateMatchScore(parsed);
  const p1Won = validation.ok && validation.winner === 'p1';
  const winnerName = p1Won ? p1Name : p2Name;
  const loserName = p1Won ? p2Name : p1Name;
  const winnerPerspectiveScore = p1Won ? parsed : reverseParsedScore(parsed);
  const division = mainMatchContext.division || (divisionWriteResult?.status === 'saved' ? divisionWriteResult.division : '');
  const competition = parseCompetition(mainMatchContext.competition);
  const seasonName = competition.seasonName || divisionWriteResult?.season || RESULTS.seasonName;
  const title = division
    ? `Division ${division} ${seasonName}`
    : `Cross-Division ${seasonName}`;

  return {
    title,
    division,
    seasonName,
    stage: competition.stage || mainMatchContext.format || divisionWriteResult?.stage || RESULTS.defaultStage || 'Group Stage',
    dateText: formatMatchDateForCard(mainMatchContext.matchDate),
    winnerName,
    loserName,
    scoreText: formatScoreForCard(winnerPerspectiveScore)
  };
}

function formatDivisionSeasonTitle(card, lang) {
  const seasonName = lang === 'ru' ? localizeSeasonName(card.seasonName, lang) : card.seasonName;
  if (!card.division) {
    return lang === 'ru'
      ? `Междивизионный матч ${seasonName}`
      : `Cross-Division ${seasonName}`;
  }

  return lang === 'ru'
    ? `Дивизион ${card.division} ${seasonName}`
    : `Division ${card.division} ${seasonName}`;
}

function localizeSeasonName(seasonName, lang) {
  const raw = String(seasonName || RESULTS.seasonName || '').trim();
  if (lang !== 'ru') return raw;
  const match = raw.match(/\bseason\s*(\d+)\b/i);
  return match ? `Сезон ${match[1]}` : raw;
}

function shortPlayerName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Player';
}

async function getMainMatchContext(row) {
  if (!row) return {};
  const values = await getValues(RESULTS.sheetId, `${RESULTS.logSheetName}!B${row}:J${row}`);
  const data = values[0] || [];
  const p1Division = String(data[COL_P1_DIVISION - COL_MATCH_DATE] || '').trim().toUpperCase();
  const p2Division = String(data[COL_P2_DIVISION - COL_MATCH_DATE] || '').trim().toUpperCase();
  return {
    matchDate: data[0] || '',
    format: String(data[1] || '').trim(),
    competition: String(data[2] || '').trim(),
    p1Division,
    p2Division,
    division: p1Division && p1Division === p2Division ? p1Division : '',
    p1Name: String(data[COL_P1_NAME - COL_MATCH_DATE] || '').trim(),
    p2Name: String(data[COL_P2_NAME - COL_MATCH_DATE] || '').trim()
  };
}

function parseCompetition(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};

  const seasonNumberMatch = raw.match(/\b(?:season|s)\s*(\d+)\b/i);
  const seasonName = seasonNumberMatch ? `Season ${seasonNumberMatch[1]}` : raw;

  if (/semi[-\s]?finals?/i.test(raw)) return { seasonName, stage: 'Semifinal' };
  if (/\bfinals?\b/i.test(raw)) return { seasonName, stage: 'Final' };
  if (/play[-\s]?off/i.test(raw)) return { seasonName, stage: 'Playoff' };
  if (/season/i.test(raw)) return { seasonName, stage: 'Group Stage' };

  return { seasonName, stage: RESULTS.defaultStage || 'Group Stage' };
}

function getDivisionTableUrl(divisionWriteResult, mainMatchContext={}) {
  const division = String(
    mainMatchContext.division ||
    (divisionWriteResult?.status === 'saved' ? divisionWriteResult.division : '')
  ).trim().toUpperCase();
  if (!division) return '';
  return RESULTS.divisionUrls?.[division] || '';
}

function formatResultDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: RESULTS.localTimezone,
    day: 'numeric',
    month: 'long'
  }).format(date);
}

function formatMatchDateForCard(value) {
  const raw = String(value || '').trim();
  if (!raw) return formatResultDate(new Date());

  const dotMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return formatResultDate(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return formatResultDate(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
  }

  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 20000) {
    return formatResultDate(new Date((serial - 25569) * 86400000));
  }

  return raw;
}

function formatPlayerLink(name, url) {
  if (!url) return `<b>${escapeHtmlLocal(name)}</b>`;
  return `<b><a href="${escapeHtmlLocal(url)}">${escapeHtmlLocal(name)}</a></b>`;
}

async function getPlayerProfileUrlMap() {
  const now = Date.now();
  if (playerProfileUrlCache.expiresAt > now) return playerProfileUrlCache.map;

  const map = new Map();
  if (!RESULTS.playerProfilesSpreadsheetId) {
    playerProfileUrlCache = { expiresAt: now + 10 * 60 * 1000, map };
    return map;
  }

  const values = await getValues(
    RESULTS.playerProfilesSpreadsheetId,
    `${RESULTS.playerProfilesSheetName}!A1:Z`
  );
  const headers = values[0] || [];
  const nameIndex = findHeaderIndex(headers, ['player name', 'name']);
  const urlIndex = findHeaderIndex(headers, ['profile url by name', 'profile url by id', 'profile url', 'url']);

  if (nameIndex < 0 || urlIndex < 0) {
    playerProfileUrlCache = { expiresAt: now + 10 * 60 * 1000, map };
    return map;
  }

  for (const row of values.slice(1)) {
    const name = String(row[nameIndex] || '').trim();
    const url = normalizeWebsiteUrl(row[urlIndex]);
    if (name && url) map.set(norm(name), url);
  }

  playerProfileUrlCache = { expiresAt: now + 10 * 60 * 1000, map };
  return map;
}

function findHeaderIndex(headers, names) {
  const normalized = headers.map(h => norm(h));
  for (const name of names.map(norm)) {
    const index = normalized.findIndex(h => h === name || h.includes(name));
    if (index >= 0) return index;
  }
  return -1;
}

function normalizeWebsiteUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `${RESULTS.websiteBaseUrl}${s}`;
  return `${RESULTS.websiteBaseUrl}/${s.replace(/^\/+/, '')}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowISOForResults() {
  return new Date().toISOString();
}

function escapeHtmlLocal(s='') {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function writeMatchRow(p1NameExact, p2NameExact, parsed) {
  if (!p1NameExact || !p2NameExact) throw new Error('Cannot write match: missing player name.');
  const scoreValidation = validateMatchScore(parsed);
  if (!scoreValidation.ok) throw new Error(`Cannot write match: ${scoreValidation.message}`);

  const row = await getNextEmptyRow(RESULTS.sheetId, RESULTS.logSheetName, COL_P1_NAME, DATA_START_ROW);
  const dateSerial = getLocalDateSerial();
  const set3Mode = detectSet3Mode(parsed);

  await batchUpdateValues(RESULTS.sheetId, [
    { range: `${RESULTS.logSheetName}!B${row}`, values: [[dateSerial]] },
    { range: `${RESULTS.logSheetName}!I${row}:J${row}`, values: [[p1NameExact, p2NameExact]] },
    { range: `${RESULTS.logSheetName}!K${row}:V${row}`, values: [scoreValues(parsed).map(coerceNumber)] },
    { range: `${RESULTS.logSheetName}!W${row}:X${row}`, values: [[set3Mode, 'Yes']] }
  ]);

  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: RESULTS.sheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: await getSheetId(RESULTS.sheetId, RESULTS.logSheetName),
            startRowIndex: row - 1,
            endRowIndex: row,
            startColumnIndex: 1,
            endColumnIndex: 2
          },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd.MM.yyyy' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      }]
    }
  });

  return row;
}

async function writeDivisionMatchRow(p1Name, p2Name, parsed, mainMatchContext={}) {
  try {
    const playersIndex = await getPlayersIndex();
    const p1 = playersIndex[norm(p1Name)];
    const p2 = playersIndex[norm(p2Name)];
    if (!p1 || !p2) return { status: 'player_not_found' };

    const div1 = String(p1.division || '').trim().toUpperCase();
    const div2 = String(p2.division || '').trim().toUpperCase();
    if (!div1 || !div2 || div1 !== div2) return { status: 'cross_division', div1, div2 };

    const config = RESULTS.divisionSpreadsheets[div1];
    if (!config?.spreadsheetId) return { status: 'config_missing', division: div1 };

    const rowInfo = await findDivisionMatchRow(config.spreadsheetId, config.sheetName, p1Name, p2Name, mainMatchContext);
    if (!rowInfo) return { status: 'not_found', division: div1 };

    await writeDivisionScoreToRow(config.spreadsheetId, config.sheetName, rowInfo.row, parsed, rowInfo.reversed);
    await debugLog('DIVISION MATCH WRITTEN', {
      division: div1,
      row: rowInfo.row,
      reversed: rowInfo.reversed,
      completedBeforeWrite: rowInfo.completed,
      selectedReason: rowInfo.selectedReason,
      p1Name,
      p2Name,
      score: formatScore(parsed)
    });
    return {
      status: 'saved',
      division: div1,
      row: rowInfo.row,
      reversed: rowInfo.reversed,
      stage: rowInfo.stage || RESULTS.defaultStage,
      season: rowInfo.season || RESULTS.seasonName
    };
  } catch (err) {
    await debugLog('DIVISION WRITE ERROR', stackDetails(err));
    return { status: 'error', message: err.message };
  }
}

async function findDivisionMatchRow(spreadsheetId, sheetName, p1Name, p2Name, mainMatchContext={}) {
  const values = await getValues(spreadsheetId, `${sheetName}!A1:AD`);
  const headers = values[0] || [];
  const p1HeaderIndex = findHeaderIndex(headers, ['player 1']);
  const p2HeaderIndex = findHeaderIndex(headers, ['player 2']);
  const p1Index = p1HeaderIndex >= 0 ? p1HeaderIndex : 2;
  const p2Index = p2HeaderIndex >= 0 ? p2HeaderIndex : 4;
  const completedIndex = findHeaderIndex(headers, ['completed', 'complete']);
  const stageIndex = findHeaderIndex(headers, ['stage', 'round', 'phase']);
  const seasonIndex = findHeaderIndex(headers, ['season']);
  const stageHint = normalizeStageHint(mainMatchContext.competition || mainMatchContext.format || '');
  const targetP1 = norm(p1Name);
  const targetP2 = norm(p2Name);
  const candidates = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;
    const sheetP1 = norm(row[p1Index]);
    const sheetP2 = norm(row[p2Index]);
    const metadata = {
      row: rowNumber,
      stage: stageIndex >= 0 ? String(row[stageIndex] || '').trim() : '',
      season: seasonIndex >= 0 ? String(row[seasonIndex] || '').trim() : '',
      completed: isDivisionRowCompleted(row, completedIndex)
    };
    if (sheetP1 === targetP1 && sheetP2 === targetP2) candidates.push({ ...metadata, reversed: false });
    if (sheetP1 === targetP2 && sheetP2 === targetP1) candidates.push({ ...metadata, reversed: true });
  }

  if (candidates.length === 0) return null;

  const stageCandidates =
    stageHint && stageIndex >= 0
      ? candidates.filter(candidate => normalizeStageHint(candidate.stage) === stageHint)
      : [];
  const pool = stageCandidates.length ? stageCandidates : candidates;
  const openCandidate = pool.find(candidate => !candidate.completed);

  if (openCandidate) {
    return {
      ...openCandidate,
      selectedReason: stageCandidates.length ? 'stage_open_row' : 'open_row'
    };
  }

  const fallbackCandidate = isPlayoffStage(stageHint) ? pool[pool.length - 1] : pool[0];
  return {
    ...fallbackCandidate,
    selectedReason: isPlayoffStage(stageHint) ? 'playoff_last_completed_match' : 'first_completed_match'
  };
}

function isDivisionRowCompleted(row, completedIndex) {
  if (completedIndex < 0) return false;
  return /^(yes|true|done|completed)$/i.test(String(row[completedIndex] || '').trim());
}

function normalizeStageHint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/semi[-\s]?finals?/i.test(raw)) return 'semifinal';
  if (/\bfinals?\b/i.test(raw)) return 'final';
  if (/play[-\s]?off/i.test(raw)) return 'playoff';
  if (/group/i.test(raw) || /season/i.test(raw)) return 'group';
  return '';
}

function isPlayoffStage(stage) {
  return ['semifinal', 'final', 'playoff'].includes(stage);
}

async function writeDivisionScoreToRow(spreadsheetId, sheetName, row, parsed, reversed) {
  const p = reversed ? reverseParsedScore(parsed) : parsed;
  await batchUpdateValues(spreadsheetId, [
    { range: `${sheetName}!F${row}:Q${row}`, values: [scoreValues(p).map(coerceNumber)] },
    { range: `${sheetName}!R${row}:S${row}`, values: [[detectSet3Mode(p), 'Yes']] }
  ]);
}

function parseMatchMessageV2(text) {
  const originalText = String(text || '');
  const scoreRegex = /(\d{1,2})\s*[:\-\/]\s*(\d{1,2})(?:\s*[\(\[]\s*(\d{1,2})\s*[:\-\/]\s*(\d{1,2})\s*[\)\]])?/g;
  const scores = [];
  let match;

  while ((match = scoreRegex.exec(originalText)) !== null) {
    scores.push({ p1: match[1], p2: match[2], tb1: match[3] || '', tb2: match[4] || '' });
  }
  if (scores.length === 0) return { hasScore: false };

  const cleaned = normalizeMessageText(chooseNameParsingText(originalText));
  scoreRegex.lastIndex = 0;

  let firstScoreIndex = -1;
  let lastScoreEnd = -1;
  while ((match = scoreRegex.exec(cleaned)) !== null) {
    if (firstScoreIndex === -1) firstScoreIndex = match.index;
    lastScoreEnd = match.index + match[0].length;
  }

  let p1Raw = '';
  let p2Raw = '';
  const beforeFirstScore = firstScoreIndex >= 0 ? cleaned.slice(0, firstScoreIndex).trim() : '';
  let afterLastScore = lastScoreEnd >= 0 ? cleaned.slice(lastScoreEnd).trim() : '';
  afterLastScore = cleanTrailingComments(afterLastScore);
  const explicitSepRegex = /\s+\bvs\b\s+|\s+\bv\b\s+|\s+against\s+|\s+[-—]\s+|[-—]/i;

  if (explicitSepRegex.test(beforeFirstScore)) {
    const parts = beforeFirstScore.split(explicitSepRegex).map(s => s.trim()).filter(Boolean);
    p1Raw = parts[0] || '';
    p2Raw = parts[1] || '';
  } else if (beforeFirstScore && afterLastScore) {
    p1Raw = beforeFirstScore;
    p2Raw = afterLastScore;
  } else {
    let namesOnly = cleaned.replace(scoreRegex, ' ').replace(/[(){}\[\],/]/g, ' ').replace(/\s+/g, ' ').trim();
    namesOnly = cleanTrailingComments(namesOnly);
    const parts = namesOnly.split(explicitSepRegex).map(s => s.trim()).filter(Boolean);

    if (parts.length >= 2) {
      p1Raw = parts[0];
      p2Raw = parts[1];
    } else {
      const tokens = namesOnly.split(' ').map(t => t.trim()).filter(t => t.length > 1);
      if (tokens.length >= 4) {
        p1Raw = tokens.slice(0, 2).join(' ');
        p2Raw = tokens.slice(2).join(' ');
      } else if (tokens.length === 3) {
        p1Raw = tokens[0];
        p2Raw = tokens.slice(1).join(' ');
      } else if (tokens.length === 2) {
        p1Raw = tokens[0];
        p2Raw = tokens[1];
      } else {
        p1Raw = tokens[0] || 'Unknown';
        p2Raw = 'Unknown';
      }
    }
  }

  return {
    hasScore: true,
    p1Raw: sanitizeName(p1Raw),
    p2Raw: sanitizeName(p2Raw),
    s1p1: scores[0]?.p1 || '',
    s1p2: scores[0]?.p2 || '',
    s1tb1: scores[0]?.tb1 || '',
    s1tb2: scores[0]?.tb2 || '',
    s2p1: scores[1]?.p1 || '',
    s2p2: scores[1]?.p2 || '',
    s2tb1: scores[1]?.tb1 || '',
    s2tb2: scores[1]?.tb2 || '',
    s3p1: scores[2]?.p1 || '',
    s3p2: scores[2]?.p2 || '',
    s3tb1: scores[2]?.tb1 || '',
    s3tb2: scores[2]?.tb2 || ''
  };
}

function normalizeMessageText(text) {
  return String(text || '')
    .replace(/Div\s+(PRIME|A|B|C|D)/gi, ' ')
    .replace(/Division\s+(PRIME|A|B|C|D)/gi, ' ')
    .replace(/[🔥👏🎾✅🏆🥇🥈🥉❤️💙👍🤝⭐🌟🏠🧰🧳🥰💋😱🤣]/gu, ' ')
    .replace(/\bwas unstoppable\b/gi, ' ')
    .replace(/\bamazing tennis\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chooseNameParsingText(text) {
  const lineScoreRegex = /(\d{1,2})\s*[:\-\/]\s*(\d{1,2})(?:\s*[\(\[]\s*(\d{1,2})\s*[:\-\/]\s*(\d{1,2})\s*[\)\]])?/g;
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let bestLine = '';
  let bestScoreCount = 0;

  for (const line of lines) {
    lineScoreRegex.lastIndex = 0;
    const matches = line.match(lineScoreRegex);
    const scoreCount = matches ? matches.length : 0;
    if (scoreCount > bestScoreCount) {
      bestScoreCount = scoreCount;
      bestLine = line;
    }
  }

  if (bestScoreCount >= 2 && /\p{L}/u.test(bestLine)) return bestLine;
  return text;
}

function cleanTrailingComments(s) {
  return String(s || '')
    .trim()
    .replace(/\bgame\b.*$/i, ' ')
    .replace(/\bmatch\b.*$/i, ' ')
    .replace(/\bwin\b.*$/i, ' ')
    .replace(/\bwinner\b.*$/i, ' ')
    .replace(/\([^)]*\)$/g, ' ')
    .replace(/[(){}\[\],/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeName(s) {
  return String(s || '')
    .replace(/\s*[\(\[]\s*(?:w|win|winner|won|l|loss|lost)\s*[\)\]]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, '')
    .trim();
}

function validateMatchScore(p) {
  const sets = getSets(p);
  if (sets.length < 2) return { ok: false, message: 'A completed match must include at least two sets.' };
  if (sets.length > 3) return { ok: false, message: 'A match cannot have more than three sets.' };

  const first = classifyNormalSet(sets[0]);
  const second = classifyNormalSet(sets[1]);
  if (!first.ok) return { ok: false, message: `Set 1 is invalid: ${first.message}` };
  if (!second.ok) return { ok: false, message: `Set 2 is invalid: ${second.message}` };

  const p1SetsAfterTwo = (first.winner === 'p1' ? 1 : 0) + (second.winner === 'p1' ? 1 : 0);
  const p2SetsAfterTwo = (first.winner === 'p2' ? 1 : 0) + (second.winner === 'p2' ? 1 : 0);

  if (p1SetsAfterTwo === 2 || p2SetsAfterTwo === 2) {
    if (sets.length > 2) return { ok: false, message: 'The match is already finished after two sets, but a third set was also provided.' };
    return { ok: true, winner: p1SetsAfterTwo === 2 ? 'p1' : 'p2', set3Mode: '' };
  }

  if (p1SetsAfterTwo === 1 && p2SetsAfterTwo === 1) {
    if (sets.length < 3) return { ok: false, message: 'The match is tied 1-1 after two sets. Please add the 3rd set or match tie-break.' };
    const third = classifyThirdSet(sets[2]);
    if (!third.ok) return { ok: false, message: `Set 3 is invalid: ${third.message}` };
    return { ok: true, winner: third.winner, set3Mode: third.mode };
  }

  return { ok: false, message: 'The match score is not complete.' };
}

function getSets(p) {
  const sets = [];
  if (p.s1p1 !== '' && p.s1p2 !== '') sets.push({ a: Number(p.s1p1), b: Number(p.s1p2), tba: p.s1tb1, tbb: p.s1tb2 });
  if (p.s2p1 !== '' && p.s2p2 !== '') sets.push({ a: Number(p.s2p1), b: Number(p.s2p2), tba: p.s2tb1, tbb: p.s2tb2 });
  if (p.s3p1 !== '' && p.s3p2 !== '') sets.push({ a: Number(p.s3p1), b: Number(p.s3p2), tba: p.s3tb1, tbb: p.s3tb2 });
  return sets;
}

function classifyNormalSet(set) {
  const { a, b } = set;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, message: 'Set score contains non-numeric values.' };
  if (a > 15 || b > 15) return { ok: false, message: 'This looks like time or an invalid tennis score, not a set score.' };
  if (a === b) return { ok: false, message: 'A completed set cannot end with equal games.' };

  const max = Math.max(a, b);
  const min = Math.min(a, b);
  const winner = a > b ? 'p1' : 'p2';
  const isRegularSix = max === 6 && min >= 0 && min <= 4;
  const isSevenFive = max === 7 && min === 5;
  const isSevenSix = max === 7 && min === 6;

  if (!isRegularSix && !isSevenFive && !isSevenSix) {
    return { ok: false, message: `Invalid set score ${a}-${b}. Allowed examples: 6-4, 7-5, 7-6.` };
  }

  if (isSevenSix) {
    const tbValidation = validateTieBreak(set, winner, 7);
    if (!tbValidation.ok) return tbValidation;
  }

  return { ok: true, winner };
}

function classifyThirdSet(set) {
  const { a, b } = set;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, message: 'Set score contains non-numeric values.' };
  if (a >= 10 || b >= 10) return classifyMatchTieBreak(set);
  const normal = classifyNormalSet(set);
  if (!normal.ok) return normal;
  return { ok: true, winner: normal.winner, mode: 'Full Set' };
}

function classifyMatchTieBreak(set) {
  const { a, b } = set;
  if (a === b) return { ok: false, message: 'A match tie-break cannot end with equal points.' };
  const max = Math.max(a, b);
  const min = Math.min(a, b);
  const winner = a > b ? 'p1' : 'p2';
  if (max < 10) return { ok: false, message: 'A match tie-break winner must have at least 10 points.' };
  if (max - min < 2) return { ok: false, message: 'A match tie-break must be won by 2 points.' };
  if (max > 30) return { ok: false, message: 'This looks too high for a match tie-break. Please check the score.' };
  return { ok: true, winner, mode: 'Match TB' };
}

function validateTieBreak(set, setWinner, minWinningPoints) {
  if (set.tba === '' && set.tbb === '') return { ok: true };
  if (set.tba === '' || set.tbb === '') return { ok: false, message: 'Tie-break score is incomplete.' };
  const tba = Number(set.tba);
  const tbb = Number(set.tbb);
  if (!Number.isFinite(tba) || !Number.isFinite(tbb)) return { ok: false, message: 'Tie-break score contains non-numeric values.' };
  if (tba === tbb) return { ok: false, message: 'A tie-break cannot end with equal points.' };

  const tbWinner = tba > tbb ? 'p1' : 'p2';
  const max = Math.max(tba, tbb);
  const min = Math.min(tba, tbb);
  if (tbWinner !== setWinner) return { ok: false, message: 'Tie-break winner does not match set winner.' };
  if (max < minWinningPoints) return { ok: false, message: 'Tie-break winner has too few points.' };
  if (max - min < 2) return { ok: false, message: 'Tie-break must be won by 2 points.' };
  return { ok: true };
}

function resolvePlayer(raw, playersList, aliasMap) {
  raw = sanitizeName(raw);
  if (!raw || raw === 'Unknown') return { name: null, method: 'none', score: 0, needsConfirmation: false, conflict: false };
  const normRaw = norm(raw);

  for (const p of playersList) {
    if (norm(p) === normRaw) return { name: p, method: 'exact', score: 100, needsConfirmation: false, conflict: false };
  }

  if (aliasMap[normRaw]?.length === 1) return { name: aliasMap[normRaw][0], method: 'alias', score: 100, needsConfirmation: false, conflict: false };
  if (aliasMap[normRaw]?.length > 1) return { name: null, method: 'alias_conflict', score: 100, needsConfirmation: true, conflict: true };

  const ranked = rankCandidates(raw, playersList);
  if (ranked.length === 0) return { name: null, method: 'none', score: 0, needsConfirmation: false, conflict: false };

  const best = ranked[0];
  const second = ranked[1] || null;
  const hasCloseCompetitor = second && second.score >= 70 && best.score - second.score <= 15;

  if (best.score >= 95 && !hasCloseCompetitor) return { name: best.name, method: 'strong_fuzzy', score: best.score, needsConfirmation: false, conflict: false };
  if (best.score >= 70) return { name: best.name, method: hasCloseCompetitor ? 'fuzzy_conflict' : 'weak_fuzzy', score: best.score, needsConfirmation: true, conflict: Boolean(hasCloseCompetitor) };
  return { name: null, method: 'low_confidence', score: best.score, needsConfirmation: false, conflict: false };
}

function buildPlayerOptionsForSelection(raw, resolved, playersList, aliasMap, limit) {
  if (resolved?.name && !resolved.needsConfirmation && !resolved.conflict) return [resolved.name];
  const options = [];
  if (resolved?.name) options.push(resolved.name);
  for (const name of buildSuggestions(raw, playersList, aliasMap, limit)) {
    if (!options.includes(name)) options.push(name);
  }
  return options.slice(0, limit);
}

function buildSuggestions(raw, playersList, aliasMap, limit) {
  raw = sanitizeName(raw);
  const nr = norm(raw);
  const suggestions = [];
  if (aliasMap[nr]) {
    for (const name of aliasMap[nr]) if (!suggestions.includes(name)) suggestions.push(name);
  }
  const ranked = rankCandidates(raw, playersList)
    .filter(x => x.score >= SUGGESTION_MIN_SCORE)
    .map(x => x.name)
    .filter(name => !suggestions.includes(name));
  return suggestions.concat(ranked).slice(0, limit);
}

function rankCandidates(raw, playersList) {
  raw = sanitizeName(raw);
  const nr = norm(raw);
  const out = [];

  for (const p of playersList) {
    const np = norm(p);
    let score = 0;
    if (np === nr) score = 100;
    else if (np.startsWith(nr) || nr.startsWith(np)) score = 90;
    else if (np.includes(nr) || nr.includes(np)) score = 80;
    else score = Math.max(tokenOverlapScore(nr, np), typoSimilarityScore(nr, np));

    const rawTokens = nr.split(' ').filter(Boolean);
    const pTokens = np.split(' ').filter(Boolean);
    for (const rawToken of rawTokens) {
      for (const playerToken of pTokens) {
        score = Math.max(score, typoSimilarityScore(rawToken, playerToken));
      }
    }

    if (rawTokens.length && pTokens.length && rawTokens[0] === pTokens[0]) score += 12;
    if (rawTokens.length && pTokens.length && rawTokens.at(-1) === pTokens.at(-1)) score += 10;

    if (rawTokens.length >= 2 && pTokens.length >= 2) {
      const firstMatches = pTokens[0].startsWith(rawTokens[0]) || rawTokens[0].startsWith(pTokens[0].slice(0, Math.min(3, pTokens[0].length)));
      const secondInitialMatches = rawTokens[1].length === 1 && pTokens[1].startsWith(rawTokens[1]);
      if (firstMatches && secondInitialMatches) score += 35;
    }

    if (score > 0) out.push({ name: p, score });
  }

  return out.sort((a, b) => b.score - a.score);
}

function buildPairChoices(p1Options, p2Options, limit) {
  const choices = [];
  for (const p1 of p1Options) {
    for (const p2 of p2Options) {
      if (!p1 || !p2 || p1 === p2) continue;
      choices.push({ p1, p2 });
      if (choices.length >= limit) return choices;
    }
  }
  return choices;
}

async function getPlayersList() {
  const values = await getValues(RESULTS.sheetId, `${RESULTS.masterSheetName}!B${MASTER_START_ROW}:B`);
  return values.flat().map(v => String(v).trim()).filter(Boolean);
}

async function getPlayersIndex() {
  const values = await getValues(RESULTS.sheetId, `${RESULTS.masterSheetName}!A${MASTER_START_ROW}:C`);
  const index = {};
  for (const row of values) {
    const id = row[0];
    const name = String(row[1] || '').trim();
    const division = String(row[2] || '').trim();
    if (name) index[norm(name)] = { id, name, division };
  }
  return index;
}

async function getPlayerAliases(playersList) {
  const aliasMap = {};
  const values = await getValues(RESULTS.sheetId, `${RESULTS.aliasesSheetName}!A${ALIAS_START_ROW}:B`);

  for (let idx = 0; idx < values.length; idx++) {
    const row = values[idx];
    const rowNumber = ALIAS_START_ROW + idx;
    const playerName = String(row[0] || '').trim();
    const aliasesCell = String(row[1] || '').trim();
    if (!playerName || !aliasesCell) continue;

    const exactPlayer = playersList.find(p => norm(p) === norm(playerName));
    if (!exactPlayer) {
      await debugLog('ALIAS PLAYER NOT FOUND', { rowNumber, playerName, aliasesCell });
      continue;
    }

    aliasesCell.split(/[,;|\n\r]+/).map(a => sanitizeName(a)).filter(Boolean).forEach(alias => {
      const key = norm(alias);
      if (!key) return;
      if (!aliasMap[key]) aliasMap[key] = [];
      if (!aliasMap[key].includes(exactPlayer)) aliasMap[key].push(exactPlayer);
    });
  }

  for (const key of Object.keys(aliasMap)) {
    if (aliasMap[key].length > 1) await debugLog('ALIAS CONFLICT', { alias: key, players: aliasMap[key] });
  }

  return aliasMap;
}

async function getNextEmptyRow(spreadsheetId, sheetName, col, startRow) {
  const letter = colToLetter(col);
  const values = await getValues(spreadsheetId, `${sheetName}!${letter}${startRow}:${letter}`);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i]?.[0] || '').trim() === '') return startRow + i;
  }
  return startRow + values.length;
}

async function getValues(spreadsheetId, range) {
  const res = await sheets().spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function batchUpdateValues(spreadsheetId, data) {
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data }
  });
}

async function getSheetId(spreadsheetId, title) {
  const key = `${spreadsheetId}:${title}`;
  if (sheetIdCache.has(key)) return sheetIdCache.get(key);

  const res = await sheets().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = res.data.sheets.find(s => s.properties.title === title);
  if (!sheet) throw new Error(`Sheet not found: ${title}`);
  sheetIdCache.set(key, sheet.properties.sheetId);
  return sheet.properties.sheetId;
}

async function debugLog(stage, details) {
  try {
    await sheets().spreadsheets.values.append({
      spreadsheetId: RESULTS.sheetId,
      range: `${RESULTS.debugSheetName}!A:C`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[new Date().toISOString(), stage, typeof details === 'string' ? details : JSON.stringify(details)]]
      }
    });
  } catch (err) {
    console.error('results debugLog failed', err.message);
  }
}

async function sendPairChoiceButtons(destinationId, title, token, pairChoices) {
  const inline_keyboard = pairChoices.map((choice, index) => [{
    text: `${choice.p1} vs ${choice.p2}`,
    callback_data: `PTF|${token}|pair|${index}`
  }]);
  inline_keyboard.push([{ text: 'Cancel', callback_data: `PTF|${token}|cancel|` }]);
  await safeSendMessage(destinationId, title, { reply_markup: { inline_keyboard } });
}

async function sendPlayerNotFoundMessage(userId, rawName) {
  await safeSendMessage(
    userId,
    `I couldn't find a player named "${rawName}".\n\nPlease delete the old message in the Results topic and resend the match there with full player names.`
  );
}

async function safeSendMessage(chatId, text, opts = {}) {
  if (!chatId) return null;
  try {
    const result = await sendMessage(chatId, text, opts);
    await debugLog('TELEGRAM SEND OK', {
      chatId,
      message_thread_id: opts.message_thread_id || '',
      text,
      has_reply_markup: Boolean(opts.reply_markup),
      sent_message_id: result?.message_id || ''
    });
    return result;
  } catch (err) {
    await debugLog('TELEGRAM SEND ERROR', { error: err.message, chatId, text });
    return null;
  }
}

function cachePutPending(userId, token, obj) {
  pendingSessions.set(cacheKey(userId, token), { ...obj, expiresAt: Date.now() + PENDING_TTL_MS });
}

function cacheGetPending(userId, token) {
  const key = cacheKey(userId, token);
  const obj = pendingSessions.get(key);
  if (!obj) return null;
  if (obj.expiresAt && Date.now() > obj.expiresAt) {
    pendingSessions.delete(key);
    return null;
  }
  return obj;
}

function cacheDeletePending(userId, token) {
  pendingSessions.delete(cacheKey(userId, token));
}

function cacheKey(userId, token) {
  return `PTF_PENDING_${userId}_${token}`;
}

function claimMessageOnce(chatId, messageId) {
  if (!chatId || !messageId) return true;
  const key = `PTF_MSG_${chatId}_${messageId}`;
  if (seenMessages.has(key)) return false;
  seenMessages.set(key, Date.now());
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingSessions.entries()) {
    if (value.expiresAt && now > value.expiresAt) pendingSessions.delete(key);
  }
  for (const [key, createdAt] of seenMessages.entries()) {
    if (now - createdAt > 24 * 60 * 60 * 1000) seenMessages.delete(key);
  }
}, 60 * 1000).unref();

function scoreValues(p) {
  return [
    p.s1p1, p.s1p2, p.s1tb1, p.s1tb2,
    p.s2p1, p.s2p2, p.s2tb1, p.s2tb2,
    p.s3p1, p.s3p2, p.s3tb1, p.s3tb2
  ];
}

function reverseParsedScore(p) {
  return {
    hasScore: p.hasScore,
    p1Raw: p.p2Raw,
    p2Raw: p.p1Raw,
    s1p1: p.s1p2,
    s1p2: p.s1p1,
    s1tb1: p.s1tb2,
    s1tb2: p.s1tb1,
    s2p1: p.s2p2,
    s2p2: p.s2p1,
    s2tb1: p.s2tb2,
    s2tb2: p.s2tb1,
    s3p1: p.s3p2,
    s3p2: p.s3p1,
    s3tb1: p.s3tb2,
    s3tb2: p.s3tb1
  };
}

function formatScore(p) {
  const sets = [];
  if (p.s1p1 !== '' && p.s1p2 !== '') sets.push(formatSet(p.s1p1, p.s1p2, p.s1tb1, p.s1tb2));
  if (p.s2p1 !== '' && p.s2p2 !== '') sets.push(formatSet(p.s2p1, p.s2p2, p.s2tb1, p.s2tb2));
  if (p.s3p1 !== '' && p.s3p2 !== '') sets.push(formatSet(p.s3p1, p.s3p2, p.s3tb1, p.s3tb2));
  return sets.join(' ');
}

function formatSet(a, b, tba, tbb) {
  let s = `${a}-${b}`;
  if (tba !== '' && tbb !== '') s += `(${tba}-${tbb})`;
  return s;
}

function formatScoreForCard(p) {
  const sets = [];
  if (p.s1p1 !== '' && p.s1p2 !== '') sets.push(formatSetForCard(p.s1p1, p.s1p2, p.s1tb1, p.s1tb2));
  if (p.s2p1 !== '' && p.s2p2 !== '') sets.push(formatSetForCard(p.s2p1, p.s2p2, p.s2tb1, p.s2tb2));
  if (p.s3p1 !== '' && p.s3p2 !== '') sets.push(formatSetForCard(p.s3p1, p.s3p2, p.s3tb1, p.s3tb2));
  return sets.join(' ');
}

function formatSetForCard(a, b, tba, tbb) {
  let s = `${a}:${b}`;
  if (tba !== '' && tbb !== '') s += ` (${tba}:${tbb})`;
  return s;
}

function detectSet3Mode(p) {
  if (p.s3p1 === '' || p.s3p2 === '') return '';
  const a = Number(p.s3p1);
  const b = Number(p.s3p2);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return a >= 10 || b >= 10 ? 'Match TB' : 'Full Set';
}

function getLocalDateSerial() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RESULTS.localTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);
  return Date.UTC(year, month - 1, day) / 86400000 + 25569;
}

function coerceNumber(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

function tokenOverlapScore(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach(t => {
    if (tb.has(t)) inter++;
  });
  return Math.round((inter / (ta.size + tb.size - inter)) * 70);
}

function typoSimilarityScore(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  let score = 0;
  const distance = levenshteinDistance(a, b);
  const similarity = 1 - distance / Math.max(a.length, b.length);
  score = Math.max(score, Math.round(similarity * 86));

  if (shorter.length >= 3 && isSubsequence(shorter, longer)) score = Math.max(score, 72);
  if (a[0] === b[0]) score += 8;
  if (a.at(-1) === b.at(-1)) score += 6;

  return Math.min(score, 94);
}

function levenshteinDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function isSubsequence(shorter, longer) {
  let i = 0;
  for (const ch of longer) {
    if (ch === shorter[i]) i++;
    if (i === shorter.length) return true;
  }
  return false;
}

function colToLetter(col) {
  let out = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    col = Math.floor((col - 1) / 26);
  }
  return out;
}

function randomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stackDetails(err) {
  return err?.stack || err?.message || String(err);
}
