#!/usr/bin/env node
/**
 * Import test: the real old weight-tracker export format
 * (qa/fixtures/old-weight-export.json) must land as weight entries, phases and
 * profile values in the new account.
 *
 * Run: node qa/import-old-export.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = mkdtempSync(join(tmpdir(), "healthlog-import-"));
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const fixture = JSON.parse(readFileSync(join(ROOT, "qa/fixtures/old-weight-export.json"), "utf8"));

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : " — " + detail}`);
};

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR, AI_MOCK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const api = async (path, opts = {}, token) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...opts, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  const invite = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["server/cli.js", "invite", "create"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve((out.match(/HL-[A-Z0-9-]+/) || [])[0]));
  });

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "import@test.local", password: "hunter2hunter2", inviteCode: invite }),
  });
  check("register", reg.status === 200, `status ${reg.status}`);
  const token = reg.json.token;

  const imp = await api("/api/import/weight-json", {
    method: "POST",
    body: JSON.stringify({ json: fixture }),
  }, token);
  check("import returns ok", imp.status === 200 && imp.json.ok, `status ${imp.status} ${JSON.stringify(imp.json).slice(0, 200)}`);
  check("5 entries imported", imp.json.imported?.entries === 5, JSON.stringify(imp.json.imported));
  check("2 phases imported", imp.json.imported?.phases === 2, JSON.stringify(imp.json.imported));

  const weights = await api("/api/weights", {}, token);
  check("weights endpoint lists 5", weights.json.entries?.length === 5, String(weights.json.entries?.length));
  const first = weights.json.entries?.find((e) => e.date === "2026-09-01");
  check("first entry keeps its weight and note", first?.weightKg === 92.4 && first?.note === "start", JSON.stringify(first));

  const phases = await api("/api/phases", {}, token);
  check("phases endpoint lists 2", phases.json.phases?.length === 2, String(phases.json.phases?.length));
  const ongoing = phases.json.phases?.find((p) => p.name === "Maintenance");
  check("ongoing phase has a null end date", ongoing?.endDate === null, JSON.stringify(ongoing));

  const profile = await api("/api/profile", {}, token);
  check("height carried over", profile.json.profile?.heightCm === 181, JSON.stringify(profile.json.profile));
  check("start weight carried over", profile.json.profile?.startWeightKg === 92.4, JSON.stringify(profile.json.profile));
  check("goal weight carried over", profile.json.profile?.goalWeightKg === 78, JSON.stringify(profile.json.profile));

  const dash = await api("/api/dashboard?days=365", {}, token);
  check("dashboard sees the imported history", dash.json.metrics?.entryCount === 5, JSON.stringify(dash.json.metrics?.entryCount));
  check("total change computed", dash.json.metrics?.totalChangeKg === -2.2, JSON.stringify(dash.json.metrics?.totalChangeKg));

  // Re-importing the same file must update, not duplicate.
  const again = await api("/api/import/weight-json", {
    method: "POST",
    body: JSON.stringify({ json: fixture }),
  }, token);
  const weights2 = await api("/api/weights", {}, token);
  check("re-import does not duplicate entries", weights2.json.entries?.length === 5, String(weights2.json.entries?.length));
  check("re-import is idempotent (skipped counted)", typeof again.json.skipped?.entries === "number", JSON.stringify(again.json.skipped));
} catch (err) {
  failed++;
  console.error("threw:", err);
  console.error(log);
} finally {
  server.kill();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} assertions`);
process.exit(failed ? 1 : 0);
