import { lazy, Suspense, useEffect, useState } from "react"
import type { FormEvent } from "react"
import { adminApi, ApiError, attendanceApi, promotionApi } from "./api"
import type { PromotionRecord } from "./api"
import { formatIndiaDate, formatIndiaTime } from "./india-time.js"
import { cloudinaryDeliveryUrl } from "./image-url"
import { Brand, Button, Icon, TextField } from "./ui"

type AttendanceState =
  | "default"
  | "loading"
  | "invalid"
  | "success"
  | "active"
  | "completed"
  | "checked-out"
  | "leave"
  | "inactive"
  | "error"
  | "second-check-in-pending"
  | "second-check-in-approved"
  | "second-check-in-rejected"
type AppView = "student" | "admin-login" | "admin-dashboard"
type Promotion = PromotionRecord

const AdminDashboard = lazy(() => import("./AdminDashboard"))
function ViewSwitch({
  view,
  setView,
}: {
  view: AppView
  setView: (view: AppView) => void
}) {
  return (
    <nav
      className="view-switch"
      aria-label="Portal navigation"
    >
      <button
        className={view === "student" ? "active" : ""}
        onClick={() => setView("student")}
      >
        Student
      </button>
      <button
        className={view !== "student" ? "active" : ""}
        onClick={() => setView("admin-login")}
      >
        Admin
      </button>
    </nav>
  )
}

function PromotionPanel({
  promotions,
  activeIndex,
}: {
  promotions: Promotion[]
  activeIndex: number
}) {
  const activePromotions = promotions.filter((promotion) => promotion.enabled)
  const current =
    activePromotions[activeIndex % Math.max(activePromotions.length, 1)]
  const imageSource = current
    ? cloudinaryDeliveryUrl(current.source, 1600)
    : undefined
  const imageSourceSet =
    current && imageSource !== current.source
      ? `${imageSource} 1600w, ${cloudinaryDeliveryUrl(current.source, 2400)} 2400w`
      : undefined

  return (
    <section className="promo-panel" aria-hidden="true">
      {imageSource && (
        <img
          className="promo-panel-image"
          src={imageSource}
          srcSet={imageSourceSet}
          sizes="(max-width: 760px) 100vw, 50vw"
          width="1600"
          height="1200"
          fetchPriority="high"
          loading="eager"
          decoding="async"
          alt=""
        />
      )}
      <div className="promo-overlay" />
    </section>
  )
}

