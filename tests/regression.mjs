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
  ['match','p1_id','player_1','p2_id','player_2','s1p1','s1p2','s1tb1','s1tb2','s2p1','s2p2','s2tb1','s2tb2','s3p1','s3p2','s3tb1','s3tb2','set3_mode','played'],
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
synthetic(path.join(root,'telegram.js'),Object.fromEntries(telegramNames.map(n=>[n,n.endsWith('COMMANDS')?{}:n==='ADMIN_COMMAND_LIST'?[]:async(...args)=>{if(n==='sendMessage'&&String(args[0])===telegramFailureId)throw Error('blocked test recipient');messages.push({method:n,args});if(n==='sendPhotoBuffer')return {photo:[{file_id:'generated-card'}]};if(n==='getMe')return {username:'test_bot'};return {}}])));
synthetic('express',{default:Object.assign(()=>({use(...x){middleware.push(x)},get(p,h){routes.push({method:'get',p,h})},post(p,h){routes.push({method:'post',p,h})},listen(){}}),{json:()=>()=>{},urlencoded:()=>()=>{},static:()=>()=>{}})});
const cardModule=synthetic(path.join(root,'matchcard.js'),{cardForSlot:async()=>Buffer.from('generated-card')});
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
const result2={division:'Division C',season:'2',group:'2',from_name:'Carol Three',to_name:'Dan Four',from_telegram_id:'3',to_telegram_id:'4',agreed_date:'2099-09-14',result_score:'6:4 6:3',result_winner:'3'};
const before=writes.length;const write=await results.writeConfirmedResult(result2);
check(write.status==='saved'&&write.division.status==='saved','Confirmed group 2 score written');
check(writes.slice(before).some(w=>w.spreadsheetId==='c2')&&!writes.slice(before).some(w=>w.spreadsheetId==='c1'),'Only correct group table receives result');
const dup=await results.writeConfirmedResult(result2);check(dup.status==='duplicate','Repeat result does not append duplicate');
const mixed=await results.writeConfirmedResult({...result2,to_name:'Alice One',to_telegram_id:'1'});check(mixed.status==='error','Group mismatch cannot be recorded');
check((await results.getUnplayedOpponents('C','Alice One','2','1')).names.includes('Bob Two'),'Schedule uses group 1');
check((await results.getUnplayedOpponents('C','Carol Three','2','2')).played===1,'Schedule uses group 2 result');
const server=await load('index.js');
const util=await load('util.js');
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
check((await request('get','/api/league/division','1')).code!==403,'Inactive master member may view league');
const errorRu=await request('post','/api/match/create','2',{});check(/[а-я]/i.test(errorRu.body.error),'RU validation error');
const errorEn=await request('post','/api/match/create','1',{});check(!/[а-я]/i.test(errorEn.body.error),'EN validation error');
check(routes.filter(r=>r.p==='/cal').length===1,'Only one calendar route');
for(const letter of ['C','W']) {
 const view=await request('get','/api/league/division','1',{letter,season:'2'});
 check(view.body.groups?.length===2,letter+' API returns both groups');
 check(view.body.groups.every(g=>g.grouped&&!g.playoff.champion&&g.players.every(p=>!p.zone)),letter+' groups do not award final promotion or playoffs');
}
const cross=await results.writeConfirmedResult({...result2,to_name:'Wendy Three',to_telegram_id:'9'});
check(cross.status==='cross_division_blocked','Existing admin approval for cross-division results preserved');
const matches=await load('matches.js');messages.length=0;
await matches.publishOpenSlot({...slot,challenge_id:'private',season:'2',group:'1'});
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='🎾 Играю'),'Open slot reaches the same group with RU button');
check(!messages.some(m=>m.method==='sendMessage'&&['3','4','7','8','9','10'].includes(String(m.args[0]))),'Open slot is not sent to other groups or divisions');
messages.length=0;
await matches.broadcastResult({...result2,challenge_id:'broadcast',result_photo_file_id:'user-photo'});
check(messages.some(m=>m.method==='sendPhotoBuffer'),'Result card generated despite user photo');
check(messages.some(m=>m.method==='sendPhoto'&&m.args[1]==='user-photo'),'User photo delivered additionally');
check(messages.some(m=>/sendPhoto/.test(m.method)&&String(m.args[0])==='2'&&/Результат/.test(m.args[m.method==='sendPhotoBuffer'?3:2]?.caption||'')),'RU result caption uses recipient language');
check(messages.some(m=>/sendPhoto/.test(m.method)&&String(m.args[0])==='3'&&/Match Result/.test(m.args[m.method==='sendPhotoBuffer'?3:2]?.caption||'')),'EN result caption uses recipient language');
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
check((await request('get','/api/match/admin-active','1')).code===403,'Admin active-request list rejects a player');
const adminActive=await request('get','/api/match/admin-active','99');
check(adminActive.body.ok&&adminActive.body.items.some(x=>x.challenge_id==='cancel-open'),'Admin sees active requests across divisions');

