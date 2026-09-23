
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {SHEETS} from '../config.js';
import * as tennis from '../tennis.js';
import * as model from '../public/fantasy-model.js';

const settings=new Map(Object.entries({FANTASY_MODE:'TEST',FANTASY_SEASON:'2',FANTASY_BUDGET:'88',FANTASY_TEAM_SIZE:'8',FANTASY_TRANSFERS:'2',FANTASY_TEST_ENTRY_OPEN:'on',FANTASY_ENTRY_OPEN:'on',FANTASY_DEADLINE:'2026-09-20T08:00:00+07:00',FANTASY_TEST_ENTRY_DEADLINE:'2099-01-01T00:00:00Z',FANTASY_TEST_END_AT:'2026-11-09T23:59:59+07:00'}));
const tables=new Map(), writes=[];
let roster=['C:1','C:2','W:1','W:2','PRIME','A','B','A','C:1','PRIME','B','A'].map((pool,i)=>({name:'Player '+i,letter:pool.split(':')[0],group:pool.split(':')[1]||''}));
const originalRoster=structuredClone(roster);
const profiles=roster.map((p,i)=>({id:String(i+1),name:p.name}));
let history=new Map(), sequence=0;
const rows=name=>tables.get(name)||[];
const sheets={
 getSetting:async key=>settings.get(key)||'',
 ensureExtraSheet:async name=>{if(!tables.has(name))tables.set(name,[]);},
 getRows:async name=>({rows:rows(name)}),
 appendObject:async(name,row)=>{const list=rows(name);const next={...row,_rowNumber:list.length+2};list.push(next);tables.set(name,list);writes.push({name,row:next});},
 updateObjectByRow:async(name,num,patch)=>{const row=rows(name).find(r=>r._rowNumber===num);assert.ok(row);Object.assign(row,patch);writes.push({name,row});},
 getLeagueProfiles:async()=>profiles,
 getMasterPlayers:async()=>originalRoster.map(p=>({player_name:p.name})),
 getLeagueMatchHistory:async()=>history,
 findApplicantByTelegramId:async()=>({name:'Player 0'}),
 getPlayerLeagueInfo:async()=>({member:true})
};
const divisions={availableDivisions:async()=>[],divisionGroups:async()=>[],getDivisionTable:async()=>null,latestSeason:async()=>'2',seasonRoster:async()=>({players:roster})};
const context=vm.createContext({console,Date,Map,Set,JSON,Number,String,Boolean,Math,Error,Promise});
function synthetic(values){return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});}
const imports={
 './config.js':synthetic({SHEETS,ADMIN_IDS:['admin']}),
 './sheets.js':synthetic(sheets),
 './division.js':synthetic(divisions),
 './tennis.js':synthetic(tennis),
 './util.js':synthetic({nowISO:()=>new Date().toISOString(),parseSeasonNumber:s=>s,uid:prefix=>prefix+'-'+(++sequence)}),
 './public/fantasy-model.js':synthetic(model)
};
const module=new vm.SourceTextModule(await fs.readFile(new URL('../fantasy.js',import.meta.url),'utf8'),{context});
await module.link(spec=>{assert.ok(imports[spec],spec);return imports[spec];});await module.evaluate();
const f=module.namespace;
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const rejects=async(fn,label)=>{await assert.rejects(fn);checks++;};
const member={telegramId:'1',name:'Player 0',username:'tester',isLeagueMember:true};
check(!(await f.fantasyAccessFor({...member,isLeagueMember:false,isAdmin:true})).allowed,'Admin outside Players_Master denied');
check(!(await f.fantasyAccessFor({...member,isAdmin:true})).allowed,'Admin requires TEST membership too');
check(!(await f.fantasyAccessFor(member)).allowed,'TEST outsider denied');
tables.set(SHEETS.fantasyTesters,[{telegram_id:'1',status:'off'}]);
check(!(await f.fantasyAccessFor(member)).allowed,'Disabled tester denied');
tables.set(SHEETS.fantasyTesters,[{telegram_id:'1',status:'active'}]);
check((await f.fantasyAccessFor(member)).allowed,'Active tester allowed');
tables.set(SHEETS.fantasyTesters,[]);
settings.set('FANTASY_TEST_GROUP','@tester');
check((await f.fantasyAccessFor(member)).allowed,'Settings tester allowed');
settings.set('FANTASY_MODE','LIVE');
check((await f.fantasyAccessFor(member)).allowed,'LIVE master member allowed');
check(!(await f.fantasyAccessFor({...member,isLeagueMember:false})).allowed,'LIVE outsider denied');
settings.set('FANTASY_MODE','OFF');
check(!(await f.fantasyAccessFor({...member,isAdmin:true})).allowed,'OFF denies even administrators');
settings.set('FANTASY_MODE','TEST');

