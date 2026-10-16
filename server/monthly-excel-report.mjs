import { deflateRawSync } from "node:zlib"

import { businessDate } from "./business-date.mjs"

const DAY_MS = 86_400_000
const EXCEL_EPOCH_OFFSET = 25_569

const DAILY_HEADERS = [
  "Register No.",
  "Student Name",
  "Course",
  "Date",
  "Entry Time",
  "Exit Time",
  "Status",
  "Leave Details",
]

const SUMMARY_HEADERS = [
  "Register No.",
  "Student Name",
  "Course",
  "Date",
  "Present",
  "Absent",
  "Total",
  "Attendance Status",
  "Leave Details",
]

const DAILY_EXPORT_HEADERS = [
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
]

const MONTH_END_HEADERS = [
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
]

function dateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function dateToExcelSerial(value) {
  const date = dateString(value)
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS) + EXCEL_EPOCH_OFFSET
}

export function validateReportMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    throw Object.assign(new Error("Month must use YYYY-MM format."), {
      status: 400,
      code: "VALIDATION_ERROR",
    })

  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const end = new Date(0)
  end.setUTCHours(0, 0, 0, 0)
  end.setUTCFullYear(year, month, 0)
  if (!Number.isFinite(end.getTime()) || year < 1)
    throw Object.assign(new Error("Month must be a valid calendar month."), {
      status: 400,
      code: "VALIDATION_ERROR",
    })

  return {
    month: value,
    startDate: `${value}-01`,
    endDate: end.toISOString().slice(0, 10),
  }
}

export function validateReportDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw Object.assign(new Error("Date must use a valid YYYY-MM-DD value."), {
      status: 400,
      code: "VALIDATION_ERROR",
    })
  }

  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw Object.assign(new Error("Date must be a valid calendar date."), {
      status: 400,
      code: "VALIDATION_ERROR",
    })
  }
  return value
}

