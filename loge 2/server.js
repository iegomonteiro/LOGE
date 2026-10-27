import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PEERS = Number(process.env.MAX_PEERS) || 8;
const ROOM_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MSGS = 40;
const RATE_MAX_SYNC = 30;

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

app.get("/sala/:id", (req, res) => {
  if (!ROOM_RE.test(req.params.id)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "sala.html"));
});

app.get("/ice", (_req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  const { TURN_URL, TURN_SECRET } = process.env;
  if (TURN_URL && TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + 6 * 3600);
    const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");
    iceServers.push({ urls: TURN_URL.split(","), username, credential });
  }
  res.set("Cache-Control", "no-store").json({ iceServers });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const rooms = new Map();

function makeHash(salaId, pw) {
  return scryptSync(String(pw || ""), `loge:${salaId}`, 32).toString("hex");
}
function checkHash(salaId, pw, stored) {
  if (!stored) return true;
  const a = Buffer.from(makeHash(salaId, pw), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const hostId = (room) => room.keys().next().value;
const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (room, msg, exceptId) => {
  for (const [pid, p] of room) if (pid !== exceptId) send(p.ws, msg);
};

wss.on("connection", (ws) => {
  const id = randomUUID();
  let roomId = null;
  const rate = { window: Date.now(), count: 0, sync: 0 };

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  const allow = (kind = "any") => {
    const now = Date.now();
    if (now - rate.window > RATE_WINDOW_MS) {
      rate.window = now;
      rate.count = 0;
      rate.sync = 0;
    }
    rate.count++;
    if (rate.count > RATE_MAX_MSGS) return false;
    if (kind === "sync") {
      rate.sync++;
      if (rate.sync > RATE_MAX_SYNC) return false;
    }
    return true;
  };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      if (roomId) return;
      if (!allow()) return ws.close(4029, "rate-limited");
      const rid = String(msg.room);
      if (!ROOM_RE.test(rid)) return ws.close(4000, "invalid-room");
      const pw = String(msg.password || "").slice(0, 128);
      if (!rooms.has(rid)) {
        const nova = new Map();
        nova.hash = pw ? makeHash(rid, pw) : null;
        nova.sharer = null;
        rooms.set(rid, nova);
      }
      const room = rooms.get(rid);
      if (room.hash && !checkHash(rid, pw, room.hash)) {
        send(ws, { type: pw ? "wrong-password" : "need-password" });
        return ws.close(4001, "auth");
      }
      if (room.size >= MAX_PEERS) {
        send(ws, { type: "full" });
        return ws.close(4002, "full");
      }
      roomId = rid;
      const name = String(msg.name || "anônimo").trim().slice(0, 24) || "anônimo";
      const peers = [...room].map(([pid, p]) => ({ id: pid, name: p.name }));
      room.set(id, { ws, name });
      send(ws, { type: "joined", id, peers, host: hostId(room), sharer: room.sharer });
      broadcast(room, { type: "peer-joined", id, name }, id);
      return;
    }

    const room = roomId && rooms.get(roomId);
    if (!room) return;
    if (!allow()) return ws.close(4029, "rate-limited");

    if (msg.type === "signal") {
      const target = room.get(msg.to);
      if (target) send(target.ws, { type: "signal", from: id, data: msg.data });
      return;
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 500);
      if (text) broadcast(room, { type: "chat", from: id, name: room.get(id)?.name, text });
      return;
    }

    if (msg.type === "share-start") {
      if (room.sharer && room.sharer !== id)
        return send(ws, { type: "share-denied", by: room.get(room.sharer)?.name || "Alguém" });
      room.sharer = id;
      send(ws, { type: "share-ok" });
      broadcast(room, { type: "sharer", id }, id);
      return;
    }
    if (msg.type === "share-stop" && room.sharer === id) {
      room.sharer = null;
      broadcast(room, { type: "sharer", id: null });
      return;
    }
    if (msg.type === "release" && hostId(room) === id && room.sharer) {
      const alvo = room.get(room.sharer);
      room.sharer = null;
      if (alvo) send(alvo.ws, { type: "stop-share" });
      broadcast(room, { type: "sharer", id: null });
      return;
    }
    if (msg.type === "sync" && room.sharer === id) {
      if (!allow("sync")) return;
      const s = JSON.stringify(msg.data ?? null);
      if (s.length < 300) broadcast(room, { type: "sync", from: id, data: msg.data }, id);
    }
  });

  ws.on("close", () => {
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    const eraHost = hostId(room) === id;
    room.delete(id);
    if (room.size === 0) return rooms.delete(roomId);
    broadcast(room, { type: "peer-left", id });
    if (room.sharer === id) { room.sharer = null; broadcast(room, { type: "sharer", id: null }); }
    if (eraHost) broadcast(room, { type: "host", id: hostId(room) });
  });
});

setInterval(() => {
  wss.clients.forEach((c) => {
    if (!c.isAlive) return c.terminate();
    c.isAlive = false;
    c.ping();
  });
}, 30000);

server.listen(PORT, HOST, () => console.log(`Loge rodando em http://${HOST}:${PORT}`));