const scopes={
 initial:{...base,status:'open',match_type:'direct'},
 negotiation:{...base,status:'pending',pending_by:'2'},
 court:{...base,status:'accepted'},
 time:{...base,status:'accepted',time_change:'12:00|1|'+iso(started)},
 result:{...base,status:'accepted',result_status:'pending',result_by:'1',result_submitted_at:iso(started)},
 score:{...base,status:'accepted',court_confirmed_at:iso(started),result_prompt_sent_at:iso(started)}
};
for(const [name,fixture] of Object.entries(scopes)) {
 check(!db.stuckItem(fixture,started+19*60000),name+' no reminder before 20 minutes');
 for(const [minutes,stage] of [[20,'m20'],[120,'n1'],[240,'n2'],[1440,'d1'],[1680,'close']]) {
   const item=db.stuckItem(fixture,started+minutes*60000);
   check(item?.stage===stage&&item.scope===(name==='initial'?'negotiation':name),name+' reaches '+stage);
 }
}
check(db.stuckItem(scopes.initial,started+20*60000).waiting.id==='2','Initial direct challenge reminds recipient');
check(db.stuckItem(scopes.negotiation,started+20*60000).waiting.id==='1','Counter-proposal reminds other side');
check(!db.stuckItem({...base,status:'open',to_telegram_id:''},started+28*hour),'Unclaimed open window does not spam every opponent');
check(!db.stuckItem({...scopes.court,court_confirmed_at:iso(started)},started+2*hour),'Confirmed court stops booking reminders');
check(!db.stuckItem({...scopes.result,result_status:'confirmed'},started+2*hour),'Confirmed score stops reminders');
check(!db.stuckItem({...scopes.result,result_status:'disputed'},started+2*hour),'Disputed score does not trigger court expiration');
check(db.stuckItem({...scopes.court,time_change:scopes.time.time_change},started+2*hour).scope==='time','Court reminders pause during rescheduling');
check(db.stageFor(2,['m20','n1'])==='','Do not replay earlier reminder stages');
await db.createSlot(scopes.initial);
check((await db.listStuck(started+14*hour)).length===0,'Night hold suppresses staged reminders');
let item=db.stuckItem(scopes.initial,started+4*hour);
await db.markStuckNudge('remind','negotiation','n2',item);
check((await db.findSlot('remind')).nudge_sent==='m20,n1,n2','Night catch-up marks earlier stages instead of sending a burst');
await db.updateSlot('remind',{nudge_sent:''});
messages.length=0;
await server.runStuckNudges(started+20*60000);
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[1].includes('Согласование матча не завершено')),'Scheduler sends first reminder in recipient language');
const sentAt20=messages.length;
await server.runStuckNudges(started+25*60000);
check(messages.length===sentAt20,'Next scheduler tick does not repeat delivered reminder');
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
await server.runStuckNudges(started+20*60000);
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
console.log(`PASS: ${checks} regression checks; all Sheets and Telegram operations were mocked.`);
