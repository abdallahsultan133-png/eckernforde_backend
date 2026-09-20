export type PositionResultRow = {
    studentId: string;
    classId: number;
    score: number;
    applicable: boolean;
    schoolLevel?: "nursery" | "primary" | "secondary" | null;
};

export type StudentPosition = {
    position: number;
    totalStudents: number;
    averageScore: number;
    divisionPoints: number | null;
};

/**
 * Rank a student against classmates who completed every applicable subject on
 * that student's report. Secondary students are ranked by official division
 * points (lower is better); other levels use the average score. Equal metrics
 * share a position.
 */
export function calculateStudentPosition(
    studentId: string,
    requiredClassIds: number[],
    results: PositionResultRow[],
    useDivisionPoints = results.some((row) => row.studentId === studentId && row.schoolLevel === "secondary"),
): StudentPosition | null {
    const required = [...new Set(requiredClassIds)];
    if (!required.length) return null;

    const scoresByStudent = new Map<string, Map<number, number>>();
    for (const row of results) {
        if (!row.applicable || !required.includes(row.classId) || !Number.isFinite(row.score)) continue;
        const scores = scoresByStudent.get(row.studentId) ?? new Map<number, number>();
        scores.set(row.classId, row.score);
        scoresByStudent.set(row.studentId, scores);
    }

    const entries = [...scoresByStudent.entries()]
        .filter(([, scores]) => required.every((classId) => scores.has(classId)))
        .map(([id, scores]) => ({
            studentId: id,
            averageScore: required.reduce((sum, classId) => sum + (scores.get(classId) ?? 0), 0) / required.length,
            divisionPoints: null as number | null,
        }));
    if (useDivisionPoints) {
        for (const entry of entries) {
            const scores = scoresByStudent.get(entry.studentId)!;
            const points = [...scores.values()].map((score) => score >= 75 ? 1 : score >= 65 ? 2 : score >= 45 ? 3 : score >= 30 ? 4 : 5).sort((a, b) => a - b).slice(0, 7);
            entry.divisionPoints = points.reduce((sum, point) => sum + point, 0) + Math.max(0, 7 - points.length) * 5;
        }
    }
    const student = entries.find((entry) => entry.studentId === studentId);
    if (!student) return null;
    const rankValue = (entry: typeof student) => useDivisionPoints ? (entry.divisionPoints ?? Number.POSITIVE_INFINITY) : -entry.averageScore;

    return {
        position: entries.filter((entry) => rankValue(entry) < rankValue(student)).length + 1,
        totalStudents: entries.length,
        averageScore: Math.round(student.averageScore * 100) / 100,
        divisionPoints: student.divisionPoints,
    };
}
