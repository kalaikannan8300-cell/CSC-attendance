import assert from "node:assert/strict"

import { randomBytes, scryptSync } from "node:crypto"

import { readFile } from "node:fs/promises"

import { Writable } from "node:stream"

import { after, before, describe, test } from "node:test"

import { v2 as cloudinary } from "cloudinary"

import pg from "pg"

import { businessDate } from "./business-date.mjs"

import {
  createPostgresApiServer,
  processCloudinaryCleanup,
  processSyncQueue,
} from "./postgres-index.mjs"

const { Pool } = pg

const configuredUrl = process.env.TEST_DATABASE_URL

const credentials = {
  username: "test-admin",
  password: "integration-test-password-123",
}

let registerNumber = "PGTEST1001"

const schemaName = `attendance_test_${randomBytes(5).toString("hex")}`

let adminPool

let pool

let server

let baseUrl

let cookie

let studentCookie

let studentId

let attendanceId

test("PostgreSQL DATE values remain ISO calendar-date strings", () => {
  assert.equal(pg.types.getTypeParser(1082)("2026-10-13"), "2026-10-13")
})

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex")

  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`
}

async function startApi() {
  const result = createPostgresApiServer({
    pool,

    adminUsername: credentials.username,

    adminPassword: credentials.password,

    startWorker: false,
  })

  server = result.server

  await new Promise((resolve, reject) => {
    server.once("error", reject)

    server.listen(0, "127.0.0.1", resolve)
  })

  baseUrl = `http://127.0.0.1:${server.address().port}`

  const login = await api("/api/admin/login", {
    method: "POST",
    body: credentials,
  })

  assert.equal(login.response.status, 200)

  cookie = login.response.headers.get("set-cookie").split(";")[0]
}

async function stopApi() {
  if (!server) return

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })

  server = undefined
}

async function api(
  path,
  {
    method = "GET",
    body,
    authenticated = false,
    studentAuthenticated = false,
  } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,

    headers: {
      "X-Requested-With": "CSCAttendance",

      ...(body ? { "Content-Type": "application/json" } : {}),

      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(studentAuthenticated && studentCookie
        ? { Cookie: studentCookie }
        : {}),
    },

    body: body ? JSON.stringify(body) : undefined,
  })

  if (path === "/api/attendance" && response.headers.get("set-cookie")) {
    studentCookie = response.headers.get("set-cookie").split(";")[0]
  }

  return { response, payload: await response.json() }
}

async function createLegacyExitRequest(attendanceId, studentId) {
  const result = await pool.query(
    "INSERT INTO login_requests(attendance_id,student_id) VALUES($1,$2) RETURNING id",
    [attendanceId, studentId],
  )
  return Number(result.rows[0].id)
}

const testDatabaseName = configuredUrl
  ? decodeURIComponent(new URL(configuredUrl).pathname.slice(1))
  : ""

const testDatabaseIsExplicit = /(?:^|[_-])test(?:$|[_-])/i.test(
  testDatabaseName,
)

