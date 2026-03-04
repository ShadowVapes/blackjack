
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
        dealer17: "S17",
        bjPay: "3:2",
        surrender: "late",
        doubleRule: "any",
        doubleCustom: "",
        DAS: true,
        maxHands: 4,
        splitA: "one" },
      hands: [[]],
      activeHand: 0,
      dealer: [],
      seen: [] };
  }

  let state = defaultState();

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

  function rtStatus(text){ $("rtStatus").textContent = text; }

  function getSbConfig(){
    return {
      url: localStorage.getItem("bj_sb_url") || "",
      key: localStorage.getItem("bj_sb_key") || ""
    };
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

    if(Array.isArray(partial.seen)) state.seen = partial.seen;
  }

  async function rtConnect(){
    const {url,key} = getSbConfig();
    if(!url || !key){
      showToast("Supabase kulcs hiányzik – offline mód");
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
        config: { presence: { key: randId(10) } }
      });

      sbChannel
        .on("broadcast", { event: "patch" }, (payload)=>{
          const msg = payload.payload || {};
          mergePartial(msg.patch || {}, msg.role || "any");
          renderAll();
        })
        .on("presence", { event: "sync" }, ()=>{
          presence = sbChannel.presenceState() || {};
          updateRoleFromPresence();
        });

      await sbChannel.subscribe(async (status)=>{
        if(status === "SUBSCRIBED"){
          rtReady = true;
          rtStatus("online");
          await sbChannel.track({ role: state.role, ts: Date.now() });

          // Send initial patches
          if(state.role === "host"){
            rtBroadcast({ hands: state.hands, activeHand: state.activeHand, rules: state.rules, seen: state.seen }, "host");
          } else if(state.role === "dealer"){
            rtBroadcast({ dealer: state.dealer }, "dealer");
          } else {
            rtBroadcast({ rules: state.rules, seen: state.seen }, "any");
          }
        }
      });
    }catch(e){
      console.error(e);
      rtStatus("offline");
      showToast("Realtime hiba – offline");
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
      payload: { role, patch }
    });
  }

  function updateRoleFromPresence(){
    if(state.mode !== "multi") return;
    let roles = [];
    for(const k of Object.keys(presence)){
      const arr = presence[k];
      if(Array.isArray(arr)){
        for(const p of arr){
          if(p && p.role) roles.push(p.role);
        }
      }
    }
    const want = state.roleWanted;
    const hostTaken = roles.includes("host");
    const dealerTaken = roles.includes("dealer");

    let newRole = state.role;
    if(want === "host" && !hostTaken) newRole = "host";
    else if(want === "dealer" && !dealerTaken) newRole = "dealer";
    else if(!hostTaken) newRole = "host";
    else if(!dealerTaken) newRole = "dealer";
    else newRole = "spectator";

    if(newRole !== state.role){
      state.role = newRole;
      renderRole();
      try{ sbChannel.track({ role: state.role, ts: Date.now() }); }catch(_e){}
    }
  }

  // ---- UI helpers ----

  function ensureHands(){
    if(!Array.isArray(state.hands) || state.hands.length === 0) state.hands = [[]];
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
    const tabs = $("handTabs");
    const hint = $("handHint");
    if(!tabs) return;
    tabs.innerHTML = "";
    state.hands.forEach((h, i)=>{
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "handTab" + (i === state.activeHand ? " active" : "");
      const t = window.BJStrategy.handTotal(h);
      const label = h.length ? `H${i+1} (${t.total}${t.soft?"s":""})` : `H${i+1}`;
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
    if(state.mode === "multi" && rtReady) rtBroadcast({ hands: state.hands, activeHand: state.activeHand }, "host");
  }

  function addCardTo(listName, card){
    if(listName === "player"){
      ensureHands();
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
    const decks = parseInt(state.rules.decks,10) || 6;
    ensureHands();
    const dealt = [...state.seen, ...allPlayerCards(), ...state.dealer];
    const rc = window.BJCount.runningCount(dealt);
    const rem = window.BJCount.remainingFromSeen(decks, dealt.length);
    const tc = window.BJCount.trueCount(rc, rem.remainingDecks);

    $("rcOut").textContent = String(rc);
    $("tcOut").textContent = tc.toFixed(2);
    $("remCardsOut").textContent = String(rem.remainingCards);
    $("remDecksOut").textContent = rem.remainingDecks.toFixed(2);

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
      splitA: state.rules.splitA
    };

    const rec = window.BJStrategy.recommend(activeHand(), state.dealer, rules, tc);

    const box = $("recBox");
    box.querySelector(".recTitle").textContent = rec.title || "—";
    $("recDetail").textContent = rec.detail || "—";
    const t = rec.action;
    box.style.borderColor = t==="STAND" || t==="DOUBLE" || t==="SPLIT" ? "rgba(44,217,123,.35)" :
      t==="HIT" ? "rgba(255,211,107,.35)" :
      t==="SURRENDER" ? "rgba(255,77,77,.35)" : "rgba(255,255,255,.12)";

    return { rc, tc, rem, rec };
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

    compute();
    persist();
  }

  function applyRulesFromUI(){
    state.rules.decks = parseInt($("ruleDecks").value,10);
    state.rules.dealer17 = $("ruleDealer17").value;
    state.rules.bjPay = $("ruleBjPay").value;
    state.rules.surrender = $("ruleSurrender").value;
    state.rules.doubleRule = $("ruleDouble").value;
    state.rules.DAS = $("ruleDAS").value === "on";
    state.rules.maxHands = parseInt($("ruleMaxHands").value,10);
    state.rules.splitA = $("ruleSplitA").value;
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      rtBroadcast({ rules: state.rules }, "any");
    }
  }

  function applyAuto(){
    const { rec, tc } = compute();
    if(!rec.action){ showToast("Nincs ajánlás"); return; }
    showToast(`Ajánlott: ${rec.action}`);
    openModal("AUTO", `Ajánlott lépés: ${rec.action}\n\n${rec.detail}\n\nTC: ${tc.toFixed(2)}\n\nMegjegyzés: basic strategy + TC deviációk.`);
  }

  function exportState(){
    const pack = {
      v: state.v,
      rules: state.rules,
      hands: state.hands,
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
    else if(Array.isArray(obj.player)) state.hands = [obj.player]; // backward compat
    if(typeof obj.activeHand === "number") state.activeHand = obj.activeHand;
    if(Array.isArray(obj.dealer)) state.dealer = obj.dealer;
    if(Array.isArray(obj.seen)) state.seen = obj.seen;
    renderAll();
  }

  let __bj_inited = false;

  function init(){
    if(__bj_inited) return;
    __bj_inited = true;
    loadPersist();

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
      const h = activeHand();
      let newHand = [];
      // If it's a real pair on exactly 2 cards, move one card to the new hand (real split feel)
      if(h.length === 2 && String(h[0].rank) === String(h[1].rank)){
        newHand = [h.pop()];
      }
      state.hands.push(newHand);
      state.activeHand = state.hands.length - 1;
      persist();
      renderAll();
      broadcastHostHands();
      showToast("Új kéz létrehozva");
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
      state.hands.splice(state.activeHand, 1);
      if(state.activeHand >= state.hands.length) state.activeHand = state.hands.length - 1;
      persist();
      renderAll();
      broadcastHostHands();
      showToast("Kéz törölve");
    });

    $("btnNewRound").addEventListener("click", ()=>{
  // Multiplayer: only Host can finalize a round (avoids race)
  if(state.mode === "multi" && state.role !== "host"){
    showToast("Csak a HOST indíthatja a következő kört");
    return;
  }
  const toMove = [...allPlayerCards(), ...state.dealer];
  if(toMove.length === 0){
    showToast("Nincs mit menteni (adj meg lapokat)");
    return;
  }
  state.seen.push(...toMove);

  state.hands = [[]];
  state.activeHand = 0;
  state.dealer = [];

  persist();
  renderAll();

  if(state.mode === "multi" && rtReady){
    rtBroadcast({ seen: state.seen }, "any");
    rtBroadcast({ hands: state.hands, activeHand: state.activeHand }, "host");
    rtBroadcast({ dealer: state.dealer }, "dealer");
  }
  showToast("Következő kör ✓ (kör mentve a shoe-ba)");
});
    $("btnResetShoe").addEventListener("click", ()=>{
      state.seen = [];
      renderAll();
      if(state.mode === "multi" && rtReady) rtBroadcast({ seen: [] }, "any");
      showToast("Cipő reset");
    });
$("btnAuto").addEventListener("click", applyAuto);
    $("btnExplain").addEventListener("click", ()=>{
      const { rec, tc } = compute();
      openModal("Miért ez?", `${rec.title}\n\n${rec.detail}\n\nTC: ${tc.toFixed(2)}\n\nMegjegyzés: basic strategy + TC deviációk.`);
    });

    ["ruleDecks","ruleDealer17","ruleBjPay","ruleSurrender","ruleDouble","ruleDAS","ruleMaxHands","ruleSplitA"]
      .forEach(id => $(id).addEventListener("change", applyRulesFromUI));

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
  }
  document.addEventListener("DOMContentLoaded", init);
})();
