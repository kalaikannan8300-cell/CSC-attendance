import { createHash, createSign, randomBytes } from "node:crypto"

import { createReadStream } from "node:fs"

import { readFile, stat } from "node:fs/promises"

import { createServer } from "node:http"

import { extname, join, resolve, sep } from "node:path"

import { pathToFileURL } from "node:url"

import pg from "pg"

import { passwordHash, verifyPassword } from "./admin-password.mjs"
import { businessDate } from "./business-date.mjs"
import { cloudinaryDelete, cloudinaryUpload } from "./cloudinary-storage.mjs"
import { buildDailyAttendanceDashboard } from "./daily-attendance-dashboard.mjs"
import { validateLeaveInput } from "./leave-management.mjs"
import { calculateMonthlySummaries } from "./monthly-summary.mjs"
import {
  buildMonthlyReportData,
  createDailyAttendanceWorkbook,
  createMonthlyAttendanceWorkbook,
  createMonthEndAttendanceWorkbook,
  validateReportDate,
  validateReportMonth,
} from "./monthly-excel-report.mjs"
import {
  MAX_IMAGE_BYTES,
  assertActivePromotionCapacity,
  validatePromotionImage,
} from "./promotion-image.mjs"

const { Pool } = pg

// PostgreSQL DATE values are calendar dates, not instants; preserve their ISO date strings.
pg.types.setTypeParser(1082, (value) => value)

const SESSION_HOURS = 8

const STUDENT_SESSION_HOURS = 12

const MAX_JSON_BYTES = 1024 * 1024

const hash = (value) => createHash("sha256").update(value).digest("hex")

const base64url = (value) => Buffer.from(value).toString("base64url")

function send(res, status, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",

    ...extra,
  })

  res.end(JSON.stringify(body))
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

async function readBody(req, limit) {
  const chunks = []

  let size = 0

  for await (const chunk of req) {
    size += chunk.length

    if (size > limit)
      throw httpError(413, "BODY_TOO_LARGE", "Request body is too large.")

    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function bodyJson(req) {
  let value

  try {
    value = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8"))
  } catch (error) {
    if (error.status) throw error

    throw httpError(400, "INVALID_JSON", "A valid JSON object is required.")
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "INVALID_JSON", "A valid JSON object is required.")
  }

  return value
}

function readCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))

      .filter(([key, value]) => key && value)

      .map(([key, ...value]) => [key, value.join("=")]),
  )
}

function requiredString(object, key, label, max = 500, optional = false) {
  const value = typeof object[key] === "string" ? object[key].trim() : ""

  if (!value && !optional)
    throw httpError(400, "VALIDATION_ERROR", `${label} is required.`)

  if (value.length > max)
    throw httpError(
      400,
      "VALIDATION_ERROR",
      `${label} must be ${max} characters or fewer.`,
    )

  return value
}

function parseDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(
      400,
      "VALIDATION_ERROR",
      `${label} must use YYYY-MM-DD format.`,
    )
  }

  const date = new Date(`${value}T00:00:00.000Z`)

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw httpError(
      400,
      "VALIDATION_ERROR",
      `${label} is not a valid calendar date.`,
    )
  }

  return value
}

function publicStudent(row) {
  return {
    id: Number(row.id),

    registerNumber: row.register_number,

    name: row.name,

    phoneNumber: row.phone_number,

    address: row.address,

    course: row.course ?? "",

    classTiming: row.class_timing ?? "",

    active: row.active,
  }
}

function publicCalendarEvent(row) {
  return {
    id: Number(row.id),
    title: row.title,
    eventType: row.event_type,
    description: row.description,
    startDate: String(row.start_date).slice(0, 10),
    endDate: String(row.end_date).slice(0, 10),
    fullDay: row.full_day,
    startTime: row.start_time,
    endTime: row.end_time,
    affectsAttendance: row.affects_attendance,
    leaveScope: row.leave_scope ?? null,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function validateCalendarEvent(body) {
  const eventType = requiredString(body, "eventType", "Event type", 40)
  if (!["public_holiday", "csc_closed", "emergency_leave", "event", "other"].includes(eventType)) {
    throw httpError(400, "VALIDATION_ERROR", "Choose a valid event type.")
  }
  if (typeof body.fullDay !== "boolean" || typeof body.affectsAttendance !== "boolean") {
    throw httpError(400, "VALIDATION_ERROR", "Choose the event duration and attendance impact.")
  }
  if (!body.fullDay && body.affectsAttendance) {
    throw httpError(400, "VALIDATION_ERROR", "Partial-day events cannot exclude an entire day from attendance.")
  }
  const event = {
    title: requiredString(body, "title", "Title", 200),
    eventType,
    description: requiredString(body, "description", "Description", 1000, true),
    startDate: parseDate(body.startDate, "Start date"),
    endDate: parseDate(body.endDate, "End date"),
    fullDay: body.fullDay,
    startTime: body.fullDay ? null : requiredString(body, "startTime", "Start time", 5),
    endTime: body.fullDay ? null : requiredString(body, "endTime", "End time", 5),
    affectsAttendance: body.affectsAttendance,
  }
  if (event.endDate < event.startDate)
    throw httpError(400, "VALIDATION_ERROR", "End date must not be before start date.")
  if (!event.fullDay) {
    const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    if (!validTime(event.startTime) || !validTime(event.endTime) || event.endTime <= event.startTime)
      throw httpError(400, "VALIDATION_ERROR", "Provide a valid partial-day time range.")
  }
  return event
}

async function saveCalendarEvent(pool, id, event) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    if (event.fullDay && event.affectsAttendance) {
      await client.query("SELECT pg_advisory_xact_lock(8193)")
      const overlap = await client.query(
        `SELECT id FROM calendar_events
         WHERE affects_attendance=TRUE AND full_day=TRUE
           AND start_date <= $2::date AND end_date >= $1::date
           AND ($3::bigint IS NULL OR id <> $3)
         LIMIT 1 FOR UPDATE`,
        [event.startDate, event.endDate, id],
      )
      if (overlap.rowCount) {
        throw httpError(
          409,
          "CLOSURE_OVERLAP",
          "An attendance-affecting full-day closure already overlaps these dates.",
        )
      }
    }
    const values = [
      event.title,
      event.eventType,
      event.description,
      event.startDate,
      event.endDate,
      event.fullDay,
      event.startTime,
      event.endTime,
      event.affectsAttendance,
    ]
    const result = id
      ? await client.query(
          `UPDATE calendar_events SET title=$1,event_type=$2,description=$3,
           start_date=$4,end_date=$5,full_day=$6,start_time=$7,end_time=$8,
           affects_attendance=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
          [...values, id],
        )
      : await client.query(
          `INSERT INTO calendar_events(title,event_type,description,start_date,end_date,
           full_day,start_time,end_time,affects_attendance)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          values,
        )
    await client.query("COMMIT")
    return result.rows[0] ?? null
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

async function saveLeave(pool, id, leave, adminId) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(8193)")

    if (id) {
      const existing = await client.query(
        "SELECT id FROM calendar_events WHERE id=$1 AND leave_scope IS NOT NULL FOR UPDATE",
        [id],
      )
      if (!existing.rowCount) {
        throw httpError(404, "LEAVE_NOT_FOUND", "Leave record not found.")
      }
    }

    if (leave.affectsAttendance) {
      const overlap = await client.query(
        `SELECT id FROM calendar_events
         WHERE affects_attendance=TRUE AND full_day=TRUE
           AND start_date <= $1::date AND end_date >= $1::date
           AND ($2::bigint IS NULL OR id <> $2)
         LIMIT 1 FOR UPDATE`,
        [leave.date, id],
      )
      if (overlap.rowCount) {
        throw httpError(
          409,
          "CLOSURE_OVERLAP",
          "A full-day class closure already covers this date.",
        )
      }
    }

    const values = [
      leave.scope === "staff" ? "Staff/Admin leave" : "Class closed",
      leave.scope === "staff" ? "emergency_leave" : "csc_closed",
      leave.reason,
      leave.date,
      leave.fullDay,
      leave.startTime,
      leave.endTime,
      leave.affectsAttendance,
      leave.scope,
      adminId,
    ]
    const result = id
      ? await client.query(
          `UPDATE calendar_events SET title=$1,event_type=$2,description=$3,
           start_date=$4,end_date=$4,full_day=$5,start_time=$6,end_time=$7,
           affects_attendance=$8,leave_scope=$9,updated_at=NOW()
           WHERE id=$10 AND leave_scope IS NOT NULL RETURNING *`,
          [...values.slice(0, 9), id],
        )
      : await client.query(
          `INSERT INTO calendar_events(title,event_type,description,start_date,end_date,
           full_day,start_time,end_time,affects_attendance,leave_scope,created_by)
           VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          values,
        )

    await client.query("COMMIT")
    return result.rows[0] ?? null
  } catch (error) {
    await client.query("ROLLBACK")
    if (error.code === "23505") {
      throw httpError(
        409,
        "DUPLICATE_LEAVE",
        "A leave record already exists for this date and scope.",
      )
    }
    throw error
  } finally {
    client.release()
  }
}

function publicPromotion(row) {
  return {
    id: Number(row.id),

    source: row.image_url,

    title: row.title,

    displayOrder: row.display_order,

    enabled: row.enabled,
  }
}

function requireCsrf(req) {
  if (req.headers["x-requested-with"] !== "CSCAttendance") {
    throw httpError(403, "CSRF_REJECTED", "Request verification failed.")
  }
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i
    .exec(contentType)
    ?.slice(1)
    .find(Boolean)

  if (!boundary)
    throw httpError(
      400,
      "INVALID_UPLOAD",
      "A multipart image upload is required.",
    )

  const marker = Buffer.from(`--${boundary}`)

  const fields = new Map()

  let cursor = 0

  while (cursor < buffer.length) {
    const start = buffer.indexOf(marker, cursor)

    if (start < 0) break

    let partStart = start + marker.length

    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from("--")))
      break

    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from("\r\n")))
      partStart += 2

    const headersEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart)

    if (headersEnd < 0)
      throw httpError(
        400,
        "INVALID_UPLOAD",
        "Malformed multipart image upload.",
      )

    const next = buffer.indexOf(marker, headersEnd + 4)

    if (next < 0)
      throw httpError(
        400,
        "INVALID_UPLOAD",
        "Malformed multipart image upload.",
      )

    let partEnd = next

    if (buffer.subarray(partEnd - 2, partEnd).equals(Buffer.from("\r\n")))
      partEnd -= 2

    const headers = buffer.subarray(partStart, headersEnd).toString("latin1")

    const name = /content-disposition:[^\r\n]*\bname="([^"]+)"/i.exec(
      headers,
    )?.[1]

    if (name) {
      const filename = /content-disposition:[^\r\n]*\bfilename="([^"]*)"/i.exec(
        headers,
      )?.[1]

      fields.set(name, {
        filename,

        contentType: /content-type:\s*([^\r\n]+)/i
          .exec(headers)?.[1]
          ?.trim()
          .toLowerCase(),

        data: buffer.subarray(headersEnd + 4, partEnd),
      })
    }

    cursor = next
  }

  return fields
}

let googleToken

let googleTokenExpiresAt = 0

async function googleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL

  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  )

  if (!email || !privateKey)
    throw new Error("Google Sheets service account is not configured.")

  if (googleToken && googleTokenExpiresAt > Date.now() + 60000)
    return googleToken

  const now = Math.floor(Date.now() / 1000)

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))

  const claim = base64url(
    JSON.stringify({
      iss: email,

      scope: "https://www.googleapis.com/auth/spreadsheets",

      aud: "https://oauth2.googleapis.com/token",

      iat: now,

      exp: now + 3600,
    }),
  )

  const unsigned = `${header}.${claim}`

  const signer = createSign("RSA-SHA256")

  signer.update(unsigned)

  const assertion = `${unsigned}.${signer.sign(privateKey, "base64url")}`

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",

    headers: { "Content-Type": "application/x-www-form-urlencoded" },

    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",

      assertion,
    }),

    signal: AbortSignal.timeout(15000),
  })

  const result = await response.json()

  if (!response.ok || !result.access_token)
    throw new Error(
      `Google token request failed with status ${response.status}.`,
    )

  googleToken = result.access_token

  googleTokenExpiresAt = Date.now() + Number(result.expires_in ?? 3600) * 1000

  return googleToken
}

async function sheetsRequest(spreadsheetId, path, options = {}) {
  const token = await googleAccessToken()

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${path}`,
    {
      ...options,

      headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },

      signal: AbortSignal.timeout(20000),
    },
  )

  if (!response.ok) {
    const message = (await response.text()).slice(0, 300)

    throw new Error(
      `Google Sheets request failed (${response.status}): ${message}`,
    )
  }

  return response.status === 204 ? null : response.json()
}

