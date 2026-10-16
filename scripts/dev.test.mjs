import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeDevelopmentEnvironment } from "./dev.mjs";

test("first-time development setup writes a random admin password to .env", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "csc-dev-setup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {};

  initializeDevelopmentEnvironment({ directory, env });

  assert.equal(env.ADMIN_USERNAME, "admin");
  assert.ok(env.ADMIN_PASSWORD.length >= 12);
  assert.match(readFileSync(join(directory, ".env"), "utf8"), new RegExp(`ADMIN_PASSWORD=${env.ADMIN_PASSWORD}`));
});

test("development setup accepts credentials supplied by the environment", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "csc-dev-config-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.doesNotThrow(() => initializeDevelopmentEnvironment({
    directory,
    env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "a-valid-password-123" },
  }));
});
