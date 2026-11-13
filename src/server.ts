import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { db, execute, many, one, transaction } from './db.js';
import {
  calculateSubjectScore,
  formatDate,
  phaseForGrade,
  type AssessmentKind,
  type AssessmentScore
} from './domain.js';
import { parseAttendanceWorkbook } from './attendance.js';

type Role = 'subject_teacher' | 'homeroom_teacher' | 'principal';
interface User {
  id: number;
  name: string;
  username: string;
  role: Role;
}
interface AuthenticatedRequest extends Request {
  user?: User;
}

class AuthenticationError extends Error {}

const app = express();
const port = Number(process.env.PORT ?? 3000);
const roleNames: Record<Role, string> = {
  subject_teacher: 'Guru mata pelajaran',
  homeroom_teacher: 'Wali kelas',
  principal: 'Kepala sekolah'
};

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(process.cwd(), 'public')));

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function route(
  handler: (req: AuthenticatedRequest, res: Response) => void | Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req as AuthenticatedRequest, res))
      .catch(next);
  };
}

async function getUserFromCookie(req: Request): Promise<User | undefined> {
  const cookie = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('raport_session='));
  const token = cookie?.slice('raport_session='.length);
  if (!token) return undefined;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return one<User>(
      `SELECT users.id, users.name, users.username, users.role
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP`,
      tokenHash
    );
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  void getUserFromCookie(req)
    .then((user) => {
      if (!user) {
        fail(res, 401, 'Silakan masuk terlebih dahulu.');
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      fail(res, 403, 'Aksi ini tidak diizinkan untuk peran Anda.');
      return;
    }
    next();
  };
}

async function audit(userId: number, action: string, entity: string, entityId?: number | string): Promise<void> {
  await execute('INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)',
    userId,
    action,
    entity,
    entityId == null ? null : String(entityId)
  );
}

function requireText(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`${label} wajib diisi (maksimal ${maxLength} karakter).`);
  }
  return value.trim();
}

