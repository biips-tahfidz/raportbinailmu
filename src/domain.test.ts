import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parseAttendanceWorkbook } from './attendance.js';
import { calculateSubjectScore, phaseForGrade } from './domain.js';

test('score calculation applies the saved weights to normalized category means', () => {
  const result = calculateSubjectScore(
    { formativeWeight: 30, summativeWeight: 70 },
    [
      { kind: 'formative', score: 8, maxScore: 10 },
      { kind: 'summative', score: 18, maxScore: 20 }
    ]
  );
  assert.deepEqual(result, { score: 87, missingKinds: [] });
});

test('positive-weight categories without scores keep the report incomplete', () => {
  const result = calculateSubjectScore(
    { formativeWeight: 50, summativeWeight: 50 },
    [{ kind: 'formative', score: 8, maxScore: 10 }]
  );
  assert.equal(result.score, null);
  assert.deepEqual(result.missingKinds, ['summative']);
});

test('phase mapping covers all SD grades and rejects out-of-range values', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(phaseForGrade), ['A', 'A', 'B', 'B', 'C', 'C']);
  assert.throws(() => phaseForGrade(7));
});

async function workbook(rows: Record<string, unknown>[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Rekap Siswa');
  const headers = ['Tanggal', 'ID_Siswa', 'Nama', 'Kelas', 'Status', 'Jam', 'Metode', 'Diinput_Oleh'];
  sheet.addRow(headers);
  for (const item of rows) sheet.addRow(headers.map((header) => item[header] ?? ''));
  return Buffer.from(await book.xlsx.writeBuffer());
}

const row = (status: string, studentId = 'SYN-001', date = '2026-09-10') => ({
  Tanggal: date,
  ID_Siswa: studentId,
  Nama: 'Siswa Contoh',
  Kelas: '4A Contoh',
  Status: status,
  Jam: '-',
  Metode: 'Contoh',
  Diinput_Oleh: 'Sistem Contoh'
});

test('attendance import supports only A/H/I/S and explicitly rejects legacy codes', async () => {
  const parsed = await parseAttendanceWorkbook(await workbook([row('A'), row('H', 'SYN-002'), row('M', 'SYN-003')]));
  assert.deepEqual(parsed.rows.map((item) => item.status), ['A', 'H']);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!.message, /legacy/);
});

test('attendance import reports conflicting duplicates and collapses identical duplicates', async () => {
  const parsed = await parseAttendanceWorkbook(
    await workbook([row('H'), row('H'), row('S', 'SYN-001', '2026-09-10')])
  );
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!.message, /bentrok/);
});
