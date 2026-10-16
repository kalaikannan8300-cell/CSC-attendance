import assert from "node:assert/strict"

import { test } from "node:test"

import { businessDate } from "./business-date.mjs"

test("uses India calendar date on both sides of UTC midnight boundaries", () => {
  assert.equal(businessDate(new Date("2026-10-12T18:29:59.000Z")), "2026-10-12")

  assert.equal(businessDate(new Date("2026-10-12T18:30:00.000Z")), "2026-10-13")
})
