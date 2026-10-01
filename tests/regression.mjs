import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// In-memory Sheets and Telegram. No credentials, network, bot startup or writes
// to real spreadsheets are involved. Run: node --experimental-vm-modules tests/regression.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let telegramFailureId='',telegramTransientId='',transientLeft=0;
const tables = new Map(), writes = [], messages = [], routes = [], middleware = [], sheetEdits = [];
const put = (id,title,rows) => tables.set(id+'|'+title,structuredClone(rows));
put('crm','Applicants',[
 ['telegram_id','name','status','language','telegram_username','avatar_file_id'],
 ['1','Alice One','inactive','en','alice',''],['2','Bob Two','waitlist','ru','bob',''],
 ['3','Carol Three','active','en','carol',''],['4','Dan Four','active','ru','dan',''],
 ['5','No Division','inactive','en','nodiv',''],['6','Out Sider','active','en','out',''],
 ['7','Wendy One','inactive','en','wendy',''],['8','Wendy Two','waitlist','ru','wendy2',''],
 ['9','Wendy Three','active','en','wendy3',''],['10','Wendy Four','active','ru','wendy4','']
]);
put('crm','Settings',[['key','value'],['season_number','2'],['league_seasons','2:active']]);
put('crm','Applications',[['application_id','telegram_id']]);
put('master','Players_Master',[[],[],['Player ID','Player Name','Division','Photo URL'],
 ...['Alice One','Bob Two','Carol Three','Dan Four','No Division','Wendy One','Wendy Two','Wendy Three','Wendy Four'].map((n,i)=>[i+1,n,'','https://photos.test/'+i+'.png'])]);
put('master','Divisions',[
 ['season','letter','title','title_en','sheet_url','status','order','group'],
 ['2','A','Division A','Division A','https://docs.google.com/spreadsheets/d/a-test','On',1,''],
 ...[['C','1','c1'],['C','2','c2'],['W','1','w1'],['W','2','w2']].map(([d,g,id])=>['2',d,'Division '+d,'Division '+d,'https://docs.google.com/spreadsheets/d/'+id,'On',d==='C'?4:6,g])
]);
put('master','Cross_Division_Match_Log',[['Match','Date']]);
for(const [id,names] of Object.entries({c1:['Alice One','Bob Two'],c2:['Carol Three','Dan Four'],w1:['Wendy One','Wendy Two'],w2:['Wendy Three','Wendy Four']})){
 put(id,'Division_Tracker',[['Player'],...names.map(n=>[n])]);
 put(id,'Match_Log',[
  ['match','p1_id','player_1','p2_id','player_2','s1p1','s1p2','s1tb1','s1tb2','s2p1','s2p2','s2tb1','s2tb2','s3p1','s3p2','s3tb1','s3tb2','set3_mode','played','competition','winner_id'],
  ['1','1',names[0],'2',names[1]]
 ]);
}
put('matches','Match Slots',[['challenge_id','match_type','status','division','from_telegram_id','from_name']]);
put('a-test','Division_Tracker',[['Player'],...Array.from({length:8},(_,i)=>['A Player '+(i+1)])]);
put('a-test','Match_Log',[['match','id1','player1','id2','player2'],...Array.from({length:7},(_,i)=>[i+1,1,'A Player 1',i+2,'A Player '+(i+2)]),[1,1,'A Player 1',2,'A Player 2'],[29,1,'A Player 1',3,'A Player 3',6,0]]);
put('matches','Courts',[['name','address','whatsapp'],['Court A','Phuket','661234']]);
const col = letters => [...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
function rangeInfo(id,range){
 const m=/^'?([^'!]+)'?!([A-Z]+)(\d*)?(?::([A-Z]+)(\d*)?)?$/.exec(range);
 if(!m)throw Error('Unsupported range '+range);
 return {key:id+'|'+m[1],title:m[1],c1:col(m[2]),r1:Number(m[3]||1)-1,c2:col(m[4]||m[2]),r2:m[5]?Number(m[5])-1:(m[4]?Infinity:Number(m[3]||1)-1)};
}
// quotaKeys: листы, на которых Google «упёрся в лимит»; sheetReads — счётчик чтений.
const quotaKeys=new Set(),sheetReads=[];
async function get({spreadsheetId,range}){
 const r=rangeInfo(spreadsheetId,range),rows=tables.get(r.key);
 sheetReads.push(r.key);
 if(quotaKeys.has(r.key)||quotaKeys.has('*'))throw Error("Quota exceeded for quota metric 'Read requests'");
 if(!rows)throw Error('Unable to parse range: '+range+' (missing test sheet '+r.key+')');
 return {data:{values:rows.slice(r.r1,Number.isFinite(r.r2)?r.r2+1:undefined).map(row=>row.slice(r.c1,r.c2+1))}};
}
async function update({spreadsheetId,range,requestBody}){
 writes.push({spreadsheetId,range,values:requestBody.values});
 const r=rangeInfo(spreadsheetId,range);const rows=tables.get(r.key)||[];
 requestBody.values.forEach((row,i)=>{rows[r.r1+i] ||= [];row.forEach((v,j)=>rows[r.r1+i][r.c1+j]=v)});
 tables.set(r.key,rows);return {data:{}};
}
const google={spreadsheets:{
 get:async({spreadsheetId})=>({data:{sheets:[...tables.keys()].filter(k=>k.startsWith(spreadsheetId+'|')).map((k,i)=>({properties:{title:k.split('|')[1],sheetId:i}}))}}),
 batchUpdate:async({spreadsheetId,requestBody})=>{sheetEdits.push(...(requestBody.requests||[]));for(const r of requestBody.requests||[])if(r.addSheet)put(spreadsheetId,r.addSheet.properties.title,[]);return {data:{}}},
 values:{get,update,batchGet:async({spreadsheetId,ranges})=>({data:{valueRanges:await Promise.all(ranges.map(range=>get({spreadsheetId,range}).then(r=>r.data)))}}),
  batchUpdate:async({spreadsheetId,requestBody})=>{for(const d of requestBody.data)await update({spreadsheetId,...d,requestBody:d});return {data:{}}},
  append:async({spreadsheetId,range,requestBody})=>{const r=rangeInfo(spreadsheetId,range);const rows=tables.get(r.key)||[];rows.push(...structuredClone(requestBody.values));tables.set(r.key,rows);return {data:{updates:{updatedRange:r.title+'!A'+rows.length}}}}
 }}};
const context=vm.createContext({console,URL,URLSearchParams,Buffer,Date,Math,JSON,Intl,Set,Map,FormData,Blob,Uint8Array,
 process:{env:{BOT_TOKEN:'test-token',PUBLIC_URL:'https://app.test',SPREADSHEET_ID:'crm',DIVISIONS_SPREADSHEET_ID:'master',LEAGUE_RESULTS_SHEET_ID:'master',MATCHES_SPREADSHEET_ID:'matches',TOURNAMENTS_SPREADSHEET_ID:'trn',TOURNAMENTS_TEST_SPREADSHEET_ID:'trn-test',ADMIN_IDS:'99',BROADCAST_QUIET_HOURS:'off',NODE_ENV:'production'}},
 setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>({unref(){}}),
 fetch:()=>{throw Error('Unexpected network access')}
});
const modules=new Map();
function synthetic(key,values){const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v)},{context,identifier:key});modules.set(key,m);return m;}
synthetic(path.join(root,'google.js'),{sheets:()=>google});
const telegramSource=await fs.readFile(path.join(root,'telegram.js'),'utf8');
const telegramNames=[...telegramSource.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1]);
synthetic(path.join(root,'telegram.js'),Object.fromEntries(telegramNames.map(n=>[n,n.endsWith('COMMANDS')?{}:n==='ADMIN_COMMAND_LIST'?[]:async(...args)=>{if(n==='sendMessage'&&String(args[0])===telegramFailureId)throw Error('blocked test recipient');if(n==='sendMessage'&&String(args[0])===telegramTransientId&&transientLeft-->0)throw Error('sendMessage: {"ok":false,"error_code":429,"description":"Too Many Requests: retry after 1","parameters":{"retry_after":1}}');if(n!=='withBulkRetries')messages.push({method:n,args});if(n==='withBulkRetries')return typeof args[0]==='function'?args[0]():undefined;if(n==='sendPhotoBuffer')return {photo:[{file_id:'generated-card'}]};if(n==='getMe')return {username:'test_bot'};return {}}])));
synthetic('express',{default:Object.assign(()=>({use(...x){middleware.push(x)},get(p,h){routes.push({method:'get',p,h})},post(p,h){routes.push({method:'post',p,h})},listen(){}}),{json:()=>()=>{},urlencoded:()=>()=>{},static:()=>()=>{}})});
const cardContexts=new Map();
const cardModule=synthetic(path.join(root,'matchcard.js'),{cardForSlot:async()=>Buffer.from('generated-card'),rememberCardContext:(id,data)=>cardContexts.set(String(id),data),matchDataForSlot:async()=>({}),playerPhotoForPoster:async()=>null});
const sourceLoads=new Map();
async function getModule(spec,ref){
 const key=spec.startsWith('.')?path.resolve(path.dirname(ref.identifier),spec):spec;
 if(modules.has(key))return modules.get(key);
 if(!key.startsWith(root)){
  const imported=await import(spec==='luxon'?pathToFileURL(path.join(root,'node_modules/luxon/build/node/luxon.js')).href:spec);
  return synthetic(key,imported);
 }
 // Два модуля могут одновременно попросить один и тот же файл — без этой
 // защиты тест получал бы две копии модуля (в бою ES-модуль всегда один).
 if(sourceLoads.has(key))return sourceLoads.get(key);
 const loading=(async()=>{
 const source=await fs.readFile(key,'utf8');
 const m=new vm.SourceTextModule(source,{context,identifier:key,initializeImportMeta(meta){meta.url='file:///'+key.replaceAll('\\','/')},importModuleDynamically:async(spec,ref)=>{const d=await getModule(spec,ref);if(d.status==='unlinked')await d.link(getModule);if(d.status==='linked')await d.evaluate();return d;}});
 modules.set(key,m);return m;
 })();
 sourceLoads.set(key,loading);
 return loading;
}
async function load(name){const m=await getModule('./'+name,{identifier:path.join(root,'_test.js')});if(m.status==='unlinked')await m.link(getModule);if(m.status==='linked')await m.evaluate();return m.namespace;}
const sheets=await load('sheets.js'),division=await load('division.js'),db=await load('matchesdb.js'),access=await load('access.js'),results=await load('results.js');
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++};
for(const id of ['1','2','5'])check((await sheets.getPlayerLeagueInfo({telegram_id:id})).member,'Membership ignores CRM status '+id);
check(!(await sheets.getPlayerLeagueInfo({telegram_id:'6'})).member,'Active CRM outsider denied');
check((await sheets.getPlayerLeagueInfo({telegram_id:'99'})).admin,'Admin bypasses membership');
check(!(await sheets.getPlayerLeagueInfo({telegram_id:'5'})).found,'Unassigned member has no match scope');
check((await sheets.findApplicantByTelegramIdentity({id:500,username:'alice'})).telegram_id==='1','Existing username fallback preserved');
check(await sheets.playerGroup('1')==='active','Inactive master member receives member interface');
check((await sheets.getDivisionOpponents('Division C','1','2','1')).map(p=>p.name).join()==='Bob Two','Group 1 opponents only, regardless status');
check((await sheets.getDivisionOpponents('Division W','9','2','2')).map(p=>p.name).join()==='Wendy Four','Women group 2 isolated');
check(await division.divisionSheetId('W','2','2')==='w2','Women group 2 table');
check(await division.divisionSheetId('C','2','missing')==='','No fallback to group 1 for unknown group');
const slot={challenge_id:'old',match_type:'open',status:'open',division:'Division C',from_telegram_id:'1',from_name:'Alice One',dates:'2099-09-14',time_from:'10:00',time_to:'14:00',duration_min:'120',courts:'Court A'};
await db.createSlot(slot);
check(sheetEdits.some(r=>r.updateSheetProperties?.fields==='gridProperties.columnCount'),'Existing Match Slots expands before appending service columns');
check((await db.listOpenSlots('Division C','2','2','1')).length===1,'Old slot inferred as group 1');
check((await db.listOpenSlots('Division C','3','2','2')).length===0,'Group 2 cannot see group 1 old slot');
check(!(await db.claimSlot('old',{telegram_id:'3'},{date:'2099-09-14',time:'10:00',court:'Court A'})).ok,'Cross-group take rejected');
check((await db.claimSlot('old',{telegram_id:'2'},{date:'2099-09-14',time:'10:00',court:'Court A'})).ok,'Same-group take accepted');
check((await db.findSlot('old')).group==='1','Legacy scope persisted on interaction');
check((await db.acceptProposal('old',{telegram_id:'1'})).ok,'Inactive master member confirms proposal');
check(!(await db.confirmCourt('old',{telegram_id:'6'})).ok,'Outsider cannot confirm court');
check(!(await db.confirmCourt('old',{telegram_id:'2'})).ok,'Opponent cannot confirm court');
check((await db.confirmCourt('old',{telegram_id:'1'})).ok,'Creator confirms court');
check((await db.submitResult('old',{telegram_id:'1'},{winner:'1',score:'6:4 6:3'})).ok,'Score accepted');
check(!(await db.disputeResult('old',{telegram_id:'3'})).ok,'Unrelated player cannot dispute result');
check(!(await db.confirmResult('old',{telegram_id:'1'})).ok,'Submitter cannot confirm own score');
check((await db.confirmResult('old',{telegram_id:'2'})).ok,'Opponent confirms result');
put('1CZ2-B09kIxegOK1lYVl0KBucjbxxp1ZukMD0t1QQCiY','Frontend_Profile_All',[
 ['player_id','player_name','recent_form'],
 ['3','Carol Three','WIN LOST WIN'],['4','Dan Four','LOST WIN']
]);
const result2={challenge_id:'history-form',division:'Division C',season:'2',group:'2',from_name:'Carol Three',to_name:'Dan Four',from_telegram_id:'3',to_telegram_id:'4',agreed_date:'2099-09-14',result_score:'6:4 6:3',result_winner:'3'};
const before=writes.length;const write=await results.writeConfirmedResult(result2);
check(write.status==='saved'&&write.division.status==='saved','Confirmed group 2 score written');
const allSeasonForm=cardContexts.get('history-form');
check(allSeasonForm?.p1.form.join(',')==='W,L,W,W'&&allSeasonForm?.p2.form.join(',')==='L,W,L','Card form uses the all-season profile history and includes this match once');
check(writes.slice(before).some(w=>w.spreadsheetId==='c2')&&!writes.slice(before).some(w=>w.spreadsheetId==='c1'),'Only correct group table receives result');
// Заголовки Match_Log раньше не находились никогда (norm() съедает подчёркивание
// в «p1_id»), и вместе с ними молча отваливалась запись сезона.
check(write.division.columns>0,'Match_Log header row is located');
check(write.division.season_write?.value==='Season 2','Season is written into the division Match_Log');
check(String(tables.get('c2|Match_Log')[1][19]||'')==='Season 2','Competition cell holds the season of the match');
const dup=await results.writeConfirmedResult(result2);check(dup.status==='duplicate','Repeat result does not append duplicate');
const mixed=await results.writeConfirmedResult({...result2,group:'cross',to_name:'Alice One',to_telegram_id:'1'});check(mixed.status==='saved'&&mixed.division?.cross_group,'Same-division cross-group result is stored centrally');
check(tables.has('master|Cross_Group_Match_Log'),'Cross-group journal is created in MatchLog');
const womenCrossSlot={challenge_id:'women-cross-movement',division:'Division W',season:'2',group:'cross',from_name:'Wendy Two',to_name:'Wendy Three',from_telegram_id:'8',to_telegram_id:'9',agreed_date:'2099-09-22',result_score:'6:4 6:3',result_winner:'8'};
const womenCrossWrite=await results.writeConfirmedResult(womenCrossSlot);
const womenCtx=cardContexts.get('women-cross-movement');
const womenAfter=await division.getDivisionTable('W','2','2');
const wendyThreeAfter=womenAfter.players.find(p=>p.name==='Wendy Three');
check(womenCrossWrite.division?.cross_group&&womenCtx?.cross_group,'Women cross-group result stores card context');
check(womenCtx.p1.group==='1'&&womenCtx.p2.group==='2','Women cross-group context preserves each player group');
check(womenCtx.p2.place===2&&wendyThreeAfter?.place===1,'Women cross-group result exposes ranking movement before and after');
// Боевой тестовый прогон: журнал правок и полный откат в исходное состояние.
const undoBefore=structuredClone(tables.get('w1|Match_Log'));
const journal=[];
const testRun=await results.writeConfirmedResult({division:'Division W',season:'2',group:'1',from_name:'Wendy One',to_name:'Wendy Two',from_telegram_id:'7',to_telegram_id:'8',agreed_date:'2099-10-01',result_score:'6:1 6:2',result_winner:'7'},{journal});
check(testRun.division?.status==='saved'&&journal.length>0,'Test run records every written range in the journal');
check(String(tables.get('w1|Match_Log')[1][5]||'')!=='','Test run really writes the score into the division table');
const undo=await results.rollbackJournal(journal);
check(undo.restored===undo.total&&!undo.failed.length,'Rollback restores every recorded range');
check(JSON.stringify(tables.get('w1|Match_Log')[1].slice(0,20))===JSON.stringify([...undoBefore[1],...Array(20-undoBefore[1].length).fill('')].slice(0,20)),'Division row returns to its pre-test state');
check((await results.getUnplayedOpponents('C','Alice One','2','1')).names.includes('Bob Two'),'Schedule uses group 1');
check((await results.getUnplayedOpponents('C','Carol Three','2','2')).played===1,'Schedule uses group 2 result');
const server=await load('index.js');
const util=await load('util.js');
// /test_match набирают с телефона как получится. Здесь — ровно те строки,
// которыми команда не заводилась: без разделителей, одними фамилиями, в нижнем
// регистре. Все они должны находить обоих игроков и счёт целиком.
{
 const squad=[{name:'Ilia Izotov'},{name:'Viacheslav Poniiatovsky'},{name:'Yuriy B'}];
 const resolve=raw=>{
  const p=util.parseTestMatchInput(raw);
  if(!p||!p.head)return {empty:true};
  let a=null,b=null;
  if(p.parts.length>=2){a=util.findRosterPlayer(squad,p.parts[0]).player||null;b=util.findRosterPlayer(squad,p.parts[1]).player||null}
  if(!a||!b){const pair=util.findRosterPair(squad,p.head);if(pair.length===2){a=pair[0];b=pair[1]}}
  return {winner:a?.name,loser:b?.name,score:p.score};
 };
 const joined=resolve('/test_match Ilia izotov Viacheslav Poniiatovsky 6:4 6:7 (8:10) 4:6');
 check(joined.winner==='Ilia Izotov'&&joined.loser==='Viacheslav Poniiatovsky','Names without any separator still resolve in order');
 check(joined.score==='6:4 6:7 (8:10) 4:6','Score with a tie-break in brackets survives parsing');
 const surnames=resolve('/test_match izotov | poniiatovsky | 6:4 6:3');
 check(surnames.winner==='Ilia Izotov'&&surnames.loser==='Viacheslav Poniiatovsky','Lowercase surnames resolve to full roster names');
 const dashed=resolve('/test_match Izotov - Poniiatovsky 6:4 6:3');
 check(dashed.winner==='Ilia Izotov'&&dashed.score==='6:4 6:3','Dash separator works as well as a pipe');
 check(resolve('/test_match').empty,'Bare command asks for help instead of failing');
 check(!resolve('/test_match Победитель | Проигравший | 6:4 6:3').winner,'Placeholder names match nobody');
}
async function request(method,p,id,body={}){
 const route=routes.find(r=>r.method===method&&r.p===p);assert.ok(route,'route '+p);
 const req={body:{...body},query:{...(method==='get'?body:{}),t:util.signWebAppToken(id)},path:p};
 if(method==='post')req.body.t=req.query.t;
 const res={code:200,status(n){this.code=n;return this},json(v){this.body=v;return this},set(){return this},send(v){this.body=v;return this}};
 const langMiddleware=middleware.find(x=>x[0]==='/api')[1];await langMiddleware(req,res,()=>{});
 await route.h(req,res);return res;
}
check((await request('get','/api/match/bootstrap','5')).body.can_match===false,'Unassigned member can open match interface without creating matches');
check((await request('post','/api/match/create','5',{})).code===400,'Unassigned member cannot create slot');
check((await request('get','/api/match/bootstrap','6')).code===403,'Nonmember API denied');
check((await request('get','/api/match/bootstrap','99')).code===200,'Admin API access without roster');
const techApi=await request('post','/api/match/manual','99',{from_telegram_id:'7',to_telegram_id:'9',date:'2099-09-18',court:'Court A',kind:'technical',winner:'7',points_from:'3',points_to:'0',note:'no show'});
check(techApi.body.ok,'Admin can submit a technical result for a cross-group pair');
const techSlot=await db.findSlot(techApi.body.challenge_id);
check(techSlot.result_score==='W/L'&&techSlot.result_kind==='technical'&&String(techSlot.result_points_from)==='3'&&String(techSlot.result_points_to)==='0','Technical notation and manual points are stored');
check((await db.confirmResult(techApi.body.challenge_id,{telegram_id:'9'})).ok,'Second player confirms admin-entered technical result');
const techBefore=writes.length;const techWrite=await results.writeConfirmedResult({...techSlot,result_status:'confirmed'});
check(techWrite.status==='saved'&&techWrite.division?.cross_group,'Confirmed technical cross-group result reaches central cross-group log');
check(writes.slice(techBefore).some(w=>/!AB\d+$/.test(w.range)&&w.values[0][0]==='W/L')&&writes.slice(techBefore).some(w=>/!AN\d+:AO\d+$/.test(w.range)&&String(w.values[0])==='3,0'),'Technical marker and points are written to AB and AN:AO');
const qfApi=await request('post','/api/match/manual','99',{from_telegram_id:'8',to_telegram_id:'10',date:'2099-09-19',court:'Court A',round:'QF',kind:'played',winner:'8',sets:[{a:6,b:2},{a:6,b:3}],points_from:'3',points_to:'1'});
check(qfApi.body.ok,'Admin can mark a manual result as a quarterfinal');const qfSlot=await db.findSlot(qfApi.body.challenge_id);check(qfSlot.round==='QF','Playoff stage is stored in the match slot');check((await db.confirmResult(qfApi.body.challenge_id,{telegram_id:'10'})).ok,'Playoff result still requires the second player confirmation');const qfWrite=await results.writeConfirmedResult({...qfSlot,result_status:'confirmed'});check(qfWrite.division?.playoff&&tables.has('master|Playoff'),'Confirmed grouped quarterfinal is stored in the Playoff sheet');
const retApi=await request('post','/api/match/manual','3',{to_telegram_id:'4',date:'2099-09-18',court:'Court A',kind:'retired',winner:'3',sets:[{a:6,b:4},{a:2,b:1}],note:'injury'});
check(retApi.body.ok,'Player can submit a RET result');
const retSlot=await db.findSlot(retApi.body.challenge_id);check(retSlot.result_kind==='retired'&&/RET$/.test(retSlot.result_score),'RET keeps the played score and label');
check((await request('get','/api/league/division','1')).code!==403,'Inactive master member may view league');
const errorRu=await request('post','/api/match/create','2',{});check(/[а-я]/i.test(errorRu.body.error),'RU validation error');
const errorEn=await request('post','/api/match/create','1',{});check(!/[а-я]/i.test(errorEn.body.error),'EN validation error');
check(routes.filter(r=>r.p==='/cal').length===1,'Only one calendar route');
for(const letter of ['C','W']) {
 const view=await request('get','/api/league/division','1',{letter,season:'2'});
 check(view.body.groups?.length===2,letter+' API returns both groups');
 check(view.body.groups.every(g=>g.grouped&&!g.playoff.champion&&g.players.every(p=>p.zone==='playoff')),letter+' groups mark their top four as playoff seeds without declaring a champion');
 if(letter==='W')check((view.body.playoff?.qf||[]).length===1,'Grouped division API exposes the quarterfinal bracket');
}
const cross=await results.writeConfirmedResult({...result2,to_name:'Wendy Three',to_telegram_id:'9'});
check(cross.status==='cross_division_blocked','Existing admin approval for cross-division results preserved');
const matches=await load('matches.js');messages.length=0;

// Unfinished match: one durable state stops nudges without closing score entry.
const unfinishedFixture={...slot,challenge_id:'unfinished',match_type:'open',status:'accepted',season:'2',group:'1',
 from_telegram_id:'1',from_name:'Alice One',from_username:'alice',to_telegram_id:'2',to_name:'Bob Two',to_username:'bob',
 dates:'2000-01-01',agreed_date:'2000-01-01',agreed_time:'10:00',duration_min:'120',court_confirmed_at:'2000-01-01T02:00:00.000Z',
 result_prompt_sent_at:'2000-01-01T05:00:00.000Z',score_nudge:'m20,n1'};
