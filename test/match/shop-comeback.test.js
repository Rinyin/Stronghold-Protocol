// Comeback shop-refresh boost: triggers (first LP < 8 or 2-round loss >= 15), deactivation (2 consecutive perfect
// rounds), top-3 bond ranking (inactive at 75% layers), board-operator & bond weight lift on regular shop rolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMEBACK_BOARD_WEIGHT_MUL,
  COMEBACK_BOND_WEIGHT_MUL,
  createComebackState,
  recordComebackPrepLpLoss,
  recordComebackRound,
  shopComebackWeightMul,
  topComebackBonds,
} from '../../server/match/shopComeback.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA, makeMatch, give } from './harness.js';

test('trigger A: first LP < 8 activates once; 2 consecutive perfect rounds deactivate and staying < 8 does not re-trigger', () => {
  const st = createComebackState();
  recordComebackRound(st, { lp: 10, loss: 5, perfect: false });
  assert.equal(st.active, false);
  assert.equal(st.lowHpTriggered, false);
  // LP = 8 is NOT below 8
  recordComebackRound(st, { lp: 8, loss: 2, perfect: false });
  assert.equal(st.active, false);
  assert.equal(st.lowHpTriggered, false);
  // First time LP < 8 (7) -> activates
  recordComebackRound(st, { lp: 7, loss: 1, perfect: false });
  assert.equal(st.active, true);
  assert.equal(st.lowHpTriggered, true);
  assert.equal(st.perfectStreak, 0);
  // 1st perfect round: still active
  recordComebackRound(st, { lp: 7, loss: 0, perfect: true });
  assert.equal(st.active, true);
  assert.equal(st.perfectStreak, 1);
  // Non-perfect round (e.g. leaked but saved by 联防, loss 0) breaks the streak
  recordComebackRound(st, { lp: 7, loss: 0, perfect: false });
  assert.equal(st.active, true);
  assert.equal(st.perfectStreak, 0);
  // Next 2 consecutive perfect rounds deactivate
  recordComebackRound(st, { lp: 7, loss: 0, perfect: true });
  assert.equal(st.active, true);
  recordComebackRound(st, { lp: 7, loss: 0, perfect: true });
  assert.equal(st.active, false);
  assert.equal(st.perfectStreak, 0);
  // Still < 8 on further small loss: lowHpTriggered was already spent, does not re-trigger
  recordComebackRound(st, { lp: 5, loss: 2, perfect: false });
  assert.equal(st.active, false);
});

test('trigger B: two consecutive rounds losing >= 15 LP activates even at LP >= 8; non-consecutive does not', () => {
  const st = createComebackState();
  // Non-consecutive 8, 0, 8 does not trigger
  recordComebackRound(st, { lp: 20, loss: 8, perfect: false });
  recordComebackRound(st, { lp: 20, loss: 0, perfect: true });
  recordComebackRound(st, { lp: 12, loss: 8, perfect: false });
  assert.equal(st.active, false);
  // Next round loses 7 -> 8 + 7 = 15 -> activates (and LP 5 also consumes lowHpTriggered)
  const st2 = createComebackState();
  recordComebackRound(st2, { lp: 20, loss: 8, perfect: false });
  assert.equal(st2.active, false);
  recordComebackRound(st2, { lp: 13, loss: 7, perfect: false });
  assert.equal(st2.active, true);
  assert.equal(st2.lowHpTriggered, false);
  // Two consecutive perfect rounds deactivate
  recordComebackRound(st2, { lp: 13, loss: 0, perfect: true });
  assert.equal(st2.active, true);
  recordComebackRound(st2, { lp: 13, loss: 0, perfect: true });
  assert.equal(st2.active, false);
  // Later LP drops below 8 for the first time -> triggers via condition A
  recordComebackRound(st2, { lp: 7, loss: 6, perfect: false });
  assert.equal(st2.active, true);
  assert.equal(st2.lowHpTriggered, true);
  // Two consecutive perfect rounds turn it off again
  recordComebackRound(st2, { lp: 7, loss: 0, perfect: true });
  recordComebackRound(st2, { lp: 7, loss: 0, perfect: true });
  assert.equal(st2.active, false);
});

test('prep LP sacrifice triggers immediately and feeds into two-round total without double-triggering on a perfect fight', () => {
  const st = createComebackState();
  recordComebackRound(st, { lp: 20, loss: 8, perfect: false });
  assert.equal(st.active, false);
  // Prep sacrifices 7 LP -> 8 + 7 = 15 triggers immediately
  recordComebackPrepLpLoss(st, { lp: 13, loss: 7 });
  assert.equal(st.active, true);
  // Next two combat rounds are both perfect -> deactivates
  recordComebackRound(st, { lp: 13, loss: 0, perfect: true });
  assert.equal(st.active, true);
  assert.equal(st.perfectStreak, 1);
  recordComebackRound(st, { lp: 13, loss: 0, perfect: true });
  assert.equal(st.active, false);
});

