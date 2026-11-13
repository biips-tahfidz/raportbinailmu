import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';

export type AttendanceStatus = 'A' | 'H' | 'I' | 'S';

export interface AttendanceRow {
  date: string;
  studentCode: string;
  name: string;
  className: string;
  status: string;
}

export interface AttendanceIssue {
  row: number;
  message: string;
}

export interface ValidAttendanceRow extends AttendanceRow {
  status: AttendanceStatus;
  row: number;
}

export interface AttendancePreview {
  rows: ValidAttendanceRow[];
  issues: AttendanceIssue[];
  warnings: AttendanceIssue[];
  fileHash: string;
}

const REQUIRED_COLUMNS = ['Tanggal', 'ID_Siswa', 'Nama', 'Kelas', 'Status'];
const ALLOWED_STATUSES = new Set<AttendanceStatus>(['A', 'H', 'I', 'S']);

export async function parseAttendanceWorkbook(buffer: Buffer): Promise<AttendancePreview> {
  const workbook = new ExcelJS.Workbook();
  const workbookData = new ArrayBuffer(buffer.length);
  new Uint8Array(workbookData).set(buffer);
  await workbook.xlsx.load(workbookData);
  const sheet =
    workbook.getWorksheet('Rekap Siswa') ??
    workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook tidak memiliki lembar kerja.');
  if (sheet.rowCount < 2) throw new Error('Workbook tidak memiliki baris data.');
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber - 1] = cell.text.trim();
  });
  const columns = headers.filter(Boolean);
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missingColumns.length > 0) {
    throw new Error(`Kolom wajib tidak ditemukan: ${missingColumns.join(', ')}.`);
  }

  const rows: ValidAttendanceRow[] = [];
  const issues: AttendanceIssue[] = [];
  const warnings: AttendanceIssue[] = [];
  const seen = new Map<string, AttendanceStatus>();

  sheet.eachRow((worksheetRow, rowNumber) => {
    if (rowNumber === 1) return;
    const record = Object.fromEntries(
      headers.map((header, index) => [header, readCell(worksheetRow.getCell(index + 1).value)])
    );
    const date = normalizeDate(record.Tanggal);
    const studentCode = String(record.ID_Siswa ?? '').trim();
    const name = String(record.Nama ?? '').trim();
    const className = String(record.Kelas ?? '').trim();
    const statusText = String(record.Status ?? '').trim().toUpperCase();

    if (!date || !studentCode || !name || !className) {
      issues.push({ row: rowNumber, message: 'Tanggal, ID_Siswa, Nama, dan Kelas wajib diisi.' });
      return;
    }
    if (!ALLOWED_STATUSES.has(statusText as AttendanceStatus)) {
      const detail = ['L', 'M'].includes(statusText)
        ? `Status ${statusText} adalah status legacy yang tidak didukung.`
        : `Status "${statusText}" tidak valid; gunakan A, H, I, atau S.`;
      issues.push({ row: rowNumber, message: detail });
      return;
    }

    const status = statusText as AttendanceStatus;
    const key = `${date}\u0000${studentCode}`;
    const previous = seen.get(key);
    if (previous) {
      if (previous !== status) {
        issues.push({
          row: rowNumber,
          message: `Status bentrok untuk ID_Siswa dan tanggal yang sama (${previous} vs ${status}).`
        });
      } else {
        warnings.push({ row: rowNumber, message: 'Baris duplikat identik diabaikan.' });
      }
      return;
    }

    seen.set(key, status);
    rows.push({ row: rowNumber, date, studentCode, name, className, status });
  });

  return {
    rows,
    issues,
    warnings,
    fileHash: createHash('sha256').update(buffer).digest('hex')
  };
}

function readCell(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) {
    if ('text' in value) return value.text;
    if ('result' in value) return value.result;
    return '';
  }
  return value ?? '';
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const isoDate = new Date(`${raw}T00:00:00.000Z`);
    return !Number.isNaN(isoDate.getTime()) && isoDate.toISOString().slice(0, 10) === raw ? raw : null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
