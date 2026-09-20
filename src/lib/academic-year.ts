export type AcademicYearWindow = { startsOn: string; endsOn: string; active: boolean };

export function schoolToday(now = new Date()): string {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

/** Choose the latest explicitly active year covering the school's local day. */
export function academicYearForDate<T extends AcademicYearWindow>(years: readonly T[], day: string): T | null {
    return years
        .filter((year) => year.active && year.startsOn <= day && day <= year.endsOn)
        .sort((left, right) => right.startsOn.localeCompare(left.startsOn))[0] ?? null;
}
