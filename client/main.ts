export {};

type Role = 'subject_teacher' | 'homeroom_teacher' | 'principal';
interface User {
  id: number;
  name: string;
  username: string;
  role: Role;
}
interface Row {
  id: number;
  [key: string]: unknown;
}
interface AppData {
  user: User;
  roleName: string;
  classes: Row[];
  students: Row[];
  subjects: Row[];
  objectives: Row[];
  terms: Row[];
  rules: Row[];
  narratives: Row[];
  settings: { name: string | null; logo_url: string | null; city: string | null; principal_name: string | null };
  users: Row[];
  attendanceImports: Row[];
}
interface ReportRow {
  student: { id: number; student_code: string; name: string; class_name: string };
  status: string;
  ready: boolean;
  issues: string[];
  subjects: {
    subjectId: number;
    name: string;
    score: number | null;
    narrative: string | null;
    narrativeReviewed: boolean;
  }[];
  attendance: Record<string, number>;
  sections: Record<string, string>;
}

const appRoot = document.querySelector<HTMLDivElement>('#app')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const roleLabel: Record<Role, string> = {
  subject_teacher: 'Guru mata pelajaran',
  homeroom_teacher: 'Wali kelas',
  principal: 'Kepala sekolah'
};
let data: AppData | null = null;
let screen = 'dashboard';
let activeTermId = '';
let reportRows: ReportRow[] = [];
let toastTimer = 0;

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character]!;
  });

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle('error-toast', isError);
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3800);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? 'Permintaan gagal.', response.status);
  return body as T;
}

function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function boot(): Promise<void> {
  try {
    const status = await request<{ needsSetup: boolean; requiresSetupToken: boolean }>('/api/auth/status');
    if (status.needsSetup) {
      renderAuth(true, status.requiresSetupToken);
      return;
    }
    try {
      await request('/api/auth/me');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        renderAuth(false);
        return;
      }
      throw error;
    }
    await refresh();
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Aplikasi tidak dapat dimuat.', true);
  }
}

function renderAuth(needsSetup: boolean, requiresSetupToken = false): void {
  appRoot.innerHTML = `
    <main class="auth-shell">
      <section class="auth-intro">
        <div class="eyebrow">Rapor Bina Ilmu · Kurikulum Merdeka SD</div>
        <h1>Belajar tumbuh, laporan bermakna.</h1>
        <p>Kelola tujuan pembelajaran, asesmen, narasi, dan rapor semester dalam satu alur yang dapat ditinjau sebelum diterbitkan.</p>
        <p class="hint">Aplikasi lokal. Data tersimpan di komputer ini; buat akun kepala sekolah saat pertama kali menjalankan.</p>
      </section>
      <section class="auth-card">
        <div class="eyebrow">${needsSetup ? 'Pengaturan awal' : 'Akses sekolah'}</div>
        <h2>${needsSetup ? 'Buat akun kepala sekolah' : 'Selamat datang kembali'}</h2>
        <p>${needsSetup ? 'Akun ini menjadi administrator pertama. Tidak ada akun atau kata sandi bawaan.' : 'Masuk menggunakan akun sekolah Anda.'}</p>
        <form class="stack" data-action="${needsSetup ? 'setup' : 'login'}">
          ${needsSetup ? `<div class="field"><label>Nama kepala sekolah</label><input name="name" required autocomplete="name" /></div>` : ''}
          ${needsSetup && requiresSetupToken ? `<div class="field"><label>Token setup awal</label><input name="setupToken" type="password" required autocomplete="off" /></div>` : ''}
          <div class="field"><label>Nama pengguna</label><input name="username" required autocomplete="username" /></div>
          <div class="field">
            <label>Kata sandi${needsSetup ? ' (minimal 12 karakter)' : ''}</label>
            <input name="password" type="password" required ${needsSetup ? 'minlength="12"' : ''} autocomplete="${needsSetup ? 'new-password' : 'current-password'}" />
          </div>
          <button class="button primary" type="submit">${needsSetup ? 'Buat akun dan masuk' : 'Masuk'}</button>
        </form>
      </section>
    </main>`;
}

async function refresh(): Promise<void> {
  data = await request<AppData>('/api/data');
  if (!activeTermId && data.terms.length) activeTermId = String(data.terms[0]!.id);
  if (screen === 'reports' && activeTermId) {
    const result = await request<{ reports: ReportRow[] }>(`/api/reports?termId=${encodeURIComponent(activeTermId)}`);
    reportRows = result.reports;
  }
  renderApp();
}

function selectedTerm(): Row | undefined {
  return data?.terms.find((term) => String(term.id) === activeTermId);
}

function termSelect(): string {
  if (!data) return '';
  return `<select class="top-select" id="term-select" aria-label="Periode rapor">
    ${data.terms.map((term) => `<option value="${esc(term.id)}" ${String(term.id) === activeTermId ? 'selected' : ''}>${esc(term.academic_year)} · Semester ${esc(term.semester)}</option>`).join('')}
  </select>`;
}

