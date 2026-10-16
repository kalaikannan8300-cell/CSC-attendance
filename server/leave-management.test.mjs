import assert from "node:assert/strict"
import { test } from "node:test"

import { leaveDurationMinutes, validateLeaveInput } from "./leave-management.mjs"

test("validates and stores the explicit staff leave scope without affecting student attendance", () => {
  assert.deepEqual(
    validateLeaveInput({
      date: "2026-10-15",
      scope: "staff",
      leaveType: "full_day",
      reason: "Personal work",
    }),
    {
      date: "2026-10-15",
      scope: "staff",
      leaveType: "full_day",
      reason: "Personal work",
      startTime: null,
      endTime: null,
      fullDay: true,
      affectsAttendance: false,
    },
  )
})

test("validates class closure partial time and does not make the whole date a closure", () => {
  assert.deepEqual(
    validateLeaveInput({
      date: "2026-10-15",
      scope: "class_closed",
      leaveType: "partial_time",
      startTime: "10:00",
      endTime: "12:00",
      reason: "",
    }),
    {
      date: "2026-10-15",
      scope: "class_closed",
      leaveType: "partial_time",
      reason: "",
      startTime: "10:00",
      endTime: "12:00",
      fullDay: false,
      affectsAttendance: false,
    },
  )
})

test("rejects duplicate-invalid dates, scopes, leave types, and reversed or invalid times", () => {
  const invalid = [
    { date: "2026-02-30", scope: "staff", leaveType: "full_day" },
    { date: "2026-10-15", scope: "all_students", leaveType: "full_day" },
    { date: "2026-10-15", scope: "staff", leaveType: "morning" },
    {
      date: "2026-10-15",
      scope: "staff",
      leaveType: "partial_time",
      startTime: "12:00",
      endTime: "10:00",
    },
    {
      date: "2026-10-15",
      scope: "staff",
      leaveType: "partial_time",
      startTime: "24:00",
      endTime: "25:00",
    },
  ]

  for (const input of invalid)
    assert.throws(() => validateLeaveInput(input), { code: "VALIDATION_ERROR" })
})

test("calculates time-based leave duration in minutes", () => {
  assert.equal(leaveDurationMinutes("10:00", "12:00"), 120)
  assert.equal(leaveDurationMinutes("09:30", "11:15"), 105)
  assert.equal(leaveDurationMinutes("12:00", "10:00"), 0)
})
