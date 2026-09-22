// Подготовка постера матча без подключения Image API.
//
// Модуль уже делает всё вокруг будущего генератора:
//   • собирает точные данные того же матча, что и карточка;
//   • проверяет отдельное согласие ОБОИХ игроков;
//   • строит два варианта промпта из Railway Variable MATCH_POSTER_PROMPT;
//   • принимает комментарий организатора;
//   • умеет наложить счёт, имена, форму, позиции и логотипы на готовый фон;
//   • отдаёт сериализуемое задание для Google Drive.
//
// Сетевого вызова генератора здесь намеренно нет. В следующем шаге достаточно
// реализовать generatePosterBackgrounds(job, photos); остальные части готовы.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApplicantByTelegramId } from './sheets.js';
import { matchDataForSlot, playerPhotoForPoster } from './matchcard.js';

const WIDTH = 1080;
const HEIGHT = 1920;
const VARIANTS = Math.max(1, Math.min(2, Number(process.env.MATCH_POSTER_VARIANTS || 2)));
const MODEL = process.env.POSTER_IMAGE_MODEL || 'gpt-image-2';
const QUALITY = process.env.POSTER_QUALITY || 'medium';
const SIZE = process.env.POSTER_SIZE || '1024x1536';
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const LOGOS_DIR = path.join(ASSETS_DIR, 'match-card-logos');

const DEFAULT_PROMPT = `Create a cinematic vertical 9:16 tennis match poster background using the two supplied player portraits as identity references.
Preserve the exact recognizable facial features of both people. Show both players from approximately the waist or chest upward, with balanced visual weight. Player 1 is on the left and player 2 is on the right.
Do not show tennis rackets, tennis balls or sports equipment in either player's hands or in the foreground. Keep both players' hands and arms in relaxed, natural, freely chosen positions that may differ between generations. When the source portrait shows a natural shoulder or arm posture, stay close to it where the poster composition permits. Do not force identical, mirrored or staged poses.
They wear premium modern minimalist tennis apparel in complementary colors chosen from blue, red, white, gray, pink, light blue, beige, yellow, or black.
The setting is a premium blue hard court at a luxury tennis club in Phuket during a vibrant tropical sunset. The sky has fiery orange, deep violet and soft pink gradients, with palm trees and tropical foliage in the background. Warm low-angle light, realistic skin texture, polished sports lifestyle photography, shallow depth of field.
Keep the center readable and leave the lower 35 percent visually calm. The lower-middle area will receive a narrow dark translucent information panel, and the bottom 15 percent must remain especially clean for real organization and sponsor logos added later by code. Do not generate any text, letters, logos, scoreboards, watermarks, trophies or fake sponsor marks.`;

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