async function syncAttendance(pool, job) {
  const rowResult = await pool.query(
    `SELECT a.id, a.attendance_date, a.entry_time, a.exit_time, a.status,
            s.register_number, s.name, c.spreadsheet_id
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     JOIN spreadsheet_config c ON c.month_key = to_char(a.attendance_date, 'YYYY-MM')
     WHERE a.id = $1`,

    [job.attendance_id],
  )

  if (!rowResult.rowCount) return false

  const row = rowResult.rows[0]

  const sheetPath = "/values/A:G?majorDimension=COLUMNS"

  const columns = await sheetsRequest(row.spreadsheet_id, sheetPath)

  const ids = columns.values?.[0] ?? []

  const existingIndex = ids.findIndex((id) => String(id) === String(row.id))

  const hasHeader = ["id", "attendance_id", "attendance id"].includes(
    String(ids[0] ?? "")
      .trim()
      .toLowerCase(),
  )

  const values = [
    [
      row.id,

      String(row.attendance_date),

      row.register_number,

      row.name,

      row.entry_time.toISOString(),

      row.exit_time?.toISOString() ?? "",

      row.status,
    ],
  ]

  if (ids.length === 0) {
    await sheetsRequest(
      row.spreadsheet_id,
      "/values/A:G:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
      {
        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({
          values: [
            [
              "Attendance ID",
              "Date",
              "Register Number",
              "Name",
              "Entry Time",
              "Exit Time",
              "Status",
            ],
          ],
        }),
      },
    )
  }

  if (existingIndex >= 0) {
    const rowNumber = existingIndex + 1

    await sheetsRequest(
      row.spreadsheet_id,
      `/values/A${rowNumber}:G${rowNumber}?valueInputOption=RAW`,
      {
        method: "PUT",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ values }),
      },
    )
  } else {
    if (!hasHeader && ids.length > 0 && ids[0] !== undefined) {
      console.warn(
        `Google Sheet ${row.spreadsheet_id} has no attendance header row; values will be appended below existing rows.`,
      )
    }

    await sheetsRequest(
      row.spreadsheet_id,
      "/values/A:G:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
      {
        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ values }),
      },
    )
  }

  await pool.query(
    "UPDATE attendance_sync_outbox SET synced_at=NOW(),locked_until=NULL,last_error=NULL WHERE id=$1",
    [job.id],
  )

  return true
}

export async function processSyncQueue(pool) {
  const client = await pool.connect()

  let job

  try {
    await client.query("BEGIN")

    const result = await client.query(
      `SELECT o.id, o.attendance_id, o.attempts
       FROM attendance_sync_outbox o
       JOIN attendance a ON a.id = o.attendance_id
       JOIN spreadsheet_config c ON c.month_key = to_char(a.attendance_date, 'YYYY-MM')
       WHERE o.synced_at IS NULL AND o.next_attempt_at <= NOW()
         AND (o.locked_until IS NULL OR o.locked_until < NOW())
       ORDER BY o.id LIMIT 1
       FOR UPDATE OF o SKIP LOCKED`,
    )

    job = result.rows[0]

    if (!job) {
      await client.query("COMMIT")

      return false
    }

    await client.query(
      "UPDATE attendance_sync_outbox SET locked_until=NOW()+INTERVAL '2 minutes' WHERE id=$1",

      [job.id],
    )

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")

    throw error
  } finally {
    client.release()
  }

  try {
    await syncAttendance(pool, job)
  } catch (error) {
    const delaySeconds = Math.min(
      3600,
      30 * 2 ** Math.min(Number(job.attempts ?? 0), 7),
    )

    console.error(
      `Google Sheets sync failed for attendance ${job.attendance_id}:`,
      error.message,
    )

    await pool.query(
      `UPDATE attendance_sync_outbox
       SET attempts=attempts+1, next_attempt_at=NOW()+($2 * INTERVAL '1 second'),
           locked_until=NULL, last_error=$3
       WHERE id=$1`,

      [job.id, delaySeconds, String(error.message).slice(0, 1000)],
    )
  }

  return true
}

function startSyncWorker(pool) {
  let running = false

  const timer = setInterval(async () => {
    if (running) return

    running = true

    try {
      for (
        let count = 0;
        count < 10 && (await processSyncQueue(pool));
        count += 1
      ) {}
    } catch (error) {
      console.error("Attendance sync worker failed:", error.message)
    } finally {
      running = false
    }
  }, 15000)

  timer.unref()

  return timer
}

async function queueCloudinaryCleanup(pool, publicId) {
  await pool.query(
    `INSERT INTO cloudinary_asset_cleanup(public_id)
     VALUES($1) ON CONFLICT(public_id) DO NOTHING`,
    [publicId],
  )
}

export async function processCloudinaryCleanup(pool) {
  const client = await pool.connect()
  let transactionOpen = false

  try {
    await client.query("BEGIN")
    transactionOpen = true
    await client.query("SELECT pg_advisory_xact_lock(8192)")

    const queued = await client.query(
      `SELECT public_id,attempts FROM cloudinary_asset_cleanup
       WHERE next_attempt_at<=NOW() ORDER BY created_at
       LIMIT 1 FOR UPDATE`,
    )

    if (!queued.rowCount) {
      await client.query("COMMIT")
      transactionOpen = false
      return false
    }

    const { public_id: publicId, attempts } = queued.rows[0]
    const references = await client.query(
      "SELECT COUNT(*)::int AS count FROM promotional_images WHERE cloudinary_public_id=$1",
      [publicId],
    )

    if (references.rows[0].count > 0) {
      await client.query(
        "DELETE FROM cloudinary_asset_cleanup WHERE public_id=$1",
        [publicId],
      )
    } else {
      try {
        await cloudinaryDelete(publicId)
        await client.query(
          "DELETE FROM cloudinary_asset_cleanup WHERE public_id=$1",
          [publicId],
        )
      } catch (error) {
        const delaySeconds = Math.min(
          60 * 60,
          30 * 2 ** Math.min(Number(attempts), 7),
        )
        await client.query(
          `UPDATE cloudinary_asset_cleanup
           SET attempts=attempts+1,
               next_attempt_at=NOW()+($2 * INTERVAL '1 second'),
               last_error=$3
           WHERE public_id=$1`,
          [publicId, delaySeconds, String(error.message).slice(0, 1000)],
        )
        console.error(
          `Cloudinary cleanup failed for ${publicId}:`,
          error.message,
        )
        await client.query("COMMIT")
        transactionOpen = false
        return false
      }
    }

    await client.query("COMMIT")
    transactionOpen = false
    return true
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK")
      } catch {
        console.error("Unable to roll back Cloudinary cleanup transaction.")
      }
    }
    throw error
  } finally {
    client.release()
  }
}

function startCloudinaryCleanupWorker(pool) {
  let running = false

  const timer = setInterval(async () => {
    if (running) return
    running = true

    try {
      for (
        let count = 0;
        count < 10 && (await processCloudinaryCleanup(pool));
        count += 1
      ) {}
    } catch (error) {
      console.error("Cloudinary cleanup worker failed:", error.message)
    } finally {
      running = false
    }
  }, 15000)

  timer.unref()
  return timer
}

