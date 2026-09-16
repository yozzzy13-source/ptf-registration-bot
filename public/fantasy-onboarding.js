
import {assignSlots, selectionIssue, deadlineReached} from './fantasy-model.js';

const tg=window.Telegram?.WebApp;
try { tg?.ready(); tg?.expand(); } catch {}
const initData=tg?.initData||'', token=new URLSearchParams(location.search).get('t')||'';
const app=document.getElementById('app');
let D, ru=(tg?.initDataUnsafe?.user?.language_code||'').startsWith('ru');
let view='home', step=0, slot=1, filter='slot', search='', transferOut='', busy=false, notice='', review=null, priceOpen='', searchSugOpen=false;
// Разовое приглашение при первом заходе в Fantasy — показываем один раз на
// это устройство, дальше не мешаем.
let introOpen=false;
try { introOpen=!localStorage.getItem('ptf_fantasy_intro_seen'); } catch {}
function dismissIntro(){ introOpen=false; try{ localStorage.setItem('ptf_fantasy_intro_seen','1'); }catch{} render(); }
const drafts=new Map(), saves=new Map(), timers=new Map();
const tr=(r,e)=>ru?r:e;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,kind='primary',extra='')=>'<button class="'+kind+'" data-action="'+action+'" '+extra+(busy?' disabled':'')+'>'+esc(label)+'</button>';
const player=key=>D.players.find(p=>p.key===key);
const team=(n=slot)=>D.teams.find(t=>Number(t.team_slot||1)===n);
function draft(n=slot) {
  if(!drafts.has(n)) {
    const t=team(n);
    drafts.set(n,{picks:(t?.picks||[]).map(p=>p.key),captain_key:t?.captain_key||'',vice_key:t?.vice_key||'',team_name:t?.team_name||((D.owner_name||'PTF')+' '+tr('Команда','Team')+' '+n),version:0,saved:0});
  }
  return drafts.get(n);
}
const editable=()=>D.entry_open&&!deadlineReached(D);
const spent=(keys=draft().picks)=>keys.reduce((sum,k)=>sum+Number(player(k)?.price??team()?.picks.find(p=>p.key===k)?.price??0),0);
const date=()=>D.lock_at?new Date(D.lock_at).toLocaleString(ru?'ru-RU':'en-GB',{dateStyle:'medium',timeStyle:'short'}):tr('Дедлайн ещё не установлен','Deadline is not set yet');
function avatar(p) {
  return p.photo?'<img class="avatar" src="'+esc(p.photo)+'" alt="" loading="lazy">':'<span class="avatar" aria-hidden="true">'+esc((p.name||'?').split(/\s+/).slice(0,2).map(s=>s[0]).join(''))+'</span>';
}
async function api(path,body) {
  const options={cache:'no-store'};
  if(body)Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,lang:ru?'ru':'en',initData,...(token?{t:token}:{})})});
  const response=await fetch('/api/fantasy/'+path+(body?'':'?'+new URLSearchParams({initData,...(token?{t:token}:{})})),options);
  const j=await response.json();
  if(!response.ok||!j.ok)throw Error(j.error||tr('Не удалось загрузить данные','Unable to load data'));
  return j;
}
function payload(n=slot) {
  const d=draft(n);
  return {team_slot:n,team_name:d.team_name,picks:[...d.picks],captain_key:d.captain_key,vice_key:d.vice_key};
}
function updateTeam(t) {
  const index=D.teams.findIndex(x=>Number(x.team_slot||1)===Number(t.team_slot||1));
  if(index<0)D.teams.push(t);else D.teams[index]={...D.teams[index],...t};
}
function changed() {
  const d=draft(); d.version++; review=null; notice='';
  // Locked teams stay unchanged until the user reviews and confirms an edit.
  if(!team()||team().status==='draft') {
    clearTimeout(timers.get(slot));const n=slot;
    timers.set(n,setTimeout(()=>saveDraft(n).catch(e=>{notice=e.message;render();}),700));
  }
}
async function saveDraft(n=slot) {
  clearTimeout(timers.get(n));
  if(saves.has(n)) { await saves.get(n); return saveDraft(n); }
  const d=draft(n);
  if(d.version===d.saved||!editable()||team(n)?.status==='locked')return;
  const version=d.version, body=payload(n);
  const pending=api('team',{...body,action:'draft'}).then(j=>{updateTeam(j.team);d.saved=version;});
  saves.set(n,pending);
  try { await pending; } finally { saves.delete(n); }
}
function progress() {
  const labels=[tr('Игроки','Players'),tr('Капитаны','Captains'),tr('Название','Name'),tr('Проверка','Review'),tr('Фиксация','Confirm')];
  return '<ol class="progress" aria-label="'+tr('Шаги создания команды','Team creation steps')+'">'+labels.map((label,i)=>'<li '+(i===step?'aria-current="step"':'')+' class="'+(i===step?'on':i<step?'done':'')+'"><b>'+(i<step?'✓':i+1)+'</b><span>'+label+'</span></li>').join('')+'</ol>';
}
function header() {
  return '<div class="top"><div><div class="eyebrow">Phuket Tennis Family</div><h1>Fantasy</h1><div class="sub">'+tr('Сезон','Season')+' '+esc(D.season)+'</div></div><div class="theme">'+button('☾','dark','')+button('☀','light','')+button(ru?'EN':'RU','language','')+'</div></div>'+
    (D.banner?'<div class="banner">'+esc(D.is_test?tr('TEST · тестовые команды','TEST · test squads'):D.banner)+'</div>':'')+
    '<nav class="tabs">'+[['home',tr('Главная','Home')],['players',tr('Игроки','Players')],['table',tr('Рейтинг','Standings')],['rules',tr('Правила','Rules')]].map(([v,label])=>button(label,v,'tab '+(view===v?'on':''))).join('')+'</nav>';
}
function rule(key) {
  if(key==='intro')return tr('До двух независимых команд из ','Up to two independent squads of ')+D.roster_size+tr(' игроков. Сезон ',' players. Season ')+D.season+'.';
  if(key==='budget')return tr('Бюджет: ','Budget: ')+D.budget+'.';
  if(key==='squad')return tr('2 C и 2 W — по одному из каждой группы; 1 Prime, 1 A, 1 B и flex Prime/A/B.','2 C and 2 W — one from each group; 1 Prime, 1 A, 1 B and flex Prime/A/B.');
  if(key==='locking')return tr('До дедлайна можно менять и подтверждённый состав. После дедлайна доступны только разрешённые замены.','Edit even a confirmed squad until the deadline. After the deadline, only permitted transfers remain.');
  if(key==='transfers')return tr('После дедлайна замен: ','Transfers after the deadline: ')+D.transfers+tr('. Замена официально снятого до первого матча игрока бесплатна.','. Replacing an officially withdrawn player before their first match is free.');
  return D.rules_i18n?.[ru?'ru':'en']?.[key]||D.rules[key]||'';
}
function timing() {
  return '<p class="meta">'+tr('Дедлайн: ','Deadline: ')+esc(date())+'</p>';
}
function windowMessage() {
  return deadlineReached(D)?tr('Дедлайн прошёл. Создание команд и изменение черновиков закрыты.','The deadline has passed. New teams and draft edits are closed.'):
    tr('Приём составов пока закрыт.','Squad entry is currently closed.')+(D.open_at?' '+tr('Открытие: ','Opens: ')+new Date(D.open_at).toLocaleString(ru?'ru-RU':'en-GB'):'');
}
function homeView() {
  const first=team(1),second=team(2),local=drafts.get(1);
  let html='<section class="card clubhero"><h2>'+tr('Ваша первая Fantasy-команда','Your first Fantasy team')+'</h2><p>'+tr('Соберите команду из реальных игроков PTF. Их настоящие матчи принесут вам Fantasy-очки.','Build a team of real PTF players. Earn Fantasy points from their real matches.')+'</p><div class="clubgrid"><div class="clubcell"><b>'+D.roster_size+'</b><span>'+tr('игроков','players')+'</span></div><div class="clubcell"><b>'+D.budget+'</b><span>'+tr('бюджет','budget')+'</span></div><div class="clubcell"><b>×'+D.scoring.captainMultiplier+'</b><span>'+tr('капитан','captain')+'</span></div></div>'+timing();
  if(!first)html+=editable()?button(local?.picks.length?tr('Продолжить команду','Continue team'):tr('Создать первую команду','Create first team'),'start','primary full','data-slot="1"'):'<div class="readonly">'+esc(windowMessage())+'</div>';
  html+='</section>';
  for(const t of [first,second].filter(Boolean))html+='<section class="card"><div class="eyebrow">'+tr('Команда','Team')+' '+Number(t.team_slot||1)+'</div><h2>'+esc(t.team_name)+'</h2><p class="meta">'+esc(t.status==='locked'?tr('Подтверждена','Confirmed'):deadlineReached(D)?tr('Черновик — не участвует','Draft — not entered'):tr('Черновик','Draft'))+' · '+(t.picks||[]).length+'/8 · <b>'+Number(t.points||0)+'</b> Fantasy Points</p>'+timing()+button(tr('Продолжить команду','Continue team'),'start','primary full','data-slot="'+Number(t.team_slot||1)+'"')+'</section>';
  if(first&&!second&&editable())html+=button(tr('Создать вторую команду','Create second team'),'start','secondary full','data-slot="2"');
  return html+'<details class="card rules"><summary>'+tr('Короткие правила','Quick rules')+'</summary><p>'+esc(rule('squad'))+'</p><p>'+esc(rule('locking'))+'</p></details>';
}
function slotsPanel() {
  const keys=draft().picks.filter(k=>k!==transferOut),state=assignSlots(keys,D.players),next=state.slots.findIndex(s=>!s.key);
  const current=state.slots[next];
  return '<div class="selection-summary"><p class="slots-howto">'+tr('Заполните все 8 слотов ниже: по одному игроку из каждой группы (C1/C2/W1/W2) и каждого дивизиона (Prime/A/B).','Fill all 8 slots below: one player from each group (C1/C2/W1/W2) and each division (Prime/A/B).')+'</p><div class="budget-line"><b>'+keys.length+'/8</b><span>'+tr('Использовано','Used')+' <b>'+spent(keys)+'/'+D.budget+'</b></span><span>'+tr('Осталось','Left')+' <b class="'+(spent(keys)>D.budget?'error':'')+'">'+(D.budget-spent(keys))+'</b></span></div><div class="slots" aria-label="'+tr('Слоты команды','Team slots')+'">'+state.slots.map((s,i)=>'<div class="req '+(s.key?'ok':i===next?'current':'')+'" '+(i===next?'aria-current="true"':'')+' title="'+esc(s.key?player(s.key)?.name:s.pools.join(' / '))+'">'+(s.key?'✓ ':'')+esc(s.label==='Flex'?'Flex P/A/B':s.label)+'</div>').join('')+'</div><div class="meta slot-instruction">'+(current?tr('Выберите: ','Choose: ')+esc(current.label==='Flex'?'Prime / A / B':current.pools.join(' / '))+(current.pools.some(p=>p.includes(':'))?' · '+tr('по одному из каждой группы','one from each group'):''):tr('Все 8 мест заполнены','All 8 places filled'))+'</div></div>';
}
const errors={
  unavailable:['Игрок больше недоступен. Уберите его из состава.','Player is no longer available. Remove them from the squad.'],
  selected:['Игрок уже выбран.','Player is already selected.'],
  full:['Все 8 мест заполнены. Сначала уберите игрока.','All 8 places are filled. Remove a player first.'],
  quota:['Квота заполнена: выберите игрока для свободного слота.','Quota filled: choose a player for an empty slot.'],
  slot:['Игрок не подходит текущему слоту. Выберите игрока из указанного фильтра.','This player does not fit the current slot. Choose from the slot filter.'],
  budget:['Не хватает бюджета. Выберите игрока дешевле или измените состав.','Not enough budget. Choose a cheaper player or edit the squad.']
};
function issueText(issue) {return errors[issue]?.[ru?0:1]||issue;}
function selectionError(key) {
  if(transferOut) {
    const keys=draft().picks.filter(k=>k!==transferOut);
    return selectionIssue(keys,key,D.players,D.budget,D.max_per_pool);
  }
  return selectionIssue(draft().picks,key,D.players,D.budget,D.max_per_pool,assignSlots(draft().picks,D.players).slots.findIndex(s=>!s.key));
}
// По просьбе Костаса: клик по цене раскрывает, из чего она сложилась —
// база + бонусы за винрейт/место/плей-офф, минус скидка за переход дивизиона.
function priceBreakdown(p) {
  const b=p.price_breakdown;
  if(!b)return '';
  const row=(label,v,signed)=>'<div class="pbd-row"><span>'+esc(label)+'</span><b'+(signed&&v>0?' class="pos"':signed&&v<0?' class="neg"':'')+'>'+(signed&&v>0?'+':'')+v+'</b></div>';
  if(b.override)return '<div class="price-breakdown">'+row(tr('Цена задана вручную','Manually set price'),b.final,false)+'</div>';
  if(b.debutant)return '<div class="price-breakdown">'+row(tr('База (нет истории — дебютант)','Base (no history — debutant)'),b.final,false)+'</div>';
  const promoted=(b.transition_factor||1)<1;
  return '<div class="price-breakdown">'+
    row(tr('База','Base'),b.base,false)+
    row(tr('Винрейт','Win rate'),b.win_rate_bonus,true)+
    row(tr('Место в регулярке','Regular-season place'),b.regular_bonus,true)+
    row(tr('Плей-офф','Playoffs'),b.playoff_bonus,true)+
    (promoted?'<div class="pbd-row note">'+esc(tr('Переход в более сильный дивизион уменьшает надбавку (×'+b.transition_factor+')','Moving to a stronger division shrinks the premium (×'+b.transition_factor+')'))+'</div>':'')+
    '<div class="pbd-row total"><span>'+tr('Итоговая цена','Final price')+'</span><b>'+b.final+'</b></div></div>';
}
// Клик по игроку в общем списке (не в режиме выбора) раскрывает, за какие
// именно матчи и почему он получил свои Fantasy Points.
let matchesOpen='';
const PT_LABELS={appearance:['Участие','Appearance'],win:['Победа','Win'],sets:['Сеты','Sets'],games:['Геймы','Games'],straight:['Победа 2:0','Straight win'],bagels:['«Сухие» сеты','Bagel sets'],upset:['Апсет','Upset'],technical:['Техническая победа','Walkover']};
function matchBreakdown(p) {
  const details=p.score?.details||[];
  if(!details.length)return '<div class="price-breakdown"><div class="pbd-row note">'+esc(tr('Пока нет сыгранных матчей в этом сезоне.','No matches played this season yet.'))+'</div></div>';
  return '<div class="price-breakdown">'+details.map(m=>{
    const pts=m.points||{},parts=Object.entries(PT_LABELS).filter(([k])=>pts[k]).map(([k,l])=>tr(l[0],l[1])+' +'+pts[k]).join(' · ');
    return '<div class="pbd-row" style="display:block"><div style="display:flex;justify-content:space-between;gap:8px"><span>'+esc((m.opponent||'')+(m.score?' · '+m.score:''))+'</span><b>'+(pts.total||0)+'</b></div>'
      +(parts?'<div style="color:var(--muted);font-size:11px;margin-top:2px">'+esc(parts)+'</div>':'')+'</div>';
  }).join('')+'</div>';
}
// Костас: клик по подсказке под именем (или по самому имени) в режиме выбора
// должен раскрывать, ПОЧЕМУ это перспективный выбор — используем готовые
// p.tips.why/risks/captain с сервера, а не разбивку очков по матчам (это
// другая функция, matchBreakdown, для вкладки «Игроки» вне режима выбора).
let tipsOpen='';
function tipsBreakdown(p) {
  const t=p.tips||{why:[],risks:[],captain:''};
  if(!t.why.length&&!t.risks.length&&!t.captain)return '';
  const line=(cls,label,items)=>items.length?'<div class="pbd-row note '+cls+'">'+esc(label)+' '+items.map(esc).join(' · ')+'</div>':'';
  return '<div class="price-breakdown">'
    +line('good',tr('Плюсы:','Why:'),t.why)
    +line('bad',tr('Риски:','Risks:'),t.risks)
    +(t.captain?'<div class="pbd-row note">'+esc(tr('Капитан: ','Captain: ')+t.captain)+'</div>':'')
    +'</div>';
}
function hint(p) {
  if(p.history&&p.price>=13&&p.transition_factor===1)return tr('Кандидат в капитаны','Captain candidate');
  const top=D.player_leaderboard?.slice(0,5).some(x=>x.key===p.key);
  if(top&&p.score?.total>0)return tr('Высокие Fantasy Points','High Fantasy Points');
  if(p.price<=D.budget/8)return tr('Доступная цена','Affordable price');
  if(p.history?.winRate>=60)return tr('Перспективный выбор','Promising pick');
  return '';
}
function catalog(selecting=false) {
  const state=assignSlots(draft().picks.filter(k=>k!==transferOut),D.players),current=state.slots.find(s=>!s.key);
  const list=(D.player_leaderboard||[]).map(rank=>({...player(rank.key),place:rank.place})).filter(p=>
    (!search||p.name.toLowerCase().includes(search.toLowerCase()))&&
    (filter==='all'||(filter==='slot'?(!current||current.pools.includes(p.pool)):p.pool.split(':')[0]===filter)));
  const sugs=(searchSugOpen&&search.trim())?(D.player_leaderboard||[]).filter(r=>r.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0,6):[];
  return '<label class="sr-only" for="player-search">'+tr('Поиск игрока','Search player')+'</label><div class="searchwrap"><input id="player-search" class="search" placeholder="'+tr('Поиск игрока','Search player')+'" value="'+esc(search)+'" autocomplete="off">'
    +(sugs.length?'<div class="psug">'+sugs.map(r=>'<button type="button" class="pi" onmousedown="event.preventDefault()" data-action="search-pick" data-key="'+esc(r.key)+'">'+esc(r.name)+'</button>').join('')+'</div>':'')+'</div><div class="filters">'+(selecting?button(tr('Для слота','For this slot'),'filter','filter '+(filter==='slot'?'on':''),'data-filter="slot"'):'')+['all','C','W','PRIME','A','B'].map(f=>button(f==='all'?tr('Все','All'):f==='PRIME'?'Prime':f,'filter','filter '+(filter===f?'on':''),'data-filter="'+f+'"')).join('')+'</div><div class="tb fantasy-catalog '+(selecting?'selecting':'')+'"><div class="thd"><span>#</span><span></span><span>'+tr('Игрок','Player')+'</span><span>Teams</span><span>Fantasy<br>Points</span><span>'+tr('Цена','Price')+'</span>'+(selecting?'<span></span>':'')+'</div>'+list.map(p=>{
    const selected=draft().picks.includes(p.key),h=selecting?hint(p):'';
    const priceBtn='<button type="button" class="price price-toggle" data-action="price-info" data-key="'+esc(p.key)+'" aria-expanded="'+(priceOpen===p.key)+'" aria-label="'+esc(tr('Откуда цена: ','Where the price comes from: ')+p.name)+'">'+p.price+'</button>';
    // Вне режима выбора клик по игроку раскрывает разбивку очков по матчам —
    // за что именно и сколько он получил.
    const nameCell=selecting
      ?'<button type="button" class="player-name player-name-btn" data-action="tips-toggle" data-key="'+esc(p.key)+'" aria-expanded="'+(tipsOpen===p.key)+'"><b>'+esc(p.name)+'</b>'+(h?'<small>'+esc(h)+'</small>':'')+'</button>'
      :'<button type="button" class="player-name player-name-btn" data-action="matches-toggle" data-key="'+esc(p.key)+'" aria-expanded="'+(matchesOpen===p.key)+'"><b>'+esc(p.name)+'</b></button>';
    return '<div class="trw-wrap"><div class="trw">'+ '<span class="place">'+p.place+'</span>'+avatar(p)+nameCell+'<span>'+Number(p.selected_by||0)+'</span><span class="pts">'+Number(p.score?.total||0)+'</span>'+priceBtn+(selecting?button(selected?'✓':'+',transferOut?'transfer-pick':'pick','mini '+(selected?'on':''),'data-key="'+esc(p.key)+'" aria-label="'+esc((selected?tr('Уже выбран: ','Already selected: '):tr('Выбрать: ','Select: '))+p.name)+'"'):'')+'</div>'+(priceOpen===p.key?priceBreakdown(p):'')+(selecting&&tipsOpen===p.key?tipsBreakdown(p):'')+(!selecting&&matchesOpen===p.key?matchBreakdown(p):'')+'</div>';
  }).join('')+'</div>'+(!list.length?'<div class="empty">'+tr('Нет подходящих игроков. Измените поиск или фильтр.','No matching players. Change the search or filter.')+'</div>':'');
}
function cards(mode='review') {
  const d=draft();
  return '<div class="squad">'+d.picks.map(k=>{
    const p=player(k)||team()?.picks.find(x=>x.key===k)||{key:k,name:k};
    const cap=d.captain_key===k,vice=d.vice_key===k;
    return '<div class="pick">'+avatar(p)+'<div class="player-name"><div class="name">'+esc(p.name)+'</div><div class="meta">'+esc(p.pool||'')+' · '+(p.score?.total||0)+' Fantasy Points</div><div class="actions">'+(mode==='captains'?button(tr('Капитан','Captain'),'captain','mini '+(cap?'on':''),'data-key="'+esc(k)+'" aria-pressed="'+cap+'"')+button(tr('Вице-капитан','Vice-captain'),'vice','mini '+(vice?'on':''),'data-key="'+esc(k)+'" aria-pressed="'+vice+'"'):(cap?'<span class="badge cap">'+tr('Капитан','Captain')+' ×1.5</span>':'')+(vice?'<span class="badge">'+tr('Вице-капитан','Vice-captain')+'</span>':''))+
    (mode==='select'?button(tr('Убрать','Remove'),'remove','mini danger','data-key="'+esc(k)+'"'):'')+
    (mode==='team'&&canTransfer(k)?button((team().free_transfer_keys||[]).includes(k)?tr('Бесплатная замена','Free transfer'):tr('Заменить','Replace'),'transfer-start','mini transfer','data-key="'+esc(k)+'"'):'')+'</div></div>'+
    (p.price_breakdown?'<button type="button" class="price price-toggle" data-action="price-info" data-key="'+esc(k)+'" aria-expanded="'+(priceOpen===k)+'" aria-label="'+esc(tr('Откуда цена: ','Where the price comes from: ')+p.name)+'">'+Number(p.price||0)+'</button>'+(priceOpen===k?priceBreakdown(p):''):'<div class="price">'+Number(p.price||0)+'</div>')+'</div>';
  }).join('')+'</div>';
}
function localErrors() {
  const d=draft(),state=assignSlots(d.picks,D.players),out=[];
  if(d.picks.length!==8||state.unmatched.length||state.slots.some(s=>!s.key))out.push({step:0,text:tr('Заполните 8 слотов по квотам.','Fill all 8 slots with the required quotas.')});
  if(spent()>D.budget)out.push({step:0,text:tr('Превышен бюджет на ','Budget exceeded by ')+(spent()-D.budget)});
  if(!d.picks.includes(d.captain_key)||!d.picks.includes(d.vice_key)||d.captain_key===d.vice_key)out.push({step:1,text:tr('Выберите разных капитана и вице-капитана.','Choose a distinct captain and vice-captain.')});
  if(!d.team_name.trim())out.push({step:2,text:tr('Укажите название команды.','Enter a team name.')});
  return out;
}
function reviewView() {
  const errs=localErrors();
  return '<section class="card"><h2>'+esc(draft().team_name)+'</h2>'+timing()+'<div class="budget-line"><b>'+tr('Бюджет','Budget')+': '+spent()+'/'+D.budget+'</b><span>'+tr('Осталось','Left')+': '+(D.budget-spent())+'</span></div>'+cards()+slotsPanel()+
    errs.map(e=>'<div class="message bad">'+esc(e.text)+' '+button(tr('Исправить','Fix'),'step','mini','data-step="'+e.step+'"')+'</div>').join('')+
    (review?.errors||[]).map(e=>'<div class="message bad">'+esc(e)+' '+button(tr('Изменить состав','Edit squad'),'step','mini','data-step="0"')+'</div>').join('')+
    (!errs.length&&review?.ok?'<div class="message good">✓ '+tr('Состав прошёл проверку','Squad validation passed')+'</div>':'')+
    (review?.warnings?.length?'<details class="meta"><summary>'+tr('Подсказки','Tips')+'</summary>'+review.warnings.map(x=>'<p>'+esc(x)+'</p>').join('')+'</details>':'')+'</section>';
}
function wizardView() {
  let html=progress();
  if(!editable())return html+'<div class="card">'+esc(windowMessage())+button(tr('Посмотреть состав','View squad'),'team','secondary full')+'</div>';
  if(step===0)html+=slotsPanel()+'<div class="section-title"><h2>'+tr('Выберите игроков','Pick your players')+'</h2></div><details class="card" '+(draft().picks.length===8?'open':'')+'><summary>'+tr('Мой состав','My squad')+' · '+draft().picks.length+'/8</summary>'+cards('select')+'</details>'+catalog(true);
  if(step===1)html+='<section class="card"><h2>'+tr('Капитан и вице-капитан','Captain and vice-captain')+'</h2><p class="sub">'+tr('Капитан получает ×1.5. Вице-капитан заменяет его при официальном снятии до первого матча.','Your captain earns ×1.5. Your vice-captain takes over if the captain officially withdraws before their first match.')+'</p>'+cards('captains')+'</section>';
  if(step===2)html+='<section class="card"><h2>'+tr('Как назовём команду?','Name your team')+'</h2><p class="sub">'+tr('Название появится в рейтинге.','This name appears in the standings.')+'</p><div class="field"><label for="team-name">'+tr('Название команды','Team name')+'</label><input id="team-name" maxlength="40" autocomplete="off" value="'+esc(draft().team_name)+'"></div></section>';
  if(step===3)html+=reviewView();
  if(step===4)html+='<section class="card"><h2>'+tr('Подтвердить команду','Confirm your team')+'</h2><p>'+esc(draft().team_name)+' · 8/8 · '+spent()+'/'+D.budget+'</p>'+timing()+'<p class="sub">'+esc(rule('locking'))+'</p><p class="sub">'+esc(rule('transfers'))+'</p>'+button(team()?.status==='locked'?tr('Подтвердить изменения','Confirm changes'):tr('Создать команду','Create team'),'confirm','primary full',localErrors().length||!review?.ok?'disabled':'')+'</section>';
  return html+'<div class="wizard-actions '+(step===0?'selection-actions':'')+'">'+button(tr('Назад','Back'),'back','secondary')+
    (step<4?button([tr('К капитанам','Choose captains'),tr('К названию','Name team'),tr('Проверить состав','Review team'),tr('К подтверждению','Continue')][step],'next','primary',(step===0&&draft().picks.length!==8)||(step===1&&localErrors().some(x=>x.step===1))||(step===2&&!draft().team_name.trim())||(step===3&&(localErrors().length||!review?.ok))?'disabled':''):'')+'</div>'+
    (team()?.status==='locked'?button(tr('Отменить изменения','Discard changes'),'discard','secondary full'):button(tr('Сохранить и выйти','Save and exit'),'save-exit','secondary full'))+
    '<p class="meta">'+(team()?.status==='locked'?tr('Изменения вступят в силу после подтверждения.','Changes take effect after confirmation.'):tr('Черновик сохраняется автоматически.','Draft saves automatically.'))+'</p>';
}
function canTransfer(key) {
  const t=team();
  return deadlineReached(D)&&D.transfers_open&&t?.status==='locked'&&(Number(t.transfers_used)<D.transfers||(t.free_transfer_keys||[]).includes(key));
}
function teamView() {
  const t=team();
  if(!t)return homeView();
  const locked=t.status==='locked';
  return '<section class="card"><h2>'+esc(t.team_name)+'</h2><p class="meta">'+(locked?tr('Подтверждена','Confirmed'):tr('Черновик','Draft'))+' · '+Number(t.points||0)+' Fantasy Points</p>'+timing()+
    (deadlineReached(D)?'<div class="readonly">'+(locked?tr('Состав закрыт. Осталось замен: ','Squad closed. Transfers left: ')+Math.max(0,D.transfers-Number(t.transfers_used)):tr('Черновик не подтверждён до дедлайна и не участвует в рейтинге.','This draft was not confirmed before the deadline and is not in the standings.'))+'</div>':'')+
    cards('team')+(editable()?button(tr('Изменить команду','Edit team'),'edit','primary full'):'')+'</section>'+
    (transferOut?'<section class="card"><h3>'+tr('Заменить: ','Replace: ')+esc((player(transferOut)||t.picks.find(p=>p.key===transferOut)).name)+'</h3>'+button(tr('Отмена замены','Cancel transfer'),'transfer-cancel','secondary')+'</section>'+slotsPanel()+catalog(true):'')+
    button(tr('Все мои команды','All my teams'),'home','secondary full');
}
function successView() {
  return '<section class="card"><div class="clubmark">✓</div><h2>'+tr('Команда создана!','Team created!')+'</h2><p>'+esc(team().team_name)+'</p>'+timing()+'<p class="sub">'+esc(rule('locking'))+'</p><p class="sub">'+esc(rule('transfers'))+'</p>'+button(tr('Посмотреть мою команду','View my team'),'team','primary full')+'</section>';
}
let rankMode='teams';
function tableView() {
  const list=rankMode==='teams'?D.leaderboard:D.player_leaderboard;
  return '<div class="ranktabs">'+button(tr('Команды','Teams'),'rank-teams',rankMode==='teams'?'on':'')+button(tr('Игроки','Players'),'rank-players',rankMode==='players'?'on':'')+'</div><div class="card">'+(list.length?list.map(p=>'<div class="leader"><div class="place">'+p.place+'</div>'+avatar(rankMode==='teams'?{name:p.owner_name,photo:p.owner_photo}:p)+'<div class="player-name"><div class="name">'+esc(p.team_name||p.name)+'</div><div class="meta">'+esc(rankMode==='teams'?p.owner_name:'Teams: '+p.selected_by)+'</div></div><div class="pts">'+p.points+'</div></div>').join(''):'<div class="empty">'+tr('Рейтинг пока пуст','No standings yet')+'</div>')+'</div>';
}
function rulesView() {
  const titles={intro:tr('Формат','Format'),squad:tr('Состав','Squad'),budget:tr('Бюджет','Budget'),format:tr('Матчи','Matches'),pricing:tr('Цены','Prices'),locking:tr('Дедлайн','Deadline'),captain:tr('Капитаны','Captains'),transfers:tr('Замены','Transfers'),scoring:tr('Очки','Points'),ranking:tr('Рейтинг','Standings')};
  return Object.entries(titles).map(([key,label])=>'<details class="card rules"><summary>'+esc(label)+'</summary><p>'+esc(rule(key))+'</p></details>').join('');
}
function render() {
  if(!D)return;
  document.documentElement.lang=ru?'ru':'en';
  app.dataset.view=view;
  app.innerHTML=header()+(notice?'<div class="message bad" role="alert">'+esc(notice)+'</div>':'')+
    (view==='home'?homeView():view==='wizard'?wizardView():view==='team'?teamView():view==='success'?successView():view==='players'?catalog():view==='table'?tableView():rulesView())+
    (introOpen&&view==='home'?introOverlay():'');
  app.setAttribute('aria-busy',String(busy));
  try { view==='home'?tg?.BackButton?.hide():tg?.BackButton?.show(); } catch {}
}
// По просьбе Костаса: сначала «продаём» идею — открытое, бесплатное
// соревнование между командами игроков лиги — и только потом объясняем
// механику. Раньше шло наоборот: сразу шаги, без объяснения зачем.
function introOverlay() {
  return '<div class="intro-backdrop"><div class="intro-card">'
    +'<div class="clubmark">✨</div><h2>'+tr('Другие игроки уже собирают команды','Other players are already building teams')+'</h2>'
    +'<p>'+tr('PTF Fantasy — открытое соревнование между командами игроков лиги: кто лучше соберёт состав из настоящих теннисистов PTF. Бесплатно, только ради веселья.','PTF Fantasy is an open competition between league players’ squads — who can build the best team of real PTF players. Free, just for fun.')+'</p>'
    +'<p class="sub">'+tr('Их реальные матчи в сезоне будут приносить вам очки. Вот как это работает:','Their real matches this season earn you points. Here’s how it works:')+'</p>'
    +'<ul class="intro-steps">'
    +'<li><b>1.</b> '+tr('Выберите 8 игроков в рамках бюджета '+D.budget+' кредитов.','Pick 8 players within a '+D.budget+'-credit budget.')+'</li>'
    +'<li><b>2.</b> '+tr('Назначьте капитана — он приносит очки ×1.5.','Name a captain — they score ×1.5.')+'</li>'
    +'<li><b>3.</b> '+tr('Следите за очками по мере того, как игроки играют реальные матчи.','Watch the points roll in as players compete in real matches.')+'</li></ul>'
    +'<p class="sub">'+tr('Можно собрать до двух независимых команд за сезон.','You can build up to two independent teams per season.')+'</p>'
    +button(tr('Понятно, начнём','Got it, let us go'),'intro-dismiss','primary full')+'</div></div>';
}
function navigate(v) { view=v;notice='';if(v==='players'){filter='all';search='';}render();window.scrollTo(0,0); }
async function start(n) {
  await saveDraft(slot);slot=n;transferOut='';filter='slot';search='';review=null;
  const d=draft();
  if(team()?.status==='locked'||!editable())navigate('team');
  else {step=d.picks.length<8?0:localErrors().some(e=>e.step===1)?1:2;navigate('wizard');}
}
async function validateReview() {
  review=null;render();
  const n=slot,version=draft().version;
  const result=await api('validate',{...payload(),complete:true});
  if(n===slot&&version===draft().version){review=result.validation;render();}
}
async function next() {
  if(!editable())return render();
  if(step===0&&localErrors().some(e=>e.step===0))return;
  if(step===1&&localErrors().some(e=>e.step===1))return;
  if(step===2&&!draft().team_name.trim())return;
  if(step===3&&(localErrors().length||!review?.ok))return;
  busy=true;render();
  try {await saveDraft();step++;window.scrollTo(0,0);if(step===3)await validateReview();}
  finally {busy=false;render();}
}
async function commit() {
  if(busy||!editable()||localErrors().length||!review?.ok)return;
  busy=true;render();
  try {
    await saveDraft();
    const result=await api('validate',{...payload(),complete:true});review=result.validation;
    if(!review.ok){step=3;return;}
    const saved=await api('team',{...payload(),action:'lock'});
    updateTeam(saved.team);draft().saved=draft().version;
    // Refresh scores, transfer availability and deadline after a write.
    try {const fresh=await api('bootstrap');D=fresh;}catch {}
    view='success';
  } catch(e) {notice=e.message;step=3;review=null;}
  finally {busy=false;render();window.scrollTo(0,0);}
}
async function back() {
  if(busy)return;
  if(view==='wizard'&&step>0){step--;render();return;}
  await saveDraft();navigate('home');
}
async function handle(action,el={dataset:{}}) {
  if(busy)return;
  if(action==='intro-dismiss'){dismissIntro();return;}
  if(['dark','light'].includes(action)){setTheme(action);return;}
  if(action==='language'){ru=!ru;render();if(view==='wizard'&&step===3)await validateReview();return;}
  if(['home','players','table','rules'].includes(action)){await saveDraft();return navigate(action);}
  if(action==='start')return start(Number(el.dataset.slot));
  if(action==='team'){transferOut='';drafts.delete(slot);return navigate('team');}
  if(action==='edit'){step=0;filter='slot';return navigate('wizard');}
  if(action==='discard'){drafts.delete(slot);return navigate('team');}
  if(action==='back')return back();
  if(action==='next')return next();
  if(action==='step'){step=Number(el.dataset.step);return render();}
  if(action==='confirm')return commit();
  if(action==='save-exit'){await saveDraft();return navigate('home');}
  if(action==='filter'){filter=el.dataset.filter;return render();}
  if(action==='rank-teams'||action==='rank-players'){rankMode=action.slice(5);return render();}
  const key=el.dataset.key,d=draft();
  if(action==='price-info'){priceOpen=priceOpen===key?'':key;return render();}
  if(action==='matches-toggle'){matchesOpen=matchesOpen===key?'':key;return render();}
  if(action==='tips-toggle'){tipsOpen=tipsOpen===key?'':key;return render();}
  if(action==='pick') {
    if(!editable())return;
    const issue=selectionError(key);if(issue){notice=issueText(issue)+' '+tr('Цена: ','Price: ')+player(key).price;render();return;}
    d.picks.push(key);changed();
    if(d.picks.length===8){step=1;window.scrollTo(0,0);}
    render();return;
  }
  if(action==='remove'&&editable()){d.picks=d.picks.filter(k=>k!==key);if(d.captain_key===key)d.captain_key='';if(d.vice_key===key)d.vice_key='';changed();return render();}
  if((action==='captain'||action==='vice')&&editable()&&d.picks.includes(key)){
    if(action==='captain'){d.captain_key=key;if(d.vice_key===key)d.vice_key='';}else{d.vice_key=key;if(d.captain_key===key)d.captain_key='';}
    changed();return render();
  }
  if(action==='search-pick'){const p=player(key);if(p){search=p.name;searchSugOpen=false;}return render();}
  if(action==='transfer-start'&&canTransfer(key)){transferOut=key;filter='slot';search='';return render();}
  if(action==='transfer-cancel'){transferOut='';return render();}
  if(action==='transfer-pick'&&transferOut&&canTransfer(transferOut)) {
    const issue=selectionError(key);if(issue){notice=issueText(issue);return render();}
    if(!window.confirm(tr('Подтвердить замену на ','Confirm transfer to ')+player(key).name+'?'))return;
    busy=true;render();
    try {await api('transfer',{team_slot:slot,player_out_key:transferOut,player_in_key:key});D=await api('bootstrap');drafts.delete(slot);transferOut='';}
    finally {busy=false;render();}
  }
}
let handling=false;
app.addEventListener('click',event=>{
  const el=event.target.closest('button[data-action]');
  if(el&&!el.disabled&&!handling){handling=true;handle(el.dataset.action,el).catch(e=>{notice=e.message;render();}).finally(()=>{handling=false;});}
});
app.addEventListener('input',event=>{
  if(event.target.id==='team-name'){draft().team_name=event.target.value;changed();const nextButton=app.querySelector('[data-action="next"]');if(nextButton)nextButton.disabled=!draft().team_name.trim();return;}
  if(event.target.id==='player-search'){search=event.target.value;searchSugOpen=!!search.trim();const pos=event.target.selectionStart;render();const input=document.getElementById('player-search');input.focus();input.setSelectionRange(pos,pos);}
});
app.addEventListener('focusout',event=>{
  if(event.target.id==='player-search'&&searchSugOpen)setTimeout(()=>{searchSugOpen=false;render();},150);
});
app.addEventListener('error',event=>{if(event.target.tagName==='IMG'){const span=document.createElement('span');span.className='avatar';span.textContent='PTF';event.target.replaceWith(span);}},true);
function setTheme(value) {document.documentElement.dataset.theme=value;try{localStorage.setItem('ptf_theme',value);tg?.setHeaderColor(value==='light'?'#f2f5f1':'#0a0a0b');}catch{}}
try{setTheme(localStorage.getItem('ptf_theme')==='light'?'light':'dark');tg?.BackButton?.onClick(()=>back().catch(e=>{notice=e.message;render();}));}catch{}
api('bootstrap').then(j=>{D=j;D.teams=D.teams||[];ru=j.lang==='ru';render();}).catch(e=>{D=null;app.innerHTML='<div class="card empty"><h2>'+tr('Нет доступа','Access denied')+'</h2><p>'+esc(e.message)+'</p></div>';});
// A long-open Telegram web view must stop offering edits at the deadline.
setInterval(()=>{if(D&&!D.locked&&deadlineReached(D)){D.locked=true;D.entry_open=false;review=null;render();api('bootstrap').then(j=>{D=j;render();}).catch(()=>{});}},1000);

