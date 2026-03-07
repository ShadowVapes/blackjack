/* exact_solver_worker.js
   EV-based recommendation using remaining shoe composition (rank counts).

   Goal: Provide the highest-EV action for the CURRENT decision point.

   Notes / assumptions (kept explicit):
   - Dealer hole card is unknown; only dealer upcard is used for decision.
   - Uses the remaining shoe composition derived from (decks - seen - player hand - dealer upcard).
   - Computes EV by recursion over possible draws (no Monte Carlo).
   - SPLIT EV uses a shoe-aware "with-replacement" approximation for follow-up hands to keep it fast.
     (Deck coupling between split hands is extremely expensive to model exactly in-browser.)

   Output EV is in units of the original bet (bet=1). Split EV sums both hands (so it can be >1).
*/

const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"]; // 13 ranks
const TEN_RANKS = new Set(["10","J","Q","K"]);

function cardValue(rank){
  if(rank === "A") return 11;
  if(TEN_RANKS.has(rank)) return 10;
  return parseInt(rank, 10);
}

function addTo(total, softAces, rank){
  total += cardValue(rank);
  if(rank === "A") softAces += 1;
  while(total > 21 && softAces > 0){ total -= 10; softAces -= 1; }
  return [total, softAces];
}

function isBlackjack2(r1, r2){
  if(!r1 || !r2) return false;
  const a = (r1 === "A") || (r2 === "A");
  const t = TEN_RANKS.has(r1) || TEN_RANKS.has(r2);
  return a && t;
}

function countsKey(c){ return c.join(","); }

function totalCards(c){
  let s=0; for(let i=0;i<c.length;i++) s += c[i];
  return s;
}

function probListFromCounts(c){
  const tot = totalCards(c);
  const out = [];
  if(tot <= 0) return { tot: 0, out };
  for(let i=0;i<RANKS.length;i++){
    const n = c[i];
    if(n>0) out.push([i, n / tot]);
  }
  return { tot, out };
}

function decCount(c, idx){
  const n = c[idx];
  if(n<=0) return null;
  const copy = c.slice();
  copy[idx] = n - 1;
  return copy;
}


function parseDoubleCustomSet(str){
  const s = String(str||"").trim();
  const set = new Set();
  if(!s) return set;
  // allow "9-11" ranges and "9,10,11" lists (spaces ok)
  const parts = s.split(/\s*,\s*/).filter(Boolean);
  for(const part of parts){
    const m = part.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if(m){
      let a = parseInt(m[1],10), b = parseInt(m[2],10);
      if(Number.isFinite(a) && Number.isFinite(b)){
        if(a>b){ const t=a; a=b; b=t; }
        for(let x=a;x<=b;x++) set.add(x);
      }
      continue;
    }
    const n = parseInt(part,10);
    if(Number.isFinite(n)) set.add(n);
  }
  return set;
}

// In "custom" mode, we treat an empty set as ANY (fallback).
function canDoubleOnTotal(total, rules){
  const mode = rules.doubleRule || "any";
  if(mode === "any") return true;
  if(mode === "9-11") return total>=9 && total<=11;
  if(mode === "10-11") return total>=10 && total<=11;
  if(mode === "custom"){
    const set = parseDoubleCustomSet(rules.doubleCustom || rules.doubleCustomStr || "");
    if(!set || set.size===0) return true;
    return set.has(total);
  }
  return true;
}

function dealerShouldHit(total, softAces, rules){
  if(total < 17) return true;
  if(total > 17) return false;
  // total == 17
  if(rules.dealer17 === "H17" && softAces > 0) return true;
  return false;
}

// Memoization maps
const memoDealer = new Map(); // key -> Map(total->prob) with 0 as bust
const memoBest   = new Map(); // key -> {best, evs, nodes, exact:false/true}

let NODE_LIMIT = 120000; // can be increased by UI
let nodeCount = 0;

function bumpNode(){
  nodeCount += 1;
  if(nodeCount > NODE_LIMIT) throw new Error("NODE_LIMIT");
}

function dealerDistExact(counts, total, softAces, rules){
  bumpNode();
  if(total > 21){
    const m = new Map(); m.set(0, 1); return m;
  }
  if(!dealerShouldHit(total, softAces, rules)){
    const m = new Map(); m.set(total, 1); return m;
  }
  const k = "D|"+countsKey(counts)+"|"+total+"|"+softAces+"|"+rules.dealer17;
  const cached = memoDealer.get(k);
  if(cached) return cached;

  const { out } = probListFromCounts(counts);
  const acc = new Map();
  for(const [i,p] of out){
    const c2 = decCount(counts, i);
    if(!c2) continue;
    const r = RANKS[i];
    const [nt, ns] = addTo(total, softAces, r);
    const sub = dealerDistExact(c2, nt, ns, rules);
    for(const [t2, pr] of sub.entries()){
      acc.set(t2, (acc.get(t2)||0) + p*pr);
    }
  }
  memoDealer.set(k, acc);
  return acc;
}

