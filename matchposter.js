// Постер матча — заготовка. Пока НЕ включён: ждём промпт и обкатку.
//
// Как договорились:
//   • картинку 9:16 рисует OpenAI по двум аватаркам игроков и промпту;
//   • весь текст (логотип, счёт, имена, дивизион, дата) кладём поверх сами —
//     модели коверкают надписи, а счёт врать не имеет права;
//   • качество medium, промпт и модель — переменными окружения;
//   • если у кого-то нет аватарки, генерацию не запускаем вовсе;
//   • не больше POSTER_DAILY_LIMIT штук в сутки;
//   • одна повторная попытка при ошибке, дальше карточка матча;
//   • готовый постер запоминаем по file_id, чтобы не платить дважды.
//
// Сейчас модуль всегда отвечает «постера нет» — и лента спокойно уходит с
// карточкой матча. Когда появится ключ и промпт, включаем POSTER_ENABLED, и
// цепочка вокруг уже готова: менять придётся только generate().
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.POSTER_IMAGE_MODEL || 'gpt-image-2';
const QUALITY = process.env.POSTER_QUALITY || 'medium';
const SIZE = process.env.POSTER_SIZE || '1024x1536';
const DAILY_LIMIT = Number(process.env.POSTER_DAILY_LIMIT || 50);
const DEFAULT_PROMPT = 'Two tennis players standing side by side, full body, sports portrait, '
  + 'warm sunset light, clean neutral studio-style background, no text, no logos, '
  + 'photorealistic, vertical composition';

// Рубильник отдельный от ключа: ключ может быть заведён для аватарок, а постер
// при этом ещё не обкатан.
export function posterEnabled() {
  return Boolean(OPENAI_API_KEY) && String(process.env.POSTER_ENABLED || '').toLowerCase() === 'on';
}
export function posterPrompt() { return process.env.POSTER_PROMPT || DEFAULT_PROMPT; }
export function posterSettings() {
  return { model: MODEL, quality: QUALITY, size: SIZE, dailyLimit: DAILY_LIMIT, enabled: posterEnabled() };
}

// Расход за сутки. Хранится в памяти: перезапуск обнуляет, и это осознанно —
// лимит нужен от случайного цикла, а не для бухгалтерии.
let spent = { day: '', count: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
export function posterQuotaLeft() {
  if (spent.day !== today()) spent = { day: today(), count: 0 };
  return Math.max(0, DAILY_LIMIT - spent.count);
}
function spend() {
  if (spent.day !== today()) spent = { day: today(), count: 0 };
  spent.count += 1;
}

// Главная точка входа. Возвращает { buffer, ms } или null — «постера нет,
// отправляй карточку».
export async function renderMatchPoster(match = {}, { photos = [] } = {}) {
  if (!posterEnabled()) return null;
  if (photos.length < 2 || photos.some(p => !p)) return null;   // без двух лиц не начинаем
  if (posterQuotaLeft() <= 0) {
    console.warn('poster: суточный лимит исчерпан');
    return null;
  }
  const started = Date.now();
  try {
    const buffer = await generate(photos);
    spend();
    return { buffer, ms: Date.now() - started };
  } catch (e) {
    console.error('poster: первая попытка не удалась:', e.message);
    try {
      const buffer = await generate(photos);
      spend();
      return { buffer, ms: Date.now() - started };
    } catch (e2) {
      console.error('poster: вторая попытка тоже:', e2.message);
      return null;
    }
  }
}

// Сам вызов провайдера. Ровно та же форма, что у генератора аватарок, только
// картинок на входе две. Включится, когда появятся ключ и промпт.
async function generate(photos) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', posterPrompt());
  form.append('size', SIZE);
  form.append('quality', QUALITY);
  form.append('n', '1');
  for (const p of photos) form.append('image[]', new Blob([p], { type: 'image/jpeg' }), 'player.jpg');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `OpenAI ответил ${res.status}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI не вернул изображение');
  return Buffer.from(b64, 'base64');
}
