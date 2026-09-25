import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// In-memory Sheets and Telegram. No credentials, network, bot startup or writes
// to real spreadsheets are involved. Run: node --experimental-vm-modules tests/regression.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let telegramFailureId='';
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
async function get({spreadsheetId,range}){
 const r=rangeInfo(spreadsheetId,range),rows=tables.get(r.key);
 if(!rows)throw Error('Missing test sheet '+r.key);
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
 process:{env:{BOT_TOKEN:'test-token',PUBLIC_URL:'https://app.test',SPREADSHEET_ID:'crm',DIVISIONS_SPREADSHEET_ID:'master',LEAGUE_RESULTS_SHEET_ID:'master',MATCHES_SPREADSHEET_ID:'matches',ADMIN_IDS:'99',NODE_ENV:'production'}},
 setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>({unref(){}}),
 fetch:()=>{throw Error('Unexpected network access')}
});
const modules=new Map();
function synthetic(key,values){const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v)},{context,identifier:key});modules.set(key,m);return m;}
synthetic(path.join(root,'google.js'),{sheets:()=>google});
const telegramSource=await fs.readFile(path.join(root,'telegram.js'),'utf8');
const telegramNames=[...telegramSource.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1]);
synthetic(path.join(root,'telegram.js'),Object.fromEntries(telegramNames.map(n=>[n,n.endsWith('COMMANDS')?{}:n==='ADMIN_COMMAND_LIST'?[]:async(...args)=>{if(n==='sendMessage'&&String(args[0])===telegramFailureId)throw Error('blocked test recipient');if(n!=='withBulkRetries')messages.push({method:n,args});if(n==='withBulkRetries')return typeof args[0]==='function'?args[0]():undefined;if(n==='sendPhotoBuffer')return {photo:[{file_id:'generated-card'}]};if(n==='getMe')return {username:'test_bot'};return {}}])));
synthetic('express',{default:Object.assign(()=>({use(...x){middleware.push(x)},get(p,h){routes.push({method:'get',p,h})},post(p,h){routes.push({method:'post',p,h})},listen(){}}),{json:()=>()=>{},urlencoded:()=>()=>{},static:()=>()=>{}})});
const cardContexts=new Map();
const cardModule=synthetic(path.join(root,'matchcard.js'),{cardForSlot:async()=>Buffer.from('generated-card'),rememberCardContext:(id,data)=>cardContexts.set(String(id),data)});
async function getModule(spec,ref){
 const key=spec.startsWith('.')?path.resolve(path.dirname(ref.identifier),spec):spec;
 if(modules.has(key))return modules.get(key);
 if(!key.startsWith(root)){
  const imported=await import(spec==='luxon'?pathToFileURL(path.join(root,'node_modules/luxon/build/node/luxon.js')).href:spec);
  return synthetic(key,imported);
 }
 const source=await fs.readFile(key,'utf8');
 const m=new vm.SourceTextModule(source,{context,identifier:key,initializeImportMeta(meta){meta.url='file:///'+key.replaceAll('\\','/')},importModuleDynamically:async(spec,ref)=>{const d=await getModule(spec,ref);if(d.status==='unlinked')await d.link(getModule);if(d.status==='linked')await d.evaluate();return d;}});
 modules.set(key,m);return m;
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

await matches.publishOpenSlot({...slot,challenge_id:'private',season:'2',group:'1'});
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='🎾 Играю'),'Open slot reaches the same group with RU button');
check(!messages.some(m=>m.method==='sendMessage'&&['3','4','7','8','9','10'].includes(String(m.args[0]))),'Open slot is not sent to other groups or divisions');
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
 const stages=name==='score'?[[1680,'close']]:[[15,'m20'],[120,'n1'],[240,'n2'],[1440,'d1'],[1680,'close']];
 for(const [minutes,stage] of stages) {
   const item=db.stuckItem(fixture,started+minutes*60000);
   check(item?.stage===stage&&item.scope===(name==='initial'?'invite':name),name+' reaches '+stage);
 }
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
messages.length=0;await matches.publishOpenSlot({...slot,challenge_id:'ru-author',season:'2',group:'1',from_telegram_id:'2',from_name:'Bob Two'});
check(messages.some(m=>String(m.args[0])==='1'&&m.args[1].includes('Looking for a match')&&!/[а-яё]/i.test(m.args[1])),'Russian author window has English body and dates for English recipient');
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
put('crm','Broadcasts',[['broadcast_id','message_text','sent_count']]);put('crm','Broadcast Logs',[['broadcast_id','telegram_id','status','language']]);
messages.length=0;const delivered=await request('post','/api/admin/broadcast','99',{initData:adminInit,message_ru:'Привет {matches}',message_en:'Hello {matches}',filters:{selected_ids:['1','2']}});
check(delivered.body.ok&&delivered.body.sent===2,'Bilingual panel broadcast reaches both language groups');
check(messages.some(m=>String(m.args[0])==='1'&&m.args[1]==='Hello')&&messages.some(m=>String(m.args[0])==='2'&&m.args[1]==='Привет'),'Recipients receive only selected text, not both variants');
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
const invite = await request('get','/api/league/bootstrap','777');
check(invite.code===403&&(invite.body?.code==='profile_required'||invite.body?.error==='profile_required'),'Без анкеты лига отдаёт код profile_required, а не переведённый текст');
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
 check(trn.sheetName('entries',true).endsWith(' TEST'),'Тестовые листы помечены суффиксом');
 const sandbox=await trn.createTournament({name:'Песочница',kind:'singles'},admin,true);
 check((await trn.listTournaments(true)).length===1,'В тестовом режиме свой список турниров');
 check((await trn.listTournaments(false)).every(x=>x.tournament_id!==sandbox.tournament_id),'Тестовый турнир не попал в боевой список');
 check((await trn.listTournaments(false)).length===3,'Боевой список не изменился от записей в тест');
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

 // Свежие матчи сверху во всех трёх списках.
 check(/function byFreshest/.test(match),'Есть единая сортировка списков матчей');
 check(/byFreshest\(myMatches\)/.test(match)&&/byFreshest\(resultTasks\)/.test(match),'Мои матчи и результаты идут от свежего к старому');
 check(/adminMatchTime\(b\)-adminMatchTime\(a\)/.test(match),'Админская вкладка тоже развёрнута свежими вверх');
 check(/sortableDate\(b\.date\)-sortableDate\(a\.date\)/.test(league),'Лента лиги сортируется по дате, а не по номеру матча');
 check(/function sortableDate/.test(league),'Дата приводится к числу: «01.09» не встаёт выше «12.08»');

 // Поиск с выпадающим списком во всех трёх местах лиги.
 check(/function sugBox/.test(league),'Есть общий конструктор поля поиска');
 for(const [id,handler] of [['rq','race'],['pq','plr'],['fq','feed']]){
  check(new RegExp(`sugBox\\('${id}'`).test(league),'Поле '+id+' собрано через общий конструктор');
  for(const suffix of ['Set','Pick','Focus','Blur'])
   check(new RegExp(`function ${handler}${suffix}\\(`).test(league),'Обработчик '+handler+suffix+' определён');
 }
 check(/Focus\(\)\{[a-zA-Z]+SugOpen=true/.test(league),'Список открывается целиком по нажатию, а не только при вводе');
 check(!/function setPQuery|function pickPQ|function setRaceQuery|function setFQuery/.test(league),'Старые обработчики поиска убраны, двух путей к одному полю не осталось');

 // Игрок в ручном матче выбирается из списка или набирается руками.
 check(/list="mPlayerList"/.test(match)&&/<datalist id="mPlayerList">/.test(match),'Игрок в ручном матче выбирается из выпадающего списка');
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
 check(/const SPONSOR_FILE=path\.join\(ASSETS_DIR,'sponsors\.png'\)/.test(src),'Спонсоры читаются из assets/sponsors.png');
 check(/hasSponsors\?/.test(src),'Без файла спонсоров плашка не рисуется');

 const poster=await import(pathToFileURL(path.join(root,'matchposter.js')).href);
 check(poster.sponsorsAvailable()===false,'Файла спонсоров сейчас нет — и это не ошибка');
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
 check(/SEASON PARTNERS/.test(src),'Подпись плашки спонсоров английская');
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
 check(/2 matches played/.test(caption)&&/4 players on court/.test(caption),'В подписи настоящие цифры недели');
 check(/@alice\.t @carol\.t/.test(caption),'Игроки, давшие согласие, упомянуты в подписи');
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
 check(/prepared\.images\.slice\(0, CAROUSEL_MAX\)/.test(src),'Лимит Instagram применяется только при публикации');
 check(/for \(let i = 0; i < prepared\.images\.length; i \+= 10\)/.test(src),'Карточки уходят в Telegram пачками по десять — сколько бы их ни было');
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
 check(/sponsor:\{ x:88, y:1578, w:904, h:228/.test(poster),'Плашка спонсоров компактнее и ниже');
 const panelBottom=1120+424, sponsorBottom=1578+228;
 check(sponsorBottom<1920*0.95,'Спонсоры не заходят в нижние 5%, закрытые интерфейсом Stories');
 check(panelBottom<1578,'Плашки не накладываются друг на друга');
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
 check(/Photos sent in by the players themselves/.test(cap),'Подпись говорит, что фото прислали сами игроки');
 check(/@a\.t/.test(cap)&&cap.includes(pub3.CAROUSEL_HASHTAGS.join(' ')),'В подписи есть упоминания и хэштеги');
 check(!/[А-Яа-я]/.test(cap),'Подпись к фотопосту без русского текста');
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
 check(/data === 'igweek:go' \|\| data === 'igphotos:go'/.test(bot3),'Обе подборки публикуются одним обработчиком');
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
 // Подпись берёт даты из отрезка, а не из «сегодня».
 const cap=pub4.carouselCaption([{slot:{from_name:'A',to_name:'B',division:'C'}}],exact,[]);
 check(/05 Jan — 11 Jan/.test(cap),'В подписи стоят даты выбранного отрезка');

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

console.log(`PASS: ${checks} regression checks; all Sheets and Telegram operations were mocked.`);
