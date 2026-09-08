#!/usr/bin/env node
/**
 * Free TCP ports so `npm run serve` can bind 4000 (server) and 3000 (web).
 * Uses `ss` / `fuser` — `lsof` misses some Node listeners (e.g. next-server).
 */
import { execSync } from "node:child_process";

const ports = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const targets = ports.length > 0 ? ports : [4000, 3000];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidsFromSs(port) {
  try {
    const out = execSync(`ss -ltnp 'sport = :${port}'`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  } catch {
    return [];
  }
}

function pidsFromFuser(port) {
  try {
    // PIDs go to stdout; the "N/tcp:" label goes to stderr.
    const out = execSync(`fuser ${port}/tcp`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return [...new Set(out.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  } catch {
    return [];
  }
}

function pidsOnPort(port) {
  const fromSs = pidsFromSs(port);
  if (fromSs.length > 0) return fromSs;
  return pidsFromFuser(port);
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function forceFuserKill(port) {
  try {
    execSync(`fuser -k -KILL ${port}/tcp`, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

for (const port of targets) {
  let pids = pidsOnPort(port);
  if (pids.length === 0) {
    console.log(`free-ports  :${port} already free`);
    continue;
  }

  for (const pid of pids) {
    if (killPid(pid, "SIGTERM")) {
      console.log(`free-ports  sent SIGTERM to pid ${pid} on :${port}`);
    }
  }

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && pidsOnPort(port).length > 0) {
    sleep(100);
  }

  pids = pidsOnPort(port);
  for (const pid of pids) {
    if (killPid(pid, "SIGKILL")) {
      console.log(`free-ports  sent SIGKILL to pid ${pid} on :${port}`);
    }
  }

  if (pidsOnPort(port).length > 0) {
    forceFuserKill(port);
    sleep(200);
  }

  if (pidsOnPort(port).length === 0) {
    console.log(`free-ports  :${port} freed`);
  } else {
    console.warn(`free-ports  :${port} still in use after kill attempts`);
    process.exitCode = 1;
  }
}