const navItems: [string, string][] = [
  ['dashboard', 'Ringkasan'],
  ['students', 'Kelas & siswa'],
  ['subjects', 'Mata pelajaran & TP'],
  ['assessment', 'Asesmen & narasi'],
  ['attendance', 'Impor kehadiran'],
  ['reports', 'Rapor & leger'],
  ['settings', 'Pengaturan']
];

function renderApp(): void {
  if (!data) return;
  const title = navItems.find(([key]) => key === screen)?.[1] ?? 'Ringkasan';
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">BI</div><strong>Rapor Bina Ilmu</strong><small>SD · Kurikulum Merdeka</small></div>
        <nav class="nav" aria-label="Navigasi utama">
          ${navItems.map(([key, label]) => `<button type="button" class="${key === screen ? 'active' : ''}" data-screen="${key}">${label}</button>`).join('')}
        </nav>
        <div class="sidebar-bottom">Data lokal di perangkat ini.<br />Belum ada fitur keasramaan.</div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <h1>${esc(title)}</h1>
          <div class="user-chip"><div><strong>${esc(data.user.name)}</strong>${esc(roleLabel[data.user.role])}</div><div class="avatar">${esc(data.user.name.slice(0, 1).toUpperCase())}</div><button class="button secondary small" data-action="logout">Keluar</button></div>
        </header>
        <section class="content" id="content">${renderScreen()}</section>
      </main>
    </div>`;
  appRoot.querySelectorAll<HTMLFormElement>('form[data-action="assessment"], form[data-action="narrative"]').forEach(syncLinkedChoices);
}

function pageHead(eyebrow: string, title: string, description: string, right = ''): string {
  return `<div class="content-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${right}</div>`;
}

function stat(label: string, value: number | string, caption: string): string {
  return `<article class="card"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong><span class="stat-caption">${esc(caption)}</span></article>`;
}

function empty(message: string): string {
  return `<div class="empty">${esc(message)}</div>`;
}

function renderScreen(): string {
  if (!data) return '';
  if (screen === 'students') return renderStudents();
  if (screen === 'subjects') return renderSubjects();
  if (screen === 'assessment') return renderAssessments();
  if (screen === 'attendance') return renderAttendance();
  if (screen === 'reports') return renderReports();
  if (screen === 'settings') return renderSettings();
  return renderDashboard();
}

function renderDashboard(): string {
  if (!data) return '';
  const currentTerm = selectedTerm();
  return `
    ${pageHead('Semester berjalan', 'Ringkasan sekolah', 'Data awal hanya contoh sintetis. Atur bobot dan lengkapi data sebelum meninjau rapor.', termSelect())}
    <div class="grid cards">
      ${stat('Rombel', data.classes.length, 'Kelas yang terdaftar')}
      ${stat('Siswa', data.students.length, 'Data siswa sintetis / sekolah')}
      ${stat('Mata pelajaran', data.subjects.length, 'Dapat berbeda per kelas dan fase')}
      ${stat('Periode aktif', currentTerm ? `S${esc(currentTerm.semester)}` : '—', currentTerm ? String(currentTerm.academic_year) : 'Tambahkan periode')}
    </div>
    <div class="grid two">
      <article class="card">
        <h3 class="section-title">Mulai dari sini</h3>
        <div class="list">
          <div class="list-row"><div><strong>1. Siapkan kelas dan siswa</strong><small>Buat rombel, lalu masukkan siswa dengan ID sekolah yang stabil.</small></div><button class="button secondary small" data-screen="students">Buka</button></div>
          <div class="list-row"><div><strong>2. Atur mata pelajaran dan TP</strong><small>Konfigurasi per kelas/fase; kolom rapor mengikuti data ini.</small></div><button class="button secondary small" data-screen="subjects">Buka</button></div>
          <div class="list-row"><div><strong>3. Tentukan bobot nilai</strong><small>Tidak ada formula bawaan; kepala sekolah menyimpan bobot tiap periode/mapel.</small></div><button class="button secondary small" data-screen="subjects">Atur</button></div>
          <div class="list-row"><div><strong>4. Lengkapi asesmen dan narasi</strong><small>Guru mata pelajaran mencatat formatif/sumatif dan meninjau narasi.</small></div><button class="button secondary small" data-screen="assessment">Buka</button></div>
          <div class="list-row"><div><strong>5. Impor kehadiran lalu tinjau rapor</strong><small>Impor ekspor sistem sekolah; tidak ada pencatatan presensi di aplikasi ini.</small></div><button class="button secondary small" data-screen="attendance">Impor</button></div>
        </div>
      </article>
      <div class="stack">
        <article class="card">
          <h3 class="section-title">Alur penerbitan</h3>
          <div class="callout">Guru meninjau narasi → wali kelas meninjau rapor → kepala sekolah menyetujui dan memfinalkan. Rapor belum dapat dicetak sebelum final.</div>
          <p class="hint">Sistem menahan penerbitan bila bobot, capaian, narasi, atau data kehadiran periode belum lengkap.</p>
        </article>
        <article class="card">
          <h3 class="section-title">Impor kehadiran terakhir</h3>
          ${data.attendanceImports.length ? `<div class="list">${data.attendanceImports.map((item) => `<div class="list-row"><div>${esc(item.rows_added)} baris baru<small>${esc(item.imported_at)}</small></div><span class="badge">${esc(item.rows_unchanged)} tidak berubah</span></div>`).join('')}</div>` : empty('Belum ada impor.')}
        </article>
      </div>
    </div>`;
}

