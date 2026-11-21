#!/usr/bin/env node
/**
 * arm-state relay: the meeting point between the Pis on the arms and FactoryForm.
 *
 *   Pi on each arm  --POST /api/robots/live-->  this relay  <--GET-- FactoryForm
 *
 * It speaks the same three routes, with the same JSON, as FactoryForm's own
 * server/robot-live.js, so arm_state_pusher.py can post to either one and
 * FactoryForm's twin can read either one:
 *
 *   POST /api/robots/live          { source, robots: [{ id, joints[6], tcp?, robotMode?, safetyMode?, model?, simulated? }] }
 *   GET  /api/robots/live          { live, robots: [...] }
 *   GET  /api/robots/live/stream   the same frames as Server-Sent Events
 *   GET  /healthz                  open; says only how many arms are live
 *
 * Observation only. Nothing here, and nothing reachable from here, can send a
 * command to a robot. State is kept in memory, never stored, and an arm reads
 * as not live 2 s after its frames stop.
 *
 * Keys (environment):
 *   ROBOT_API_KEY    required. Pis send it as `Authorization: Bearer ...` to post.
 *   ROBOT_READ_KEY   optional. Readers send it the same way; if unset, readers use ROBOT_API_KEY.
 *   PORT             default 3001
 *
 * No dependencies: Node 18+ standard library only.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const STALE_MS = 2000;
const MAX_ROBOTS = 16;
const MAX_BODY = 64 * 1024;

// Universal Robots' controller enums, as the real-time interface reports them.
const ROBOT_MODES = {
  "-1": "no-controller", 0: "disconnected", 1: "confirm-safety", 2: "booting", 3: "power-off",
  4: "power-on", 5: "idle", 6: "backdrive", 7: "running", 8: "updating-firmware",
};
const SAFETY_MODES = {
  1: "normal", 2: "reduced", 3: "protective-stop", 4: "recovery", 5: "safeguard-stop", 6: "system-emergency-stop",
  7: "robot-emergency-stop", 8: "violation", 9: "fault", 10: "validate-joint-id", 11: "undefined",
  12: "automatic-mode-safeguard-stop", 13: "three-position-enabling-stop",
};

function robotTone(robotMode, safetyMode) {
  if (safetyMode && !["normal", "reduced"].includes(safetyMode)) return "bad";
  if (robotMode === "running") return "ok";
  if (robotMode === "no-controller" || robotMode === "disconnected") return "bad";
  return "warn";
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function mode(value, table, field) {
  if (value === undefined || value === null) return null;
  if (Number.isInteger(value) && table[value]) return table[value];
  if (typeof value === "string" && Object.values(table).includes(value)) return value;
  fail(400, `${field} is not a mode the controller reports`);
}

function parse(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROBOTS) fail(400, `robots must be an array of 1 to ${MAX_ROBOTS} robots`);
  return list.map((r, i) => {
    const where = `robots[${i}]`;
    if (!r || typeof r.id !== "string" || !ID.test(r.id)) fail(400, `${where}.id is required`);
    if (!Array.isArray(r.joints) || r.joints.length !== 6 || !r.joints.every(Number.isFinite) || r.joints.some((v) => Math.abs(v) > 4 * Math.PI))
      fail(400, `${where}.joints must be six joint angles in radians`);
    const tcp = r.tcp === undefined || r.tcp === null ? null : r.tcp;
    if (tcp && (!Array.isArray(tcp) || tcp.length !== 6 || !tcp.every(Number.isFinite))) fail(400, `${where}.tcp must be [x, y, z, rx, ry, rz] in metres and radians`);
    const robotMode = mode(r.robotMode, ROBOT_MODES, `${where}.robotMode`);
    const safetyMode = mode(r.safetyMode, SAFETY_MODES, `${where}.safetyMode`);
    return {
      id: r.id, joints: r.joints, tcp, robotMode, safetyMode, tone: robotTone(robotMode, safetyMode),
      model: typeof r.model === "string" ? r.model.slice(0, 40) : null,
      simulated: r.simulated === true,
    };
  });
}

function sameKey(provided, key) {
  const expected = `Bearer ${key}`;
  return Buffer.byteLength(provided) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function createRelay({ writeKey = process.env.ROBOT_API_KEY || "", readKey = process.env.ROBOT_READ_KEY || "" } = {}) {
  const robots = new Map();
  const listeners = new Set();
  const isLive = (r, now = Date.now()) => now - r.receivedAt < STALE_MS;

  function authorize(req, kind) {
    if (!writeKey) fail(503, "ROBOT_API_KEY is not set on the relay, so it accepts nothing yet");
    const provided = req.headers.authorization || "";
    const keys = kind === "write" ? [writeKey] : [readKey, writeKey].filter(Boolean);
    if (!keys.some((k) => sameKey(provided, k))) fail(401, "Valid bearer key required");
  }

  function status() {
    const now = Date.now();
    return {
      live: [...robots.values()].some((r) => isLive(r, now)),
      robots: [...robots.values()].map((r) => ({ ...r, live: isLive(r, now), receivedAt: new Date(r.receivedAt).toISOString() })),
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, "Body too large")); req.destroy(); } else chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new HttpError(400, "Body must be JSON")); }
      });
      req.on("error", reject);
    });
  }

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    const path = new URL(req.url, "http://relay").pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (path === "/healthz" || path === "/")) {
      const now = Date.now();
      return json(res, 200, { ok: true, service: "arm-state relay", liveRobots: [...robots.values()].filter((r) => isLive(r, now)).length, keySet: Boolean(writeKey) });
    }
    if (path === "/api/robots/live" && req.method === "GET") {
      authorize(req, "read");
      return json(res, 200, status());
    }
    if (path === "/api/robots/live" && req.method === "POST") {
      authorize(req, "write");
      const body = await readBody(req);
      const frame = parse(body.robots);
      const receivedAt = Date.now();
      const source = typeof body.source === "string" ? body.source.slice(0, 80) : "unknown";
      for (const r of frame) robots.set(r.id, { ...r, source, receivedAt });
      const payload = `event: robots\ndata: ${JSON.stringify({ robots: frame, receivedAt })}\n\n`;
      for (const l of listeners) l.write(payload);
      res.writeHead(204);
      return res.end();
    }
    if (path === "/api/robots/live/stream" && req.method === "GET") {
      authorize(req, "read");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const fresh = [...robots.values()].filter((r) => isLive(r));
      if (fresh.length) res.write(`event: robots\ndata: ${JSON.stringify({ robots: fresh, receivedAt: Date.now() })}\n\n`);
      else res.write(": connected\n\n");
      listeners.add(res);
      const timer = setInterval(() => res.write(": keepalive\n\n"), 20000);
      timer.unref();
      req.on("close", () => { clearInterval(timer); listeners.delete(res); });
      return;
    }
    fail(404, "Not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      json(res, err.status || 500, { error: err.status ? err.message : "Internal error" });
      if (!err.status) console.error(err);
    });
  });
  server.on("close", () => { for (const l of listeners) l.end(); listeners.clear(); });
  return server;
}

module.exports = { createRelay, robotTone, STALE_MS };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  if (!process.env.ROBOT_API_KEY) console.warn("ROBOT_API_KEY is not set: the relay will refuse every post and read until it is.");
  createRelay().listen(port, "0.0.0.0", () => console.log(`arm-state relay listening on :${port}`));
}