await db.createSlot(unfinishedFixture);
check(!(await db.markMatchUnfinished('unfinished',{telegram_id:'6'})).ok,'Nonparticipant cannot pause match reminders');
const unfinishedSaved=await db.markMatchUnfinished('unfinished',{telegram_id:'1',name:'Alice One'},{note:'Rain stopped play',photoFileId:'proof-photo'});
check(unfinishedSaved.ok&&unfinishedSaved.slot.result_status==='unfinished','Player can mark a completed-time match unfinished');
check(!unfinishedSaved.slot.score_nudge&&unfinishedSaved.slot.unfinished_note==='Rain stopped play'&&unfinishedSaved.slot.unfinished_photo_file_id==='proof-photo','Unfinished evidence is stored and reminder marks are cleared');
check(!db.stuckItem(unfinishedSaved.slot,Date.now()+48*3600000),'Unfinished match produces no staged reminder');
check(db.pendingActionsFor('1',[unfinishedSaved.slot]).total===0&&db.pendingActionsFor('2',[unfinishedSaved.slot]).total===0,'Unfinished match clears both action badges');
check((await db.listResultTasks('1')).some(s=>s.challenge_id==='unfinished'),'Unfinished match remains available for later score entry');
check((await db.listMySlots('1')).some(s=>s.challenge_id==='unfinished'),'Past unfinished match remains visible in My matches');
check(!(await db.listMatchesNeedingResultPrompt()).some(s=>s.challenge_id==='unfinished'),'Unfinished match cannot receive a new result prompt');
const finishedLater=await db.submitResult('unfinished',{telegram_id:'2',name:'Bob Two'},{winner:'2',score:'3:6 6:4 6:2'});
check(finishedLater.ok&&finishedLater.slot.result_status==='pending','Either player can submit the result after the match is completed');

const unfinishedApiFixture={...unfinishedFixture,challenge_id:'unfinished-api',unfinished_note:'',unfinished_photo_file_id:'',result_status:'',score_nudge:''};
await db.createSlot(unfinishedApiFixture);
const unfinishedApi=await request('post','/api/match/unfinished','2',{challenge_id:'unfinished-api',note:'Court lights went out'});
check(unfinishedApi.body.ok&&(await db.findSlot('unfinished-api')).result_status==='unfinished','Mini app API marks the match unfinished');
const futureUnfinished={...unfinishedFixture,challenge_id:'unfinished-future',dates:'2099-01-01',agreed_date:'2099-01-01',result_prompt_sent_at:''};
await db.createSlot(futureUnfinished);
check((await db.markMatchUnfinished('unfinished-future',{telegram_id:'1'})).reason==='match_not_ended','A future match cannot be marked unfinished');

// Круговой турнир: окно уходит только тем, с кем ещё не играли.
messages.length=0;
await matches.publishOpenSlot({challenge_id:'private2',match_type:'open',status:'open',division:'Division W',
  from_telegram_id:'7',from_name:'Wendy One',dates:'2099-09-14',time_from:'10:00',time_to:'14:00',duration_min:'120',courts:'Court A',season:'2',group:'1'});
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='8'&&m.args[2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='🎾 Играю'),'Open slot reaches the same group with RU button');
check(!messages.some(m=>m.method==='sendMessage'&&['1','2','3','4'].includes(String(m.args[0]))),'Open slot is not sent to other groups or divisions');
messages.length=0;
// У Алисы с Бобом матч уже есть — окно ему больше не уходит.
await matches.publishOpenSlot({...slot,challenge_id:'private',season:'2',group:'1'});
check(!messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='🎾 Играю'),'С кем уже сыграли или договорились — окно не шлём');
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='1'&&/уже сыграли|already played/i.test(String(m.args[1]||''))),'Автору честно говорят, что рассылать некому');
messages.length=0;
await matches.broadcastResult({...result2,challenge_id:'broadcast',result_photo_file_id:'user-photo'});
check(messages.some(m=>m.method==='sendPhotoBuffer'),'Result card generated despite user photo');
check(messages.some(m=>m.method==='sendPhoto'&&m.args[1]==='user-photo'),'User photo delivered additionally');
const resultCaptions=messages.filter(m=>/sendPhoto/.test(m.method)).map(m=>m.args[m.method==='sendPhotoBuffer'?3:2]?.caption||'').filter(Boolean);
check(resultCaptions.length&&resultCaptions.every(c=>/Match Result/.test(c)&&!/[А-Яа-яЁё]/.test(c)),'Result captions are consistently English');
check(resultCaptions.every(c=>!c.includes('tg://user?id=')&&!/<a href="https:\/\/t\.me\/[^\/"]+">/.test(c)),'Result captions never link to private chats');
check(resultCaptions.some(c=>/🏆 <b>[^<]+<\/b>/.test(c)),'Result captions show player names in bold');
check(!messages.some(m=>/sendPhoto/.test(m.method)&&m.args[m.method==='sendPhotoBuffer'?4:3]?.reply_markup?.inline_keyboard),'Result cards have no inline buttons');
// Reminder lifecycle: fixed daytime clock, no live scheduler or external APIs.
const started=Date.parse('2099-09-15T03:00:00Z');
const iso=ms=>new Date(ms).toISOString();
const hour=3600000;
const base={...slot,challenge_id:'remind',season:'2',group:'1',created_at:iso(started),responded_at:iso(started),
 dates:'2099-09-20',agreed_date:'2099-09-20',agreed_time:'10:00',agreed_court:'Court A',
 to_telegram_id:'2',to_name:'Bob Two',to_username:'bob',court_pending_at:iso(started),result_status:'',nudge_sent:'',court_nudge:''};
const directCancel={...base,challenge_id:'cancel-direct',status:'pending',match_type:'direct',pending_by:'1'};
await db.createSlot(directCancel);
check((await db.cancelMatchmaking('cancel-direct',{telegram_id:'2'})).ok,'Either participant can cancel a direct request');
check((await db.findSlot('cancel-direct')).status==='cancelled','Cancelled direct request is closed');
const openCancel={...base,challenge_id:'cancel-open',status:'pending',match_type:'open',pending_by:'2',dates:'2099-09-20,2099-09-21'};
await db.createSlot(openCancel);
const returned=await db.cancelMatchmaking('cancel-open',{telegram_id:'2'});
check(returned.ok&&returned.backToOpen,'Claimant can cancel and return an open window');
const returnedSlot=await db.findSlot('cancel-open');
check(returnedSlot.status==='open'&&!returnedSlot.to_telegram_id&&returnedSlot.dates.includes('2099-09-20'),'Returned window preserves future availability and clears opponent');
await db.updateSlot('cancel-direct',{status:'accepted',result_status:'pending'});
check((await db.cancelMatchmaking('cancel-direct',{telegram_id:'1'})).reason==='result_started','A match with submitted result cannot be cancelled');
const adminOld={...base,challenge_id:'admin-old',status:'accepted',agreed_date:'2099-09-18',agreed_time:'09:00',result_status:'',result_confirmed_at:''};
const adminNew={...base,challenge_id:'admin-new',status:'accepted',agreed_date:'2099-09-22',agreed_time:'09:00',result_status:'',result_confirmed_at:''};
const adminConfirmedStatus={...base,challenge_id:'admin-confirmed-status',status:'accepted',agreed_date:'2099-09-17',result_status:' Confirmed ',result_confirmed_at:''};
const adminConfirmedAt={...base,challenge_id:'admin-confirmed-at',status:'accepted',agreed_date:'2099-09-16',result_status:'',result_confirmed_at:iso(started)};
for(const fixture of [adminOld,adminNew,adminConfirmedStatus,adminConfirmedAt])await db.createSlot(fixture);
check((await request('get','/api/match/admin-active','1')).code===403,'Admin active-request list rejects a player');
const adminActive=await request('get','/api/match/admin-active','99');
check(adminActive.body.ok&&adminActive.body.items.some(x=>x.challenge_id==='cancel-open'),'Admin sees active requests across divisions');
check(!adminActive.body.items.some(x=>['admin-confirmed-status','admin-confirmed-at'].includes(x.challenge_id)),'Admin match list hides every confirmed result');
const adminOrder=adminActive.body.items.filter(x=>['admin-old','admin-new'].includes(x.challenge_id)).map(x=>x.challenge_id).join(',');
check(adminOrder==='admin-old,admin-new','Admin match list is sorted oldest to newest');
const adminBootstrap=await request('get','/api/match/bootstrap','99');
check(!adminBootstrap.body.result_tasks.some(x=>['admin-confirmed-status','admin-confirmed-at'].includes(x.challenge_id)),'Admin result entry hides confirmed matches too');

const scopes={
 initial:{...base,status:'open',match_type:'direct'},
 negotiation:{...base,status:'pending',pending_by:'2'},
 court:{...base,status:'accepted'},
 time:{...base,status:'accepted',time_change:'12:00|1|'+iso(started)},
 result:{...base,status:'accepted',result_status:'pending',result_by:'1',result_submitted_at:iso(started)},
 score:{...base,status:'accepted',court_confirmed_at:iso(started),result_prompt_sent_at:iso(started)}
};
for(const [name,fixture] of Object.entries(scopes)) {
 check(!db.stuckItem(fixture,started+14*60000),name+' no reminder before 15 minutes');
 // «Внесите счёт» напоминаний больше не шлёт: приглашение уходит один раз, а
 // через 28 часов вопрос уходит организатору. Остальные ступени не тронуты.
 // Подтверждение чужого счёта дёргаем реже всех: две ступени вместо четырёх.
 const stages=name==='score'?[[1680,'close']]
   :name==='result'?[[240,'n2'],[1440,'d1'],[1680,'close']]
   :[[15,'m20'],[120,'n1'],[240,'n2'],[1440,'d1'],[1680,'close']];
 for(const [minutes,stage] of stages) {
   const item=db.stuckItem(fixture,started+minutes*60000);
   check(item?.stage===stage&&item.scope===(name==='initial'?'invite':name),name+' reaches '+stage);
 }
 if(name==='result')for(const minutes of [15,120])
   check(!db.stuckItem(fixture,started+minutes*60000),'Подтверждение счёта не дёргают через '+minutes+' мин');
 if(name==='score')for(const minutes of [15,120,240,1440])
   check(!db.stuckItem(fixture,started+minutes*60000),'Просьба внести счёт не повторяется через '+minutes+' мин');
}
check(db.stuckItem(scopes.initial,started+15*60000).waiting.id==='2','Initial direct challenge reminds recipient');
check(db.stuckItem(scopes.negotiation,started+15*60000).waiting.id==='1','Counter-proposal reminds other side');
check(!db.stuckItem({...base,status:'open',to_telegram_id:''},started+28*hour),'Unclaimed open window does not spam every opponent');
check(!db.stuckItem({...scopes.court,court_confirmed_at:iso(started)},started+2*hour),'Confirmed court stops booking reminders');
check(!db.stuckItem({...scopes.result,result_status:'confirmed'},started+2*hour),'Confirmed score stops reminders');
check(!db.stuckItem({...scopes.result,result_status:'disputed'},started+2*hour),'Disputed score does not trigger court expiration');
check(db.stuckItem({...scopes.court,time_change:scopes.time.time_change},started+2*hour).scope==='time','Court reminders pause during rescheduling');
check(db.stageFor(2,['m20','n1'])==='','Do not replay earlier reminder stages');
await db.createSlot(scopes.initial);
check((await db.listStuck(started+14*hour)).length===0,'Night hold suppresses staged reminders');
let item=db.stuckItem(scopes.initial,started+4*hour);
await db.markStuckNudge('remind','invite','n2',item);
check((await db.findSlot('remind')).nudge_sent==='m20,n1,n2','Night catch-up marks earlier stages instead of sending a burst');
await db.updateSlot('remind',{nudge_sent:''});
messages.length=0;
await server.runStuckNudges(started+15*60000);
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[1].includes('Вас вызвали на матч')),'Непринятый вызов получает приглашение, а не укор про незавершённое согласование');
const sentAt15=messages.length;
await server.runStuckNudges(started+20*60000);
check(messages.length===sentAt15,'Next scheduler tick does not repeat delivered reminder');
await server.runStuckNudges(started+24*hour);
check((await db.findSlot('remind')).nudge_sent.includes('d1'),'24-hour final reminder recorded');
await server.runStuckNudges(started+28*hour);
check((await db.findSlot('remind')).status==='expired','Unanswered initial direct challenge expires after 28 hours');
await db.updateSlot('remind',{...scopes.negotiation,nudge_sent:'m20,n1,n2,d1'});
const stale=db.stuckItem(await db.findSlot('remind'),started+28*hour);
check((await db.counterSlot('remind',{telegram_id:'1'},{date:'2099-09-20',time:'11:00',court:'Court A'})).ok,'Counter-proposal accepted');
check((await db.findSlot('remind')).nudge_sent==='','Counter-proposal resets all reminders');
check(!await db.isStuckCurrent(stale),'Old sweep item invalidated by new proposal');
await db.markStuckNudge('remind','negotiation','d1',stale);
check((await db.findSlot('remind')).nudge_sent==='','Stale delivery cannot mark the next stage as notified');
check(!(await db.closeStuckSlot('remind',{expected:stale,now:started+28*hour})).ok,'Stale sweep cannot expire new proposal');
check((await db.acceptProposal('remind',{telegram_id:'2'})).ok,'Agree match after counter-proposal');
check(Boolean((await db.findSlot('remind')).court_pending_at),'Court stage starts on agreement');
await db.updateSlot('remind',{...scopes.court,court_nudge:'m20,n1,n2'});
check((await db.proposeTimeChange('remind',{telegram_id:'1'},'12:00')).ok,'Rescheduling creates independent stage');
check((await db.acceptTimeChange('remind',{telegram_id:'2'},'12:00')).ok,'New time confirmed');
check((await db.findSlot('remind')).court_nudge==='','Court reminders restart after new time agreement');
await db.updateSlot('remind',{...scopes.court,time_change:'',court_nudge:''});
messages.length=0;
await server.runStuckNudges(started+15*60000);
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='1'&&m.args[1].includes('booking is incomplete')),'Court reminder sent in EN to first player');
check(!messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[1].includes('Бронирование матча не завершено')),'No court reminder sent to responding player');
item=db.stuckItem(await db.findSlot('remind'),started+28*hour);
check((await db.confirmCourt('remind',{telegram_id:'1'})).ok,'Court confirmation remains available');
check(!(await db.closeStuckSlot('remind',{scope:'court',expected:item,now:started+28*hour})).ok,'Sweep cannot cancel a court confirmed in the meantime');
await db.updateSlot('remind',{...scopes.court,court_confirmed_at:'',court_confirmed_by:'',time_change:'',dates:'2099-09-14,2099-09-20'});
await server.runStuckNudges(started+28*hour);
const reopened=await db.findSlot('remind');
check(reopened.status==='open'&&!reopened.to_telegram_id&&!reopened.agreed_time,'Unconfirmed court releases original open window');
check(reopened.dates==='2099-09-20','Only future dates return to available windows');
check(!reopened.reminder_sent&&!reopened.court_nudge&&!reopened.result_prompt_sent_at,'Reopened window has clean next-stage flags');
await db.updateSlot('remind',{...scopes.court,dates:'2099-09-14',time_change:''});
check(!(await db.closeStuckSlot('remind',{scope:'court',now:started+28*hour})).backToOpen,'Past windows are never reopened');
await db.updateSlot('remind',{...scopes.result,time_change:''});
await server.runStuckNudges(started+28*hour);
check((await db.findSlot('remind')).result_nudge.includes('close')&&(await db.findSlot('remind')).status==='accepted','Unconfirmed result escalates once without cancelling match');
await db.updateSlot('remind',{...scopes.court,agreed_date:'2000-01-01',time_change:''});
check(!(await db.listMatchesNeedingResultPrompt()).some(s=>s.challenge_id==='remind'),'Unconfirmed booking does not trigger a misleading result request');
await db.updateSlot('remind',{court_confirmed_at:iso(started)});
check((await db.listMatchesNeedingResultPrompt()).some(s=>s.challenge_id==='remind'),'Confirmed court can trigger post-match score request');
await db.updateSlot('remind',{...scopes.time,court_confirmed_at:'',result_prompt_sent_at:'',court_nudge:'m20,n1,n2,d1'});
await server.runStuckNudges(started+28*hour);
check(!(await db.findSlot('remind')).time_change&&(await db.findSlot('remind')).agreed_time==='10:00','Expired time proposal preserves original match time');
check(!(await db.findSlot('remind')).court_nudge&&(await db.findSlot('remind')).court_pending_at!==iso(started),'Court stage restarts after expired time proposal');
await db.updateSlot('remind',{...scopes.negotiation,nudge_sent:'',court_confirmed_at:'',result_prompt_sent_at:'',time_change:'',cancelled_at:''});
await server.runStuckNudges(started+28*hour);
check((await db.findSlot('remind')).status==='open','Expired negotiation returns the original available window');
await db.updateSlot('remind',{...scopes.result,result_nudge:'m20,n1,n2,d1',result_prompt_sent_at:'',time_change:''});
check((await db.submitResult('remind',{telegram_id:'1'},{winner:'1',score:'6:3 6:4'})).ok,'Revised result can be submitted');
check(!(await db.findSlot('remind')).result_nudge,'Revised result gets its own reminder sequence');
await db.updateSlot('remind',{...scopes.score,result_nudge:'',score_nudge:'',time_change:''});
await server.runStuckNudges(started+28*hour);
check((await db.findSlot('remind')).score_nudge.includes('close')&&(await db.findSlot('remind')).status==='accepted','Missing result is escalated without deleting the match');

