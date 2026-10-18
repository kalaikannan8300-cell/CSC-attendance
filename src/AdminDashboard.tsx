import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"

import {
  attendanceApi,
  calendarApi,
  promotionApi,
  reportApi,
  studentApi,
} from "./api"
import type {
  AdminLeave,
  AdminLeaveInput,
  AttendanceRecord,
  CalendarEvent,
  DailyAttendanceDashboard,
  ExitRequest,
  PromotionRecord,
  SecondCheckInRequest,
  Student,
  StudentAttendanceHistory,
  StudentInput,
  StudentMonthlySummary,
} from "./api"
import { overallAttendanceCounts } from "./attendance-metrics"
import { formatIndiaDate, formatIndiaTime, indiaDateInputValue } from "./india-time.js"
import { calendarDateForCell, openLeaveDialog } from "./leave-calendar"
import type { LeaveForm } from "./leave-calendar"
import { cloudinaryDeliveryUrl } from "./image-url"
import { AttendancePieChart, Brand, Button, Icon, TextField } from "./ui"

type AdminSection =
  | "attendance"
  | "exit-requests"
  | "second-check-in-requests"
  | "promotions"
  | "students"
  | "calendar"

function StudentManagement() {
  const [students, setStudents] = useState<Student[]>([])
  const [month, setMonth] = useState(indiaDateInputValue().slice(0, 7))
  const [summaries, setSummaries] = useState<
    Record<number, { presentDays: number; absentDays: number; leaveDays: number }>
  >({})
  const [isSummaryLoading, setIsSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState("")
  const summaryRefreshSequence = useRef(0)
  const [historyStudent, setHistoryStudent] = useState<Student | null>(null)
  const [history, setHistory] = useState<StudentAttendanceHistory[]>([])
  const [approvedLeaves, setApprovedLeaves] = useState<string[]>([])
  const [leaveDate, setLeaveDate] = useState("")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] =
    useState<"all" | "active" | "inactive">("all")
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState("")
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingStudent, setEditingStudent] = useState<Student | null>(null)
  const [form, setForm] = useState<StudentInput>({
    registerNumber: "",
    name: "",
    phoneNumber: "",
    address: "",
    course: "",
    classTiming: "",
    active: true,
  })

  const refreshStudents = async () => {
    setIsLoading(true)
    try {
      const result = await studentApi.list()
      setStudents(result.students)
      setError("")
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load students.",
      )
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshStudents()
  }, [])

  const refreshSummaries = async () => {
    const requestSequence = ++summaryRefreshSequence.current
    setIsSummaryLoading(true)
    setSummaryError("")
    try {
      const { summaries: items } = await studentApi.monthlySummary(month)
      if (requestSequence === summaryRefreshSequence.current) {
        setSummaries(
          Object.fromEntries(
            items.map((item) => [
              item.studentId,
              {
                presentDays: item.presentDays,
                absentDays: item.absentDays,
                leaveDays: item.leaveDays,
              },
            ]),
          ),
        )
      }
    } catch (summaryError) {
      if (requestSequence === summaryRefreshSequence.current) {
        setSummaries({})
        setSummaryError(
          summaryError instanceof Error
            ? summaryError.message
            : "Unable to load monthly attendance summaries.",
        )
      }
    } finally {
      if (requestSequence === summaryRefreshSequence.current) {
        setIsSummaryLoading(false)
      }
    }
  }

  useEffect(() => {
    setSummaries({})
    void refreshSummaries()
  }, [month, students])

  const downloadMonthlyReport = async () => {
    setIsExporting(true)
    setError("")
    try {
      const workbook = await reportApi.monthlyAttendance(month)
      const objectUrl = URL.createObjectURL(workbook)
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = `csc-attendance-${month}.xlsx`
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : "Unable to download the monthly attendance report.",
      )
    } finally {
      setIsExporting(false)
    }
  }

  const loadHistory = async (student: Student) => {
    setHistoryStudent(student)
    setHistory([])
    setError("")
    try {
      const result = await studentApi.attendanceHistory(student.id, month)
      setHistory(result.attendance)
      setApprovedLeaves(result.approvedLeaves)
    } catch (historyError) {
      setError(
        historyError instanceof Error
          ? historyError.message
          : "Unable to load attendance history.",
      )
    }
  }

  useEffect(() => {
    if (historyStudent) void loadHistory(historyStudent)
  }, [month])

  const setLeaveApproval = async (approved: boolean) => {
    if (!historyStudent || !leaveDate) return
    setError("")
    try {
      await studentApi.setApprovedLeave(historyStudent.id, leaveDate, approved)
      const result = await studentApi.attendanceHistory(historyStudent.id, month)
      setApprovedLeaves(result.approvedLeaves)
      setHistory(result.attendance)
      await refreshSummaries()
      setLeaveDate("")
    } catch (leaveError) {
      setError(
        leaveError instanceof Error
          ? leaveError.message
          : "Unable to update approved leave.",
      )
    }
  }

  const openNewStudentForm = () => {
    setEditingStudent(null)
    setForm({
      registerNumber: "",
      name: "",
      phoneNumber: "",
      address: "",
      course: "",
      classTiming: "",
      active: true,
    })
    setError("")
    setIsFormOpen(true)
  }

  const openEditForm = (student: Student) => {
    setEditingStudent(student)
    setForm({
      registerNumber: student.registerNumber,
      name: student.name,
      phoneNumber: student.phoneNumber,
      address: student.address,
      course: student.course,
      classTiming: student.classTiming,
      active: student.active,
    })
    setError("")
    setIsFormOpen(true)
  }

  const saveStudent = async (event: FormEvent) => {
    event.preventDefault()
    setError("")
    setIsSaving(true)
    try {
      if (editingStudent) await studentApi.update(editingStudent.id, form)
      else await studentApi.create(form)
      setIsFormOpen(false)
      setEditingStudent(null)
      await refreshStudents()
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save this student.",
      )
    } finally {
      setIsSaving(false)
    }
  }

  const changeStatus = async (student: Student) => {
    setError("")
    try {
      await studentApi.update(student.id, {
        registerNumber: student.registerNumber,
        name: student.name,
        phoneNumber: student.phoneNumber,
        address: student.address,
        course: student.course,
        classTiming: student.classTiming,
        active: !student.active,
      })
      await refreshStudents()
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "Unable to update this student's status.",
      )
    }
  }

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredStudents = students.filter((student) => {
    const matchesSearch = [
      student.registerNumber,
      student.name,
      student.phoneNumber,
      student.address,
      student.course,
      student.classTiming,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch))
    const matchesStatus =
      statusFilter === "all" || student.active === (statusFilter === "active")
    return matchesSearch && matchesStatus
  })

  return (
    <section className="student-management">
      <div className="management-toolbar">
        <div>
          <h2>Student records</h2>
          <p>
            Add, edit, and manage student access. Deactivated students and their
            attendance history are retained.
          </p>
        </div>
        <Button onClick={openNewStudentForm}>
          <Icon name="plus" />
          Add Student
        </Button>
      </div>

      {error && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}
      {summaryError && (
        <p className="management-error" role="alert">
          {summaryError}
        </p>
      )}

      {isFormOpen && (
        <form className="student-form" onSubmit={saveStudent}>
          <div className="student-form-heading">
            <h3>{editingStudent ? "Edit student" : "Add Student"}</h3>
            <button
              type="button"
              className="text-button"
              onClick={() => setIsFormOpen(false)}
            >
              Cancel
            </button>
          </div>
          <div className="student-form-grid">
            <label className="field">
              <span>Register Number</span>
              <input
                required
                maxLength={100}
                value={form.registerNumber}
                onChange={(event) =>
                  setForm({ ...form, registerNumber: event.target.value })
                }
                placeholder="Enter register number"
              />
            </label>
            <label className="field">
              <span>Student Name</span>
              <input
                required
                maxLength={200}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Enter student name"
              />
            </label>
            <label className="field">
              <span>Phone Number</span>
              <input
                required
                type="tel"
                maxLength={50}
                value={form.phoneNumber}
                onChange={(event) =>
                  setForm({ ...form, phoneNumber: event.target.value })
                }
                placeholder="Enter phone number"
              />
            </label>
            <label className="field">
              <span>Course</span>
              <input
                maxLength={200}
                value={form.course}
                onChange={(event) =>
                  setForm({ ...form, course: event.target.value })
                }
                placeholder="Enter course"
              />
            </label>
            <label className="field">
              <span>Class Timing</span>
              <input
                maxLength={200}
                value={form.classTiming}
                onChange={(event) =>
                  setForm({ ...form, classTiming: event.target.value })
                }
                placeholder="e.g. 9:00 AM - 11:00 AM"
              />
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={form.active ? "active" : "inactive"}
                onChange={(event) =>
                  setForm({ ...form, active: event.target.value === "active" })
                }
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="field student-address-field">
              <span>Address</span>
              <textarea
                required
                maxLength={500}
                rows={3}
                value={form.address}
                onChange={(event) =>
                  setForm({ ...form, address: event.target.value })
                }
                placeholder="Enter address"
              />
            </label>
          </div>
          <div className="student-form-actions">
            <Button variant="secondary" onClick={() => setIsFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? "Saving..."
                : editingStudent
                  ? "Save changes"
                  : "Save Student"}
            </Button>
          </div>
        </form>
      )}

      <div className="student-list-panel">
        <div className="student-list-toolbar">
          <label className="student-search">
            <Icon name="search" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search students"
              aria-label="Search students"
            />
          </label>
          <label className="student-filter">
            <span>Month</span>
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              aria-label="Attendance summary month"
            />
          </label>
          <Button
            variant="secondary"
            disabled={isExporting}
            onClick={() => void downloadMonthlyReport()}
          >
            {isExporting ? "Preparing report..." : "Download Excel"}
          </Button>
          <label className="student-filter">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="all">All students</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>
        <div className="student-table-wrap">
          <table className="student-table">
            <thead>
              <tr>
                <th>Register Number</th>
                <th>Name</th>
                <th>Course</th>
                <th>Class Timing</th>
                <th>Present Days</th>
                <th>Absent Days</th>
                <th>Leave Days</th>
                <th>Monthly Pie</th>
                <th>Phone Number</th>
                <th>Address</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={12} className="student-empty">
                    Loading students...
                  </td>
                </tr>
              ) : filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={12} className="student-empty">
                    {students.length
                      ? "No students match these filters."
                      : "No students yet. Add a student to get started."}
                  </td>
                </tr>
              ) : (
                filteredStudents.map((student) => (
                  <tr key={student.id}>
                    <td data-label="Register Number">
                      <strong>{student.registerNumber}</strong>
                    </td>
                    <td data-label="Name">{student.name}</td>
                    <td data-label="Course">{student.course || "—"}</td>
                    <td data-label="Class Timing">{student.classTiming || "—"}</td>
                    <td data-label="Present Days">
                      {isSummaryLoading
                        ? "…"
                        : summaryError
                          ? "—"
                        : summaries[student.id]?.presentDays ?? 0}
                    </td>
                    <td data-label="Absent Days">
                      {isSummaryLoading
                        ? "…"
                        : summaryError
                          ? "—"
                        : summaries[student.id]?.absentDays ?? 0}
                    </td>
                    <td data-label="Leave Days">
                      {isSummaryLoading
                        ? "…"
                        : summaryError
                          ? "—"
                        : summaries[student.id]?.leaveDays ?? 0}
                    </td>
                    <td data-label="Monthly Pie">
                      {isSummaryLoading ? (
                        <span className="attendance-loading" role="status">
                          Loading…
                        </span>
                      ) : summaryError ? (
                        <span className="attendance-chart-error" role="alert">
                          Unavailable
                        </span>
                      ) : (
                        <AttendancePieChart
                          compact
                          presentDays={summaries[student.id]?.presentDays ?? 0}
                          absentDays={summaries[student.id]?.absentDays ?? 0}
                          label={`${student.registerNumber} ${student.name}`}
                        />
                      )}
                    </td>
                    <td data-label="Phone Number">{student.phoneNumber}</td>
                    <td data-label="Address" className="student-address-cell">
                      {student.address}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`student-status ${
                          student.active ? "is-active" : "is-inactive"
                        }`}
                      >
                        {student.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td data-label="Actions">
                      <div className="student-actions">
                        <button
                          className="student-action"
                          onClick={() => void loadHistory(student)}
                        >
                          Attendance
                        </button>
                        <button
                          className="student-action"
                          onClick={() => openEditForm(student)}
                        >
                          <Icon name="edit" />
                          Edit
                        </button>
                        <button
                          className={`student-action ${
                            student.active ? "deactivate-action" : ""
                          }`}
                          onClick={() => void changeStatus(student)}
                        >
                          {student.active ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      {historyStudent && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-heading"
          >
            <div className="student-form-heading">
              <div>
                <h3 id="history-heading">
                  Attendance history · {historyStudent.name}
                </h3>
                <p>{historyStudent.registerNumber} · {month}</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setHistoryStudent(null)}
              >
                Close
              </button>
            </div>
            <div className="leave-editor">
              <label className="field">
                <span>Approve leave date</span>
                <input
                  type="date"
                  value={leaveDate}
                  min={`${month}-01`}
                  max={`${month}-31`}
                  onChange={(event) => setLeaveDate(event.target.value)}
                />
              </label>
              <Button
                disabled={!leaveDate || !leaveDate.startsWith(month)}
                onClick={() => {
                  if (window.confirm("Approve this leave date? It will not count as an absence.")) {
                    void setLeaveApproval(true)
                  }
                }}
              >
                Approve Leave
              </Button>
            </div>
            {approvedLeaves.length > 0 && (
              <div className="approved-leaves">
                <strong>Approved leave</strong>
                {approvedLeaves.map((date) => (
                  <span key={date}>
                    {date}
                    <button
                      className="text-button"
                      onClick={() => {
                        if (window.confirm(`Remove approved leave for ${date}?`)) {
                          setLeaveDate(date)
                          void studentApi
                            .setApprovedLeave(historyStudent.id, date, false)
                            .then(async () => {
                              await loadHistory(historyStudent)
                              await refreshSummaries()
                            })
                            .catch((leaveError) =>
                              setError(
                                leaveError instanceof Error
                                  ? leaveError.message
                                  : "Unable to remove approved leave.",
                              ),
                            )
                        }
                      }}
                    >
                      Remove
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="student-table-wrap">
              <table className="student-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry Time (IST)</th>
                    <th>Exit Time (IST)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length ? (
                    history.map((record) => (
                      <tr key={record.id}>
                        <td>{record.attendanceDate}</td>
                        <td>{formatIndiaTime(record.entryTime)}</td>
                        <td>{record.exitTime ? formatIndiaTime(record.exitTime) : "—"}</td>
                        <td>{record.status === "completed" ? "Completed" : "Present"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="student-empty">
                        No attendance records for this month.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

function AttendanceManagement() {
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([])
  const [dailyDashboard, setDailyDashboard] =
    useState<DailyAttendanceDashboard | null>(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState("")
  const [monthlySummaries, setMonthlySummaries] = useState<
    StudentMonthlySummary[]
  >([])
  const [monthlySummaryLoading, setMonthlySummaryLoading] = useState(true)
  const [monthlySummaryError, setMonthlySummaryError] = useState("")
  const [date, setDate] = useState(() => indiaDateInputValue())
  const [reportMonth, setReportMonth] = useState(() =>
    indiaDateInputValue().slice(0, 7),
  )
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] =
    useState<"all" | "present" | "completed">("all")
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const [reportError, setReportError] = useState("")
  const [exportingReport, setExportingReport] = useState<
    "daily" | "month-end" | null
  >(null)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const refreshSequence = useRef(0)
  const hasLoaded = useRef(false)
  const dashboardSequence = useRef(0)
  const monthlySummarySequence = useRef(0)

  const refreshAttendance = useCallback(
    async (showLoading = false) => {
      const requestSequence = ++refreshSequence.current
      if (!date) {
        setError("Choose a date to load attendance records.")
        setIsLoading(false)
        return
      }

      if (showLoading || !hasLoaded.current) setIsLoading(true)
      try {
        const result = await attendanceApi.list({ date, search })
        if (requestSequence === refreshSequence.current) {
          setAttendance(result.attendance)
          setError("")
        }
      } catch (loadError) {
        if (requestSequence === refreshSequence.current) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load attendance records.",
          )
        }
      } finally {
        if (requestSequence === refreshSequence.current) {
          hasLoaded.current = true
          setIsLoading(false)
        }
      }
    },
    [date, search],
  )

  useEffect(() => {
    void refreshAttendance(true)
  }, [refreshAttendance])

  const refreshDailyDashboard = useCallback(async () => {
    const requestSequence = ++dashboardSequence.current
    if (!date) {
      setDailyDashboard(null)
      setDashboardError("Choose a date to load daily attendance.")
      setDashboardLoading(false)
      return
    }

    setDailyDashboard(null)
    setDashboardLoading(true)
    setDashboardError("")
    try {
      const result = await attendanceApi.dashboard(date)
      if (requestSequence === dashboardSequence.current) {
        setDailyDashboard(result)
      }
    } catch (loadError) {
      if (requestSequence === dashboardSequence.current) {
        setDailyDashboard(null)
        setDashboardError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load daily attendance lists.",
        )
      }
    } finally {
      if (requestSequence === dashboardSequence.current) {
        setDashboardLoading(false)
      }
    }
  }, [date])

  useEffect(() => {
    void refreshDailyDashboard()
  }, [refreshDailyDashboard])

  useEffect(() => {
    const requestSequence = ++monthlySummarySequence.current
    if (!reportMonth) {
      setMonthlySummaries([])
      setMonthlySummaryError("Choose a month to load attendance totals.")
      setMonthlySummaryLoading(false)
      return
    }

    setMonthlySummaryLoading(true)
    setMonthlySummaryError("")
    void studentApi
      .monthlySummary(reportMonth)
      .then(({ summaries }) => {
        if (requestSequence === monthlySummarySequence.current) {
          setMonthlySummaries(summaries)
        }
      })
      .catch((loadError) => {
        if (requestSequence === monthlySummarySequence.current) {
          setMonthlySummaries([])
          setMonthlySummaryError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load monthly attendance totals.",
          )
        }
      })
      .finally(() => {
        if (requestSequence === monthlySummarySequence.current) {
          setMonthlySummaryLoading(false)
        }
      })
  }, [reportMonth])

  useEffect(() => {
    const interval = window.setInterval(() => void refreshAttendance(), 3000)
    const refreshOnFocus = () => void refreshAttendance()
    window.addEventListener("focus", refreshOnFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshOnFocus)
    }
  }, [refreshAttendance])

  const filteredAttendance = attendance.filter(
    (record) => statusFilter === "all" || record.status === statusFilter,
  )
  const overallMonthlyCounts = overallAttendanceCounts(monthlySummaries)

  const markExit = async (record: AttendanceRecord) => {
    setProcessingId(record.id)
    setError("")
    try {
      await attendanceApi.markExit(record.id)
      await refreshAttendance(true)
    } catch (exitError) {
      setError(
        exitError instanceof Error
          ? exitError.message
          : "Unable to mark this attendance as exited.",
      )
    } finally {
      setProcessingId(null)
    }
  }

  const downloadReport = async (kind: "daily" | "month-end") => {
    setExportingReport(kind)
    setReportError("")
    try {
      const workbook =
        kind === "daily"
          ? await reportApi.dailyAttendance(date)
          : await reportApi.monthEndAttendance(reportMonth)
      const filename =
        kind === "daily"
          ? `CSC_Daily_Attendance_${date}.xlsx`
          : `CSC_Monthly_Attendance_${reportMonth}.xlsx`
      const objectUrl = URL.createObjectURL(workbook)
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (exportError) {
      setReportError(
        exportError instanceof Error
          ? exportError.message
          : "Unable to download the attendance report.",
      )
    } finally {
      setExportingReport(null)
    }
  }

  return (
    <section className="attendance-management">
      <div className="management-toolbar">
        <div>
          <h2>Attendance records</h2>
          <p>
            Student entries for the selected date. Times are shown in India
            Standard Time.
          </p>
        </div>
        <div className="attendance-report-actions">
          <label className="student-filter">
            <span>Date</span>
            <input
              className="attendance-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-label="Date for daily attendance lists"
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => void downloadReport("daily")}
            disabled={!date || exportingReport !== null}
          >
            {exportingReport === "daily"
              ? "Preparing daily Excel..."
              : "Download Daily Excel"}
          </Button>
          <label className="student-filter">
            <span>Report month</span>
            <input
              type="month"
              value={reportMonth}
              onChange={(event) => setReportMonth(event.target.value)}
              aria-label="Month for attendance Excel report"
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => void downloadReport("month-end")}
            disabled={!reportMonth || exportingReport !== null}
          >
            {exportingReport === "month-end"
              ? "Preparing monthly Excel..."
              : "Download Monthly Excel"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void refreshAttendance(true)
              void refreshDailyDashboard()
            }}
            disabled={isLoading || dashboardLoading}
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {reportError && (
        <p className="management-error" role="alert">
          {reportError}
        </p>
      )}

      {error && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}

      {dashboardError && (
        <p className="management-error" role="alert">
          {dashboardError}
        </p>
      )}

      <section className="attendance-insights" aria-label="Attendance overview">
        <div className="attendance-summary-cards">
          <article className="attendance-summary-card">
            <span>Active students</span>
            <strong>
              {dashboardLoading ? "…" : dailyDashboard?.totalActiveStudents ?? "—"}
            </strong>
          </article>
          <article className="attendance-summary-card">
            <span>Present · {date}</span>
            <strong>
              {dashboardLoading ? "…" : dailyDashboard?.presentStudents.length ?? "—"}
            </strong>
          </article>
          <article className="attendance-summary-card">
            <span>Absent · {date}</span>
            <strong>
              {dashboardLoading ? "…" : dailyDashboard?.absentStudents.length ?? "—"}
            </strong>
          </article>
          <article
            className={`attendance-summary-card ${
              dailyDashboard?.isFullDayClassClosure ? "is-closed" : ""
            }`}
          >
            <span>Class status · {date}</span>
            <strong>
              {dashboardLoading
                ? "…"
                : dashboardError
                  ? "Unavailable"
                  : dailyDashboard?.isFullDayClassClosure
                  ? "Full-day leave"
                  : "Open"}
            </strong>
            {dailyDashboard?.isFullDayClassClosure && (
              <small>
                {dailyDashboard.closureTitle ?? "Class Closed — Full Day"}
              </small>
            )}
          </article>
        </div>

        <section className="monthly-attendance-panel">
          <div className="attendance-panel-heading">
            <div>
              <h3>Monthly attendance</h3>
              <p>
                Eligible student-days for {reportMonth}; one count per student
                per day.
              </p>
            </div>
          </div>
          {monthlySummaryError ? (
            <p className="management-error" role="alert">
              {monthlySummaryError}
            </p>
          ) : monthlySummaryLoading ? (
            <p className="attendance-loading" role="status">
              Loading monthly attendance…
            </p>
          ) : (
            <AttendancePieChart
              presentDays={overallMonthlyCounts.presentDays}
              absentDays={overallMonthlyCounts.absentDays}
              label={`Overall attendance for ${reportMonth}`}
            />
          )}
        </section>

        <div className="daily-student-lists">
          <section className="student-list-panel daily-student-panel">
            <div className="attendance-panel-heading">
              <div>
                <h3>Present Today</h3>
                <p>Checked in on {date}; check-out is not required.</p>
              </div>
              <strong>{dashboardLoading ? "…" : dailyDashboard?.presentStudents.length ?? "—"}</strong>
            </div>
            <div className="student-table-wrap">
              <table className="student-table daily-attendance-list">
                <thead>
                  <tr>
                    <th>Register No.</th>
                    <th>Student Name</th>
                    <th>Course</th>
                    <th>Entry Time</th>
                    <th>Exit Time</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardLoading ? (
                    <tr><td colSpan={6} className="student-empty">Loading present students…</td></tr>
                  ) : dashboardError ? (
                    <tr><td colSpan={6} className="student-empty">Present students could not be loaded.</td></tr>
                  ) : dailyDashboard?.presentStudents.length ? (
                    dailyDashboard.presentStudents.map((student) => (
                      <tr key={student.registerNumber}>
                        <td><strong>{student.registerNumber}</strong></td>
                        <td>{student.name}</td>
                        <td>{student.course || "—"}</td>
                        <td>{student.entryTime ? formatIndiaTime(student.entryTime) : "—"}</td>
                        <td>{student.exitTime ? formatIndiaTime(student.exitTime) : "Not checked out"}</td>
                        <td><span className="attendance-status attendance-present">{student.status}</span></td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={6} className="student-empty">No students are present for this date.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="student-list-panel daily-student-panel">
            <div className="attendance-panel-heading">
              <div>
                <h3>Absent Today</h3>
                <p>Expected active students without a check-in on {date}.</p>
              </div>
              <strong>{dashboardLoading ? "…" : dailyDashboard?.absentStudents.length ?? "—"}</strong>
            </div>
            <div className="student-table-wrap">
              <table className="student-table daily-attendance-list">
                <thead>
                  <tr>
                    <th>Register No.</th>
                    <th>Student Name</th>
                    <th>Course</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardLoading ? (
                    <tr><td colSpan={4} className="student-empty">Loading absent students…</td></tr>
                  ) : dashboardError ? (
                    <tr><td colSpan={4} className="student-empty">Absent students could not be loaded.</td></tr>
                  ) : dailyDashboard?.absentStudents.length ? (
                    dailyDashboard.absentStudents.map((student) => (
                      <tr key={student.registerNumber}>
                        <td><strong>{student.registerNumber}</strong></td>
                        <td>{student.name}</td>
                        <td>{student.course || "—"}</td>
                        <td><span className="attendance-status attendance-absent">{student.status}</span></td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="student-empty">
                        {dailyDashboard?.isFullDayClassClosure
                          ? "No absences are counted because the class is closed for the full day."
                          : dailyDashboard?.isEligibleWorkingDay
                            ? "No absent students for this date."
                            : "This date is not an eligible past working day."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>

      <div className="student-list-panel">
        <div className="student-list-toolbar attendance-toolbar">
          <label className="student-search">
            <Icon name="search" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or register number"
              aria-label="Search attendance"
            />
          </label>
          <label className="student-filter">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="all">All statuses</option>
              <option value="present">Present</option>
              <option value="completed">Completed</option>
            </select>
          </label>
        </div>
        <div className="student-table-wrap">
          <table className="student-table attendance-table">
            <thead>
              <tr>
                <th>Register Number</th>
                <th>Student</th>
                <th>Date</th>
                <th>Entry Time (IST)</th>
                <th>Exit Time (IST)</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="student-empty">
                    Loading attendance...
                  </td>
                </tr>
              ) : filteredAttendance.length === 0 ? (
                <tr>
                  <td colSpan={7} className="student-empty">
                    No attendance records match this date and filter.
                  </td>
                </tr>
              ) : (
                filteredAttendance.map((record) => (
                  <tr key={record.id}>
                    <td data-label="Register Number">
                      <strong>{record.register_number}</strong>
                    </td>
                    <td data-label="Student">{record.name}</td>
                    <td data-label="Date">
                      {formatIndiaDate(record.attendance_date)}
                    </td>
                    <td data-label="Entry Time">
                      {formatIndiaTime(record.entry_time)}
                    </td>
                    <td data-label="Exit Time">
                      {record.exit_time
                        ? formatIndiaTime(record.exit_time)
                        : "—"}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`attendance-status attendance-${record.status}`}
                      >
                        {record.status === "present" ? "Present" : "Completed"}
                      </span>
                    </td>
                    <td data-label="Action">
                      {record.status === "present" ? (
                        <Button
                          variant="secondary"
                          disabled={processingId === record.id}
                          onClick={() => void markExit(record)}
                        >
                          {processingId === record.id
                            ? "Saving..."
                            : "Mark Exit"}
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function ExitRequestsManagement({ onApproved }: { onApproved: () => void }) {
  const [requests, setRequests] = useState<ExitRequest[]>([])
  const [statusFilter, setStatusFilter] =
    useState<"all" | ExitRequest["status"]>("all")
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [error, setError] = useState("")

  const refreshRequests = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await attendanceApi.exitRequests()
      setRequests(result.requests)
      setError("")
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load exit requests.",
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshRequests()
  }, [refreshRequests])

  const processRequest = async (
    request: ExitRequest,
    action: "approve" | "reject",
  ) => {
    setProcessingId(request.id)
    setError("")
    try {
      await attendanceApi.processExitRequest(request.id, action)
      await refreshRequests()
      if (action === "approve") onApproved()
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to process this exit request.",
      )
    } finally {
      setProcessingId(null)
    }
  }

  const visibleRequests = requests.filter(
    (request) => statusFilter === "all" || request.status === statusFilter,
  )

  return (
    <section className="attendance-management">
      <div className="management-toolbar">
        <div>
          <h2>Student exit requests</h2>
          <p>
            Review student requests. Approval records the exit time; rejection
            leaves attendance active.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refreshRequests()}
          disabled={isLoading}
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </div>
      {error && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}
      <div className="student-list-panel">
        <div className="student-list-toolbar">
          <label className="student-filter">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="all">All requests</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
        <div className="student-table-wrap">
          <table className="student-table exit-request-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Register Number</th>
                <th>Requested (IST)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="student-empty">
                    Loading exit requests...
                  </td>
                </tr>
              ) : visibleRequests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="student-empty">
                    No exit requests match this filter.
                  </td>
                </tr>
              ) : (
                visibleRequests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Student">{request.name}</td>
                    <td data-label="Register Number">
                      <strong>{request.register_number}</strong>
                    </td>
                    <td data-label="Requested (IST)">
                      {formatIndiaDate(request.requested_at)}{" "}
                      {formatIndiaTime(request.requested_at)}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`attendance-status request-${request.status}`}
                      >
                        {request.status}
                      </span>
                    </td>
                    <td data-label="Actions">
                      {request.status === "pending" ? (
                        <div className="student-actions">
                          <button
                            className="student-action"
                            disabled={processingId === request.id}
                            onClick={() =>
                              void processRequest(request, "approve")
                            }
                          >
                            {processingId === request.id
                              ? "Saving..."
                              : "Approve"}
                          </button>
                          <button
                            className="student-action deactivate-action"
                            disabled={processingId === request.id}
                            onClick={() =>
                              void processRequest(request, "reject")
                            }
                          >
                            Reject
                          </button>
                        </div>
                      ) : request.processed_at ? (
                        `${
                          request.status === "approved"
                            ? "Processed"
                            : "Rejected"
                        } ${formatIndiaDate(request.processed_at)} ${formatIndiaTime(request.processed_at)}`
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function SecondCheckInRequestsManagement() {
  const [requests, setRequests] = useState<SecondCheckInRequest[]>([])
  const [statusFilter, setStatusFilter] = useState<
    "all" | SecondCheckInRequest["status"]
  >("pending")
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [error, setError] = useState("")

  const refreshRequests = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await attendanceApi.secondCheckInRequests()
      setRequests(result.requests)
      setError("")
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load second login requests.",
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshRequests()
  }, [refreshRequests])

  const processRequest = async (
    request: SecondCheckInRequest,
    action: "approve" | "reject",
  ) => {
    setProcessingId(request.id)
    setError("")
    try {
      await attendanceApi.processSecondCheckInRequest(request.id, action)
      await refreshRequests()
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to process this second login request.",
      )
    } finally {
      setProcessingId(null)
    }
  }

  const visibleRequests = requests.filter(
    (request) => statusFilter === "all" || request.status === statusFilter,
  )

  return (
    <section className="attendance-management">
      <div className="management-toolbar">
        <div>
          <h2>Second Login Requests</h2>
          <p>
            Approve or reject a student's second login for the local attendance
            day. The first check-in time is preserved.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refreshRequests()}
          disabled={isLoading}
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </div>
      {error && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}
      <div className="student-list-panel">
        <div className="student-list-toolbar">
          <label className="student-filter">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="completed">Completed</option>
              <option value="all">All requests</option>
            </select>
          </label>
        </div>
        <div className="student-table-wrap">
          <table className="student-table exit-request-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Register Number</th>
                <th>Requested (IST)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="student-empty">
                    Loading second login requests...
                  </td>
                </tr>
              ) : visibleRequests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="student-empty">
                    No second login requests match this filter.
                  </td>
                </tr>
              ) : (
                visibleRequests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Student">{request.name}</td>
                    <td data-label="Register Number">
                      <strong>{request.register_number}</strong>
                    </td>
                    <td data-label="Requested (IST)">
                      {formatIndiaDate(request.requested_at)}{" "}
                      {formatIndiaTime(request.requested_at)}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`attendance-status request-${request.status}`}
                      >
                        {request.status}
                      </span>
                    </td>
                    <td data-label="Actions">
                      {request.status === "pending" ? (
                        <div className="student-actions">
                          <button
                            className="student-action"
                            disabled={processingId === request.id}
                            onClick={() =>
                              void processRequest(request, "approve")
                            }
                          >
                            {processingId === request.id
                              ? "Saving..."
                              : "Approve"}
                          </button>
                          <button
                            className="student-action deactivate-action"
                            disabled={processingId === request.id}
                            onClick={() =>
                              void processRequest(request, "reject")
                            }
                          >
                            Reject
                          </button>
                        </div>
                      ) : request.processed_at ? (
                        `${request.status === "completed" ? "Approved" : request.status === "approved" ? "Approved" : "Rejected"} ${formatIndiaDate(request.processed_at)} ${formatIndiaTime(request.processed_at)}`
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function leaveDuration(start: string, end: string) {
  if (!start || !end || end <= start) return ""
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number)
    return hours * 60 + minutes
  }
  const duration = toMinutes(end) - toMinutes(start)
  const hours = Math.floor(duration / 60)
  const minutes = duration % 60
  return [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" ")
}

function leaveDateLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`))
}

function LeaveCalendarManagement() {
  const [month, setMonth] = useState(indiaDateInputValue().slice(0, 7))
  const [leaves, setLeaves] = useState<AdminLeave[]>([])
  const [historicalEvents, setHistoricalEvents] = useState<CalendarEvent[]>([])
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [form, setForm] = useState<LeaveForm>({
    scope: "staff",
    leaveType: "full_day",
    reason: "",
    startTime: "",
    endTime: "",
  })
  const [selectedDate, setSelectedDate] = useState("")
  const [editingLeave, setEditingLeave] = useState<AdminLeave | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [error, setError] = useState("")

  const refresh = async () => {
    try {
      const [leaveResult, eventResult, schedule] = await Promise.all([
        calendarApi.listLeaves(month),
        calendarApi.list(month),
        calendarApi.workingDays(),
      ])
      setLeaves(leaveResult.leaves)
      setHistoricalEvents(
        eventResult.events.filter((event) => !event.leaveScope),
      )
      setWorkingDays(schedule.workingDays)
      setError("")
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load leave records.")
    }
  }

  const saveWorkingDays = async () => {
    if (!window.confirm("Save this class-working week? Monthly absence totals will use this schedule.")) return
    try {
      const result = await calendarApi.setWorkingDays(workingDays)
      setWorkingDays(result.workingDays)
      setError("")
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the class-working calendar.")
    }
  }

  useEffect(() => {
    void refresh()
  }, [month])

  const openForDate = (date: string, leave?: AdminLeave) => {
    const draft = openLeaveDialog(date, leave)
    setSelectedDate(draft.selectedDate)
    setEditingLeave(draft.editingLeave)
    setForm(draft.form)
    setError("")
    setIsOpen(draft.isOpen)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError("")
    setIsSaving(true)
    try {
      const input: AdminLeaveInput = {
        date: selectedDate,
        scope: form.scope,
        leaveType: form.leaveType,
        reason: form.reason.trim(),
        startTime: form.leaveType === "partial_time" ? form.startTime : null,
        endTime: form.leaveType === "partial_time" ? form.endTime : null,
      }
      if (editingLeave) await calendarApi.updateLeave(editingLeave.id, input)
      else await calendarApi.createLeave(input)
      setIsOpen(false)
      setEditingLeave(null)
      await refresh()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this leave.")
    } finally {
      setIsSaving(false)
    }
  }

  const removeLeave = async (leave: AdminLeave) => {
    if (!window.confirm(`Remove the leave record for ${leaveDateLabel(leave.startDate)}?`))
      return
    setRemovingId(leave.id)
    setError("")
    try {
      await calendarApi.removeLeave(leave.id)
      if (editingLeave?.id === leave.id) setIsOpen(false)
      await refresh()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove this leave.")
    } finally {
      setRemovingId(null)
    }
  }

  const daysInMonth = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate()
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay()
  const days = Array.from({ length: firstWeekday + daysInMonth }, (_, index) =>
    index < firstWeekday ? null : index - firstWeekday + 1,
  )
  const getDayLeaves = (day: number) => {
    const date = `${month}-${String(day).padStart(2, "0")}`
    return leaves.filter((item) => item.startDate === date)
  }
  const getDayEvents = (day: number) => {
    const date = `${month}-${String(day).padStart(2, "0")}`
    return historicalEvents.filter(
      (item) => item.startDate <= date && item.endDate >= date,
    )
  }

  return (
    <section className="calendar-management">
      <div className="management-toolbar">
        <div>
          <h2>Leave Calendar</h2>
          <p>Choose a date to record Staff/Admin leave or a class closure. Staff leave never changes student attendance.</p>
        </div>
      </div>
      {error && <p className="management-error" role="alert">{error}</p>}
      {isOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setIsOpen(false)
        }}>
          <form
            className="history-dialog leave-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-dialog-title"
            onSubmit={save}
          >
            <div className="student-form-heading">
              <div>
                <h3 id="leave-dialog-title">{editingLeave ? "Edit Leave" : "Record Leave"}</h3>
                <p className="leave-selected-date">{leaveDateLabel(selectedDate)}</p>
              </div>
              <button type="button" className="text-button" onClick={() => setIsOpen(false)}>Cancel</button>
            </div>
            {error && <p className="management-error" role="alert">{error}</p>}
            <div className="student-form-grid">
              <label className="field">
                <span>Leave Scope</span>
                <select value={form.scope} onChange={(event) => setForm({
                  ...form,
                  scope: event.target.value as AdminLeaveInput["scope"],
                })}>
                  <option value="staff">Staff/Admin Leave</option>
                  <option value="class_closed">Class Closed</option>
                </select>
              </label>
              <label className="field">
                <span>Leave Type</span>
                <select value={form.leaveType} onChange={(event) => setForm({
                  ...form,
                  leaveType: event.target.value as AdminLeaveInput["leaveType"],
                  startTime: "",
                  endTime: "",
                })}>
                  <option value="full_day">Full-Day Leave</option>
                  <option value="partial_time">Partial/Time-Based Leave</option>
                </select>
              </label>
              {form.leaveType === "partial_time" && (
                <>
                  <label className="field">
                    <span>Start Time</span>
                    <input required type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>End Time</span>
                    <input required type="time" min={form.startTime || undefined} value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} />
                  </label>
                  {form.startTime && form.endTime && form.endTime > form.startTime && (
                    <p className="leave-duration">Duration: {leaveDuration(form.startTime, form.endTime)}</p>
                  )}
                </>
              )}
              <label className="field event-description">
                <span>Reason (optional)</span>
                <textarea rows={3} maxLength={1000} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
              </label>
            </div>
            <p className="leave-scope-note">
              {form.scope === "staff"
                ? "Staff/Admin leave is recorded separately and does not change student attendance."
                : form.leaveType === "full_day"
                  ? "A full-day class closure is marked LEAVE and excluded from student absence calculations. Existing attendance remains unchanged."
                  : "Partial class closure details are reported separately and do not change student attendance."}
            </p>
            <div className="student-form-actions leave-form-actions">
              {editingLeave && (
                <Button
                  type="button"
                  variant="danger"
                  disabled={isSaving || removingId === editingLeave.id}
                  onClick={() => void removeLeave(editingLeave)}
                >
                  {removingId === editingLeave.id ? "Removing..." : "Remove Leave"}
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => setIsOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Leave"}
              </Button>
            </div>
          </form>
        </div>
      )}
      <div className="calendar-toolbar">
        <label className="student-filter">
          <span>Calendar month</span>
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
      </div>
      <section className="working-week">
        <div>
          <h3>Class-working week</h3>
          <p>Monthly absences include only selected weekdays, excluding full-day closures and approved student leave.</p>
        </div>
        <div className="weekday-options">
          {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={workingDays.includes(index)}
                onChange={(event) => setWorkingDays(
                  event.target.checked
                    ? [...workingDays, index].sort((a, b) => a - b)
                    : workingDays.filter((item) => item !== index),
                )}
              />
              {day}
            </label>
          ))}
          <Button variant="secondary" onClick={() => void saveWorkingDays()}>Save working week</Button>
        </div>
      </section>
      <div className="event-calendar leave-calendar" aria-label={`Calendar for ${month}`}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <strong key={day}>{day}</strong>)}
        {days.map((day, index) => {
          const date = calendarDateForCell(month, day)
          const dayLeaves = day ? getDayLeaves(day) : []
          const dayEvents = day ? getDayEvents(day) : []
          return (
          <button
            type="button"
            className={`event-calendar-day leave-calendar-day ${day ? "" : "empty"}`}
            key={`${month}-${index}`}
            disabled={!day}
            aria-label={day ? `${leaveDateLabel(date)}${dayLeaves.length ? `, ${dayLeaves.length} leave records` : ""}` : undefined}
            onClick={() => day && openForDate(date, dayLeaves[0])}
          >
            {day && (
              <>
                <span>{day}</span>
                {dayLeaves.map((item) => (
                  <small key={`leave-${item.id}`} className="leave-calendar-badge" title={`${item.leaveScope === "staff" ? "Staff/Admin leave" : "Class closed"}${item.fullDay ? "" : ` ${item.startTime?.slice(0, 5)}–${item.endTime?.slice(0, 5)}`}`}>
                    LEAVE{!item.fullDay && ` · ${item.startTime?.slice(0, 5)}–${item.endTime?.slice(0, 5)}`}
                  </small>
                ))}
                {dayEvents.map((item) => (
                  <small key={`legacy-${item.id}`} className={item.affectsAttendance ? "closure legacy-calendar-badge" : "legacy-calendar-badge"} title={item.title}>
                    {item.title}{!item.fullDay && ` · ${item.startTime?.slice(0, 5)}–${item.endTime?.slice(0, 5)}`}
                  </small>
                ))}
              </>
            )}
          </button>
        )})}
      </div>
      <div className="event-upcoming leave-details">
        <h3>Leave details this month</h3>
        {leaves.length ? leaves.map((item) => (
          <article className="event-card" key={item.id}>
            <div>
              <strong>{item.leaveScope === "staff" ? "Staff/Admin Leave" : "Class Closed"}</strong>
              <span>{leaveDateLabel(item.startDate)} · {item.fullDay ? "Full day" : `${item.startTime?.slice(0, 5)}–${item.endTime?.slice(0, 5)} (${leaveDuration(item.startTime?.slice(0, 5) ?? "", item.endTime?.slice(0, 5) ?? "")})`}</span>
              <span>{item.createdByUsername ? `Recorded by ${item.createdByUsername}` : "Admin recorded"}</span>
              {item.description && <p>{item.description}</p>}
            </div>
            <div className="student-actions">
              <button className="student-action" onClick={() => openForDate(item.startDate, item)}>Edit</button>
              <button className="student-action deactivate-action" disabled={removingId === item.id} onClick={() => void removeLeave(item)}>
                {removingId === item.id ? "Removing..." : "Remove"}
              </button>
            </div>
          </article>
        )) : <p className="student-empty">No leave recorded for this month. Select a date to add a leave record.</p>}
      </div>
      {historicalEvents.length > 0 && (
        <details className="legacy-events">
          <summary>Previously recorded holidays and events</summary>
          <p>These historical records are retained and are not changed by the Leave Calendar.</p>
          {historicalEvents.map((item) => (
            <article className="event-card" key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.startDate === item.endDate ? item.startDate : `${item.startDate} – ${item.endDate}`} · {item.fullDay ? "Full day" : `${item.startTime?.slice(0, 5)}–${item.endTime?.slice(0, 5)}`}</span>
                {item.description && <p>{item.description}</p>}
              </div>
            </article>
          ))}
        </details>
      )}
    </section>
  )
}

function AdminDashboard({
  promotions,
  setPromotions,
  onLogout,
}: {
  promotions: PromotionRecord[]
  setPromotions: (promotions: PromotionRecord[]) => void
  onLogout: () => Promise<void>
}) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [replaceId, setReplaceId] = useState<number | null>(null)
  const [activeSection, setActiveSection] = useState<AdminSection>("attendance")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [logoutError, setLogoutError] = useState("")
  const [promotionError, setPromotionError] = useState("")
  const [isPromotionUploading, setIsPromotionUploading] = useState(false)

  useEffect(() => {
    promotionApi
      .list()
      .then(({ promotions: items }) => setPromotions(items))
      .catch((loadError) =>
        setPromotionError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load promotional images.",
        ),
      )
  }, [])

  const logout = async () => {
    setLogoutError("")
    try {
      await onLogout()
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "Unable to sign out.",
      )
    }
  }

  const addFiles = async (files: FileList | null, targetId?: number) => {
    const file = files?.[0]
    if (!file || isPromotionUploading) return
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPromotionError("Choose a JPEG, PNG, or WebP image.")
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setPromotionError("Images must be 8 MB or smaller.")
      return
    }
    setPromotionError("")
    setIsPromotionUploading(true)
    try {
      if (targetId) {
        const result = await promotionApi.replace(targetId, file)
        setPromotions(promotions.map((item) =>
          item.id === targetId ? result.promotion : item,
        ))
      } else {
        const result = await promotionApi.upload(file, file.name)
        setPromotions([...promotions, result.promotion])
      }
    } catch (uploadError) {
      setPromotionError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to save this promotional image.",
      )
    } finally {
      setIsPromotionUploading(false)
      if (uploadRef.current) uploadRef.current.value = ""
      if (replaceRef.current) replaceRef.current.value = ""
    }
  }

  const move = async (index: number, direction: -1 | 1) => {
    const destination = index + direction
    if (destination < 0 || destination >= promotions.length) return
    const updated = [...promotions]
    ;[updated[index], updated[destination]] = [
      updated[destination],
      updated[index],
    ]
    try {
      const result = await promotionApi.order(updated.map((item) => item.id))
      setPromotions(result.promotions)
      setPromotionError("")
    } catch (orderError) {
      setPromotionError(
        orderError instanceof Error ? orderError.message : "Unable to reorder images.",
      )
    }
  }

  return (
    <div className={`dashboard ${mobileNavOpen ? "nav-open" : ""}`}>
      <aside className="sidebar">
        <Brand light />
        <nav aria-label="Admin navigation">
          <button
            className={activeSection === "attendance" ? "active" : ""}
            onClick={() => {
              setActiveSection("attendance")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="clock" />
            </span>
            Attendance
          </button>
          <button
            className={activeSection === "exit-requests" ? "active" : ""}
            onClick={() => {
              setActiveSection("exit-requests")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="shield" />
            </span>
            Exit Requests
          </button>
          <button
            className={
              activeSection === "second-check-in-requests" ? "active" : ""
            }
            onClick={() => {
              setActiveSection("second-check-in-requests")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="shield" />
            </span>
            Second Login Requests
          </button>
          <button
            className={activeSection === "students" ? "active" : ""}
            onClick={() => {
              setActiveSection("students")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="students" />
            </span>
            Student Management
          </button>
          <button
            className={activeSection === "promotions" ? "active" : ""}
            onClick={() => {
              setActiveSection("promotions")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="image" />
            </span>
            Login Promotions
          </button>
          <button
            className={activeSection === "calendar" ? "active" : ""}
            onClick={() => {
              setActiveSection("calendar")
              setMobileNavOpen(false)
            }}
          >
            <span>
              <Icon name="clock" />
            </span>
            Leave Calendar
          </button>
        </nav>
        <div className="sidebar-profile">
          <div className="avatar">
            <picture>
              <source
                type="image/webp"
                srcSet="/assets/csc-icon-128.webp?v=20261018-1 128w, /assets/csc-icon-256.webp?v=20261018-1 256w"
                sizes="68px"
              />
              <img
                src="/assets/csc-icon.png?v=20261016-3"
                width="512"
                height="512"
                alt="CSC Computer Software College logo"
              />
            </picture>
          </div>
          <div>
            <strong>Admin Kumar</strong>
            <span>Administrator</span>
          </div>
          <button className="sidebar-signout" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-header">
          <button
            className="mobile-menu"
            aria-label="Toggle menu"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
          >
            <Icon name="menu" />
          </button>
          <div>
            <p className="section-label">Admin Dashboard</p>
            <h1>
              {activeSection === "attendance"
                ? "Attendance"
                : activeSection === "exit-requests"
                  ? "Exit Requests"
                  : activeSection === "second-check-in-requests"
                    ? "Second Login Requests"
                  : activeSection === "students"
                    ? "Student Management"
                      : activeSection === "calendar"
                        ? "Leave Calendar"
                        : "Login Page Promotions"}
            </h1>
          </div>
          {activeSection === "promotions" && (
            <Button
              onClick={() => uploadRef.current?.click()}
              disabled={
                isPromotionUploading ||
                promotions.filter((item) => item.enabled).length >= 5
              }
            >
              <Icon name="upload" />
              {isPromotionUploading ? "Uploading..." : "Upload image"}
            </Button>
          )}
          <input
            ref={uploadRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => addFiles(event.target.files)}
          />
        </header>
        {logoutError && (
          <p className="management-error" role="alert">
            {logoutError}
          </p>
        )}
        {activeSection === "promotions" && promotionError && (
          <p className="management-error" role="alert">{promotionError}</p>
        )}
        {activeSection === "attendance" ? (
          <AttendanceManagement />
        ) : activeSection === "exit-requests" ? (
          <ExitRequestsManagement
            onApproved={() => setActiveSection("attendance")}
          />
        ) : activeSection === "second-check-in-requests" ? (
          <SecondCheckInRequestsManagement />
        ) : activeSection === "students" ? (
          <StudentManagement />
        ) : activeSection === "calendar" ? (
          <LeaveCalendarManagement />
        ) : (
          <>
            <section className="dashboard-intro">
              <div>
                <h2>Student login visuals</h2>
                <p>
                  Choose up to five images shown on the student attendance page.
                  Drag order is reflected in the carousel.
                </p>
              </div>
              <span>
                {promotions.filter((item) => item.enabled).length} / 5 active
              </span>
            </section>
            {isPromotionUploading && (
              <p role="status" aria-live="polite">
                Uploading image securely...
              </p>
            )}
            <div className="promotion-list">
              {promotions.map((promotion, index) => (
                <article className="promotion-row" key={promotion.id}>
                  <div className="drag-index">
                    <button
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <button
                      onClick={() => move(index, 1)}
                      disabled={index === promotions.length - 1}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                  </div>
                  <img
                    src={cloudinaryDeliveryUrl(promotion.source, 400)}
                    width="400"
                    height="300"
                    loading="lazy"
                    decoding="async"
                    alt={`Promotion: ${promotion.title}`}
                  />
                  <div className="promotion-info">
                    <div>
                      <strong>Image {index + 1}</strong>
                      <span>{promotion.title}</span>
                    </div>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={promotion.enabled}
                        disabled={isPromotionUploading}
                        onChange={() =>
                          void promotionApi
                            .setEnabled(promotion.id, !promotion.enabled)
                              .then(({ promotion: updated }) => {
                                setPromotions(promotions.map((item) =>
                                  item.id === updated.id ? updated : item,
                                ))
                                setPromotionError("")
                            })
                            .catch((toggleError) =>
                              setPromotionError(
                                toggleError instanceof Error
                                  ? toggleError.message
                                  : "Unable to update image status.",
                              ),
                            )
                        }
                      />
                      <span />
                      {promotion.enabled ? "Enabled" : "Disabled"}
                    </label>
                  </div>
                  <div className="row-actions">
                    <Button
                      variant="secondary"
                      disabled={isPromotionUploading}
                      onClick={() => window.open(promotion.source, "_blank")}
                    >
                      <Icon name="image" />
                      Preview
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={isPromotionUploading}
                      onClick={() => {
                        setReplaceId(promotion.id)
                        replaceRef.current?.click()
                      }}
                    >
                      <Icon name="replace" />
                      Replace
                    </Button>
                    <Button
                      variant="danger"
                      disabled={isPromotionUploading}
                      onClick={() => {
                        if (!window.confirm("Remove this promotional image?")) return
                        void promotionApi
                          .remove(promotion.id)
                          .then(() => {
                            setPromotions(promotions.filter((item) => item.id !== promotion.id))
                            setPromotionError("")
                          })
                          .catch((deleteError) =>
                            setPromotionError(
                              deleteError instanceof Error
                                ? deleteError.message
                                : "Unable to remove this image.",
                            ),
                          )
                      }}
                    >
                      <Icon name="trash" />
                      Delete
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            <input
              ref={replaceRef}
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                if (replaceId) addFiles(event.target.files, replaceId)
              }}
            />
            <div className="dashboard-tip">
              <Icon name="shield" />
              <p>
                <strong>Changes appear automatically</strong>
                <span>
                  Enabled promotions rotate on the student login page. The first
                  image is shown by default.
                </span>
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export default AdminDashboard