describe(
  "PostgreSQL attendance workflows",
  { skip: !configuredUrl || !testDatabaseIsExplicit },
  () => {
    before(async () => {
      adminPool = new Pool({ connectionString: configuredUrl })

      await adminPool.query(`CREATE SCHEMA "${schemaName}"`)

      pool = new Pool({
        connectionString: configuredUrl,
        options: `-c search_path=${schemaName}`,
      })

      await pool.query(
        await readFile(
          new URL("./postgres-schema.sql", import.meta.url),
          "utf8",
        ),
      )

      await pool.query(
        "INSERT INTO admins(username,password_hash) VALUES($1,$2)",

        [credentials.username, hashPassword(credentials.password)],
      )

      await startApi()
    })

    after(async () => {
      await stopApi()

      await pool?.end()

      await adminPool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)

      await adminPool?.end()
    })

    test("daily dashboard is Admin-protected and returns roster-aware present, absent, and closure data", async () => {
      const addStudent = async (registerNumber, name, active = true) => {
        const result = await pool.query(
          `INSERT INTO students(register_number,name,course,active,created_at)
           VALUES($1,$2,'Office', $3, '2019-01-01T00:00:00Z') RETURNING id`,
          [registerNumber, name, active],
        )
        return Number(result.rows[0].id)
      }

      const presentId = await addStudent("PGDASH0001", "Dashboard Present")
      const absentId = await addStudent("PGDASH0002", "Dashboard Absent")
      const leaveId = await addStudent("PGDASH0003", "Dashboard Leave")
      const inactiveId = await addStudent(
        "PGDASH0004",
        "Dashboard Inactive",
        false,
      )
      await pool.query(
        `INSERT INTO attendance(student_id,attendance_date,entry_time)
         VALUES($1,'2020-02-03','2020-02-03 09:00:00+05:30')`,
        [presentId],
      )
      await pool.query(
        `INSERT INTO approved_student_leaves(student_id,leave_date)
         VALUES($1,'2020-02-03')`,
        [leaveId],
      )
      await pool.query(
        `INSERT INTO calendar_events(
           title,event_type,start_date,end_date,full_day,start_time,end_time,
           affects_attendance,leave_scope
         ) VALUES(
           'Partial class closure','csc_closed','2020-02-03','2020-02-03',
           FALSE,'10:00','12:00',FALSE,'class_closed'
         )`,
      )

      const unauthorized = await api(
        "/api/admin/dashboard-attendance?date=2020-02-03",
      )
      assert.equal(unauthorized.response.status, 401)

      const daily = await api(
        "/api/admin/dashboard-attendance?date=2020-02-03",
        { authenticated: true },
      )
      assert.equal(daily.response.status, 200)
      assert.equal(daily.payload.totalActiveStudents, 3)
      assert.equal(daily.payload.isEligibleWorkingDay, true)
      assert.equal(daily.payload.isFullDayClassClosure, false)
      assert.deepEqual(
        daily.payload.presentStudents.map((student) => ({
          registerNumber: student.registerNumber,
          status: student.status,
          exitTime: student.exitTime,
        })),
        [{ registerNumber: "PGDASH0001", status: "PRESENT", exitTime: null }],
      )
      assert.deepEqual(
        daily.payload.absentStudents.map((student) => student.registerNumber),
        ["PGDASH0002"],
      )

      await pool.query(
        `INSERT INTO calendar_events(
           title,event_type,start_date,end_date,full_day,affects_attendance,
           leave_scope
         ) VALUES(
           'Full-day class closure','csc_closed','2020-02-04','2020-02-04',
           TRUE,TRUE,'class_closed'
         )`,
      )
      const closure = await api(
        "/api/admin/dashboard-attendance?date=2020-02-04",
        { authenticated: true },
      )
      assert.equal(closure.payload.isFullDayClassClosure, true)
      assert.deepEqual(closure.payload.absentStudents, [])
      await pool.query(
        "DELETE FROM calendar_events WHERE title IN ('Partial class closure','Full-day class closure')",
      )
      await pool.query(
        "DELETE FROM attendance WHERE student_id=ANY($1::bigint[])",
        [[presentId, absentId, leaveId, inactiveId]],
      )
      await pool.query(
        "DELETE FROM approved_student_leaves WHERE student_id=ANY($1::bigint[])",
        [[presentId, absentId, leaveId, inactiveId]],
      )
      await pool.query(
        "DELETE FROM students WHERE id=ANY($1::bigint[])",
        [[presentId, absentId, leaveId, inactiveId]],
      )
    })

    test("valid first login creates one server-timestamped attendance row; invalid, inactive, and malformed requests fail", async () => {
      const student = await pool.query(
        "INSERT INTO students(register_number,name,active) VALUES($1,$2,TRUE) RETURNING id",

        [registerNumber, "Test Student"],
      )

      studentId = student.rows[0].id

      const invalid = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber: "UNKNOWN" },
      })

      assert.equal(invalid.response.status, 404)

      const malformed = await api("/api/attendance", {
        method: "POST",
        body: {},
      })

      assert.equal(malformed.response.status, 400)

      assert.equal(
        (await pool.query("SELECT COUNT(*)::int AS count FROM attendance"))
          .rows[0].count,
        0,
      )

      const date = businessDate()
      const staffLeave = await pool.query(
        `INSERT INTO calendar_events(
           title,event_type,start_date,end_date,full_day,affects_attendance,leave_scope
         ) VALUES('Staff leave','emergency_leave',$1,$1,TRUE,FALSE,'staff')
         RETURNING id`,
        [date],
      )
      const classClosure = await pool.query(
        `INSERT INTO calendar_events(
           title,event_type,start_date,end_date,full_day,affects_attendance,leave_scope
         ) VALUES('Class closed','csc_closed',$1,$1,TRUE,TRUE,'class_closed')
         RETURNING id`,
        [date],
      )
      const blocked = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      assert.equal(blocked.response.status, 403)
      assert.equal(blocked.payload.code, "CLASS_CLOSED_LEAVE")
      assert.match(blocked.payload.error, /contact Admin\/Staff/i)
      assert.equal(
        (await pool.query("SELECT COUNT(*)::int AS count FROM attendance"))
          .rows[0].count,
        0,
      )
      await pool.query("DELETE FROM calendar_events WHERE id=$1", [
        classClosure.rows[0].id,
      ])

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })

      assert.equal(first.response.status, 201)

      assert.equal(first.payload.attendance.exitTime, null)

      assert.ok(first.payload.attendance.markedAt)

      attendanceId = first.payload.attendance.id

      const saved = await pool.query(
        "SELECT attendance_date FROM attendance WHERE id=$1",
        [attendanceId],
      )
      const adminRecords = await api(
        `/api/admin/attendance?date=${saved.rows[0].attendance_date}`,
        { authenticated: true },
      )

      assert.equal(adminRecords.response.status, 200)
      assert.equal(adminRecords.payload.attendance.length, 1)
      assert.equal(adminRecords.payload.attendance[0].id, attendanceId)
      assert.equal(
        adminRecords.payload.attendance[0].register_number,
        registerNumber,
      )
      assert.equal(adminRecords.payload.attendance[0].name, "Test Student")
      assert.equal(adminRecords.payload.attendance[0].status, "present")
      assert.equal(adminRecords.payload.attendance[0].exit_time, null)
      await pool.query("DELETE FROM calendar_events WHERE id=$1", [
        staffLeave.rows[0].id,
      ])
      assert.ok(
        Number.isFinite(
          new Date(adminRecords.payload.attendance[0].entry_time).getTime(),
        ),
      )

      await pool.query("UPDATE students SET active=FALSE WHERE id=$1", [
        studentId,
      ])

      const inactive = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })

      assert.equal(inactive.response.status, 403)
    })

    test("repeated check-ins reuse today's row without duplicating or auto-approving a legacy exit request", async () => {
      registerNumber = "PGTEST1002"

      const student = await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2) RETURNING id",
        [registerNumber, "Test Student"],
      )

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })

      assert.equal(first.response.status, 201)
      const pendingRequestId = await createLegacyExitRequest(
        first.payload.attendance.id,
        student.rows[0].id,
      )

      const results = await Promise.all([
        api("/api/attendance", { method: "POST", body: { registerNumber } }),

        api("/api/attendance", { method: "POST", body: { registerNumber } }),
      ])

      assert.deepEqual(
        results.map((result) => result.response.status),
        [200, 200],
      )

      assert.equal(
        results[0].payload.attendance.id,
        results[1].payload.attendance.id,
      )
      assert.equal(results[0].payload.attendance.status, "already_checked_in")

      const counts = await pool.query(
        "SELECT (SELECT COUNT(*) FROM attendance)::int AS attendance,(SELECT COUNT(*) FROM login_requests WHERE status='pending')::int AS pending",
      )

      assert.deepEqual(counts.rows[0], { attendance: 1, pending: 1 })
      const pendingRequest = await pool.query(
        "SELECT status FROM login_requests WHERE id=$1",
        [pendingRequestId],
      )
      assert.equal(pendingRequest.rows[0].status, "pending")
    })

    test("student checkout uses its bound session, stores database time once, and appears in Admin attendance", async () => {
      registerNumber = "PGTEST1010"

      const student = await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2) RETURNING id",
        [registerNumber, "Checkout Test"],
      )

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      assert.equal(first.response.status, 201)
      assert.match(first.response.headers.get("set-cookie"), /HttpOnly/)
      attendanceId = first.payload.attendance.id

      const restored = await api("/api/attendance/session", {
        studentAuthenticated: true,
      })
      assert.equal(restored.response.status, 200)
      assert.equal(restored.payload.attendance.id, attendanceId)
      assert.equal(
        new Date(restored.payload.attendance.entryTime).getTime(),
        new Date(first.payload.attendance.markedAt).getTime(),
      )
      assert.equal(restored.payload.attendance.status, "present")

      const unauthorized = await api("/api/attendance/check-out", {
        method: "POST",
      })
      assert.equal(unauthorized.response.status, 401)

      const checkedOut = await api("/api/attendance/check-out", {
        method: "POST",
        studentAuthenticated: true,
      })
      assert.equal(checkedOut.response.status, 200)
      assert.equal(checkedOut.payload.attendance.id, attendanceId)
      assert.equal(checkedOut.payload.attendance.status, "completed")

      const saved = await pool.query(
        "SELECT id,entry_time,exit_time,status FROM attendance WHERE student_id=$1",
        [student.rows[0].id],
      )
      assert.equal(saved.rowCount, 1)
      assert.equal(Number(saved.rows[0].id), attendanceId)
      assert.equal(saved.rows[0].status, "completed")
      assert.ok(saved.rows[0].exit_time >= saved.rows[0].entry_time)
      assert.equal(
        new Date(checkedOut.payload.attendance.exitTime).getTime(),
        saved.rows[0].exit_time.getTime(),
      )

      const repeatedCheckout = await api("/api/attendance/check-out", {
        method: "POST",
        studentAuthenticated: true,
      })
      assert.equal(repeatedCheckout.response.status, 409)
      const unchanged = await pool.query(
        "SELECT exit_time FROM attendance WHERE id=$1",
        [attendanceId],
      )
      assert.equal(
        unchanged.rows[0].exit_time.getTime(),
        saved.rows[0].exit_time.getTime(),
      )

      const attendanceDate = await pool.query(
        "SELECT attendance_date FROM attendance WHERE id=$1",
        [attendanceId],
      )
      const adminRecords = await api(
        `/api/admin/attendance?date=${attendanceDate.rows[0].attendance_date}`,
        { authenticated: true },
      )
      const adminRow = adminRecords.payload.attendance.find(
        (row) => row.id === attendanceId,
      )
      assert.equal(adminRecords.response.status, 200)
      assert.ok(adminRow)
      assert.equal(adminRow.status, "completed")
      assert.equal(
        new Date(adminRow.exit_time).getTime(),
        saved.rows[0].exit_time.getTime(),
      )
    })

    test("concurrent student check-outs cannot overwrite the first exit time", async () => {
      registerNumber = "PGTEST1011"
      await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2)",
        [registerNumber, "Concurrent Checkout Test"],
      )
      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      const results = await Promise.all([
        api("/api/attendance/check-out", {
          method: "POST",
          studentAuthenticated: true,
        }),
        api("/api/attendance/check-out", {
          method: "POST",
          studentAuthenticated: true,
        }),
      ])
      assert.deepEqual(
        results.map((result) => result.response.status).sort(),
        [200, 409],
      )
      const row = await pool.query(
        "SELECT exit_time,status FROM attendance WHERE id=$1",
        [first.payload.attendance.id],
      )
      assert.equal(row.rows[0].status, "completed")
      const successfulResponse = results.find(
        (result) => result.response.status === 200,
      )
      assert.equal(
        new Date(successfulResponse.payload.attendance.exitTime).getTime(),
        row.rows[0].exit_time.getTime(),
      )
    })

    test("admin rejection preserves the active attendance entry for legacy requests", async () => {
      registerNumber = "PGTEST1003"

      const student = await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2) RETURNING id",
        [registerNumber, "Test Student"],
      )

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      const pendingRequestId = await createLegacyExitRequest(
        first.payload.attendance.id,
        student.rows[0].id,
      )

      const result = await api(
        `/api/admin/exit-requests/${pendingRequestId}/reject`,
        {
          method: "POST",

          authenticated: true,
        },
      )

      assert.equal(result.response.status, 200)

      const row = await pool.query(
        "SELECT exit_time,status FROM attendance WHERE student_id=$1",
        [student.rows[0].id],
      )

      assert.equal(row.rows[0].exit_time, null)

      assert.equal(row.rows[0].status, "present")

      const processedRequest = await pool.query(
        "SELECT status,processed_by,processed_at FROM login_requests WHERE id=$1",
        [pendingRequestId],
      )
      assert.equal(processedRequest.rows[0].status, "rejected")
      assert.ok(processedRequest.rows[0].processed_by)
      assert.ok(processedRequest.rows[0].processed_at)

      const requestList = await api("/api/admin/exit-requests", {
        authenticated: true,
      })
      const listedRequest = requestList.payload.requests.find(
        (item) => item.id === pendingRequestId,
      )
      assert.equal(listedRequest.status, "rejected")
      assert.ok(listedRequest.processed_at)
    })

    test("admin approval of a legacy request records an exit and subsequent check-in reuses the completed row", async () => {
      registerNumber = "PGTEST1004"

      await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2)",
        [registerNumber, "Test Student"],
      )

      const student = await pool.query(
        "SELECT id FROM students WHERE register_number=$1",
        [registerNumber],
      )

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      const pendingRequestId = await createLegacyExitRequest(
        first.payload.attendance.id,
        student.rows[0].id,
      )

      const result = await api(
        `/api/admin/exit-requests/${pendingRequestId}/approve`,
        {
          method: "POST",

          authenticated: true,
        },
      )

      assert.equal(result.response.status, 200)

      const row = await pool.query(
        "SELECT id,attendance_date,entry_time,exit_time,status FROM attendance WHERE student_id=$1",
        [student.rows[0].id],
      )

      assert.ok(row.rows[0].exit_time >= row.rows[0].entry_time)

      assert.equal(row.rows[0].status, "completed")

      const processedRequest = await pool.query(
        "SELECT status,processed_by,processed_at FROM login_requests WHERE id=$1",
        [pendingRequestId],
      )
      assert.equal(processedRequest.rows[0].status, "approved")
      assert.ok(processedRequest.rows[0].processed_by)
      assert.ok(processedRequest.rows[0].processed_at)

      const requestList = await api("/api/admin/exit-requests", {
        authenticated: true,
      })
      const listedRequest = requestList.payload.requests.find(
        (item) => item.id === pendingRequestId,
      )
      assert.equal(listedRequest.status, "approved")
      assert.equal(listedRequest.attendance_id, Number(row.rows[0].id))
      assert.ok(listedRequest.exit_time)

      const adminRecords = await api(
        `/api/admin/attendance?date=${row.rows[0].attendance_date}&search=${registerNumber}`,
        { authenticated: true },
      )
      assert.equal(adminRecords.response.status, 200)
      assert.equal(adminRecords.payload.attendance.length, 1)
      assert.equal(
        adminRecords.payload.attendance[0].id,
        Number(row.rows[0].id),
      )
      assert.equal(adminRecords.payload.attendance[0].status, "completed")
      assert.ok(adminRecords.payload.attendance[0].exit_time)

      const repeatedApproval = await api(
        `/api/admin/exit-requests/${pendingRequestId}/approve`,
        { method: "POST", authenticated: true },
      )
      assert.equal(repeatedApproval.response.status, 404)

      const subsequentCheckIn = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })
      assert.equal(subsequentCheckIn.response.status, 200)
      assert.equal(
        subsequentCheckIn.payload.attendance.status,
        "already_completed",
      )
      assert.equal(
        new Date(subsequentCheckIn.payload.attendance.exitTime).getTime(),
        row.rows[0].exit_time.getTime(),
      )
      assert.equal(
        (
          await pool.query(
            "SELECT COUNT(*)::int AS count FROM attendance WHERE student_id=$1",
            [student.rows[0].id],
          )
        ).rows[0].count,
        1,
      )
    })

    test("manual exit closes an active session and supersedes legacy pending requests", async () => {
      registerNumber = "PGTEST1005"

      const student = await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2) RETURNING id",

        [registerNumber, "Test Student"],
      )

      studentId = student.rows[0].id

      const first = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })

      attendanceId = first.payload.attendance.id
      const pendingRequestId = await createLegacyExitRequest(
        attendanceId,
        studentId,
      )

      const result = await api(
        `/api/admin/attendance/${attendanceId}/mark-exit`,
        {
          method: "POST",

          authenticated: true,
        },
      )

      assert.equal(result.response.status, 200)

      const request = await pool.query(
        "SELECT status FROM login_requests WHERE id=$1",
        [pendingRequestId],
      )

      assert.equal(request.rows[0].status, "rejected")

      const closedAttendance = await pool.query(
        "SELECT entry_time,exit_time,status FROM attendance WHERE id=$1",
        [attendanceId],
      )
      assert.ok(
        closedAttendance.rows[0].exit_time >=
          closedAttendance.rows[0].entry_time,
      )
      assert.equal(closedAttendance.rows[0].status, "completed")

      assert.equal(
        (
          await api(`/api/admin/attendance/${attendanceId}/mark-exit`, {
            method: "POST",
            authenticated: true,
          })
        ).response.status,
        404,
      )
    })

    test("attendance rollback keeps records out when a transaction-dependent write fails", async () => {
      registerNumber = "PGTEST1006"

      await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2)",
        [registerNumber, "Test Student"],
      )

      await pool.query(`
      CREATE FUNCTION fail_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected test failure'; END $$;
      CREATE TRIGGER fail_outbox BEFORE INSERT ON attendance_sync_outbox
      FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert();
    `)

      const result = await api("/api/attendance", {
        method: "POST",
        body: { registerNumber },
      })

      await pool.query(
        "DROP TRIGGER fail_outbox ON attendance_sync_outbox; DROP FUNCTION fail_outbox_insert()",
      )

      assert.equal(result.response.status, 500)

      const count = await pool.query(
        "SELECT COUNT(*)::int AS count FROM attendance",
      )

      assert.equal(count.rows[0].count, 0)
    })

    test("admin APIs and promotion management are protected while active promotions are public", async () => {
      assert.equal((await api("/api/admin/attendance")).response.status, 401)
      assert.equal((await api("/api/admin/promotions")).response.status, 401)
      assert.equal((await api("/api/admin/exit-requests")).response.status, 401)
      assert.equal((await api("/api/admin/leaves?month=2026-10")).response.status, 401)
      assert.equal(
        (
          await api(
            "/api/admin/reports/daily-attendance.xlsx?date=2026-10-15",
          )
        ).response.status,
        401,
      )
      assert.equal(
        (
          await api(
            "/api/admin/reports/month-end-attendance.xlsx?month=2026-10",
          )
        ).response.status,
        401,
      )
      assert.equal(
        (
          await api("/api/admin/leaves", {
            method: "POST",
            body: {
              date: "2026-10-15",
              scope: "staff",
              leaveType: "full_day",
              reason: "",
            },
          })
        ).response.status,
        401,
      )
      assert.equal(
        (
          await fetch(`${baseUrl}/api/admin/promotions`, {
            method: "POST",
            headers: {
              "X-Requested-With": "CSCAttendance",
              "Content-Type": "multipart/form-data; boundary=unused",
            },
          })

        ).status,
        401,
      )
      assert.equal(
        (
          await fetch(`${baseUrl}/api/admin/attendance/sync-retry`, {
            method: "POST",
            headers: { Cookie: cookie },
          })
        ).status,
        403,
      )
      const publicPromotions = await api("/api/promotions")
      assert.equal(publicPromotions.response.status, 200)
      assert.deepEqual(publicPromotions.payload.promotions, [])
    })

    test("student course and timing persist; monthly summaries exclude closures and approved leave", async () => {
      const created = await api("/api/students", {
        method: "POST",
        authenticated: true,
        body: {
          registerNumber: "PGCOURSE001",
          name: "Course Test",
          phoneNumber: "",
          address: "",
          course: "Office Automation",
          classTiming: "9:00 AM - 11:00 AM",
          active: true,
        },
      })
      assert.equal(created.response.status, 201)
      const id = created.payload.student.id
      assert.equal(created.payload.student.course, "Office Automation")
      assert.equal(created.payload.student.classTiming, "9:00 AM - 11:00 AM")

      const edited = await api(`/api/students/${id}`, {
        method: "PATCH",
        authenticated: true,
        body: {
          ...created.payload.student,
          course: "Web Development",
          classTiming: "1:00 PM - 3:00 PM",
        },
      })
      assert.equal(edited.response.status, 200)
      assert.equal(edited.payload.student.course, "Web Development")
      assert.equal(edited.payload.student.classTiming, "1:00 PM - 3:00 PM")
      await pool.query(
        "UPDATE students SET created_at='2020-01-01T00:00:00Z' WHERE id=$1",
        [id],
      )
      await pool.query(
        `INSERT INTO attendance(student_id,attendance_date,entry_time)
         VALUES($1,'2020-01-06',NOW())`,
        [id],
      )

      const closure = await api("/api/admin/calendar-events", {
        method: "POST",
        authenticated: true,
        body: {
          title: "Emergency closure",
          eventType: "emergency_leave",
          description: "Test closure",
          startDate: "2020-01-08",
          endDate: "2020-01-08",
          fullDay: true,
          startTime: null,
          endTime: null,
          affectsAttendance: true,
        },
      })
      assert.equal(closure.response.status, 201)
      const partial = await api("/api/admin/calendar-events", {
        method: "POST",
        authenticated: true,
        body: {
          title: "Partial event",
          eventType: "event",
          description: "",
          startDate: "2020-01-09",
          endDate: "2020-01-09",
          fullDay: false,
          startTime: "10:00",
          endTime: "12:00",
          affectsAttendance: false,
        },
      })
      assert.equal(partial.response.status, 201)
      assert.equal(partial.payload.event.startTime, "10:00:00")

      const overlap = await api("/api/admin/calendar-events", {
        method: "POST",
        authenticated: true,
        body: {
          title: "Duplicate closure",
          eventType: "csc_closed",
          description: "",
          startDate: "2020-01-08",
          endDate: "2020-01-10",
          fullDay: true,
          startTime: null,
          endTime: null,
          affectsAttendance: true,
        },
      })
      assert.equal(overlap.response.status, 409)
      assert.equal(overlap.payload.code, "CLOSURE_OVERLAP")

      const leave = await api(`/api/admin/students/${id}/leave`, {
        method: "POST",
        authenticated: true,
        body: { leaveDate: "2020-01-07" },
      })
      assert.equal(leave.response.status, 200)
      const summary = await api(
        "/api/admin/student-attendance-summary?month=2020-01",
        { authenticated: true },
      )
      const studentSummary = summary.payload.summaries.find(
        (item) => item.studentId === id,
      )
      assert.deepEqual(
        {
          presentDays: studentSummary.presentDays,
          absentDays: studentSummary.absentDays,
        },
        { presentDays: 1, absentDays: 20 },
      )
      const history = await api(
        `/api/admin/students/${id}/attendance?month=2020-01`,
        { authenticated: true },
      )
      assert.equal(history.response.status, 200)
      assert.deepEqual(history.payload.approvedLeaves, ["2020-01-07"])
      assert.equal(history.payload.attendance.length, 1)
      assert.equal(history.payload.attendance[0].exitTime, null)

      const events = await api(
        "/api/admin/calendar-events?month=2020-01",
        { authenticated: true },
      )
      assert.equal(events.payload.events.length, 2)
      const attendance = await pool.query(
        "SELECT COUNT(*)::int AS count FROM attendance WHERE student_id=$1",
        [id],
      )
      assert.equal(attendance.rows[0].count, 1)
    })

    test("scoped leave records persist, update, and remove without rewriting attendance", async () => {
      const student = await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2) RETURNING id",
        ["PGLEAVE0001", "Leave Test Student"],
      )
      const studentId = student.rows[0].id
      await pool.query(
        "UPDATE students SET created_at='2019-01-01T00:00:00Z' WHERE id=$1",
        [studentId],
      )
      await pool.query(
        `INSERT INTO attendance(student_id,attendance_date,entry_time)
         VALUES($1,'2020-02-03',NOW())`,
        [studentId],
      )

      const staffLeave = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-04",
          scope: "staff",
          leaveType: "full_day",
          reason: "Personal work",
        },
      })
      assert.equal(staffLeave.response.status, 201)
      assert.equal(staffLeave.payload.leave.affectsAttendance, false)
      assert.equal(staffLeave.payload.leave.createdByUsername, credentials.username)
      const updatedStaffLeave = await api(
        `/api/admin/leaves/${staffLeave.payload.leave.id}`,
        {
          method: "PUT",
          authenticated: true,
          body: {
            date: "2020-02-04",
            scope: "staff",
            leaveType: "full_day",
            reason: "Updated personal work",
          },
        },
      )
      assert.equal(updatedStaffLeave.response.status, 200)
      assert.equal(
        updatedStaffLeave.payload.leave.description,
        "Updated personal work",
      )

      const duplicate = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-04",
          scope: "staff",
          leaveType: "full_day",
          reason: "",
        },
      })
      assert.equal(duplicate.response.status, 409)
      assert.equal(duplicate.payload.code, "DUPLICATE_LEAVE")

      const classClosure = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-10",
          scope: "class_closed",
          leaveType: "full_day",
          reason: "Emergency closure",
        },
      })
      assert.equal(classClosure.response.status, 201)
      assert.equal(classClosure.payload.leave.affectsAttendance, true)
      const duplicateClosure = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-10",
          scope: "class_closed",
          leaveType: "full_day",
          reason: "",
        },
      })
      assert.equal(duplicateClosure.response.status, 409)

      const invalidPartial = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-11",
          scope: "class_closed",
          leaveType: "partial_time",
          startTime: "12:00",
          endTime: "10:00",
          reason: "",
        },
      })
      assert.equal(invalidPartial.response.status, 400)

      const partial = await api("/api/admin/leaves", {
        method: "POST",
        authenticated: true,
        body: {
          date: "2020-02-03",
          scope: "class_closed",
          leaveType: "partial_time",
          startTime: "10:00",
          endTime: "12:00",
          reason: "Maintenance",
        },
      })
      assert.equal(partial.response.status, 201)
      assert.equal(partial.payload.leave.affectsAttendance, false)
      const updated = await api(`/api/admin/leaves/${partial.payload.leave.id}`, {
        method: "PUT",
        authenticated: true,
        body: {
          date: "2020-02-03",
          scope: "class_closed",
          leaveType: "partial_time",
          startTime: "11:00",
          endTime: "12:30",
          reason: "Updated maintenance",
        },
      })
      assert.equal(updated.response.status, 200)
      assert.equal(updated.payload.leave.startTime, "11:00:00")

      const listed = await api("/api/admin/leaves?month=2020-02", {
        authenticated: true,
      })
      assert.equal(listed.payload.leaves.length, 3)
      const summary = await api(
        "/api/admin/student-attendance-summary?month=2020-02",
        { authenticated: true },
      )
      const studentSummary = summary.payload.summaries.find(
        (item) => item.studentId === studentId,
      )
      assert.deepEqual(
        {
          presentDays: studentSummary.presentDays,
          absentDays: studentSummary.absentDays,
          leaveDays: studentSummary.leaveDays,
        },
        { presentDays: 1, absentDays: 18, leaveDays: 1 },
      )
      const savedAttendance = await pool.query(
        "SELECT attendance_date,status FROM attendance WHERE student_id=$1",
        [studentId],
      )
      assert.equal(savedAttendance.rows.length, 1)
      assert.equal(savedAttendance.rows[0].status, "present")

      const workbook = await fetch(
        `${baseUrl}/api/admin/reports/monthly-attendance.xlsx?month=2020-02`,
        { headers: { Cookie: cookie, "X-Requested-With": "CSCAttendance" } },
      )
      assert.equal(workbook.status, 200)
      assert.match(workbook.headers.get("content-type"), /spreadsheetml\.sheet/)
      const workbookBytes = Buffer.from(await workbook.arrayBuffer())
      assert.equal(workbookBytes.readUInt32LE(0), 0x04034b50)

      const dailyWorkbook = await fetch(
        `${baseUrl}/api/admin/reports/daily-attendance.xlsx?date=2020-02-03`,
        { headers: { Cookie: cookie, "X-Requested-With": "CSCAttendance" } },
      )
      assert.equal(dailyWorkbook.status, 200)
      assert.equal(
        dailyWorkbook.headers.get("content-disposition"),
        'attachment; filename="CSC_Daily_Attendance_2020-02-03.xlsx"',
      )
      assert.match(
        dailyWorkbook.headers.get("content-type"),
        /spreadsheetml\.sheet/,
      )
      assert.equal(
        Buffer.from(await dailyWorkbook.arrayBuffer()).readUInt32LE(0),
        0x04034b50,
      )

      const monthEndWorkbook = await fetch(
        `${baseUrl}/api/admin/reports/month-end-attendance.xlsx?month=2020-02`,
        { headers: { Cookie: cookie, "X-Requested-With": "CSCAttendance" } },
      )
      assert.equal(monthEndWorkbook.status, 200)
      assert.equal(
        monthEndWorkbook.headers.get("content-disposition"),
        'attachment; filename="CSC_Monthly_Attendance_2020-02.xlsx"',
      )
      assert.match(
        monthEndWorkbook.headers.get("content-type"),
        /spreadsheetml\.sheet/,
      )
      assert.equal(
        Buffer.from(await monthEndWorkbook.arrayBuffer()).readUInt32LE(0),
        0x04034b50,
      )

      const removal = await api(
        `/api/admin/leaves/${classClosure.payload.leave.id}`,
        { method: "DELETE", authenticated: true },
      )
      assert.equal(removal.response.status, 200)
      const remaining = await pool.query(
        "SELECT COUNT(*)::int AS count FROM calendar_events WHERE leave_scope='class_closed' AND start_date='2020-02-10'",
      )
      assert.equal(remaining.rows[0].count, 0)
      const staffRemoval = await api(
        `/api/admin/leaves/${staffLeave.payload.leave.id}`,
        { method: "DELETE", authenticated: true },
      )
      assert.equal(staffRemoval.response.status, 200)
    })

    test("Cloudinary-backed promotion upload and replacement persist metadata only and cleanup old assets", async () => {
      const previousCloud = process.env.CLOUDINARY_CLOUD_NAME
      const previousKey = process.env.CLOUDINARY_API_KEY
      const previousSecret = process.env.CLOUDINARY_API_SECRET
      const originalUploadStream = cloudinary.uploader.upload_stream
      const originalDestroy = cloudinary.uploader.destroy
      const deletedAssets = []
      let uploaded = 0
      let failNextDelete = false
      process.env.CLOUDINARY_CLOUD_NAME = "test-cloud"
      process.env.CLOUDINARY_API_KEY = "test-key"
      process.env.CLOUDINARY_API_SECRET = "test-secret"
      cloudinary.uploader.upload_stream = (options, callback) => {
        void options
        return new Writable({
          write(_chunk, _encoding, done) {
            done()
          },
          final(done) {
          uploaded += 1
            callback(null, {
              secure_url: `https://res.cloudinary.com/test/image/upload/v1/asset-${uploaded}.png`,
              public_id: `asset-${uploaded}`,
            }),
            done()
          },
        })
      }
      cloudinary.uploader.destroy = async (publicId) => {
        deletedAssets.push(publicId)
        if (failNextDelete) {
          failNextDelete = false
          throw new Error("simulated provider deletion failure")
        }
        return { result: "ok" }
      }
      const uploadForm = () => {
        const form = new FormData()
        form.set(
          "image",
          new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png",
          }),
          "banner.png",
        )
        form.set("title", "Student login banner")
        return form
      }
      try {
        const firstResponse = await fetch(`${baseUrl}/api/admin/promotions`, {
          method: "POST",
          headers: {
            "X-Requested-With": "CSCAttendance",
            Cookie: cookie,
          },
          body: uploadForm(),
        })
        const first = await firstResponse.json()
        assert.equal(firstResponse.status, 201)
        assert.equal(first.promotion.source.includes("cloudinary.com"), true)
        assert.equal(first.promotion.title, "Student login banner")

        const publicPage = await api("/api/promotions")
        assert.equal(publicPage.response.status, 200)
        assert.equal(publicPage.payload.promotions[0].id, first.promotion.id)

        const workingUploadStream = cloudinary.uploader.upload_stream
        cloudinary.uploader.upload_stream = (_options, callback) =>
          new Writable({
            write(_chunk, _encoding, done) {
              done()
            },
            final(done) {
              callback(new Error("simulated provider failure"))
              done()
            },
          })
        const failedReplacement = await fetch(
          `${baseUrl}/api/admin/promotions/${first.promotion.id}`,
          {
            method: "PUT",
            headers: {
              "X-Requested-With": "CSCAttendance",
              Cookie: cookie,
            },
            body: uploadForm(),
          },
        )
        assert.equal(failedReplacement.status, 502)
        const unchanged = await pool.query(
          "SELECT image_url,cloudinary_public_id FROM promotional_images WHERE id=$1",
          [first.promotion.id],
        )
        assert.equal(unchanged.rows[0].cloudinary_public_id, "asset-1")
        assert.deepEqual(deletedAssets, [])
        cloudinary.uploader.upload_stream = workingUploadStream

        const replaceResponse = await fetch(
          `${baseUrl}/api/admin/promotions/${first.promotion.id}`,
          {
            method: "PUT",
            headers: {
              "X-Requested-With": "CSCAttendance",
              Cookie: cookie,
            },
            body: uploadForm(),
          },
        )
        const replacement = await replaceResponse.json()
        assert.equal(replaceResponse.status, 200)
        assert.notEqual(replacement.promotion.source, first.promotion.source)
        assert.deepEqual(deletedAssets, ["asset-1"])

        const stored = await pool.query(
          "SELECT image_url,cloudinary_public_id FROM promotional_images WHERE id=$1",
          [first.promotion.id],
        )
        assert.equal(stored.rows[0].cloudinary_public_id, "asset-2")
        assert.equal(stored.rows[0].image_url, replacement.promotion.source)

        failNextDelete = true
        const removal = await fetch(
          `${baseUrl}/api/admin/promotions/${first.promotion.id}`,
          {
            method: "DELETE",
            headers: {
              "X-Requested-With": "CSCAttendance",
              Cookie: cookie,
            },
          },
        )
        assert.equal(removal.status, 200)
        const pendingCleanup = await pool.query(
          "SELECT attempts FROM cloudinary_asset_cleanup WHERE public_id='asset-2'",
        )
        assert.equal(pendingCleanup.rows[0].attempts, 1)

        await pool.query(
          "UPDATE cloudinary_asset_cleanup SET next_attempt_at=NOW() WHERE public_id='asset-2'",
        )
        await processCloudinaryCleanup(pool)
        assert.deepEqual(deletedAssets, ["asset-1", "asset-2", "asset-2"])
        assert.equal(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS count FROM cloudinary_asset_cleanup",
            )
          ).rows[0].count,
          0,
        )
      } finally {
        cloudinary.uploader.upload_stream = originalUploadStream
        cloudinary.uploader.destroy = originalDestroy
        if (previousCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME
        else process.env.CLOUDINARY_CLOUD_NAME = previousCloud
        if (previousKey === undefined) delete process.env.CLOUDINARY_API_KEY
        else process.env.CLOUDINARY_API_KEY = previousKey
        if (previousSecret === undefined) delete process.env.CLOUDINARY_API_SECRET
        else process.env.CLOUDINARY_API_SECRET = previousSecret
      }
    })

    test("invalid report dates and reversed date ranges are rejected", async () => {
      const invalidDate = await api("/api/admin/attendance?date=2026-02-30", {
        authenticated: true,
      })
      assert.equal(invalidDate.response.status, 400)
      const reversed = await api(
        "/api/admin/attendance?from=2026-10-12&to=2026-10-11",
        { authenticated: true },
      )
      assert.equal(reversed.response.status, 400)
    })

    test("failed Sheets sync is retried without rolling back PostgreSQL attendance", async () => {
      registerNumber = "PGTEST1007"

      await pool.query(
        "INSERT INTO students(register_number,name) VALUES($1,$2)",
        [registerNumber, "Test Student"],
      )

      await api("/api/attendance", { method: "POST", body: { registerNumber } })

      const record = await pool.query(
        "SELECT to_char(attendance_date,'YYYY-MM') AS month FROM attendance",
      )

      const date = record.rows[0].month

      await pool.query(
        "INSERT INTO spreadsheet_config(month_key,spreadsheet_id) VALUES($1,'test-sheet')",
        [date],
      )

      const previousEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL

      const previousKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY

      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL =
        "integration-test@example.invalid"

      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "not-a-private-key"

      try {
        await processSyncQueue(pool)
      } finally {
        if (previousEmail === undefined)
          delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
        else process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = previousEmail

        if (previousKey === undefined)
          delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
        else process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = previousKey
      }

      const result = await pool.query(
        `SELECT a.id,o.attempts,o.last_error,o.synced_at
       FROM attendance a JOIN attendance_sync_outbox o ON o.attendance_id=a.id`,
      )

      assert.equal(result.rowCount, 1)

      assert.equal(result.rows[0].attempts, 1)

      assert.ok(result.rows[0].last_error)

      assert.equal(result.rows[0].synced_at, null)
    })

    test("admin logout revokes the database session and expires its cookie", async () => {
      const logout = await api("/api/admin/logout", {
        method: "POST",
        authenticated: true,
      })
      assert.equal(logout.response.status, 200)
      assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/)
      assert.equal(
        (await api("/api/admin/session", { authenticated: true })).response.status,
        401,
      )
    })
  },
)

if (configuredUrl && !testDatabaseIsExplicit) {
  test("PostgreSQL integration tests require TEST_DATABASE_URL to name a dedicated test database", () => {
    assert.fail(
      "Refusing to run PostgreSQL integration tests unless the database name includes 'test'.",
    )
  })
}
