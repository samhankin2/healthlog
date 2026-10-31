#!/usr/bin/env node
/**
 * Smoke test against a LIVE HealthLog API (default: the public VPS).
 * Registers a throwaway account with a supplied invite code, sends a chat
 * message, checks the meal was saved, then reports.
 *
 * Usage:
 *   node qa/live-public-test.mjs <inviteCode> [baseUrl]
 */
const invite = process.argv[2];
const BASE = (process.argv[3] || "https://healthlog.152.69.178.242.sslip.io").replace(/\/+$/, "");
if (!invite) {
  console.error("usage: node qa/live-public-test.mjs <inviteCode> [baseUrl]");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : " — " + detail}`);
};

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

const email = `smoke-${Date.now()}@test.local`;
try {
  const health = await api("/api/health");
  check("health reachable", health.status === 200 && health.json.ok, JSON.stringify(health.json));

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "smoke-test-password", inviteCode: invite }),
  });
  check("register with invite code", reg.status === 200 && !!reg.json.token, `status ${reg.status} ${JSON.stringify(reg.json).slice(0, 150)}`);
  const token = reg.json.token;
  if (!token) throw new Error("no token");

  const dupe = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "smoke-test-password", inviteCode: invite }),
  });
  check("duplicate email rejected", dupe.status === 409, `status ${dupe.status}`);

  const t0 = Date.now();
  const chat = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message: "chicken breast 200g with rice and a salad" }),
  }, token);
  const ms = Date.now() - t0;
  check(`chat answered (${ms} ms)`, chat.status === 200 && !!chat.json.message, `status ${chat.status} ${JSON.stringify(chat.json).slice(0, 200)}`);

  const a = chat.json.analysis || {};
  check("two model outputs present", !!a.modelAOutput?.total && !!a.modelBOutput?.total,
    `A=${JSON.stringify(a.modelAOutput?.total)} B=${JSON.stringify(a.modelBOutput?.total)}`);
  check("a comparison was written", typeof a.comparison === "string" && a.comparison.length > 10, String(a.comparison).slice(0, 140));
  check("reconciled totals present", !!a.reconciled?.total?.kcal, JSON.stringify(a.reconciled?.total));
  check("meal saved", !!chat.json.meal, JSON.stringify(chat.json.meal)?.slice(0, 150));

  const dash = await api("/api/dashboard?days=7", {}, token);
  check("dashboard intake reflects the meal", dash.json.metrics?.intake?.kcal > 0, JSON.stringify(dash.json.metrics?.intake));

  console.log("\n--- live public result ---");
  console.log("model A   :", a.modelA, JSON.stringify(a.modelAOutput?.total), "conf", a.modelAOutput?.confidence);
  console.log("model B   :", a.modelB, JSON.stringify(a.modelBOutput?.total), "conf", a.modelBOutput?.confidence);
  console.log("delta     :", a.deltaPct, "% | agreement:", a.agreement);
  console.log("reconciled:", JSON.stringify(a.reconciled?.total));
  console.log("comparison:", a.comparison);
  console.log("meal      :", chat.json.meal?.name, chat.json.meal?.kcal, "kcal");
  console.log("---------------------------\n");
} catch (err) {
  failed++;
  console.error("threw:", err);
}

console.log(`${passed} passed, ${failed} failed, ${passed + failed} assertions`);
process.exit(failed ? 1 : 0);
