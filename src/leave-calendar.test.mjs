import assert from "node:assert/strict"
import { test } from "node:test"

import { calendarDateForCell, openLeaveDialog } from "./leave-calendar.ts"

test("selecting a calendar date opens a new leave form for that exact date", () => {
  const selectedDate = calendarDateForCell("2026-10", 15)
  const dialog = openLeaveDialog(selectedDate)

  assert.equal(dialog.isOpen, true)
  assert.equal(dialog.selectedDate, "2026-10-15")
  assert.equal(dialog.editingLeave, null)
  assert.equal(dialog.form.scope, "staff")
  assert.equal(dialog.form.leaveType, "full_day")
})

test("selecting an existing leave date opens the form populated for editing", () => {
  const leave = {
    id: 3,
    title: "Class closed",
    eventType: "csc_closed",
    description: "Maintenance",
    startDate: "2026-10-15",
    endDate: "2026-10-15",
    fullDay: false,
    startTime: "10:00:00",
    endTime: "12:00:00",
    affectsAttendance: false,
    leaveScope: "class_closed",
    createdBy: 1,
    createdByUsername: "admin",
    createdAt: "2026-10-14T12:00:00Z",
    updatedAt: "2026-10-14T12:00:00Z",
  }
  const dialog = openLeaveDialog(
    calendarDateForCell("2026-10", 15),
    leave,
  )

  assert.equal(dialog.isOpen, true)
  assert.equal(dialog.editingLeave?.id, 3)
  assert.equal(dialog.form.scope, "class_closed")
  assert.equal(dialog.form.leaveType, "partial_time")
  assert.equal(dialog.form.startTime, "10:00")
  assert.equal(dialog.form.endTime, "12:00")
})

test("empty calendar cells do not select a date", () => {
  assert.equal(calendarDateForCell("2026-10", null), "")
})
