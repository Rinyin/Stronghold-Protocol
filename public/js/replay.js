// Native in-client full-process replay mode (`/?replay=<tag>`, plus the 运营回放 picker in Title / Lobby).
//
// Plays recorded server protocol streams (`/dev/recordings/demo_ops/<tag>_native.json`) directly through the
// client's real store, real PixiJS/Spine battlefield, real shop/bench/equipment/bond/choice UI, and real
// deterministic battleRunner — zero WebSocket traffic, pure read-only spectating.
//
// Exports:
//   parseReplayParam(search)      -> { mode: 'play'|'picker', tag: string|null } | null
//   initReplayFromUrl()           -> auto-enter replay or open picker on boot when `?replay=` is present
//   openReplayPicker()            -> open the match selection modal from Title / Lobby / ReplayDock
//   startReplay(tag)              -> load `<tag>_native.json` and enter native replay
//   exitReplay()                  -> leave native replay cleanly and restore prior state
//   isReplayActive()              -> boolean
//   ReplayEntryButton             -> compact entry button for Title / Lobby
//   ReplayHost                    -> global overlay mounted once in App (picker modal + dock + callout)

import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { PHASE } from '../../shared/constants.js';
import { t, N_ } from '../../shared/i18n.js';
import { createStore, store, useStore, emptyMatch } from './store.js';
import { net } from './net.js';
import { data } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { battleRunner } from './battle/runner.js';
import { contentSet } from './content.js';
import { DEFAULT_VERSION } from './versions.js';
import { html, Button, Icon, MicroLabel, Modal, Spinner, closeAllDialogs } from './ui/components.js';
import { toast } from './ui/toasts.js';

const MATCHES_URL = '/dev/recordings/demo_ops/matches.json';
const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2, 4]);
const TAG_RE = /^[A-Za-z0-9_-]{1,80}$/;

const CORE_META = Object.freeze({
  kjeragShip: { label: N_('谢拉格'), tone: 'kjerag' },
  lethaniaShip: { label: N_('莱塔尼亚'), tone: 'lethania' },
  ursusShip: { label: N_('乌萨斯'), tone: 'ursus' },
  yanShip: { label: N_('炎'), tone: 'yan' },
  victoriaShip: { label: N_('维多利亚'), tone: 'victoria' },
  sargonShip: { label: N_('萨尔贡'), tone: 'sargon' },
  egirShip: { label: N_('阿戈尔'), tone: 'egir' },
  siracusaShip: { label: N_('叙拉古'), tone: 'siracusa' },
  kazimierzShip: { label: N_('卡西米尔'), tone: 'kazimierz' },
  iberiaShip: { label: N_('伊比利亚'), tone: 'iberia' },
});

function matchPeakLayers(m) {
  return Math.max(Number(m?.peakLayers || 0), Number(m?.r14ActivatedLayers || 0));
}

function evaluateMatchHighlight(m, maxSoloLayers, maxCoopLayers) {
  const peak = matchPeakLayers(m);
  const r15Dps = Number(m?.r15Dps || 0);
  const lp = Number(m?.lpRemaining || 0);
  const cleared = !!m?.hiddenCleared;
  const isCoop = m?.mode === 'coop';
  const modeMax = isCoop ? maxCoopLayers : maxSoloLayers;
  const isRecord = cleared && peak > 0 && peak === modeMax && (isCoop ? peak >= 1500 : peak >= 550);

  let tier = 'normal';
  if (m?.featured === 'legend'
    || isRecord
    || (!isCoop && cleared && (peak >= 700 || r15Dps >= 200000))
    || (isCoop && cleared && peak >= 1600)) {
    tier = 'legend';
  } else if (m?.featured === true || m?.featured === 'featured'
    || (!isCoop && cleared && (peak >= 520 || r15Dps >= 100000 || lp >= 19))) {
    tier = 'featured';
  }

  const tierWeight = tier === 'legend' ? 2 : tier === 'featured' ? 1 : 0;
  const score = tierWeight * 1e9 + (isRecord ? 5e8 : 0) + (cleared ? 1e8 : 0) + peak * 1e4 + Math.min(9999, Math.round(r15Dps / 100));
  return { tier, isRecord, peak, r15Dps, score };
}

const ACTION_BADGE = Object.freeze({
  round_start: N_('回合开始'),
  buy: N_('招募'),
  sell: N_('出售'),
  refresh: N_('刷新'),
  upgrade: N_('升本'),
  freeze: N_('冻结'),
  choice_pick: N_('选卡'),
  choice: N_('确认选择'),
  deploy: N_('部署'),
  recall: N_('撤回'),
  equip: N_('穿戴装备'),
  gift: N_('信标传递'),
  sellEquip: N_('销毁装备'),
  unequip: N_('卸下装备'),
  command: N_('策略指令'),
  note: N_('运营思路'),
  ready: N_('准备就绪'),
  readyAll: N_('全员就绪'),
});

const KIND_LABEL = Object.freeze({
  normal: N_('常规作战'),
  unite: N_('联防作战'),
  boss: N_('最终攻势'),
  hidden: N_('隐秘核心'),
});

/** Observable replay state (consumed by ReplayHost and screens). */
export const replayStore = createStore({
  active: false,
  pickerOpen: false,
  loading: false,
  loadingTag: null,
  error: null,
  matches: [],
  matchesLoading: false,
  matchesError: null,
  doc: null,
  roundIdx: 0,
  stage: 'prep', // 'prep' | 'battle' | 'result'
  stepIdx: 0,
  battleIdx: 0,
  seatIdx: 0,
  playing: true,
  speed: 2,
  collapsed: false,
  battleDone: false,
  battleGt: 0,
  activeBattleId: null,
  loadNote: '',
});

/** Parse `?replay=<tag>` or `?replay=1` from a query string. */
export function parseReplayParam(search) {
  try {
    const sp = new URLSearchParams(search || '');
    if (!sp.has('replay')) return null;
    const raw = (sp.get('replay') || '').trim();
    if (!raw || raw === '1' || raw === 'true' || raw === 'picker' || raw === 'list') {
      return { mode: 'picker', tag: null };
    }
    if (!TAG_RE.test(raw)) return { mode: 'picker', tag: null };
    return { mode: 'play', tag: raw };
  } catch {
    return null;
  }
}

