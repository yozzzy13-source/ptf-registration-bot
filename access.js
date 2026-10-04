import { ADMIN_IDS } from './config.js';
import { getPlayerLeagueInfo, sameName } from './sheets.js';
import { divisionLetter, latestSeason, seasonRoster } from './division.js';

export const isLeagueAdmin = id => ADMIN_IDS.includes(String(id));
// The two W groups remain separate. These are the only approved cross-group
// regular-season pairings, so a general W1↔W2 challenge is never opened.
//
// Список составлен на старте сезона: [игрок группы 2, игрок группы 1].
// Замена игрока в дивизионе подхватывается сама: бот сверяет список с
// таблицей дивизиона (Division_Tracker), и если кого-то из списка в группе
// больше нет, а в группе появился новый человек, — новый встаёт на место
// выбывшего во всех его межгрупповых парах. Так Аксинья заняла пары Анны.
// В коде ничего менять при заменах не нужно.
export const W_CROSS_BASE=[
 ['Olga Sauer','Masha Geveling'],['Olga Sauer','Yana D'],['Marina Banatskaia','Elena Ian'],['Marina Banatskaia','Irina Strembitska'],
 ['Daria Kozitskaya','Tatiana Sokolova'],['Daria Kozitskaya','Xenia Hors'],['Hyunjung Moon','Masha Geveling'],['Hyunjung Moon','Irina Strembitska'],
 ['Anna Ermolina','Elena Ian'],['Anna Ermolina','Yana D'],['Maria Evangelista','Tatiana Sokolova'],['Maria Evangelista','Xenia Hors']
];
let wCross={ t:0, season:'', pairs:W_CROSS_BASE, subs:[] };
const W_CROSS_MS=2*60*1000;
// Пары с учётом замен. subs — кто кого заменил: [{ from, to, group }].
export async function resolveWCrossPairs(season=''){
  const s=String(season||await latestSeason().catch(()=>'')||'');
  if(wCross.season===s&&Date.now()-wCross.t<W_CROSS_MS)return wCross;
  const roster=await seasonRoster(s).catch(()=>null);
  const w=(roster?.players||[]).filter(p=>String(p.letter||'').toUpperCase()==='W');
  if(!w.length){wCross={t:Date.now(),season:s,pairs:W_CROSS_BASE,subs:[]};return wCross}
  const map=new Map(),subs=[];
  for(const [group,idx] of [['2',0],['1',1]]){
    const listed=[...new Set(W_CROSS_BASE.map(p=>p[idx]))];
    const current=w.filter(p=>String(p.group||'')===group).map(p=>p.name);
    if(!current.length)continue;
    const missing=listed.filter(n=>!current.some(c=>sameName(c,n)));
    const extra=current.filter(c=>!listed.some(n=>sameName(c,n)));
    // Сопоставляем по порядку: выбывший → новый игрок той же группы. Новых
    // больше, чем выбывших (группу расширили), — лишние в пары не попадают.
    // Замена — это один-два человека. Если группа почти целиком другая
    // (новый сезон, другие составы), это не замена: старый список не трогаем.
    if(!missing.length||missing.length>2||listed.length-missing.length<Math.ceil(listed.length/2))continue;
    missing.forEach((n,i)=>{if(extra[i]){map.set(n,extra[i]);subs.push({from:n,to:extra[i],group})}});
  }
  const sub=name=>{for(const [from,to] of map)if(sameName(from,name))return to;return name};
  wCross={t:Date.now(),season:s,pairs:W_CROSS_BASE.map(([a,b])=>[sub(a),sub(b)]),subs};
  return wCross;
}
export const currentWCrossPairs=()=>wCross.pairs;
export function forgetWCrossPairs(){wCross={...wCross,t:0}}
export function isWCrossGroupPair(a,b,division=''){return String(division||'').replace(/^(division|дивизион)\s*/i,'').trim().toUpperCase()==='W'&&wCross.pairs.some(([x,y])=>(sameName(x,a)&&sameName(y,b))||(sameName(x,b)&&sameName(y,a)));}

// A saved scope keeps results in their original season and group. Old slots
// acquire a scope from their owner's roster without rewriting historical rows.
export async function slotScope(slot) {
  const season = String(slot.season || await latestSeason());
  const letter = divisionLetter(slot.division);
  const map = await seasonRoster(season);
  const owner = map.players.find(p => p.letter === letter && sameName(p.name, slot.from_name));
  if (letter === 'W') await resolveWCrossPairs(season).catch(() => null);
  const cross=isWCrossGroupPair(slot.from_name,slot.to_name,letter);
  return { season, letter, group: cross?'cross':String(slot.group || owner?.group || '') };
}

export function sameScope(a, b) {
  return String(a.season) === String(b.season)
    && divisionLetter(a.letter || a.division) === divisionLetter(b.letter || b.division)
    && String(a.group || '') === String(b.group || '');
}

export async function authorizeSlot(slot, actor, { joining = false } = {}) {
  if (!slot) return { ok: false, reason: 'not_found' };
  const id = String(actor.telegram_id || actor.id || '');
  if (!joining && ![slot.from_telegram_id, slot.to_telegram_id].map(String).includes(id)) {
    return { ok: false, reason: 'not_a_player' };
  }
  if (isLeagueAdmin(id)) return { ok: true, scope: await slotScope(slot) };
  const info = await getPlayerLeagueInfo({ telegram_id: id });
  if (!info.member) return { ok: false, reason: 'league_access_denied' };
  if (!info.found) return { ok: false, reason: 'division_required' };
  const scope = await slotScope(slot);
  // An open W window has no opponent yet, so its stored group is the author's
  // group. A taker may cross that boundary only when they are one of the
  // explicitly approved W1/W2 pairs. Once taken, the slot is persisted as
  // `cross` and every following proposal uses the normal cross-group policy.
  const joiningCross = joining && isWCrossGroupPair(slot.from_name, info.name || actor.name, scope.letter);
  const resolvedScope = joiningCross ? { ...scope, group:'cross' } : scope;
  const crossGroup = resolvedScope.group === 'cross';
  const sameDivision = x => String(x.season) === String(resolvedScope.season) && divisionLetter(x.letter || x.division) === divisionLetter(resolvedScope.letter);
  if (crossGroup ? !sameDivision(info) : !sameScope(info, resolvedScope)) return { ok: false, reason: 'different_group' };
  // A removed/moved opponent cannot keep receiving new match proposals.
  const otherId = String(slot.from_telegram_id) === id ? slot.to_telegram_id : slot.from_telegram_id;
  if (otherId && !isLeagueAdmin(otherId)) {
    const other = await getPlayerLeagueInfo({ telegram_id: otherId });
    if (!other.member || !other.found || (crossGroup ? !sameDivision(other) : !sameScope(other, resolvedScope))) return { ok: false, reason: 'different_group' };
  }
  return { ok: true, scope: resolvedScope };
}
