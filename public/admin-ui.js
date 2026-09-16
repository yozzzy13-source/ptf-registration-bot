
const tg=window.Telegram?.WebApp; tg?.ready(); tg?.expand(); const initData=tg?.initData||''; let contacts=[],filtered=[],selected=new Set();
const $=id=>document.getElementById(id); function status(t,err=false){$('status').innerHTML=err?`<span class="err">${t}</span>`:t}
function filters(){return {status:$('fStatus').value,division:$('fDivision').value,language:$('fLanguage').value,selfie_status:$('fSelfie').value,rating:$('fRating').value,event:$('fEvent').value,search:$('fSearch').value.trim(),selected_ids:[...selected]}}
function noSelectionFilters(){const f=filters(); delete f.selected_ids; return f}
function matches(c){const f=noSelectionFilters(); const n=v=>String(v||'').toLowerCase(); if(f.status&&n(c.status)!==n(f.status))return false;if(f.division&&n(c.division)!==n(f.division))return false;if(f.language){if(f.language==='ru'&&n(c.language)!=='ru')return false;if(f.language==='en'&&n(c.language)==='ru')return false}if(f.selfie_status){if(f.selfie_status==='missing'){if(n(c.selfie_status)==='received')return false}else if(n(c.selfie_status)!==n(f.selfie_status))return false}if(f.event&&!n(c.last_application_event).includes(n(f.event)))return false;if(f.rating==='missing'&&!c.missing_rating)return false;if(f.rating==='set'&&c.missing_rating)return false;if(f.search){const hay=[c.name,c.telegram_username,c.telegram_id,c.whatsapp,c.country,c.crm_tags].map(n).join(' ');if(!hay.includes(n(f.search)))return false}return true}
function renderStats(stats){const labels=window.PTF_LANG==='ru'?{contacts:'Контакты',applications:'Заявки',active:'Активные',waitlist:'Лист ожидания',unpaid:'Ожидают оплаты',proofReceived:'Получены чеки',paid:'Оплата подтверждена',rejectedPayments:'Оплата отклонена',paidThb:'Оплачено THB',paidUsdt:'Оплачено USDT',missingSelfie:'Нет селфи'}:{contacts:'Contacts',applications:'Applications',active:'Active',waitlist:'Waitlist',unpaid:'Unpaid / waiting',proofReceived:'Proof received',paid:'Paid approved',rejectedPayments:'Payment rejected',paidThb:'Paid THB',paidUsdt:'Paid USDT',missingSelfie:'Missing selfies'};$('stats').innerHTML=Object.entries(stats).map(([k,v])=>`<div class="stat"><b>${v}</b><span>${labels[k]||k}</span></div>`).join('')}
function optionize(id,arr){const el=$(id);const first=el.querySelector('option')?.outerHTML||AUI("<option value=\"\">Все</option>");el.innerHTML=first+arr.map(x=>`<option value="${esc(x)}">${esc(id==='fStatus'?adminValue(x):x)}</option>`).join('')}
function renderTable(){filtered=contacts.filter(matches);$('countLine').textContent=`${AUI("Найдено: ")}${filtered.length}${AUI(" · отмечено: ")}${selected.size}`;let html=AUI("<thead><tr><th><input type=\"checkbox\" onchange=\"toggleAll(this.checked)\"></th><th>Игрок</th><th>Статус</th><th>Дивизион</th><th class=\"lo\">NTRP</th><th class=\"lo\">Селфи</th><th class=\"lo\">Язык</th><th class=\"lo\">Ник</th><th class=\"lo\">Событие</th><th class=\"lo\">Страна</th><th class=\"lo\">WhatsApp</th><th></th></tr></thead><tbody>");html+=filtered.map(c=>`<tr><td><input type="checkbox" ${selected.has(String(c.telegram_id))?'checked':''} onchange="toggleOne('${c.telegram_id}',this.checked)"></td><td class="grow"><b>${esc(c.name)}</b><br><span class="muted">${c.telegram_username?'@'+esc(c.telegram_username)+' · ':''}${esc(c.telegram_id)}</span></td><td><span class="pill">${esc(adminValue(c.status))}</span></td><td>${esc(c.division)}</td><td class="lo">${c.missing_rating?'<span class="err">—</span>':esc(c.ntrp)}</td><td class="lo">${esc(adminValue(c.selfie_status))}</td><td class="lo">${esc(c.language)}</td><td class="lo">${c.telegram_username?'@'+esc(c.telegram_username):''}</td><td class="lo">${esc(c.last_application_event)}</td><td class="lo">${esc(c.country)}</td><td class="lo">${esc(c.whatsapp)}</td><td><button class="btn secondary" onclick="event.stopPropagation();avOpen('${c.telegram_id}${AUI("')\">Аватар</button>")}${String(c.status||'').toLowerCase()==='active'?'':` <button class="btn secondary" onclick="event.stopPropagation();activatePlayer('${c.telegram_id}${AUI("')\">Активировать</button>")}`}</td></tr>`).join('');html+='</tbody>';$('playersTable').innerHTML=html;renderRecipients()}
function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
// Быстрый поиск по имени в списке игроков: подсказки появляются по мере
// набора, а сам список фильтруется по клику на подсказку или по «Применить».
function fSearchInput(v){
  const box=$('fSearchSug'),q=String(v||'').trim().toLowerCase();
  if(!q){box.classList.add('hidden');box.innerHTML='';return}
  const seen=new Set(),names=[];
  for(const c of contacts){const n=(c.name||'').trim();if(!n||seen.has(n))continue;if(n.toLowerCase().includes(q)){seen.add(n);names.push(n)}if(names.length>=6)break}
  if(!names.length){box.classList.add('hidden');box.innerHTML='';return}
  box.innerHTML=names.map(n=>`<div class="pi" onmousedown="event.preventDefault();fSearchPick('${n.replace(/'/g,"\\'")}')">${esc(n)}</div>`).join('');
  box.classList.remove('hidden');
}
function fSearchPick(name){$('fSearch').value=name;$('fSearchSug').classList.add('hidden');$('fSearchSug').innerHTML='';applyFilters()}
function fSearchBlur(){setTimeout(()=>{const b=$('fSearchSug');if(b){b.classList.add('hidden');b.innerHTML=''}},150)}
function toggleOne(id,on){if(on)selected.add(String(id));else selected.delete(String(id));renderTable()} function toggleAll(on){filtered.forEach(c=>on?selected.add(String(c.telegram_id)):selected.delete(String(c.telegram_id)));renderTable()} function selectFiltered(){filtered.forEach(c=>selected.add(String(c.telegram_id)));renderTable()} function clearSelection(){selected.clear();renderTable()} function applyFilters(){renderTable()} function clearFilters(){['fStatus','fDivision','fLanguage','fSelfie','fRating','fEvent','fSearch'].forEach(id=>$(id).value='');const b=$('fSearchSug');if(b){b.classList.add('hidden');b.innerHTML=''}renderTable()}
async function api(path,body=null){const opts=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData,...body})}:{};const url=body?path:path+(path.includes('?')?'&':'?')+'initData='+encodeURIComponent(initData);const r=await fetch(url,opts);const j=await r.json();if(!j.ok)throw new Error(j.error||'Error');return j}
async function reload(){try{status(AUI("Загружаю…"));const j=await api('/api/admin/bootstrap');contacts=j.contacts||[];renderStats(j.stats||{});optionize('fStatus',j.statuses||[]);optionize('fDivision',j.divisions||[]);
  // Список событий для фильтра: из листа Events плюс то, что реально стоит у игроков.
  const evNames=[...new Set([...(j.events||[]).map(e=>e.event_name||e.name||'').filter(Boolean),
    ...contacts.map(c=>c.last_application_event||'').filter(Boolean)])].sort();
  optionize('fEvent',evNames);
  // Дивизионы для фильтра рассылки события — тот же список, что и в фильтрах игроков.
  const dv=$('evDivision');
  if(dv)dv.innerHTML=AUI("<option value=\"\">Любой</option>")+(j.divisions||[]).map(d=>{
    const k=String(d).replace(/^(division|дивизион)\s*/i,'').trim().toUpperCase();
    return `<option value="${esc(k)}">${esc(d)}</option>`;
  }).join('');
  initEventPickers();evRenderInvited();evAudienceChanged();
  renderCodes(j.link_codes||[]);renderTable();status(AUI("Готово"))}catch(e){status(e.message,true)}}