// Every public Fantasy route must deny before reading/writing the catalog.
const routes=new Map();
let viewer={ok:true,user:{id:'1'},profile:{name:'Player 0',telegram_username:'tester'},lang:'en',isPlayersMasterMember:false};
f.registerFantasyRoutes({get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},{viewer:async()=>viewer});
for(const [path,handler]of routes){
 const before=writes.length,res={code:200,status(n){this.code=n;return this;},json(x){this.body=x;}};
 await handler({body:{},query:{}},res);
 check(res.code===403&&res.body.reason==='players_master_required'&&writes.length===before,'Route rejects outsider: '+path);
}
viewer={...viewer,isPlayersMasterMember:true};
settings.set('FANTASY_TEST_GROUP','');
for(const [path,handler]of routes){
 const res={code:200,status(n){this.code=n;return this;},json(x){this.body=x;}};
 await handler({body:{},query:{}},res);check(res.code===403,'TEST route blocked: '+path);
}
settings.set('FANTASY_TEST_GROUP','1');
const bootstrap=await f.getFantasyBootstrap('1','Player 0','en','test');
check(!bootstrap.teams.length&&bootstrap.entry_open&&bootstrap.budget===88,'New player with Settings budget');
const keys=bootstrap.players.map(p=>p.key);
const byName=name=>bootstrap.players.find(p=>p.name===name).key;
const squad=Array.from({length:8},(_,i)=>byName('Player '+i));
const body={team_slot:1,team_name:'First',picks:squad,captain_key:squad[4],vice_key:squad[5],action:'lock'};
check(model.assignSlots(squad,bootstrap.players).slots.every(s=>s.key),'All eight slots assigned');
check(model.selectionIssue([],squad[4],bootstrap.players,88,2,0)==='slot','Wrong slot explained');
check(model.selectionIssue([squad[0]],squad[0],bootstrap.players,88)==='selected','Duplicate explained');
check(model.selectionIssue([],squad[0],bootstrap.players,5)==='budget','Budget explained');
check(model.deadlineReached({lock_at:'2020-01-01'})&&!model.deadlineReached({lock_at:'2099-01-01'}),'Entry deadline boundary');
check(model.seasonFinished({season_end_at:'2020-01-01'})&&!model.seasonFinished({season_end_at:'2099-01-01'}),'Season end boundary');
check(f.FANTASY_DATES.entryDeadline==='2026-09-21T12:00:00+07:00'&&f.FANTASY_DATES.seasonEndAt==='2026-11-09T23:59:59+07:00','Season 2 Thailand campaign dates');
const catalog=await f.buildFantasyCatalog({mode:'test'});
for(const [patch,label]of [
 [{picks:squad.slice(0,7)},'incomplete squad'],
 [{picks:[...squad.slice(0,7),squad[0]]},'duplicate player'],
 [{picks:[...squad.slice(0,7),byName('Player 8')]},'C player in flex'],
 [{vice_key:body.captain_key},'same captain and vice'],
 [{captain_key:'missing'},'captain outside squad']
])await rejects(()=>f.saveFantasyTeam('1','Player 0',{...body,...patch},'en','test'),label);
const draft=await f.saveFantasyTeam('1','Player 0',{...body,picks:squad.slice(0,2),captain_key:'',vice_key:'',action:'draft'},'en','test');
check(draft.team.status==='draft'&&draft.team.picks.length===2,'Partial draft persists');
check((await f.getFantasyBootstrap('1','Player 0','en','test')).teams[0].picks.length===2,'Draft resumes');
await f.saveFantasyTeam('1','Player 0',body,'en','test');
let one=(await f.getFantasyBootstrap('1','Player 0','en','test')).teams[0];
check(one.status==='locked','First team confirmed');
const lockedAt=one.locked_at;
await f.saveFantasyTeam('1','Player 0',{...body,team_name:'Edited',picks:squad.map(k=>k===squad[7]?byName('Player 9'):k)},'en','test');
one=(await f.getFantasyBootstrap('1','Player 0','en','test')).teams[0];
check(one.team_name==='Edited'&&one.locked_at===lockedAt&&one.transfers_used===0,'Confirmed edit before deadline is free and preserves lock time');
await rejects(()=>f.saveFantasyTeam('1','Player 0',{...body,picks:squad.slice(0,2),action:'draft'},'en','test'),'Cannot downgrade locked squad to partial draft');
await f.saveFantasyTeam('1','Player 0',{...body,team_slot:2,team_name:'Second'},'en','test');
let both=(await f.getFantasyBootstrap('1','Player 0','en','test')).teams;
check(both.length===2&&both[0].team_name==='Edited'&&both[1].team_name==='Second','Two independent teams share real players');
await rejects(()=>f.saveFantasyTeam('1','Player 0',{...body,team_slot:3},'en','test'),'Third slot denied');
check(rows(SHEETS.fantasyTeams).length===0&&rows(SHEETS.fantasyTestTeams).length===2,'TEST and LIVE storage isolated');
await rejects(()=>f.transferFantasyPlayer('1',{team_slot:1,player_out_key:squad[4],player_in_key:byName('Player 11')},'en','test'),'No charged transfer before deadline');
settings.set('FANTASY_BUDGET','70');
await rejects(()=>f.saveFantasyTeam('1','Player 0',body,'en','test'),'Settings budget enforced');
settings.set('FANTASY_BUDGET','88');
settings.set('FANTASY_TEST_ENTRY_DEADLINE','2020-01-01T00:00:00Z');
const closed=await f.getFantasyBootstrap('1','Player 0','en','test');
check(closed.locked&&!closed.entry_open&&closed.transfers_open&&closed.competition_open&&!closed.season_finished&&!closed.preview_only,'Entry deadline closes squads but keeps competition and points open');
await rejects(()=>f.saveFantasyTeam('2','Player 0',body,'en','test'),'No first team after deadline');
await rejects(()=>f.saveFantasyTeam('1','Player 0',body,'en','test'),'No edit after deadline');
await rejects(()=>f.saveFantasyTeam('2','Player 0',{...body,team_slot:2},'en','test'),'No second team after deadline');
await f.transferFantasyPlayer('1',{team_slot:2,player_out_key:squad[7],player_in_key:byName('Player 9')},'en','test');
await f.transferFantasyPlayer('1',{team_slot:2,player_out_key:byName('Player 9'),player_in_key:squad[7]},'en','test');
await rejects(()=>f.transferFantasyPlayer('1',{team_slot:2,player_out_key:squad[7],player_in_key:byName('Player 9')},'en','test'),'Third paid transfer rejected');
both=(await f.getFantasyBootstrap('1','Player 0','en','test')).teams;
check(both[0].transfers_used===0&&both[1].transfers_used===2,'Transfer allowances independent');
roster=roster.filter(p=>p.name!=='Player 7');await f.buildFantasyCatalog({mode:'test',fresh:true});
const withdrawn=await f.getFantasyBootstrap('1','Player 0','en','test');
check(withdrawn.teams[1].free_transfer_keys.includes(squad[7]),'Official withdrawal before first match offers free transfer');
const free=await f.transferFantasyPlayer('1',{team_slot:2,player_out_key:squad[7],player_in_key:byName('Player 9')},'en','test');
check(free.forced&&free.team.transfers_used===2,'Forced transfer preserves used count');
history=new Map([[profiles[5].id,[{season:'2',date:'09.11.2026',score:'6:0 6:0',result:'W',opponent:'Player 6',match_no:'1'},{season:'2',date:'10.11.2026',score:'6:0 6:0',result:'W',opponent:'Player 6',match_no:'2'}]]]);
roster=roster.filter(p=>p.name!=='Player 4');await f.buildFantasyCatalog({mode:'test',fresh:true});
const promoted=await f.getFantasyBootstrap('1','Player 0','en','test');
check(promoted.teams[1].points===55.5,'Vice scores x1.5 and matches after 9 November do not change final points');
settings.set('FANTASY_TEST_END_AT','2020-01-02T00:00:00Z');
const finished=await f.getFantasyBootstrap('1','Player 0','en','test');
check(finished.season_finished&&finished.phase==='finished'&&!finished.competition_open&&!finished.transfers_open&&finished.leaderboard.length===2,'Finished competition keeps final standings visible');
await rejects(()=>f.transferFantasyPlayer('1',{team_slot:1,player_out_key:squad[4],player_in_key:byName('Player 9')},'en','test'),'Transfers close after competition end');
settings.set('FANTASY_TEST_END_AT','2026-11-09T23:59:59+07:00');
settings.set('FANTASY_TEST_ENTRY_OPEN','off');
check(!(await f.getFantasyBootstrap('1','Player 0','en','test')).transfers_open,'Settings switch closes transfer actions');
await rejects(()=>f.transferFantasyPlayer('1',{team_slot:1,player_out_key:squad[4],player_in_key:byName('Player 9')},'en','test'),'Closed switch rejects transfer');
settings.set('FANTASY_TEST_ENTRY_OPEN','on');
settings.set('FANTASY_BUDGET','');settings.set('FANTASY_TEAM_SIZE','');settings.set('FANTASY_TRANSFERS','');
const defaults=await f.getFantasyBootstrap('1','Player 0','en','test');
check(defaults.budget===88&&defaults.roster_size===8&&defaults.transfers===2,'Blank Settings use existing defaults');
console.log('PASS: '+checks+' Fantasy flow checks; all Sheets writes mocked.');

