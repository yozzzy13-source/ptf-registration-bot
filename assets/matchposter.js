// Генерация постера матча через OpenAI Image API.
//
// Два исходных фото используются только как ссылки на личности игроков.
// Нейросеть создаёт сцену без текста, а сервер накладывает точные имена, счёт,
// форму, позиции и сменные логотипы. Готовый PNG отправляется прямо в Telegram;
// Google Drive для ветки постеров не требуется.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApplicantByTelegramId } from './sheets.js';
import { matchDataForSlot, playerPhotoForPoster } from './matchcard.js';

const WIDTH = 1080;
const HEIGHT = 1920;
const VARIANTS = Math.max(1, Math.min(2, Number(process.env.MATCH_POSTER_VARIANTS || 2)));
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_IMAGE_API_URL = String(process.env.OPENAI_IMAGE_API_URL || 'https://api.openai.com/v1/images/edits').trim();
const MODEL = process.env.POSTER_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const QUALITY = process.env.POSTER_QUALITY || 'medium';
const SIZE = process.env.POSTER_SIZE || '1008x1792';
const API_TIMEOUT_MS = Math.max(30_000, Number(process.env.POSTER_API_TIMEOUT_MS || 180_000));
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const LOGOS_DIR = path.join(ASSETS_DIR, 'match-card-logos');

const DEFAULT_PROMPT = `Create a cinematic vertical 9:16 tennis match poster background using the two supplied player portraits as strict identity references.

REFERENCE ASSIGNMENT
Player 1 is {{player_1}} and must appear on the left.
Player 2 is {{player_2}} and must appear on the right.

Preserve each person's exact recognizable facial identity, including face proportions, eyes, nose, mouth, jawline, skin tone, apparent age, hairstyle and distinctive features. Do not blend their faces, swap traits, or beautify either person into someone different.

FRAMING — this is the most important instruction
Shoot both players as a close portrait, not a full-body or environmental shot. Crop each player just below the shoulders, at mid-chest level. Heads and faces must be large and clearly readable, occupying a substantial part of the frame. The camera is close to the subjects, at eye level, with a portrait lens look (85mm equivalent). Leave roughly 12 percent breathing room above their heads. Do not show the waist, hips, legs or full torso. Do not pull the camera back. Do not make the players small in a wide scene.

Place the two portraits side by side in the upper two thirds of the frame, with equal visual weight and a small gap between them.

Do not show tennis rackets, tennis balls, trophies, sports bags or any sports equipment. Keep hands out of the frame or barely visible at the bottom crop.

Keep both players' shoulders and posture relaxed and natural, and different from each other — not mirrored, not staged, no crossed arms. When possible, preserve the shoulder line and head angle visible in the supplied portraits.

Both players wear premium modern minimalist tennis apparel in clearly different complementary colors selected from blue, red, white, gray, pink, light blue, beige, yellow or black. Only collars and upper chest are visible.

The setting is a premium blue hard court at a luxury tennis club in Phuket during a vibrant tropical sunset, rendered as a softly blurred background behind the portraits. The sky has a rich gradient of fiery orange, deep violet and soft pink. Palm trees and tropical foliage are suggested in the background bokeh. Use warm low-angle sunlight, cinematic rim lighting on the shoulders and hair, realistic skin texture, shallow depth of field and polished professional sports portrait photography.

Keep the bottom 30 percent of the image dark, calm and free from faces, hands and important scene details. That area is covered later by an information panel and by real sponsor logos added by code.

Do not generate text, letters, player names, scores, rankings, badges, banners, logos, watermarks, scoreboards, trophies or fake sponsor marks. The image generator creates only the photographic scene.`;

const cleanEnvPrompt = value => String(value || '').replace(/\\n/g, '\n').trim();
export function posterPromptTemplate() {
  return cleanEnvPrompt(process.env.MATCH_POSTER_PROMPT)
    || cleanEnvPrompt(process.env.POSTER_PROMPT)
    || DEFAULT_PROMPT;
}
export function posterPromptSource() {
  if (cleanEnvPrompt(process.env.MATCH_POSTER_PROMPT)) return 'MATCH_POSTER_PROMPT';
  if (cleanEnvPrompt(process.env.POSTER_PROMPT)) return 'POSTER_PROMPT';
  return 'built_in_default';
}

