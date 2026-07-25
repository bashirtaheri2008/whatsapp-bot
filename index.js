const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const http = require("http");
const fs = require("fs");

// ===== تنظیمات =====
const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = "93745872028";

// ===== GROQ =====
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// ===== سیستم پرامپت جدید =====
const SYSTEM_PROMPT = `
تو دستیار شخصی هوش مصنوعی «بشیر» در واتساپ هستی.

هویت:
- هرگز ادعا نکن که خودت بشیر هستی.
- اگر کسی بپرسد «بشیر هست؟» بگو:
  «سلام 👋
  بشیر فعلاً در دسترس نیست. من دستیار هوش مصنوعی او هستم. اگر پیامی یا سؤالی داری بفرست؛ اگر بتوانم پاسخ می‌دهم و اگر لازم باشد، وقتی بشیر فرصت داشت خودش پاسخ خواهد داد.»

رفتار:
- مودب، دوستانه و طبیعی باش.
- پاسخ‌ها را کوتاه اما کامل بنویس.
- اگر لازم بود مرحله‌به‌مرحله توضیح بده.
- به زبان کاربر پاسخ بده.
- اگر سؤال را نمی‌دانی، صادقانه بگو مطمئن نیستی.
- اطلاعات ساختگی تولید نکن.
- اگر پیام فقط سلام بود، مکالمه را دوستانه ادامه بده.
- اگر کاربر درباره برنامه‌نویسی سؤال کرد، کد کامل و قابل اجرا بنویس.
- اگر درباره ترید سؤال کرد، پاسخ آموزشی بده و یادآوری کن که تصمیم نهایی با خود کاربر است.
- اگر کاربر فقط خواست پیامی برای بشیر بگذارد، بگو:
  «حتماً، اگر بشیر بعداً پیام‌ها را بررسی کند، این پیام را خواهد دید.»
  هرگز ادعا نکن که پیام را واقعاً ذخیره یا ارسال کرده‌ای مگر اینکه برنامه چنین قابلیتی داشته باشد.

سبک پاسخ:
- طبیعی صحبت کن.
- از ایموجی در حد متعادل استفاده کن.
- پاسخ‌ها شبیه یک انسان باشند، نه یک ربات خشک.
`;

// ===== تاریخچه مکالمات =====
const conversations = {};

// ===== ذخیره و بارگذاری تاریخچه =====
function saveConversations() {
  try {
    fs.writeFileSync('conversations.json', JSON.stringify(conversations, null, 2));
  } catch (e) {}
}

function loadConversations() {
  try {
    const data = fs.readFileSync('conversations.json', 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

Object.assign(conversations, loadConversations());
setInterval(saveConversations, 300000);

// ===== سرور HTTP =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("🤖 Bashir's AI Assistant");
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
    if (connection === "open") {
      console.log("✅ Bashir's AI Assistant is Online");
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
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

  // ===== تابع پاسخگویی =====
  async function getAssistantResponse(userMessage, sender) {
    const userId = sender.split('@')[0];
    
    if (!conversations[userId]) {
      conversations[userId] = {
        messages: [],
        firstSeen: new Date().toISOString()
      };
    }

    conversations[userId].messages.push({
      role: "user",
      content: userMessage,
      time: new Date().toISOString()
    });

    const history = conversations[userId].messages.slice(-10);
    const chatHistory = history.map(m => 
      `${m.role === 'user' ? '👤 کاربر' : '🤖 دستیار'}: ${m.content}`
    ).join('\n');

    const fullPrompt = `
${SYSTEM_PROMPT}

═══════════════════════════════════════
📝 تاریخچه مکالمه (۱۰ پیام آخر):
═══════════════════════════════════════
${chatHistory || 'شروع مکالمه'}

═══════════════════════════════════════
📩 پیام جدید کاربر:
═══════════════════════════════════════
${userMessage}
`;

    try {
      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: fullPrompt },
            { role: "user", content: userMessage }
          ],
          temperature: 0.8,
          max_tokens: 800
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "API Error");
      }

      const data = await response.json();
      const reply = data.choices[0].message.content;

      conversations[userId].messages.push({
        role: "assistant",
        content: reply,
        time: new Date().toISOString()
      });

      if (conversations[userId].messages.length > 20) {
        conversations[userId].messages = conversations[userId].messages.slice(-20);
      }

      return reply;

    } catch (error) {
      console.error("❌ Error:", error);
      return "🙏 سلام، من دستیار بشیر هستم. یه مشکل کوچیک پیش اومده، ولی می‌تونیم دوباره تلاش کنیم.";
    }
  }

  // ===== گوش دادن به پیام‌ها =====
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    if (!text.trim()) return;

    console.log(`📩 پیام از ${sender}: ${text}`);

    await sock.sendPresenceUpdate("composing", sender);

    const reply = await getAssistantResponse(text, sender);

    const delay = 800 + Math.random() * 1500;
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(sender, { text: reply });

    console.log(`🤖 پاسخ ارسال شد: ${reply.substring(0, 50)}...`);
  });
}

// ===== اجرا =====
startBot().catch(err => {
  console.error("❌ Fatal error:", err);
});

process.on("uncaughtException", (err) => {
  console.log("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.log("❌ Unhandled Rejection:", reason);
});
