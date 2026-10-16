import assert from "node:assert/strict"
import { test } from "node:test"

import { calculateMonthlySummaries } from "./monthly-summary.mjs"

const weekdays = [1, 2, 3, 4, 5]

test("monthly present days are unique; closures and approved leave reduce expected absences", () => {
  const [summary] = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-31",
    students: [{ id: 1, created_at: "2019-01-01T00:00:00.000Z" }],
    attendance: [
      { student_id: 1, attendance_date: "2020-01-06" },
      { student_id: 1, attendance_date: "2020-01-06" },
    ],
    events: [
      {
        start_date: "2020-01-08",
        end_date: "2020-01-08",
        full_day: true,
        affects_attendance: true,
      },
      {
        start_date: "2020-01-09",
        end_date: "2020-01-09",
        full_day: false,
        affects_attendance: false,
      },
      {
        start_date: "2020-01-10",
        end_date: "2020-01-10",
        full_day: true,
        affects_attendance: false,
      },
    ],
    approvedLeaves: [{ student_id: 1, leave_date: "2020-01-07" }],
    workingDays: weekdays,
  })

  assert.deepEqual(summary, {
    studentId: 1,
    month: "2020-01",
    presentDays: 1,
    absentDays: 20,
    leaveDays: 2,
  })
})

test("future month has no expected absences and no attendance uses enrollment date", () => {
  const summaries = calculateMonthlySummaries({
    month: "2026-11",
    today: "2026-10-13",
    students: [
      { id: 1, created_at: "2020-01-01T00:00:00.000Z" },
      { id: 2, created_at: "2026-11-04T00:00:00.000Z" },
    ],
    attendance: [],
    events: [],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.deepEqual(
    summaries.map(({ presentDays, absentDays }) => ({ presentDays, absentDays })),
    [
      { presentDays: 0, absentDays: 0 },
      { presentDays: 0, absentDays: 0 },
    ],
  )
})

test("three students receive distinct monthly present and absent counts", () => {
  const summaries = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-03",
    students: [
      { id: 1, created_at: "2019-01-01T00:00:00.000Z" },
      { id: 2, created_at: "2019-01-01T00:00:00.000Z" },
      { id: 3, created_at: "2019-01-01T00:00:00.000Z" },
    ],
    attendance: [
      { student_id: 1, attendance_date: "2020-01-01" },
      { student_id: 1, attendance_date: "2020-01-02" },
      { student_id: 2, attendance_date: "2020-01-01" },
    ],
    events: [],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.deepEqual(
    summaries.map(({ studentId, presentDays, absentDays }) => ({
      studentId,
      presentDays,
      absentDays,
    })),
    [
      { studentId: 1, presentDays: 2, absentDays: 1 },
      { studentId: 2, presentDays: 1, absentDays: 2 },
      { studentId: 3, presentDays: 0, absentDays: 3 },
    ],
  )
})

test("future attendance records do not count in current month summaries", () => {
  const [summary] = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-01",
    students: [{ id: 1, created_at: "2019-01-01T00:00:00.000Z" }],
    attendance: [
      { student_id: 1, attendance_date: "2020-01-01" },
      { student_id: 1, attendance_date: "2020-01-02" },
    ],
    events: [],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.equal(summary.presentDays, 1)
  assert.equal(summary.absentDays, 0)
})

test("attendance on a configured working day counts present without requiring an exit time", () => {
  const [summary] = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-01",
    students: [{ id: 3, created_at: "2019-01-01T00:00:00.000Z" }],
    attendance: [{ student_id: 3, attendance_date: "2020-01-01", exit_time: null }],
    events: [],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.deepEqual(
    { presentDays: summary.presentDays, absentDays: summary.absentDays },
    { presentDays: 1, absentDays: 0 },
  )
})

test("inactive students with no attendance are not counted absent, but recorded presence is retained", () => {
  const summaries = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-01",
    students: [
      { id: 1, created_at: "2019-01-01T00:00:00.000Z", active: false },
      { id: 2, created_at: "2019-01-01T00:00:00.000Z", active: false },
    ],
    attendance: [{ student_id: 2, attendance_date: "2020-01-01" }],
    events: [],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.deepEqual(
    summaries.map(({ presentDays, absentDays }) => ({
      presentDays,
      absentDays,
    })),
    [
      { presentDays: 0, absentDays: 0 },
      { presentDays: 1, absentDays: 0 },
    ],
  )
})

test("full-day class leave is counted as leave, not absence; staff leave does not affect student totals", () => {
  const [summary] = calculateMonthlySummaries({
    month: "2020-01",
    today: "2020-01-08",
    students: [{ id: 5, created_at: "2019-01-01T00:00:00.000Z" }],
    attendance: [],
    events: [
      {
        start_date: "2020-01-08",
        end_date: "2020-01-08",
        full_day: true,
        affects_attendance: true,
        leave_scope: "class_closed",
      },
      {
        start_date: "2020-01-07",
        end_date: "2020-01-07",
        full_day: true,
        affects_attendance: false,
        leave_scope: "staff",
      },
    ],
    approvedLeaves: [],
    workingDays: weekdays,
  })

  assert.deepEqual(
    {
      absentDays: summary.absentDays,
      leaveDays: summary.leaveDays,
    },
    { absentDays: 5, leaveDays: 1 },
  )
})
