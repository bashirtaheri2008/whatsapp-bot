const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const http = require("http");

const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = "93745872028";

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WhatsApp Bot Running");
}).listen(PORT);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "connecting") {
      console.log("Connecting...");
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
    }

    if (connection === "close") {
      console.log("Connection closed");

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      }
    }
  });

  // فقط بار اول کد Pairing تولید می‌شود
  if (!state.creds.registered) {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const code = await sock.requestPairingCode(PHONE_NUMBER);

      console.log("===============================");
      console.log("PAIRING CODE:");
      console.log(code);
      console.log("===============================");
    } catch (err) {
      console.log(err);
    }
  }

  // پاسخ خودکار
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    if (!msg.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (text.toLowerCase() === "سلام") {
      await sock.sendMessage(msg.key.remoteJid, {
        text: "سلام 🌹\nربات با موفقیت فعال است."
      });
    }
  });
}

startBot();