// API намеренно не подключён. Это отличает «готово задание» от ложного
// состояния «генерация включена», даже если на сервере уже есть OPENAI_API_KEY.
export function posterEnabled() { return false; }
export function posterSettings() {
  return {
    apiConnected:false,
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
  'Composition option 1: balanced face-off, both players equally prominent, calm premium editorial framing, with different relaxed arm positions and no sports equipment.',
  'Composition option 2: slightly more dynamic diagonal framing and stronger sunset atmosphere, with different relaxed arm positions, no sports equipment, and the clear lower panel and sponsor areas preserved.'
];

export function buildPosterPrompt(match={}, { comment='', variant=1 }={}) {
  const n = Math.max(1, Math.min(VARIANTS, Number(variant || 1)));
  const values = tokenMap(match, comment, n);
  const base = fillTokens(posterPromptTemplate(), values);
  const context = [
    `Reference assignment: player 1 is ${values.player_1 || 'the first supplied portrait'}; player 2 is ${values.player_2 || 'the second supplied portrait'}.`,
    VARIANT_NOTES[n - 1] || VARIANT_NOTES[0],
    comment ? `Organizer direction: ${comment}` : '',
    'Mandatory composition constraints: no tennis rackets, balls or equipment; hands and arms remain relaxed and naturally positioned; keep the bottom 15 percent clean for sponsor and organization logos.',
    'The image generator creates only the photographic scene. Exact names, score, rankings, form and organization logos are added later by code.'
  ].filter(Boolean).join('\n');
  return base + '\n\n' + context;
}

const consentValue = row => String(row?.photo_publication_consent || '').trim().toUpperCase();
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
    value:consentValue(row) || 'MISSING',
    allowed:consentValue(row) === 'YES'
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
    status:allowed ? 'waiting_api' : 'blocked_consent',
    api_connected:false,
    prompt_source:posterPromptSource(),
    settings:posterSettings(),
    comment:String(comment || '').trim(),
    match,
    consent,
    prompts,
    variants:prompts.map(p=>({ variant:p.variant, status:'waiting_api', drive_file_id:'', telegram_file_id:'' }))
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
function fit(value='', max=18) {
  const s=String(value||'').trim();
  return s.length<=max?s:s.slice(0,Math.max(1,max-1))+'…';
}
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
function positionSvg(meta, center=0, y=0) {
  const data=positionData(meta);
  if(!data)return '';
  const rankX=data.delta?center-42:center;
  const rank=`<text x="${rankX}" y="${y}" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="27" font-weight="900" fill="#f4f7fb">#${data.value}</text>`;
  if(!data.delta)return rank;
  const bg=data.up?'rgba(143,191,154,.16)':'rgba(194,105,94,.15)';
  const line=data.up?'rgba(143,191,154,.38)':'rgba(194,105,94,.36)';
  const fg=data.up?'#8FBF9A':'#C2695E';
  const arrow=data.up?'▲':'▼';
  return `${rank}<rect x="${center+5}" y="${y-27}" width="74" height="34" rx="17" fill="${bg}" stroke="${line}"/>
    <text x="${center+42}" y="${y-4}" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="17" font-weight="900" fill="${fg}">${arrow} ${data.delta}</text>`;
}
function formSvg(items=[], center=0, y=0) {
  const list=(Array.isArray(items)?items:[]).slice(-5).map(x=>String(x||'').toUpperCase()).filter(x=>x==='W'||x==='L');
  const gap=34,start=center-(list.length-1)*gap/2;
  return list.map((v,i)=>{
    const win=v==='W',x=start+i*gap;
    return `<circle cx="${x}" cy="${y}" r="13" fill="${win?'#173d35':'#3a242b'}" stroke="${win?'#35d0a0':'#ef6d7a'}"/>
      <text x="${x}" y="${y+5}" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="13" font-weight="800" fill="${win?'#7ee8c4':'#ff9ca5'}">${v}</text>`;
  }).join('');
}
async function posterLogoLayers() {
  let names=[];
  try { names=fs.readdirSync(LOGOS_DIR).filter(n=>/\.(png|webp|svg)$/i.test(n)).sort().slice(0,4); }
  catch { return []; }
  const rendered=[];
  for(const name of names) {
    try {
      const input=await sharp(path.join(LOGOS_DIR,name)).resize({width:210,height:88,fit:'inside',withoutEnlargement:true}).png().toBuffer();
      const meta=await sharp(input).metadata();
      rendered.push({input,width:meta.width||230,height:meta.height||100});
    } catch(e) { console.error('poster logo failed:',name,e.message); }
  }
  const gap=30,total=rendered.reduce((s,x)=>s+x.width,0)+Math.max(0,rendered.length-1)*gap;
  let left=Math.round((WIDTH-total)/2);
  return rendered.map(item=>{const layer={input:item.input,left,top:1772+Math.round((88-item.height)/2)};left+=item.width+gap;return layer;});
}

// Накладывает точный текст и логотипы на любой будущий AI-фон. Эту функцию
// можно проверять и использовать уже сейчас — сетевого доступа она не требует.
export async function composeMatchPoster(backgroundBuffer, match={}) {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const score=String(match.score||'').replace(/\s+/g,' ').trim();
  const division=[match.division,match.season?`Season ${match.season}`:''].filter(Boolean).join(' · ');
  const svg=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06101b" stop-opacity=".12"/><stop offset=".58" stop-color="#06101b" stop-opacity=".25"/><stop offset="1" stop-color="#06101b" stop-opacity=".88"/></linearGradient></defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
    <text x="540" y="88" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="28" font-weight="700" letter-spacing="7" fill="#f4f7fb">PHUKET TENNIS FAMILY</text>
    <rect x="92" y="1030" width="896" height="558" rx="38" fill="#07131f" fill-opacity=".84" stroke="#ffffff" stroke-opacity=".22"/>
    <text x="540" y="1090" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="23" font-weight="700" letter-spacing="3" fill="#d6dde7">${esc(division)}</text>
    <text x="292" y="1175" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="40" font-weight="800" fill="#ffffff">${esc(fit(match.winner,17))}</text>
    <text x="788" y="1175" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="40" font-weight="800" fill="#ffffff">${esc(fit(match.loser,17))}</text>
    <text x="540" y="1288" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="72" font-weight="900" letter-spacing="2" fill="#f4b84a">${esc(score)}</text>
    ${positionSvg(match.winnerMeta,292,1387)}
    ${positionSvg(match.loserMeta,788,1387)}
    ${formSvg(match.winnerMeta?.form,292,1452)}
    ${formSvg(match.loserMeta?.form,788,1452)}
    ${match.label?`<text x="540" y="1535" text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="19" font-weight="700" letter-spacing="4" fill="#f4b84a">${esc(match.label)}</text>`:''}
  </svg>`);
  const logos=await posterLogoLayers();
  return sharp(backgroundBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'centre'})
    .composite([{input:svg,left:0,top:0},...logos]).png({compressionLevel:6}).toBuffer();
}

// Совместимая точка входа. Пока возвращает только готовое задание; buffers
// останется пустым до подключения generatePosterBackgrounds.
export async function renderMatchPoster(slot={}, options={}) {
  const job=await preparePosterJob(slot,options);
  return { ...job, buffers:[] };
}

export async function generatePosterBackgrounds() {
  throw new Error('poster_api_not_connected');
}