function renderStudents(): string {
  if (!data) return '';
  const canEdit = ['principal', 'homeroom_teacher'].includes(data.user.role);
  return `
    ${pageHead('Data kelas', 'Kelas dan siswa', 'Rombel mengacu pada fase SD: kelas 1–2 fase A, 3–4 fase B, dan 5–6 fase C.')}
    <div class="grid two">
      <article class="card">
        <h3 class="section-title">Daftar rombel</h3>
        ${data.classes.length ? `<div class="table-wrap"><table><thead><tr><th>Rombel</th><th>Kelas / fase</th><th>Wali kelas</th><th>Siswa</th></tr></thead><tbody>${data.classes.map((room) => `<tr><td><strong>${esc(room.name)}</strong></td><td>${esc(room.grade)} · Fase ${esc(room.phase)}</td><td>${esc(room.homeroom_teacher || '—')}</td><td>${esc(room.student_count)}</td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada rombel.')}
        ${canEdit ? `<hr class="divider" /><h3 class="section-title">Tambah rombel</h3><form class="stack" data-action="class"><div class="form-grid"><div class="field"><label>Nama rombel</label><input name="name" placeholder="Contoh: 4A" required /></div><div class="field"><label>Kelas</label><select name="grade" required>${[1, 2, 3, 4, 5, 6].map((grade) => `<option value="${grade}">Kelas ${grade} · Fase ${grade < 3 ? 'A' : grade < 5 ? 'B' : 'C'}</option>`).join('')}</select></div><div class="field full"><label>Nama wali kelas</label><input name="homeroomTeacher" /></div></div><button class="button primary" type="submit">Simpan rombel</button></form>` : ''}
      </article>
      <article class="card">
        <h3 class="section-title">Daftar siswa</h3>
        ${data.students.length ? `<div class="table-wrap"><table><thead><tr><th>ID siswa</th><th>Nama</th><th>Rombel</th></tr></thead><tbody>${data.students.map((student) => `<tr><td>${esc(student.student_code)}</td><td><strong>${esc(student.name)}</strong></td><td>${esc(student.class_name)}</td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada siswa.')}
        ${canEdit ? `<hr class="divider" /><h3 class="section-title">Tambah siswa</h3><form class="stack" data-action="student"><div class="form-grid"><div class="field"><label>ID siswa</label><input name="studentCode" required /></div><div class="field"><label>Nama siswa</label><input name="name" required /></div><div class="field full"><label>Rombel</label><select name="classId" required>${data.classes.map((room) => `<option value="${esc(room.id)}">${esc(room.name)} · Kelas ${esc(room.grade)}</option>`).join('')}</select></div></div><button class="button primary" type="submit" ${data.classes.length ? '' : 'disabled'}>Simpan siswa</button></form>` : ''}
      </article>
    </div>`;
}

function renderSubjects(): string {
  if (!data) return '';
  const canAddSubject = data.user.role === 'principal';
  const canAddObjective = ['principal', 'subject_teacher'].includes(data.user.role);
  const termId = activeTermId;
  const relevantSubjects = data.subjects;
  const objectives = data.objectives;
  const scoreRules = data.rules;
  const initialRule = relevantSubjects.length
    ? scoreRules.find((item) => Number(item.subject_id) === Number(relevantSubjects[0]!.id) && Number(item.term_id) === Number(termId))
    : undefined;
  return `
    ${pageHead('Kurikulum', 'Mata pelajaran dan TP', 'Struktur fleksibel per kelas/fase. Atur bobot nilai per periode tanpa formula bawaan.', termSelect())}
    <div class="grid two">
      <div class="stack">
        <article class="card"><h3 class="section-title">Mata pelajaran</h3>
          ${relevantSubjects.length ? `<div class="table-wrap"><table><thead><tr><th>Mata pelajaran</th><th>Kelas</th><th>TP</th></tr></thead><tbody>${relevantSubjects.map((subject) => `<tr><td><strong>${esc(subject.name)}</strong></td><td>${esc(subject.grade)} · Fase ${esc(subject.phase)}</td><td>${objectives.filter((objective) => Number(objective.subject_id) === Number(subject.id)).length}</td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada mata pelajaran.')}</article>
        ${canAddSubject ? `<article class="card"><h3 class="section-title">Tambah mata pelajaran</h3><form class="stack" data-action="subject"><div class="form-grid"><div class="field"><label>Nama mata pelajaran</label><input name="name" required /></div><div class="field"><label>Kelas</label><select name="grade">${[1, 2, 3, 4, 5, 6].map((grade) => `<option value="${grade}">Kelas ${grade} · Fase ${grade < 3 ? 'A' : grade < 5 ? 'B' : 'C'}</option>`).join('')}</select></div></div><button class="button primary" type="submit">Simpan mata pelajaran</button></form></article>` : ''}
        ${canAddObjective ? `<article class="card"><h3 class="section-title">Tambah tujuan pembelajaran</h3><form class="stack" data-action="objective"><div class="form-grid"><div class="field"><label>Mata pelajaran</label><select name="subjectId" required>${relevantSubjects.map((subject) => `<option value="${esc(subject.id)}">${esc(subject.name)} · Kelas ${esc(subject.grade)}</option>`).join('')}</select></div><div class="field"><label>Kode TP (opsional)</label><input name="code" /></div><div class="field full"><label>Deskripsi tujuan pembelajaran</label><textarea name="description" required></textarea></div></div><button class="button primary" type="submit" ${relevantSubjects.length ? '' : 'disabled'}>Simpan TP</button></form></article>` : ''}
      </div>
      <div class="stack">
        <article class="card"><h3 class="section-title">Bobot per mata pelajaran</h3>
          <p class="hint">Nilai tiap jenis dirata-ratakan dalam skala 0–100, lalu dikalikan bobot yang ditentukan. Jika suatu jenis berbobot di atas 0 namun belum ada nilai, rapor belum lengkap.</p>
          ${data.user.role === 'principal' ? `<form class="stack" data-action="weights"><div class="field"><label>Periode</label><select name="termId" required>${data.terms.map((term) => `<option value="${esc(term.id)}" ${String(term.id) === termId ? 'selected' : ''}>${esc(term.academic_year)} · Semester ${esc(term.semester)}</option>`).join('')}</select></div><div class="field"><label>Mata pelajaran</label><select name="subjectId" required>${relevantSubjects.map((subject) => { const rule = scoreRules.find((item) => Number(item.subject_id) === Number(subject.id) && Number(item.term_id) === Number(termId)); return `<option value="${esc(subject.id)}">${esc(subject.name)} · K${esc(subject.grade)}${rule ? ` (${esc(rule.formative_weight)} / ${esc(rule.summative_weight)})` : ' (belum diatur)'}</option>`; }).join('')}</select></div><div class="form-grid"><div class="field"><label>Formatif (%)</label><input name="formativeWeight" type="number" min="0" max="100" step="0.1" value="${esc(initialRule?.formative_weight ?? '')}" placeholder="0–100" required /></div><div class="field"><label>Sumatif (%)</label><input name="summativeWeight" type="number" min="0" max="100" step="0.1" value="${esc(initialRule?.summative_weight ?? '')}" placeholder="0–100" required /></div></div><div class="hint">Tidak ada bobot bawaan. Jumlah yang Anda pilih harus tepat 100%.</div><button class="button primary" type="submit">Simpan bobot</button></form>` : `<div class="callout warning">Hanya kepala sekolah yang dapat mengatur bobot.</div>`}
        </article>
        <article class="card"><h3 class="section-title">Tujuan pembelajaran</h3>${data.objectives.length ? `<div class="list">${data.objectives.map((objective) => `<div class="list-row"><div><strong>${esc(objective.code || 'TP')} · ${esc(objective.subject_name)}</strong><small>Kelas ${esc(objective.grade)} · Fase ${esc(objective.phase)} · ${esc(objective.description)}</small></div></div>`).join('')}</div>` : empty('Tambahkan TP untuk mulai membuat asesmen.')}</article>
      </div>
    </div>`;
}

function renderAssessments(): string {
  if (!data) return '';
  const teacher = data.user.role === 'subject_teacher';
  const students = data.students;
  const subjects = data.subjects;
  const termOptions = data.terms;
  const objectiveOptions = data.objectives;
  return `
    ${pageHead('Guru mata pelajaran', 'Asesmen dan narasi', 'Catat asesmen formatif/sumatif pada TP dan tinjau narasi sebelum rapor wali kelas.', termSelect())}
    ${teacher ? `<div class="grid two">
      <article class="card"><h3 class="section-title">Catat asesmen</h3><form class="stack" data-action="assessment"><div class="form-grid">
        <div class="field"><label>Siswa</label><select name="studentId" required>${students.map((student) => `<option value="${esc(student.id)}" data-grade="${esc(student.grade)}" data-phase="${esc(student.phase)}">${esc(student.name)} · ${esc(student.class_name)}</option>`).join('')}</select></div>
        <div class="field"><label>Periode</label><select name="termId" required>${termOptions.map((term) => `<option value="${esc(term.id)}" ${String(term.id) === activeTermId ? 'selected' : ''}>${esc(term.academic_year)} · S${esc(term.semester)}</option>`).join('')}</select></div>
        <div class="field full"><label>Tujuan pembelajaran</label><select name="objectiveId" required>${objectiveOptions.map((objective) => `<option value="${esc(objective.id)}" data-grade="${esc(objective.grade)}" data-phase="${esc(objective.phase)}">${esc(objective.subject_name)} · ${esc(objective.code || 'TP')} · K${esc(objective.grade)}</option>`).join('')}</select></div>
        <div class="field"><label>Jenis</label><select name="kind"><option value="formative">Formatif</option><option value="summative">Sumatif</option></select></div>
        <div class="field"><label>Nama asesmen</label><input name="title" required /></div>
        <div class="field"><label>Nilai</label><input name="score" type="number" min="0" step="0.1" required /></div>
        <div class="field"><label>Nilai maksimal</label><input name="maxScore" type="number" min="0.1" step="0.1" value="100" required /></div>
        <div class="field full"><label>Tanggal</label><input name="assessedOn" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div>
      </div><button class="button primary" type="submit" ${students.length && objectiveOptions.length && termOptions.length ? '' : 'disabled'}>Simpan asesmen</button></form></article>
      <article class="card"><h3 class="section-title">Narasi capaian</h3><form class="stack" data-action="narrative"><div class="form-grid">
        <div class="field"><label>Siswa</label><select name="studentId" required>${students.map((student) => `<option value="${esc(student.id)}" data-grade="${esc(student.grade)}" data-phase="${esc(student.phase)}">${esc(student.name)} · ${esc(student.class_name)}</option>`).join('')}</select></div>
        <div class="field"><label>Periode</label><select name="termId" required>${termOptions.map((term) => `<option value="${esc(term.id)}" ${String(term.id) === activeTermId ? 'selected' : ''}>${esc(term.academic_year)} · S${esc(term.semester)}</option>`).join('')}</select></div>
        <div class="field full"><label>Mata pelajaran</label><select name="subjectId" required>${subjects.map((subject) => `<option value="${esc(subject.id)}" data-grade="${esc(subject.grade)}" data-phase="${esc(subject.phase)}">${esc(subject.name)} · K${esc(subject.grade)}</option>`).join('')}</select></div>
        <div class="field full"><label>Narasi</label><textarea name="content" maxlength="2000" required placeholder="Jelaskan kekuatan dan hal yang dapat ditingkatkan secara spesifik."></textarea></div>
      </div><p class="hint">Menyimpan ulang narasi akan menghapus tanda tinjauan agar diperiksa kembali.</p><button class="button primary" type="submit" ${students.length && subjects.length && termOptions.length ? '' : 'disabled'}>Simpan narasi</button></form></article>
    </div>` : `<div class="callout warning">Pencatatan asesmen dan peninjauan narasi hanya tersedia bagi akun guru mata pelajaran.</div>`}
    ${teacher && data.narratives.length ? `<article class="card" style="margin-top:18px"><h3 class="section-title">Narasi untuk ditinjau</h3><div class="table-wrap"><table><thead><tr><th>Siswa</th><th>Mata pelajaran / periode</th><th>Narasi</th><th>Status</th></tr></thead><tbody>${data.narratives.map((narrative) => `<tr><td>${esc(narrative.student_name)}</td><td>${esc(narrative.subject_name)}<div class="hint">${esc(narrative.academic_year)} · S${esc(narrative.semester)}</div></td><td>${esc(narrative.content)}</td><td>${narrative.reviewed_at ? '<span class="badge good">Ditinjau</span>' : `<button class="button secondary small" data-review-narrative data-student="${esc(narrative.student_id)}" data-subject="${esc(narrative.subject_id)}" data-term="${esc(narrative.term_id)}">Tandai ditinjau</button>`}</td></tr>`).join('')}</tbody></table></div></article>` : ''}
    <article class="card" style="margin-top:18px"><h3 class="section-title">Alur kerja</h3><p class="hint">Gunakan siswa, kelas/fase, dan periode yang sesuai. Nilai dinormalisasi ke skala 100 per jenis asesmen, kemudian dihitung memakai bobot yang disimpan kepala sekolah untuk mata pelajaran dan periode tersebut. Nilai tidak otomatis diterbitkan.</p></article>`;
}

function renderAttendance(): string {
  if (!data) return '';
  const canImport = ['principal', 'homeroom_teacher'].includes(data.user.role);
  return `
    ${pageHead('Sistem sekolah terpisah', 'Impor kehadiran', 'Tidak ada pencatatan presensi di aplikasi ini. Impor file ekspor XLSX melalui ID siswa yang stabil.')}
    <div class="grid two">
      <article class="card"><h3 class="section-title">Impor ekspor XLSX</h3>
        <div class="callout">Kolom wajib: <strong>Tanggal, ID_Siswa, Nama, Kelas, Status</strong>. Status yang diterima: A (alfa), H (hadir), I (izin), S (sakit). Status legacy L/M tidak diterjemahkan dan akan membatalkan seluruh impor.</div>
        <p class="hint">Jika nama/kelas berbeda, sistem memberi peringatan tetapi tetap mencocokkan berdasarkan ID_Siswa. Baris dengan ID tidak dikenal, status bertentangan, tanggal salah, atau konflik status akan membatalkan impor secara utuh. Impor ulang status identik tidak membuat duplikat.</p>
        ${canImport ? `<form class="stack" data-action="attendance" style="margin-top:18px"><div class="field"><label>File laporan harian (.xlsx)</label><input name="file" type="file" accept=".xlsx" required /></div><button class="button primary" type="submit">Validasi dan impor</button></form>` : `<div class="callout warning">Hanya kepala sekolah dan wali kelas yang dapat mengimpor data kehadiran.</div>`}
      </article>
      <article class="card"><h3 class="section-title">Riwayat impor</h3>${data.attendanceImports.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Baris baru</th><th>Tidak berubah</th></tr></thead><tbody>${data.attendanceImports.map((item) => `<tr><td>${esc(item.imported_at)}</td><td>${esc(item.rows_added)}</td><td>${esc(item.rows_unchanged)}</td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada impor.')}</article>
    </div>`;
}

function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Draf',
    homeroom_review: 'Ditinjau wali kelas',
    principal_approval: 'Persetujuan kepala sekolah',
    finalized: 'Final'
  };
  const style = status === 'finalized' ? 'good' : status === 'draft' ? 'warn' : '';
  return `<span class="badge ${style}">${esc(labels[status] ?? status)}</span>`;
}

function renderReports(): string {
  if (!data) return '';
  const activeTerm = selectedTerm();
  const rows = reportRows;
  return `
    ${pageHead('Leger & rapor', 'Rapor semester', 'Tinjau kelengkapan data per siswa sebelum wali kelas dan kepala sekolah melanjutkan alur penerbitan.', termSelect())}
    <article class="card"><div class="table-wrap">
      ${rows.length ? `<table><thead><tr><th>Siswa / rombel</th><th>Nilai mapel</th><th>Kehadiran</th><th>Status</th><th>Kesiapan / tindakan</th></tr></thead><tbody>
      ${rows.map((row) => {
        const scoreCells = row.subjects.map((subject) => `<details><summary>${esc(subject.name)}: <strong>${subject.score === null ? '—' : esc(subject.score)}</strong></summary><div class="hint">${esc(subject.narrative || 'Narasi belum diisi.')}</div><span class="badge ${subject.narrativeReviewed ? 'good' : 'warn'}">${subject.narrativeReviewed ? 'Narasi ditinjau' : 'Narasi belum ditinjau'}</span></details>`).join('');
        const readyText = row.ready ? '<span class="badge good">Lengkap</span>' : `<span class="badge warn">${row.issues.length} hal perlu dilengkapi</span><div class="hint">${row.issues.map(esc).join('<br />')}</div>`;
        let action = '';
        if (row.ready && row.status === 'draft' && data!.user.role === 'homeroom_teacher') action = `<button class="button primary small" data-report-action="review" data-student="${row.student.id}">Tinjau rapor</button>`;
        if (row.ready && row.status === 'homeroom_review' && data!.user.role === 'principal') action = `<button class="button secondary small" data-report-action="approve" data-student="${row.student.id}">Setujui</button>`;
        if (row.ready && row.status === 'principal_approval' && data!.user.role === 'principal') action = `<button class="button primary small" data-report-action="finalize" data-student="${row.student.id}">Finalkan</button>`;
        if (row.status === 'finalized') action = `<button class="button secondary small" data-report-action="print" data-student="${row.student.id}">Buka rapor</button>`;
        return `<tr><td><strong>${esc(row.student.name)}</strong><div class="hint">${esc(row.student.student_code)} · ${esc(row.student.class_name)}</div></td><td>${scoreCells || '—'}</td><td>H ${row.attendance.H} · A ${row.attendance.A} · I ${row.attendance.I} · S ${row.attendance.S}</td><td>${statusBadge(row.status)}</td><td>${readyText}<div class="actions" style="margin-top:8px">${action}</div></td></tr>`;
      }).join('')}
      </tbody></table>` : empty(activeTerm ? 'Belum ada data rapor untuk periode ini.' : 'Tambahkan periode rapor di Pengaturan.')}
    </div></article>
    <p class="hint">Rapor mensyaratkan bobot yang tersimpan, asesmen sesuai semua jenis berbobot, narasi yang sudah ditinjau guru, dan setidaknya satu data kehadiran dalam rentang periode. Isi kokurikuler, profil, dan ekstrakurikuler dapat dilengkapi wali kelas.</p>
    ${data.user.role === 'homeroom_teacher' ? `<article class="card" style="margin-top:18px"><h3 class="section-title">Bagian rapor tambahan</h3><p class="hint">Kokurikuler, perkembangan profil, dan ekstrakurikuler bersifat opsional. Bagian kosong tidak ditampilkan pada rapor cetak.</p><form class="stack" data-action="section"><div class="form-grid"><div class="field"><label>Siswa</label><select name="studentId" required>${data.students.map((student) => `<option value="${esc(student.id)}">${esc(student.name)} · ${esc(student.class_name)}</option>`).join('')}</select></div><div class="field"><label>Bagian</label><select name="sectionKey"><option value="kokurikuler">Kokurikuler</option><option value="profil">Perkembangan profil</option><option value="ekstrakurikuler">Ekstrakurikuler</option></select></div><div class="field full"><label>Catatan (kosongkan untuk menghapus dari rapor)</label><textarea name="content" maxlength="2000">${esc(rows.find((row) => row.student.id === Number(data!.students[0]?.id))?.sections.kokurikuler || '')}</textarea></div></div><input type="hidden" name="termId" value="${esc(activeTermId)}" /><button class="button primary" type="submit" ${data.students.length ? '' : 'disabled'}>Simpan bagian</button></form></article>` : ''}`;
}

function renderSettings(): string {
  if (!data) return '';
  const settings = data.settings;
  const isPrincipal = data.user.role === 'principal';
  const roleOptions: [Role, string][] = [
    ['subject_teacher', roleLabel.subject_teacher],
    ['homeroom_teacher', roleLabel.homeroom_teacher],
    ['principal', roleLabel.principal]
  ];
  return `
    ${pageHead('Kepala sekolah', 'Pengaturan sekolah', 'Identitas sekolah dapat dikosongkan; nama dan logo hanya muncul bila diisi.')}
    <div class="grid two">
      <article class="card"><h3 class="section-title">Identitas sekolah</h3>
        ${isPrincipal ? `<form class="stack" data-action="settings"><div class="field"><label>Nama sekolah (opsional)</label><input name="name" value="${esc(settings.name)}" /></div><div class="field"><label>URL logo (opsional)</label><input name="logoUrl" type="url" value="${esc(settings.logo_url)}" placeholder="https://…" /></div><div class="field"><label>Kota (opsional)</label><input name="city" value="${esc(settings.city)}" /></div><div class="field"><label>Nama kepala sekolah (opsional)</label><input name="principalName" value="${esc(settings.principal_name)}" /></div><button class="button primary" type="submit">Simpan identitas</button></form>` : `<div class="callout warning">Hanya kepala sekolah yang dapat mengedit identitas sekolah.</div>`}
      </article>
      <div class="stack">
        <article class="card"><h3 class="section-title">Periode akademik</h3>${data.terms.length ? `<div class="list">${data.terms.map((term) => `<div class="list-row"><div><strong>${esc(term.academic_year)} · Semester ${esc(term.semester)}</strong><small>${esc(term.starts_on)} sampai ${esc(term.ends_on)}</small></div></div>`).join('')}</div>` : empty('Belum ada periode.')}${isPrincipal ? `<hr class="divider" /><form class="stack" data-action="term"><div class="form-grid"><div class="field"><label>Tahun ajaran</label><input name="academicYear" placeholder="2026/2027" required /></div><div class="field"><label>Semester</label><select name="semester"><option value="1">Semester 1</option><option value="2">Semester 2</option></select></div><div class="field"><label>Tanggal mulai</label><input name="startsOn" type="date" required /></div><div class="field"><label>Tanggal akhir</label><input name="endsOn" type="date" required /></div></div><button class="button primary" type="submit">Tambah periode</button></form>` : ''}</article>
        <article class="card"><h3 class="section-title">Akun pengguna</h3>${data.users.length ? `<div class="list">${data.users.map((user) => `<div class="list-row"><div><strong>${esc(user.name)}</strong><small>${esc(user.username)} · ${esc(roleLabel[user.role as Role])}</small></div></div>`).join('')}</div>` : empty('Daftar akun hanya dapat dilihat kepala sekolah.')}${isPrincipal ? `<hr class="divider" /><form class="stack" data-action="user"><div class="form-grid"><div class="field"><label>Nama lengkap</label><input name="name" required /></div><div class="field"><label>Nama pengguna</label><input name="username" required /></div><div class="field"><label>Peran</label><select name="role">${roleOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><div class="field"><label>Kata sandi sementara (min. 12 karakter)</label><input name="password" type="password" minlength="12" required /></div></div><button class="button primary" type="submit">Buat akun</button></form>` : ''}</article>
      </div>
    </div>`;
}

async function handleSubmit(form: HTMLFormElement): Promise<void> {
  const action = form.dataset.action;
  const fields = Object.fromEntries(new FormData(form).entries());
  if (action === 'setup' || action === 'login') {
    const result = await request<{ user: User }>(`/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });
    data = null;
    screen = 'dashboard';
    await refresh();
    showToast(`Selamat datang, ${result.user.name}.`);
    return;
  }
  if (action === 'attendance') {
    const file = (fields.file as File | undefined);
    if (!file || file.size === 0) throw new Error('Pilih file XLSX terlebih dahulu.');
    const response = await fetch('/api/attendance/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer()
    });
    const result = (await response.json()) as {
      error?: string;
      imported?: number;
      unchanged?: number;
      warnings?: { row: number; message: string }[];
      issues?: { row: number; message: string }[];
    };
    if (!response.ok) {
      const details = (result.issues ?? []).slice(0, 8).map((item) => `Baris ${item.row}: ${item.message}`).join('\n');
      const warnings = (result.warnings ?? []).slice(0, 5).map((item) => `Peringatan baris ${item.row}: ${item.message}`).join('\n');
      throw new Error([result.error ?? 'Impor gagal.', details, warnings].filter(Boolean).join('\n'));
    }
    const warnings = (result.warnings ?? []).slice(0, 5).map((item) => `Baris ${item.row}: ${item.message}`).join('\n');
    await refresh();
    showToast(`Impor berhasil: ${result.imported} baris baru, ${result.unchanged} tidak berubah.${warnings ? ` ${warnings}` : ''}`);
    return;
  }
  const endpoints: Record<string, string> = {
    class: '/api/classes',
    student: '/api/students',
    subject: '/api/subjects',
    objective: '/api/objectives',
    assessment: '/api/assessments',
    narrative: '/api/narratives',
    section: '/api/report-sections',
    weights: '/api/score-rules',
    term: '/api/terms',
    user: '/api/users',
    settings: '/api/settings'
  };
  const endpoint = action ? endpoints[action] : undefined;
  if (!endpoint) return;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof File) continue;
    normalized[key] = value;
  }
  await post(endpoint, normalized);
  if (action === 'weights' && typeof normalized.termId === 'string') activeTermId = normalized.termId;
  await refresh();
  showToast('Perubahan berhasil disimpan.');
}

