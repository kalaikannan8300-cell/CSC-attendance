import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApiServer } from "./index.mjs";

const credentials = { username: "admin", password: "test-password-12345" };
const databaseDirectory = mkdtempSync(join(tmpdir(), "csc-attendance-"));
const databasePath = join(databaseDirectory, "attendance.sqlite");
let server;
let baseUrl;
let adminCookie;

async function startServer() {
  server = createApiServer({
    databasePath,
    adminUsername: credentials.username,
    adminPassword: credentials.password,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

before(async () => {
  await startServer();
  const login = await api("/api/admin/login", {
    method: "POST",
    body: credentials,
  });
  assert.equal(login.response.status, 200);
  adminCookie = login.response.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await stopServer();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

test("student changes require an admin session and login validates credentials", async () => {
  const unauthorized = await api("/api/students");
  assert.equal(unauthorized.response.status, 401);

  const badLogin = await api("/api/admin/login", {
    method: "POST",
    body: { ...credentials, password: "wrong-password" },
  });
  assert.equal(badLogin.response.status, 401);

  const unauthorizedCreate = await api("/api/students", {
    method: "POST",
    body: { registerNumber: "CSC1001", name: "Test", phoneNumber: "123", address: "Road", active: true },
  });
  assert.equal(unauthorizedCreate.response.status, 401);
});

test("students persist, duplicate register numbers are rejected, and inactive students cannot mark attendance", async () => {
  const studentInput = {
    registerNumber: "csc1001",
    name: "Asha Student",
    phoneNumber: "555-0101",
    address: "10 College Road",
    active: true,
  };
  const invalidStudent = await api("/api/students", {
    method: "POST",
    cookie: adminCookie,
    body: { ...studentInput, name: "" },
  });
  assert.equal(invalidStudent.response.status, 400);

  const created = await api("/api/students", {
    method: "POST",
    cookie: adminCookie,
    body: studentInput,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.student.registerNumber, "CSC1001");

  const duplicate = await api("/api/students", {
    method: "POST",
    cookie: adminCookie,
    body: { ...studentInput, registerNumber: "CSC1001" },
  });
  assert.equal(duplicate.response.status, 409);

  const unauthorizedEdit = await api(`/api/students/${created.payload.student.id}`, {
    method: "PATCH",
    body: { ...studentInput, name: "Unauthorized edit" },
  });
  assert.equal(unauthorizedEdit.response.status, 401);

  const edited = await api(`/api/students/${created.payload.student.id}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { ...studentInput, name: "Asha Updated" },
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.payload.student.name, "Asha Updated");

  const marked = await api("/api/attendance", {
    method: "POST",
    body: { registerNumber: "CSC1001" },
  });
  assert.equal(marked.response.status, 201);

  const alreadyMarked = await api("/api/attendance", {
    method: "POST",
    body: { registerNumber: "CSC1001" },
  });
  assert.equal(alreadyMarked.response.status, 409);

  const inactive = await api(`/api/students/${created.payload.student.id}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { ...studentInput, active: false },
  });
  assert.equal(inactive.response.status, 200);
  assert.equal(inactive.payload.student.active, false);

  const blockedAttendance = await api("/api/attendance", {
    method: "POST",
    body: { registerNumber: "CSC1001" },
  });
  assert.equal(blockedAttendance.response.status, 403);

  await stopServer();
  const historyDb = new DatabaseSync(databasePath);
  const history = historyDb.prepare("SELECT COUNT(*) AS count FROM attendance WHERE student_id = ?")
    .get(created.payload.student.id);
  historyDb.close();
  assert.equal(history.count, 1);

  await startServer();
  const login = await api("/api/admin/login", { method: "POST", body: credentials });
  adminCookie = login.response.headers.get("set-cookie").split(";")[0];
  const listed = await api("/api/students", { cookie: adminCookie });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.students.length, 1);
  assert.equal(listed.payload.students[0].active, false);
});