function StatusCard({
  state,
  onBack,
  onDone,
  onCheckOut,
  onRefreshApproval,
  onCompleteSecondCheckIn,
  isCheckingOut,
  isRefreshingApproval,
  isCompletingSecondCheckIn,
  markedAt,
  exitTime,
  requestedAt,
  message,
}: {
  state: Exclude<AttendanceState, "default" | "loading">
  onBack: () => void
  onDone: () => void
  onCheckOut: () => void
  onRefreshApproval: () => void
  onCompleteSecondCheckIn: () => void
  isCheckingOut: boolean
  isRefreshingApproval: boolean
  isCompletingSecondCheckIn: boolean
  markedAt?: string
  exitTime?: string
  requestedAt?: string
  message?: string
}) {
  const content = {
    invalid: {
      label: "Unable to continue",
      title: "Register Number Not Found",
      description: "Please check your Register Number and try again.",
      note: "Register numbers are provided by your CSC administrator.",
    },
    success: {
      label: "Attendance Marked",
      title: "Check-in successful",
      description: "Your attendance has been recorded.",
      note: markedAt
        ? `Entry time: ${formatIndiaTime(markedAt)}`
        : "Your entry time is recorded.",
    },
    active: {
      label: "Checked In",
      title: "You're checked in",
      description: "Your attendance is active. Check out when you are leaving.",
      note: markedAt
        ? `Entry time: ${formatIndiaTime(markedAt)}`
        : "Your entry time is recorded.",
    },
    completed: {
      label: "Attendance Completed",
      title: "Today's attendance is complete",
      description: "Your exit has already been recorded for today.",
      note: exitTime
        ? `Exit time: ${formatIndiaTime(exitTime)}`
        : "Your exit time is recorded.",
    },
    "checked-out": {
      label: "Checked Out",
      title: "Successfully checked out",
      description: "Your exit time has been recorded.",
      note: exitTime
        ? `Exit time: ${formatIndiaTime(exitTime)}`
        : "Your exit time is recorded.",
    },
    leave: {
      label: "Class Closed",
      title: "Class is on leave",
      description: "Attendance cannot be marked while the class is closed.",
      note: "Please contact Admin/Staff for more information.",
    },
    inactive: {
      label: "Attendance Unavailable",
      title: "Student account is inactive",
      description: "This account cannot mark new attendance.",
      note: "Please contact your CSC administrator.",
    },
    error: {
      label: "Service Unavailable",
      title: "Unable to mark attendance",
      description: "The attendance service could not complete your request.",
      note: message || "Please try again in a moment.",
    },
    "second-check-in-pending": {
      label: "Approval Required",
      title: "Second Check-In Pending Admin Approval",
      description:
        "Your original attendance time is unchanged. An administrator must approve this second check-in.",
      note: requestedAt
        ? `Request sent: ${formatIndiaDate(requestedAt)} ${formatIndiaTime(requestedAt)}`
        : "Your request is waiting for an administrator.",
    },
    "second-check-in-approved": {
      label: "Request Approved",
      title: "Second Check-In Approved",
      description: "Complete your approved second check-in to continue.",
      note: requestedAt
        ? `Approved request from ${formatIndiaDate(requestedAt)} ${formatIndiaTime(requestedAt)}`
        : "Your administrator approved the request.",
    },
    "second-check-in-rejected": {
      label: "Request Rejected",
      title: "Second Check-In Not Approved",
      description:
        "Your original attendance record and check-in time have not been changed.",
      note: "Contact your administrator if you think this was a mistake.",
    },
  }[state]

  return (
    <div
      className={`status-card status-${state}`}
      role={
        state === "invalid" ||
        state === "leave" ||
        state === "inactive" ||
        state === "error"
          ? "alert"
          : "status"
      }
    >
      <div className="status-icon">
        <Icon
          name={
            state === "success"
              ? "check"
              : state === "active" ||
                  state === "completed" ||
                  state === "checked-out" ||
                  state === "leave" ||
                  state === "second-check-in-pending"
                ? "clock"
                : "shield"
          }
        />
      </div>
      <p className="status-label">{content.label}</p>
      <h2>{content.title}</h2>
      <p className="status-description">{content.description}</p>
      <div className="status-note">{content.note}</div>
      {message && state !== "error" && (
        <p className="management-error" role="alert">
          {message}
        </p>
      )}
      {state === "active" ? (
        <Button onClick={onCheckOut} disabled={isCheckingOut}>
          {isCheckingOut ? (
            <>
              <span className="spinner" />
              Checking out...
            </>
          ) : (
            "Check Out"
          )}
        </Button>
      ) : state === "second-check-in-pending" ? (
        <Button onClick={onRefreshApproval} disabled={isRefreshingApproval}>
          {isRefreshingApproval ? "Checking approval..." : "Check approval status"}
        </Button>
      ) : state === "second-check-in-approved" ? (
        <Button
          onClick={onCompleteSecondCheckIn}
          disabled={isCompletingSecondCheckIn}
        >
          {isCompletingSecondCheckIn
            ? "Recording second check-in..."
            : "Complete second check-in"}
        </Button>
      ) : state === "success" ||
        state === "completed" ||
        state === "checked-out" ||
        state === "leave" ? (
        <p className="form-note">Returning to the attendance login...</p>
      ) : state === "invalid" ? (
        <div className="status-actions">
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onDone}>Try again</Button>
        </div>
      ) : (
        <Button onClick={onDone}>Try again</Button>
      )}
    </div>
  )
}

