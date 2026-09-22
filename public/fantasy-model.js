// Shared slot assignment: keep the existing C/W group requirements.
export function slotsFor(players) {
  const pools = [...new Set(players.map(p => p.pool))];
  const grouped = division => {
    const groups = pools.filter(p => p.split(':')[0] === division).sort();
    return [0, 1].map(i => ({label:division, pools:groups.length > 1 ? [groups[i]] : groups}));
  };
  return [...grouped('C'), ...grouped('W'), ...['PRIME','A','B'].map(d => ({label:d === 'PRIME' ? 'Prime' : d, pools:pools.filter(p => p.split(':')[0] === d)})),
    {label:'Flex', pools:pools.filter(p => ['PRIME','A','B'].includes(p.split(':')[0]))}];
}

export function assignSlots(keys, players) {
  const slots = slotsFor(players).map(s => ({...s, key:''}));
  const unmatched = [];
  for (const key of keys) {
    const p = players.find(p => p.key === key);
    const slot = p && slots.find(s => !s.key && s.pools.includes(p.pool));
    if (slot) slot.key = key;
    else unmatched.push(key);
  }
  return {slots, unmatched};
}

export function selectionIssue(keys, key, players, budget, maxPerPool = 2, slotIndex = -1) {
  const p = players.find(p => p.key === key);
  if (!p) return 'unavailable';
  if (keys.includes(key)) return 'selected';
  if (keys.length >= 8) return 'full';
  const selected = keys.map(k => players.find(p => p.key === k)).filter(Boolean);
  if (selected.filter(x => x.pool === p.pool).length >= maxPerPool) return 'quota';
  const state = assignSlots(keys, players);
  if (slotIndex >= 0 && (state.slots[slotIndex]?.key || !state.slots[slotIndex]?.pools.includes(p.pool))) return 'slot';
  if (assignSlots([...keys, key], players).unmatched.length) return 'quota';
  if (selected.reduce((sum, p) => sum + Number(p.price), 0) + Number(p.price) > budget) return 'budget';
  return '';
}

export function deadlineReached(data, now = Date.now()) {
  return Boolean(data.locked || (data.lock_at && now >= Date.parse(data.lock_at)));
}
