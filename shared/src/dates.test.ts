import { describe, expect, it } from "vitest";
import { monthKeyIn, todayIn } from "./dates.js";

// 2026-10-25T02:30:00Z — late evening of the 24th on the US west coast,
// already the 25th in UTC and in Madrid.
const LATE_EVENING_PACIFIC = Date.UTC(2026, 9, 25, 2, 30);
// 2026-11-01T05:00:00Z — still October 31st in Honolulu (UTC−10).
const UTC_MONTH_ROLLED = Date.UTC(2026, 10, 1, 5, 0);

describe("todayIn", () => {
  it("is the restaurant's calendar day, not UTC's", () => {
    expect(todayIn("America/Los_Angeles", LATE_EVENING_PACIFIC)).toBe("2026-10-24");
    expect(todayIn("Europe/Madrid", LATE_EVENING_PACIFIC)).toBe("2026-10-25");
    expect(todayIn("UTC", LATE_EVENING_PACIFIC)).toBe("2026-10-25");
  });

  it("falls back to UTC for a missing or unknown zone", () => {
    expect(todayIn(null, LATE_EVENING_PACIFIC)).toBe("2026-10-25");
    expect(todayIn(undefined, LATE_EVENING_PACIFIC)).toBe("2026-10-25");
    expect(todayIn("", LATE_EVENING_PACIFIC)).toBe("2026-10-25");
    expect(todayIn("Mars/Olympus_Mons", LATE_EVENING_PACIFIC)).toBe("2026-10-25");
  });

  it("accepts a Date as well as a timestamp and defaults to now", () => {
    expect(todayIn("UTC", new Date(LATE_EVENING_PACIFIC))).toBe("2026-10-25");
    expect(todayIn("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("monthKeyIn", () => {
  it("does not roll the month over before the restaurant's midnight", () => {
    expect(monthKeyIn("Pacific/Honolulu", UTC_MONTH_ROLLED)).toBe("2026-10");
    expect(monthKeyIn("UTC", UTC_MONTH_ROLLED)).toBe("2026-11");
    expect(monthKeyIn("Europe/Madrid", UTC_MONTH_ROLLED)).toBe("2026-11");
  });
});
