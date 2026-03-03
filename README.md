# Blackjack Recreator (GitHub Pages)

## Funkciók
- Valós blackjack leosztás "recreate" (kézzel felveszed a lapokat)
- Hi‑Lo running count + true count (a kijátszott lapok alapján)
- Ajánlott döntés: basic strategy (multi‑deck S17 alap) + TC‑deviációk (a kért 11vA, 16v10 stb.)
- Single-player: mindig működik
- Multiplayer:
  - Host: játékos lapok
  - Dealer: dealer lapok
  - Realtime: opcionális Supabase Realtime Broadcast (GitHub Pageshez is jó)

## GitHub Pages
1. Pushold a repót.
2. Settings → Pages → Deploy from branch → root.

## Realtime (opcionális)
Supabase:
- Project URL + anon key → Room oldalon beilleszted → Connect

Ha nincs Supabase, használhatod a "Manuális sync" state copy/paste-t.
