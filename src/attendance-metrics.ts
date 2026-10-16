import type { StudentMonthlySummary } from "./api"

export type AttendanceCounts = {
  presentDays: number
  absentDays: number
  totalDays: number
  presentPercentage: number | null
  absentPercentage: number | null
}

export function attendanceCounts(
  presentDays: number,
  absentDays: number,
): AttendanceCounts {
  const totalDays = presentDays + absentDays
  return {
    presentDays,
    absentDays,
    totalDays,
    presentPercentage:
      totalDays === 0 ? null : Math.round((presentDays / totalDays) * 1000) / 10,
    absentPercentage:
      totalDays === 0 ? null : Math.round((absentDays / totalDays) * 1000) / 10,
  }
}

export function overallAttendanceCounts(
  summaries: readonly StudentMonthlySummary[],
): AttendanceCounts {
  return attendanceCounts(
    summaries.reduce((total, summary) => total + summary.presentDays, 0),
    summaries.reduce((total, summary) => total + summary.absentDays, 0),
  )
}
