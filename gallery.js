// Галерея сайта: живые фото лиги — финалы, награждения, ужины.
//
// Источник — папка «PTF Gallery» на Google Диске. Костас просто кладёт туда
// фото; подпапки становятся альбомами («Сезон 1 · Финалы» и т.п.), порядок —
// от свежих к старым. Ничего настраивать в коде не нужно.
//
// Картинки отдаём через свой сервер, уменьшенными: оригинал с телефона весит
// 5–10 МБ, а плитке галереи хватает 500 пикселей. Готовые уменьшенные копии
// держим в памяти, чтобы Диск не дёргать на каждый показ. Отдаём только файлы
// из этой папки — посторонний id с Диска через нас не открыть.
import sharp from 'sharp';
import { drive } from './google.js';
import { GALLERY_FOLDER_ID } from './config.js';

const LIST_MS = 10 * 60 * 1000;
const MAX_ALBUMS = 12, MAX_PER_ALBUM = 60;
let listCache = { t: 0, v: null, building: null };
const known = new Set();
const images = new Map();          // `${id}:${w}` → Buffer
const IMAGE_CACHE = 120;

async function listFolder(folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await drive().files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,createdTime,imageMediaMetadata(width,height,time))',
      orderBy: 'createdTime desc', pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && out.length < 600);
  return out;
}
const isImage = f => /^image\//.test(f.mimeType || '');
const photo = f => {
  known.add(f.id);
  const w = Number(f.imageMediaMetadata?.width || 0), h = Number(f.imageMediaMetadata?.height || 0);
  return { id: f.id, ratio: w && h ? Math.round((w / h) * 100) / 100 : 0 };
};

async function buildGallery() {
  if (!GALLERY_FOLDER_ID) return { albums: [] };
  const top = await listFolder(GALLERY_FOLDER_ID);
  const albums = [];
  const loose = top.filter(isImage).slice(0, MAX_PER_ALBUM).map(photo);
  if (loose.length) albums.push({ title: '', photos: loose });
  // Подпапки — альбомы. Сортируем по имени от «большего» к «меньшему»: так
  // «Сезон 2» встаёт выше «Сезона 1» без всяких настроек.
  const folders = top.filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    .sort((a, b) => String(b.name).localeCompare(String(a.name), undefined, { numeric: true }))
    .slice(0, MAX_ALBUMS);
  for (const f of folders) {
    const photos = (await listFolder(f.id)).filter(isImage).slice(0, MAX_PER_ALBUM).map(photo);
    if (photos.length) albums.push({ title: String(f.name || '').trim(), photos });
  }
  return { albums };
}
export async function getGallery() {
  const fresh = listCache.v && Date.now() - listCache.t < LIST_MS;
  if (!fresh && !listCache.building) {
    listCache.building = buildGallery()
      .then(v => { listCache = { t: Date.now(), v, building: null }; return v; })
      .catch(e => { listCache.building = null; console.error('gallery list failed:', e.message); return listCache.v || { albums: [] }; });
  }
  return listCache.v || listCache.building;
}

// Уменьшенная копия фото. w — ширина: 500 для плитки, 1600 для просмотра.
export async function galleryImage(id, width = 500) {
  const fileId = String(id || '');
  if (!known.has(fileId)) {
    await getGallery();
    if (!known.has(fileId)) return null;
  }
  const w = width >= 1000 ? 1600 : 500;
  const key = `${fileId}:${w}`;
  if (images.has(key)) return images.get(key);
  const res = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  const buf = await sharp(Buffer.from(res.data)).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: w > 1000 ? 82 : 76, mozjpeg: true }).toBuffer();
  images.set(key, buf);
  if (images.size > IMAGE_CACHE) images.delete(images.keys().next().value);
  return buf;
}
