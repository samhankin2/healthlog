#!/usr/bin/env node
/**
 * LIVE end-to-end test of the AI pipeline against the real OpenCode Go API.
 *
 * Unlike qa/api-test.mjs (which uses AI_MOCK=1), this boots the server with the
 * real key and sends a real chat message through both models and the judge.
 *
 * The key is read from OPENCODE_API_KEY in the environment (or from
 * C:\Users\hanki\.oci\opencode_key.txt on Windows) and is never printed.
 *
 * Usage:
 *   node qa/live-ai-test.mjs            # default meal
 *   node qa/live-ai-test.mjs "pasta and a glass of wine"
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY_FILE = "C:/Users/hanki/.oci/opencode_key.txt";

function apiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY.trim();
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  console.error("no OPENCODE_API_KEY and no key file — cannot run the live test");
  process.exit(2);
}

const MESSAGE = process.argv[2] || "2 scrambled eggs on 1 slice of buttered toast and a black coffee";
const DATA_DIR = mkdtempSync(join(tmpdir(), "healthlog-live-"));
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATA_DIR,
    OPENCODE_API_KEY: apiKey(),
    AI_MOCK: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function api(path, opts = {}, token) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
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
}

try {
  if (!(await waitForServer())) {
    console.error("server did not start:\n" + serverLog);
    process.exit(1);
  }

  const invite = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["server/cli.js", "invite", "create", "--note", "live-test"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => {
      const m = out.match(/HL-[A-Z0-9-]+/);
      m ? resolve(m[0]) : reject(new Error("no invite code in: " + out));
    });
  });

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "live@test.local", password: "correct horse battery", inviteCode: invite }),
  });
  check("register", reg.status === 200 && reg.json.token, `status ${reg.status}`);
  const token = reg.json.token;

  const t0 = Date.now();
  const chat = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message: MESSAGE }),
  }, token);
  const ms = Date.now() - t0;

  check(`chat answered (${ms} ms)`, chat.status === 200 && !!chat.json.message, `status ${chat.status}`);
  const a = chat.json.analysis || {};
  check("analysis has model A output", !!a.modelAOutput && !a.modelAOutput.error, JSON.stringify(a.modelAOutput)?.slice(0, 200));
  check("analysis has model B output", !!a.modelBOutput && !a.modelBOutput.error, JSON.stringify(a.modelBOutput)?.slice(0, 200));
  check("analysis has a comparison", typeof a.comparison === "string" && a.comparison.length > 10, String(a.comparison).slice(0, 120));
  check("agreement is high/medium/low", ["high", "medium", "low"].includes(a.agreement), String(a.agreement));
  check("reconciled totals present", !!(a.reconciled && a.reconciled.total), JSON.stringify(a.reconciled)?.slice(0, 200));
  check("meal saved", !!chat.json.meal, JSON.stringify(chat.json.meal)?.slice(0, 200));

  console.log("\n--- live result ---------------------------------------------");
  console.log("message      :", MESSAGE);
  console.log("model A      :", a.modelA, "->", a.modelAOutput?.total, "confidence", a.modelAOutput?.confidence);
  console.log("model B      :", a.modelB, "->", a.modelBOutput?.total, "confidence", a.modelBOutput?.confidence);
  console.log("delta        :", a.deltaPct, "%  agreement:", a.agreement);
  console.log("reconciled   :", JSON.stringify(a.reconciled?.total));
  console.log("comparison   :", a.comparison);
  console.log("reply        :", chat.json.message?.content?.slice(0, 400));
  console.log("meal         :", chat.json.meal?.name, chat.json.meal?.kcal, "kcal",
    `P${chat.json.meal?.proteinG} C${chat.json.meal?.carbsG} F${chat.json.meal?.fatG}`);
  console.log("---------------------------------------------------------------\n");

  const dash = await api("/api/dashboard?days=7", {}, token);
  check("dashboard includes today's intake", dash.status === 200 && dash.json.metrics?.intake?.kcal > 0,
    JSON.stringify(dash.json.metrics?.intake));
  console.log("intake       :", JSON.stringify(dash.json.metrics?.intake));

  const meals = await api("/api/meals?limit=5", {}, token);
  check("meal list contains the new meal", (meals.json.meals || []).some((m) => m.id === chat.json.meal?.id));
} catch (err) {
  failed++;
  console.error("live test threw:", err);
} finally {
  server.kill();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} assertions`);
process.exit(failed ? 1 : 0);
