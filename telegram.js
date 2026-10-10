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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Telegram отвечает 429 (error_code:429, parameters.retry_after=N) при превышении
// лимитов — раньше это просто роняло рассылку с ошибкой и результат/уведомление
// терялось. Теперь ждём ровно столько, сколько просит Telegram (+небольшой запас),
// и повторяем сам запрос — без этого масштабирование числа игроков рано или
// поздно начинает терять сообщения на каждой массовой рассылке.
// Ожидание лимитов включается ТОЧЕЧНО, а не для всего подряд.
//
// Раньше повторы стояли на каждом обращении к Telegram. Пока лимиты не
// упирались, это ничего не стоило; как только пошли массовые рассылки, нажатие
// кнопки стало ждать в общей очереди по несколько секунд. Интерфейс должен
// отвечать сразу и лучше промахнётся, а рассылка пусть терпеливо ждёт — ей
// спешить некуда, а терять сообщения нельзя.
const MAX_RETRY_429 = 6;
let bulkDepth = 0;
export async function withBulkRetries(fn) {
  bulkDepth++;
  try { return await fn(); } finally { bulkDepth--; }
}
async function callWithRetry(doRequest, method) {
  let json = await doRequest();
  if (!bulkDepth) {
    // Интерактив: один раз сообщаем в лог и выходим, не заставляя человека ждать.
    if (json && json.ok === false && json.error_code === 429) {
      console.warn(`Telegram 429 on ${method}: пропускаю ожидание (интерактивный вызов)`);
    }
    return json;
  }
  for (let attempt = 0; json && json.ok === false && json.error_code === 429 && attempt < MAX_RETRY_429; attempt++) {
    const waitSec = Number(json.parameters?.retry_after) || 1;
    console.warn(`Telegram 429 on ${method}: ждём ${waitSec}s (попытка ${attempt + 1}/${MAX_RETRY_429})`);
    await sleep((waitSec + 0.3) * 1000);
    json = await doRequest();
  }
  return json;
}

// Кто заблокировал бота или удалил аккаунт. Писать им бесполезно: каждая
// такая попытка — лишний запрос и строка ошибки в логах, а при рассылке
// результата их было по два на человека (фото + карточка). Помним в памяти:
// после перезапуска сервера каждый такой человек стоит одну неудачную попытку.
// Написал боту сам — снова живой (markChatAlive в обработчике входящих).
const deadChats = new Map();   // chat_id → причина
const DEAD_RE = /bot was blocked by the user|user is deactivated|bot was kicked|chat not found|bot can't initiate conversation/i;
export const isChatDead = chatId => deadChats.has(String(chatId));
export const markChatAlive = chatId => { deadChats.delete(String(chatId)); };
export const deadChatsCount = () => deadChats.size;
const SEND_METHODS = /^(send|copyMessage|forwardMessage)/;

// Кнопка-ссылка на профиль человека (tg://user?id=…) не проходит, если у него
// в Telegram закрыта приватность: Telegram отвечает
// BUTTON_USER_PRIVACY_RESTRICTED и не отправляет сообщение вовсе. Тогда шлём
// то же сообщение без таких кнопок — сам текст важнее кнопки.
function withoutUserButtons(payload) {
  const kb = payload?.reply_markup?.inline_keyboard;
  if (!Array.isArray(kb)) return null;
  const userBtn = b => /^tg:\/\/user/i.test(String(b?.url || '')) || b?.user_id !== undefined;
  const rows = kb.map(r => (r || []).filter(b => !userBtn(b))).filter(r => r.length);
  if (rows.length === kb.length && rows.every((r, i) => r.length === kb[i].length)) {
    const { reply_markup, ...rest } = payload;   // таких кнопок не нашли — шлём без клавиатуры
    return rest;
  }
  return { ...payload, reply_markup: rows.length ? { ...payload.reply_markup, inline_keyboard: rows } : undefined };
}

