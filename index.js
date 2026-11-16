
import express from "express";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import P from "pino";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

// =====================================
// TARZAN WHATSAPP VIP
// MULTI USER / MULTI SESSION SERVER
// HEARTBEAT ENABLED
// =====================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || "./data"
);
const AUTH_DIR = path.join(DATA_DIR, "sessions");

await fs.mkdir(AUTH_DIR, { recursive: true });

const db = new Database(
  path.join(DATA_DIR, "database.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const logger = P({ level: "silent" });

// =====================================
// SECURITY AND AUTHENTICATION
// =====================================

const sessions = new Map();
const sockets = new Map();
const clients = new Map();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function createToken(userId) {
  const token = crypto.randomBytes(48).toString("hex");

  const expires =
    Date.now() + 30 * 24 * 60 * 60 * 1000;

  db.prepare(`
    INSERT INTO tokens(token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(hashToken(token), userId, expires);

  return token;
}

function authenticate(req, res, next) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "Authentication required"
    });
  }

  const token = authorization.slice(7);

  if (token.length < 50 || token.length > 200) {
    return res.status(401).json({
      ok: false,
      error: "Invalid session"
    });
  }

  const record = db.prepare(`
    SELECT users.id, users.username, tokens.expires_at
    FROM tokens
    JOIN users ON users.id = tokens.user_id
    WHERE tokens.token_hash = ?
  `).get(hashToken(token));

  if (!record || record.expires_at < Date.now()) {
    return res.status(401).json({
      ok: false,
      error: "Session expired"
    });
  }

  req.user = {
    id: record.id,
    username: record.username
  };

  next();
}

function userDirectory(userId) {
  return path.join(AUTH_DIR, userId);
}

function getSession(userId) {
  return sessions.get(userId);
}

// =====================================
// USER EVENT DELIVERY
// =====================================

function sendToUser(userId, type, data = {}) {
  const connections = clients.get(userId);

  if (!connections) return;

  const payload = JSON.stringify({
    type,
    ...data,
    time: Date.now()
  });

  for (const client of connections) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        // Ignore individual client send errors
      }
    }
  }
}

function updateUserStatus(userId, status, extra = {}) {
  const session = getSession(userId);

  if (session) {
    session.status = status;
  }

  sendToUser(userId, "status", {
    status,
    ...extra
  });
}

// =====================================
// HEARTBEAT ENGINE
// =====================================

const HEARTBEAT_INTERVAL = 25000;

function heartbeatResponse(ws) {
  if (ws.readyState !== 1) return;

  try {
    ws.send(JSON.stringify({
      type: "heartbeat_ack",
      status: "alive",
      time: Date.now()
    }));
  } catch {
    ws.terminate();
  }
}

// Server WebSocket Ping/Pong
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;

    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL);

heartbeatTimer.unref();

// =====================================
// WHATSAPP SESSION MANAGER
// =====================================

async function connectUser(userId, phoneNumber = null) {
  let session = getSession(userId);

  if (session?.connecting || session?.sock) {
    throw new Error("WhatsApp session already started");
  }

  if (!session) {
    session = {
      sock: null,
      status: "disconnected",
      connecting: false,
      manuallyStopped: false,
      reconnectTimer: null
    };

    sessions.set(userId, session);
  }

  session.connecting = true;
  session.manuallyStopped = false;

  clearTimeout(session.reconnectTimer);

  try {
    const directory = userDirectory(userId);

    await fs.mkdir(directory, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(directory);

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);

          sendToUser(userId, "qr", {
            qr,
            qrDataUrl: qrImage
          });
        } catch {
          sendToUser(userId, "error", {
            error: "QR generation failed"
          });
        }
      }

      if (connection === "connecting") {
        updateUserStatus(userId, "connecting");
      }

      if (connection === "open") {
        updateUserStatus(userId, "connected", {
          user: sock.user?.id || null
        });
      }

      if (connection === "close") {
        const code =
          lastDisconnect?.error?.output?.statusCode;

        session.sock = null;

        if (code === DisconnectReason.loggedOut) {
          updateUserStatus(userId, "logged_out");
          return;
        }

        updateUserStatus(userId, "disconnected");

        if (!session.manuallyStopped) {
          session.reconnectTimer = setTimeout(() => {
            connectUser(userId).catch(() => {});
          }, 5000);
        }
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const message of messages) {
        const data = message.message || {};

        const text =
          data.conversation ||
          data.extendedTextMessage?.text ||
          data.imageMessage?.caption ||
          data.videoMessage?.caption ||
          "";

        sendToUser(userId, "message", {
          eventType: type,
          message: {
            id: message.key?.id || null,
            jid: message.key?.remoteJid || null,
            fromMe: Boolean(message.key?.fromMe),
            timestamp: message.messageTimestamp || null,
            text
          }
        });
      }
    });

    sock.ev.on("messages.update", updates => {
      sendToUser(userId, "messages_update", { updates });
    });

    sock.ev.on("chats.upsert", chats => {
      sendToUser(userId, "chats_upsert", { chats });
    });

    sock.ev.on("contacts.upsert", contacts => {
      sendToUser(userId, "contacts_upsert", { contacts });
    });

    if (phoneNumber) {
      if (state.creds.registered) {
        throw new Error("WhatsApp account already paired");
      }

      const code = await sock.requestPairingCode(phoneNumber);
      return code;
    }

    return null;

  } finally {
    session.connecting = false;
  }
}

// =====================================
// BASIC SERVER
// =====================================

app.get("/", (req, res) => {
  res.json({
    name: "TARZAN WHATSAPP VIP",
    version: "2.1.0",
    status: "running",
    architecture: "multi-user multi-session",
    heartbeat: "enabled"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    activeSessions: [...sessions.values()]
      .filter(s => s.status === "connected").length,
    websocketClients: wss.clients.size,
    heartbeat: "active",
    time: Date.now()
  });
});

// =====================================
// HTTP HEARTBEAT
// =====================================

app.post("/api/heartbeat", authenticate, (req, res) => {
  const session = getSession(req.user.id);

  res.json({
    ok: true,
    type: "heartbeat",
    server: "alive",
    whatsapp: session?.status || "disconnected",
    connected: session?.status === "connected",
    time: Date.now()
  });
});

// =====================================
// REGISTER
// =====================================

app.post(
  "/api/register",
  registerLimiter,
  async (req, res) => {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body?.password || "");

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({
        ok: false,
        error: "Username must be 3-24 characters"
      });
    }

    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({
        ok: false,
        error: "Password must be 10-128 characters"
      });
    }

    try {
      const id = crypto.randomUUID();

      const passwordHash = await bcrypt.hash(password, 12);

      db.prepare(`
        INSERT INTO users(id, username, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(id, username, passwordHash, Date.now());

      const token = createToken(id);

      res.status(201).json({
        ok: true,
        user: { id, username },
        token
      });

    } catch (error) {
      if (String(error.code).includes("SQLITE_CONSTRAINT")) {
        return res.status(409).json({
          ok: false,
          error: "Username already exists"
        });
      }

      res.status(500).json({
        ok: false,
        error: "Registration failed"
      });
    }
  }
);

// =====================================
// LOGIN
// =====================================

app.post(
  "/api/login",
  loginLimiter,
  async (req, res) => {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body?.password || "");

    const user = db.prepare(`
      SELECT id, username, password_hash
      FROM users
      WHERE username = ?
    `).get(username);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        ok: false,
        error: "Invalid username or password"
      });
    }

    const token = createToken(user.id);

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username
      },
      token
    });
  }
);

