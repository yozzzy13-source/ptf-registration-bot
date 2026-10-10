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
import { matchDataForSlot, playerPhotoForPoster, cardStage, STAGE_THEMES } from './matchcard.js';
import { sponsorsAvailable, sponsorStrip } from './sponsors.js';
// Пробрасываем дальше: снаружи удобнее спрашивать у модуля постера.
export { sponsorsAvailable };

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

LIGHTING — both players must look photographed together
Light both people with the SAME key light, from the same direction, at the same intensity and the same color temperature, as if they were standing side by side in one photograph taken at one moment. Their faces must have equal brightness, equal contrast and matching shadow direction. Do not light one player brightly and the other in shadow. Do not give one a warm golden look and the other a cool or flat look. Do not make one face noticeably sharper, more contrasty or more saturated than the other. Match their skin tones to the same exposure and white balance, while keeping each person's real complexion. The two portraits must read as one photograph, not as two images pasted together.

Keep the bottom 20 percent of the image dark, calm and free from faces, hands and important scene details. That area is covered later by an information panel and by real sponsor logos added by code.

Do not generate text, letters, player names, scores, rankings, badges, banners, logos, watermarks, scoreboards, trophies or fake sponsor marks. The image generator creates only the photographic scene.`;

const cleanEnvPrompt = value => String(value || '').replace(/\\n/g, '\n').trim();
// Плей-офф: своя сцена на каждую стадию, и игроки меньше — чтобы сцена
// (прожекторы, закат, кубок) читалась в верхней трети кадра. Отдельный
// шаблон, а не приписка к обычному: у обычного другая раскладка кадра, и два
// противоречащих указания нейросеть выполняет как попало.
// Заменить можно переменной MATCH_POSTER_PLAYOFF_PROMPT; {{stage_scene}} и
// {{stage}} подставляются сами.
export const PLAYOFF_SCENES = {
  QF: 'QUARTER-FINAL NIGHT: an evening hard court under powerful stadium floodlights. Cool steel-blue and teal atmosphere, visible light beams cutting through a light haze in the dark blue sky above the players, crisp cold highlights on the court lines. Tense, focused, cinematic.',
  SF: 'SEMI-FINAL SUNSET: a dramatic golden-hour sunset over the tropical club. Rich gold and amber sky with long sun rays streaming down behind the players, glowing clouds, warm golden rim light. Epic and triumphant.',
  '3rd': 'BRONZE MATCH: a warm copper and bronze sunset with a soft atmospheric haze, deep terracotta and amber tones in the sky, gentle warm backlight. Calm, proud, dignified.',
  Final: 'CHAMPIONSHIP FINAL: a night centre court with bright spotlights and a glowing arena atmosphere, golden sparks and fine golden confetti drifting in the air. A large shining silver-and-gold championship trophy stands on a pedestal in sharp focus in the gap between the two players, slightly behind them, rising in the gap between their heads, the cup fully visible just below the title area. Grand, celebratory, prestigious.'
};
const PLAYOFF_PROMPT = `Create a cinematic vertical 9:16 tennis PLAYOFF match poster background using the two supplied player portraits as strict identity references.

REFERENCE ASSIGNMENT
Player 1 is {{player_1}} and must appear on the left.
Player 2 is {{player_2}} and must appear on the right.

Preserve each person's exact recognizable facial identity, including face proportions, eyes, nose, mouth, jawline, skin tone, apparent age, hairstyle and distinctive features. Do not blend their faces, swap traits, or beautify either person into someone different.

STAGE: {{stage}}
{{stage_scene}}

FRAMING — the scene must stay visible
Show both players as close portraits cropped at mid-chest, side by side with equal visual weight and a small gap between them in the centre of the frame. Faces are large and clearly readable. The tops of their heads sit at about 29 percent of the image height and their faces around 33 to 45 percent; the figures fill the band down to about 80 percent of the height. The area above their heads (the top 27 percent) shows the stage scene described above — sky, light beams, sun, sparks — and stays free of heads: a logo and a large title are placed over it, so keep it calm and slightly darker in the centre. Faces must still be large enough to be clearly recognizable. Camera at eye level, 85mm portrait look.

Keep both players' posture relaxed and natural, different from each other, not mirrored, no crossed arms. Do not show tennis rackets, balls or sports bags. Both players wear premium modern minimalist tennis apparel in clearly different complementary colors.

