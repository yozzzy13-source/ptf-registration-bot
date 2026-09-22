import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=await fs.readFile(path.join(root,'matcharchive.js'),'utf8');
const context=vm.createContext({Buffer,console,Map,Date,String});
const entries=[];
let seq=0,folderCreates=0,fileCreates=0,fileUpdates=0;
const readBody=async body=>{const chunks=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);};
const parseQuoted=(q,label)=>{
  if(label==='parent')return q.match(/'([^']+)' in parents/)?.[1]||'';
  if(label==='name')return q.match(/name = '([^']+)'/)?.[1]||'';
  if(label==='mime')return q.match(/mimeType = '([^']+)'/)?.[1]||'';
  return '';
};
const api={files:{
  async list({q}) {
    const parent=parseQuoted(q,'parent'),name=parseQuoted(q,'name'),mime=parseQuoted(q,'mime');
    return {data:{files:entries.filter(x=>x.parent===parent&&x.name===name&&(!mime||x.mimeType===mime)).slice(0,1)}};
  },
  async create({requestBody,media}) {
    const isFolder=requestBody.mimeType==='application/vnd.google-apps.folder';
    const item={id:'id-'+(++seq),name:requestBody.name,parent:requestBody.parents[0],
      mimeType:isFolder?requestBody.mimeType:media.mimeType,webViewLink:'https://drive.test/'+seq,
      bytes:media?await readBody(media.body):Buffer.alloc(0),appProperties:requestBody.appProperties||{}};
    entries.push(item);if(isFolder)folderCreates++;else fileCreates++;
    return {data:item};
  },
  async update({fileId,requestBody,media}) {
    const item=entries.find(x=>x.id===fileId);Object.assign(item,requestBody,{bytes:await readBody(media.body)});
    fileUpdates++;return {data:item};
  }
}};
const dependency=new vm.SyntheticModule(['drive'],function(){this.setExport('drive',()=>api)},{context});
const streamModule=new vm.SyntheticModule(['Readable'],function(){this.setExport('Readable',Readable)},{context});
const mod=new vm.SourceTextModule(source,{context});
await mod.link(spec=>spec==='./google.js'?dependency:spec==='node:stream'?streamModule:Promise.reject(Error('Unexpected import '+spec)));
await mod.evaluate();
const archive=mod.namespace;
const slot={challenge_id:'match-7',season:'2',agreed_date:'2026-09-21',division:'W',group:'2',
  from_name:'Alice One',to_name:'Bob Two'};
const options={rootFolderId:'root-folder',season:'2',cardBuffer:Buffer.from('unified-card')};
const first=await archive.archiveMatchCards(slot,options);
assert.equal(first.saved,true);assert.equal(first.path,'Season 2/2026-09/Publishing');
assert.equal(folderCreates,5);assert.equal(fileCreates,2);assert.equal(fileUpdates,0);
assert.match(first.card.name,/_match\.png$/);
assert.equal(entries.find(x=>x.name===first.card.name).bytes.toString(),'unified-card');
assert.equal(entries.find(x=>x.name===first.card.name).appProperties.ptf_card_type,'match');
const eventEntry=entries.find(x=>x.name===first.event.name);
const event=JSON.parse(eventEntry.bytes.toString());
assert.equal(event.status,'card_ready');assert.equal(event.match_card.height,1148);assert.equal(event.carousel.status,'planned');assert.equal(event.carousel.aspect_ratio,'4:5');
assert.equal(event.story_poster.aspect_ratio,'9:16');assert.equal(event.story_poster.generator,'pending_api');
const second=await archive.archiveMatchCards(slot,{...options,cardBuffer:Buffer.from('unified-card-v2')});
assert.equal(second.saved,true);assert.equal(folderCreates,5);assert.equal(fileCreates,2);assert.equal(fileUpdates,2);
assert.equal(entries.find(x=>x.name===second.card.name).bytes.toString(),'unified-card-v2');
assert.equal((await archive.archiveMatchCards(slot,{...options,rootFolderId:''})).reason,'not_configured');
assert.equal((await archive.archiveMatchCards(slot,{...options,cardBuffer:null})).reason,'buffer_missing');
const job={job_id:'poster-job-1',status:'waiting_api',prompts:[{variant:1,prompt:'one'},{variant:2,prompt:'two'}]};
const savedJob=await archive.archivePosterJob(slot,{rootFolderId:'root-folder',season:'2',job});
assert.equal(savedJob.saved,true);assert.match(savedJob.job.name,/_poster-job\.json$/);
assert.equal(JSON.parse(entries.find(x=>x.name===savedJob.job.name).bytes.toString()).prompts.length,2);
const savedPoster=await archive.archivePosterVariant(slot,{rootFolderId:'root-folder',season:'2',buffer:Buffer.from('poster-v1'),variant:1,jobId:job.job_id});
assert.equal(savedPoster.saved,true);assert.match(savedPoster.poster.name,/_poster-v1\.png$/);
assert.equal(entries.find(x=>x.name===savedPoster.poster.name).bytes.toString(),'poster-v1');
assert.equal((await archive.archivePosterJob(slot,{rootFolderId:'',season:'2',job})).reason,'not_configured');
console.log('PASS: Drive archive stores the compact match card, poster job and future 9:16 variants.');