// Аватарки игроков: селфи → обработка ИИ → картинка в профиле лиги.
//
// Ключевое решение: пока нет OPENAI_API_KEY, генератор работает ЗАГЛУШКОЙ и
// возвращает исходное фото. Это позволяет проверить всю цепочку целиком —
// загрузку, очередь, уведомление организатору, утверждение и подстановку в
// витрину — не тратя ни рубля и не завися от чужого API. Как только ключ
// появится в окружении, тот же код пойдёт в настоящую генерацию: меняется
// только одна функция, всё остальное уже проверено.
//
// Готовую картинку не храним в файлах: Telegram сам хранит её вечно по
// file_id, а витрине мы отдаём её через собственный адрес /avatar/<id>.png.
// Никакого Drive, никаких протухающих ссылок.
import { getFileBuffer, sendPhotoBuffer } from './telegram.js';
import { findApplicantByTelegramId, updateApplicantByTelegramId, ensureAvatarColumns } from './sheets.js';
import { nowISO } from './util.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
// Промпт держим в окружении, чтобы правки не требовали выкладки кода.
const DEFAULT_PROMPT = 'Stylized tennis player avatar portrait, keep the face recognizable, clean background, square crop, shoulders up.';
export function avatarPrompt() { return process.env.AVATAR_PROMPT || DEFAULT_PROMPT; }
export function avatarReady() { return Boolean(OPENAI_API_KEY); }

export const MAX_ATTEMPTS = Number(process.env.AVATAR_MAX_ATTEMPTS || 3);

// Статусы держим в анкете, чтобы перезапуск сервиса не терял состояние.
export const AVATAR_STATUS = {
  none: '', queued: 'queued', generating: 'generating',
  ready: 'ready', published: 'published', failed: 'failed'
};

