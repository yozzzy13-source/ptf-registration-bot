import fetch from 'node-fetch';
import { BOT_TOKEN, PUBLIC_URL, CLUB_CHAT_URL } from './config.js';

const API = `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${BOT_TOKEN}`;

const migratedChats = new Map();

function normalizePayload(payload = {}) {
  if (payload.chat_id !== undefined && payload.chat_id !== null) {
    const key = String(payload.chat_id);
    if (migratedChats.has(key)) return { ...payload, chat_id: migratedChats.get(key) };
  }
  return payload;
}

async function rawCall(method, payload = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json().catch(() => ({}));
}

async function call(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  const normalized = normalizePayload(payload);
  let json = await rawCall(method, normalized);

  // Telegram group -> supergroup migration.
  // Without this retry, admin notifications can break the whole WebApp submit flow.
  const migrateTo = json?.parameters?.migrate_to_chat_id;
  if (!json.ok && migrateTo && normalized.chat_id !== undefined && normalized.chat_id !== null) {
    const oldChatId = String(normalized.chat_id);
    const newChatId = String(migrateTo);
    migratedChats.set(oldChatId, newChatId);
    console.warn(`Telegram chat migrated: ${oldChatId} -> ${newChatId}`);
    json = await rawCall(method, { ...normalized, chat_id: newChatId });
  }

  if (!json.ok) {
    const err = new Error(`${method}: ${JSON.stringify(json)}`);
    err.telegram = json;
    throw err;
  }
  return json.result;
}

export const sendMessage = (chat_id, text, opts={}) => call('sendMessage', {
  chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts
});
export const editMessageText = (chat_id, message_id, text, opts={}) => call('editMessageText', {
  chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts
});
export const answerCallbackQuery = (callback_query_id, text='', show_alert=false) => call('answerCallbackQuery', { callback_query_id, text, show_alert });
export const sendPhoto = (chat_id, photo, opts={}) => call('sendPhoto', { chat_id, photo, parse_mode: 'HTML', ...opts });
export const sendDocument = (chat_id, document, opts={}) => call('sendDocument', { chat_id, document, parse_mode: 'HTML', ...opts });
export const sendVideo = (chat_id, video, opts={}) => call('sendVideo', { chat_id, video, parse_mode: 'HTML', ...opts });
export const sendVoice = (chat_id, voice, opts={}) => call('sendVoice', { chat_id, voice, parse_mode: 'HTML', ...opts });
export const sendAudio = (chat_id, audio, opts={}) => call('sendAudio', { chat_id, audio, parse_mode: 'HTML', ...opts });
export const sendVideoNote = (chat_id, video_note, opts={}) => call('sendVideoNote', { chat_id, video_note, ...opts });
export const sendSticker = (chat_id, sticker, opts={}) => call('sendSticker', { chat_id, sticker, ...opts });
export const copyMessage = (chat_id, from_chat_id, message_id, opts={}) => call('copyMessage', { chat_id, from_chat_id, message_id, ...opts });
export const createForumTopic = (chat_id, name, opts={}) => call('createForumTopic', { chat_id, name, ...opts });
export const getChat = (chat_id) => call('getChat', { chat_id });
export const getWebhookInfo = () => call('getWebhookInfo', {});

// Фото из мини-приложения приходит бинарём — его нужно отправить multipart-ом,
// обычный JSON-вызов принимает только file_id или URL.
// ВАЖНО: здесь берём глобальный fetch (undici из Node), а не node-fetch.
// Смешивание node-fetch с глобальными FormData/Blob давало на отправке фото
// «Invalid state: chunk ArrayBuffer is zero-length or detached» — тело формы
// разъезжалось между двумя реализациями. Плюс копируем байты в свой Uint8Array:
// Buffer из Node — это view на общий пул памяти, который может быть переиспользован.
export async function sendPhotoBuffer(chat_id, buffer, mimeType = 'image/jpeg', opts = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  if (!buffer || !buffer.length) throw new Error('sendPhoto: пустой файл');
  const ext = String(mimeType).split('/')[1] || 'jpg';
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append('photo', new Blob([bytes], { type: mimeType }), `result.${ext}`);
  const res = await globalThis.fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`sendPhoto: ${JSON.stringify(json)}`);
  return json.result;
}
export const getMe = () => call('getMe', {});
export const sendPoll = (chat_id, question, options, opts={}) => call('sendPoll', { chat_id, question, options, ...opts });

