export {};

interface ReportResponse {
  student: { student_code: string; name: string; class_name: string; grade: number };
  term: { academic_year: string; semester: number };
  subjects: { name: string; score: number | null; narrative: string | null }[];
  sections: Record<string, string>;
  attendance: Record<string, number>;
  settings: { name: string | null; logo_url: string | null; city: string | null; principal_name: string | null };
  state: string;
}

const root = document.querySelector<HTMLElement>('#report')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const printButton = document.querySelector<HTMLButtonElement>('#print-button')!;
const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character]!;
  });

async function load(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const studentId = params.get('studentId');
  const termId = params.get('termId');
  if (!studentId || !termId) throw new Error('Tautan rapor tidak lengkap.');
  const response = await fetch(`/api/report/${encodeURIComponent(studentId)}?termId=${encodeURIComponent(termId)}`);
  const result = (await response.json()) as ReportResponse & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Rapor tidak dapat dibuka.');
  if (result.state !== 'finalized') throw new Error('Rapor belum difinalisasi.');

  const schoolName = result.settings.name
    ? `<h1>${esc(result.settings.name)}</h1>`
    : '<h1>Laporan Hasil Belajar</h1>';
  const logo = result.settings.logo_url
    ? `<img src="${esc(result.settings.logo_url)}" alt="Logo sekolah" />`
    : '';
  const schoolCity = result.settings.city ? `<p>${esc(result.settings.city)}</p>` : '';
  const schoolHeading = result.settings.name
    ? `<p>Laporan Hasil Belajar Peserta Didik</p>`
    : '';
  const section = (key: string, title: string): string => {
    const content = result.sections[key];
    if (!content) return '';
    return `<h2>${esc(title)}</h2><div class="report-section">${esc(content)}</div>`;
  };
  const attendanceLabels: Record<string, string> = { H: 'Hadir', A: 'Alfa', I: 'Izin', S: 'Sakit' };

  root.innerHTML = `
    <header class="report-header">${logo}<div>${schoolName}${schoolHeading}${schoolCity}</div></header>
    <div class="report-title">Rapor Semester ${esc(result.term.semester)}<br />Tahun Ajaran ${esc(result.term.academic_year)}</div>
    <div class="identity">
      <div><span>Nama peserta didik</span><br /><strong>${esc(result.student.name)}</strong></div>
      <div><span>ID siswa</span><br /><strong>${esc(result.student.student_code)}</strong></div>
      <div><span>Kelas</span><br /><strong>${esc(result.student.grade)} · ${esc(result.student.class_name)}</strong></div>
      <div><span>Fase</span><br /><strong>${result.student.grade < 3 ? 'A' : result.student.grade < 5 ? 'B' : 'C'}</strong></div>
    </div>
    <h2>Capaian pembelajaran</h2>
    <table class="report-table"><thead><tr><th style="width:28px">No.</th><th>Mata pelajaran</th><th style="width:72px">Nilai</th><th>Catatan capaian</th></tr></thead><tbody>
      ${result.subjects.map((subject, index) => `<tr><td>${index + 1}</td><td>${esc(subject.name)}</td><td>${subject.score === null ? '—' : esc(subject.score)}</td><td>${esc(subject.narrative)}</td></tr>`).join('')}
    </tbody></table>
    ${section('kokurikuler', 'Kokurikuler')}
    ${section('profil', 'Perkembangan profil')}
    ${section('ekstrakurikuler', 'Ekstrakurikuler')}
    <h2>Kehadiran</h2>
    <div class="attendance-summary">${Object.entries(attendanceLabels).map(([key, label]) => `<span><strong>${label}:</strong> ${result.attendance[key] ?? 0} hari</span>`).join('')}</div>
    <div class="signatures">
      <div>Orang tua / wali<div class="signature-space"></div><div>________________________</div></div>
      <div>${esc(result.settings.city || 'Tempat')},<div class="signature-space"></div><div class="signature-name">${esc(result.settings.principal_name || 'Kepala sekolah')}</div></div>
    </div>`;
  printButton.disabled = false;
}

printButton.addEventListener('click', () => window.print());
void load().catch((error: unknown) => {
  root.innerHTML = `<div class="callout error">${esc(error instanceof Error ? error.message : 'Rapor tidak dapat dibuka.')}</div>`;
  toast.textContent = error instanceof Error ? error.message : 'Rapor tidak dapat dibuka.';
  toast.classList.add('show', 'error-toast');
});
