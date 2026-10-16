import type { AdminLeave, AdminLeaveInput } from "./api.ts"

export type LeaveForm = {
  scope: AdminLeaveInput["scope"]
  leaveType: AdminLeaveInput["leaveType"]
  reason: string
  startTime: string
  endTime: string
}

export type LeaveDialogDraft = {
  isOpen: boolean
  selectedDate: string
  editingLeave: AdminLeave | null
  form: LeaveForm
}

export function openLeaveDialog(
  selectedDate: string,
  leave?: AdminLeave,
): LeaveDialogDraft {
  return {
    isOpen: true,
    selectedDate,
    editingLeave: leave ?? null,
    form: leave
      ? {
          scope: leave.leaveScope,
          leaveType: leave.fullDay ? "full_day" : "partial_time",
          reason: leave.description,
          startTime: leave.startTime?.slice(0, 5) ?? "",
          endTime: leave.endTime?.slice(0, 5) ?? "",
        }
      : {
          scope: "staff",
          leaveType: "full_day",
          reason: "",
          startTime: "",
          endTime: "",
        },
  }
}

export function calendarDateForCell(month: string, day: number | null) {
  return day === null ? "" : `${month}-${String(day).padStart(2, "0")}`
}
