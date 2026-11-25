// server/sim/content/bonds/regulation.js — 规程·序列Ⅰ bond clauses (act3autochess V3_1).
//
// Dispatch is by effectId. 规程 reuses yan / sargon / kjerag / siracusa / kazimierz with new effect ids; a band can
// swap those ids back (and victoria → victoria_2, egir → egir_2). This module does not import core.js: core calls
// bindLegacy after its installers exist, then installEffect / installExtra from install().
// Default data never enters here (core.install only calls us when support.isVersionData()).
//
// Standing ATK / HP / DEF ratios are 直接乘算 (support.directMods). Live layers: support.bondLayers. A missing
// threshold is not reached on version data, same rule as core.reached.

import * as S from '../support/index.js';
import { lendItemEffects } from '../items.js';
import { damageAttackType, isHpLoss } from '../../attack.js';
import { COLS } from '../../constants.js';
import { tileKeyOf } from '../../targeting.js';
import { msg } from '../../../../shared/i18n.js';
import { bbCap } from '../../../../shared/plugins/officialBounds.js';
import { captureLethaniaBirthMode, lethaniaSummon } from './lethania.js';
import { ursusTempExtra } from '../garrisons/regulation.js';

const num = S.num;

/** Bond ids whose 规程 effect id differs from 盟约. core.install dispatches these by effectId. */
export const EFFECT_KEYED_BONDS = new Set(['yanShip', 'sargonShip', 'kjeragShip', 'siracusaShip', 'kazimierzShip']);

/** Buff keys this season introduces. Named so the blackboard audit can see them. */
const K = Object.freeze({
  yan: 'act3autochess_bond_eff_yan',
  yanEnemy: 'act3autochess_bond_eff_yan[enemy]',
  sargon: 'act3autochess_bond_eff_sargon',
  sargonPower: 'act3autochess_bond_eff_sargon_power',
  sargonTile: 'act3autochess_bond_eff_sargon_power[tile_listener]',
  kjerag: 'act3autochess_bond_eff_kjerag',
  kjeragPower: 'act3autochess_bond_eff_kjerag_power',
  siracusa: 'act3autochess_bond_eff_siracusa',
  kazimierz: 'act3autochess_bond_eff_kazimierz',
  victoria: 'act3autochess_bond_eff_victoria',
  egir: 'act3autochess_bond_eff_egir',
  ursus: 'act3autochess_bond_eff_ursus',
  iberia: 'act3autochess_bond_eff_iberia[enemy]',
  iberiaDot: 'act3autochess_bond_eff_iberia[enemy][dot]',
  lethania: 'act3autochess_bond_eff_lethania',
  lethaniaEnemy: 'act3autochess_bond_eff_lethania[enemy]',
  doc: 'act3autochess_bond_eff_doc',
  arcane: 'act3autochess_bond_eff_arcane',
  arcaneEnemy: 'act3autochess_bond_eff_arcane_power[enemy]',
  reward: 'bond_layer_added_reward_equip',
});

const NOTE = 'enemy_9025_aclts';
const CHORUS = 'enemy_9026_acltm';
const GIANT = 'enemy_9024_acsgnt';
const KJERAG_ICE = 'bond:kjerag:ice';
// Official abnormal set of act3autochess_bond_eff_siracusa (buff template abnormal_buff[random_creator]).
const SIRACUSA_STATUS = Object.freeze(['stun', 'fear', 'attract', 'cold', 'palsy', 'groundbind']);
// Official element gauges. The 炎 template rolls element_type 1..6; the engine has these five.
// [ASSUMED] 5 → necrosis and 6 → neural again. No sixth gauge exists in the sim.
const YAN_ELEMENTS = Object.freeze(['neural', 'erosion', 'burn', 'apoptosis', 'necrosis', 'neural']);

let legacy = {};
/** core.js passes its 盟约 installers once they exist. */
export function bindLegacy(map) { legacy = map || {}; }

function effectBb(effectId, key) {
  return S.buffParams(S.effectRecord(effectId), key);
}
function bondBb(bondId, key) {
  return S.buffParams(S.bondRecord(bondId), key);
}
/** Prefer the bond record (a season copies its effect's buffs); a swapped effect id still finds the effect record. */
function bbOf(bondId, effectId, key) {
  return bondBb(bondId, key) || effectBb(effectId, key) || {};
}
function reached(battle, pid, bondId, cnt) {
  const st = S.bondState(battle, pid, bondId);
  if (!st || !st.active) return false;
  const need = num(cnt, 0);
  if (!(need > 0)) return !S.isVersionData();
  if (num(st.count, 0) >= need) return true;
  const th = S.bondRecord(bondId)?.thresholds;
  const idx = Array.isArray(th) ? th.indexOf(need) : -1;
  return idx >= 0 && S.bondTier(battle, pid, bondId) >= idx + 1;
}
function scaled(bb, baseKey, perKey, L, maxKey) {
  let v = num(bb[baseKey]) + num(bb[perKey]) * L;
  const cap = maxKey != null ? bb[maxKey] : undefined;
  if (typeof cap === 'number' && cap !== 0) v = Math.min(v, cap);
  return v;
}
function tagged(dmg, tag) {
  return !!dmg && Array.isArray(dmg.tags) && dmg.tags.includes(tag);
}
function rider(dmg) {
  // ADDITION is excluded (the member template's FilterDamageModifier + IfNot) so the extra arts hit does not chain.
  // Element and periodic hits are also skipped: the template does not filter them, but emitting the extra arts
  // synchronously from `damaged` nests past MAX_HOOK_DEPTH in real fights (溯光星源 and other on-hit chains) and
  // the engine then skips handlers. Left out until that extra hit can be scheduled without dropping the chain.
  if (!dmg || isHpLoss(dmg) || dmg.type === 'element' || dmg.type === 'elemental') return true;
  if (damageAttackType(dmg) === 'ADDITION' || tagged(dmg, 'addition') || tagged(dmg, 'dot') || tagged(dmg, 'periodic')) return true;
  return false;
}
function onLayers(battle, pid, bondId, fn) {
  const st = S.battleStore(battle, 'bonds:reg:layers', () => ({ map: new Map(), pending: new Set(), hooked: false }));
  const k = `${pid}|${bondId}`;
  if (!st.map.has(k)) st.map.set(k, []);
  st.map.get(k).push(fn);
  if (st.hooked) return;
  st.hooked = true;
  const schedule = (c) => {
    const key = `${c.playerId}|${c.bondId}`;
    const list = st.map.get(key);
    if (!list || st.pending.has(key)) return;
    st.pending.add(key);
    battle.after(0, () => { st.pending.delete(key); for (const f of list) f(); });
  };
  battle.on('layerGain', schedule, { priority: -100 });
  battle.on('tempLayerGain', schedule, { priority: -100 });
}

