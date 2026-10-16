import assert from "node:assert/strict"

import { afterEach, test } from "node:test"

import {
  adminApi,
  ApiError,
  attendanceApi,
  calendarApi,
  promotionApi,
  reportApi,
  studentApi,
} from "./api.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("admin login sends credentials to the same-origin endpoint and accepts a successful response", async () => {
  let requestUrl

  let requestOptions

  globalThis.fetch = async (url, options) => {
    requestUrl = url

    requestOptions = options

    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,

      headers: { "Content-Type": "application/json" },
    })
  }

  const result = await adminApi.login("staff-id", "test-password")

  assert.equal(result.authenticated, true)

  assert.equal(requestUrl, "/api/admin/login")

  assert.equal(requestOptions.method, "POST")

  assert.equal(requestOptions.credentials, "same-origin")

  assert.equal(requestOptions.headers.get("X-Requested-With"), "CSCAttendance")

  assert.deepEqual(JSON.parse(requestOptions.body), {
    username: "staff-id",

    password: "test-password",
  })
})

test("admin login preserves invalid-credential responses as authentication errors", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "Staff ID or password is incorrect.",

        code: "INVALID_CREDENTIALS",
      }),

      {
        status: 401,

        headers: { "Content-Type": "application/json" },
      },
    )

  await assert.rejects(
    adminApi.login("staff-id", "wrong-password"),

    (error) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === "INVALID_CREDENTIALS" &&
      error.message === "Staff ID or password is incorrect.",
  )
})

test("admin login preserves server errors instead of reporting a network failure", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Login service is unavailable." }), {
      status: 500,

      headers: { "Content-Type": "application/json" },
    })

  await assert.rejects(
    adminApi.login("staff-id", "test-password"),

    (error) =>
      error instanceof ApiError &&
      error.status === 500 &&
      error.message === "Login service is unavailable.",
  )
})

test("admin login reports network failures separately from rejected credentials", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed")
  }

  await assert.rejects(
    adminApi.login("staff-id", "test-password"),

    (error) =>
      error instanceof ApiError &&
      error.status === 0 &&
      error.message.includes("Cannot reach the attendance API") &&
      !error.message.includes("password"),
  )
})