async function loadMonthlyAttendanceReport(pool, month) {
  const { startDate, endDate } = validateReportMonth(month)
  const today = businessDate()
  let results
  try {
    results = await Promise.all([
      pool.query(
        `SELECT id,register_number,name,course,active,created_at
         FROM students`,
      ),
      pool.query(
        `SELECT a.student_id,s.register_number,s.name,s.course,
                a.attendance_date,a.entry_time,a.exit_time,a.status
         FROM attendance a JOIN students s ON s.id=a.student_id
         WHERE a.attendance_date >= $1::date AND a.attendance_date <= $2::date`,
        [startDate, endDate],
      ),
      pool.query(
        `SELECT start_date,end_date,full_day,start_time,end_time,
                affects_attendance,leave_scope,description,title
         FROM calendar_events
         WHERE start_date <= $2::date AND end_date >= $1::date`,
        [startDate, endDate],
      ),
      pool.query(
        `SELECT student_id,leave_date
         FROM approved_student_leaves
         WHERE leave_date >= $1::date AND leave_date <= $2::date`,
        [startDate, endDate],
      ),
      pool.query("SELECT working_days FROM attendance_calendar_settings WHERE id=1"),
    ])
  } catch (error) {
    const connectionCodes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "57P01",
      "57P03",
    ])
    if (
      typeof error.code === "string" &&
      (error.code.startsWith("08") || connectionCodes.has(error.code))
    ) {
      throw Object.assign(
        httpError(
          503,
          "DATABASE_UNAVAILABLE",
          "Attendance data is temporarily unavailable. Please try again.",
        ),
        { cause: error },
      )
    }
    throw error
  }

  const [
    studentsResult,
    attendanceResult,
    eventsResult,
    leavesResult,
    settingsResult,
  ] = results

  return buildMonthlyReportData({
    month,
    today,
    students: studentsResult.rows,
    attendance: attendanceResult.rows,
    events: eventsResult.rows,
    approvedLeaves: leavesResult.rows,
    workingDays: settingsResult.rows[0]?.working_days ?? [1, 2, 3, 4, 5],
  })
}

function studentSessionCookie(sessionToken) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `csc_student_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${STUDENT_SESSION_HOURS * 60 * 60}${secure}`
}

async function createStudentSession(
  client,
  studentId,
  attendanceId,
  secondCheckinId = null,
) {
  const sessionToken = randomBytes(32).toString("base64url")

  await client.query("DELETE FROM student_sessions WHERE expires_at<=NOW()")
  await client.query(
    `INSERT INTO student_sessions(
       token_hash,student_id,attendance_id,second_checkin_id,expires_at
     ) VALUES($1,$2,$3,$4,NOW()+($5 * INTERVAL '1 hour'))`,
    [
      hash(sessionToken),
      studentId,
      attendanceId,
      secondCheckinId,
      STUDENT_SESSION_HOURS,
    ],
  )

  return studentSessionCookie(sessionToken)
}