/** Temp layers stored in battle._perPlayer[pid].tempLayerGains (乌萨斯 kill node `_isTemp` + 烈夏 + 多功能补剂). */
export function tempBondLayers(battle, pid, bondId) {
  return num(battle?._perPlayer?.[pid]?.tempLayerGains?.[bondId], 0);
}

function enemyRaw(battle, id) {
  const e = battle.data?.getEnemy?.(id);
  return e?.raw || null;
}
function talentBb(raw) {
  if (!raw) return {};
  if (raw.talents && raw.talents.bb) return raw.talents.bb;
  return {};
}
/** Chebyshev radius. [ASSUMED] range id `x-5` is 5 tiles from the anchor, the square the summon node names. */
function nearestOpen(battle, fromR, fromC, radius) {
  const R = battle.rect;
  let best = null, bestD = Infinity;
  for (let r = R.r0; r <= R.r1; r++) {
    for (let c = R.c0; c <= R.c1; c++) {
      if (radius != null && Math.max(Math.abs(r - fromR), Math.abs(c - fromC)) > radius) continue;
      if (!battle.grid.canStand(r, c)) continue;
      if (battle.unitAt(r, c) || battle.downOn(r, c)) continue;
      const d = Math.abs(r - fromR) + Math.abs(c - fromC);
      if (d < bestD) { bestD = d; best = [r, c]; }
    }
  }
  return best;
}
function inRadius(u, x, y, r) {
  const dx = u.x - x, dy = u.y - y;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

function handSwitch(battle, dead, bondId, { meleeOnly = false, cap = Infinity, counter } = {}) {
  const st = S.battleStore(battle, 'bonds:reg:switch', () => ({ n: {}, taken: new Set() }));
  const pid = dead.ownerId;
  const key = counter || bondId;
  if (num(st.n[`${pid}|${key}`]) >= cap) return false;
  const pieces = (S.contentInfo(battle, pid).handPieces || []).filter((p) => p && Array.isArray(p.bonds) && p.bonds.includes(bondId));
  pieces.sort((a, b) => num(b.slot) - num(a.slot) || String(b.id).localeCompare(String(a.id)));
  const r = dead.tileR, c = dead.tileC;
  for (const p of pieces) {
    const slotKey = `${pid}:${p.slot}`;
    if (st.taken.has(slotKey)) continue;
    if (meleeOnly && String(p.position || '').toUpperCase() !== 'MELEE') continue;
    dead.removed = true;
    const spawned = typeof battle.spawnOperator === 'function'
      ? battle.spawnOperator(pid, p.id, r, c, {}) : null;
    if (!spawned) { dead.removed = false; continue; }
    st.taken.add(slotKey);
    st.n[`${pid}|${key}`] = num(st.n[`${pid}|${key}`]) + 1;
    return true;
  }
  return false;
}

// =====================================================================================================================
// changed effects

function installYan2(battle, pid, effectId, members) {
  const bb = bbOf('yanShip', effectId, K.yan);
  const enemy = bbOf('yanShip', effectId, K.yanEnemy);
  const apply = () => {
    const mods = S.directMods({ atk: num(bb.atk_base) + num(bb.atk_per_stack) * S.bondLayers(battle, pid, 'yanShip') });
    for (const u of members) S.passiveBuff(battle, u, 'bond:yan', mods);
  };
  apply();
  onLayers(battle, pid, 'yanShip', apply);
  const set = new Set(members);
  battle.on('damaged', (c) => {
    const u = c.source, t = c.target, dmg = c.dmg;
    if (!set.has(u) || !t || t.side !== 'enemy' || !t.alive || rider(dmg) || tagged(dmg, 'bond:yan')) return;
    if (!reached(battle, pid, 'yanShip', bb.power_bond_char_cnt)) return;
    const scale = scaled(bb, 'ex_atk_scale_base', 'ex_atk_scale_per_stack', S.bondLayers(battle, pid, 'yanShip'), 'ex_atk_scale_max');
    if (!(scale > 0)) return;
    const roll = Math.floor(battle.rng() * YAN_ELEMENTS.length);
    const element = YAN_ELEMENTS[roll] || 'burn';
    battle.dealElementDamage({ source: u, target: t, amount: scale * num(u.s.atk), element, tags: ['bond:yan'] });
  });
  if (!reached(battle, pid, 'yanShip', enemy.power_bond_char_cnt)) return;
  const rateOf = () => {
    const L = S.bondLayers(battle, pid, 'yanShip');
    return scaled(enemy, 'ep_break_recover_speed_base', 'ep_break_recover_speed_per_stack', L, 'ep_break_recover_speed_max');
  };
  // The attribute is EP_BREAK_RECOVER_SPEED. Same reading as 异客 S3: it shortens the burst lock, not the gauge fill.
  battle.every(0.5, () => {
    const rate = rateOf();
    if (!(rate > 0)) return;
    for (const e of battle.enemies) {
      if (!e.alive || !e.buffs) continue;
      for (const b of e.buffs) {
        if (b.flags && b.flags.burstLock && Number.isFinite(b.timeLeft)) b.timeLeft -= 0.5 * rate;
      }
    }
  });
}

function installSargon2(battle, pid, effectId, members) {
  const bb = bbOf('sargonShip', effectId, K.sargon);
  const tile = bbOf('sargonShip', effectId, K.sargonTile);
  const power = reached(battle, pid, 'sargonShip', bbOf('sargonShip', effectId, K.sargonPower).power_bond_char_cnt);
  const set = new Set(members);
  const maxStacks = Math.max(1, Math.floor(num(bb.max_buff_stack_cnt, 25)));
  const sandTiles = new Set();
  const slowKey = 'act3autochess_bond_eff_sargon_power[tile_buff][slow]';
  const magKey = 'act3autochess_bond_eff_sargon_power[tile_buff][mag_damage]';
  const mag2Key = 'act3autochess_bond_eff_sargon_power[tile_buff][mag_damage_2]';
  const inSand = (e) => sandTiles.size > 0 && S.onKeys(e, sandTiles);
  const inBoostedSand = (e) => inSand(e) && members.some((m) => S.onField(m) && m.skill && m.skill.active && S.inRange(m, e));
  const refreshSlow = () => {
    if (!power) return;
    const L = S.bondLayers(battle, pid, 'sargonShip');
    const baseSlow = scaled(tile, `${slowKey}.slow_base`, `${slowKey}.slow_per_stack`, L, `${slowKey}.slow_max`);
    const slowCap = num(tile[`${slowKey}.slow_max`], baseSlow * 2);
    for (const e of battle.enemies) {
      if (!e.alive) continue;
      if (!inSand(e)) {
        if (e.findBuff && e.findBuff('bond:sargon:slow')) battle.removeBuff(e, 'bond:sargon:slow');
        continue;
      }
      const slow = inBoostedSand(e) ? Math.min(slowCap, baseSlow + baseSlow) : baseSlow;
      battle.addBuff(e, { key: 'bond:sargon:slow', duration: 1.25, refresh: 'replace', mods: { moveMul: Math.max(0, 1 - slow) } });
    }
  };
  battle.on('skillStart', ({ unit }) => {
    if (!set.has(unit)) return;
    const L = S.bondLayers(battle, pid, 'sargonShip');
    const dur = num(bb.base_time) + num(bb.time_per_stack) * L;
    if (dur > 0) {
      for (const m of members) {
        if (!S.onField(m)) continue;
        battle.addBuff(m, {
          key: 'bond:sargon', duration: dur, refresh: 'independent', maxStacks,
          mods: { aspd: num(bb.base_attack_speed) },
        });
      }
    }
    if (power) {
      const keys = unit.rangeKeySet && unit.rangeKeySet.size ? unit.rangeKeySet : unit.rangeKeys;
      if (keys) for (const k of keys) sandTiles.add(k);
      refreshSlow();
    }
  });
  if (!power) return;
  battle.on('skillEnd', ({ unit }) => {
    if (set.has(unit)) refreshSlow();
  });
  battle.every(1, refreshSlow);
  const iv = num(tile[`${magKey}.interval`], 5);
  if (iv > 0) {
    battle.every(iv, () => {
      if (!sandTiles.size) return;
      const L = S.bondLayers(battle, pid, 'sargonShip');
      const amount = scaled(tile, `${magKey}.magic_damage_base`, `${magKey}.magic_damage_per_stack`, L, `${magKey}.magic_damage_max`);
      const bind = num(tile[`${magKey}.unmovable_duration`], 0);
      if (!(amount > 0)) return;
      for (const e of battle.enemies) {
        if (!e.alive || !inSand(e)) continue;
        battle.dealDamage({ source: null, target: e, amount, type: 'arts', attackType: 'BUFF', tags: ['bond:sargon', 'periodic'] });
        if (e.alive && bind > 0) battle.applyStatus(e, 'bind', { duration: bind, source: null });
      }
    });
  }
  // mag_damage_2 triggerInterval is 1s (buff template), and only on sand tiles inside a casting 萨尔贡 member's range.
  battle.every(1, () => {
    if (!sandTiles.size) return;
    const L = S.bondLayers(battle, pid, 'sargonShip');
    const amount = scaled(tile, `${mag2Key}.magic_damage_base`, `${mag2Key}.magic_damage_per_stack`, L, `${mag2Key}.magic_damage_max`);
    if (!(amount > 0)) return;
    for (const e of battle.enemies) {
      if (!e.alive || !inBoostedSand(e)) continue;
      battle.dealDamage({ source: null, target: e, amount, type: 'arts', attackType: 'BUFF', tags: ['bond:sargon', 'periodic'] });
    }
  });
}

function kjeragGiantKit(raw, tb) {
  const st = raw.stats || {};
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  const sk = (key) => skills.find((s) => s && s.prefabKey === key) || null;
  const blockCnt = num(tb['BlockEnemy.block_cnt'], 3);
  const snowyR = num(tb['BlockEnemy.attack@ability_range_radius'], 1.5);
  const giantR = num(st.rangeRadius, 2.4);
  const switchR = num(sk('Switch2Snowy')?.bb?.range_radius, 0.8);
  const switchIv = num(tb['SwitchMode.interval'], 5);
  const splashR = num(sk('PowerAttack')?.bb?.range_radius, 1.1);
  const frozenScale = num(tb['FrozenBreak.atk_scale'], 3.5);
  const attractSp = num(sk('Attract')?.spCost, 18);
  const attractR = num(sk('Attract')?.bb?.range_radius, 1.5);
  // [ASSUMED] Attract duration is not on the enemy blackboard; 3s matches the mode's standard attract pulse.
  const attractDur = 3;
  return {
    trait: {
      attack: 'ranged',
      dmgType: st.dmgType ?? 'arts',
      projectile: 'none',
      canHitFly: true,
      attackRangeRadius: snowyR,
      splashRadius: splashR,
      splashScale: 1,
    },
    install(battle, unit) {
      unit.mem.giantMode = 'snowy';
      unit.mem.giantIdle = 0;
      unit.mem.giantAttractSp = 0;
      const setMode = (mode) => {
        if (unit.mem.giantMode === mode) return;
        unit.mem.giantMode = mode;
        if (mode === 'giant') {
          unit.profile.attackRangeRadius = giantR;
          battle.addBuff(unit, { key: 'bond:kjerag:giantMode', persist: true, refresh: 'replace', mods: { blockCnt: -blockCnt } });
          battle.releaseBlocked(unit);
        } else {
          unit.profile.attackRangeRadius = snowyR;
          battle.removeBuff(unit, 'bond:kjerag:giantMode');
        }
      };
      // 【覆雪坐定】 FrozenBreak: attacks against frozen enemies deal 3.5× arts damage and dispel freeze.
      battle.on('hit', (c) => {
        if (c.source !== unit || unit.mem.giantMode !== 'snowy' || !c.dmg || !c.dmg.isAttack) return;
        const t = c.target;
        if (!t || t.side !== 'enemy' || !t.alive || !t.s?.flags?.freeze) return;
        if (frozenScale > 0) c.dmg.mul *= frozenScale;
        c.dmg.kjeragFrozenBreak = true;
      }, { owner: unit });
      battle.on('damaged', (c) => {
        if (c.source !== unit || !c.dmg || !c.dmg.kjeragFrozenBreak) return;
        if (c.target && c.target.alive) battle.removeBuff(c.target, 'freeze');
      }, { owner: unit });
      battle.on('tick', ({ dt }) => {
        if (!unit.alive || !unit.deployed || !unit.canAct) return;
        const near = (unit.blocking && unit.blocking.length > 0)
          || battle.foesInColliderRadius(unit.x, unit.y, switchR).some((e) => e.alive && !e.isFlying);
        if (unit.mem.giantMode === 'giant') {
          if (near) {
            setMode('snowy');
            unit.mem.giantIdle = 0;
          }
          return;
        }
        // In 【覆雪坐定】 mode: switch to 【覆雪苏醒】 (2.4 ranged splash) if no nearby ground foe for SwitchMode.interval.
        if (near) {
          unit.mem.giantIdle = 0;
        } else {
          unit.mem.giantIdle += dt;
          if (switchIv > 0 && unit.mem.giantIdle + 1e-9 >= switchIv && battle.enemies.some((e) => e.alive && !e.hidden)) {
            setMode('giant');
            unit.mem.giantIdle = 0;
            return;
          }
        }
        // 【神迹之声】 Attract: every attractSp seconds in 【覆雪坐定】, attract enemies within attractR.
        if (attractSp > 0 && attractR > 0) {
          unit.mem.giantAttractSp += dt;
          if (unit.mem.giantAttractSp + 1e-9 >= attractSp) {
            const foes = battle.foesInColliderRadius(unit.x, unit.y, attractR).filter((e) => e.alive);
            if (foes.length) {
              unit.mem.giantAttractSp = 0;
              for (const e of foes) {
                battle.applyStatus(e, 'attract', { duration: attractDur, source: unit, point: { x: unit.x, y: unit.y } });
              }
            }
          }
        }
      }, { owner: unit });
    },
  };
}

function installKjerag2(battle, pid, effectId, members) {
  const bb = bbOf('kjeragShip', effectId, K.kjerag);
  // The combat blackboard also carries power_bond_char_cnt. Passing that through would start the 盟约 cold wind.
  if (typeof legacy.kjerag === 'function') legacy.kjerag(battle, pid, { ...bb, power_bond_char_cnt: 0 }, members);
  const power = bbOf('kjeragShip', effectId, K.kjeragPower);
  if (!reached(battle, pid, 'kjeragShip', power.power_bond_char_cnt || bb.power_bond_char_cnt)) return;
  battle.on('battleStart', () => {
    const anchor = members.find((u) => S.onField(u) || u.tileR != null);
    if (!anchor) return;
    const tile = nearestOpen(battle, anchor.tileR, anchor.tileC, 5);
    if (!tile) return;
    const raw = enemyRaw(battle, GIANT);
    if (!raw) return;
    const tb = talentBb(raw);
    const step = num(tb['BondBuff.stackStep'], 0);
    const steps = step > 0 ? Math.floor(S.bondLayers(battle, pid, 'kjeragShip') / step) : 0;
    // BondBuff on the enemy talent: ATK / HP scale by floor(layers / stackStep). Starts in 【覆雪坐定】 (block 3,
    // 1.5 radius, 1.1 arts splash, 3.5× FrozenBreak + dispel, 18s Attract) and switches to 【覆雪苏醒】 (2.4 ranged
    // arts splash, block 0) when idle for SwitchMode.interval without a nearby ground foe.
    const atkMul = 1 + num(tb['BondBuff.base_atk']) + num(tb['BondBuff.attack_per_stack']) * steps;
    const hpMul = 1 + num(tb['BondBuff.base_max_hp']) + num(tb['BondBuff.max_hp_per_stack']) * steps;
    const st = raw.stats || {};
    const def = {
      ...raw,
      id: GIANT,
      name: raw.name ?? GIANT,
      profession: 'CASTER',
      attackKind: 'ranged',
      dmgType: st.dmgType ?? 'arts',
      canHitFly: true,
      rangeGrid: [[0, 0]],
      immunities: { ...(st.immunities || {}), frozen: true },
    };
    battle.spawnToken(anchor, GIANT, tile[0], tile[1], {
      def, anySource: true,
      kit: kjeragGiantKit(raw, tb),
      stats: {
        atk: num(st.atk) * atkMul,
        maxHp: num(st.maxHp) * hpMul,
        blockCnt: num(tb['BlockEnemy.block_cnt'], st.blockCnt),
      },
    });
  }, { once: true });
}

const ABNORMAL_STATUSES = new Set([
  'stun', 'cold', 'freeze', 'fear', 'attract', 'groundbind', 'palsy', 'sleep', 'levitate', 'bind', 'tremble',
]);

function installSiracusa2(battle, pid, effectId, members) {
  const bb = bbOf('siracusaShip', effectId, K.siracusa);
  const set = new Set(members);
  const six = reached(battle, pid, 'siracusaShip', bb.power_bond_char_cnt);
  battle.on('deploy', ({ unit }) => {
    if (!set.has(unit)) return;
    const L = S.bondLayers(battle, pid, 'siracusaShip');
    const dur = num(bb.base_duration) + num(bb.duration_per_stack) * L;
    if (!(dur > 0)) return;
    battle.addBuff(unit, {
      key: 'bond:siracusa', duration: dur,
      mods: { aspd: num(bb.base_attack_speed) + num(bb.attack_speed_per_stack) * L },
    });
  });
  if (!six) return;
  const prob = num(bb.prob, 0);
  // PRTS 叙拉古 6人: 0.2s internal cooldown per operator on the random abnormal roll (not exposed on the blackboard).
  const abCd = 0.2;
  battle.on('damaged', (c) => {
    const u = c.source, t = c.target, dmg = c.dmg;
    if (!set.has(u) || !t || t.side !== 'enemy' || !t.alive || rider(dmg) || tagged(dmg, 'bond:siracusa')) return;
    const now = battle.time;
    if (now < num(u.mem.siraAbCd, -Infinity) - 1e-9) return;
    u.mem.siraAbCd = now + abCd;
    if (!(battle.rng() < prob)) return;
    const L = S.bondLayers(battle, pid, 'siracusaShip');
    const dur = scaled(bb, 'ab_buff_duration_base', 'ab_buff_duration_per_stack', L, 'ab_buff_duration_max');
    const status = SIRACUSA_STATUS[Math.floor(battle.rng() * SIRACUSA_STATUS.length)];
    if (dur > 0 && status) battle.applyStatus(t, status, { duration: dur, source: u });
  });
  const limit = num(bb.abnormal_buff_count_limit, 2);
  const radius = 1.1; // official AOEDamage radius on the enemy periodic; not a blackboard field
  battle.every(1, () => {
    const L = S.bondLayers(battle, pid, 'siracusaShip');
    const amount = num(bb.damage_value_base) + num(bb.damage_value_per_stack) * L;
    if (!(amount > 0)) return;
    for (const e of battle.enemies) {
      if (!e.alive || abnormalCount(e) < limit) continue;
      for (const o of battle.enemies) {
        if (!o.alive || !inRadius(o, e.x, e.y, radius)) continue;
        battle.dealDamage({ source: null, credit: members[0] || null, target: o, amount, type: 'true',
          attackType: 'BUFF', tags: ['bond:siracusa', 'periodic'] });
      }
    }
  });
}
function abnormalCount(u) {
  const seen = new Set();
  if (Array.isArray(u.buffs)) {
    for (const b of u.buffs) {
      if (b.status && ABNORMAL_STATUSES.has(b.status)) seen.add(b.status);
      else if (b.palsy) seen.add('palsy');
    }
  }
  const f = u.s?.flags || {};
  if (f.cold) seen.add('cold');
  if (f.freeze) seen.add('freeze');
  if (f.fear) seen.add('fear');
  if (f.attract) seen.add('attract');
  if (f.groundbind) seen.add('groundbind');
  if (f.sleep) seen.add('sleep');
  if (f.levitate) seen.add('levitate');
  if (f.bind) seen.add('bind');
  if (f.tremble) seen.add('tremble');
  // freeze and levitate also set flags.stun to stop actions; only count stun when not solely from those.
  if (f.stun && !seen.has('freeze') && !seen.has('levitate')) seen.add('stun');
  return seen.size;
}

function installKazimierz2(battle, pid, effectId, members) {
  const bb = bbOf('kazimierzShip', effectId, K.kazimierz);
  if (typeof legacy.kazimierz === 'function') legacy.kazimierz(battle, pid, bb, members);
  const six = reached(battle, pid, 'kazimierzShip', bb.power_bond_char_cnt);
  if (!six) return;
  const set = new Set(members);
  const window = num(bb.ex_damage_duration, 0);
  battle.on('damaged', (c) => {
    const u = c.source, t = c.target, dmg = c.dmg;
    if (!set.has(u) || !t || t.side !== 'enemy' || !t.alive || rider(dmg) || tagged(dmg, 'bond:kazimierz')) return;
    const fresh = window > 0 && battle.time <= num(u.deployedAt, -Infinity) + window + 1e-9;
    const casting = !!(u.skill && u.skill.active);
    if (!fresh && !casting) return;
    const scale = scaled(bb, 'ex_atk_scale_base', 'ex_atk_scale_per_stack', S.bondLayers(battle, pid, 'kazimierzShip'), 'ex_atk_scale_max');
    if (!(scale > 0)) return;
    battle.dealDamage({ source: u, target: t, amount: scale * num(u.s.atk), type: 'true', attackType: 'ADDITION',
      tags: ['addition', 'bond:kazimierz'] });
  });
  const ops = new Set(members.filter((u) => S.isOp(u) && S.isGroundOp(u)));
  battle.on('death', (c) => {
    const u = c.unit;
    if (!u || c.reason !== 'killed' || c.revivedBy || !ops.has(u) || u.alive || u.removed) return;
    if (!S.isGroundOp(u)) return;
    // 不屈 (priority 10) and 阿戈尔's free redeploy (11) run first. A unit still down is replaced from the bench.
    handSwitch(battle, u, 'kazimierzShip', { meleeOnly: true });
  }, { priority: 0 });
}

function installVictoria2(battle, pid, effectId, members) {
  const bb = bbOf('victoriaShip', effectId, K.victoria);
  const apply = () => {
    const mul = num(bb.base_damage_scale, 1) + num(bb.damage_scale_per_stack) * S.bondLayers(battle, pid, 'victoriaShip');
    for (const u of members) {
      if (S.itemsOf(u).length >= 1) S.passiveBuff(battle, u, 'bond:victoria', { dmgDealtMul: mul });
    }
  };
  apply();
  onLayers(battle, pid, 'victoriaShip', apply);
  if (!reached(battle, pid, 'victoriaShip', bb.power_bond_char_cnt)) return;
  const set = new Set(members);
  // bondeffect_victoria_2 (洛洛) has no tier cap in PRTS or blackboard; override lendItemEffects's legacy default (5).
  const maxTier = num(bb.filter_item_level, 99);
  battle.on('skillStart', ({ unit }) => {
    if (!set.has(unit) || !S.itemsOf(unit).length) return;
    const L = S.bondLayers(battle, pid, 'victoriaShip');
    const duration = scaled(bb, 'share_equip_duration_base', 'share_equip_duration_per_stack', L, 'share_equip_duration_max');
    if (!(duration > 0) || typeof lendItemEffects !== 'function') return;
    for (const a of S.alliesAround(battle, unit, S.N8)) {
      if (!S.isOp(a)) continue;
      lendItemEffects(battle, unit, a, { maxTier, duration });
    }
  });
}

function installEgir2(battle, pid, effectId, members) {
  const bb = bbOf('egirShip', effectId, K.egir);
  if (typeof legacy.egir === 'function') legacy.egir(battle, pid, bb, members, { respawn: false });
  if (!reached(battle, pid, 'egirShip', bb.power_bond_char_cnt)) return;
  const cap = Math.max(0, Math.floor(num(bb.switch_cnt_max, 0)));
  if (!(cap > 0)) return;
  const ops = new Set(members.filter(S.isOp));
  battle.on('death', (c) => {
    const u = c.unit;
    if (!u || c.reason !== 'killed' || c.revivedBy || !ops.has(u) || u.alive || u.removed) return;
    handSwitch(battle, u, 'egirShip', { meleeOnly: false, cap, counter: 'egir2' });
  }, { priority: 0 });
}

// =====================================================================================================================
// new bonds

function installUrsus(battle, pid, effectId, members) {
  const bb = bbOf('ursusShip', effectId, K.ursus);
  const apply = () => {
    const L = S.bondLayers(battle, pid, 'ursusShip');
    const mods = S.directMods({
      atk: num(bb.atk_base) + num(bb.atk_per_stack) * L,
      hp: num(bb.hp_base) + num(bb.hp_per_stack) * L,
    });
    for (const u of members) S.passiveBuff(battle, u, 'bond:ursus', mods);
  };
  apply();
  onLayers(battle, pid, 'ursusShip', apply);
  const set = new Set(members);
  const six = reached(battle, pid, 'ursusShip', bb.power_bond_char_cnt);
  battle.on('death', (c) => {
    if (c.reason !== 'killed' || !c.unit || c.unit.side !== 'enemy') return;
    const killer = c.killer;
    const who = killer && killer.kind === 'token' ? killer.ownerUnit : killer;
    if (!set.has(who)) return;
    const base = six ? num(bb['temp_bond_stack_cnt[power]'], 4) : num(bb.temp_bond_stack_cnt, 2);
    const extra = ursusTempExtra(battle, pid) + Math.max(0, num(bb.extra_bond_stack_cnt, 0));
    battle.addTempLayers(pid, 'ursusShip', base + extra);
  });
  if (!six) return;
  const bleedDur = Math.max(1, Math.round(num(bb.bleed_duration, 10)));
  // PRTS 乌萨斯 6人: convert a share of post-mitigation phys/arts damage taken into independent 10s HP-loss bleeds;
  // each bleed stops if its damage source dies or the operator leaves the field.
  battle.on('hpDamage', (c) => {
    const u = c.target, dmg = c.dmg;
    if (!set.has(u) || !dmg || !(c.amount > 0)) return;
    if ((dmg.type !== 'phys' && dmg.type !== 'arts') || tagged(dmg, 'bond:ursus') || tagged(dmg, 'bond:stead:share')) return;
    const L = S.bondLayers(battle, pid, 'ursusShip');
    const r = scaled(bb, 'damage_one_minus_base', 'damage_one_minus_per_stack', L, 'damage_one_minus_max');
    const cut = Math.max(0, Math.min(num(bb.damage_one_minus_max, 1), r));
    if (!(cut > 0)) return;
    const before = c.amount;
    const transferred = before * cut;
    c.amount = before - transferred;
    const perTick = transferred / bleedDur;
    if (!(perTick > 0)) return;
    const src = c.source;
    const seq = u.deploySeq;
    let ticks = 0;
    const timer = battle.every(1, () => {
      ticks++;
      if (ticks > bleedDur || !u.alive || u.deploySeq !== seq || (src && !src.alive)) { timer.cancel(); return; }
      battle.dealHPLose({ source: src, target: u, amount: perTick, type: 'true', tags: ['bond:ursus', 'periodic'] });
    }, { owner: u, immediate: true });
  }, { priority: -1000 });
  battle.every(1, () => {
    const L = S.bondLayers(battle, pid, 'ursusShip');
    const scale = num(bb.atk_scale_base) + num(bb.atk_scale_per_stack) * L;
    if (!(scale > 0)) return;
    for (const m of members) {
      if (!S.onField(m) || !m.blocking || !m.blocking.length) continue;
      const amount = scale * num(m.s.atk);
      for (const e of m.blocking) {
        if (!e || !e.alive) continue;
        battle.dealDamage({ source: m, target: e, amount, type: 'arts', tags: ['bond:ursus', 'periodic'] });
      }
    }
  });
}

function installIberia(battle, pid, effectId, members) {
  const bb = bbOf('iberiaShip', effectId, K.iberia);
  const set = new Set(members);
  const six = reached(battle, pid, 'iberiaShip', bb.power_bond_char_cnt);
  const speedKey = 'act3autochess_bond_eff_iberia[enemy][speed]';
  const dotCap = 10; // CreateBuff maxStackCnt on act3autochess_bond_eff_iberia[enemy][dot]
  const cd = new WeakMap();
  const whoOf = (u) => {
    if (!u) return null;
    if (set.has(u)) return u;
    // [ASSUMED] 炼金单元 is a token whose owner is an 伊比利亚 member.
    if (u.kind === 'token' && u.ownerUnit && set.has(u.ownerUnit)) return u.ownerUnit;
    return null;
  };
  battle.on('damaged', (c) => {
    const t = c.target, dmg = c.dmg;
    if (!t || t.side !== 'enemy' || !t.alive || !dmg || tagged(dmg, 'bond:iberia') || rider(dmg)) return;
    const who = whoOf(c.source);
    if (!who) return;
    let stamp = cd.get(t);
    if (!stamp) { stamp = new Map(); cd.set(t, stamp); }
    const now = battle.time;
    if (now < num(stamp.get(who), -Infinity)) return;
    stamp.set(who, now + 0.2);
    const st = t.mem.iberia || (t.mem.iberia = { stacks: 0, until: 0, atk: 0, who, slow: 0, slowUntil: 0, timer: null });
    st.stacks = Math.min(dotCap, st.stacks + 1);
    st.until = now + num(bb.dot_duration, 10);
    st.atk = num(who.s.atk);
    st.who = who;
    st.power = six;
    if (six) {
      if (now > st.slowUntil + 1e-9) st.slow = 0;
      const slowMax = num(bb[`${speedKey}.max_stack_cnt`], 20);
      const slowDur = num(bb[`${speedKey}.speed_duration`], 10);
      st.slow = Math.min(slowMax, st.slow + 1);
      st.slowUntil = now + slowDur;
      const move = num(bb[`${speedKey}.move_speed`], -0.04);
      battle.addBuff(t, {
        key: 'bond:iberia:slow', duration: slowDur, refresh: 'replace',
        // [ASSUMED] move_speed is an additive attribute-style factor (1 + value × stacks), floored at 0.
        mods: { moveMul: Math.max(0, 1 + move * st.slow) },
      });
      const prob = num(bb.prob_base) + num(bb.prob_per_stack) * S.bondLayers(battle, pid, 'iberiaShip');
      if (battle.rng() < prob) {
        const radius = num(bb.range_radius, 1.7);
        const amount = num(bb.atk_scale, 0) * st.atk;
        if (amount > 0) {
          for (const e of battle.enemies) {
            if (!e.alive || e === t || !inRadius(e, t.x, t.y, radius)) continue;
            battle.dealDamage({ source: who, target: e, amount, type: 'arts', isSplash: true, tags: ['bond:iberia', 'addition'] });
          }
        }
      }
    }
    // One timer for the enemy's life. Expiry clears stacks but keeps the timer, so a later stack does not start a second one.
    if (st.timer) return;
    st.timer = battle.every(1, () => {
      if (!t.alive) return;
      if (!(st.stacks > 0) || battle.time > st.until + 1e-9) { st.stacks = 0; return; }
      const L = S.bondLayers(battle, pid, 'iberiaShip');
      let scale = (num(bb.dot_atk_scale_base) + num(bb.dot_atk_scale_per_stack) * L) * st.stacks;
      if (st.power) scale += scale; // template BlackboardAdd of the scale onto itself when is_power > 0
      if (scale > 0) {
        // PRTS 伊比利亚: the ongoing arts DoT is arts HP loss (mitigated by RES, ignores dodge/barriers/damage-res).
        battle.dealHPLose({ source: st.who, target: t, amount: scale * st.atk, type: 'arts', tags: ['bond:iberia', 'dot', 'periodic'] });
      }
    }, { owner: t });
  });
}

function installLethania(battle, pid, effectId, members) {
  const bb = bbOf('lethaniaShip', effectId, K.lethania);
  const power = reached(battle, pid, 'lethaniaShip', bb.power_bond_char_cnt);
  const chorusAuraPer = () => {
    const raw = enemyRaw(battle, CHORUS);
    const tb = talentBb(raw);
    const base = num(tb['Aura.base_attack_speed'], 20);
    const per = num(tb['Aura.attack_speed_per_stack'], 0);
    const step = num(tb['Aura.stackStep'], 10);
    const steps = per && step > 0 ? Math.floor(S.bondLayers(battle, pid, 'lethaniaShip') / step) : 0;
    return base + per * steps;
  };
  const syncChorusAura = () => {
    if (!power) return;
    let cnt = 0;
    for (const u of battle.allyUnits) {
      if (u.ownerId === pid && u.alive && u.kind === 'token' && u.defId === CHORUS) cnt++;
    }
    const aspd = cnt > 0 ? chorusAuraPer() * cnt : 0;
    for (const m of members) {
      if (aspd > 0) S.passiveBuff(battle, m, 'bond:lethania:chorusAura', { aspd });
      else battle.removeBuff(m, 'bond:lethania:chorusAura');
    }
  };
  const apply = () => {
    const mods = S.directMods({ atk: num(bb.atk_base) + num(bb.atk_per_stack) * S.bondLayers(battle, pid, 'lethaniaShip') });
    for (const u of members) S.passiveBuff(battle, u, 'bond:lethania', mods);
    for (const u of battle.allyUnits) {
      if (u.ownerId === pid && u.kind === 'token' && (u.defId === NOTE || u.defId === CHORUS)) {
        S.passiveBuff(battle, u, 'bond:lethania', mods);
      }
    }
    syncChorusAura();
  };
  apply();
  onLayers(battle, pid, 'lethaniaShip', apply);
  const aliveNotes = () => battle.allyUnits.filter((u) => u.ownerId === pid && u.alive && u.kind === 'token'
    && (u.defId === NOTE || u.defId === CHORUS)).length;
  const summonOne = (anchor) => {
    const cap = power ? num(bb.summon_cnt_max_2, 20) : num(bb.summon_cnt_max_1, 10);
    // [ASSUMED] the cap counts living notes, not every summon ever created.
    if (aliveNotes() >= cap || !anchor) return;
    const L = S.bondLayers(battle, pid, 'lethaniaShip');
    const p = Math.min(num(bb.summon_prob_max, 1), num(bb.summon_prob_base, 1) + num(bb.summon_prob_per_stack) * L);
    if (!(battle.rng() < p)) return;
    let id = NOTE;
    if (power) {
      const big = Math.min(num(bb.big_prob_max, 1), num(bb.big_prob_base) + num(bb.big_prob_per_stack) * L);
      if (battle.rng() < big) id = CHORUS;
    }
    const raw = enemyRaw(battle, id);
    if (!raw) return;
    const R = battle.rect;
    const deathTile = tileKeyOf(anchor);
    if (deathTile < 0) return;
    const row = Math.max(R.r0, Math.min(R.r1, Math.floor(deathTile / COLS)));
    const col = Math.max(R.c0, Math.min(R.c1, deathTile % COLS));
    // [ASSUMED] the note and the chorus are allied tokens built from the enemy record (they are not in tokens.json).
    // They appear at the death cell center, even on non-deployable floor, another pursuer, an ally, or a downed body.
    const u = battle.spawnToken(pid, id, row, col, {
      ...lethaniaSummon(id, raw), lethaniaPursuit: true, position: { x: col, y: row },
    });
    if (!u) return;
    if (id === NOTE) captureLethaniaBirthMode(battle, u);
    const tb = talentBb(raw);
    const ratio = num(tb['Bleeding.hp_ratio']);
    const iv = num(tb['Bleeding.interval'], 1);
    if (ratio > 0 && iv > 0) {
      battle.every(iv, () => {
        if (!u.alive) return;
        battle.dealHPLose({ source: u, target: u, amount: ratio * u.s.maxHp, type: 'true', tags: ['bond:lethania:bleed'] });
      }, { owner: u });
    }
    apply();
  };
  battle.on('death', (c) => {
    const u = c.unit;
    if (!u) return;
    if (u.side === 'ally' && u.kind === 'token' && u.ownerId === pid && u.defId === CHORUS) syncChorusAura();
    if (c.reason !== 'killed') return;
    if (u.side === 'enemy') { summonOne(u); return; }
    if (power && u.side === 'ally' && u.kind === 'op' && u.ownerId === pid) summonOne(u);
  });
}

function installDoc(battle, pid, effectId, members) {
  const bb = bbOf('docShip', effectId, K.doc);
  const three = reached(battle, pid, 'docShip', bb.power_bond_char_cnt);
  const syncShelter = () => {
    if (!three) return;
    const L = S.bondLayers(battle, pid, 'docShip');
    const res = num(bb.damage_res_base) + num(bb.damage_res_per_stack) * L;
    const covered = new Map();
    if (res > 0) {
      for (const m of members) {
        if (!S.onField(m)) continue;
        for (const a of battle.allyUnits) {
          if (!a.alive || a.ownerId !== pid || !S.isOp(a) || !S.inRange(m, a)) continue;
          const prev = covered.get(a) || 0;
          if (res > prev) covered.set(a, res);
        }
      }
    }
    for (const a of battle.allyUnits) {
      if (a.ownerId !== pid || !S.isOp(a)) continue;
      const v = covered.get(a) || 0;
      if (v > 0 && a.alive) {
        // PRTS 庇护 (ba.protect): reduces physical and arts damage taken (strongest of overlapping members), never true/elemental.
        const mul = Math.max(0, 1 - v);
        battle.addBuff(a, { key: 'bond:doc:res', mods: { physTakenMul: mul, artsTakenMul: mul }, refresh: 'replace' });
      } else if (a.findBuff && a.findBuff('bond:doc:res')) {
        battle.removeBuff(a, 'bond:doc:res');
      }
    }
  };
  if (three) {
    battle.on('battleStart', syncShelter);
    battle.on('deploy', (c) => { if (c.unit && c.unit.ownerId === pid && S.isOp(c.unit)) syncShelter(); });
    battle.on('death', (c) => { if (c.unit && c.unit.ownerId === pid && S.isOp(c.unit)) syncShelter(); });
    onLayers(battle, pid, 'docShip', syncShelter);
    battle.every(0.25, syncShelter);
  }
  battle.every(1, () => {
    const L = S.bondLayers(battle, pid, 'docShip');
    const healR = num(bb.heal_base) + num(bb.heal_per_stack) * L;
    const epR = num(bb.ep_heal_base) + num(bb.ep_heal_per_stack) * L;
    for (const m of members) {
      if (!S.onField(m)) continue;
      const atk = num(m.s.atk);
      for (const a of battle.allyUnits) {
        if (!a.alive || a.ownerId !== pid || !S.isOp(a) || !S.inRange(m, a)) continue;
        // [ASSUMED] overlapping members each heal; HP and element recovery stack.
        if (healR > 0) battle.heal({ source: m, target: a, amount: healR * atk });
        if (epR > 0) battle.healElement({ target: a, amount: epR * atk });
      }
    }
    if (three) syncShelter();
  });
}

// =====================================================================================================================
// entry

const BY_EFFECT = Object.freeze({
  bondeffect_yan_2: installYan2,
  bondeffect_sargon_2: installSargon2,
  bondeffect_kjerag_2: installKjerag2,
  bondeffect_siracusa_2: installSiracusa2,
  bondeffect_kazimierz_2: installKazimierz2,
  bondeffect_victoria_2: installVictoria2,
  bondeffect_egir_2: installEgir2,
});

/** @returns {boolean} true when this effect id is handled here (core must not also run the 盟约 installer). */
export function installEffect(battle, pid, bondId, effectId, members) {
  const fn = BY_EFFECT[effectId];
  if (!fn) return false;
  fn(battle, pid, effectId, members);
  return true;
}

const EXTRA = Object.freeze([
  ['ursusShip', 'bondeffect_ursus', installUrsus],
  ['iberiaShip', 'bondeffect_iberia', installIberia],
  ['lethaniaShip', 'bondeffect_lethania', installLethania],
  ['docShip', 'bondeffect_doc', installDoc],
]);

export function installExtra(battle) {
  if (!S.isVersionData() || !battle || !Array.isArray(battle.players)) return;
  for (const p of battle.players) {
    const pid = p.playerId;
    for (const [bondId, effectId, fn] of EXTRA) {
      if (!S.bondActive(battle, pid, bondId)) continue;
      const cur = S.bondRecord(bondId)?.effectId;
      if (cur && cur !== effectId) continue;
      const members = S.bondMembers(battle, pid, bondId);
      if (!members.length) continue;
      fn(battle, pid, cur || effectId, members);
    }
  }
}

const ARCANE_REVEAL = 'bond:arcane:reveal';

/** Max arcane layers in this battle, and whether any player's prep count reached `need`. Pair / 联防 share one Battle. */
function arcaneArea(battle, need) {
  let maxLayers = 0;
  let met = false;
  for (const p of battle.players || []) {
    const pid = p.playerId;
    const layers = S.bondLayers(battle, pid, 'arcaneShip');
    if (layers > maxLayers) maxLayers = layers;
    if (reached(battle, pid, 'arcaneShip', need)) met = true;
  }
  return { maxLayers, met };
}

/**
 * 隐匿失效 while a powered arcane member's range covers the enemy. The ability prefab
 * (act3autochess_bond_mag_power[immune_invisible]) is not in the tables.
 * [ASSUMED] leaving the range restores 隐匿: the effect text conditions 失效 on standing in range,
 * the same way an operator module's 「攻击范围内敌人的隐匿效果失效」 does. Not a dispel.
 */
function syncArcaneStealth(battle) {
  const need = bondBb('arcaneShip', K.arcane).power_bond_char_cnt;
  const members = [];
  for (const p of battle.players || []) {
    if (!reached(battle, p.playerId, 'arcaneShip', need)) continue;
    for (const m of S.bondMembers(battle, p.playerId, 'arcaneShip', { fieldOnly: true })) members.push(m);
  }
  for (const e of battle.enemies || []) {
    if (!e) continue;
    const held = typeof e.findBuff === 'function' && e.findBuff(ARCANE_REVEAL);
    const inside = e.alive && e.s?.flags?.stealth && members.some((m) => S.inRange(m, e));
    if (inside) {
      if (!held) battle.addBuff(e, { key: ARCANE_REVEAL, flags: { reveal: true }, duration: Infinity, refresh: 'replace' });
    } else if (held) battle.removeBuff(e, ARCANE_REVEAL);
  }
}

/**
 * 奥术 on a season whose first env_gbuff_new is the act3 arts rider (atk_base, no base_damage_scale).
 * Called from addon/battle.js. Default data returns immediately.
 */
export function installArcaneExtra(battle) {
  if (!S.isVersionData() || !battle) return;
  const sample = bondBb('arcaneShip', K.arcane);
  // a season without the act3 rider (第一期 has no 奥术 at all: null) keeps its own path
  if (!sample || sample.base_damage_scale != null || sample.atk_base == null) return;
  const enemy0 = bondBb('arcaneShip', K.arcaneEnemy);
  // Power clauses (RES shred, 隐匿失效) exist only once some player in this battle reached 3. Skipping the
  // listener and the 0.2 s poll otherwise keeps battles that never meet it off this scheduler.
  if (!arcaneArea(battle, enemy0.power_bond_char_cnt).met) return;
  battle.on('damaged', (c) => {
    const t = c.target, dmg = c.dmg;
    // Enemy template act3autochess_bond_eff_arcane_power[enemy]: ANY_ATTACK_EXCEPT_ELEMENT, cancelled hits
    // dropped, source and the continuous shared mask not filtered. The buff stays when the MAX char count
    // in this battle is ≥ power_bond_char_cnt (_useMaxBondCharCntInCurArea). The floor uses the MAX layers
    // in this battle (_useMaxBondStackCntInCurArea), not the hitter's.
    if (!t || t.side !== 'enemy' || !t.alive || !dmg || dmg.type === 'element' || dmg.type === 'elemental' || isHpLoss(dmg)) return;
    const enemy = bondBb('arcaneShip', K.arcaneEnemy);
    const area = arcaneArea(battle, enemy.power_bond_char_cnt);
    if (!area.met) return;
    const L = area.maxLayers;
    const floor = Math.max(num(enemy.magic_res_max_min, -100), num(enemy.magic_res_max_base, -30) + num(enemy.magic_res_max_per_stack) * L);
    // The template stores magic_resistance and adds magic_res_add when it is still above the floor.
    // A later, deeper floor (the other player's layers rose) steps by one, it does not replay every past hit.
    const prev = num(t.mem.arcaneResAcc, 0);
    if (!(prev > floor)) return;
    const acc = Math.max(floor, prev + num(enemy.magic_res_add, -1));
    t.mem.arcaneResAcc = acc;
    const effective = num(t.base?.res) + acc;
    const shown = Math.min(100, Math.max(0, effective));
    const official = (100 - effective) / 100;
    const engine = (100 - shown) / 100;
    const mods = { resFlat: acc };
    if (engine > 0 && Math.abs(official - engine) > 1e-9) mods.artsTakenMul = official / engine;
    S.passiveBuff(battle, t, 'bond:arcane:res', mods);
  });
  battle.every(0.2, () => syncArcaneStealth(battle));
  battle.on('statusApplied', (c) => {
    if (!c || c.status !== 'stealth' || !c.target || c.target.side !== 'enemy') return;
    syncArcaneStealth(battle);
  });
}

/** Extra arts hit of the act3 奥术 rider. addon calls this only when base_damage_scale is absent. */
export function arcaneRider(battle, ctx, bb) {
  const dmg = ctx.dmg, src = ctx.source, t = ctx.target;
  if (!src || !t || !dmg || rider(dmg) || tagged(dmg, 'bond:arcane')) return;
  const scale = Math.abs(num(bb.atk_base) + num(bb.atk_per_stack) * S.bondLayers(battle, src.ownerId, 'arcaneShip'));
  if (!(scale > 0)) return;
  battle.dealDamage({
    source: src, target: t, amount: scale * num(src.s.atk), type: 'arts', attackType: 'ADDITION',
    tags: ['addition', 'bond:arcane'],
  });
}

/**
 * 谢拉格不融冰: every `layer` layers of kjeragShip, `count` item(s) from `pool`.
 * No-op when the bond record has no bond_layer_added_reward_equip (盟约 谢拉格, and a swap back to it).
 * The item's own effect belongs to the items task.
 */
export function payKjeragIce(ctx) {
  if (!ctx || typeof ctx.bondActive !== 'function' || !ctx.bondActive('kjeragShip')) return 0;
  const rec = ctx.data?.bonds?.kjeragShip ?? S.bondRecord('kjeragShip');
  const effectId = rec?.effectId;
  const p = S.buffParams(rec, K.reward) || (effectId ? S.buffParams(S.effectRecord(effectId), K.reward) : null);
  const step = Math.floor(num(p?.layer, 0));
  if (!p || !(step > 0)) return 0;
  const due = Math.floor(ctx.layers('kjeragShip') / step);
  const count = Math.min(bbCap('count'), Math.max(0, Math.floor(num(p.count, 1))));
  let granted = 0;
  for (let guard = 0; guard < 100; guard++) {
    const paid = ctx.counter(KJERAG_ICE);
    if (paid >= due) break;
    ctx.setCounter(KJERAG_ICE, paid + 1);
    for (let i = 0; i < count; i++) {
      const id = ctx.rollItem({ pool: p.pool });
      if (id && ctx.grantItem(id, { source: 'bond:kjeragShip' })) granted++;
    }
  }
  if (granted && typeof ctx.toast === 'function') ctx.toast(msg('【谢拉格】获得{n}件谢拉格不融冰', { n: granted }), 'info');
  return granted;
}
