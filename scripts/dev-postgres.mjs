import { spawn } from "node:child_process"

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Set it in .env before starting the PostgreSQL development app.",
  )
}

const apiPort = process.env.API_PORT ?? "3001"
const api = spawn(process.execPath, ["server/postgres-index.mjs"], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: { ...process.env, API_PORT: apiPort, PORT: "" },
})

const children = new Set([api])
let stopping = false

function stop(code = 0) {
  if (stopping) return

  stopping = true

  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }

  process.exitCode = code
}

function waitForApiReady(child) {
  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (error) => {
      if (settled) return

      settled = true
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("error", onError)
      child.off("exit", onExit)

      if (error) reject(error)
      else resolve()
    }

    const onMessage = (message) => {
      if (message?.type === "ready") finish()
    }
    const onError = (error) => {
      finish(
        new Error(`Unable to start the PostgreSQL API process: ${error.message}`),
      )
    }
    const onExit = (code) => {
      finish(
        new Error(
          `PostgreSQL API exited before becoming ready (code ${code ?? "unknown"}). Vite was not started; see the API error above.`,
        ),
      )
    }

    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "PostgreSQL API did not become ready within 60 seconds. Vite was not started; check the database connection and API errors above.",
          ),
        ),
      60000,
    )

    child.on("message", onMessage)
    child.once("error", onError)
    child.once("exit", onExit)
  })
}

function watch(child, label) {
  child.on("error", (error) => {
    console.error(`Unable to start ${label}: ${error.message}`)
    stop(1)
  })

  child.on("exit", (code) => {
    if (stopping) return

    console.error(`${label} exited unexpectedly (code ${code ?? "unknown"}).`)
    stop(code ?? 1)
  })
}

watch(api, "PostgreSQL API")

process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())

try {
  await waitForApiReady(api)

  if (api.connected) api.disconnect()

  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
    env: {
      ...process.env,
      API_URL: process.env.API_URL ?? `http://127.0.0.1:${apiPort}`,
    },
  })

  children.add(vite)
  watch(vite, "Vite")
} catch (error) {
  console.error(error.message)
  stop(1)
}