// Recipient language and booking ownership across the complete match lifecycle.
const languageSlot={...base,challenge_id:'language',status:'accepted',comment:'',result_winner:'1',result_by:'2',result_score:'6:4 6:3',result_set3_mode:'Match TB',pending_by:'2',from_username:'outdated',to_username:'bob'};
const actions=[
 ['agreed',()=>matches.notifyMatchAgreed(languageSlot)],
 ['court',()=>matches.notifyCourtConfirmed(languageSlot)],
 ['reminder',()=>matches.notifyMatchReminder(languageSlot)],
 ['proposal',()=>matches.notifyProposal(languageSlot)],
 ['counter',()=>matches.notifyProposal(languageSlot,{isCounter:true})],
 ['direct',()=>matches.sendDirectChallenge({...languageSlot,from_telegram_id:'2',to_telegram_id:'1'})],
 ['cancel',()=>matches.notifyMatchCancelled(languageSlot,{telegram_id:'2'})],
 ['proposal declined',()=>matches.notifyProposalRejected({...languageSlot,status:'open'},{...languageSlot,pending_by:'1'})],
 ['new time',()=>matches.notifyTimeChange(languageSlot,'12:00','2')],
 ['time accepted',()=>matches.notifyTimeChangeAccepted(languageSlot,'11:00')],
 ['time rejected',()=>matches.notifyTimeChangeRejected(languageSlot,'12:00','1')],
 ['time expired',()=>matches.notifyTimeChangeExpired(languageSlot,{by:'1',time:'12:00'})],
 ['result prompt',()=>matches.notifyResultPrompt(languageSlot)],
 ['verify photo',()=>matches.notifyResultForVerification({...languageSlot,result_photo_file_id:'photo'})],
 ['result rejected',()=>matches.notifyResultRejected(languageSlot)],
 ['result recorded',()=>matches.notifyResultConfirmed(languageSlot)],
 ['result disputed',()=>matches.notifyResultDisputed({...languageSlot,result_by:'1'})],
 ['deadline',()=>matches.notifyDeadline('1',{names:['Bob Two'],daysLeft:2,division:'C'})]
];
for(const [label,action]of actions){messages.length=0;await action();const english=messages.filter(m=>String(m.args[0])==='1'&&['sendPhoto','sendMessage'].includes(m.method));check(english.length>0,label+' reaches English recipient');for(const m of english){const opts=m.method==='sendPhoto'?m.args[2]:m.args[2];const text=m.method==='sendPhoto'?opts.caption:m.args[1];check(!/[а-яё]/i.test(text+' '+JSON.stringify(opts?.reply_markup||{})),label+' body and buttons use EN');}}
messages.length=0;await matches.publishOpenSlot({...slot,challenge_id:'ru-author',division:'Division W',season:'2',group:'1',from_telegram_id:'8',from_name:'Wendy Two'});
check(messages.some(m=>String(m.args[0])==='7'&&m.args[1].includes('Looking for a match')&&!/[а-яё]/i.test(m.args[1])),'Russian author window has English body and dates for English recipient');
messages.length=0;await matches.notifyMatchAgreed(languageSlot);
for(const id of ['1','2']){const m=messages.find(m=>String(m.args[0])===id);const buttons=m.args[2].reply_markup.inline_keyboard.flat();check(buttons.some(b=>b.url&&/t.me|tg:\/\//.test(b.url)),'Contact button on agreement for '+id);check(buttons.some(b=>b.callback_data?.startsWith('match_book:'))===(id==='1'),'Only creator gets booking button '+id);}
for(const id of ['1','2']){const m=messages.find(m=>String(m.args[0])===id);check(m.args[2].reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='match_cancel:language'),'Both players get a chat cancel button '+id);}
messages.length=0;telegramFailureId='1';await matches.notifyMatchAgreed(languageSlot);telegramFailureId='';check(messages.some(m=>String(m.args[0])==='2'),'Blocked creator does not prevent notifying second player');
check((await matches.matchContact(languageSlot,'2')).url==='https://t.me/alice','Contact refreshes Applicants username before stale slot value');
check((await matches.matchContact({...languageSlot,to_telegram_id:'12345',to_username:''},'1')).url==='tg://user?id=12345','No username falls back to Telegram user link');
messages.length=0;await matches.sendBookingHelper('2',languageSlot);
check(!messages.some(m=>m.args[2]?.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.includes('court_ok'))),'Noncreator cannot use old booking helper');
await db.updateSlot('remind',{...base,status:'accepted',court_confirmed_at:'',court_confirmed_by:'',time_change:'',result_status:''});
check((await request('post','/api/match/booking','2',{challenge_id:'remind'})).code===403,'Booking API blocks noncreator');
check((await request('post','/api/match/booking','1',{challenge_id:'remind'})).body.ok,'Booking API permits creator');
check(!(await db.proposeTimeChange('remind',{telegram_id:'2'},'12:00')).ok,'Noncreator cannot reschedule court');
const count=(id,s)=>db.pendingActionsFor(id,[{...base,...s}],started).total;
check(count('2',{status:'open',match_type:'direct'})===1&&count('1',{status:'open',match_type:'direct'})===0,'Only recipient owes initial challenge response');
check(count('1',{status:'pending',pending_by:'2'})===1&&count('2',{status:'pending',pending_by:'2'})===0,'Only waiting party owes proposal response');
check(count('1',{status:'accepted'})===1&&count('2',{status:'accepted'})===0,'Only creator owes court confirmation');
check(count('1',{status:'accepted',court_confirmed_at:iso(started)})===0,'Future confirmed court clears action count');
check(count('2',{status:'accepted',time_change:'12:00|1|'+iso(started)})===1&&count('1',{status:'accepted',time_change:'12:00|1|'+iso(started)})===0,'Time change pauses booking and awaits other player only');
check(count('1',{status:'accepted',result_status:'pending',result_by:'2'})===1&&count('2',{status:'accepted',result_status:'pending',result_by:'2'})===0,'Result badge counts verifier only');
check(count('1',{status:'accepted',result_status:'confirmed'})===0&&count('1',{status:'cancelled'})===0,'Completed and cancelled matches clear badge');
const attention=(await request('get','/api/match/attention','1')).body.attention;check(Number.isInteger(attention.total)&&Array.isArray(attention.items),'Attention API returns shared action projection');
const kb=await load('keyboards.js');const decorated=kb.persistentKeyboard('en','active','1',['matches','events'],2);
check(decorated.keyboard.flat()[0].text==='🔴 My matches · 2','Telegram badge shows pending total');
check(kb.menuAction(decorated.keyboard.flat()[0].text)==='matches','Decorated text button still routes');
check(decorated.keyboard.flat()[1].web_app.url.includes('/league?tab=events'),'Standalone Events opens events, not season application');
check(sheets.BOT_MENU_BUTTONS.includes('events')&&sheets.KEYBOARD_BUTTONS.includes('events'),'Events configurable in both admin menus');
const changed=[];db.setMatchChangeHandler(ids=>changed.push(...ids));await db.updateSlot('remind',{court_confirmed_at:iso(started)});check(changed.includes('1'),'Court confirmation refreshes creator keyboard');changed.length=0;await db.updateSlot('remind',{court_nudge:'m20'});check(!changed.length,'Nudge metadata does not refresh keyboard');db.setMatchChangeHandler(null);
// Repeated schedule rows must not inflate round-robin totals or count playoff scores.
const wlog=tables.get('w1|Match_Log');wlog.push(['1','2','Wendy Two','1','Wendy One']);wlog.push(['2','1','Wendy One','2','Wendy Two',6,0]);
const unique=await results.getUnplayedOpponents('W','Wendy One','2','1');check(unique.total===1&&unique.names.length===1&&unique.played===0,'Repeated and playoff rows do not inflate or complete regular opponent');
const eight=await results.getUnplayedOpponents('A','A Player 1','2','');check(eight.total===7&&eight.names.length===7,'Eight-player division with nine schedule entries yields seven opponents');
const ev=await load('events.js'),flow=await load('eventflow.js');
const event={event_id:'past',status:'published',date:'14.09.2099',time:'10:00',signup_deadline:'30.09.2099'};
const start=Date.parse('2099-09-14T03:00:00Z');
check(ev.eventStartMs(event)===start&&ev.eventStartMs({...event,date:'2099-09-14'})===start,'Event dates accept table and ISO formats in Phuket time');
check(!ev.eventHasEnded(event,start-1)&&ev.eventHasEnded(event,start),'Without end time Past starts at exact start time');
check(!flow.isSignupOpen(event,start),'Future deadline cannot keep started event signup active');
check(!ev.eventHasEnded({...event,end_time:'12:00'},start+3600000)&&ev.eventHasEnded({...event,end_time:'12:00'},start+7200000),'Optional end time controls Past label');
check(ev.eventEndMs({...event,time:'23:00',end_time:'01:00'})===Date.parse('2099-09-14T18:00:00Z'),'Overnight event end rolls to next local date');
put('crm','Event_Registry',[ev.REGISTRY_HEADERS,ev.REGISTRY_HEADERS.map(h=>({...event,date:'01.01.2000',audience:'all'})[h]||'')]);
check(!(await flow.joinEvent({telegramId:'1',name:'Alice One',lang:'en',eventId:'past',group:'active'})).ok,'Old event signup callback cannot join past event');
put('crm','Event_Signups',[['signup_id','event_id','telegram_id','status','amount_thb'],['past-signup','past','1','invoiced',100]]);
check(!(await flow.payFromDeposit({signupId:'past-signup',telegramId:'1',lang:'en'})).ok,'Past event cannot charge a new deposit payment');
check(!(await flow.cancelSignup({signupId:'past-signup',telegramId:'1',lang:'en'})).ok,'Past event cannot cancel attendance using an old button');

const links=await load('links.js');
const two=links.parseTemplate(links.panelBroadcastText({message_ru:'Привет! {matches}',message_en:'Hello! {matches}'}));
check(links.renderText(two,'en')==='Hello!'&&links.renderText(two,'ru')==='Привет!','Broadcast selects complete text by recipient language');
check(links.renderButtons(two,'en').inline_keyboard[0][0].text.includes('Matches'),'Broadcast buttons use same language as text');
links.validateBroadcastLanguages(two,[{language:'ru'},{language:'en'}]);
for(const body of [{message_ru:'Только русский',message_en:''},{message_ru:'',message_en:'English only'}]){
 let rejected=false;try{links.validateBroadcastLanguages(links.parseTemplate(links.panelBroadcastText(body)),[{language:'ru'},{language:'en'}])}catch{rejected=true}check(rejected,'Missing translation stops mixed broadcast before delivery');
}
let legacyBlocked=false;try{links.validateBroadcastLanguages(links.parseTemplate('Привет всем {matches}'),[{language:'en'}])}catch{legacyBlocked=true}check(legacyBlocked,'Legacy Russian-only broadcast cannot reach EN recipient');
const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:99,first_name:'Admin'})});
const secret=crypto.createHmac('sha256','WebAppData').update('test-token').digest();params.set('hash',crypto.createHmac('sha256',secret).update([...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
const adminInit=params.toString();
const preview=await request('post','/api/admin/broadcast-preview','99',{initData:adminInit,message_ru:'Привет {matches}',message_en:'Hello {matches}',lang:'en'});
check(preview.body.ok&&preview.body.text==='Hello'&&preview.body.buttons[0].includes('Matches'),'Panel preview renders EN body and EN buttons');
messages.length=0;const missing=await request('post','/api/admin/broadcast','99',{initData:adminInit,message_ru:'Привет',message_en:'',filters:{selected_ids:['1','2']}});
check(!missing.body.ok&&!messages.some(m=>m.method==='sendMessage'&&['1','2'].includes(String(m.args[0]))),'Panel refuses all delivery if one recipient language is missing');
put('crm','Broadcasts',[['broadcast_id','created_at','message_text','recipients_count','sent_count','failed_count','status','notes']]);put('crm','Broadcast Logs',[['broadcast_id','telegram_id','name','telegram_username','status','sent_at','error','language','segment_filter']]);
messages.length=0;const delivered=await request('post','/api/admin/broadcast','99',{initData:adminInit,message_ru:'Привет {matches}',message_en:'Hello {matches}',filters:{selected_ids:['1','2']}});
const settle=async()=>{for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));await (await load('broadcast.js')).whenBroadcastsIdle()};
check(delivered.body.ok&&delivered.body.queued&&delivered.body.recipients===2,'Panel broadcast is queued and answers at once');
await settle();
check(messages.some(m=>String(m.args[0])==='1'&&m.args[1]==='Hello')&&messages.some(m=>String(m.args[0])==='2'&&m.args[1]==='Привет'),'Recipients receive only selected text, not both variants');
{
 // --- устойчивая очередь рассылок -------------------------------------------
 const rowsOf=name=>{const t=tables.get('crm|'+name)||[];const h=t[0]||[];return t.slice(1).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]])))};
 const logs=rowsOf('Broadcast Logs'),summary=rowsOf('Broadcasts');
 check(logs.length===2&&logs.every(r=>r.status==='sent'),'Результаты рассылки записаны в журнал (пачкой)');
 check(summary.length===1&&summary[0].status==='sent'&&Number(summary[0].sent_count)===2&&Number(summary[0].recipients_count)===2,'Итоговая строка истории обновлена: 2 из 2');
 check(messages.some(m=>String(m.args[0])==='99'&&String(m.args[1]).includes('Рассылка принята'))&&messages.some(m=>String(m.args[0])==='99'&&String(m.args[1]).includes('Рассылка завершена')),'Организатор получает «принята» и итог в чат с ботом');
 check(!String((tables.get('crm|Settings')||[]).find(r=>r[0]==='broadcast_jobs')?.[1]||''),'После завершения очередь в Settings пуста');
 // Один игрок заблокировал бота — остальным доходит, причина в итоге.
 messages.length=0;telegramFailureId='2';
 await request('post','/api/admin/broadcast','99',{initData:adminInit,message_ru:'Привет',message_en:'Hello',filters:{selected_ids:['1','2']}});await settle();telegramFailureId='';
 const logs2=rowsOf('Broadcast Logs');
 check(messages.some(m=>String(m.args[0])==='1'&&m.args[1]==='Hello')&&logs2.some(r=>r.telegram_id==='2'&&r.status==='failed'&&/заблокирован/.test(r.error)),'Отказ одного получателя не останавливает остальных, причина понятна');
 check(messages.some(m=>String(m.args[0])==='99'&&String(m.args[1]).includes('Не доставлено: <b>1</b>')),'В итоге видно, скольким не дошло');
 // Временная ошибка (лимит Telegram) — повтор, а не «не доставлено».
 messages.length=0;telegramTransientId='1';transientLeft=2;
 await request('post','/api/admin/broadcast','99',{initData:adminInit,message_ru:'Привет',message_en:'Hello',filters:{selected_ids:['1']}});await settle();telegramTransientId='';
 check(rowsOf('Broadcast Logs').filter(r=>r.telegram_id==='1'&&r.status==='sent').length>=2&&messages.filter(m=>m.method==='sendMessage'&&String(m.args[0])==='1'&&m.args[1]==='Hello').length===1,'Лимит Telegram: сообщение повторено и доставлено, без ложного «не доставлено»');
 // Перезапуск: очередь из Settings продолжается с того же места.
 const bc=await load('broadcast.js');
 const saved={id:'resume_job',kind:'rating',params:{},contacts:[{telegram_id:'1',name:'Alice One',language:'en'},{telegram_id:'2',name:'Bob Two',language:'ru'}],next:1,sent:1,failed:0,failures:[],segment:'x',mediaType:'text',status:'running',createdAt:new Date().toISOString(),admin:{id:'99',name:'Admin',chatId:'99'},told:{}};
 const st=tables.get('crm|Settings');const idx=st.findIndex(r=>r[0]==='broadcast_jobs');const row=['broadcast_jobs',JSON.stringify([saved])];if(idx>=0)st[idx]=row;else st.push(row);
 messages.length=0;
 const resumed=await bc.resumeBroadcasts();check(resumed===1,'После перезапуска найдена незаконченная рассылка');await settle();
 check(!messages.some(m=>String(m.args[0])==='1'&&m.method==='sendMessage'&&m.args[1]!==undefined&&String(m.args[1]).includes('NTRP'))&&messages.some(m=>String(m.args[0])==='2'&&m.method==='sendMessage'),'Продолжение с места остановки: уже получившим повторно не шлём');
 // Автоочистка журналов: старое сверху удаляется, заголовок и последние строки — нет.
 const oldRow=i=>['b'+i,String(i),'N','u','sent','2026-01-01T10:00:00.000+07:00','','en','x'],newRow=i=>['c'+i,String(i),'N','u','sent','2026-09-28T10:00:00.000+07:00','','en','x'];
 const logHead=['broadcast_id','telegram_id','name','telegram_username','status','sent_at','error','language','segment_filter'];
 put('crm','Broadcast Logs',[logHead,...Array.from({length:70},(_,i)=>oldRow(i)),...Array.from({length:60},(_,i)=>newRow(i))]);
 sheetEdits.length=0;
 const cut=Date.parse('2026-08-01T00:00:00Z');
 check(await sheets.deleteOldRows('Broadcast Logs','sent_at',cut,{keepAtLeast:50})===70,'Автоочистка удаляет только старые строки');
 const del=sheetEdits.find(r=>r.deleteDimension)?.deleteDimension?.range;
 check(del&&del.startIndex===1&&del.endIndex===71,'Удаляется один блок сразу под заголовком (строки 2–71), заголовок остаётся');
 put('crm','Broadcast Logs',[logHead,...Array.from({length:60},(_,i)=>oldRow(i))]);sheetEdits.length=0;
 check(await sheets.deleteOldRows('Broadcast Logs','sent_at',cut,{keepAtLeast:50})===10&&sheetEdits.some(r=>r.deleteDimension),'Последние 50 строк журнала не удаляются, даже если все старые');
 put('crm','Broadcast Logs',[logHead,oldRow(1),['x','1','N','u','sent','','','en','x'],...Array.from({length:80},(_,i)=>oldRow(i+5))]);sheetEdits.length=0;
 check(await sheets.deleteOldRows('Broadcast Logs','sent_at',cut,{keepAtLeast:50})===1,'Строка без даты останавливает очистку — лишнего не удаляем');
 put('crm','Broadcast Logs',[logHead]);
 const bsrc=await fs.readFile(path.join(root,'broadcast.js'),'utf8');
 check(/catch \(e\) \{ console\.error\('broadcast: журнал не записан, повторим позже/.test(bsrc)&&/catch \(e\) \{ console\.error\('broadcast: не удалось сохранить прогресс/.test(bsrc),'Ошибка записи в таблицу (лимит Google) не обрывает рассылку');
 check(/inQuiet\(win\)/.test(bsrc)&&/тихие часы|Тихие часы/i.test(bsrc),'Ночью рассылка на паузе и предупреждает организатора');
 const ad=await fs.readFile(path.join(root,'admin.js'),'utf8'),ap=await fs.readFile(path.join(root,'adminPanel.js'),'utf8'),ix=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(!/for \(const c of contacts\)/.test(ad.slice(ad.indexOf('export async function executeBroadcast')))&&!/logBroadcastResult\(/.test(ap),'Цикл отправки по получателям больше не живёт внутри запроса');
 check(/resumeBroadcasts\(\)/.test(ix)&&/process\.on\?\.\('SIGTERM'/.test(ix)&&/startLogCleanup\(\)/.test(ix),'Сервер продолжает очередь на старте, сохраняет прогресс при деплое и чистит журналы');
}
messages.length=0;
messages.length=0;await flow.reviewTopup({telegramId:'1',approve:false});check(messages.some(m=>String(m.args[0])==='1'&&m.args[1].includes('Top-up not confirmed')),'Top-up rejection follows player language');
const futureEvent={...event,date:'16.09.2099',title_ru:'Турнир',title_en:'Tournament',audience:'all'};
put('crm','Event_Registry',[ev.REGISTRY_HEADERS,ev.REGISTRY_HEADERS.map(h=>futureEvent[h]||'')]);
put('crm','Event_Signups',[['signup_id','event_id','telegram_id','status','amount_thb'],['en-event','past','1','confirmed',0],['ru-event','past','2','confirmed',0]]);
messages.length=0;await flow.runEventReminders(started);
check(messages.some(m=>String(m.args[0])==='1'&&m.args[1].includes('Tomorrow')&&!/[а-яё]/i.test(m.args[1])),'Scheduled event reminder uses EN body');
check(messages.some(m=>String(m.args[0])==='2'&&m.args[1].includes('Завтра')),'Scheduled event reminder uses RU body');
messages.length=0;await flow.notifyEventChanged(futureEvent,['Время: 09:00 → 10:00']);check(messages.some(m=>String(m.args[0])==='1'&&m.args[1].includes('Time:')&&!/[а-яё]/i.test(m.args[1])),'Event change translates field labels and title');
messages.length=0;await flow.reviewEventProof({signupId:'en-event',approve:true});check(messages.some(m=>String(m.args[0])==='1'&&m.args[1].includes('Payment for')&&!/[а-яё]/i.test(m.args[1])),'Event payment approval uses recipient language');
const matchHtml=await fs.readFile(path.join(root,'public/match.html'),'utf8');
check(matchHtml.includes('function renderAdmin()')&&matchHtml.includes("'/api/match/admin-active"),'Match miniapp includes protected admin list UI');
check(matchHtml.includes("esc(opp.name||X.waiting)")&&matchHtml.includes('function requestActions'),'Schedule displays named opponents with contact and cancel actions');
// The League bootstrap must not leak Fantasy data around the dedicated API gate.
put('1CZ2-B09kIxegOK1lYVl0KBucjbxxp1ZukMD0t1QQCiY','Frontend_Profile_All',[['player_id','player_name'],['1','Alice One']]);
await sheets.setSetting('FANTASY_MODE','LIVE');
for(const id of ['6','99']){
 const result=await request('get','/api/league/bootstrap',id);
 check(result.code===403||(result.body?.fantasy===null&&!result.body.tabs.includes('fantasy')),'League hides Fantasy for nonmember '+id);
}
await sheets.setSetting('FANTASY_MODE','TEST');
await sheets.setSetting('FANTASY_TEST_GROUP','');
const noTest=await request('get','/api/league/bootstrap','1');
check(noTest.body?.fantasy===null&&!noTest.body.tabs.includes('fantasy'),'League hides Fantasy from non-testers');
// Скорость: Fantasy в первый ответ не кладётся, приложение рисуется сразу, а
// очки догружаются вторым запросом. Доступ при этом решается как раньше.
{
 await sheets.setSetting('FANTASY_MODE','LIVE');
 const fast=await request('get','/api/league/bootstrap','1');
 check(fast.body?.fantasy===null&&fast.body?.fantasy_deferred===true,'Fantasy is deferred out of the first league payload');
 check(fast.body?.fantasy_allowed===true,'Deferred Fantasy still reports access in the first payload');
 const full=await request('get','/api/league/bootstrap','1',{with_fantasy:'1'});
 check(full.body?.fantasy&&full.body?.fantasy_deferred===false,'Asking for Fantasy explicitly returns it in one request');
 const leagueHtml=await fs.readFile(path.join(root,'public/league.html'),'utf8');
 check(leagueHtml.includes('loadFantasyLater')&&leagueHtml.includes('fantasy_deferred'),'Мини-приложение догружает Fantasy после первой отрисовки');
 await sheets.setSetting('FANTASY_MODE','TEST');
}
// Опросы и рассылка по рейтингу удалены целиком — ни команд, ни обработчиков.
{
 const botSource=await fs.readFile(path.join(root,'bot.js'),'utf8');
 const adminSource=await fs.readFile(path.join(root,'admin.js'),'utf8');
 const tgSource=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(!/poll/i.test(botSource)&&!/poll/i.test(adminSource),'Опросы убраны из бота и админки');
 check(!botSource.includes('/rating_broadcast')&&!botSource.includes('startMissingRatingBroadcast'),'Рассылка по рейтингу убрана');
 check(!tgSource.includes("cmd:'overview'")&&tgSource.includes("cmd:'matches'"),'Осталась одна команда матчей вместо двух');
 check(tgSource.includes('help_en'),'У команд есть английские описания для двуязычного /help');
 check(botSource.includes('adminHelpText(l)')&&botSource.includes('ADMIN_HELP_ICON'),'Админский /help двуязычный и с эмодзи по разделам');
 // «<id сообщения>» без экранирования Telegram считает HTML-тегом и молча съедает.
 check(botSource.includes('escapeHtml(args)'),'Подсказка по аргументам в /help экранируется');
 const { ADMIN_COMMAND_LIST } = await load('telegram.js');
 const noEnglish = ADMIN_COMMAND_LIST.filter(c => !c.help_en && !c.short_en).map(c => c.cmd);
 check(!noEnglish.length,'У каждой админской команды есть английское описание: '+noEnglish.join(', '));
 const badArgs = ADMIN_COMMAND_LIST.filter(c => c.args && !c.args_en && /[а-яё]/i.test(c.args)).map(c => c.cmd);
 check(!badArgs.length,'Русские подсказки аргументов переведены: '+badArgs.join(', '));
}
// --- словарь статусов -------------------------------------------------------
// Статусы решают, кого пускать в лигу и кому уходят рассылки, поэтому словарь
// закрываем тестами: старые значения из таблицы должны читаться как раньше.
check(sheets.canonicalStatus('lead')===''&&sheets.canonicalStatus('')==='','Новичок и старый lead читаются как пустой статус');
check(sheets.canonicalStatus(' Active ')==='active'&&sheets.canonicalStatus('WAITLIST')==='waitlist','Статус не зависит от регистра и пробелов');
check(sheets.canonicalStatus('waiting_payment')==='payment'&&sheets.canonicalStatus('proof_received')==='payment','Оба платёжных статуса сводятся к payment');
check(['rejected','declined','banned','blocked','left','unsubscribed','refunded'].every(v=>sheets.isInactiveStatus(v)),'Все отказные статусы сведены к одному выключателю');
check(sheets.canonicalStatus('confirmed')==='active'&&sheets.canonicalStatus('payment_approved')==='active','Подтверждённые и оплаченные читаются как активные');
check(!sheets.isProfileCompleted({telegram_id:'1',name:'A',gender:'male',country_of_origin:'TH',experience:'5',whatsapp:'+1',ntrp:'3.5',status:'rejected'}),'Отклонённый больше не проходит в мини-приложение лиги');
check(sheets.isProfileCompleted({telegram_id:'1',name:'A',gender:'male',country_of_origin:'TH',experience:'5',whatsapp:'+1',ntrp:'3.5',status:'waitlist'}),'Игрок из листа ожидания по-прежнему проходит');
// «Лига» не должна теряться, даже если в настройках группы её забыли.
await sheets.setSetting('btns_applied','events,contact');
check((await sheets.getGroupButtons('applied')).includes('league'),'Кнопка лиги добавляется в меню группы, даже если её нет в настройках');
await sheets.setSetting('kb_applied','pay,contact');
check((await sheets.getGroupKeyboard('applied')).includes('league'),'Кнопка лиги добавляется и в нижнюю клавиатуру');
await sheets.setSetting('btns_applied','none');
check((await sheets.getGroupButtons('applied')).length===0,'Слово none по-прежнему выключает все кнопки группы');
await sheets.setSetting('btns_applied','');
await sheets.setSetting('kb_applied','');

// Статусы событий: витрина новичка показывает всё, заявку принимаем не везде.
check(sheets.canonicalEventStatus('open')==='open'&&sheets.canonicalEventStatus('registration_open')==='open','Открытый набор читается одинаково при любом написании');
check(sheets.canonicalEventStatus('Live')==='live'&&sheets.canonicalEventStatus('active')==='live','Идущий сезон (active) читается как live: играем, набор закрыт');
check(sheets.canonicalEventStatus('next_season')==='waitlist'&&sheets.canonicalEventStatus('лист ожидания')==='waitlist','Набор в следующий сезон читается как лист ожидания');
check(sheets.canonicalEventStatus('finished')==='archived'&&sheets.canonicalEventStatus('что-то своё')==='archived','Завершённое и незнакомое читаются как архив');
check(sheets.eventJoinable('open')&&sheets.eventJoinable('waitlist')&&!sheets.eventJoinable('live')&&!sheets.eventJoinable('closed'),'Заявку принимаем только в открытый набор и в лист ожидания');
// Новичку без анкеты интерфейс лиги отвечает кодом, а не общей ошибкой:
// по коду он показывает приглашение заполнить анкету.
// Без анкеты интерфейс лиги больше не блокируется: человек видит всё открытое,
// сверху — кнопка анкеты. Fantasy и личное закрыты.
const invite = await request('get','/api/league/bootstrap','777');
check(invite.code===200&&invite.body.guest===true&&invite.body.needs_profile===true&&!invite.body.tabs.includes('fantasy')&&invite.body.fantasy===null,'Без анкеты лига открыта гостем: кнопка анкеты, без Fantasy');
check((await request('get','/api/league/wallet','777')).code===403,'Личное (касса) без анкеты по-прежнему закрыто');

// --- Сайт лиги: гость без входа, вход через Telegram, кука, защита -----------
{
 const web=await load('webauth.js');
 const bare=async(method,p,{query={},body={},headers={}}={})=>{
  const route=routes.find(r=>r.method===method&&r.p===p);assert.ok(route,'route '+p);
  const req={body:{...body},query:{...query},path:p,method:method.toUpperCase(),headers,secure:true};
  const res={code:200,headers:{},cookies:[],status(n){this.code=n;return this},json(v){this.body=v;return this},set(){return this},send(v){this.body=v;return this},
   append(k,v){if(k==='Set-Cookie')this.cookies.push(v);return this},redirect(c,u){this.code=c;this.location=u;return this},sendFile(f){this.file=f;return this},type(){return this}};
  await web.webSessionMiddleware(req,res,()=>{});
  const langMiddleware=middleware.find(x=>x[0]==='/api')[1];if(p.startsWith('/api/'))await langMiddleware(req,res,()=>{});
  await route.h(req,res);return {req,res};
 };
 const anon=(await bare('get','/api/league/bootstrap',{query:{lang:'ru'}})).res;
 check(anon.code===200&&anon.body.anonymous===true&&anon.body.user===null&&anon.body.lang==='ru','Сайт без входа: лига открыта гостю, язык из браузера');
 check(!anon.body.tabs.includes('fantasy')&&anon.body.fantasy===null,'Гостю сайта Fantasy не отдаётся');
 check((await bare('get','/api/league/division',{query:{letter:'C',season:'2'}})).res.code===200,'Гость сайта видит таблицу дивизиона');
 check((await bare('get','/api/league/wallet')).res.code===400,'Гость сайта не видит личное');
 check((await bare('get','/api/fantasy/bootstrap')).res.code!==200,'Гость сайта не попадает в Fantasy');
 const sched=(await bare('get','/api/league/schedule')).res;
 check(sched.code===200&&(sched.body.items||[]).every(i=>!i.p1.id&&!i.p2.id),'Гостю в расписании не отдаются Telegram ID игроков');
 const homePage=(await bare('get','/')).res;
 check(/id="viewHome"/.test(homePage.body)&&/<title>Phuket Tennis Family — Amateur Tennis League in Phuket<\/title>/.test(homePage.body),'Главная сайта — интерфейс лиги с поисковым заголовком');

 // Подпись Telegram Login считается ровно как в документации Telegram.
 const signLogin=fields=>{
  const check=Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('\n');
  const secret=crypto.createHash('sha256').update('test-token').digest();
  return {...fields,hash:crypto.createHmac('sha256',secret).update(check).digest('hex')};
 };
 const now=Math.floor(Date.now()/1000);
 const good=signLogin({id:'555001',first_name:'Web',last_name:'Visitor',username:'webvisitor',auth_date:String(now)});
 check(web.verifyTelegramLogin(good).ok,'Верная подпись Telegram Login принимается');
 check(!web.verifyTelegramLogin({...good,id:'555002'}).ok,'Подменённый id не проходит проверку');
 check(!web.verifyTelegramLogin(signLogin({id:'555001',auth_date:String(now-3*86400)})).ok,'Старая ссылка входа (старше суток) не принимается');
 check(web.safeNext('//evil.com')==='/'&&web.safeNext('https://evil.com')==='/'&&web.safeNext('/league?tab=div')==='/league?tab=div','После входа возвращаем только на свои страницы');

 const bad=(await bare('get','/auth/telegram',{query:{...good,id:'1'}})).res;
 check(bad.code===302&&/login=failed/.test(bad.location)&&!bad.cookies.length,'Неверный вход: без куки и с пометкой об ошибке');
 const adminChatWas=await sheets.getSetting('admin_chat_id');await sheets.setSetting('admin_chat_id','-100777');
 const login=(await bare('get','/auth/telegram',{query:{...good,next:'/?tab=div'}})).res;
 check(login.code===302&&login.location==='/?tab=div'&&/ptf_web=/.test(login.cookies[0])&&/HttpOnly/.test(login.cookies[0])&&/SameSite=Lax/.test(login.cookies[0])&&/Secure/.test(login.cookies[0]),'Вход через Telegram ставит защищённую куку и возвращает на ту же страницу');
 await settle();
 const lead=(tables.get('crm|Applicants')||[]);const hdr=lead[0];
 const row=lead.find(r=>String(r[hdr.indexOf('telegram_id')])==='555001');
 check(Boolean(row),'Вошедший с сайта сразу появляется в Players list лидом');
 check(messages.some(m=>/Новый лид/.test(JSON.stringify(m.args))&&/вошёл на сайт/.test(JSON.stringify(m.args))),'В админ-чат приходит карточка нового пользователя с сайта');

 await sheets.setSetting('admin_chat_id',adminChatWas||'');
 const cookie=login.cookies[0].split(';')[0];
 const me=(await bare('get','/api/league/bootstrap',{headers:{cookie}})).res;
 check(me.code===200&&me.body.anonymous===false&&String(me.body.user?.id)==='555001'&&me.body.needs_profile===true,'С кукой сайт узнаёт человека; без анкеты — кнопка анкеты');
 const member=(await bare('get','/api/league/bootstrap',{headers:{cookie:'ptf_web='+encodeURIComponent(util.signWebAppToken('1'))}})).res;
 check(member.code===200&&!member.body.guest&&String(member.body.user?.id)==='1','Игрок лиги на сайте получает свой полный вид');
 const forged=(await bare('get','/api/league/bootstrap',{headers:{cookie:'ptf_web=1.9999999999999.abc'}})).res;
 check(forged.body.anonymous===true,'Поддельная кука не даёт входа');
 const crossSite=(await bare('post','/api/league/event-join',{body:{event_id:'x'},headers:{cookie:'ptf_web='+encodeURIComponent(util.signWebAppToken('1')),origin:'https://evil.test',host:'app.test'}})).req;
 check(!crossSite.body.t,'Запрос с чужого сайта кукой не авторизуется');
 const sameSite=(await bare('post','/api/league/event-join',{body:{event_id:'x'},headers:{cookie:'ptf_web='+encodeURIComponent(util.signWebAppToken('1')),origin:'https://app.test',host:'app.test'}})).req;
 check(Boolean(sameSite.body.t),'Запрос со своей страницы кукой авторизуется');
 const out=(await bare('get','/auth/logout')).res;
 check(out.code===302&&/Max-Age=0/.test(out.cookies[0]),'Выход стирает куку');
 {
  const wwwHop=middleware.find(x=>typeof x[0]==='function'&&/www/.test(String(x[0])))[0];
  let moved=null,passed=false;
  wwwHop({headers:{host:'www.phukettennis.com'},method:'GET',originalUrl:'/?tab=div'},{redirect(c,u){moved=[c,u]}},()=>{passed=true});
  check(moved&&moved[0]===301&&moved[1]==='https://phukettennis.com/?tab=div','Адрес с www перекидывается на основной домен с тем же путём');
  passed=false;wwwHop({headers:{host:'phukettennis.com'},method:'GET',originalUrl:'/'},{redirect(){}},()=>{passed=true});
  check(passed,'Основной домен открывается без перенаправления');
 }
 // Лендинг, ссылки «поделиться» и общее меню.
 const aboutPage=(await bare('get','/about')).res;
 check(/<title>About the league — Phuket Tennis Family<\/title>/.test(aboutPage.body)&&/"@type":"FAQPage"/.test(aboutPage.body),'Страница «О лиге» открывается по /about и отдаёт вопросы-ответы для Google');
 const dreq=await (async()=>{const route=routes.find(r=>r.p==='/d/:letter');const res={set(){return this},type(){return this},send(v){this.body=v;return this}};await route.h({params:{letter:'c'},headers:{}},res);return res})();
 check(/<title>Division C — standings · Phuket Tennis Family<\/title>/.test(dreq.body)&&/og:url" content="https:\/\/phukettennis.com\/d\/C"/.test(dreq.body),'Ссылка на дивизион отдаёт свой заголовок и адрес для превью');
 const preq=await (async()=>{const route=routes.find(r=>r.p==='/p/:slug');const res={set(){return this},type(){return this},send(v){this.body=v;return this}};await route.h({params:{slug:'alice-one'},headers:{}},res);return res})();
 check(/<title>Alice One — Phuket Tennis Family<\/title>/.test(preq.body)&&/og:url" content="https:\/\/phukettennis.com\/p\/alice-one"/.test(preq.body),'Ссылка на игрока отдаёт имя и адрес для превью');
 // SEO: canonical, русская версия, разметка, серверный текст, robots и карта сайта.
 check(/rel="canonical" href="https:\/\/phukettennis.com\/p\/alice-one"/.test(preq.body)&&/hreflang="ru"/.test(preq.body)&&/"@type":"ProfilePage"/.test(preq.body)&&/id="ssr"/.test(preq.body)&&/<h1>Alice One<\/h1>/.test(preq.body),'Страница игрока: главный адрес, русская версия, разметка профиля и текст для поисковика');
 check(/"@type":"SportsOrganization"/.test(homePage.body)&&/"@type":"WebSite"/.test(homePage.body)&&/href="\/p\/alice-one"/.test(homePage.body),'Главная: разметка организации и сайта, ссылки на игроков прямо в HTML');
 const nobody=await (async()=>{const route=routes.find(r=>r.p==='/p/:slug');const res={set(){return this},type(){return this},send(v){this.body=v;return this}};await route.h({params:{slug:'no-such-player'},headers:{}},res);return res})();
 check(/name="robots" content="noindex"/.test(nobody.body),'Несуществующий игрок не попадает в поиск');
 const ruPage=(await bare('get','/race',{query:{lang:'ru'}})).res;
 check(/<html lang="ru"/.test(ruPage.body)&&/<title>Годовая гонка — Phuket Tennis Family<\/title>/.test(ruPage.body)&&/rel="canonical" href="https:\/\/phukettennis.com\/race\?lang=ru"/.test(ruPage.body),'Русская версия страницы: свой язык, заголовок и адрес');
 const robotsSite=(await bare('get','/robots.txt',{headers:{host:'phukettennis.com'}})).res.body;
 const robotsOther=(await bare('get','/robots.txt',{headers:{host:'app.test'}})).res.body;
 check(/Sitemap: https:\/\/phukettennis.com\/sitemap.xml/.test(robotsSite)&&/Disallow: \/api\//.test(robotsSite)&&/Disallow: \/$/m.test(robotsOther),'robots.txt: сайт открыт для поиска, служебный адрес Railway — закрыт');
 const sm=(await bare('get','/sitemap.xml')).res.body;
 check(/<loc>https:\/\/phukettennis.com\/<\/loc>/.test(sm)&&/<loc>https:\/\/phukettennis.com\/p\/alice-one<\/loc>/.test(sm)&&/<loc>https:\/\/phukettennis.com\/about<\/loc>/.test(sm),'Карта сайта: главная, лендинг и страницы игроков');
 check(routes.some(r=>r.p==='/tournament-admin')&&routes.some(r=>r.p==='/tournaments'),'Турнирная админка переехала на /tournament-admin, /tournaments — публичная вкладка');
 check(JSON.parse((await bare('get','/site.webmanifest')).res.body).icons.length===2,'Есть манифест сайта с иконками');
 const navAnon=(await bare('get','/api/league/nav')).res;
 check(navAnon.code===200&&navAnon.body.anonymous===true&&!navAnon.body.tabs.includes('fantasy')&&navAnon.body.can_match===false,'Меню для гостя: без Fantasy и без «Моих матчей»');
 const navAdmin=(await bare('get','/api/league/nav',{headers:{cookie:'ptf_web='+encodeURIComponent(util.signWebAppToken('99'))}})).res;
 check(navAdmin.body.is_admin===true&&navAdmin.body.tabs.length>=7,'Меню для организатора — полный набор вкладок');
 const mh=await fs.readFile(path.join(root,'public/match.html'),'utf8');
 check(!/--accBg:var\(--accBg\)/.test(mh)&&/--accBg:rgba\(232,164,92/.test(mh),'В «Моих матчах» тёмная тема снова подсвечивает выбранное');
 check(/tg\.platform==='unknown'/.test(mh)&&mh.includes('ptf-nav.js')&&mh.includes("id=\"mnav\""),'«Мои матчи» работают в браузере и показывают общее меню сайта');
 const ab=await fs.readFile(path.join(root,'public/about.html'),'utf8');
 check(ab.includes('/?join=1')&&ab.includes('Вступить в лигу')&&ab.includes('Join the league'),'Лендинг ведёт ко входу и есть на двух языках');
 // Живая часть: галерея и Instagram не роняют страницу без подключений;
 // сезоны отдают счётчики сыгранного; «Турниры» один раз добавляются группам.
 check((await bare('get','/api/public/gallery')).res.body?.ok===true,'Галерея отвечает, даже если Диск недоступен');
 const igRes=(await bare('get','/api/public/instagram')).res;
 check(igRes.body?.ok===true&&Array.isArray(igRes.body.posts),'Лента Instagram отвечает, даже если Instagram не подключён');
 const ps=(await bare('get','/api/public/seasons')).res;
 check(ps.body?.ok&&(ps.body.seasons||[]).every(x=>'matches_played' in x&&'players_played' in x),'У сезонов есть счётчики: сколько игроков сыграло и сколько матчей');
 await sheets.setSetting('tabs_guest','home,div,race,players,matches,events');
 await sheets.setSetting('tabs_added_tournaments','');
 check(await sheets.addNewTabOnce('tournaments')&&(await sheets.getSetting('tabs_guest'))==='home,div,race,players,matches,events,tournaments','Вкладка «Турниры» встаёт после «Событий» у групп с сохранённым меню');
 check(!(await sheets.addNewTabOnce('tournaments')),'Вкладка добавляется один раз — дальше меню правит организатор');
 await sheets.setSetting('tabs_guest','');
 const lg2=await fs.readFile(path.join(root,'public/league.html'),'utf8');
 check(lg2.includes('function evStatusOf(')&&lg2.includes('evc-past')&&lg2.includes('function renderTournaments(')&&lg2.includes('function galleryBlock('),'События — карточками со статусами, есть вкладка «Турниры» и галерея');
 check(lg2.includes('function introLang(')&&lg2.includes('Любительская теннисная лига Пхукета')&&lg2.includes('class="go2" href="/about"'),'В окне-знакомстве выбор языка, «любительская лига» и заметная «Подробнее о лиге»');
 const lh=await fs.readFile(path.join(root,'public/league.html'),'utf8');
 check(lh.includes('function maybeIntro()')&&lh.includes('ptf_intro_seen')&&lh.includes('ptf-nav.js')&&lh.includes('function shareLink('),'На сайте: окно-знакомство для новых, значки меню, кнопки «поделиться»');
 check(lh.includes('telegram-widget.js')&&lh.includes("data-request-access','write'")&&lh.includes('?start=profile'),'На сайте кнопка Telegram Login с правом писать и переход в бот на анкету');
 const botSrc=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/param === 'profile'/.test(botSrc)&&/🌐 <b>Сайт лиги<\/b>/.test(botSrc),'Бот понимает переход с сайта на анкету; сайт описан в админском /help');
}
const leagueHtml = await fs.readFile(path.join(root,'public/league.html'),'utf8');
check(leagueHtml.includes('function renderInvite()')&&!/renderInvite[\s\S]{0,1200}Fantasy/.test(leagueHtml.split('function renderInvite()')[1]?.slice(0,1200)||''),'Экран приглашения есть и не рассказывает про Fantasy');
const applyHtml = await fs.readFile(path.join(root,'public/apply.html'),'utf8');
check(applyHtml.includes('function renderIntro()')&&applyHtml.includes('introEvents'),'Стартовый экран анкеты показывает витрину событий');

check(applyHtml.includes("id=\"instagram\"")&&applyHtml.includes('instagramHint')&&!/instagram[\s\S]{0,80}missing\.push/.test(applyHtml),'Instagram есть в анкете и остаётся необязательным');
check(applyHtml.includes('function fillProfile(')&&applyHtml.includes("set('instagram'"),'Анкета подставляет сохранённые данные, включая Instagram');
check(applyHtml.includes('loadSeasonInfo')&&applyHtml.includes('/api/public/seasons'),'Стартовый экран подтягивает цифры сезонов');
check(applyHtml.includes('fillAgeOptions')&&applyHtml.includes('COUNTRIES_RU')&&applyHtml.includes('countryList'),'Возраст выбирается списком, страна — списком с вводом');
check(applyHtml.includes('nameHint')&&applyHtml.includes('experienceHint'),'У имени и опыта есть поясняющие подписи');
check(applyHtml.includes('function finalCard(')&&applyHtml.includes('toggleRoster'),'Прошедший сезон показывает финалы, а число игроков раскрывает состав');
check(leagueHtml.includes('inviteHeroHtml')&&leagueHtml.includes('toggleInvitePlayers')&&leagueHtml.includes('function inviteFinal('),'Экран приглашения: чемпионы сверху, финалы в карточке, состав по клику');
check(leagueHtml.includes('inviteEventsHtml')&&!leagueHtml.includes('ivPast\">'),'Прошлые сезоны на экране приглашения показаны развёрнутыми');
const pub = await request('get','/api/public/seasons','777');
check(pub.code===200&&Array.isArray(pub.body?.seasons),'Витрина сезонов открыта без анкеты');

check(applyHtml.includes('fillAgeOptions')&&applyHtml.includes('<select id="age"')&&applyHtml.includes('countryList'),'Возраст выбирается списком, страна — с подсказками ввода');
check(applyHtml.includes('nameHint')&&applyHtml.includes('experienceHint'),'У имени и опыта есть поясняющие подписи');
check(leagueHtml.includes('inviteHeroHtml')&&leagueHtml.includes('toggleInvitePlayers')&&leagueHtml.includes('inviteFinal'),'Приглашение: чемпионы сверху, состав раскрывается, финалы показаны сразу');

check(applyHtml.includes("id=\"startBtn2\"")&&applyHtml.indexOf("id=\"startBtn\"")<applyHtml.indexOf('id="introEvents"'),'Кнопка продолжения стоит над витриной событий');
check(applyHtml.includes("openParticipantsPage(ev)")&&applyHtml.includes("'&season='"),'Список участников открывается для сезона своего события');
const partsHtml = await fs.readFile(path.join(root,'public/participants.html'),'utf8');
check(partsHtml.includes("season=")&&partsHtml.includes('data.season'),'Страница состава читает вкладку своего сезона и объясняет пустой список');

// Каждый импорт между файлами проекта должен иметь свой экспорт. Проверка
// появилась после падения на деплое: results.js звал новую функцию из
// division.js, а в архив попали не все файлы — бот не поднялся с SyntaxError.
// Ловим это здесь, а не на Railway.
{
 const jsFiles=(await fs.readdir(root)).filter(f=>f.endsWith('.js')&&!f.includes('.test.'));
 const exportsOf=src=>{
  const out=new Set();
  for(const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g))out.add(m[1]);
  for(const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g))out.add(m[1]);
  for(const m of src.matchAll(/export\s*\{([^}]+)\}/g))
   for(const part of m[1].split(','))
    {const n=part.trim().split(/\s+as\s+/).pop().trim();if(n)out.add(n)}
  return out;
 };
 const cache=new Map();
 const exportsFor=async file=>{
  if(!cache.has(file))cache.set(file,exportsOf(await fs.readFile(path.join(root,file),'utf8')));
  return cache.get(file);
 };
 const broken=[];
 for(const file of jsFiles){
  const src=await fs.readFile(path.join(root,file),'utf8');
  const uses=[...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)]
   // Динамический импорт считаем только «чистый»: с .then() модуль могут
   // домешать из другого файла, и такая строка не про этот модуль.
   .concat([...src.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*'(\.\/[^']+)'\s*\)(?!\s*\n?\s*\.then)/g)]);
  for(const use of uses){
   const target=use[2].replace('./','');
   if(!jsFiles.includes(target))continue;
   const have=await exportsFor(target);
   for(const raw of use[1].split(',')){
    const name=raw.trim().split(/\s+as\s+/)[0].trim();
    if(name&&!have.has(name))broken.push(`${file} → ${target}: нет экспорта «${name}»`);
   }
  }
 }
 check(!broken.length,'Каждый импорт находит свой экспорт:\n'+broken.join('\n'));
}


// --- Турниры: группы, сетка, снятия, замены, парная запись ------------------
{
 const trn=await load('tournaments.js');

 // Круговая система: каждая пара встречается ровно один раз, туры ровные.
 const rr=trn.roundRobinPairs(['a','b','c','d','e']);
 const seen=new Set();
 for(const round of rr)for(const [x,y] of round)seen.add([x,y].sort().join('-'));
 check(seen.size===10,'Круговая система: 5 игроков дают 10 уникальных пар');
 check(rr.every(round=>new Set(round.flat()).size===round.flat().length),'В одном туре игрок встречается один раз');
 check(trn.roundRobinPairs(['a']).length===0,'Один участник — матчей нет');

 // Змейка разводит сильных по разным группам.
 check(JSON.stringify(trn.snakeDistribute([1,2,3,4,5,6],2))==='[[1,4,5],[2,3,6]]','Змейка раскладывает 1-2 / 3-4 наоборот');
 check(trn.snakeDistribute([1,2,3],1).length===1,'Одна группа принимает всех');

 check(JSON.stringify(trn.parseScore('6:4 7:6 (7:4)'))==='[{"a":6,"b":4},{"a":7,"b":6}]','Тай-брейк в скобках не считается сетом');
 check(trn.parseScore('W/O').length===0,'W/O не даёт сетов');

 // Полный проход по турниру на мок-таблицах.
 const admin={id:'99',name:'Admin'};
 const t=await trn.createTournament({name:'Тестовый турнир',kind:'singles',playoff_type:'cross_1_4',third_place:'yes'},admin,false);
 check(t.tournament_id.startsWith('trn_'),'Турнир создан');
 check((await trn.listTournaments(false)).length===1,'Турнир виден в списке');

 const names=['P1','P2','P3','P4'];
 const made=[];
 for(let i=0;i<names.length;i++){
  made.push(await trn.addEntry(t.tournament_id,{player_id:String(100+i),player_name:names[i],display_name:names[i],status:'accepted',group:'A',seed:String(i+1)},admin,false));
 }
 check((await trn.listEntries(t.tournament_id,false,false)).length===4,'Четыре заявки записаны');
 const twin=await trn.addEntry(t.tournament_id,{player_id:'100',player_name:'P1'},admin,false);
 check(twin.entry_id===made[0].entry_id,'Повторная заявка того же игрока не плодит дубль');

 const stage=await trn.createStage(t.tournament_id,{kind:'group',name:'Группы'},admin,false);
 const gm=await trn.generateGroupMatches(t.tournament_id,stage.stage_id,admin,false);
 check(gm.length===6,'Расписание группы из четырёх: шесть матчей');

 // Вносим счёт так, чтобы порядок был предсказуемым: P1 > P2 > P3 > P4.
 const rank={};made.forEach((e,i)=>rank[e.entry_id]=i);
 for(const m of await trn.listMatches(t.tournament_id,false,false)){
  const winner=rank[m.entry_a]<rank[m.entry_b]?m.entry_a:m.entry_b;
  await trn.setMatchResult(m.match_id,{status:'completed',score:'6:1 6:1',winner_entry:winner},admin,false);
 }
 let state=await trn.tournamentState(t.tournament_id,false);
 check(state.standings.map(x=>x.name).join()==='P1,P2,P3,P4','Таблица считается из матчей в верном порядке');
 check(state.standings[0].points===9&&state.standings[3].points===3,'Очки: 3 за победу, 1 за поражение');

 const po=await trn.generatePlayoff(t.tournament_id,{},admin,false);
 const semis=po.matches.filter(m=>Number(m.round)===1);
 check(semis.length===2,'Плей-офф: два полуфинала');
 check(semis[0].entry_a_name==='P1'&&semis[0].entry_b_name==='P4','Первый полуфинал 1-4');
 check(semis[1].entry_a_name==='P2'&&semis[1].entry_b_name==='P3','Второй полуфинал 2-3');
 check(po.matches.some(m=>m.round_label==='Финал'),'Финал создан');
 check(po.matches.some(m=>m.round_label==='Матч за 3-е место'),'Матч за третье место создан');

 // Победитель полуфинала сам встаёт в финал.
 await trn.setMatchResult(semis[0].match_id,{status:'completed',score:'6:2 6:2',winner_entry:semis[0].entry_a},admin,false);
 await trn.setMatchResult(semis[1].match_id,{status:'completed',score:'7:5 6:4',winner_entry:semis[1].entry_b},admin,false);
 let all=await trn.listMatches(t.tournament_id,false,false);
 const final=all.find(m=>m.round_label==='Финал');
 check(final.entry_a_name==='P1'&&final.entry_b_name==='P3','Победители полуфиналов подставились в финал');
 const third=all.find(m=>m.round_label==='Матч за 3-е место');
 check(third.entry_a_name==='P4'&&third.entry_b_name==='P2','Проигравшие полуфиналов подставились в матч за третье место');

 // Исправление счёта переписывает и таблицу, и подстановку в финал.
 await trn.setMatchResult(semis[1].match_id,{status:'completed',score:'6:7 4:6',winner_entry:semis[1].entry_a},admin,false);
 const log=await trn.readLog(t.tournament_id,false);
 check(log.some(r=>r.action==='result_corrected'),'Исправление счёта попадает в журнал отдельным действием');

 // Победитель определяется по счёту, если его не указали явно.
 const extra=await trn.createManualTournamentMatch(t.tournament_id,{entry_a:made[0].entry_id,entry_b:made[3].entry_id,round_label:'Кросс-групповой'},admin,false);
 const auto=await trn.setMatchResult(extra.match_id,{status:'completed',score:'6:3 4:6 10:8'},admin,false);
 check(auto.winner_entry===made[0].entry_id,'Победитель выведен из счёта без явного указания');
 let failed='';
 try{await trn.setMatchResult(extra.match_id,{status:'completed',score:''},admin,false)}catch(e){failed=e.message}
 check(/счёт/i.test(failed),'Пустой счёт не принимается');
 failed='';
 try{await trn.setMatchResult(extra.match_id,{status:'walkover'},admin,false)}catch(e){failed=e.message}
 check(/победител/i.test(failed),'W/O без победителя не принимается');

 // Снятие: сыгранное остаётся, несыгранное превращается в W/O сопернику.
 const t2=await trn.createTournament({name:'Снятия',kind:'singles'},admin,false);
 const st2=await trn.createStage(t2.tournament_id,{kind:'group'},admin,false);
 const e2=[];
 for(let i=0;i<4;i++)e2.push(await trn.addEntry(t2.tournament_id,{player_id:String(200+i),player_name:'W'+i,display_name:'W'+i,status:'accepted',group:'A',seed:String(i+1)},admin,false));
 await trn.generateGroupMatches(t2.tournament_id,st2.stage_id,admin,false);
 const before=(await trn.listMatches(t2.tournament_id,false,false)).filter(m=>[m.entry_a,m.entry_b].includes(e2[0].entry_id));
 await trn.setMatchResult(before[0].match_id,{status:'completed',score:'6:0 6:0',winner_entry:e2[0].entry_id},admin,false);
 await trn.withdrawEntry(e2[0].entry_id,{reason:'injury'},admin,false);
 const after=(await trn.listMatches(t2.tournament_id,false,false)).filter(m=>[m.entry_a,m.entry_b].includes(e2[0].entry_id));
 check(after.find(m=>m.match_id===before[0].match_id).status==='completed','Сыгранный матч снятого игрока не тронут');
 check(after.filter(m=>m.status==='walkover').length===2,'Несыгранные матчи снятого стали W/O');
 check(after.filter(m=>m.status==='walkover').every(m=>m.winner_entry&&m.winner_entry!==e2[0].entry_id),'W/O засчитан сопернику');
 const withdrawn=(await trn.listEntries(t2.tournament_id,false,false)).find(x=>x.entry_id===e2[0].entry_id);
 check(withdrawn.status==='withdrawn'&&withdrawn.withdrawal_reason==='injury','Заявка снята с причиной');

 // Замена: новый участник наследует место, группу и несыгранные матчи.
 const spare=await trn.addEntry(t2.tournament_id,{player_id:'299',player_name:'Spare',display_name:'Spare',status:'waitlist'},admin,false);
 await trn.withdrawEntry(e2[1].entry_id,{reason:'travel',replacedBy:spare.entry_id},admin,false);
 const swapped=(await trn.listEntries(t2.tournament_id,false,false)).find(x=>x.entry_id===spare.entry_id);
 check(swapped.status==='accepted'&&swapped.group===e2[1].group&&swapped.seed===e2[1].seed,'Замена встала на то же место с тем же посевом');
 const inherited=(await trn.listMatches(t2.tournament_id,false,false)).filter(m=>[m.entry_a,m.entry_b].includes(spare.entry_id));
 check(inherited.length>0&&inherited.every(m=>m.status==='scheduled'),'Замена унаследовала несыгранные матчи');
 check((await trn.listEntries(t2.tournament_id,false,false)).find(x=>x.entry_id===e2[1].entry_id).status==='replaced','Заменённый помечен отдельным статусом, не «снят»');

 // Подмена участника прямо в слоте сетки.
 const slotMatch=inherited[0];
 const side=slotMatch.entry_a===spare.entry_id?'a':'b';
 await trn.slotAction(slotMatch.match_id,{side,action:'bye'},admin,false);
 const byeMatch=(await trn.listMatches(t2.tournament_id,false,false)).find(m=>m.match_id===slotMatch.match_id);
 check(byeMatch.status==='bye'&&byeMatch.winner_entry,'Проход без игры отдаёт победу второму участнику слота');

 // Парная цепочка.
 const dbl=await trn.createTournament({name:'Парный',kind:'doubles',status:'registration'},admin,false);
 const pair=await trn.createPair(dbl.tournament_id,{playerAId:'301',playerAName:'Alpha'},admin,false);
 check(pair.status==='seeking','Запись без партнёра создаёт пару в поиске');
 const again=await trn.createPair(dbl.tournament_id,{playerAId:'301',playerAName:'Alpha'},admin,false);
 check(again.pair_id===pair.pair_id,'Повторная запись не плодит вторую пару');
 const inv=await trn.invitePartner(pair.pair_id,{toId:'302',toName:'Beta'},admin,false);
 check((await trn.findPair(pair.pair_id,false)).status==='invite_pending','После приглашения пара ждёт ответа');
 await trn.declineInvite(inv.invite_id,admin,false);
 const afterDecline=await trn.findPair(pair.pair_id,false);
 check(afterDecline.status==='seeking'&&!afterDecline.player_b_id,'Отказ не убивает заявку — пара снова ищет партнёра');
 const inv2=await trn.invitePartner(pair.pair_id,{toId:'303',toName:'Gamma'},admin,false);
 const accepted=await trn.acceptInvite(inv2.invite_id,{playerId:'303',playerName:'Gamma'},admin,false);
 check(accepted.pair.status==='confirmed','Согласие собирает пару');
 check(accepted.entry.entrant_type==='pair'&&accepted.entry.display_name==='Alpha / Gamma','После согласия появляется заявка пары');
 check((await trn.pendingInvitesFor('303',false)).length===0,'Принятое приглашение больше не висит');

 // Встречные приглашения засчитываются как согласие.
 const p1=await trn.createPair(dbl.tournament_id,{playerAId:'401',playerAName:'Mu'},admin,false);
 const p2=await trn.createPair(dbl.tournament_id,{playerAId:'402',playerAName:'Nu'},admin,false);
 await trn.invitePartner(p1.pair_id,{toId:'402',toName:'Nu'},admin,false);
 await trn.invitePartner(p2.pair_id,{toId:'401',toName:'Mu'},admin,false);
 const mutual=await trn.matchMutualInvites(dbl.tournament_id,false);
 check(mutual.length===1,'Встречные приглашения схлопнулись в одно согласие');
 const confirmed=(await trn.listPairs(dbl.tournament_id,false,false)).filter(p=>p.status==='confirmed');
 check(confirmed.length===2,'После встречного согласия собранных пар стало две');

 // Тестовый режим живёт в отдельных листах и не видит боевых данных.
 const sandbox=await trn.createTournament({name:'Песочница',kind:'singles'},admin,true);
 check(writes.some(w=>w.spreadsheetId==='trn-test'),'Тест пишет в отдельную тестовую таблицу');
 check(!writes.some(w=>w.spreadsheetId==='crm'&&/Tournament/.test(w.range)),'Турниры не пишут в основную таблицу Players list');
 check(writes.some(w=>w.spreadsheetId==='trn'),'Бой пишет в боевую таблицу турниров');
 check((await trn.listTournaments(true)).length===1,'В тестовом режиме свой список турниров');
 check((await trn.listTournaments(false)).every(x=>x.tournament_id!==sandbox.tournament_id),'Тестовый турнир не попал в боевой список');
 check((await trn.listTournaments(false)).length===3,'Боевой список не изменился от записей в тест');

 // Перенос сезона: один дивизион — один турнир, группы как в лиге, без дублей.
 const imp=await trn.importSeason('2',{},admin,true);
 check(imp.created.length===3&&imp.created.map(c=>c.division).sort().join()==='A,C,W','Перенос сезона: по одному турниру на дивизион');
 const byDiv=Object.fromEntries(imp.created.map(c=>[c.division,c]));
 check(byDiv.A.entries===8&&byDiv.C.entries===4&&byDiv.W.entries===4,'В каждый турнир попали игроки только своего дивизиона');
 const cEntries=await trn.listEntries(byDiv.C.tournament.tournament_id,true,false);
 check(new Set(cEntries.map(e=>e.group)).size===2&&cEntries.every(e=>['1','2'].includes(String(e.group))),'Группы дивизиона C перенесены как в лиге (1 и 2)');
 check(byDiv.C.tournament.playoff_type==='cross_groups'&&byDiv.A.tournament.playoff_type==='cross_1_4','Плей-офф: две группы — крест, одна — 1–4');
 check((await trn.listEntries(byDiv.A.tournament.tournament_id,true,false)).every(e=>e.division==='Division A'&&e.group==='1'),'Дивизион без групп — одна группа, дивизион подписан верно');
 const reimp=await trn.importSeason('2',{},admin,true);
 check(reimp.created.length===0&&reimp.skipped.length===3,'Повторный перенос не плодит дубли');
 const dbls=await trn.importSeason('2',{division:'A',kind:'doubles'},admin,true);
 const dEntries=await trn.listEntries(dbls.tournament.tournament_id,true,false);
 const dPairs=await trn.listPairs(dbls.tournament.tournament_id,true,false);
 check(dEntries.length===4&&dPairs.length===4&&dEntries.every(e=>e.entrant_type==='pair'&&e.status==='accepted'),'Парный перенос: восемь игроков → четыре готовые пары-участника');
 check(new Set(dPairs.flatMap(p=>[p.player_a_name,p.player_b_name])).size===8,'В парах каждый игрок встречается один раз');
}


// --- Турнирное API: доступ только админу, ошибки едут отдельным полем -------
{
 for(const p of ['/api/tournaments/bootstrap','/api/tournaments/state','/api/tournaments/candidates','/api/tournaments/log','/api/tournaments/open','/api/tournaments/my-invites'])
  check(routes.some(r=>r.method==='get'&&r.p===p),'Зарегистрирован GET '+p);
 for(const p of ['/api/tournaments/create','/api/tournaments/update','/api/tournaments/import-season','/api/tournaments/entry/add','/api/tournaments/entry/update','/api/tournaments/entry/assign','/api/tournaments/entry/withdraw','/api/tournaments/pair/create','/api/tournaments/pair/invite','/api/tournaments/pair/accept','/api/tournaments/pair/decline','/api/tournaments/groups/distribute','/api/tournaments/matches/generate','/api/tournaments/playoff/generate','/api/tournaments/match/result','/api/tournaments/match/slot','/api/tournaments/match/create'])
  check(routes.some(r=>r.method==='post'&&r.p===p),'Зарегистрирован POST '+p);

 const denied=await request('get','/api/tournaments/bootstrap','3');
 check(denied.code===403&&denied.body.code==='tournament_admin_only','Не-админа в турнирную админку не пускают');
 const boot=await request('get','/api/tournaments/bootstrap','99');
 check(boot.code===200&&Array.isArray(boot.body.tournaments),'Админ получает список турниров');
 const bad=await request('post','/api/tournaments/create','99',{});
 check(bad.code===400&&/назван/i.test(bad.body.detail||''),'Настоящая причина ошибки едет в detail, а не теряется в общем переводчике');
 const created=await request('post','/api/tournaments/create','99',{name:'API турнир',kind:'doubles'});
 check(created.body.ok&&created.body.tournament.kind==='doubles','Турнир создаётся через API');
 const testMode=await request('get','/api/tournaments/bootstrap','99',{test:'1'});
 check(testMode.body.test===true,'Флаг тестового режима доезжает до сервера');

 // Файлы интерфейса и цепочки загружаются без сюрпризов.
 const pair=await load('pairflow.js');
 check(typeof pair.handlePairCallback==='function'&&pair.isPairCallback('pr:join:x')&&!pair.isPairCallback('pay:1'),'Парные колбэки отделены от остальных');
 const page=await fs.readFile(path.join(root,'public','tournament.html'),'utf8');
 for(const path0 of ['bootstrap','state','entry/assign','playoff/generate','match/result','match/slot','pair/invite'])
  check(page.includes(`'${path0}'`)||page.includes(`api('${path0}'`),'Интерфейс зовёт '+path0);
 check(!/localStorage|sessionStorage/.test(page),'Интерфейс не полагается на браузерное хранилище');
}


// --- Команды не теряются: и в меню по слэшу, и в /help ----------------------
{
 const tg=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 const bot=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/cmd:'tournaments'/.test(tg),'Команда /tournaments есть в едином списке команд организатора');
 check(/command: 'doubles'/.test(tg)&&tg.match(/command: 'doubles'/g).length===2,'Команда /doubles есть в меню игрока на обоих языках');
 check(/'\/doubles — парные турниры/.test(bot)&&/'\/doubles — doubles tournaments/.test(bot),'Команда /doubles описана в /help на обоих языках');
 check(/'Турниры':'🥇'/.test(bot)&&/'Турниры':'Tournaments'/.test(bot),'Раздел «Турниры» в админском /help переведён');
 check(/text === '\/tournaments'/.test(bot),'Обработчик команды /tournaments на месте');
 check(/param\.startsWith\('pair_'\)/.test(bot),'Ссылка-приглашение в пару разбирается в /start');
 check(/PERSONAL_PREFIXES[^\n]*'pr:'/.test(bot),'Парные кнопки помечены личными — в группе их не нажать');
}


// --- Сообщения об ошибках счёта доходят до человека -------------------------
{
 const ui=await load('ui-errors.js');
 const generic=ui.uiError('какая-то неизвестная ошибка','ru');
 for(const msg of ['Указанный победитель не совпадает со счётом','Выберите победителя или результат для обоих','Для RET укажите сыгранный счёт','Выберите двух разных игроков','Игроки должны быть из одного дивизиона','Только для организатора','Профиль не найден'])
  check(ui.uiError(msg,'ru')!==generic&&ui.uiError(msg,'en')!==ui.uiError('неизвестно','en'),'Переведено: '+msg);
 check(/переверн/i.test(ui.uiError('Указанный победитель не совпадает со счётом','ru')),'Ошибка про победителя подсказывает, что делать');

 // Ровно та ситуация со скриншота: победитель выбран, а решающий тай-брейк
 // выигран соперником. Форма обязана сказать это человеческим текстом.
 const mismatch=await request('post','/api/match/manual','99',{from_telegram_id:'7',to_telegram_id:'9',date:'2099-09-20',court:'Court A',kind:'played',winner:'9',sets:[{a:6,b:3},{a:6,b:7,tba:4,tbb:7},{a:4,b:10}]});
 check(mismatch.code===400,'Несовпадение победителя и счёта не проходит');
 check(mismatch.body.code==='Указанный победитель не совпадает со счётом','Машинный код ошибки сохраняется');
 check(/переверн|flip the score/i.test(mismatch.body.error),'Человек видит подсказку, а не дежурную фразу');
}


// --- Порядок матчей и поиск по имени ---------------------------------------
{
 const league=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 const match=await fs.readFile(path.join(root,'public','match.html'),'utf8');

 // Победитель встаёт слева — синхронно с колонками счёта и очков.
 check(/function orderByWinner/.test(match),'Победитель переставляется влево при выборе');
 check(/orderByWinner\(prefix\|\|'r',node\)/.test(match),'Перестановка вызывается из выбора победителя');
 check(/two\.insertBefore\(two\.children\[1\],first\)/.test(match),'Очки переставляются блоками, а не значениями');

 // Ближайшая дата сверху во всех трёх списках — не нужно листать в конец,
 // чтобы увидеть, что актуально прямо сейчас.
 check(/function byFreshest/.test(match),'Есть единая сортировка списков матчей');
 check(/byFreshest\(myMatches\)/.test(match)&&/byFreshest\(resultTasks\)/.test(match),'Мои матчи и результаты идут от ближней даты к дальней');
 check(/adminMatchTime\(a\)-adminMatchTime\(b\)/.test(match),'Админская вкладка тоже развёрнута ближней датой вверх');
 check(/openSlots\.slice\(\)\.sort\(function\(a,b\)\{[\s\S]{0,80}adminMatchTime\(a\)-adminMatchTime\(b\)/.test(match),'Открытые окна тоже сортируются по ближней дате');
 check(/sortableDate\(b\.date\)-sortableDate\(a\.date\)/.test(league),'Лента лиги сортируется по дате, а не по номеру матча');
 check(/function sortableDate/.test(league),'Дата приводится к числу: «01.09» не встаёт выше «12.08»');

 // Окно уходит только тем, с кем ещё не играли.
 const openSrc=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/async function alreadyPairedNames/.test(openSrc),'Уже сыгранные соперники отсеиваются');
 check(/String\(r\.completed \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'yes'/.test(openSrc),'Строка расписания без результата парой не считается');
 check(/\['pending', 'confirmed', 'disputed', 'unfinished'\]\.includes\(result\)/.test(openSrc),'Согласованный матч тоже занимает пару');
 check(/пропущено уже сыгранных/.test(openSrc),'Сколько пропустили — видно в журнале');

 // Повторная подача счёта и цепочка подтверждения.
 const idxSrc=await fs.readFile(path.join(root,'index.js'),'utf8');
 const matchesSrc=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/result_pending_confirm/.test(idxSrc),'Пока счёт ждёт подтверждения, второй игрок его не переписывает');
 check(/notifyResultForVerification\(slot,\{only:String\(v\.user\.id\)\}\)/.test(idxSrc),'Не заметил уведомление — присылаем то же самое заново');
 check(/String\(t\.id\) !== String\(slot\.result_by \|\| ''\)/.test(matchesSrc),'Автору счёта просьба подтвердить не уходит никогда');
 check(/const RESEND_GAP_MS/.test(matchesSrc),'Повтор ограничен по времени — три нажатия не дадут трёх писем');
 check(/app\.post\('\/api\/match\/result\/dispute'/.test(idxSrc),'«Не согласен» работает и из мини-приложения');
 const botSrc=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/Счёт по этому матчу уже внесён и ждёт вашего подтверждения/.test(botSrc),'Кнопка «Матч не доигран» при внесённом счёте отвечает подсказкой');
 check(/function renderConfirmScreen/.test(match),'Вместо формы показывается экран подтверждения');
 check(/pingConfirmation\(s\.challenge_id\)/.test(match),'Открыл экран — бот продублировал сообщение в чат');
 const dbSrc=await fs.readFile(path.join(root,'matchesdb.js'),'utf8');
 check(/const CONFIRM_STAGES = \[\['n2',4\],\['d1',24\]\]/.test(dbSrc),'У подтверждения своя лесенка: две ступени');

 // Форма создания вызова: выбор корта не сбрасывает время и комментарий.
 check(/function keepNewForm/.test(match),'Перед перерисовкой форма запоминает введённое');
 check(/toggleCourt\(name\)\{keepNewForm\(\)/.test(match),'Клик по корту сохраняет время');
 check(/toggleDate\(iso\)\{keepNewForm\(\)/.test(match),'Клик по дате сохраняет время');
 check(/timeOptions\(selFrom\)/.test(match)&&/timeOptions\(selTo\)/.test(match),'Время рисуется из сохранённого, а не из 17:00');
 check(/oninput="selComment=this\.value"/.test(match),'Комментарий тоже переживает перерисовку');

 // Поиск с выпадающим списком во всех трёх местах лиги.
 check(/function sugBox/.test(league),'Есть общий конструктор поля поиска');
 for(const [id,handler] of [['rq','race'],['pq','plr'],['fq','feed']]){
  check(new RegExp(`sugBox\\('${id}'`).test(league),'Поле '+id+' собрано через общий конструктор');
  for(const suffix of ['Set','Pick','Blur'])
   check(new RegExp(`function ${handler}${suffix}\\(`).test(league),'Обработчик '+handler+suffix+' определён');
  check(!new RegExp(`function ${handler}Focus\\(`).test(league),'По касанию поля список больше не открывается: '+handler);
 }
 check(!/onfocus="/.test(league),'Обработчика onfocus у поиска нет вовсе');
 check(/var hits=qq\?uniq\.filter/.test(league),'Подсказки появляются только после ввода символов');
 check(/open&&qq&&rows/.test(league),'Пустой запрос списка не рисует');
 check(/class="sugx"/.test(league),'У поля поиска есть крестик очистки');
 check(/max-height:46vh/.test(league),'Список ограничен по высоте и не накрывает соседние поля');
 check(/if\(document\.activeElement!==el\)el\.focus\(\)/.test(league),'Фокус возвращается после перерисовки — клавиатура не закрывается');
 check(/if\(typingIn!==id\|\|Date\.now\(\)-typingAt>1500\)return;/.test(league),'Фокус возвращается только пока человек печатает — страница сама клавиатуру не открывает');
 for(const h of ['feed','race','plr'])
  check(new RegExp(`function ${h}Set\\(v\\)\\{markTyping\\(`).test(league),'Ввод в '+h+' отмечает, что человек печатает');
 check(!/function setPQuery|function pickPQ|function setRaceQuery|function setFQuery/.test(league),'Старые обработчики поиска убраны, двух путей к одному полю не осталось');

 // Игрок в ручном матче выбирается из списка или набирается руками.
 check(!/datalist/.test(match),'Нативных выпадающих списков в ручном матче не осталось');
 check(/function comboBox\(id,names,placeholder,onpick\)/.test(match),'Поля игрока и корта собраны своим поиском');
 check(/if\(!v\)\{box\.style\.display='none'/.test(match),'Пустое поле списка не показывает');
 check(/function comboClear/.test(match)&&/class="sugx"/.test(match),'Список можно закрыть и очистить');
 check(/function manualPerson\(value\)/.test(match),'Игрок ищется по тексту поля, а не по telegram_id');
 check(/manualPerson\(\$\('mOpp'\)\.value\)\.telegram_id/.test(match),'На сервер уходит найденный telegram_id, а не введённый текст');
 check(/sugMore/.test(league),'Подсказка «сколько ещё» переведена');
 check(/awaitingResult\.sort\(\(a, b\) => byStart\(b, a\)\)/.test(await fs.readFile(path.join(root,'matchesdb.js'),'utf8')),'Сводка /matches: сыгранные без счёта идут от свежего к старому');
}


// --- Непринятый вызов и кнопка «Напомнить» ---------------------------------
{
 const invite={challenge_id:'inv1',match_type:'direct',status:'open',division:'Division C',season:'2',group:'1',
   from_telegram_id:'1',from_name:'Alice One',to_telegram_id:'2',to_name:'Bob Two',
   dates:'2099-10-10',time_from:'10:00',time_to:'12:00',duration_min:'120',courts:'Court A',created_at:'2099-01-01T00:00:00+07:00'};
 const pending={...invite,challenge_id:'neg1',status:'pending',pending_by:'2',responded_at:'2099-01-01T00:00:00+07:00'};

 // Непринятый адресный вызов больше не выдаёт себя за идущее согласование.
 check(db.pendingAction(invite).scope==='invite','Непринятый вызов — отдельная ветка invite');
 check(db.pendingAction(invite).waitingIds.join()==='2','Ждём того, кого вызвали');
 check(db.pendingAction(pending).scope==='negotiation','Ответивший матч остаётся согласованием');
 check(db.pendingAction({...invite,status:'accepted',result_status:'confirmed'})===null,'У закрытого матча ждать нечего');

 // Ступени напоминаний не тронуты: те же 15 минут, 2, 4, 24 часа.
 const hours=h=>Date.parse(invite.created_at)+h*3600000;
 check(!db.stuckItem(invite,hours(0.1)),'До 15 минут никто никого не дёргает');
 check(db.stuckItem(invite,hours(0.3)).stage==='m20','Первая ступень на 15 минутах осталась');
 check(db.stuckItem(invite,hours(3)).stage==='n1','Вторая ступень осталась');
 check(db.stuckItem(invite,hours(5)).stage==='n2','Третья ступень осталась');
 check(db.stuckItem(invite,hours(30)).stage==='close','Автозакрытие через 28 часов осталось');
 check(db.stuckItem(invite,hours(0.3)).scope==='invite','Напоминание по вызову идёт своей веткой');

 // Сводка: адресный вызов не лежит среди открытых окон.
 const overview=await db.matchesOverview();
 check(!overview.openSlots.some(x=>x.challenge_id==='inv1'),'Адресный вызов не считается открытым окном');

 // Текст напоминания по непринятому вызову — приглашение, а не укор.
 const matchesSrc=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/Вас вызвали на матч/.test(matchesSrc)&&/You have a match challenge/.test(matchesSrc),'У непринятого вызова свой заголовок на двух языках');
 check(/nudgeWarning\(stage,ru,initial\)/.test(matchesSrc),'Предупреждение о снятии сформулировано отдельно для вызова');

 // Ручное напоминание.
 check(routes.some(r=>r.method==='post'&&r.p==='/api/match/nudge'),'Эндпоинт ручного напоминания зарегистрирован');
 const page=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 check(/function nudgeOpponent/.test(page)&&/function waitingOnOpponent/.test(page),'В интерфейсе есть кнопка и правило её показа');
 check(/nudge:'🔔 Напомнить'/.test(page)&&/nudge:'🔔 Remind'/.test(page),'Кнопка переведена');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/MANUAL_NUDGE_MS = 60 \* 60 \* 1000/.test(idx),'Ручное напоминание ограничено одним разом в час');
 check(/isNightHold\(Date\.now\(\),TIMEZONE,win\)/.test(idx),'Ночью ручное напоминание тоже молчит');
 check(/pendingAction\(slot\)/.test(idx),'Кого будить, решает сервер, а не интерфейс');
 // Живые проверки доступа: до ночного правила и лимита частоты.
 await db.createSlot({...invite,challenge_id:'nudge1',status:'pending',pending_by:'2',responded_at:new Date().toISOString()});
 // pending_by — тот, кто предложил; ждём другого. Напоминать может предложивший.
 const self=await request('post','/api/match/nudge','1',{challenge_id:'nudge1'});
 check(self.code===409,'Тому, за кем ход, кнопка ничего не отправляет');
 const stranger=await request('post','/api/match/nudge','3',{challenge_id:'nudge1'});
 check(stranger.code===403,'Посторонний не может слать напоминания по чужому матчу');
 const missing=await request('post','/api/match/nudge','1',{challenge_id:'нет-такого'});
 check(missing.code===404,'Несуществующий матч честно отвечает «не найден»');
}



// --- 90 минут, отключённые напоминания о счёте, двойное подтверждение -------
{
 // Просьба внести счёт приходит через 90 минут ПОСЛЕ НАЧАЛА, а не после конца.
 const start=Date.parse('2099-05-05T10:00:00+07:00');
 await db.createSlot({challenge_id:'p90',match_type:'manual',status:'accepted',division:'Division C',season:'2',group:'1',
   from_telegram_id:'1',from_name:'Alice One',to_telegram_id:'2',to_name:'Bob Two',
   dates:'2099-05-05',time_from:'10:00',time_to:'12:00',duration_min:'120',courts:'Court A',
   agreed_date:'2099-05-05',agreed_time:'10:00',agreed_court:'Court A'});
 check(db.RESULT_PROMPT_AFTER_MIN===90,'По умолчанию просим счёт через 90 минут');
 check(await db.resultPromptDelayMin()===90,'Без настройки берём значение по умолчанию');
 const soon=(await db.listMatchesNeedingResultPrompt(start+89*60000)).some(x=>x.challenge_id==='p90');
 const due=(await db.listMatchesNeedingResultPrompt(start+91*60000)).some(x=>x.challenge_id==='p90');
 check(!soon&&due,'Через 89 минут ещё рано, через 91 — пора');

 // Значение настраивается из Settings без правки кода.
 tables.set('crm|Settings',[['key','value'],['season_number','2'],['league_seasons','2:active'],['result_prompt_after_min','75']]);
 sheets.invalidateSheetCache();
 await new Promise(r=>setTimeout(r,0));
 check(db.RESULT_PROMPT_AFTER_MIN===90,'Значение по умолчанию остаётся в коде неизменным');

 // Счёт от организатора: автор — не игрок, подтверждают оба.
 const organiser={from_telegram_id:'1',to_telegram_id:'2',result_by:'99'};
 check(db.isOrganiserResult(organiser),'Счёт от организатора отличается по автору');
 check(!db.isOrganiserResult({...organiser,result_by:'1'}),'Счёт от игрока остаётся обычным');
 check(db.resultConfirmationsLeft(organiser).join()==='1,2','Сначала ждём обоих');
 check(db.resultConfirmationsLeft({...organiser,result_confirmed_by:'1'}).join()==='2','После первой подписи ждём второго');
 check(db.resultConfirmationsLeft({...organiser,result_by:'1'}).length===0,'У обычного счёта списка подписей нет');

 // Живая цепочка: организатор вносит счёт за двоих.
 const byAdmin=await request('post','/api/match/manual','99',{from_telegram_id:'1',to_telegram_id:'2',
   date:'2099-05-06',court:'Court A',kind:'played',winner:'1',sets:[{a:6,b:3},{a:6,b:4}],perspective:'winner'});
 check(byAdmin.body.ok,'Организатор внёс счёт за двоих');
 const made=await db.findSlot(byAdmin.body.challenge_id);
 check(String(made.result_by)==='99','Автором счёта записан организатор, а не первый игрок формы');
 check(db.isOrganiserResult(made),'Матч распознаётся как внесённый организатором');

 messages.length=0;
 const first=await db.confirmResult(made.challenge_id,{telegram_id:'1',name:'Alice One'});
 check(first.ok&&first.waiting,'Первая подпись не закрывает результат');
 check(String(first.slot.result_status)==='pending','Пока ждём второго, результат не засчитан');
 const second=await db.confirmResult(made.challenge_id,{telegram_id:'2',name:'Bob Two'});
 check(second.ok&&!second.waiting,'Вторая подпись закрывает результат');
 check(String(second.slot.result_status)==='confirmed','После двух подписей результат засчитан');
 check(db.resultConfirmedBy(second.slot).sort().join()==='1,2','В таблице видно, кто именно подтвердил');

 // Несогласие любого из двоих отправляет счёт в спор и стирает подписи.
 const byAdmin2=await request('post','/api/match/manual','99',{from_telegram_id:'1',to_telegram_id:'2',
   date:'2099-05-07',court:'Court A',kind:'played',winner:'2',sets:[{a:6,b:0},{a:6,b:0}],perspective:'winner'});
 const slot2=byAdmin2.body.challenge_id;
 await db.confirmResult(slot2,{telegram_id:'1',name:'Alice One'});
 const disputed=await db.disputeResult(slot2,{telegram_id:'2',name:'Bob Two'});
 check(disputed.ok,'Второй игрок может не согласиться');
 const after=await db.findSlot(slot2);
 check(String(after.result_status)==='disputed'&&!String(after.result_confirmed_by||'').trim(),'Спор стирает собранные подписи');

 // Автору непринятого вызова бот больше ничего не пишет.
 const src=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/if\(stage==='n2'&&!initial&&proposer\?\.id\)/.test(src),'По непринятому вызову автору ничего не уходит');
 check(/Подтвердить должны оба игрока/.test(src),'В уведомлении сказано, что подтверждают оба');
 check(/Организатор<\/b> внёс счёт/.test(src),'В уведомлении честно указан организатор как автор счёта');
 const ui=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 check(/function byOrganiser/.test(ui)&&/function canConfirmResult/.test(ui),'Интерфейс различает счёт от организатора');
 check(/alreadyConfirmed/.test(ui),'Подтвердивший второй раз кнопку не видит');
 check(/waitingOther:'Вы подтвердили, ждём соперника'/.test(ui)&&/waitingOther:'You confirmed/.test(ui),'Ожидание второго подтверждения переведено');
 check(/appendObjects/.test(await fs.readFile(path.join(root,'tournaments.js'),'utf8')),'Перенос сезона пишет участников одним запросом');
 const page=await fs.readFile(path.join(root,'public','tournament.html'),'utf8');
 check(/Ответ \$\{res\.status\}/.test(page),'Турнирная админка показывает настоящий код ответа, а не «сервер не ответил»');
}


// --- Каждый вызов админки попадает в существующий маршрут нужным методом ----
// Ровно на этом сломалась турнирная админка: метод угадывался по наличию
// параметров, и чтение состояния уходило POST-запросом в никуда.
{
 const page=await fs.readFile(path.join(root,'public','tournament.html'),'utf8');
 const getList=/const GET_PATHS = new Set\(\[([^\]]+)\]\)/.exec(page);
 check(Boolean(getList),'Список читающих ручек объявлен явно');
 const gets=new Set(getList[1].split(',').map(x=>x.trim().replace(/^'|'$/g,'')));
 const called=[...page.matchAll(/\bapi\('([a-z0-9/-]+)'/gi)].map(m=>m[1]);
 check(called.length>10,'Нашли вызовы админки в разметке');
 const missing=[];
 for(const p of new Set(called)){
  const method=gets.has(p)?'get':'post';
  if(!routes.some(r=>r.method===method&&r.p==='/api/tournaments/'+p))missing.push(method.toUpperCase()+' '+p);
 }
 check(!missing.length,'Каждый вызов админки находит маршрут: '+missing.join(', '));
 // И обратное: объявленный как чтение путь не должен быть только POST-ручкой.
 for(const p of gets){
  if(routes.some(r=>r.p==='/api/tournaments/'+p))
   check(routes.some(r=>r.method==='get'&&r.p==='/api/tournaments/'+p),'Путь '+p+' действительно читающий');
 }
 // Метод берётся из списка, а не угадывается по наличию параметров: именно
 // из-за угадывания чтение состояния уходило POST-запросом и падало в 404.
 check(/const isGet = method \? method === 'GET' : GET_PATHS\.has\(path\);/.test(page),'Метод запроса определяется по списку чтений');
 check(!/body \? 'POST' : 'GET'/.test(page),'Метод больше не выводится из наличия данных');
 check(/function plainError/.test(page),'Ошибку сервера показываем текстом, а не разметкой');
}


// --- Приглашение и форма счёта открываются в один и тот же момент -----------
// Ровно здесь сломалось у живого игрока: бот звал вносить счёт через 90 минут
// после начала, а список задач ждал конца брони — и человек упирался в пустой
// экран на полчаса.
{
 const start=Date.parse('2099-06-06T11:00:00+07:00');
 const two={challenge_id:'win2h',match_type:'manual',status:'accepted',division:'Division C',season:'2',group:'1',
   from_telegram_id:'1',from_name:'Alice One',to_telegram_id:'2',to_name:'Bob Two',
   dates:'2099-06-06',time_from:'11:00',time_to:'13:00',duration_min:'120',courts:'Court A',
   agreed_date:'2099-06-06',agreed_time:'11:00',agreed_court:'Court A',court_confirmed_at:'2099-06-05T10:00:00+07:00'};
 await db.createSlot(two);
 const hour={...two,challenge_id:'win1h',time_to:'12:00',duration_min:'60'};
 await db.createSlot(hour);

 check(db.resultOpenMs(two)===start+90*60000,'Двухчасовой матч открывает счёт через 90 минут после начала');
 check(db.resultOpenMs(hour)===start+60*60000,'Часовой матч не заставляет ждать дольше своей брони');
 check(db.resultOpenMs({agreed_date:'',agreed_time:''})===null,'Матч без даты порога не имеет');

 const at=m=>start+m*60000;
 const prompted=async m=>(await db.listMatchesNeedingResultPrompt(at(m))).some(x=>x.challenge_id==='win2h');
 const tasked=async m=>(await db.listResultTasks('1',at(m))).some(x=>x.challenge_id==='win2h');
 check(!await prompted(89)&&!await tasked(89),'До порога нет ни приглашения, ни задачи');
 check(await prompted(91),'После порога приглашение уходит');
 check(await tasked(91),'И в тот же момент матч появляется в списке «внести результат»');
 // Старое поведение: приглашение есть, а задачи нет. Проверяем, что окна больше нет.
 for(const m of [91,100,115,119]) check(await tasked(m),'В окне между порогом и концом брони матч доступен ('+m+' мин)');

 // «Матч не доигран» открывается тогда же, а не по концу брони.
 const early=await db.markMatchUnfinished('win2h',{telegram_id:'1',name:'Alice One'});
 check(!early.ok&&early.reason==='match_not_ended','До порога отметить недоигранным нельзя');

 // Интерфейс считает по тому же правилу и берёт число с сервера.
 const ui=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 check(/resultAfterMin=Number\(j\.result_after_min\|\|90\)/.test(ui),'Интерфейс берёт порог с сервера, а не зашивает своё число');
 check(/Math\.min\(Number\(resultAfterMin\)\|\|90,Number\(s\.duration_min\|\|matchDuration\)\|\|120\)/.test(ui),'Интерфейс считает порог той же формулой');
 check(/myMatches\.filter\(function\(x\)\{return x\.challenge_id===resultSlotId/.test(ui),'Ссылка из бота открывает форму, даже если матча нет в списке задач');
 const boot=await request('get','/api/match/bootstrap','1');
 check(Number(boot.body.result_after_min)===90,'Порог уезжает в интерфейс при загрузке');
}


// --- Постер: новая раскладка, стадия матча и один общий файл спонсоров ------
{
 const src=await fs.readFile(path.join(root,'matchposter.js'),'utf8');
 // Промпт: портретное кадрирование вместо общего плана.
 check(/Crop each player just below the shoulders, at mid-chest level/.test(src),'Промпт требует портретного кадрирования по грудь');
 check(/Do not show the waist, hips, legs or full torso/.test(src),'Промпт прямо запрещает общий план');
 check(!/Show both players from approximately the chest or waist upward/.test(src),'Старая формулировка кадрирования убрана');

 // Оформление взято из карточки матча, Fantasy Points нет.
 check(/gold:'#C9A76A'/.test(src)&&/amber:'#E8A45C'/.test(src),'Палитра та же, что в карточке матча');
 check(!/FANTASY POINTS/i.test(src.replace(/\/\/[^\n]*/g,'')),'Fantasy Points на постере нет');
 check(/DIVISION RANK/.test(src),'Место в дивизионе на постере есть');
 check(!/DejaVu Sans,Arial/.test(src),'Зашитый чужой шрифт убран — берём шрифт карточки');

 // Один общий файл спонсоров, и без него плашки просто нет.
 const sponsorsSrc=await fs.readFile(path.join(root,'sponsors.js'),'utf8');
 check(/SPONSOR_FILE = path\.join\(ASSETS_DIR, 'sponsors\.png'\)/.test(sponsorsSrc),'Спонсоры читаются из assets/sponsors.png');
 const poster=await import(pathToFileURL(path.join(root,'matchposter.js')).href);
 check(poster.sponsorsAvailable()===false,'Без файла спонсоров лента просто не рисуется');
 check(poster.posterStageLabel({round:'SF'})==='PLAYOFF · SEMIFINAL','Стадия читается из round слота');
 check(poster.posterStageLabel({round:'QF'})==='PLAYOFF · QUARTERFINAL','Четвертьфинал подписан');
 check(poster.posterStageLabel({round:'Final'})==='PLAYOFF · FINAL','Финал подписывается финалом');
 check(poster.posterStageLabel({round:'3rd'})==='PLAYOFF · THIRD PLACE MATCH','Матч за третье место подписан');
 check(poster.posterStageLabel({})==='GROUP STAGE','Обычный матч — групповой этап');
 // На постере не должно быть ни одной русской буквы: картинка уходит всем
 // сразу, в том числе в Instagram.
 const drawn=src.split('\n').filter(line=>!/^\s*\/\//.test(line)).join('\n');
 const cyrillic=[...drawn.matchAll(/>[^<>]*[А-Яа-яЁё][^<>]*</g)].map(m=>m[0]);
 check(!cyrillic.length,'В разметке постера нет русского текста: '+cyrillic.join(' | '));
 check(!/SEASON PARTNERS/.test(src),'Подписи над логотипами нет — только сама лента');
 check(poster.posterStageLabel({label:'TECHNICAL RESULT'})==='TECHNICAL RESULT','Техническое поражение перебивает стадию');

 // Стадия доезжает из слота в данные постера.
 const card=await fs.readFile(path.join(root,'matchcard.js'),'utf8');
 check(/round:slot\.round\|\|''/.test(card),'Стадия матча передаётся из слота в данные постера');

 // Команда на постер по уже сыгранному матчу есть и в /help, и в меню.
 const tg=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(/cmd:'poster_test'/.test(tg),'Команда /poster_test попала в единый список команд');
 const bot=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/text\.startsWith\('\/poster_test'\)/.test(bot),'Обработчик /poster_test на месте');
}


// --- Instagram: опрос, согласие, сторис и карусель недели ------------------
{
 const pub=await load('publicity.js');
 const ig=await load('instagram.js');

 // Опрос на двух языках, со ссылкой на аккаунт и кнопкой отказа.
 const ruText=pub.instagramAskText('ru'), enText=pub.instagramAskText('en');
 check(/пришлите свой Instagram/i.test(ruText)&&/send us your Instagram|send your Instagram/i.test(enText),'Опрос просит прислать инстаграм на обоих языках');
 check(ruText.includes(ig.IG_ACCOUNT)&&enText.includes(ig.IG_ACCOUNT),'В тексте назван наш аккаунт');
 const kb=pub.instagramAskKeyboard('ru').inline_keyboard.flat();
 check(kb.some(b=>b.url===ig.IG_PROFILE_URL),'В опросе есть прямая ссылка на аккаунт');
 check(kb.some(b=>b.callback_data==='pub:send')&&kb.some(b=>b.callback_data==='pub:no'),'Есть кнопки «прислать» и «не публиковать»');
 check(pub.isPublicityCallback('pub:no')&&!pub.isPublicityCallback('pr:join:x'),'Кнопки опроса отделены от остальных');

 // Ник приводится к одному виду, мусор не принимается.
 check(sheets.normalizeInstagramHandle('https://instagram.com/kostas.p/?hl=ru')==='@kostas.p','Ссылка превращается в ник');
 check(sheets.normalizeInstagramHandle('@@Kostas_P')==='@Kostas_P','Лишние собачки убираются');
 check(sheets.normalizeInstagramHandle('не инстаграм')==='','Мусор не принимается');
 check(sheets.normalizeInstagramHandle('')==='','Пустое остаётся пустым');

 // Согласие: публикуем по умолчанию, останавливает только явный отказ.
 check(sheets.publicationAllowed({})===true,'Молчание не запрещает публикацию');
 check(sheets.publicationAllowed({photo_publication_consent:'YES'})===true,'Согласие разрешает');
 check(sheets.publicationAllowed({photo_publication_consent:'no'})===false,'Явный отказ запрещает, регистр не важен');
 check(sheets.publicationAllowed({instagram:''})===true,'Отсутствие инстаграма публикации не мешает');

 // Отказ одного игрока снимает весь матч: в карточке двое.
 await sheets.setPhotoConsent('4','NO');
 await sheets.setPlayerInstagram('3','@carol.tennis');
 const both={from_telegram_id:'3',from_name:'Carol Three',to_telegram_id:'4',to_name:'Dan Four'};
 const verdict=await pub.matchPublicity(both);
 check(!verdict.allowed&&verdict.blocked.length===1,'Отказ одного снимает весь матч');
 const clean={from_telegram_id:'3',from_name:'Carol Three',to_telegram_id:'1',to_name:'Alice One'};
 const ok=await pub.matchPublicity(clean);
 check(ok.allowed&&ok.handles.join()==='carol.tennis','У разрешённого матча собираются ники для отметок');

 // Запрет доходит до самой публикации, а не только до интерфейса.
 let blocked='';
 try { await pub.publishPosterToStory(Buffer.from('x'),both); } catch(e) { blocked=e.message; }
 check(/не публиков|Instagram не подключ/.test(blocked),'Публикация запрещённого матча не проходит');

 // Воскресенье 19:00 и ничего в другое время.
 const at=iso=>Date.parse(iso);
 check(pub.carouselDue(at('2099-01-04T12:00:00Z')),'Воскресенье 19:00 по Пхукету — время карусели');
 check(!pub.carouselDue(at('2099-01-04T09:00:00Z')),'В воскресенье утром карусель не собирается');
 check(!pub.carouselDue(at('2099-01-05T12:00:00Z')),'В понедельник карусель не собирается');

 // Подпись к посту — короткий обзор недели, а не список счетов.
 const week=[{slot:{from_name:'Alice One',to_name:'Bob Two',division:'Division C'}},
   {slot:{from_name:'Carol Three',to_name:'Dan Four',division:'Division W'}}];
 const caption=pub.carouselCaption(week,at('2099-01-04T12:00:00Z'),['alice.t','carol.t']);
 check(!/6:4|def\./.test(caption),'Счёта матчей в подписи нет — он и так на карточках');
 check(/2 matches played this week/.test(caption),'Единственная цифра в подписи — сколько матчей сыграно');
 check(!/players on court|divisions in action|Jan|Sept/.test(caption),'Ни игроков, ни дивизионов, ни дат в подписи нет');
 check(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(caption.split('\n')[0]),'Заголовок с эмодзи');
 check(/@alice\.t @carol\.t/.test(caption),'Игроки, давшие согласие, упомянуты в подписи');
 const pubSrc=await fs.readFile(path.join(root,'publicity.js'),'utf8');
 check(/const caption = carouselCaption\(used, span, handles\);/.test(pubSrc),'Подпись одна на всю подборку, а не на каждый пост');
 check(/const buttons = canPublish/.test(pubSrc),'Кнопки публикации собраны под одной подписью');
 // Карточки недели не пересобираются — пересылается сохранённая в момент результата.
 check(!/cardForSlot/.test(pubSrc.slice(pubSrc.indexOf('export async function buildWeeklyCarousel'),pubSrc.indexOf('export async function publishWeeklyCarousel'))),'Подборка недели карточки не пересобирает');
 check(/txt\(item\.slot\.result_card_file_id\)/.test(pubSrc),'Берётся сохранённая карточка матча');
 check(/Нет сохранённой карточки/.test(pubSrc),'Матчи без сохранённой карточки названы в сводке');
 const mSrc=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/export async function archiveResultCard/.test(mSrc),'Карточка сохраняется в момент результата');
 check(/if \(media\.buffer\) await archiveResultCard\(slot, media\.buffer\)/.test(mSrc),'Сохраняется та же картинка, что уходит в ленту');
 check(/sendDocumentBuffer\(chatId, buffer, `card-/.test(mSrc)&&/deleteMessage\(chatId, sent\.message_id\)/.test(mSrc),'Файлом, в оригинале, и сообщение сразу удаляется');
 check(/'result_card_file_id'/.test(await fs.readFile(path.join(root,'matchesdb.js'),'utf8')),'Под карточку есть колонка в Match Slots');
 // Fantasy Points в публичные материалы не идут.
 const rSrc=await fs.readFile(path.join(root,'results.js'),'utf8');
 check(!/buildFantasyCatalog|scoreFantasyMatch/.test(rSrc),'Снимок для карточки больше не считает очки Fantasy');
 check(!/FANTASY POINTS/.test(await fs.readFile(path.join(root,'matchcard.js'),'utf8')),'Плашки Fantasy на карточке нет даже в коде');
 // Перенос аватарок из Players_Master выполнен и больше не нужен: новые
 // аватарки грузятся через Telegram, автопрогон удалён вместе с запуском.
 const avSrc=await fs.readFile(path.join(root,'avatars.js'),'utf8');
 check(!/importMasterAvatars/.test(avSrc),'Функции переноса из Players_Master больше нет');
 check(!/avatarImport|importMasterAvatars/.test(await fs.readFile(path.join(root,'index.js'),'utf8')),'И её запуска после старта и раз в сутки тоже');
 check(/sameName\(n, wanted\)/.test(await fs.readFile(path.join(root,'matchcard.js'),'utf8')),'Фото на карточке ищется по имени терпимо');

 check(pub.CAROUSEL_HASHTAGS.join(' ')==='#phuket #tennis #phukettennis #phukettennisfamily','Хэштеги те, что просили');
 check(caption.includes(pub.CAROUSEL_HASHTAGS.join(' ')),'Хэштеги есть в подписи');
 check(!/[А-Яа-я]/.test(caption),'Подпись к посту без русского текста');
 // Две недели подряд текст не повторяется.
 const a=pub.carouselCaption(week,at('2099-01-04T12:00:00Z'),[]);
 const b=pub.carouselCaption(week,at('2099-01-11T12:00:00Z'),[]);
 check(a.split('\n')[0]!==b.split('\n')[0],'Первая фраза меняется от недели к неделе');

 // Витрина картинок: ссылка живёт, отдаётся и умирает по требованию.
 const kept=ig.rememberMedia(Buffer.from('jpeg-bytes'),'image/jpeg');
 check(/\/ig\/[a-z0-9]+\.jpg$/.test(kept.url),'Картинка получает публичную ссылку');
 check(ig.takeMedia(kept.id)?.buffer?.toString()==='jpeg-bytes','По ссылке отдаётся та самая картинка');
 ig.forgetMedia(kept.id);
 check(ig.takeMedia(kept.id)===null,'После публикации ссылка умирает');
 check(ig.instagramEnabled()===false,'Без ключей Instagram считается неподключённым');
 check(ig.CAROUSEL_MAX===20,'В карусель кладём двадцать карточек');
 check(ig.CAROUSEL_SAFE===10,'Безопасный откат — десять, как обещает документация Meta');

 // Маршрут отдачи и команды на месте.
 check(routes.some(r=>r.method==='get'&&r.p==='/ig/:id.jpg'),'Маршрут отдачи картинок зарегистрирован');
 const tg=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 for(const cmd of ['instagram_ask','instagram_status','instagram_week'])
  check(new RegExp(`cmd:'${cmd}'`).test(tg),'Команда /'+cmd+' в едином списке команд');
 const bot=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/poster:ig:/.test(bot),'Под постером есть кнопка публикации в сторис');
 check(/igweek:go/.test(bot),'Под каруселью есть кнопка публикации');
 check(/'Instagram':'📸'/.test(bot),'Раздел Instagram в админском /help');
}


// --- Подборка недели уходит целиком, лимит Instagram только при публикации --
{
 const pub2=await load('publicity.js');
 const ig2=await load('instagram.js');
 const src=await fs.readFile(path.join(root,'publicity.js'),'utf8');
 check(/return { matches: out, extra/.test(src),'Организатору показываем все матчи недели, а не первые десять');
 check(/export const POST_SIZE = 10/.test(src),'Подборка режется на посты по десять картинок');
 check(/const handles = \[\.\.\.new Set\(list\.flatMap\(x => x\.handles \|\| \[\]\)\)\]/.test(src),'В посте отмечены только те игроки, чьи картинки в него вошли');
 check(/publishCarousel\(post\.images, \{ caption: post\.caption, handles: post\.handles \}\)/.test(src),'Публикуется один конкретный пост: подпись общая, отметки свои');
 check(/callback_data: `\$\{action\}:\$\{post\.index\}`/.test(src),'У каждого поста своя кнопка публикации');
 check(ig2.CAROUSEL_MAX===20,'По умолчанию двадцать');
 check(/children\.slice\(0, CAROUSEL_SAFE\)/.test(await fs.readFile(path.join(root,'instagram.js'),'utf8')),'При отказе карусель сама урезается до десяти, а не падает');
 check(/IG_CAROUSEL_MAX/.test(await fs.readFile(path.join(root,'instagram.js'),'utf8')),'Лимит меняется переменной, без правки кода');

 // Тема для материалов задаётся отдельно от админского чата.
 const bot2=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/text === '\/instagram_here'/.test(bot2),'Есть привязка темы для материалов Instagram');
 check(/instagram_chat_id/.test(src)&&/instagram_topic_id/.test(src),'Подборка уходит в привязанную тему');
 check(/canPublish: instagramEnabled\(\)/.test(src),'Кнопка публикации появляется только когда Instagram подключён');

 // Постер: счёт больше не налезает на имена.
 const poster=await fs.readFile(path.join(root,'matchposter.js'),'utf8');
 check(/function nameFit/.test(poster)&&/const textWidth/.test(poster),'Ширина имени считается, а не угадывается');
 check(/const room=Math\.max\(160/.test(poster),'Кегль счёта подбирается под фактический просвет между именами');
 check(!/scoreRoom:420/.test(poster),'Фиксированный просвет убран');
 check(/LIGHTING — both players must look photographed together/.test(poster),'В промпте есть требование одинакового света');
 check(/Do not light one player brightly and the other in shadow/.test(poster),'Запрет на разное освещение сформулирован прямо');
 // Плашка опущена, спонсорская стала компактнее.
 check(/panel:\{ x:40, y:1120/.test(poster),'Информационная плашка опущена ниже');
 check(/sponsor:\{ top:1556, bottom:1818 \}/.test(poster),'Под партнёров оставлена свободная полоса под панелью счёта');
 const panelBottom=1120+424;
 check(1818<1920*0.95,'Спонсоры не заходят в нижние 5%, закрытые интерфейсом Stories');
 check(panelBottom<1556,'Лента не налезает на панель счёта');
 check(!/SEASON PARTNERS/.test(poster),'Плашки и подписи под спонсорами больше нет');
 check(!/<rect[^>]*S\.x/.test(poster),'Рамки вокруг логотипов не рисуем');
 const strip=await fs.readFile(path.join(root,'sponsors.js'),'utf8');
 check(/fit: 'inside'/.test(strip),'Логотипы вписываются целиком, без растяжения и обрезки');
 check(/width: Math\.round\(width \|\| canvas\)/.test(strip),'Лента идёт во всю ширину картинки');
 check(/export async function sponsorStrip/.test(strip),'Лента партнёров собирается в одном месте для всех картинок');
 const cardSrc=await fs.readFile(path.join(root,'matchcard.js'),'utf8');
 const standSrc=await fs.readFile(path.join(root,'standings.js'),'utf8');
 check(/sponsorStrip/.test(cardSrc),'Карточка матча берёт ту же ленту');
 check(/sponsorStrip/.test(standSrc),'Постер таблицы берёт ту же ленту');
 check(/sponsorsAvailable\(\)/.test(cardSrc),'Общий файл партнёров главнее папки с отдельными логотипами');
}


// --- Постер старого матча: форма и место берутся по логике карточки ---------
 // Форма: журналы дивизионов главнее витрины, сквозь сезоны, свежее слева.
 const divForm=await fs.readFile(path.join(root,'division.js'),'utf8');
 check(/export async function playerFormAcrossSeasons/.test(divForm),'Форма собирается по журналам дивизионов сквозь сезоны');
 check(/if \(out\.length >= limit\) break;/.test(divForm),'Прошлый сезон добирается только пока не набрана пятёрка');
 check(/if \(current && Number\(one\) > Number\(current\)\) continue;/.test(divForm),'Будущие сезоны в форму не попадают');
 const res5=await fs.readFile(path.join(root,'results.js'),'utf8');
 check(/const live = await playerFormAcrossSeasons\(name, \{ season, upTo, limit: 5 \}\)/.test(res5),'Карточка берёт форму из журналов, витрина — запасной вариант');
 const card5=await fs.readFile(path.join(root,'matchcard.js'),'utf8');
 check(/const live = await playerFormAcrossSeasons\(name, \{ season, limit: 5 \}\)/.test(card5),'Постер старого матча берёт форму оттуда же');
 check(/slice\(-5\)\.reverse\(\)/.test(card5),'На карточке свежий матч слева');
 const post5=await fs.readFile(path.join(root,'matchposter.js'),'utf8');
 check(/\.filter\(x=>x==='W'\|\|x==='L'\)\.reverse\(\)/.test(post5),'На постере свежий матч слева');
 const lg5=await fs.readFile(path.join(root,'public/league.html'),'utf8');
 check(/form\.slice\(-5\)\.reverse\(\)/.test(lg5),'В мини-приложении свежий матч слева');


{
 const card=await fs.readFile(path.join(root,'matchcard.js'),'utf8');
 check(/async function metasFromSheets/.test(card),'Без контекста карточка не остаётся пустой');
 check(/if \(!ctx\) return metasFromSheets\(slot, winnerIsFrom, seasonHint\)/.test(card),'Запасной путь включается именно при отсутствии контекста');
 check(/playerFormAcrossSeasons/.test(card),'Форма берётся из журналов дивизионов сквозь сезоны');
 check(/getLeagueProfiles\(\)/.test(card),'Витрина профилей осталась запасным источником формы');
 check(/sameName\(x\.name, name\)\)\?\.place/.test(card),'Место читается из живой таблицы дивизиона');
 check(/position: \{ after: place\(p1\) \}/.test(card),'Место «до» задним числом не выдумываем — стрелки нет');
 check(!/fp:/.test(card),'Fantasy Points в данных карточки нет вовсе');

 const results2=await fs.readFile(path.join(root,'results.js'),'utf8');
 check(/recent_form/.test(results2)||/cardFormsBefore/.test(results2),'Карточка по-прежнему снимает контекст при записи счёта');
 const div=await fs.readFile(path.join(root,'division.js'),'utf8');
 check(!/getDivisionTable\(letter, season = '', group = '', \{ upTo/.test(div),'Срезов таблицы в прошлое нет — место считаем по живой таблице');
}


// --- Таблицы дивизионов: вторник, снимки мест, по картинке на группу --------
{
 const st=await load('standings.js');
 const at=iso=>Date.parse(iso);
 const src=await fs.readFile(path.join(root,'standings.js'),'utf8');
 check(st.WEEKLY_FROM==='2026-10-06','Автовыпуски начинаются 6 октября');
 check(st.SEASON_END==='2026-11-08','После 8 ноября автоматика молчит');
 check(st.standingsDue(at('2026-10-06T12:00:00Z')),'Вторник 19:00 по Пхукету — время таблиц');
 check(!st.standingsDue(at('2026-10-07T12:00:00Z')),'В среду выпуск не собирается');
 check(!st.standingsDue(at('2026-10-06T09:00:00Z')),'Во вторник утром выпуск не собирается');
 check(!st.standingsDue(at('2026-09-29T12:00:00Z')),'До 6 октября автоматических выпусков нет — только руками');
 check(!st.standingsDue(at('2026-11-10T12:00:00Z')),'После конца сезона выпусков нет');
 check(st.groupTitle('B','2','')==='DIVISION B · GROUP 2','Заголовок группы по-английски');
 check(!/[А-Яа-я]/.test(st.groupTitle('W','1','')),'В заголовке картинки нет кириллицы');

 const cap=await st.groupCaption({rows:[{name:'Alice One',place:1,points:21,matches:7,wins:7,move:2}]});
 check(!/#/.test(cap),'В подписи к сторис нет хэштегов');
 check(!/DIVISION|GROUP|SEASON/i.test(cap),'Дивизион, группа и сезон в тексте не повторяются — они на картинке');
 check(cap.split(/\s+/).length<=16,'Подпись — одно короткое предложение');
 check(!/[А-Яа-я]/.test(cap),'Подпись только на английском');
 check(/Alice One/.test(cap),'Подпись опирается на факты таблицы, а не на выдумку');

 check(/playerPhotoForPoster\(\{ telegramId, name \}\)/.test(src),'Аватарки идут по той же цепочке, что в карточке матча');
 check(/publishedAvatars\(\)/.test(src),'Своя аватарка игрока находится по имени через витрину аватарок');
 check(/sources\?\.master\.find\(\(\[n\]\) => sameName\(n, name\)\)/.test(src),'Фото из Players_Master подбирается терпимым сравнением имён');
 check(/async function orgLogoLayer/.test(src),'В шапке таблицы есть логотип лиги');
 check(/'match-card-logos', 'ptf\.png'/.test(src),'Логотип берётся из того же файла, что на постере матча');
 const tg4=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(/export async function sendDocumentBuffer/.test(tg4),'Картинки уходят файлом, без пережатия Телеграмом');
 check(/sendDocumentBuffer\(chatId, item\.buffer, tableFileName\(item\)/.test(src),'Таблица приходит файлом');
 check(/table-\$\{String\(item\.key/.test(src),'У файла осмысленное имя');
 const bot4=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/sendDocumentBuffer\(chatId,finalBuffer,posterFileName/.test(bot4),'Постер матча приходит файлом');
 check(/result\?\.document\?\.file_id/.test(bot4),'file_id у файла читается из document, а не из photo');
 const pub4=await fs.readFile(path.join(root,'publicity.js'),'utf8');
 check(/sendDocumentAlbumBuffers/.test(pub4),'Недельные подборки уходят файлами');
 check(/>G<\/text>/.test(src),'Колонка сыгранных матчей подписана G — Games');
 check(/const SPONSOR = \{ top: 1398, bottom: 1660 \}/.test(src),'Лента партнёров поднята выше кнопок сторис');
 check(/title: 236, logoTop: 268/.test(src),'Шапка опущена ниже полосы просмотра сторис');
 check(/Math\.min\(L\.row, Math\.floor\(\(bandBottom - bandTop\) \/ rows\.length\)\)/.test(src),'Длинная группа ужимается по высоте строки, а не вылезает за кадр');
 const league=await fs.readFile(path.join(root,'public/league.html'),'utf8');
 check(/colM:'И',colW:'П',colWR:'WR',colPts:'ОЧК'/.test(league),'В русском интерфейсе колонки И · П · ОЧК');
 check(/colM:'G',colW:'W',colWR:'WR',colPts:'PTS'/.test(league),'В английском интерфейсе колонки G · W · PTS');
 check(/Standings Snapshots/.test(src),'Снимки мест лежат в нашей таблице, а не в таблицах дивизионов');
 check(/ensureExtraSheet/.test(src),'Лист снимков заводится сам');
 check(/const move = Number\.isFinite\(was\) \? was - p\.place : null/.test(src),'Движение считается от прошлого выпуска, а не от начала сезона');
 check(/data\.baseline \? '' :/.test(src),'Первый выпуск выходит без стрелок');
 check(/if \(save\) for \(const item of prepared\.items\)/.test(src),'Снимок кладётся только после отправки');
 check(/callback_data: `igtable:\$\{item\.key\}`/.test(src),'У каждой группы своя кнопка публикации');
 check(/publishStory/.test(src)&&!/publishCarousel/.test(src),'Таблицы уходят в сторис по одной, а не каруселью');

 const bot3=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/text\.startsWith\('\/tables'\)/.test(bot3),'Команда /tables есть');
 check(/data\.startsWith\('igtable:'\)/.test(bot3),'Кнопка «В сторис» обрабатывается');
 check(/\bdraft\b/.test(bot3),'Черновой прогон не сдвигает точку отсчёта');
 const tg3=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(/cmd:'tables'/.test(tg3),'Команда есть и в /help, и в меню по слэшу');
 const idx3=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/runWeeklyStandings/.test(idx3),'Вторничный выпуск подключён к общему проходу');
}


// --- Фотографии недели: четверг, только с согласия, только с фото -----------
{
 const pub3=await load('publicity.js');
 const at=iso=>Date.parse(iso);
 check(pub3.photosDue(at('2099-01-01T12:00:00Z')),'Четверг 19:00 по Пхукету — время фотографий');
 check(!pub3.photosDue(at('2099-01-04T12:00:00Z')),'В воскресенье фотоподборка не собирается');
 check(!pub3.photosDue(at('2099-01-01T09:00:00Z')),'В четверг утром фотоподборка не собирается');
 check(pub3.carouselDue(at('2099-01-04T12:00:00Z'))&&!pub3.carouselDue(at('2099-01-01T12:00:00Z')),'Карточки и фото разведены по разным дням');

 const cap=pub3.photosCaption([{slot:{from_name:'A',to_name:'B'}}],at('2099-01-01T12:00:00Z'),['a.t']);
 check(/@a\.t/.test(cap)&&cap.includes(pub3.CAROUSEL_HASHTAGS.join(' ')),'В подписи есть упоминания и хэштеги');
 check(!/[А-Яа-я]/.test(cap),'Подпись к фотопосту без русского текста');
 check(!/\d/.test(cap.replace(/#\S+|@\S+/g,'')),'Ни дат, ни числа игроков — никакой статистики в подписи');
 check(!/Sept|players on court/i.test(cap),'Даты и счётчики убраны');
 check(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(cap.split('\n')[0]),'Заголовок с эмодзи');
 check(cap.split('\n')[2].length>30,'Под заголовком живой текст про неделю, а не метрика');
 check(pub3.photosCaption([],at('2099-01-01T12:00:00Z'),[]).split('\n')[0]
   !==pub3.photosCaption([],at('2099-01-08T12:00:00Z'),[]).split('\n')[0],'Первая фраза меняется от недели к неделе');

 // Берём только матчи с фотографией и только разрешённые.
 const src=await fs.readFile(path.join(root,'publicity.js'),'utf8');
 check(/if \(!txt\(r\.result_photo_file_id\)\) return false;/.test(src),'Без фотографии матч в подборку не попадает');
 check(/const who = await matchPublicity\(slot\);\n    if \(!who\.allowed\)/.test(src),'Согласие проверяется и здесь');
 check(/getFileBuffer\(txt\(item\.slot\.result_photo_file_id\)\)/.test(src),'Фото скачивается из Telegram по file_id');
 check(/instagram_photos_last/.test(src),'Повтор в тот же четверг отсекается отметкой');

 const bot3=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/text\.startsWith\('\/instagram_photos'\)/.test(bot3),'Есть команда ручной сборки фотографий');
 check(/data\.startsWith\('igweek:go'\) \|\| data\.startsWith\('igphotos:go'\)/.test(bot3),'Обе подборки публикуются одним обработчиком');
 check(/publishWeeklyCarousel\(prepared,index\)/.test(bot3),'Кнопка публикует именно свой пост, а не всю подборку');
 const tg3=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(/cmd:'instagram_photos'/.test(tg3),'Команда /instagram_photos в едином списке');
 const idx3=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/runWeeklyPhotos\(Date\.now\(\), evAdmin\)/.test(idx3),'Четверговая подборка висит на общем проходе');
}


// --- Диапазоны, превью опроса, согласие в анкете, ссылки на Instagram ------
{
 const pub4=await load('publicity.js');
 const now=Date.parse('2099-03-01T12:00:00Z');
 check(pub4.parseRange('',now).label==='последние 7 дней','Без аргумента — последняя неделя');
 check(pub4.parseRange('-2',now).label==='2 недели назад','Неделя назад задаётся числом');
 const exact=pub4.parseRange('2099-01-05 2099-01-11',now);
 check(exact.label==='2099-01-05 — 2099-01-11'&&exact.to>exact.from,'Точный отрезок разбирается по двум датам');
 check(pub4.parseRange('2099-02-01',now).label==='2099-02-01 + 7 дней','Одна дата — неделя от неё');
 check(pub4.parseRange('2099-13-45',now).label==='последние 7 дней','Битая дата не ломает сборку');
 // Подпись сама по себе дат не показывает, но отрезок всё равно определяет её
 // содержание: по нему выбирается заголовок недели.
 const cap=pub4.carouselCaption([{slot:{from_name:'A',to_name:'B',division:'C'}}],exact,[]);
 check(!/Jan|Feb/.test(cap),'Дат в подписи нет');
 check(/1 match played this week/.test(cap),'Число матчей считается по выбранному отрезку');

 const bot4=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/\btest\b/.test(bot4)&&/Так опрос выглядит у игрока/.test(bot4),'Есть превью опроса перед рассылкой');
 check(/instagramAskText\('ru'\)/.test(bot4)&&/instagramAskText\('en'\)/.test(bot4),'Превью показывает обе языковые версии');
 check(/parseRange\(text\.replace/.test(bot4),'Команды подборок принимают даты');

 // Анкета спрашивает согласие и прячет ник у отказавшихся.
 const form=await fs.readFile(path.join(root,'public','apply.html'),'utf8');
 check(/id="photoConsent"/.test(form),'В анкете есть вопрос про публикацию');
 check(/consentLabel:'Публиковать вас в Instagram лиги\?'/.test(form)&&/consentLabel:'Publish you on the league Instagram\?'/.test(form),'Вопрос переведён');
 check(/function toggleInstagram/.test(form),'Поле инстаграма прячется при отказе');
 check(/photo_publication_consent:\$\('photoConsent'\)\.value/.test(form),'Ответ уезжает на сервер');
 check(/@phukettennisfamily/.test(form),'Аккаунт назван прямо в подсказке к полю, без отдельной кнопки');

 // Ответ доезжает до таблицы — раньше инстаграм из анкеты терялся.
 const sh=await fs.readFile(path.join(root,'sheets.js'),'utf8');
 check(/instagram: profile\.instagram \|\| existing\?\.instagram/.test(sh),'Инстаграм из анкеты попадает в таблицу');
 check(/photo_publication_consent: profile\.photo_publication_consent/.test(sh),'Согласие из анкеты попадает в таблицу');
 const idx4=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/function consentFromForm/.test(idx4),'Ответ анкеты приводится к YES/NO/пусто');

 // Ссылка на аккаунт в приветствии и после анкеты.
 const kb=await fs.readFile(path.join(root,'keyboards.js'),'utf8');
 // Отдельных кнопок под Instagram нет: ссылка живёт строкой в тексте.
 check(!/Instagram/.test(kb),'В приветственной клавиатуре нет отдельной кнопки Instagram');
 check(!/📸 Наш Instagram/.test(idx4),'После анкеты тоже нет отдельной кнопки');
 check(/href="\$\{IG_PROFILE_URL\}">Instagram<\/a>/.test(idx4),'Ссылка встроена в текст сообщения после анкеты');
 check(/href="\$\{INSTAGRAM_URL\}">Instagram<\/a>/.test(await fs.readFile(path.join(root,'admin.js'),'utf8')),'Ссылка встроена в текст приветствия');
 const adm=await fs.readFile(path.join(root,'admin.js'),'utf8');
 check(/Постеры матчей и результаты выкладываем/.test(adm)&&/Match posters and results go to our/.test(adm),'В тексте приветствия сказано про Instagram');
 // Пропущенный вопрос — это разрешение: публикуем, просто не отмечаем.
 check(sheets.publicationAllowed({})===true&&sheets.publicationAllowed({photo_publication_consent:''})===true,'Молчание считается разрешением');
 const silent=await pub4.matchPublicity({from_telegram_id:'1',from_name:'Alice One',to_telegram_id:'2',to_name:'Bob Two'});
 check(silent.allowed===true,'Матч двоих промолчавших публикуется');
 check(silent.handles.length===0,'Промолчавших просто не отмечаем');
 check(/Не ответите — ничего страшного/.test(await fs.readFile(path.join(root,'publicity.js'),'utf8')),'В опросе прямо сказано, что молчание — не отказ');
}

// --- Афиша-анонс: постер до результата -------------------------------------
{
 const posterSrc=await fs.readFile(path.join(root,'matchposter.js'),'utf8');
 check(/export async function prepareAnnouncementJob/.test(posterSrc),'Есть подготовка задания без слота матча');
 check(/export async function composeAnnouncementPoster/.test(posterSrc),'Есть отдельная отрисовка панели анонса');
 check(/export async function renderAnnouncementPoster/.test(posterSrc),'Есть оркестратор анонса');
 check(/UPCOMING MATCH/.test(posterSrc),'На афише анонса нет счёта — вместо него метка анонса');
 check(!/composeAnnouncementPoster[\s\S]{0,900}rankPlate/.test(posterSrc),'На афише анонса нет плашки места в дивизионе');
 check(!/composeAnnouncementPoster[\s\S]{0,900}formSvg/.test(posterSrc),'На афише анонса нет формы W/L');
 check(/\$\{note\?`<text[\s\S]{0,200}esc\(note\)/.test(posterSrc),'Комментарий, если задан, ложится строкой на афишу');

 const botSrc2=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/export async function prepareAnnouncementForAdmin/.test(botSrc2),'Отправка анонса в чат админов вынесена отдельной функцией');
 check(/rememberPosterVariant\(jobId,variant,\{fileId,buffer:finalBuffer,comment:job\.comment,createdAt:new Date\(\)\.toISOString\(\),player1,player2\}\)/.test(botSrc2),'Игроки анонса запоминаются в run — слот матча не нужен для публикации');
 check(/data\.startsWith\('announce:ig:'\)/.test(botSrc2),'Публикация анонса в сторис — своя кнопка');
 check(/pseudoSlot=\{from_telegram_id:saved\.player1\?\.telegram_id/.test(botSrc2),'Для отметок в Instagram собирается облегчённый слот из памяти');

 const idxSrc2=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/app\.post\('\/api\/match\/announce-poster'/.test(idxSrc2),'Есть endpoint запуска афиши из мини-приложения');
 check(/if\(!v\.isAdmin\)return res\.status\(403\)\.json\(\{ok:false,error:'admin_required'\}\)/.test(idxSrc2.slice(idxSrc2.indexOf("'/api/match/announce-poster'"))),'Запускать афишу может только админ');

 const matchHtml2=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 check(/function renderAnnouncePanel/.test(matchHtml2),'В админской вкладке есть блок создания афиши');
 check(/function submitAnnouncePoster/.test(matchHtml2),'Отправка формы анонса реализована');
 check(/\/api\/match\/announce-poster'/.test(matchHtml2),'Форма анонса стучится в новый endpoint');
 check(/comboBox\('annP1'/.test(matchHtml2)&&/comboBox\('annP2'/.test(matchHtml2),'Игроки для анонса выбираются тем же комбобоксом, что и везде');
}

// --- Тема и язык во всех мини-приложениях -----------------------------------
{
 const pub=f=>fs.readFile(path.join(root,'public',f),'utf8');
 const prefs=await pub('ptf-prefs.js');
 check(/ptf_theme/.test(prefs)&&/ptf_lang/.test(prefs),'Тема и язык хранятся на устройстве под общими ключами');
 check(/\/api\/ui-language',\{method:'POST'/.test(prefs),'Смена языка уходит на сервер, в анкету');
 check(/j\.lang_source==='profile'/.test(prefs),'Язык из анкеты главнее выбора на устройстве');
 check(/lang\?'EN':'RU'|lang==='ru'\?'EN':'RU'/.test(prefs),'На кнопке — язык, на который переключимся, как в Fantasy');
 for(const f of ['league.html','match.html','apply.html','participants.html','tournament.html','admin.html','fantasy.html'])
  check(/<script src="\/public\/ptf-prefs\.js"><\/script>/.test(await pub(f)),f+' подключает общий переключатель');
 for(const f of ['league.html','match.html','apply.html','participants.html'])
  check(/PTFPrefs\.mount\(/.test(await pub(f))&&/id="thSw"/.test(await pub(f)),f+': переключатель темы и языка в шапке');
 check(/PTFPrefs\.mount\(document\.getElementById\('thSw'\),\{lang:false\}\)/.test(await pub('admin.html')),'В админке только тема — её не переводим');
 check(/PTFPrefs\.mount\(document\.getElementById\('thSw'\),\{lang:false\}\)/.test(await pub('tournament.html')),'В турнирах только тема');
 check(/html\[data-theme="light"\]/.test(await pub('apply.html'))&&/html\[data-theme="light"\]/.test(await pub('participants.html'))&&/html\[data-theme="light"\]/.test(await pub('admin.html')),'У анкеты, состава и админки есть светлая тема');
 check(/PTFPrefs\.resolveLang\(j\)/.test(await pub('league.html'))&&/PTFPrefs\.resolveLang\(j\)/.test(await pub('match.html')),'Лига и матчи берут язык через общее правило');
 check(/saved\.then\(function\(\)\{location\.reload\(\)\}\)/.test(await pub('league.html')),'Лига перезагружается только после записи языка в анкету');
 check(/PTFPrefs\?\.setLang\(ru\?'ru':'en'\)/.test(await pub('fantasy-onboarding.js')),'Язык в Fantasy теперь запоминается');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/app\.post\('\/api\/ui-language'/.test(idx),'Есть запись языка из мини-приложения');
 check(/if \(!profile\) return res\.json\(\{ ok:true, lang, saved:false \}\)/.test(idx),'Без анкеты новую строку не создаём');
 check(/lang_source:body\.lang_source/.test(idx),'Сервер сообщает, откуда взят язык');
 const r1=await request('post','/api/ui-language','1',{lang:'ru'});
 check(r1.code===200&&r1.body.ok,'Смена языка отвечает без ошибок');
}

// --- «Контроль»: подтверждение за игрока, а не «нужно ваше» -----------------
{
 const match=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 check(/function adminOnlyConfirm\(s\)\{return isAdmin&&!amPlayer\(s\)\}/.test(match),'Админ отличает свои матчи от чужих');
 check(/adminOnlyConfirm\(s\)\?X\.awaitingPlayer:X\.pendingApproval/.test(match),'В чужом матче — «ждёт подтверждения игрока»');
 check(/adminOnlyConfirm\(s\)\?X\.confirmForPlayer:X\.confirmResult/.test(match),'Кнопка подписана как ручное подтверждение за игрока');
}

// --- /announce и клавиатура без Fantasy --------------------------------------
{
 const tg=await fs.readFile(path.join(root,'telegram.js'),'utf8');
 check(/cmd:'announce'/.test(tg),'Команда /announce в едином списке — попадает и в /help, и в меню по слэшу');
 const botSrc3=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/\/\^\\\/announce/.test(botSrc3),'Бот понимает /announce');
 check(/findRosterPlayer\(roster,parts\[0\]\)/.test(botSrc3),'Игроки ищутся по составу лиги, как в /test_match');
 const kbSrc=await fs.readFile(path.join(root,'keyboards.js'),'utf8');
 check(/k !== 'fantasy'/.test(kbSrc)&&!/make\('fantasy'\)/.test(kbSrc),'Кнопки Fantasy в клавиатуре чата нет');
}

// --- Партнёры: своя таблица, раскладка по столбцам, отдельные кнопки ---------
{
 const cfg=await fs.readFile(path.join(root,'config.js'),'utf8');
 check(/PARTNERS_SPREADSHEET_ID = process\.env\.PARTNERS_SPREADSHEET_ID \|\| '1QjPUpMEcb2bI7N0xsO4xjSeJMqTT_VTGyq1U5waCHO0'/.test(cfg),'Партнёры читаются из таблицы PTF Partners');
 const list=sheets.partnersFromColumns([
  ['Name','Club A','Cafe B','Hidden'],
  ['Description RU','Корты','Кофе'],['Description EN','Courts','Coffee'],
  ['Google Maps','maps.app.goo.gl/x','',''],['Instagram','@club_a','',''],
  ['WhatsApp','+66 81 234 5678','https://wa.me/66899999999',''],
  ['Message','Hi, I am {name}','',''],['Site','','cafe.com',''],
  ['Order','2','1','3'],['Active','','yes','no']]);
 check(list.length===2&&list[0].name==='Cafe B','Каждый столбец — партнёр; порядок по Order; Active=no прячет');
 const club=list.find(p=>p.name==='Club A');
 check(club.maps==='https://maps.app.goo.gl/x'&&club.instagram==='https://instagram.com/club_a','Карта и Instagram — отдельные ссылки, @ник превращается в профиль');
 check(club.whatsapp==='66812345678'&&list[0].whatsapp==='66899999999','WhatsApp — номер или wa.me-ссылка, на выходе цифры');
 check(club.site===''&&list[0].site==='https://cafe.com','Сайт пустой — кнопки нет; без https дописывается');
 check(club.message==='Hi, I am {name}'&&typeof club.message==='string','Сообщение одно, на английском');
 check(club.description.ru==='Корты'&&club.description.en==='Courts','Описание на двух языках');
 const lg=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 for(const k of ['button_maps','button_instagram','button_whatsapp','button_site'])check(lg.includes("partnerLabel('"+k+"'"),'Кнопка '+k+' в карточке партнёра');
 check(!/phone_label/.test(lg),'Номер телефона на экран больше не выводится');
 check(/box\.innerHTML=partners\.map\(partnerCard\)\.join\(''\);/.test(lg),'На вкладке «Партнёры» нет вводной плашки — сразу карточки');
}

// --- Оформление описания партнёра из таблицы --------------------------------
{
 const h=sheets.partnerCellHtml({formattedValue:'Get 10% off <now>',textFormatRuns:[{format:{}},{startIndex:4,format:{bold:true}},{startIndex:7,format:{bold:false,italic:true}},{startIndex:10,format:{italic:false}}]});
 check(h==='Get <b>10%</b><i> of</i>f &lt;now&gt;','Жирный и курсив из таблицы переходят в карточку, остальной текст экранируется');
 check(sheets.partnerCellHtml({formattedValue:'Line 1\n  Line 2',effectiveFormat:{textFormat:{italic:true}}})==='<i>Line 1\n  Line 2</i>','Оформление всей ячейки и отступы сохраняются');
 const withHtml=sheets.partnersFromColumns([['Name','A'],['Description EN','plain']],[['Name','A'],['Description EN','<b>plain</b>']]);
 check(withHtml[0].description_html.en==='<b>plain</b>'&&withHtml[0].description.en==='plain','Описание приходит и простым текстом, и с оформлением');
 const lg=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 check(/var descHtml=partnerText\(p\.description_html\)/.test(lg)&&/white-space:pre-wrap/.test(lg),'Карточка показывает оформление и сохраняет отступы');
 check(/\.pt \.ptimg\{[^}]*object-fit:contain/.test(lg)&&!/\.pt \.ptimg\{[^}]*object-fit:cover/.test(lg),'Картинка партнёра показывается целиком, без обрезки');
 const src=await fs.readFile(path.join(root,'sheets.js'),'utf8');
 check(/textFormatRuns/.test(src)&&/falling back to plain text/.test(src),'Не удалось прочитать оформление — берётся простой текст');
}

// --- Главная: без Fantasy, тестовая главная с бегущими строками -------------
{
 check(sheets.partnerWhatsappNumber('66 0957912772')==='66957912772','Ноль после кода страны убирается — wa.me откроет чат');
 check(sheets.partnerWhatsappNumber('660630135888')==='66630135888'&&sheets.partnerWhatsappNumber('6.60630135888E+11')==='66630135888','Номер-число и номер в виде 6.6E+11 тоже чинятся');
 check(sheets.partnerWhatsappNumber('66 65 650 5195')==='66656505195','Правильный номер не трогаем');
 const lg=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 const home=lg.slice(lg.indexOf('function renderHome(){'),lg.indexOf('function renderHome2(){'));
 check(!/homeFantasyBanner\(\)/.test(home),'Плашки Fantasy на главной больше нет');
 check(!/'home2'/.test(lg),'Тестовая вкладка убрана — всё на настоящей главной');
 check(/partnersStrip\(\)\+homeEvents\(\)\+leadersStrip\(\)\+championsStrip\(\)\+seasonCard\(\)\+statsBlock\(\)\+promotionsStrip\(\)\+igBlock\(\)\+tgBlock\(\)/.test(lg),'Порядок главной: партнёры, событие, лидеры, чемпионы, сезон, цифры, повышения, Instagram, Telegram');
 check(/function mountMarquees/.test(lg)&&/mq-prom/.test(lg)&&/mq-ldr/.test(lg),'Лидеры, чемпионы, повышения и партнёры — бегущими строками');
 check(/\(top\.points\|\|0\)>0/.test(lg),'Лидер без очков не показывается');
 check(/class="live"><i class="ball">🎾<\/i>LIVE/.test(lg)&&/@keyframes ballPulse/.test(lg),'У сезона метка LIVE с пульсирующим мячиком');
 check(/return e\.open_now&&!e\.past/.test(lg)&&/else if\(mode==='home'&&!openId\)renderHome\(\)/.test(lg),'Открытое событие поднимается на главную, как только загрузится');
 check(!/pmq-cat/.test(lg),'В ленте партнёров только логотипы, без рамок и подписей');
 check(/'Чемпионы сезона '\+s\.number:'Season '\+s\.number\+' Champions'/.test(lg),'Блок называется «Чемпионы сезона N»');
 check(!/X\.champTag\)\+'<\/div>'/.test(lg)&&!/label\+' '\+X\.leaderTag/.test(lg),'В карточках только дивизион, без повторного «champion/лидер»');
 check(/\(L\?'И ':'G '\)/.test(lg)&&/\(L\?'ОЧК ':'PTS '\)/.test(lg),'У лидеров коротко: игры · победы · очки');
 check(/prefers-reduced-motion: reduce/.test(lg),'При «уменьшить движение» лента сама не едет');
 check(/if\(m\.moved\)\{e\.stopPropagation\(\);e\.preventDefault\(\)/.test(lg),'Перетаскивание не срабатывает как нажатие');
 check(/sz=\)w\\d\+\/,'\$1w400'\)/.test(lg),'В ленту идут уменьшенные логотипы');
 check(/onclick="openPartner\('\+peak\+'\)"/.test(lg)&&/function openPartner\(i\)/.test(lg),'The Peak в блоке сезона ведёт на его карточку партнёра');
 check(/sDatesV:'14 сен – 5 ноя'/.test(lg)&&/sSemiV:'7–8 ноя'/.test(lg),'Даты сезона короткие');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/is_admin: Boolean\(v\.isAdmin && !viewAs\)/.test(idx),'Лига знает, что открыл организатор; в режиме «глазами группы» — нет');
}

// --- «Ждут вашего действия» не повторяется после перезапуска -----------------
{
 const botSrc4=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/if\(!attentionCounts\.has\(id\)\)\{attentionCounts\.set\(id,n\);continue;\}/.test(botSrc4),'После перезапуска первое наблюдение запоминается молча — без повторного сообщения');
 check(/for\(const id of ids\)if\(!attentionCounts\.has\(String\(id\)\)&&previous\[id\]!==undefined\)attentionCounts\.set/.test(botSrc4),'Настоящее изменение матча по-прежнему приносит сообщение');
}

// --- Подтверждение корта: понятно обеим сторонам, кнопка в приложении -----------
{
 const mt=await fs.readFile(path.join(root,'matches.js'),'utf8');
 const mh=await fs.readFile(path.join(root,'public','match.html'),'utf8');
 const ix=await fs.readFile(path.join(root,'index.js'),'utf8');
 const md=await import(pathToFileURL(path.join(root,'matchesdb.js')).href);
 const m=await import(pathToFileURL(path.join(root,'matches.js')).href);
 const now=Date.parse('2026-09-29T10:00:00+07:00');
 check(m.deadlineLabel(Date.parse('2026-09-29T21:26:00+07:00'),'ru',now)==='сегодня до 21:26','Срок по-русски: «сегодня до 21:26»');
 check(m.deadlineLabel(Date.parse('2026-10-01T13:00:00+07:00'),'en',now)==='by 13:00 on 1 Oct','Срок по-английски: «by 13:00 on 1 Oct»');
 const slot={status:'accepted',court_pending_at:'2026-09-28T10:00:00+07:00'};
 check(md.courtCloseAt(slot)>Date.parse(slot.court_pending_at),'Срок автоснятия считается от «ждём корт»');
 check(md.courtCloseAt({...slot,court_confirmed_at:'x'})===0&&md.courtCloseAt({...slot,match_type:'manual'})===0,'После подтверждения корта и у ручных матчей срока нет');
 const agreed=mt.slice(mt.indexOf('export async function notifyMatchAgreed'),mt.indexOf('export async function sendDirectChallenge'));
 check(/match_court_ok:/.test(agreed)&&/не считается согласованным/.test(agreed)&&/снимется автоматически/.test(agreed),'«Матч согласован»: у автора кнопка «Корт подтвердил», объяснение и срок');
 check(/Остался последний шаг/.test(agreed)&&/One step left/.test(agreed),'Сопернику объясняем, чего ждём');
 check(!/до сегодня/.test(mt),'Нет корявого «до сегодня, 21:26»');
 const stuck=mt.slice(mt.indexOf('export async function notifyStuckCourt'),mt.indexOf('export async function notifyStuckTimeChange'));
 check(/stage==='d1'&&oppId/.test(stuck)&&/contactRow\(slot,oppId,lang\)/.test(stuck),'На последнем напоминании соперник тоже получает предупреждение с кнопкой «Написать»');
 check(/app\.post\('\/api\/match\/court-confirm'/.test(ix)&&/notifyCourtConfirmed\(r\.slot\)/.test(ix),'Корт можно подтвердить из мини-приложения — уведомления те же');
 check(/court_close_at: courtCloseAt\(s\)/.test(ix),'Карточка знает срок автоснятия');
 check(/function confirmCourtApp/.test(mh)&&/canRetime\(s\)&&courtPending\(s\)\)b\+='<button class="mini primary" onclick="confirmCourtApp/.test(mh),'В «Моих матчах» у автора есть кнопка «Корт подтвердил»');
 check(/courtMine:'Корт не подтверждён — ваше действие'/.test(mh)&&/courtWait:'Ждём подтверждения корта'/.test(mh),'На карточке видно, кто и что должен сделать с кортом');
}

// --- Английские кнопки у англоязычных игроков, понятные подсказки --------------
{
 const mt=await fs.readFile(path.join(root,'matches.js'),'utf8');
 const pf=await fs.readFile(path.join(root,'pairflow.js'),'utf8');
 const bt=await fs.readFile(path.join(root,'bot.js'),'utf8');
 const map=JSON.parse(mt.match(/const MATCH_BUTTON_EN = (\{.*\});/)[1]);
 const miss=[...mt.matchAll(/text\s*:\s*(['"`])([^'"`]*[А-Яа-яЁё][^'"`]*)\1/g)].map(m=>m[2]).filter(t=>!map[t]&&!/Создать 2 варианта|Добавить комментарий/.test(t));
 check(!miss.length,'Каждая русская кнопка матчей имеет английский перевод'+(miss.length?': '+miss.join(', '):''));
 const m=await import(pathToFileURL(path.join(root,'matches.js')).href);
 const kb=m.timeChoiceKeyboard({challenge_id:'x',agreed_time:'10:00'},'en');
 check(kb.inline_keyboard.at(-1)[0].text==='✖️ Cancel match','Выбор нового времени: кнопка отмены по-английски');
 check(/timeChoiceKeyboard\(slot,lang\)/.test(bt),'Бот передаёт язык в выбор времени');
 check(/async function langOf\(id\)/.test(pf)&&/'✅ Accept'/.test(pf)&&/'💳 I’ll pay'/.test(pf)&&/'👤 Invite someone else'/.test(pf),'Парный турнир: приглашение, отказ и оплата — на языке получателя');
 const direct=mt.slice(mt.indexOf('export async function sendDirectChallenge'),mt.indexOf('export async function declineDirectChallenge'));
 check(!/match_cancel:\$\{slot\.challenge_id\}` \}\]\];/.test(direct.split('const delivered')[0])&&/забронирует корт/.test(direct),'Получателю вызова — без «Отменить запрос», с подсказкой, кто бронирует корт');
 check(/Вызвать другого игрока/.test(mt.slice(mt.indexOf('export async function declineDirectChallenge'))),'После отказа — кнопки «Вызвать другого» и «Мои матчи»');
 check(/Отклик на ваше окно/.test(mt)&&!/твоё окно|Подтверди или предложи/.test(mt),'Отклик на окно — на «вы» и с подсказкой про корт');
 const rem=mt.slice(mt.indexOf('export async function notifyMatchReminder'),mt.indexOf('export async function notifyDeadline'));
 check(/courtRow/.test(rem)&&/снимется автоматически/.test(rem),'Напоминание о матче при неподтверждённом корте: кнопка и срок');
 const acc=mt.slice(mt.indexOf('export async function notifyTimeChangeAccepted'),mt.indexOf('export async function notifyTimeChangeRejected'));
 check(/match_court_ok:/.test(acc),'После переноса времени у автора есть «Корт подтвердил»');
 const exp=mt.slice(mt.indexOf('export async function notifyNegotiationExpired'),mt.indexOf('export async function notifyStuckCourt'));
 check(/scope==='court'&&!booker/.test(exp),'Снятие матча без корта: сопернику свой текст');
 check(/Счёт вносит кто-то один из вас/.test(mt)&&/Only one of you needs to enter the score/.test(mt),'«Матч сыгран?» — счёт вносит один, второй подтверждает');
}

// --- Лимит Google (60 чтений в минуту): рассылка не должна ронять всё остальное ---
{
 const mt=await load('matches.js');
 const src=await fs.readFile(path.join(root,'sheets.js'),'utf8');
 const writeBodies=src.slice(src.indexOf('function forgetSheet'));
 check(!/cache\.clear\(\)/.test(writeBodies.replace(/export function invalidateSheetCache\(\) \{ cache\.clear\(\); \}/,'')),'Запись в лист больше не сбрасывает кэш всех листов');
 sheets.invalidateSheetCache();
 await sheets.getSetting('season_number');
 await sheets.findApplicantByTelegramId('3');
 sheetReads.length=0;
 await sheets.setSetting('rate_test','1');
 await sheets.findApplicantByTelegramId('3');
 check(!sheetReads.includes('crm|Applicants'),'Запись в Settings не заставляет перечитывать Applicants');
 sheets.invalidateSheetCache();sheetReads.length=0;
 await Promise.all([1,2,3,4,5].map(()=>sheets.findApplicantByTelegramId('3')));
 check(sheetReads.filter(k=>k==='crm|Applicants').length===1,'Пять одновременных запросов к листу — одно чтение из Google');
 sheets.invalidateSheetCache();quotaKeys.add('crm|Applicants');
 const carol=await sheets.findApplicantByTelegramId('3').catch(()=>null);
 check(carol?.name==='Carol Three','Лимит Google: анкета берётся из последнего удачного чтения');
 const subs=await sheets.getAllBotSubscribers().catch(()=>null);
 check(Array.isArray(subs)&&subs.some(p=>p.telegram_id==='3'),'Лимит Google: список подписчиков для рассылки берётся из последнего удачного');
 quotaKeys.clear();
 // Сбой без прошлой копии: пустота не запоминается на 5 минут.
 sheets.invalidateLeagueCache();quotaKeys.add('*');
 const photosDown=await sheets.getMasterPhotos().catch(()=>new Map());
 quotaKeys.clear();
 check(photosDown.size>0,'Фото из Players_Master переживают сбой Google (последняя удачная копия)');
 check(/const cacheStamp = /.test(src)&&/FAILED_TTL_MS = 30_000/.test(src),'Пустой результат из-за сбоя живёт 30 секунд, а не 5 минут');
 // Список подписчиков так и не прочитался — админ узнаёт, чей результат не разослан.
 const adminChatWas=await sheets.getSetting('admin_chat_id');await sheets.setSetting('admin_chat_id','-100777');
 const before=messages.length;let tries=0;
 const list=await mt.__subscribersWithRetry({from_name:'Irina S',to_name:'Yana D',score:'6:3 6:4'},[0,0],async()=>{tries++;throw Error("Quota exceeded for quota metric 'Read requests'")});
 await settle();
 check(Array.isArray(list)&&!list.length&&tries===3,'Список подписчиков не читается: три попытки, рассылка не падает');
 check(messages.slice(before).some(m=>/Результат не разослан в личку/.test(JSON.stringify(m.args))&&/Irina S/.test(JSON.stringify(m.args))),'Админ получает сообщение, чей результат не ушёл в личку');
 tries=0;
 const ok=await mt.__subscribersWithRetry({},[0,0],async()=>{if(++tries<2)throw Error('Quota exceeded');return [{telegram_id:'3'}]});
 check(ok.length===1&&tries===2,'Вторая попытка удалась — рассылка идёт как обычно');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 const mtSrc=await fs.readFile(path.join(root,'matches.js'),'utf8');
 check(/avatarFileOf\.get\(id\)/.test(idx),'Аватарка на витрине отдаётся по известному файлу, если таблица не читается');
 check(/missingPhotos/.test(mtSrc)&&/Карточка ушла без фото/.test(mtSrc),'Админ узнаёт, что карточка ушла без фото и почему');
 check(/Результат не разослан в личку/.test(mtSrc)&&/SUBSCRIBER_RETRY_MS = \[30_000, 60_000, 120_000\]/.test(mtSrc),'Личная рассылка результата ждёт и повторяет, потом пишет админу');
 await sheets.setSetting('admin_chat_id',adminChatWas||'');
}

// --- Лист ожидания → таблица участников («Short Players list», вкладка сезона) ---
{
 const PID='161O5DWEJU-ik3XoDaUjWeTlm7T2Je98IFd_-DFhRBu8',WID='1CZ2-B09kIxegOK1lYVl0KBucjbxxp1ZukMD0t1QQCiY';
 const saved={ev:tables.get('crm|Events'),apps:tables.get('crm|Applications'),appl:structuredClone(tables.get('crm|Applicants')),prof:tables.get(WID+'|Frontend_Profile_All')};
 put('crm','Events',[['event_id','event_name_en','status','event_type'],['league_s2','League Season 2','live','league'],['league_s3','League Season 3','waitlist','league']]);
 put('crm','Applications',[['application_id','telegram_id','player_name','event_id','application_status','submitted_at'],
  ['a1','6','Out Sider','league_s3','application_received','2026-09-01T10:00:00Z'],
  ['a2','4','Dan Four','league_s3','application_received','2026-09-20T10:00:00Z'],
  ['a3','3','Carol Three','league_s3','rejected','2026-08-01T10:00:00Z'],
  ['a4','9','Wendy Three','league_s2','application_received','2026-07-01T10:00:00Z']]);
 const ap=tables.get('crm|Applicants');ap[0].push('ntrp');ap.forEach((r,i)=>{if(i)r[ap[0].length-1]={'4':'4.0','6':'3.0','10':'2.5'}[r[0]]||''});
 put(WID,'Frontend_Profile_All',[['player_id','player_name','matches_played','seasons_played'],['1','Dan Four','7','1'],['2','Out Sider','0','0']]);
 const tpl=[['The division has not yet been formed.'],[''],['','Players','Division Size'],['PRIME','0','8'],['Division A','0','8'],['Division B','0','8'],['Division C','0','8'],['Division D','0','8'],['Division Woman','0','16'],[''],['Name','ntrp','Division','status']];
 put(PID,'Season 3',[...structuredClone(tpl),['Manual Guy','3.5','','waitlist']]);
 put(PID,'Short (копия) 1',[...structuredClone(tpl),['Season Two Player','4.0','Division A','active']]);
 const shortBefore=JSON.stringify(tables.get(PID+'|Short (копия) 1'));
 sheets.invalidateSheetCache();sheets.invalidateLeagueCache();
 const wl=await load('waitlistsync.js');
 const tab=()=>tables.get(PID+'|Season 3');
 const rowOf=(n)=>tab()[10+n]||[];
 let r=await wl.syncWaitlistSeason('3');
 check(r.ok&&r.waitlist===2&&r.tab==='Season 3','Лист ожидания сезона 3 переносится во вкладку «Season 3»');
 check(tab()[10].slice(4,7).join('|')==='telegram_id|applied_at|league_player','Справа дописаны служебные колонки telegram_id, applied_at, league_player');
 check(rowOf(1)[0]==='Dan Four'&&rowOf(1)[1]==='4.0'&&rowOf(1)[3]==='waitlist'&&rowOf(1)[4]==='4'&&rowOf(1)[6]==='yes','Игрок лиги — первым, рейтинг из анкеты, статус waitlist');
 check(rowOf(2)[0]==='Out Sider'&&rowOf(2)[6]==='','Новичок — после игроков лиги, хоть и подал заявку раньше');
 check(rowOf(3)[0]==='Manual Guy'&&!rowOf(3)[4],'Строка, вписанная руками, сохраняется в конце');
 check(!tab().some(x=>x[0]==='Carol Three'),'Отклонённая заявка в список не попадает');
 check(!tab().some(x=>x[0]==='Wendy Three'),'Заявка в идущий сезон (не лист ожидания) в список не попадает');
 check(tab()[3][1]==='0'&&tab()[0][0]==='The division has not yet been formed.','Сводка над таблицей не тронута');
 check(JSON.stringify(tables.get(PID+'|Short (копия) 1'))===shortBefore,'Вкладка другого сезона не тронута');
 // Организатор поставил дивизион и откалибровал рейтинг; пришла новая заявка.
 rowOf(1)[1]='4.5';rowOf(1)[2]='Division A';
 tables.get('crm|Applications').push(['a5','10','Wendy Four','league_s3','application_received','2026-08-15T10:00:00Z']);
 sheets.invalidateSheetCache();
 r=await wl.syncWaitlistSeason('3');
 check(rowOf(1)[0]==='Dan Four'&&rowOf(1)[1]==='4.5'&&rowOf(1)[2]==='Division A','Правки организатора (рейтинг, дивизион) не перезаписываются');
 check(rowOf(2)[0]==='Wendy Four'&&rowOf(3)[0]==='Out Sider'&&rowOf(4)[0]==='Manual Guy','Новички — по дате заявки');
 // Заявку отменили — строка уходит, хвост очищается.
 tables.get('crm|Applications').find(x=>x[0]==='a1')[4]='cancelled';
 sheets.invalidateSheetCache();
 r=await wl.syncWaitlistSeason('3');
 check(r.waitlist===2&&!tab().some(x=>x[0]==='Out Sider')&&rowOf(3)[0]==='Manual Guy'&&!rowOf(4).some(Boolean),'Отменённая заявка удаляется из списка, лишняя строка очищается');
 const twice=JSON.stringify(tab());await wl.syncWaitlistSeason('3');
 check(JSON.stringify(tab())===twice,'Повторная сверка ничего не меняет');
 // Участники сезона: отметка «игрок лиги» доходит до экрана.
 const part=await sheets.getManualParticipants('3');
 check(part.players.find(p=>p.name==='Dan Four')?.league_player===true&&part.players.find(p=>p.name==='Wendy Four')?.league_player===false,'Экран участников знает, кто игрок лиги');
 // Нет вкладки сезона — ничего не пишем в чужую.
 put('crm','Events',[['event_id','event_name_en','status','event_type'],['league_s5','League Season 5','waitlist','league']]);
 tables.get('crm|Applications').push(['a6','4','Dan Four','league_s5','application_received','2026-09-25T10:00:00Z']);
 sheets.invalidateSheetCache();
 const before3=JSON.stringify(tab());
 const all=await wl.syncAllWaitlists();
 check(all.length===1&&all[0].reason==='no_tab'&&JSON.stringify(tab())===before3&&JSON.stringify(tables.get(PID+'|Short (копия) 1'))===shortBefore,'Нет вкладки с номером сезона — ничего не пишем в чужие вкладки');
 check((await wl.syncWaitlistSeason('4')).reason==='no_waitlist_event','Сезон без листа ожидания пропускается');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/const clean = \(\{ telegram_id, \.\.\.p \}\) => p;/.test(idx),'telegram_id участников не уходит в браузер');
 check(/syncWaitlistEntry\(event\)/.test(idx)&&/setImmediate\(\(\) => \(async \(\) => \{/.test(idx),'Заявка: ответ экрану сразу, сообщения и перенос в список — в фоне');
 check(/keepStatus/.test(idx),'Игрок идущего сезона, вставший в лист следующего, остаётся active');
 const adm=await fs.readFile(path.join(root,'admin.js'),'utf8');
 check(/syncWaitlistEntry\(app\.event_id\)/.test(adm),'Отклонение заявки пересобирает список участников');
 check(/cmd:'waitlist_sync', group:'Лига'/.test(telegramSource)&&/text === '\/waitlist_sync'/.test(await fs.readFile(path.join(root,'bot.js'),'utf8')),'Команда /waitlist_sync — в списке команд и в /help');
 // вернуть как было
 if(saved.ev)tables.set('crm|Events',saved.ev);else tables.delete('crm|Events');
 tables.set('crm|Applications',saved.apps);tables.set('crm|Applicants',saved.appl);
 if(saved.prof)tables.set(WID+'|Frontend_Profile_All',saved.prof);
 sheets.invalidateSheetCache();sheets.invalidateLeagueCache();
}

// --- Сайт: страница игрока, сезоны, лист ожидания в мини-приложении и боте ---
{
 const lg=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 check(/\.hero\{display:grid;grid-template-columns:232px minmax\(0,1fr\)/.test(lg)&&/class="hph"/.test(lg),'Компьютер: фото игрока квадратом слева, данные справа, ярлыки не на фото');
 check(/\$\('title'\)\.textContent=L\?'Игрок':'Player';/.test(lg),'В шапке страницы игрока — «Игрок», а не название прошлой вкладки');
 check(/Number\(b\.number\)-Number\(a\.number\)/.test(lg.slice(lg.indexOf('function statsBlock'))),'«PTF в цифрах»: свежий сезон первым');
 check(/s\.players\|\|s\.players_played/.test(lg)&&!/s\.players_played\|\|s\.players\b/.test(lg),'Игроки сезона — весь состав, а не только сыгравшие');
 const trn=lg.slice(lg.indexOf('function renderTournaments'),lg.indexOf('function renderAbout'));
 check(trn.indexOf('next.forEach')<trn.indexOf('live.forEach')&&/trn-nx/.test(trn),'Турниры: лист ожидания сверху скромной плашкой, фокус на идущем сезоне');
 check(/Runner-up/.test(trn)&&/trn-ru/.test(trn),'Турниры: финалист в серебряной рамке рядом с чемпионом');
 const idx=await fs.readFile(path.join(root,'index.js'),'utf8');
 check(/=== 'finished' \? span\.get/.test(idx),'Длительность по матчам — только у завершённого сезона');
 const ab=await fs.readFile(path.join(root,'public','about.html'),'utf8');
 check(/s\.players\|\|s\.players_played\|\|0/.test(ab)&&/\.slice\(\)\.reverse\(\); \/\/ свежий сезон первым/.test(ab),'Лендинг: игроки — весь состав, свежий сезон первым');
 const apx=await fs.readFile(path.join(root,'public','apply.html'),'utf8');
 check(/if\(mode!=='waitlist'\)mode='event';preselectWait\(\)/.test(apx),'Лист ожидания: «Start profile → Continue» больше не путается');
 check(/function cardAction/.test(apx)&&/League tables/.test(apx)&&/startFor\(/.test(apx),'Карточки событий кликабельны: таблицы лиги / встать в лист ожидания');
 check(/function waitIntroText/.test(apx)&&/8 places per division/.test(apx),'Экран листа ожидания объясняет, что это и что нажать');
 check(/!weeks&&ev\.start_date&&ev\.end_date/.test(apx),'Мини-приложение: длительность идущего сезона по датам события');
 const pt=await fs.readFile(path.join(root,'public','participants.html'),'utf8');
 check(/queueSub/.test(pt)&&/league_player/.test(pt)&&/fromMode/.test(pt),'Экран участников: очередь листа ожидания с отметкой «игрок лиги», «Назад» возвращает в лист');
 const bt=await fs.readFile(path.join(root,'bot.js'),'utf8');
 check(/async function sendWaitlistInvite/.test(bt)&&/dest\.code === 'waitlist'/.test(bt),'Бот: развёрнутое сообщение про лист ожидания');
 check(/if \(param\) return handleStartParam\(chatId, selected, from, param/.test(bt),'Бот: после выбора языка ссылка с сайта не теряется');
}

// --- Гость сайта: сезоны и турниры видны без входа, знакомство при каждом заходе ---
{
 const route=routes.find(r=>r.method==='get'&&r.p==='/api/public/events');
 check(Boolean(route),'Есть открытая ручка событий для сайта');
 put('crm','Events',[['event_id','event_name_en','status','event_type','price_thb','payment_link'],['league_s3','League Season 3','waitlist','league','3000','secret-link']]);
 sheets.invalidateSheetCache();
 const res={code:200,status(n){this.code=n;return this},json(v){this.body=v;return this},set(){return this}};
 await route.h({query:{},headers:{}},res);
 check(res.body.ok&&res.body.events.length===1&&res.body.events[0].status_code==='waitlist','Гость видит события лиги без входа');
 check(!('payment_link' in res.body.events[0])&&!('price_thb' in res.body.events[0]),'Гостю уходят только открытые поля события');
 quotaKeys.add('crm|Events');
 const res2={code:200,status(n){this.code=n;return this},json(v){this.body=v;return this},set(){return this}};
 await route.h({query:{},headers:{}},res2);
 quotaKeys.clear();
 check(res2.body.ok&&res2.body.events.length===1,'Лимит Google: события берутся из кеша, вкладка не пустеет');
 tables.delete('crm|Events');sheets.invalidateSheetCache();
 const lg=await fs.readFile(path.join(root,'public','league.html'),'utf8');
 check(/get\('\/api\/public\/events'\)/.test(lg)&&/pubRetried=true;setTimeout\(loadPublicExtras,4000\)/.test(lg),'Вкладка «Турниры» берёт события из открытой ручки и переспрашивает при сбое');
 check(/sessionStorage\.getItem\('ptf_intro_seen'\)/.test(lg)&&/Seasons and the waitlist/.test(lg),'Знакомство гостю — при каждом заходе на сайт, со ссылкой на сезоны и лист ожидания');
}

console.log(`PASS: ${checks} regression checks; all Sheets and Telegram operations were mocked.`);
