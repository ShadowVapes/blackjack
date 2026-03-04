/* strategy.js
   Full multi-deck basic strategy table (Hard / Soft / Pairs) + Late Surrender + TC deviations.
   Matches common chart notation:
     H  = Hit
     S  = Stand
     Dh = Double if allowed, otherwise Hit
     Ds = Double if allowed, otherwise Stand
     P  = Split
     Ph = Split if DAS (Double After Split) allowed, otherwise Hit
     Rh = Surrender if allowed, otherwise Hit
     Rs = Surrender if allowed, otherwise Stand
     Rp = Surrender if allowed, otherwise Split

   Notes:
   - "Pairs" require the SAME RANK (e.g., K+Q is NOT a pair).
   - Ten-value bucket ("10") is used for totals/counting, but only after confirming it's a real pair.
*/
(function(){
  const TEN_SET = new Set(["10","J","Q","K"]);

  function rankBucket(rank){ return TEN_SET.has(rank) ? "10" : rank; }
  function cardValue(rank){
    const b = rankBucket(rank);
    if(b==="A") return 11;
    if(b==="10") return 10;
    return parseInt(b, 10);
  }

  function handTotal(cards){
    let total = 0, aces = 0;
    for(const c of cards){
      total += cardValue(c.rank);
      if(rankBucket(c.rank)==="A") aces++;
    }
    while(total>21 && aces>0){ total -= 10; aces--; }
    const raw = cards.reduce((s,c)=>s+cardValue(c.rank), 0);
    const soft = cards.some(c=>rankBucket(c.rank)==="A") && raw !== total;
    return { total, soft };
  }

  // IMPORTANT: pairs require same rank (no suit needed, but rank must match)
  function isPair(cards){
    return cards.length===2 && String(cards[0].rank) === String(cards[1].rank);
  }

  function dealerUpValue(rank){
    const b = rankBucket(rank);
    if(b==="A") return 11;
    if(b==="10") return 10;
    return parseInt(b, 10);
  }

  function parseDoubleCustom(str){
    const s = String(str||"").trim();
    if(!s) return null;
    const out = new Set();
    const parts = s.split(/[;\s]+/).join(",").split(",");
    for(const p0 of parts){
      const p = p0.trim();
      if(!p) continue;
      const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if(m){
        let a = parseInt(m[1],10), b = parseInt(m[2],10);
        if(Number.isFinite(a) && Number.isFinite(b)){
          if(a>b){ const t=a; a=b; b=t; }
          for(let x=a;x<=b;x++) out.add(x);
        }
        continue;
      }
      const n = parseInt(p,10);
      if(Number.isFinite(n)) out.add(n);
    }
    return out.size ? out : null;
  }

  function canDoubleOnTotal(total, rules){
    const mode = rules.doubleRule || "any";
    if(mode === "any") return true;
    if(mode === "9-11") return total>=9 && total<=11;
    if(mode === "10-11") return total>=10 && total<=11;
    if(mode === "custom"){
      const set = parseDoubleCustom(rules.doubleCustom || "");
      if(!set) return true; // fallback: don't block if user left it empty
      return set.has(total);
    }
    return true;
  }

  function canSurrenderNow(cards, rules){
    // late surrender normally only on first 2 cards
    return (rules.surrender === "late") && cards.length===2;
  }

  // ---- Tables ----
  // Dealer columns: 2,3,4,5,6,7,8,9,10,A
  const COLS = [2,3,4,5,6,7,8,9,10,11];
  const colIndex = (up)=>COLS.indexOf(up);

  // Hard totals (8..17) - base S17. H17 tweaks below.
  const HARD_S17 = {
    8:  ["H","H","H","H","H","H","H","H","H","H"],
    9:  ["H","Dh","Dh","Dh","Dh","H","H","H","H","H"],
    10: ["Dh","Dh","Dh","Dh","Dh","Dh","Dh","Dh","H","H"],
    // IMPORTANT: 11 vs A is Dh on common multi-deck charts
    11: ["Dh","Dh","Dh","Dh","Dh","Dh","Dh","Dh","Dh","Dh"],
    12: ["H","H","S","S","S","H","H","H","H","H"],
    13: ["S","S","S","S","S","H","H","H","H","H"],
    14: ["S","S","S","S","S","H","H","H","H","H"],
    // Surrender options: common charts: 15 vs 10 Rh, vs A usually H (depends), keep H for S17
    15: ["S","S","S","S","S","H","H","H","Rh","H"],
    // 16 vs 9/10/A Rh
    16: ["S","S","S","S","S","H","H","Rh","Rh","Rh"],
    17: ["S","S","S","S","S","S","S","S","S","S"],
  };

  // Soft totals: map by total 13..20 (A2..A9) for S17 baseline
  const SOFT_S17 = {
    13: ["H","H","H","Dh","Dh","H","H","H","H","H"], // A2
    14: ["H","H","H","Dh","Dh","H","H","H","H","H"], // A3
    15: ["H","H","Dh","Dh","Dh","H","H","H","H","H"], // A4
    16: ["H","H","Dh","Dh","Dh","H","H","H","H","H"], // A5
    17: ["H","Dh","Dh","Dh","Dh","H","H","H","H","H"], // A6
    18: ["S","Ds","Ds","Ds","Ds","S","S","H","H","H"], // A7 (S17: vs2 stand)
    19: ["S","S","S","S","S","S","S","S","S","S"],     // A8
    20: ["S","S","S","S","S","S","S","S","S","S"],     // A9
  };

  // H17 tweaks to match common charts (like in the screenshot):
  // - A7 vs 2 becomes Ds
  // - A8 vs 6 becomes Ds
  // - 15 vs A becomes Rh (late surrender)
  // - 17 vs A becomes Rs (late surrender)
  function softRow(total, rules){
    const row = (SOFT_S17[total] || ["S","S","S","S","S","S","S","S","S","S"]).slice();
    if(rules.dealer17 === "H17"){
      if(total === 18){ row[0] = "Ds"; } // A7 vs 2
      if(total === 19){ row[4] = "Ds"; } // A8 vs 6
    }
    return row;
  }

  function hardRow(total, rules){
    const row = (HARD_S17[total] || ["H","H","H","H","H","H","H","H","H","H"]).slice();

    // The screenshot chart is H17 + Late Surrender; keep these surrender spots when surrender is enabled.
    if(rules.surrender === "late"){
      // 15 vs 10/A
      if(total === 15){ row[8] = "Rh"; row[9] = "Rh"; }
      // 16 vs 9/10/A
      if(total === 16){ row[7] = "Rh"; row[8] = "Rh"; row[9] = "Rh"; }
      // 17 vs A
      if(total === 17){ row[9] = "Rs"; }
    }

    return row;
  }

  // Pairs table (H17 chart style from the screenshot).
  // Special codes:
  //   Ph = Split if DAS allowed, otherwise Hit
  //   Rp = Surrender if allowed, otherwise Split
  function pairCode(pairRank, up, rules){
    // pairRank is the ACTUAL rank string (A, K, Q, J, 10, 9..2)
    const pb = rankBucket(pairRank);

    if(pb === "A") return "P";
    if(pb === "10") return "S";

    if(pb === "9"){
      // Split vs 2-6,8-9; Stand vs 7,10,A
      if([2,3,4,5,6,8,9].includes(up)) return "P";
      return "S";
    }

    if(pb === "8"){
      // Chart shows Rp vs A (surrender if possible, else split), split everywhere else
      if(up === 11) return "Rp";
      return "P";
    }

    if(pb === "7"){
      // Split vs 2-7
      return (up >= 2 && up <= 7) ? "P" : "H";
    }

    if(pb === "6"){
      // Split vs 3-6; vs 2 is Ph (DAS-dependent); otherwise Hit
      if(up === 2) return "Ph";
      if(up >= 3 && up <= 6) return "P";
      return "H";
    }

    // IMPORTANT: 5-5 is played like hard 10 (double 2-9, hit 10/A)
    if(pb === "5"){
      return (up >= 2 && up <= 9) ? "Dh" : "H";
    }

    if(pb === "4"){
      // Split 4-4 vs 5-6 only if DAS, else Hit
      if(up === 5 || up === 6) return "Ph";
      return "H";
    }

    if(pb === "3" || pb === "2"){
      // Chart: Ph vs 2-3, P vs 4-7, else H
      if(up === 2 || up === 3) return "Ph";
      if(up >= 4 && up <= 7) return "P";
      return "H";
    }

    return "H";
  }

  function codeToAction(code, ctx){
    // ctx: { canDouble, canSplit, canSurrender, rules }
    const { canDouble, canSplit, canSurrender, rules } = ctx;

    switch(code){
      case "H": return { action:"HIT", note:"H" };
      case "S": return { action:"STAND", note:"S" };
      case "Dh": return { action: (canDouble ? "DOUBLE" : "HIT"), note:"Dh" };
      case "Ds": return { action: (canDouble ? "DOUBLE" : "STAND"), note:"Ds" };
      case "P":  return { action: (canSplit ? "SPLIT" : "HIT"), note:"P" };
      case "Ph": return { action: (canSplit && rules.DAS ? "SPLIT" : "HIT"), note:"Ph" };
      case "Rh": return { action: (canSurrender ? "SURRENDER" : "HIT"), note:"Rh" };
      case "Rs": return { action: (canSurrender ? "SURRENDER" : "STAND"), note:"Rs" };
      case "Rp": return { action: (canSurrender ? "SURRENDER" : (canSplit ? "SPLIT" : "HIT")), note:"Rp" };
      default:   return { action:"HIT", note:code||"?" };
    }
  }

  // TC deviations requested by the user
  const deviations = [
    { key:"16v10", label:"16 vs 10", thresh:0, when:(tc)=>tc>=0, apply:(ctx)=>!ctx.soft && ctx.total===16 && ctx.up===10, action:"STAND" },
    { key:"15v10", label:"15 vs 10", thresh:4, when:(tc)=>tc>=4, apply:(ctx)=>!ctx.soft && ctx.total===15 && ctx.up===10, action:"STAND" },
    { key:"12v3",  label:"12 vs 3",  thresh:2, when:(tc)=>tc>=2, apply:(ctx)=>!ctx.soft && ctx.total===12 && ctx.up===3,  action:"STAND" },
    { key:"12v2",  label:"12 vs 2",  thresh:3, when:(tc)=>tc>=3, apply:(ctx)=>!ctx.soft && ctx.total===12 && ctx.up===2,  action:"STAND" },
    { key:"11vA",  label:"11 vs A",  thresh:1, when:(tc)=>tc>=1, apply:(ctx)=>!ctx.soft && ctx.total===11 && ctx.up===11, action:"DOUBLE" },
    { key:"ins",   label:"Insurance",thresh:3, when:(tc)=>tc>=3, apply:()=>false, action:null },
  ];

  function basicFromTable(playerCards, dealerUpRank, rules){
    const up = dealerUpValue(dealerUpRank);
    const { total, soft } = handTotal(playerCards);

    const canDouble = (playerCards.length===2) && canDoubleOnTotal(total, rules);
    const canSplit  = (playerCards.length===2) && isPair(playerCards);
    const canSurrender = canSurrenderNow(playerCards, rules);

    let code = "H";
    let source = "Hard";

    if(canSplit){
      source = "Pairs";
      code = pairCode(playerCards[0].rank, up, rules);
    } else if(soft){
      source = "Soft";
      code = (softRow(total, rules)[colIndex(up)] || "S");
    } else {
      source = "Hard";
      if(total <= 8) code = "H";
      else if(total >= 18) code = "S";
      else code = (hardRow(total, rules)[colIndex(up)] || "H");
    }

    // Apply surrender codes only if surrender is on; otherwise downgrade Rh/Rs to hit/stand
    if((code === "Rh" || code === "Rs") && rules.surrender !== "late"){
      code = (code === "Rh") ? "H" : "S";
    }

    const mapped = codeToAction(code, { canDouble, canSplit, canSurrender, rules });

    return {
      action: mapped.action,
      code,
      source,
      total,
      soft,
      up,
      canDouble,
      canSplit,
      canSurrender,
    };
  }

  function recommend(playerCards, dealerCards, rules, tc){
    const upRank = dealerCards?.[0]?.rank;
    if(!upRank){
      return { action:null, title:"Adj meg dealer lapot", detail:"Legalább 1 dealer lap kell (upcard)." };
    }

    const base = basicFromTable(playerCards, upRank, rules);
    let action = base.action;
    const notes = [];
    notes.push(`Táblázat: ${base.source} • kód: ${base.code}`);
    notes.push(`Basic: ${action}`);

    const ctx = { total: base.total, up: base.up, soft: base.soft, dealer17: rules.dealer17 };

    for(const d of deviations){
      if(!d.action) continue;
      if(!d.when(tc)) continue;
      if(!d.apply(ctx)) continue;
      if(d.action === "DOUBLE" && !base.canDouble) continue;

      // If basic says SURRENDER, we still show the deviation as a NOTE,
      // but keep surrender as the action (surrender is usually stronger when available).
      if(action === "SURRENDER"){
        notes.push(`TC deviáció (info): ${d.label} → ${d.action} (de SURRENDER engedett)`);
        continue;
      }

      action = d.action;
      notes.push(`TC deviáció: ${d.label} → ${d.action} (TC≥+${d.thresh})`);
    }

    notes.push(tc >= 3 ? "Insurance: IGEN (TC≥+3)" : "Insurance: NEM");

    return {
      action,
      title: action ? `AJÁNLÁS: ${action}` : "—",
      detail: notes.join(" • "),
      deviations
    };
  }

  window.BJStrategy = { handTotal, rankBucket, recommend, deviations };
})();