function setUrlReplayParam(tag) {
  try {
    const url = new URL(location.href);
    if (tag) url.searchParams.set('replay', tag);
    else url.searchParams.delete('replay');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

/** Whether native replay mode is currently active. */
export function isReplayActive() {
  return replayStore.get().active === true;
}

// ---- lossless hydration of `<tag>_native.json` -------------------------------------------------------

function deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

function restorePriv(rawPriv, shared, seatKey, roundKey) {
  if (!rawPriv || typeof rawPriv !== 'object') return rawPriv;
  const out = { ...rawPriv };
  if (out.loadout === '$shared' && shared?.loadoutBySeat?.[seatKey]) {
    out.loadout = shared.loadoutBySeat[seatKey];
  }
  if (out.diy === '$shared' && shared?.diyBySeat?.[seatKey]) {
    out.diy = shared.diyBySeat[seatKey];
  }
  if (out.nextEnemies === '$shared' && shared?.nextEnemiesByRound?.[`${roundKey}:${seatKey}`]) {
    out.nextEnemies = shared.nextEnemiesByRound[`${roundKey}:${seatKey}`];
  }
  return out;
}

function hydrateNativeReplay(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rounds)) {
    throw new Error('invalid native replay document');
  }
  const shared = raw.shared || {};
  const seats = Array.isArray(raw.seats) && raw.seats.length
    ? raw.seats
    : (Array.isArray(raw.room?.seats) ? raw.room.seats.map((s, i) => ({
      seatIdx: i, playerId: s?.playerId || `p_${i}`, name: s?.name || `P${i + 1}`, bandId: null, bandName: '',
    })) : [{ seatIdx: 0, playerId: 'p_0', name: 'P1', bandId: null, bandName: '' }]);

  const rounds = raw.rounds.map((r) => {
    const rk = String(r.round);
    let prevPub = null;
    const prevPrivBySeat = {};
    const steps = (Array.isArray(r.steps) ? r.steps : []).map((st, idx) => {
      const pub = st.pub === '$same' ? prevPub : st.pub;
      prevPub = pub;
      const privBySeat = {};
      for (const [sk, pv] of Object.entries(st.privBySeat || {})) {
        const resolved = pv === '$same' ? prevPrivBySeat[sk] : restorePriv(pv, shared, sk, rk);
        privBySeat[sk] = resolved;
        prevPrivBySeat[sk] = resolved;
      }
      return {
        seq: st.seq ?? idx,
        ts: st.ts || 0,
        phase: st.phase || pub?.phase || PHASE.PREP,
        seatIdx: Number.isInteger(st.seatIdx) ? st.seatIdx : 0,
        action: st.action || 'step',
        label: st.label || '',
        result: st.result || '',
        note: st.note || '',
        ok: st.ok !== false,
        highlight: st.highlight || null,
        pub,
        privBySeat,
      };
    });

    const battles = (Array.isArray(r.battles) ? r.battles : []).map((b) => {
      const privBySeat = {};
      for (const [sk, pv] of Object.entries(b.privBySeat || {})) {
        privBySeat[sk] = restorePriv(pv, shared, sk, rk);
      }
      return {
        kind: b.kind || b.bStart?.kind || b.bStart?.spec?.kind || 'normal',
        battleId: b.battleId || b.bStart?.battleId || `r${r.round}_b`,
        fieldId: b.fieldId || b.bStart?.fieldId || b.bStart?.spec?.fieldId || '',
        members: Array.isArray(b.members) ? b.members : [],
        seatIdxs: Array.isArray(b.seatIdxs) ? b.seatIdxs : [],
        pub: b.pub || null,
        privBySeat,
        bStart: b.bStart || null,
        poolEvents: Array.isArray(b.poolEvents) ? b.poolEvents : [],
        resultSummary: b.resultSummary || null,
      };
    });

    return {
      round: Number(r.round) || 1,
      summary: r.summary || {},
      steps,
      battles,
    };
  });

  return {
    ...raw,
    seats,
    rounds,
  };
}

function battlesForSeat(roundObj, seatIdx, seats) {
  const all = Array.isArray(roundObj?.battles) ? roundObj.battles : [];
  if (!all.length) return [];
  const pid = seats[seatIdx]?.playerId;
  const mine = all.filter((b) => (Array.isArray(b.seatIdxs) && b.seatIdxs.includes(seatIdx))
    || (pid && Array.isArray(b.members) && b.members.includes(pid)));
  return mine.length ? mine : all;
}

function seatPrivFrom(privBySeat, seatIdx) {
  if (!privBySeat || typeof privBySeat !== 'object') return null;
  if (privBySeat[String(seatIdx)]) return privBySeat[String(seatIdx)];
  if (privBySeat['0']) return privBySeat['0'];
  const firstKey = Object.keys(privBySeat)[0];
  return firstKey != null ? privBySeat[firstKey] : null;
}

// ---- playback controller -----------------------------------------------------------------------------

let stepTimer = null;
let battleAdvanceTimer = null;
let runnerOffs = [];
let poolCursor = 0;
let activePoolEvents = null;
let savedSessionSnap = null;
let loadToken = 0;

function clearTimers() {
  if (stepTimer != null) { clearTimeout(stepTimer); stepTimer = null; }
  if (battleAdvanceTimer != null) { clearTimeout(battleAdvanceTimer); battleAdvanceTimer = null; }
}

function detachRunnerListeners() {
  for (const off of runnerOffs) { try { off(); } catch { /* ignore */ } }
  runnerOffs = [];
  activePoolEvents = null;
  poolCursor = 0;
}

function combatPhaseForKind(kind) {
  if (kind === 'hidden') return PHASE.HIDDEN_CORE;
  if (kind === 'boss') return PHASE.FINAL_ASSAULT;
  if (kind === 'unite') return PHASE.UNITE;
  return PHASE.COMBAT;
}

const COMBAT_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

function patchPubForReplay(rawPub, { isCombat = false, battleObj = null } = {}) {
  if (!rawPub || typeof rawPub !== 'object') return null;
  const now = Date.now();
  const out = {
    ...deepClone(rawPub),
    paused: false,
    combatMode: 'client',
    serverNow: now,
  };
  if (isCombat && battleObj) {
    if (!COMBAT_PHASES.has(out.phase)) {
      out.phase = combatPhaseForKind(battleObj.kind);
    }
    if (!Array.isArray(out.fields) || !out.fields.length) {
      out.fields = [{
        fieldId: battleObj.fieldId,
        kind: battleObj.kind,
        players: Array.isArray(battleObj.members) ? battleObj.members : [],
        status: 'running',
      }];
    }
  }
  if (out.deadline != null) {
    out.deadline = now + (isCombat ? 120_000 : 180_000);
  }
  if (out.overtimeAt != null) {
    out.overtimeAt = now + 120_000;
  }
  return out;
}

function prepStepDelayMs(step, speed) {
  const s = Math.max(0.5, Number(speed) || 1);
  const base = (step?.note || step?.action === 'choice_pick' || step?.action === 'note') ? 2300 : 1450;
  return Math.max(360, Math.min(3800, Math.round(base / s)));
}

function schedulePrepAdvance() {
  clearTimers();
  const st = replayStore.get();
  if (!st.active || !st.playing || st.stage !== 'prep' || !st.doc) return;
  const r = st.doc.rounds[st.roundIdx];
  const step = r?.steps?.[st.stepIdx];
  stepTimer = setTimeout(() => {
    stepTimer = null;
    nextReplayStep({ fromAuto: true });
  }, prepStepDelayMs(step, st.speed));
}

function attachBattleListeners(battleObj) {
  detachRunnerListeners();
  if (!battleRunner || !battleObj) return;
  activePoolEvents = Array.isArray(battleObj.poolEvents) && battleObj.poolEvents.length ? battleObj.poolEvents : null;
  poolCursor = 0;

  runnerOffs.push(battleRunner.on('snap', (snap) => {
    const st = replayStore.get();
    if (!st.active || st.stage !== 'battle' || st.activeBattleId !== battleObj.battleId) return;
    const gt = Number(snap?.gt) || 0;
    if (Math.abs(gt - st.battleGt) >= 0.4) {
      replayStore.set({ battleGt: Math.round(gt * 10) / 10 });
    }
    if (activePoolEvents) {
      while (poolCursor < activePoolEvents.length && activePoolEvents[poolCursor].gt <= gt + 0.05) {
        const ev = activePoolEvents[poolCursor++];
        try { battleRunner.onPool({ t: 'b.pool', hp: ev.hp, ...(ev.acked ? { acked: ev.acked } : {}) }); } catch { /* ignore */ }
      }
    }
  }));

  runnerOffs.push(battleRunner.on('state', (bs) => {
    const st = replayStore.get();
    if (!st.active || st.stage !== 'battle' || st.activeBattleId !== battleObj.battleId) return;
    if (bs?.done && !st.battleDone) {
      replayStore.set({ battleDone: true });
      if (st.playing) {
        clearTimers();
        const waitMs = Math.max(650, Math.round(1450 / Math.max(0.5, st.speed)));
        battleAdvanceTimer = setTimeout(() => {
          battleAdvanceTimer = null;
          const cur = replayStore.get();
          if (cur.active && cur.playing && cur.stage === 'battle' && cur.activeBattleId === battleObj.battleId) {
            nextReplayStep({ fromAuto: true });
          }
        }, waitMs);
      }
    }
  }));
}