function standEVExact(counts, pTotal, pIsNaturalBJ, dealerUpRank, rules, pBJEligible){
  bumpNode();
  const upIdx = RANKS.indexOf(dealerUpRank);
  if(upIdx < 0) return -1;

  const tot = totalCards(counts);
  if(tot <= 0) return -1;

  // If dealer PEeks under A/10 and we are already making decisions (i.e. after peek),
  // then dealer blackjack is ruled out and we condition on "no dealer BJ".
  const isUpAce = (dealerUpRank === "A");
  const isUpTen = TEN_RANKS.has(dealerUpRank);
  const postPeek = !!rules.peek && (rules.surrender !== "early"); // early surrender is pre-peek
  const conditionNoBJ = postPeek && (isUpAce || isUpTen) && !pIsNaturalBJ;

  let denom = tot;
  if(conditionNoBJ){
    let bjCount = 0;
    if(isUpAce){
      // BJ if hole is any ten-value
      for(let i=0;i<RANKS.length;i++){
        if(counts[i] > 0 && TEN_RANKS.has(RANKS[i])) bjCount += counts[i];
      }
    } else if(isUpTen){
      // BJ if hole is Ace
      const aIdx = RANKS.indexOf("A");
      bjCount = aIdx>=0 ? (counts[aIdx]||0) : 0;
    }
    denom = tot - bjCount;
    if(denom <= 0){
      // dealer always has blackjack in this configuration; if we are here (postPeek), the round wouldn't exist.
      // return worst-case EV for non-BJ hand.
      return -1;
    }
  }

  let ev = 0;
  // iterate over hole card
  for(let i=0;i<RANKS.length;i++){
    const n = counts[i];
    if(n<=0) continue;
    const pHole = n / denom;
    const c2 = decCount(counts, i);
    if(!c2) continue;
    const hole = RANKS[i];

    // dealer initial totals
    let dTotal = 0, dSoft = 0;
    [dTotal, dSoft] = addTo(dTotal, dSoft, dealerUpRank);
    [dTotal, dSoft] = addTo(dTotal, dSoft, hole);

    const dealerBJ = isBlackjack2(dealerUpRank, hole);

    if(conditionNoBJ && dealerBJ){
      // ruled out by peek
      continue;
    }

    if(pBJEligible && pIsNaturalBJ){
      // player has blackjack
      if(dealerBJ){
        ev += pHole * 0; // push
      } else {
        ev += pHole * (rules.bjPay === "6:5" ? 1.2 : 1.5);
      }
      continue;
    }

    // dealer blackjack just means total 21 and stands
    let dist;
    if(dealerBJ){
      dist = new Map([[21,1]]);
    } else {
      dist = dealerDistExact(c2, dTotal, dSoft, rules);
    }

    // compare
    if(pTotal > 21){
      ev += pHole * (-1);
      continue;
    }

    let local = 0;
    for(const [dt, pr] of dist.entries()){
      if(dt === 0){ local += pr * 1; continue; } // dealer bust
      if(pTotal > dt) local += pr * 1;
      else if(pTotal < dt) local += pr * (-1);
      else local += pr * 0;
    }
    ev += pHole * local;
  }
  return ev;
}

