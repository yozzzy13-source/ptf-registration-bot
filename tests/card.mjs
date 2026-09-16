import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Real image renderer, mocked portrait sources: no Google or Telegram access.
const red = await sharp({create:{width:400,height:400,channels:3,background:'#ef3434'}}).png().toBuffer();
const blue = await sharp({create:{width:400,height:400,channels:3,background:'#3454ef'}}).png().toBuffer();
let lookups = [], downloads = [], failAvatar = false;
const context = vm.createContext({Buffer,console,Map,fetch:async url=>{
  downloads.push(url);
  assert.equal(url,'https://portraits.test/master.png');
  return {ok:true,arrayBuffer:async()=>blue};
}});
const mock = values => new vm.SyntheticModule(Object.keys(values),function(){
  for(const [key,value] of Object.entries(values)) this.setExport(key,value);
},{context});
const deps = {
  sharp:mock({default:sharp}),
  './telegram.js':mock({getFileBuffer:async id=>{
    lookups.push(id); if(failAvatar)throw Error('Unavailable avatar');return {buffer:red};
  }}),
  './sheets.js':mock({
    findApplicantByTelegramId:async id=>({avatar_file_id:id==='1'?'applicants-avatar':''}),
    getMasterPhotos:async()=>new Map([['Alice One','https://portraits.test/master.png'],['Bob Two','https://portraits.test/master.png']])
  }),
  'node:fs':mock({default:{readFileSync:()=>Buffer.from('test-font')}}),
  'node:path':mock({default:{join:(...parts)=>parts.join('/'),dirname:x=>x}}),
  'node:url':mock({fileURLToPath:x=>String(x)})
};
const source=await fs.readFile(new URL('../matchcard.js',import.meta.url),'utf8');
const mod=new vm.SourceTextModule(source,{context});
await mod.link(spec=>{assert.ok(deps[spec],'Unexpected portrait source: '+spec);return deps[spec]});
await mod.evaluate();
const card=mod.namespace;
const match={winner:'Alice One',loser:'Bob Two',winnerId:'1',loserId:'2',score:'7:6 (7:4) 3:6 10:8',division:'Division W · Group 2',season:'2',date:'13.09.2026',court:'Court A'};
const png=await card.renderMatchCard(match);
const meta=await sharp(png).metadata();
assert.equal(meta.width,1200);assert.equal(meta.height,630);assert.equal(meta.format,'png');
assert.deepEqual(lookups,['applicants-avatar']);
assert.deepEqual(downloads,['https://portraits.test/master.png']);
const pixel=async (img,left,top)=>[...await sharp(img).extract({left,top,width:1,height:1}).removeAlpha().raw().toBuffer()];
assert.deepEqual(await pixel(png,280,250),[239,52,52],'Applicants portrait takes priority');
assert.deepEqual(await pixel(png,920,250),[52,84,239],'Master photo is second choice');
card.forgetPhotoCache();failAvatar=true;downloads=[];
const fallback=await card.renderMatchCard({...match,loser:'No Portrait',loserId:''});
assert.deepEqual(downloads,['https://portraits.test/master.png']);
assert.deepEqual(await pixel(fallback,280,250),[52,84,239],'Broken Applicants avatar falls back to Master');
assert.equal((await sharp(fallback).metadata()).width,1200,'Missing photo renders initials');
if(process.argv[2]) await fs.writeFile(process.argv[2],png);
console.log('PASS: 10 image checks, using the real renderer with mocked portrait sources.');
