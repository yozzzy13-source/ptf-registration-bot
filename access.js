import { ADMIN_IDS } from './config.js';
import { getPlayerLeagueInfo, sameName } from './sheets.js';
import { divisionLetter, latestSeason, seasonRoster } from './division.js';

export const isLeagueAdmin = id => ADMIN_IDS.includes(String(id));
// The two W groups remain separate. These are the only approved cross-group
// regular-season pairings, so a general W1↔W2 challenge is never opened.
const W_CROSS_PAIRS=[
 ['Olga Sauer','Masha Geveling'],['Olga Sauer','Yana D'],['Marina Banatskaia','Elena Ian'],['Marina Banatskaia','Irina Strembitska'],
 ['Daria Kozitskaya','Tatiana Sokolova'],['Daria Kozitskaya','Xenia Hors'],['Hyunjung Moon','Masha Geveling'],['Hyunjung Moon','Irina Strembitska'],
 ['Anna Ermolina','Elena Ian'],['Anna Ermolina','Yana D'],['Maria Evangelista','Tatiana Sokolova'],['Maria Evangelista','Xenia Hors']
];
export function isWCrossGroupPair(a,b,division=''){return String(division||'').replace(/^(division|дивизион)\s*/i,'').trim().toUpperCase()==='W'&&W_CROSS_PAIRS.some(([x,y])=>(sameName(x,a)&&sameName(y,b))||(sameName(x,b)&&sameName(y,a)));}

// A saved scope keeps results in their original season and group. Old slots
// acquire a scope from their owner's roster without rewriting historical rows.
export async function slotScope(slot) {
  const season = String(slot.season || await latestSeason());
  const letter = divisionLetter(slot.division);
  const map = await seasonRoster(season);
  const owner = map.players.find(p => p.letter === letter && sameName(p.name, slot.from_name));
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
  const crossGroup = scope.group === 'cross';
  const sameDivision = x => String(x.season) === String(scope.season) && divisionLetter(x.letter || x.division) === divisionLetter(scope.letter);
  if (crossGroup ? !sameDivision(info) : !sameScope(info, scope)) return { ok: false, reason: 'different_group' };
  // A removed/moved opponent cannot keep receiving new match proposals.
  const otherId = String(slot.from_telegram_id) === id ? slot.to_telegram_id : slot.from_telegram_id;
  if (otherId && !isLeagueAdmin(otherId)) {
    const other = await getPlayerLeagueInfo({ telegram_id: otherId });
    if (!other.member || !other.found || (crossGroup ? !sameDivision(other) : !sameScope(other, scope))) return { ok: false, reason: 'different_group' };
  }
  return { ok: true, scope };
}