export function createPostgresApiServer({
  connectionString = process.env.DATABASE_URL,

  adminUsername = process.env.ADMIN_USERNAME,

  adminPassword = process.env.ADMIN_PASSWORD,

  pool: suppliedPool,

  startWorker = true,
} = {}) {
  if (!suppliedPool && !connectionString) {
    throw new Error(
      "DATABASE_URL is required. Add your Neon PostgreSQL connection string to .env.",
    )
  }

  if (!adminUsername || !adminPassword || adminPassword.length < 16) {
    throw new Error(
      "Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 16 characters in .env.",
    )
  }

  const pool =
    suppliedPool ??
    new Pool({
      connectionString,

      ssl: connectionString.includes("localhost")
        ? false
        : { rejectUnauthorized: true },

      max: 10,

      idleTimeoutMillis: 30000,

      connectionTimeoutMillis: 10000,
    })
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      const code = error.code ? ` (${error.code})` : ""
      console.error(`PostgreSQL connection was interrupted${code}.`)
    })
  })
  pool.on("error", (error) => {
    const code = error.code ? ` (${error.code})` : ""
    console.error(`Idle PostgreSQL connection failed${code}.`)
  })
  const workers = startWorker
    ? [startSyncWorker(pool), startCloudinaryCleanupWorker(pool)]
    : []

  const loginAttempts = new Map()

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")

      if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res)

      if (req.method === "GET" && url.pathname === "/api/health") {
        await pool.query("SELECT 1")

        return send(res, 200, { status: "ok", database: "postgresql" })
      }

      const token = readCookies(req.headers.cookie).csc_admin_session

      const tokenHash = token ? hash(token) : null
      const studentSessionToken = readCookies(
        req.headers.cookie,
      ).csc_student_session
      const studentSessionHash = studentSessionToken
        ? hash(studentSessionToken)
        : null

      let admin = null

      if (tokenHash) {
        const result = await pool.query(
          `SELECT a.id, a.username FROM admin_sessions s
           JOIN admins a ON a.id=s.admin_id
           WHERE s.token_hash=$1 AND s.expires_at>NOW() AND a.is_active=TRUE`,

          [tokenHash],
        )

        admin = result.rows[0] ?? null
      }

      if (req.method === "POST" && url.pathname === "/api/admin/login") {
        requireCsrf(req)

        const body = await bodyJson(req)

        const username = requiredString(body, "username", "Staff ID", 200)

        const password = requiredString(body, "password", "Password", 500)

        const clientIp = req.socket.remoteAddress ?? "unknown"

        const attemptWindow = loginAttempts.get(clientIp)

        if (
          attemptWindow &&
          Date.now() - attemptWindow.startedAt < 15 * 60 * 1000 &&
          attemptWindow.count >= 10
        ) {
          return send(res, 429, {
            error: "Too many sign-in attempts. Try again in 15 minutes.",
            code: "LOGIN_RATE_LIMITED",
          })
        }

        const result = await pool.query(
          "SELECT id, password_hash FROM admins WHERE lower(username)=lower($1) AND is_active=TRUE",

          [username],
        )

        if (
          !result.rowCount ||
          !verifyPassword(password, result.rows[0].password_hash)
        ) {
          if (
            !attemptWindow ||
            Date.now() - attemptWindow.startedAt >= 15 * 60 * 1000
          ) {
            loginAttempts.set(clientIp, { count: 1, startedAt: Date.now() })
          } else {
            attemptWindow.count += 1
          }

          return send(res, 401, {
            error: "Staff ID or password is incorrect.",
            code: "INVALID_CREDENTIALS",
          })
        }

        loginAttempts.delete(clientIp)

        const sessionToken = randomBytes(32).toString("base64url")

        await pool.query(
          "INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '8 hours')",

          [hash(sessionToken), result.rows[0].id],
        )

        const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""

        return send(res, 200, { authenticated: true }, {
          "Set-Cookie": `csc_admin_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
        })
      }

      if (req.method === "GET" && url.pathname === "/api/admin/session") {
        return admin
          ? send(res, 200, { authenticated: true })
          : send(res, 401, {
              authenticated: false,
              error: "Admin sign-in is required.",
            })
      }

      if (req.method === "POST" && url.pathname === "/api/admin/logout") {
        requireCsrf(req)

        if (tokenHash)
          await pool.query("DELETE FROM admin_sessions WHERE token_hash=$1", [
            tokenHash,
          ])

        return send(res, 200, { authenticated: false }, {
          "Set-Cookie":
            "csc_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        })
      }

      if (req.method === "GET" && url.pathname === "/api/attendance/session") {
        if (!studentSessionHash) {
          return send(res, 401, {
            error: "Student check-in is required.",
            code: "STUDENT_SESSION_REQUIRED",
          })
        }

        const result = await pool.query(
          `SELECT COALESCE(sc.id,a.id) AS id,
                  COALESCE(sc.entry_time,a.entry_time) AS entry_time,
                  CASE WHEN ss.second_checkin_id IS NOT NULL
                    THEN sc.exit_time ELSE a.exit_time END AS exit_time,
                  CASE WHEN ss.second_checkin_id IS NOT NULL
                    THEN CASE WHEN sc.exit_time IS NULL THEN 'present' ELSE 'completed' END
                    ELSE a.status END AS status,
                  second_request.status AS second_checkin_status,
                  second_request.requested_at AS second_checkin_requested_at
           FROM student_sessions ss
           JOIN students s ON s.id=ss.student_id
           JOIN attendance a ON a.id=ss.attendance_id
           LEFT JOIN attendance_second_checkins sc
             ON sc.id=ss.second_checkin_id AND sc.student_id=ss.student_id
           LEFT JOIN LATERAL (
             SELECT status,requested_at
             FROM second_checkin_requests
             WHERE student_id=ss.student_id
               AND attendance_date=$2::date
             ORDER BY id DESC
             LIMIT 1
           ) second_request ON TRUE
           WHERE ss.token_hash=$1 AND ss.expires_at>NOW()
             AND a.student_id=ss.student_id`,
          [studentSessionHash, businessDate()],
        )

        if (!result.rowCount) {
          return send(res, 401, {
            error: "Student check-in is required.",
            code: "STUDENT_SESSION_REQUIRED",
          })
        }

        return send(res, 200, {
          attendance: {
            id: Number(result.rows[0].id),
            entryTime: result.rows[0].entry_time,
            exitTime: result.rows[0].exit_time,
            status: result.rows[0].status,
          },
          secondCheckInRequest: result.rows[0].second_checkin_status
            ? {
                status: result.rows[0].second_checkin_status,
                requestedAt: result.rows[0].second_checkin_requested_at,
              }
            : null,
        })
      }

      const protectedPath =
        url.pathname.startsWith("/api/admin/") ||
        url.pathname.startsWith("/api/students")

      if (protectedPath && !admin) {
        return send(res, 401, {
          error: "Admin sign-in is required.",
          code: "UNAUTHORIZED",
        })
      }

      if (protectedPath && req.method !== "GET") requireCsrf(req)

      if (req.method === "GET" && url.pathname === "/api/promotions") {
        const result = await pool.query(
          "SELECT * FROM promotional_images WHERE enabled=TRUE ORDER BY display_order,id",
        )

        return send(res, 200, { promotions: result.rows.map(publicPromotion) })
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/student-attendance-summary"
      ) {
        const month = url.searchParams.get("month") ?? ""
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw httpError(400, "VALIDATION_ERROR", "Month must use YYYY-MM format.")

        const monthStart = `${month}-01`
        const monthEnd = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
        ).toISOString().slice(0, 10)
        const today = businessDate()
        const dueThrough = today < monthEnd ? today : monthEnd
        const [studentsResult, attendanceResult, closuresResult, leavesResult, calendarSettingsResult] =
          await Promise.all([
            pool.query("SELECT id,created_at,active FROM students"),
            pool.query(
              `SELECT student_id,attendance_date
               FROM attendance
               WHERE attendance_date >= $1::date AND attendance_date <= $2::date
               GROUP BY student_id,attendance_date`,
              [monthStart, monthEnd],
            ),
            pool.query(
              `SELECT start_date,end_date FROM calendar_events
               WHERE full_day=TRUE AND affects_attendance=TRUE
                 AND start_date <= $2::date AND end_date >= $1::date`,
              [monthStart, dueThrough],
            ),
            pool.query(
              `SELECT student_id,leave_date FROM approved_student_leaves
               WHERE leave_date >= $1::date AND leave_date <= $2::date`,
              [monthStart, dueThrough],
            ),
            pool.query(
              "SELECT working_days FROM attendance_calendar_settings WHERE id=1",
            ),
          ])
        const summaries = calculateMonthlySummaries({
          month,
          today,
          students: studentsResult.rows,
          attendance: attendanceResult.rows,
          events: closuresResult.rows,
          approvedLeaves: leavesResult.rows,
          workingDays:
            calendarSettingsResult.rows[0]?.working_days ?? [1, 2, 3, 4, 5],
        })
        return send(res, 200, { summaries })
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/dashboard-attendance"
      ) {
        const date = parseDate(url.searchParams.get("date") ?? "", "Date")
        const [
          studentsResult,
          attendanceResult,
          closuresResult,
          leavesResult,
          settingsResult,
        ] = await Promise.all([
          pool.query(
            `SELECT id,register_number,name,course,active,created_at
             FROM students ORDER BY name,id`,
          ),
          pool.query(
            `SELECT DISTINCT ON (a.student_id)
                    a.student_id,s.register_number,s.name,s.course,
                    a.entry_time,a.exit_time
             FROM attendance a JOIN students s ON s.id=a.student_id
             WHERE a.attendance_date=$1::date
             ORDER BY a.student_id,a.entry_time,a.id`,
            [date],
          ),
          pool.query(
            `SELECT title FROM calendar_events
             WHERE start_date <= $1::date AND end_date >= $1::date
               AND full_day=TRUE AND affects_attendance=TRUE
               AND (leave_scope IS NULL OR leave_scope='class_closed')
             ORDER BY start_date,id`,
            [date],
          ),
          pool.query(
            "SELECT student_id FROM approved_student_leaves WHERE leave_date=$1::date",
            [date],
          ),
          pool.query(
            "SELECT working_days FROM attendance_calendar_settings WHERE id=1",
          ),
        ])
        const dashboard = buildDailyAttendanceDashboard({
          date,
          today: businessDate(),
          students: studentsResult.rows,
          attendance: attendanceResult.rows,
          closures: closuresResult.rows,
          approvedLeaves: leavesResult.rows,
          workingDays: settingsResult.rows[0]?.working_days ?? [1, 2, 3, 4, 5],
        })
        return send(res, 200, dashboard)
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/reports/daily-attendance.xlsx"
      ) {
        const date = validateReportDate(url.searchParams.get("date") ?? "")
        const report = await loadMonthlyAttendanceReport(pool, date.slice(0, 7))
        const workbook = createDailyAttendanceWorkbook(report, date)
        res.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="CSC_Daily_Attendance_${date}.xlsx"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        return res.end(workbook)
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/reports/month-end-attendance.xlsx"
      ) {
        const { month } = validateReportMonth(
          url.searchParams.get("month") ?? "",
        )
        const report = await loadMonthlyAttendanceReport(pool, month)
        const workbook = createMonthEndAttendanceWorkbook(report)
        res.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="CSC_Monthly_Attendance_${month}.xlsx"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        return res.end(workbook)
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/reports/monthly-attendance.xlsx"
      ) {
        const { month } = validateReportMonth(
          url.searchParams.get("month") ?? "",
        )
        const report = await loadMonthlyAttendanceReport(pool, month)
        const workbook = createMonthlyAttendanceWorkbook(report)
        res.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="csc-attendance-${month}.xlsx"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        return res.end(workbook)
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/admin/calendar-events"
      ) {
        const month = url.searchParams.get("month") ?? ""
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw httpError(400, "VALIDATION_ERROR", "Month must use YYYY-MM format.")
        const start = `${month}-01`
        const end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
        ).toISOString().slice(0, 10)
        const result = await pool.query(
          `SELECT * FROM calendar_events
           WHERE start_date <= $2::date AND end_date >= $1::date
           ORDER BY start_date,title,id`,
          [start, end],
        )
        return send(res, 200, { events: result.rows.map(publicCalendarEvent) })
      }

      if (url.pathname === "/api/admin/leaves" && req.method === "GET") {
        const month = url.searchParams.get("month") ?? ""
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw httpError(400, "VALIDATION_ERROR", "Month must use YYYY-MM format.")
        const start = `${month}-01`
        const end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
        ).toISOString().slice(0, 10)
        const result = await pool.query(
          `SELECT e.*,a.username AS created_by_username
           FROM calendar_events e LEFT JOIN admins a ON a.id=e.created_by
           WHERE e.leave_scope IS NOT NULL
             AND e.start_date >= $1::date AND e.start_date <= $2::date
           ORDER BY e.start_date,e.leave_scope,e.id`,
          [start, end],
        )
        return send(res, 200, { leaves: result.rows.map(publicCalendarEvent) })
      }

      if (url.pathname === "/api/admin/leaves" && req.method === "POST") {
        const leave = validateLeaveInput(await bodyJson(req))
        const result = await saveLeave(pool, null, leave, admin.id)
        return send(res, 201, { leave: publicCalendarEvent(result) })
      }

      const leaveMatch = url.pathname.match(/^\/api\/admin\/leaves\/(\d+)$/)
      if (leaveMatch && req.method === "PUT") {
        const leave = validateLeaveInput(await bodyJson(req))
        const result = await saveLeave(pool, leaveMatch[1], leave, admin.id)
        if (!result)
          throw httpError(404, "LEAVE_NOT_FOUND", "Leave record not found.")
        return send(res, 200, { leave: publicCalendarEvent(result) })
      }
      if (leaveMatch && req.method === "DELETE") {
        const result = await pool.query(
          "DELETE FROM calendar_events WHERE id=$1 AND leave_scope IS NOT NULL RETURNING id",
          [leaveMatch[1]],
        )
        if (!result.rowCount)
          throw httpError(404, "LEAVE_NOT_FOUND", "Leave record not found.")
        return send(res, 200, { deleted: true })
      }

      if (url.pathname === "/api/admin/calendar-settings" && req.method === "GET") {
        const result = await pool.query(
          "SELECT working_days FROM attendance_calendar_settings WHERE id=1",
        )
        return send(res, 200, { workingDays: result.rows[0]?.working_days ?? [1, 2, 3, 4, 5] })
      }
      if (url.pathname === "/api/admin/calendar-settings" && req.method === "PUT") {
        const body = await bodyJson(req)
        if (
          !Array.isArray(body.workingDays) ||
          body.workingDays.length < 1 ||
          body.workingDays.length > 7 ||
          body.workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
          new Set(body.workingDays).size !== body.workingDays.length
        ) {
          throw httpError(400, "VALIDATION_ERROR", "Select one or more unique working weekdays.")
        }
        const result = await pool.query(
          `UPDATE attendance_calendar_settings
           SET working_days=$1::smallint[],updated_at=NOW() WHERE id=1
           RETURNING working_days`,
          [body.workingDays],
        )
        return send(res, 200, { workingDays: result.rows[0].working_days })
      }

      const calendarMatch = url.pathname.match(
        /^\/api\/admin\/calendar-events\/(\d+)$/,
      )
      if (
        url.pathname === "/api/admin/calendar-events" &&
        ["POST"].includes(req.method)
      ) {
        const body = await bodyJson(req)
        const event = validateCalendarEvent(body)
        const result = await saveCalendarEvent(pool, null, event)
        return send(res, 201, { event: publicCalendarEvent(result) })
      }
      if (calendarMatch && req.method === "PUT") {
        const body = await bodyJson(req)
        const event = validateCalendarEvent(body)
        const result = await saveCalendarEvent(pool, calendarMatch[1], event)
        if (!result)
          throw httpError(404, "EVENT_NOT_FOUND", "Calendar event not found.")
        return send(res, 200, { event: publicCalendarEvent(result) })
      }
      if (calendarMatch && req.method === "DELETE") {
        const result = await pool.query(
          "DELETE FROM calendar_events WHERE id=$1 RETURNING id",
          [calendarMatch[1]],
        )
        if (!result.rowCount)
          throw httpError(404, "EVENT_NOT_FOUND", "Calendar event not found.")
        return send(res, 200, { deleted: true })
      }

      const studentLeaveMatch = url.pathname.match(
        /^\/api\/admin\/students\/(\d+)\/leave$/,
      )
      if (studentLeaveMatch && ["POST", "DELETE"].includes(req.method)) {
        const body = await bodyJson(req)
        const leaveDate = parseDate(body.leaveDate, "Leave date")
        if (req.method === "POST") {
          await pool.query(
            `INSERT INTO approved_student_leaves(student_id,leave_date,approved_by)
             VALUES($1,$2,$3) ON CONFLICT(student_id,leave_date) DO NOTHING`,
            [studentLeaveMatch[1], leaveDate, admin.id],
          )
          return send(res, 200, { approved: true })
        }
        await pool.query(
          "DELETE FROM approved_student_leaves WHERE student_id=$1 AND leave_date=$2",
          [studentLeaveMatch[1], leaveDate],
        )
        return send(res, 200, { approved: false })
      }

      const studentHistoryMatch = url.pathname.match(
        /^\/api\/admin\/students\/(\d+)\/attendance$/,
      )
      if (studentHistoryMatch && req.method === "GET") {
        const month = url.searchParams.get("month") ?? ""
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw httpError(400, "VALIDATION_ERROR", "Month must use YYYY-MM format.")
        const start = `${month}-01`
        const end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
        ).toISOString().slice(0, 10)
        const [attendanceResult, leavesResult] = await Promise.all([
          pool.query(
            `SELECT id,attendance_date,entry_time,exit_time,status
             FROM attendance WHERE student_id=$1 AND attendance_date >= $2::date
               AND attendance_date <= $3::date ORDER BY attendance_date DESC`,
            [studentHistoryMatch[1], start, end],
          ),
          pool.query(
            `SELECT leave_date FROM approved_student_leaves
             WHERE student_id=$1 AND leave_date >= $2::date AND leave_date <= $3::date`,
            [studentHistoryMatch[1], start, end],
          ),
        ])
        const leaveDates = new Set(
          leavesResult.rows.map((row) => String(row.leave_date).slice(0, 10)),
        )
        return send(res, 200, {
          month,
          approvedLeaves: [...leaveDates],
          attendance: attendanceResult.rows.map((row) => ({
            id: Number(row.id),
            attendanceDate: String(row.attendance_date).slice(0, 10),
            entryTime: row.entry_time,
            exitTime: row.exit_time,
            status: row.status,
            approvedLeave: leaveDates.has(String(row.attendance_date).slice(0, 10)),
          })),
        })
      }

      if (url.pathname === "/api/students" && req.method === "GET") {
        const search = (url.searchParams.get("search") ?? "")
          .trim()
          .slice(0, 100)

        const result = await pool.query(
          `SELECT * FROM students
           WHERE $1 = '' OR register_number ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
             OR course ILIKE '%' || $1 || '%' OR class_timing ILIKE '%' || $1 || '%'
           ORDER BY name, id`,

          [search],
        )

        return send(res, 200, { students: result.rows.map(publicStudent) })
      }

      if (url.pathname === "/api/students" && req.method === "POST") {
        const body = await bodyJson(req)

        const input = {
          registerNumber: requiredString(
            body,
            "registerNumber",
            "Register Number",
            100,
          ).toUpperCase(),

          name: requiredString(body, "name", "Student Name", 200, true),

          phone: requiredString(body, "phoneNumber", "Phone Number", 50, true),

          address: requiredString(body, "address", "Address", 500, true),

          course: requiredString(body, "course", "Course", 200, true),

          classTiming: requiredString(body, "classTiming", "Class Timing", 200, true),
        }

        if (typeof body.active !== "boolean")
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Choose whether the student is active or inactive.",
          )

        const result = await pool
          .query(
            `INSERT INTO students(register_number,name,phone_number,address,course,class_timing,active)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,

            [
              input.registerNumber,
              input.name,
              input.phone,
              input.address,
              input.course,
              input.classTiming,
              body.active,
            ],
          )
          .catch((error) => {
            if (error.code === "23505")
              throw httpError(
                409,
                "DUPLICATE_REGISTER_NUMBER",
                "A student with this Register Number already exists.",
              )

            throw error
          })

        return send(res, 201, { student: publicStudent(result.rows[0]) })
      }

      const studentMatch = url.pathname.match(/^\/api\/students\/(\d+)$/)

      if (studentMatch && req.method === "PATCH") {
        const body = await bodyJson(req)

        const input = {
          registerNumber: requiredString(
            body,
            "registerNumber",
            "Register Number",
            100,
          ).toUpperCase(),

          name: requiredString(body, "name", "Student Name", 200, true),

          phone: requiredString(body, "phoneNumber", "Phone Number", 50, true),

          address: requiredString(body, "address", "Address", 500, true),

          course: requiredString(body, "course", "Course", 200, true),

          classTiming: requiredString(body, "classTiming", "Class Timing", 200, true),
        }

        if (typeof body.active !== "boolean")
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Choose whether the student is active or inactive.",
          )

        const result = await pool
          .query(
            `UPDATE students SET register_number=$1,name=$2,phone_number=$3,address=$4,course=$5,class_timing=$6,active=$7,updated_at=NOW()
           WHERE id=$8 RETURNING *`,

            [
              input.registerNumber,
              input.name,
              input.phone,
              input.address,
              input.course,
              input.classTiming,
              body.active,
              studentMatch[1],
            ],
          )
          .catch((error) => {
            if (error.code === "23505")
              throw httpError(
                409,
                "DUPLICATE_REGISTER_NUMBER",
                "A student with this Register Number already exists.",
              )

            throw error
          })

        return result.rowCount
          ? send(res, 200, { student: publicStudent(result.rows[0]) })
          : send(res, 404, {
              error: "Student not found.",
              code: "STUDENT_NOT_FOUND",
            })
      }

      if (url.pathname.startsWith("/api/students/"))
        return send(res, 405, { error: "Method not allowed." })

      if (req.method === "POST" && url.pathname === "/api/attendance") {
        const body = await bodyJson(req)

        const registerNumber = requiredString(
          body,
          "registerNumber",
          "Register Number",
          100,
        ).toUpperCase()

        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          const studentResult = await client.query(
            "SELECT id,active FROM students WHERE lower(register_number)=lower($1) FOR UPDATE",

            [registerNumber],
          )

          if (!studentResult.rowCount) {
            await client.query("ROLLBACK")

            return send(res, 404, {
              error: "Register Number Not Found.",
              code: "STUDENT_NOT_FOUND",
            })
          }

          const student = studentResult.rows[0]

          if (!student.active) {
            await client.query("ROLLBACK")

            return send(res, 403, {
              error: "This student is inactive and cannot mark attendance.",
              code: "STUDENT_INACTIVE",
            })
          }

          const date = businessDate()

          const closure = await client.query(
            `WITH current_business_time AS (
               SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::time AS local_time
             )
             SELECT e.title FROM calendar_events e
             CROSS JOIN current_business_time t
             WHERE e.start_date <= $1::date AND e.end_date >= $1::date
               AND (
                 e.leave_scope='class_closed'
                 OR (e.leave_scope IS NULL AND e.full_day=TRUE AND e.affects_attendance=TRUE)
               )
               AND (
                 e.full_day=TRUE
                 OR (
                   e.leave_scope='class_closed'
                   AND e.start_time <= t.local_time
                   AND e.end_time > t.local_time
                 )
               )
               AND NOT EXISTS (
                 SELECT 1 FROM attendance a
                 WHERE a.student_id=$2 AND a.attendance_date=$1::date
               )
             ORDER BY e.full_day DESC
             LIMIT 1`,
            [date, student.id],
          )

          if (closure.rowCount) {
            await client.query("ROLLBACK")

            return send(res, 403, {
              error:
                "The class is closed during this leave time. Please contact Admin/Staff.",
              code: "CLASS_CLOSED_LEAVE",
            })
          }

          const inserted = await client.query(
            `INSERT INTO attendance(student_id,attendance_date,entry_time,status)
             VALUES($1,$2,NOW(),'present')
             ON CONFLICT(student_id,attendance_date) DO NOTHING
             RETURNING id,entry_time`,

            [student.id, date],
          )

          if (inserted.rowCount) {
            await client.query(
              "INSERT INTO attendance_sync_outbox(attendance_id) VALUES($1) ON CONFLICT(attendance_id) DO NOTHING",

              [inserted.rows[0].id],
            )

            const studentSessionCookie = await createStudentSession(
              client,
              student.id,
              inserted.rows[0].id,
            )

            await client.query("COMMIT")

            return send(
              res,
              201,
              {
                attendance: {
                  id: Number(inserted.rows[0].id),
                  markedAt: inserted.rows[0].entry_time,
                  exitTime: null,
                  status: "entry_recorded",
                },
              },
              { "Set-Cookie": studentSessionCookie },
            )
          }

          const existing = await client.query(
            "SELECT id,entry_time,exit_time FROM attendance WHERE student_id=$1 AND attendance_date=$2 FOR UPDATE",

            [student.id, date],
          )

          const originalAttendance = existing.rows[0]
          const secondEntry = await client.query(
            `SELECT id,entry_time,exit_time
             FROM attendance_second_checkins
             WHERE student_id=$1 AND attendance_date=$2
             FOR UPDATE`,
            [student.id, date],
          )

          if (secondEntry.rowCount) {
            const second = secondEntry.rows[0]
            const sessionCookie = await createStudentSession(
              client,
              student.id,
              originalAttendance.id,
              second.id,
            )
            await client.query("COMMIT")

            return send(
              res,
              200,
              {
                attendance: {
                  id: Number(second.id),
                  markedAt: second.entry_time,
                  exitTime: second.exit_time,
                  status: second.exit_time
                    ? "already_completed"
                    : "already_checked_in",
                },
              },
              { "Set-Cookie": sessionCookie },
            )
          }

          const existingRequest = await client.query(
            `SELECT id,status,requested_at
             FROM second_checkin_requests
             WHERE student_id=$1 AND attendance_date=$2
               AND status IN ('pending','approved','rejected')
             ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [student.id, date],
          )

          if (existingRequest.rows[0]?.status === "rejected") {
            await client.query("COMMIT")
            return send(res, 403, {
              error: "Your second login request was rejected by an administrator.",
              code: "SECOND_CHECK_IN_REJECTED",
            })
          }

          if (existingRequest.rows[0]?.status === "approved") {
            const request = existingRequest.rows[0]
            const sessionCookie = await createStudentSession(
              client,
              student.id,
              originalAttendance.id,
            )
            await client.query("COMMIT")

            return send(
              res,
              200,
              {
                attendance: {
                  id: Number(originalAttendance.id),
                  markedAt: originalAttendance.entry_time,
                  exitTime: originalAttendance.exit_time,
                  status: "second_check_in_approved",
                },
                secondCheckInRequest: {
                  id: Number(request.id),
                  requestedAt: request.requested_at,
                  status: "approved",
                },
              },
              { "Set-Cookie": sessionCookie },
            )
          }

          const request =
            existingRequest.rows[0] ??
            (
              await client.query(
                `INSERT INTO second_checkin_requests(
                   student_id,attendance_date,original_attendance_id
                 ) VALUES($1,$2,$3)
                 ON CONFLICT DO NOTHING
                 RETURNING id,requested_at`,
                [student.id, date, originalAttendance.id],
              )
            ).rows[0]

          const pendingRequest = request
            ? { id: request.id, requested_at: request.requested_at }
            : (
                await client.query(
                  `SELECT id,requested_at
                   FROM second_checkin_requests
                   WHERE student_id=$1 AND attendance_date=$2 AND status='pending'
                   ORDER BY id DESC LIMIT 1`,
                  [student.id, date],
                )
              ).rows[0]

          if (!pendingRequest) {
            throw new Error("Unable to create or retrieve the pending request.")
          }

          const sessionCookie = await createStudentSession(
            client,
            student.id,
            originalAttendance.id,
          )
          await client.query("COMMIT")

          return send(
            res,
            202,
            {
              attendance: {
                id: Number(originalAttendance.id),
                markedAt: originalAttendance.entry_time,
                exitTime: originalAttendance.exit_time,
                status: "second_check_in_pending",
              },
              secondCheckInRequest: {
                id: Number(pendingRequest.id),
                requestedAt: pendingRequest.requested_at,
                status: "pending",
              },
            },
            { "Set-Cookie": sessionCookie },
          )
        } catch (error) {
          await client.query("ROLLBACK")

          throw error
        } finally {
          client.release()
        }
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/attendance/second-check-in/complete"
      ) {
        requireCsrf(req)

        if (!studentSessionHash) {
          return send(res, 401, {
            error: "Student check-in is required.",
            code: "STUDENT_SESSION_REQUIRED",
          })
        }

        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          const session = await client.query(
            `SELECT ss.student_id,ss.attendance_id,ss.second_checkin_id,s.active
             FROM student_sessions ss
             JOIN students s ON s.id=ss.student_id
             WHERE ss.token_hash=$1 AND ss.expires_at>NOW()
             FOR UPDATE OF ss,s`,
            [studentSessionHash],
          )

          if (!session.rowCount) {
            await client.query("ROLLBACK")
            return send(res, 401, {
              error: "Student check-in is required.",
              code: "STUDENT_SESSION_REQUIRED",
            })
          }

          const {
            student_id: studentId,
            attendance_id: attendanceId,
          } = session.rows[0]

          if (!session.rows[0].active) {
            await client.query("ROLLBACK")
            return send(res, 403, {
              error: "This student is inactive and cannot mark attendance.",
              code: "STUDENT_INACTIVE",
            })
          }

          const date = businessDate()
          const currentSecond = await client.query(
            `SELECT id,entry_time,exit_time,original_attendance_id
             FROM attendance_second_checkins
             WHERE student_id=$1 AND attendance_date=$2
             FOR UPDATE`,
            [studentId, date],
          )

          if (currentSecond.rowCount) {
            const second = currentSecond.rows[0]
            if (
              String(second.original_attendance_id) !== String(attendanceId)
            ) {
              await client.query("ROLLBACK")
              return send(res, 409, {
                error: "This session does not match today's approved check-in.",
                code: "SECOND_CHECK_IN_SESSION_MISMATCH",
              })
            }
            await client.query(
              `UPDATE student_sessions
               SET second_checkin_id=$1
               WHERE student_id=$2 AND attendance_id=$3 AND expires_at>NOW()`,
              [second.id, studentId, attendanceId],
            )
            await client.query("COMMIT")
            return send(res, 200, {
              attendance: {
                id: Number(second.id),
                markedAt: second.entry_time,
                exitTime: second.exit_time,
                status: second.exit_time
                  ? "already_completed"
                  : "already_checked_in",
              },
            })
          }

          const approvedRequest = await client.query(
            `SELECT id,original_attendance_id
             FROM second_checkin_requests
             WHERE student_id=$1 AND attendance_date=$2 AND status='approved'
             ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [studentId, date],
          )

          if (!approvedRequest.rowCount) {
            const pendingRequest = await client.query(
              `SELECT id FROM second_checkin_requests
               WHERE student_id=$1 AND attendance_date=$2 AND status='pending'
               ORDER BY id DESC LIMIT 1`,
              [studentId, date],
            )
            await client.query("ROLLBACK")
            return send(res, 409, {
              error: pendingRequest.rowCount
                ? "Second Check-In Pending Admin Approval."
                : "There is no approved second check-in request for today.",
              code: pendingRequest.rowCount
                ? "SECOND_CHECK_IN_PENDING"
                : "SECOND_CHECK_IN_NOT_APPROVED",
            })
          }

          const request = approvedRequest.rows[0]
          if (String(request.original_attendance_id) !== String(attendanceId)) {
            await client.query("ROLLBACK")
            return send(res, 409, {
              error: "The approved request does not match this attendance session.",
              code: "SECOND_CHECK_IN_SESSION_MISMATCH",
            })
          }

          const inserted = await client.query(
            `INSERT INTO attendance_second_checkins(
               student_id,attendance_date,original_attendance_id,request_id,entry_time
             ) VALUES($1,$2,$3,$4,clock_timestamp())
             ON CONFLICT(student_id,attendance_date) DO NOTHING
             RETURNING id,entry_time,exit_time`,
            [studentId, date, attendanceId, request.id],
          )

          if (!inserted.rowCount) {
            throw new Error("Approved second check-in was not recorded.")
          }

          await client.query(
            `UPDATE second_checkin_requests
             SET status='completed' WHERE id=$1 AND status='approved'`,
            [request.id],
          )

          await client.query(
            `UPDATE student_sessions
             SET second_checkin_id=$1,
                 expires_at=NOW()+($2 * INTERVAL '1 hour')
             WHERE student_id=$3 AND attendance_id=$4 AND expires_at>NOW()`,
            [
              inserted.rows[0].id,
              STUDENT_SESSION_HOURS,
              studentId,
              attendanceId,
            ],
          )

          await client.query("COMMIT")

          return send(
            res,
            201,
            {
              attendance: {
                id: Number(inserted.rows[0].id),
                markedAt: inserted.rows[0].entry_time,
                exitTime: null,
                status: "second_entry_recorded",
              },
            },
            { "Set-Cookie": studentSessionCookie(studentSessionToken) },
          )
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/attendance/check-out"
      ) {
        requireCsrf(req)

        if (!studentSessionHash) {
          return send(res, 401, {
            error: "Student check-in is required before checking out.",
            code: "STUDENT_SESSION_REQUIRED",
          })
        }

        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          const session = await client.query(
            `SELECT ss.attendance_id,ss.second_checkin_id,a.exit_time
             FROM student_sessions ss
             JOIN students s ON s.id=ss.student_id
             JOIN attendance a ON a.id=ss.attendance_id
             WHERE ss.token_hash=$1 AND ss.expires_at>NOW()
               AND a.student_id=ss.student_id
             FOR UPDATE OF ss,a`,
            [studentSessionHash],
          )

          if (!session.rowCount) {
            await client.query("ROLLBACK")
            return send(res, 401, {
              error: "Student check-in is required before checking out.",
              code: "STUDENT_SESSION_REQUIRED",
            })
          }

          let exitTime = session.rows[0].exit_time
          if (session.rows[0].second_checkin_id) {
            const second = await client.query(
              `SELECT exit_time
               FROM attendance_second_checkins
               WHERE id=$1 AND student_id=(
                 SELECT student_id FROM student_sessions WHERE token_hash=$2
               )
               FOR UPDATE`,
              [session.rows[0].second_checkin_id, studentSessionHash],
            )
            if (!second.rowCount) {
              await client.query("ROLLBACK")
              return send(res, 401, {
                error: "Student check-in is required before checking out.",
                code: "STUDENT_SESSION_REQUIRED",
              })
            }
            exitTime = second.rows[0].exit_time
          }

          if (exitTime) {
            await client.query("COMMIT")
            return send(res, 409, {
              error: "This attendance is already checked out.",
              code: "ATTENDANCE_COMPLETED",
            })
          }

          const updated = session.rows[0].second_checkin_id
            ? await client.query(
                `UPDATE attendance_second_checkins
                 SET exit_time=clock_timestamp()
                 WHERE id=$1 AND exit_time IS NULL
                 RETURNING id,exit_time`,
                [session.rows[0].second_checkin_id],
              )
            : await client.query(
                `UPDATE attendance
                 SET exit_time=clock_timestamp(),status='completed',updated_at=NOW()
                 WHERE id=$1 AND exit_time IS NULL
                 RETURNING id,exit_time`,
                [session.rows[0].attendance_id],
              )

          if (!updated.rowCount) {
            await client.query("ROLLBACK")
            return send(res, 409, {
              error: "This attendance is already checked out.",
              code: "ATTENDANCE_COMPLETED",
            })
          }

          if (!session.rows[0].second_checkin_id) {
            await client.query(
              `UPDATE attendance_sync_outbox
               SET synced_at=NULL,next_attempt_at=NOW(),locked_until=NULL
               WHERE attendance_id=$1`,
              [session.rows[0].attendance_id],
            )
          }

          await client.query("COMMIT")

          return send(res, 200, {
            attendance: {
              id: Number(updated.rows[0].id),
              exitTime: updated.rows[0].exit_time,
              status: "completed",
            },
          })
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      }

      if (
        url.pathname === "/api/admin/second-check-in-requests" &&
        req.method === "GET"
      ) {
        const result = await pool.query(
          `SELECT r.id,r.requested_at,r.status,r.processed_at,
                  r.attendance_date,s.register_number,s.name
           FROM second_checkin_requests r
           JOIN students s ON s.id=r.student_id
           ORDER BY (r.status='pending') DESC,r.requested_at DESC,r.id DESC`,
        )

        return send(res, 200, {
          requests: result.rows.map((request) => ({
            ...request,
            id: Number(request.id),
          })),
        })
      }

      const secondCheckInRequestMatch = url.pathname.match(
        /^\/api\/admin\/second-check-in-requests\/(\d+)\/(approve|reject)$/,
      )

      if (secondCheckInRequestMatch && req.method === "POST") {
        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          const request = await client.query(
            `SELECT id FROM second_checkin_requests
             WHERE id=$1 AND status='pending' FOR UPDATE`,
            [secondCheckInRequestMatch[1]],
          )

          if (!request.rowCount) {
            await client.query("ROLLBACK")
            return send(res, 404, {
              error: "Pending second check-in request not found.",
              code: "REQUEST_NOT_FOUND",
            })
          }

          const status =
            secondCheckInRequestMatch[2] === "approve"
              ? "approved"
              : "rejected"
          const processed = await client.query(
            `UPDATE second_checkin_requests
             SET status=$1,processed_by=$2,processed_at=clock_timestamp()
             WHERE id=$3 AND status='pending'`,
            [status, admin.id, request.rows[0].id],
          )

          if (processed.rowCount !== 1) {
            throw new Error("Second check-in request was not processed.")
          }

          await client.query("COMMIT")
          return send(res, 200, { success: true, status })
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      }

      if (url.pathname === "/api/admin/exit-requests" && req.method === "GET") {
        const result = await pool.query(
          `SELECT lr.id,lr.requested_at,lr.status,lr.processed_at,
                  s.register_number,s.name,a.attendance_date,a.entry_time,
                  a.exit_time,a.status AS attendance_status,a.id AS attendance_id
           FROM login_requests lr
           JOIN students s ON s.id=lr.student_id
           JOIN attendance a ON a.id=lr.attendance_id
           ORDER BY lr.requested_at DESC,lr.id DESC`,
        )

        return send(res, 200, {
          requests: result.rows.map((request) => ({
            ...request,
            id: Number(request.id),
            attendance_id: Number(request.attendance_id),
          })),
        })
      }

      const requestMatch = url.pathname.match(
        /^\/api\/admin\/exit-requests\/(\d+)\/(approve|reject)$/,
      )

      if (requestMatch && req.method === "POST") {
        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          const requestResult = await client.query(
            "SELECT id,attendance_id FROM login_requests WHERE id=$1 AND status='pending' FOR UPDATE",

            [requestMatch[1]],
          )

          if (!requestResult.rowCount) {
            await client.query("ROLLBACK")

            return send(res, 404, {
              error: "Pending exit request not found.",
              code: "REQUEST_NOT_FOUND",
            })
          }

          if (requestMatch[2] === "approve") {
            const attendance = await client.query(
              `UPDATE attendance SET exit_time=GREATEST(NOW(),entry_time),status='completed',updated_at=NOW()
               WHERE id=$1 AND exit_time IS NULL RETURNING id,exit_time`,

              [requestResult.rows[0].attendance_id],
            )

            if (!attendance.rowCount) {
              await client.query("ROLLBACK")

              return send(res, 409, {
                error: "Attendance is no longer active.",
                code: "ATTENDANCE_NOT_ACTIVE",
              })
            }

            await client.query(
              `UPDATE attendance_sync_outbox SET synced_at=NULL,next_attempt_at=NOW(),locked_until=NULL
               WHERE attendance_id=$1`,

              [requestResult.rows[0].attendance_id],
            )
          }

          const processed = await client.query(
            "UPDATE login_requests SET status=$1,processed_by=$2,processed_at=NOW() WHERE id=$3",

            [
              requestMatch[2] === "approve" ? "approved" : "rejected",
              admin.id,
              requestResult.rows[0].id,
            ],
          )

          if (processed.rowCount !== 1) {
            throw new Error("Exit request was not processed.")
          }

          await client.query("COMMIT")

          return send(res, 200, {
            success: true,
            status: requestMatch[2] === "approve" ? "approved" : "rejected",
          })
        } catch (error) {
          await client.query("ROLLBACK")

          throw error
        } finally {
          client.release()
        }
      }

      if (url.pathname === "/api/admin/attendance" && req.method === "GET") {
        const from = parseDate(
          url.searchParams.get("from") ??
            url.searchParams.get("date") ??
            businessDate(),
          "From date",
        )

        const to = parseDate(url.searchParams.get("to") ?? from, "To date")

        if (from > to)
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "From date must not be after To date.",
          )

        const search = (url.searchParams.get("search") ?? "")
          .trim()
          .slice(0, 100)

        const result = await pool.query(
          `SELECT a.id,s.register_number,s.name,a.attendance_date,a.entry_time,a.exit_time,a.status
           FROM attendance a JOIN students s ON s.id=a.student_id
           WHERE a.attendance_date BETWEEN $1 AND $2
             AND ($3='' OR s.register_number ILIKE '%' || $3 || '%' OR s.name ILIKE '%' || $3 || '%')
           ORDER BY a.attendance_date DESC,a.entry_time`,

          [from, to, search],
        )

        return send(res, 200, { attendance: result.rows })
      }

      const manualExitMatch = url.pathname.match(
        /^\/api\/admin\/attendance\/(\d+)\/mark-exit$/,
      )

      if (manualExitMatch && req.method === "POST") {
        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          await client.query(
            "SELECT id FROM login_requests WHERE attendance_id=$1 AND status='pending' FOR UPDATE",
            [manualExitMatch[1]],
          )

          const result = await client.query(
            `UPDATE attendance SET exit_time=GREATEST(NOW(),entry_time),status='completed',updated_at=NOW()
             WHERE id=$1 AND exit_time IS NULL RETURNING id,exit_time`,

            [manualExitMatch[1]],
          )

          if (!result.rowCount) {
            await client.query("ROLLBACK")

            return send(res, 404, {
              error: "Active attendance not found.",
              code: "ACTIVE_ATTENDANCE_NOT_FOUND",
            })
          }

          await client.query(
            `UPDATE attendance_sync_outbox
             SET synced_at=NULL,next_attempt_at=NOW(),locked_until=NULL
             WHERE attendance_id=$1`,

            [manualExitMatch[1]],
          )

          await client.query(
            `UPDATE login_requests SET status='rejected',processed_by=$1,processed_at=NOW()
             WHERE attendance_id=$2 AND status='pending'`,

            [admin.id, manualExitMatch[1]],
          )

          await client.query("COMMIT")

          return send(res, 200, {
            attendance: {
              id: Number(result.rows[0].id),
              exitTime: result.rows[0].exit_time,
            },
          })
        } catch (error) {
          await client.query("ROLLBACK")

          throw error
        } finally {
          client.release()
        }
      }

      if (
        url.pathname === "/api/admin/attendance/sync-retry" &&
        req.method === "POST"
      ) {
        const result = await pool.query(
          "UPDATE attendance_sync_outbox SET next_attempt_at=NOW(),locked_until=NULL WHERE synced_at IS NULL",
        )

        return send(res, 200, { queued: result.rowCount })
      }

      if (
        url.pathname === "/api/admin/spreadsheet-config" &&
        req.method === "GET"
      ) {
        const monthKey =
          url.searchParams.get("month") ?? businessDate().slice(0, 7)

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey))
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Month must use YYYY-MM format.",
          )

        const result = await pool.query(
          "SELECT month_key,spreadsheet_id,updated_at FROM spreadsheet_config WHERE month_key=$1",
          [monthKey],
        )

        const config = result.rows[0] ?? null

        return send(res, 200, {
          config: config
            ? {
                month: Number(config.month_key.slice(5)),
                year: Number(config.month_key.slice(0, 4)),
                spreadsheetId: config.spreadsheet_id,
                updatedAt: config.updated_at,
              }
            : null,
        })
      }

      if (
        url.pathname === "/api/admin/spreadsheet-config" &&
        req.method === "PUT"
      ) {
        const body = await bodyJson(req)

        if (
          !Number.isInteger(body.month) ||
          body.month < 1 ||
          body.month > 12 ||
          !Number.isInteger(body.year) ||
          body.year < 2000 ||
          body.year > 9999
        ) {
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "A valid spreadsheet month and year are required.",
          )
        }

        const spreadsheetId = requiredString(
          body,
          "spreadsheetId",
          "Spreadsheet ID",
          300,
        )

        const monthKey = `${body.year}-${String(body.month).padStart(2, "0")}`

        const result = await pool.query(
          `INSERT INTO spreadsheet_config(month_key,spreadsheet_id) VALUES($1,$2)
           ON CONFLICT(month_key) DO UPDATE SET spreadsheet_id=EXCLUDED.spreadsheet_id,updated_at=NOW()
           RETURNING month_key,spreadsheet_id,updated_at`,

          [monthKey, spreadsheetId],
        )

        await pool.query(
          `UPDATE attendance_sync_outbox o SET synced_at=NULL,next_attempt_at=NOW(),locked_until=NULL
           FROM attendance a
           WHERE o.attendance_id=a.id AND o.synced_at IS NULL
             AND to_char(a.attendance_date,'YYYY-MM')=$1`,

          [monthKey],
        )

        return send(res, 200, {
          config: {
            month: body.month,
            year: body.year,
            spreadsheetId: result.rows[0].spreadsheet_id,
            updatedAt: result.rows[0].updated_at,
          },
        })
      }

      if (url.pathname === "/api/admin/promotions" && req.method === "GET") {
        const result = await pool.query(
          "SELECT * FROM promotional_images ORDER BY display_order,id",
        )

        return send(res, 200, { promotions: result.rows.map(publicPromotion) })
      }

      if (url.pathname === "/api/admin/promotions" && req.method === "POST") {
        const fields = parseMultipart(
          await readBody(req, MAX_IMAGE_BYTES + 64 * 1024),
          req.headers["content-type"] ?? "",
        )

        const image = validatePromotionImage(fields.get("image"))

        const title = requiredString(
          { title: fields.get("title")?.data.toString("utf8") ?? "" },
          "title",
          "Title",
          200,
          true,
        )

        const stored = await cloudinaryUpload(image)

        let client
        let committed = false
        try {
          client = await pool.connect()
          await client.query("BEGIN")

          await client.query("SELECT pg_advisory_xact_lock(8192)")

          const count = await client.query(
            "SELECT COUNT(*)::int AS count FROM promotional_images WHERE enabled=TRUE",
          )

          assertActivePromotionCapacity(count.rows[0].count)

          const result = await client.query(
            `INSERT INTO promotional_images(image_url,cloudinary_public_id,title,display_order,enabled)
             VALUES($1,$2,$3,$4,TRUE) RETURNING *`,

            [stored.imageUrl, stored.publicId, title, count.rows[0].count],
          )

          await client.query("COMMIT")
          committed = true

          return send(res, 201, { promotion: publicPromotion(result.rows[0]) })
        } catch (error) {
          if (client && !committed) {
            try {
              await client.query("ROLLBACK")
            } catch {
              console.error("Unable to roll back failed promotion metadata save.")
            }
          }
          if (!committed) {
            try {
              await queueCloudinaryCleanup(pool, stored.publicId)
              await processCloudinaryCleanup(pool)
            } catch {
              console.error("Unable to clean up failed promotional image upload.")
            }
          }
          throw error
        } finally {
          client?.release()
        }
      }

      const promotionMatch = url.pathname.match(
        /^\/api\/admin\/promotions\/(\d+)$/,
      )

      if (promotionMatch && req.method === "PUT") {
        const fields = parseMultipart(
          await readBody(req, MAX_IMAGE_BYTES + 64 * 1024),
          req.headers["content-type"] ?? "",
        )

        const image = validatePromotionImage(fields.get("image"))

        const existing = await pool.query(
          "SELECT cloudinary_public_id FROM promotional_images WHERE id=$1",
          [promotionMatch[1]],
        )

        if (!existing.rowCount)
          throw httpError(
            404,
            "PROMOTION_NOT_FOUND",
            "Promotional image not found.",
          )

        const stored = await cloudinaryUpload(image)

        const titleField = fields.get("title")

        let result
        let previousAssetIsUnreferenced = false
        let transactionOpen = false
        let client
        try {
          client = await pool.connect()
          await client.query("BEGIN")
          transactionOpen = true
          await client.query("SELECT pg_advisory_xact_lock(8192)")
          result = await client.query(
            `UPDATE promotional_images SET image_url=$1,cloudinary_public_id=$2,
             title=COALESCE($3,title),updated_at=NOW() WHERE id=$4 RETURNING *`,
            [
              stored.imageUrl,
              stored.publicId,
              titleField
                ? titleField.data.toString("utf8").trim().slice(0, 200)
                : null,
              promotionMatch[1],
            ],
          )
          if (!result.rowCount)
            throw httpError(404, "PROMOTION_NOT_FOUND", "Promotional image not found.")
          const previousPublicId = existing.rows[0].cloudinary_public_id
          if (previousPublicId && previousPublicId !== stored.publicId) {
            const references = await client.query(
              "SELECT COUNT(*)::int AS count FROM promotional_images WHERE cloudinary_public_id=$1",
              [previousPublicId],
            )
            previousAssetIsUnreferenced = references.rows[0].count === 0
            if (previousAssetIsUnreferenced) {
              await client.query(
                `INSERT INTO cloudinary_asset_cleanup(public_id)
                 VALUES($1) ON CONFLICT(public_id) DO NOTHING`,
                [previousPublicId],
              )
            }
          }
          await client.query("COMMIT")
          transactionOpen = false
        } catch (error) {
          if (transactionOpen) {
            try {
              await client.query("ROLLBACK")
            } catch {
              console.error("Unable to roll back failed image replacement.")
            }
          }
          try {
            await queueCloudinaryCleanup(pool, stored.publicId)
            await processCloudinaryCleanup(pool)
          } catch {
            console.error("Unable to clean up failed replacement image.")
          }
          throw error
        } finally {
          client?.release()
        }
        if (previousAssetIsUnreferenced) {
          try {
            await processCloudinaryCleanup(pool)
          } catch (error) {
            console.error("Unable to process replaced Cloudinary image cleanup:", error.message)
          }
        }

        return send(res, 200, { promotion: publicPromotion(result.rows[0]) })
      }

      if (promotionMatch && req.method === "PATCH") {
        const body = await bodyJson(req)

        if (typeof body.enabled !== "boolean")
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Enabled must be true or false.",
          )

        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          await client.query("SELECT pg_advisory_xact_lock(8192)")

          if (body.enabled) {
            const count = await client.query(
              "SELECT COUNT(*)::int AS count FROM promotional_images WHERE enabled=TRUE AND id<>$1",

              [promotionMatch[1]],
            )

            assertActivePromotionCapacity(count.rows[0].count)
          }

          const result = await client.query(
            "UPDATE promotional_images SET enabled=$1,updated_at=NOW() WHERE id=$2 RETURNING *",

            [body.enabled, promotionMatch[1]],
          )

          if (!result.rowCount) {
            await client.query("ROLLBACK")

            throw httpError(
              404,
              "PROMOTION_NOT_FOUND",
              "Promotional image not found.",
            )
          }

          await client.query("COMMIT")

          return send(res, 200, { promotion: publicPromotion(result.rows[0]) })
        } catch (error) {
          await client.query("ROLLBACK")

          throw error
        } finally {
          client.release()
        }
      }

      if (
        url.pathname === "/api/admin/promotions/order" &&
        req.method === "PUT"
      ) {
        const body = await bodyJson(req)

        if (
          !Array.isArray(body.ids) ||
          body.ids.some((id) => !Number.isInteger(id))
        ) {
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Provide the ordered list of promotional image IDs.",
          )
        }

        if (new Set(body.ids).size !== body.ids.length)
          throw httpError(
            400,
            "VALIDATION_ERROR",
            "Image IDs must not be repeated.",
          )

        const client = await pool.connect()

        try {
          await client.query("BEGIN")

          await client.query("SELECT pg_advisory_xact_lock(8192)")

          const current = await client.query(
            "SELECT id FROM promotional_images ORDER BY id",
          )

          if (
            current.rowCount !== body.ids.length ||
            current.rows.some(({ id }) => !body.ids.includes(Number(id)))
          ) {
            await client.query("ROLLBACK")

            throw httpError(
              400,
              "VALIDATION_ERROR",
              "The ordered list must include every promotional image exactly once.",
            )
          }

          for (const [index, id] of body.ids.entries()) {
            await client.query(
              "UPDATE promotional_images SET display_order=$1,updated_at=NOW() WHERE id=$2",
              [index, id],
            )
          }

          await client.query("COMMIT")

          const result = await pool.query(
            "SELECT * FROM promotional_images ORDER BY display_order,id",
          )

          return send(res, 200, {
            promotions: result.rows.map(publicPromotion),
          })
        } catch (error) {
          await client.query("ROLLBACK")

          throw error
        } finally {
          client.release()
        }
      }

      if (promotionMatch && req.method === "DELETE") {
        const existing = await pool.query(
          "SELECT cloudinary_public_id FROM promotional_images WHERE id=$1",
          [promotionMatch[1]],
        )
        if (!existing.rowCount)
          throw httpError(
            404,
            "PROMOTION_NOT_FOUND",
            "Promotional image not found.",
          )
        const client = await pool.connect()
        let existingPublicId
        let assetIsUnreferenced = false
        let transactionOpen = false
        try {
          await client.query("BEGIN")
          transactionOpen = true
          await client.query("SELECT pg_advisory_xact_lock(8192)")
          const deleted = await client.query(
            "DELETE FROM promotional_images WHERE id=$1 RETURNING cloudinary_public_id",
            [promotionMatch[1]],
          )
          if (!deleted.rowCount)
            throw httpError(
              404,
              "PROMOTION_NOT_FOUND",
              "Promotional image not found.",
            )
          existingPublicId = deleted.rows[0].cloudinary_public_id
          if (existingPublicId) {
            const references = await client.query(
              "SELECT COUNT(*)::int AS count FROM promotional_images WHERE cloudinary_public_id=$1",
              [existingPublicId],
            )
            assetIsUnreferenced = references.rows[0].count === 0
            if (assetIsUnreferenced) {
              await client.query(
                `INSERT INTO cloudinary_asset_cleanup(public_id)
                 VALUES($1) ON CONFLICT(public_id) DO NOTHING`,
                [existingPublicId],
              )
            }
          }
          await client.query("COMMIT")
          transactionOpen = false
        } catch (error) {
          if (transactionOpen) await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
        if (assetIsUnreferenced) {
          try {
            await processCloudinaryCleanup(pool)
          } catch (error) {
            console.error("Unable to process deleted Cloudinary image cleanup:", error.message)
          }
        }
        return send(res, 200, { deleted: true })
      }

      return send(res, 404, { error: "Not found." })
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500

      if (status >= 500)
        console.error(
          `PostgreSQL API error (${req.method} ${req.url?.split("?")[0] ?? "/"}, ${error.code ?? "UNEXPECTED_ERROR"}):`,
          error.cause?.message ?? error.message,
        )

      if (res.headersSent) return res.destroy(error)

      return send(res, status, {
        error:
          error.code === "IMAGE_STORAGE_NOT_CONFIGURED"
            ? error.message
            : status >= 500
              ? "An unexpected server error occurred."
              : error.message,

        ...(error.code ? { code: error.code } : {}),
      })
    }
  })

  server.on("close", () => {
    for (const worker of workers) clearInterval(worker)

    if (!suppliedPool) void pool.end()
  })

  return { server, pool }
}

