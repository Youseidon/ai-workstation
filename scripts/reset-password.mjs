#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { configuredDatabasePath } from "../server/src/config/statePaths.ts";
import { IdentityError, openIdentityStore } from "../server/src/repositories/identities.ts";

const username = process.argv[2]?.trim();
if (!username || username.startsWith("-")) {
  console.error("Usage: npm run reset-password -- <username>");
  process.exit(2);
}

const registry = `${configuredDatabasePath()}.identities.sqlite`;
if (!existsSync(registry)) {
  console.error(`No Hydra account registry at ${registry}. Set HYDRA_DB if Hydra uses another database.`);
  process.exit(1);
}

function hidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const done = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function piped() {
  const lines = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line);
  return lines;
}

let password;
try {
  if (process.stdin.isTTY) {
    password = await hidden(`New password for ${username}: `);
    if (await hidden("Repeat it: ") !== password) throw new Error("The passwords do not match. Nothing was changed.");
  } else {
    const [first = "", second] = await piped();
    if (second !== undefined && second !== first) throw new Error("The passwords do not match. Nothing was changed.");
    password = first;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const store = openIdentityStore(registry);
try {
  const user = await store.resetPassword(username, password);
  console.log(`Password for ${user.username} changed. Every session of this account was signed out.`);
} catch (error) {
  console.error(error instanceof IdentityError ? error.message : `Could not change the password: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  store.close();
}
