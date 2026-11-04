# Downloader

Runs entirely in the visitor's browser (no server of ours does the conversion, no MacBook):
YouTube through Invidious streams, joined/encoded with mediabunny (`js/engine.js`); TikTok through tikwm; X through fxtwitter;
Instagram + Threads through the Supabase Edge Function `amatu-dl` (`supabase/functions/amatu-dl`).

Deploy the function: `supabase functions deploy amatu-dl --project-ref ieyqxmzztoxgpvwexbkj --no-verify-jwt --use-api`.
`js/vendor` = mediabunny 1.65.1 + @mediabunny/mp3-encoder (MPL-2.0), unmodified except the mp3 encoder's import path.