LIGHTING — both players must look photographed together
Light both people with the SAME key light, from the same direction, at the same intensity and color temperature, as if photographed side by side at one moment. Equal brightness, contrast and shadow direction on both faces; nobody in shadow. The two portraits must read as one photograph.

Keep the bottom 20 percent of the image dark, calm and free from faces, hands and important details: it is covered later by an information panel and sponsor logos added by code.

Do not generate text, letters, player names, scores, numbers, banners, logos, watermarks or scoreboards. The image generator creates only the photographic scene.`;
const PLAYOFF_STAGE_TITLES = { QF:'QUARTER-FINAL', SF:'SEMI-FINAL', '3rd':'3RD PLACE MATCH', Final:'FINAL' };
export function playoffPromptTemplate() {
  return cleanEnvPrompt(process.env.MATCH_POSTER_PLAYOFF_PROMPT) || PLAYOFF_PROMPT;
}

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
  'Composition option 1: calm premium editorial portraits, both faces at the same height, one shared soft key light falling equally on both, chest-level crop.',
  'Composition option 2: slightly different head angles and a stronger sunset rim light — applied equally to both players — with a chest-level crop and both faces large, evenly lit and readable.'
];

export function buildPosterPrompt(match={}, { comment='', variant=1 }={}) {
  const n = Math.max(1, Math.min(VARIANTS, Number(variant || 1)));
  const values = tokenMap(match, comment, n);
  const stage = cardStage(match.stage);
  if (stage) return buildPlayoffPrompt(values, stage.key, comment, n);
  const base = fillTokens(posterPromptTemplate(), values);
  const context = [
    `Reference assignment: player 1 is ${values.player_1 || 'the first supplied portrait'}; player 2 is ${values.player_2 || 'the second supplied portrait'}.`,
    VARIANT_NOTES[n - 1] || VARIANT_NOTES[0],
    comment ? `Organizer direction: ${comment}` : '',
    'Mandatory constraints: close portrait crop just below the shoulders; faces large and identical to the references; identical lighting on both players — same direction, same intensity, same color temperature, no one left in shadow; no tennis rackets, balls or equipment; dark calm bottom third for the information panel and sponsor logos.',
    'The image generator creates only the photographic scene. Exact names, score, rankings, form and organization logos are added later by code.'
  ].filter(Boolean).join('\n');
  return base + '\n\n' + context;
}

function buildPlayoffPrompt(values, key, comment, n) {
  const base = fillTokens(playoffPromptTemplate(), { ...values, stage: PLAYOFF_STAGE_TITLES[key] || key, stage_scene: PLAYOFF_SCENES[key] || '' });
  const notes = [
    'Composition option 1: calm, premium, both faces at the same height, one shared key light.',
    'Composition option 2: slightly different head angles and a stronger backlight from the stage scene, applied equally to both players.'
  ];
  return base + '\n\n' + [
    `Reference assignment: player 1 is ${values.player_1 || 'the first supplied portrait'}; player 2 is ${values.player_2 || 'the second supplied portrait'}.`,
    notes[n - 1] || notes[0],
    comment ? `Organizer direction: ${comment}` : '',
    'Mandatory constraints: large chest-level portraits; top quarter shows the stage scene; faces identical to the references and equally lit; dark calm bottom 20 percent; no text.'
  ].filter(Boolean).join('\n');
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
// Шрифт и палитру забирает сторис с таблицей дивизиона: обе картинки уходят в
// одну ленту, и разница в шрифте или оттенке сразу читается как небрежность.
export const POSTER_FONT=FONT;

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
export const POSTER_COLORS=C;

// Раскладка. Интерфейс Stories съедает примерно по 5% сверху и снизу, поэтому
// содержимое прижато к краям, а фон идёт во весь кадр без обрезки.
const L={
  titleY:168, logoTop:198, logoBox:{ w:240, h:150 },
  panel:{ x:40, y:1120, w:1000, h:424, r:38 },
  cxL:240, cxR:840, nameMax:300, nameSize:40, nameMin:26, scoreMax:58, scoreMin:28, gap:26,
  // Партнёры: никакой рамки и подписи, просто свободная полоса под панелью
  // счёта. Панель кончается на 1544, нижние 5% кадра (от 1824) закрыты
  // интерфейсом Stories — значит лента живёт между 1556 и 1818.
  sponsor:{ top:1556, bottom:1818 }
};
// Ширину текста считаем приблизительно: точных метрик шрифта у нас нет, а
// librsvg их не отдаёт. Коэффициент подобран по этому начертанию и намеренно
// щедрый — лучше уменьшить кегль на пару пунктов, чем наехать на соседа.
const textWidth = (text='', size=40, k=0.56) => String(text).length * size * k;
// Имя ужимаем по ширине колонки, а не по числу букв: «Olga Sauer» и «Maria E.»
// занимают разное место при одинаковой длине.
function nameFit(name='') {
  const text=fit(name,18);
  let size=L.nameSize;
  while(size>L.nameMin&&textWidth(text,size)>L.nameMax)size-=1;
  return { text, size, width:Math.min(L.nameMax,textWidth(text,size)) };
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
  // Свежий матч слева — так же, как в карточке и в мини-приложении.
  const list=(Array.isArray(items)?items:[]).slice(-5).map(x=>String(x||'').toUpperCase()).filter(x=>x==='W'||x==='L').reverse();
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
// Кегль счёта подбираем под фактический просвет между именами. Раньше здесь
// стояло фиксированное число, и счёт из трёх сетов налезал на имена.
function scoreSize(text='', room=380) {
  const len=Math.max(1,String(text).length);
  let size=L.scoreMax;
  while(size>L.scoreMin&&textWidth(text,size,0.58)>room)size-=1;
  return size;
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

// Логотипы. Организация — assets/match-card-logos/ptf.png, партнёры — один
// общий файл assets/sponsors.png, см. sponsors.js.
// Свободная полоса под панелью счёта на постере матча.
export const SPONSOR_BAND={ top:L.sponsor.top, bottom:L.sponsor.bottom };
export const posterSponsorStrip = () => sponsorStrip(SPONSOR_BAND);
async function posterLogoLayers(sponsor=null, logoTop=L.logoTop, box=L.logoBox) {
  const layers=[];
  try {
    const org=await sharp(path.join(LOGOS_DIR,'ptf.png'))
      .resize({ width:box.w, height:box.h, fit:'inside', withoutEnlargement:true }).png().toBuffer();
    const meta=await sharp(org).metadata();
    layers.push({ input:org, left:Math.round((WIDTH-(meta.width||box.w))/2), top:logoTop });
  } catch(e) { if(e?.code!=='ENOENT')console.error('poster org logo failed:',e.message); }
  if(sponsor?.layer)layers.push(sponsor.layer);
  return layers;
}

// ------------------------------------------------------ постер плей-офф
// Тот же язык, что у утверждённой карточки плей-офф: металл стадии (сталь,
// золото, бронза, насыщенное золото финала), уголки рамки, сверху
// «PHUKET TENNIS FAMILY» и плашка дивизиона с сезоном; на панели — счёт,
// под ним стадия между именами, форма; плашки мест — только финал и 3-е место.
// Раскладка как у обычного постера (заголовок, логотип того же размера), но
// панель — компактная: только имена, счёт и крупная стадия. Форма, места и
// прочая статистика остаются карточкам; постер — про лица и момент.
const PL={ panelBottom:1548, panelH:268 };
const hexA=(hex,a)=>{const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${(n>>8)&255},${n&255},${a})`;};
function corners(th, double) {
  const Lc=110,o=26,w=4;
  const c=(x,y,dx,dy,off)=>`<path d="M${x+dx*off} ${y+dy*(off+Lc)} V${y+dy*off} H${x+dx*(off+Lc)}" fill="none" stroke="${th.metal}" stroke-width="${w}" stroke-linecap="round" opacity="${off>o?.55:.95}"/>`;
  const set=off=>c(0,0,1,1,off)+c(WIDTH,0,-1,1,off)+c(0,HEIGHT,1,-1,off)+c(WIDTH,HEIGHT,-1,-1,off);
  return set(o)+(double?set(o+14):'');
}
// Стадия — заголовок постера наверху, как на матчевых постерах больших
// турниров: крупное слово стадии над игроками, бренд лиги рядом, внизу
// компактная панель с именами и счётом.
// Утверждён layout 'B': логотип по центру, как на обычном постере, стадия
// крупно под ним; дивизион и сезон — мелко в нижней панели.
// layout 'A' (логотип в углу) оставлен для сравнения макетов.
export async function composePlayoffPoster(backgroundBuffer, match={}, stage=cardStage(match.stage), { layout='B' }={}) {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const th=STAGE_THEMES[stage.key]||STAGE_THEMES.SF, final=stage.key==='Final';
  const panelH=176, P={ x:40, y:PL.panelBottom-panelH, w:1000, h:panelH, r:38 };
  const score=scoreLine(match.score);
  const left=nameFit(match.winner), right=nameFit(match.loser);
  const room=Math.max(160,(L.cxR-right.width/2)-(L.cxL+left.width/2)-L.gap*2);
  const size=scoreSize(score,room);
  const divRaw=String(match.division||'').split('·')[0].trim();
  const chip=[divRaw&&!/^Division\b/i.test(divRaw)?`DIVISION ${divRaw.toUpperCase()}`:divRaw.toUpperCase(),match.season?`SEASON ${match.season}`:''].filter(Boolean).join(' · ');
  const title=PLAYOFF_STAGE_TITLES[stage.key]||stage.key;
  // Кегль заголовка — по ширине кадра: «3RD PLACE MATCH» длиннее «FINAL».
  const hs=Math.min(final?150:120, Math.floor(960/(title.length*0.68)));
  const rowY=P.y+84, divY=P.y+140;
  const head=layout==='B'
    ? { brandY:L.titleY, brandX:WIDTH/2, anchor:'middle', logoTop:L.logoTop, logoBox:L.logoBox, logoLeft:null, titleY:L.logoTop+L.logoBox.h+hs*0.92 }
    : { brandY:118, brandX:200, anchor:'start', logoTop:52, logoBox:{ w:140, h:110 }, logoLeft:48, titleY:190+hs*0.78 };
  const sponsor=await posterSponsorStrip();
  const svg=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.bg1}" stop-opacity=".72"/>
      <stop offset=".18" stop-color="${C.bg1}" stop-opacity=".25"/>
      <stop offset=".3" stop-color="${C.bg1}" stop-opacity=".04"/>
      <stop offset=".62" stop-color="${C.bg1}" stop-opacity=".1"/>
      <stop offset=".76" stop-color="${C.bg1}" stop-opacity=".8"/>
      <stop offset="1" stop-color="${C.bg1}" stop-opacity=".98"/></linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${th.deep}"/><stop offset=".5" stop-color="${th.light}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${th.light}"/><stop offset=".55" stop-color="${th.metal}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
  ${corners(th,final)}
  <rect width="${WIDTH}" height="8" fill="url(#bar)"/>
  <rect y="${HEIGHT-8}" width="${WIDTH}" height="8" fill="url(#bar)"/>
  <text x="${head.brandX}" y="${head.brandY}" text-anchor="${head.anchor}" font-family="${FONT}" font-size="${layout==='B'?28:26}" font-weight="700"
    letter-spacing="${layout==='B'?9:7}" fill="${th.light}" opacity=".95">PHUKET TENNIS FAMILY</text>
  ${layout==='B'?'':`<text x="${head.brandX}" y="${head.brandY+34}" text-anchor="start" font-family="${FONT}" font-size="18" font-weight="700" letter-spacing="4" fill="${C.dim}">PLAYOFFS · ${esc(chip)}</text>`}
  <text x="${WIDTH/2}" y="${head.titleY}" text-anchor="middle" font-family="${FONT}" font-size="${hs}" font-weight="900"
    letter-spacing="${Math.round(hs*0.06)}" fill="url(#metal)" stroke="${hexA(C.bg1,.35)}" stroke-width="2">${esc(title)}</text>
  <rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="${P.r}" fill="${C.bg2}" fill-opacity=".78" stroke="${hexA(th.metal,.45)}" stroke-width="1.5"/>
  <text x="${L.cxL}" y="${rowY}" text-anchor="middle" font-family="${FONT}" font-size="${left.size}" font-weight="900" fill="${final?th.light:C.text}">${esc(left.text)}</text>
  <text x="${L.cxR}" y="${rowY}" text-anchor="middle" font-family="${FONT}" font-size="${right.size}" font-weight="900" fill="${C.silver}">${esc(right.text)}</text>
  <rect x="${L.cxL-left.width/2}" y="${rowY+16}" width="${left.width}" height="3" rx="2" fill="${th.metal}" opacity=".85"/>
  <rect x="${L.cxR-right.width/2}" y="${rowY+16}" width="${right.width}" height="3" rx="2" fill="${C.silver}" opacity=".55"/>
  <text x="${WIDTH/2}" y="${rowY+10}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="900" letter-spacing="1" fill="${stage.key==='SF'?C.amber:th.light}">${esc(score||'—')}</text>
  ${layout==='B'&&chip?`<text x="${WIDTH/2}" y="${divY}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="700" letter-spacing="4" fill="${C.dim}" opacity=".85">${esc(chip)}</text>`:''}
