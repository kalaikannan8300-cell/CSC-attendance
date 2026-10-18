import assert from "node:assert/strict"

import { EventEmitter } from "node:events"

import { test } from "node:test"

import { createPostgresApiServer } from "./postgres-index.mjs"

async function requestWithPool(pool, path, options = {}) {
  const { server } = createPostgresApiServer({
    pool,
    adminUsername: "test-admin",
    adminPassword: "integration-test-password",
    startWorker: false,
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  try {
    return await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      options,
    )
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test("a checked-out PostgreSQL client connection reset is handled without exposing error details", () => {
  const pool = new EventEmitter()

  const { server } = createPostgresApiServer({
    pool,

    adminUsername: "test-admin",

    adminPassword: "integration-test-password",

    startWorker: false,
  })

  const client = new EventEmitter()

  const logged = []

  const originalConsoleError = console.error

  try {
    console.error = (...args) => logged.push(args)

    pool.emit("connect", client)

    assert.doesNotThrow(() => {
      client.emit(
        "error",

        Object.assign(new Error("sensitive connection details"), {
          code: "ECONNRESET",
        }),
      )
    })

    assert.deepEqual(logged, [
      ["PostgreSQL connection was interrupted (ECONNRESET)."],
    ])
  } finally {
    console.error = originalConsoleError

    server.close()
  }
})

test("a transient reset retries the public promotions read once and recovers", async () => {
  const pool = new EventEmitter()
  let queryCount = 0
  pool.query = async () => {
    queryCount += 1
    if (queryCount === 1) {
      throw new Error("Connection terminated unexpectedly")
    }
    return { rows: [] }
  }

  const response = await requestWithPool(pool, "/api/promotions")

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { promotions: [] })
  assert.equal(queryCount, 2)
})

test("a transient reset retries the authenticated attendance session read once", async () => {
  const pool = new EventEmitter()
  let queryCount = 0
  pool.query = async () => {
    queryCount += 1
    if (queryCount === 1) {
      throw Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      })
    }
    return {
      rowCount: 1,
      rows: [
        {
          id: 42,
          entry_time: "2026-10-18T09:00:00.000Z",
          exit_time: null,
          status: "present",
          second_checkin_request_id: null,
          second_checkin_status: null,
          second_checkin_requested_at: null,
        },
      ],
    }
  }

  const response = await requestWithPool(pool, "/api/attendance/session", {
    headers: { Cookie: "csc_student_session=test-session-token" },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    attendance: {
      id: 42,
      entryTime: "2026-10-18T09:00:00.000Z",
      exitTime: null,
      status: "present",
    },
    secondCheckInRequest: null,
  })
  assert.equal(queryCount, 2)
})

test("a persistent database reset returns 503 instead of success-shaped data", async () => {
  const pool = new EventEmitter()
  let queryCount = 0
  pool.query = async () => {
    queryCount += 1
    throw Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "ECONNRESET",
    })
  }

  const response = await requestWithPool(pool, "/api/promotions")

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: "Database is temporarily unavailable. Please try again.",
    code: "DATABASE_UNAVAILABLE",
  })
  assert.equal(queryCount, 2)
})

test("a PostgreSQL query error is not retried as a transient connection failure", async () => {
  const pool = new EventEmitter()
  let queryCount = 0
  pool.query = async () => {
    queryCount += 1
    throw Object.assign(new Error("syntax error"), { code: "42601" })
  }

  const response = await requestWithPool(pool, "/api/promotions")

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: "An unexpected server error occurred.",
    code: "42601",
  })
  assert.equal(queryCount, 1)
})
