// HTTP-слой турниров. Всё под админом: турнирная админка никому, кроме
// организатора, не открывается. Исключение — два чтения для игрока: список
// открытых парных турниров и его собственные приглашения.
//
// Тестовый режим передаётся флагом test в каждом запросе. Он не «запоминается»
// на сервере нарочно: так невозможно случайно оставить включённым тест и
// думать, что пишешь в боевые листы, или наоборот.
import {
  ensureTournamentSheets, listTournaments, getTournament, createTournament, updateTournament,
  listEntries, addEntry, updateEntry, assignEntries, withdrawEntry,
  listPairs, createPair, updatePair, invitePartner, acceptInvite, declineInvite, matchMutualInvites,
  listStages, createStage, setStageStatus,
  distributeGroups, generateGroupMatches, generatePlayoff,
  setMatchResult, slotAction, createManualTournamentMatch,
  tournamentState, candidatePlayers, importSeason, readLog, pendingInvitesFor, pairLabel
} from './tournaments.js';
import { latestSeason, getSeasons } from './division.js';

const asTest = req => {
  const v = req.body?.test ?? req.query?.test;
  return ['1','true','yes','on'].includes(String(v ?? '').toLowerCase());
};
const actorOf = v => ({ id: String(v.user?.id || ''), name: String(v.profile?.name || v.user?.first_name || '') });

