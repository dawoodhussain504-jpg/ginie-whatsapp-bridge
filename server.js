const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || "dev_bridge_secret";
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");
const DATABASE_URL = process.env.DATABASE_URL || "";

let sock = null;
let latestQrBase64 = null;
let latestRawQr = null;
let pairingCode = null;
let connectionStatus = "disconnected";
let connectedPhone = null;
let pushName = null;
let n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || "";
let autoReplyEnabled = true;
let autoReplyCustomMessage = "";
const recentReplies = new Map();
let reconnectAttempts = 0;
let isInitializing = false;

// Ensure local auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const logger = pino({ level: "silent" });

// ─── PostgreSQL Session Persistence (Anti-Disconnect) ────────────────────────
let pgPool = null;

if (DATABASE_URL) {
  try {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    });
    console.log("[WhatsApp Bridge DB] PostgreSQL pool configured for session persistence.");
  } catch (err) {
    console.warn("[WhatsApp Bridge DB Warning]: Could not create pool:", err.message);
  }
}

async function initDbTable() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_bridge_auth (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log("[WhatsApp Bridge DB] whatsapp_bridge_auth table ready.");
  } catch (err) {
    console.warn("[WhatsApp Bridge DB Warning]: Could not create auth table:", err.message);
  }
}

async function restoreSessionFromDb() {
  if (!pgPool) return 0;
  try {
    await initDbTable();
    const res = await pgPool.query("SELECT key, value FROM whatsapp_bridge_auth");
    if (res.rows && res.rows.length > 0) {
      for (const row of res.rows) {
        const filePath = path.join(AUTH_DIR, row.key);
        fs.writeFileSync(filePath, row.value, "utf8");
      }
      console.log(`[WhatsApp Bridge DB] Restored ${res.rows.length} session auth keys from PostgreSQL!`);
      return res.rows.length;
    }
  } catch (err) {
    console.warn("[WhatsApp Bridge DB Warning]: Error restoring session from DB:", err.message);
  }
  return 0;
}

