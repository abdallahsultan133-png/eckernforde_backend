import { describe, expect, it } from "vitest";

import { pairedExamAverage } from "./exam-average.js";

describe("pairedExamAverage", () => {
    it("averages a subject's Midterm and Terminal/Annual marks", () => {
        expect(pairedExamAverage([
            { termType: "midterm", score: 60 },
            { termType: "terminal", score: 60 },
        ])).toBe(60);
        expect(pairedExamAverage([
            { termType: "midterm", score: 60 },
            { termType: "terminal", score: 80 },
        ])).toBe(70);
    });

    it("shows a single published term without halving it", () => {
        expect(pairedExamAverage([{ termType: "midterm", score: 60 }])).toBe(60);
        expect(pairedExamAverage([{ termType: "terminal", score: 72 }])).toBe(72);
    });
});