</svg>`);
  const logos=[];
  try {
    const org=await sharp(path.join(LOGOS_DIR,'ptf.png')).resize({ width:head.logoBox.w, height:head.logoBox.h, fit:'inside', withoutEnlargement:true }).png().toBuffer();
    const meta=await sharp(org).metadata();
    logos.push({ input:org, left:head.logoLeft ?? Math.round((WIDTH-(meta.width||head.logoBox.w))/2), top:head.logoTop });
  } catch(e) { if(e?.code!=='ENOENT')console.error('poster org logo failed:',e.message); }
  if(sponsor?.layer)logos.push(sponsor.layer);
  return sharp(backgroundBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'centre'})
    .composite([{input:svg,left:0,top:0},...logos]).png({compressionLevel:6}).toBuffer();
}

// Накладывает точный текст и логотипы на любой будущий AI-фон. Эту функцию
// можно проверять и использовать уже сейчас — сетевого доступа она не требует.
export async function composeMatchPoster(backgroundBuffer, match={}) {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const stage=cardStage(match.stage);
  if (stage) return composePlayoffPoster(backgroundBuffer, match, stage);
  const P=L.panel;
  const score=scoreLine(match.score);
  const left=nameFit(match.winner),right=nameFit(match.loser);
  // Просвет: от правого края левого имени до левого края правого, минус поля.
  const room=Math.max(160,(L.cxR-right.width/2)-(L.cxL+left.width/2)-L.gap*2);
  const size=scoreSize(score,room);
  const divisionName=String(match.division||'').trim();
  const division=[
    divisionName&&!/^Division\b/i.test(divisionName)?`DIVISION ${divisionName}`:divisionName.toUpperCase(),
    match.season?`SEASON ${match.season}`:''
  ].filter(Boolean).join(' · ');
  const sponsor=await posterSponsorStrip();
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
  <text x="${L.cxL}" y="${P.y+154}" text-anchor="middle" font-family="${FONT}" font-size="${left.size}" font-weight="900"
    fill="${C.gold}">${esc(left.text)}</text>
  <text x="${L.cxR}" y="${P.y+154}" text-anchor="middle" font-family="${FONT}" font-size="${right.size}" font-weight="900"
    fill="${C.silver}">${esc(right.text)}</text>
  <rect x="${L.cxL-left.width/2}" y="${P.y+170}" width="${left.width}" height="3" rx="2" fill="${C.gold}" opacity=".8"/>
  <rect x="${L.cxR-right.width/2}" y="${P.y+170}" width="${right.width}" height="3" rx="2" fill="${C.silver}" opacity=".6"/>
  <text x="${WIDTH/2}" y="${P.y+166}" text-anchor="middle" font-family="${FONT}" font-size="${size}"
    font-weight="900" letter-spacing="1" fill="${C.amber}">${esc(score||'—')}</text>
  ${formSvg(match.winnerMeta?.form,L.cxL,P.y+216)}
  ${formSvg(match.loserMeta?.form,L.cxR,P.y+216)}
  ${rankPlate(match.winnerMeta,L.cxL,P.y+256)}
  ${rankPlate(match.loserMeta,L.cxR,P.y+256)}
</svg>`);
  const logos=await posterLogoLayers(sponsor);
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

