import assert from "node:assert/strict"
import test from "node:test"

import { staticCacheControl } from "./postgres-index.mjs"

test("HTML entry points revalidate on each visit", () => {
  assert.equal(staticCacheControl("/", ""), "no-cache")
  assert.equal(staticCacheControl("/index.html", ""), "no-cache")
})

test("fingerprinted and versioned public assets are immutable", () => {
  assert.equal(
    staticCacheControl("/assets/index-AbCdEf12.js"),
    "public, max-age=31536000, immutable",
  )
  assert.equal(
    staticCacheControl("/assets/csc-logo.webp", "?v=20261018-1"),
    "public, max-age=31536000, immutable",
  )
})

test("unversioned public files have a bounded cache lifetime", () => {
  assert.equal(
    staticCacheControl("/robots.txt"),
    "public, max-age=3600",
  )
  assert.equal(
    staticCacheControl("/assets/csc-logo.png"),
    "public, max-age=3600",
  )
})