function bestEVExact(counts, pTotal, pSoftAces, cardsCount, r1, r2, fromSplit, dealerUpRank, rules, handsUsed){
  bumpNode();

  // key
  const k = "B|"+countsKey(counts)+"|"+pTotal+"|"+pSoftAces+"|"+cardsCount+"|"+(r1||"")+"|"+(r2||"")+"|"+(fromSplit?1:0)+"|"+dealerUpRank+"|"+rules.dealer17+"|"+rules.surrender+"|"+rules.doubleRule+"|"+(rules.doubleCustom||"")+"|"+(rules.DAS?1:0)+"|"+rules.maxHands+"|"+rules.splitA+"|"+(rules.resplitA?1:0)+"|"+(rules.peek?1:0)+"|"+handsUsed;
  const cached = memoBest.get(k);
  if(cached) return cached;

  const evs = {};
  const actions = [];

  // determine availability
  const canSurrender = ((rules.surrender === "late") || (rules.surrender === "early")) && !fromSplit && cardsCount === 2;
  const canDouble = (cardsCount === 2) && (fromSplit ? !!rules.DAS : true) && canDoubleOnTotal(pTotal, rules);
  let canSplit = (cardsCount === 2) && (r1 && r2 && r1 === r2) && (handsUsed < rules.maxHands);
  if(canSplit && r1 === "A" && fromSplit && rules.resplitA === false){ canSplit = false; }

  const pIsNaturalBJ = (cardsCount === 2) && !fromSplit && isBlackjack2(r1, r2);
  const pBJEligible = (cardsCount === 2) && !fromSplit;

  // If player already has natural BJ, best is stand (no hit/double).
  if(pIsNaturalBJ){
    evs.STAND = standEVExact(counts, pTotal, true, dealerUpRank, rules, pBJEligible);
    const out = { best: "STAND", evs, exact: true, nodes: nodeCount, note: "natural BJ" };
    memoBest.set(k, out);
    return out;
  }

  // STAND always available
  evs.STAND = standEVExact(counts, pTotal, false, dealerUpRank, rules, false);
  actions.push("STAND");

  // SURRENDER
  if(canSurrender){
    evs.SURRENDER = -0.5;
    actions.push("SURRENDER");
  }

  // HIT
  if(pTotal < 21){
    const { out } = probListFromCounts(counts);
    let evHit = 0;
    for(const [i,p] of out){
      const c2 = decCount(counts, i);
      if(!c2) continue;
      const r = RANKS[i];
      const [nt, ns] = addTo(pTotal, pSoftAces, r);
      if(nt > 21){
        evHit += p * (-1);
      } else {
        const sub = bestEVExact(c2, nt, ns, cardsCount+1, null, null, fromSplit, dealerUpRank, rules, handsUsed);
        const bestSub = sub.evs[sub.best];
        evHit += p * bestSub;
      }
    }
    evs.HIT = evHit;
    actions.push("HIT");
  }

  // DOUBLE
  if(canDouble){
    const { out } = probListFromCounts(counts);
    let evD = 0;
    for(const [i,p] of out){
      const c2 = decCount(counts, i);
      if(!c2) continue;
      const r = RANKS[i];
      const [nt, ns] = addTo(pTotal, pSoftAces, r);
      if(nt > 21){
        evD += p * (-2);
      } else {
        const evStand = standEVExact(c2, nt, false, dealerUpRank, rules, false); // pIsNaturalBJ false
        evD += p * (2 * evStand);
      }
    }
    evs.DOUBLE = evD;
    actions.push("DOUBLE");
  }

  // SPLIT (without-replacement for initial split cards; follow-up solved with exact recursion on reduced shoe)
  if(canSplit){
    const tot0 = totalCards(counts);
    if(tot0 > 0){
      const pairRank = r1;
      const splitAOne = (pairRank === "A") && (rules.splitA === "one");
      const nextHandsUsed = Math.min(rules.maxHands, handsUsed + 1);

      let evSplit = 0;
      const { out: out1 } = probListFromCounts(counts);
      for(const [i, p1] of out1){
        const c1 = decCount(counts, i);
        if(!c1) continue;
        const dr1 = RANKS[i];

        let t1=0, s1=0;
        [t1, s1] = addTo(t1, s1, pairRank);
        [t1, s1] = addTo(t1, s1, dr1);

        const { out: out2 } = probListFromCounts(c1);
        for(const [j, p2] of out2){
          const c2 = decCount(c1, j);
          if(!c2) continue;
          const dr2 = RANKS[j];

          let t2=0, s2=0;
          [t2, s2] = addTo(t2, s2, pairRank);
          [t2, s2] = addTo(t2, s2, dr2);

          // Both initial draw cards are removed in c2.
          // Note: exact coupling of future draws between hands is extremely expensive;
          // we compute each hand's optimal EV on this reduced shoe and sum them (high-accuracy approx).
          let evH1, evH2;

          if(t1 > 21) evH1 = -1;
          else if(splitAOne) evH1 = standEVExact(c2, t1, false, dealerUpRank, rules, false);
          else {
            const sub1 = bestEVExact(c2, t1, s1, 2, pairRank, dr1, true, dealerUpRank, rules, nextHandsUsed);
            evH1 = sub1.evs[sub1.best];
          }

          if(t2 > 21) evH2 = -1;
          else if(splitAOne) evH2 = standEVExact(c2, t2, false, dealerUpRank, rules, false);
          else {
            const sub2 = bestEVExact(c2, t2, s2, 2, pairRank, dr2, true, dealerUpRank, rules, nextHandsUsed);
            evH2 = sub2.evs[sub2.best];
          }

          evSplit += p1 * p2 * (evH1 + evH2);
        }
      }

      evs.SPLIT = evSplit;
      actions.push("SPLIT");
    }
  }


  // Pick best EV
  let best = actions[0];
  let bestVal = evs[best];
  for(const a of actions){
    const v = evs[a];
    if(v > bestVal + 1e-12){ best = a; bestVal = v; }
  }

  const out = { best, evs, exact: true, nodes: nodeCount };
  memoBest.set(k, out);
  return out;
}

