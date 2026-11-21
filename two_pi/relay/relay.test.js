const test = require("node:test");
const assert = require("node:assert");
const { createRelay } = require("./server.js");

const KEY = "write-key-for-tests", READ = "read-key-for-tests";
const frame = (id, extra = {}) => ({ source: "test", robots: [{ id, joints: [0, -1.57, 0, -1.57, -1.57, 0], robotMode: 7, safetyMode: 1, ...extra }] });

async function start(opts = { writeKey: KEY, readKey: READ }) {
  const server = createRelay(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "GET", key, body } = {}) =>
    fetch(base + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { server, base, call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("two Pis post one arm each and a reader sees both", async () => {
  const r = await start();
  assert.equal((await r.call("/api/robots/live", { method: "POST", key: KEY, body: frame("ur-small") })).status, 204);
  assert.equal((await r.call("/api/robots/live", { method: "POST", key: KEY, body: frame("ur-large", { safetyMode: 3 }) })).status, 204);
  const res = await r.call("/api/robots/live", { key: READ });
  const body = await res.json();
  assert.equal(body.live, true);
  assert.deepEqual(body.robots.map((x) => [x.id, x.tone, x.live]), [["ur-small", "ok", true], ["ur-large", "bad", true]]);
  assert.equal(body.robots[1].safetyMode, "protective-stop");
  await r.close();
});

test("posting needs the write key; reading needs a key; health is open and shows no joints", async () => {
  const r = await start();
  assert.equal((await r.call("/api/robots/live", { method: "POST", body: frame("a") })).status, 401);
  assert.equal((await r.call("/api/robots/live", { method: "POST", key: READ, body: frame("a") })).status, 401, "the read key must not be able to post");
  assert.equal((await r.call("/api/robots/live")).status, 401);
  assert.equal((await r.call("/api/robots/live", { key: KEY })).status, 200, "the write key can also read");
  const health = await (await r.call("/healthz")).json();
  assert.deepEqual(health, { ok: true, service: "arm-state relay", liveRobots: 0, keySet: true });
  await r.close();
});

test("with no key set the relay refuses everything", async () => {
  const r = await start({ writeKey: "", readKey: "" });
  assert.equal((await r.call("/api/robots/live", { method: "POST", key: "anything", body: frame("a") })).status, 503);
  assert.equal((await r.call("/api/robots/live", { key: "anything" })).status, 503);
  await r.close();
});

test("bad frames are refused", async () => {
  const r = await start();
  const post = (body) => r.call("/api/robots/live", { method: "POST", key: KEY, body });
  assert.equal((await post({ robots: [] })).status, 400);
  assert.equal((await post({ robots: [{ id: "a", joints: [1, 2, 3] }] })).status, 400);
  assert.equal((await post({ robots: [{ id: "a", joints: [0, 0, 0, 0, 0, 99] }] })).status, 400);
  assert.equal((await post({ robots: [{ id: "bad id!", joints: [0, 0, 0, 0, 0, 0] }] })).status, 400);
  assert.equal((await post(frame("a", { robotMode: 42 }))).status, 400);
  assert.equal((await r.call("/api/robots/command", { method: "POST", key: KEY, body: {} })).status, 404, "there is no route that commands a robot");
  await r.close();
});

test("an arm goes stale 2 s after its frames stop", async () => {
  const r = await start();
  await r.call("/api/robots/live", { method: "POST", key: KEY, body: frame("ur-small") });
  await new Promise((s) => setTimeout(s, 2200));
  const body = await (await r.call("/api/robots/live", { key: READ })).json();
  assert.equal(body.live, false);
  assert.equal(body.robots[0].live, false);
  await r.close();
});

test("the stream delivers frames as they are posted", async () => {
  const r = await start();
  const res = await r.call("/api/robots/live/stream", { key: READ });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read(); // ": connected"
  await r.call("/api/robots/live", { method: "POST", key: KEY, body: frame("ur-large") });
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /^event: robots\ndata: /);
  assert.equal(JSON.parse(text.split("data: ")[1]).robots[0].id, "ur-large");
  await reader.cancel();
  await r.close();
});