function renderCodes(list){const html=list.map(c=>`<span onclick="insertCode('${esc(c.code)}')" title="${esc(c.label)}">${esc(c.label)}</span>`).join('');$('codeChips').innerHTML=html;
  const d=$('directCodeChips');if(d)d.innerHTML=list.map(c=>`<span onclick="insertCode('${esc(c.code)}','directText')" title="${esc(c.label)}">${esc(c.label)}</span>`).join('')}
function insertCode(code,target){const t=$(target||'broadcastText');const tag='{'+code+'}';const a=t.selectionStart||t.value.length;const b=t.selectionEnd||a;t.value=t.value.slice(0,a)+(a&&t.value[a-1]!=='\n'?'\n\n':'')+tag+t.value.slice(b);t.focus();t.selectionStart=t.selectionEnd=a+tag.length+2}
// --- Рассылка по событию ---------------------------------------------------
// Одно событие за раз: конкретный ивент — конкретный пул записанных. На второй
// ивент делается отдельная рассылка, поэтому подстановки в тексте однозначны.
let bcTo='players',bcWhom='all',bcTimer=null;
function bcMode(m){
  bcTo=m;
  document.querySelectorAll('#bcMode .s').forEach(s=>s.classList.toggle('on',s.dataset.m===m));
  $('bcEventBox').classList.toggle('hidden',m!=='event');
  $('bcPlayersBox').classList.toggle('hidden',m!=='players');
  if(m==='event')bcFillEvents();
}
function bcScope(s){
  bcWhom=s;
  document.querySelectorAll('#bcScope .s').forEach(x=>x.classList.toggle('on',x.dataset.s===s));
  bcCount();
}
async function bcFillEvents(){
  const sel=$('bcEvent');if(!sel||sel.dataset.filled)return;
  try{
    // Список событий берём с сервера: вкладку «События» могли и не открывать.
    const j=await api('/api/admin/events');
    evData=j.events||evData||[];
  }catch(e){}
  const list=(evData||[]).filter(e=>e.event_id);
  sel.innerHTML=AUI("<option value=\"\">— выбери событие —</option>")+list.map(e=>{
    const when=[e.date,e.time].filter(Boolean).join(' ');
    const n=e.signups!==undefined?AUI(" · записано ")+e.signups:'';
    return `<option value="${esc(e.event_id)}">${esc(e.title_ru||e.title_en||e.event_id)}${when?' · '+esc(when):''}${esc(n)}</option>`;
  }).join('');
  sel.dataset.filled='1';
}
const BC_SCOPE_NAMES={all:AUI("все записанные"),confirmed:AUI("участвуют"),waitlist:AUI("лист ожидания"),unpaid:AUI("не оплатили")};
async function bcCount(){
  const id=$('bcEvent').value;
  const box=$('bcCount');
  if(!id){box.textContent=AUI("Выбери событие");$('bcWho').innerHTML='';return}
  box.textContent=AUI("Считаю…");
  clearTimeout(bcTimer);
  bcTimer=setTimeout(async()=>{
    try{
      const j=await api(`/api/admin/event-recipients?event_id=${encodeURIComponent(id)}&scope=${encodeURIComponent(bcWhom)}`);
      const c=j.counts||{};
      const tail=Object.keys(BC_SCOPE_NAMES).filter(k=>k!=='all'&&c[k]).map(k=>`${BC_SCOPE_NAMES[k]}: ${c[k]}`).join(' · ');
      box.innerHTML=`${AUI("Получателей: <b>")}${j.count}</b> (${esc(BC_SCOPE_NAMES[bcWhom]||bcWhom)})`+(tail?`<br><span class="muted">${esc(tail)}</span>`:'');
      $('bcWho').innerHTML=(j.names||[]).map(n=>`<span>${esc(n)}</span>`).join('')||AUI("<span>никого</span>");
    }catch(e){box.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  },120);
}
async function previewBroadcast(lang='ru'){const box=$('broadcastPreview');try{const j=await api('/api/admin/broadcast-preview',{message_ru:$('broadcastText').value,message_en:$('broadcastTextEn').value,lang,event_id:bcTo==='event'?$('bcEvent').value:''});box.classList.remove('hidden');const btns=(j.buttons||[]).map(b=>`<span class="pbtn">${esc(b)}</span>`).join('');box.innerHTML=j.text.replace(/\n/g,'<br>')+(btns?'<div style="margin-top:10px">'+btns+'</div>':'')+(j.inline?`${AUI("<div class=\"muted\" style=\"margin-top:8px\">ссылок в тексте: ")}${j.inline}</div>`:'')+((j.unknown||[]).length?`${AUI("<div class=\"warn\">⚠️ неизвестные коды: ")}${esc(j.unknown.join(', '))}</div>`:'')}catch(e){box.classList.remove('hidden');box.innerHTML=`<span class="err">${esc(e.message)}</span>`}}
let broadcastPhotos=[];
function bcResizePhoto(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error(AUI("Не удалось прочитать фотографию")));
    reader.onload=()=>{const img=new Image();img.onerror=()=>reject(new Error(AUI("Не удалось открыть фотографию")));img.onload=()=>{
      const max=1200,scale=Math.min(1,max/Math.max(img.width,img.height)),w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);resolve(canvas.toDataURL('image/jpeg',.82));
    };img.src=String(reader.result)};reader.readAsDataURL(file);
  });
}
async function bcPhotoPick(input){
  try{
    const files=[...(input.files||[])].slice(0,10);
    if(!files.length)return;
    const next=await Promise.all(files.map(bcResizePhoto));
    const merged=broadcastPhotos.concat(next).slice(0,10);
    if(merged.reduce((n,x)=>n+x.length,0)>8.5*1024*1024)throw new Error(AUI("Фотографии слишком большие для одной рассылки"));
    broadcastPhotos=merged;bcRenderPhotos();
  }catch(e){$('broadcastResult').innerHTML='<span class="err">'+esc(e.message)+'</span>'}
  input.value='';
}
function bcRemovePhoto(i){broadcastPhotos.splice(i,1);bcRenderPhotos()}
function bcClearPhotos(){broadcastPhotos=[];bcRenderPhotos();const i=$('broadcastPhotoInput');if(i)i.value=''}
function bcRenderPhotos(){const box=$('broadcastPhotoPreview');if(!box)return;box.innerHTML=broadcastPhotos.map((src,i)=>'<div class="pv"><img src="'+src+'" alt=""><button type="button" onclick="bcRemovePhoto('+i+')">✕</button></div>').join('')}
async function sendBroadcast(){try{
  const message=$('broadcastText').value.trim();
  let body;
  if(bcTo==='event'){
    const id=$('bcEvent').value;
    if(!id)throw new Error(AUI("Сначала выбери событие"));
    const who=$('bcEvent').selectedOptions[0]?.textContent||'';
    if(!confirm(`${AUI("Отправить записанным на «")}${who}» (${BC_SCOPE_NAMES[bcWhom]})?`))return;
    body={message,button:$('broadcastButton').value,event_id:id,scope:bcWhom};
  } else {
    if(!confirm(AUI("Отправить рассылку?")))return;
    const useSelected=selected.size>0;
    body={message,button:$('broadcastButton').value,filters:useSelected?{selected_ids:[...selected]}:noSelectionFilters()};
  }
  body.message_ru=$('broadcastText').value.trim();body.message_en=$('broadcastTextEn').value.trim();body.photos=broadcastPhotos.slice();
  const j=await api('/api/admin/broadcast',body);
  $('broadcastResult').innerHTML=`${AUI("✅ Ушло: <b>")}${j.sent}${AUI("</b>, ошибок: <b>")}${j.failed}${AUI("</b>, получателей: <b>")}${j.recipients}${AUI("</b> — подробности во вкладке «История»")}`;history=[];bcClearPhotos()
}catch(e){$('broadcastResult').innerHTML=`<span class="err">${esc(e.message)}</span>`}}
async function sendDirect(){try{const id=$('directId').value.trim()||[...selected][0];if(!id)throw new Error(AUI("Сначала выбери игрока"));const message=$('directText').value.trim();const j=await api('/api/admin/direct-message',{telegram_id:id,message,button:$('directButton').value});$('directResult').innerHTML=AUI("✅ Отправлено")}catch(e){$('directResult').innerHTML=`<span class="err">${esc(e.message)}</span>`}}
async function requestSelfies(){try{if(!confirm(AUI("Запросить селфи у отфильтрованных активных игроков?")))return;const useSelected=selected.size>0;const j=await api('/api/admin/request-selfie',{filters:useSelected?{selected_ids:[...selected]}:noSelectionFilters()});$('selfieResult').innerHTML=`${AUI("✅ Ушло: <b>")}${j.sent}${AUI("</b>, ошибок: <b>")}${j.failed}${AUI("</b>, получателей: <b>")}${j.recipients}</b>`;await reload()}catch(e){$('selfieResult').innerHTML=`<span class="err">${esc(e.message)}</span>`}}
async function requestRatings(){try{if(!confirm(AUI("Запросить рейтинг NTRP?")))return;const useSelected=selected.size>0;const j=await api('/api/admin/request-rating',{filters:useSelected?{selected_ids:[...selected]}:noSelectionFilters()});$('ratingResult').innerHTML=`${AUI("✅ Ушло: <b>")}${j.sent}${AUI("</b>, ошибок: <b>")}${j.failed}${AUI("</b>, получателей: <b>")}${j.recipients}</b>`;await reload()}catch(e){$('ratingResult').innerHTML=`<span class="err">${esc(e.message)}</span>`}}
let history=[],openId='',logsCache={};
function segLabel(s){if(!s)return '';try{const f=JSON.parse(s);if(f.selected_ids)return `selected: ${f.selected_ids.length}`;const parts=Object.entries(f).filter(([k,v])=>v&&k!=='selected_ids').map(([k,v])=>`${k}=${v}`);return parts.length?parts.join(', '):'all'}catch{return s}}
function fmtDate(v){if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?String(v).slice(0,16):d.toLocaleString((window.PTF_LANG==='ru'?'ru-RU':'en-GB'),{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
async function loadHistory(){try{$('hCount').textContent=AUI("Загружаю…");const j=await api('/api/admin/broadcasts');history=j.broadcasts||[];logsCache={};renderHistory()}catch(e){$('hCount').innerHTML=`<span class="err">${esc(e.message)}</span>`}}
function renderHistory(){const q=$('hSearch').value.trim().toLowerCase();const fo=$('hFailedOnly').checked;const rows=history.filter(b=>(!fo||b.failed>0)&&(!q||[b.message_text,b.segment_filter,b.admin_name,b.broadcast_id].join(' ').toLowerCase().includes(q)));$('hCount').textContent=`${rows.length}${AUI(" из ")}${history.length}`;let html=AUI("<thead><tr><th>Дата</th><th class=\"lo\">Админ</th><th class=\"lo\">Кому</th><th>Сообщение</th><th class=\"num\">Ушло</th><th class=\"num\">Ошибок</th></tr></thead><tbody>");for(const b of rows){const open=openId===b.broadcast_id;html+=`<tr class="row ${open?'open':''}" onclick="toggleLogs('${esc(b.broadcast_id)}')"><td>${esc(fmtDate(b.created_at))}</td><td class="lo">${esc(b.admin_name)}</td><td class="lo"><span class="chip">${esc(segLabel(b.segment_filter))}</span>${b.media_type&&b.media_type!=='text'?`<span class="chip">${esc(b.media_type)}</span>`:''}</td><td class="grow"><div class="msg" title="${esc(b.message_text)}">${esc(b.message_text.replace(/<[^>]+>/g,''))}</div></td><td class="num ok-n">${b.sent}/${b.recipients}</td><td class="num ${b.failed?'fail-n':'muted'}">${b.failed}</td></tr>`;if(open)html+=`<tr class="logs"><td colspan="6" id="logs-${esc(b.broadcast_id)}">${renderLogs(b.broadcast_id)}</td></tr>`}html+='</tbody>';$('historyTable').innerHTML=html}
function renderLogs(id){const l=logsCache[id];if(!l)return AUI("<span class=\"muted\">Загружаю получателей…</span>");if(!l.length)return AUI("<span class=\"muted\">Пофамильного журнала по этой рассылке нет.</span>");return `<table><tbody>${l.map(r=>`<tr class="${r.status==='failed'?'fail':''}"><td>${r.status==='failed'?'❌':'✅'}</td><td><b>${esc(r.name||'')}</b> ${r.telegram_username?'@'+esc(r.telegram_username):''} <span class="muted">${esc(r.telegram_id)}</span></td><td>${esc(r.language)}</td><td>${esc(fmtDate(r.sent_at))}</td><td>${esc(r.error||'')}</td></tr>`).join('')}</tbody></table>`}
async function toggleLogs(id){openId=openId===id?'':id;renderHistory();if(openId&&!logsCache[id]){try{const j=await api('/api/admin/broadcast-logs?broadcast_id='+encodeURIComponent(id));logsCache[id]=j.logs||[];}catch(e){logsCache[id]=[{status:'failed',name:'Load error',error:e.message}]}if(openId===id)renderHistory()}}

// --- события -----------------------------------------------------------------
// Карточка живёт как черновик, пока организатор не подтвердит её в боте.
let evEditing='';
// Дата и время выбираются из списков: руками получалось «13.092026», и такая
// карточка уходила игрокам как есть.
const EV_DAYS=90;
function pad2(n){return String(n).padStart(2,'0')}
function dmy(d){return pad2(d.getDate())+'.'+pad2(d.getMonth()+1)+'.'+d.getFullYear()}
const EV_WD=[AUI("вс"),AUI("пн"),AUI("вт"),AUI("ср"),AUI("чт"),AUI("пт"),AUI("сб")];
function evDateOptions(){
  const out=[AUI("<option value=\"\">— выбери дату —</option>")];
  const now=new Date();now.setHours(12,0,0,0);
  for(let i=0;i<EV_DAYS;i++){
    const d=new Date(now.getTime()+i*86400000);const v=dmy(d);
    out.push(`<option value="${v}">${v} · ${EV_WD[d.getDay()]}</option>`);
  }
  return out.join('');
}
function evTimeOptions(){
  const out=[AUI("<option value=\"\">— выбери время —</option>")];
  for(let h=6;h<=22;h++)for(const m of ['00','30']){
    if(h===22&&m==='30')continue;
    const v=pad2(h)+':'+m;out.push(`<option value="${v}">${v}</option>`);
  }
  return out.join('');
}
function shiftDate(v,days){
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v||''));
  if(!m)return '';
  const d=new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),12,0,0);
  return dmy(new Date(d.getTime()+days*86400000));
}
// Значение может быть не из списка (старая карточка) — добавляем его отдельным
// пунктом, иначе правка молча стёрла бы дату.
function evSetSelect(id,value){
  const el=$(id);const v=String(value||'').trim();
  if(v&&![...el.options].some(o=>o.value===v))
    el.insertAdjacentHTML('beforeend',`<option value="${esc(v)}">${esc(v)}</option>`);
  el.value=v;
}
function initEventPickers(){
  $('evDate').innerHTML=evDateOptions();
  $('evDeadline').innerHTML=evDateOptions();
  $('evTime').innerHTML=evTimeOptions();
  // «Запись до» по умолчанию — за день до события.
  $('evDate').onchange=()=>{ if(!$('evDeadline').value)evSetSelect('evDeadline',shiftDate($('evDate').value,-1)) };
}

