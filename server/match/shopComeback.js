// server/match/shopComeback.js — comeback shop refresh boost:
//   * Activates when a player's LP drops below 8 for the first time, or when two consecutive rounds lose >= 15 LP total.
//   * While active, regular shop rolls boost remaining-copy weights of:
//       - operators currently on the player's board (×1.60), and
//       - operators belonging to the player's top 3 bonds by layers (inactive bonds ranked at 75% of their layers, ×1.35).
//     Operators matching both receive both multipliers (×2.16).
//   * Deactivates once the player either clears a single round with no own leaks (teammate 联防 cover does not count),
//     or goes 2 consecutive rounds without losing combat LP (including teammate 联防 cover).

import { computeBonds } from './bondsMeta.js';

export const COMEBACK_LOW_HP = 8;
export const COMEBACK_TWO_ROUND_LOSS = 15;
export const COMEBACK_NO_LOSS_STOP = 2;
export const COMEBACK_TOP_BONDS = 3;
export const COMEBACK_INACTIVE_BOND_RATIO = 0.75;
export const COMEBACK_BOARD_WEIGHT_MUL = 1.6;
export const COMEBACK_BOND_WEIGHT_MUL = 1.35;

/** Initial per-player comeback state. */
export function createComebackState() {
  return {
    active: false,
    lowHpTriggered: false,
    prevRoundLoss: 0,
    prepLoss: 0,
    noLossStreak: 0,
  };
}

/**
 * Record an LP decrease occurring during prep (e.g. a strategy command that sacrifices LP).
 * Activates immediately if LP drops below 8 for the first time or two-round total loss reaches 15.
 * @param {ReturnType<typeof createComebackState>} state
 * @param {{ lp: number, loss?: number }} info
 */
export function recordComebackPrepLpLoss(state, { lp, loss = 0 }) {
  if (!state) return state;
  const curLoss = Math.max(0, Math.trunc(Number(loss) || 0));
  const curLp = Number.isFinite(lp) ? lp : 0;
  if (curLoss > 0) state.prepLoss = (state.prepLoss || 0) + curLoss;
  if (curLp <= 0) {
    state.active = false;
    state.noLossStreak = 0;
    return state;
  }
  let triggered = false;
  if (!state.lowHpTriggered && curLp < COMEBACK_LOW_HP) {
    state.lowHpTriggered = true;
    triggered = true;
  }
  if (curLoss > 0 && state.prevRoundLoss + state.prepLoss >= COMEBACK_TWO_ROUND_LOSS) {
    triggered = true;
  }
  if (triggered) {
    state.active = true;
    state.noLossStreak = 0;
  }
  return state;
}

/**
 * Record a settled combat round for the player and update the comeback state.
 * `perfect` means the player's own battle had no counted leaks (teammate 联防 saving leaks is false).
 * @param {ReturnType<typeof createComebackState>} state
 * @param {{ lp: number, loss?: number, perfect?: boolean }} info
 */
export function recordComebackRound(state, { lp, loss = 0, perfect = false }) {
  if (!state) return state;
  const battleLoss = Math.max(0, Math.trunc(Number(loss) || 0));
  const totalRoundLoss = (state.prepLoss || 0) + battleLoss;
  state.prepLoss = 0;
  const curLp = Number.isFinite(lp) ? lp : 0;
  if (curLp <= 0) {
    state.active = false;
    state.noLossStreak = 0;
    state.prevRoundLoss = totalRoundLoss;
    return state;
  }
  if (state.active) {
    if (perfect && battleLoss === 0) {
      // Single round with no own leaks immediately ends protection.
      state.active = false;
      state.noLossStreak = 0;
    } else if (battleLoss === 0) {
      // Leaked but covered by teammates (0 LP loss): 2 consecutive no-loss rounds end protection.
      state.noLossStreak += 1;
      if (state.noLossStreak >= COMEBACK_NO_LOSS_STOP) {
        state.active = false;
        state.noLossStreak = 0;
      }
    } else {
      state.noLossStreak = 0;
    }
  }
  let triggered = false;
  if (!state.lowHpTriggered && curLp < COMEBACK_LOW_HP) {
    state.lowHpTriggered = true;
    triggered = true;
  }
  if (battleLoss > 0 && state.prevRoundLoss + totalRoundLoss >= COMEBACK_TWO_ROUND_LOSS) {
    triggered = true;
  }
  if (triggered) {
    state.active = true;
    state.noLossStreak = 0;
  }
  state.prevRoundLoss = totalRoundLoss;
  return state;
}