function StudentLogin({
  view,
  setView,
}: {
  view: AppView
  setView: (view: AppView) => void
}) {
  const [registerNumber, setRegisterNumber] = useState("")
  const [state, setState] = useState<AttendanceState>("default")
  const [markedAt, setMarkedAt] = useState<string>()
  const [exitTime, setExitTime] = useState<string>()
  const [requestedAt, setRequestedAt] = useState<string>()
  const [isCheckingOut, setIsCheckingOut] = useState(false)
  const [isRefreshingApproval, setIsRefreshingApproval] = useState(false)
  const [isCompletingSecondCheckIn, setIsCompletingSecondCheckIn] =
    useState(false)
  const [isRestoring, setIsRestoring] = useState(true)
  const [serviceMessage, setServiceMessage] = useState("")
  const [currentTime, setCurrentTime] = useState(() => new Date())

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(new Date()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false
    void attendanceApi
      .studentSession()
      .then((session) => {
        if (cancelled) return
        setMarkedAt(session.attendance.entryTime)
        setExitTime(session.attendance.exitTime ?? undefined)
        setRequestedAt(
          session.secondCheckInRequest?.requestedAt ?? undefined,
        )
        if (session.secondCheckInRequest?.status === "pending") {
          setState("second-check-in-pending")
        } else if (session.secondCheckInRequest?.status === "approved") {
          setState("second-check-in-approved")
        } else if (session.secondCheckInRequest?.status === "rejected") {
          setState("second-check-in-rejected")
        } else if (session.secondCheckInRequest?.status === "completed") {
          setState(
            session.attendance.status === "completed" ? "completed" : "active",
          )
        } else {
          setState("default")
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (
          !(
            error instanceof ApiError &&
            error.code === "STUDENT_SESSION_REQUIRED"
          )
        ) {
          setServiceMessage(
            error instanceof Error
              ? error.message
              : "Unable to restore your attendance session.",
          )
          setState("error")
        } else {
          setState("default")
        }
      })
      .finally(() => {
        if (!cancelled) setIsRestoring(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (
      state !== "success" &&
      state !== "completed" &&
      state !== "checked-out" &&
      state !== "leave"
    )
      return

    const timeout = window.setTimeout(() => {
      setState("default")
      setRegisterNumber("")
      setMarkedAt(undefined)
      setExitTime(undefined)
      setRequestedAt(undefined)
      setServiceMessage("")
    }, 5000)

    return () => window.clearTimeout(timeout)
  }, [state])

  useEffect(() => {
    if (state !== "second-check-in-pending") return

    let cancelled = false
    const interval = window.setInterval(() => {
      void attendanceApi
        .studentSession()
        .then((session) => {
          if (cancelled) return
          const request = session.secondCheckInRequest
          if (!request) return
          setRequestedAt(request.requestedAt)
          setServiceMessage("")
          if (request.status === "approved")
            setState("second-check-in-approved")
          else if (request.status === "rejected")
            setState("second-check-in-rejected")
          else if (request.status === "completed") {
            setMarkedAt(session.attendance.entryTime)
            setExitTime(session.attendance.exitTime ?? undefined)
            setState(
              session.attendance.status === "completed"
                ? "completed"
                : "active",
            )
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setServiceMessage(
            error instanceof Error
              ? error.message
              : "Unable to check the approval status.",
          )
        })
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [state])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!registerNumber.trim()) return
    setState("loading")
    setServiceMessage("")
    try {
      const result = await attendanceApi.mark(registerNumber)
      setMarkedAt(result.attendance.markedAt)
      setExitTime(result.attendance.exitTime ?? undefined)
      if (result.attendance.status === "second_check_in_pending") {
        setRequestedAt(result.secondCheckInRequest?.requestedAt)
        setState("second-check-in-pending")
      } else if (result.attendance.status === "second_check_in_approved") {
        setRequestedAt(result.secondCheckInRequest?.requestedAt)
        setState("second-check-in-approved")
      } else {
        setState(
          result.attendance.status === "entry_recorded" ||
            result.attendance.status === "second_entry_recorded"
            ? "success"
            : result.attendance.status === "already_checked_in"
              ? "active"
              : "completed",
        )
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "STUDENT_NOT_FOUND")
        setState("invalid")
      else if (
        error instanceof ApiError &&
        error.code === "SECOND_CHECK_IN_REJECTED"
      )
        setState("second-check-in-rejected")
      else if (error instanceof ApiError && error.code === "STUDENT_INACTIVE")
        setState("inactive")
      else if (error instanceof ApiError && error.code === "CLASS_CLOSED_LEAVE")
        setState("leave")
      else if (
        error instanceof ApiError &&
        error.code === "ATTENDANCE_COMPLETED"
      )
        setState("completed")
      else if (error instanceof ApiError && error.code === "ATTENDANCE_EXISTS")
        setState("active")
      else {
        setServiceMessage(
          error instanceof Error ? error.message : "Unable to mark attendance.",
        )
        setState("error")
      }
    }
  }

  const checkOut = async () => {
    setIsCheckingOut(true)
    setServiceMessage("")
    try {
      const result = await attendanceApi.checkOut()
      setExitTime(result.attendance.exitTime)
      setState("checked-out")
    } catch (error) {
      if (error instanceof ApiError && error.code === "ATTENDANCE_COMPLETED") {
        try {
          const session = await attendanceApi.studentSession()
          setExitTime(session.attendance.exitTime ?? undefined)
          setState(
            session.attendance.status === "completed" ? "completed" : "success",
          )
        } catch (sessionError) {
          setServiceMessage(
            sessionError instanceof Error
              ? sessionError.message
              : "Unable to verify the attendance status.",
          )
        }
      } else {
        setServiceMessage(
          error instanceof Error ? error.message : "Unable to check out.",
        )
      }
    } finally {
      setIsCheckingOut(false)
    }
  }

  const refreshApproval = async () => {
    setIsRefreshingApproval(true)
    setServiceMessage("")
    try {
      const session = await attendanceApi.studentSession()
      const request = session.secondCheckInRequest
      if (!request) {
        setState("default")
        return
      }
      setRequestedAt(request.requestedAt)
      setState(
        request.status === "pending"
          ? "second-check-in-pending"
          : request.status === "approved"
            ? "second-check-in-approved"
            : request.status === "rejected"
              ? "second-check-in-rejected"
              : session.attendance.status === "completed"
                ? "completed"
                : "active",
      )
    } catch (error) {
      setServiceMessage(
        error instanceof Error
          ? error.message
          : "Unable to check the approval status.",
      )
    } finally {
      setIsRefreshingApproval(false)
    }
  }

  const completeSecondCheckIn = async () => {
    setIsCompletingSecondCheckIn(true)
    setServiceMessage("")
    try {
      const result = await attendanceApi.completeSecondCheckIn()
      setMarkedAt(result.attendance.markedAt)
      setExitTime(result.attendance.exitTime ?? undefined)
      setState(
        result.attendance.status === "second_entry_recorded"
          ? "success"
          : result.attendance.status === "already_checked_in"
            ? "active"
            : "completed",
      )
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "SECOND_CHECK_IN_PENDING"
      ) {
        setState("second-check-in-pending")
      } else if (
        error instanceof ApiError &&
        error.code === "SECOND_CHECK_IN_NOT_APPROVED"
      ) {
        setState("second-check-in-rejected")
      } else {
        setServiceMessage(
          error instanceof Error
            ? error.message
            : "Unable to complete the second check-in.",
        )
      }
    } finally {
      setIsCompletingSecondCheckIn(false)
    }
  }

  const reset = () => {
    setState("default")
    setRegisterNumber("")
    setMarkedAt(undefined)
    setExitTime(undefined)
    setRequestedAt(undefined)
    setServiceMessage("")
  }

  const returnToRegisterForm = () => {
    setState("default")
    setServiceMessage("")
  }

  return (
    <main className="login-panel">
      <div className="login-panel-header">
        <ViewSwitch view={view} setView={setView} />
        <div className="student-login-brand">
          <Brand />
        </div>
      </div>
      <div className="login-content">
        <p className="india-clock">
          <Icon name="clock" />
          <span>{formatIndiaTime(currentTime)} IST</span>
        </p>
        {isRestoring ? (
          <div className="login-heading">
            <p className="section-label">Student attendance</p>
            <h2>Checking attendance...</h2>
          </div>
        ) : state === "default" || state === "loading" ? (
          <>
            <div className="login-heading">
              <p className="section-label">Student attendance</p>
              <h2>Welcome back</h2>
              <p className="lead">Mark your attendance</p>
              <p>Enter your Register Number to continue.</p>
            </div>
            <form onSubmit={submit} className="login-form">
              <TextField
                label="Register Number"
                value={registerNumber}
                onChange={setRegisterNumber}
                placeholder="Enter your register number"
                autoFocus
              />
              <Button
                type="submit"
                disabled={
                  !registerNumber.trim() || state === "loading" || isRestoring
                }
              >
                {state === "loading" ? (
                  <>
                    <span className="spinner" />
                    Checking register...
                  </>
                ) : (
                  <>
                    Check In <Icon name="arrow" />
                  </>
                )}
              </Button>
            </form>
            <p className="form-note">
              <Icon name="shield" /> Use your registered number to mark your
              attendance.
            </p>
          </>
        ) : (
          <StatusCard
            state={state}
            onBack={returnToRegisterForm}
            onDone={reset}
            onCheckOut={() => void checkOut()}
            onRefreshApproval={() => void refreshApproval()}
            onCompleteSecondCheckIn={() => void completeSecondCheckIn()}
            isCheckingOut={isCheckingOut}
            isRefreshingApproval={isRefreshingApproval}
            isCompletingSecondCheckIn={isCompletingSecondCheckIn}
            markedAt={markedAt}
            exitTime={exitTime}
            requestedAt={requestedAt}
            message={serviceMessage}
          />
        )}
      </div>
      <div className="login-footer">
        <span>CSC Class Attendance</span>
        <span>Secure student access</span>
      </div>
    </main>
  )
}

function AdminLogin({
  onLogin,
  onStudent,
}: {
  onLogin: (username: string, password: string) => Promise<void>
  onStudent: () => void
}) {
  const [staffId, setStaffId] = useState("")
  const [password, setPassword] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError("")
    try {
      await onLogin(staffId, password)
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : "Unable to sign in.",
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="admin-login-shell">
      <div className="admin-login-card">
        <Brand />
        <div className="admin-login-heading">
          <p className="section-label">Administration</p>
          <h1>Sign in to your workspace</h1>
          <p>Manage attendance and login page promotions securely.</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <TextField
            label="Staff ID"
            value={staffId}
            onChange={setStaffId}
            placeholder="Enter your staff ID"
          />
          <TextField
            label="Password"
            value={password}
            onChange={setPassword}
            placeholder="Enter your password"
            type="password"
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={!staffId || !password || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <span className="spinner" />
                Signing in...
              </>
            ) : (
              <>
                Sign in <Icon name="arrow" />
              </>
            )}
          </Button>
        </form>
        <button className="back-link" onClick={onStudent}>
          Return to student attendance
        </button>
      </div>
      <div className="admin-login-aside">
        <div>
          <span className="aside-icon">
            <Icon name="shield" />
          </span>
          <p className="eyebrow">CSC Class Admin</p>
          <h2>
            Simple controls.
            <br />
            Clear oversight.
          </h2>
          <p>
            Keep the student experience current without adding complexity to
            attendance.
          </p>
        </div>
      </div>
    </main>
  )
}

export default function App() {
  const [view, setView] = useState<AppView>("student")
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const enabledCount = promotions.filter(
      (promotion) => promotion.enabled,
    ).length
    if (activeIndex >= enabledCount) setActiveIndex(0)
    const interval = window.setInterval(() => {
      setActiveIndex((index) =>
        enabledCount > 0 ? (index + 1) % enabledCount : 0,
      )
    }, 6000)
    return () => window.clearInterval(interval)
  }, [promotions, activeIndex])

  useEffect(() => {
    promotionApi
      .publicList()
      .then(({ promotions: items }) => setPromotions(items))
      .catch((error) =>
        console.error("Unable to load login page images.", error),
      )
  }, [])

  const loginAdmin = async (username: string, password: string) => {
    await adminApi.login(username, password)
    setView("admin-dashboard")
  }

  const logoutAdmin = async () => {
    await adminApi.logout()
    setView("admin-login")
  }

  if (view === "admin-login") {
    return (
      <AdminLogin onLogin={loginAdmin} onStudent={() => setView("student")} />
    )
  }

  if (view === "admin-dashboard") {
    return (
      <Suspense fallback={<div role="status">Loading dashboard…</div>}>
        <AdminDashboard
          promotions={promotions}
          setPromotions={setPromotions}
          onLogout={logoutAdmin}
        />
      </Suspense>
    )
  }

  return (
    <div className="student-shell">
      <PromotionPanel promotions={promotions} activeIndex={activeIndex} />
      <StudentLogin view={view} setView={setView} />
    </div>
  )
}
