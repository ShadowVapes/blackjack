
/* count.js - Hi-Lo count + true count from shoe state */
(function(){
  const TEN_SET = new Set(["10","J","Q","K"]);
  const bucket = (rank)=>TEN_SET.has(rank) ? "10" : rank;

  function hiloValue(rank){
    const b = bucket(rank);
    if(["2","3","4","5","6"].includes(b)) return +1;
    if(["7","8","9"].includes(b)) return 0;
    return -1;
  }

  function runningCount(seenCards){
    return seenCards.reduce((acc,c)=>acc + hiloValue(c.rank), 0);
  }

  function remainingFromSeen(decks, seenCount){
    const totalCards = decks * 52;
    const remainingCards = Math.max(0, totalCards - seenCount);
    const remainingDecks = remainingCards / 52;
    return { totalCards, remainingCards, remainingDecks };
  }

  function trueCount(rc, remainingDecks){
    const denom = Math.max(0.25, remainingDecks);
    return rc / denom;
  }

  window.BJCount = { runningCount, remainingFromSeen, trueCount };
})();