// =====================================
// CURRENT USER
// =====================================

app.get("/api/me", authenticate, (req, res) => {
  res.json({
    ok: true,
    user: req.user
  });
});

// =====================================
// LOGOUT APPLICATION ACCOUNT
// =====================================

app.post("/api/logout", authenticate, (req, res) => {
  const token = req.headers.authorization.slice(7);

  db.prepare(`
    DELETE FROM tokens WHERE token_hash = ?
  `).run(hashToken(token));

  res.json({ ok: true });
});

// =====================================
// WHATSAPP STATUS
// =====================================

app.get(
  "/api/whatsapp/status",
  authenticate,
  (req, res) => {
    const session = getSession(req.user.id);

    res.json({
      ok: true,
      status: session?.status || "disconnected",
      connected: session?.status === "connected",
      user: session?.sock?.user?.id || null
    });
  }
);

// =====================================
// CONNECT QR
// =====================================

app.post(
  "/api/whatsapp/connect/qr",
  authenticate,
  async (req, res) => {
    try {
      await connectUser(req.user.id);

      res.json({
        ok: true,
        message: "QR will arrive through your WebSocket"
      });

    } catch (error) {
      res.status(409).json({
        ok: false,
        error: error.message
      });
    }
  }
);

// =====================================
// CONNECT PAIRING CODE
// =====================================

