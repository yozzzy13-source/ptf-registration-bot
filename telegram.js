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
export const sendPoll = (chat_id, question, options, opts={}) => call('sendPoll', { chat_id, question, options, ...opts });

export async function setWebhook() {
  if (!PUBLIC_URL) throw new Error('PUBLIC_URL env is empty');
  return call('setWebhook', { url: `${PUBLIC_URL}/webhook`, drop_pending_updates: true });
}

export async function setCommands() {
  return call('setMyCommands', { commands: [
    { command: 'start', description: 'Start / Main menu' },
    { command: 'help', description: 'Help' },
    { command: 'language', description: 'Choose language' },
    { command: 'admin', description: 'Open admin panel' },
    { command: 'poll_stats', description: 'Admin: poll summary' },
    { command: 'cancel', description: 'Cancel current action' }
  ]});
}

export function inlineKeyboard(rows) { return { inline_keyboard: rows }; }
export function webAppButton(text, path='/apply') { return { text, web_app: { url: `${PUBLIC_URL}${path}` } }; }
export function urlButton(text, url) { return { text, url }; }
export const clubChatButton = (text) => urlButton(text, CLUB_CHAT_URL);
