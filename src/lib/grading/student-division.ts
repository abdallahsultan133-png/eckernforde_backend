/** Tanzania-style secondary result calculation, separate from assignments. */
export type SecondaryGrade = "A" | "B" | "C" | "D" | "F";
export type SecondaryDivision = "I" | "II" | "III" | "IV" | "0" | null;

export type ApplicableSubjectResult = {
    subjectId: string | number;
    score: number | null | undefined;
    applicable?: boolean;
};

export type GradedSubjectResult = {
    subjectId: string | number;
    score: number;
    grade: SecondaryGrade;
    points: 1 | 2 | 3 | 4 | 5;
};

export const gradeSecondaryScore = (score: number): { grade: SecondaryGrade; points: 1 | 2 | 3 | 4 | 5 } => {
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError("Secondary scores must be a number from 0 to 100.");
    if (score >= 75) return { grade: "A", points: 1 };
    if (score >= 65) return { grade: "B", points: 2 };
    if (score >= 45) return { grade: "C", points: 3 };
    if (score >= 30) return { grade: "D", points: 4 };
    return { grade: "F", points: 5 };
};

export const divisionForPoints = (points: number): SecondaryDivision => {
    if (!Number.isInteger(points) || points < 7) return null;
    if (points <= 17) return "I";
    if (points <= 21) return "II";
    if (points <= 25) return "III";
    if (points <= 34) return "IV";
    return points === 35 ? "0" : null;
};

export function calculateSecondaryDivision(results: ApplicableSubjectResult[]) {
    const subjects: GradedSubjectResult[] = results
        .filter((result) => result.applicable !== false && result.score !== null && result.score !== undefined)
        .map((result) => {
            const score = Number(result.score);
            const { grade, points } = gradeSecondaryScore(score);
            return { subjectId: result.subjectId, score, grade, points };
        })
        .sort((a, b) => a.points - b.points || b.score - a.score);
    const bestSeven = subjects.slice(0, 7);
    const totalPoints = bestSeven.length === 7 ? bestSeven.reduce((sum, result) => sum + result.points, 0) : null;
    return { subjects, bestSeven, totalPoints, division: totalPoints === null ? null : divisionForPoints(totalPoints) };
}
