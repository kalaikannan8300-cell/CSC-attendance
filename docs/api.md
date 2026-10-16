# API reference

The API is same-origin with the frontend. JSON endpoints return `{"error":"...","code":"..."}` for expected failures and never expose stack traces. Mutating requests must include `X-Requested-With: CSCAttendance`; the supplied frontend adds it automatically. Admin routes require the HttpOnly `csc_admin_session` cookie.

## Public routes

| Method and path | Request | Result |
|---|---|---|
| `GET /api/health` | — | `200 { status: "ok", database: "postgresql" }` when DB is available |
| `GET /api/promotions` | — | `200 { promotions: [...] }` with active images only |
| `POST /api/attendance` | `{ registerNumber }` | Creates today's attendance once (`201`) or returns the existing active/completed row (`200`); issues a short-lived, HttpOnly student session cookie |
| `GET /api/attendance/session` | Student session cookie | Restores the current bound attendance record and its saved entry/exit times |
| `POST /api/attendance/check-out` | Student session cookie | Closes only the attendance row bound to that session using the PostgreSQL clock; repeated checkout returns `409 ATTENDANCE_COMPLETED` |

Attendance errors include `400 VALIDATION_ERROR`, `404 STUDENT_NOT_FOUND`, `403 STUDENT_INACTIVE`, `401 STUDENT_SESSION_REQUIRED`, and `409 ATTENDANCE_COMPLETED`. Entry and exit timestamps are server-side. The business day uses `Asia/Kolkata`; the student clock and Admin attendance table display timestamps in India time. Repeated check-in reuses today's active attendance and never creates a second row or exit request. A student session is bound to the student and attendance row in PostgreSQL, has a 12-hour expiry, and is stored server-side only as a token hash. Existing Admin exit requests remain available for legacy requests and are not automatically approved by student checkout.

## Authentication

| Method and path | Behavior |
|---|---|
| `POST /api/admin/login` | Body `{ username, password }`; sets an eight-hour HttpOnly session cookie. Invalid credentials return `401`; excessive attempts return `429`. |
| `GET /api/admin/session` | `200` if authenticated; otherwise `401`. |
| `POST /api/admin/logout` | Revokes the server-side session and expires the cookie. |

## Protected administration routes