async function initializeDatabase(pool) {
  const schema = await readFile(
    new URL("./postgres-schema.sql", import.meta.url),
    "utf8",
  )

  await pool.query(schema)
}

async function bootstrap() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString)
    throw new Error(
      "DATABASE_URL missing. Copy .env.example to .env and set your Neon URL.",
    )

  const username = process.env.ADMIN_USERNAME

  const password = process.env.ADMIN_PASSWORD

  if (!username || !password || password.length < 16) {
    throw new Error(
      "Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 16 characters before setup.",
    )
  }

  const pool = new Pool({
    connectionString,

    ssl: connectionString.includes("localhost")
      ? false
      : { rejectUnauthorized: true },
  })

  try {
    await initializeDatabase(pool)

    const existing = await pool.query(
      "SELECT id FROM admins WHERE lower(username)=lower($1)",
      [username],
    )

    if (!existing.rowCount) {
      await pool.query(
        "INSERT INTO admins(username,password_hash) VALUES($1,$2)",

        [username, passwordHash(password)],
      )

      console.log(`Created initial admin account: ${username}`)
    } else {
      console.log(
        `Admin ${username} already exists; setup did not overwrite its password.`,
      )
    }
  } finally {
    await pool.end()
  }
}

export function staticCacheControl(pathname, search = "") {
  if (pathname === "/" || pathname === "/index.html") return "no-cache"

  const hasVersion = new URLSearchParams(search).has("v")
  const hasContentHash =
    pathname.startsWith("/assets/") &&
    /-[\da-z_-]{8,}\.[a-z\d]+$/i.test(pathname)

  if (pathname.startsWith("/assets/") && (hasVersion || hasContentHash)) {
    return "public, max-age=31536000, immutable"
  }

  return "public, max-age=3600"
}

