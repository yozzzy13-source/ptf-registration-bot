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
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
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