async function handleReportAction(button: HTMLButtonElement): Promise<void> {
  const studentId = button.dataset.student;
  const action = button.dataset.reportAction;
  if (!studentId || !action) return;
  if (action === 'print') {
    window.open(`/report?studentId=${encodeURIComponent(studentId)}&termId=${encodeURIComponent(activeTermId)}`, '_blank', 'noopener');
    return;
  }
  await post(`/api/reports/${encodeURIComponent(studentId)}/${action}`, { termId: Number(activeTermId) });
  await refresh();
  showToast('Status rapor diperbarui.');
}

function syncLinkedChoices(form: HTMLFormElement): void {
  const student = form.querySelector<HTMLSelectElement>('select[name="studentId"]');
  const linked = form.querySelector<HTMLSelectElement>('select[name="objectiveId"], select[name="subjectId"]');
  const selected = student?.selectedOptions[0];
  if (!student || !linked || !selected) return;
  for (const option of linked.options) {
    const matches =
      option.dataset.grade === selected.dataset.grade &&
      option.dataset.phase === selected.dataset.phase;
    option.hidden = !matches;
    option.disabled = !matches;
  }
  if (linked.selectedOptions[0]?.disabled) {
    const firstAvailable = [...linked.options].find((option) => !option.disabled);
    if (firstAvailable) firstAvailable.selected = true;
  }
}