function syncMeForSeat(doc, seatIdx) {
  const seat = doc.seats[seatIdx] || doc.seats[0];
  if (!seat) return;
  const curMe = store.get().me;
  if (curMe.playerId !== seat.playerId || curMe.name !== seat.name) {
    store.set({ me: { ...curMe, playerId: seat.playerId, name: seat.name } });
  }
}

function applyPrepFrame(roundIdx, stepIdx, seatIdx) {
  clearTimers();
  detachRunnerListeners();
  const st = replayStore.get();
  const doc = st.doc;
  if (!doc) return;
  const rObj = doc.rounds[roundIdx];
  if (!rObj) return;
  const steps = rObj.steps || [];
  if (!steps.length) {
    // Round has no recorded prep steps — jump directly to its first battle if any.
    if (rObj.battles?.length) { applyBattleFrame(roundIdx, 0, seatIdx); return; }
    return;
  }
  const safeStep = Math.max(0, Math.min(steps.length - 1, stepIdx));
  const step = steps[safeStep];
  syncMeForSeat(doc, seatIdx);

  if (battleRunner) {
    try { battleRunner.setPaused(false); battleRunner.clear({ keepMetrics: true }); } catch { /* ignore */ }
  }

  const pub = patchPubForReplay(step.pub, { isCombat: false });
  const priv = deepClone(seatPrivFrom(step.privBySeat, seatIdx));

  replayStore.set({
    roundIdx,
    stage: 'prep',
    stepIdx: safeStep,
    battleIdx: 0,
    seatIdx,
    battleDone: false,
    battleGt: 0,
    activeBattleId: null,
  });

  store.patch('match', { public: pub, private: priv, field: null, result: null });
  if (replayStore.get().playing) schedulePrepAdvance();
}

