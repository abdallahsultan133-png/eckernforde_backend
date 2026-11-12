export type ExamTermMark = { termType: "midterm" | "terminal"; score: number };

/** Show the available published term mark until both terms can be averaged. */
export function pairedExamAverage(rows: ExamTermMark[]): number | null {
    const midterm = rows.filter((row) => row.termType === "midterm").map((row) => Number(row.score));
    const terminal = rows.filter((row) => row.termType === "terminal").map((row) => Number(row.score));
    if (!midterm.length && !terminal.length) return null;
    const termAverage = (values: number[]) => values.reduce((sum, score) => sum + score, 0) / values.length;
    const midtermAverage = midterm.length ? termAverage(midterm) : null;
    const terminalAverage = terminal.length ? termAverage(terminal) : null;
    const combined = midtermAverage !== null && terminalAverage !== null
        ? (midtermAverage + terminalAverage) / 2
        : midtermAverage ?? terminalAverage ?? 0;
    return Math.round(combined * 10) / 10;
}