// --------------------------------------------------------------- генерация
// Настоящий вызов OpenAI. Ошибку не глотаем: организатору важно видеть, что
// именно ответил провайдер — отказ по политике и упавшая сеть чинятся по-разному.
async function generateWithOpenAI(buffer, mime) {
  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('prompt', avatarPrompt());
  form.append('size', '1024x1024');
  form.append('n', '1');
  form.append('image', new Blob([buffer], { type: mime || 'image/jpeg' }), 'selfie.jpg');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `OpenAI ответил ${res.status}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI не вернул изображение');
  return Buffer.from(b64, 'base64');
}

// Заглушка: возвращаем исходник как есть. Специально НЕ рисуем ничего своего —
// так на любом экране сразу видно, что генерация ещё не подключена, и это
// невозможно принять за настоящий результат.
async function generateStub(buffer) { return buffer; }

export async function renderAvatar(buffer, mime) {
  if (avatarReady()) return { buffer: await generateWithOpenAI(buffer, mime), stub: false };
  return { buffer: await generateStub(buffer), stub: true };
}

// ------------------------------------------------------------------ очередь
// Одна картинка делается десятки секунд, поэтому запрос игрока не ждёт
// результата: задача встаёт в очередь, а игрок видит статус. Очередь на один
// поток — и чтобы не упереться в лимиты провайдера, и чтобы расход был
// предсказуемым.
const queue = [];
let running = false;
let onDone = async () => {};
export function setAvatarHandler(fn) { onDone = fn; }

export function queueLength() { return queue.length + (running ? 1 : 0); }

export async function enqueueAvatar(telegramId) {
  const id = String(telegramId);
  if (queue.includes(id)) return { ok: true, queued: true, position: queue.indexOf(id) + 1 };
  queue.push(id);
  pump();
  return { ok: true, queued: true, position: queue.length };
}

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  running = true;
  try { await processOne(id); }
  catch (e) { console.error('avatar job failed:', id, e.message); }
  running = false;
  if (queue.length) pump();
}

async function processOne(telegramId) {
  await ensureAvatarColumns().catch(() => {});
  const profile = await findApplicantByTelegramId(telegramId);
  const sourceId = profile?.selfie_file_id || '';
  if (!sourceId) {
    await updateApplicantByTelegramId(telegramId, { avatar_status: AVATAR_STATUS.failed, avatar_error: 'нет исходного селфи', avatar_updated_at: nowISO() });
    return;
  }
  await updateApplicantByTelegramId(telegramId, { avatar_status: AVATAR_STATUS.generating, avatar_error: '', avatar_updated_at: nowISO() });
  try {
    const src = await getFileBuffer(sourceId);
    const { buffer, stub } = await renderAvatar(src.buffer, src.mime);
    // Кладём результат в Telegram — он же и наше хранилище: file_id вечный,
    // а отдаём картинку витрине мы сами по /avatar/<id>.png.
    // Варианты копим, а не перетираем: игрок делает до трёх генераций и
    // выбирает из них ту, что нравится. Поэтому file_id складываются списком.
    const attempts = Number(profile?.avatar_attempts || 0) + 1;
    const left = Math.max(0, MAX_ATTEMPTS - attempts);
    const sent = await sendPhotoBuffer(telegramId, buffer, 'image/jpeg', {
      caption: variantCaption(attempts, left, stub)
    });
    const fileId = photoIdFrom(sent);
    const options = mergeOptions(profile?.avatar_options, fileId);
    await updateApplicantByTelegramId(telegramId, {
      avatar_status: AVATAR_STATUS.ready,
      avatar_options: options.join(','),
      avatar_stub: stub ? 'yes' : '',
      avatar_attempts: String(attempts),
      avatar_error: '',
      avatar_updated_at: nowISO()
    });
    await onDone({ telegramId: String(telegramId), fileId, index: options.length, left, stub, profile });
  } catch (e) {
    await updateApplicantByTelegramId(telegramId, {
      avatar_status: AVATAR_STATUS.failed,
      avatar_error: String(e.message || e).slice(0, 200),
      avatar_updated_at: nowISO()
    });
    throw e;
  }
}

// sendPhotoBuffer возвращает уже развёрнутый result, но подстрахуемся на оба вида.
export function photoIdFrom(sent) {
  const photo = sent?.photo || sent?.result?.photo || [];
  return photo.length ? photo[photo.length - 1].file_id : '';
}

// ------------------------------------------------------------------ галерея
export function optionList(value = '') {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}
export function mergeOptions(value, fileId) {
  const list = optionList(value);
  if (fileId && !list.includes(fileId)) list.push(fileId);
  return list.slice(0, MAX_ATTEMPTS);
}
function variantCaption(n, left, stub) {
  const head = `🖼 Вариант ${n} из ${MAX_ATTEMPTS}`;
  const tail = left
    ? `\n\nНравится — жми «Выбрать этот». Хочешь другой — «Ещё вариант», осталось ${left}.`
    : '\n\nЭто последний вариант. Выбери тот, что больше нравится — все они сохранены.';
  const warn = stub ? '\n\n⚠️ Генерация ИИ ещё не подключена, пока возвращается исходное фото.' : '';
  return head + warn + tail;
}

// Запрос ещё одного варианта из кнопки в чате. Лимит проверяем здесь же —
// это единственная точка входа для повторной генерации.
export async function requestAnotherAvatar(telegramId) {
  const profile = await findApplicantByTelegramId(telegramId).catch(() => null);
  if (!profile?.selfie_file_id) return { ok: false, error: 'Сначала загрузи селфи в разделе «Лига» → своя карточка → «Аватарка».' };
  const attempts = Number(profile.avatar_attempts || 0);
  if (attempts >= MAX_ATTEMPTS) return { ok: false, error: `Попытки закончились (${MAX_ATTEMPTS}). Выбери из уже готовых вариантов — команда /avatar.` };
  await updateApplicantByTelegramId(telegramId, { avatar_status: AVATAR_STATUS.queued, avatar_error: '', avatar_updated_at: nowISO() });
  await enqueueAvatar(telegramId);
  return { ok: true };
}

// ------------------------------------------------ перенос фото из Players_Master
// В Players_Master фото лежат ссылками — чаще всего на Google Drive. Такие
// ссылки то отдают картинку, то нет, а найти их можно только по имени, и
// «Tom Sauer» с лишним пробелом уже не совпадал. Поэтому переносим эти фото
// туда же, где живут собственные аватарки игроков: в Telegram, по file_id.
// Ровно то же самое, что делает организатор, загружая аватарку в админке, —
// только без уведомления каждому игроку: это массовый перенос, а не новость.
//
// Трогаем ТОЛЬКО тех, у кого своей аватарки нет. Кто сделал себе аватарку,
// остаётся со своей. Прогон безопасно повторять: перенесённые в следующий раз
// уже имеют avatar_file_id и пропускаются, поэтому запускаем его после старта
// и раз в сутки — так подхватываются и игроки, добавленные позже.
const IMPORT_LIMIT = 40;        // за один прогон, чтобы не упереться в лимиты
// Фото в Players_Master лежат на postimg.cc — он за Cloudflare и после серии
// быстрых запросов с адреса дата-центра начинает обрывать соединения. Поэтому
// ходим как браузер, медленно, с паузой и повтором после обрыва, а если хост
// упёрся несколько раз подряд — прекращаем прогон и досылаем остальных позже.
const IMPORT_PAUSE_MS = 2500;
const IMPORT_RETRY_PAUSE_MS = 30 * 1000;
const IMPORT_STOP_AFTER = 3;    // подряд неудач по сети — хост нас притормозил
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// «fetch failed» ничего не объясняет — настоящая причина лежит в e.cause.
function networkReason(e) {
  const code = e?.cause?.code || e?.code || '';
  const known = {
    ECONNRESET: 'хост оборвал соединение', ETIMEDOUT: 'хост не ответил вовремя',
    UND_ERR_CONNECT_TIMEOUT: 'хост не ответил вовремя', ECONNREFUSED: 'хост отказал в соединении',
    ENOTFOUND: 'адрес не существует', EAI_AGAIN: 'адрес не определился',
    UND_ERR_SOCKET: 'хост оборвал соединение', AbortError: 'хост не ответил за 20 с'
  };
  if (e?.name === 'AbortError') return known.AbortError;
  return known[code] || (code ? `ошибка сети ${code}` : (e?.message || 'ошибка сети'));
}
async function downloadImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20 * 1000);
  try {
    const res = await globalThis.fetch(url, { redirect: 'follow', headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) { const err = new Error(`ссылка ответила ${res.status}`); err.http = true; throw err; }
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(mime)) { const err = new Error(`по ссылке не картинка (${mime || 'пусто'})`); err.http = true; throw err; }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) { const err = new Error('пустой файл'); err.http = true; throw err; }
    return { buffer, mime };
  } finally { clearTimeout(timer); }
}
// Одна повторная попытка после паузы: обрыв часто разовый.
async function downloadWithRetry(url) {
  try { return await downloadImage(url); }
  catch (e) {
    if (e.http) throw e;
    await sleep(IMPORT_RETRY_PAUSE_MS);
    return downloadImage(url);
  }
}

export async function importMasterAvatars({ adminChatId = '' } = {}) {
  if (!adminChatId) return { ok: false, reason: 'no_admin_chat' };
  const { getRows, getMasterPhotos, sameName, invalidateLeagueCache } = await import('./sheets.js');
  const { SHEETS } = await import('./config.js');
  const { deleteMessage } = await import('./telegram.js');
  await ensureAvatarColumns().catch(() => {});
  const [{ rows }, master] = await Promise.all([
    getRows(SHEETS.applicants, { useCache: false }),
    getMasterPhotos().catch(() => new Map())
  ]);
  const photos = [...master].filter(([, url]) => String(url || '').trim());
  const todo = [];
  for (const row of rows || []) {
    const telegramId = String(row.telegram_id || '').trim();
    if (!telegramId || String(row.avatar_file_id || '').trim()) continue;
    const hit = photos.find(([name]) => sameName(name, row.name));
    if (hit) todo.push({ telegramId, name: String(row.name || ''), url: String(hit[1]).trim(),
      retried: String(row.avatar_error || '').startsWith('master_import') });
  }
  // Сначала те, кого ещё не пробовали: битые ссылки не должны навсегда занять
  // собой лимит прогона. Их повторяем в конце очереди — вдруг ссылку уже
  // поправили в Players_Master.
  todo.sort((a, b) => Number(a.retried) - Number(b.retried));
  const done = [], failed = [];
  let networkStreak = 0, stoppedEarly = false, tried = 0;
  for (const item of todo.slice(0, IMPORT_LIMIT)) {
    if (networkStreak >= IMPORT_STOP_AFTER) { stoppedEarly = true; break; }
    tried++;
    try {
      const { buffer, mime } = await downloadWithRetry(item.url);
      networkStreak = 0;
      const sent = await sendPhotoBuffer(adminChatId, buffer, mime, { disable_notification: true });
      const fileId = (sent?.photo || []).slice(-1)[0]?.file_id || '';
      if (sent?.message_id) await deleteMessage(adminChatId, sent.message_id).catch(() => {});
      if (!fileId) throw new Error('Telegram не принял фото');
      await updateApplicantByTelegramId(item.telegramId, {
        avatar_file_id: fileId, avatar_status: AVATAR_STATUS.published, avatar_error: '', avatar_updated_at: nowISO()
      });
      done.push(item.name);
    } catch (e) {
      const reason = e.http ? e.message : networkReason(e);
      if (!e.http) networkStreak++;
      failed.push({ name: item.name, error: reason, network: !e.http });
      console.error(`avatar import failed for ${item.name}:`, reason, item.url);
      await updateApplicantByTelegramId(item.telegramId, { avatar_error: `master_import: ${reason}`.slice(0, 200) }).catch(() => {});
    }
    await sleep(IMPORT_PAUSE_MS);
  }
  if (done.length) invalidateLeagueCache?.();
  // Сетевые неудачи — не битые ссылки: хост просто притормозил нас. Их и
  // непройденный остаток досылаем следующим прогоном.
  const retryable = failed.filter(f => f.network).length + Math.max(0, todo.length - tried);
  return { ok: true, done, failed, stoppedEarly, retryable, left: Math.max(0, todo.length - tried) };
}