function safeDate(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} tidak valid.`);
  return formatDate(value);
}

async function createSession(userId: number, res: Response): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL '7 days')",
    tokenHash,
    userId
  );
  res.cookie('raport_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function issueToken(req: Request, res: Response): Promise<User> {
  const body = req.body as Record<string, unknown>;
  const username = requireText(body.username, 'Nama pengguna', 50).toLocaleLowerCase('id-ID');
  const password = requireText(body.password, 'Kata sandi', 200);
  const user = await one<User & { password_hash: string }>(
    'SELECT * FROM users WHERE username = ?',
    username
  );
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AuthenticationError('Nama pengguna atau kata sandi tidak cocok.');
  }
  await createSession(user.id, res);
  return { id: user.id, name: user.name, username: user.username, role: user.role };
}

interface StudentRow {
  id: number;
  student_code: string;
  name: string;
  class_id: number;
  class_name: string;
  grade: number;
  phase: 'A' | 'B' | 'C';
}
interface ReportSubject {
  subjectId: number;
  name: string;
  score: number | null;
  narrative: string | null;
  narrativeReviewed: boolean;
}

async function reportData(studentId: number, termId: number): Promise<{
  student: StudentRow;
  term: { id: number; academic_year: string; semester: number; starts_on: string; ends_on: string };
  subjects: ReportSubject[];
  sections: Record<string, string>;
  attendance: Record<string, number>;
  state: string;
  issues: string[];
}> {
  const student = await one<StudentRow>(
      `SELECT students.id, students.student_code, students.name, students.class_id,
              classes.name AS class_name, classes.grade, classes.phase
       FROM students JOIN classes ON classes.id = students.class_id WHERE students.id = ?`,
      studentId
    );
  const term = await one<{
    id: number;
    academic_year: string;
    semester: number;
    starts_on: string;
    ends_on: string;
  }>('SELECT id, academic_year, semester, starts_on, ends_on FROM academic_terms WHERE id = ?', termId);
  if (!student || !term) throw new Error('Siswa atau periode tidak ditemukan.');

  const subjectRows = await many<{ id: number; name: string }>(
    'SELECT id, name FROM subjects WHERE grade = ? AND phase = ? ORDER BY name',
    student.grade,
    student.phase
  );
  const rules = await many<{
    subject_id: number;
    formative_weight: number;
    summative_weight: number;
  }>('SELECT subject_id, formative_weight, summative_weight FROM score_rules WHERE term_id = ?', termId);
  const ruleMap = new Map(
    rules.map((rule) => [
      rule.subject_id,
      { formativeWeight: rule.formative_weight, summativeWeight: rule.summative_weight }
    ])
  );
  const assessmentsBySubject = await many<{
    subject_id: number;
    kind: AssessmentKind;
    score: number;
    max_score: number;
  }>(
      `SELECT learning_objectives.subject_id, assessments.kind, assessments.score, assessments.max_score
       FROM assessments
       JOIN learning_objectives ON learning_objectives.id = assessments.objective_id
       WHERE assessments.student_id = ? AND assessments.term_id = ?`,
      studentId,
      termId
    );
  const narratives = await many<{
    subject_id: number;
    content: string;
    reviewed_at: string | null;
  }>(
    'SELECT subject_id, content, reviewed_at FROM narratives WHERE student_id = ? AND term_id = ?',
    studentId,
    termId
  );
  const narrativeMap = new Map(narratives.map((narrative) => [narrative.subject_id, narrative]));
  const subjects = subjectRows.map((subject) => {
    const scores = assessmentsBySubject
      .filter((assessment) => assessment.subject_id === subject.id)
      .map<AssessmentScore>((assessment) => ({
        kind: assessment.kind,
        score: assessment.score,
        maxScore: assessment.max_score
      }));
    const result = calculateSubjectScore(ruleMap.get(subject.id), scores);
    const narrative = narrativeMap.get(subject.id);
    return {
      subjectId: subject.id,
      name: subject.name,
      score: result.score,
      narrative: narrative?.content ?? null,
      narrativeReviewed: Boolean(narrative?.reviewed_at)
    };
  });

  const sectionRows = await many<{ section_key: string; content: string }>(
    'SELECT section_key, content FROM report_sections WHERE student_id = ? AND term_id = ?',
    studentId,
    termId
  );
  const sections = Object.fromEntries(sectionRows.map((section) => [section.section_key, section.content]));
  const counts = await many<{ status: string; count: string }>(
      `SELECT status, COUNT(*) AS count FROM attendance
       WHERE student_id = ? AND attendance_date BETWEEN ? AND ? GROUP BY status`,
      studentId,
      term.starts_on,
      term.ends_on
    );
  const attendance = { H: 0, A: 0, I: 0, S: 0 };
  for (const count of counts) attendance[count.status as keyof typeof attendance] = Number(count.count);

  const stateRow = await one<{ status: string }>(
    'SELECT status FROM report_states WHERE student_id = ? AND term_id = ?',
    studentId,
    termId
  );
  const issues: string[] = [];
  if (subjects.length === 0) issues.push('Belum ada mata pelajaran untuk kelas/fase ini.');
  for (const subject of subjects) {
    if (subject.score === null) issues.push(`Nilai ${subject.name} belum lengkap atau bobot belum diatur.`);
    if (!subject.narrative) issues.push(`Narasi ${subject.name} belum diisi.`);
    else if (!subject.narrativeReviewed) issues.push(`Narasi ${subject.name} belum ditinjau guru.`);
  }
  if (Object.values(attendance).reduce((sum, count) => sum + count, 0) === 0) {
    issues.push('Data kehadiran untuk periode ini belum diimpor.');
  }

  return {
    student,
    term,
    subjects,
    sections,
    attendance,
    state: stateRow?.status ?? 'draft',
    issues
  };
}

async function assertReportDraft(studentId: number, termId: number): Promise<void> {
  const state = await one<{ status: string }>(
    'SELECT status FROM report_states WHERE student_id = ? AND term_id = ?',
    studentId,
    termId
  );
  if (state && state.status !== 'draft') {
    throw new Error('Data rapor dikunci setelah ditinjau wali kelas. Minta kepala sekolah mengembalikan rapor ke draf.');
  }
}

app.get(
  '/api/auth/status',
  route(async (_req, res) => {
    const userCount = await one<{ count: string }>('SELECT COUNT(*) AS count FROM users');
    res.json({
      needsSetup: Number(userCount?.count ?? 0) === 0,
      requiresSetupToken: process.env.NODE_ENV === 'production'
    });
  })
);

app.post(
  '/api/auth/setup',
  route(async (req, res) => {
    const currentCount = await one<{ count: string }>('SELECT COUNT(*) AS count FROM users');
    if (Number(currentCount?.count ?? 0) !== 0) {
      fail(res, 409, 'Pengaturan awal sudah selesai.');
      return;
    }
    if (process.env.NODE_ENV === 'production') {
      const expectedToken = process.env.INITIAL_SETUP_TOKEN;
      if (!expectedToken || expectedToken.length < 32) {
        fail(res, 503, 'Token setup awal minimal 32 karakter harus dikonfigurasi oleh operator.');
        return;
      }
      const submittedToken = typeof req.body.setupToken === 'string' ? req.body.setupToken : '';
      const expectedHash = createHash('sha256').update(expectedToken).digest();
      const submittedHash = createHash('sha256').update(submittedToken).digest();
      if (!timingSafeEqual(expectedHash, submittedHash)) {
        fail(res, 403, 'Token setup awal tidak valid.');
        return;
      }
    }
    const name = requireText(req.body.name, 'Nama kepala sekolah');
    const username = requireText(req.body.username, 'Nama pengguna', 50).toLocaleLowerCase('id-ID');
    const password = requireText(req.body.password, 'Kata sandi', 200);
    if (password.length < 12) throw new Error('Kata sandi harus memiliki minimal 12 karakter.');
    const userId = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [781246903]);
      const count = await client.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
      if (Number(count.rows[0]?.count ?? 0) !== 0) return null;
      const result = await client.query<{ id: number }>(
        'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, username, hashPassword(password), 'principal']
      );
      return result.rows[0]!.id;
    });
    if (userId === null) {
      fail(res, 409, 'Pengaturan awal sudah selesai.');
      return;
    }
    await createSession(userId, res);
    res.status(201).json({
      user: { id: userId, name, username, role: 'principal' },
      roleName: roleNames.principal
    });
  })
);

app.post(
  '/api/auth/login',
  route(async (req, res) => {
    try {
      const user = await issueToken(req, res);
      res.json({ user, roleName: roleNames[user.role] });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        fail(res, 401, error.message);
        return;
      }
      throw error;
    }
  })
);

app.get(
  '/api/auth/me',
  requireAuth,
  route(async (req, res) => {
    res.json({ user: req.user, roleName: roleNames[req.user!.role] });
  })
);

app.post(
  '/api/auth/logout',
  requireAuth,
  route(async (req, res) => {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('raport_session='));
    const token = cookie?.slice('raport_session='.length);
    if (token) {
      await execute('DELETE FROM sessions WHERE token_hash = ?',
        createHash('sha256').update(token).digest('hex')
      );
    }
    res.clearCookie('raport_session', { httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
  })
);

app.get(
  '/api/data',
  requireAuth,
  route(async (req, res) => {
    const classes = await many(
        `SELECT classes.*, COUNT(students.id) AS student_count FROM classes
         LEFT JOIN students ON students.class_id = classes.id GROUP BY classes.id ORDER BY grade, name`
      );
    const students = await many(
        `SELECT students.id, student_code, students.name, class_id, classes.name AS class_name,
                classes.grade, classes.phase FROM students JOIN classes ON classes.id = students.class_id
         ORDER BY classes.grade, classes.name, students.name`
      );
    const subjects = await many('SELECT * FROM subjects ORDER BY grade, name');
    const objectives = await many(
        `SELECT learning_objectives.*, subjects.name AS subject_name, subjects.grade, subjects.phase
         FROM learning_objectives JOIN subjects ON subjects.id = learning_objectives.subject_id
         ORDER BY subjects.grade, subjects.name, learning_objectives.id`
      );
    const terms = await many('SELECT * FROM academic_terms ORDER BY starts_on DESC');
    const rules = await many(
        `SELECT score_rules.*, subjects.name AS subject_name
         FROM score_rules JOIN subjects ON subjects.id = score_rules.subject_id`
      );
    const narratives = await many(
        `SELECT narratives.student_id, narratives.subject_id, narratives.term_id, narratives.content,
                narratives.reviewed_at, students.name AS student_name, subjects.name AS subject_name,
                academic_terms.academic_year, academic_terms.semester
         FROM narratives JOIN students ON students.id = narratives.student_id
         JOIN subjects ON subjects.id = narratives.subject_id
         JOIN academic_terms ON academic_terms.id = narratives.term_id
         ORDER BY narratives.updated_at DESC`
      );
    const settings = await one('SELECT name, logo_url, city, principal_name FROM school_settings WHERE id = 1');
    const users =
      req.user!.role === 'principal'
        ? await many('SELECT id, name, username, role, created_at FROM users ORDER BY name')
        : [];
    const attendanceImports = await many(
      'SELECT imported_at, rows_added, rows_unchanged FROM attendance_imports ORDER BY id DESC LIMIT 5'
    );
    res.json({
      user: req.user,
      roleName: roleNames[req.user!.role],
      classes,
      students,
      subjects,
      objectives,
      terms,
      rules,
      narratives,
      settings,
      users,
      attendanceImports
    });
  })
);

app.post(
  '/api/users',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const name = requireText(req.body.name, 'Nama lengkap');
    const username = requireText(req.body.username, 'Nama pengguna', 50).toLocaleLowerCase('id-ID');
    const password = requireText(req.body.password, 'Kata sandi', 200);
    const role = req.body.role as Role;
    if (!['subject_teacher', 'homeroom_teacher', 'principal'].includes(role)) {
      throw new Error('Peran pengguna tidak valid.');
    }
    if (password.length < 12) throw new Error('Kata sandi harus memiliki minimal 12 karakter.');
    const result = await one<{ id: number }>(
      'INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id',
      name,
      username,
      hashPassword(password),
      role
    );
    await audit(req.user!.id, 'create_user', 'user', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/settings',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const cleanOptional = (value: unknown, field: string, max = 250): string | null => {
      if (value == null || value === '') return null;
      return requireText(value, field, max);
    };
    const logoUrl = cleanOptional(req.body.logoUrl, 'URL logo', 1000);
    if (logoUrl && !/^https?:\/\//i.test(logoUrl)) throw new Error('Logo harus berupa URL http/https.');
    await execute(
      `UPDATE school_settings SET name = ?, logo_url = ?, city = ?, principal_name = ? WHERE id = 1`,
      cleanOptional(req.body.name, 'Nama sekolah'),
      logoUrl,
      cleanOptional(req.body.city, 'Kota'),
      cleanOptional(req.body.principalName, 'Nama kepala sekolah')
    );
    await audit(req.user!.id, 'update_school_identity', 'school_settings');
    res.json({ ok: true });
  })
);

app.post(
  '/api/classes',
  requireAuth,
  requireRole('principal', 'homeroom_teacher'),
  route(async (req, res) => {
    const name = requireText(req.body.name, 'Nama rombel');
    const grade = Number(req.body.grade);
    const phase = phaseForGrade(grade);
    const teacher = req.body.homeroomTeacher
      ? requireText(req.body.homeroomTeacher, 'Nama wali kelas')
      : null;
    const result = await one<{ id: number }>(
      'INSERT INTO classes (name, grade, phase, homeroom_teacher) VALUES (?, ?, ?, ?) RETURNING id',
      name,
      grade,
      phase,
      teacher
    );
    await audit(req.user!.id, 'create_class', 'class', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/students',
  requireAuth,
  requireRole('principal', 'homeroom_teacher'),
  route(async (req, res) => {
    const studentCode = requireText(req.body.studentCode, 'ID siswa', 50);
    const name = requireText(req.body.name, 'Nama siswa');
    const classId = Number(req.body.classId);
    if (!(await one('SELECT id FROM classes WHERE id = ?', classId))) {
      throw new Error('Rombel tidak ditemukan.');
    }
    const result = await one<{ id: number }>(
      'INSERT INTO students (student_code, name, class_id) VALUES (?, ?, ?) RETURNING id',
      studentCode,
      name,
      classId
    );
    await audit(req.user!.id, 'create_student', 'student', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/terms',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const academicYear = requireText(req.body.academicYear, 'Tahun ajaran', 20);
    const semester = Number(req.body.semester);
    if (![1, 2].includes(semester)) throw new Error('Semester harus 1 atau 2.');
    const startsOn = safeDate(req.body.startsOn, 'Tanggal mulai');
    const endsOn = safeDate(req.body.endsOn, 'Tanggal akhir');
    if (startsOn > endsOn) throw new Error('Tanggal mulai harus sebelum tanggal akhir.');
    const result = await one<{ id: number }>(
      'INSERT INTO academic_terms (academic_year, semester, starts_on, ends_on) VALUES (?, ?, ?, ?) RETURNING id',
      academicYear,
      semester,
      startsOn,
      endsOn
    );
    await audit(req.user!.id, 'create_term', 'term', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/subjects',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const name = requireText(req.body.name, 'Nama mata pelajaran');
    const grade = Number(req.body.grade);
    const phase = phaseForGrade(grade);
    if (
      await one(
          `SELECT 1 FROM students JOIN classes ON classes.id = students.class_id
           JOIN report_states ON report_states.student_id = students.id
           WHERE classes.grade = ? AND classes.phase = ? AND report_states.status <> 'draft' LIMIT 1`,
          grade,
          phase
        )
    ) {
      throw new Error('Mata pelajaran tidak dapat ditambah setelah rapor untuk kelas/fase ini mulai ditinjau.');
    }
    const result = await one<{ id: number }>(
      'INSERT INTO subjects (name, grade, phase) VALUES (?, ?, ?) RETURNING id',
      name,
      grade,
      phase
    );
    await audit(req.user!.id, 'create_subject', 'subject', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/objectives',
  requireAuth,
  requireRole('principal', 'subject_teacher'),
  route(async (req, res) => {
    const subjectId = Number(req.body.subjectId);
    const code = req.body.code ? requireText(req.body.code, 'Kode TP', 40) : null;
    const description = requireText(req.body.description, 'Deskripsi TP', 1000);
    if (!(await one('SELECT id FROM subjects WHERE id = ?', subjectId))) {
      throw new Error('Mata pelajaran tidak ditemukan.');
    }
    const result = await one<{ id: number }>(
      'INSERT INTO learning_objectives (subject_id, code, description) VALUES (?, ?, ?) RETURNING id',
      subjectId,
      code,
      description
    );
    await audit(req.user!.id, 'create_objective', 'objective', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/score-rules',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const termId = Number(req.body.termId);
    const subjectId = Number(req.body.subjectId);
    const formativeWeight = Number(req.body.formativeWeight);
    const summativeWeight = Number(req.body.summativeWeight);
    if (
      !Number.isFinite(formativeWeight) ||
      !Number.isFinite(summativeWeight) ||
      formativeWeight < 0 ||
      summativeWeight < 0 ||
      formativeWeight + summativeWeight !== 100
    ) {
      throw new Error('Bobot formatif dan sumatif harus berjumlah tepat 100%.');
    }
    if (
      !(await one('SELECT id FROM academic_terms WHERE id = ?', termId)) ||
      !(await one('SELECT id FROM subjects WHERE id = ?', subjectId))
    ) {
      throw new Error('Periode atau mata pelajaran tidak ditemukan.');
    }
    if (
      await one(
          "SELECT 1 FROM report_states WHERE term_id = ? AND status <> 'draft' LIMIT 1"
          ,
          termId
        )
    ) {
      throw new Error('Bobot tidak dapat diubah setelah rapor periode ini mulai ditinjau.');
    }
    await execute(
      `INSERT INTO score_rules (term_id, subject_id, formative_weight, summative_weight)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(term_id, subject_id) DO UPDATE SET
         formative_weight = excluded.formative_weight,
         summative_weight = excluded.summative_weight,
         updated_at = CURRENT_TIMESTAMP`,
      termId,
      subjectId,
      formativeWeight,
      summativeWeight
    );
    await audit(req.user!.id, 'update_score_rule', 'score_rule', `${termId}:${subjectId}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/assessments',
  requireAuth,
  requireRole('subject_teacher'),
  route(async (req, res) => {
    const studentId = Number(req.body.studentId);
    const objectiveId = Number(req.body.objectiveId);
    const termId = Number(req.body.termId);
    const kind = req.body.kind as AssessmentKind;
    const title = requireText(req.body.title, 'Nama penilaian');
    const score = Number(req.body.score);
    const maxScore = Number(req.body.maxScore);
    const assessedOn = safeDate(req.body.assessedOn, 'Tanggal penilaian');
    if (!['formative', 'summative'].includes(kind)) throw new Error('Jenis penilaian tidak valid.');
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || score < 0 || score > maxScore) {
      throw new Error('Nilai harus berada di antara 0 dan nilai maksimal.');
    }
    const relationship = await one(
        `SELECT students.id, subjects.grade, subjects.phase FROM students
         JOIN classes ON classes.id = students.class_id
         JOIN learning_objectives ON learning_objectives.id = ?
         JOIN subjects ON subjects.id = learning_objectives.subject_id
         WHERE students.id = ? AND classes.grade = subjects.grade AND classes.phase = subjects.phase`,
        objectiveId,
        studentId
      );
    if (!relationship) throw new Error('TP dan siswa harus berasal dari kelas/fase yang sama.');
    if (!(await one('SELECT id FROM academic_terms WHERE id = ?', termId))) {
      throw new Error('Periode tidak ditemukan.');
    }
    await assertReportDraft(studentId, termId);
    const result = await one<{ id: number }>(
        `INSERT INTO assessments
         (student_id, objective_id, term_id, kind, title, score, max_score, assessed_on, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        studentId,
        objectiveId,
        termId,
        kind,
        title,
        score,
        maxScore,
        assessedOn,
        req.user!.id
      );
    await audit(req.user!.id, 'record_assessment', 'assessment', result!.id);
    res.status(201).json({ ok: true });
  })
);

app.post(
  '/api/narratives',
  requireAuth,
  requireRole('subject_teacher'),
  route(async (req, res) => {
    const studentId = Number(req.body.studentId);
    const subjectId = Number(req.body.subjectId);
    const termId = Number(req.body.termId);
    const content = requireText(req.body.content, 'Narasi', 2000);
    const relationship = await one(
        `SELECT students.id FROM students JOIN classes ON classes.id = students.class_id
         JOIN subjects ON subjects.id = ? WHERE students.id = ?
         AND classes.grade = subjects.grade AND classes.phase = subjects.phase`,
        subjectId,
        studentId
      );
    if (!relationship) throw new Error('Siswa dan mata pelajaran harus berada pada kelas/fase yang sama.');
    await assertReportDraft(studentId, termId);
    await execute(
      `INSERT INTO narratives (student_id, subject_id, term_id, content, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(student_id, subject_id, term_id) DO UPDATE SET
         content = excluded.content, reviewed_by = NULL, reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP`,
      studentId,
      subjectId,
      termId,
      content
    );
    await audit(req.user!.id, 'save_narrative', 'narrative', `${studentId}:${subjectId}:${termId}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/narratives/:studentId/:subjectId/:termId/review',
  requireAuth,
  requireRole('subject_teacher'),
  route(async (req, res) => {
    const changes = await execute(
        `UPDATE narratives SET reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
         WHERE student_id = ? AND subject_id = ? AND term_id = ?`,
        req.user!.id,
        Number(req.params.studentId),
        Number(req.params.subjectId),
        Number(req.params.termId)
      );
    if (changes === 0) throw new Error('Narasi belum tersedia untuk ditinjau.');
    await audit(req.user!.id, 'review_narrative', 'narrative', `${req.params.studentId}:${req.params.subjectId}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/report-sections',
  requireAuth,
  requireRole('homeroom_teacher'),
  route(async (req, res) => {
    const studentId = Number(req.body.studentId);
    const termId = Number(req.body.termId);
    const sectionKey = req.body.sectionKey as string;
    if (!['kokurikuler', 'profil', 'ekstrakurikuler'].includes(sectionKey)) {
      throw new Error('Bagian rapor tidak valid.');
    }
    const content =
      req.body.content === '' ? '' : requireText(req.body.content, 'Isi bagian rapor', 2000);
    if (
      !(await one('SELECT id FROM students WHERE id = ?', studentId)) ||
      !(await one('SELECT id FROM academic_terms WHERE id = ?', termId))
    ) {
      throw new Error('Siswa atau periode tidak ditemukan.');
    }
    await assertReportDraft(studentId, termId);
    await execute(
      `INSERT INTO report_sections (student_id, term_id, section_key, content) VALUES (?, ?, ?, ?)
       ON CONFLICT(student_id, term_id, section_key) DO UPDATE SET
         content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
      studentId,
      termId,
      sectionKey,
      content
    );
    await audit(req.user!.id, 'save_report_section', 'report_section', `${studentId}:${sectionKey}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/attendance/import',
  requireAuth,
  requireRole('principal', 'homeroom_teacher'),
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  route(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      fail(res, 400, 'Pilih file XLSX terlebih dahulu.');
      return;
    }
    const preview = await parseAttendanceWorkbook(req.body);
    const issues = [...preview.issues];
    const warnings = [...preview.warnings];
    const studentCodes = [...new Set(preview.rows.map((row) => row.studentCode))];
    const students = await many<{ id: number; student_code: string; name: string; class_name: string }>(
      `SELECT students.id, students.student_code, students.name, classes.name AS class_name
       FROM students JOIN classes ON classes.id = students.class_id
       WHERE students.student_code = ANY(?::text[])`,
      studentCodes
    );
    const studentsByCode = new Map(students.map((student) => [student.student_code, student]));
    const matchedPairs = preview.rows.flatMap((row) => {
      const student = studentsByCode.get(row.studentCode);
      return student ? [{ studentId: student.id, date: row.date }] : [];
    });
    const pairIds = matchedPairs.map((pair) => pair.studentId);
    const pairDates = matchedPairs.map((pair) => pair.date);
    const existingRows = matchedPairs.length
      ? await many<{ student_id: number; attendance_date: string; status: string }>(
          `SELECT attendance.student_id, attendance.attendance_date::text AS attendance_date, attendance.status
           FROM attendance
           JOIN UNNEST(?::integer[], ?::date[]) AS input(student_id, attendance_date)
             ON input.student_id = attendance.student_id AND input.attendance_date = attendance.attendance_date`,
          pairIds,
          pairDates
        )
      : [];
    const existingByKey = new Map(
      existingRows.map((row) => [`${row.student_id}\u0000${row.attendance_date}`, row.status])
    );
    const lockedRows = matchedPairs.length
      ? await many<{ student_id: number; attendance_date: string }>(
          `SELECT DISTINCT input.student_id, input.attendance_date::text AS attendance_date
           FROM UNNEST(?::integer[], ?::date[]) AS input(student_id, attendance_date)
           JOIN report_states ON report_states.student_id = input.student_id
             AND report_states.status <> 'draft'
           JOIN academic_terms ON academic_terms.id = report_states.term_id
             AND input.attendance_date BETWEEN academic_terms.starts_on AND academic_terms.ends_on`,
          pairIds,
          pairDates
        )
      : [];
    const lockedKeys = new Set(lockedRows.map((row) => `${row.student_id}\u0000${row.attendance_date}`));
    const validRows: typeof preview.rows = [];

    for (const row of preview.rows) {
      const student = studentsByCode.get(row.studentCode);
      if (!student) {
        issues.push({ row: row.row, message: 'ID_Siswa tidak ditemukan; data tidak dapat dicocokkan.' });
        continue;
      }
      if (student.class_name.trim().toLocaleLowerCase('id-ID') !== row.className.toLocaleLowerCase('id-ID')) {
        warnings.push({ row: row.row, message: 'Nama kelas berbeda; pencocokan tetap memakai ID_Siswa.' });
      }
      if (student.name.trim().toLocaleLowerCase('id-ID') !== row.name.toLocaleLowerCase('id-ID')) {
        warnings.push({ row: row.row, message: 'Nama berbeda; pencocokan tetap memakai ID_Siswa.' });
      }
      const key = `${student.id}\u0000${row.date}`;
      const currentStatus = existingByKey.get(key);
      if (currentStatus && currentStatus !== row.status) {
        issues.push({
          row: row.row,
          message: `Status bertentangan dengan data tersimpan (${currentStatus} vs ${row.status}).`
        });
        continue;
      }
      if (lockedKeys.has(key) && !currentStatus) {
        issues.push({
          row: row.row,
          message: 'Data baru tidak dapat ditambahkan ke periode yang rapornya sudah ditinjau.'
        });
        continue;
      }
      validRows.push(row);
    }

    if (issues.length > 0) {
      res.status(422).json({ error: 'Impor dibatalkan; perbaiki semua masalah sebelum mencoba lagi.', issues, warnings });
      return;
    }

    const rowsToAdd = validRows.filter((row) => {
      const student = studentsByCode.get(row.studentCode)!;
      return !existingByKey.has(`${student.id}\u0000${row.date}`);
    });
    const rowsUnchanged = validRows.length - rowsToAdd.length;
    const importId = await transaction(async (client) => {
      const importResult = await client.query<{ id: number }>(
        `INSERT INTO attendance_imports (file_hash, imported_by, rows_added, rows_unchanged)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [preview.fileHash, req.user!.id, rowsToAdd.length, rowsUnchanged]
      );
      const id = importResult.rows[0]!.id;
      if (rowsToAdd.length > 0) {
        await client.query(
          `INSERT INTO attendance (student_id, attendance_date, status, import_id)
           SELECT * FROM UNNEST($1::integer[], $2::date[], $3::text[], $4::integer[])`,
          [
            rowsToAdd.map((row) => studentsByCode.get(row.studentCode)!.id),
            rowsToAdd.map((row) => row.date),
            rowsToAdd.map((row) => row.status),
            rowsToAdd.map(() => id)
          ]
        );
      }
      return id;
    });
    await audit(req.user!.id, 'import_attendance', 'attendance_import', importId);
    res.json({
      ok: true,
      imported: rowsToAdd.length,
      unchanged: rowsUnchanged,
      warnings,
      statusMeanings: { A: 'Alfa', H: 'Hadir', I: 'Izin', S: 'Sakit' }
    });
  })
);

