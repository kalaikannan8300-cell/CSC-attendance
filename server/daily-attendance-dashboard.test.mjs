import assert from "node:assert/strict"
import { test } from "node:test"

import { buildDailyAttendanceDashboard } from "./daily-attendance-dashboard.mjs"

const students = [
  {
    id: 1,
    register_number: "REG001",
    name: "Asha",
    course: "Accounting",
    active: true,
    created_at: "2020-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    register_number: "REG002",
    name: "Bala",
    course: "Office",
    active: true,
    created_at: "2020-01-01T00:00:00.000Z",
  },
  {
    id: 3,
    register_number: "REG003",
    name: "Inactive",
    course: "Office",
    active: false,
    created_at: "2020-01-01T00:00:00.000Z",
  },
  {
    id: 4,
    register_number: "REG004",
    name: "New enrollee",
    course: "Office",
    active: true,
    created_at: "2026-10-16T00:00:00.000Z",
  },
]

function dashboard(overrides = {}) {
  return buildDailyAttendanceDashboard({
    date: "2026-10-15",
    today: "2026-10-15",
    students,
    attendance: [],
    closures: [],
    approvedLeaves: [],
    workingDays: [1, 2, 3, 4, 5],
    ...overrides,
  })
}

test("daily lists count check-in without check-out as present and exclude it from absences", () => {
  const result = dashboard({
    attendance: [
      {
        student_id: 1,
        register_number: "REG001",
        name: "Asha",
        course: "Accounting",
        entry_time: "2026-10-15T04:00:00.000Z",
        exit_time: null,
      },
    ],
  })

  assert.equal(result.totalActiveStudents, 3)
  assert.deepEqual(result.presentStudents, [
    {
      registerNumber: "REG001",
      name: "Asha",
      course: "Accounting",
      entryTime: "2026-10-15T04:00:00.000Z",
      exitTime: null,
      status: "PRESENT",
    },
  ])
  assert.deepEqual(
    result.absentStudents.map(({ registerNumber, status }) => ({
      registerNumber,
      status,
    })),
    [{ registerNumber: "REG002", status: "ABSENT" }],
  )
})

test("full-day class closure suppresses absence while preserving actual attendance", () => {
  const result = dashboard({
    closures: [{ title: "Emergency closure" }],
    attendance: [
      {
        student_id: 1,
        register_number: "REG001",
        name: "Asha",
        course: "Accounting",
        entry_time: "2026-10-15T04:00:00.000Z",
        exit_time: null,
      },
    ],
  })

  assert.equal(result.isFullDayClassClosure, true)
  assert.equal(result.closureTitle, "Emergency closure")
  assert.equal(result.presentStudents.length, 1)
  assert.deepEqual(result.absentStudents, [])
})

test("approved student leave, inactive students, and future enrollees are not absent", () => {
  const result = dashboard({
    attendance: [
      {
        student_id: 1,
        register_number: "REG001",
        name: "Asha",
        course: "Accounting",
        entry_time: "2026-10-15T04:00:00.000Z",
        exit_time: null,
      },
    ],
    approvedLeaves: [{ student_id: 2 }],
  })

  assert.deepEqual(result.absentStudents, [])
})

test("future dates and non-working dates do not produce absences", () => {
  const future = dashboard({ date: "2026-10-16", today: "2026-10-15" })
  const weekend = dashboard({ date: "2026-10-17", today: "2026-10-17" })

  assert.equal(future.isEligibleWorkingDay, false)
  assert.deepEqual(future.absentStudents, [])
  assert.equal(weekend.isEligibleWorkingDay, false)
  assert.deepEqual(weekend.absentStudents, [])
})

test("partial class leave does not count as a full-day closure", () => {
  const result = dashboard({ closures: [] })

  assert.equal(result.isFullDayClassClosure, false)
  assert.deepEqual(
    result.absentStudents.map((student) => student.registerNumber),
    ["REG001", "REG002"],
  )
})
