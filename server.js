const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

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
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");

let sock = null;
let latestQrBase64 = null;
let latestRawQr = null;
let pairingCode = null;
let connectionStatus = "disconnected";
let connectedPhone = null;
let pushName = null;
let n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || "";

// Ensure auth dir exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const logger = pino({ level: "silent" });

async function initWhatsAppSession() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["Ginie Space OS", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestRawQr = qr;
      connectionStatus = "pairing_qr";
      try {
        latestQrBase64 = await QRCode.toDataURL(qr);
        console.log("[WhatsApp Bridge] Fresh QR generated successfully.");
      } catch (err) {
        console.error("QR Code generation error:", err);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp Bridge] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      connectionStatus = "disconnected";
      latestQrBase64 = null;

      if (shouldReconnect) {
        setTimeout(initWhatsAppSession, 3000);
      } else {
        // Clear auth folder if logged out
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (_) {}
      }
    } else if (connection === "open") {
      console.log("[WhatsApp Bridge] Connected to WhatsApp Web successfully!");
      connectionStatus = "connected";
      latestQrBase64 = null;
      connectedPhone = sock.user?.id ? sock.user.id.split(":")[0].split("@")[0] : null;
      pushName = sock.user?.name || "Merchant";
    }
  });

  // Listen to incoming messages and forward to n8n if configured
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || !messages || messages.length === 0) return;
    const msg = messages[0];
    if (msg.key.fromMe) return;

    const fromPhone = msg.key.remoteJid ? msg.key.remoteJid.split("@")[0] : "";
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

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
  });
}

// ─── REST API Endpoints ─────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Ginie Space WhatsApp Bridge",
    connection: connectionStatus,
    phone: connectedPhone,
  });
});

app.get("/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({
      status: "connected",
      phone: connectedPhone,
      pushName,
      message: "Device already linked and active.",
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

app.get("/status", (req, res) => {
  res.json({
    connected: connectionStatus === "connected",
    status: connectionStatus,
    phone: connectedPhone ? `+${connectedPhone}` : null,
    pushName,
  });
});

app.post("/send", async (req, res) => {
  const { number, text } = req.body;

  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp device is not connected. Please scan QR first.",
    });
  }

  if (!number || !text) {
    return res.status(400).json({
      success: false,
      error: "Missing number or text in payload.",
    });
  }

  try {
    const cleanNumber = number.replace(/[^0-9]/g, "");
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text });

    res.json({
      success: true,
      recipient: cleanNumber,
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
    } catch (_) {}
    setTimeout(initWhatsAppSession, 1000);
    res.json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Ginie Space WhatsApp Bridge] Server listening on port ${PORT}`);
  initWhatsAppSession();
});
