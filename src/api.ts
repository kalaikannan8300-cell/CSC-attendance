export type Student = {
  id: number

  registerNumber: string

  name: string

  phoneNumber: string

  address: string

  course: string

  classTiming: string

  active: boolean
}

export type StudentInput = Omit<Student, "id">

export type StudentMonthlySummary = {
  studentId: number
  month: string
  presentDays: number
  absentDays: number
  leaveDays: number
}

export type CalendarEvent = {
  id: number
  title: string
  eventType: "public_holiday" | "csc_closed" | "emergency_leave" | "event" | "other"
  description: string
  startDate: string
  endDate: string
  fullDay: boolean
  startTime: string | null
  endTime: string | null
  affectsAttendance: boolean
  leaveScope?: "staff" | "class_closed" | null
  createdBy?: number | null
  createdByUsername?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type CalendarEventInput = Omit<CalendarEvent, "id">

export type AdminLeave = {
  id: number
  title: string
  eventType: CalendarEvent["eventType"]
  description: string
  startDate: string
  endDate: string
  fullDay: boolean
  startTime: string | null
  endTime: string | null
  affectsAttendance: boolean
  leaveScope: "staff" | "class_closed"
  createdBy: number | null
  createdByUsername: string | null
  createdAt: string
  updatedAt: string
}

export type AdminLeaveInput = {
  date: string
  scope: AdminLeave["leaveScope"]
  leaveType: "full_day" | "partial_time"
  reason: string
  startTime: string | null
  endTime: string | null
}

export type StudentAttendanceHistory = {
  id: number
  attendanceDate: string
  entryTime: string
  exitTime: string | null
  status: "present" | "completed"
  approvedLeave: boolean
}

export type AttendanceRecord = {
  id: number

  register_number: string

  name: string

  attendance_date: string

  entry_time: string

  exit_time: string | null

  status: "present" | "completed"
}

export type DailyDashboardStudent = {
  registerNumber: string
  name: string
  course: string
  status: "PRESENT" | "ABSENT"
  entryTime?: string
  exitTime?: string | null
}

export type DailyAttendanceDashboard = {
  date: string
  totalActiveStudents: number
  presentStudents: DailyDashboardStudent[]
  absentStudents: DailyDashboardStudent[]
  isEligibleWorkingDay: boolean
  isFullDayClassClosure: boolean
  closureTitle: string | null
}

export type ExitRequest = {
  id: number

  requested_at: string

  status: "pending" | "approved" | "rejected"

  processed_at: string | null

  register_number: string

  name: string

  attendance_date: string

  entry_time: string

  exit_time: string | null

  attendance_status: "present" | "completed"

  attendance_id: number
}

export type SecondCheckInRequest = {
  id: number
  requested_at: string
  status: "pending" | "approved" | "rejected" | "completed"
  processed_at: string | null
  attendance_date: string
  register_number: string
  name: string
}

export type StudentAttendance = {
  id: number
  entryTime: string
  exitTime: string | null
  status: "present" | "completed"
}

type AttendanceMarkResponse = {
  attendance: {
    id: number
    markedAt: string
    exitTime: string | null
    status:
      | "entry_recorded"
      | "already_checked_in"
      | "already_completed"
      | "second_check_in_pending"
      | "second_check_in_approved"
      | "second_entry_recorded"
  }
  secondCheckInRequest?: {
    id: number
    requestedAt: string
    status: "pending" | "approved"
  }
}

type StudentSessionResponse = {
  attendance: StudentAttendance
  secondCheckInRequest: {
    status: "pending" | "approved" | "rejected" | "completed"
    requestedAt: string
  } | null
}

type CheckOutResponse = {
  attendance: {
    id: number
    exitTime: string
    status: "completed"
  }
}

type AttendanceFilters = {
  date: string
  search?: string
}

type ExitRequestResult = {
  success: true
  status: "approved" | "rejected"
}

type MarkExitResponse = {
  attendance: {
    id: number
    exitTime: string
  }
}

export class ApiError extends Error {
  status: number

  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)

    this.name = "ApiError"

    this.status = status

    this.code = code
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const responseStatus = response.ok ? 502 : response.status
  const invalidResponseMessage = response.ok
    ? "The attendance service returned an empty or invalid response. Please try again."
    : `The attendance service returned an invalid error response (HTTP ${response.status}).`

  let text: string
  try {
    text = await response.text()
  } catch {
    throw new ApiError(
      "The attendance service response was interrupted. Please try again.",
      responseStatus,
      "INVALID_API_RESPONSE",
    )
  }

  if (!text.trim()) {
    throw new ApiError(
      invalidResponseMessage,
      responseStatus,
      "INVALID_API_RESPONSE",
    )
  }

  const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()
  if (
    contentType !== "application/json" &&
    !contentType?.endsWith("+json")
  ) {
    throw new ApiError(
      invalidResponseMessage,
      responseStatus,
      "INVALID_API_RESPONSE",
    )
  }

  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    throw new ApiError(
      invalidResponseMessage,
      responseStatus,
      "INVALID_API_RESPONSE",
    )
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ApiError(
      invalidResponseMessage,
      responseStatus,
      "INVALID_API_RESPONSE",
    )
  }

  return result as Record<string, unknown>
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)

  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json")

  headers.set("X-Requested-With", "CSCAttendance")

  let response: Response

  try {
    response = await fetch(path, {
      ...options,

      headers,

      credentials: "same-origin",
    })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError(
        "Cannot reach the attendance API. Check your connection and try again.",

        0,
      )
    }

    throw error
  }

  const result = await readJsonResponse(response)

  if (!response.ok) {
    throw new ApiError(
      typeof result.error === "string"
        ? result.error
        : `The request could not be completed (HTTP ${response.status}).`,

      response.status,

      typeof result.code === "string" ? result.code : undefined,
    )
  }

  return result as T
}