export function posterEnabled() { return Boolean(OPENAI_API_KEY); }
export function posterSettings() {
  return {
    apiConnected:posterEnabled(),
    model:MODEL,
    quality:QUALITY,
    size:SIZE,
    output:{ width:WIDTH, height:HEIGHT, aspectRatio:'9:16' },
    variants:VARIANTS,
    promptSource:posterPromptSource()
  };
}

function tokenMap(match={}, comment='', variant=1) {
  return {
    player_1:String(match.winner || ''),
    player_2:String(match.loser || ''),
    winner:String(match.winner || ''),
    loser:String(match.loser || ''),
    score:String(match.score || ''),
    division:String(match.division || ''),
    season:String(match.season || ''),
    comment:String(comment || ''),
    variant:String(variant)
  };
}
function fillTokens(template, values) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
    (whole,key) => Object.prototype.hasOwnProperty.call(values,key.toLowerCase()) ? values[key.toLowerCase()] : whole);
}
const VARIANT_NOTES = [
  'Composition option 1: calm premium editorial portraits, both faces at the same height, soft symmetrical lighting, chest-level crop.',
  'Composition option 2: slightly different head angles and a stronger sunset rim light, one player a touch closer to camera, still a chest-level crop with both faces large and readable.'
];

export function buildPosterPrompt(match={}, { comment='', variant=1 }={}) {
  const n = Math.max(1, Math.min(VARIANTS, Number(variant || 1)));
  const values = tokenMap(match, comment, n);
  const base = fillTokens(posterPromptTemplate(), values);
  const context = [
    `Reference assignment: player 1 is ${values.player_1 || 'the first supplied portrait'}; player 2 is ${values.player_2 || 'the second supplied portrait'}.`,
    VARIANT_NOTES[n - 1] || VARIANT_NOTES[0],
    comment ? `Organizer direction: ${comment}` : '',
    'Mandatory composition constraints: close portrait crop just below the shoulders, faces large and identical to the references, no tennis rackets, balls or equipment, and a dark calm bottom third for the information panel and sponsor logos.',
    'The image generator creates only the photographic scene. Exact names, score, rankings, form and organization logos are added later by code.'
  ].filter(Boolean).join('\n');
  return base + '\n\n' + context;
}

const consentValue = row => String(row?.photo_publication_consent || '').trim().toUpperCase();
// По текущей политике блокирует только явный отказ. Пустое поле или ещё не
// полученный ответ считаются разрешением.
export function posterConsentAllowed(value='') {
  return String(value || '').trim().toUpperCase() !== 'NO';
}
export async function preparePosterJob(slot={}, {
  winnerFirstScore, season='', comment='', variants=VARIANTS
}={}) {
  const match = await matchDataForSlot(slot, { winnerFirstScore, season });
  const players = await Promise.all([
    findApplicantByTelegramId(match.winnerId).catch(() => null),
    findApplicantByTelegramId(match.loserId).catch(() => null)
  ]);
  const consent = players.map((row,index) => ({
    telegram_id:String((index ? match.loserId : match.winnerId) || ''),
    name:String((index ? match.loser : match.winner) || ''),
    value:consentValue(row) || 'NOT_ANSWERED',
    allowed:posterConsentAllowed(consentValue(row))
  }));
  const count = Math.max(1, Math.min(2, Number(variants || VARIANTS)));
  const prompts = Array.from({length:count},(_,i)=>({
    variant:i + 1,
    prompt:buildPosterPrompt(match,{comment,variant:i + 1})
  }));
  const allowed = consent.every(x => x.allowed);
  return {
    schema_version:1,
    job_id:`poster-${String(slot.challenge_id || slot.match_id || 'match')}-${Date.now()}`,
    match_id:String(slot.challenge_id || slot.match_id || ''),
    created_at:new Date().toISOString(),
    status:allowed ? (posterEnabled() ? 'ready_to_generate' : 'api_not_configured') : 'blocked_consent',
    api_connected:posterEnabled(),
    prompt_source:posterPromptSource(),
    settings:posterSettings(),
    comment:String(comment || '').trim(),
    match,
    consent,
    prompts,
    variants:prompts.map(p=>({ variant:p.variant, status:'ready_to_generate', telegram_file_id:'' }))
  };
}

