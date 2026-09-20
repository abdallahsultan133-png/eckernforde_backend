import { describe, expect, it } from "vitest";
import { calculateSecondaryDivision, divisionForPoints, gradeSecondaryScore } from "./student-division.js";

describe("gradeSecondaryScore", () => {
    it.each([[100, "A", 1], [75, "A", 1], [74, "B", 2], [65, "B", 2], [64, "C", 3], [45, "C", 3], [44, "D", 4], [30, "D", 4], [29, "F", 5], [0, "F", 5]])("maps %s to %s / %s point(s)", (score, grade, points) => {
        expect(gradeSecondaryScore(score)).toEqual({ grade, points });
    });
    it("rejects scores outside the approved range", () => {
        expect(() => gradeSecondaryScore(-1)).toThrow(RangeError);
        expect(() => gradeSecondaryScore(101)).toThrow(RangeError);
    });
});

describe("divisionForPoints", () => {
    it.each([[7, "I"], [17, "I"], [18, "II"], [21, "II"], [22, "III"], [25, "III"], [26, "IV"], [34, "IV"], [35, "0"]])("maps %s to Division %s", (points, division) => expect(divisionForPoints(points)).toBe(division));
});

describe("calculateSecondaryDivision", () => {
    it("uses only the best seven applicable final subject scores", () => {
        const result = calculateSecondaryDivision([
            { subjectId: "math", score: 75 }, { subjectId: "english", score: 65 }, { subjectId: "biology", score: 45 }, { subjectId: "chemistry", score: 45 }, { subjectId: "history", score: 30 }, { subjectId: "geography", score: 30 }, { subjectId: "kiswahili", score: 30 }, { subjectId: "extra", score: 0 }, { subjectId: "not-applicable", score: 100, applicable: false },
        ]);
        expect(result.bestSeven.map((subject) => subject.subjectId)).not.toContain("extra");
        expect(result.bestSeven.map((subject) => subject.subjectId)).not.toContain("not-applicable");
        expect(result.totalPoints).toBe(21);
        expect(result.division).toBe("II");
    });
    it("projects fewer than seven applicable results onto the seven-subject scale", () => {
        const result = calculateSecondaryDivision(Array.from({ length: 6 }, (_, index) => ({ subjectId: index, score: 75 })));
        expect(result.totalPoints).toBe(11);
        expect(result.division).toBe("I");
    });
});