/** Distinct base chess ids currently deployed on the player's board. */
export function boardBaseIds(ps) {
  const out = new Set();
  if (!ps || !ps.board) return out;
  for (const piece of ps.board.values()) {
    if (!piece || piece.kind !== 'chess') continue;
    const baseId = ps.gd.baseIdOf(piece.id);
    if (baseId) out.add(baseId);
  }
  return out;
}

function bondHasShopMembers(ps, bondId) {
  const bond = ps.gd.bond(bondId);
  if (!bond || bond.countMode === 'BOARD_ALL_CHESS') return false;
  if (ps.gd.modeInactiveBonds && ps.gd.modeInactiveBonds.has(bondId)) return false;
  if (typeof ps.m?.bondInPool === 'function') {
    if (ps.m.bondInPool(bondId)) return true;
    if (ps.diyStock?.entries) {
      for (const id of ps.diyStock.entries.keys()) {
        const rec = ps.gd.chess(id);
        if (rec && Array.isArray(rec.bonds) && rec.bonds.includes(bondId)) return true;
      }
    }
    return false;
  }
  return true;
}

/**
 * Top 3 bonds by effective layer score (inactive bonds compare at 75% of their layers).
 * Excludes 0-layer bonds and memberless/disabled bonds so the 3 slots always correspond to shoppable operators.
 * @param {any} ps
 * @param {Record<string, { active?: boolean, layers?: number }>|null} [bonds]
 * @returns {string[]}
 */
export function topComebackBonds(ps, bonds = null) {
  if (!ps || !ps.gd) return [];
  const state = bonds || computeBonds(ps.gd, ps);
  const ids = Array.isArray(ps.gd.bondIds) ? ps.gd.bondIds : [];
  const ranked = [];
  for (let i = 0; i < ids.length; i++) {
    const bondId = ids[i];
    const raw = Number(ps.layers?.[bondId]) || 0;
    if (!(raw > 0)) continue;
    if (!bondHasShopMembers(ps, bondId)) continue;
    const active = !!(state[bondId] && state[bondId].active);
    const score = active ? raw : raw * COMEBACK_INACTIVE_BOND_RATIO;
    ranked.push({ bondId, score, active, raw, order: i });
  }
  ranked.sort((a, b) => (b.score - a.score) || ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || (b.raw - a.raw) || (a.order - b.order));
  return ranked.slice(0, COMEBACK_TOP_BONDS).map((x) => x.bondId);
}

/**
 * Build a pool weight multiplier for this player's shop roll, or null when the comeback boost is inactive
 * or has no board/bond targets.
 * @param {any} ps
 * @returns {((id: string) => number)|null}
 */
export function shopComebackWeightMul(ps) {
  if (!ps?.shopComeback?.active) return null;
  const boardOps = boardBaseIds(ps);
  const topBonds = new Set(topComebackBonds(ps));
  if (!boardOps.size && !topBonds.size) return null;
  return (id) => {
    let mul = 1;
    if (boardOps.has(id)) mul *= COMEBACK_BOARD_WEIGHT_MUL;
    if (topBonds.size) {
      const rec = ps.gd.chess(id);
      if (rec && Array.isArray(rec.bonds) && rec.bonds.some((b) => topBonds.has(b))) {
        mul *= COMEBACK_BOND_WEIGHT_MUL;
      }
    }
    return mul;
  };
}