async function serveStatic(req, res) {
  const root = resolve(process.cwd(), "dist")

  const url = new URL(req.url ?? "/", "http://localhost")
  let requested = decodeURIComponent(url.pathname)

  if (requested === "/") requested = "/index.html"

  const file = resolve(root, `.${requested}`)

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    res.writeHead(403)

    res.end()

    return
  }

  try {
    const info = await stat(file)

    if (!info.isFile()) throw new Error("Not a file")

    const contentType =
      {
        ".html": "text/html; charset=utf-8",

        ".js": "text/javascript; charset=utf-8",

        ".css": "text/css; charset=utf-8",

        ".svg": "image/svg+xml",

        ".png": "image/png",

        ".jpg": "image/jpeg",

        ".jpeg": "image/jpeg",

        ".webp": "image/webp",

        ".ico": "image/x-icon",
      }[extname(file)] ?? "application/octet-stream"

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": staticCacheControl(requested, url.search),
      "X-Content-Type-Options": "nosniff",
    })

    createReadStream(file).pipe(res)
  } catch {
    if (req.method === "GET" && !requested.includes(".")) {
      const html = await readFile(join(root, "index.html"))

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      })

      res.end(html)
    } else {
      res.writeHead(404)

      res.end("Not found.")
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await bootstrap()

  if (process.argv.includes("--setup-only")) {
    console.log("PostgreSQL schema and initial admin are ready.")
  } else {
    const { server, pool } = createPostgresApiServer()

    const port = Number(process.env.PORT || process.env.API_PORT || 3001)

    server.once("error", (error) => {
      console.error(
        `Unable to listen on PostgreSQL API port ${port}: ${error.message}`,
      )
      void pool.end().finally(() => {
        process.exitCode = 1
      })
    })

    server.listen(port, "0.0.0.0", () => {
      console.log(`CSC PostgreSQL application listening on port ${port}`)
      process.send?.({ type: "ready", port })
    })
  }
}