async function call(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  let normalized = normalizePayload(payload);
  const target = String(normalized.chat_id ?? '');
  if (SEND_METHODS.test(method) && target && !target.startsWith('-') && deadChats.has(target)) {
    const json = { ok:false, error_code:403, description:`Forbidden: ${deadChats.get(target)} (известно заранее, запрос не отправлялся)` };
    const err = new Error(`${method}: ${JSON.stringify(json)}`);
    err.telegram = json;
    throw err;
  }
  let json = await callWithRetry(() => rawCall(method, normalized), method);
  if (json && json.ok === false && /BUTTON_USER_PRIVACY_RESTRICTED/i.test(String(json.description || ''))) {
    const lighter = withoutUserButtons(normalized);
    if (lighter) {
      console.warn(`${method}: кнопка-профиль закрыта приватностью получателя, отправляю без неё`);
      normalized = lighter;
      json = await callWithRetry(() => rawCall(method, normalized), method);
    }
  }
  if (json && json.ok === false && json.error_code === 403 && target && !target.startsWith('-') && DEAD_RE.test(String(json.description || ''))) {
    deadChats.set(target, String(json.description || '').replace(/^Forbidden:\s*/i, ''));
  }

  // Telegram group -> supergroup migration.
  // Without this retry, admin notifications can break the whole WebApp submit flow.
  const migrateTo = json?.parameters?.migrate_to_chat_id;
  if (!json.ok && migrateTo && normalized.chat_id !== undefined && normalized.chat_id !== null) {
    const oldChatId = String(normalized.chat_id);
    const newChatId = String(migrateTo);
    migratedChats.set(oldChatId, newChatId);
    console.warn(`Telegram chat migrated: ${oldChatId} -> ${newChatId}`);
    json = await callWithRetry(() => rawCall(method, { ...normalized, chat_id: newChatId }), method);
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
// Правка уже отправленного сообщения. Картинку меняем по file_id — тогда это
// обычный JSON-запрос, без загрузки файла заново. Телеграм разрешает боту
// править свои сообщения только первые 48 часов.
export const editMessageMedia = (chat_id, message_id, media, opts={}) => call('editMessageMedia', { chat_id, message_id, media, ...opts });
export const editMessageCaption = (chat_id, message_id, caption, opts={}) => call('editMessageCaption', { chat_id, message_id, caption, parse_mode: 'HTML', ...opts });
export const deleteMessage = (chat_id, message_id) => call('deleteMessage', { chat_id, message_id });
export const sendPhoto = (chat_id, photo, opts={}) => call('sendPhoto', { chat_id, photo, parse_mode: 'HTML', ...opts });
export const sendDocument = (chat_id, document, opts={}) => call('sendDocument', { chat_id, document, parse_mode: 'HTML', ...opts });
export const sendVideo = (chat_id, video, opts={}) => call('sendVideo', { chat_id, video, parse_mode: 'HTML', ...opts });
export const sendVoice = (chat_id, voice, opts={}) => call('sendVoice', { chat_id, voice, parse_mode: 'HTML', ...opts });
export const sendAudio = (chat_id, audio, opts={}) => call('sendAudio', { chat_id, audio, parse_mode: 'HTML', ...opts });
export const sendVideoNote = (chat_id, video_note, opts={}) => call('sendVideoNote', { chat_id, video_note, ...opts });
export const sendSticker = (chat_id, sticker, opts={}) => call('sendSticker', { chat_id, sticker, ...opts });
// Альбом по уже загруженным file_id: рассылка грузит фото в Telegram один раз,
// а каждому получателю отдаёт только идентификатор — это быстро и переживает
// перезапуск сервера (сами файлы в памяти не нужны).
export const sendPhotoAlbumIds = (chat_id, photoIds = [], opts={}) => call('sendMediaGroup', {
  chat_id, media: photoIds.map(id => ({ type: 'photo', media: id })), ...opts
});
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
  // Подписи у нас с HTML-разметкой, как и у всех остальных отправок.
  for (const [k, v] of Object.entries({ parse_mode: 'HTML', ...opts })) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append('photo', new Blob([bytes], { type: mimeType }), `result.${ext}`);
  const send = async () => {
    const res = await globalThis.fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
    return res.json().catch(() => ({}));
  };
  const json = await callWithRetry(send, 'sendPhoto');
  if (!json.ok) throw new Error(`sendPhoto: ${JSON.stringify(json)}`);
  return json.result;
}
// Отправка картинки ФАЙЛОМ. sendPhoto Телеграм пережимает сам: конвертирует
// в JPEG и ужимает длинную сторону до 1280 px, поэтому сохранённый из чата
// постер 1080×1920 оказывается копией с двойным сжатием. sendDocument отдаёт
// файл байт в байт — это то, что нужно для публикации в Instagram руками.
export async function sendDocumentBuffer(chat_id, buffer, filename = 'file.png', opts = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  if (!buffer || !buffer.length) throw new Error('sendDocument: пустой файл');
  const name = String(filename || 'file.png');
  const ext = name.split('.').pop().toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  for (const [k, v] of Object.entries({ parse_mode: 'HTML', ...opts })) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append('document', new Blob([bytes], { type: mime }), name);
  const send = async () => {
    const res = await globalThis.fetch(`${API}/sendDocument`, { method: 'POST', body: form });
    return res.json().catch(() => ({}));
  };
  const json = await callWithRetry(send, 'sendDocument');
  if (!json.ok) throw new Error(`sendDocument: ${JSON.stringify(json)}`);
  return json.result;
}
// Пачка файлов одним сообщением: те же оригиналы, но альбомом, чтобы недельная
// подборка не растягивалась на двадцать сообщений.
export async function sendDocumentAlbumBuffers(chat_id, items = [], opts = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  if (!Array.isArray(items) || !items.length) throw new Error('sendMediaGroup: нет файлов');
  if (items.length > 10) throw new Error('sendMediaGroup: не больше 10 файлов за раз');
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  if (opts.message_thread_id) form.append('message_thread_id', String(opts.message_thread_id));
  const media = [];
  items.forEach((item, index) => {
    const buffer = item?.buffer;
    if (!buffer?.length) throw new Error('sendMediaGroup: пустой файл');
    const name = String(item.filename || `file-${index + 1}.png`);
    const ext = name.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const bytes = new Uint8Array(buffer.length);
    bytes.set(buffer);
    const field = 'doc' + index;
    media.push({ type: 'document', media: 'attach://' + field });
    form.append(field, new Blob([bytes], { type: mime }), name);
  });
  form.append('media', JSON.stringify(media));
  const res = await globalThis.fetch(API + '/sendMediaGroup', { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error('sendMediaGroup: ' + JSON.stringify(json));
  return json.result;
}
export async function sendPhotoAlbumBuffers(chat_id, items = [], opts = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  if (!Array.isArray(items) || !items.length) throw new Error('sendMediaGroup: нет файлов');
  if (items.length > 10) throw new Error('sendMediaGroup: не больше 10 фотографий за раз');
  if (items.length === 1) {
    return sendPhotoBuffer(chat_id, items[0].buffer, items[0].mimeType || items[0].mime || 'image/jpeg', opts);
  }
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  if (opts.message_thread_id) form.append('message_thread_id', String(opts.message_thread_id));
  const media = [];
  items.forEach((item, index) => {
    const buffer = item?.buffer;
    if (!buffer?.length) throw new Error('sendMediaGroup: пустой файл');
    const mimeType = String(item.mimeType || item.mime || 'image/jpeg');
    const ext = mimeType.split('/')[1] || 'jpg';
    const bytes = new Uint8Array(buffer.length);
    bytes.set(buffer);
    const field = 'photo' + index;
    media.push({ type:'photo', media:'attach://' + field });
    form.append(field, new Blob([bytes], { type:mimeType }), field + '.' + ext);
  });
  form.append('media', JSON.stringify(media));
  const res = await globalThis.fetch(API + '/sendMediaGroup', { method:'POST', body:form });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error('sendMediaGroup: ' + JSON.stringify(json));
  return json.result;
}
export const getMe = () => call('getMe', {});

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
    { command: 'avatar', description: 'My avatar versions' },
    { command: 'fantasy', description: 'PTF Fantasy: build your squad' },
  { command: 'menu', description: 'Main menu' },
    { command: 'help', description: 'What the bot can do' },
    { command: 'results', description: 'Results feed on / off' },
    { command: 'language', description: 'Choose language' },
    { command: 'cancel', description: 'Cancel current action' }
  ],
  ru: [
    { command: 'fantasy', description: 'PTF Fantasy: собрать команду' },
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
    { command: 'book', description: 'Book a court' },
    { command: 'doubles', description: 'Doubles: enter and find a partner' }
  ],
  ru: [
    { command: 'match', description: 'Матчи: окна и вызовы' },
    { command: 'result', description: 'Внести результат матча' },
    { command: 'book', description: 'Забронировать корт' },
    { command: 'doubles', description: 'Парные турниры: запись и партнёр' }
  ]
};

// Рассылки (в том числе опросы и их статистика) живут в админской панели —
// в подсказке команд их нет, чтобы не было двух путей к одному и тому же.
// ЕДИНЫЙ список команд организатора. Из него собираются и меню по слэшу, и
// текст /help — чтобы новая команда не могла попасть в одно место и потеряться
// в другом. Добавил строку сюда — она появилась везде.
export const ADMIN_COMMAND_LIST = [
  { cmd:'admin',        group:'Панель и рассылки', short:'Админ-панель',
    short_en:'Admin panel', help_en:'admin panel: players, filters, broadcasts, events (edit and delete), balances, manual refunds', help:'админ-панель: игроки, фильтры, рассылки, события (правка и удаление), балансы, ручные возвраты, кнопки меню по группам' },
  { cmd:'stats',        group:'Лига', short:'Статистика', short_en:'Stats', help_en:'applications, payments and statuses at a glance', help:'заявки, оплаты, статусы' },
  { cmd:'match_check', group:'Матчи', short:'Почему нет напоминания или кнопки счёта', short_en:'Why no reminder or score button', args_en:'<player name>', args:'<имя игрока>',
    help:'несыгранные матчи игрока и что бот по ним видит: понял ли дату и время, подтверждён ли корт, когда появится кнопка «внести счёт», придёт ли приглашение и какие напоминания уже ушли',
    help_en:'a player’s unplayed matches and what the bot sees: whether the date and time are understood, whether the court is confirmed, when the score button appears, whether the invite will come and which reminders went out' },
  { cmd:'load', group:'Настройка', short:'Нагрузка на Google Таблицы', short_en:'Google Sheets load',
    help:'сколько запросов к Google Таблицам ушло за последнюю минуту из лимита, сколько ждут в очереди и сколько людей заблокировали бота',
    help_en:'how many Google Sheets requests went out in the last minute against the limit, how many are queued, and how many people blocked the bot' },
  { cmd:'waitlist_sync', group:'Лига', short:'Лист ожидания → участники', short_en:'Waitlist → participants',
    help:'сверить лист ожидания с таблицей «Short Players list»: добавить новых, убрать отменённых, расставить по очереди (игроки лиги, затем по дате). Обычно это происходит само при каждой заявке',
    help_en:'sync the waitlist with the «Short Players list» sheet: add new people, drop cancelled ones, order the queue (league players, then by date). Normally this happens by itself on every application' },
  { cmd:'pending',      group:'Лига', short:'Заявки в работе', short_en:'Applications in progress', help_en:'applications waiting for a payment check', help:'заявки, ждущие проверки оплаты' },
  { cmd:'profile',      group:'Лига', short:'Карточка игрока', args_en:'@username or telegram_id', args:'@ник или telegram_id',
    short_en:'Player card', help_en:'a player card with buttons: approve, send an invoice, write to them', help:'карточка игрока с кнопками: подтвердить участие, выставить счёт, написать' },
  { cmd:'payment_auto', group:'Лига', short:'Счёт сразу или после подтверждения', args:'on|off',
    short_en:'Invoice now or after approval', help_en:'whether the league invoice goes out at once or only after your button', help:'счёт на участие уходит игроку сразу или только после вашей кнопки' },
  { cmd:'events',       group:'Лига', short:'События', short_en:'Events', help_en:'active events', help:'активные события' },
  { cmd:'messages',     group:'Лига', short:'Сообщения игроков', short_en:'Player messages', help_en:'the latest messages from players', help:'последние сообщения от игроков' },
  { cmd:'whois',        group:'Настройка', short:'Что бот видит по игроку', args_en:'@username or telegram_id', args:'@ник или telegram_id',
    short_en:'What the bot sees', help_en:'whether the player is recognised by id, which group they are in and which buttons they get', help:'узнаётся ли игрок по id, какая у него группа и какие кнопки ему достаются' },
  { cmd:'id_check',     group:'Настройка', short:'Проверка telegram_id',
    short_en:'telegram_id check', help_en:'who has no telegram_id and where duplicates are — they make menus differ', help:'у кого в базе нет telegram_id и где дубли — из-за них меню у игрока разное' },
  { cmd:'photos',       group:'Настройка', short:'Откуда берутся аватарки',
    short_en:'Where avatars come from', help_en:'how many photos come from Players_Master, the showcase and own avatars, and who has none', help:'сколько фото читается из Players_Master, витрины и своих аватарок, и у кого фото нет' },
  { cmd:'matches',      group:'Матчи', short:'Сводка матчей', short_en:'Matches overview',
    help:'назначенные матчи, где не подтверждён корт, кто не ответил, где нет счёта, открытые окна',
    help_en:'scheduled matches, courts not confirmed, who has not replied, missing scores, open slots' },
  { cmd:'league',       group:'Матчи', short:'Витрина лиги', short_en:'League app', help_en:'open the league app', help:'открыть витрину лиги' },
  { cmd:'tournaments',  group:'Турниры', short:'Админка турниров', short_en:'Tournament admin',
    help:'создание турниров, приём заявок, распределение по группам, расписание круговой системы, сборка сетки плей-офф 1-4 и 2-3, ручные замены и подмена участника в слоте, внесение и ИСПРАВЛЕНИЕ счёта с пересчётом таблицы, журнал всех правок. Переключатель «Тест» в шапке пишет всё в листы с пометкой TEST — боевые таблицы не меняются',
    help_en:'create tournaments, accept entries, split into groups, generate round-robin schedules, build the 1-4 / 2-3 playoff bracket, swap players in slots, enter and CORRECT scores with automatic standings recalculation, and read the full audit log. The «Test» switch writes everything into TEST-suffixed sheets, leaving the live ones untouched' },
  { cmd:'fantasy',      group:'Матчи', short:'Fantasy во вкладке лиги',
    short_en:'Fantasy tab', help_en:'open the league straight on the Fantasy tab — the same button players get', help:'открыть лигу сразу на вкладке Fantasy — та же кнопка, что уходит игрокам' },
  { cmd:'rating_to',    group:'Панель и рассылки', short:'Запрос уровня одному', short_en:'Ask one player for level', args_en:'@username', args:'@ник',
    help:'запрос уровня одному игроку', help_en:'ask a single player to confirm their level' },
  { cmd:'links',        group:'Панель и рассылки', short:'Коды разделов', short_en:'Section codes', help_en:'section codes for broadcasts', help:'коды разделов для рассылок' },
  { cmd:'admin_init',   group:'Настройка', short:'Сделать чат админским',
    short_en:'Make this chat the admin chat', help_en:'bind the current chat as the admin one (once, in the right group)', help:'привязать текущий чат как админский (один раз, в нужной группе)' },
  { cmd:'results_here', group:'Настройка', short:'Лента результатов сюда',
    short_en:'Results feed here', help_en:'bind the results feed to the current topic', help:'привязать ленту результатов к текущей теме' },
  { cmd:'topic_sync',   group:'Настройка', short:'Привязать темы',
    short_en:'Link topics', help_en:'link existing topics to the current admin group', help:'привязать существующие темы к текущей админской группе' },
  { cmd:'topic_backfill', group:'Настройка', short:'Добрать темы', args_en:'[how many]', args:'[сколько]',
    short_en:'Backfill topics', help_en:'create topics for people who already wrote but got none; 25 per run by default', help:'завести темы тем, кто уже взаимодействовал, но темы не получил; по умолчанию 25 за раз' },
  { cmd:'topic_test',   group:'Настройка', short:'Проверка топиков', short_en:'Topics check', help_en:'check the webhook and player topics', help:'проверка вебхука и топиков игроков' },
  { cmd:'profile_refresh', group:'Настройка', short:'Обновить витрину профилей', args:'[go]',
    short_en:'Refresh the profile showcase', help_en:'show the IMPORTRANGE formulas in the showcase; with «go» force them to recalculate now', help:'показать формулы IMPORTRANGE в витрине профилей; с «go» — заставить их пересчитаться сейчас' },
  { cmd:'places', group:'Настройка', short:'Проверить места в дивизионах', args_en:'[season]', args:'[сезон]',
    short_en:'Check division places', help_en:'what the bot sees in the live division sheets and whether names match the showcase', help:'что бот видит в живых таблицах дивизионов и совпали ли имена с витриной профилей; кого там нет — у того в карточке не будет номера места' },
  { cmd:'result_test',  group:'Матчи', short:'Предпросмотр карточки результата', args_en:'[player name]', args:'[имя игрока]',
    short_en:'Preview a result card', help_en:'see how the card and text will go to the feed and to a DM, on a real match; nobody but you receives it', help:'показать, как карточка и текст уйдут в ленту и в личку, на настоящем матче; вторым словом можно назвать игрока, иначе берётся последний результат; никому, кроме вас, не отправляется' },
  { cmd:'test_match',   group:'Матчи', short:'Боевой тест результата с откатом', args_en:'<winner | loser | score>', args:'<победитель | проигравший | счёт>',
    short_en:'Live result test with rollback', help_en:'run a match through the whole chain for real: both logs, the season, places, form and Fantasy points, then the card. Nothing is published — the card comes only to you, with a «Roll back» button. Score is written winner-first: /test_match Ivan | Peter | 6:4 6:3', help:'прогнать матч по всей цепочке по-настоящему: запись в общий лог и в таблицу дивизиона, сезон, пересчёт мест, снимок формы и очков Fantasy, карточка. В ленту и игрокам ничего не уходит — карточка приходит только вам, а под ней кнопка «Откатить», которая возвращает таблицы в исходное состояние. Счёт пишется от победителя: /test_match Иван | Пётр | 6:4 6:3' },
  { cmd:'withdraw',     group:'Матчи', short:'Снять игрока с турнира (W/O)', short_en:'Withdraw a player (W/O)', args_en:'<player name>', args:'<имя игрока>',
    help_en:'all unplayed matches of the player (group and cross-group) become walkovers: opponent 3 points, player 0, no sets or games; played matches stay; the player\u2019s slots are cancelled and opponents get a message; a preview comes first, writing only after the button',
    help:'все несыгранные матчи игрока (в группе и межгрупповые) засчитываются соперникам как W/O: им 3 очка, ему 0, сеты и геймы не идут; сыгранные матчи остаются; в историю матчей W/O не попадает; его окна и договорённости отменяются, соперникам приходит сообщение; сначала предпросмотр, запись — только по кнопке «Снять»' },
  { cmd:'playoff', group:'Матчи', short:'Плей-офф: сетка и статус', short_en:'Playoffs: bracket and status',
    help_en:'bracket of every division (provisional or published), unplayed regular matches and results, plus a button to the Playoffs section in My matches → Control: publish, replace a player, set times, enter scores, the day poster',
    help:'сетка каждого дивизиона (предварительная или опубликованная), несыгранные матчи регулярки и результаты; кнопка открывает раздел «Плей-офф» во вкладке «Контроль»: публикация, замена игрока, время матчей, счёт, афиша дня' },
  { cmd:'playoff_result', group:'Матчи', short:'Счёт матча плей-офф', short_en:'Enter a playoff score', args_en:'<division> <match> <winner> | <score>', args:'<дивизион> <матч> <победитель> | <счёт>',
    help_en:'enter a playoff result straight away (already confirmed): /playoff_result A SF1 Roman Vengerak | 6:4 6:3 — score from the winner’s side; matches: QF1–QF4, SF1, SF2, Final, 3rd. The winner moves on in the bracket by itself',
    help:'внести счёт матча плей-офф сразу подтверждённым: <code>/playoff_result A SF1 Roman Vengerak | 6:4 6:3</code> — счёт со стороны победителя; матчи: QF1–QF4, SF1, SF2, Final, 3rd. Победитель сам проходит дальше по сетке' },
  { cmd:'playoff_cards', group:'Матчи', short:'Карточки плей-офф файлами', short_en:'Playoff match cards as files', args_en:'[division|all]', args:'[дивизион|all]',
    help_en:'sends the cards of played playoff matches as files to this chat — for the Instagram feed; nothing is published',
    help:'присылает карточки сыгранных матчей плей-офф файлами в этот чат — для ленты Instagram; никуда не публикуется' },
  { cmd:'pace', group:'Матчи', short:'Темп сезона: кто отстаёт', short_en:'Season pace: who is behind', args_en:'[save]', args:'[save]',
    help_en:'the weekly pace digest right now: season week, matches played / scheduled / pending per division, the watch list «before → now» and a ready message for every lagging player in their language. Comes by itself on Saturdays at 13:00. Without «save» it is a preview; with «save» the watch list is updated as if the messages were sent',
    help:'еженедельная сводка темпа прямо сейчас: неделя сезона, сыграно / назначено / ждут ответа по дивизионам, шорт-лист «было → стало» и готовое сообщение каждому отстающему на его языке. Сама приходит по субботам в 13:00. Без «save» — предпросмотр; с «save» шорт-лист отмечается так, будто сообщения отправлены' },
  { cmd:'result_resync', group:'Матчи', short:'Переписать результат в таблицы', short_en:'Rewrite a result into the sheets', args_en:'<player name | match id>', args:'<имя игрока | id матча>',
    help_en:'writes an already confirmed result again into the league journal and the division table, without cards or broadcasts; use when a match is missing from player history',
    help:'заново записывает уже подтверждённый результат в общий журнал лиги и таблицу дивизиона — без карточек и рассылок; нужна, когда матча нет в истории игрока' },
  { cmd:'fix_result',   group:'Матчи', short:'Перевыпустить карточку результата', args_en:'<message id> [player name]', args:'<id сообщения> [имя игрока]',
    short_en:'Reissue a result card', help_en:'replace the picture, text and buttons of an already published result; the message id is the last number in its link; editing works for 48 hours', help:'заменить картинку, текст и кнопки у уже опубликованного результата в ленте; id сообщения — последнее число в ссылке на пост, вторым аргументом можно назвать игрока, иначе берётся последний результат; править можно первые 48 часов' },
  { cmd:'instagram_ask',   group:'Instagram', short:'Опрос про Instagram', args:'[test|force]', args_en:'[test|force]',
    short_en:'Ask players about Instagram',
    help:'разослать активным игрокам просьбу прислать свой Instagram и подписаться на наш аккаунт. Сначала посмотрите, как это выглядит: <code>/instagram_ask test</code> пришлёт обе языковые версии только вам. Тем, кто уже ответил, повторно не пишем — чтобы написать всем, добавьте слово force. В том же сообщении у игрока есть кнопка «Не публиковать меня»: нажал — его матчи в Instagram больше не уходят, и вы получите об этом сообщение',
    help_en:'ask active players to send their Instagram and follow the league account. Preview it first: <code>/instagram_ask test</code> sends both language versions to you only. Players who already answered are skipped — add the word force to write to everyone. The same message carries a "Don\u2019t publish me" button: once tapped, that player\u2019s matches stop going to Instagram and you get a notice' },
  { cmd:'instagram_status', group:'Instagram', short:'Состояние Instagram',
    short_en:'Instagram status',
    help:'подключён ли Instagram, какой аккаунт и токен используются, и полный список тех, кто просил себя не публиковать',
    help_en:'whether Instagram is connected, which account and token are in use, and the full list of players who asked not to be published' },
  { cmd:'instagram_here',  group:'Instagram', short:'Материалы Instagram сюда',
    short_en:'Instagram materials here',
    help:'привязать текущую тему как место, куда будут приходить карточки недели и подпись к посту. Выполняется прямо в нужной теме, как /results_here. Не привязано — всё падает в общий админский чат',
    help_en:'bind the current topic as the place where the weekly cards and the post caption arrive. Run it inside the topic you want, like /results_here. If not bound, everything goes to the main admin chat' },
  { cmd:'instagram_week',  group:'Instagram', short:'Карусель недели', args:'[даты]', args_en:'[dates]',
    short_en:'Weekly carousel',
    help:'собрать карточки матчей за последние семь дней и прислать их пачками вместе с готовой подписью и хэштегами — чтобы можно было сохранить и выложить самому. За другой отрезок: <code>/instagram_week -2</code> — позапрошлая неделя, <code>/instagram_week 2026-09-01 2026-09-07</code> — точные даты. То же самое бот делает сам по воскресеньям в 19:00. Кнопка публикации появляется, только когда Instagram подключён',
    help_en:'collect this week\u2019s match cards and send them in batches with a ready caption and hashtags, so you can save and post them yourself. The bot does the same on Sundays at 19:00. The publish button appears only once Instagram is connected' },
  { cmd:'instagram_photos', group:'Instagram', short:'Фотографии недели', args:'[даты]', args_en:'[dates]',
    short_en:'Weekly photos',
    help:'собрать фотографии, которые игроки прикладывали к результатам за последние семь дней, и прислать их пачками с готовой подписью. Учитывается отказ от публикации: если хоть один игрок матча просил себя не публиковать, фото не войдёт. За другой отрезок: <code>/instagram_photos -2</code> или <code>/instagram_photos 2026-09-01 2026-09-07</code>. То же самое бот делает сам по четвергам в 19:00',
    help_en:'collect the photos players attached to their results over the last seven days and send them in batches with a ready caption. Opt-outs are respected: if either player of a match asked not to be published, the photo is left out. The bot does the same on Thursdays at 19:00' },
  { cmd:'tables', group:'Instagram', short:'Таблицы дивизионов', args:'[группа] [draft]', args_en:'[group] [draft]',
    short_en:'Division tables',
    help:'собрать сторис с таблицей по каждой группе: место, аватарка, имя, сыграно, выиграно, очки и ярлычок движения с прошлого выпуска. Без аргумента — все группы, с ним одна: <code>/tables B2</code>. Каждая картинка приходит со своей подписью, её можно скопировать одним касанием. Каждый выпуск запоминает места — от них считается движение в следующий раз; чтобы прогнать вхолостую и не сдвигать точку отсчёта, добавьте слово draft. Сам бот делает это по вторникам в 19:00 начиная с 6 октября и до конца сезона 8 ноября',
    help_en:'build a story image with the standings of every group: place, avatar, name, played, won, points and a movement badge since the last issue. Without an argument — all groups, with one — a single group: <code>/tables B2</code>. Each image arrives with its own caption, copyable in one tap. Every issue stores the places that next week\u2019s movement is measured from; add the word draft to run without moving that baseline. The bot does the same on Tuesdays at 19:00 from 6 October until the season ends on 8 November' },
  { cmd:'poster_test',  group:'Матчи', short:'Постер по сыгранному матчу', args_en:'[player name] [QF|SF|3rd|Final]', args:'[имя игрока] [QF|SF|3rd|Final]',
    short_en:'Poster for a played match',
    help:'собрать постер 9:16 по любому уже сыгранному матчу: имена, счёт, стадия, форма и движение по таблице берутся заново, поэтому старые матчи получают постер по действующему макету. Вторым словом можно назвать игрока, иначе берётся последний подтверждённый результат. Результат повторно не публикуется — два варианта приходят только вам. Последним словом — стадия плей-офф (QF, SF, 3rd, Final): постер соберётся в её оформлении, для проверки макета на реальной генерации, например <code>/poster_test Roman SF</code>',
    help_en:'build a 9:16 poster for any match already played: names, score, stage, form and table movement are recalculated, so old matches get a poster in the current layout. Name a player as the second word, otherwise the latest confirmed result is used. Nothing is republished — both variants come only to you. Add a playoff stage as the last word (QF, SF, 3rd, Final) to build it in that stage\u2019s design, e.g. /poster_test Roman SF' },
  { cmd:'announce',     group:'Матчи', short:'Афиша-анонс матча', args:'<игрок 1 | игрок 2 | комментарий>', args_en:'<player 1 | player 2 | comment>',
    short_en:'Match announcement poster',
    help:'афиша 9:16 к матчу, который ещё не сыгран: тот же AI-фон с двумя игроками, что у постера результата, но без счёта, формы и места — только имена, VS и дивизион. Комментарий необязателен: он уходит в промпт и строкой на афишу (дата, время, корт). Пример: <code>/announce Иван Петров | Пётр Сидоров | сб · 4 окт · 18:00 · The Dome</code>. Два варианта приходят сюда с кнопкой «Опубликовать в сторис». То же самое — формой во вкладке «Контроль» мини-приложения матчей',
    help_en:'a 9:16 poster for a match not yet played: the same AI background with both players as the result poster, but no score, form or place — just names, VS and the division. The comment is optional: it goes into the prompt and onto the poster as a line (date, time, court). Example: <code>/announce Ivan Petrov | Peter Sidorov | Sat · 4 Oct · 18:00 · The Dome</code>. Two variants arrive here with a «Publish to story» button. The same form lives in the «Admin» tab of the matches app' },
  { cmd:'match_test',   group:'Настройка', short:'Проверка таблиц', short_en:'Sheets check', help_en:'match sheets, league sheets and the division registry; also re-reads the registry', help:'таблицы матчей, таблицы лиги и реестр дивизионов; заодно перечитывает реестр' },
  { cmd:'avatar',       group:'Прочее', short:'Мои варианты аватарки', short_en:'My avatar options', help_en:'my avatar options', help:'мои варианты аватарки' },
  { cmd:'help',         group:'Прочее', short:'Все команды', short_en:'All commands', help_en:'this list', help:'этот список' },
  { cmd:'menu',         group:'Прочее', short:'Главное меню', short_en:'Main menu', help_en:'main menu', help:'главное меню' },
  { cmd:'cancel',       group:'Прочее', short:'Отменить действие', short_en:'Cancel', help_en:'cancel the current action', help:'отменить текущее действие' }
];

// Меню по слэшу: Telegram берёт только имя и короткое описание.
export const ADMIN_COMMANDS = ADMIN_COMMAND_LIST.map(c => ({
  command: c.cmd, description: c.short.slice(0, 256)
}));

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

// Скачивание файла, который игрок прислал боту. Нужно, чтобы отдать селфи
// генератору, а готовую аватарку — витрине: file_id у Telegram вечный, поэтому
// он же служит нам хранилищем картинок.
export async function getFileBuffer(fileId) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN env is empty');
  const meta = await call('getFile', { file_id: fileId });
  const path = meta?.file_path || meta?.result?.file_path || '';
  if (!path) throw new Error('Telegram не отдал путь к файлу');
  const res = await globalThis.fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`);
  if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = String(path).split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mime, path };
}
