
/* supabase.js - Optional realtime via Supabase Realtime Broadcast */
(function(){
  const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

  function loadScriptOnce(){
    return new Promise((resolve,reject)=>{
      if(window.supabase) return resolve();
      const s = document.createElement("script");
      s.src = CDN;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Supabase CDN load failed"));
      document.head.appendChild(s);
    });
  }

  async function createClient(url, key){
    await loadScriptOnce();
    return window.supabase.createClient(url, key, { realtime: { params: { eventsPerSecond: 10 } } });
  }

  window.SBRT = { createClient };
})();
