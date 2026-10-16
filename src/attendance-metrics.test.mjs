import assert from "node:assert/strict"
import { test } from "node:test"

import {
  attendanceCounts,
  overallAttendanceCounts,
} from "./attendance-metrics.ts"

test("student attendance metrics calculate present percentage from present and absent days", () => {
  assert.deepEqual(attendanceCounts(8, 2), {
    presentDays: 8,
    absentDays: 2,
    totalDays: 10,
    presentPercentage: 80,
    absentPercentage: 20,
  })
})

test("student attendance percentage is N/A when there are no eligible days", () => {
  assert.deepEqual(attendanceCounts(0, 0), {
    presentDays: 0,
    absentDays: 0,
    totalDays: 0,
    presentPercentage: null,
    absentPercentage: null,
  })
})

test("overall attendance aggregates eligible student-days without double-counting records", () => {
  assert.deepEqual(
    overallAttendanceCounts([
      {
        studentId: 1,
        month: "2026-10",
        presentDays: 3,
        absentDays: 1,
        leaveDays: 2,
      },
      {
        studentId: 2,
        month: "2026-10",
        presentDays: 1,
        absentDays: 3,
        leaveDays: 0,
      },
    ]),
    {
      presentDays: 4,
      absentDays: 4,
      totalDays: 8,
      presentPercentage: 50,
      absentPercentage: 50,
    },
  )
})
