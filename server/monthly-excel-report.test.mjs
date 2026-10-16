import assert from "node:assert/strict"
import { inflateRawSync } from "node:zlib"
import { test } from "node:test"

import {
  buildMonthlyReportData,
  createDailyAttendanceWorkbook,
  createMonthlyAttendanceWorkbook,
  createMonthEndAttendanceWorkbook,
  monthlyReportHeaders,
  validateReportDate,
} from "./monthly-excel-report.mjs"

function readZipTextFile(archive, expectedName) {
  let offset = 0
  while (offset + 30 < archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18)
    const fileNameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = archive.toString("utf8", nameStart, nameStart + fileNameLength)
    const contentStart = nameStart + fileNameLength + extraLength
    if (name === expectedName) {
      return inflateRawSync(
        archive.subarray(contentStart, contentStart + compressedSize),
      ).toString("utf8")
    }
    offset = contentStart + compressedSize
  }
  throw new Error(`Workbook entry not found: ${expectedName}`)
}

function readInlineHeaderRow(worksheet) {
  const headerRow = worksheet.match(/<row r="1">(.*?)<\/row>/)?.[1]
  assert.ok(headerRow, "worksheet should contain a header row")
  return [...headerRow.matchAll(/<c\b[^>]*><is><t[^>]*>(.*?)<\/t><\/is><\/c>/g)]
    .map((match) => match[1])
}

