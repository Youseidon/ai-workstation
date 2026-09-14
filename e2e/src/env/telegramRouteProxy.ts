import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";

/*
 * Telegram route proxy (docs/e2e-harness-plan.md 4.2): a loopback forwarder
 * between the harness server and its Telegram backend (the fake server or
 * api.telegram.org). Cutting it takes away only the server's route, so the
 * phone side stays connected and "the workstation lost its network" becomes
 * a precise, repeatable step on either backend.
 *
 * Requests carry the bot token in their path, so the proxy never records or
 * reports a path: calls are recorded by method name and JSON body only.
 * It forwards only Bot API paths, only to its one configured upstream
 * (api.telegram.org, or a loopback fake), and listens on loopback only.
 */

type Json = Record<string, unknown>;

export type RouteCut = "refuse" | "hang";

export interface ProxiedCall {
  method: string;
  body: Json;
  at: number;
  /** HTTP status the upstream answered, or the cut that stopped the call. */
  outcome: number | RouteCut | "upstream_error";
}

const BOT_API_PATH = /^\/bot\d+:[A-Za-z0-9_-]+\/([A-Za-z]+)$/;
const REAL_TELEGRAM = "https://api.telegram.org";

export class TelegramRouteProxy {
  readonly calls: ProxiedCall[] = [];
  private server: Server | null = null;
  private cut: RouteCut | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly inFlight = new Set<{ upstream: ClientRequest; res: ServerResponse; call: ProxiedCall }>();
  private readonly held = new Set<ServerResponse>();
  private readonly upstream: URL;

  constructor(upstreamUrl: string, private readonly logFile: string | null = null) {
    this.upstream = new URL(upstreamUrl);
    const loopbackFake = this.upstream.protocol === "http:" && (this.upstream.hostname === "127.0.0.1" || this.upstream.hostname === "[::1]");
    if (this.upstream.origin !== REAL_TELEGRAM && !loopbackFake) throw new Error(`telegram route proxy: upstream must be ${REAL_TELEGRAM} or a loopback http fake`);
    if (this.upstream.pathname !== "/" || this.upstream.username !== "" || this.upstream.password !== "") throw new Error("telegram route proxy: upstream must be a bare origin");
  }

  get url(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error("telegram route proxy is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  get state(): RouteCut | "open" {
    return this.cut ?? "open";
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      if (this.cut === "refuse") {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  /**
   * "refuse" resets open connections and refuses new ones, like a dropped
   * network interface; "hang" accepts requests and never answers, like a
   * black-holed route, so the client's own timeouts must fire.
   */
  cutRoute(mode: RouteCut): void {
    this.cut = mode;
    for (const flight of this.inFlight) {
      flight.call.outcome = mode;
      flight.upstream.destroy();
      if (mode === "refuse") flight.res.socket?.destroy();
      else this.held.add(flight.res);
    }
    this.inFlight.clear();
    if (mode === "refuse") for (const socket of this.sockets) socket.destroy();
  }

  /** Restores the route; requests held by a hang are reset so the client retries promptly. */
  restoreRoute(): void {
    this.cut = null;
    for (const res of this.held) res.socket?.destroy();
    this.held.clear();
  }

  async close(): Promise<void> {
    this.restoreRoute();
    for (const flight of this.inFlight) flight.upstream.destroy();
    this.inFlight.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readRaw(req);
    // Origin-form Bot API paths only: an absolute-form URL or any other path is never forwarded.
    const method = BOT_API_PATH.exec(req.url ?? "")?.[1];
    if (method === undefined) {
      this.log("rejected a request that is not a Bot API call");
      const text = JSON.stringify({ ok: false, error_code: 404, description: "Not Found: the harness route proxy forwards Bot API calls only" });
      res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    const call: ProxiedCall = { method, body: parseJson(raw), at: Date.now(), outcome: "upstream_error" };
    this.calls.push(call);
    res.on("close", () => this.log(`${method} ${call.outcome}`));
    if (this.cut === "refuse") {
      call.outcome = "refuse";
      res.socket?.destroy();
      return;
    }
    if (this.cut === "hang") {
      call.outcome = "hang";
      this.held.add(res);
      return;
    }
    const target = new URL(this.upstream.origin);
    target.pathname = req.url!;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json", "content-length": Buffer.byteLength(raw) },
    });
    const flight = { upstream, res, call };
    this.inFlight.add(flight);
    upstream.on("response", (answer) => {
      call.outcome = answer.statusCode ?? 502;
      res.writeHead(answer.statusCode ?? 502, { "content-type": answer.headers["content-type"] ?? "application/json" });
      answer.pipe(res);
      answer.on("end", () => this.inFlight.delete(flight));
    });
    upstream.on("error", () => {
      this.inFlight.delete(flight);
      // A cut already decided what the client sees; otherwise pass the failure on as a reset.
      if (this.cut === null) res.socket?.destroy();
    });
    upstream.end(raw);
  }

  private log(line: string): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // The log is evidence, not control flow: a removed log directory must not break a closing proxy.
    }
  }
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

function parseJson(raw: Buffer): Json {
  try {
    const parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString("utf8")) as unknown);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}
