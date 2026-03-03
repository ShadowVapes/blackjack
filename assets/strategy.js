
/* strategy.js
   Basic strategy (multi-deck, S17 baseline) + optional late surrender + simple TC deviations
   Returns recommended action and explanation.
*/
(function(){
  const TEN_SET = new Set(["10","J","Q","K"]);

  function rankBucket(rank){
    return TEN_SET.has(rank) ? "10" : rank;
  }
  function cardValue(rank){
    const b = rankBucket(rank);
    if(b === "A") return 11;
    if(b === "10") return 10;
    return parseInt(b, 10);
  }
  function handTotal(cards){
    let total = 0;
    let aces = 0;
    for(const c of cards){
      total += cardValue(c.rank);
      if(rankBucket(c.rank) === "A") aces++;
    }
    while(total > 21 && aces > 0){
      total -= 10;
      aces--;
    }
    const raw = cards.reduce((s,c)=>s+cardValue(c.rank),0);
    const soft = cards.some(c=>rankBucket(c.rank)==="A") && raw !== total;
    return { total, soft };
  }
  function isPair(cards){
    if(cards.length !== 2) return false;
    return cards[0].rank === cards[1].rank;
  }
  function dealerUpValue(upRank){
    const b = rankBucket(upRank);
    if(b === "A") return 11;
    if(b === "10") return 10;
    return parseInt(b, 10);
  }
  function canDoubleOn(total, rules){
    if(rules.doubleRule === "any") return true;
    if(rules.doubleRule === "9-11") return total >= 9 && total <= 11;
    if(rules.doubleRule === "10-11") return total >= 10 && total <= 11;
    return true;
  }

  // Late surrender approximation (multi-deck). Rules vary across tables.
  function surrenderSuggestion(total, soft, dealerUp, rules){
    if(rules.surrender !== "late") return false;
    if(soft) return false;
    if(total === 16 && (dealerUp === 9 || dealerUp === 10 || dealerUp === 11)) return true;
    if(total === 15 && dealerUp === 10) return true;
    if(total === 15 && dealerUp === 11 && rules.dealer17 === "H17") return true;
    return false;
  }

  function basicStrategy(cards, dealerUpRank, rules){
    const up = dealerUpValue(dealerUpRank);
    const { total, soft } = handTotal(cards);
    const allowDouble = (cards.length === 2) && canDoubleOn(total, rules);
    const allowSplit = (cards.length === 2) && isPair(cards);

    if(surrenderSuggestion(total, soft, up, rules)){
      return { action: "SURRENDER", note: "Late surrender szerint" };
    }

    // Pair strategy (multi-deck S17 baseline, DAS affects 4-4)
    if(allowSplit){
      const r = cards[0].rank;
      const b = rankBucket(r);

      if(b === "A") return { action: "SPLIT", note: "AA mindig split" };
      if(b === "8") return { action: "SPLIT", note: "88 mindig split" };
      if(b === "10") return { action: "STAND", note: "10-es párt nem splitelünk" };

      if(b === "9"){
        if([2,3,4,5,6,8,9].includes(up)) return { action:"SPLIT", note:"99 split 2-6,8-9" };
        return { action:"STAND", note:"99 stand 7,10,A" };
      }
      if(b === "7"){
        if(up <= 7) return { action:"SPLIT", note:"77 split 2-7" };
        return { action:"HIT", note:"77 hit 8-A" };
      }
      if(b === "6"){
        if(up >=2 && up <=6) return { action:"SPLIT", note:"66 split 2-6" };
        return { action:"HIT", note:"66 hit 7-A" };
      }
      if(b === "5"){
        if(allowDouble && up >=2 && up <=9) return { action:"DOUBLE", note:"55 double 2-9" };
        return { action:"HIT", note:"55 hit 10/A" };
      }
      if(b === "4"){
        if(rules.DAS && (up === 5 || up === 6)) return { action:"SPLIT", note:"44 split 5-6 (DAS)" };
        return { action:"HIT", note:"44 hit" };
      }
      if(b === "3" || b === "2"){
        if(up >=2 && up <=7) return { action:"SPLIT", note:`${b}${b} split 2-7` };
        return { action:"HIT", note:`${b}${b} hit 8-A` };
      }
    }

    // Soft totals
    if(soft){
      if(total <= 17){
        if(total === 13 || total === 14){
          if(allowDouble && (up === 5 || up === 6)) return { action:"DOUBLE", note:"A2/A3 double 5-6" };
          return { action:"HIT", note:"A2/A3 hit" };
        }
        if(total === 15 || total === 16){
          if(allowDouble && (up >=4 && up <=6)) return { action:"DOUBLE", note:"A4/A5 double 4-6" };
          return { action:"HIT", note:"A4/A5 hit" };
        }
        if(total === 17){
          if(allowDouble && (up >=3 && up <=6)) return { action:"DOUBLE", note:"A6 double 3-6" };
          return { action:"HIT", note:"A6 hit" };
        }
      }
      if(total === 18){
        if(allowDouble && (up >=3 && up <=6)) return { action:"DOUBLE", note:"A7 double 3-6" };
        if(up === 2 || up === 7 || up === 8) return { action:"STAND", note:"A7 stand 2,7,8" };
        return { action:"HIT", note:"A7 hit 9,10,A" };
      }
      if(total >= 19) return { action:"STAND", note:"soft 19+ stand" };
    }

    // Hard totals
    if(total >= 17) return { action:"STAND", note:"17+ stand" };
    if(total <= 8) return { action:"HIT", note:"<=8 hit" };

    if(total === 9){
      if(allowDouble && (up >=3 && up <=6)) return { action:"DOUBLE", note:"9 double 3-6" };
      return { action:"HIT", note:"9 hit" };
    }
    if(total === 10){
      if(allowDouble && (up >=2 && up <=9)) return { action:"DOUBLE", note:"10 double 2-9" };
      return { action:"HIT", note:"10 hit 10/A" };
    }
    if(total === 11){
      if(allowDouble && up !== 11) return { action:"DOUBLE", note:"11 double (nem A ellen)" };
      return { action:"HIT", note:"11 hit A ellen" };
    }
    if(total === 12){
      if(up >=4 && up <=6) return { action:"STAND", note:"12 stand 4-6" };
      return { action:"HIT", note:"12 hit 2-3,7-A" };
    }
    if(total >= 13 && total <= 16){
      if(up >=2 && up <=6) return { action:"STAND", note:"13-16 stand 2-6" };
      return { action:"HIT", note:"13-16 hit 7-A" };
    }
    return { action:"HIT", note:"fallback" };
  }

  const deviations = [
    { key:"16v10", label:"16 vs 10", thresh:0,  when:(tc)=>tc>=0, apply:(ctx)=>ctx.total===16 && ctx.up===10, action:"STAND" },
    { key:"15v10", label:"15 vs 10", thresh:4,  when:(tc)=>tc>=4, apply:(ctx)=>ctx.total===15 && ctx.up===10, action:"STAND" },
    { key:"12v3",  label:"12 vs 3",  thresh:2,  when:(tc)=>tc>=2, apply:(ctx)=>ctx.total===12 && ctx.up===3,  action:"STAND" },
    { key:"12v2",  label:"12 vs 2",  thresh:3,  when:(tc)=>tc>=3, apply:(ctx)=>ctx.total===12 && ctx.up===2,  action:"STAND" },
    { key:"11vA",  label:"11 vs A",  thresh:1,  when:(tc)=>tc>=1, apply:(ctx)=>ctx.total===11 && ctx.up===11, action:"DOUBLE" },
    { key:"ins",   label:"Insurance",thresh:3,  when:(tc)=>tc>=3, apply:()=>false, action:null },
  ];

  function recommend(playerCards, dealerCards, rules, tc){
    const upRank = dealerCards?.[0]?.rank;
    if(!upRank){
      return { action:null, title:"Adj meg dealer upcardot", detail:"Legalább 1 dealer lap kell." };
    }
    const up = dealerUpValue(upRank);
    const hv = handTotal(playerCards);
    const allowDoubleNow = (playerCards.length === 2) && canDoubleOn(hv.total, rules);

    let base = basicStrategy(playerCards, upRank, rules);
    let action = base.action;
    const notes = [`Basic: ${base.action} (${base.note})`];

    const ctx = { total: hv.total, up, soft: hv.soft };

    for(const d of deviations){
      if(!d.action) continue;
      if(!d.when(tc)) continue;
      if(!d.apply(ctx)) continue;
      if(d.action === "DOUBLE" && !allowDoubleNow) continue;
      if(action === "SURRENDER") continue;
      action = d.action;
      notes.push(`TC dev: ${d.label} → ${d.action} (TC≥+${d.thresh})`);
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
