import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

export const passwordHash = (
  password,
  salt = randomBytes(16).toString("hex"),
) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`

export function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored).split(":")

  if (
    !salt ||
    !expectedHex ||
    expectedHex.length % 2 ||
    !/^[\da-f]+$/i.test(expectedHex)
  )
    return false

  const expected = Buffer.from(expectedHex, "hex")

  const actual = scryptSync(password, salt, expected.length)

  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
