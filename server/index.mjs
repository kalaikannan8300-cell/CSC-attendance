import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const sessionDurationMs = 8 * 60 * 60 * 1000;
const maxRequestBytes = 1024 * 1024;

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, value.join("=")]),
  );
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    const error = new Error("A valid JSON object is required.");
    error.status = 400;
    throw error;
  }
}

function requiredText(body, key, label, maxLength = 500) {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) throw Object.assign(new Error(`${label} is required.`), { status: 400, code: "VALIDATION_ERROR" });
  if (value.length > maxLength) {
    throw Object.assign(new Error(`${label} must be ${maxLength} characters or fewer.`), {
      status: 400,
      code: "VALIDATION_ERROR",
    });
  }
  return value;
}

function studentInput(body) {
  const active = body.active;
  if (typeof active !== "boolean") {
    throw Object.assign(new Error("Choose whether the student is active or inactive."), {
      status: 400,
      code: "VALIDATION_ERROR",
    });
  }
  return {
    registerNumber: requiredText(body, "registerNumber", "Register Number", 100).toUpperCase(),
    name: requiredText(body, "name", "Student Name", 200),
    phoneNumber: requiredText(body, "phoneNumber", "Phone Number", 50),
    address: requiredText(body, "address", "Address", 500),
    active,
  };
}

function publicStudent(row) {
  return {
    id: row.id,
    registerNumber: row.register_number,
    name: row.name,
    phoneNumber: row.phone_number,
    address: row.address,
    active: Boolean(row.active),
  };
}

function sqliteIsUniqueError(error) {
  return error.code === "ERR_SQLITE_ERROR" && /UNIQUE constraint failed/i.test(error.message);
}

export function createApiServer({
  databasePath = process.env.DATABASE_PATH ?? "./data/attendance.sqlite",
  adminUsername = process.env.ADMIN_USERNAME,
  adminPassword = process.env.ADMIN_PASSWORD,
} = {}) {
  if (!adminUsername || !adminPassword || adminPassword.length < 12) {
    throw new Error("Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters before starting the API.");
  }

  const resolvedDatabasePath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedDatabasePath !== ":memory:") mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  const database = new DatabaseSync(resolvedDatabasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY,
      register_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      address TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
      attendance_date TEXT NOT NULL,
      marked_at TEXT NOT NULL,
      UNIQUE (student_id, attendance_date)
    );
  `);

  const sessions = new Map();
  const server = createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found." });
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok" });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/login") {
        const body = await readJson(request);
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!safeEqual(username, adminUsername) || !safeEqual(password, adminPassword)) {
          return json(response, 401, { error: "Staff ID or password is incorrect.", code: "INVALID_CREDENTIALS" });
        }

        const token = randomBytes(32).toString("base64url");
        sessions.set(token, Date.now() + sessionDurationMs);
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        return json(response, 200, { authenticated: true }, {
          "Set-Cookie": `csc_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
        });
      }

      const token = parseCookies(request.headers.cookie).csc_admin_session;
      const expiresAt = token ? sessions.get(token) : undefined;
      const authenticated = Boolean(expiresAt && expiresAt > Date.now());
      if (token && expiresAt && !authenticated) sessions.delete(token);

      if (request.method === "GET" && url.pathname === "/api/admin/session") {
        return authenticated
          ? json(response, 200, { authenticated: true })
          : json(response, 401, { authenticated: false, error: "Admin sign-in is required." });
      }
      if (request.method === "POST" && url.pathname === "/api/admin/logout") {
        if (token) sessions.delete(token);
        return json(response, 200, { authenticated: false }, {
          "Set-Cookie": "csc_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        });
      }

      const studentCollection = url.pathname === "/api/students";
      const studentMatch = url.pathname.match(/^\/api\/students\/(\d+)$/);
      if (studentCollection || studentMatch) {
        if (!authenticated) return json(response, 401, { error: "Admin sign-in is required.", code: "UNAUTHORIZED" });

        if (request.method === "GET" && studentCollection) {
          const rows = database.prepare("SELECT * FROM students ORDER BY name COLLATE NOCASE, id").all();
          return json(response, 200, { students: rows.map(publicStudent) });
        }
        if (request.method === "POST" && studentCollection) {
          const student = studentInput(await readJson(request));
          try {
            const result = database.prepare(`
              INSERT INTO students (register_number, name, phone_number, address, active)
              VALUES (?, ?, ?, ?, ?)
            `).run(student.registerNumber, student.name, student.phoneNumber, student.address, Number(student.active));
            const row = database.prepare("SELECT * FROM students WHERE id = ?").get(Number(result.lastInsertRowid));
            return json(response, 201, { student: publicStudent(row) });
          } catch (error) {
            if (sqliteIsUniqueError(error)) {
              return json(response, 409, { error: "A student with this Register Number already exists.", code: "DUPLICATE_REGISTER_NUMBER" });
            }
            throw error;
          }
        }
        if (request.method === "PATCH" && studentMatch) {
          const id = Number(studentMatch[1]);
          const student = studentInput(await readJson(request));
          try {
            const result = database.prepare(`
              UPDATE students
              SET register_number = ?, name = ?, phone_number = ?, address = ?, active = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(student.registerNumber, student.name, student.phoneNumber, student.address, Number(student.active), id);
            if (result.changes === 0) return json(response, 404, { error: "Student not found.", code: "STUDENT_NOT_FOUND" });
            const row = database.prepare("SELECT * FROM students WHERE id = ?").get(id);
            return json(response, 200, { student: publicStudent(row) });
          } catch (error) {
            if (sqliteIsUniqueError(error)) {
              return json(response, 409, { error: "A student with this Register Number already exists.", code: "DUPLICATE_REGISTER_NUMBER" });
            }
            throw error;
          }
        }
        return json(response, 405, { error: "Method not allowed." });
      }

      if (request.method === "POST" && url.pathname === "/api/attendance") {
        const body = await readJson(request);
        const registerNumber = requiredText(body, "registerNumber", "Register Number", 100).toUpperCase();
        const student = database.prepare("SELECT id, active FROM students WHERE register_number = ?").get(registerNumber);
        if (!student) return json(response, 404, { error: "Register Number Not Found.", code: "STUDENT_NOT_FOUND" });
        if (!student.active) return json(response, 403, { error: "This student is inactive and cannot mark attendance.", code: "STUDENT_INACTIVE" });

        const markedAt = new Date().toISOString();
        const attendanceDate = markedAt.slice(0, 10);
        try {
          const result = database.prepare(`
            INSERT INTO attendance (student_id, attendance_date, marked_at)
            VALUES (?, ?, ?)
          `).run(student.id, attendanceDate, markedAt);
          return json(response, 201, { attendance: { id: Number(result.lastInsertRowid), markedAt } });
        } catch (error) {
          if (sqliteIsUniqueError(error)) {
            return json(response, 409, { error: "Attendance has already been recorded for this student today.", code: "ATTENDANCE_EXISTS" });
          }
          throw error;
        }
      }

      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error("API request failed:", error);
      return json(response, status, {
        error: status >= 500 ? "An unexpected server error occurred." : error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  });

  server.on("close", () => database.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createApiServer();
  const port = Number(process.env.API_PORT ?? 3001);
  server.listen(port, "127.0.0.1", () => console.log(`CSC attendance API listening on http://127.0.0.1:${port}`));
}
