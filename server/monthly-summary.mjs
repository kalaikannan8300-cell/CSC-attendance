import { businessDate } from "./business-date.mjs"

function monthEnd(month) {
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10)
}

function dateString(value) {
  return String(value).slice(0, 10)
}

export function calculateMonthlySummaries({
  month,
  today,
  students,
  attendance,
  events,
  approvedLeaves,
  workingDays,
}) {
  const monthStart = `${month}-01`
  const lastDate = monthEnd(month)
  const throughDate = today < lastDate ? today : lastDate
  const schedule = new Set(workingDays)
  const presentByStudent = new Map()

  for (const row of attendance) {
    const key = String(row.student_id)
    if (!presentByStudent.has(key)) presentByStudent.set(key, new Set())
    presentByStudent.get(key).add(dateString(row.attendance_date))
  }

  const closedDates = new Set()
  for (const event of events) {
    if (!event.full_day || !event.affects_attendance) continue
    const cursor = new Date(`${dateString(event.start_date)}T00:00:00Z`)
    const end = new Date(`${dateString(event.end_date)}T00:00:00Z`)
    while (cursor <= end) {
      closedDates.add(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  const leavesByStudent = new Map()
  for (const leave of approvedLeaves) {
    const key = String(leave.student_id)
    if (!leavesByStudent.has(key)) leavesByStudent.set(key, new Set())
    leavesByStudent.get(key).add(dateString(leave.leave_date))
  }

  return students.map(({ id, created_at, active = true }) => {
    const key = String(id)
    const presentDates = presentByStudent.get(key) ?? new Set()
    const leaveDates = leavesByStudent.get(key) ?? new Set()
    const enrolledDate = businessDate(new Date(created_at))
    const expectedStart =
      enrolledDate > monthStart ? enrolledDate : monthStart
    const expectedDates = new Set()
    const leaveDays = new Set()
    const cursor = new Date(`${expectedStart}T00:00:00Z`)
    const end = new Date(`${throughDate}T00:00:00Z`)

    while (cursor <= end) {
      const weekday = cursor.getUTCDay()
      const date = cursor.toISOString().slice(0, 10)
      if (
        schedule.has(weekday) &&
        !closedDates.has(date) &&
        !leaveDates.has(date)
      ) {
        expectedDates.add(date)
      }
      if (
        schedule.has(weekday) &&
        (closedDates.has(date) || leaveDates.has(date))
      ) {
        leaveDays.add(date)
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    let absentDays = 0
    for (const date of expectedDates) {
      if (active && !presentDates.has(date)) absentDays += 1
    }

    return {
      studentId: Number(id),
      month,
      presentDays: [...presentDates].filter(
        (date) => date >= monthStart && date <= throughDate,
      ).length,
      absentDays,
      leaveDays: leaveDays.size,
    }
  })
}
