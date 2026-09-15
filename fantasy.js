import { ADMIN_IDS,SHEETS } from './config.js';
import { appendObject,ensureExtraSheet,findApplicantByTelegramId,getLeagueMatchHistory,getPlayerLeagueInfo,getLeagueProfiles,getRows,getSetting,updateObjectByRow } from './sheets.js';
import { availableDivisions,divisionGroups,getDivisionTable,latestSeason,seasonRoster } from './division.js';
import { cellToScore,getSets } from './tennis.js';
import { nowISO,parseSeasonNumber,uid } from './util.js';

export const FANTASY_DEFAULTS=Object.freeze({rosterSize:8,budget:88,maxPerPool:2,transfers:2});
export const FANTASY_SCORING=Object.freeze({appearance:2,win:10,setWon:3,gameWon:1,straightSets:3,bagelSet:2,walkoverWin:5,upset:{2:2,3:4,4:6},captainMultiplier:1.5});
export const FANTASY_PRICING=Object.freeze({base:10,winRate:[[0,19.9,-1],[20,39.9,0],[40,59.9,1],[60,79.9,2],[80,100,3]],regularPlace:{1:2,2:1,3:1},playoff:{champion:2,finalist:1,semifinalist:1},promotionFactor:{same:1,oneLevel:0.5,twoLevels:0.25}});
const TEAM_HEADERS=['team_id','telegram_id','owner_name','team_name','season','status','picks_json','captain_key','vice_key','budget_spent','transfers_used','created_at','updated_at','locked_at'];
const TRANSFER_HEADERS=['transfer_id','team_id','telegram_id','season','player_out_key','player_out_name','player_in_key','player_in_name','price_out','price_in','forced','created_at'];
const TESTER_HEADERS=['telegram_id','telegram_username','player_name','status','notes'];
const RULES={
 ru:{title:'PTF Fantasy — правила',intro:'Каждый участник лиги может собрать одну команду из 8 игроков PTF, включая себя, и получать очки за их реальные матчи второго сезона.',format:'Каждый игрок проводит 7 матчей. В W это 5 матчей внутри своей группы и 2 матча со случайными соперницами другой группы; все матчи считаются одинаково.',squad:'Выберите по одному игроку из PRIME, A, B, обеих групп C и обеих групп W. Восьмой игрок — свободный выбор. Из одной группы можно взять не больше двух игроков.',budget:'Бюджет — 88 кредитов. Цена фиксируется при закрытии составов.',pricing:'Базовая цена — 10. Винрейт даёт от −1 до +3, место в регулярке — до +2, плей-офф — до +2. При переходе выше надбавка уменьшается вдвое за каждый уровень. Дебютанты без истории стоят 10; NTRP не учитывается.',locking:'До дедлайна состав можно сохранять как черновик. После фиксации менять его можно только через разрешённые замены.',captain:'Капитан получает ×1,5. Вице-капитан заменяет его только при официальном снятии капитана до первого матча.',transfers:'После фиксации доступны две замены за сезон. Замена снявшегося до первого матча игрока не расходует лимит.',scoring:'Матч: +2 за участие, +10 за победу, +3 за сет, +1 за гейм, +3 за победу 2:0 и +2 за каждый сет 6:0. Победа над соперником дороже на 2/3/4+ кредита даёт +2/+4/+6. Техническая победа без игры — только +5.',ranking:'Побеждает команда с наибольшим числом очков; в итогах показываются топ-3. При равенстве выше команда с меньшим числом замен, затем зафиксированная раньше.',tip:'Для первого состава возьмите двух проверенных игроков, а остальные места распределите между сбалансированными и недорогими вариантами.'},
 en:{title:'PTF Fantasy — rules',intro:'Every league player may build one team of 8 PTF players, including themselves, and score from their real Season 2 matches.',format:'Every player has 7 matches. In W, that is 5 matches inside the group and 2 against random players from the other group; every match scores the same.',squad:'Pick one player from PRIME, A, B, both C groups and both W groups. The eighth player is a free pick. You may select at most two from one group.',budget:'The budget is 88 credits. Prices freeze when squads lock.',pricing:'Base price is 10. Win rate adds −1 to +3, regular-season position up to +2, and playoffs up to +2. Promotion halves the premium for each level moved up. Debutants with no history cost 10; NTRP is not used.',locking:'You may edit a draft until the deadline. Once locked, the squad changes only through permitted transfers.',captain:'The captain scores ×1.5. The vice-captain takes over only if the captain officially withdraws before playing.',transfers:'You have two transfers after locking. Replacing a player who withdraws before playing does not use one.',scoring:'Match: +2 appearance, +10 win, +3 per set won, +1 per game won, +3 for a 2–0 win and +2 per 6–0 set. Beating a player priced 2/3/4+ higher adds +2/+4/+6. A walkover without play is only +5.',ranking:'The team with the most points wins and the final table highlights the top three. Ties are broken by fewer transfers, then by the earlier lock time.',tip:'For a first squad, use two proven players and fill the rest with balanced lower-priced picks.'}
};
const FANTASY_ERRORS={
 ru:{fantasy_access_denied:'Fantasy пока недоступно для вашего аккаунта.',fantasy_team_locked:'Состав уже зафиксирован. Используйте замену.',fantasy_deadline_passed:'Срок подачи составов уже завершён.',fantasy_team_not_locked:'Сначала зафиксируйте полный состав.',fantasy_invalid_transfer:'Эту замену выполнить нельзя. Проверьте выбранных игроков.',fantasy_no_transfers_left:'Две доступные замены уже использованы.'},
 en:{fantasy_access_denied:'Fantasy is not available for your account yet.',fantasy_team_locked:'Your squad is already locked. Use a transfer.',fantasy_deadline_passed:'The squad deadline has passed.',fantasy_team_not_locked:'Lock a complete squad first.',fantasy_invalid_transfer:'This transfer is not valid. Check the selected players.',fantasy_no_transfers_left:'Both available transfers have already been used.'}
};
function failure(key,lang,code=400){const e=Error(FANTASY_ERRORS[lang==='ru'?'ru':'en'][key]||key);e.code=code;e.error_key=key;return e}
const t=v=>String(v??'').trim();
const nk=v=>t(v).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const n=(v,d=0)=>{const x=Number(String(v??'').replace(',','.'));return Number.isFinite(x)?x:d};
const js=(v,d)=>{try{return JSON.parse(String(v||''))}catch{return d}};
const r1=v=>Math.round(Number(v||0)*10)/10;
export const fantasyPlayerKey=v=>t(v).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'');