test('top-3 bond ranking: inactive bonds compare at 75% of layers; 0-layer and memberless 绝技 are excluded', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 11 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  // Find 4 bonds live in this match's pool
  const liveBonds = m.gd.bondIds.filter((b) => b !== 'suntShip' && m.bondLive(b));
  assert.ok(liveBonds.length >= 4);
  const [bActive1, bActive2, bInactiveHigh, bInactiveLow] = liveBonds;
  // Activate bActive1 and bActive2 via bondCountBonus
  ps.bondCountBonus[bActive1] = 10;
  ps.bondCountBonus[bActive2] = 10;
  ps.layers[bActive1] = 10; // active -> score 10
  ps.layers[bActive2] = 11; // active -> score 11
  ps.layers[bInactiveHigh] = 16; // inactive -> 16 * 0.75 = 12 (beats both active!)
  ps.layers[bInactiveLow] = 12; // inactive -> 12 * 0.75 = 9 (loses to active 10)
  ps.layers.suntShip = 99; // 绝技 has no member operators -> must not consume a top-3 slot
  ps.recompute();

  const top3 = topComebackBonds(ps);
  assert.deepEqual(top3, [bInactiveHigh, bActive2, bActive1]);
  m.dispose();
});

test('rollShop applies comeback weight multipliers for board ops (including elites) and top-3 bonds, and restores baseline when off', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 17 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  ps.shop.level = 5;

  // Pick a live bond and deploy 1 elite + 1 normal operator on the board
  const bondA = m.gd.bondIds.find((b) => b !== 'suntShip' && m.bondLive(b) && m.gd.bond(b).isCore);
  assert.ok(bondA);
  const bondAOps = [...m.pool.entries.keys()].filter((id) => {
    const c = m.gd.chess(id);
    return c && c.tier <= 5 && Array.isArray(c.bonds) && c.bonds.includes(bondA);
  });
  const otherOps = [...m.pool.entries.keys()].filter((id) => {
    const c = m.gd.chess(id);
    return c && c.tier <= 5 && (!Array.isArray(c.bonds) || !c.bonds.includes(bondA));
  });
  assert.ok(bondAOps.length >= 2 && otherOps.length >= 2);

  const boardCoreBase = bondAOps[0];
  const boardOtherBase = otherOps[0];
  // Deploy elite form of boardCoreBase + normal form of boardOtherBase
  give(m, ps, DATA.chess[boardCoreBase].goldenId, 'board', [10, 3]);
  give(m, ps, boardOtherBase, 'board', [10, 4]);
  ps.layers[bondA] = 20;
  ps.recompute();

  // Inactive: weightMul is null
  assert.equal(shopComebackWeightMul(ps), null);

  // Activate via first LP < 8
  recordComebackRound(ps.shopComeback, { lp: 6, loss: 4, perfect: false });
  const mul = shopComebackWeightMul(ps);
  assert.ok(typeof mul === 'function');
  assert.equal(mul(boardCoreBase), COMEBACK_BOARD_WEIGHT_MUL * COMEBACK_BOND_WEIGHT_MUL);
  assert.equal(mul(boardOtherBase), COMEBACK_BOARD_WEIGHT_MUL);
  assert.equal(mul(bondAOps[1]), COMEBACK_BOND_WEIGHT_MUL);
  assert.equal(mul(otherOps[1]), 1);

  // Statistical verification over 1500 shop refreshes (7500 chess slots)
  const sampleRates = (active) => {
    ps.shopComeback.active = active;
    m.rngShop = createRng(9001);
    let total = 0;
    let boardHits = 0;
    let bondHits = 0;
    for (let i = 0; i < 1500; i++) {
      ps.rollShop({ keepFrozen: false });
      for (const s of ps.shop.slots) {
        if (!s || s.kind !== 'chess') continue;
        total++;
        if (s.id === boardCoreBase || s.id === boardOtherBase) boardHits++;
        if (m.gd.chess(s.id)?.bonds?.includes(bondA)) bondHits++;
      }
    }
    return { boardRate: boardHits / total, bondRate: bondHits / total };
  };

  const base = sampleRates(false);
  const boosted = sampleRates(true);
  assert.ok(boosted.boardRate > base.boardRate * 1.4, `board rate should rise clearly: ${base.boardRate} -> ${boosted.boardRate}`);
  assert.ok(boosted.bondRate > base.bondRate * 1.15, `bond rate should rise clearly: ${base.bondRate} -> ${boosted.bondRate}`);

  // Deactivate after 2 consecutive perfect rounds -> returns to exact baseline
  ps.shopComeback.active = true;
  ps.shopComeback.perfectStreak = 0;
  recordComebackRound(ps.shopComeback, { lp: 6, loss: 0, perfect: true });
  recordComebackRound(ps.shopComeback, { lp: 6, loss: 0, perfect: true });
  assert.equal(ps.shopComeback.active, false);
  assert.equal(shopComebackWeightMul(ps), null);
  m.dispose();
});