// --- кого приглашаем ---------------------------------------------------------
let evInvited=new Map(),evPickIdx=-1,evPickRows=[];
function evAudienceChanged(){
  $('evPickWrap').classList.toggle('hidden',$('evAudience').value!=='personal');
}
function evRenderInvited(){
  const box=$('evInvited');
  const list=[...evInvited.values()];
  $('evInvitedCount').textContent=list.length?`${AUI("Выбрано: ")}${list.length}`:AUI("Никого не выбрано");
  box.innerHTML=list.length?list.map(c=>`<label class="r on"><input type="checkbox" checked onchange="evInviteOff('${esc(c.telegram_id)}')"><span><span class="nm">${esc(c.name||c.telegram_id)}</span> <span class="sub">${c.telegram_username?'@'+esc(c.telegram_username):esc(c.telegram_id)}</span></span></label>`).join(''):'';
}
function evInviteOff(id){evInvited.delete(String(id));evRenderInvited()}
function evPickMatches(q){
  const s=String(q||'').trim().toLowerCase().replace(/^@/,'');
  if(!s)return [];
  return (contacts||[]).filter(c=>!evInvited.has(String(c.telegram_id))&&(
    String(c.name||'').toLowerCase().includes(s)||
    String(c.telegram_username||'').toLowerCase().includes(s)||
    String(c.telegram_id||'').includes(s))).slice(0,8);
}
function evPickInput(q){
  evPickRows=evPickMatches(q);evPickIdx=-1;
  const box=$('evPickSug');
  if(!evPickRows.length){box.classList.add('hidden');box.innerHTML='';return}
  box.innerHTML=evPickRows.map((c,i)=>`<div onclick="evPickChoose(${i})"><b>${esc(c.name||'—')}</b> <span class="sub">${c.telegram_username?'@'+esc(c.telegram_username):esc(c.telegram_id)}${c.division?' · '+esc(c.division):''}</span></div>`).join('');
  box.classList.remove('hidden');
}
function evPickChoose(i){
  const c=evPickRows[i];if(!c)return;
  evInvited.set(String(c.telegram_id),c);
  $('evPick').value='';$('evPickSug').classList.add('hidden');$('evPickSug').innerHTML='';
  evRenderInvited();
}
function evPickKey(e){
  const box=$('evPickSug');if(box.classList.contains('hidden'))return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    evPickIdx=Math.max(0,Math.min(evPickRows.length-1,evPickIdx+(e.key==='ArrowDown'?1:-1)));
    [...box.children].forEach((el,i)=>el.classList.toggle('on',i===evPickIdx));
  } else if(e.key==='Enter'){ e.preventDefault();evPickChoose(evPickIdx<0?0:evPickIdx); }
  else if(e.key==='Escape'){ box.classList.add('hidden'); }
}

