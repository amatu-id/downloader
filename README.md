# Downloader

Tempel link YouTube, Instagram, TikTok, X, atau Threads, lalu otomatis dikonversi dan disimpan sebagai **MP4** (YouTube: pilih resolusi 144p–4K), **MP3** (128–320 kbps), **foto**, atau **teks**.

Situs: https://amatu-id.github.io/downloader/ (bagian dari Portal AMATU, perlu masuk portal).

- Tempel link (Ctrl/⌘+V di mana saja, tombol **Tempel**, atau tarik link ke halaman) → detail video langsung muncul.
- MP4: setiap resolusi yang tersedia di YouTube beserta perkiraan ukuran. Resolusi yang hanya ada dalam VP9/AV1 (umumnya 2K/4K) bisa diubah otomatis ke H.264 supaya bisa diputar di semua perangkat.
- MP3: 320 / 256 / 192 / 128 kbps, dengan sampul dan judul tertanam.
- **Instagram**: postingan publik (foto/video/carousel) dan reels, tanpa login. Story dan highlight perlu login sehingga tidak bisa diunduh. Pilih item yang mau diambil; beberapa file bisa disimpan satu-satu atau sebagai ZIP.
- **TikTok**: video (tanpa watermark), foto slideshow (+ audio), link pendek `vm.`/`vt.tiktok.com`. Video juga bisa langsung jadi MP3.
- **X (Twitter)**: video (kualitas tertinggi), GIF, foto asli, dan teks post; link `x.com`, `twitter.com`, `t.co`. Hanya post publik (tanpa login).
- **Threads**: video (sampai 1080p), foto, carousel, dan teks post; link `threads.com`, `threads.net`. Hanya post publik (tanpa login).
- Post tanpa media disimpan sebagai `.txt`; teks post bisa disalin langsung.
- **Otomatis unduh saat ditempel**: link yang ditempel langsung diproses dengan format & kualitas pilihan terakhir lalu tersimpan.
- Riwayat unduhan tersinkron ke akun portal; file hasil tersimpan di perangkat selama halaman terbuka.
- Link langsung: `https://amatu-id.github.io/downloader/?url=<link YouTube>`.

Semua proses berjalan di browser pengunjung, tanpa MacBook. YouTube: stream dari server Invidious, digabung/dikonversi dengan mediabunny (`js/engine.js`). TikTok lewat tikwm, X lewat fxtwitter, Instagram dan Threads lewat Supabase Edge Function `amatu-dl` (`supabase/functions/amatu-dl`).

Deploy fungsi: `supabase functions deploy amatu-dl --project-ref ieyqxmzztoxgpvwexbkj --no-verify-jwt --use-api`.

`js/vendor` = mediabunny 1.65.1 + @mediabunny/mp3-encoder (MPL-2.0), tanpa perubahan selain alamat impor pada mp3 encoder.
