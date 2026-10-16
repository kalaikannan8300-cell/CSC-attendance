import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function initializeDevelopmentEnvironment({ directory = process.cwd(), env = process.env } = {}) {
  const envPath = resolve(directory, ".env");
  const hasEnvFile = existsSync(envPath);

  if (hasEnvFile && env === process.env) {
    process.loadEnvFile(envPath);
  } else if (!hasEnvFile && !env.ADMIN_USERNAME && !env.ADMIN_PASSWORD) {
    const username = "admin";
    const password = randomBytes(24).toString("base64url");
    const contents = `ADMIN_USERNAME=${username}\nADMIN_PASSWORD=${password}\n`;
    let created = false;

    try {
      writeFileSync(envPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (env === process.env) process.loadEnvFile(envPath);
    }

    if (created) {
      env.ADMIN_USERNAME = username;
      env.ADMIN_PASSWORD = password;
      if (env === process.env) {
        console.log("Created .env with a randomly generated local admin account.");
        console.log(`Admin Staff ID: ${username}`);
        console.log(`Admin password: ${password}`);
        console.log("Save this password securely; it is only displayed during first-time setup.");
      }
    }
  }

  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
    throw new Error(
      "Admin credentials are missing or incomplete. Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters) in .env, then restart.",
    );
  }
}

export function startDevelopmentServers() {
  initializeDevelopmentEnvironment();

  const children = [
    spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit" }),
    spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
  ];

  let shuttingDown = false;

  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    process.exitCode = code;
  }

  for (const child of children) {
    child.on("error", (error) => {
      console.error("Unable to start the development server:", error);
      shutdown(1);
    });
    child.on("exit", (code) => {
      if (!shuttingDown) shutdown(code ?? 1);
    });
  }

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startDevelopmentServers();
}