async function syncSessionToDb() {
  if (!pgPool) return;
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = fs.readdirSync(AUTH_DIR);
    for (const file of files) {
      const filePath = path.join(AUTH_DIR, file);
      if (fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath, "utf8");
        await pgPool.query(
          `INSERT INTO whatsapp_bridge_auth (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [file, content]
        );
      }
    }
  } catch (err) {
    console.warn("[WhatsApp Bridge DB Warning]: Error syncing session to DB:", err.message);
  }
}

async function clearDbSession() {
  if (!pgPool) return;
  try {
    await pgPool.query("DELETE FROM whatsapp_bridge_auth");
    console.log("[WhatsApp Bridge DB] Cleared database session keys.");
  } catch (err) {
    console.warn("[WhatsApp Bridge DB Warning]: Error clearing DB session:", err.message);
  }
}

// ─── Baileys WhatsApp Web Session ────────────────────────────────────────────

async function initWhatsAppSession() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    // If local auth is empty, attempt to restore from database
    const localFiles = fs.readdirSync(AUTH_DIR);
    if (localFiles.length === 0) {
      await restoreSessionFromDb();
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["GINIE CRM OS", "Chrome", "10.0.0"],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      // Sync updated credentials to PostgreSQL database immediately
      syncSessionToDb().catch(() => {});
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestRawQr = qr;
        connectionStatus = "pairing_qr";
        try {
          latestQrBase64 = await QRCode.toDataURL(qr, {
            width: 380,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          console.log("[WhatsApp Bridge] Fresh pairing QR generated successfully.");
        } catch (err) {
          console.error("QR generation error:", err);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp Bridge] Connection closed (code: ${statusCode}). Logged out: ${isLoggedOut}`
        );

        connectionStatus = "disconnected";
        latestQrBase64 = null;
        latestRawQr = null;
        connectedPhone = null;
        pushName = null;
        isInitializing = false;

        if (isLoggedOut) {
          console.warn("[WhatsApp Bridge] Explicitly logged out from device. Clearing credentials.");
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            await clearDbSession();
          } catch (_) {}
          setTimeout(initWhatsAppSession, 3000);
        } else {
          // Automatic resilient reconnect with exponential backoff (Max 30s)
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 2000, 30000);
          console.log(`[WhatsApp Bridge] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
          setTimeout(initWhatsAppSession, delay);
        }
      } else if (connection === "open") {
        connectionStatus = "connected";
        latestQrBase64 = null;
        latestRawQr = null;
        reconnectAttempts = 0;
        isInitializing = false;

        connectedPhone = sock.user?.id ? sock.user.id.split(":")[0].split("@")[0] : null;
        pushName = sock.user?.name || "Merchant";

        console.log(`[WhatsApp Bridge] Connected to WhatsApp Web successfully as +${connectedPhone} (${pushName})!`);

        // Do a full sync of all session keys to database upon open
        syncSessionToDb().catch(() => {});
      }
    });

    // Listen to incoming messages and handle Auto-Responder + n8n forwarding
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !messages || messages.length === 0) return;
      const msg = messages[0];
      if (msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes("@g.us")) return; // ignore group messages

      const fromPhone = remoteJid.split("@")[0];
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

      console.log(`[WhatsApp Incoming] Received message from ${fromPhone}: "${body}"`);

      // 1. Forward to n8n Webhook if configured
      if (n8nWebhookUrl && body) {
        try {
          await fetch(n8nWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "whatsapp.incoming",
              from: fromPhone,
              message: body,
              timestamp: new Date().toISOString(),
            }),
          });
        } catch (e) {
          console.warn("[n8n Forwarding Warning]:", e?.message);
        }
      }

      // 2. Autonomous Built-in Auto-Reply
      if (autoReplyEnabled && body) {
        try {
          const now = Date.now();
          const lastReplied = recentReplies.get(fromPhone) || 0;
          if (now - lastReplied > 60000) {
            recentReplies.set(fromPhone, now);

            const autoReplyText =
              autoReplyCustomMessage ||
              `[GINIE CRM Autonomous Assistant]\nNamaste! Thank you for reaching out.\nYour message has been received: "${body.substring(0, 40)}"\nOur team will assist you shortly.`;

            await sock.sendMessage(remoteJid, { text: autoReplyText });
            console.log(`[WhatsApp Auto-Reply] Successfully sent auto-reply to ${fromPhone}`);
          }
        } catch (err) {
          console.warn("[WhatsApp Auto-Reply Warning]:", err?.message);
        }
      }
    });
  } catch (err) {
    console.error("[WhatsApp Bridge Init Error]:", err);
    isInitializing = false;
    setTimeout(initWhatsAppSession, 5000);
  }
}

// ─── Continuous Socket Heartbeat & Anti-Sleep Ping ──────────────────────────

// Active WebSocket presence update every 30 seconds to prevent idle disconnection
setInterval(() => {
  if (sock && connectionStatus === "connected") {
    try {
      sock.sendPresenceUpdate("available");
    } catch (_) {}
  }
}, 30 * 1000);

// Anti-Sleep self-ping every 8 minutes on Render/Cloud hosting
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL) {
    fetch(`${SELF_URL}/health`)
      .then(() => console.log(`[Anti-Sleep Keep-Alive] Ping sent to ${SELF_URL}`))
      .catch((err) => console.warn(`[Anti-Sleep Warning]: ${err.message}`));
  }
}, 8 * 60 * 1000);

// ─── REST API Endpoints ─────────────────────────────────────────────────────

// Auth check for internal bridge calls (optional secret protection)
const checkSecret = (req) => {
  const incoming = req.headers["x-bridge-secret"];
  if (!BRIDGE_SECRET || BRIDGE_SECRET === "dev_bridge_secret") return true;
  return incoming === BRIDGE_SECRET;
};

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GINIE WhatsApp Web Bridge",
    connection: connectionStatus,
    phone: connectedPhone ? `+${connectedPhone}` : null,
    pushName,
    dbPersistence: !!pgPool,
  });
});

app.get("/status", (req, res) => {
  res.json({
    connected: connectionStatus === "connected",
    status: connectionStatus,
    phone: connectedPhone ? `+${connectedPhone}` : null,
    pushName,
    autoReplyEnabled,
    dbPersistence: !!pgPool,
  });
});

app.get("/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({
      status: "connected",
      phone: connectedPhone ? `+${connectedPhone}` : null,
      pushName,
      message: "Device already linked and permanently active.",
    });
  }

  if (latestQrBase64) {
    return res.json({
      status: "pairing_qr",
      qr: latestQrBase64,
      raw: latestRawQr,
    });
  }

  res.json({
    status: "connecting",
    message: "Generating pairing handshake with WhatsApp servers...",
  });
});

// Request 8-digit Pairing Code directly (Alternative to QR scan)
app.post("/pairing-code", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Please provide a valid phone number" });
  }

  const cleanPhone = String(phone).replace(/\D/g, "");
  if (cleanPhone.length < 10) {
    return res.status(400).json({ success: false, error: "Phone number must be at least 10 digits" });
  }

  if (connectionStatus === "connected") {
    return res.json({ success: true, message: "Already connected to WhatsApp!", connected: true });
  }

  try {
    if (!sock) {
      await initWhatsAppSession();
    }
    const code = await sock.requestPairingCode(cleanPhone);
    pairingCode = code;
    res.json({
      success: true,
      pairingCode: code,
      phone: cleanPhone,
      message: "Pairing code generated! Open WhatsApp > Linked Devices > Link with Phone Number.",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || "Failed to generate pairing code" });
  }
});

app.post("/autoreply", (req, res) => {
  const { enabled, customMessage } = req.body;
  if (typeof enabled === "boolean") autoReplyEnabled = enabled;
  if (typeof customMessage === "string") autoReplyCustomMessage = customMessage;
  res.json({
    success: true,
    autoReplyEnabled,
    autoReplyCustomMessage,
  });
});

app.post("/send", async (req, res) => {
  const { number, text } = req.body;

  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp device is not connected. Please scan QR or link device first.",
    });
  }

  if (!number || !text) {
    return res.status(400).json({
      success: false,
      error: "Missing number or text in payload.",
    });
  }

  try {
    let cleanNumber = String(number).replace(/[^0-9]/g, "");

    // Normalize 10-digit Indian numbers without country code
    if (cleanNumber.length === 10 && /^[6-9]/.test(cleanNumber)) {
      cleanNumber = "91" + cleanNumber;
    } else if (cleanNumber.length === 11 && cleanNumber.startsWith("0")) {
      cleanNumber = "91" + cleanNumber.slice(1);
    }

    if (cleanNumber.length < 10) {
      return res.status(400).json({
        success: false,
        error: `Incomplete phone number '${number}' (${cleanNumber.length} digits). Standard mobile numbers require at least 10 digits.`,
      });
    }

    const jid = `${cleanNumber}@s.whatsapp.net`;
    let targetJid = jid;

    // Verify whether number exists on WhatsApp
    try {
      const [onWa] = await sock.onWhatsApp(jid);
      if (onWa && onWa.exists) {
        targetJid = onWa.jid;
      }
    } catch (checkErr) {
      console.warn("[onWhatsApp check warning]:", checkErr?.message);
    }

    const result = await sock.sendMessage(targetJid, { text });

    res.json({
      success: true,
      messageId: result?.key?.id || `msg_${Date.now()}`,
      recipient: cleanNumber,
      jid: targetJid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Message send error:", error);
    res.status(500).json({
      success: false,
      error: error?.message || "Failed to dispatch message.",
    });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    connectionStatus = "disconnected";
    latestQrBase64 = null;
    connectedPhone = null;
    pushName = null;
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      await clearDbSession();
    } catch (_) {}
    setTimeout(initWhatsAppSession, 1000);
    res.json({ success: true, message: "Logged out successfully and auth session cleared." });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 [GINIE WhatsApp Web Bridge] Daemon running on port ${PORT}`);
  if (DATABASE_URL) {
    await restoreSessionFromDb();
  }
  initWhatsAppSession();
});
