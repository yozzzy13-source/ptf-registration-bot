// Лента партнёров — одна на все наши картинки: карточку матча, постер матча
// и постер таблицы дивизиона.
//
// Правило простое: никакой рамки, подложки и подписи. В макете просто
// остаётся пустое место, и туда вписывается один общий файл assets/sponsors.png
// во всю ширину кадра. Нет файла — место остаётся пустым, и это нормально:
// пустая рамка на публикации выглядит хуже, чем её отсутствие.
//
// Высоту не выдумываем: какая пропорция у файла, такая и будет. Если по
// пропорции лента в свободную полосу не помещается, уменьшаем её целиком —
// растягивать или обрезать логотипы нельзя. Поэтому идеальный файл — во всю
// ширину картинки и не выше свободной полосы (на постере это 1080×262).
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
export const SPONSOR_FILE = path.join(ASSETS_DIR, 'sponsors.png');

export function sponsorsAvailable() {
  try { return fs.statSync(SPONSOR_FILE).size > 0; } catch { return false; }
}

// top/bottom — границы свободной полосы, canvas — ширина картинки, в которую
// кладём. Возвращает готовый слой для sharp.composite() или null.
export async function sponsorStrip({ top, bottom, width = 0, canvas = 1080 } = {}) {
  if (!sponsorsAvailable()) return null;
  const band = Math.max(0, Math.round(bottom - top));
  if (!band) return null;
  try {
    const strip = await sharp(SPONSOR_FILE)
      .resize({ width: Math.round(width || canvas), height: band, fit: 'inside' }).png().toBuffer();
    const meta = await sharp(strip).metadata();
    const iw = meta.width || canvas, ih = meta.height || band;
    return {
      layer: { input: strip, left: Math.round((canvas - iw) / 2), top: Math.round(top + (band - ih) / 2) },
      image: { width: iw, height: ih }
    };
  } catch (e) { console.error('sponsors strip failed:', e.message); return null; }
}
