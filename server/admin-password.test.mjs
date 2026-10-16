import assert from "node:assert/strict"

import { describe, test } from "node:test"

import { passwordHash, verifyPassword } from "./admin-password.mjs"

describe("admin password hashing", () => {
  test("stores scrypt hashes in the format accepted by admin login", () => {
    const password = "test-password-for-admin"

    const stored = passwordHash(password)

    const [salt, hash] = stored.split(":")

    assert.match(salt, /^[\da-f]{32}$/)

    assert.match(hash, /^[\da-f]{128}$/)

    assert.equal(verifyPassword(password, stored), true)

    assert.equal(verifyPassword("different-password", stored), false)
  })
})