function readSheetNames(workbookXml) {
  return [...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map(
    (match) => match[1],
  )
}

test("daily export date validation accepts real dates and rejects malformed dates", () => {
  assert.equal(validateReportDate("2026-10-15"), "2026-10-15")
  for (const date of ["2026-02-30", "2026-13-01", "2026-1-01", "invalid"]) {
    assert.throws(() => validateReportDate(date), {
      code: "VALIDATION_ERROR",
    })
  }
})

test("daily and month-end Excel exports use the requested single-sheet columns and leave values", () => {
  const report = buildMonthlyReportData({
    month: "2026-10",
    today: "2026-10-15",
    students: [
      {
        id: 1,
        register_number: "CSC001",
        name: "Test Student",
        course: "Office Automation",
        active: true,
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
    attendance: [
      {
        student_id: 1,
        register_number: "CSC001",
        name: "Test Student",
        course: "Office Automation",
        attendance_date: "2026-10-13",
        entry_time: "2026-10-13T04:00:00.000Z",
        exit_time: null,
        status: "present",
      },
    ],
    events: [
      {
        start_date: "2026-10-14",
        end_date: "2026-10-14",
        full_day: true,
        affects_attendance: true,
        leave_scope: "class_closed",
      },
      {
        start_date: "2026-10-13",
        end_date: "2026-10-13",
        full_day: false,
        start_time: "17:00",
        end_time: "18:00",
        affects_attendance: false,
        leave_scope: "class_closed",
      },
      {
        start_date: "2026-10-15",
        end_date: "2026-10-15",
        full_day: true,
        affects_attendance: false,
        leave_scope: "staff",
      },
    ],
    approvedLeaves: [],
    workingDays: [1, 2, 3, 4, 5],
  })

  assert.deepEqual(monthlyReportHeaders.dailyExport, [
    "Register No.",
    "Student Name",
    "Course",
    "Date",
    "Entry Time",
    "Exit Time",
    "Attendance Status",
    "Leave Type",
    "Leave Start Time",
    "Leave End Time",
    "Leave Duration",
  ])
  assert.deepEqual(monthlyReportHeaders.monthEnd, [
    "Register No.",
    "Student Name",
    "Course",
    "Date",
    "Present",
    "Absent",
    "Total",
    "Attendance Status",
    "Entry Time",
    "Exit Time",
    "Leave Type",
    "Leave Start Time",
    "Leave End Time",
    "Leave Duration",
  ])
  const presentPartial = report.summaryRows.find(
    (row) => row.date === "2026-10-13",
  )
  const fullDayClosure = report.summaryRows.find(
    (row) => row.date === "2026-10-14",
  )
  const staffLeave = report.summaryRows.find(
    (row) => row.date === "2026-10-15",
  )
  assert.deepEqual(
    {
      status: presentPartial.status,
      present: presentPartial.present,
      absent: presentPartial.absent,
      entryTime: presentPartial.entryTime,
      exitTime: presentPartial.exitTime,
      leaveType: presentPartial.leaveType,
      leaveStartTime: presentPartial.leaveStartTime,
      leaveEndTime: presentPartial.leaveEndTime,
      leaveDuration: presentPartial.leaveDuration,
    },
    {
      status: "PRESENT",
      present: 1,
      absent: 0,
      entryTime: "2026-10-13T04:00:00.000Z",
      exitTime: null,
      leaveType: "Class Closed — Partial Time",
      leaveStartTime: "17:00",
      leaveEndTime: "18:00",
      leaveDuration: "1 hour",
    },
  )
  assert.deepEqual(
    {
      status: fullDayClosure.status,
      present: fullDayClosure.present,
      absent: fullDayClosure.absent,
      total: fullDayClosure.total,
      leaveType: fullDayClosure.leaveType,
    },
    {
      status: "LEAVE",
      present: 0,
      absent: 0,
      total: 0,
      leaveType: "Class Closed — Full Day",
    },
  )
  assert.notEqual(staffLeave.status, "LEAVE")
  assert.equal(staffLeave.leaveType, "Staff/Admin Leave (no attendance impact)")

  const dailyWorkbook = createDailyAttendanceWorkbook(report, "2026-10-13")
  const dailyWorkbookXml = readZipTextFile(dailyWorkbook, "xl/workbook.xml")
  const dailySheet = readZipTextFile(
    dailyWorkbook,
    "xl/worksheets/sheet1.xml",
  )
  assert.deepEqual(readSheetNames(dailyWorkbookXml), ["Daily Attendance"])
  assert.deepEqual(
    readInlineHeaderRow(dailySheet),
    monthlyReportHeaders.dailyExport,
  )
  assert.match(dailySheet, /Office Automation/)
  assert.match(dailySheet, />PRESENT</)
  assert.match(dailySheet, />17:00</)
  assert.match(dailySheet, />18:00</)
  assert.match(dailySheet, />1 hour</)
  assert.match(dailySheet, /autoFilter/)
  assert.match(dailySheet, /state="frozen"/)

  const monthlyWorkbook = createMonthEndAttendanceWorkbook(report)
  const monthlyWorkbookXml = readZipTextFile(
    monthlyWorkbook,
    "xl/workbook.xml",
  )
  const monthlySheet = readZipTextFile(
    monthlyWorkbook,
    "xl/worksheets/sheet1.xml",
  )
  assert.deepEqual(readSheetNames(monthlyWorkbookXml), ["Attendance Report"])
  assert.deepEqual(
    readInlineHeaderRow(monthlySheet),
    monthlyReportHeaders.monthEnd,
  )
  assert.match(monthlySheet, /Office Automation/)
  assert.match(monthlySheet, />LEAVE</)
  assert.match(monthlySheet, /Class Closed — Full Day/)
  assert.match(monthlySheet, /Class Closed — Partial Time/)
  assert.match(monthlySheet, />17:00</)
  assert.match(monthlySheet, />18:00</)
  assert.match(monthlySheet, />1 hour</)
})

test("monthly export marks class closure LEAVE and keeps attendance present on a partial leave date", () => {
  const report = buildMonthlyReportData({
    month: "2026-10",
    today: "2026-10-15",
    students: [
      {
        id: 1,
        register_number: "CSC001",
        name: "Test Student",
        course: "Course",
        active: true,
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
    attendance: [
      {
        student_id: 1,
        register_number: "CSC001",
        name: "Test Student",
        course: "Course",
        attendance_date: "2026-10-13",
        entry_time: "2026-10-13T04:00:00.000Z",
        exit_time: null,
        status: "present",
      },
    ],
    events: [
      {
        start_date: "2026-10-14",
        end_date: "2026-10-14",
        full_day: true,
        affects_attendance: true,
        leave_scope: "class_closed",
      },
      {
        start_date: "2026-10-13",
        end_date: "2026-10-13",
        full_day: false,
        start_time: "10:00",
        end_time: "12:00",
        affects_attendance: false,
        leave_scope: "class_closed",
      },
      {
        start_date: "2026-10-15",
        end_date: "2026-10-15",
        full_day: false,
        start_time: "10:00",
        end_time: "12:00",
        affects_attendance: false,
        leave_scope: "staff",
      },
    ],
    approvedLeaves: [],
    workingDays: [1, 2, 3, 4, 5],
  })

  const closed = report.summaryRows.find((row) => row.date === "2026-10-14")
  const presentPartial = report.summaryRows.find((row) => row.date === "2026-10-13")
  const staffPartial = report.summaryRows.find((row) => row.date === "2026-10-15")
  assert.equal(closed.status, "LEAVE")
  assert.equal(closed.absent, 0)
  assert.equal(presentPartial.status, "PRESENT")
  assert.equal(presentPartial.leaveInfo, "Class closed — 10:00–12:00 (2 hours)")
  assert.equal(staffPartial.status, "ABSENT")
  assert.equal(staffPartial.leaveInfo, "Staff/Admin leave — 10:00–12:00 (2 hours)")
  assert.ok(monthlyReportHeaders.summary.includes("Attendance Status"))

  const workbook = createMonthlyAttendanceWorkbook(report)
  const summarySheet = readZipTextFile(
    workbook,
    "xl/worksheets/sheet2.xml",
  )
  assert.match(summarySheet, /Attendance Status/)
  assert.match(summarySheet, />LEAVE</)
  assert.match(summarySheet, /Class closed/)
  assert.match(summarySheet, /Staff\/Admin leave/)
})

test("future dates are not marked absent and duplicate daily attendance is exported once", () => {
  const report = buildMonthlyReportData({
    month: "2026-11",
    today: "2026-10-15",
    students: [
      {
        id: 1,
        register_number: "CSC001",
        name: "Test Student",
        active: true,
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
    attendance: [
      { student_id: 1, register_number: "CSC001", name: "Test Student", attendance_date: "2026-11-02", status: "present" },
      { student_id: 1, register_number: "CSC001", name: "Test Student", attendance_date: "2026-11-02", status: "present" },
    ],
    events: [],
    approvedLeaves: [],
    workingDays: [1, 2, 3, 4, 5],
  })

  assert.equal(report.dailyRows.length, 1)
  assert.ok(report.summaryRows.every((row) => row.absent === 0))
  assert.equal(
    report.summaryRows.find((row) => row.date === "2026-11-02").status,
    "PRESENT",
  )
  assert.ok(
    report.summaryRows
      .filter((row) => row.date !== "2026-11-02")
      .every((row) => row.status === "UPCOMING"),
  )
})