export function fantasyWinRateBonus(v){v=n(v);return v<20?-1:v<40?0:v<60?1:v<80?2:3}
export function fantasyRegularBonus(v){v=n(v);return v===1?2:(v===2||v===3?1:0)}
export function fantasyPlayoffBonus(v){v=t(v).toLowerCase();return v==='champion'?2:(v==='finalist'||v==='semifinalist'?1:0)}
export function fantasyTransitionFactor(a,b){
 a=t(a).toUpperCase();b=t(b).toUpperCase();
 if(!a||!b||a===b||(a==='D'&&b==='W'))return 1;
 const rank={D:0,C:1,B:2,A:3,PRIME:4};
 return rank[a]===undefined||rank[b]===undefined||rank[b]<=rank[a]?1:0.5**(rank[b]-rank[a]);
}
export function fantasyPriceBreakdown(h,current,override){
 const explicit=override!==''&&override!==undefined&&Number.isFinite(Number(override));
 if(explicit){const final=Math.max(1,Math.round(Number(override)));return{base:10,win_rate_bonus:0,regular_bonus:0,playoff_bonus:0,premium:0,transition_factor:1,adjusted_premium:final-10,override:true,final}}
 if(!h||n(h.matches)<1)return{base:10,win_rate_bonus:0,regular_bonus:0,playoff_bonus:0,premium:0,transition_factor:1,adjusted_premium:0,override:false,debutant:true,final:10};
 const winRate=fantasyWinRateBonus(h.winRate),regular=fantasyRegularBonus(h.place),playoff=fantasyPlayoffBonus(h.playoff),premium=winRate+regular+playoff,factor=fantasyTransitionFactor(h.division,current),adjusted=Math.round(premium*factor),final=Math.max(7,Math.min(16,10+adjusted));
 return{base:10,win_rate_bonus:winRate,regular_bonus:regular,playoff_bonus:playoff,premium,transition_factor:factor,adjusted_premium:adjusted,override:false,debutant:false,final};
}
export function fantasyPrice(h,current,override){return fantasyPriceBreakdown(h,current,override).final}
function playoffResult(table,name){
 const key=nk(name),p=table?.playoff||{},names=x=>[x?.first?.name,x?.second?.name].filter(Boolean).map(nk);
 if(nk(p.champion?.name)===key)return'champion';
 if(names(p.final).includes(key))return'finalist';
 if(names(p.sf1).concat(names(p.sf2)).includes(key))return'semifinalist';
 return'';
}
async function previousIndex(season){
 const prev=String(Math.max(1,Number(season||2)-1)),out=new Map();
 for(const letter of await availableDivisions(prev).catch(()=>[])){
  const groups=await divisionGroups(letter,prev).catch(()=>[]),variants=groups.length?groups.map(x=>x.group):[''];
  for(const group of variants){
   const table=await getDivisionTable(letter,prev,group).catch(()=>null);
   if(!table?.ok)continue;
   for(const p of table.players||[])if(p.name&&n(p.matches)>0)out.set(nk(p.name),{division:String(letter).toUpperCase(),group:t(group),matches:n(p.matches),wins:n(p.wins),losses:n(p.losses),winRate:n(p.winRate),place:n(p.place),playoff:playoffResult(table,p.name)});
  }
 }
 return out;
}
const poolKey=(l,g)=>t(g)?t(l).toUpperCase()+':'+t(g):t(l).toUpperCase();
const poolLabel=(l,g,lang)=>t(g)?'Division '+t(l).toUpperCase()+' · '+(lang==='ru'?'Группа ':'Group ')+t(g):'Division '+t(l).toUpperCase();
function tips(p,lang){
 const ru=lang==='ru',why=[],risks=[];
 if(!p.history){why.push(ru?'Нейтральная цена сохраняет бюджет для лидеров.':'Neutral price leaves budget for proven leaders.');risks.push(ru?'Дебютант: подтверждённой статистики лиги нет.':'Debutant: no confirmed league record.')}
 else{
  if(p.history.winRate>=80)why.push(ru?'Очень высокий процент побед в прошлом сезоне.':'Very high win rate last season.');
  else if(p.history.winRate>=60)why.push(ru?'Стабильный положительный результат.':'Consistent positive record.');
  else if(p.history.winRate>=40)why.push(ru?'Сбалансированный выбор по умеренной цене.':'Balanced pick at a moderate price.');
  else risks.push(ru?'Невысокий процент побед в прошлом сезоне.':'Low win rate last season.');
  if(p.history.playoff==='champion')why.push(ru?'Чемпион дивизиона.':'Division champion.');
  else if(p.history.playoff==='finalist')why.push(ru?'Финалист прошлого сезона.':'Finalist last season.');
  else if(p.history.playoff==='semifinalist')why.push(ru?'Есть опыт плей-офф.':'Has playoff experience.');
  if(p.transition_factor<1)risks.push(ru?'Поднялся в более сильный дивизион: прошлый результат может не повториться.':'Moved up: last season may not repeat.');
 }
 const captain=!p.history?(ru?'Новичку безопаснее не назначать дебютанта капитаном.':'A beginner should avoid captaining an unknown debutant.'):p.price>=13&&p.transition_factor===1?(ru?'Сильный кандидат в капитаны: результат получен на сопоставимом уровне.':'Strong captain: proven at a comparable level.'):p.price>=13?(ru?'Кандидат в капитаны с повышенным риском после перехода.':'Higher-risk captain after promotion.'):(ru?'Скорее игрок состава, чем очевидный капитан.':'Better as a squad pick than an obvious captain.');
 return{why,risks,captain};
}
async function settings(mode='live'){
 const keys=mode==='test'?['fantasy_test_season','fantasy_test_budget','fantasy_test_lock_at']:['fantasy_season','fantasy_budget','fantasy_lock_at'];
 const a=await Promise.all(keys.map(k=>getSetting(k).catch(()=>''))),baseSeason=mode==='test'&&!t(a[0])?await getSetting('fantasy_season').catch(()=>''):a[0],baseBudget=mode==='test'&&!t(a[1])?await getSetting('fantasy_budget').catch(()=>''):a[1];
 return{season:t(baseSeason)||await latestSeason()||'2',budget:Math.max(1,n(baseBudget,88)),lockAt:t(a[2])};
}
let cache={key:'',at:0,value:null};
export async function buildFantasyCatalog({lang='en',fresh=false,mode='live'}={}){
 lang=lang==='ru'?'ru':'en';
 const cfg=await settings(mode),ck=mode+':'+cfg.season+':'+cfg.budget+':'+lang;
 if(!fresh&&cache.value&&cache.key===ck&&Date.now()-cache.at<60000)return cache.value;
 const overrideKey=mode==='test'?'fantasy_test_price_overrides':'fantasy_price_overrides';
 const [roster,profiles,hist,testOverrides,liveOverrides]=await Promise.all([seasonRoster(cfg.season),getLeagueProfiles().catch(()=>[]),previousIndex(cfg.season),getSetting(overrideKey).catch(()=>''),mode==='test'?getSetting('fantasy_price_overrides').catch(()=>''):'']);
 const byName=new Map(profiles.map(p=>[nk(p.name),p])),overrides=js(testOverrides||liveOverrides,{}),seen=new Set(),players=[];
 for(const row of roster.players||[]){
  const key=fantasyPlayerKey(row.name);if(!key||seen.has(key))continue;seen.add(key);
  const h=hist.get(nk(row.name))||null,pf=byName.get(nk(row.name))||{},division=t(row.letter).toUpperCase(),override=overrides[key]??overrides[row.name];
  const priceBreakdown=fantasyPriceBreakdown(h,division,override),p={key,name:row.name,division,group:t(row.group),pool:poolKey(division,row.group),pool_label:poolLabel(division,row.group,lang),photo:pf.photo||'',profile_id:pf.id||'',price:priceBreakdown.final,price_breakdown:priceBreakdown,is_debutant:!h,transition_factor:h?fantasyTransitionFactor(h.division,division):1,history:h};
  p.tips=tips(p,lang);players.push(p);
 }
 players.sort((a,b)=>a.pool.localeCompare(b.pool)||b.price-a.price||a.name.localeCompare(b.name));
 const value={...cfg,mode,rosterSize:8,maxPerPool:2,transfers:2,pools:[...new Set(players.map(p=>p.pool))],players};
 cache={key:ck,at:Date.now(),value};return value;
}
export function validateFantasySelection(input={},catalog,{complete=true,lang='en'}={}){
 const ru=lang==='ru',byKey=new Map((catalog.players||[]).map(p=>[p.key,p])),keys=[...new Set((input.picks||[]).map(x=>typeof x==='string'?x:x?.key).map(t).filter(Boolean))],picks=keys.map(k=>byKey.get(k)).filter(Boolean),errors=[],warnings=[];
 if(keys.some(k=>!byKey.has(k)))errors.push(ru?'Один из игроков больше не входит в состав сезона.':'A selected player is no longer in the season roster.');
 if(keys.length>catalog.rosterSize)errors.push(ru?'Можно выбрать только 8 игроков.':'You may select only 8 players.');
 if(complete&&keys.length!==catalog.rosterSize)errors.push(ru?'Нужно выбрать ровно 8 игроков.':'Select exactly 8 players.');
 const counts={};picks.forEach(p=>counts[p.pool]=(counts[p.pool]||0)+1);
 Object.entries(counts).forEach(([pool,count])=>{if(count>catalog.maxPerPool)errors.push(ru?'Из '+pool+' можно взять не больше двух игроков.':'At most two players may come from '+pool+'.')});
 const missingPools=(catalog.pools||[]).filter(pool=>!counts[pool]);
 if(complete&&missingPools.length)errors.push((ru?'Не представлены группы: ':'Missing groups: ')+missingPools.join(', ')+'.');
 const spent=picks.reduce((s,p)=>s+p.price,0),remaining=catalog.budget-spent;
 if(spent>catalog.budget)errors.push((ru?'Бюджет превышен на ':'Budget exceeded by ')+(spent-catalog.budget)+(ru?' кредитов.':' credits.'));
 const captain=t(input.captain_key),vice=t(input.vice_key);
 if(complete&&(!captain||!keys.includes(captain)))errors.push(ru?'Выберите капитана.':'Choose a captain.');
 if(complete&&(!vice||!keys.includes(vice)))errors.push(ru?'Выберите вице-капитана.':'Choose a vice-captain.');
 if(captain&&vice&&captain===vice)errors.push(ru?'Капитан и вице-капитан должны отличаться.':'Captain and vice-captain must differ.');
 if(byKey.get(captain)?.is_debutant)warnings.push(ru?'Капитан — дебютант без подтверждённой статистики.':'Your captain is an unproven debutant.');
 if(picks.filter(p=>p.is_debutant).length>4)warnings.push(ru?'В составе больше четырёх дебютантов: неопределённость высокая.':'More than four debutants makes the squad highly uncertain.');
 if(remaining>=4&&keys.length===catalog.rosterSize)warnings.push(ru?'Осталось много бюджета — возможно усиление.':'A large budget remains; consider an upgrade.');
 return{ok:!errors.length,errors,warnings,picks,spent,remaining,counts,missingPools};
}
export function scoreFantasyMatch(match={},playerPrice=10,opponentPrice=10){
 const score=t(match.score),result=t(match.result).toUpperCase();
 if(/\bW\/?O\b|WALKOVER|TECH/i.test(score)){const technical=result.startsWith('W')?5:0;return{appearance:0,win:0,sets:0,games:0,straight:0,bagels:0,upset:0,technical,total:technical}};
 const sets=getSets(cellToScore(score));let setWins=0,games=0,bagels=0;
 sets.forEach((s,i)=>{const mtb=i===2&&(s.a>=10||s.b>=10);if(s.a>s.b)setWins++;if(!mtb)games+=Number.isFinite(s.a)?s.a:0;if(!mtb&&s.a===6&&s.b===0)bagels++});
 const won=result.startsWith('W'),diff=n(opponentPrice,10)-n(playerPrice,10),upset=won?(diff>=4?6:diff>=3?4:diff>=2?2:0):0;
 const out={appearance:2,win:won?10:0,sets:setWins*3,games,straight:won&&setWins===2&&sets.length===2&&!/RET/i.test(score)?3:0,bagels:bagels*2,upset,technical:0};
 out.total=out.appearance+out.win+out.sets+out.games+out.straight+out.bagels+out.upset;return out;
}
async function scores(catalog,extras=[]){
 const [history,profiles]=await Promise.all([getLeagueMatchHistory().catch(()=>new Map()),getLeagueProfiles().catch(()=>[])]),profilesByName=new Map(profiles.map(p=>[nk(p.name),p])),all=new Map(catalog.players.map(p=>[p.key,p]));
 for(const raw of extras||[]){if(!raw?.key||all.has(raw.key))continue;const pf=profilesByName.get(nk(raw.name))||{};all.set(raw.key,{key:raw.key,name:raw.name,price:n(raw.price,10),profile_id:pf.id||''})}
 const list=[...all.values()],byName=new Map(list.map(p=>[nk(p.name),p])),out=new Map();
 for(const p of list){
  const seen=new Set(),details=[];let total=0;
  for(const m of (p.profile_id?history.get(String(p.profile_id)):[])||[]){
   if(String(parseSeasonNumber(m.season,m.competition)||'')!==String(catalog.season))continue;
   const id=t(m.match_no)+'|'+nk(m.opponent)+'|'+t(m.date)+'|'+t(m.score);if(seen.has(id))continue;seen.add(id);
   const op=byName.get(nk(m.opponent)),points=scoreFantasyMatch(m,p.price,op?.price||10);total+=points.total;details.push({...m,points});
  }
  out.set(p.key,{key:p.key,name:p.name,total:r1(total),matches:details.length,details});
 }
 return out;
}
async function seasonMatchCount(name,season){
 const [history,profiles]=await Promise.all([getLeagueMatchHistory().catch(()=>new Map()),getLeagueProfiles().catch(()=>[])]);
 const p=profiles.find(x=>nk(x.name)===nk(name));if(!p?.id)return 0;
 const seen=new Set();
 for(const m of history.get(String(p.id))||[]){if(String(parseSeasonNumber(m.season,m.competition)||'')!==String(season))continue;seen.add(t(m.match_no)+'|'+nk(m.opponent)+'|'+t(m.date)+'|'+t(m.score))}
 return seen.size;
}
async function fantasyMode(){const v=t(await getSetting('fantasy_mode').catch(()=>'' )).toLowerCase();return v==='live'?'live':v==='closed'?'closed':'test'}
const storeFor=mode=>mode==='test'?{teams:SHEETS.fantasyTestTeams,transfers:SHEETS.fantasyTestTransfers}:{teams:SHEETS.fantasyTeams,transfers:SHEETS.fantasyTransfers};
async function ensureTesterSheet(){await ensureExtraSheet(SHEETS.fantasyTesters,TESTER_HEADERS)}
async function ensureSheets(mode='test'){const use=storeFor(mode);await Promise.all([ensureExtraSheet(use.teams,TEAM_HEADERS),ensureExtraSheet(use.transfers,TRANSFER_HEADERS)])}
async function testMember(id,name,username=''){
 await ensureTesterSheet();const rows=(await getRows(SHEETS.fantasyTesters)).rows,idKey=t(id),nameKey=nk(name),userKey=nk(String(username||'').replace(/^@/,''));
 return rows.some(r=>{const status=t(r.status||'active').toLowerCase();if(['off','inactive','no','0','disabled'].includes(status))return false;return(idKey&&t(r.telegram_id)===idKey)||(nameKey&&nk(r.player_name)===nameKey)||(userKey&&nk(String(r.telegram_username||'').replace(/^@/,''))===userKey)});
}
export async function fantasyAccessFor({telegramId='',name='',username='',isAdmin=false,isLeagueMember=false}={}){
 const mode=await fantasyMode(),admin=Boolean(isAdmin)||ADMIN_IDS.includes(String(telegramId));
 if(admin)return{allowed:true,mode,is_test:mode==='test',admin:true,reason:'admin'};
 if(mode==='test'){const allowed=Boolean(isLeagueMember)&&await testMember(telegramId,name,username);return{allowed,mode,is_test:true,admin:false,reason:allowed?'tester':'test_only'}}
 if(mode==='live'){const allowed=Boolean(isLeagueMember);return{allowed,mode,is_test:false,admin:false,reason:allowed?'players_master':'players_master_required'}}
 return{allowed:false,mode,is_test:false,admin:false,reason:'closed'};
}
export async function canAccessFantasyByTelegramId(telegramId){
 const profile=await findApplicantByTelegramId(telegramId).catch(()=>null),admin=ADMIN_IDS.includes(String(telegramId)),league=admin?{member:true}:await getPlayerLeagueInfo({...profile,telegram_id:telegramId}).catch(()=>({member:false})),access=await fantasyAccessFor({telegramId,name:profile?.name||'',username:profile?.telegram_username||profile?.telegram||'',isAdmin:admin,isLeagueMember:Boolean(league.member)});
 return access.allowed;
}
async function findTeam(id,season,mode){const use=storeFor(mode);await ensureSheets(mode);return(await getRows(use.teams,{useCache:false})).rows.find(x=>String(x.telegram_id)===String(id)&&String(x.season)===String(season))||null}
function publicTeam(x){return!x?null:{team_id:x.team_id,team_name:x.team_name,season:x.season,status:x.status,picks:js(x.picks_json,[]),captain_key:x.captain_key,vice_key:x.vice_key,budget_spent:n(x.budget_spent),transfers_used:n(x.transfers_used),locked_at:x.locked_at||''}}
function deadlinePassed(v){if(!v)return false;const d=new Date(v);return!Number.isNaN(d.getTime())&&Date.now()>=d.getTime()}
export async function getFantasyBootstrap(id,owner,lang='en',mode='test'){
 lang=lang==='ru'?'ru':'en';const catalog=await buildFantasyCatalog({lang,mode}),use=storeFor(mode);await ensureSheets(mode);if(mode==='test')await ensureTesterSheet();
 const rows=(await getRows(use.teams,{useCache:false})).rows,seasonRows=rows.filter(x=>String(x.season)===String(catalog.season)),team=seasonRows.find(x=>String(x.telegram_id)===String(id))||null,stored=seasonRows.flatMap(x=>js(x.picks_json,[])),pointMap=await scores(catalog,stored),leaderboard=[];
 for(const row of seasonRows.filter(x=>x.status==='locked')){
  const picks=js(row.picks_json,[]),captainInRoster=catalog.players.some(p=>p.key===row.captain_key),captainScore=pointMap.get(row.captain_key),multiplier=!captainInRoster&&!(captainScore?.matches)?row.vice_key:row.captain_key;let total=0;
  picks.forEach(p=>{const value=pointMap.get(p.key)?.total||0;total+=value+(p.key===multiplier?value*.5:0)});
  leaderboard.push({team_name:row.team_name||row.owner_name||'PTF Team',owner_name:row.owner_name||'',points:r1(total),transfers_used:n(row.transfers_used),locked_at:row.locked_at||''});
 }
 leaderboard.sort((a,b)=>b.points-a.points||a.transfers_used-b.transfers_used||String(a.locked_at).localeCompare(String(b.locked_at))||a.team_name.localeCompare(b.team_name));leaderboard.forEach((x,i)=>x.place=i+1);
 const banner=mode==='test'?(lang==='ru'?'Тестовый режим: составы и рейтинг не переносятся в основную Fantasy League.':'Test mode: squads and standings will not carry into the live Fantasy League.'):'';
 return{lang,mode,is_test:mode==='test',banner,season:catalog.season,budget:catalog.budget,roster_size:8,max_per_pool:2,transfers:2,lock_at:catalog.lockAt,locked:deadlinePassed(catalog.lockAt),rules:RULES[lang],rules_i18n:RULES,scoring:FANTASY_SCORING,pricing:FANTASY_PRICING,players:catalog.players.map(p=>({...p,score:pointMap.get(p.key)||{total:0,matches:0}})),team:publicTeam(team),leaderboard,owner_name:owner||''};
}
export async function validateFantasyTeam(input,lang,mode='test'){const c=await buildFantasyCatalog({lang,mode});return validateFantasySelection(input,c,{complete:input?.complete!==false,lang})}
export async function saveFantasyTeam(id,owner,input={},lang='en',mode='test'){
 const c=await buildFantasyCatalog({lang,mode}),use=storeFor(mode),old=await findTeam(id,c.season,mode);if(old?.status==='locked')throw failure('fantasy_team_locked',lang);if(deadlinePassed(c.lockAt))throw failure('fantasy_deadline_passed',lang);
 const locking=input.action==='lock',v=validateFantasySelection(input,c,{complete:locking,lang});if(!v.ok){const e=Error(v.errors.join(' '));e.code=400;throw e}
 const now=nowISO(),patch={team_id:old?.team_id||uid('fantasy'),telegram_id:String(id),owner_name:t(owner),team_name:t(input.team_name).slice(0,40)||(t(owner)||'PTF')+' Fantasy',season:c.season,status:locking?'locked':'draft',picks_json:JSON.stringify(v.picks.map(p=>({key:p.key,name:p.name,pool:p.pool,price:p.price}))),captain_key:t(input.captain_key),vice_key:t(input.vice_key),budget_spent:v.spent,transfers_used:n(old?.transfers_used),created_at:old?.created_at||now,updated_at:now,locked_at:locking?now:''};
 if(old?._rowNumber)await updateObjectByRow(use.teams,old._rowNumber,patch);else await appendObject(use.teams,patch);return{team:publicTeam(patch),validation:{warnings:v.warnings,remaining:v.remaining}};
}
export async function transferFantasyPlayer(id,input={},lang='en',mode='test'){
 const c=await buildFantasyCatalog({lang,mode}),use=storeFor(mode),row=await findTeam(id,c.season,mode);if(!row||row.status!=='locked')throw failure('fantasy_team_not_locked',lang);
 const picks=js(row.picks_json,[]),outKey=t(input.player_out_key),inKey=t(input.player_in_key),old=picks.find(p=>p.key===outKey),incoming=c.players.find(p=>p.key===inKey);
 if(!old||!incoming||picks.some(p=>p.key===inKey))throw failure('fantasy_invalid_transfer',lang);
 const removed=!c.players.some(p=>p.key===outKey),forced=removed&&(await seasonMatchCount(old.name,c.season))===0,used=n(row.transfers_used);if(!forced&&used>=2)throw failure('fantasy_no_transfers_left',lang);
 const next=picks.map(p=>p.key===outKey?{key:incoming.key,name:incoming.name,pool:incoming.pool,price:incoming.price}:p),captain=outKey===row.captain_key?(t(input.captain_key)||incoming.key):row.captain_key,vice=outKey===row.vice_key?(t(input.vice_key)||incoming.key):row.vice_key,v=validateFantasySelection({picks:next,captain_key:captain,vice_key:vice},c,{complete:true,lang});
 if(!v.ok){const e=Error(v.errors.join(' '));e.code=400;throw e}
 const now=nowISO(),usedNext=forced?used:used+1;await appendObject(use.transfers,{transfer_id:uid('ft'),team_id:row.team_id,telegram_id:String(id),season:c.season,player_out_key:old.key,player_out_name:old.name,player_in_key:incoming.key,player_in_name:incoming.name,price_out:old.price,price_in:incoming.price,forced:forced?'yes':'no',created_at:now});
 await updateObjectByRow(use.teams,row._rowNumber,{picks_json:JSON.stringify(next),captain_key:captain,vice_key:vice,budget_spent:v.spent,transfers_used:usedNext,updated_at:now});
 return{team:publicTeam({...row,picks_json:JSON.stringify(next),captain_key:captain,vice_key:vice,budget_spent:v.spent,transfers_used:usedNext}),forced,transfers_left:2-usedNext};
}
export function registerFantasyRoutes(app,{viewer}){
 const auth=async(req,res)=>{const v=await viewer(req.body?.initData||req.query.initData||'',String(req.body?.t||req.query.t||''));if(!v.ok){res.status(v.code).json({ok:false,error:v.error});return null}const access=await fantasyAccessFor({telegramId:v.user.id,name:v.profile.name||'',username:v.profile.telegram_username||v.user.username||'',isAdmin:v.isAdmin,isLeagueMember:true});if(!access.allowed){const ru=v.lang==='ru',error=access.reason==='players_master_required'?(ru?'Fantasy League доступна игрокам из Players_Master таблицы Match Log.':'Fantasy League is available to players listed in Match Log Players_Master.'):(ru?'Fantasy пока доступно только тестовой группе.':'Fantasy is currently available to the test group only.');res.status(403).json({ok:false,error,reason:access.reason});return null}return{...v,fantasy:access}};
 app.get('/api/fantasy/bootstrap',async(req,res)=>{try{const v=await auth(req,res);if(v)res.json({ok:true,...await getFantasyBootstrap(v.user.id,v.profile.name||'',v.lang,v.fantasy.mode)})}catch(e){console.error('fantasy bootstrap:',e);res.status(500).json({ok:false,error:e.message})}});
 app.post('/api/fantasy/validate',async(req,res)=>{try{const v=await auth(req,res);if(v){const x=await validateFantasyTeam(req.body||{},v.lang,v.fantasy.mode);res.json({ok:true,validation:{...x,picks:x.picks.map(p=>p.key)}})}}catch(e){res.status(e.code||500).json({ok:false,error:e.message})}});
 app.post('/api/fantasy/team',async(req,res)=>{try{const v=await auth(req,res);if(v)res.json({ok:true,...await saveFantasyTeam(v.user.id,v.profile.name||'',req.body||{},v.lang,v.fantasy.mode)})}catch(e){res.status(e.code||400).json({ok:false,error:e.message})}});
 app.post('/api/fantasy/transfer',async(req,res)=>{try{const v=await auth(req,res);if(v)res.json({ok:true,...await transferFantasyPlayer(v.user.id,req.body||{},v.lang,v.fantasy.mode)})}catch(e){res.status(e.code||400).json({ok:false,error:e.message})}});
}
