import { emitKeypressEvents } from "node:readline"

import pg from "pg"

import { passwordHash } from "../server/admin-password.mjs"

const { Pool } = pg

function promptHidden(label) {
  const input = process.stdin

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "Run this command in an interactive terminal so the password can be entered without echo.",
    )
  }

  return new Promise((resolve, reject) => {
    let value = ""

    const cleanup = () => {
      input.off("keypress", onKeypress)

      if (input.isRaw) input.setRawMode(false)

      input.pause()
    }

    const finish = (error, result) => {
      cleanup()

      process.stdout.write("\n")

      if (error) reject(error)
      else resolve(result)
    }

    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        return finish(new Error("Password reset cancelled."))
      }

      if (key.name === "return" || key.name === "enter") {
        return finish(null, value)
      }

      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("")

        return
      }

      if (character && !key.ctrl && !key.meta) value += character
    }

    process.stdout.write(label)

    emitKeypressEvents(input)

    input.setRawMode(true)

    input.resume()

    input.on("keypress", onKeypress)
  })
}

async function resetAdminPassword() {
  const connectionString = process.env.DATABASE_URL

  const username = process.env.ADMIN_USERNAME

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing. Set it in the local .env file.")
  }

  if (!username) {
    throw new Error(
      "ADMIN_USERNAME is missing. Set the configured admin username in .env.",
    )
  }

  const newPassword = await promptHidden(
    "New admin password (16+ characters): ",
  )

  if (newPassword.length < 16 || newPassword.length > 500) {
    throw new Error("Password must be between 16 and 500 characters.")
  }

  const confirmation = await promptHidden("Confirm new admin password: ")

  if (newPassword !== confirmation) {
    throw new Error("Passwords do not match; no database changes were made.")
  }

  const pool = new Pool({
    connectionString,

    ssl: connectionString.includes("localhost")
      ? false
      : { rejectUnauthorized: true },
  })

  let client

  let transactionOpen = false

  try {
    client = await pool.connect()

    await client.query("BEGIN")

    transactionOpen = true

    const result = await client.query(
      "SELECT id, username, is_active FROM admins WHERE lower(username)=lower($1) FOR UPDATE",

      [username],
    )

    if (result.rowCount !== 1) {
      throw new Error(
        result.rowCount === 0
          ? "Configured admin account was not found; no changes were made."
          : "Configured admin username matched multiple accounts; no changes were made.",
      )
    }

    const admin = result.rows[0]

    if (!admin.is_active) {
      throw new Error(
        "Configured admin account is inactive; no password changes were made.",
      )
    }

    const update = await client.query(
      "UPDATE admins SET password_hash=$1 WHERE id=$2 RETURNING id",

      [passwordHash(newPassword), admin.id],
    )

    if (
      update.rowCount !== 1 ||
      String(update.rows[0]?.id) !== String(admin.id)
    ) {
      throw new Error(
        "Exactly one intended admin account was not updated; transaction rolled back.",
      )
    }

    await client.query("COMMIT")

    transactionOpen = false

    console.log("Password reset successfully for the configured admin account.")

    console.log("No other account fields or application records were changed.")
  } catch (error) {
    if (client && transactionOpen) {
      await client.query("ROLLBACK")

      transactionOpen = false
    }

    if (
      error.message.startsWith("Configured admin") ||
      error.message.startsWith("Exactly one intended")
    ) {
      throw error
    }

    const code = error.code ? ` (database error ${error.code})` : ""

    throw new Error(
      `Admin password reset failed${code}. No password or hash was displayed.`,
    )
  } finally {
    client?.release()

    await pool.end()
  }
}

resetAdminPassword().catch((error) => {
  console.error(error.message)

  process.exitCode = 1
})
