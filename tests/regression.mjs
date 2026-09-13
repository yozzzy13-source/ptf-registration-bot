import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// In-memory Sheets and Telegram. No credentials, network, bot startup or writes
// to real spreadsheets are involved. Run: node --experimental-vm-modules tests/regression.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
synthetic(path.join(root,'telegram.js'),Object.fromEntries(telegramNames.map(n=>[n,n.endsWith('COMMANDS')?{}:n==='ADMIN_COMMAND_LIST'?[]:async(...args)=>{messages.push({method:n,args});if(n==='sendPhotoBuffer')return {photo:[{file_id:'generated-card'}]};if(n==='getMe')return {username:'test_bot'};return {}}])));
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
check((await db.confirmCourt('old',{telegram_id:'2'})).ok,'Opponent confirms court');
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
check(messages.some(m=>m.method==='sendMessage'&&String(m.args[0])==='2'&&m.args[1].includes('Бронирование матча не завершено')),'Court reminder sent in RU to second player');
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
console.log(`PASS: ${checks} regression checks; all Sheets and Telegram operations were mocked.`);