// ---------------------------------------------------- афиша-анонс (без счёта)
// Та же самая цепочка — тот же AI-фон, та же панель, тот же логотип и лента
// спонсоров, — но матча ещё не было: нет счёта, формы, места в дивизионе.
// Вместо этого крупно имена и акцент на дивизионе. Дата/место на афише не
// придумываем отдельным полем — если организатор написал что-то в комментарии
// при создании (та же графа, что уже используется для промпта), эта же строка
// ложится на афишу; пустой комментарий — просто нет этой строки.
export async function prepareAnnouncementJob({
  player1={}, player2={}, division='', season='', comment='', variants=VARIANTS
}={}) {
  const match={
    winner:String(player1.name || ''), winnerId:String(player1.telegram_id || ''),
    loser:String(player2.name || ''), loserId:String(player2.telegram_id || ''),
    division:String(division || ''), season:String(season || '')
  };
  const players=await Promise.all([
    findApplicantByTelegramId(match.winnerId).catch(() => null),
    findApplicantByTelegramId(match.loserId).catch(() => null)
  ]);
  const consent=players.map((row,index) => ({
    telegram_id:String((index ? match.loserId : match.winnerId) || ''),
    name:String((index ? match.loser : match.winner) || ''),
    value:consentValue(row) || 'NOT_ANSWERED',
    allowed:posterConsentAllowed(consentValue(row))
  }));
  const count=Math.max(1, Math.min(2, Number(variants || VARIANTS)));
  const prompts=Array.from({length:count},(_,i)=>({
    variant:i + 1,
    prompt:buildPosterPrompt(match,{comment,variant:i + 1})
  }));
  const allowed=consent.every(x => x.allowed);
  return {
    schema_version:1,
    kind:'announcement',
    job_id:`announce-${match.winnerId}-${match.loserId}-${Date.now()}`,
    match_id:`announce-${match.winnerId}-${match.loserId}`,
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

export async function composeAnnouncementPoster(backgroundBuffer, match={}, comment='') {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const P=L.panel;
  const left=nameFit(match.winner),right=nameFit(match.loser);
  const divisionName=String(match.division || '').trim();
  const division=[
    divisionName&&!/^Division\b/i.test(divisionName)?`DIVISION ${divisionName}`:divisionName.toUpperCase(),
    match.season?`SEASON ${match.season}`:''
  ].filter(Boolean).join(' · ');
  const note=String(comment || '').trim();
  const sponsor=await posterSponsorStrip();
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
    letter-spacing="4" fill="${C.amber}">UPCOMING MATCH</text>
  ${division?`<rect x="${WIDTH/2-160}" y="${P.y+66}" width="320" height="50" rx="25" fill="rgba(232,164,92,.12)" stroke="rgba(232,164,92,.4)"/>
  <text x="${WIDTH/2}" y="${P.y+99}" text-anchor="middle" font-family="${FONT}" font-size="22"
    font-weight="800" letter-spacing="3" fill="${C.amber}">${esc(division)}</text>`:''}
  <text x="${L.cxL}" y="${P.y+206}" text-anchor="middle" font-family="${FONT}" font-size="${left.size}" font-weight="900"
    fill="${C.gold}">${esc(left.text)}</text>
  <text x="${L.cxR}" y="${P.y+206}" text-anchor="middle" font-family="${FONT}" font-size="${right.size}" font-weight="900"
    fill="${C.silver}">${esc(right.text)}</text>
  <rect x="${L.cxL-left.width/2}" y="${P.y+222}" width="${left.width}" height="3" rx="2" fill="${C.gold}" opacity=".8"/>
  <rect x="${L.cxR-right.width/2}" y="${P.y+222}" width="${right.width}" height="3" rx="2" fill="${C.silver}" opacity=".6"/>
  <text x="${WIDTH/2}" y="${P.y+206}" text-anchor="middle" font-family="${FONT}" font-size="42"
    font-weight="900" fill="${C.text}" opacity=".55">VS</text>
  ${note?`<text x="${WIDTH/2}" y="${P.y+296}" text-anchor="middle" font-family="${FONT}" font-size="21"
    font-weight="700" letter-spacing="2" fill="${C.dim}">${esc(note)}</text>`:''}
</svg>`);
  const logos=await posterLogoLayers(sponsor);
  return sharp(backgroundBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'centre'})
    .composite([{input:svg,left:0,top:0},...logos]).png({compressionLevel:6}).toBuffer();
}

// Тот же оркестратор, что renderMatchPoster, только без слота матча — просто
// пара игроков. AI-фон, загрузка фото и лимиты — переиспользуются как есть.
export async function renderAnnouncementPoster(options={}) {
  const job=await prepareAnnouncementJob(options);
  if (job.status === 'blocked_consent') return { ...job, buffers:[] };
  const generated=await generatePosterBackgrounds(job);
  const buffers=[];
  for (const item of generated) {
    buffers.push({ variant:item.variant, buffer:await composeAnnouncementPoster(item.buffer,job.match,job.comment) });
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


// ------------------------------------------------------ постер места игрока
// После финала и матча за 3-е место: отдельный постер каждому игроку —
// CHAMPION / RUNNER-UP / 3RD PLACE / 4TH PLACE. Один портрет, своя сцена,
// то же оформление, что у постера матча плей-офф (вариант B).
export const PLACE_KINDS = {
  champion: { title:'CHAMPION', theme:'Final', scene:'CHAMPION CELEBRATION: a night centre court in a glowing arena, bright spotlights, golden confetti and sparks falling. The player proudly holds a large shining silver-and-gold championship trophy, raised at chest or shoulder height, both hands on it, a happy confident expression.' },
  runner_up: { title:'RUNNER-UP', theme:'QF', metal:{ metal:'#C9CCD3', light:'#EEF0F4', deep:'#6E727B', text:'#EEF0F4' }, scene:'RUNNER-UP: an elegant evening court under cool silver and moonlight-blue light, soft haze, gentle sparkle in the air. The player wears a silver medal on a ribbon around the neck, a proud and composed expression.' },
  third: { title:'3RD PLACE', theme:'3rd', scene:'BRONZE MEDAL: a warm copper and bronze sunset over the tropical club, soft atmospheric haze, warm backlight. The player wears a bronze medal on a ribbon around the neck, a proud satisfied smile.' },
  fourth: { title:'4TH PLACE', theme:'QF', scene:'FOURTH PLACE: a calm blue-hour evening court with soft floodlights and a cool steel-blue atmosphere. The player looks focused and determined, arms relaxed.' }
};
const PLACE_PROMPT = `Create a cinematic vertical 9:16 tennis poster background featuring ONE player, using the supplied portrait as a strict identity reference.

The player is {{player}}. Preserve the exact recognizable facial identity: face proportions, eyes, nose, mouth, jawline, skin tone, apparent age, hairstyle and distinctive features. Do not beautify the person into someone different.

SCENE
{{scene}}

FRAMING
A single close portrait cropped at mid-chest, centred, the face large and clearly readable. The top of the head sits at about 29 percent of the image height and the face around 33 to 46 percent; the figure fills the frame down to about 80 percent of the height. The top 27 percent shows the scene (sky, light, sparks) behind a logo and a large title added later, so keep it free of the head and calm in the centre. Premium modern minimalist tennis apparel. Eye-level camera, 85mm portrait look, realistic skin texture, polished professional sports photography.

Keep the bottom 20 percent of the image dark and calm: an information panel and sponsor logos are added there by code.

Do not generate text, letters, names, numbers, banners, logos or watermarks. Do not show tennis rackets or balls.`;
export function buildPlacePrompt(name='', kind='champion', { comment='', variant=1 }={}) {
  const k=PLACE_KINDS[kind]||PLACE_KINDS.champion;
  const notes=['Composition option 1: calm, premium editorial portrait, soft key light.','Composition option 2: slightly turned head and a stronger rim light from the scene.'];
  return fillTokens(cleanEnvPrompt(process.env.PLACE_POSTER_PROMPT)||PLACE_PROMPT,{ player:String(name||''), scene:k.scene })
    +'\n\n'+[notes[(Number(variant)||1)-1]||notes[0], comment?`Organizer direction: ${comment}`:''].filter(Boolean).join('\n');
}
export async function preparePlacePosterJob({ name='', telegramId='', kind='champion', division='', season='', comment='', variants=VARIANTS }={}) {
  const row=await findApplicantByTelegramId(telegramId).catch(()=>null);
  const consent=[{ telegram_id:String(telegramId||''), name:String(name||''), value:consentValue(row)||'NOT_ANSWERED', allowed:posterConsentAllowed(consentValue(row)) }];
  const count=Math.max(1,Math.min(2,Number(variants||VARIANTS)));
  const prompts=Array.from({length:count},(_,i)=>({ variant:i+1, prompt:buildPlacePrompt(name,kind,{comment,variant:i+1}) }));
  return { kind:'place', place:kind, name:String(name||''), telegramId:String(telegramId||''), division:String(division||''), season:String(season||''),
    status:consent[0].allowed?(posterEnabled()?'ready_to_generate':'api_not_configured'):'blocked_consent', consent, prompts, comment:String(comment||'').trim() };
}
export async function generatePlaceBackgrounds(job={}) {
  if(!posterEnabled())throw new Error('OPENAI_API_KEY не задан');
  if(!job.consent?.every(x=>x.allowed))throw new Error('poster_consent_required');
  const photo=await playerPhotoForPoster({ telegramId:job.telegramId, name:job.name });
  if(!photo)throw new Error('poster_source_photo_missing');
  const refs=[await imageReference(photo)];
  const out=[];
  for(const item of job.prompts||[])out.push({ variant:item.variant, buffer:await generateOneBackground(String(item.prompt||''),refs) });
  return out;
}
export async function composePlacePoster(backgroundBuffer, { name='', kind='champion', division='', season='' }={}) {
  if (!backgroundBuffer) throw new Error('poster_background_missing');
  const k=PLACE_KINDS[kind]||PLACE_KINDS.champion;
  const th={ ...(STAGE_THEMES[k.theme]||STAGE_THEMES.SF), ...(k.metal||{}) };
  const champion=kind==='champion';
  const panelH=170, P={ x:40, y:PL.panelBottom-panelH, w:1000, h:panelH, r:38 };
  const nm=fit(name,22); let ns=60; while(ns>34&&textWidth(nm,ns)>900)ns-=1;
  const divRaw=String(division||'').split('·')[0].trim();
  const chip=[divRaw&&!/^Division\b/i.test(divRaw)?`DIVISION ${divRaw.toUpperCase()}`:divRaw.toUpperCase(),season?`SEASON ${season}`:''].filter(Boolean).join(' · ');
  const hs=Math.min(champion?150:130, Math.floor(960/(k.title.length*0.68)));
  const titleY=L.logoTop+L.logoBox.h+hs*0.92;
  const sponsor=await posterSponsorStrip();
  const svg=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.bg1}" stop-opacity=".72"/><stop offset=".18" stop-color="${C.bg1}" stop-opacity=".25"/>
      <stop offset=".3" stop-color="${C.bg1}" stop-opacity=".04"/><stop offset=".64" stop-color="${C.bg1}" stop-opacity=".1"/>
      <stop offset=".78" stop-color="${C.bg1}" stop-opacity=".8"/><stop offset="1" stop-color="${C.bg1}" stop-opacity=".98"/></linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${th.deep}"/><stop offset=".5" stop-color="${th.light}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.light}"/><stop offset=".55" stop-color="${th.metal}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
  ${corners(th,champion)}
  <rect width="${WIDTH}" height="8" fill="url(#bar)"/><rect y="${HEIGHT-8}" width="${WIDTH}" height="8" fill="url(#bar)"/>
  <text x="${WIDTH/2}" y="${L.titleY}" text-anchor="middle" font-family="${FONT}" font-size="28" font-weight="700" letter-spacing="9" fill="${th.light}" opacity=".95">PHUKET TENNIS FAMILY</text>
  <text x="${WIDTH/2}" y="${titleY}" text-anchor="middle" font-family="${FONT}" font-size="${hs}" font-weight="900" letter-spacing="${Math.round(hs*0.06)}" fill="url(#metal)" stroke="${hexA(C.bg1,.35)}" stroke-width="2">${esc(k.title)}</text>
  <rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="${P.r}" fill="${C.bg2}" fill-opacity=".78" stroke="${hexA(th.metal,.45)}" stroke-width="1.5"/>
  <text x="${WIDTH/2}" y="${P.y+86}" text-anchor="middle" font-family="${FONT}" font-size="${ns}" font-weight="900" fill="${th.light}">${esc(nm)}</text>
  ${chip?`<text x="${WIDTH/2}" y="${P.y+132}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="700" letter-spacing="4" fill="${C.dim}" opacity=".85">PLAYOFFS · ${esc(chip)}</text>`:''}
</svg>`);
  const logos=await posterLogoLayers(sponsor);
  return sharp(backgroundBuffer).rotate().resize(WIDTH,HEIGHT,{fit:'cover',position:'centre'})
    .composite([{input:svg,left:0,top:0},...logos]).png({compressionLevel:6}).toBuffer();
}
// Какие постеры мест положены после матча: финал — чемпион и раннер-ап,
// матч за 3-е — третье и четвёртое места.
export function placesForStage(stageKey) {
  if (stageKey === 'Final') return [['winner','champion'],['loser','runner_up']];
  if (stageKey === '3rd') return [['winner','third'],['loser','fourth']];
  return [];
}
