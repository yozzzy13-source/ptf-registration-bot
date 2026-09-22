import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Real image renderer, mocked portrait sources: no Google or Telegram access.
const red = await sharp({create:{width:400,height:400,channels:3,background:'#ef3434'}}).png().toBuffer();
const blue = await sharp({create:{width:400,height:400,channels:3,background:'#3454ef'}}).png().toBuffer();
const green = await sharp({create:{width:400,height:400,channels:4,background:'#24b56a'}}).png().toBuffer();
let lookups = [], downloads = [], failAvatar = false, logoFiles = [];
const sharpMock=(input,...args)=>sharp(typeof input==='string'&&input.includes('match-card-logos')?green:input,...args);
sharpMock.strategy=sharp.strategy;
const context = vm.createContext({Buffer,console,Map,process:{env:{}},fetch:async url=>{
  downloads.push(url);
  assert.equal(url,'https://portraits.test/master.png');
  return {ok:true,arrayBuffer:async()=>blue};
}});
const mock = values => new vm.SyntheticModule(Object.keys(values),function(){
  for(const [key,value] of Object.entries(values)) this.setExport(key,value);
},{context});
const deps = {
  sharp:mock({default:sharpMock}),
  './telegram.js':mock({getFileBuffer:async id=>{
    lookups.push(id); if(failAvatar)throw Error('Unavailable avatar');return {buffer:red};
  }}),
  './sheets.js':mock({
    findApplicantByTelegramId:async id=>({avatar_file_id:id==='1'?'applicants-avatar':''}),
    getMasterPhotos:async()=>new Map([['Alice One','https://portraits.test/master.png'],['Bob Two','https://portraits.test/master.png']])
  }),
  'node:fs':mock({default:{readdirSync:dir=>String(dir).includes('match-card-logos')?logoFiles:[],readFileSync:()=>Buffer.from('test-font'),writeFileSync:()=>{},mkdtempSync:p=>String(p)+'tmp'}}),
  'node:path':mock({default:{join:(...parts)=>parts.join('/'),dirname:x=>x}}),
  'node:os':mock({default:{tmpdir:()=>'/tmp'}}),
  'node:url':mock({fileURLToPath:x=>String(x)})
};
const source=await fs.readFile(new URL('../matchcard.js',import.meta.url),'utf8');
const mod=new vm.SourceTextModule(source,{context});
await mod.link(spec=>{assert.ok(deps[spec],'Unexpected portrait source: '+spec);return deps[spec]});
await mod.evaluate();
const card=mod.namespace;
const match={winner:'Alice One',loser:'Bob Two',winnerId:'1',loserId:'2',score:'7:6 (7:4) 3:6 10:8',division:'Division W · Group 2',season:'2',date:'13.09.2026',court:'Court A',
  winnerMeta:{position:{before:3,after:1},fp:18,form:['L','W','W','W','W']},
  loserMeta:{position:{before:2,after:2},fp:6,form:['W','L','W','L']}};
const png=await card.renderMatchCard(match);
if(process.argv[2]) await fs.writeFile(process.argv[2],png);
const meta=await sharp(png).metadata();
assert.equal(meta.width,1080);assert.equal(meta.height,1148);assert.equal(meta.format,'png');
assert.deepEqual(lookups,['applicants-avatar']);
assert.deepEqual(downloads,['https://portraits.test/master.png']);
const pixel=async (img,left,top)=>[...await sharp(img).extract({left,top,width:1,height:1}).removeAlpha().raw().toBuffer()];
assert.deepEqual(await pixel(png,225,390),[239,52,52],'Applicants portrait takes priority');
assert.deepEqual(await pixel(png,855,390),[52,84,239],'Master photo is second choice');
card.forgetPhotoCache();failAvatar=true;downloads=[];
const fallback=await card.renderMatchCard({...match,loser:'No Portrait',loserId:''});
assert.deepEqual(downloads,['https://portraits.test/master.png']);
assert.deepEqual(await pixel(fallback,225,390),[52,84,239],'Broken Applicants avatar falls back to Master');
assert.equal((await sharp(fallback).metadata()).width,1080,'Missing photo renders initials');
const bare=await card.renderMatchCard({...match,winnerMeta:null,loserMeta:null});
assert.equal((await sharp(bare).metadata()).height,1148,'Card without stats keeps the same canvas');
failAvatar=false;downloads=[];lookups=[];card.forgetPhotoCache();
const instagram=await card.renderInstagramMatchCard(match);
const instagramMeta=await sharp(instagram).metadata();
assert.equal(instagramMeta.width,1080);assert.equal(instagramMeta.height,1148);assert.equal(instagramMeta.format,'png');
assert.deepEqual(png,instagram,'Telegram and Instagram use one identical card');
logoFiles=['01-partner.png'];
const branded=await card.renderMatchCard(match);
assert.deepEqual(await pixel(branded,540,1048),[36,181,106],'Transparent partner files are picked up without a code change');
logoFiles=[];
const withoutFantasy=await card.renderInstagramMatchCard({
  ...match,
  winnerMeta:{...match.winnerMeta,fp:null},
  loserMeta:{...match.loserMeta,fp:null}
});
assert.deepEqual(instagram,withoutFantasy,'Unified card ignores Fantasy Points');
assert.ok(!(await fs.readFile(new URL('../matchcard.js',import.meta.url),'utf8')).includes('>WINNER<'),'Winner label is absent');
if(process.argv[2]) await fs.writeFile(process.argv[2],png);
if(process.argv[3]) await fs.writeFile(process.argv[3],instagram);
console.log('PASS: unified 1080x1148 match card, portrait fallbacks, no Fantasy Points or Winner label.');