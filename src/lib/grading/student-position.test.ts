import { describe, expect, it } from "vitest";
import { calculateStudentPosition } from "./student-position.js";

describe("calculateStudentPosition", () => {
    it("ranks secondary students by lower division points and gives ties the same position", () => {
        const results = [1, 2, 3, 4, 5, 6, 7].flatMap((classId, index) => [
            { studentId: "juma", classId, score: index < 4 ? 80 : 70, applicable: true, schoolLevel: "secondary" as const },
            { studentId: "asha", classId, score: 50, applicable: true, schoolLevel: "secondary" as const },
            { studentId: "hassan", classId, score: 90, applicable: true, schoolLevel: "secondary" as const },
        ]).concat([{ studentId: "partial", classId: 1, score: 100, applicable: true, schoolLevel: "secondary" as const }]);

        expect(calculateStudentPosition("hassan", [1, 2, 3, 4, 5, 6, 7], results)).toEqual({ position: 1, totalStudents: 3, averageScore: 90, divisionPoints: 7 });
        expect(calculateStudentPosition("juma", [1, 2, 3, 4, 5, 6, 7], results)).toEqual({ position: 2, totalStudents: 3, averageScore: 75.71, divisionPoints: 10 });
        expect(calculateStudentPosition("asha", [1, 2, 3, 4, 5, 6, 7], results)).toEqual({ position: 3, totalStudents: 3, averageScore: 50, divisionPoints: 21 });
    });
});
