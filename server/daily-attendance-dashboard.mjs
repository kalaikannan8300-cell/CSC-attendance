import { businessDate } from "./business-date.mjs"

export function buildDailyAttendanceDashboard({
  date,
  today = businessDate(),
  students,
  attendance,
  closures,
  approvedLeaves,
  workingDays,
}) {
  const workWeek = new Set(workingDays)
  const dateValue = new Date(`${date}T00:00:00Z`)
  const eligibleWorkingDay = date <= today && workWeek.has(dateValue.getUTCDay())
  const classClosed = closures.length > 0
  const activeStudents = students.filter((student) => student.active)
  const studentsById = new Map(students.map((student) => [String(student.id), student]))
  const attendanceByStudent = new Map()

  for (const record of attendance) {
    const key = String(record.student_id)
    if (!studentsById.has(key) || attendanceByStudent.has(key)) continue
    attendanceByStudent.set(key, record)
  }

  const presentStudents = [...attendanceByStudent.values()]
    .map((record) => ({
      registerNumber: record.register_number,
      name: record.name,
      course: record.course ?? "",
      entryTime: record.entry_time,
      exitTime: record.exit_time,
      status: "PRESENT",
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.registerNumber.localeCompare(right.registerNumber),
    )

  const approvedLeaveIds = new Set(
    approvedLeaves.map((leave) => String(leave.student_id)),
  )
  const presentIds = new Set(attendanceByStudent.keys())
  const absentStudents =
    eligibleWorkingDay && !classClosed
      ? activeStudents
          .filter((student) => {
            const enrolledDate = businessDate(new Date(student.created_at))
            return (
              enrolledDate <= date &&
              !presentIds.has(String(student.id)) &&
              !approvedLeaveIds.has(String(student.id))
            )
          })
          .map((student) => ({
            registerNumber: student.register_number,
            name: student.name,
            course: student.course ?? "",
            status: "ABSENT",
          }))
          .sort(
            (left, right) =>
              left.name.localeCompare(right.name) ||
              left.registerNumber.localeCompare(right.registerNumber),
          )
      : []

  return {
    date,
    totalActiveStudents: activeStudents.length,
    presentStudents,
    absentStudents,
    isEligibleWorkingDay: eligibleWorkingDay,
    isFullDayClassClosure: classClosed,
    closureTitle: closures[0]?.title ?? null,
  }
}
