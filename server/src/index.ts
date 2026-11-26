export {};

if (process.argv.includes("--identity-worker")) {
  if (!process.env.HYDRA_WORKER_SECRET) throw new Error("Account runtimes require a gateway credential.");
  await import("./api/server.ts");
} else {
  await import("./api/identityGateway.ts");
}