// Вызывается только будущим API-адаптером. Повторно проверяет согласие перед
// чтением файлов, поэтому фотографии не уйдут во внешний сервис после отказа.
export async function loadPosterSourcePhotos(job={}) {
  if (!Array.isArray(job.consent) || !job.consent.every(x => x.allowed)) {
    throw new Error('poster_consent_required');
  }
  const match = job.match || {};
  const photos = await Promise.all([
    playerPhotoForPoster({ telegramId:match.winnerId, name:match.winner }),
    playerPhotoForPoster({ telegramId:match.loserId, name:match.loser })
  ]);
  if (photos.some(p => !p)) throw new Error('poster_source_photo_missing');
  return photos;
}

function esc(value='') {
  return String(value).replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[m]));
}
function fit(value='', max=14) {
  const s=String(value||'').trim();
  if(s.length<=max)return s;
  const parts=s.split(/\s+/);
  if(parts.length>1) {
    const short=`${parts[0]} ${parts[parts.length-1][0]}.`;
    if(short.length<=max)return short;
  }
  return s.slice(0,Math.max(1,max-1))+'…';
}

// Шрифт берём тот же, что у карточки матча, и тем же способом: librsvg внутри
// sharp не читает встроенные в SVG шрифты, он спрашивает их у fontconfig.
// Имя семейства читаем из самого файла — тогда замена шрифта остаётся заменой
// файла, без правок кода.
function posterFontFamily(file) {
  try {
    const b=fs.readFileSync(file),tables={},count=b.readUInt16BE(4);
    for(let i=0;i<count;i++){const rec=12+i*16;tables[b.toString('latin1',rec,rec+4)]=b.readUInt32BE(rec+8);}
    const nameOff=tables.name;if(!nameOff)return '';
    const recs=b.readUInt16BE(nameOff+2),strOff=nameOff+b.readUInt16BE(nameOff+4);
    let fallback='';
    for(let i=0;i<recs;i++){
      const r=nameOff+6+i*12,platform=b.readUInt16BE(r),nameId=b.readUInt16BE(r+6);
      const len=b.readUInt16BE(r+8),off=b.readUInt16BE(r+10);
      if(nameId!==1)continue;
      const raw=b.subarray(strOff+off,strOff+off+len);
      const value=(platform===3||platform===0)?Buffer.from(raw).swap16().toString('utf16le'):raw.toString('latin1');
      if(value&&!fallback)fallback=value;
      if(platform===3)return value;
    }
    return fallback;
  } catch(e) { return ''; }
}
function posterFontFile() {
  try { return fs.readdirSync(ASSETS_DIR).filter(f=>/\.(ttf|otf)$/i.test(f)).sort()[0]||''; }
  catch { return ''; }
}
const POSTER_FONT_FILE=posterFontFile();
const POSTER_FAMILY=(POSTER_FONT_FILE&&posterFontFamily(path.join(ASSETS_DIR,POSTER_FONT_FILE)))||'DejaVu Sans';
const FONT=`'${POSTER_FAMILY}', 'DejaVu Sans', 'Liberation Sans', sans-serif`;

// Палитра — ровно та же, что в карточке матча: постер и карточка ложатся рядом
// в ленте, и разница в оттенках сразу читается как небрежность.
const C={
  bg1:'#0C0B0B', bg2:'#17130F', text:'#EFEBE4', dim:'#B9B1A5', mute:'#8A7F6F',
  amber:'#E8A45C', win:'#8FBF9A', loss:'#C2695E',
  chipBg:'rgba(143,191,154,.15)', chipLine:'rgba(143,191,154,.34)',
  lossBg:'rgba(194,105,94,.15)', lossLine:'rgba(194,105,94,.36)',
  upBg:'rgba(143,191,154,.16)', upLine:'rgba(143,191,154,.38)',
  plate:'rgba(255,255,255,.035)', plateLine:'rgba(255,255,255,.10)',
  gold:'#C9A76A', silver:'#9A948B'
};

