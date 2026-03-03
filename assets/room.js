
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
        DAS: true,
        maxHands: 4,
        splitA: "one",
      },
      player: [],
      dealer: [],
      showHole: false,
      seen: [],
    };
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
    if(typeof partial.showHole === "boolean") state.showHole = partial.showHole;

    if(source === "host" && partial.player) state.player = partial.player;
    if(source === "dealer" && partial.dealer) state.dealer = partial.dealer;

    if(source === "any"){
      if(partial.player) state.player = partial.player;
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
            rtBroadcast({ player: state.player, rules: state.rules, seen: state.seen, showHole: state.showHole }, "host");
          } else if(state.role === "dealer"){
            rtBroadcast({ dealer: state.dealer, showHole: state.showHole }, "dealer");
          } else {
            rtBroadcast({ rules: state.rules, seen: state.seen, showHole: state.showHole }, "any");
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
  function makePicker(container, onPick){
    container.innerHTML = "";
    for(const r of RANKS){
      const b = document.createElement("button");
      b.className = "pickBtn";
      b.textContent = r;
      b.addEventListener("click", ()=>onPick({ kind:"rank", value:r }));
      container.appendChild(b);
    }
    for(const s of SUITS){
      const b = document.createElement("button");
      b.className = "pickBtn suit " + ((s==="♥"||s==="♦")?"red":"");
      b.textContent = s;
      b.addEventListener("click", ()=>onPick({ kind:"suit", value:s }));
      container.appendChild(b);
    }
  }

  function cardChip(card, onRemove, canEdit){
    const el = document.createElement("div");
    el.className = "cardChip";
    const rank = document.createElement("span"); rank.className="rank"; rank.textContent=card.rank;
    const suit = document.createElement("span"); suit.className="suit"; suit.textContent=card.suit;
    const btn = document.createElement("button"); btn.textContent="×"; btn.title="Remove";
    btn.disabled = !canEdit;
    btn.addEventListener("click", ()=>{ if(canEdit) onRemove(); });
    el.append(rank,suit,btn);
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

  let pickState = {
    player: { rank:null, suit:null },
    dealer: { rank:null, suit:null },
    seen: { rank:null, suit:null },
  };
  function pickToCard(which, pick){
    if(pick.kind === "rank") pickState[which].rank = pick.value;
    if(pick.kind === "suit") pickState[which].suit = pick.value;
    const {rank, suit} = pickState[which];
    if(rank && suit){
      pickState[which] = { rank:null, suit:null };
      return { rank, suit };
    }
    return null;
  }

  function addCardTo(listName, card){
    state[listName].push(card);
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      if(listName === "player") rtBroadcast({ player: state.player }, "host");
      else if(listName === "dealer") rtBroadcast({ dealer: state.dealer, showHole: state.showHole }, "dealer");
      else if(listName === "seen") rtBroadcast({ seen: state.seen }, "any");
    }
  }
  function removeCardFrom(listName, idx){
    state[listName].splice(idx, 1);
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      if(listName === "player") rtBroadcast({ player: state.player }, "host");
      else if(listName === "dealer") rtBroadcast({ dealer: state.dealer, showHole: state.showHole }, "dealer");
      else if(listName === "seen") rtBroadcast({ seen: state.seen }, "any");
    }
  }
  function clearList(listName){
    state[listName] = [];
    persist();
    renderAll();
    if(state.mode === "multi" && rtReady){
      const patch = {}; patch[listName] = [];
      rtBroadcast(patch, listName==="player"?"host": listName==="dealer"?"dealer":"any");
    }
  }

  function compute(){
    const decks = parseInt(state.rules.decks,10) || 6;
    const rc = window.BJCount.runningCount(state.seen);
    const rem = window.BJCount.remainingFromSeen(decks, state.seen.length);
    const tc = window.BJCount.trueCount(rc, rem.remainingDecks);

    $("rcOut").textContent = String(rc);
    $("tcOut").textContent = tc.toFixed(2);
    $("remCardsOut").textContent = String(rem.remainingCards);
    $("remDecksOut").textContent = rem.remainingDecks.toFixed(2);

    const pTotal = window.BJStrategy.handTotal(state.player);
    $("playerTotal").textContent = `Total: ${pTotal.total} (${pTotal.soft ? "soft" : "hard"})`;
    const dUp = state.dealer[0] ? `${state.dealer[0].rank}${state.dealer[0].suit}` : "—";
    $("dealerTotal").textContent = `Upcard: ${dUp}` + (state.showHole && state.dealer[1] ? ` • Hole: ${state.dealer[1].rank}${state.dealer[1].suit}` : "");

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
      DAS: !!state.rules.DAS,
      maxHands: parseInt(state.rules.maxHands,10) || 4,
      splitA: state.rules.splitA
    };

    const rec = window.BJStrategy.recommend(state.player, state.dealer, rules, tc);

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

    renderHand("playerHand", state.player, canEditPlayer(), (idx)=>removeCardFrom("player", idx));
    renderHand("dealerHand", state.dealer, canEditDealer(), (idx)=>removeCardFrom("dealer", idx));

    $("seenCount").textContent = String(state.seen.length);
    const seenWrap = $("seenList");
    seenWrap.innerHTML = "";
    state.seen.forEach((c, idx)=>{
      seenWrap.appendChild(cardChip(c, ()=>removeCardFrom("seen", idx), true));
    });

    $("showHole").checked = !!state.showHole;

    // rules UI
    $("ruleDecks").value = String(state.rules.decks);
    $("ruleDealer17").value = state.rules.dealer17;
    $("ruleBjPay").value = state.rules.bjPay;
    $("ruleSurrender").value = state.rules.surrender;
    $("ruleDouble").value = state.rules.doubleRule;
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
      player: state.player,
      dealer: state.dealer,
      showHole: state.showHole,
      seen: state.seen
    };
    return JSON.stringify(pack);
  }
  function importState(raw){
    const obj = JSON.parse(raw);
    if(obj.rules) state.rules = { ...state.rules, ...obj.rules };
    if(Array.isArray(obj.player)) state.player = obj.player;
    if(Array.isArray(obj.dealer)) state.dealer = obj.dealer;
    if(typeof obj.showHole === "boolean") state.showHole = obj.showHole;
    if(Array.isArray(obj.seen)) state.seen = obj.seen;
    renderAll();
  }

  function init(){
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
        if(state.dealer.length >= (state.showHole ? 2 : 1)){
          showToast("Dealer lap limit (kapcsold be a Hole-t)");
          return;
        }
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

    $("btnNewRound").addEventListener("click", ()=>{
      state.player = [];
      state.dealer = [];
      state.showHole = false;
      renderAll();
      if(state.mode === "multi" && rtReady){
        rtBroadcast({ player: state.player }, "host");
        rtBroadcast({ dealer: state.dealer, showHole:false }, "dealer");
      }
      showToast("Új kör");
    });
    $("btnResetShoe").addEventListener("click", ()=>{
      state.seen = [];
      renderAll();
      if(state.mode === "multi" && rtReady) rtBroadcast({ seen: [] }, "any");
      showToast("Cipő reset");
    });

    $("showHole").addEventListener("change", (e)=>{
      state.showHole = !!e.target.checked;
      if(!state.showHole && state.dealer.length > 1){
        state.dealer = state.dealer.slice(0,1);
      }
      renderAll();
      if(state.mode === "multi" && rtReady) rtBroadcast({ showHole: state.showHole, dealer: state.dealer }, "dealer");
    });

    $("btnAuto").addEventListener("click", applyAuto);
    $("btnExplain").addEventListener("click", ()=>{
      const { rec, tc } = compute();
      openModal("Miért ez?", `${rec.title}\n\n${rec.detail}\n\nTC: ${tc.toFixed(2)}\n\nMegjegyzés: basic strategy + TC deviációk.`);
    });

    ["ruleDecks","ruleDealer17","ruleBjPay","ruleSurrender","ruleDouble","ruleDAS","ruleMaxHands","ruleSplitA"]
      .forEach(id => $(id).addEventListener("change", applyRulesFromUI));

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
      await navigator.clipboard.writeText(txt);
      showToast("Host link másolva");
    });
    $("btnCopyDealer").addEventListener("click", async ()=>{
      const txt = $("dealerLink").textContent;
      await navigator.clipboard.writeText(txt);
      showToast("Dealer link másolva");
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

  window.addEventListener("load", init);
})();
