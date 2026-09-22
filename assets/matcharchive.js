import { Readable } from 'node:stream';
import { drive } from './google.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const folderCache = new Map();

const clean = (value, fallback='match') => {
  const out = String(value || '').normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return (out || fallback).slice(0, 90);
};
const escapeQuery = value => String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findChild(parentId, name, mimeType='') {
  const api = drive();
  const clauses = [
    `'${escapeQuery(parentId)}' in parents`,
    `name = '${escapeQuery(name)}'`,
    'trashed = false'
  ];
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  const res = await api.files.list({
    q: clauses.join(' and '),
    spaces: 'drive',
    fields: 'files(id,name,mimeType,webViewLink,parents)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return res.data.files?.[0] || null;
}

async function ensureFolder(parentId, name) {
  const key = `${parentId}:${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const existing = await findChild(parentId, name, FOLDER_MIME);
  if (existing?.id) { folderCache.set(key, existing.id); return existing.id; }
  const created = await drive().files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true
  });
  const id = created.data.id;
  if (!id) throw new Error(`Drive did not return an id for folder ${name}`);
  folderCache.set(key, id);
  return id;
}

async function upsertPng(parentId, name, buffer, appProperties={}) {
  const api = drive();
  const existing = await findChild(parentId, name, 'image/png');
  const media = { mimeType: 'image/png', body: Readable.from(buffer) };
  if (existing?.id) {
    const updated = await api.files.update({
      fileId: existing.id,
      requestBody: { name, appProperties },
      media,
      fields: 'id,name,webViewLink,modifiedTime',
      supportsAllDrives: true
    });
    return { ...updated.data, updated:true };
  }
  const created = await api.files.create({
    requestBody: { name, parents:[parentId], appProperties },
    media,
    fields: 'id,name,webViewLink,createdTime',
    supportsAllDrives: true
  });
  return { ...created.data, updated:false };
}

async function upsertJson(parentId, name, value, appProperties={}) {
  const api = drive();
  const existing = await findChild(parentId, name, 'application/json');
  const buffer = Buffer.from(JSON.stringify(value, null, 2));
  const media = { mimeType:'application/json', body:Readable.from(buffer) };
  if (existing?.id) {
    const updated = await api.files.update({
      fileId:existing.id, requestBody:{ name, appProperties }, media,
      fields:'id,name,webViewLink,modifiedTime', supportsAllDrives:true
    });
    return { ...updated.data, updated:true };
  }
  const created = await api.files.create({
    requestBody:{ name, parents:[parentId], appProperties }, media,
    fields:'id,name,webViewLink,createdTime', supportsAllDrives:true
  });
  return { ...created.data, updated:false };
}
function matchBaseName(slot={}) {
  const date = clean(slot.agreed_date || new Date().toISOString().slice(0, 10), 'undated');
  const division = clean([slot.division, slot.group ? `group-${slot.group}` : ''].filter(Boolean).join('-'), 'division');
  const players = clean(`${slot.from_name || 'player-1'}-vs-${slot.to_name || 'player-2'}`, 'players');
  const id = clean(slot.challenge_id || slot.match_id || '', 'match');
  return `${date}_${division}_${players}_${id}`;
}

export async function archiveMatchCards(slot={}, {
  rootFolderId='', season='', cardBuffer=null
}={}) {
  if (!rootFolderId) return { saved:false, reason:'not_configured' };
  if (!cardBuffer) return { saved:false, reason:'buffer_missing' };
  const seasonName = 'Season ' + clean(season || slot.season || 'unknown', 'unknown');
  const monthName = /^\d{4}-\d{2}/.test(String(slot.agreed_date || ''))
    ? String(slot.agreed_date).slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const seasonFolder = await ensureFolder(rootFolderId, seasonName);
  const monthFolder = await ensureFolder(seasonFolder, monthName);
  const publishingFolder = await ensureFolder(monthFolder, 'Publishing');
  const cardsFolder = await ensureFolder(publishingFolder, 'Match Cards');
  const queueFolder = await ensureFolder(publishingFolder, 'Queue');
  const base = matchBaseName(slot);
  const props = {
    ptf_match_id:String(slot.challenge_id || slot.match_id || ''),
    ptf_season:String(season || slot.season || ''),
    ptf_date:String(slot.agreed_date || ''),
    ptf_card_type:'match'
  };
  const card = await upsertPng(cardsFolder, base + '_match.png', cardBuffer, props);
  const publication = {
    schema_version:1,
    status:'card_ready',
    match:{
      id:String(slot.challenge_id || slot.match_id || ''),
      season:String(season || slot.season || ''),
      division:String(slot.division || ''),
      group:String(slot.group || ''),
      date:String(slot.agreed_date || ''),
      from:{ telegram_id:String(slot.from_telegram_id || ''), name:String(slot.from_name || '') },
      to:{ telegram_id:String(slot.to_telegram_id || ''), name:String(slot.to_name || '') },
      winner_telegram_id:String(slot.result_winner || ''),
      score:String(slot.result_score || '')
    },
    match_card:{
      status:'ready', width:1080, height:1148,
      drive_file_id:String(card.id || ''), drive_url:String(card.webViewLink || '')
    },
    carousel:{
      status:'planned', aspect_ratio:'4:5', width:1080, height:1350
    },
    story_poster:{
      status:'prompt_ready', aspect_ratio:'9:16', width:1080, height:1920,
      generator:'pending_api', source:'original_player_avatars',
      prompt_version:'ptf-match-poster-v1', variants:2
    }
  };
  const event = await upsertJson(queueFolder, base + '.json', publication, {
    ...props, ptf_card_type:'publication_event', ptf_publication_status:'card_ready'
  });
  return {
    saved:true,
    path:seasonName + '/' + monthName + '/Publishing',
    card:{ id:card.id, name:card.name, url:card.webViewLink || '', updated:card.updated },
    event:{ id:event.id, name:event.name, url:event.webViewLink || '', updated:event.updated }
  };
}
async function posterPublishingFolders(slot={}, rootFolderId='', season='') {
  const seasonName = 'Season ' + clean(season || slot.season || 'unknown', 'unknown');
  const monthName = /^\d{4}-\d{2}/.test(String(slot.agreed_date || ''))
    ? String(slot.agreed_date).slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const seasonFolder = await ensureFolder(rootFolderId, seasonName);
  const monthFolder = await ensureFolder(seasonFolder, monthName);
  const publishingFolder = await ensureFolder(monthFolder, 'Publishing');
  return {
    seasonName, monthName, publishingFolder,
    queueFolder:await ensureFolder(publishingFolder, 'Queue'),
    postersFolder:await ensureFolder(publishingFolder, 'Story Posters')
  };
}

export async function archivePosterJob(slot={}, {
  rootFolderId='', season='', job=null
}={}) {
  if (!rootFolderId) return { saved:false, reason:'not_configured' };
  if (!job) return { saved:false, reason:'job_missing' };
  const folders=await posterPublishingFolders(slot,rootFolderId,season);
  const base=matchBaseName(slot);
  const props={
    ptf_match_id:String(slot.challenge_id || slot.match_id || ''),
    ptf_season:String(season || slot.season || ''),
    ptf_date:String(slot.agreed_date || ''),
    ptf_card_type:'poster_job',
    ptf_publication_status:String(job.status || 'prompt_ready')
  };
  const file=await upsertJson(folders.queueFolder,base+'_poster-job.json',job,props);
  return {
    saved:true,
    path:folders.seasonName+'/'+folders.monthName+'/Publishing/Queue',
    job:{id:file.id,name:file.name,url:file.webViewLink || '',updated:file.updated}
  };
}

export async function archivePosterVariant(slot={}, {
  rootFolderId='', season='', buffer=null, variant=1, jobId=''
}={}) {
  if (!rootFolderId) return { saved:false, reason:'not_configured' };
  if (!buffer) return { saved:false, reason:'buffer_missing' };
  const folders=await posterPublishingFolders(slot,rootFolderId,season);
  const base=matchBaseName(slot);
  const index=Math.max(1,Math.min(2,Number(variant || 1)));
  const file=await upsertPng(folders.postersFolder,base+`_poster-v${index}.png`,buffer,{
    ptf_match_id:String(slot.challenge_id || slot.match_id || ''),
    ptf_season:String(season || slot.season || ''),
    ptf_card_type:'story_poster',
    ptf_poster_variant:String(index),
    ptf_poster_job:String(jobId || '')
  });
  return {
    saved:true,
    path:folders.seasonName+'/'+folders.monthName+'/Publishing/Story Posters',
    poster:{id:file.id,name:file.name,url:file.webViewLink || '',updated:file.updated,variant:index}
  };
}

export function forgetMatchArchiveFolders() { folderCache.clear(); }