test("student check-out uses the same-origin authenticated route without a client-supplied timestamp", async () => {
  let requestUrl
  let requestOptions

  globalThis.fetch = async (url, options) => {
    requestUrl = url
    requestOptions = options
    return new Response(
      JSON.stringify({
        attendance: {
          id: 12,
          exitTime: "2026-10-13T13:00:00.000Z",
          status: "completed",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  const result = await attendanceApi.checkOut()

  assert.equal(requestUrl, "/api/attendance/check-out")
  assert.equal(requestOptions.method, "POST")
  assert.equal(requestOptions.credentials, "same-origin")
  assert.equal(requestOptions.headers.get("X-Requested-With"), "CSCAttendance")
  assert.equal(requestOptions.body, undefined)
  assert.equal(result.attendance.status, "completed")
})

test("student check-in session is restored from its HttpOnly same-origin cookie", async () => {
  let requestUrl
  let requestOptions

  globalThis.fetch = async (url, options) => {
    requestUrl = url
    requestOptions = options
    return new Response(
      JSON.stringify({
        attendance: {
          id: 12,
          entryTime: "2026-10-13T08:00:00.000Z",
          exitTime: null,
          status: "present",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  const result = await attendanceApi.studentSession()

  assert.equal(requestUrl, "/api/attendance/session")
  assert.equal(requestOptions.credentials, "same-origin")
  assert.equal(result.attendance.status, "present")
})

test("student create and edit payloads include course and class timing", async () => {
  const bodies = []
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ student: { id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  const student = {
    registerNumber: "CSC100",
    name: "Student",
    phoneNumber: "",
    address: "",
    course: "Office Automation",
    classTiming: "9:00 AM - 11:00 AM",
    active: true,
  }
  await studentApi.create(student)
  await studentApi.update(1, student)
  assert.deepEqual(bodies, [student, student])
})

test("calendar event create and update use persistent protected API routes", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({ event: { id: 4 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  const event = {
    title: "Emergency closure",
    eventType: "emergency_leave",
    description: "",
    startDate: "2026-10-20",
    endDate: "2026-10-20",
    fullDay: true,
    startTime: null,
    endTime: null,
    affectsAttendance: true,
  }
  await calendarApi.create(event)
  await calendarApi.update(4, event)
  assert.equal(requests[0].url, "/api/admin/calendar-events")
  assert.equal(requests[0].options.method, "POST")
  assert.equal(requests[1].url, "/api/admin/calendar-events/4")
  assert.equal(requests[1].options.method, "PUT")
})

test("leave routes create, list, update, and delete scoped calendar records", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({ leaves: [], leave: { id: 7 }, deleted: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  const leave = {
    date: "2026-10-15",
    scope: "staff",
    leaveType: "full_day",
    reason: "Personal work",
    startTime: null,
    endTime: null,
  }
  await calendarApi.listLeaves("2026-10")
  await calendarApi.createLeave(leave)
  await calendarApi.updateLeave(7, leave)
  await calendarApi.removeLeave(7)

  assert.equal(requests[0].url, "/api/admin/leaves?month=2026-10")
  assert.equal(requests[1].options.method, "POST")
  assert.deepEqual(JSON.parse(requests[1].options.body), leave)
  assert.equal(requests[2].url, "/api/admin/leaves/7")
  assert.equal(requests[2].options.method, "PUT")
  assert.equal(requests[3].options.method, "DELETE")
  assert.ok(requests.every(({ options }) =>
    options.headers.get("X-Requested-With") === "CSCAttendance",
  ))
})

test("monthly Excel API returns a same-origin authenticated workbook response", async () => {
  let requestUrl
  let requestOptions
  globalThis.fetch = async (url, options) => {
    requestUrl = url
    requestOptions = options
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    })
  }

  const workbook = await reportApi.monthlyAttendance("2026-10")
  assert.equal(requestUrl, "/api/admin/reports/monthly-attendance.xlsx?month=2026-10")
  assert.equal(requestOptions.credentials, "same-origin")
  assert.equal(requestOptions.headers["X-Requested-With"], "CSCAttendance")
  assert.deepEqual([...new Uint8Array(await workbook.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04])
})

test("daily and month-end Excel APIs request authenticated same-origin workbooks", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    })
  }

  await reportApi.dailyAttendance("2026-10-15")
  await reportApi.monthEndAttendance("2026-10")

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/api/admin/reports/daily-attendance.xlsx?date=2026-10-15",
      "/api/admin/reports/month-end-attendance.xlsx?month=2026-10",
    ],
  )
  assert.ok(
    requests.every(
      ({ options }) =>
        options.credentials === "same-origin" &&
        options.headers["X-Requested-With"] === "CSCAttendance",
    ),
  )
})

test("Excel API reports a non-workbook server response instead of downloading it", async () => {
  globalThis.fetch = async () =>
    new Response("database unavailable", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })

  await assert.rejects(
    reportApi.dailyAttendance("2026-10-15"),
    /server did not return an Excel workbook/,
  )
})

test("Excel API surfaces database availability errors", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "Attendance data is temporarily unavailable. Please try again.",
        code: "DATABASE_UNAVAILABLE",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    )

  await assert.rejects(
    reportApi.monthEndAttendance("2026-10"),
    (error) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === "DATABASE_UNAVAILABLE" &&
      error.message.includes("temporarily unavailable"),
  )
})

test("daily dashboard API follows the selected date and sends same-origin admin requests", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(
      JSON.stringify({
        date: "2026-10-15",
        totalActiveStudents: 0,
        presentStudents: [],
        absentStudents: [],
        isEligibleWorkingDay: true,
        isFullDayClassClosure: false,
        closureTitle: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  await attendanceApi.dashboard("2026-10-15")
  await attendanceApi.dashboard("2026-10-16")

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/api/admin/dashboard-attendance?date=2026-10-15",
      "/api/admin/dashboard-attendance?date=2026-10-16",
    ],
  )
  assert.ok(
    requests.every(
      ({ options }) =>
        options.credentials === "same-origin" &&
        options.headers.get("X-Requested-With") === "CSCAttendance",
    ),
  )
})

test("daily dashboard API preserves Admin authorization failures", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "Admin sign-in is required.",
        code: "UNAUTHORIZED",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )
  await assert.rejects(
    attendanceApi.dashboard("2026-10-15"),
    (error) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === "UNAUTHORIZED" &&
      error.message === "Admin sign-in is required.",
  )
})

test("monthly student summaries use one batch request for the selected month", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({ summaries: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  await studentApi.monthlySummary("2026-10")
  await studentApi.monthlySummary("2026-11")

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/api/admin/student-attendance-summary?month=2026-10",
      "/api/admin/student-attendance-summary?month=2026-11",
    ],
  )
  assert.ok(
    requests.every(({ options }) =>
      options.headers.get("X-Requested-With") === "CSCAttendance",
    ),
  )
})

test("daily dashboard API surfaces server errors without substituting empty data", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "Attendance data is temporarily unavailable.",
        code: "DATABASE_UNAVAILABLE",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  await assert.rejects(
    attendanceApi.dashboard("2026-10-15"),
    (error) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === "DATABASE_UNAVAILABLE" &&
      error.message.includes("temporarily unavailable"),
  )
})

test("promotional upload sends multipart bytes without setting or exposing Cloudinary secrets", async () => {
  let requestUrl
  let requestOptions
  globalThis.fetch = async (url, options) => {
    requestUrl = url
    requestOptions = options
    return new Response(JSON.stringify({ promotion: { id: 1 } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  }
  await promotionApi.upload(new File(["fake-image"], "banner.png", { type: "image/png" }), "Banner")
  assert.equal(requestUrl, "/api/admin/promotions")
  assert.equal(requestOptions.method, "POST")
  assert.ok(requestOptions.body instanceof FormData)
  assert.equal(requestOptions.headers.has("Content-Type"), false)
  assert.equal(JSON.stringify(requestOptions).includes("CLOUDINARY_API_SECRET"), false)
})