export const adminApi = {
  login: (username: string, password: string) =>
    request<{ authenticated: true }>("/api/admin/login", {
      method: "POST",

      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    request<{ authenticated: false }>("/api/admin/logout", { method: "POST" }),
}

export const studentApi = {
  list: () => request<{ students: Student[] }>("/api/students"),

  create: (student: StudentInput) =>
    request<{ student: Student }>("/api/students", {
      method: "POST",

      body: JSON.stringify(student),
    }),

  update: (id: number, student: StudentInput) =>
    request<{ student: Student }>(`/api/students/${id}`, {
      method: "PATCH",

      body: JSON.stringify(student),
    }),

  monthlySummary: (month: string) =>
    request<{ summaries: StudentMonthlySummary[] }>(
      `/api/admin/student-attendance-summary?month=${encodeURIComponent(month)}`,
    ),

  attendanceHistory: (id: number, month: string) =>
    request<{ attendance: StudentAttendanceHistory[]; approvedLeaves: string[]; month: string }>(
      `/api/admin/students/${id}/attendance?month=${encodeURIComponent(month)}`,
    ),

  setApprovedLeave: (id: number, leaveDate: string, approved: boolean) =>
    request<{ approved: boolean }>(`/api/admin/students/${id}/leave`, {
      method: approved ? "POST" : "DELETE",
      body: JSON.stringify({ leaveDate }),
    }),
}

export const calendarApi = {
  workingDays: () =>
    request<{ workingDays: number[] }>("/api/admin/calendar-settings"),

  setWorkingDays: (workingDays: number[]) =>
    request<{ workingDays: number[] }>("/api/admin/calendar-settings", {
      method: "PUT",
      body: JSON.stringify({ workingDays }),
    }),

  list: (month: string) =>
    request<{ events: CalendarEvent[] }>(
      `/api/admin/calendar-events?month=${encodeURIComponent(month)}`,
    ),

  create: (event: CalendarEventInput) =>
    request<{ event: CalendarEvent }>("/api/admin/calendar-events", {
      method: "POST",
      body: JSON.stringify(event),
    }),

  update: (id: number, event: CalendarEventInput) =>
    request<{ event: CalendarEvent }>(`/api/admin/calendar-events/${id}`, {
      method: "PUT",
      body: JSON.stringify(event),
    }),

  remove: (id: number) =>
    request<{ deleted: true }>(`/api/admin/calendar-events/${id}`, {
      method: "DELETE",
    }),

  listLeaves: (month: string) =>
    request<{ leaves: AdminLeave[] }>(
      `/api/admin/leaves?month=${encodeURIComponent(month)}`,
    ),

  createLeave: (leave: AdminLeaveInput) =>
    request<{ leave: AdminLeave }>("/api/admin/leaves", {
      method: "POST",
      body: JSON.stringify(leave),
    }),

  updateLeave: (id: number, leave: AdminLeaveInput) =>
    request<{ leave: AdminLeave }>(`/api/admin/leaves/${id}`, {
      method: "PUT",
      body: JSON.stringify(leave),
    }),

  removeLeave: (id: number) =>
    request<{ deleted: true }>(`/api/admin/leaves/${id}`, {
      method: "DELETE",
    }),
}

export const reportApi = {
  dailyAttendance: (date: string) =>
    downloadReport(
      `/api/admin/reports/daily-attendance.xlsx?date=${encodeURIComponent(date)}`,
    ),
  monthEndAttendance: (month: string) =>
    downloadReport(
      `/api/admin/reports/month-end-attendance.xlsx?month=${encodeURIComponent(month)}`,
    ),
  monthlyAttendance: (month: string) =>
    downloadReport(
      `/api/admin/reports/monthly-attendance.xlsx?month=${encodeURIComponent(month)}`,
    ),
}

async function downloadReport(path: string): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(path, {
      headers: { "X-Requested-With": "CSCAttendance" },
      credentials: "same-origin",
    })
  } catch (error) {
    if (error instanceof TypeError)
      throw new ApiError("Cannot reach the attendance API. Try again.", 0)
    throw error
  }

  if (!response.ok) {
    const result = await readJsonResponse(response)
    throw new ApiError(
      typeof result.error === "string"
        ? result.error
        : `The report could not be downloaded (HTTP ${response.status}).`,
      response.status,
      typeof result.code === "string" ? result.code : undefined,
    )
  }
  const contentType = response.headers.get("Content-Type") ?? ""
  if (!contentType.includes("spreadsheetml.sheet"))
    throw new ApiError("The server did not return an Excel workbook.", 502)
  return response.blob()
}