// Раскладка. Интерфейс Stories съедает примерно по 5% сверху и снизу, поэтому
// содержимое прижато к краям, а фон идёт во весь кадр без обрезки.
const L={
  titleY:168, logoTop:198, logoBox:{ w:240, h:150 },
  panel:{ x:40, y:1010, w:1000, h:424, r:38 },
  cxL:262, cxR:818, scoreRoom:420,
  sponsor:{ x:40, y:1498, w:1000, h:268, r:34, boxX:90, boxY:56, boxW:900, boxH:186 }
};

function positionData(meta) {
  const pos=meta?.position||{};
  const value=Number.isFinite(pos.after)?pos.after:(Number.isFinite(pos.before)?pos.before:null);
  if(value===null)return null;
  if(Number.isFinite(pos.before)&&Number.isFinite(pos.after)&&pos.before!==pos.after) {
    const up=pos.after<pos.before;
    return { value, delta:Math.abs(pos.before-pos.after), up };
  }
  return { value, delta:0, up:null };
}
// Плашка места в дивизионе — как в карточке: подпись, крупный номер и пилюля
// со стрелкой, если игрок сместился. Fantasy Points на постере нет намеренно.
function rankPlate(meta, cx, y, w=186) {
  const data=positionData(meta);
  if(!data)return '';
  const height=data.delta?132:100,x=cx-w/2;
  let out=`<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="18" fill="${C.plate}" stroke="${C.plateLine}"/>
    <text x="${cx}" y="${y+28}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800"
      letter-spacing="2" fill="${C.mute}">DIVISION RANK</text>
    <text x="${cx}" y="${y+76}" text-anchor="middle" font-family="${FONT}" font-size="46" font-weight="900"
      fill="${C.text}">#${data.value}</text>`;
  if(!data.delta)return out;
  const bg=data.up?C.upBg:C.lossBg,line=data.up?C.upLine:C.lossLine,fg=data.up?C.win:C.loss;
  return out+`<rect x="${cx-37}" y="${y+88}" width="74" height="32" rx="16" fill="${bg}" stroke="${line}"/>
    <text x="${cx}" y="${y+110}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="800"
      fill="${fg}">${data.up?'▲':'▼'} ${data.delta}</text>`;
}
function formSvg(items=[], cx=0, y=0, r=17, gap=44) {
  const list=(Array.isArray(items)?items:[]).slice(-5).map(x=>String(x||'').toUpperCase()).filter(x=>x==='W'||x==='L');
  if(!list.length)return '';
  let x=cx-(list.length*gap)/2+gap/2,out='';
  for(const v of list) {
    const win=v==='W';
    out+=`<circle cx="${x}" cy="${y}" r="${r}" fill="${win?C.chipBg:C.lossBg}" stroke="${win?C.chipLine:C.lossLine}" stroke-width="1.5"/>
      <text x="${x}" y="${y+Math.round(r*0.38)}" text-anchor="middle" font-family="${FONT}"
        font-size="${Math.round(r*1.15)}" font-weight="800" fill="${win?C.win:C.loss}">${v}</text>`;
    x+=gap;
  }
  return out;
}
// Счёт стоит между именами, и места там ровно L.scoreRoom. Тай-брейки в скобках
// выбрасываем: «7:6 (7:4)» одной строкой между двумя именами не живёт.
function scoreLine(score='') {
  return String(score||'').replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
}
function scoreSize(text='', room=L.scoreRoom, max=64) {
  const len=Math.max(1,String(text).length);
  return Math.max(30,Math.min(max,Math.floor(room/(len*0.56))));
}
// Стадия матча: из round слота (QF/SF/Final/3rd) или из label, если он задан.
// Подписи только английские — постер один на всех, в том числе для Instagram.
const STAGE_NAMES={ qf:'QUARTERFINAL', sf:'SEMIFINAL', final:'FINAL', '3rd':'THIRD PLACE MATCH' };
export function posterStageLabel(match={}) {
  const explicit=String(match.label||'').trim();
  if(explicit)return explicit.toUpperCase();
  const round=String(match.round||'').trim().toLowerCase();
  if(STAGE_NAMES[round])return `PLAYOFF · ${STAGE_NAMES[round]}`;
  return 'GROUP STAGE';
}

