# Downloader

Tempel link YouTube, lalu video otomatis dikonversi dan disimpan sebagai **MP4** (pilih resolusi 144p–4K) atau **MP3** (128–320 kbps).

Situs: https://amatu-id.github.io/downloader/ (bagian dari Portal AMATU, perlu masuk portal).

- Tempel link (Ctrl/⌘+V di mana saja, tombol **Tempel**, atau tarik link ke halaman) → detail video langsung muncul.
- MP4: setiap resolusi yang tersedia di YouTube beserta perkiraan ukuran. Resolusi yang hanya ada dalam VP9/AV1 (umumnya 2K/4K) bisa diubah otomatis ke H.264 supaya bisa diputar di semua perangkat.
- MP3: 320 / 256 / 192 / 128 kbps, dengan sampul dan judul tertanam.
- **Otomatis unduh saat ditempel**: link yang ditempel langsung diproses dengan format & kualitas pilihan terakhir lalu tersimpan.
- Riwayat unduhan tersinkron ke akun portal; file hasil tersedia di server selama 1 jam.
- Link langsung: `https://amatu-id.github.io/downloader/?url=<link YouTube>`.

Konversi berjalan di server kecil di MacBook (yt-dlp + ffmpeg, folder `dl-relay/`) yang diakses lewat Cloudflare tunnel; alamatnya diambil dari Supabase (`amt_relay_get`). MacBook harus menyala dan online.
