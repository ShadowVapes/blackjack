
/* room.js - UI + state + multiplayer (optional) */
(function(){
  const $ = (id)=>document.getElementById(id);

  const SUITS = ["♠","♥","♦","♣"];
  const RANKS = ["A","K","Q","J","10","9","8","7","6","5","4","3","2"];

  const toast = $("toast");
  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(()=>toast.classList.remove("show"), 2200);
  }

  const modal = $("modal");
  const modalTitle = $("modalTitle");
  const modalBody = $("modalBody");
  $("modalClose").addEventListener("click", ()=>modal.classList.remove("show"));
  modal.addEventListener("click", (e)=>{ if(e.target === modal) modal.classList.remove("show"); });

  function openModal(title, body){
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modal.classList.add("show");
  }

  function randId(n=6){
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s="";
    for(let i=0;i<n;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  }

  function parseHash(){
    const h = location.hash.replace(/^#/, "");
    const out = {};
    for(const part of h.split("&")){
      if(!part) continue;
      const [k,v] = part.split("=");
      out[decodeURIComponent(k)] = decodeURIComponent(v||"");
    }
    return out;
  }
  function setHash(obj){
    const parts = [];
    for(const [k,v] of Object.entries(obj)){
      parts.push(encodeURIComponent(k)+"="+encodeURIComponent(v));
    }
    location.hash = parts.join("&");
  }

  function defaultState(){
    return {
      v: 1,
      mode: "single",
      roomId: "",
      roleWanted: null,
      role: "single",
      rules: {
        decks: 6,
        // shoeDecks is the CURRENT shoe capacity (auto-extends when depleted)
        // decks is the base starting decks selected by the user.
        shoeDecks: 6,
        dealer17: "S17",
        bjPay: "3:2",
        surrender: "late",
        doubleRule: "any",
        doubleCustom: "",
        DAS: true,
        maxHands: 4,
        splitA: "one",
        resplitA: false,
        peek: true },
      hands: [[]],
      hmeta: [{ fromSplit: false }],
      activeHand: 0,
      dealer: [],
      seen: [] };
  }

  let state = defaultState();

  // Bet sizing is LOCAL ONLY (not synced to room). Stored in localStorage.
  let betSettings = {
    base: 1000,        // 1 unit
    ramp: "1-6",       // "1-6" | "1-10" | "custom"
    custom: "0:1,1:2,2:3,3:4,4:5,5:6",
    cap: 6,            // max units
    round: 0           // 0/10/100/1000 (round DOWN)
  };

  // Bankroll (LOCAL ONLY, not synced to room).
  // Model: balance = available cash, committed = stakes currently on the table for this round.
  // When you start a round (bet), it moves from balance -> committed. Split/Double also move additional stake.
  // On resolve (Next Round), payouts are added back to balance and committed resets to 0.
  let bank = {
    start: 100000,
    balance: 100000,
    committed: 0,
    inRound: false,
    baseBet: 0,
    stakes: [0],
    doubled: [false],
    surrendered: [false],
  };

  let bankSettings = {
    capToBankroll: true,
    reserveMode: '4', // '1'|'2'|'4'|'max'
  };

  function clampMoney(x){
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  function loadBank(){
    try{
      const raw = localStorage.getItem('bj_bankroll');
      if(raw){
        const o = JSON.parse(raw);
        if(typeof o.start==='number') bank.start = o.start;
        if(typeof o.balance==='number') bank.balance = o.balance;
        if(typeof o.committed==='number') bank.committed = o.committed;
        if(typeof o.inRound==='boolean') bank.inRound = o.inRound;
        if(typeof o.baseBet==='number') bank.baseBet = o.baseBet;
        if(Array.isArray(o.stakes)) bank.stakes = o.stakes;
        if(Array.isArray(o.doubled)) bank.doubled = o.doubled;
        if(Array.isArray(o.surrendered)) bank.surrendered = o.surrendered;
      }
      const raw2 = localStorage.getItem('bj_bank_settings');
      if(raw2){
        const s = JSON.parse(raw2);
        if(typeof s.capToBankroll==='boolean') bankSettings.capToBankroll = s.capToBankroll;
        if(typeof s.reserveMode==='string') bankSettings.reserveMode = s.reserveMode;
      }
    }catch(_e){}

    if(!Array.isArray(bank.stakes) || bank.stakes.length===0) bank.stakes=[0];
    if(!Array.isArray(bank.doubled) || bank.doubled.length!==bank.stakes.length) bank.doubled = bank.stakes.map(()=>false);
    if(!Array.isArray(bank.surrendered) || bank.surrendered.length!==bank.stakes.length) bank.surrendered = bank.stakes.map(()=>false);
  }

  function saveBank(){
    try{ localStorage.setItem('bj_bankroll', JSON.stringify(bank)); }catch(_e){}
    try{ localStorage.setItem('bj_bank_settings', JSON.stringify(bankSettings)); }catch(_e){}
  }

  function bankTotal(){
    return clampMoney(bank.balance) + clampMoney(bank.committed);
  }

  function exposureFactor(){
    const maxHands = parseInt(state.rules.maxHands,10) || 4;
    if(bankSettings.reserveMode === 'max') return Math.max(1, 2 * maxHands);
    const n = parseInt(bankSettings.reserveMode,10);
    return Number.isFinite(n) && n>0 ? n : 4;
  }

  function ensureBankArrays(){
    ensureHands();
    const n = state.hands.length;
    if(!Array.isArray(bank.stakes)) bank.stakes = [];
    if(!Array.isArray(bank.doubled)) bank.doubled = [];
    if(!Array.isArray(bank.surrendered)) bank.surrendered = [];
    while(bank.stakes.length < n) bank.stakes.push(0);
    while(bank.doubled.length < n) bank.doubled.push(false);
    while(bank.surrendered.length < n) bank.surrendered.push(false);
    bank.stakes = bank.stakes.slice(0, n);
    bank.doubled = bank.doubled.slice(0, n);
    bank.surrendered = bank.surrendered.slice(0, n);
  }

  function updateBankUI(){
    const out = $('bankOut');
    const meta = $('bankMeta');
    if(!out || !meta) return;
    const bal = clampMoney(bank.balance);
    const com = clampMoney(bank.committed);
    const tot = bal + com;
    out.textContent = 'Avail: ' + bal.toLocaleString('hu-HU') + ' • In play: ' + com.toLocaleString('hu-HU') + ' • Total: ' + tot.toLocaleString('hu-HU');
    meta.textContent = bank.inRound
      ? ('Kör: aktív • base bet: ' + clampMoney(bank.baseBet).toLocaleString('hu-HU') + ' • hands: ' + state.hands.length)
      : 'Kör: nincs bet lockolva';
  }

  function bankSetStart(val){
    const v = clampMoney(val);
    bank.start = v;
    bank.balance = v;
    bank.committed = 0;
    bank.inRound = false;
    bank.baseBet = 0;
    bank.stakes = [0];
    bank.doubled = [false];
    bank.surrendered = [false];
    saveBank();
    updateBankUI();
  }

  function bankRefundAll(){
    bank.balance = clampMoney(bank.balance) + clampMoney(bank.committed);
    bank.committed = 0;
    bank.inRound = false;
    bank.baseBet = 0;
    ensureHands();
    bank.stakes = state.hands.map(()=>0);
    bank.doubled = state.hands.map(()=>false);
    bank.surrendered = state.hands.map(()=>false);
    saveBank();
    updateBankUI();
  }

  function bankStartRound(bet){
    ensureBankArrays();
    const b = clampMoney(bet);
    if(b<=0){ showToast('Adj meg fogadást'); return false; }
    if(bank.inRound){ showToast('A kör már elindult'); return true; }
    const need = b * state.hands.length;
    if(clampMoney(bank.balance) < need){
      showToast('Nincs elég pénz a bethez (kell ' + need + ')');
      return false;
    }
    bank.baseBet = b;
    bank.inRound = true;
    bank.balance = clampMoney(bank.balance) - need;
    bank.committed = clampMoney(bank.committed) + need;
    bank.stakes = state.hands.map(()=>b);
    bank.doubled = state.hands.map(()=>false);
    bank.surrendered = state.hands.map(()=>false);
    saveBank();
    updateBankUI();
    return true;
  }

  function bankAddHandStake(){
    if(!bank.inRound) return true;
    const b = clampMoney(bank.baseBet);
    if(b<=0) return true;
    if(clampMoney(bank.balance) < b){
      showToast('Nincs fedezet +1 hand betre');
      return false;
    }
    bank.balance = clampMoney(bank.balance) - b;
    bank.committed = clampMoney(bank.committed) + b;
    bank.stakes.push(b);
    bank.doubled.push(false);
    bank.surrendered.push(false);
    saveBank();
    updateBankUI();
    return true;
  }

  function bankRemoveHandStake(idx){
    ensureBankArrays();
    const s = clampMoney(bank.stakes[idx]||0);
    if(bank.inRound && s>0){
      bank.balance = clampMoney(bank.balance) + s;
      bank.committed = Math.max(0, clampMoney(bank.committed) - s);
    }
    bank.stakes.splice(idx,1);
    bank.doubled.splice(idx,1);
    bank.surrendered.splice(idx,1);
    saveBank();
    updateBankUI();
  }

  function bankToggleDouble(idx){
    ensureBankArrays();
    if(!bank.inRound){ showToast('Előbb indíts kört (bet)'); return; }
    const stake = clampMoney(bank.stakes[idx]||0);
    if(stake<=0){ showToast('Nincs stake ezen a handen'); return; }
    if(bank.doubled[idx]){
      // undo double: refund the extra half
      const extra = Math.floor(stake/2);
      bank.balance = clampMoney(bank.balance) + extra;
      bank.committed = Math.max(0, clampMoney(bank.committed) - extra);
      bank.stakes[idx] = extra;
      bank.doubled[idx] = false;
      saveBank();
      updateBankUI();
      showToast('Double visszavonva');
      return;
    }
    if(clampMoney(bank.balance) < stake){
      showToast('Nincs elég pénz a DOUBLE-hoz');
      return;
    }
    bank.balance = clampMoney(bank.balance) - stake;
    bank.committed = clampMoney(bank.committed) + stake;
    bank.stakes[idx] = stake * 2;
    bank.doubled[idx] = true;
    saveBank();
    updateBankUI();
    showToast('Double jelölve');
  }

  function bankToggleSurrender(idx){
    ensureBankArrays();
    if(!bank.inRound){ showToast('Előbb indíts kört (bet)'); return; }
    bank.surrendered[idx] = !bank.surrendered[idx];
    saveBank();
    updateBankUI();
    showToast(bank.surrendered[idx] ? 'Surrender jelölve' : 'Surrender levéve');
  }

  function resolvePayouts(){
    ensureHands();
    ensureBankArrays();
    if(!bank.inRound){
      return { ok:false, msg:'Nincs aktív kör (bet nincs lockolva).' };
    }
    if(!state.dealer || state.dealer.length < 2){
      return { ok:false, msg:'Adj meg a dealer lapjait (legalább 2), hogy lezárjuk a kört.' };
    }

    const dTotObj = window.BJStrategy.handTotal(state.dealer);
    const dTotal = dTotObj.total;
    const dealerBJ = (state.dealer.length===2 && dTotal===21);

    const bjPay = (state.rules.bjPay === '6:5') ? 1.2 : 1.5;
    let returned = 0;
    const lines = [];

    for(let i=0;i<state.hands.length;i++){
      const hand = state.hands[i];
      const meta = (state.hmeta && state.hmeta[i]) ? state.hmeta[i] : {fromSplit:false};
      const stake = clampMoney(bank.stakes[i]||0);
      const pObj = window.BJStrategy.handTotal(hand);
      const pTotal = pObj.total;
      const pBJ = (!meta.fromSplit) && hand.length===2 && pTotal===21;
      const surrendered = !!bank.surrendered[i];

      let add = 0;
      let outcome = '';

      if(stake<=0){
        outcome = 'no-bet';
        add = 0;
      } else if(surrendered){
        add = Math.floor(stake * 0.5);
        outcome = 'surrender (-1/2)';
      } else if(pTotal>21){
        add = 0;
        outcome = 'bust (lose)';
      } else if(dealerBJ){
        if(pBJ){ add = stake; outcome='push (BJ/BJ)'; }
        else { add = 0; outcome='lose (dealer BJ)'; }
      } else if(pBJ){
        add = Math.floor(stake * (1 + bjPay));
        outcome = 'blackjack (+' + bjPay + ')';
      } else if(dTotal>21){
        add = stake * 2;
        outcome = 'win (dealer bust)';
      } else {
        if(pTotal > dTotal){ add = stake * 2; outcome='win'; }
        else if(pTotal < dTotal){ add = 0; outcome='lose'; }
        else { add = stake; outcome='push'; }
      }

      returned += add;
      lines.push('Hand ' + (i+1) + ': stake ' + stake + ' → ' + outcome + ' | return ' + add);
    }

    const beforeTotal = bankTotal();
    bank.balance = clampMoney(bank.balance) + returned;
    bank.committed = 0;
    bank.inRound = false;
    bank.baseBet = 0;
    bank.stakes = state.hands.map(()=>0);
    bank.doubled = state.hands.map(()=>false);
    bank.surrendered = state.hands.map(()=>false);
    saveBank();
    updateBankUI();

    const afterTotal = bankTotal();
    const net = afterTotal - beforeTotal;
    return { ok:true, net, lines, beforeTotal, afterTotal, returned };
  }


  // EV-solver (exact EV) settings - LOCAL ONLY (not synced)
  let solverSettings = {
    enabled: true,
    nodeLimit: 400000
  };

  function loadSolverSettings(){
    try{
      const raw = localStorage.getItem("bj_solver_settings");
      if(!raw) return;
      const o = JSON.parse(raw);
      if(typeof o.enabled === "boolean") solverSettings.enabled = o.enabled;
      if(typeof o.nodeLimit === "number") solverSettings.nodeLimit = o.nodeLimit;
    }catch(_e){}
  }
  function saveSolverSettings(){
    try{ localStorage.setItem("bj_solver_settings", JSON.stringify(solverSettings)); }catch(_e){}
  }

  let evWorker = null;
  let evPendingKey = null;
  let evReqId = 0;
  const evCache = new Map();

  const SOLVER_RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const rankIdx = Object.fromEntries(SOLVER_RANKS.map((r,i)=>[r,i]));

  function shoeDecks(){
    // current shoe size (may be larger than base decks if we had to extend)
    const d = Number(state.rules.shoeDecks ?? state.rules.decks ?? 6);
    return Number.isFinite(d) && d > 0 ? d : 6;
  }

  function baseDecks(){
    const d = Number(state.rules.decks ?? 6);
    return Number.isFinite(d) && d > 0 ? d : 6;
  }

  function usedRankCounts(){
    const m = Object.fromEntries(SOLVER_RANKS.map(r=>[r,0]));
    for(const c of state.seen) if(m[c.rank] !== undefined) m[c.rank] += 1;
    for(const c of allPlayerCards()) if(m[c.rank] !== undefined) m[c.rank] += 1;
    for(const c of state.dealer) if(m[c.rank] !== undefined) m[c.rank] += 1;
    return m;
  }

  function ensureShoeHasRank(rank){
    const r = String(rank);
    if(rankIdx[r] === undefined) return 0;
    const used = usedRankCounts();
    const usedR = used[r] || 0;
    const d = shoeDecks();
    const rem = (4 * d) - usedR;
    if(rem >= 1) return 0;

    // Need to add decks until we have at least 1 card of that rank remaining.
    const deficit = (usedR - (4 * d)) + 1; // how many cards short we are
    const add = Math.max(1, Math.ceil(deficit / 4));
    state.rules.shoeDecks = d + add;
    return add;
  }

  function normalizeShoeDecks(){
    // Ensure shoeDecks is large enough for already-entered cards.
    const used = usedRankCounts();
    let need = baseDecks();
    for(const r of SOLVER_RANKS){
      const u = used[r] || 0;
      need = Math.max(need, Math.ceil(u / 4));
    }
    if(!Number.isFinite(state.rules.shoeDecks) || state.rules.shoeDecks < need){
      state.rules.shoeDecks = need;
    }
  }

  function buildRemainingCounts(decks){
    const counts = SOLVER_RANKS.map(()=>4*decks);
    function dec(rank){
      const r = String(rank);
      const idx = rankIdx[r];
      if(idx === undefined) return;
      counts[idx] = Math.max(0, (counts[idx]||0) - 1);
    }
    // remove seen + all player cards + dealer upcard ONLY (decision-time info)
    for(const c of state.seen) dec(c.rank);
    for(const c of allPlayerCards()) dec(c.rank);
    if(state.dealer && state.dealer[0]) dec(state.dealer[0].rank);
    return counts;
  }

  function evKey(payload){
    return JSON.stringify([
      payload.counts,
      payload.playerRanks,
      payload.dealerUpRank,
      payload.rules,
      payload.fromSplit ? 1 : 0,
      payload.handsUsed,
      payload.nodeLimit
    ]);
  }

  function ensureEvWorker(){
    if(evWorker) return;
    try{
      evWorker = new Worker("./assets/exact_solver_worker.js");
      evWorker.onmessage = (e)=>{
        const res = e.data || {};
        const key = res.__key;
        if(!key) return;
        evCache.set(key, res);
        if(evPendingKey === key) evPendingKey = null;
        // re-render to show results
        renderAll();
      };
    }catch(err){
      console.warn("EV worker init failed", err);
      evWorker = null;
    }
  }

  function requestEV(payload){
    ensureEvWorker();
    if(!evWorker) return null;
    const key = evKey(payload);
    if(evCache.has(key)) return evCache.get(key);
    if(evPendingKey === key) return null;
    evPendingKey = key;
    evReqId += 1;
    payload.__reqId = evReqId;
    payload.__key = key;
    evWorker.postMessage(payload);
    return null;
  }

  function fmtEV(v){
    if(v === undefined || v === null || !Number.isFinite(v)) return "—";
    return (v >= 0 ? "+" : "") + v.toFixed(4);
  }
  function formatEVList(evs){
    const order = ["STAND","HIT","DOUBLE","SPLIT","SURRENDER"];
    const lines = [];
    for(const a of order){
      if(evs && Object.prototype.hasOwnProperty.call(evs, a)){
        lines.push(`${a}: ${fmtEV(evs[a])}`);
      }
    }
    return lines.join("\n");
  }

  function loadBetSettings(){
    try{
      const raw = localStorage.getItem("bj_bet_settings");
      if(!raw) return;
      const o = JSON.parse(raw);
      if(typeof o.base === "number") betSettings.base = o.base;
      if(typeof o.ramp === "string") betSettings.ramp = o.ramp;
      if(typeof o.custom === "string") betSettings.custom = o.custom;
      if(typeof o.cap === "number") betSettings.cap = o.cap;
      if(typeof o.round === "number") betSettings.round = o.round;
    }catch(_e){}
  }
  function saveBetSettings(){
    try{ localStorage.setItem("bj_bet_settings", JSON.stringify(betSettings)); }catch(_e){}
  }

  function parseCustomRamp(str){
    // "0:1,1:2,2:4" => [{tc:0, u:1}, ...] sorted asc
    const out = [];
    const s = String(str||"").trim();
    if(!s) return out;
    const parts = s.split(/[;\n]+/).join(",").split(",");
    for(const p0 of parts){
      const p = p0.trim();
      if(!p) continue;
      const m = p.match(/^\s*(-?\d+)\s*:\s*(\d+)\s*$/);
      if(!m) continue;
      const tc = parseInt(m[1],10);
      const u  = parseInt(m[2],10);
      if(!Number.isFinite(tc) || !Number.isFinite(u)) continue;
      out.push({ tc, u });
    }
    out.sort((a,b)=>a.tc-b.tc);
    return out;
  }

  function betUnitsFromTC(tc){
    const tci = Math.floor(tc);
    if(tci <= 0) return 1;

    if(betSettings.ramp === "1-10"){
      if(tci === 1) return 2;
      if(tci === 2) return 4;
      if(tci === 3) return 6;
      if(tci === 4) return 8;
      return 10; // 5+
    }

    if(betSettings.ramp === "custom"){
      const map = parseCustomRamp(betSettings.custom);
      if(!map.length) return Math.min(6, tci + 1);
      let best = null;
      for(const it of map){
        if(it.tc <= tci) best = it;
        else break;
      }
      if(best) return best.u;
      return 1;
    }

    // default 1-6
    return Math.min(6, tci + 1);
  }

  function roundDown(amount, step){
    const s = Number(step)||0;
    if(s <= 0) return amount;
    return Math.floor(amount / s) * s;
  }

  function calcRecommendedBetNextRound(){
    try{
      normalizeShoeDecks();
      const decks = shoeDecks();
      const rcShoe = window.BJCount.runningCount(state.seen);
      const remShoe = window.BJCount.remainingFromSeen(decks, state.seen.length);
      const tcShoe = window.BJCount.trueCount(rcShoe, remShoe.remainingDecks);

      const unitsRaw = betUnitsFromTC(tcShoe);
      const cap = Math.max(1, parseInt(betSettings.cap,10) || 6);
      const units = Math.min(cap, Math.max(1, unitsRaw));
      const base = Math.max(0, parseFloat(betSettings.base) || 0);
      let bet = roundDown(base * units, betSettings.round);

      if(bankSettings && bankSettings.capToBankroll){
        const totBank = bankTotal();
        const factor = exposureFactor();
        const maxBet = roundDown(Math.floor(totBank / factor), betSettings.round);
        if(Number.isFinite(maxBet) && maxBet >= 0) bet = Math.min(bet, maxBet);
      }
      return clampMoney(bet);
    }catch(_e){
      return 0;
    }
  }

  function loadPersist(){
    try{
      const raw = localStorage.getItem("bj_recreator_state");
      if(raw){
        const parsed = JSON.parse(raw);
        if(parsed.rules) state.rules = { ...state.rules, ...parsed.rules };
        if(Array.isArray(parsed.seen)) state.seen = parsed.seen;
      }
    }catch(_e){}
  }
  function persist(){
    try{
      localStorage.setItem("bj_recreator_state", JSON.stringify({
        rules: state.rules,
        seen: state.seen
      }));
    }catch(_e){}
  }

  
  // ---- Realtime ----
  let sbClient = null;
  let sbChannel = null;
  let presence = {};
  let rtReady = false;

  // Stable client id (so Presence doesn't duplicate you on reconnect)
  const CLIENT_ID_KEY = "bj_rt_client_id";
  const clientId = (()=>{
    try{
      let id = localStorage.getItem(CLIENT_ID_KEY);
      if(!id){ id = randId(10); localStorage.setItem(CLIENT_ID_KEY, id); }
      return id;
    }catch(_e){ return randId(10); }
  })();
  const joinTs = Date.now();

  let helloTimer = null;

  function rtStatus(text){ $("rtStatus").textContent = text; }

  function getSbConfig(){
    const url = (window.BJ_SUPABASE_URL || "").trim() || (localStorage.getItem("bj_sb_url") || "");
    const key = (window.BJ_SUPABASE_ANON_KEY || "").trim() || (localStorage.getItem("bj_sb_key") || "");
    return { url, key };
  }
  function setSbConfig(url,key){
    localStorage.setItem("bj_sb_url", url);
    localStorage.setItem("bj_sb_key", key);
  }

  function mergePartial(partial, source){
    if(partial.rules) state.rules = { ...state.rules, ...partial.rules };

    if(source === "host" && partial.hands) state.hands = partial.hands;
    if(source === "host" && typeof partial.activeHand === "number") state.activeHand = partial.activeHand;
    if(source === "dealer" && partial.dealer) state.dealer = partial.dealer;

    if(source === "any"){
      if(partial.hands) state.hands = partial.hands;
      if(typeof partial.activeHand === "number") state.activeHand = partial.activeHand;
      if(partial.dealer) state.dealer = partial.dealer;
    }

    if(source === "snapshot"){
      if(partial.hands) state.hands = partial.hands;
      if(typeof partial.activeHand === "number") state.activeHand = partial.activeHand;
      // dealer is NOT applied from host snapshot to avoid flicker/desync
    }

    if(Array.isArray(partial.seen)) state.seen = partial.seen;
  }

  function scheduleHello(){
    if(helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(()=>{
      if(!sbChannel || !rtReady) return;
      sbChannel.send({
        type: "broadcast",
        event: "hello",
        payload: {
          from: clientId,
          role: state.role,
          want: state.roleWanted,
          room: state.roomId,
          ts: Date.now()
        }
      });
    }, 120);
  }

  function sendSnapshot(to){
    if(!sbChannel || !rtReady) return;
    // Host is authoritative for rules/seen/hands; dealer for dealer cards.
    const snap = {
      rules: state.rules,
      seen: state.seen,
      hands: state.hands,
      hmeta: state.hmeta,
      activeHand: state.activeHand,
    };
    sbChannel.send({
      type: "broadcast",
      event: "snapshot",
      payload: { from: clientId, to, snap, ts: Date.now() }
    });
  }

  function sendDealerPatch(to){
    if(!sbChannel || !rtReady) return;
    sbChannel.send({
      type: "broadcast",
      event: "dealer_snapshot",
      payload: { from: clientId, to, dealer: state.dealer, ts: Date.now() }
    });
  }

  async function rtConnect(){
    const {url,key} = getSbConfig();
    if(!url || !key){
      showToast("Supabase URL/anon key hiányzik – offline mód");
      return;
    }
    const roomId = state.roomId;
    if(!roomId){
      showToast("Adj meg Room ID-t");
      return;
    }

    try{
      rtStatus("connecting…");
      sbClient = await window.SBRT.createClient(url, key);

      sbChannel = sbClient.channel("bj-room-"+roomId, {
        config: { presence: { key: clientId } }
      });

      sbChannel
        .on("broadcast", { event: "patch" }, (payload)=>{
          const msg = payload.payload || {};
          mergePartial(msg.patch || {}, msg.role || "any");
          renderAll();
        })
        .on("broadcast", { event: "hello" }, ({payload})=>{
          const p = payload || {};
          if(!p.from || p.from === clientId) return;
          // If I'm host -> send full snapshot to the joiner.
          if(state.role === "host"){
            sendSnapshot(p.from);
          }
          // If I'm dealer -> send dealer cards to the joiner.
          if(state.role === "dealer"){
            sendDealerPatch(p.from);
          }
        })
        .on("broadcast", { event: "snapshot" }, ({payload})=>{
          const p = payload || {};
          if(!p.to || (p.to !== clientId && p.to !== "*")) return;
          if(!p.snap) return;
          mergePartial(p.snap, "snapshot");
          renderAll();
          showToast("Szinkron kész (snapshot)");
        })
        .on("broadcast", { event: "dealer_snapshot" }, ({payload})=>{
          const p = payload || {};
          if(!p.to || (p.to !== clientId && p.to !== "*")) return;
          if(!Array.isArray(p.dealer)) return;
          mergePartial({ dealer: p.dealer }, "dealer");
          renderAll();
        })
        .on("presence", { event: "sync" }, ()=>{
          presence = sbChannel.presenceState() || {};
          updateRoleFromPresence();
          scheduleHello();
        });

      await sbChannel.subscribe(async (status)=>{
        if(status === "SUBSCRIBED"){
          rtReady = true;
          rtStatus("online");

          // Track presence with our role
          try{ await sbChannel.track({ role: state.role, want: state.roleWanted, ts: joinTs }); }catch(_e){}

          // Send initial patches so late-joiners still see something even before snapshot
          if(state.role === "host"){
            rtBroadcast({ hands: state.hands, activeHand: state.activeHand, rules: state.rules, seen: state.seen }, "host");
          } else if(state.role === "dealer"){
            rtBroadcast({ dealer: state.dealer }, "dealer");
          } else {
            rtBroadcast({ rules: state.rules, seen: state.seen }, "any");
          }

          // Ask for snapshot
          scheduleHello();
        }
      });
    }catch(e){
      console.error(e);
      rtStatus("offline");
      showToast("Realtime hiba – offline");
      rtReady = false;
      sbChannel = null;
      sbClient = null;
    }
  }

  async function rtDisconnect(){
    try{
      if(sbChannel){
        await sbChannel.unsubscribe();
        sbChannel = null;
      }
      sbClient = null;
    }catch(_e){}
    rtReady = false;
    rtStatus("offline");
  }

  function rtBroadcast(patch, role){
    if(!sbChannel || !rtReady) return;
    sbChannel.send({
      type: "broadcast",
      event: "patch",
      payload: { role, patch, from: clientId, ts: Date.now() }
    });
  }

  function updateRoleFromPresence(){
    if(state.mode !== "multi") return;

    // Build stable participant list from presence
    const entries = [];
    for(const cid of Object.keys(presence)){
      const arr = presence[cid];
      if(!Array.isArray(arr) || !arr[0]) continue;
      const p = arr[0] || {};
      entries.push({
        id: cid,
        want: p.want || "auto",
        ts: Number(p.ts) || 0
      });
    }
    if(entries.length === 0) return;

    // Sort by join timestamp (then id) to avoid role flip-flop
    entries.sort((a,b)=>{
      const dt = (a.ts - b.ts);
      if(dt !== 0) return dt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    // Decide host (prefer someone who wants host, otherwise first joiner)
    let hostId = entries.find(e=>e.want === "host")?.id || entries[0].id;

    // Decide dealer (prefer someone who wants dealer, otherwise next joiner)
    let dealerId = entries.find(e=>e.id !== hostId && e.want === "dealer")?.id
                || entries.find(e=>e.id !== hostId)?.id
                || null;

    const desiredRole = (clientId === hostId) ? "host"
                       : (dealerId && clientId === dealerId) ? "dealer"
                       : "spectator";

    if(desiredRole !== state.role){
      state.role = desiredRole;
      renderRole();
      try{ sbChannel && sbChannel.track({ role: state.role, want: state.roleWanted, ts: joinTs }); }catch(_e){}
      // After role changes, re-announce
      scheduleHello();
      // Send authoritative snapshot/patch if you became host/dealer
      if(state.role === "host"){
        sendSnapshot("*");
      } else if(state.role === "dealer"){
        sendDealerPatch("*");
      }
    }
  }

// ---- UI helpers ----

  function ensureHands(){
    if(!Array.isArray(state.hands) || state.hands.length === 0) state.hands = [[]];
    // hand metadata (fromSplit flags) so solver can respect BJ/surrender rules
    if(!Array.isArray(state.hmeta) || state.hmeta.length !== state.hands.length){
      const next = [];
      for(let i=0;i<state.hands.length;i++){
        const prev = (Array.isArray(state.hmeta) && state.hmeta[i]) ? state.hmeta[i] : null;
        next.push({ fromSplit: !!(prev && prev.fromSplit) });
      }
      state.hmeta = next;
    }
    if(typeof state.activeHand !== "number" || state.activeHand < 0) state.activeHand = 0;
    if(state.activeHand >= state.hands.length) state.activeHand = 0;
  }

  function activeHand(){
    ensureHands();
    return state.hands[state.activeHand];
  }

  function allPlayerCards(){
    ensureHands();
    return state.hands.flat();
  }
  function makePicker(container, onPick){
  container.innerHTML = "";
  for(const r of RANKS){
    const b = document.createElement("button");
    b.className = "pickBtn";
    b.type = "button";
    // Display-only suit icon for "card look"
    b.innerHTML = `<span class="pRank">${r}</span><span class="pSuit">♠</span>`;
    b.addEventListener("click", ()=>onPick({ kind:"rank", value:r }));
    container.appendChild(b);
  }
}

  function cardChip(card, onRemove, canEdit){
  const el = document.createElement("div");
  el.className = "cardChip";
  el.setAttribute("role","button");
  el.setAttribute("tabindex", canEdit ? "0" : "-1");
  el.setAttribute("aria-disabled", canEdit ? "false" : "true");

  const rank = document.createElement("div");
  rank.className = "rank";
  rank.textContent = card.rank;

  const suit = document.createElement("div");
  suit.className = "suit" + ((card.suit==="♥"||card.suit==="♦") ? " red" : "");
  suit.textContent = card.suit;

  el.append(rank, suit);

  function fire(){
    if(!canEdit) return;
    onRemove();
  }
  el.addEventListener("click", fire);
  el.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fire(); }});

  return el;
}

function renderHand(containerId, cards, canEdit, onRemoveAt){
    const wrap = $(containerId);
    wrap.innerHTML = "";
    cards.forEach((c, idx)=>{
      wrap.appendChild(cardChip(c, ()=>onRemoveAt(idx), canEdit));
    });
  }

  function setPill(el, text, tone){
    el.textContent = text;
    el.style.borderColor = tone==="good" ? "rgba(44,217,123,.45)" :
      tone==="bad" ? "rgba(255,77,77,.45)" :
      tone==="warn" ? "rgba(255,211,107,.45)" : "rgba(255,255,255,.12)";
    el.style.background = tone==="good" ? "rgba(44,217,123,.12)" :
      tone==="bad" ? "rgba(255,77,77,.12)" :
      tone==="warn" ? "rgba(255,211,107,.12)" : "rgba(0,0,0,.22)";
  }

  function canEditPlayer(){ return state.role === "single" || state.role === "host"; }
  function canEditDealer(){ return state.role === "single" || state.role === "dealer"; }

  function renderRole(){
    const pill = $("rolePill");
    const role = state.role;
    setPill(pill, role.toUpperCase(), role==="host"?"good": role==="dealer"?"warn": role==="single"?"good":"");
    $("roomSub").textContent = state.roomId ? `Room: ${state.roomId}` : "—";

    const playerLock = $("playerLock");
    const dealerLock = $("dealerLock");
    const pEdit = canEditPlayer();
    const dEdit = canEditDealer();
    setPill(playerLock, pEdit ? "edit" : "locked", pEdit ? "good" : "bad");
    setPill(dealerLock, dEdit ? "edit" : "locked", dEdit ? "good" : "bad");
  }

  function setActiveHand(idx){
    ensureHands();
    const n = state.hands.length;
    const next = Math.max(0, Math.min(n-1, idx));
    if(next === state.activeHand) return;
    state.activeHand = next;
    renderAll();
    // Only host/single should sync activeHand
    if(canEditPlayer()) broadcastHostHands();
  }

  function renderHandTabs(){
    ensureHands();
    ensureBankArrays();
    const tabs = $("handTabs");
    const hint = $("handHint");
    if(!tabs) return;
    tabs.innerHTML = "";
    state.hands.forEach((h, i)=>{
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "handTab" + (i === state.activeHand ? " active" : "");
      const t = window.BJStrategy.handTotal(h);
      const stake = clampMoney(bank.stakes[i]||0);
      const fD = bank.doubled[i] ? ' D' : '';
      const fR = bank.surrendered[i] ? ' R' : '';
      const fS = (bank.inRound && stake>0) ? (' [' + stake.toLocaleString('hu-HU') + ']') : '';
      const label = h.length ? `H${i+1} (${t.total}${t.soft?"s":""})${fD}${fR}${fS}` : `H${i+1}${fD}${fR}${fS}`;
      btn.textContent = label;
      btn.addEventListener("click", ()=>setActiveHand(i));
      tabs.appendChild(btn);
    });
    if(hint) hint.textContent = `Aktív kéz: Hand ${state.activeHand+1} / ${state.hands.length}`;
  }

  // Suit is only for display; input is rank-only.
const suitCursor = { player: 0, dealer: 0, seen: 0 };
function autoSuit(which){
  const i = (suitCursor[which] || 0);
  suitCursor[which] = i + 1;
  return SUITS[i % SUITS.length];
}
function pickToCard(which, pick){
  if(pick.kind !== "rank") return null;
  return { rank: pick.value, suit: autoSuit(which) };
}

  function broadcastHostHands(){
    if(state.mode === "multi" && rtReady) rtBroadcast({ hands: state.hands, hmeta: state.hmeta, activeHand: state.activeHand }, "host");
  }

  function addCardTo(listName, card){
    // Auto-extend shoe when depleted.
    // If the requested rank has no remaining copies, we add +1 (or more) full decks.
    const added = ensureShoeHasRank(card.rank);
    if(added > 0){
      showToast(`Elfogyott a lap → +${added} pakli (össz: ${shoeDecks()})`);
      // Keep all clients consistent.
      if(state.mode === "multi" && rtReady){
        rtBroadcast({ rules: state.rules }, "any");
      }
    }
    if(listName === "player"){
      ensureHands();
      // auto-start round bet on first player card (so DOUBLE/SPLIT affordability is correct)
      if(!bank.inRound){
        const roundBetEl = $("roundBet");
        let b = roundBetEl ? clampMoney(roundBetEl.value) : 0;
        if(b <= 0) b = calcRecommendedBetNextRound();
        if(roundBetEl) roundBetEl.value = String(b);
        // try start; if fails (too big), fall back to capped recommended
        if(!bankStartRound(b)){
          const b2 = calcRecommendedBetNextRound();
          if(b2>0 && b2 !== b){
            if(roundBetEl) roundBetEl.value = String(b2);
            bankStartRound(b2);
          }
        }
      }
      activeHand().push(card);
      persist();
      renderAll();
      broadcastHostHands();
      return;
    }
    state[listName].push(card);
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      if(listName === "dealer") rtBroadcast({ dealer: state.dealer }, "dealer");
      else if(listName === "seen") rtBroadcast({ seen: state.seen }, "any");
    }
  }

  function removeCardFrom(listName, idx){
    if(listName === "player"){
      ensureHands();
      activeHand().splice(idx, 1);
      persist();
      renderAll();
      broadcastHostHands();
      return;
    }
    state[listName].splice(idx, 1);
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      if(listName === "dealer") rtBroadcast({ dealer: state.dealer }, "dealer");
      else if(listName === "seen") rtBroadcast({ seen: state.seen }, "any");
    }
  }

  function clearList(listName){
    if(listName === "player"){
      ensureHands();
      state.hands[state.activeHand] = [];
      persist();
      renderAll();
      broadcastHostHands();
      return;
    }
    state[listName] = [];
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      const patch = {}; patch[listName] = [];
      rtBroadcast(patch, listName==="dealer"?"dealer":"any");
    }
  }

  function compute(){
    normalizeShoeDecks();
    const decks = shoeDecks();
    ensureHands();
    const dealt = [...state.seen, ...allPlayerCards(), ...state.dealer];
    const rc = window.BJCount.runningCount(dealt);
    const rem = window.BJCount.remainingFromSeen(decks, dealt.length);
    const tc = window.BJCount.trueCount(rc, rem.remainingDecks);

    // Bet recommendation should be for the NEXT ROUND (before dealing): use shoe-only cards.
    const rcShoe = window.BJCount.runningCount(state.seen);
    const remShoe = window.BJCount.remainingFromSeen(decks, state.seen.length);
    const tcShoe = window.BJCount.trueCount(rcShoe, remShoe.remainingDecks);
    const unitsRaw = betUnitsFromTC(tcShoe);
    const cap = Math.max(1, parseInt(betSettings.cap,10) || 6);
    const units = Math.min(cap, Math.max(1, unitsRaw));
    const base = Math.max(0, parseFloat(betSettings.base) || 0);
    let bet = roundDown(base * units, betSettings.round);

    // Bankroll-aware cap (optional): ensure suggested bet fits your bankroll reserve so DOUBLE/SPLIT is affordable.
    let betCapInfo = '';
    try{
      const capOn = !!bankSettings.capToBankroll;
      if(capOn){
        const totBank = bankTotal();
        const factor = exposureFactor();
        const maxBet = roundDown(Math.floor(totBank / factor), betSettings.round);
        if(Number.isFinite(maxBet) && maxBet >= 0){
          if(bet > maxBet){
            betCapInfo = ' • bankroll cap: ' + maxBet.toLocaleString('hu-HU') + ' (/' + factor + 'x)';
            bet = maxBet;
          } else {
            betCapInfo = ' • bankroll ok (/' + factor + 'x)';
          }
        }
      }
    }catch(_e){}

    $("rcOut").textContent = String(rc);
    $("tcOut").textContent = tc.toFixed(2);
    $("remCardsOut").textContent = String(rem.remainingCards);
    $("remDecksOut").textContent = rem.remainingDecks.toFixed(2);

    // Bet UI
    if($("betOut")){
      $("betOut").textContent = bet ? `${bet.toLocaleString('hu-HU')}  (${units}u)` : `0  (${units}u)`;
    }
    if($("betMeta")){
      $("betMeta").textContent = `shoe RC: ${rcShoe} • shoe TC: ${tcShoe.toFixed(2)} • cap: ${cap}u • shoe pakli: ${shoeDecks()} (alap: ${baseDecks()})${betCapInfo} • bankroll total: ${bankTotal().toLocaleString('hu-HU')}`;
    }

    const pTotal = window.BJStrategy.handTotal(activeHand());
    $("playerTotal").textContent = `Total: ${pTotal.total} (${pTotal.soft ? "soft" : "hard"})`;
    const dUp = state.dealer[0] ? `${state.dealer[0].rank}${state.dealer[0].suit}` : "—";
    $("dealerTotal").textContent = `Dealer up: ${dUp} • lapok: ${state.dealer.length}`;

    const devUl = $("devList");
    devUl.innerHTML = "";
    for(const d of window.BJStrategy.deviations){
      const li = document.createElement("li");
      if(!d.action){
        li.textContent = `Insurance: TC ≥ +3 → IGEN`;
      } else {
        li.textContent = `${d.label}: TC ≥ +${d.thresh} → ${d.action}`;
      }
      devUl.appendChild(li);
    }

    const rules = {
      dealer17: state.rules.dealer17,
      bjPay: state.rules.bjPay,
      surrender: state.rules.surrender,
      doubleRule: state.rules.doubleRule,
      doubleCustom: state.rules.doubleCustom || "",
      DAS: !!state.rules.DAS,
      maxHands: parseInt(state.rules.maxHands,10) || 4,
      splitA: state.rules.splitA,
      resplitA: !!state.rules.resplitA,
      peek: !!state.rules.peek
    };

    const baseRec = window.BJStrategy.recommend(activeHand(), state.dealer, rules, tc);
    let rec = { ...baseRec, _provisional: false };

    // EV-solver: exact EV from remaining shoe (decision-time info: dealer upcard only)
    const useSolverEl = $("useSolver");
    const solverOn = !!solverSettings.enabled && (!useSolverEl || !!useSolverEl.checked);
    const solverStatusEl = $("solverStatus");
    const evOutEl = $("evOut");
    const evHintEl = $("evHint");

    if(solverOn && state.dealer && state.dealer[0] && activeHand().length){
      const payload = {
        counts: buildRemainingCounts(decks),
        playerRanks: activeHand().map(c=>c.rank),
        dealerUpRank: state.dealer[0].rank,
        rules,
        fromSplit: !!(state.hmeta && state.hmeta[state.activeHand] && state.hmeta[state.activeHand].fromSplit),
        handsUsed: state.hands.length,
        nodeLimit: solverSettings.nodeLimit
      };
      const key = evKey(payload);
      let evRes = evCache.get(key);
      if(!evRes) evRes = requestEV(payload);

      if(evRes && evRes.ok){
        const mode = evRes.exact ? "EXACT" : "APPROX";
        const evLines = formatEVList(evRes.evs);
        let bestAction = evRes.best;
        let bankrollNote = '';

        // If bankroll is tracked and a bet is already on the table, filter out actions you cannot afford now.
        try{
          if(bank.inRound){
            const aIdx = state.activeHand;
            const needDouble = clampMoney(bank.stakes[aIdx]||0);
            const canAffordDouble = needDouble>0 && clampMoney(bank.balance) >= needDouble;
            const canAffordSplit = (clampMoney(bank.balance) >= clampMoney(bank.baseBet||0)) && (state.hands.length < (parseInt(state.rules.maxHands,10)||4));

            const affordable = (a)=>{
              if(a === 'DOUBLE') return canAffordDouble;
              if(a === 'SPLIT') return canAffordSplit;
              return true;
            };

            if(!affordable(bestAction) && evRes.evs){
              // pick best affordable EV
              let best = null;
              let bestEv = -1e9;
              for(const [act, ev] of Object.entries(evRes.evs)){
                if(!affordable(act)) continue;
                if(typeof ev !== 'number') continue;
                if(ev > bestEv){ bestEv = ev; best = act; }
              }
              if(best){
                bankrollNote = `

⚠ Bankroll limit: ${bestAction} nem fér bele most → ${best}`;
                bestAction = best;
              }
            }
          }
        }catch(_e){}

        rec.action = bestAction;
        rec.title = `AJÁNLÁS: ${bestAction}`;
        rec.detail =
          `EV-solver: ${mode} • nodes: ${evRes.nodes||0}${evRes.note?` • ${evRes.note}`:""}\n` +
          `${evLines || "—"}\n\n` +
          `Basic (tábla) összevetés: ${baseRec.action || "—"}\n` +
          `${baseRec.detail || ""}` + bankrollNote;

        if(solverStatusEl) solverStatusEl.textContent = `${mode.toLowerCase()} • ${evRes.nodes||0}`;
        if(evOutEl) evOutEl.textContent = evLines || "—";
        if(evHintEl) evHintEl.textContent = `(${mode.toLowerCase()})`;
        rec._provisional = false;
      } else if(evRes && evRes.ok === false){
        rec._provisional = true;
        if(solverStatusEl) solverStatusEl.textContent = "hiba";
        if(evOutEl) evOutEl.textContent = (evRes.error || "solver error");
        if(evHintEl) evHintEl.textContent = "";
      } else {
        rec._provisional = true;
        if(solverStatusEl) solverStatusEl.textContent = (evPendingKey === key) ? "számol…" : "—";
        if(evOutEl) evOutEl.textContent = "számol…";
        if(evHintEl) evHintEl.textContent = "";
      }
    } else {
      if(solverStatusEl) solverStatusEl.textContent = solverOn ? "add lapot…" : "off";
      if(evOutEl) evOutEl.textContent = "—";
      if(evHintEl) evHintEl.textContent = "";
    }

    const box = $("recBox");
    box.querySelector(".recTitle").textContent = rec.title || "—";
    $("recDetail").textContent = rec.detail || "—";
    const t = rec.action;
    box.style.borderColor = t==="STAND" || t==="DOUBLE" || t==="SPLIT" ? "rgba(44,217,123,.35)" :
      t==="HIT" ? "rgba(255,211,107,.35)" :
      t==="SURRENDER" ? "rgba(255,77,77,.35)" : "rgba(255,255,255,.12)";

    return { rc, tc, rem, rec, bet, units, tcShoe };
  }

  function renderAll(){
    renderRole();

    renderHandTabs();
    renderHand("playerHand", activeHand(), canEditPlayer(), (idx)=>removeCardFrom("player", idx));
    renderHand("dealerHand", state.dealer, canEditDealer(), (idx)=>removeCardFrom("dealer", idx));

    $("seenCount").textContent = String(state.seen.length);
    const seenWrap = $("seenList");
    seenWrap.innerHTML = "";
    state.seen.forEach((c, idx)=>{
      seenWrap.appendChild(cardChip(c, ()=>removeCardFrom("seen", idx), true));
    });    // rules UI
    $("ruleDecks").value = String(state.rules.decks);
    $("ruleDealer17").value = state.rules.dealer17;
    $("ruleBjPay").value = state.rules.bjPay;
    $("ruleSurrender").value = state.rules.surrender;
    $("ruleDouble").value = state.rules.doubleRule;
    if($("ruleDoubleCustom")) $("ruleDoubleCustom").value = state.rules.doubleCustom || "";
    if($("doubleCustomWrap")) $("doubleCustomWrap").style.display = (state.rules.doubleRule === "custom") ? "block" : "none";

    $("ruleDAS").value = state.rules.DAS ? "on" : "off";
    $("ruleMaxHands").value = String(state.rules.maxHands);
    $("ruleSplitA").value = state.rules.splitA;
    if($("ruleResplitA")) $("ruleResplitA").value = state.rules.resplitA ? "on" : "off";
    if($("rulePeek")) $("rulePeek").value = state.rules.peek ? "on" : "off";

    // bet UI (local)
    if($("betBase")) $("betBase").value = String(betSettings.base ?? 0);
    if($("betRamp")) $("betRamp").value = betSettings.ramp || "1-6";
    if($("betCustom")) $("betCustom").value = betSettings.custom || "";
    if($("betCap")) $("betCap").value = String(betSettings.cap ?? 6);
    if($("betRound")) $("betRound").value = String(betSettings.round ?? 0);
    if($("betCustomWrap")) $("betCustomWrap").style.display = (betSettings.ramp === "custom") ? "block" : "none";
    // bankroll UI (local)
    if($("bankStart")) $("bankStart").value = String(bank.start ?? 0);
    if($("roundBet")) $("roundBet").value = String(bank.inRound ? (bank.baseBet ?? 0) : (clampMoney($("roundBet").value) || 0));
    if($("reserveMode")) $("reserveMode").value = bankSettings.reserveMode || '4';
    if($("bankCap")) $("bankCap").value = bankSettings.capToBankroll ? 'on' : 'off';
    updateBankUI();
    // reflect per-hand markers on buttons
    try{
      ensureBankArrays();
      const i = state.activeHand;
      const bd = $("btnToggleDouble");
      if(bd) bd.textContent = bank.doubled[i] ? "Double ✓" : "Double";
      const bs = $("btnToggleSurrender");
      if(bs) bs.textContent = bank.surrendered[i] ? "Surrender ✓" : "Surrender";
    }catch(_e){}

    compute();
    persist();
  }

  function applyRulesFromUI(){
    const newBase = parseInt($("ruleDecks").value,10);
    state.rules.decks = newBase;
    // When user changes deck count, treat it as a new shoe configuration.
    state.rules.shoeDecks = Number.isFinite(newBase) && newBase > 0 ? newBase : 6;
    state.rules.dealer17 = $("ruleDealer17").value;
    state.rules.bjPay = $("ruleBjPay").value;
    state.rules.surrender = $("ruleSurrender").value;
    state.rules.doubleRule = $("ruleDouble").value;
    state.rules.DAS = $("ruleDAS").value === "on";
    state.rules.maxHands = parseInt($("ruleMaxHands").value,10);
    state.rules.splitA = $("ruleSplitA").value;
    state.rules.resplitA = $("ruleResplitA") ? ($("ruleResplitA").value === "on") : !!state.rules.resplitA;
    state.rules.peek = $("rulePeek") ? ($("rulePeek").value === "on") : !!state.rules.peek;
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      rtBroadcast({ rules: state.rules }, "any");
    }
  }

  function applyAuto(){
    const { rec, tc, bet, units, tcShoe } = compute();
    if(!rec.action){ showToast("Nincs ajánlás"); return; }
    showToast(`Ajánlott: ${rec.action}`);
    openModal("AUTO", `Ajánlott lépés: ${rec.action}\n\n${rec.detail}\n\nTC (aktuális döntéshez): ${tc.toFixed(2)}\nAjánlott tét (köv. kör): ${bet}  (${units}u) • shoe TC: ${tcShoe.toFixed(2)}\n\nMegjegyzés: basic strategy + TC deviációk. A nyerő/vesztő széria normális (variancia).`);
  }

  function exportState(){
    const pack = {
      v: state.v,
      rules: state.rules,
      hands: state.hands,
      hmeta: state.hmeta,
      activeHand: state.activeHand,
      dealer: state.dealer,
      seen: state.seen
    };
    return JSON.stringify(pack);
  }
  function importState(raw){
    const obj = JSON.parse(raw);
    if(obj.rules) state.rules = { ...state.rules, ...obj.rules };
    if(Array.isArray(obj.hands)) state.hands = obj.hands;
    if(Array.isArray(obj.hmeta)) state.hmeta = obj.hmeta;
    else if(Array.isArray(obj.player)) state.hands = [obj.player]; // backward compat
    if(typeof obj.activeHand === "number") state.activeHand = obj.activeHand;
    if(Array.isArray(obj.dealer)) state.dealer = obj.dealer;
    if(Array.isArray(obj.seen)) state.seen = obj.seen;
    // ensure shoeDecks is consistent with imported cards
    normalizeShoeDecks();
    renderAll();
  }

  let __bj_inited = false;

  function init(){
    if(__bj_inited) return;
    __bj_inited = true;
    loadPersist();
    loadBetSettings();
    loadSolverSettings();
    loadBank();

    const h = parseHash();
    state.mode = (h.mode === "multi") ? "multi" : "single";
    state.roomId = (h.room || "").toUpperCase();
    state.roleWanted = h.role || null;
    state.role = state.mode === "single" ? "single" : (state.roleWanted || "host");

    $("modeLine").textContent = state.mode === "multi"
      ? "Multiplayer: Host = player lapok • Dealer = dealer lapok (realtime opcionális)"
      : "Single-player: mindent te állítasz";

    if(state.roomId) $("roomId").value = state.roomId;

    makePicker($("playerPicker"), (pick)=>{
      if(!canEditPlayer()) return showToast("Player locked");
      const card = pickToCard("player", pick);
      if(card) addCardTo("player", card);
    });
    makePicker($("dealerPicker"), (pick)=>{
      if(!canEditDealer()) return showToast("Dealer locked");
      const card = pickToCard("dealer", pick);
      if(card){
        addCardTo("dealer", card);
      }
    });
    makePicker($("seenPicker"), (pick)=>{
      const card = pickToCard("seen", pick);
      if(card) addCardTo("seen", card);
    });

    $("btnPlayerClear").addEventListener("click", ()=>{ if(canEditPlayer()) clearList("player"); });
    $("btnDealerClear").addEventListener("click", ()=>{ if(canEditDealer()) clearList("dealer"); });
    $("btnSeenClear").addEventListener("click", ()=> clearList("seen"));

    // Multi-hand controls
    $("btnSplitHand").addEventListener("click", ()=>{
      if(!canEditPlayer()) return showToast("Player locked");
      ensureHands();
      const maxHands = parseInt(state.rules.maxHands, 10) || 4;
      if(state.hands.length >= maxHands){
        return showToast(`Max hands elérve (${maxHands})`);
      }
      const hIdx = state.activeHand;
      const h = activeHand();
      let newHand = [];
      let realSplit = false;
      let movedCard = null;
      // If it's a real pair on exactly 2 cards, move one card to the new hand (real split feel)
      if(h.length === 2 && String(h[0].rank) === String(h[1].rank)){
        movedCard = h.pop();
        newHand = [movedCard];
        realSplit = true;
      }
      state.hands.push(newHand);
      // bankroll: if round already started, new split hand needs an extra bet
      if(bank.inRound){
        if(!bankAddHandStake()){
          // undo hand creation
          state.hands.pop();
          if(movedCard){ h.push(movedCard); movedCard = null; }
          showToast("Nincs fedezet SPLIT-re");
          renderAll();
          return;
        }
      }
      // keep metadata in sync
      if(!Array.isArray(state.hmeta)) state.hmeta = [];
      // new hand meta: fromSplit only if it was a real split
      state.hmeta.push({ fromSplit: realSplit ? true : false });
      // current hand becomes a split hand too if real split
      if(realSplit && state.hmeta[hIdx]) state.hmeta[hIdx].fromSplit = true;

      state.activeHand = state.hands.length - 1;
      persist();
      renderAll();
      broadcastHostHands();
      showToast(realSplit ? "Split: új kéz" : "Új kéz létrehozva");
    });

    $("btnRemoveHand").addEventListener("click", ()=>{
      if(!canEditPlayer()) return showToast("Player locked");
      ensureHands();
      if(state.hands.length <= 1){
        return showToast("Minimum 1 kéz kell");
      }
      const h = activeHand();
      if(h.length){
        return showToast("Előbb töröld az aktív kéz lapjait");
      }
      bankRemoveHandStake(state.activeHand);
      state.hands.splice(state.activeHand, 1);
      if(Array.isArray(state.hmeta)) state.hmeta.splice(state.activeHand, 1);
      if(state.activeHand >= state.hands.length) state.activeHand = state.hands.length - 1;
      persist();
      renderAll();
      broadcastHostHands();
      showToast("Kéz törölve");
    });

    // Per-hand action markers (local bankroll model)
    const btnTD = $("btnToggleDouble");
    if(btnTD){
      btnTD.addEventListener("click", ()=>{
        if(!canEditPlayer()) return showToast("Player locked");
        bankToggleDouble(state.activeHand);
        renderAll();
        broadcastHostHands();
      });
    }
    const btnTS = $("btnToggleSurrender");
    if(btnTS){
      btnTS.addEventListener("click", ()=>{
        if(!canEditPlayer()) return showToast("Player locked");
        bankToggleSurrender(state.activeHand);
        renderAll();
        broadcastHostHands();
      });
    }

    $("btnNewRound").addEventListener("click", ()=>{
  // Multiplayer: only Host can finalize a round (avoids race)
  if(state.mode === "multi" && state.role !== "host"){
    showToast("Csak a HOST indíthatja a következő kört");
    return;
  }

  const toMove = [...allPlayerCards(), ...state.dealer];

  // If a bet is active, resolve bankroll first.
  if(bank.inRound){
    if(toMove.length === 0){
      bankRefundAll();
      showToast("Kör törölve (nincs lap)");
    } else {
      const res = resolvePayouts();
      if(!res.ok){
        showToast(res.msg || "Nem tudom lezárni a kört");
        openModal("Nem zárható le", res.msg || "Adj meg több infot");
        return;
      }
      const sign = res.net >= 0 ? "+" : "";
      openModal(
        "Kör összegzés",
        "Net: " + sign + res.net.toLocaleString('hu-HU') + "\n" +
        "Before: " + res.beforeTotal.toLocaleString('hu-HU') + "\n" +
        "After: " + res.afterTotal.toLocaleString('hu-HU') + "\n\n" +
        res.lines.join("\n")
      );
    }
  }

  if(toMove.length === 0){
    showToast("Nincs mit menteni (adj meg lapokat)");
    return;
  }

  state.seen.push(...toMove);
  state.hands = [[]];
  state.hmeta = [{ fromSplit: false }];
  state.activeHand = 0;
  state.dealer = [];

  // After moving cards, round is over.
  bank.inRound = false;
  bank.baseBet = 0;
  bank.stakes = [0];
  bank.doubled = [false];
  bank.surrendered = [false];
  saveBank();

  persist();
  renderAll();

  if(state.mode === "multi" && rtReady){
    rtBroadcast({ seen: state.seen }, "any");
    rtBroadcast({ hands: state.hands, hmeta: state.hmeta, activeHand: state.activeHand }, "host");
    rtBroadcast({ dealer: state.dealer }, "dealer");
  }
  showToast("Következő kör ✓ (kör mentve a shoe-ba)");
});
    $("btnResetShoe").addEventListener("click", ()=>{
      state.seen = [];
      // Reset shoe capacity back to base decks
      state.rules.shoeDecks = baseDecks();
      renderAll();
      if(state.mode === "multi" && rtReady) rtBroadcast({ seen: [], rules: state.rules }, "any");
      showToast("Cipő reset");
    });
$("btnAuto").addEventListener("click", applyAuto);
    $("btnExplain").addEventListener("click", ()=>{
      const { rec, tc, bet, units, tcShoe } = compute();
      openModal("Miért ez?", `${rec.title}\n\n${rec.detail}\n\nTC (aktuális döntéshez): ${tc.toFixed(2)}\nAjánlott tét (köv. kör): ${bet}  (${units}u) • shoe TC: ${tcShoe.toFixed(2)}\n\nMegjegyzés: basic strategy + TC deviációk.`);
    });

    ["ruleDecks","ruleDealer17","ruleBjPay","rulePeek","ruleSurrender","ruleDouble","ruleDAS","ruleMaxHands","ruleSplitA","ruleResplitA"]
      .forEach(id => $(id).addEventListener("change", applyRulesFromUI));

    // Presets (BJA-style common rules)
    const applyPreset = (dealer17) => {
      $("ruleDealer17").value = dealer17;
      $("ruleBjPay").value = "3:2";
      $("ruleSurrender").value = "late";
      $("ruleDouble").value = "any";
      if($("ruleDoubleCustom")) $("ruleDoubleCustom").value = "";
      $("ruleDAS").value = "on";
      $("ruleSplitA").value = "one";
      if($("rulePeek")) $("rulePeek").value = "on";
      if($("ruleResplitA")) $("ruleResplitA").value = "off";
      // leave decks as-is (user might be on 6 or 8), but if empty set to 6
      if(!$("ruleDecks").value) $("ruleDecks").value = "6";
      applyRulesFromUI();
      showToast(`Preset betöltve: ${dealer17} • 3:2 • late surrender • Double ANY • DAS on`);
    };
    const pH17 = document.getElementById("presetH17");
    const pS17 = document.getElementById("presetS17");
    if(pH17) pH17.addEventListener("click", ()=>applyPreset("H17"));
    if(pS17) pS17.addEventListener("click", ()=>applyPreset("S17"));

    // Bet UI (local-only)
    const syncBetCustomUI = ()=>{
      const wrap = $("betCustomWrap");
      if(wrap) wrap.style.display = (betSettings.ramp === "custom") ? "block" : "none";
    };

    if($("betBase")){
      $("betBase").addEventListener("input", ()=>{
        betSettings.base = Math.max(0, parseFloat($("betBase").value) || 0);
        saveBetSettings();
        renderAll();
      });
    }
    if($("betRamp")){
      $("betRamp").addEventListener("change", ()=>{
        betSettings.ramp = $("betRamp").value;
        // default cap based on ramp
        if(betSettings.ramp === "1-10" && (betSettings.cap === 6 || !betSettings.cap)) betSettings.cap = 10;
        if(betSettings.ramp === "1-6" && (betSettings.cap === 10 || !betSettings.cap)) betSettings.cap = 6;
        saveBetSettings();
        syncBetCustomUI();
        renderAll();
      });
    }
    if($("betCustom")){
      $("betCustom").addEventListener("input", ()=>{
        betSettings.custom = $("betCustom").value;
        saveBetSettings();
        renderAll();
      });
    }
    if($("betCap")){
      $("betCap").addEventListener("input", ()=>{
        betSettings.cap = Math.max(1, parseInt($("betCap").value,10) || 1);
        saveBetSettings();
        renderAll();
      });
    }
    if($("betRound")){
      $("betRound").addEventListener("change", ()=>{
        betSettings.round = parseInt($("betRound").value,10) || 0;
        saveBetSettings();
        renderAll();
      });
    }

    // Bankroll UI (local-only)
    const bankStartEl = $("bankStart");
    const roundBetEl = $("roundBet");
    const reserveModeEl = $("reserveMode");
    const bankCapEl = $("bankCap");

    // restore draft round bet
    try{
      const d = localStorage.getItem('bj_round_bet_draft');
      if(roundBetEl && d) roundBetEl.value = String(clampMoney(d));
    }catch(_e){}

    if(bankStartEl) bankStartEl.value = String(bank.start ?? 0);
    updateBankUI();

    const btnBankSet = $("btnBankSet");
    if(btnBankSet){
      btnBankSet.addEventListener('click', ()=>{
        const v = bankStartEl ? bankStartEl.value : 0;
        bankSetStart(v);
        renderAll();
        showToast('Bankroll beállítva');
      });
    }

    const btnBankReset = $("btnBankReset");
    if(btnBankReset){
      btnBankReset.addEventListener('click', ()=>{
        bankSetStart(bank.start);
        renderAll();
        showToast('Bankroll reset');
      });
    }

    const btnUseRecBet = $("btnUseRecBet");
    if(btnUseRecBet){
      btnUseRecBet.addEventListener('click', ()=>{
        const r = compute();
        if(roundBetEl) roundBetEl.value = String(clampMoney(r.bet||0));
        try{ localStorage.setItem('bj_round_bet_draft', String(clampMoney(r.bet||0))); }catch(_e){}
        showToast('Fogadás = ajánlott');
      });
    }

    const btnStartRound = $("btnStartRound");
    if(btnStartRound){
      btnStartRound.addEventListener('click', ()=>{
        const v = roundBetEl ? clampMoney(roundBetEl.value) : 0;
        const bet = v>0 ? v : clampMoney(compute().bet||0);
        if(roundBetEl) roundBetEl.value = String(bet);
        try{ localStorage.setItem('bj_round_bet_draft', String(bet)); }catch(_e){}
        bankStartRound(bet);
        renderAll();
      });
    }

    const btnCancelRound = $("btnCancelRound");
    if(btnCancelRound){
      btnCancelRound.addEventListener('click', ()=>{
        bankRefundAll();
        renderAll();
        showToast('Kör törölve (refund)');
      });
    }

    if(roundBetEl){
      roundBetEl.addEventListener('input', ()=>{
        try{ localStorage.setItem('bj_round_bet_draft', String(clampMoney(roundBetEl.value))); }catch(_e){}
      });
    }

    if(reserveModeEl){
      reserveModeEl.value = bankSettings.reserveMode || '4';
      reserveModeEl.addEventListener('change', ()=>{
        bankSettings.reserveMode = reserveModeEl.value;
        saveBank();
        renderAll();
      });
    }

    if(bankCapEl){
      bankCapEl.value = bankSettings.capToBankroll ? 'on' : 'off';
      bankCapEl.addEventListener('change', ()=>{
        bankSettings.capToBankroll = (bankCapEl.value === 'on');
        saveBank();
        renderAll();
      });
    }


    // EV-solver UI
    const useSolver = $("useSolver");
    if(useSolver){
      useSolver.checked = !!solverSettings.enabled;
      useSolver.addEventListener("change", ()=>{
        solverSettings.enabled = !!useSolver.checked;
        saveSolverSettings();
        // clear pending so it recalculates
        evPendingKey = null;
        renderAll();
      });
    }

    // Double custom UI
    const syncDoubleCustomUI = ()=>{
      const mode = $("ruleDouble").value;
      const wrap = $("doubleCustomWrap");
      if(wrap) wrap.style.display = (mode === "custom") ? "block" : "none";
    };
    syncDoubleCustomUI();
    $("ruleDouble").addEventListener("change", syncDoubleCustomUI);
    const dci = $("ruleDoubleCustom");
    if(dci){
      dci.addEventListener("input", ()=>{
        state.rules.doubleCustom = dci.value;
        persist();
        renderAll();
        if(state.mode === "multi" && rtReady) rtBroadcast({ rules: state.rules }, "any");
      });
    }


    function renderLinks(){
      const baseUrl = location.href.split("#")[0].replace(/room\.html.*$/,"room.html");
      const host = `${baseUrl}#mode=multi&room=${state.roomId}&role=host`;
      const dealer = `${baseUrl}#mode=multi&room=${state.roomId}&role=dealer`;
      $("hostLink").textContent = host;
      $("dealerLink").textContent = dealer;
    }

    $("btnCreateRoom").addEventListener("click", ()=>{
      const id = randId(6);
      state.roomId = id;
      $("roomId").value = id;
      state.mode = "multi";
      state.roleWanted = "host";
      state.role = "host";
      setHash({ mode:"multi", room:id, role:"host" });
      renderLinks();
      renderAll();
      showToast("Room created");
    });
    $("btnJoinRoom").addEventListener("click", ()=>{
      const id = ($("roomId").value||"").trim().toUpperCase();
      if(!id) return showToast("Adj meg Room ID-t");
      state.roomId = id;
      state.mode = "multi";
      state.roleWanted = state.roleWanted || "dealer";
      state.role = state.roleWanted;
      setHash({ mode:"multi", room:id, role: state.roleWanted });
      renderLinks();
      renderAll();
      showToast("Joined (offline until connect)");
    });

    $("btnCopyHost").addEventListener("click", async ()=>{
      const txt = $("hostLink").textContent;
      try{ await navigator.clipboard.writeText(txt); showToast("Host link másolva"); }
      catch(_e){ showToast("Másolás nem engedett (nyisd HTTPS-en vagy localhoston)"); }
    });
    $("btnCopyDealer").addEventListener("click", async ()=>{
      const txt = $("dealerLink").textContent;
      try{ await navigator.clipboard.writeText(txt); showToast("Dealer link másolva"); }
      catch(_e){ showToast("Másolás nem engedett (nyisd HTTPS-en vagy localhoston)"); }
    });

    $("btnCopyState").addEventListener("click", async ()=>{
      const txt = exportState();
      $("stateArea").value = txt;
      try{ await navigator.clipboard.writeText(txt); }catch(_e){}
      showToast("State kimásolva");
    });
    $("btnPasteState").addEventListener("click", ()=>{
      const txt = $("stateArea").value.trim();
      if(!txt) return showToast("Nincs mit beilleszteni");
      try{ importState(txt); showToast("State betöltve"); }catch(_e){ showToast("Hibás JSON"); }
    });

    // Supabase
    const cfg = getSbConfig();
    $("sbUrl").value = cfg.url;
    $("sbKey").value = cfg.key;
    $("btnSbSave").addEventListener("click", ()=>{
      setSbConfig($("sbUrl").value.trim(), $("sbKey").value.trim());
      showToast("Mentve");
    });
    $("btnSbConnect").addEventListener("click", async ()=>{
      const id = ($("roomId").value||"").trim().toUpperCase();
      if(id) state.roomId = id;
      if(!state.roomId) return showToast("Adj meg Room ID-t");
      state.mode = "multi";
      setHash({ mode:"multi", room: state.roomId, role: state.roleWanted || "dealer" });
      renderLinks();
      renderAll();
      await rtConnect();
    });

    renderLinks();
    renderAll();

    // Auto-connect Realtime if room is multi and config is present
    try{
      const cfg2 = getSbConfig();
      if(state.mode === 'multi' && state.roomId && cfg2.url && cfg2.key){
        rtConnect();
      }
    }catch(_e){}
  }
  document.addEventListener("DOMContentLoaded", init);
})();
