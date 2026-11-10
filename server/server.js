const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOM_TTL_MS = Math.max(60, Number(process.env.ROOM_TTL_SECONDS || 3600)) * 1000;
const MAX_PEERS = Math.min(2, Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM || 2)));
const MAX_MESSAGE_BYTES = 256 * 1024;
const rooms = new Map();

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function makeCode() {
  // 8 characters from an ambiguity-reduced alphabet.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
}
function validCode(value) {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{6,12}$/.test(value);
}
function cleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const peer of room.peers.values()) {
    send(peer, { type: "room_closed", reason: "expired_or_closed" });
    try { peer.close(1000, "room closed"); } catch {}
  }
  rooms.delete(code);
}
function sendToOther(room, ws, payload) {
  for (const peer of room.peers.values()) {
    if (peer !== ws) send(peer, payload);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      service: "TARZAN SCREEN CAST signaling",
      websocket: "/ws",
      activeRooms: rooms.size
    }));
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.role = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: "error", code: "invalid_json" }); return; }

    if (!msg || typeof msg.type !== "string") {
      send(ws, { type: "error", code: "invalid_message" }); return;
    }

    if (msg.type === "create_room") {
      if (ws.roomCode) { send(ws, { type: "error", code: "already_in_room" }); return; }
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = { peers: new Map(), expiresAt: Date.now() + ROOM_TTL_MS };
      rooms.set(code, room);
      ws.roomCode = code;
      ws.role = "sender";
      room.peers.set("sender", ws);
      send(ws, { type: "room_created", room: code, expiresInSeconds: Math.floor(ROOM_TTL_MS / 1000) });
      return;
    }

    if (msg.type === "join_room") {
      if (ws.roomCode) { send(ws, { type: "error", code: "already_in_room" }); return; }
      const code = String(msg.room || "").toUpperCase();
      if (!validCode(code)) { send(ws, { type: "error", code: "invalid_room_code" }); return; }
      const room = rooms.get(code);
      if (!room || room.expiresAt < Date.now()) {
        if (room) cleanRoom(code);
        send(ws, { type: "error", code: "room_not_found" }); return;
      }
      if (room.peers.size >= MAX_PEERS || room.peers.has("receiver")) {
        send(ws, { type: "error", code: "room_full" }); return;
      }
      ws.roomCode = code;
      ws.role = "receiver";
      room.peers.set("receiver", ws);
      send(ws, { type: "joined", room: code, role: "receiver" });
      const sender = room.peers.get("sender");
      send(sender, { type: "peer_joined", role: "receiver" });
      return;
    }

    if (msg.type === "leave_room" || msg.type === "hangup") {
      const code = ws.roomCode;
      if (code && rooms.has(code)) {
        const room = rooms.get(code);
        sendToOther(room, ws, { type: "peer_left", role: ws.role });
        if (ws.role === "sender") cleanRoom(code);
        else room.peers.delete("receiver");
      }
      ws.roomCode = null;
      ws.role = null;
      send(ws, { type: "left" });
      return;
    }

    const allowed = new Set(["offer", "answer", "ice_candidate", "renegotiate"]);
    if (!allowed.has(msg.type)) {
      send(ws, { type: "error", code: "unsupported_type" }); return;
    }
    if (!ws.roomCode || !rooms.has(ws.roomCode)) {
      send(ws, { type: "error", code: "not_in_room" }); return;
    }
    const room = rooms.get(ws.roomCode);
    const peer = [...room.peers.values()].find(p => p !== ws);
    if (!peer) { send(ws, { type: "error", code: "peer_not_connected" }); return; }

    // Relay only the signaling payload; the media stream does not pass through this server.
    const forwarded = { type: msg.type };
    if (msg.sdp !== undefined) forwarded.sdp = msg.sdp;
    if (msg.candidate !== undefined) forwarded.candidate = msg.candidate;
    if (msg.mid !== undefined) forwarded.mid = msg.mid;
    if (msg.mLineIndex !== undefined) forwarded.mLineIndex = msg.mLineIndex;
    if (msg.data !== undefined) forwarded.data = msg.data;
    send(peer, forwarded);
  });

  ws.on("close", () => {
    const code = ws.roomCode;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    sendToOther(room, ws, { type: "peer_left", role: ws.role });
    if (ws.role === "sender") cleanRoom(code);
    else room.peers.delete("receiver");
  });
  ws.on("error", () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt < now) cleanRoom(code);
  }
}, 30000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`TARZAN signaling listening on ${HOST}:${PORT}`);
});
