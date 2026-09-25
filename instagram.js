// Публикация в Instagram: сторис с постером и еженедельная карусель карточек.
//
// Работаем напрямую через официальный Content Publishing API. Это бесплатно:
// Meta не берёт денег ни за Instagram API, ни за разрешения на нём. Проверка
// бизнеса нужна только для «расширенного доступа» — то есть чтобы публиковать
// в ЧУЖИЕ аккаунты. Нам это не нужно: мы пишем в свой единственный аккаунт,
// поэтому приложение остаётся в режиме разработки, а аккаунт добавлен в него
// тестировщиком. Никакой оплаты и никакой проверки бизнеса.
//
// Instagram не принимает картинку файлом — только ссылку, по которой он сам
// её скачает. Поэтому готовое изображение кладётся в память процесса и на
// полчаса открывается по адресу вида PUBLIC_URL/ig/<id>.jpg. Дольше держать
// незачем: Instagram забирает файл в первые секунды.
import { PUBLIC_URL } from './config.js';

const GRAPH = `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || 'v23.0'}`;
const FACEBOOK_GRAPH = `https://graph.facebook.com/${process.env.IG_GRAPH_VERSION || 'v23.0'}`;
const USER_ID = String(process.env.IG_USER_ID || '').trim();
const TOKEN = String(process.env.IG_ACCESS_TOKEN || '').trim();
// Через какой домен ходить. Логин через Instagram — graph.instagram.com,
// классический через страницу Facebook — graph.facebook.com.
const BASE = String(process.env.IG_LOGIN || 'instagram').toLowerCase() === 'facebook' ? FACEBOOK_GRAPH : GRAPH;
export const IG_ACCOUNT = String(process.env.IG_ACCOUNT || 'phukettennisfamily').replace(/^@/, '');
export const IG_PROFILE_URL = `https://www.instagram.com/${IG_ACCOUNT}/`;
const TIMEOUT_MS = Math.max(10_000, Number(process.env.IG_TIMEOUT_MS || 60_000));

export function instagramEnabled() { return Boolean(USER_ID && TOKEN && PUBLIC_URL); }
export function instagramStatus() {
  return {
    enabled: instagramEnabled(),
    account: IG_ACCOUNT,
    user_id: USER_ID ? `…${USER_ID.slice(-4)}` : '',
    token: TOKEN ? `…${TOKEN.slice(-6)}` : '',
    login: BASE === FACEBOOK_GRAPH ? 'facebook' : 'instagram',
    public_url: PUBLIC_URL || ''
  };
}

// ------------------------------------------------------- временная витрина
const media = new Map();
const MEDIA_TTL_MS = 30 * 60 * 1000;
function sweep() {
  const now = Date.now();
  for (const [id, item] of media) if (now - item.at > MEDIA_TTL_MS) media.delete(id);
}
export function rememberMedia(buffer, mime = 'image/jpeg') {
  sweep();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  media.set(id, { buffer, mime, at: Date.now() });
  if (media.size > 60) media.delete(media.keys().next().value);
  return { id, url: `${PUBLIC_URL}/ig/${id}.jpg` };
}
export function takeMedia(id) {
  sweep();
  return media.get(String(id).replace(/\.jpe?g$/i, '')) || null;
}
export function forgetMedia(id) { media.delete(String(id)); }

// ------------------------------------------------------------ сам API
async function call(path, params = {}, method = 'POST') {
  if (!instagramEnabled()) throw new Error('Instagram не подключён: не заданы IG_USER_ID и IG_ACCESS_TOKEN');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ access_token: TOKEN });
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const url = `${BASE}/${path}`;
    const res = method === 'GET'
      ? await fetch(`${url}?${query}`, { signal: controller.signal })
      : await fetch(url, { method: 'POST', body: query, signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const e = json?.error || {};
      throw new Error(`${e.message || `Instagram ответил ${res.status}`}${e.code ? ` (код ${e.code})` : ''}`);
    }
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Instagram не ответил за ${Math.round(TIMEOUT_MS / 1000)} с`);
    throw e;
  } finally { clearTimeout(timer); }
}

// Контейнер готовится асинхронно: сразу после создания он ещё IN_PROGRESS.
// Публиковать можно только FINISHED, иначе получаем «Media ID is not available».
async function waitReady(creationId, { tries = 20, pause = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const info = await call(creationId, { fields: 'status_code,status' }, 'GET').catch(() => null);
    const status = String(info?.status_code || '').toUpperCase();
    if (status === 'FINISHED') return true;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram не принял изображение: ${info?.status || status}`);
    await new Promise(r => setTimeout(r, pause));
  }
  throw new Error('Instagram слишком долго готовил публикацию');
}

