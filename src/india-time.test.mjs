import assert from "node:assert/strict"

import { test } from "node:test"

import {
  formatIndiaDate,
  formatIndiaTime,
  indiaDateInputValue,
} from "./india-time.js"

test("formats live and attendance times in Asia/Kolkata", () => {
  assert.equal(
    formatIndiaTime("2026-10-12T14:30:05.000Z"),

    "08:00:05 pm",
  )
})

test("formats a stored attendance date without shifting its calendar day", () => {
  assert.equal(formatIndiaDate("2026-10-12"), "12 Oct 2026")
})

test("produces the current India date for the attendance date filter", () => {
  assert.equal(
    indiaDateInputValue(new Date("2026-10-12T20:00:00.000Z")),

    "2026-10-13",
  )
})
