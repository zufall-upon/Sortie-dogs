import http from "node:http";

export class HttpJsonError extends Error {
  constructor(message, metadata, options = {}) {
    super(message, options);
    this.name = "HttpJsonError";
    this.metadata = metadata;
  }
}

function errorField(error, key) {
  const direct = error?.[key];
  if (typeof direct === "string" || typeof direct === "number") return direct;
  const caused = error?.cause?.[key];
  return typeof caused === "string" || typeof caused === "number" ? caused : null;
}

export function sanitizedHttpFailure(error, fallback = {}) {
  const metadata = error?.metadata ?? {};
  return {
    code: metadata.code ?? errorField(error, "code") ?? null,
    causeCode: metadata.causeCode ?? errorField(error?.cause, "code") ?? null,
    errno: metadata.errno ?? errorField(error, "errno") ?? null,
    syscall: metadata.syscall ?? errorField(error, "syscall") ?? null,
    phase: metadata.phase ?? fallback.phase ?? "unknown",
    elapsedMs: metadata.elapsedMs ?? fallback.elapsedMs ?? null,
    statusCode: metadata.statusCode ?? null,
  };
}

export async function requestJson(baseUrl, path, { method = "GET", body, timeoutMs }) {
  const target = new URL(path, baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new HttpJsonError("HTTP JSON transport requires loopback HTTP", {
      code: "INVALID_LOOPBACK_URL", causeCode: null, errno: null, syscall: null,
      phase: "connect", elapsedMs: 0, statusCode: null,
    });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new HttpJsonError("HTTP JSON transport requires a positive wall-clock timeout", {
      code: "INVALID_TIMEOUT", causeCode: null, errno: null, syscall: null,
      phase: "connect", elapsedMs: 0, statusCode: null,
    });
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const started = Date.now();
  let phase = "connect";
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error, overrides = {}) => {
      const fields = sanitizedHttpFailure(error, { phase, elapsedMs: Date.now() - started });
      finish(rejectPromise, error instanceof HttpJsonError ? error : new HttpJsonError("HTTP JSON request failed", {
        ...fields, ...overrides,
      }, { cause: error }));
    };
    const request = http.request(target, {
      method,
      agent: false,
      headers: payload === undefined ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (response) => {
      phase = "body";
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", fail);
      response.on("end", () => {
        const elapsedMs = Date.now() - started;
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(new HttpJsonError(`HTTP ${response.statusCode}`, {
            code: "HTTP_STATUS", causeCode: null, errno: null, syscall: null,
            phase, elapsedMs, statusCode: response.statusCode,
          }));
          return;
        }
        try {
          finish(resolvePromise, JSON.parse(text));
        } catch (error) {
          fail(new HttpJsonError("Invalid JSON response", {
            code: "INVALID_JSON", causeCode: errorField(error, "code"), errno: null, syscall: null,
            phase, elapsedMs, statusCode: response.statusCode,
          }, { cause: error }));
        }
      });
    });
    request.on("socket", (socket) => {
      if (!socket.connecting) phase = "headers";
      else socket.once("connect", () => { phase = "headers"; });
    });
    request.on("error", fail);
    const timer = setTimeout(() => {
      const elapsedMs = Date.now() - started;
      const error = new HttpJsonError("HTTP JSON wall-clock deadline exceeded", {
        code: "REQUEST_WALL_TIMEOUT", causeCode: null, errno: null, syscall: null,
        phase, elapsedMs, statusCode: null,
      });
      request.destroy(error);
      fail(error);
    }, timeoutMs);
    timer.unref?.();
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
