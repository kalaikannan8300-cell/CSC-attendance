import { DatabaseSync } from "node:sqlite"

import { resolve } from "node:path"

import { pathToFileURL } from "node:url"

import pg from "pg"

const { Pool } = pg

function sqliteTimestamp(value) {
  const source = String(value)

  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(source)
    ? new Date(source).toISOString()
    : new Date(`${source.replace(" ", "T")}Z`).toISOString()
}

export async function importSqliteData({ sqlitePath, connectionString }) {
  const source = new DatabaseSync(sqlitePath, { readOnly: true })

  const pool = new Pool({
    connectionString,

    ssl: connectionString.includes("localhost")
      ? false
      : { rejectUnauthorized: true },
  })

  try {
    const schema = await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        new URL("../server/postgres-schema.sql", import.meta.url),
        "utf8",
      ),
    )

    await pool.query(schema)

    const sourceStudents = source
      .prepare(
        "SELECT id,register_number,name,phone_number,address,active FROM students ORDER BY id",
      )
      .all()

    const sourceAttendance = source
      .prepare(
        "SELECT student_id,attendance_date,marked_at FROM attendance ORDER BY id",
      )
      .all()

    const ids = new Map()

    const client = await pool.connect()

    try {
      await client.query("BEGIN")

      for (const student of sourceStudents) {
        await client.query(
          `INSERT INTO students(register_number,name,phone_number,address,active)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,

          [
            student.register_number,
            student.name ?? "",
            student.phone_number ?? "",
            student.address ?? "",
            Boolean(student.active),
          ],
        )

        const result = await client.query(
          "SELECT id FROM students WHERE lower(register_number)=lower($1)",

          [student.register_number],
        )

        if (!result.rowCount)
          throw new Error(
            `Could not resolve imported student ${student.register_number}.`,
          )

        ids.set(Number(student.id), result.rows[0].id)
      }

      for (const record of sourceAttendance) {
        const studentId = ids.get(Number(record.student_id))

        if (!studentId)
          throw new Error(
            `Attendance record references missing SQLite student ${record.student_id}.`,
          )

        const result = await client.query(
          `INSERT INTO attendance(student_id,attendance_date,entry_time,status)
           VALUES($1,$2,$3,'present')
           ON CONFLICT(student_id,attendance_date) DO NOTHING
           RETURNING id`,

          [
            studentId,
            String(record.attendance_date).slice(0, 10),
            sqliteTimestamp(record.marked_at),
          ],
        )

        let attendanceId = result.rows[0]?.id

        if (!attendanceId) {
          const existing = await client.query(
            "SELECT id FROM attendance WHERE student_id=$1 AND attendance_date=$2",

            [studentId, String(record.attendance_date).slice(0, 10)],
          )

          attendanceId = existing.rows[0]?.id
        }

        if (!attendanceId)
          throw new Error(
            `Could not verify imported attendance for student ${record.student_id}.`,
          )

        await client.query(
          "INSERT INTO attendance_sync_outbox(attendance_id) VALUES($1) ON CONFLICT(attendance_id) DO NOTHING",

          [attendanceId],
        )
      }

      const studentsById = new Map(
        sourceStudents.map((student) => [
          Number(student.id),
          student.register_number,
        ]),
      )
      const studentRows = sourceStudents.map((student) => ({
        register_number: student.register_number,
        name: student.name ?? "",
        phone_number: student.phone_number ?? "",
        address: student.address ?? "",
        active: Boolean(student.active),
      }))
      const verifiedStudents = await client.query(
        `SELECT COUNT(*)::int AS count,
                COUNT(*) FILTER (
                  WHERE s.name<>imported.name OR s.phone_number<>imported.phone_number
                     OR s.address<>imported.address OR s.active<>imported.active
                )::int AS mismatches
         FROM jsonb_to_recordset($1::jsonb)
           AS imported(register_number text,name text,phone_number text,address text,active boolean)
         JOIN students s ON lower(s.register_number)=lower(imported.register_number)`,
        [JSON.stringify(studentRows)],
      )
      const attendanceRows = sourceAttendance.map((row) => ({
        register_number: studentsById.get(Number(row.student_id)),
        attendance_date: String(row.attendance_date).slice(0, 10),
        entry_time: sqliteTimestamp(row.marked_at),
      }))
      const verifiedAttendance = await client.query(
        `SELECT COUNT(*)::int AS count,
                COUNT(*) FILTER (
                  WHERE a.entry_time<>imported.entry_time::timestamptz
                )::int AS timestamp_mismatches
         FROM jsonb_to_recordset($1::jsonb)
           AS imported(register_number text,attendance_date date,entry_time timestamptz)
         JOIN students s ON lower(s.register_number)=lower(imported.register_number)
         JOIN attendance a ON a.student_id=s.id AND a.attendance_date=imported.attendance_date`,
        [JSON.stringify(attendanceRows)],
      )
      const studentCount = verifiedStudents.rows[0].count
      const studentMismatches = verifiedStudents.rows[0].mismatches
      const attendanceCount = verifiedAttendance.rows[0].count
      const timestampMismatches =
        verifiedAttendance.rows[0].timestamp_mismatches
      if (
        studentCount !== sourceStudents.length ||
        studentMismatches ||
        attendanceCount !== sourceAttendance.length ||
        timestampMismatches
      ) {
        throw new Error(
          `Import verification failed (students ${studentCount}/${sourceStudents.length}, student mismatches ${studentMismatches}, attendance ${attendanceCount}/${sourceAttendance.length}, timestamp mismatches ${timestampMismatches}).`,
        )
      }
      await client.query("COMMIT")
      return {
        sourceStudents: sourceStudents.length,
        sourceAttendance: sourceAttendance.length,
        targetStudentsMatched: studentCount,
        targetAttendanceMatched: attendanceCount,
      }
    } catch (error) {
      await client.query("ROLLBACK")

      throw error
    } finally {
      client.release()
    }
  } finally {
    source.close()

    await pool.end()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) throw new Error("Set DATABASE_URL before importing.")

  const pathFlag = process.argv.indexOf("--path")

  const sqlitePath = resolve(
    pathFlag >= 0 ? process.argv[pathFlag + 1] : "data/attendance.sqlite",
  )

  const report = await importSqliteData({ sqlitePath, connectionString })

  console.log(
    "SQLite import verified; the source SQLite database was opened read-only.",
  )

  console.log(JSON.stringify(report, null, 2))
}