// Логотипы. Организация — assets/match-card-logos/ptf.png, спонсоры — ОДИН
// общий файл assets/sponsors.png. Нет файла — плашки спонсоров нет вовсе:
// пустая рамка на публикации выглядит хуже, чем её отсутствие.
const SPONSOR_FILE=path.join(ASSETS_DIR,'sponsors.png');
export function sponsorsAvailable() {
  try { return fs.statSync(SPONSOR_FILE).size>0; } catch { return false; }
}
async function posterLogoLayers() {
  const layers=[];
  try {
    const org=await sharp(path.join(LOGOS_DIR,'ptf.png'))
      .resize({ width:L.logoBox.w, height:L.logoBox.h, fit:'inside', withoutEnlargement:true }).png().toBuffer();
    const meta=await sharp(org).metadata();
    layers.push({ input:org, left:Math.round((WIDTH-(meta.width||L.logoBox.w))/2), top:L.logoTop });
  } catch(e) { if(e?.code!=='ENOENT')console.error('poster org logo failed:',e.message); }
  if(sponsorsAvailable()) {
    try {
      const box=L.sponsor;
      const strip=await sharp(SPONSOR_FILE)
        .resize({ width:box.boxW, height:box.boxH, fit:'inside', withoutEnlargement:true }).png().toBuffer();
      const meta=await sharp(strip).metadata();
      layers.push({
        input:strip,
        left:Math.round((WIDTH-(meta.width||box.boxW))/2),
        top:box.y+box.boxY+Math.round((box.boxH-(meta.height||box.boxH))/2)
      });
    } catch(e) { console.error('poster sponsors failed:',e.message); }
  }
  return layers;
}

// Накладывает точный текст и логотипы на любой будущий AI-фон. Эту функцию
// можно проверять и использовать уже сейчас — сетевого доступа она не требует.
export async function composeMatchPoster(backgroundBuffer, match={}) {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const P=L.panel;
  const score=scoreLine(match.score);
  const size=scoreSize(score);
  const divisionName=String(match.division||'').trim();
  const division=[
    divisionName&&!/^Division\b/i.test(divisionName)?`DIVISION ${divisionName}`:divisionName.toUpperCase(),
    match.season?`SEASON ${match.season}`:''
  ].filter(Boolean).join(' · ');
  const hasSponsors=sponsorsAvailable();
  const S=L.sponsor;
  const svg=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.bg1}" stop-opacity=".66"/>
    <stop offset=".22" stop-color="${C.bg1}" stop-opacity=".14"/>
    <stop offset=".5" stop-color="${C.bg1}" stop-opacity=".42"/>
    <stop offset=".74" stop-color="${C.bg1}" stop-opacity=".9"/>
    <stop offset="1" stop-color="${C.bg1}" stop-opacity=".98"/></linearGradient></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
  <text x="${WIDTH/2}" y="${L.titleY}" text-anchor="middle" font-family="${FONT}" font-size="28"
    font-weight="700" letter-spacing="9" fill="${C.text}" opacity=".92">PHUKET TENNIS FAMILY</text>
  <rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="${P.r}" fill="${C.bg2}" fill-opacity=".8" stroke="${C.plateLine}"/>
  <text x="${WIDTH/2}" y="${P.y+48}" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="800"
    letter-spacing="4" fill="${C.amber}">${esc(posterStageLabel(match))}</text>
  ${division?`<text x="${WIDTH/2}" y="${P.y+80}" text-anchor="middle" font-family="${FONT}" font-size="17"
    font-weight="700" letter-spacing="3" fill="${C.dim}">${esc(division)}</text>`:''}
  <text x="${L.cxL}" y="${P.y+154}" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="900"
    fill="${C.gold}">${esc(fit(match.winner))}</text>
  <text x="${L.cxR}" y="${P.y+154}" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="900"
    fill="${C.silver}">${esc(fit(match.loser))}</text>
  <rect x="${L.cxL-66}" y="${P.y+170}" width="132" height="3" rx="2" fill="${C.gold}" opacity=".8"/>
  <rect x="${L.cxR-66}" y="${P.y+170}" width="132" height="3" rx="2" fill="${C.silver}" opacity=".6"/>
  <text x="${WIDTH/2}" y="${P.y+166}" text-anchor="middle" font-family="${FONT}" font-size="${size}"
    font-weight="900" letter-spacing="1" fill="${C.amber}">${esc(score||'—')}</text>
  ${formSvg(match.winnerMeta?.form,L.cxL,P.y+216)}
  ${formSvg(match.loserMeta?.form,L.cxR,P.y+216)}
  ${rankPlate(match.winnerMeta,L.cxL,P.y+256)}
  ${rankPlate(match.loserMeta,L.cxR,P.y+256)}
  ${hasSponsors?`<rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="${S.r}" fill="${C.bg2}" fill-opacity=".72" stroke="${C.plateLine}"/>
  <text x="${WIDTH/2}" y="${S.y+38}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800"
    letter-spacing="4" fill="${C.mute}">SEASON PARTNERS</text>`:''}
