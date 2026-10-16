import assert from "node:assert/strict"

import { EventEmitter } from "node:events"

import { test } from "node:test"

import { createPostgresApiServer } from "./postgres-index.mjs"

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
