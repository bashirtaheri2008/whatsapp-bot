const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const http = require("http");

// ===== تنظیمات =====
const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = "93745872028";

// ===== Groq AI =====
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// تاریخچه مکالمه برای هر کاربر
const chatHistories = {};

// ===== سرور HTTP برای Render =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WhatsApp Bot with Groq AI Running");
}).listen(PORT);

// ===== تابع اصلی ربات =====
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
      console.log("🔄 Connecting...");
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
    }

    if (connection === "close") {
      console.log("❌ Connection closed");
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔄 Reconnecting in 5 seconds...");
        setTimeout(startBot, 5000);
      }
    }
  });

  // ===== دریافت کد جفت‌سازی =====
  if (!state.creds.registered) {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log("===============================");
      console.log("📱 PAIRING CODE:");
      console.log(code);
      console.log("===============================");
    } catch (err) {
      console.log("❌ Pairing error:", err);
    }
  }

  // ===== تابع تماس با Groq (متن) =====
  async function callGroqText(userMessage, history = []) {
    try {
      const messages = [
        {
          role: "system",
          content: `تو دستیار بشیر در واتساپ هستی که بشیر تو را جایگزین خود در واتساپ کرده تا به پیام های مخاطبین که به بشیر مسج میکند جواب بدی در صورت لازم بگو بشیر در حال حاضر در دسترس نیست `
        },
        ...history,
        { role: "user", content: userMessage }
      ];

      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: messages,
          temperature: 0.7,
          max_tokens: 1024,
          top_p: 0.9
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "خطای ناشناخته");
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error("❌ Groq Error:", error);
      return "🤖 متأسفانه خطایی رخ داد. لطفاً دوباره تلاش کنید.";
    }
  }

  // ===== تابع تماس با Groq (تصویر) =====
  async function callGroqImage(base64Image, userMessage = "این تصویر را تحلیل کن") {
    try {
      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userMessage },
                { type: "image_url", image_url: { url: base64Image } }
              ]
            }
          ],
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "خطای ناشناخته");
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error("❌ Groq Image Error:", error);
      return "🤖 خطا در تحلیل تصویر. لطفاً دوباره تلاش کنید.";
    }
  }

  // ===== گوش دادن به پیام‌ها =====
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    // رد کردن پیام‌های خودم و پیام‌های بدون متن
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;

    // استخراج متن پیام
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    // استخراج تصویر اگر وجود داشته باشد
    let imageBase64 = null;
    let caption = "";

    if (msg.message.imageMessage) {
      // دانلود تصویر
      try {
        const media = await sock.downloadMediaMessage(msg);
        imageBase64 = `data:${msg.message.imageMessage.mimetype};base64,${media.toString("base64")}`;
        caption = msg.message.imageMessage.caption || "";
      } catch (e) {
        console.error("❌ دانلود تصویر失敗:", e);
      }
    }

    // استخراج ویدئو (اختیاری)
    let videoBase64 = null;
    if (msg.message.videoMessage) {
      try {
        const media = await sock.downloadMediaMessage(msg);
        videoBase64 = `data:${msg.message.videoMessage.mimetype};base64,${media.toString("base64")}`;
      } catch (e) {}
    }

    // ===== پردازش پیام =====
    console.log(`📩 پیام از ${sender}: ${text || "[رسانه]"}`);

    // ارسال تایپینگ
    await sock.sendPresenceUpdate("composing", sender);

    let reply = "";

    // اگر تصویر داشتیم
    if (imageBase64) {
      const userMessage = caption || "این تصویر را تحلیل کن";
      reply = await callGroqImage(imageBase64, userMessage);
    }
    // اگر ویدئو داشتیم (فعلاً پشتیبانی نمی‌شه)
    else if (videoBase64) {
      reply = "متاسفم نتوانستم بررسی کنم";
    }
    // پیام متنی
    else if (text.trim()) {
      // مدیریت تاریخچه برای هر کاربر
      if (!chatHistories[sender]) {
        chatHistories[sender] = [];
      }

      // اگر پیام خیلی طولانی نبود
      if (text.length < 500) {
        reply = await callGroqText(text, chatHistories[sender]);

        // ذخیره در تاریخچه (حداکثر ۲۰ پیام)
        chatHistories[sender].push({ role: "user", content: text });
        chatHistories[sender].push({ role: "assistant", content: reply });

        if (chatHistories[sender].length > 20) {
          chatHistories[sender] = chatHistories[sender].slice(-20);
        }
      } else {
        reply = "📏 پیام شما خیلی طولانی است. لطفاً کمتر از ۵۰۰ کاراکتر ارسال کنید.";
      }
    } else {
      reply = "متاسفم نتوانستم بررسی کنم ";
    }

    // ارسال پاسخ
    await sock.sendMessage(sender, {
      text: reply
    });

    console.log(`🤖 پاسخ ارسال شد: ${reply.substring(0, 50)}...`);
  });
}

// ===== اجرای ربات =====
startBot().catch(err => {
  console.error("❌ Fatal error:", err);
});

// ===== مدیریت خطاهای ناگهانی =====
process.on("uncaughtException", (err) => {
  console.log("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.log("❌ Unhandled Rejection:", reason);
});
