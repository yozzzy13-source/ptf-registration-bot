import { ADMIN_IDS } from './config.js';
import { getPlayerLeagueInfo, sameName } from './sheets.js';
import { divisionLetter, latestSeason, seasonRoster } from './division.js';

export const isLeagueAdmin = id => ADMIN_IDS.includes(String(id));

// A saved scope keeps results in their original season and group. Old slots
// acquire a scope from their owner's roster without rewriting historical rows.
export async function slotScope(slot) {
  const season = String(slot.season || await latestSeason());
  const letter = divisionLetter(slot.division);
  const map = await seasonRoster(season);
  const owner = map.players.find(p => p.letter === letter && sameName(p.name, slot.from_name));
  return { season, letter, group: String(slot.group || owner?.group || '') };
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
  if (!sameScope(info, scope)) return { ok: false, reason: 'different_group' };
  // A removed/moved opponent cannot keep receiving new match proposals.
  const otherId = String(slot.from_telegram_id) === id ? slot.to_telegram_id : slot.from_telegram_id;
  if (otherId && !isLeagueAdmin(otherId)) {
    const other = await getPlayerLeagueInfo({ telegram_id: otherId });
    if (!other.member || !other.found || !sameScope(other, scope)) return { ok: false, reason: 'different_group' };
  }
  return { ok: true, scope };
}