function applyBattleFrame(roundIdx, battleIdx, seatIdx) {
  clearTimers();
  detachRunnerListeners();
  const st = replayStore.get();
  const doc = st.doc;
  if (!doc) return;
  const rObj = doc.rounds[roundIdx];
  if (!rObj) return;
  const list = battlesForSeat(rObj, seatIdx, doc.seats);
  if (!list.length) {
    if (roundIdx + 1 < doc.rounds.length) { applyPrepFrame(roundIdx + 1, 0, seatIdx); return; }
    applyResultFrame();
    return;
  }
  const safeBIdx = Math.max(0, Math.min(list.length - 1, battleIdx));
  const bObj = list[safeBIdx];
  syncMeForSeat(doc, seatIdx);

  const pub = patchPubForReplay(bObj.pub, { isCombat: true, battleObj: bObj });
  const priv = deepClone(seatPrivFrom(bObj.privBySeat, seatIdx));

  replayStore.set({
    roundIdx,
    stage: 'battle',
    battleIdx: safeBIdx,
    seatIdx,
    battleDone: false,
    battleGt: 0,
    activeBattleId: bObj.battleId,
  });

  store.patch('match', { public: pub, private: priv, field: null, result: null });

  if (battleRunner && bObj.bStart) {
    try {
      battleRunner.setPaused(false);
      battleRunner.clear({ keepMetrics: true });
      attachBattleListeners(bObj);
      const startMsg = {
        ...deepClone(bObj.bStart),
        t: 'b.start',
        authoritative: false,
        watch: false,
        elapsed: 0,
        speed: replayStore.get().speed,
      };
      const readyP = battleRunner.onStart(startMsg);
      if (!replayStore.get().playing) {
        Promise.resolve(readyP).then(() => {
          const cur = replayStore.get();
          if (cur.active && cur.stage === 'battle' && cur.activeBattleId === bObj.battleId && !cur.playing) {
            setTimeout(() => {
              const again = replayStore.get();
              if (again.active && again.stage === 'battle' && again.activeBattleId === bObj.battleId && !again.playing) {
                battleRunner.setPaused(true);
              }
            }, 80);
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[replay] failed to start native battle', err);
      toast(t('回放战斗启动失败'), 'error');
    }
  }
}

function applyResultFrame() {
  clearTimers();
  detachRunnerListeners();
  const st = replayStore.get();
  const doc = st.doc;
  if (!doc) return;
  if (battleRunner) {
    try { battleRunner.setPaused(false); battleRunner.clear({ keepMetrics: true }); } catch { /* ignore */ }
  }
  if (!doc.finalResult) {
    replayStore.set({ playing: false });
    toast(t('已播放至录像末尾'), 'info');
    return;
  }
  const lastRound = doc.rounds[doc.rounds.length - 1];
  const lastPub = lastRound?.battles?.[lastRound.battles.length - 1]?.pub
    || lastRound?.steps?.[lastRound.steps.length - 1]?.pub
    || {};
  const resultPub = {
    ...deepClone(lastPub),
    phase: PHASE.RESULT,
    paused: false,
  };
  replayStore.set({
    stage: 'result',
    playing: false,
    battleDone: true,
    activeBattleId: null,
  });
  store.patch('match', { public: resultPub, result: deepClone(doc.finalResult), field: null });
}

/** Step forward one prep action, enter battle, or advance to next round. */
export function nextReplayStep({ fromAuto = false } = {}) {
  const st = replayStore.get();
  if (!st.active || !st.doc) return;
  const doc = st.doc;
  const rObj = doc.rounds[st.roundIdx];
  if (!rObj) return;

  if (st.stage === 'prep') {
    if (st.stepIdx + 1 < rObj.steps.length) {
      applyPrepFrame(st.roundIdx, st.stepIdx + 1, st.seatIdx);
      return;
    }
    const list = battlesForSeat(rObj, st.seatIdx, doc.seats);
    if (list.length) {
      applyBattleFrame(st.roundIdx, 0, st.seatIdx);
      return;
    }
    if (st.roundIdx + 1 < doc.rounds.length) {
      applyPrepFrame(st.roundIdx + 1, 0, st.seatIdx);
      return;
    }
    applyResultFrame();
    return;
  }

  if (st.stage === 'battle') {
    const list = battlesForSeat(rObj, st.seatIdx, doc.seats);
    if (st.battleIdx + 1 < list.length) {
      applyBattleFrame(st.roundIdx, st.battleIdx + 1, st.seatIdx);
      return;
    }
    if (st.roundIdx + 1 < doc.rounds.length) {
      applyPrepFrame(st.roundIdx + 1, 0, st.seatIdx);
      return;
    }
    applyResultFrame();
    return;
  }

  if (st.stage === 'result' && !fromAuto) {
    applyPrepFrame(0, 0, st.seatIdx);
  }
}

/** Step backward one prep action or back to previous round's battle / prep. */
export function prevReplayStep() {
  const st = replayStore.get();
  if (!st.active || !st.doc) return;
  const doc = st.doc;
  const rObj = doc.rounds[st.roundIdx];
  if (!rObj) return;

  if (st.stage === 'result') {
    const lastIdx = doc.rounds.length - 1;
    const lastR = doc.rounds[lastIdx];
    const list = battlesForSeat(lastR, st.seatIdx, doc.seats);
    if (list.length) { applyBattleFrame(lastIdx, list.length - 1, st.seatIdx); return; }
    if (lastR?.steps?.length) { applyPrepFrame(lastIdx, lastR.steps.length - 1, st.seatIdx); return; }
    return;
  }

  if (st.stage === 'battle') {
    if (st.battleIdx > 0) {
      applyBattleFrame(st.roundIdx, st.battleIdx - 1, st.seatIdx);
      return;
    }
    if (rObj.steps.length) {
      applyPrepFrame(st.roundIdx, rObj.steps.length - 1, st.seatIdx);
      return;
    }
    if (st.roundIdx > 0) {
      const prevR = doc.rounds[st.roundIdx - 1];
      const list = battlesForSeat(prevR, st.seatIdx, doc.seats);
      if (list.length) { applyBattleFrame(st.roundIdx - 1, list.length - 1, st.seatIdx); return; }
      applyPrepFrame(st.roundIdx - 1, Math.max(0, prevR.steps.length - 1), st.seatIdx);
    }
    return;
  }

  // prep
  if (st.stepIdx > 0) {
    applyPrepFrame(st.roundIdx, st.stepIdx - 1, st.seatIdx);
    return;
  }
  if (st.roundIdx > 0) {
    const prevR = doc.rounds[st.roundIdx - 1];
    const list = battlesForSeat(prevR, st.seatIdx, doc.seats);
    if (list.length) { applyBattleFrame(st.roundIdx - 1, list.length - 1, st.seatIdx); return; }
    applyPrepFrame(st.roundIdx - 1, Math.max(0, prevR.steps.length - 1), st.seatIdx);
  }
}

/** Jump directly to a round's prep start or battle start. */
export function jumpReplayRound(roundIdx, target = 'prep') {
  const st = replayStore.get();
  if (!st.active || !st.doc) return;
  const safeR = Math.max(0, Math.min(st.doc.rounds.length - 1, roundIdx));
  if (target === 'battle') {
    applyBattleFrame(safeR, 0, st.seatIdx);
  } else {
    applyPrepFrame(safeR, 0, st.seatIdx);
  }
}

/** Skip current prep straight to this round's battle, or skip current battle to next round's prep. */
export function skipReplayPhase() {
  const st = replayStore.get();
  if (!st.active || !st.doc) return;
  const rObj = st.doc.rounds[st.roundIdx];
  if (!rObj) return;
  if (st.stage === 'prep') {
    const list = battlesForSeat(rObj, st.seatIdx, st.doc.seats);
    if (list.length) { applyBattleFrame(st.roundIdx, 0, st.seatIdx); return; }
    if (st.roundIdx + 1 < st.doc.rounds.length) { applyPrepFrame(st.roundIdx + 1, 0, st.seatIdx); return; }
    applyResultFrame();
    return;
  }
  if (st.stage === 'battle') {
    if (st.roundIdx + 1 < st.doc.rounds.length) {
      applyPrepFrame(st.roundIdx + 1, 0, st.seatIdx);
      return;
    }
    applyResultFrame();
  }
}

/** Toggle play / pause (smoothly pauses both prep auto-stepping and local battleRunner). */
export function toggleReplayPlaying(force) {
  const st = replayStore.get();
  if (!st.active) return;
  const next = typeof force === 'boolean' ? force : !st.playing;
  replayStore.set({ playing: next });
  if (st.stage === 'prep') {
    if (next) schedulePrepAdvance();
    else clearTimers();
  } else if (st.stage === 'battle') {
    if (battleRunner) battleRunner.setPaused(!next);
    if (!next) {
      clearTimers();
    } else if (st.battleDone) {
      nextReplayStep({ fromAuto: true });
    }
  }
}

/** Change playback speed (`0.5 | 1 | 2 | 4`) smoothly for both prep and battle. */
export function setReplaySpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return;
  replayStore.set({ speed: s });
  const st = replayStore.get();
  if (!st.active) return;
  if (st.stage === 'battle' && battleRunner) {
    battleRunner.setSpeed(s);
  } else if (st.stage === 'prep' && st.playing) {
    schedulePrepAdvance();
  }
}

/** Switch watched teammate perspective (seat 0..3) in coop replays. */
export function switchReplaySeat(nextSeatIdx) {
  const st = replayStore.get();
  if (!st.active || !st.doc) return;
  const doc = st.doc;
  const idx = Math.max(0, Math.min(doc.seats.length - 1, Number(nextSeatIdx) || 0));
  if (idx === st.seatIdx) return;

  if (st.stage === 'prep') {
    applyPrepFrame(st.roundIdx, st.stepIdx, idx);
    return;
  }
  if (st.stage === 'battle') {
    const rObj = doc.rounds[st.roundIdx];
    const curList = battlesForSeat(rObj, st.seatIdx, doc.seats);
    const curBattle = curList[st.battleIdx];
    const nextList = battlesForSeat(rObj, idx, doc.seats);
    if (!nextList.length) {
      replayStore.set({ seatIdx: idx });
      syncMeForSeat(doc, idx);
      return;
    }
    const sameKindIdx = curBattle ? nextList.findIndex((b) => b.kind === curBattle.kind) : 0;
    const targetBIdx = sameKindIdx >= 0 ? sameKindIdx : 0;
    const targetBattle = nextList[targetBIdx];
    if (curBattle && targetBattle.battleId === curBattle.battleId) {
      // Same shared field (e.g. boss pair or unite): swap first-person seat & private state without restarting battle.
      syncMeForSeat(doc, idx);
      replayStore.set({ seatIdx: idx, battleIdx: targetBIdx });
      const priv = deepClone(seatPrivFrom(targetBattle.privBySeat, idx));
      if (priv) store.patch('match', { private: priv });
      return;
    }
    applyBattleFrame(st.roundIdx, targetBIdx, idx);
    return;
  }
  replayStore.set({ seatIdx: idx });
  syncMeForSeat(doc, idx);
}

// ---- read-only network guard -------------------------------------------------------------------------

const SILENT_OK_TYPES = new Set([
  'room.contentReady', 'g.unitStats',
  'room.loadout', 'room.ownership', 'room.diy', 'room.skins', 'room.card',
  'state.resync',
]);

function installReplayNetGuard() {
  net.setReplayGuard((type, fields) => {
    if (SILENT_OK_TYPES.has(type)) return { t: 'ok' };
    if (type === 'g.leave' || type === 'room.leave') {
      exitReplay();
      return { t: 'ok' };
    }
    if (type === 'g.pause') {
      toggleReplayPlaying(!fields?.on);
      return { t: 'ok' };
    }
    if (type === 'g.watch') {
      const doc = replayStore.get().doc;
      if (doc && doc.seats.length > 1) {
        const pid = fields?.playerId || (typeof fields?.fieldId === 'string' && fields.fieldId.startsWith('n:') ? fields.fieldId.slice(2) : null);
        const found = pid ? doc.seats.findIndex((s) => s.playerId === pid) : -1;
        if (found >= 0) {
          switchReplaySeat(found);
          return { t: 'ok' };
        }
      }
      return { t: 'ok' };
    }
    toast(t('回放观战模式为只读，无法执行操作'), 'info', { ttl: 1800 });
    return { t: 'ok' };
  });
}

// ---- version data loading & match bootstrap ----------------------------------------------------------

async function resolveVanillaCs(fallbackCs) {
  const existing = store.get().content?.vanilla;
  if (typeof existing === 'string' && existing.length === 64) return existing;
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (res.ok) {
      const h = await res.json();
      if (typeof h?.content?.vanilla === 'string' && h.content.vanilla.length === 64) {
        return h.content.vanilla;
      }
    }
  } catch { /* ignore */ }
  return typeof fallbackCs === 'string' && fallbackCs.length === 64 ? fallbackCs : null;
}

function waitForVersionData(versionId, timeoutMs = 25000) {
  if (!versionId || versionId === DEFAULT_VERSION) return Promise.resolve();
  const isReady = (c) => c && c.kind === 'version' && c.version === versionId && (c.status === 'ready' || c.status === 'failed');
  if (isReady(contentSet.get())) {
    if (contentSet.get().status === 'failed') return Promise.reject(new Error(contentSet.get().error || 'version data failed'));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('version data timeout')); }, timeoutMs);
    const off = contentSet.subscribe((c) => {
      if (!isReady(c)) return;
      clearTimeout(timer);
      off();
      if (c.status === 'failed') reject(new Error(c.error || 'version data failed'));
      else resolve();
    });
  });
}