app.post(
  "/api/whatsapp/connect/pair",
  authenticate,
  async (req, res) => {
    const phone = String(req.body?.phoneNumber || "")
      .replace(/\D/g, "");

    if (phone.length < 8 || phone.length > 15) {
      return res.status(400).json({
        ok: false,
        error: "Invalid international phone number"
      });
    }

    try {
      const code = await connectUser(req.user.id, phone);

      res.json({
        ok: true,
        pairingCode: code
      });

    } catch (error) {
      res.status(409).json({
        ok: false,
        error: error.message
      });
    }
  }
);

// =====================================
// SEND MESSAGE
// =====================================

app.post(
  "/api/whatsapp/send",
  authenticate,
  async (req, res) => {
    const session = getSession(req.user.id);

    const jid = String(req.body?.jid || "").trim();
    const message = String(req.body?.text || "");

    if (!session?.sock || session.status !== "connected") {
      return res.status(409).json({
        ok: false,
        error: "WhatsApp is not connected"
      });
    }

    if (!/^[0-9]+(?:-[0-9]+)?@(s\.whatsapp\.net|g\.us)$/.test(jid)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid recipient"
      });
    }

    if (!message.trim() || message.length > 4000) {
      return res.status(400).json({
        ok: false,
        error: "Invalid message"
      });
    }

    try {
      const result = await session.sock.sendMessage(jid, {
        text: message
      });

      res.json({
        ok: true,
        messageId: result?.key?.id || null
      });

    } catch {
      res.status(500).json({
        ok: false,
        error: "Message sending failed"
      });
    }
  }
);

// =====================================
// WHATSAPP LOGOUT
// =====================================

app.post(
  "/api/whatsapp/logout",
  authenticate,
  async (req, res) => {
    const userId = req.user.id;
    const session = getSession(userId);

    if (!session?.sock) {
      return res.json({ ok: true });
    }

    session.manuallyStopped = true;
    clearTimeout(session.reconnectTimer);

    try {
      const current = session.sock;
      session.sock = null;

      await current.logout();

      session.status = "logged_out";

      res.json({ ok: true });

    } catch {
      res.status(500).json({
        ok: false,
        error: "WhatsApp logout failed"
      });
    }
  }
);

// =====================================
// WEBSOCKET AUTHENTICATION
// =====================================

server.on("upgrade", (request, socket, head) => {
  let pathname;

  try {
    pathname = new URL(
      request.url,
      "http://localhost"
    ).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const authorization = request.headers.authorization || "";

  if (
    pathname !== "/ws" ||
    !authorization.startsWith("Bearer ")
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = authorization.slice(7);

  if (token.length < 50 || token.length > 200) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const user = db.prepare(`
    SELECT user_id
    FROM tokens
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());

  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    ws.userId = user.user_id;
    wss.emit("connection", ws);
  });
});

// =====================================
// WEBSOCKET CONNECTION + HEARTBEAT
// =====================================

wss.on("connection", ws => {
  const userId = ws.userId;

  ws.isAlive = true;

  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }

  clients.get(userId).add(ws);

  const session = getSession(userId);

  ws.send(JSON.stringify({
    type: "status",
    status: session?.status || "disconnected",
    connected: session?.status === "connected",
    time: Date.now()
  }));

  // Automatic Ping/Pong response
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Application heartbeat
  ws.on("message", raw => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "heartbeat") {
        ws.isAlive = true;
        heartbeatResponse(ws);
      }

    } catch {
      // Ignore invalid heartbeat payloads
    }
  });

  ws.on("error", () => {
    ws.isAlive = false;
  });

  ws.on("close", () => {
    const userClients = clients.get(userId);

    if (!userClients) return;

    userClients.delete(ws);

    if (userClients.size === 0) {
      clients.delete(userId);
    }
  });
});

// =====================================
// GRACEFUL SHUTDOWN
// =====================================

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`Received ${signal}. Closing server...`);

  clearInterval(heartbeatTimer);

  for (const ws of wss.clients) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      ws.terminate();
    }
  }

  for (const session of sessions.values()) {
    clearTimeout(session.reconnectTimer);

    if (session.sock) {
      try {
        session.sock.end(undefined);
      } catch {
        // Ignore shutdown socket errors
      }

      session.sock = null;
    }
  }

  server.close(() => {
    try {
      db.close();
    } catch {
      // Database may already be closed
    }

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 25000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// =====================================
// SERVER START
// =====================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log(" TARZAN WHATSAPP VIP");
  console.log(" MULTI USER SERVER");
  console.log(" HEARTBEAT ENABLED");
  console.log(" SERVER ONLINE");
  console.log(` PORT: ${PORT}`);
  console.log("--------------------------------");
});