function evForm(){return{
  event_id:evEditing,
  title_ru:$('evTitleRu').value.trim(),title_en:$('evTitleEn').value.trim(),
  description_ru:$('evDescRu').value.trim(),description_en:$('evDescEn').value.trim(),
  date:$('evDate').value.trim(),time:$('evTime').value.trim(),end_time:$('evEndTime').value, 
  place:$('evPlace').value.trim(),place_url:$('evPlaceUrl').value.trim(),
  price_thb:$('evPrice').value||'',guest_price_thb:$('evGuestPrice').value||'',
  capacity:$('evCapacity').value||'',signup_deadline:$('evDeadline').value.trim(),
  payment_required:$('evPaid').checked,guests_allowed:$('evGuests').checked,
  max_guests:$('evMaxGuests').value||'',refund_hours:$('evRefund').value||'',
  audience:$('evAudience').value,
  audience_division:$('evDivision').value,
  invite_only:$('evInviteOnly').checked,
  invited_ids:[...evInvited.keys()]
}}
function newEvent(){
  evEditing='';
  ['evTitleRu','evTitleEn','evDescRu','evDescEn','evDate','evTime','evEndTime','evPlace','evPlaceUrl','evPrice','evGuestPrice','evCapacity','evDeadline','evMaxGuests','evRefund'].forEach(id=>$(id).value='');
  $('evAudience').value='all';$('evDivision').value='';$('evInviteOnly').checked=false;
  evInvited=new Map();evRenderInvited();evAudienceChanged();
  $('evResult').textContent=AUI("Новая карточка");
}
async function saveEvent(){
  try{const j=await api('/api/admin/event-save',{event:evForm()});evEditing=j.event.event_id;
    $('evResult').innerHTML=AUI("<span class=\"ok\">Сохранено: ")+j.event.event_id+'</span>';loadEvents()}
  catch(e){$('evResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// Ручная перерассылка тем, кто не записался. Сам текст и защита от спама — в боте.
async function nudgeEvent(id){
  try{ await api('/api/admin/event-nudge',{event_id:id});
    $('evResult').innerHTML=AUI("<span class=\"ok\">Напоминание запущено — отчёт придёт в бот.</span>") }
  catch(e){ $('evResult').innerHTML='<span class="err">'+e.message+'</span>' }
}
async function previewEvent(){
  try{if(!evEditing)await saveEvent();
    await api('/api/admin/event-preview',{event_id:evEditing});
    $('evResult').innerHTML=AUI("<span class=\"ok\">Карточка ушла тебе в бот — подтверди там.</span>")}
  catch(e){$('evResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
function editEvent(id){
  const e=(evData||[]).find(x=>x.event_id===id);if(!e)return;
  evEditing=id;
  $('evTitleRu').value=e.title_ru||'';$('evTitleEn').value=e.title_en||'';
  $('evDescRu').value=e.description_ru||'';$('evDescEn').value=e.description_en||'';
  evSetSelect('evDate',e.date||'');evSetSelect('evTime',e.time||'');$('evEndTime').value=e.end_time||'';
  $('evPlace').value=e.place||'';$('evPlaceUrl').value=e.place_url||'';
  $('evPrice').value=e.price_thb||'';$('evGuestPrice').value=e.guest_price_thb==null?'':e.guest_price_thb;
  $('evCapacity').value=e.capacity||'';evSetSelect('evDeadline',e.signup_deadline||'');
  $('evMaxGuests').value=e.max_guests||'';$('evRefund').value=e.refund_hours||'';
  $('evPaid').checked=!!e.payment_required;$('evGuests').checked=!!e.guests_allowed;
  $('evAudience').value=e.audience||'all';
  $('evDivision').value=e.audience_division||'';
  $('evInviteOnly').checked=!!e.invite_only;
  evInvited=new Map();
  (e.invited_ids||[]).forEach(id=>{
    const c=(contacts||[]).find(x=>String(x.telegram_id)===String(id));
    evInvited.set(String(id),c||{telegram_id:String(id),name:String(id)});
  });
  evRenderInvited();evAudienceChanged();
  $('evResult').textContent=AUI("Правим: ")+(e.title_ru||e.event_id);
  window.scrollTo(0,0);
}
let evData=[];
async function loadEvents(){
  try{const j=await api('/api/admin/events');evData=j.events||[];
    $('eventsTable').innerHTML=AUI("<tr><th>Событие</th><th>Когда</th><th>Статус</th><th>Мест</th><th class=\"lo\">Записей</th><th></th></tr>")
      +evData.map(e=>'<tr><td class="grow"><b>'+esc(e.title_ru||e.title_en||e.event_id)+'</b></td><td>'+esc([e.date,e.time].filter(Boolean).join(' '))+'</td>'
        +'<td><span class="pill">'+esc(e.past?AUI('Прошло'):e.status)+'</span></td><td class="num">'+(e.capacity?e.seats+' / '+e.capacity:e.seats)+'</td>'
        +'<td class="num lo">'+e.signups+'</td>'
        +'<td><button class="btn secondary" onclick="editEvent(\''+e.event_id+AUI("')\">Править</button> ")
        +'<button class="btn danger" onclick="deleteEvent(\''+e.event_id+AUI("')\">Удалить</button> ")
        +(e.status==='published'&&!e.past?'<button class="btn secondary" onclick="nudgeEvent(\''+e.event_id+AUI("')\">Напомнить</button>"):'')
        +'</td></tr>').join('')}
  catch(e){$('evResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// Проверка «глазами группы»: сообщение с её кнопками уходит мне в бот, а
// мини-апп открывается с её набором вкладок прямо здесь, в том же окне.
async function previewAs(){
  $('previewResult').textContent=AUI("Отправляю…");
  try{const j=await api('/api/admin/preview-as',{group:menuGroup()});
    $('previewResult').innerHTML=AUI("<span class=\"ok\">Готово — посмотри сообщение в чате с ботом (")+j.buttons+AUI(" кнопок под сообщением, ")+j.keyboard+AUI(" внизу).</span>")}
  catch(e){$('previewResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
function openAs(){location.href='/league?as='+encodeURIComponent(menuGroup())}

// --- удаление события ---------------------------------------------------------
// Спрашиваем один раз и на всё событие: как возвращать деньги. Дальше бот сам
// оповещает записавшихся, правит разосланные карточки и стирает строку.
async function deleteEvent(id){
  const e=(evData||[]).find(x=>x.event_id===id)||{};
  const name=e.title_ru||e.title_en||id;
  let impact={people:0,paid:0};
  try{impact=await api('/api/admin/event-impact?event_id='+encodeURIComponent(id))}catch(_){}
  const who=impact.people?(AUI("Записано: ")+impact.people+(impact.paid?(AUI(", оплачено на ")+impact.paid+' ฿'):AUI(", оплат не было"))):AUI("Записавшихся нет.");
  if(!confirm(AUI("Удалить «")+name+'»?\n\n'+who+AUI("\nСобытие исчезнет совсем, разосланные карточки станут «событие отменено».")))return;
  let mode='balance';
  if(impact.paid>0){
    mode=confirm(AUI("Вернуть ")+impact.paid+AUI(" ฿ на балансы игроков?\n\nОК — вернуть на балансы.\nОтмена — верну переводом сам (бот запишет долг в список)."))?'balance':'manual';
  }
  $('evResult').textContent=AUI("Удаляю…");
  try{
    const j=await api('/api/admin/event-delete',{event_id:id,refund_mode:mode});
    const tail=mode==='manual'&&j.owed?(AUI(" К возврату вручную: ")+j.owed+AUI(" ฿ — смотри вкладку «Возвраты».")):(j.refund_sum?(AUI(" Возвращено на депозиты: ")+j.refund_sum+' ฿.'):'');
    $('evResult').innerHTML=AUI("<span class=\"ok\">Удалено. Оповещено: ")+(j.told||0)+'.'+tail+'</span>';
    if(evEditing===id)newEvent();
    loadEvents();
  }catch(e){$('evResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// --- ручные возвраты ----------------------------------------------------------
let rfData=[];
async function loadRefunds(){
  try{
    const j=await api('/api/admin/refunds'+($('rfAll').checked?'?all=1':''));
    rfData=j.refunds||[];
    $('refundsTable').innerHTML=AUI("<tr><th class=\"lo\">Когда</th><th>Игрок</th><th class=\"lo\">Событие</th><th>Сумма</th><th>Статус</th><th></th></tr>")
      +(rfData.length?rfData.map(r=>'<tr><td class="lo">'+esc((r.created_at||'').slice(0,10))+'</td><td class="grow"><b>'+esc(r.name||r.telegram_id)+'</b></td>'
        +'<td class="lo">'+esc(r.event_title||'')+'</td><td class="num"><b>'+r.amount_thb+' ฿</b></td>'
        +'<td><span class="pill">'+(r.status==='sent'?AUI("отправлен"):AUI("ждёт"))+'</span></td>'
        +'<td>'+(r.status==='sent'?'':'<button class="btn" onclick="refundSent(\''+r.refund_id+AUI("')\">Отправил</button>"))+'</td></tr>').join('')
        :AUI("<tr><td colspan=\"6\" class=\"muted\">Ничего не ждёт возврата.</td></tr>"));
    $('rfResult').textContent='';
  }catch(e){$('rfResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
async function refundSent(id){
  try{await api('/api/admin/refund-sent',{refund_id:id,sent:true});loadRefunds()}
  catch(e){$('rfResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// --- кнопки по группам --------------------------------------------------------
// Две настройки в одном месте: вкладки внизу мини-приложения и кнопки под
// сообщением бота. Одна группа на экране — на телефоне четыре колонки галочек
// читать невозможно. Содержание кнопок не меняем, только видимость и порядок.
const TAB_NAMES={home:AUI("Лига"),div:AUI("Дивизионы"),race:AUI("Гонка"),players:AUI("Игроки"),matches:AUI("Матчи"),events:AUI("События"),about:AUI("О лиге")};
const BTN_NAMES={events:AUI("📆 События"),join_event:AUI("🎾 Заявка на событие"),matches:AUI("🎾 Мои матчи"),participants:AUI("👥 Состав"),league:AUI("🏆 Лига"),
  about:AUI("ℹ️ О лиге"),how:AUI("📖 Как работает лига"),yearly:AUI("⭐ Гонка года"),pass:AUI("💳 Оплатить взнос"),contact:AUI("💬 Связаться")};
const GROUP_NAMES={active:AUI("Активные"),waitlist:AUI("Лист ожидания"),applied:AUI("Заявка без оплаты"),guest:AUI("Все остальные")};
const KB_NAMES={events:AUI("📆 События"),matches:AUI("🎾 Мои матчи"),result:AUI("📊 Результат"),court:AUI("📅 Корт"),league:AUI("🏆 Лига"),
  squad:AUI("👥 Состав"),apply:AUI("🎾 Заявка"),pay:AUI("💳 Оплатить"),contact:AUI("💬 Связаться"),menu:AUI("🏠 Меню")};
let tabsState={},btnsState={},kbState={},tabsAll=[],btnsAll=[],kbAll=[],tabsAlways=[];
function menuGroup(){return $('menuGroup').value||'active'}
async function loadTabs(){
  try{
    const j=await api('/api/admin/tabs');
    tabsAll=j.all||[];btnsAll=j.allButtons||[];kbAll=j.allKeyboard||[];tabsAlways=j.always||[];
    tabsState=j.tabs||{};btnsState=j.buttons||{};kbState=j.keyboard||{};
    const sel=$('menuGroup');
    if(!sel.options.length)sel.innerHTML=Object.keys(GROUP_NAMES).map(g=>'<option value="'+g+'">'+esc(GROUP_NAMES[g])+'</option>').join('');
    renderTabs();$('menuResult').textContent='';
  }catch(e){$('menuResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
function menuRows(gridId,state,all,names,kind){
  const g=menuGroup();
  const on=state[g]||[];
  const off=all.filter(t=>on.indexOf(t)<0);
  const rows=on.map(t=>'<div class="r on"><input type="checkbox" checked onchange="menuToggle(\''+kind+'\',\''+t+'\')"'
      +(tabsAlways.indexOf(t)>=0&&kind==='tabs'?' disabled':'')+'>'
      +'<span class="nm">'+esc(names[t]||t)+'</span>'
      +'<span class="tags"><span class="chip" onclick="menuMove(\''+kind+'\',\''+t+'\',-1)">↑</span>'
      +'<span class="chip" onclick="menuMove(\''+kind+'\',\''+t+'\',1)">↓</span></span></div>').join('')
    +off.map(t=>'<div class="r"><input type="checkbox" onchange="menuToggle(\''+kind+'\',\''+t+'\')">'
      +'<span class="nm muted">'+esc(names[t]||t)+'</span></div>').join('');
  $(gridId).innerHTML='<div class="rcp">'+rows+'</div>'
    +(on.length?'':AUI("<div class=\"muted\" style=\"margin-top:6px\">Ничего не отмечено — эта группа не увидит ни одной кнопки.</div>"));
}
function renderTabs(){
  menuRows('menuGrid',tabsState,tabsAll,TAB_NAMES,'tabs');
  menuRows('btnGrid',btnsState,btnsAll,BTN_NAMES,'btns');
  menuRows('kbGrid',kbState,kbAll,KB_NAMES,'kb');
  $('previewResult').textContent='';
}
function menuState(kind){return kind==='tabs'?tabsState:(kind==='btns'?btnsState:kbState)}
function menuToggle(kind,t){
  if(kind==='tabs'&&tabsAlways.indexOf(t)>=0)return;
  const st=menuState(kind),g=menuGroup();
  const on=(st[g]||[]).slice();const i=on.indexOf(t);
  if(i>=0)on.splice(i,1);else on.push(t);
  st[g]=on;renderTabs();
}
function menuMove(kind,t,step){
  const st=menuState(kind),g=menuGroup();
  const on=(st[g]||[]).slice();const i=on.indexOf(t);const j=i+step;
  if(i<0||j<0||j>=on.length)return;
  on.splice(j,0,on.splice(i,1)[0]);
  st[g]=on;renderTabs();
}
// Старые имена оставлены: ими пользуются проверки и привычные вызовы.
function tabToggle(g,t){const st=tabsState;const on=(st[g]||[]).slice();const i=on.indexOf(t);if(i>=0)on.splice(i,1);else on.push(t);st[g]=on;renderTabs()}
function tabMove(g,t,step){const on=(tabsState[g]||[]).slice();const i=on.indexOf(t);const j=i+step;if(i<0||j<0||j>=on.length)return;on.splice(j,0,on.splice(i,1)[0]);tabsState[g]=on;renderTabs()}
async function saveTabs(){
  $('menuResult').textContent=AUI("Сохраняю…");
  try{const j=await api('/api/admin/tabs',{tabs:tabsState,buttons:btnsState,keyboard:kbState});
    tabsState=j.tabs||tabsState;btnsState=j.buttons||btnsState;kbState=j.keyboard||kbState;renderTabs();
    $('menuResult').innerHTML=AUI("<span class=\"ok\">Сохранено. Мини-апп подхватит при следующем открытии, нижняя клавиатура — при следующем сообщении боту.</span>")}
  catch(e){$('menuResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// --- касса --------------------------------------------------------------------
// Никакого ввода id руками: игрок выбирается из списка, операция — кнопкой,
// комментарий обязателен. Логика повторяет кассу тренерского бота.
let balList=[],balWho=null,balMode='',balSugItems=[],balSugHi=-1;
const BAL_PRESETS=[500,1000,3000,5000];
const BAL_NOTES={
  add:[AUI("пополнение депозита"),AUI("предоплата за события"),AUI("перевод на карту")],
  sub:[AUI("оплата участия"),AUI("оплата события"),AUI("корректировка")],
  refund:[AUI("возврат за событие"),AUI("возврат взноса"),AUI("отмена сезона")]
};
const BAL_TITLES={add:AUI("Сколько пополняем"),sub:AUI("Сколько списываем"),refund:AUI("Сколько возвращаем переводом")};

async function loadBalances(){
  try{
    const j=await api('/api/admin/balances');balList=j.balances||[];
    $('balancesTable').innerHTML=AUI("<tr><th>Игрок</th><th class=\"lo\">Telegram ID</th><th class=\"num\">Депозит</th></tr>")
      +(balList.length?balList.map(b=>'<tr onclick="balOpen(\''+esc(b.telegram_id)+'\')" style="cursor:pointer">'
        +'<td class="grow"><b>'+esc(b.name||b.telegram_id)+'</b></td>'
        +'<td class="lo muted">'+esc(b.telegram_id)+'</td>'
        +'<td class="num"><b>'+b.balance+' ฿</b></td></tr>').join('')
        :AUI("<tr><td class=\"muted\">Движений по депозитам пока не было.</td></tr>"))}
  catch(e){$('balResult').innerHTML='<span class="err">'+e.message+'</span>'}
}
// Поиск игрока — по всей базе, а не только по тем, у кого уже есть депозит.
function balPickInput(v){
  const q=String(v||'').trim().toLowerCase();
  const box=$('balSug');
  if(q.length<2){box.classList.add('hidden');balSugItems=[];return}
  balSugItems=(contacts||[]).filter(c=>[c.name,c.telegram_username,c.telegram_id].map(x=>String(x||'').toLowerCase()).join(' ').includes(q)).slice(0,25);
  balSugHi=-1;
  box.innerHTML=balSugItems.length
    ? balSugItems.map((c,i)=>'<div onmousedown="balPick('+i+')"><b>'+esc(c.name||c.telegram_id)+'</b>'
        +'<div class="sub">'+(c.telegram_username?'@'+esc(c.telegram_username)+' · ':'')+esc(c.status||'')+'</div></div>').join('')
    : AUI("<div class=\"muted\" style=\"padding:12px\">Никого не нашли</div>");
  box.classList.remove('hidden');
}
function balPickKey(e){
  if(!balSugItems.length)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();balSugHi=Math.max(0,Math.min(balSugItems.length-1,balSugHi+(e.key==='ArrowDown'?1:-1)));
    [...$('balSug').children].forEach((d,i)=>d.classList.toggle('hi',i===balSugHi));
  } else if(e.key==='Enter'){e.preventDefault();balPick(balSugHi<0?0:balSugHi)}
  else if(e.key==='Escape')balPickClose();
}
function balPickClose(){$('balSug').classList.add('hidden')}
function balPick(i){const c=balSugItems[i];if(!c)return;balPickClose();$('balPick').value='';balOpen(c.telegram_id,c)}

// ——— Аватарки игроков ———
const AV_SIDE=1024;
let avWho=null,avBusy=false;
async function avOpen(id){
  const c=(contacts||[]).find(x=>String(x.telegram_id)===String(id))||{telegram_id:id,name:String(id)};
  avWho={telegram_id:String(id),name:c.name||String(id)};
  $('avPanel').classList.remove('hidden');
  $('avName').textContent=avWho.name;
  $('avAv').textContent=(avWho.name||'?').trim().charAt(0).toUpperCase();
  $('avSub').textContent=[c.telegram_username?'@'+c.telegram_username:'',c.status||''].filter(Boolean).join(' · ');
  $('avResult').textContent='';$('avBig').innerHTML=AUI("<div class=\"muted\">Смотрю, что сейчас стоит…</div>");
  $('avPanel').scrollIntoView({behavior:'smooth',block:'start'});
  try{
    const j=await api('/api/admin/player-avatar?telegram_id='+encodeURIComponent(avWho.telegram_id));
    avShow(j.url,j.status);
  }catch(e){$('avBig').innerHTML='<span class="err">'+esc(e.message)+'</span>'}
}
function avShow(url,status){
  $('avBig').innerHTML=url
    ? '<img src="'+esc(url)+'" alt="" style="width:160px;height:160px;border-radius:14px;object-fit:cover;border:1px solid var(--line)"/>'
      +AUI("<div class=\"muted\" style=\"margin-top:6px\">Своя аватарка")+(status?' · '+esc(status):'')+'</div>'
    : AUI("<div class=\"muted\">Своей аватарки нет — в приложении показывается фото из общей таблицы.</div>");
  const clr=$('avClrBtn');if(clr)clr.classList.toggle('hidden',!url);
}
function avClose(){avWho=null;$('avPanel').classList.add('hidden')}
function avPickFile(input){
  const f=input.files&&input.files[0];input.value='';
  if(!f||!avWho)return;
  if(f.size>16*1024*1024){$('avResult').innerHTML=AUI("<span class=\"err\">Файл больше 16 МБ — выбери поменьше</span>");return}
  $('avResult').textContent=AUI("Готовлю квадрат 1024×1024…");
  const fr=new FileReader();
  fr.onerror=function(){$('avResult').innerHTML=AUI("<span class=\"err\">Не смог прочитать файл</span>")};
  fr.onload=function(){avSquare(String(fr.result)).then(avSend).catch(e=>{
    $('avResult').innerHTML='<span class="err">'+esc(e.message)+'</span>'})};
  fr.readAsDataURL(f);
}
// Обрезаем по центру и приводим к одному размеру — чтобы карточки не прыгали.
function avSquare(dataUrl){
  return new Promise(function(resolve,reject){
    const img=new Image();
    img.onerror=function(){reject(new Error(AUI("Это не похоже на картинку")))};
    img.onload=function(){
      const side=Math.min(img.naturalWidth||img.width,img.naturalHeight||img.height);
      if(!side)return reject(new Error(AUI("Пустая картинка")));
      const sx=((img.naturalWidth||img.width)-side)/2, sy=((img.naturalHeight||img.height)-side)/2;
      const cv=document.createElement('canvas');cv.width=AV_SIDE;cv.height=AV_SIDE;
      const ctx=cv.getContext('2d');
      ctx.fillStyle='#101214';ctx.fillRect(0,0,AV_SIDE,AV_SIDE);
      ctx.drawImage(img,sx,sy,side,side,0,0,AV_SIDE,AV_SIDE);
      resolve(cv.toDataURL('image/jpeg',0.9));
    };
    img.src=dataUrl;
  });
}
async function avSend(dataUrl){
  if(avBusy||!avWho)return;
  avBusy=true;$('avUpBtn').textContent=AUI("Отправляю…");$('avResult').textContent=AUI("Отправляю…");
  try{
    const j=await api('/api/admin/player-avatar',{telegram_id:avWho.telegram_id,photo:dataUrl});
    avShow(j.url,'published');
    $('avResult').innerHTML=AUI("✅ Аватарка обновлена, игроку ушло уведомление");
  }catch(e){$('avResult').innerHTML='<span class="err">'+esc(e.message)+'</span>'}
  avBusy=false;$('avUpBtn').textContent=AUI("Загрузить фото");
}
async function avClear(){
  if(!avWho)return;
  if(!confirm(AUI("Убрать аватарку у «")+avWho.name+AUI("»? Вернётся фото из общей таблицы.")))return;
  try{
    await api('/api/admin/player-avatar-clear',{telegram_id:avWho.telegram_id});
    avShow('','');
    $('avResult').innerHTML=AUI("✅ Аватарка убрана, игроку ушло уведомление");
  }catch(e){$('avResult').innerHTML='<span class="err">'+esc(e.message)+'</span>'}
}

async function balOpen(id,contact){
  const c=contact||(contacts||[]).find(x=>String(x.telegram_id)===String(id))
    ||balList.find(x=>String(x.telegram_id)===String(id))||{telegram_id:id,name:String(id)};
  balWho={telegram_id:String(c.telegram_id),name:c.name||String(c.telegram_id),
    username:c.telegram_username||'',status:c.status||''};
  $('balCard').classList.remove('hidden');
  $('balWho').textContent=balWho.name;
  $('balAv').textContent=(balWho.name||'?').trim().charAt(0).toUpperCase();
  $('balSubWho').textContent=[balWho.username?'@'+balWho.username:'',balWho.status].filter(Boolean).join(' · ');
  $('balResult').textContent='';balCloseOp();
  $('balNow').textContent='…';$('balHistory').innerHTML='';
  try{
    const j=await api('/api/admin/balance-history?telegram_id='+encodeURIComponent(balWho.telegram_id));
    $('balNow').textContent=j.balance;
    $('balHistory').innerHTML=(j.history||[]).length
      ? (j.history||[]).map(h=>'<div class="row2"><div><div>'+esc(h.description||h.type)+'</div>'
          +'<div class="d">'+esc(fmtDate(h.date))+' · '+esc(h.type)+'</div></div>'
          +'<div class="amt '+(h.amount>=0?'plus':'minus')+'">'+(h.amount>=0?'+':'')+h.amount+' ฿</div></div>').join('')
      : AUI("<div class=\"muted\">Операций пока не было.</div>");
  }catch(e){$('balResult').innerHTML='<span class="err">'+e.message+'</span>'}
  $('balCard').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function balOp(mode){
  if(!balWho)return;
  balMode=mode;
  $('balForm').classList.remove('hidden');
  $('balFormLabel').textContent=BAL_TITLES[mode];
  $('balPresets').innerHTML=BAL_PRESETS.map(a=>'<span class="chip" onclick="balSetAmount('+a+')">'+a+' ฿</span>').join('');
  $('balComments').innerHTML=(BAL_NOTES[mode]||[]).map(t=>'<span onclick="balSetNote(\''+esc(t)+'\')">'+esc(t)+'</span>').join('');
  $('balAmount').value='';$('balComment').value='';$('balResult').textContent='';
  $('balGo').textContent=mode==='add'?AUI("Пополнить"):(mode==='sub'?AUI("Списать"):AUI("Записать возврат"));
  $('balForm').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function balCloseOp(){balMode='';$('balForm').classList.add('hidden')}
function balSetAmount(v){$('balAmount').value=v;balPresetSync()}
function balSetNote(t){$('balComment').value=t}
function balPresetSync(){
  const v=Number($('balAmount').value||0);
  [...$('balPresets').children].forEach((c,i)=>c.classList.toggle('on',BAL_PRESETS[i]===v));
}
async function balSubmit(){
  const amount=Math.abs(Number($('balAmount').value||0));
  const comment=$('balComment').value.trim();
  if(!balWho)return;
  if(!amount)return $('balResult').innerHTML=AUI("<span class=\"err\">Укажи сумму</span>");
  if(!comment)return $('balResult').innerHTML=AUI("<span class=\"err\">Комментарий обязателен</span>");
  const body={telegram_id:balWho.telegram_id,name:balWho.name,comment};
  try{
    let j;
    if(balMode==='refund')j=await api('/api/admin/balance-refund',{...body,amount});
    else j=await api('/api/admin/balance-change',{...body,amount:balMode==='sub'?-amount:amount});
    // Сначала перечитываем карточку, и только потом пишем итог: иначе обновление
    // истории стирает сообщение, ради которого всё и делалось.
    const done=AUI("<span class=\"ok\">Готово. Депозит: ")+j.balance+' ฿'
      +(balMode==='refund'?AUI(". Долг записан во вкладку «Возвраты»."):'')+'</span>';
    balCloseOp();
    await balOpen(balWho.telegram_id);
    $('balResult').innerHTML=done;
    loadBalances();
  }catch(e){$('balResult').innerHTML='<span class="err">'+e.message+'</span>'}
}

// Подтверждение участия прямо из таблицы: игрок становится активным и получает
// приветствие — то же, что и после одобрения оплаты.
async function activatePlayer(id){
  if(!confirm(AUI("Подтвердить участие и отправить приветствие?")))return;
  try{ await api('/api/admin/activate-player',{telegram_id:id});
    status(AUI("Участие подтверждено")); await reload() }
  catch(e){ status(e.message,true) }
}

// --- получатели прямо в рассылке ------------------------------------------
// Список повторяет текущие фильтры и живёт на той же вкладке: отметил галочки
// и отправил, не переключаясь на «Игроков».
function renderRecipients(){
  const box=$('rcpList'); if(!box)return;
  const cnt=$('rcpCount');
  if(cnt)cnt.textContent=`${AUI("Под фильтрами: ")}${filtered.length}${AUI(". Отмечено: ")}${selected.size}.`;
  if(!filtered.length){box.innerHTML=AUI("<div class=\"r\"><span class=\"sub\">Никто не подходит под фильтры</span></div>");return}
  box.innerHTML=filtered.slice(0,300).map(c=>{
    const on=selected.has(String(c.telegram_id));
    return `<label class="r ${on?'on':''}">`
      +`<input type="checkbox" ${on?'checked':''} onchange="toggleOne('${c.telegram_id}',this.checked)">`
      +`<span><span class="nm">${esc(c.name)}</span>`
      +`<span class="sub"> ${c.telegram_username?'@'+esc(c.telegram_username):esc(c.telegram_id)}</span></span>`
      +`<span class="tags"><span class="chip">${esc(c.status||'')}</span>`
      +(c.division?`<span class="chip">${esc(c.division)}</span>`:'')
      +(c.language?`<span class="chip">${esc(c.language)}</span>`:'')+`</span></label>`;
  }).join('')+(filtered.length>300?AUI("<div class=\"r\"><span class=\"sub\">Показаны первые 300 — сузь фильтры</span></div>"):'');
}

// --- выбор игрока по имени -------------------------------------------------
// Telegram ID помнить не нужно: начинаешь вводить имя — появляются варианты.
let pickIdx=-1,pickRows=[];
function pickMatches(q){
  const s=String(q||'').trim().toLowerCase().replace(/^@/,'');
  if(!s)return [];
  return contacts.filter(c=>{
    const name=String(c.name||'').toLowerCase();
    const user=String(c.telegram_username||'').toLowerCase();
    return name.includes(s)||user.includes(s)||String(c.telegram_id).includes(s);
  }).slice(0,8);
}
function pickInput(q){
  pickRows=pickMatches(q); pickIdx=-1;
  const box=$('directSug');
  if(!pickRows.length){box.classList.add('hidden');box.innerHTML='';return}
  box.classList.remove('hidden');
  box.innerHTML=pickRows.map((c,i)=>`<div onmousedown="pickChoose(${i})">`
    +`<b>${esc(c.name)}</b>`
    +`<div class="sub">${c.telegram_username?'@'+esc(c.telegram_username)+' · ':''}${esc(c.telegram_id)}`
    +`${c.division?' · '+esc(c.division):''}${c.status?' · '+esc(c.status):''}</div></div>`).join('');
}
function pickChoose(i){
  const c=pickRows[i]; if(!c)return;
  $('directId').value=String(c.telegram_id);
  $('directPick').value='';
  $('directChosen').innerHTML=`<span class="picked"><b>${esc(c.name)}</b>`
    +`<span class="sub">${c.telegram_username?'@'+esc(c.telegram_username):esc(c.telegram_id)}</span>`
    +`<span class="x" onclick="pickClear()">✕</span></span>`;
  pickClose();
}
function pickClear(){ $('directId').value=''; $('directChosen').innerHTML=''; }
function pickClose(){ const b=$('directSug'); if(b){b.classList.add('hidden');b.innerHTML=''} pickIdx=-1 }
function pickKey(e){
  const box=$('directSug'); if(!box||box.classList.contains('hidden'))return;
  const items=[...box.querySelectorAll('div')];
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    pickIdx=e.key==='ArrowDown'?Math.min(pickIdx+1,items.length-1):Math.max(pickIdx-1,0);
    items.forEach((el,i)=>el.classList.toggle('hi',i===pickIdx));
  } else if(e.key==='Enter'){
    e.preventDefault();
    pickChoose(pickIdx>=0?pickIdx:0);
  } else if(e.key==='Escape'){ pickClose() }
}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  // Активный раздел подтягиваем в видимую часть полосы: на телефоне вкладок
  // больше, чем помещается, и иначе непонятно, где ты находишься.
  b.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
  window.scrollTo({top:0,behavior:'smooth'});
  ['Players','Broadcast','Direct','Selfie','Rating','History','Events','Balances','Refunds','Menu'].forEach(t=>$('tab'+t).classList.add('hidden'));$('tab'+b.dataset.tab[0].toUpperCase()+b.dataset.tab.slice(1)).classList.remove('hidden');$('filtersCard').classList.toggle('hidden',['history','events','balances','refunds','menu'].includes(b.dataset.tab));
  // Карточка аватарки живёт рядом со списком игроков — уходим из него, закрываем.
  if(b.dataset.tab!=='players')avClose();
  if(b.dataset.tab==='history'&&!history.length)loadHistory();
  if(b.dataset.tab==='broadcast')renderRecipients();
  if(b.dataset.tab==='events')loadEvents();
  if(b.dataset.tab==='balances')loadBalances();
  if(b.dataset.tab==='refunds')loadRefunds();
  if(b.dataset.tab==='menu')loadTabs()});reload();