export function registerTournamentRoutes(app, { viewer }) {
  // Проверка админа. Одна на все ручки: турнирная админка — инструмент
  // организатора, и «почти админ» здесь не бывает.
  const admin = async (req, res) => {
    const v = await viewer(req.body?.initData || req.query.initData || '', String(req.body?.t || req.query.t || ''));
    if (!v.ok) { res.status(v.code).json({ ok:false, error:v.error }); return null; }
    if (!v.isAdmin) { res.status(403).json({ ok:false, error:'tournament_admin_only', detail:'Турнирная админка доступна только организатору' }); return null; }
    return v;
  };
  const guard = handler => async (req, res) => {
    try {
      const v = await admin(req, res);
      if (!v) return;
      const test = asTest(req);
      await ensureTournamentSheets(test);
      await handler(req, res, v, test, actorOf(v));
    } catch (e) {
      console.error('tournament api:', e.message);
      // Общий /api-переводчик подменяет незнакомый текст ошибки на дежурную
      // фразу. Админке нужна настоящая причина, поэтому везём её отдельным
      // полем detail, а в error кладём код, который переводчик не трогает.
      res.status(400).json({ ok:false, error:'tournament_error', detail:e.message });
    }
  };
  const id = req => String(req.body?.tournament_id || req.query.tournament_id || '');

  // ------------------------------------------------------------- чтение
  app.get('/api/tournaments/bootstrap', guard(async (req, res, v, test) => {
    const [list, season, seasons] = await Promise.all([
      listTournaments(test),
      latestSeason().catch(() => ''),
      getSeasons().catch(() => [])
    ]);
    res.json({ ok:true, test, season, seasons, tournaments:list, admin:{ id:String(v.user.id), name:String(v.profile?.name || '') } });
  }));

  app.get('/api/tournaments/state', guard(async (req, res, v, test) => {
    const state = await tournamentState(id(req), test);
    res.json({ ok:true, test, ...state });
  }));

  app.get('/api/tournaments/candidates', guard(async (req, res) => {
    res.json({ ok:true, players: await candidatePlayers(String(req.query.season || '')) });
  }));

  app.get('/api/tournaments/log', guard(async (req, res, v, test) => {
    res.json({ ok:true, log: await readLog(id(req), test, Number(req.query.limit || 60)) });
  }));

  // ------------------------------------------------------------ турниры
  app.post('/api/tournaments/create', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, tournament: await createTournament(req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/update', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, tournament: await updateTournament(id(req), req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/import-season', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, ...await importSeason(String(b.season || ''), { division:String(b.division || ''), name:String(b.name || '') }, actor, test) });
  }));

  // ------------------------------------------------------------- заявки
  app.post('/api/tournaments/entry/add', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, entry: await addEntry(id(req), req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/entry/update', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, entry: await updateEntry(String(req.body?.entry_id || ''), req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/entry/assign', guard(async (req, res, v, test, actor) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ ok:true, changed: await assignEntries(id(req), items, actor, test) });
  }));
  app.post('/api/tournaments/entry/withdraw', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, ...await withdrawEntry(String(b.entry_id || ''), {
      reason: String(b.reason || 'other'),
      applyWalkover: b.apply_walkover !== false,
      replacedBy: String(b.replaced_by || '')
    }, actor, test) });
  }));

  // --------------------------------------------------------------- пары
  app.get('/api/tournaments/pairs', guard(async (req, res, v, test) => {
    res.json({ ok:true, pairs: await listPairs(id(req), test) });
  }));
  app.post('/api/tournaments/pair/create', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, pair: await createPair(id(req), {
      playerAId:String(b.player_a_id || ''), playerAName:String(b.player_a_name || ''),
      playerBId:String(b.player_b_id || ''), playerBName:String(b.player_b_name || ''),
      payer:String(b.payer || ''), note:String(b.note || '')
    }, actor, test) });
  }));
  app.post('/api/tournaments/pair/update', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, pair: await updatePair(String(req.body?.pair_id || ''), req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/pair/invite', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, invite: await invitePartner(String(b.pair_id || ''), {
      toId:String(b.to_id || ''), toName:String(b.to_name || ''),
      toContact:String(b.to_contact || ''), channel:String(b.channel || 'telegram')
    }, actor, test) });
  }));
  app.post('/api/tournaments/pair/accept', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, ...await acceptInvite(String(b.invite_id || ''), {
      playerId:String(b.player_id || ''), playerName:String(b.player_name || '')
    }, actor, test) });
  }));
  app.post('/api/tournaments/pair/decline', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, invite: await declineInvite(String(req.body?.invite_id || ''), actor, test) });
  }));
  app.post('/api/tournaments/pair/match-mutual', guard(async (req, res, v, test) => {
    res.json({ ok:true, matched: await matchMutualInvites(id(req), test) });
  }));

  // ------------------------------------------------------------- стадии
  app.post('/api/tournaments/stage/create', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, stage: await createStage(id(req), { kind:String(b.kind || 'group'), name:String(b.name || '') }, actor, test) });
  }));
  app.post('/api/tournaments/stage/status', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, stage: await setStageStatus(String(b.stage_id || ''), String(b.status || 'active'), actor, test) });
  }));
  app.get('/api/tournaments/stages', guard(async (req, res, v, test) => {
    res.json({ ok:true, stages: await listStages(id(req), test) });
  }));

  // ------------------------------------------------- группы и расписание
  app.post('/api/tournaments/groups/distribute', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, items: await distributeGroups(id(req), {
      groupCount:Number(b.group_count || 2), method:String(b.method || 'rating'), division:String(b.division || '')
    }, actor, test) });
  }));
  app.post('/api/tournaments/matches/generate', guard(async (req, res, v, test, actor) => {
    const matches = await generateGroupMatches(id(req), String(req.body?.stage_id || ''), actor, test);
    res.json({ ok:true, created: matches.length });
  }));
  app.post('/api/tournaments/playoff/generate', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    const out = await generatePlayoff(id(req), {
      stageId:String(b.stage_id || ''), type:String(b.type || ''),
      advance:Number(b.advance || 0), thirdPlace: b.third_place === undefined ? null : Boolean(b.third_place)
    }, actor, test);
    res.json({ ok:true, stage:out.stage, created:out.matches.length, warning:out.warning });
  }));

  // -------------------------------------------------------------- матчи
  app.post('/api/tournaments/match/result', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, match: await setMatchResult(String(req.body?.match_id || ''), req.body || {}, actor, test) });
  }));
  app.post('/api/tournaments/match/slot', guard(async (req, res, v, test, actor) => {
    const b = req.body || {};
    res.json({ ok:true, match: await slotAction(String(b.match_id || ''), {
      side:String(b.side || 'a'), action:String(b.action || 'swap'), entryId:String(b.entry_id || '')
    }, actor, test) });
  }));
  app.post('/api/tournaments/match/create', guard(async (req, res, v, test, actor) => {
    res.json({ ok:true, match: await createManualTournamentMatch(id(req), req.body || {}, actor, test) });
  }));

  // --------------------------------------------------------- для игрока
  // Единственные две ручки без админского флага: список открытых парных
  // турниров и приглашения, адресованные лично этому человеку.
  app.get('/api/tournaments/open', async (req, res) => {
    try {
      const v = await viewer(String(req.query.initData || ''), String(req.query.t || ''));
      if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
      const test = asTest(req);
      await ensureTournamentSheets(test);
      const list = (await listTournaments(test)).filter(t => String(t.status || '').toLowerCase() === 'registration');
      const out = [];
      for (const t of list) {
        const pairs = String(t.kind).toLowerCase() === 'doubles' ? await listPairs(t.tournament_id, test) : [];
        const entries = await listEntries(t.tournament_id, test);
        const mine = pairs.find(p => [String(p.player_a_id), String(p.player_b_id)].includes(String(v.user.id))
          && String(p.status).toLowerCase() !== 'dissolved');
        out.push({
          tournament_id:t.tournament_id, name:t.name, name_en:t.name_en, kind:t.kind,
          starts_on:t.starts_on, registration_closes:t.registration_closes,
          entry_fee_thb:t.entry_fee_thb, entry_fee_usdt:t.entry_fee_usdt,
          entries:entries.filter(e => ['applied','accepted'].includes(String(e.status).toLowerCase())).length,
          max_entries:t.max_entries,
          seeking: pairs.filter(p => String(p.status).toLowerCase() === 'seeking')
            .map(p => ({ pair_id:p.pair_id, name:p.player_a_name, player_id:p.player_a_id })),
          my_pair: mine ? { pair_id:mine.pair_id, status:mine.status, label:pairLabel(mine) } : null
        });
      }
      res.json({ ok:true, tournaments:out });
    } catch (e) { res.status(500).json({ ok:false, error:'tournament_error', detail:e.message }); }
  });

  app.get('/api/tournaments/my-invites', async (req, res) => {
    try {
      const v = await viewer(String(req.query.initData || ''), String(req.query.t || ''));
      if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
      const test = asTest(req);
      await ensureTournamentSheets(test);
      res.json({ ok:true, invites: await pendingInvitesFor(String(v.user.id), test) });
    } catch (e) { res.status(500).json({ ok:false, error:'tournament_error', detail:e.message }); }
  });
}