appRoot.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const screenButton = target.closest<HTMLElement>('[data-screen]');
  if (screenButton?.dataset.screen) {
    screen = screenButton.dataset.screen;
    await refresh();
    return;
  }
  const reportButton = target.closest<HTMLButtonElement>('[data-report-action]');
  if (reportButton) {
    try {
      await handleReportAction(reportButton);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Aksi gagal.', true);
    }
    return;
  }
  const narrativeButton = target.closest<HTMLButtonElement>('[data-review-narrative]');
  if (narrativeButton) {
    try {
      await post(
        `/api/narratives/${encodeURIComponent(narrativeButton.dataset.student ?? '')}/${encodeURIComponent(narrativeButton.dataset.subject ?? '')}/${encodeURIComponent(narrativeButton.dataset.term ?? '')}/review`,
        {}
      );
      await refresh();
      showToast('Narasi ditandai telah ditinjau.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Tinjauan narasi gagal.', true);
    }
    return;
  }
  if (target.closest('[data-action="logout"]')) {
    try {
      await request('/api/auth/logout', { method: 'POST' });
      data = null;
      renderAuth(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Keluar gagal.', true);
    }
  }
});

appRoot.addEventListener('change', async (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.id === 'term-select') {
    activeTermId = target.value;
    try {
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Periode gagal dimuat.', true);
    }
    return;
  }
  if (target instanceof HTMLSelectElement && target.closest('form[data-action="section"]')) {
    const form = target.closest<HTMLFormElement>('form[data-action="section"]')!;
    const studentId = Number(new FormData(form).get('studentId'));
    const sectionKey = String(new FormData(form).get('sectionKey') ?? '');
    const content = form.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
    const report = reportRows.find((row) => row.student.id === studentId);
    if (content) content.value = report?.sections[sectionKey] ?? '';
    return;
  }
  if (target instanceof HTMLSelectElement && target.name === 'studentId') {
    const form = target.closest<HTMLFormElement>('form[data-action="assessment"], form[data-action="narrative"]');
    if (form) syncLinkedChoices(form);
    return;
  }
  if (target instanceof HTMLSelectElement && target.closest('form[data-action="weights"]')) {
    const form = target.closest<HTMLFormElement>('form[data-action="weights"]')!;
    const termId = Number(form.querySelector<HTMLSelectElement>('select[name="termId"]')?.value);
    const subjectId = Number(form.querySelector<HTMLSelectElement>('select[name="subjectId"]')?.value);
    const rule = data?.rules.find((item) => Number(item.term_id) === termId && Number(item.subject_id) === subjectId);
    const formative = form.querySelector<HTMLInputElement>('input[name="formativeWeight"]');
    const summative = form.querySelector<HTMLInputElement>('input[name="summativeWeight"]');
    if (formative) formative.value = rule ? String(rule.formative_weight) : '';
    if (summative) summative.value = rule ? String(rule.summative_weight) : '';
  }
});

appRoot.addEventListener('submit', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  event.preventDefault();
  const button = target.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await handleSubmit(target);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Data gagal disimpan.', true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
});

void boot();