export const promotionApi = {
  publicList: () =>
    request<{ promotions: PromotionRecord[] }>("/api/promotions"),
  list: () => request<{ promotions: PromotionRecord[] }>("/api/admin/promotions"),
  upload: (file: File, title: string) => {
    const data = new FormData()
    data.set("image", file)
    data.set("title", title)
    return request<{ promotion: PromotionRecord }>("/api/admin/promotions", {
      method: "POST",
      body: data,
    })
  },
  replace: (id: number, file: File) => {
    const data = new FormData()
    data.set("image", file)
    return request<{ promotion: PromotionRecord }>(`/api/admin/promotions/${id}`, {
      method: "PUT",
      body: data,
    })
  },
  setEnabled: (id: number, enabled: boolean) =>
    request<{ promotion: PromotionRecord }>(`/api/admin/promotions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  order: (ids: number[]) =>
    request<{ promotions: PromotionRecord[] }>("/api/admin/promotions/order", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),
  remove: (id: number) =>
    request<{ deleted: true }>(`/api/admin/promotions/${id}`, {
      method: "DELETE",
    }),
}

export type PromotionRecord = {
  id: number
  title: string
  source: string
  displayOrder: number
  enabled: boolean
}

export const attendanceApi = {
  mark: (registerNumber: string) =>
    request<AttendanceMarkResponse>("/api/attendance", {
      method: "POST",
      body: JSON.stringify({ registerNumber }),
    }),

  studentSession: () =>
    request<StudentSessionResponse>("/api/attendance/session"),

  completeSecondCheckIn: () =>
    request<AttendanceMarkResponse>(
      "/api/attendance/second-check-in/complete",
      { method: "POST" },
    ),

  checkOut: () =>
    request<CheckOutResponse>("/api/attendance/check-out", {
      method: "POST",
    }),

  list: (filters: AttendanceFilters) => {
    const params = new URLSearchParams({ date: filters.date })

    if (filters.search?.trim()) params.set("search", filters.search.trim())

    return request<{ attendance: AttendanceRecord[] }>(
      `/api/admin/attendance?${params.toString()}`,
    )
  },

  dashboard: (date: string) =>
    request<DailyAttendanceDashboard>(
      `/api/admin/dashboard-attendance?date=${encodeURIComponent(date)}`,
    ),

  exitRequests: () =>
    request<{ requests: ExitRequest[] }>("/api/admin/exit-requests"),

  processExitRequest: (id: number, action: "approve" | "reject") =>
    request<ExitRequestResult>(
      `/api/admin/exit-requests/${id}/${action}`,

      { method: "POST" },
    ),

  secondCheckInRequests: () =>
    request<{ requests: SecondCheckInRequest[] }>(
      "/api/admin/second-check-in-requests",
    ),

  processSecondCheckInRequest: (id: number, action: "approve" | "reject") =>
    request<ExitRequestResult>(
      `/api/admin/second-check-in-requests/${id}/${action}`,
      { method: "POST" },
    ),

  markExit: (id: number) =>
    request<MarkExitResponse>(
      `/api/admin/attendance/${id}/mark-exit`,

      { method: "POST" },
    ),
}