| Method and path | Request / behavior |
|---|---|
| `GET /api/students?search=...` | List/search by Register Number, name, course, or class timing |
| `POST /api/students` | `{ registerNumber, name?, phoneNumber?, address?, course?, classTiming?, active }` |
| `PATCH /api/students/:id` | Same fields as create |
| `GET /api/admin/student-attendance-summary?month=YYYY-MM` | Selected-month unique present dates and expected absences per student; used in one batch for student and overall pie charts |
| `GET /api/admin/dashboard-attendance?date=YYYY-MM-DD` | Roster-aware daily present/absent lists, active-student count, and full-day class closure status |
| `GET /api/admin/reports/daily-attendance.xlsx?date=YYYY-MM-DD` | Downloads a filtered single-day workbook with PRESENT, ABSENT, LEAVE, course, and leave-time columns |
| `GET /api/admin/reports/month-end-attendance.xlsx?month=YYYY-MM` | Downloads a single `Attendance Report` worksheet with one row per student and eligible working date |
| `GET /api/admin/reports/monthly-attendance.xlsx?month=YYYY-MM` | Downloads the existing Daily Attendance and Monthly Summary worksheets with LEAVE and partial leave details |
| `GET /api/admin/students/:id/attendance?month=YYYY-MM` | Detailed saved attendance rows and approved leave dates for the month |
| `POST /api/admin/students/:id/leave` | `{ leaveDate }` records an approved student leave date |
| `DELETE /api/admin/students/:id/leave` | `{ leaveDate }` removes an approved student leave date |
| `GET /api/admin/calendar-events?month=YYYY-MM` | Retained historical events and closures overlapping the selected month |
| `GET /api/admin/calendar-settings` | Configured working weekdays (Sunday `0` through Saturday `6`) |
| `PUT /api/admin/calendar-settings` | `{ workingDays: [1,2,3,4,5] }` updates the class-working week |
| `GET /api/admin/leaves?month=YYYY-MM` | Lists leave records and their scope for the selected month |
| `POST /api/admin/leaves` | `{ date, scope: "staff" \| "class_closed", leaveType: "full_day" \| "partial_time", startTime?, endTime?, reason? }` |
| `PUT /api/admin/leaves/:id` | Edits a leave record; duplicate date/scope and overlapping class closures return `409` |
| `DELETE /api/admin/leaves/:id` | Removes leave metadata without changing attendance history |
| `POST /api/admin/calendar-events` | Legacy full-day or partial-day event/closure creation remains supported for compatibility |
| `PUT /api/admin/calendar-events/:id` | Updates a legacy event; overlapping attendance closures return `409` |
| `DELETE /api/admin/calendar-events/:id` | Deletes legacy event metadata without changing attendance history |
| `GET /api/admin/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&search=...` | Date-range report; `date=` is accepted as a single-day alias. The Admin dashboard filters the selected date and status, refreshes on focus, and polls for updates while open. |
| `POST /api/admin/attendance/:id/mark-exit` | Records manual server-side exit for an active session |
| `GET /api/admin/exit-requests` | Lists pending, approved, and rejected exit requests, including request and processing timestamps |
| `POST /api/admin/exit-requests/:id/approve` | Approves request and closes attendance in one transaction |
| `POST /api/admin/exit-requests/:id/reject` | Rejects without changing attendance timestamps |
| `POST /api/admin/attendance/sync-retry` | Requeues unsynced spreadsheet records |
| `GET /api/admin/spreadsheet-config?month=YYYY-MM` | Read that month's spreadsheet config |
| `PUT /api/admin/spreadsheet-config` | `{ month: 1..12, year, spreadsheetId }` |
| `GET /api/admin/promotions` | List active and disabled image metadata |
| `POST /api/admin/promotions` | Multipart `image` and optional `title`; stores image in Cloudinary |
| `PUT /api/admin/promotions/:id` | Multipart replacement image |
| `PATCH /api/admin/promotions/:id` | `{ enabled: boolean }` |
| `PUT /api/admin/promotions/order` | `{ ids: [number, ...] }` with each stored image ID exactly once |
| `DELETE /api/admin/promotions/:id` | Deletes metadata and associated Cloudinary image |

Common statuses: `400` invalid input/date, `401` missing admin session, `403` inactive student or failed request verification, `404` unknown record, `409` duplicate or invalid state transition, `413` oversized image/body, `429` login throttled, and `5xx` service/provider error.

Attendance sync is asynchronous. Failures are logged and persisted in `attendance_sync_outbox` with retry delay and last error; they do not affect a committed attendance transaction. Sheets writes use Attendance ID as the idempotency key.

The Admin Leave Calendar records either Staff/Admin leave or Class Closed leave. Staff/Admin leave is stored separately by scope and never affects student attendance or absence totals. A full-day Class Closed leave uses the existing calendar closure model, is excluded from absences, and is labeled `LEAVE` in monthly reports; partial leave records preserve actual attendance status and are listed in separate leave-detail fields. Leave records are unique by date and scope. The additive schema update retains legacy calendar records and adds optional leave scope and creator metadata.

Attendance dashboard totals are derived from PostgreSQL records, not stored separately. Monthly Present and Absent values count unique eligible student-days from the existing monthly summary rules; full-day class closures, approved student leave, inactive-student absences, future dates, and the configured working week are respected. Daily attendance treats any saved check-in as PRESENT even without an exit time. Daily absence is limited to active, enrolled students on past configured working days, excluding full-day class closures, approved student leave, and students with an attendance row. Partial and Staff/Admin leave do not create full-day student closures.

Promotional images are streamed to Cloudinary from the authenticated backend using the official Cloudinary Node SDK. Uploads accept JPEG, PNG, and WebP files up to 8 MB; no more than five images may be active at once. PostgreSQL stores secure Cloudinary URLs/identifiers and display metadata. The browser does not receive the Cloudinary API secret. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the backend to enable uploads and asset deletion. Replacement uploads are saved before the database reference changes; old assets are queued for removal only after the database save commits and no row references the asset. Failed deletions remain in a PostgreSQL cleanup queue and are retried by the server worker.