function solveApproxWithReplacement(payload){
  // Simplified approximation: treat draws with replacement from the current probability distribution.
  // This is fast and still shoe-aware (uses remaining composition for probabilities).
  const { counts, playerRanks, dealerUpRank, rules, handsUsed } = payload;

  // probabilities fixed
  const tot = totalCards(counts);
  const probs = [];
  for(let i=0;i<RANKS.length;i++){
    const n = counts[i];
    if(n>0) probs.push([RANKS[i], n/tot]);
  }

  const memo = new Map();
  function dealerDistRep(total, softAces){
    const k = total+"|"+softAces+"|"+rules.dealer17;
    const c = memo.get(k); if(c) return c;
    let m;
    if(total>21){ m = new Map([[0,1]]); memo.set(k,m); return m; }
    if(!dealerShouldHit(total, softAces, rules)){ m = new Map([[total,1]]); memo.set(k,m); return m; }
    m = new Map();
    for(const [r,p] of probs){
      const [nt, ns] = addTo(total, softAces, r);
      const sub = dealerDistRep(nt, ns);
      for(const [t2, pr] of sub.entries()) m.set(t2, (m.get(t2)||0)+p*pr);
    }
    memo.set(k,m);
    return m;
  }

  function standEVRep(pTotal, pIsBJ, pBJEligible){
    let ev=0;
    for(const [hole,pH] of probs){
      let dt=0, ds=0;
      [dt,ds] = addTo(dt,ds,dealerUpRank);
      [dt,ds] = addTo(dt,ds,hole);
      const dBJ = isBlackjack2(dealerUpRank, hole);
      if(pBJEligible && pIsBJ){
        ev += pH * (dBJ ? 0 : (rules.bjPay==="6:5"?1.2:1.5));
        continue;
      }
      const dist = dBJ ? new Map([[21,1]]) : dealerDistRep(dt, ds);
      let local=0;
      for(const [d,pr] of dist.entries()){
        if(d===0) local += pr*1;
        else if(pTotal>d) local += pr*1;
        else if(pTotal<d) local += pr*(-1);
      }
      ev += pH*local;
    }
    return ev;
  }

  const memoP = new Map();
  function bestEVRep(total, softAces, cardsCount, r1, r2, fromSplit, handsUsedNow){
    const key = [total,softAces,cardsCount,r1||"",r2||"",fromSplit?1:0,handsUsedNow].join("|");
    const cached = memoP.get(key); if(cached) return cached;

    const evs = {};
    const actions = [];
    const canSurrender = (rules.surrender==="late") && !fromSplit && cardsCount===2;
    const canDouble = (cardsCount===2) && (fromSplit ? !!rules.DAS : true) && canDoubleOnTotal(total, rules);
    const canSplit = (cardsCount===2) && (r1 && r2 && r1===r2) && (handsUsedNow < rules.maxHands);

    const pIsBJ = (cardsCount===2) && !fromSplit && isBlackjack2(r1,r2);
    const pBJEligible = (cardsCount===2) && !fromSplit;

    if(pIsBJ){
      evs.STAND = standEVRep(total, true, pBJEligible);
      const out = {best:"STAND", evs};
      memoP.set(key,out); return out;
    }

    evs.STAND = standEVRep(total, false, false);
    actions.push("STAND");

    if(canSurrender){ evs.SURRENDER = -0.5; actions.push("SURRENDER"); }

    if(total<21){
      let evH=0;
      for(const [r,p] of probs){
        const [nt,ns] = addTo(total, softAces, r);
        evH += p * (nt>21 ? -1 : bestEVRep(nt, ns, cardsCount+1, null, null, fromSplit, handsUsedNow).evs[bestEVRep(nt, ns, cardsCount+1, null, null, fromSplit, handsUsedNow).best]);
      }
      evs.HIT = evH;
      actions.push("HIT");
    }

    if(canDouble){
      let evD=0;
      for(const [r,p] of probs){
        const [nt,ns] = addTo(total, softAces, r);
        evD += p * (nt>21 ? -2 : 2*standEVRep(nt, false, false));
      }
      evs.DOUBLE = evD;
      actions.push("DOUBLE");
    }

    if(canSplit){
      const pair = r1;
      const splitAOne = (pair==="A") && (rules.splitA==="one");
      function evHand(draw){
        let t=0,s=0;
        [t,s]=addTo(t,s,pair);
        [t,s]=addTo(t,s,draw);
        if(t>21) return -1;
        if(splitAOne) return standEVRep(t, false, false);
        const sub = bestEVRep(t,s,2,pair,draw,true,Math.min(rules.maxHands,handsUsedNow+1));
        return sub.evs[sub.best];
      }
      let one=0;
      for(const [r,p] of probs) one += p*evHand(r);
      evs.SPLIT = 2*one;
      actions.push("SPLIT");
    }

    let best = actions[0];
    let bestVal = evs[best];
    for(const a of actions){ if(evs[a] > bestVal + 1e-12){ best=a; bestVal=evs[a]; } }

    const out = {best, evs};
    memoP.set(key,out);
    return out;
  }

  // init player state
  let pTotal=0, pSoft=0;
  for(const r of playerRanks){ [pTotal,pSoft] = addTo(pTotal,pSoft,r); }
  const cardsCount = playerRanks.length;
  const r1 = cardsCount===2 ? playerRanks[0] : null;
  const r2 = cardsCount===2 ? playerRanks[1] : null;
  const fromSplit = !!payload.fromSplit;

  const res = bestEVRep(pTotal,pSoft,cardsCount,r1,r2,fromSplit,handsUsed);
  return { ok:true, exact:false, best: res.best, evs: res.evs, nodes: 0, note: "approx (with-replacement)" };
}

