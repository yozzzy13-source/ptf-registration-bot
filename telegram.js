import fetch from 'node-fetch';
import { BOT_TOKEN, PUBLIC_URL, CLUB_CHAT_URL } from './config.js';

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function call(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${JSON.stringify(json)}`);
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
export const copyMessage = (chat_id, from_chat_id, message_id, opts={}) => call('copyMessage', { chat_id, from_chat_id, message_id, ...opts });
export const getChat = (chat_id) => call('getChat', { chat_id });
export const createForumTopic = (chat_id, name, opts={}) => call('createForumTopic', { chat_id, name, ...opts });
export const deleteForumTopic = (chat_id, message_thread_id) => call('deleteForumTopic', { chat_id, message_thread_id });

export async function setWebhook() {
  if (!PUBLIC_URL) throw new Error('PUBLIC_URL env is empty');
  return call('setWebhook', { url: `${PUBLIC_URL}/webhook`, drop_pending_updates: true });
}

export async function setCommands() {
  await call('setMyCommands', { commands: [
    { command: 'start', description: 'Start / Main menu' },
    { command: 'help', description: 'Help' },
    { command: 'results', description: 'Match result notifications' }
  ]});
  return call('setMyCommands', {
    language_code: 'ru',
    commands: [
      { command: 'start', description: 'Старт / главное меню' },
      { command: 'help', description: 'Помощь' },
      { command: 'results', description: 'Уведомления о результатах' }
    ]
  });
}

export function inlineKeyboard(rows) { return { inline_keyboard: rows }; }
export function webAppButton(text, path='/apply') { return { text, web_app: { url: `${PUBLIC_URL}${path}` } }; }
export function urlButton(text, url) { return { text, url }; }
export const clubChatButton = (text) => urlButton(text, CLUB_CHAT_URL);