/** Fetch the published demo match index (`/dev/recordings/demo_ops/matches.json`). */
export async function fetchReplayMatches() {
  replayStore.set({ matchesLoading: true, matchesError: null });
  try {
    const res = await fetch(MATCHES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body?.matches) ? body.matches : [];
    replayStore.set({ matches: list, matchesLoading: false, matchesError: null });
    return list;
  } catch (err) {
    replayStore.set({ matchesLoading: false, matchesError: String(err?.message || err) });
    return [];
  }
}

/** Open the match selection modal. */
export function openReplayPicker() {
  replayStore.set({ pickerOpen: true });
  fetchReplayMatches();
}

/** Close the match selection modal. */
export function closeReplayPicker() {
  replayStore.set({ pickerOpen: false });
}

/** Load `<tag>_native.json` and start native full-process replay inside GameScreen. */
export async function startReplay(tag) {
  const cleanTag = String(tag || '').trim();
  if (!TAG_RE.test(cleanTag)) {
    toast(t('无效的回放标识'), 'warn');
    return false;
  }
  const myLoad = ++loadToken;
  clearTimers();
  detachRunnerListeners();

  // Save prior store snapshot on first entry (so exiting restores the user's lobby/title cleanly).
  if (!replayStore.get().active && !savedSessionSnap) {
    const s = store.get();
    savedSessionSnap = {
      entered: s.session.entered,
      me: { ...s.me },
      connection: { ...s.connection },
    };
  }

  store.patch('ui', { replayActive: true, pendingJoin: null, restoring: false });
  replayStore.set({
    pickerOpen: false,
    loading: true,
    loadingTag: cleanTag,
    error: null,
    loadNote: t('正在载入原生回放数据…'),
  });

  try {
    const url = `/dev/recordings/demo_ops/${encodeURIComponent(cleanTag)}_native.json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(res.status === 404 ? t('该对局暂无原生回放文件，等待补录') : `HTTP ${res.status}`);
    }
    const raw = await res.json();
    if (myLoad !== loadToken) return false;
    const doc = hydrateNativeReplay(raw);

    const vanillaCs = await resolveVanillaCs(doc.vanillaCs);
    if (myLoad !== loadToken) return false;

    const versionId = doc.gameVersion || doc.room?.version || 'act3autochess@V3_1';
    const serverVerEntry = Array.isArray(store.get().versions)
      ? store.get().versions.find((v) => v && v.id === versionId)
      : null;
    const versionCs = serverVerEntry?.cs || doc.contentCs || doc.room?.content?.cs || null;

    // Align every recorded battle spec's content hash with the version set this server currently serves.
    if (versionCs) {
      for (const r of doc.rounds) {
        for (const b of r.battles) {
          if (b.bStart?.spec) b.bStart.spec.cs = versionCs;
        }
      }
    }

    const seat0 = doc.seats[0];
    const room = {
      ...(doc.room ? deepClone(doc.room) : {}),
      code: doc.room?.code || 'REPLAY',
      mode: doc.mode || doc.room?.mode || 'solo',
      difficulty: doc.room?.difficulty || (doc.mode === 'coop' ? 'ABYSS' : 'ABYSS'),
      modeId: doc.modeId || doc.room?.modeId || (doc.mode === 'coop' ? 'mode_multi_abyss' : 'mode_single_20'),
      inMatch: true,
      test: false,
      version: versionId,
      content: {
        ...(doc.room?.content || {}),
        vanilla: true,
        version: versionId,
        ...(versionCs ? { cs: versionCs } : {}),
      },
      seats: Array.isArray(doc.room?.seats) && doc.room.seats.length
        ? deepClone(doc.room.seats)
        : doc.seats.map((s) => ({ playerId: s.playerId, name: s.name, ready: true, content: 'ready' })),
    };

    installReplayNetGuard();
    closeAllDialogs();

    const curStore = store.get();
    store.set({
      ...(vanillaCs ? { content: { vanilla: vanillaCs } } : {}),
      me: { playerId: seat0.playerId, name: seat0.name, token: curStore.me.token },
      session: { entered: true },
      room,
      match: emptyMatch(),
      ticker: [],
      emotes: [],
      ui: { ...curStore.ui, replayActive: true, pendingJoin: null, restoring: false },
    });

    replayStore.set({
      active: true,
      doc,
      seatIdx: 0,
      roundIdx: 0,
      stepIdx: 0,
      battleIdx: 0,
      stage: 'prep',
      playing: true,
      battleDone: false,
      battleGt: 0,
      activeBattleId: null,
      loadNote: t('正在校验并载入版本资源…'),
    });
    setUrlReplayParam(cleanTag);

    await Promise.all([
      waitForVersionData(versionId),
      data.loadAll(GAME_FILES),
    ]);
    if (myLoad !== loadToken) return false;

    replayStore.set({ loading: false, loadingTag: null, error: null, loadNote: '' });
    if (!replayStore.get().matches.length) fetchReplayMatches();
    applyPrepFrame(0, 0, 0);
    return true;
  } catch (err) {
    if (myLoad !== loadToken) return false;
    const msg = String(err?.message || err);
    console.warn('[replay] failed to start replay', err);
    replayStore.set({ loading: false, loadingTag: null, error: msg, loadNote: '' });
    if (!replayStore.get().active) {
      store.patch('ui', { replayActive: false });
      toast(t('无法载入回放：{error}', { error: msg }), 'error');
      openReplayPicker();
    } else {
      toast(t('无法载入回放：{error}', { error: msg }), 'error');
    }
    return false;
  }
}

/** Exit native replay cleanly and return to Title / Lobby. */
export function exitReplay() {
  loadToken++;
  clearTimers();
  detachRunnerListeners();
  net.setReplayGuard(null);
  if (battleRunner) {
    try { battleRunner.setPaused(false); battleRunner.clear(); } catch { /* ignore */ }
  }
  closeAllDialogs();
  setUrlReplayParam(null);

  const prev = savedSessionSnap;
  savedSessionSnap = null;

  replayStore.set({
    active: false,
    loading: false,
    loadingTag: null,
    error: null,
    doc: null,
    roundIdx: 0,
    stage: 'prep',
    stepIdx: 0,
    battleIdx: 0,
    seatIdx: 0,
    playing: true,
    battleDone: false,
    battleGt: 0,
    activeBattleId: null,
    loadNote: '',
  });

  const cur = store.get();
  const nextMe = prev?.me ? { ...prev.me } : cur.me;
  const nextEntered = prev ? !!prev.entered : cur.session.entered;
  store.set({
    room: null,
    match: emptyMatch(),
    ticker: [],
    emotes: [],
    me: nextMe,
    session: { entered: nextEntered },
    connection: {
      status: net.status,
      ping: net.ping,
      attempt: net.attempt,
      retryAt: net.retryAt,
      lastError: net.lastError,
      everOnline: !!(prev?.connection?.everOnline || cur.connection?.everOnline || net.status === 'online'),
    },
    ui: { ...cur.ui, replayActive: false },
  });

  if (net.status === 'idle') {
    if (nextEntered && nextMe.name) net.setName(nextMe.name);
    else net.connect();
  }
}

/** Boot helper invoked from `main.js` when `?replay=` is in the URL. */
export function initReplayFromUrl(parsed) {
  if (!parsed) return;
  if (parsed.mode === 'play' && parsed.tag) {
    startReplay(parsed.tag);
  } else {
    openReplayPicker();
  }
}

// ---- UI components -----------------------------------------------------------------------------------

/** Compact entry button rendered on TitleScreen and LobbyScreen. */
export function ReplayEntryButton({ class: cls = '', size = 'sm', variant = 'secondary' }) {
  return html`<${Button} variant=${variant} size=${size} icon="play" class=${`replay-entry ${cls}`.trim()}
    onClick=${openReplayPicker} title=${t('在游戏本体内原生回放整备与战斗全过程')}>
    ${t('运营回放')}
  <//>`;
}

/** Match picker modal grouped by core faction & mode. */
function ReplayPickerModal() {
  const open = useStore((s) => s.pickerOpen, Object.is, replayStore);
  const matches = useStore((s) => s.matches, Object.is, replayStore);
  const loading = useStore((s) => s.matchesLoading, Object.is, replayStore);
  const err = useStore((s) => s.matchesError, Object.is, replayStore);
  const currentTag = useStore((s) => s.doc?.tag || null, Object.is, replayStore);
  const [coreFilter, setCoreFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');
  const [featuredOnly, setFeaturedOnly] = useState(false);

  if (!open) return null;

  let maxSoloLayers = 0;
  let maxCoopLayers = 0;
  for (const m of matches) {
    if (!m.hiddenCleared) continue;
    const pk = matchPeakLayers(m);
    if (m.mode === 'coop') maxCoopLayers = Math.max(maxCoopLayers, pk);
    else maxSoloLayers = Math.max(maxSoloLayers, pk);
  }

  const enriched = matches.map((m) => ({ m, hl: evaluateMatchHighlight(m, maxSoloLayers, maxCoopLayers) }));
  const featuredCount = enriched.filter((x) => x.hl.tier !== 'normal').length;

  const filtered = enriched
    .filter(({ m, hl }) => (coreFilter === 'all' || m.coreId === coreFilter)
      && (modeFilter === 'all' || m.mode === modeFilter)
      && (!featuredOnly || hl.tier !== 'normal'))
    .sort((a, b) => b.hl.score - a.hl.score);

  const presentCores = new Set(matches.map((m) => m.coreId).filter(Boolean));
  const coreTabs = [
    { id: 'all', label: t('全部盟约') },
    ...Object.entries(CORE_META)
      .filter(([id]) => presentCores.has(id) || id === 'kjeragShip' || id === 'lethaniaShip' || id === 'ursusShip')
      .map(([id, meta]) => ({ id, label: t(meta.label) })),
  ];
  const modeTabs = [
    { id: 'all', label: t('全部模式') },
    { id: 'solo', label: t('单人规程20级') },
    { id: 'coop', label: t('4人终极模拟') },
  ];

  return html`<${Modal} open=${open} onClose=${closeReplayPicker} title=${t('运营全过程回放')} micro="NATIVE PROTOCOL REPLAY" width="11.2rem" class="rpick-modal">
    <div class="rpick">
      <div class="rpick__filters">
        <div class="rpick__group">
          ${coreTabs.map((tab) => html`<button key=${tab.id} type="button"
            class=${`rpick__tab${coreFilter === tab.id ? ' is-on' : ''}`}
            onClick=${() => setCoreFilter(tab.id)}>${tab.label}</button>`)}
        </div>
        <div class="rpick__group">
          ${modeTabs.map((tab) => html`<button key=${tab.id} type="button"
            class=${`rpick__tab${modeFilter === tab.id ? ' is-on' : ''}`}
            onClick=${() => setModeFilter(tab.id)}>${tab.label}</button>`)}
          ${featuredCount > 0 ? html`<button type="button"
            class=${`rpick__tab rpick__tab--gold${featuredOnly ? ' is-on' : ''}`}
            onClick=${() => setFeaturedOnly((v) => !v)}>★ ${t('仅看精选')} (${featuredCount})</button>` : null}
        </div>
        <${Button} variant="ghost" size="sm" icon="refresh" onClick=${fetchReplayMatches} loading=${loading}>${t('刷新')}<//>
      </div>

      ${loading && !matches.length ? html`<div class="rpick__empty"><${Spinner} size="md" label="LOADING" /><span>${t('正在获取已发布回放列表…')}</span></div>` : null}
      ${err ? html`<div class="rpick__empty rpick__empty--err"><${Icon} name="warn" /><span>${t('回放列表载入失败：{error}', { error: err })}</span></div>` : null}
      ${!loading && !err && !filtered.length ? html`<div class="rpick__empty"><${Icon} name="info" /><span>${t('当前筛选条件下暂无已发布对局')}</span></div>` : null}

      <div class="rpick__grid">
        ${filtered.map(({ m, hl }) => {
          const core = CORE_META[m.coreId] || { label: m.coreName || m.coreId, tone: 'default' };
          const isCur = currentTag && currentTag === m.tag;
          const nativeOk = m.hasNativeReplay === true;
          const hlCls = hl.tier === 'legend' ? ' is-legend' : hl.tier === 'featured' ? ' is-featured' : '';
          const showPeak = hl.peak > 0;
          const showDps = hl.r15Dps > 0;
          return html`<article key=${m.tag} class=${`rpick__card brackets rpick__card--${core.tone}${hlCls}${isCur ? ' is-current' : ''}${nativeOk ? '' : ' is-legacy'}`}>
            <div class="rpick__card-top">
              ${hl.tier === 'legend'
                ? html`<span class="rpick__badge rpick__badge--legend">★ ${hl.isRecord ? t('历史纪录') : t('巅峰神局')}</span>`
                : hl.tier === 'featured'
                  ? html`<span class="rpick__badge rpick__badge--featured">★ ${t('精选佳局')}</span>`
                  : null}
              <span class=${`rpick__badge rpick__badge--${core.tone}`}>${CORE_META[m.coreId] ? t(core.label) : core.label}</span>
              <span class=${`rpick__badge rpick__badge--${m.mode === 'coop' ? 'coop' : 'solo'}`}>${m.mode === 'coop' ? t('4人终极模拟') : t('单人规程20级')}</span>
              ${m.hiddenCleared ? html`<span class="rpick__badge rpick__badge--gold">${t('隐秘斩杀')}</span>` : null}
              ${nativeOk
                ? html`<span class="rpick__badge rpick__badge--mint">${t('原生全过程')}</span>`
                : html`<span class="rpick__badge rpick__badge--dim">${t('待原生补录')}</span>`}
            </div>
            <h3 class="rpick__title">${m.title || m.tag}</h3>
            <div class="rpick__stats">
              <div><span>${showPeak ? t('峰值层数') : t('R14层数')}</span><b class=${`num${hl.tier !== 'normal' ? ' rpick__stat-hi' : ''}`}>${showPeak ? hl.peak : (m.r14ActivatedLayers ?? '-')}</b></div>
              ${showDps
                ? html`<div><span>${t('隐秘DPS')}</span><b class=${`num${hl.tier === 'legend' ? ' rpick__stat-hi' : ''}`}>${Math.round(hl.r15Dps).toLocaleString()}${m.r15RealSec ? ` · ${m.r15RealSec}s` : ''}</b></div>`
                : html`<div><span>${t('残余血量')}</span><b class="num">${m.lpRemaining ?? '-'}</b></div>`}
              <div><span>${t('常规领袖')}</span><b>${m.bossName || '-'}</b></div>
              <div><span>${t('隐秘核心')}</span><b>${m.hiddenBossName || '-'}</b></div>
            </div>
            <div class="rpick__foot">
              <span class="rpick__meta num">${m.roundsCount || 15}R · ${m.prepStepsTotal || 0} ${t('步')}${showDps ? ` · LP ${m.lpRemaining ?? '-'}` : ''}</span>
              ${nativeOk
                ? html`<${Button} variant=${isCur ? 'secondary' : 'primary'} size="sm" icon="play"
                    onClick=${() => startReplay(m.tag)}>${isCur ? t('重新播放') : t('原生播放')}<//>`
                : html`<a class="btn btn--secondary btn--sm rpick__legacy-link" href=${`/dev/recordings/demo_ops/replay.html?match=${encodeURIComponent(m.tag)}`} target="_blank" rel="noopener noreferrer">
                    <span class="btn__label">${t('旧版战报')}</span>
                  </a>`}
            </div>
          </article>`;
        })}
      </div>
    </div>
  <//>`;
}

/** Top-center tactical step & strategy commentary callout (pointer-events: none). */
function ReplayCallout() {
  const active = useStore((s) => s.active, Object.is, replayStore);
  const doc = useStore((s) => s.doc, Object.is, replayStore);
  const roundIdx = useStore((s) => s.roundIdx, Object.is, replayStore);
  const stage = useStore((s) => s.stage, Object.is, replayStore);
  const stepIdx = useStore((s) => s.stepIdx, Object.is, replayStore);
  const battleIdx = useStore((s) => s.battleIdx, Object.is, replayStore);
  const seatIdx = useStore((s) => s.seatIdx, Object.is, replayStore);
  const battleGt = useStore((s) => s.battleGt, Object.is, replayStore);
  const battleDone = useStore((s) => s.battleDone, Object.is, replayStore);

  if (!active || !doc) return null;
  const rObj = doc.rounds[roundIdx];
  if (!rObj) return null;

  let badge;
  let headline;
  let note = '';

  if (stage === 'prep') {
    const step = rObj.steps?.[stepIdx];
    if (!step) return null;
    const actKey = ACTION_BADGE[step.action];
    const seatTag = doc.seats.length > 1 ? `S${step.seatIdx} · ` : '';
    badge = `${seatTag}${actKey ? t(actKey) : step.action}`;
    headline = step.label || step.result || '';
    note = step.note || '';
  } else if (stage === 'battle') {
    const list = battlesForSeat(rObj, seatIdx, doc.seats);
    const bObj = list[battleIdx];
    const kLbl = KIND_LABEL[bObj?.kind] ? t(KIND_LABEL[bObj.kind]) : t('实战模拟');
    badge = `R${String(rObj.round).padStart(2, '0')} · ${kLbl}`;
    if (battleDone && bObj?.resultSummary) {
      const rs = bObj.resultSummary;
      headline = rs.bossName
        ? `${rs.bossName} · ${rs.killedBoss ? t('斩杀成功') : t('战斗结束')} (${Number(rs.bossDmg || 0).toLocaleString()})`
        : (rs.leaks === 0 ? t('完美作战 · 0 漏怪') : t('战斗结束 · 漏怪 {n}', { n: rs.leaks }));
    } else {
      headline = t('原生实机战斗演算中 · {sec}s', { sec: battleGt.toFixed(1) });
    }
    note = rObj.summary?.highlights?.[0] || '';
  } else {
    badge = t('终局结算');
    headline = doc.title || doc.tag;
  }

  if (!headline && !note) return null;

  return html`<div class="rcallout" role="status" aria-live="polite">
    <div class="rcallout__main">
      <span class=${`rcallout__badge rcallout__badge--${stage}`}>${badge}</span>
      <span class="rcallout__text">${headline}</span>
    </div>
    ${note ? html`<div class="rcallout__note">${note}</div>` : null}
  </div>`;
}

/** Compact, collapsible, draggable floating replay dock styled to match Stronghold Protocol HUD. */
function ReplayDock() {
  const active = useStore((s) => s.active, Object.is, replayStore);
  const loading = useStore((s) => s.loading, Object.is, replayStore);
  const loadNote = useStore((s) => s.loadNote, Object.is, replayStore);
  const doc = useStore((s) => s.doc, Object.is, replayStore);
  const roundIdx = useStore((s) => s.roundIdx, Object.is, replayStore);
  const stage = useStore((s) => s.stage, Object.is, replayStore);
  const stepIdx = useStore((s) => s.stepIdx, Object.is, replayStore);
  const battleIdx = useStore((s) => s.battleIdx, Object.is, replayStore);
  const seatIdx = useStore((s) => s.seatIdx, Object.is, replayStore);
  const playing = useStore((s) => s.playing, Object.is, replayStore);
  const speed = useStore((s) => s.speed, Object.is, replayStore);
  const collapsed = useStore((s) => s.collapsed, Object.is, replayStore);

  const dockRef = useRef(null);
  const [pos, setPos] = useState(null); // { left, top } in px after user drags
  const dragRef = useRef(null);

  // Replay keyboard shortcuts: Space play/pause, Left/Right step.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (ev) => {
      if (ev.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
      if (replayStore.get().pickerOpen) return;
      if (ev.key === ' ') {
        ev.preventDefault();
        toggleReplayPlaying();
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        nextReplayStep();
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        prevReplayStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  if (!active || !doc) return null;

  const rObj = doc.rounds[roundIdx] || doc.rounds[0];
  const rNum = rObj?.round ?? 1;
  const totalRounds = doc.rounds.length;
  const totalSteps = rObj?.steps?.length || 0;
  const seatBattles = battlesForSeat(rObj, seatIdx, doc.seats);
  const curBattle = stage === 'battle' ? seatBattles[battleIdx] : null;

  const onDragStart = (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (ev.target?.closest?.('button')) return;
    const el = dockRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, w: rect.width, h: rect.height };
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  };
  const onDragMove = (ev) => {
    const d = dragRef.current;
    if (!d) return;
    const maxL = Math.max(8, window.innerWidth - d.w - 8);
    const maxT = Math.max(8, window.innerHeight - d.h - 8);
    const left = Math.max(8, Math.min(maxL, ev.clientX - d.dx));
    const top = Math.max(8, Math.min(maxT, ev.clientY - d.dy));
    setPos({ left, top });
  };
  const onDragEnd = () => { dragRef.current = null; };

  const styleObj = pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: 'auto' } : null;

  const phaseText = stage === 'prep'
    ? t('整备 {cur}/{total}', { cur: Math.min(totalSteps, stepIdx + 1), total: Math.max(1, totalSteps) })
    : stage === 'battle'
      ? (KIND_LABEL[curBattle?.kind] ? t(KIND_LABEL[curBattle.kind]) : t('战斗中'))
      : t('终局结算');

  if (collapsed) {
    return html`<aside ref=${dockRef} class="rdock rdock--mini brackets" style=${styleObj}
      onPointerDown=${onDragStart} onPointerMove=${onDragMove} onPointerUp=${onDragEnd} onPointerCancel=${onDragEnd}>
      <button type="button" class="rdock__mbtn rdock__mbtn--play" onClick=${() => toggleReplayPlaying()}
        title=${playing ? t('暂停') : t('播放')}>${playing ? '❚❚' : '▶'}</button>
      <span class="rdock__mstatus num">R${String(rNum).padStart(2, '0')} · ${phaseText}</span>
      <button type="button" class="rdock__mbtn" onClick=${() => nextReplayStep()} title=${t('下一步')}>⏭</button>
      <button type="button" class="rdock__mbtn" onClick=${() => replayStore.set({ collapsed: false })} title=${t('展开回放控制条')}>
        <${Icon} name="expand" />
      </button>
    </aside>`;
  }

  return html`<aside ref=${dockRef} class="rdock brackets" style=${styleObj} aria-label=${t('原生回放控制台')}>
    <header class="rdock__head" onPointerDown=${onDragStart} onPointerMove=${onDragMove} onPointerUp=${onDragEnd} onPointerCancel=${onDragEnd}>
      <div class="rdock__brand">
        <span class="rdock__dot"></span>
        <span class="rdock__title">${t('原生回放')}</span>
        <${MicroLabel} tone="mint">R${String(rNum).padStart(2, '0')}/${String(totalRounds).padStart(2, '0')}<//>
      </div>
      <div class="rdock__head-btns">
        <button type="button" class="rdock__ibtn" onClick=${openReplayPicker} title=${t('切换对局')}>${t('切局')}</button>
        <button type="button" class="rdock__ibtn" onClick=${() => replayStore.set({ collapsed: true })} title=${t('收起控制条')}>
          <${Icon} name="collapse" />
        </button>
        <button type="button" class="rdock__ibtn rdock__ibtn--exit" onClick=${exitReplay} title=${t('退出回放')}>
          <${Icon} name="close" />
        </button>
      </div>
    </header>

    ${loading ? html`<div class="rdock__loading"><${Spinner} size="sm" /><span>${loadNote || t('载入中…')}</span></div>` : null}

    <div class="rdock__sub">
      <span class=${`rdock__pill rdock__pill--${stage}`}>${phaseText}</span>
      <span class="rdock__match-name" title=${doc.title || doc.tag}>${doc.coreName || doc.coreId} · ${doc.mode === 'coop' ? t('4人') : t('单人')}</span>
    </div>

    <div class="rdock__controls">
      <button type="button" class="rdock__cbtn" onClick=${prevReplayStep} title=${t('上一步')}>⏮</button>
      <button type="button" class=${`rdock__cbtn rdock__cbtn--main${playing ? ' is-playing' : ''}`}
        onClick=${() => toggleReplayPlaying()} title=${playing ? t('暂停') : t('播放')}>
        ${playing ? `❚❚ ${t('暂停')}` : `▶ ${t('播放')}`}
      </button>
      <button type="button" class="rdock__cbtn" onClick=${() => nextReplayStep()} title=${t('下一步')}>⏭</button>
      <button type="button" class="rdock__cbtn rdock__cbtn--skip" onClick=${skipReplayPhase}
        title=${stage === 'prep' ? t('跳过整备直达本回合战斗') : t('跳过战斗进入下回合')}>
        ${stage === 'prep' ? t('进战斗') : t('下回合')}
      </button>
    </div>

    <div class="rdock__speeds">
      <span class="rdock__lbl">${t('倍速')}</span>
      ${REPLAY_SPEEDS.map((sp) => html`<button key=${sp} type="button"
        class=${`rdock__sbtn num${speed === sp ? ' is-on' : ''}`}
        onClick=${() => setReplaySpeed(sp)}>${sp}×</button>`)}
    </div>

    ${doc.seats.length > 1 ? html`<div class="rdock__seats">
      <span class="rdock__lbl">${t('视角')}</span>
      <div class="rdock__seat-list">
        ${doc.seats.map((seat) => html`<button key=${seat.seatIdx} type="button"
          class=${`rdock__seat${seatIdx === seat.seatIdx ? ' is-on' : ''}`}
          onClick=${() => switchReplaySeat(seat.seatIdx)}
          title=${`${seat.name} (${seat.bandName || ''})`}>
          <span class="num">S${seat.seatIdx}</span>
          <span>${seat.bandName || seat.name}</span>
        </button>`)}
      </div>
    </div>` : null}

    <div class="rdock__rounds">
      <div class="rdock__rounds-head">
        <span class="rdock__lbl">${t('回合速跳')}</span>
        ${rObj?.battles?.length ? html`<button type="button" class="rdock__jump-battle"
          onClick=${() => jumpReplayRound(roundIdx, stage === 'battle' ? 'prep' : 'battle')}>
          ${stage === 'battle' ? t('回本轮整备') : t('看本轮战斗')}
        </button>` : null}
      </div>
      <div class="rdock__rgrid">
        ${doc.rounds.map((r, i) => {
          const isCur = i === roundIdx;
          const hasBoss = r.battles?.some((b) => b.kind === 'boss');
          const hasHidden = r.battles?.some((b) => b.kind === 'hidden');
          const cls = `rdock__rchip num${isCur ? ' is-cur' : ''}${hasHidden ? ' is-hidden' : hasBoss ? ' is-boss' : ''}`;
          return html`<button key=${r.round} type="button" class=${cls}
            onClick=${() => jumpReplayRound(i, 'prep')}
            title=${`R${String(r.round).padStart(2, '0')} · ${r.steps.length} ${t('步')}${r.summary?.battleSummary ? ` · ${r.summary.battleSummary}` : ''}`}>
            ${String(r.round).padStart(2, '0')}
          </button>`;
        })}
      </div>
    </div>
  </aside>`;
}

/** Global replay host mounted once inside App(). */
export function ReplayHost() {
  return html`
    <${ReplayCallout} />
    <${ReplayDock} />
    <${ReplayPickerModal} />
  `;
}

if (typeof window !== 'undefined') {
  globalThis.__SP_REPLAY__ = {
    store: replayStore,
    startReplay,
    exitReplay,
    openReplayPicker,
    nextReplayStep,
    prevReplayStep,
    jumpReplayRound,
    skipReplayPhase,
    toggleReplayPlaying,
    setReplaySpeed,
    switchReplaySeat,
  };
}