</svg>`);
  const logos=await posterLogoLayers();
  return sharp(backgroundBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'centre'})
    .composite([{input:svg,left:0,top:0},...logos]).png({compressionLevel:6}).toBuffer();
}

// Генерирует фон через OpenAI, после чего сервер сам накладывает точный текст.
export async function renderMatchPoster(slot={}, options={}) {
  const job=await preparePosterJob(slot,options);
  if (job.status === 'blocked_consent') return { ...job, buffers:[] };
  const generated=await generatePosterBackgrounds(job);
  const buffers=[];
  for (const item of generated) {
    buffers.push({ variant:item.variant, buffer:await composeMatchPoster(item.buffer,job.match) });
  }
  return { ...job, status:'ready', buffers };
}

async function imageReference(buffer) {
  if (!buffer?.length) throw new Error('poster_source_photo_missing');
  // Нормализуем EXIF и ограничиваем вес запроса. Финальный PNG всё равно
  // собирается отдельно в точном размере 1080×1920.
  const normalized=await sharp(buffer).rotate().resize(1024,1024,{
    fit:'inside',withoutEnlargement:true
  }).jpeg({quality:92,mozjpeg:true}).toBuffer();
  return { image_url:`data:image/jpeg;base64,${normalized.toString('base64')}` };
}

function openAiError(json,status) {
  const message=String(json?.error?.message || json?.message || '').trim();
  return message || `OpenAI Image API ответил ${status}`;
}

async function generateOneBackground(prompt, imageReferences) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),API_TIMEOUT_MS);
  try {
    const response=await globalThis.fetch(OPENAI_IMAGE_API_URL,{
      method:'POST',
      headers:{
        Authorization:`Bearer ${OPENAI_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        model:MODEL,
        prompt,
        images:imageReferences,
        quality:QUALITY,
        size:SIZE,
        n:1,
        output_format:'png',
        background:'opaque'
      }),
      signal:controller.signal
    });
    const json=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(openAiError(json,response.status));
    const b64=String(json?.data?.[0]?.b64_json || '');
    if(!b64)throw new Error('OpenAI Image API не вернул изображение');
    return Buffer.from(b64,'base64');
  } catch(error) {
    if(error?.name === 'AbortError')throw new Error(`OpenAI Image API не ответил за ${Math.round(API_TIMEOUT_MS/1000)} с`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generatePosterBackgrounds(job={}, photos=null) {
  if(!posterEnabled())throw new Error('OPENAI_API_KEY не задан');
  if(!Array.isArray(job.consent) || !job.consent.every(x=>x.allowed))throw new Error('poster_consent_required');
  const sourcePhotos=Array.isArray(photos) && photos.length ? photos : await loadPosterSourcePhotos(job);
  if(sourcePhotos.length < 2)throw new Error('poster_source_photo_missing');
  const imageReferences=await Promise.all(sourcePhotos.slice(0,2).map(imageReference));
  const result=[];
  // Последовательные запросы не упираются в небольшой IPM-лимит аккаунта.
  for(const item of (job.prompts || [])) {
    const buffer=await generateOneBackground(String(item.prompt || ''),imageReferences);
    result.push({variant:Number(item.variant || result.length+1),buffer});
  }
  if(!result.length)throw new Error('poster_prompts_missing');
  return result;
}
