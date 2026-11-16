export type ProtectedEdit =
  | 'class-grade'
  | 'class-name'
  | 'student-code'
  | 'student-name'
  | 'student-class'
  | 'subject-name'
  | 'subject-grade'
  | 'objective'
  | 'term';

const editMessages: Record<ProtectedEdit, string> = {
  'class-grade': 'Tingkat rombel tidak dapat diubah karena masih memiliki siswa.',
  'class-name': 'Nama rombel tidak dapat diubah karena sudah tercantum pada rapor yang ditinjau.',
  'student-code': 'ID siswa tidak dapat diubah karena sudah digunakan oleh data rapor atau kehadiran.',
  'student-name': 'Nama siswa tidak dapat diubah karena sudah tercantum pada rapor yang ditinjau.',
  'student-class': 'Rombel siswa tidak dapat diubah karena data rapor atau kehadirannya sudah digunakan.',
  'subject-name': 'Nama mata pelajaran tidak dapat diubah karena sudah tercantum pada rapor yang ditinjau.',
  'subject-grade': 'Tingkat mata pelajaran tidak dapat diubah karena sudah digunakan dalam TP atau rapor.',
  objective: 'Tujuan pembelajaran tidak dapat diubah karena sudah digunakan dalam asesmen.',
  term: 'Periode tidak dapat diubah karena sudah digunakan oleh data rapor atau kehadiran.'
};

export function assertProtectedEditAllowed(edit: ProtectedEdit, hasRelatedData: boolean): void {
  if (hasRelatedData) throw new Error(editMessages[edit]);
}
