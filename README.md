# Rapor Bina Ilmu

Aplikasi asesmen dan rapor Kurikulum Merdeka SD (kelas 1–6, fase A/B/C) dengan Supabase Postgres sebagai penyimpanan. Aplikasi tidak mencatat presensi dan tidak mencakup keasramaan.

## Setup Supabase

Project Supabase yang disiapkan untuk aplikasi ini: `raport-bina-ilmu` (`hzzllcecsddqhlvieulu`), region Singapore.

1. Migrasi awal `db/migrations/001_initial_schema.sql` telah dikonfirmasi berhasil diterapkan pada project ini. Migrasi tersebut membuat tabel/indeks dan row pengaturan sekolah kosong, mengaktifkan RLS tanpa policy untuk tabel aplikasi, serta mencabut akses schema/tabel dari role Data API (`anon`, `authenticated`, `service_role`, dan `PUBLIC`). Tidak ada data siswa contoh atau data dari workbook yang dimasukkan. Untuk project Supabase lain, jalankan migrasi melalui **SQL Editor**. Aplikasi memakai koneksi PostgreSQL server-side, bukan Supabase Data API.
2. Dari panel **Connect**, salin URI **Transaction pooler** untuk lingkungan serverless atau **Session pooler** untuk proses lokal. Letakkan URI tersebut sebagai `DATABASE_URL` di file `.env` lokal (salin `.env.example` sebagai template). Gunakan kata sandi database Supabase; URL dan kata sandi hanya disimpan di environment server, jangan di source code, browser, atau chat. Driver memaksa TLS dengan verifikasi sertifikat dan mengabaikan parameter URL yang mencoba menurunkan pengaturan TLS.
3. Jalankan aplikasi lokal seperti berikut.

```powershell
npm install
npm run dev
```

Buka `http://127.0.0.1:3000`. Pada lingkungan lokal, akun kepala sekolah pertama dibuat melalui setup awal dengan kata sandi minimal 12 karakter.

## Konfigurasi environment

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `DATABASE_URL` | Ya | URI PostgreSQL Supabase; rahasia server-side. Gunakan transaction pooler untuk serverless. |
| `INITIAL_SETUP_TOKEN` | Production | Token acak minimal 32 karakter; diperlukan hanya untuk membuat akun kepala sekolah pertama. Hapus dari environment setelah akun dibuat. |
| `DB_POOL_MAX` | Tidak | Maksimal koneksi per instance, default 3, rentang 1–10. |
| `PORT` | Tidak | Port lokal, default 3000. |

Di Vercel, simpan `DATABASE_URL` sebagai encrypted/sensitive environment variable untuk setiap environment yang akan dijalankan. `INITIAL_SETUP_TOKEN` hanya diperlukan pada environment production yang belum memiliki akun. Jangan set `SUPABASE_SERVICE_ROLE_KEY` atau publishable key untuk aplikasi ini; tidak digunakan. Aplikasi tidak pernah mengirim `DATABASE_URL` ke browser.

## Status deployment

Schema Supabase untuk project di atas telah diterapkan, tetapi konektivitas dari aplikasi belum diuji karena `DATABASE_URL` belum dikonfigurasi. Express app memiliki entry point yang dapat diekspor untuk dukungan native Express Vercel, tetapi aplikasi **belum dideploy**. Deployment menunggu project/team Vercel terhubung, environment variables rahasia tersedia dengan aman, dan uji konektivitas menggunakan URI pooler berhasil. Tidak ada secret yang diminta atau ditulis ke repository pada tahap ini.

## Alur kerja MVP

- Kepala sekolah menyiapkan rombel, siswa, mata pelajaran per kelas/fase, TP, periode akademik, pengguna, identitas sekolah opsional, serta bobot formatif/sumatif tiap mapel dan periode.
- Guru mata pelajaran memasukkan nilai per siswa dan TP, menulis narasi, lalu menandai narasi telah ditinjau.
- Wali kelas mengimpor ekspor kehadiran, mengisi bagian rapor kokurikuler/profil/ekstrakurikuler bila diperlukan, dan meninjau kelengkapan rapor.
- Kepala sekolah menyetujui dan memfinalkan rapor. Hanya rapor final yang dapat dibuka untuk dicetak atau disimpan ke PDF.

Perhitungan nilai menormalkan setiap nilai asesmen ke skala 0–100, merata-ratakan nilai formatif dan sumatif secara terpisah, lalu menerapkan bobot yang tersimpan untuk mapel/periode tersebut. Jumlah bobot wajib 100%. Tidak ada bobot default; kategori dengan bobot positif harus memiliki nilai sebelum rapor siap. Nilai dan narasi yang belum lengkap tidak dapat difinalkan. Setelah wali kelas mulai meninjau, data rapor dan bobot dikunci agar hasil final tidak berubah di belakang; buat periode baru bila ada koreksi yang memerlukan alur persetujuan ulang.

Kehadiran dihitung dari tanggal yang masuk dalam rentang periode. Impor membutuhkan kolom `Tanggal`, `ID_Siswa`, `Nama`, `Kelas`, dan `Status`; status yang didukung adalah A (alfa), H (hadir), I (izin), S (sakit). Pencocokan siswa memakai `ID_Siswa`; nama/kelas hanya pemeriksaan sekunder. Status lama L/M tidak diterjemahkan. Baris bermasalah atau konflik membatalkan seluruh impor; impor ulang status identik tidak menggandakan presensi. API adapter dapat menggantikan sumber spreadsheet nanti tanpa mengubah batas domain kehadiran.

## Pengembangan dan pengujian

```powershell
npm test
npm run build
```

Tes migrasi menjalankan SQL terhadap PostgreSQL tertanam (PGlite), menguji penerapan berulang, batas akses role Data API, RLS, dan tidak adanya data siswa fixture. Tes itu tidak terhubung ke atau mengubah project Supabase.

Server menyimpan kata sandi dengan scrypt, menggunakan cookie sesi HTTP-only, dan membatasi aksi berdasarkan peran. Sesi kedaluwarsa setelah tujuh hari. Akun tambahan dibuat oleh kepala sekolah.