app.get(
  '/api/reports',
  requireAuth,
  route(async (req, res) => {
    const termId = Number(req.query.termId);
    if (!Number.isInteger(termId)) {
      fail(res, 400, 'Pilih periode rapor.');
      return;
    }
    const students = await many<{ id: number }>('SELECT id FROM students ORDER BY name');
    const reports = [];
    for (const { id } of students) {
      const report = await reportData(id, termId);
      reports.push({
        student: report.student,
        status: report.state,
        ready: report.issues.length === 0,
        issues: report.issues,
        subjects: report.subjects,
        attendance: report.attendance,
        sections: report.sections
      });
    }
    res.json({ reports });
  })
);

app.post(
  '/api/reports/:studentId/review',
  requireAuth,
  requireRole('homeroom_teacher'),
  route(async (req, res) => {
    const termId = Number(req.body.termId);
    const studentId = Number(req.params.studentId);
    const report = await reportData(studentId, termId);
    if (report.state !== 'draft') throw new Error('Rapor tidak berada pada status Draf.');
    if (report.issues.length > 0) throw new Error(`Rapor belum siap: ${report.issues.join(' ')}`);
    await execute(
      `INSERT INTO report_states (student_id, term_id, status, homeroom_reviewed_by, homeroom_reviewed_at)
       VALUES (?, ?, 'homeroom_review', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(student_id, term_id) DO UPDATE SET status = 'homeroom_review',
         homeroom_reviewed_by = excluded.homeroom_reviewed_by,
         homeroom_reviewed_at = excluded.homeroom_reviewed_at`,
      studentId,
      termId,
      req.user!.id
    );
    await audit(req.user!.id, 'homeroom_review_report', 'report', `${studentId}:${termId}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/reports/:studentId/approve',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const termId = Number(req.body.termId);
    const studentId = Number(req.params.studentId);
    const report = await reportData(studentId, termId);
    if (report.state !== 'homeroom_review') throw new Error('Rapor harus ditinjau wali kelas terlebih dahulu.');
    if (report.issues.length > 0) throw new Error(`Rapor belum siap: ${report.issues.join(' ')}`);
    await execute(
      `UPDATE report_states SET status = 'principal_approval', approved_by = ?, approved_at = CURRENT_TIMESTAMP
       WHERE student_id = ? AND term_id = ?`,
      req.user!.id,
      studentId,
      termId
    );
    await audit(req.user!.id, 'approve_report', 'report', `${studentId}:${termId}`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/reports/:studentId/finalize',
  requireAuth,
  requireRole('principal'),
  route(async (req, res) => {
    const termId = Number(req.body.termId);
    const studentId = Number(req.params.studentId);
    const report = await reportData(studentId, termId);
    if (report.state !== 'principal_approval') throw new Error('Rapor harus disetujui sebelum difinalisasi.');
    if (report.issues.length > 0) throw new Error(`Rapor belum siap: ${report.issues.join(' ')}`);
    await execute(
      `UPDATE report_states SET status = 'finalized', finalized_by = ?, finalized_at = CURRENT_TIMESTAMP
       WHERE student_id = ? AND term_id = ?`,
      req.user!.id,
      studentId,
      termId
    );
    await audit(req.user!.id, 'finalize_report', 'report', `${studentId}:${termId}`);
    res.json({ ok: true });
  })
);

app.get(
  '/api/report/:studentId',
  requireAuth,
  route(async (req, res) => {
    const termId = Number(req.query.termId);
    const report = await reportData(Number(req.params.studentId), termId);
    if (report.state !== 'finalized') {
      fail(res, 409, 'Rapor hanya dapat dicetak setelah disetujui dan difinalisasi.');
      return;
    }
    const settings = await one('SELECT name, logo_url, city, principal_name FROM school_settings WHERE id = 1');
    res.json({ ...report, settings });
  })
);

app.get('/report', requireAuth, (req, res) => {
  res.redirect(302, req.originalUrl.replace(/^\/report/, '/report.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(join(process.cwd(), 'public', 'index.html'));
});

app.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === '23505') {
      fail(res, 409, 'Data dengan nilai tersebut sudah ada.');
      return;
    }
    if (code?.startsWith('23')) {
      fail(res, 400, 'Data tidak memenuhi aturan penyimpanan.');
      return;
    }
    if (code?.startsWith('22')) {
      fail(res, 400, 'Format data tidak valid.');
      return;
    }
    if (code) {
      fail(res, 503, 'Penyimpanan tidak dapat diakses saat ini.');
      return;
    }
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan.';
    fail(res, 400, message);
  }
);

export default app;

const server =
  process.env.VERCEL === '1'
    ? undefined
    : app.listen(port, '127.0.0.1', () => {
        console.log(`Raport Bina Ilmu berjalan di http://127.0.0.1:${port}`);
      });

function shutdown(): void {
  if (!server) {
    void db.end().then(() => process.exit(0));
    return;
  }
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