function parseDoubleCustomSet(str){
  const s = String(str||"").trim();
  const set = new Set();
  if(!s) return set;
  const parts = s.split(/[;\s]+/).join(",").split(",");
  for(const p0 of parts){
    const p = p0.trim();
    if(!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if(m){
      let a = parseInt(m[1],10), b = parseInt(m[2],10);
      if(a>b){ const t=a; a=b; b=t; }
      for(let x=a;x<=b;x++) set.add(x);
    } else {
      const n = parseInt(p,10);
      if(Number.isFinite(n)) set.add(n);
    }
  }
  return set;
}

function solve(payload){
  const rules = payload.rules;
  // enrich rules
  rules.doubleCustomSet = parseDoubleCustomSet(rules.doubleCustom || "");
  rules.maxHands = Math.max(1, parseInt(rules.maxHands,10) || 4);
  rules.peek = !!rules.peek;
  rules.resplitA = !!rules.resplitA;
  rules.surrender = String(rules.surrender || "off");
  rules.dealer17 = (rules.dealer17 === "H17") ? "H17" : "S17";
  rules.bjPay = (rules.bjPay === "6:5") ? "6:5" : "3:2";
  rules.splitA = (rules.splitA === "free") ? "free" : "one";

  NODE_LIMIT = Math.max(20000, Math.min(600000, parseInt(payload.nodeLimit,10) || 120000));
  nodeCount = 0;

  try{
    const { counts, playerRanks, dealerUpRank, handsUsed } = payload;

    // init player totals
    let pTotal=0, pSoft=0;
    for(const r of playerRanks){ [pTotal,pSoft] = addTo(pTotal,pSoft,r); }
    const cardsCount = playerRanks.length;
    const r1 = cardsCount===2 ? playerRanks[0] : null;
    const r2 = cardsCount===2 ? playerRanks[1] : null;

    const out = bestEVExact(counts, pTotal, pSoft, cardsCount, r1, r2, !!payload.fromSplit, dealerUpRank, rules, handsUsed);
    return { ok:true, exact:true, best: out.best, evs: out.evs, nodes: out.nodes || nodeCount, note: out.note || "exact" };
  } catch(e){
    if(String(e && e.message) === "NODE_LIMIT"){
      // fallback approximation
      return solveApproxWithReplacement(payload);
    }
    return { ok:false, error: String(e && (e.stack || e.message || e)) };
  }
}

self.onmessage = (ev)=>{
  const payload = ev.data || {};
  const __reqId = payload.__reqId;
  const __key = payload.__key;
  const result = solve(payload);
  result.__reqId = __reqId;
  result.__key = __key;
  self.postMessage(result);
};
