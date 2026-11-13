export type AssessmentKind = 'formative' | 'summative';

export interface ScoreRule {
  formativeWeight: number;
  summativeWeight: number;
}

export interface AssessmentScore {
  kind: AssessmentKind;
  score: number;
  maxScore: number;
}

export interface SubjectScore {
  score: number | null;
  missingKinds: AssessmentKind[];
}

export function calculateSubjectScore(
  rule: ScoreRule | undefined,
  assessments: AssessmentScore[]
): SubjectScore {
  if (!rule || rule.formativeWeight + rule.summativeWeight !== 100) {
    return { score: null, missingKinds: ['formative', 'summative'] };
  }

  const weights: Record<AssessmentKind, number> = {
    formative: rule.formativeWeight,
    summative: rule.summativeWeight
  };
  const means: Partial<Record<AssessmentKind, number>> = {};
  const missingKinds: AssessmentKind[] = [];

  for (const kind of ['formative', 'summative'] as const) {
    if (weights[kind] === 0) continue;
    const scores = assessments.filter((assessment) => assessment.kind === kind);
    if (scores.length === 0) {
      missingKinds.push(kind);
      continue;
    }

    means[kind] =
      scores.reduce((sum, assessment) => sum + (assessment.score / assessment.maxScore) * 100, 0) /
      scores.length;
  }

  if (missingKinds.length > 0) return { score: null, missingKinds };

  const score =
    ((means.formative ?? 0) * rule.formativeWeight +
      (means.summative ?? 0) * rule.summativeWeight) /
    100;
  return { score: Math.round(score * 10) / 10, missingKinds };
}

export function phaseForGrade(grade: number): 'A' | 'B' | 'C' {
  if (!Number.isInteger(grade) || grade < 1 || grade > 6) {
    throw new Error('Kelas harus berada pada rentang 1–6.');
  }
  if (grade <= 2) return 'A';
  return grade <= 4 ? 'B' : 'C';
}

export function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Tanggal tidak valid.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Tanggal tidak valid.');
  }
  return date.toISOString().slice(0, 10);
}