const tagList = (handles = []) => [...new Set((handles || [])
  .map(h => String(h || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').replace(/^@+/, ''))
  .filter(Boolean))];

// Отметки игроков. Для ленты Instagram ждёт координаты, для сторис — тоже.
// Раскладываем метки ровно по горизонтали в нижней трети: там их видно и они
// не лезут на лица.
function userTags(handles = [], { story = false } = {}) {
  const list = tagList(handles);
  if (!list.length) return null;
  return list.map((username, index) => ({
    username,
    x: Number(((index + 1) / (list.length + 1)).toFixed(3)),
    y: story ? 0.78 : 0.92
  }));
}

// Публикация в сторис. Отметки для сторис документированы хуже всего, поэтому
// при отказе по этому полю повторяем без них: лучше опубликовать без меток,
// чем не опубликовать вовсе. О том, что метки не прошли, сообщаем наверх.
export async function publishStory(buffer, { handles = [] } = {}) {
  const { id, url } = rememberMedia(buffer);
  try {
    const tags = userTags(handles, { story: true });
    let container = null, taggedFailed = '';
    try {
      container = await call(`${USER_ID}/media`, { image_url: url, media_type: 'STORIES', user_tags: tags || undefined });
    } catch (e) {
      if (!tags) throw e;
      taggedFailed = e.message;
      container = await call(`${USER_ID}/media`, { image_url: url, media_type: 'STORIES' });
    }
    await waitReady(container.id);
    const published = await call(`${USER_ID}/media_publish`, { creation_id: container.id });
    return { ok: true, id: published.id, tagged: taggedFailed ? [] : tagList(handles), tag_error: taggedFailed };
  } finally {
    setTimeout(() => forgetMedia(id), 5 * 60 * 1000).unref?.();
  }
}

// Карусель: до десяти картинок одним постом. Каждая картинка сначала едет
// отдельным контейнером с is_carousel_item, потом собирается общий.
// Сколько карточек кладём в один пост. Meta в документации обещает десять,
// но по факту у аккаунтов лимит бывает выше, поэтому пробуем двадцать, а при
// отказе автоматически урезаем до десяти — см. publishCarousel.
export const CAROUSEL_MAX = Math.max(2, Math.min(50, Number(process.env.IG_CAROUSEL_MAX || 20)));
export const CAROUSEL_SAFE = 10;
export async function publishCarousel(images = [], { caption = '', handles = [] } = {}) {
  const list = images.slice(0, CAROUSEL_MAX);
  if (!list.length) throw new Error('Нечего публиковать: нет ни одной картинки');
  const kept = [];
  try {
    const children = [];
    for (const image of list) {
      const item = rememberMedia(image.buffer || image);
      kept.push(item.id);
      const container = await call(`${USER_ID}/media`, { image_url: item.url, is_carousel_item: 'true' });
      children.push(container.id);
    }
    for (const child of children) await waitReady(child);
    const tags = userTags(handles);
    let taggedFailed = '', trimmed = 0;
    // Собираем пост в три захода: с метками, без меток, и — если Instagram не
    // принял длинную карусель — урезанный до безопасной десятки. Лучше выйти
    // постом из десяти карточек, чем не выйти вовсе.
    const build = async (ids, withTags) => call(`${USER_ID}/media`, {
      media_type: 'CAROUSEL', children: ids.join(','), caption, user_tags: withTags && tags ? tags : undefined
    });
    let parent = null;
    try { parent = await build(children, true); }
    catch (e) {
      if (tags) taggedFailed = e.message;
      try { parent = await build(children, false); }
      catch (inner) {
        if (children.length <= CAROUSEL_SAFE) throw inner;
        trimmed = children.length - CAROUSEL_SAFE;
        parent = await build(children.slice(0, CAROUSEL_SAFE), false);
      }
    }
    await waitReady(parent.id);
    const published = await call(`${USER_ID}/media_publish`, { creation_id: parent.id });
    return {
      ok: true, id: published.id, count: list.length - trimmed, trimmed,
      tagged: taggedFailed ? [] : tagList(handles), tag_error: taggedFailed
    };
  } finally {
    setTimeout(() => kept.forEach(forgetMedia), 5 * 60 * 1000).unref?.();
  }
}

// Токен живёт 60 дней и продлевается одним запросом. Дёргаем раз в сутки:
// продление раньше срока ничего не портит, а пропущенное окно означает, что
// публикации встанут молча.
export async function refreshToken() {
  if (!TOKEN) return { ok: false, reason: 'no_token' };
  const url = `${BASE === FACEBOOK_GRAPH ? FACEBOOK_GRAPH : GRAPH}/refresh_access_token`;
  const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: TOKEN });
  const res = await fetch(`${url}?${query}`).catch(() => null);
  const json = await res?.json().catch(() => ({})) || {};
  if (!res?.ok || json?.error) return { ok: false, reason: json?.error?.message || 'refresh_failed' };
  // Новый токен показываем в лог: подставить его в переменные Railway нужно
  // руками — в окружение работающего процесса записать нельзя.
  return { ok: true, token: String(json.access_token || ''), expires_in: Number(json.expires_in || 0) };
}