export async function setWebhook() {
  if (!PUBLIC_URL) throw new Error('PUBLIC_URL env is empty');
  // drop_pending_updates НЕ ставим: при рестарте/деплое Telegram держит недоставленные апдейты
  // и повторяет их — с drop_pending_updates:true присланный в этот момент скриншот оплаты
  // терялся навсегда. Дубли отсекает кэш update_id в index.js.
  return call('setWebhook', { url: `${PUBLIC_URL}/webhook`, allowed_updates: ['message','callback_query','poll'] });
}

// Подсказка команд в Telegram — общая для всех, поэтому админские команды раньше
// висели и у игроков. Теперь списки разведены по scope: игрокам — свой короткий,
// админскому чату и личке админа — полный.
//
// Команды матчей (/match, /result, /book) в базовый список НЕ входят: их бот
// добавляет персонально тем, кто в активном составе (setChatCommands ниже).
export const PLAYER_COMMANDS = {
  en: [
    { command: 'menu', description: 'Main menu' },
    { command: 'help', description: 'What the bot can do' },
    { command: 'results', description: 'Results feed on / off' },
    { command: 'language', description: 'Choose language' },
    { command: 'cancel', description: 'Cancel current action' }
  ],
  ru: [
    { command: 'menu', description: 'Главное меню' },
    { command: 'help', description: 'Что умеет бот' },
    { command: 'results', description: 'Лента результатов вкл / выкл' },
    { command: 'language', description: 'Выбрать язык' },
    { command: 'cancel', description: 'Отменить текущее действие' }
  ]
};

export const MATCH_COMMANDS = {
  en: [
    { command: 'match', description: 'Matches: open slots and challenges' },
    { command: 'result', description: 'Submit a match result' },
    { command: 'book', description: 'Book a court' }
  ],
  ru: [
    { command: 'match', description: 'Матчи: окна и вызовы' },
    { command: 'result', description: 'Внести результат матча' },
    { command: 'book', description: 'Забронировать корт' }
  ]
};

// Рассылки (в том числе опросы и их статистика) живут в админской панели —
// в подсказке команд их нет, чтобы не было двух путей к одному и тому же.
export const ADMIN_COMMANDS = [
  { command: 'help', description: 'Admin commands' },
  { command: 'overview', description: 'League overview: matches, courts, results' },
  { command: 'league', description: 'League frontend (test)' },
  { command: 'admin', description: 'Admin panel' },
  { command: 'stats', description: 'Stats' },
  { command: 'pending', description: 'Pending payments' },
  { command: 'events', description: 'Events' },
  { command: 'messages', description: 'Recent messages' },
  { command: 'results_here', description: 'Bind the results feed to this topic' },
  { command: 'menu', description: 'Main menu' },
  { command: 'cancel', description: 'Cancel current action' }
];

// Персональный список для одного чата. commands:[] снимает переопределение,
// и человек снова видит общий список.
export async function setChatCommands(chatId, commands) {
  return call('setMyCommands', { commands, scope: { type: 'chat', chat_id: chatId } });
}

export async function setCommands() {
  await call('setMyCommands', { commands: PLAYER_COMMANDS.en });
  await call('setMyCommands', { commands: PLAYER_COMMANDS.en, scope: { type: 'all_private_chats' } });
  await call('setMyCommands', { commands: PLAYER_COMMANDS.ru, scope: { type: 'all_private_chats' }, language_code: 'ru' });
  return { ok: true };
}

export function inlineKeyboard(rows) { return { inline_keyboard: rows }; }
export function webAppButton(text, path='/apply') { return { text, web_app: { url: `${PUBLIC_URL}${path}` } }; }
export function urlButton(text, url) { return { text, url }; }
export const clubChatButton = (text) => urlButton(text, CLUB_CHAT_URL);