export function buildMonthlyReportData({
  month,
  today = businessDate(),
  students,
  attendance,
  events,
  approvedLeaves,
  workingDays,
}) {
  const { startDate, endDate } = validateReportMonth(month)
  const lastDueDate = today < endDate ? today : endDate
  const workWeek = new Set(workingDays)
  const attendanceByStudentDate = new Set()
  const dailyRows = [...attendance]
    .sort((a, b) => {
      const dateCompare = dateString(a.attendance_date).localeCompare(
        dateString(b.attendance_date),
      )
      if (dateCompare !== 0) return dateCompare
      return String(a.register_number).localeCompare(String(b.register_number))
    })
    .filter((row) => {
      const date = dateString(row.attendance_date)
      if (date < startDate || date > endDate) return false
      const key = `${row.student_id}:${date}`
      if (attendanceByStudentDate.has(key)) return false
      attendanceByStudentDate.add(key)
      return true
    })
    .map((row) => ({
      registerNumber: row.register_number,
      studentName: row.name,
      course: row.course ?? "",
      date: dateString(row.attendance_date),
      entryTime: row.entry_time,
      exitTime: row.exit_time,
      status: row.status === "present" ? "PRESENT" : "COMPLETED",
      leaveInfo: "",
    }))

  const leaveDetailsByDate = new Map()
  const leaveFieldsByDate = new Map()
  const pushLeaveDetail = (date, value) => {
    if (!leaveDetailsByDate.has(date)) leaveDetailsByDate.set(date, [])
    leaveDetailsByDate.get(date).push(value)
  }
  const addLeaveFields = (date, leave) => {
    if (!leaveFieldsByDate.has(date)) leaveFieldsByDate.set(date, [])
    leaveFieldsByDate.get(date).push(leave)
  }
  const actualDatesByStudent = new Map()
  for (const attendanceRecord of attendance) {
    const date = dateString(attendanceRecord.attendance_date)
    if (date < startDate || date > endDate) continue
    const key = String(attendanceRecord.student_id)
    if (!actualDatesByStudent.has(key)) actualDatesByStudent.set(key, new Set())
    actualDatesByStudent.get(key).add(date)
  }

  const closedDates = new Set()
  for (const event of events) {
    if (
      event.leave_scope === "staff" ||
      (!event.affects_attendance && !event.leave_scope)
    ) {
      if (event.leave_scope) {
        const date = dateString(event.start_date)
        const partial = !event.full_day
        const detail = event.full_day
          ? "Staff/Admin leave — full day"
          : `Staff/Admin leave — ${String(event.start_time).slice(0, 5)}–${String(event.end_time).slice(0, 5)} (${formatDuration(event.start_time, event.end_time)})`
        pushLeaveDetail(date, detail)
        addLeaveFields(date, {
          type: "Staff/Admin Leave (no attendance impact)",
          startTime: partial ? String(event.start_time).slice(0, 5) : "",
          endTime: partial ? String(event.end_time).slice(0, 5) : "",
          duration: partial ? formatDuration(event.start_time, event.end_time) : "",
          scope: "staff",
        })
      }
      continue
    }
    if (event.leave_scope === "class_closed" && !event.full_day) {
      const date = dateString(event.start_date)
      const startTime = String(event.start_time).slice(0, 5)
      const endTime = String(event.end_time).slice(0, 5)
      const duration = formatDuration(event.start_time, event.end_time)
      pushLeaveDetail(
        date,
        `Class closed — ${startTime}–${endTime} (${duration})`,
      )
      addLeaveFields(date, {
        type: "Class Closed — Partial Time",
        startTime,
        endTime,
        duration,
        scope: "class_closed",
      })
      continue
    }
    if (!event.full_day || !event.affects_attendance) continue
    let cursor = new Date(`${dateString(event.start_date)}T00:00:00Z`)
    const end = new Date(`${dateString(event.end_date)}T00:00:00Z`)
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10)
      closedDates.add(date)
      if (event.leave_scope === "class_closed" || event.affects_attendance) {
        pushLeaveDetail(date, "Class closed — full day")
        addLeaveFields(date, {
          type: "Class Closed — Full Day",
          startTime: "",
          endTime: "",
          duration: "",
          scope: "class_closed",
        })
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  const leaveDatesByStudent = new Map()
  for (const leave of approvedLeaves) {
    const key = String(leave.student_id)
    if (!leaveDatesByStudent.has(key)) leaveDatesByStudent.set(key, new Set())
    leaveDatesByStudent.get(key).add(dateString(leave.leave_date))
  }

  const summaryRows = []
  const sortedStudents = [...students].sort((a, b) =>
    String(a.register_number).localeCompare(String(b.register_number)),
  )

  for (const student of sortedStudents) {
    const studentKey = String(student.id)
    const presentDates = actualDatesByStudent.get(studentKey) ?? new Set()
    const leaveDates = leaveDatesByStudent.get(studentKey) ?? new Set()
    const enrollmentDate = businessDate(new Date(student.created_at))
    const firstDate = enrollmentDate > startDate ? enrollmentDate : startDate
    const cursor = new Date(`${firstDate}T00:00:00Z`)
    const monthEnd = new Date(`${endDate}T00:00:00Z`)

    while (cursor <= monthEnd) {
      const date = cursor.toISOString().slice(0, 10)
      const weekday = cursor.getUTCDay()
      const present = presentDates.has(date) ? 1 : 0
      const studentLeave = leaveDates.has(date)
      const classLeave = closedDates.has(date)
      const isWorkingDay = workWeek.has(weekday)
      const includeRow =
        isWorkingDay || present > 0 || studentLeave || classLeave
      if (includeRow) {
        const isDue = date <= lastDueDate
        const absent =
          isDue && isWorkingDay && !classLeave && !studentLeave &&
          student.active && present === 0
            ? 1
            : 0
        const status = present
          ? "PRESENT"
          : studentLeave || classLeave
            ? "LEAVE"
            : !isDue
              ? "UPCOMING"
              : student.active && isWorkingDay
                ? "ABSENT"
                : "—"
        const leaveInfo = [
          ...(leaveDetailsByDate.get(date) ?? []),
          ...(studentLeave ? ["Approved student leave"] : []),
        ].join("; ")
        const leaveFields = [...(leaveFieldsByDate.get(date) ?? [])]
        if (studentLeave) {
          leaveFields.push({
            type: "Approved Student Leave",
            startTime: "",
            endTime: "",
            duration: "",
            scope: "student",
          })
        }
        const classLeaveFields = leaveFields.filter(
          (leave) => leave.scope === "class_closed",
        )
        const selectedLeaveFields = classLeaveFields.length
          ? classLeaveFields
          : leaveFields
        const leaveType = [
          ...new Set(selectedLeaveFields.map((leave) => leave.type)),
        ].join("; ")
        const partialLeave = selectedLeaveFields.find(
          (leave) => leave.startTime && leave.endTime,
        )
        summaryRows.push({
          registerNumber: student.register_number,
          studentName: student.name,
          course: student.course ?? "",
          date,
          present,
          absent,
          total: present + absent,
          status,
          leaveInfo,
          entryTime: null,
          exitTime: null,
          leaveType,
          leaveStartTime: partialLeave?.startTime ?? "",
          leaveEndTime: partialLeave?.endTime ?? "",
          leaveDuration: partialLeave?.duration ?? "",
        })
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  const detailsForDate = (date) =>
    (leaveDetailsByDate.get(date) ?? []).join("; ")
  for (const row of dailyRows) {
    row.leaveInfo = detailsForDate(row.date)
    const leaveFields = leaveFieldsByDate.get(row.date) ?? []
    const classLeaveFields = leaveFields.filter(
      (leave) => leave.scope === "class_closed",
    )
    const selectedLeaveFields = classLeaveFields.length
      ? classLeaveFields
      : leaveFields
    const partialLeave = selectedLeaveFields.find(
      (leave) => leave.startTime && leave.endTime,
    )
    row.leaveType = [
      ...new Set(selectedLeaveFields.map((leave) => leave.type)),
    ].join("; ")
    row.leaveStartTime = partialLeave?.startTime ?? ""
    row.leaveEndTime = partialLeave?.endTime ?? ""
    row.leaveDuration = partialLeave?.duration ?? ""
  }

  const attendanceByKey = new Map()
  for (const row of dailyRows) {
    attendanceByKey.set(`${row.registerNumber}:${row.date}`, row)
  }
  for (const row of summaryRows) {
    const attendanceRow = attendanceByKey.get(
      `${row.registerNumber}:${row.date}`,
    )
    if (attendanceRow) {
      row.entryTime = attendanceRow.entryTime
      row.exitTime = attendanceRow.exitTime
    }
  }

  return {
    month,
    dailyRows,
    summaryRows,
    hasAttendance: dailyRows.length > 0,
  }
}

function formatDuration(startTime, endTime) {
  const minutes = (value) => {
    const [hours, mins] = String(value).slice(0, 5).split(":").map(Number)
    return hours * 60 + mins
  }
  const duration = minutes(endTime) - minutes(startTime)
  if (duration <= 0) return ""
  const hours = Math.floor(duration / 60)
  const remainder = duration % 60
  return [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    remainder ? `${remainder} minute${remainder === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" ")
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function columnName(index) {
  let current = index + 1
  let name = ""
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function cellXml(value, rowIndex, columnIndex, dateColumns) {
  const reference = `${columnName(columnIndex)}${rowIndex + 1}`
  const style = rowIndex === 0 ? ' s="1"' : dateColumns.has(columnIndex) ? ' s="2"' : ""
  if (rowIndex > 0 && dateColumns.has(columnIndex)) {
    return `<c r="${reference}"${style}><v>${dateToExcelSerial(value)}</v></c>`
  }
  if (typeof value === "number") {
    return `<c r="${reference}"${style}><v>${value}</v></c>`
  }
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value ?? "")}</t></is></c>`
}

function worksheetXml({ headers, rows, widths, dateColumns }) {
  const allRows = [headers, ...rows]
  const sheetRows = allRows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((value, columnIndex) =>
            cellXml(value, rowIndex, columnIndex, dateColumns),
          )
          .join("")}</row>`,
    )
    .join("")
  const columns = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("")
  const lastColumn = columnName(headers.length - 1)

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${lastColumn}${Math.max(allRows.length, 1)}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipFiles(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const dosTime = 0
  const dosDate = 0x21

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, "utf8")
    const source = Buffer.from(content, "utf8")
    const compressed = deflateRawSync(source)
    const checksum = crc32(source)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(source.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(source.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export function createMonthlyAttendanceWorkbook(report) {
  const dailyData = report.dailyRows.map((row) => [
    row.registerNumber,
    row.studentName,
    row.course,
    row.date,
    formatIndiaTime(row.entryTime),
    formatIndiaTime(row.exitTime),
    row.status,
    row.leaveInfo,
  ])
  const summaryData = report.summaryRows.map((row) => [
    row.registerNumber,
    row.studentName,
    row.course,
    row.date,
    row.present,
    row.absent,
    row.total,
    row.status,
    row.leaveInfo,
  ])
  const dailySheet = worksheetXml({
    headers: DAILY_HEADERS,
    rows: dailyData,
    widths: [19, 28, 24, 14, 17, 17, 19, 44],
    dateColumns: new Set([3]),
  })
  const summarySheet = worksheetXml({
    headers: SUMMARY_HEADERS,
    rows: summaryData,
    widths: [19, 28, 24, 14, 12, 12, 12, 20, 44],
    dateColumns: new Set([3]),
  })

  return zipFiles([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>CSC Attendance Report ${xmlEscape(report.month)}</dc:title><dc:creator>CSC Attendance System</dc:creator></cp:coreProperties>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl"/><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="Daily Attendance" sheetId="1" r:id="rId1"/><sheet name="Monthly Summary" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315C46"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ],
    ["xl/worksheets/sheet1.xml", dailySheet],
    ["xl/worksheets/sheet2.xml", summarySheet],
  ])
}

function createSingleSheetAttendanceWorkbook({
  title,
  sheetName,
  headers,
  rows,
  widths,
}) {
  const worksheet = worksheetXml({
    headers,
    rows,
    widths,
    dateColumns: new Set([3]),
  })
  const escapedSheetName = xmlEscape(sheetName)
  return zipFiles([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>CSC Attendance System</dc:creator></cp:coreProperties>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl"/><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="${escapedSheetName}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315C46"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ],
    ["xl/worksheets/sheet1.xml", worksheet],
  ])
}

export function createDailyAttendanceWorkbook(report, date) {
  const rows = report.summaryRows
    .filter((row) => row.date === date)
    .map((row) => [
      row.registerNumber,
      row.studentName,
      row.course,
      row.date,
      formatIndiaTime(row.entryTime),
      formatIndiaTime(row.exitTime),
      row.status,
      row.leaveType,
      row.leaveStartTime,
      row.leaveEndTime,
      row.leaveDuration,
    ])
  return createSingleSheetAttendanceWorkbook({
    title: `CSC Daily Attendance ${date}`,
    sheetName: "Daily Attendance",
    headers: DAILY_EXPORT_HEADERS,
    rows,
    widths: [19, 28, 24, 14, 17, 17, 20, 34, 18, 18, 22],
  })
}

export function createMonthEndAttendanceWorkbook(report) {
  const rows = report.summaryRows.map((row) => [
    row.registerNumber,
    row.studentName,
    row.course,
    row.date,
    row.present,
    row.absent,
    row.total,
    row.status,
    formatIndiaTime(row.entryTime),
    formatIndiaTime(row.exitTime),
    row.leaveType,
    row.leaveStartTime,
    row.leaveEndTime,
    row.leaveDuration,
  ])
  return createSingleSheetAttendanceWorkbook({
    title: `CSC Monthly Attendance ${report.month}`,
    sheetName: "Attendance Report",
    headers: MONTH_END_HEADERS,
    rows,
    widths: [19, 28, 24, 14, 12, 12, 12, 20, 17, 17, 34, 18, 18, 22],
  })
}

export function formatIndiaTime(value) {
  if (value === null || value === undefined || value === "") return ""
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date)
}

export const monthlyReportHeaders = {
  daily: DAILY_HEADERS,
  summary: SUMMARY_HEADERS,
  dailyExport: DAILY_EXPORT_HEADERS,
  monthEnd: MONTH_END_HEADERS,
}
