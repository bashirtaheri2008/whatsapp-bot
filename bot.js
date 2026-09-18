/* ==================================================
   WhatsApp AI Bot — نسخه چندکاربره (Multi-Tenant) v9.0.0
   هر کاربر با گوگل وارد می‌شود → حساب جدا → شماره واتساپ خودش
   دیتای هر کاربر (فیش/تنظیمات/نشست) کاملاً ایزوله است
   ================================================== */

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

/* ==================================================
   AI GATEWAY — دروازه هوش مصنوعی متمرکز (مشترک بین همه کاربران)
   ================================================== */

const AI_GATEWAY = {
  url: "https://ai-gateway-npil.onrender.com",
  key: "hamgab-ai-gateway-2026",
  rpmPerKey: 700,
  statusRefreshMs: 30 * 1000
};

const keyManager = {
  cache: { totalKeys: 0, active: 0, cooling: 0 },

  init(){
    console.log("🤖 متصل به دروازه هوش مصنوعی مرکزی:", AI_GATEWAY.url);
    this.refreshStatus();
    setInterval(() => this.refreshStatus(), AI_GATEWAY.statusRefreshMs);
  },

  async refreshStatus(){
    try{
      const res = await fetch(AI_GATEWAY.url + "/status", { signal: AbortSignal.timeout(8000) });
      const d = await res.json();
      this.cache = { totalKeys: d.totalKeys || 0, active: d.active || 0, cooling: d.cooling || 0 };
    }catch(e){
      console.error("خطا در دریافت وضعیت گیت‌وی:", e.message);
    }
  },

  getNext(){
    return { key: AI_GATEWAY.key, index: 0 };
  },

  markExhausted(index, waitMs){
    console.log("⏳ دروازه AI → استراحت " + (waitMs / 1000).toFixed(1) + " ثانیه");
  },

  markHealthy(index){},

  power(){
    const c = this.cache;
    return {
      totalKeys: c.totalKeys,
      active: c.active,
      cooling: c.cooling,
      rpmPerKey: AI_GATEWAY.rpmPerKey,
      totalPower: c.active * AI_GATEWAY.rpmPerKey,
      gateway: AI_GATEWAY.url
    };
  },

  status(){ return this.power(); }
};

/* ==================================================
   CONFIG
   ================================================== */

const PORT = process.env.PORT || 3000;
const DATA_ROOT = path.join(__dirname, "data");
const USERS_DIR = path.join(DATA_ROOT, "users");

let TEXT_MODEL = null;
let VISION_MODEL = null;

const TEXT_PRIORITY = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "gemma2-9b-it"
];

const VISION_PRIORITY = [
  "qwen/qwen3.8-27b",
  "qwen/qwen3.6-27b"
];

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const MAX_CONCURRENT_BOTS = 5;

const QUEUE_DELAY_MS = 500;
const IMAGE_MAX_DIMENSION = 1400;

const COMPARE_FIELDS = [
  { key: "trackingNo",   weight: 5, label: "شماره پیگیری" },
  { key: "receiptNo",    weight: 5, label: "شماره قواره فیش" },
  { key: "amount",       weight: 4, label: "مبلغ" },
  { key: "senderIban",   weight: 4, label: "IBAN فرستنده" },
  { key: "receiverIban", weight: 4, label: "IBAN گیرنده" },
  { key: "date",         weight: 3, label: "تاریخ" },
  { key: "time",         weight: 3, label: "ساعت" },
  { key: "bank",          weight: 2, label: "بانک" },
  { key: "referenceCode", weight: 2, label: "کد مرجع" },
  { key: "senderName",   weight: 1, label: "نام فرستنده" },
  { key: "receiverName", weight: 1, label: "نام گیرنده" },
  { key: "description",  weight: 1, label: "توضیحات" }
];

const MSG_DUPLICATE = "❌ این فیش قبلاً ارسال شده است.";
const MSG_NOT_RECEIPT = "⚠️ فقط فیش بانکی پذیرفته می‌شود.";
const MSG_ERROR = "❌ خطا در پردازش فیش. لطفاً دوباره امتحان کنید.";
const MSG_PDF_ERROR = "❌ خطا در پردازش PDF. لطفاً عکس واضح فیش را بفرستید.";

const REACTION_PROCESSING = "🔍";
const REACTION_DUPLICATE = "❌";
const REACTION_NEW = "🆕";
const REACTION_ERROR = "⚠️";

/* واسطه تایید فیش */
const CONFIRM_SCAN = "🔍";
const CONFIRM_WAIT = "⏫";

/* ==================================================
   UTILS
   ================================================== */

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function formatDate(timestamp){
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  hours = hours ? hours : 12;
  hours = String(hours).padStart(2, "0");

  return year + "/" + month + "/" + day + " " + hours + ":" + minutes + " " + ampm;
}

function toEnglishDigits(str){
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return String(str || "")
    .replace(/[۰-۹]/g, d => String(fa.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(ar.indexOf(d)));
}

function normalizeLetters(str){
  return String(str || "")
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/[يﻯﻰ]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ة]/g, "ه")
    .replace(/[أإآ]/g, "ا")
    .replace(/[ؤ]/g, "و")
    .replace(/[\u064B-\u065F\u0670]/g, "");
}

function normalizeText(str){
  return normalizeLetters(toEnglishDigits(String(str || "")))
    .toLowerCase().trim().replace(/\s+/g, " ")
    .replace(/[^\w\u0600-\u06FF\/\-\.\d]/g, "");
}

function normalizeIban(str){
  return toEnglishDigits(String(str || "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeAmount(str){
  let s = toEnglishDigits(String(str || ""));
  const num = s.replace(/[^\d.]/g, "");
  if(!num) return "";
  return num.replace(/\.0+$/, "").replace(/\.$/, "");
}

function normalizeDate(str){
  const s = toEnglishDigits(String(str || "")).trim();
  if(!s) return "";
  let m = s.match(/(\d{1,4})[\/\.\-\s](\d{1,2})[\/\.\-\s](\d{1,4})/);
  if(m){
    let [, a, b, c] = m;
    if(a.length <= 2 && c.length >= 2){
      const day = a.padStart(2, "0");
      const month = b.padStart(2, "0");
      let year = c;
      if(year.length === 2) year = "20" + year;
      return year + month + day;
    }
    if(a.length === 4){
      return a + b.padStart(2, "0") + c.padStart(2, "0");
    }
  }
  return s.replace(/[^\d]/g, "");
}

function normalizeName(str){
  let s = normalizeLetters(String(str || ""))
    .replace(/[^\w\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();

  const titles = ["mr","mrs","ms","dr","bey","hanim","hanım","bay","sayin","sayın","آقا","خانم","جناب","دکتر","prof","prof."];
  titles.forEach(t => {
    s = s.replace(new RegExp("(^|\\s)" + t + "(\\s|$)", "g"), " ");
  });

  s = s.replace(/\s+/g, " ").trim();
  const words = s.split(" ").filter(w => w.length >= 2);
  words.sort();
  return words.join(" ");
}

function normalizeTime(str){
  let s = toEnglishDigits(String(str || "")).replace(/[^\d:]/g, "");
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if(!m) return s;
  const h = m[1].padStart(2, "0"), mi = m[2].padStart(2, "0");
  if(m[3]) return h + ":" + mi + ":" + m[3].padStart(2, "0");
  return h + ":" + mi;
}

function normalizeField(key, value){
  switch(key){
    case "trackingNo":    return normalizeText(value);
    case "receiptNo":     return normalizeText(value);
    case "referenceCode": return normalizeText(value);
    case "bank":          return normalizeText(value).toLowerCase();
    case "amount":        return normalizeAmount(value);
    case "currency":      return normalizeText(value).toUpperCase();
    case "date":          return normalizeDate(value);
    case "time":          return normalizeTime(value);
    case "senderName":    return normalizeName(value);
    case "receiverName":  return normalizeName(value);
    case "senderIban":    return normalizeIban(value);
    case "receiverIban":  return normalizeIban(value);
    case "description":   return normalizeText(value);
    default:              return normalizeText(value);
  }
}

function similarity(a, b){
  if(a === b) return 1;
  if(!a || !b) return 0;
  const len = Math.max(a.length, b.length);
  if(len === 0) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / len);
}

function levenshtein(a, b){
  const m = a.length, n = b.length;
  if(m === 0) return n;
  if(n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for(let j = 0; j <= n; j++) prev[j] = j;
  for(let i = 1; i <= m; i++){
    curr[0] = i;
    for(let j = 1; j <= n; j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function compareReceipts(a, b){
  const details = [];
  let totalWeight = 0;
  let matchWeight = 0;

  for(const field of COMPARE_FIELDS){
    const va = normalizeField(field.key, a[field.key]);
    const vb = normalizeField(field.key, b[field.key]);

    if(!va && !vb){
      details.push({ key: field.key, label: field.label, status: "empty", match: true, a: "", b: "" });
      continue;
    }
    if(!va || !vb){
      totalWeight += field.weight * 0.5;
      details.push({ key: field.key, label: field.label, status: "one_empty", match: false,
        a: a[field.key] || "", b: b[field.key] || "" });
      continue;
    }

    totalWeight += field.weight;

    if(va === vb){
      matchWeight += field.weight;
      details.push({ key: field.key, label: field.label, status: "exact", match: true,
        a: a[field.key], b: b[field.key] });
    }else{
      const sim = similarity(va, vb);
      if(sim >= 0.95){
        matchWeight += field.weight * sim;
        details.push({ key: field.key, label: field.label, status: "near", match: true,
          similarity: sim, a: a[field.key], b: b[field.key] });
      }else if(sim >= 0.75){
        matchWeight += field.weight * sim * 0.7;
        details.push({ key: field.key, label: field.label, status: "partial", match: true,
          similarity: sim, a: a[field.key], b: b[field.key] });
      }else{
        details.push({ key: field.key, label: field.label, status: "mismatch", match: false,
          similarity: sim, a: a[field.key], b: b[field.key] });
      }
    }
  }

  return { score: totalWeight > 0 ? matchWeight / totalWeight : 0, details };
}

/* ==================================================
   FIND DUPLICATE — حالت سخت‌گیرانه (Strict) v2 — روی لیست داده‌شده
   ================================================== */

function timeExactMatch(a, b){
  if(!a || !b) return true;
  const ma = a.split(":").slice(0, 2).join(":");
  const mb = b.split(":").slice(0, 2).join(":");
  return ma === mb;
}

const NUMERIC_FIELDS = [
  { key: "trackingNo",    label: "شماره پیگیری",    norm: v => normalizeText(v) },
  { key: "receiptNo",     label: "شماره قواره فیش", norm: v => normalizeText(v) },
  { key: "referenceCode", label: "کد مرجع",         norm: v => normalizeText(v) },
  { key: "amount",        label: "مبلغ",            norm: v => normalizeAmount(v) },
  { key: "senderIban",    label: "IBAN فرستنده",    norm: v => normalizeIban(v) },
  { key: "receiverIban",  label: "IBAN گیرنده",     norm: v => normalizeIban(v) },
  { key: "date",          label: "تاریخ",          norm: v => normalizeDate(v) },
];

function findDuplicateByVision(list, newInfo){
  if(!list || !list.length) return null;

  const nTime = normalizeTime(newInfo.time);

  for(const existing of list){
    let differs = false;
    let guardLabel = "";
    for(const f of NUMERIC_FIELDS){
      const nv = f.norm(newInfo[f.key]);
      const ov = f.norm(existing.data[f.key]);
      if(nv && ov && nv !== ov){
        differs = true;
        guardLabel = f.label;
        break;
      }
    }
    if(!differs && nTime && normalizeTime(existing.data.time) &&
       !timeExactMatch(nTime, normalizeTime(existing.data.time))){
      differs = true;
      guardLabel = "ساعت";
    }
    if(differs){
      console.log("🛡 گارد سخت‌گیرانه: «" + guardLabel + "» متفاوت است → تکراری نیست");
      continue;
    }

    const idChecks = [
      { key: "trackingNo",    label: "شماره پیگیری",    min: 5 },
      { key: "receiptNo",     label: "شماره قواره فیش", min: 5 },
      { key: "referenceCode", label: "کد مرجع",         min: 5 },
    ];
    for(const c of idChecks){
      const nv = normalizeText(newInfo[c.key]);
      const ov = normalizeText(existing.data[c.key]);
      if(nv && nv.length >= c.min && nv === ov){
        console.log("✅ تکراری (کد یکتا):", c.label, "یکسان →", nv);
        return { score: 1.0, layer: c.key, record: existing,
          details: [{ key: c.key, label: c.label, status: "exact", match: true,
            a: existing.data[c.key], b: newInfo[c.key] }] };
      }
    }

    const nS = normalizeIban(newInfo.senderIban);
    const oS = normalizeIban(existing.data.senderIban);
    const nA = normalizeAmount(newInfo.amount);
    const oA = normalizeAmount(existing.data.amount);
    const nR = normalizeIban(newInfo.receiverIban);
    const oR = normalizeIban(existing.data.receiverIban);
    const nD = normalizeDate(newInfo.date);
    const oD = normalizeDate(existing.data.date);

    if(nS && oS && nA && oA && nR && oR && nD && oD &&
       nS === oS && nA === oA && nR === oR && nD === oD){
      console.log("✅ تکراری (ترکیب کامل): IBAN فرستنده + مبلغ + IBAN گیرنده + تاریخ همه دقیقاً یکسان");
      return { score: 0.99, layer: "Strict-Full-Match", record: existing,
        details: [
          { key: "senderIban",   label: "IBAN فرستنده", status: "exact", match: true, a: existing.data.senderIban,   b: newInfo.senderIban },
          { key: "amount",      label: "مبلغ",         status: "exact", match: true, a: existing.data.amount,      b: newInfo.amount },
          { key: "receiverIban",label: "IBAN گیرنده",  status: "exact", match: true, a: existing.data.receiverIban,b: newInfo.receiverIban },
          { key: "date",        label: "تاریخ",        status: "exact", match: true, a: existing.data.date,        b: newInfo.date },
          ...(nTime && normalizeTime(existing.data.time)
            ? [{ key: "time", label: "ساعت", status: "exact", match: true, a: existing.data.time, b: newInfo.time }] : [])
        ] };
    }
  }

  console.log("❌ تکراری نیست");
  return null;
}

/* ==================================================
   MESSAGE HELPERS
   ================================================== */

function getMessageType(msg){
  const m = msg.message;
  if(!m) return "unknown";
  if(m.imageMessage) return "image";
  if(m.videoMessage) return "video";
  if(m.audioMessage) return "audio";
  if(m.documentMessage){
    const mimetype = m.documentMessage.mimetype || "";
    if(mimetype.includes("pdf")) return "pdf";
    return "document";
  }
  if(m.conversation || m.extendedTextMessage) return "text";
  return "unknown";
}

function buildQuoted(msgKey){
  return {
    key: {
      remoteJid: msgKey.remoteJid,
      fromMe: !!msgKey.fromMe,
      id: msgKey.id,
      participant: msgKey.participant || undefined
    },
    message: { conversation: "." }
  };
}

/* ==================================================
   MODELS — یک بار برای همه کاربران
   ================================================== */

async function detectModels(){
  try{
    const { key, index } = keyManager.getNext();
    const res = await fetch(AI_GATEWAY.url + "/v1/models", {
      headers: { "Authorization": "Bearer " + key }
    });

    if(res.status === 429){
      keyManager.markExhausted(index, 60000);
      return detectModels();
    }

    if(!res.ok){
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "خطا در دریافت مدل‌ها");
    }

    const data = await res.json();
    const available = (data.data || []).filter(m => m.active !== false).map(m => m.id);

    console.log("📋 مدل‌های موجود:");
    available.forEach(m => console.log("   •", m));

    TEXT_MODEL = TEXT_PRIORITY.find(m => available.includes(m)) ||
      available.find(id => !id.includes("whisper") && !id.includes("guard") && !id.includes("tts"));

    VISION_MODEL = VISION_PRIORITY.find(m => available.includes(m)) ||
      available.find(id => id.includes("vision") || id.includes("maverick") || id.includes("qwen"));

    console.log("✅ مدل متن:", TEXT_MODEL || "❌");
    console.log("✅ مدل Vision:", VISION_MODEL || "❌");
    return { TEXT_MODEL, VISION_MODEL };
  }catch(e){
    console.error("❌ detectModels:", e.message);
    throw e;
  }
}

let modelsPromise = null;
function ensureModels(){
  if(!modelsPromise) modelsPromise = detectModels().catch(e => { modelsPromise = null; throw e; });
  return modelsPromise;
}

/* ==================================================
   IMAGE / PDF PROCESSING
   ================================================== */

let sharp = null;
try{
  sharp = require("sharp");
  console.log("✅ sharp بارگذاری شد");
}catch(e){
  console.warn("⚠️ sharp نصب نیست — فشرده‌سازی کار نمی‌کنه");
}

async function downloadImage(sock, msg){
  try{
    const buffer = await downloadMediaMessage(
      msg, "buffer", {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
    );

    let mimetype = msg.message?.imageMessage?.mimetype || "image/jpeg";
    let finalBuffer = buffer;

    if(sharp){
      try{
        const meta = await sharp(buffer).metadata();
        if(meta.format === "heif" || meta.format === "webp" || meta.format === "png"){
          finalBuffer = await sharp(buffer).jpeg({ quality: 92 }).toBuffer();
          mimetype = "image/jpeg";
        }
        const newMeta = await sharp(finalBuffer).metadata();
        if(newMeta.width > IMAGE_MAX_DIMENSION || newMeta.height > IMAGE_MAX_DIMENSION){
          finalBuffer = await sharp(finalBuffer)
            .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
          mimetype = "image/jpeg";
        }
      }catch(e){ console.warn("sharp:", e.message); }
    }

    if(finalBuffer.length > MAX_IMAGE_SIZE) throw new Error("عکس خیلی بزرگه");

    return {
      buffer: finalBuffer,
      base64: `data:${mimetype};base64,${finalBuffer.toString("base64")}`
    };
  }catch(e){
    console.error("downloadImage:", e.message);
    return null;
  }
}

async function pdfToJpeg(pdfBuffer, dpi = 150){
  const tmpDir = os.tmpdir();
  const timestamp = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const pdfPath = path.join(tmpDir, `input_${timestamp}.pdf`);
  const outPrefix = path.join(tmpDir, `page_${timestamp}`);

  try{
    fs.writeFileSync(pdfPath, pdfBuffer);
    await execFileAsync("pdftoppm", ["-jpeg", "-r", String(dpi), pdfPath, outPrefix], { timeout: 30000 });

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith(path.basename(outPrefix)) && f.endsWith(".jpg"))
      .sort();

    if(!files.length) throw new Error("pdftoppm خروجی نداد");

    const imgBuffer = fs.readFileSync(path.join(tmpDir, files[0]));

    try{
      fs.unlinkSync(pdfPath);
      files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    }catch{}

    return imgBuffer;
  }catch(e){
    try{
      if(fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      fs.readdirSync(tmpDir)
        .filter(f => f.startsWith(path.basename(outPrefix)))
        .forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    }catch{}
    throw e;
  }
}

async function downloadPdf(sock, msg){
  try{
    const buffer = await downloadMediaMessage(
      msg, "buffer", {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
    );

    if(buffer.length > MAX_PDF_SIZE) throw new Error("PDF خیلی بزرگه");

    let imgBuffer = await pdfToJpeg(buffer, 150);

    if(sharp){
      try{
        const meta = await sharp(imgBuffer).metadata();
        if(meta.width > IMAGE_MAX_DIMENSION || meta.height > IMAGE_MAX_DIMENSION){
          imgBuffer = await sharp(imgBuffer)
            .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
        }
      }catch(e){ console.warn("sharp resize:", e.message); }
    }

    return {
      buffer: imgBuffer,
      base64: `data:image/jpeg;base64,${imgBuffer.toString("base64")}`
    };
  }catch(e){
    console.error("downloadPdf:", e.message);
    return null;
  }
}

/* ==================================================
   EXTRACT RECEIPT INFO (Vision) — مشترک
   ================================================== */

async function extractReceiptInfo(imageData){
  const prompt = `تو یک کارشناس خبره استخراج اطلاعات از فیش‌های بانکی هستی. این تصویر را با بیشترین دقت و ذره‌ذره بررسی کن.

⚠️ نکات حیاتی:
1. حتی اگر عکس کج، تار، برش‌خورده یا از زاویه باشه، تمام اطلاعات را با دقت بخوان
2. اعداد فارسی/عربی را به انگلیسی تبدیل کن
3. نام‌ها را دقیقاً همان‌طور که نوشته شده ثبت کن (بدون تغییر)
4. IBAN را کامل و بدون فاصله بنویس
5. شماره پیگیری / کد رهگیری / شماره تراکنش را با دقت زیاد بخوان (این مهم‌ترین فیلد است)
6. اگر فیش دو تا شماره دارد (مثلاً Tracking و Reference)، هر دو را ثبت کن
7. تاریخ را دقیق بخوان: روز، ماه و سال جدا از هم (مثال 05/09/2026)
8. ساعت را با بالاترین دقت بخوان: ساعت، دقیقه و ثانیه اگر روی فیش هست (مثال 14:32:07) — ثانیه اگر نوشته شده حتماً ثبت شود
9. شماره قواره فیش / شماره سند را جدا از شماره پیگیری ثبت کن
10. هر رقم را مو به مو بدون حدس و بدون رند کردن بخوان — یک رقم اشتباه کل سیستم را خراب می‌کند

فقط و فقط JSON برگردان (بدون هیچ متن اضافی، بدون markdown):

{
  "isReceipt": true اگر فیش بانکی است, false اگر نیست,
  "bank": "نام بانک",
  "bankBranch": "نام یا کد شعبه اگر روی فیش هست",
  "amount": "مبلغ به عدد انگلیسی بدون کاما (مثال: 5000)",
  "currency": "TL یا USD یا EUR",
  "date": "تاریخ به فرمت DD/MM/YYYY",
  "time": "ساعت دقیق — HH:MM:SS اگر ثانیه روی فیش هست, وگرنه HH:MM",
  "trackingNo": "شماره پیگیری اصلی (مهم‌ترین فیلد)",
  "receiptNo": "شماره قواره فیش / شماره سند (اگر جدا از شماره پیگیری هست, وگرنه خالی)",
  "referenceCode": "هر کد مرجع یا شماره سند دیگری که در فیش هست",
  "senderName": "نام کامل فرستنده (بدون القاب مثل Mr/Mrs/Bey/Hanım)",
  "senderIban": "IBAN فرستنده (فقط حروف و اعداد بدون فاصله)",
  "receiverName": "نام کامل گیرنده (بدون القاب)",
  "receiverIban": "IBAN گیرنده (فقط حروف و اعداد بدون فاصله)",
  "description": "توضیحات / açıklama"
}

اگر فیلدی در فیش نیست، "" بگذار. فقط JSON برگردان.`;

  const MAX_ATTEMPTS = 6; // گیت‌وی خودش کلیدها را می‌چرخاند

  for(let attempt = 0; attempt < MAX_ATTEMPTS; attempt++){
    const { key, index } = keyManager.getNext();

    try{
      console.log("🔑 تلاش " + (attempt + 1) + "/" + MAX_ATTEMPTS + " — دروازه مرکزی");
      const res = await fetch(AI_GATEWAY.url + "/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageData } }
            ]
          }],
          temperature: 0.0,
          max_tokens: 1200
        })
      });

      const data = await res.json();
      const errMsg = data.error?.message || "";

      if(res.status === 429 || errMsg.includes("Rate limit")){
        let waitMs = 60000;
        const match = errMsg.match(/in ([\d.]+)s/);
        if(match) waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 2000;
        keyManager.markExhausted(index, waitMs);
        await sleep(waitMs);
        continue;
      }

      if(!res.ok) throw new Error(errMsg || "Groq error");

      keyManager.markHealthy(index);

      let content = data.choices?.[0]?.message?.content || "";
      content = content.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if(start >= 0 && end > start) content = content.slice(start, end + 1);

      const info = JSON.parse(content);
      console.log("📄 اطلاعات استخراج‌شده:");
      console.log("   مبلغ:", info.amount, info.currency);
      console.log("   تاریخ:", info.date, info.time);
      console.log("   Tracking:", info.trackingNo);
      console.log("   Reference:", info.referenceCode);
      console.log("   IBAN فرستنده:", info.senderIban);
      console.log("   IBAN گیرنده:", info.receiverIban);
      console.log("   نام فرستنده:", info.senderName);
      console.log("   نام گیرنده:", info.receiverName);
      return info;

    }catch(e){
      console.error("خطا تلاش " + (attempt + 1) + ":", e.message);
      if(e.message && !e.message.includes("Rate limit")){
        keyManager.markExhausted(index, 5000);
      }
      if(attempt < MAX_ATTEMPTS - 1) await sleep(500);
    }
  }

  throw new Error("همه کلیدها تلاش شدن ولی موفق نشد");
}

/* ==================================================
   CLOUD BACKUP (GitHub) — چندکاربره
   ساختار ریپوی دیتا:
     users/index.json — فهرست کاربران
     users/<gid>/meta.json — پروفایل گوگل
     users/<gid>/receipts.json
     users/<gid>/config.json
     users/<gid>/confirm.json
     users/<gid>/auth_info/<file> — نشست واتساپ
     server-secret.txt — رمز امضای سشن (برای ماندگاری کوکی‌ها)
   ================================================== */

const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || "";
const GH_BASE = process.env.GH_BASE || "https://api.github.com";

function cloudEnabled(){
  return !!(GH_TOKEN && GH_REPO);
}

let ghPausedUntil = 0; /* تا این زمان بکاپ‌ها متوقف می‌مانند (لی‌میت) */

function ghRateLimited(){
  return Date.now() < ghPausedUntil;
}

async function ghApi(method, urlPath, body){
  try{
    const headers = {
      "Authorization": "token " + GH_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "wa-bot-multiuser"
    };
    const opts = { method, headers };
    if(body) opts.body = JSON.stringify(body);
    const r = await fetch(GH_BASE + urlPath, opts);
    if(r.status === 403 || r.status === 429){
      /* لی‌میت خورد — ۱۵ دقیقه بکاپ بخواب */
      ghPausedUntil = Date.now() + 15 * 60 * 1000;
      console.warn("⏸️ لی‌میت گیت‌هاب — بکاپ‌ها تا ۱۵ دقیقه متوقف شد");
    }
    return r;
  }catch(e){
    return { ok: false, status: 0, json: async () => ({}) };
  }
}

/* کش sha فایل‌های پوش‌شده — فقط تغییرات پوش می‌شوند (ضد ریت‌لیمیت گیت‌هاب) */
const pushedShaCache = new Map();

function blobSha(file){
  const buf = fs.readFileSync(file);
  const h = crypto.createHash("sha1");
  h.update(Buffer.concat([Buffer.from("blob " + buf.length + "\n"), buf]));
  return h.digest("hex");
}

async function ghPutFile(remotePath, localFile){
  let localSha;
  try{ localSha = blobSha(localFile); }catch(e){ return false; }

  if(pushedShaCache.get(remotePath) === localSha) return true;

  const content = fs.readFileSync(localFile).toString("base64");
  let sha;
  try{
    const g = await ghApi("GET", "/repos/" + GH_REPO + "/contents/" + encodeURI(remotePath));
    if(g.ok){
      sha = (await g.json()).sha;
      if(sha === localSha){
        pushedShaCache.set(remotePath, localSha);
        return true;
      }
    }
  }catch(e){}
  const p = await ghApi("PUT", "/repos/" + GH_REPO + "/contents/" + encodeURI(remotePath), {
    message: "backup: " + remotePath,
    content: content,
    ...(sha ? { sha: sha } : {})
  });
  if(p.ok){
    pushedShaCache.set(remotePath, localSha);
    return true;
  }
  return false;
}

async function ghGetFile(remotePath, localFile){
  const g = await ghApi("GET", "/repos/" + GH_REPO + "/contents/" + encodeURI(remotePath));
  if(!g.ok) return false;
  const j = await g.json();
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, Buffer.from(j.content, "base64"));
  try{ pushedShaCache.set(remotePath, blobSha(localFile)); }catch(e){}
  return true;
}

let backupBusy = false;
const lastBackupReqByUser = new Map();

async function backupUser(gid, reason){
  if(!cloudEnabled() || backupBusy || ghRateLimited()) return;
  const u = users.get(gid);
  if(!u) return;
  backupBusy = true;
  try{
    const remote = f => "users/" + gid + "/" + f;
    const files = [];
    if(fs.existsSync(u.metaFile)) files.push([remote("meta.json"), u.metaFile]);
    if(fs.existsSync(u.receiptsFile)) files.push([remote("receipts.json"), u.receiptsFile]);
    if(fs.existsSync(u.configFile)) files.push([remote("config.json"), u.configFile]);
    if(fs.existsSync(u.confirmFile)) files.push([remote("confirm.json"), u.confirmFile]);
    if(fs.existsSync(u.authDir)){
      fs.readdirSync(u.authDir).forEach(f => {
        const p = path.join(u.authDir, f);
        if(fs.statSync(p).isFile()) files.push([remote("auth_info/" + f), p]);
      });
    }
    let ok = 0;
    let changed = 0;
    for(const pair of files){
      let localSha;
      try{ localSha = blobSha(pair[1]); }catch(e){ continue; }
      if(pushedShaCache.get(pair[0]) === localSha) continue;
      changed++;
      if(await ghPutFile(pair[0], pair[1])) ok++;
    }
    console.log("☁️ بکاپ [" + gid.slice(0, 10) + "] " + reason + ": " + (changed ? (ok + "/" + changed + " فایل تغییرکرده") : "بدون تغییر"));
  }catch(e){
    console.error("backup:", e.message);
  }finally{
    backupBusy = false;
  }
}

function scheduleBackup(gid){
  if(!cloudEnabled()) return;
  const last = lastBackupReqByUser.get(gid) || 0;
  if(Date.now() - last < 90000) return;
  lastBackupReqByUser.set(gid, Date.now());
  setTimeout(() => backupUser(gid, "رویداد"), 1500);
}

function saveUserIndex(){
  try{
    const idx = [];
    for(const [gid, u] of users.entries()){
      idx.push({ gid, email: u.meta.email || "" });
    }
    fs.mkdirSync(USERS_DIR, { recursive: true });
    const local = path.join(USERS_DIR, "index.json");
    fs.writeFileSync(local, JSON.stringify({ users: idx }, null, 2));
    if(cloudEnabled()){
      let inCache = false;
      try{ inCache = pushedShaCache.get("users/index.json") === blobSha(local); }catch(e){}
      if(!inCache) ghPutFile("users/index.json", local).catch(() => {});
    }
  }catch(e){ console.error("saveUserIndex:", e.message); }
}

async function restoreAllFromGithub(){
  if(!cloudEnabled()){
    console.log("☁️ بکاپ ابری غیرفعال (GITHUB_TOKEN ست نشده)");
    return;
  }
  try{
    /* رمز امضای سشن */
    const secretFile = path.join(DATA_ROOT, "server-secret.txt");
    if(!fs.existsSync(secretFile)){
      await ghGetFile("server-secret.txt", secretFile);
    }
    /* فهرست کاربران */
    const idxLocal = path.join(USERS_DIR, "index.json");
    let index = null;
    try{
      if(fs.existsSync(idxLocal)) index = JSON.parse(fs.readFileSync(idxLocal, "utf8"));
    }catch(e){}
    if(!index){
      await ghGetFile("users/index.json", idxLocal);
      try{ index = JSON.parse(fs.readFileSync(idxLocal, "utf8")); }catch(e){ index = null; }
    }
    const list = (index && Array.isArray(index.users)) ? index.users : [];
    console.log("☁️ بازیابی: " + list.length + " کاربر از گیت‌هاب");
    for(const item of list){
      try{
        const gid = item.gid;
        if(!gid || !/^[A-Za-z0-9_\-]{5,}$/.test(gid)) continue;
        const u = ensureUser(gid, { email: item.email || "" });
        if(!fs.existsSync(u.metaFile)) await ghGetFile("users/" + gid + "/meta.json", u.metaFile);
        try{ u.meta = Object.assign(u.meta, JSON.parse(fs.readFileSync(u.metaFile, "utf8"))); }catch(e){}
        if(!fs.existsSync(u.receiptsFile)) await ghGetFile("users/" + gid + "/receipts.json", u.receiptsFile);
        if(!fs.existsSync(u.configFile)) await ghGetFile("users/" + gid + "/config.json", u.configFile);
        if(!fs.existsSync(u.confirmFile)) await ghGetFile("users/" + gid + "/confirm.json", u.confirmFile);
        /* نشست */
        const r = await ghApi("GET", "/repos/" + GH_REPO + "/contents/users/" + gid + "/auth_info");
        if(r.ok){
          const authFiles = await r.json();
          let n = 0;
          for(const f of authFiles){
            try{
              const local = path.join(u.authDir, f.name);
              if(!fs.existsSync(local) && (await ghGetFile("users/" + gid + "/auth_info/" + f.name, local))) n++;
            }catch(e){}
          }
          console.log("☁️ نشست [" + gid.slice(0, 10) + "]: " + n + " فایل");
        }
        u.loadLocal();
        /* اگر نشست دارد وصل شو (بدون QR) */
        if(fs.existsSync(path.join(u.authDir, "creds.json"))){
          u.connect().catch(e => console.error("اتصال کاربر:", e.message));
        }
      }catch(e){
        console.error("restore user:", e.message);
      }
    }
    console.log("☁️ بازیابی از گیت‌هاب کامل شد");
  }catch(e){
    console.error("restore:", e.message);
  }
}

function startCloudTasks(){
  if(!cloudEnabled()) return;
  setInterval(() => {
    for(const gid of users.keys()) backupUser(gid, "خودکار");
  }, 15 * 60 * 1000);
  const extUrl = process.env.RENDER_EXTERNAL_URL;
  if(extUrl){
    setInterval(() => { fetch(extUrl + "/api/health").catch(() => {}); }, 10 * 60 * 1000);
    console.log("⏰ پینگ ضد خواب فعال:", extUrl);
  }
}

process.on("SIGTERM", () => {
  if(!cloudEnabled()) process.exit(0);
  (async () => {
    for(const gid of users.keys()) await backupUser(gid, "خاموشی");
    process.exit(0);
  })();
  setTimeout(() => process.exit(0), 20000);
});

/* ==================================================
   AUTH — ورود با گوگل (OAuth 2.0) + سشن کوکی امضاشده
   ================================================== */

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_COOKIE = "wasid";
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000; /* ۳۰ روز */

let SESSION_SECRET = "";
let SESSION_SECRET_TEMP = false;
let SESSION_WAIT_STARTED = 0;

async function initSessionSecret(){
  if(!SESSION_WAIT_STARTED) SESSION_WAIT_STARTED = Date.now();
  const secretFile = path.join(DATA_ROOT, "server-secret.txt");
  try{
    if(fs.existsSync(secretFile)){
      SESSION_SECRET = fs.readFileSync(secretFile, "utf-8").trim();
      if(SESSION_SECRET.length >= 32) return;
    }
    /* رمز قبلی از گیت‌هاب بیاد تا کوکی‌های ورود معتبر بمانند */
    if(cloudEnabled()){
      try{
        const ok = await ghGetFile("server-secret.txt", secretFile);
        if(ok){
          SESSION_SECRET = fs.readFileSync(secretFile, "utf-8").trim();
          if(SESSION_SECRET.length >= 32){
            console.log("🔑 رمز سشن از گیت‌هاب بازیابی شد — ورود کاربران حفظ می‌شود");
            return;
          }
        }else if(ghRateLimited() && Date.now() - SESSION_WAIT_STARTED < 90000){
          /* لی‌میت است: حداکثر ۹۰ ثانیه صبر کن، سرویس گیر نکند */
          await new Promise(r => setTimeout(r, 5000));
          return await initSessionSecret();
        }else if(ghRateLimited()){
          /* لی‌میت طولانی: با رمز موقت بوت شو تا سرویس زنده بماند؛
             رمز تازه در گیت‌هاب دوباره نمی‌رود تا کوکی‌ها بعد از ریست سالم باشند */
          console.warn("⚠️ لی‌میت گیت‌هاب — بوت با رمز موقت (ورود گوگل فقط همین دوره نامعتبر)");
          SESSION_SECRET = crypto.randomBytes(32).toString("hex");
          SESSION_SECRET_TEMP = true;
          return;
        }
      }catch(e){ console.warn("⚠️ خطای دریافت رمز سشن از گیت‌هاب:", e.message); }
      console.warn("⚠️ رمز سشن در گیت‌هاب نبود — ساخته می‌شود");
    }
    SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(secretFile, SESSION_SECRET);
    if(cloudEnabled() && !SESSION_SECRET_TEMP){
      ghPutFile("server-secret.txt", secretFile).catch(() => {});
    }
  }catch(e){
    SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  }
}

function signValue(v){
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
  return v + "." + sig;
}

function unsignValue(s){
  if(!s || typeof s !== "string") return null;
  const i = s.lastIndexOf(".");
  if(i < 0) return null;
  const v = s.slice(0, i);
  if(signValue(v) !== s) return null;
  return v;
}

function parseCookies(req){
  const out = {};
  const h = req.headers.cookie;
  if(!h) return out;
  h.split(";").forEach(p => {
    const i = p.indexOf("=");
    if(i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function sessionGid(req){
  const c = parseCookies(req);
  return unsignValue(c[SESSION_COOKIE]);
}

function setSessionCookie(res, gid, secure){
  const v = signValue(gid);
  res.setHeader("Set-Cookie",
    SESSION_COOKIE + "=" + encodeURIComponent(v) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_MAX_AGE / 1000) +
    (secure ? "; Secure" : ""));
}

function clearSessionCookie(res){
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

/* ساخت redirect_uri از روی هاست درخواست (Render همیشه https است) */
function redirectUri(req){
  const ext = process.env.RENDER_EXTERNAL_URL;
  if(ext) return ext.replace(/\/$/, "") + "/api/auth/google/callback";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return proto + "://" + req.get("host") + "/api/auth/google/callback";
}

function base64urlJson(str){
  try{ return JSON.parse(Buffer.from(str, "base64url").toString("utf8")); }
  catch(e){ return null; }
}

function googleOAuthConfigured(){
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/* ==================================================
   USER REGISTRY
   ================================================== */

const users = new Map();

function ensureUser(gid, profile){
  let u = users.get(gid);
  if(u){
    /* به‌روزرسانی پروفایل گوگل */
    if(profile && (profile.email || profile.name || profile.picture)){
      if(profile.email && profile.email !== u.meta.email) u.meta.email = profile.email;
      if(profile.name) u.meta.name = profile.name;
      if(profile.picture) u.meta.picture = profile.picture;
      u.saveMeta();
    }
    u.meta.lastSeen = Date.now();
    return u;
  }
  u = new UserBot(gid, profile || {});
  users.set(gid, u);
  u.meta.lastSeen = Date.now();
  u.saveMeta();
  saveUserIndex();
  console.log("👤 کاربر جدید: " + (profile?.email || gid));
  return u;
}

function getUser(gid){ return users.get(gid) || null; }

/* مدیر: اولین کاربر ثبت‌شده یا ایمیل‌های ADMIN_EMAILS */
function isAdminUser(u){
  if(!u) return false;
  const envList = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if(envList.includes((u.meta.email || "").toLowerCase())) return true;
  return [...users.keys()][0] === u.gid;
}

/* قابلیت مؤثر: اولویت با قفل مدیر، بعد انتخاب خود کاربر */
function featEffective(u, feat){
  const ov = (u.meta.adminOverride || {})[feat];
  if(ov === true || ov === false) return ov;
  return feat === "dup" ? !!u.runtimeConfig.enabled : !!u.confirmCfg.enabled;
}

function activeBotCount(){
  let n = 0;
  for(const u of users.values()) if(u.sock) n++;
  return n;
}

/* ==================================================
   USER BOT — یک نمونه کامل و ایزوله برای هر کاربر
   ================================================== */

class UserBot {
  constructor(gid, profile){
    this.gid = gid;
    this.dir = path.join(USERS_DIR, gid);
    this.authDir = path.join(this.dir, "auth_info");
    this.metaFile = path.join(this.dir, "meta.json");
    this.configFile = path.join(this.dir, "config.json");
    this.receiptsFile = path.join(this.dir, "receipts.json");
    this.confirmFile = path.join(this.dir, "confirm.json");

    this.meta = {
      gid,
      email: profile.email || "",
      name: profile.name || "",
      picture: profile.picture || "",
      createdAt: Date.now(),
      lastSeen: Date.now()
    };

    this.runtimeConfig = { targetGroups: [], allowedNumbers: [], enabled: true };
    this.receipts = { list: [] };
    this.confirmCfg = {
      enabled: false,
      ownerJid: null,
      ownerName: "",
      sourceGroups: [],
      contacts: {},
      queue: {}
    };

    this.sock = null;
    this.botJid = null;
    this.botNumber = null;
    this.currentQR = null;
    this.currentQRImage = null;
    this.connectionState = "disconnected";
    this.groupsCache = [];
    this.clients = new Set(); /* سوکت‌های WS پنل این کاربر */

    this.queue = [];
    this.isProcessing = false;
    this.lastProcessTime = 0;
    this.loggedOut = false;
    this.connecting = false;

    fs.mkdirSync(this.dir, { recursive: true });
  }

  /* ---------- META ---------- */
  saveMeta(){
    try{ fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2)); }catch(e){}
  }

  /* ---------- DATA ---------- */
  loadLocal(){
    this.loadConfig();
    this.loadReceipts();
    this.loadConfirm();
  }

  loadConfig(){
    try{
      if(fs.existsSync(this.configFile)){
        Object.assign(this.runtimeConfig, JSON.parse(fs.readFileSync(this.configFile, "utf8")));
      }
      if(this.runtimeConfig.targetGroupJid && !(this.runtimeConfig.targetGroups || []).length){
        this.runtimeConfig.targetGroups = [{ jid: this.runtimeConfig.targetGroupJid, name: this.runtimeConfig.targetGroupName || "" }];
      }
      delete this.runtimeConfig.targetGroupJid;
      delete this.runtimeConfig.targetGroupName;
      this.runtimeConfig.targetGroups = this.runtimeConfig.targetGroups || [];
    }catch(e){ console.error("loadConfig:", e.message); }
  }

  saveConfig(){
    try{ fs.writeFileSync(this.configFile, JSON.stringify(this.runtimeConfig, null, 2)); }
    catch(e){ console.error("saveConfig:", e.message); }
  }

  loadReceipts(){
    try{
      if(fs.existsSync(this.receiptsFile)){
        const raw = fs.readFileSync(this.receiptsFile, "utf8").trim();
        if(!raw){ this.receipts = { list: [] }; this.saveReceipts(); return; }
        const data = JSON.parse(raw);
        this.receipts = { list: [], ...data };
        console.log("💾 [" + this.gid.slice(0, 10) + "]", this.receipts.list.length, "فیش بارگذاری شد");
      }
    }catch(e){
      console.error("loadReceipts:", e.message);
      this.receipts = { list: [] };
      this.saveReceipts();
    }
  }

  saveReceipts(){
    try{ fs.writeFileSync(this.receiptsFile, JSON.stringify(this.receipts, null, 2)); }
    catch(e){ console.error("saveReceipts:", e.message); }
    scheduleBackup(this.gid);
  }

  getReceiptsForPanel(){
    return this.receipts.list
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(r => ({
        id: r.id,
        sender: r.sender,
        timestamp: r.timestamp,
        source: r.source || "image",
        data: r.data
      }));
  }

  loadConfirm(){
    try{
      if(fs.existsSync(this.confirmFile)){
        this.confirmCfg = Object.assign(this.confirmCfg, JSON.parse(fs.readFileSync(this.confirmFile, "utf8")));
      }
    }catch(e){ console.error("loadConfirm:", e.message); }
  }

  saveConfirm(){
    try{ fs.writeFileSync(this.confirmFile, JSON.stringify(this.confirmCfg, null, 2)); }catch(e){}
    scheduleBackup(this.gid);
  }

  trimConfirmQueue(){
    const keys = Object.keys(this.confirmCfg.queue);
    if(keys.length > 200){
      for(let i = 0; i < keys.length - 200; i++) delete this.confirmCfg.queue[keys[i]];
    }
  }

  confirmPublic(){
    this.trimConfirmQueue();
    const contacts = Object.entries(this.confirmCfg.contacts).map(([jid, name]) => ({ jid, name: name || jid.split("@")[0] }));
    const seen = new Set(contacts.map(c => c.jid));
    for(const r of this.receipts.list){
      const jid = r.sender + "@s.whatsapp.net";
      if(!seen.has(jid)){ contacts.push({ jid, name: r.sender, fromReceipts: true }); seen.add(jid); }
    }
    const queue = Object.values(this.confirmCfg.queue);
    return {
      enabled: this.confirmCfg.enabled,
      ownerJid: this.confirmCfg.ownerJid,
      ownerName: this.confirmCfg.ownerName,
      sourceGroups: this.confirmCfg.sourceGroups,
      pending: queue.filter(q => !q.answered).length,
      queue: queue.slice(-30).reverse(),
      contacts
    };
  }

  /* ---------- QUEUE ---------- */
  enqueueTask(task){
    this.queue.push(task);
    console.log("📋 [" + this.gid.slice(0, 10) + "] صف: " + this.queue.length + " در انتظار");
    this.processQueue();
  }

  async processQueue(){
    if(this.isProcessing) return;
    if(!this.queue.length) return;
    this.isProcessing = true;
    while(this.queue.length){
      const task = this.queue.shift();
      const now = Date.now();
      const timeSinceLast = now - this.lastProcessTime;
      if(timeSinceLast < QUEUE_DELAY_MS) await sleep(QUEUE_DELAY_MS - timeSinceLast);
      try{ await task(); }
      catch(e){ console.error("خطا در صف:", e.message); }
      this.lastProcessTime = Date.now();
    }
    this.isProcessing = false;
  }

  /* ---------- PANEL BROADCAST ---------- */
  broadcast(data){
    const msg = JSON.stringify(data);
    for(const c of this.clients){
      try{ if(c.readyState === WebSocket.OPEN) c.send(msg); }catch(e){}
    }
  }

  statePayload(){
    return {
      type: "state",
      state: this.connectionState, qr: this.currentQR, qrImage: this.currentQRImage, botNumber: this.botNumber,
      groups: this.groupsCache, config: this.runtimeConfig,
      confirm: this.confirmPublic(),
      models: { text: TEXT_MODEL, vision: VISION_MODEL },
      keys: keyManager.power()
    };
  }

  broadcastState(){
    this.broadcast(this.statePayload());
  }

  /* ---------- WHATSAPP ---------- */
  async connect(){
    if(this.connecting || this.sock) return;
    this.connecting = true;
    this.loggedOut = false;
    this.connectionState = "connecting";
    this.broadcastState();

    try{
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      let version;
      try{ ({ version } = await fetchLatestWaWebVersion()); }
      catch(e){ console.warn("⚠️ دریافت نسخه واتساپ ناموفق — از پیش‌فرض استفاده می‌شود"); }

      const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false
      });
      this.sock = sock;
      this.bindSocket(sock, saveCreds);
    }catch(e){
      console.error("خطای اتصال [" + this.gid.slice(0, 10) + "]:", e.message);
      this.sock = null;
      this.connecting = false;
      this.connectionState = "disconnected";
      this.broadcastState();
    }
  }

  bindSocket(sock, saveCreds){
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if(qr){
        this.currentQR = qr;
        this.connectionState = "qr";
        try{ this.currentQRImage = await QRCode.toDataURL(qr, { margin: 2, width: 320 }); }
        catch(e){ this.currentQRImage = null; }
        this.broadcastState();
        console.log("📱 [" + this.gid.slice(0, 10) + "] QR جدید");
      }

      if(connection === "open"){
        this.connecting = false;
        this.connectionState = "connected";
        this.currentQR = null; this.currentQRImage = null;
        this.botJid = sock.user.id;
        this.botNumber = this.botJid.split(":")[0].split("@")[0];
        console.log("✅ [" + this.gid.slice(0, 10) + "] متصل شد | شماره:", this.botNumber);

        try{ await ensureModels(); }catch(e){ console.error("detectModels:", e.message); }
        try{ await this.fetchGroups(); console.log("📋", this.groupsCache.length, "گروه"); }catch(e){}
        this.broadcastState();
        scheduleBackup(this.gid);
      }

      if(connection === "close"){
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.sock = null;
        this.connecting = false;
        this.connectionState = "disconnected";
        this.broadcastState();
        console.log("❌ [" + this.gid.slice(0, 10) + "] قطع. کد:", code);
        if(loggedOut){
          this.loggedOut = true;
          try{ if(fs.existsSync(this.authDir)) fs.rmSync(this.authDir, { recursive: true, force: true }); }catch(e){}
          console.log("🚪 [" + this.gid.slice(0, 10) + "] نشست از واتساپ حذف شد — نیازمند QR جدید");
        }else{
          setTimeout(() => this.connect().catch(() => {}), 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      /* ری‌اکشن‌ها گاهی با type=append می‌آیند — برای ری‌اکشن و کش مخاطبین هر دو نوع پردازش می‌شود */
      if(type !== "notify" && type !== "append") return;

      for(const msg of messages){
        try{
          const rJid = msg.key.remoteJid || "";

          /* کش مخاطبین — شامل jidهای @lid (واتساپ جدید) */
          if((rJid.endsWith("@s.whatsapp.net") || rJid.endsWith("@lid")) && !msg.key.fromMe){
            const known = this.confirmCfg.contacts[rJid];
            if(!known || (msg.pushName && msg.pushName !== known)){
              this.confirmCfg.contacts[rJid] = msg.pushName || known || "";
              this.saveConfirm();
            }
          }

          /* ری‌اکشن روی فیش فورواردشده → انتقال به گروه
             (شناسایی فقط با id پیام ردیابی‌شده — چنین id فقط در چت تأیید کننده وجود دارد) */
          const rMsg = msg.message?.reactionMessage;
          if(rMsg && rMsg.text && !rJid.endsWith("@g.us") && !rJid.endsWith("@broadcast") && !msg.key.fromMe){
            const entry = this.confirmCfg.queue[rMsg.key?.id];
            if(entry){
              entry.answered = true;
              entry.answer = rMsg.text;
              entry.answeredBy = rJid;
              this.saveConfirm();
              try{
                await sock.sendMessage(entry.origJid, {
                  react: {
                    text: rMsg.text,
                    key: {
                      remoteJid: entry.origJid,
                      id: entry.origId,
                      fromMe: false,
                      participant: entry.participant || undefined
                    }
                  }
                });
                console.log("✅ تایید: تأیید کننده ری‌اکشن زد", rMsg.text, "→ گروه:", entry.group);
              }catch(e){ console.error("انتقال ری‌اکشن:", e.message); }
              this.broadcastState();
            }
          }

          /* از اینجا به بعد فقط پیام‌های جدید (notify) */
          if(type !== "notify") continue;

          /* جریان واسطه تایید فیش — مستقل از ربات اصلی */
          if(featEffective(this, "confirm") && this.confirmCfg.ownerJid && rJid.endsWith("@g.us") && !msg.key.fromMe){
            if(this.confirmCfg.sourceGroups.some(g => g.jid === rJid)){
              const cType = getMessageType(msg);
              if(cType === "image" || cType === "pdf"){
                const senderJidC = msg.key.participant || rJid;
                const senderNumC = senderJidC.split("@")[0].split(":")[0];
                console.log("📩 [" + this.gid.slice(0, 10) + "] تایید: ورودی از", senderNumC, "| گروه:", this.groupNameOf(rJid) || rJid);
                this.enqueueTask(() => this.processConfirmTask(msg, cType));
              }
            }
          }

          if(!rJid.endsWith("@g.us")) continue;
          if(msg.key.fromMe) continue;
          if(!featEffective(this, "dup")) continue;
          if(this.runtimeConfig.targetGroups.length > 0 &&
             !this.runtimeConfig.targetGroups.some(t => t.jid === msg.key.remoteJid)) continue;

          const msgType = getMessageType(msg);
          const senderJid = msg.key.participant || msg.key.remoteJid;
          const senderNumber = senderJid.split("@")[0].split(":")[0];

          if(this.runtimeConfig.allowedNumbers.length > 0 &&
             !this.runtimeConfig.allowedNumbers.includes(senderNumber)) continue;

          if(msgType !== "image" && msgType !== "pdf") continue;

          console.log("📥 [" + this.gid.slice(0, 10) + "] ورودی از:", senderNumber, "| نوع:", msgType);
          this.enqueueTask(() => this.processReceiptTask(msg, msgType, senderNumber));

        }catch(err){
          console.error("❌ خطا:", err.message);
        }
      }
    });

    sock.ev.on("groups.update", async () => {
      try{ await this.fetchGroups(); this.broadcastState(); }catch(e){}
    });
    sock.ev.on("group-participants.update", async () => {
      try{ await this.fetchGroups(); this.broadcastState(); }catch(e){}
    });
  }

  async fetchGroups(){
    if(!this.sock || this.connectionState !== "connected") return;
    const chats = await this.sock.groupFetchAllParticipating();
    const list = Object.keys(chats).map(jid => ({
      jid, name: chats[jid].subject,
      participants: chats[jid].participants?.length || 0
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.groupsCache = list;
  }

  groupNameOf(jid){
    const g = this.groupsCache.find(x => x.jid === jid);
    return g ? g.name : "";
  }

  async sendReaction(msg, emoji){
    try{
      await this.sock.sendMessage(msg.key.remoteJid, {
        react: { text: emoji, key: msg.key }
      });
      return true;
    }catch(e){ return false; }
  }

  /* ---------- RECEIPT PIPELINE ---------- */
  async handleReceipt(imageData, senderNumber, source = "image", msgKey = null){
    let info;
    try{
      info = await extractReceiptInfo(imageData.base64);
    }catch(e){
      console.error("extractReceiptInfo نهایی:", e.message);
      return { status: "error", message: source === "pdf" ? MSG_PDF_ERROR : MSG_ERROR };
    }

    if(info.isReceipt === false) return { status: "not_receipt", message: MSG_NOT_RECEIPT };

    const dup = findDuplicateByVision(this.receipts.list, info);

    if(dup){
      console.log("🔁 تکراری — لایه: " + dup.layer + " — " + (dup.score * 100).toFixed(1) + "%");
      return { status: "duplicate", score: dup.score, matched: dup.record, layer: dup.layer };
    }

    const id = "rc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const record = { id, data: info, sender: senderNumber, timestamp: Date.now(), source, msgKey: msgKey || null };
    this.receipts.list.push(record);
    this.saveReceipts();
    this.broadcast({ type: "receipts", receipts: this.getReceiptsForPanel() });
    console.log("✅ فیش جدید ذخیره شد:", id);
    return { status: "saved", id };
  }

  async processReceiptTask(msg, msgType, senderNumber){
    try{
      await this.sendReaction(msg, REACTION_PROCESSING);

      let imageData = null;
      let source = "image";

      if(msgType === "image"){
        imageData = await downloadImage(this.sock, msg);
      }else if(msgType === "pdf"){
        source = "pdf";
        imageData = await downloadPdf(this.sock, msg);
      }

      if(!imageData){
        await this.sendReaction(msg, REACTION_ERROR);
        await this.sock.sendMessage(msg.key.remoteJid, {
          text: msgType === "pdf" ? MSG_PDF_ERROR : MSG_ERROR
        }, { quoted: msg });
        return;
      }

      const result = await this.handleReceipt(imageData, senderNumber, source, msg.key);

      if(result.status === "duplicate"){
        await this.sendReaction(msg, REACTION_DUPLICATE);

        // ---- ریپلای ۱: به پیام فعلی ----
        await this.sock.sendMessage(msg.key.remoteJid, {
          text: MSG_DUPLICATE
        }, { quoted: msg });

        // ---- ریپلای ۲: فقط تاریخ به پیام اصلی ----
        const matched = result.matched;
        if(matched && matched.msgKey && matched.msgKey.id && matched.msgKey.remoteJid){
          try{
            const rd = matched.data || {};
            const oldDate = formatDate(matched.timestamp)
              + (rd.date ? "\n🧾 مورخ فیش: " + rd.date : "")
              + (rd.time ? " — " + rd.time : "");

            await this.sock.sendMessage(msg.key.remoteJid, {
              text: oldDate
            }, { quoted: buildQuoted(matched.msgKey) });

            console.log("📤 ریپلای ۲ با تاریخ:", oldDate);
          }catch(e){
            console.error("خطا ریپلای ۲:", e.message);
          }
        }
        console.log("📤 تکراری ❌");
      }
      else if(result.status === "not_receipt"){
        /* فیش نبود — بی‌صدا رها کن */
        await this.sendReaction(msg, "");
        console.log("🤫 فیش نبود — نادیده گرفته شد");
      }
      else if(result.status === "saved"){
        await this.sendReaction(msg, REACTION_NEW);
        console.log("📤 فیش جدید ✅");
      }
      else{
        await this.sendReaction(msg, REACTION_ERROR);
        await this.sock.sendMessage(msg.key.remoteJid, {
          text: result.message || MSG_ERROR
        }, { quoted: msg });
      }
    }catch(err){
      console.error("❌ خطا processReceiptTask:", err.message);
      try{ await this.sendReaction(msg, REACTION_ERROR); }catch(e){}
    }
  }

  async processConfirmTask(msg, msgType){
    try{
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const senderNum = senderJid.split("@")[0].split(":")[0];
      const groupJid = msg.key.remoteJid;
      const gName = this.groupNameOf(groupJid) || groupJid;

      /* 🔍 در حال اسکن */
      try{ await this.sock.sendMessage(groupJid, { react: { text: CONFIRM_SCAN, key: msg.key } }); }catch(e){}

      let imageData = null;
      if(msgType === "image") imageData = await downloadImage(this.sock, msg);
      else imageData = await downloadPdf(this.sock, msg);

      if(!imageData){
        try{ await this.sock.sendMessage(groupJid, { react: { text: "", key: msg.key } }); }catch(e){}
        return;
      }

      let info = null;
      try{ info = await extractReceiptInfo(imageData.base64); }catch(e){ info = null; }

      if(!info || info.isReceipt === false){
        /* فیش نبود — بی‌صدا رها کن */
        try{ await this.sock.sendMessage(groupJid, { react: { text: "", key: msg.key } }); }catch(e){}
        console.log("🤫 تایید: فیش نبود — نادیده گرفته شد");
        return;
      }

      /* فوروارد فایل اصلی به تأیید کننده */
      const raw = await downloadMediaMessage(msg, "buffer", {},
        { logger: pino({ level: "silent" }), reuploadRequest: this.sock.updateMediaMessage });

      const lines = ["📩 *فیش جدید — نیازمند تأیید شما*", ""];
      if(gName) lines.push("👥 گروه: " + gName);
      lines.push("👤 فرستنده: " + (msg.pushName || senderNum) + " (" + senderNum + ")");
      if(info.amount) lines.push("💰 مبلغ: " + info.amount + " " + (info.currency || ""));
      if(info.bank) lines.push("🏦 بانک: " + info.bank);
      if(info.date) lines.push("📅 تاریخ فیش: " + info.date + (info.time ? " — " + info.time : ""));
      lines.push("");
      lines.push("بعد از بررسی حساب، روی همین پیام ری‌اکشن بزن — همان ری‌اکشن دقیقا در گروه روی فیش نشان داده می‌شود ⬇️");

      let sent = null;
      if(msgType === "pdf"){
        sent = await this.sock.sendMessage(this.confirmCfg.ownerJid, {
          document: raw, mimetype: "application/pdf", fileName: "receipt.pdf",
          caption: lines.join("\n")
        });
      }else{
        const mt = msg.message?.imageMessage?.mimetype || "image/jpeg";
        sent = await this.sock.sendMessage(this.confirmCfg.ownerJid, {
          image: raw, mimetype: mt, caption: lines.join("\n")
        });
      }

      if(!sent || !sent.key || !sent.key.id){
        console.error("تایید: فوروارد ناموفق");
        try{ await this.sock.sendMessage(groupJid, { react: { text: "⚠️", key: msg.key } }); }catch(e){}
        return;
      }

      this.confirmCfg.queue[sent.key.id] = {
        origJid: groupJid,
        origId: msg.key.id,
        participant: msg.key.participant || null,
        group: gName,
        sender: senderNum,
        amount: info.amount || "",
        currency: info.currency || "",
        ts: Date.now(),
        answered: false,
        answer: ""
      };
      this.trimConfirmQueue();
      this.saveConfirm();
      this.broadcastState();

      /* ⏫ در انتظار تأیید */
      await this.sock.sendMessage(groupJid, { react: { text: CONFIRM_WAIT, key: msg.key } });
      console.log("📤 تایید: فیش به تأیید کننده فوروارد شد | گروه:", gName);
    }catch(e){
      console.error("processConfirmTask:", e.message);
      try{ await this.sock.sendMessage(msg.key.remoteJid, { react: { text: "⚠️", key: msg.key } }); }catch(err){}
    }
  }

  /* ---------- WHATSAPP LOGOUT ---------- */
  async waLogout(){
    try{
      if(this.sock){ try{ await this.sock.logout(); }catch(e){} }
      this.sock = null;
    }catch(e){}
    try{ if(fs.existsSync(this.authDir)) fs.rmSync(this.authDir, { recursive: true, force: true }); }catch(e){}
    /* sha cache برای فایل‌های نشست این کاربر باطل شود */
    for(const k of pushedShaCache.keys()){
      if(k.startsWith("users/" + this.gid + "/auth_info/")) pushedShaCache.delete(k);
    }
    this.connectionState = "disconnected";
    this.currentQR = null; this.currentQRImage = null;
    this.botJid = null; this.botNumber = null; this.groupsCache = [];
    this.broadcastState();
    setTimeout(() => this.connect().catch(() => {}), 1500);
  }
}

/* ==================================================
   EXPRESS + WS
   ================================================== */

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* احراز هویت سشن — همه APIها به جز auth نیاز به کوکی دارند */
app.use("/api", (req, res, next) => {
  if(req.path.startsWith("/auth/") || req.path === "/health") return next();
  const gid = sessionGid(req);
  if(!gid) return res.status(401).json({ error: "unauthorized" });
  /* کوکی امضاشده = خودمان صادرش کرده‌ایم؛ اگر کاربر هنوز ثبت نشده، ساخته می‌شود */
  let u = getUser(gid);
  if(!u) u = ensureUser(gid, {});
  req.user = u;
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true, users: users.size, ts: Date.now() }));

/* ---------- GOOGLE OAUTH ---------- */
app.get("/api/auth/google", (req, res) => {
  if(!googleOAuthConfigured()){
    return res.status(500).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET تنظیم نشده است");
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account"
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});

app.get("/api/auth/google/callback", async (req, res) => {
  try{
    if(!googleOAuthConfigured()){
      return res.status(500).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET تنظیم نشده است");
    }
    const code = req.query.code;
    if(!code) return res.redirect("/?auth=error");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code"
      })
    });
    if(!tokenRes.ok){
      console.error("google token:", tokenRes.status, await tokenRes.text().catch(() => ""));
      return res.redirect("/?auth=error");
    }
    const tokens = await tokenRes.json();
    const idToken = tokens.id_token;
    if(!idToken) return res.redirect("/?auth=error");

    /* payload توکن (بدون verify امضا — کد مستقیما از گوگل آمده) */
    const parts = idToken.split(".");
    if(parts.length < 2) return res.redirect("/?auth=error");
    const payload = base64urlJson(parts[1]);
    if(!payload || !payload.sub) return res.redirect("/?auth=error");
    if(payload.email && payload.email_verified === false) return res.redirect("/?auth=error");

    const gid = String(payload.sub);
    if(!/^[A-Za-z0-9_\-]{5,}$/.test(gid)) return res.redirect("/?auth=error");

    const profile = {
      email: payload.email || "",
      name: payload.name || "",
      picture: payload.picture || ""
    };
    const u = ensureUser(gid, profile);
    u.loadLocal();

    /* اتصال خودکار به واتساپ — چه نشست قدیمی داشته باشد چه اولین ورودش باشد */
    if(!u.sock && !u.connecting){
      if(activeBotCount() < MAX_CONCURRENT_BOTS || fs.existsSync(path.join(u.authDir, "creds.json"))){
        u.connect().catch(e => console.error("اتصال کاربر پس از ورود:", e.message));
      }
    }

    const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
    setSessionCookie(res, gid, secure);
    res.redirect("/?auth=ok");
  }catch(e){
    console.error("google callback:", e.message);
    res.redirect("/?auth=error");
  }
});

app.get("/api/auth/me", (req, res) => {
  const gid = sessionGid(req);
  if(!gid) return res.status(401).json({ error: "unauthorized" });
  const u = getUser(gid);
  if(!u) return res.status(401).json({ error: "unauthorized" });
  res.json({ gid: u.gid, email: u.meta.email, name: u.meta.name, picture: u.meta.picture,
             admin: isAdminUser(u), lock: u.meta.adminOverride || {} });
});

app.get("/api/admin/users", (req, res) => {
  if(!isAdminUser(req.user)) return res.status(403).json({ error: "forbidden" });
  res.json({ users: [...users.values()].map(u => ({
    gid: u.gid,
    email: u.meta.email || "",
    name: u.meta.name || "",
    picture: u.meta.picture || "",
    botNumber: u.botNumber || "",
    state: u.connectionState,
    lastSeen: u.meta.lastSeen || 0,
    dup: { own: !!u.runtimeConfig.enabled, override: (u.meta.adminOverride || {}).dup === undefined ? null : (u.meta.adminOverride || {}).dup },
    confirm: { own: !!u.confirmCfg.enabled, override: (u.meta.adminOverride || {}).confirm === undefined ? null : (u.meta.adminOverride || {}).confirm }
  })) });
});

app.post("/api/admin/override", (req, res) => {
  if(!isAdminUser(req.user)) return res.status(403).json({ error: "forbidden" });
  const target = getUser(req.body.gid);
  if(!target) return res.status(404).json({ error: "not_found" });
  const ov = target.meta.adminOverride || {};
  if("dup" in req.body) ov.dup = (req.body.dup === true || req.body.dup === false) ? req.body.dup : null;
  if("confirm" in req.body) ov.confirm = (req.body.confirm === true || req.body.confirm === false) ? req.body.confirm : null;
  target.meta.adminOverride = ov;
  target.saveMeta();
  if(ov.dup === true || ov.dup === false){ target.runtimeConfig.enabled = ov.dup; target.saveConfig(); }
  if(ov.confirm === true || ov.confirm === false){ target.confirmCfg.enabled = ov.confirm; target.saveConfirm(); }
  target.broadcastState();
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ---------- STATUS / DATA ---------- */

app.get("/api/status", (req, res) => {
  const u = req.user;
  res.json({
    state: u.connectionState, qr: u.currentQR, qrImage: u.currentQRImage, botNumber: u.botNumber,
    groups: u.groupsCache, config: u.runtimeConfig,
    models: { text: TEXT_MODEL, vision: VISION_MODEL },
    keys: keyManager.power(),
    queue: { pending: u.queue.length, busy: u.isProcessing }
  });
});

app.get("/api/keys", async (req, res) => {
  await keyManager.refreshStatus();
  res.json({ keys: keyManager.power() });
});

app.get("/api/receipts", (req, res) => res.json({ receipts: req.user.getReceiptsForPanel() }));

app.delete("/api/receipts/:id", (req, res) => {
  const u = req.user;
  const idx = u.receipts.list.findIndex(r => r.id === req.params.id);
  if(idx < 0) return res.json({ ok: false, error: "not found" });
  u.receipts.list.splice(idx, 1);
  u.saveReceipts();
  u.broadcast({ type: "receipts", receipts: u.getReceiptsForPanel() });
  res.json({ ok: true });
});

app.delete("/api/receipts", (req, res) => {
  const u = req.user;
  u.receipts = { list: [] };
  u.saveReceipts();
  u.broadcast({ type: "receipts", receipts: [] });
  res.json({ ok: true });
});

/* ---------- GROUPS / CONFIG ---------- */

app.post("/api/select-group", (req, res) => {
  const u = req.user;
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  const idx = u.runtimeConfig.targetGroups.findIndex(t => t.jid === jid);
  if(idx >= 0){
    u.runtimeConfig.targetGroups.splice(idx, 1);
    u.saveConfig(); u.broadcastState();
    return res.json({ ok: true, selected: false, count: u.runtimeConfig.targetGroups.length });
  }
  u.runtimeConfig.targetGroups.push({ jid, name: name || "" });
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true, selected: true, count: u.runtimeConfig.targetGroups.length });
});

app.post("/api/clear-group", (req, res) => {
  const u = req.user;
  u.runtimeConfig.targetGroups = [];
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true });

app.post("/api/select-all-groups", (req, res) => {
  const u = req.user;
  u.runtimeConfig.targetGroups = (u.groupsCache || []).map(g => ({ jid: g.jid, name: g.name || "" }));
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true, count: u.runtimeConfig.targetGroups.length });
});
});

app.post("/api/allowed-numbers", (req, res) => {
  const u = req.user;
  u.runtimeConfig.allowedNumbers = (req.body.numbers || []).filter(n => /^\d+$/.test(n));
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/toggle", (req, res) => {
  const u = req.user;
  const ov = (u.meta.adminOverride || {}).dup;
  u.runtimeConfig.enabled = (ov === true || ov === false) ? ov : !!req.body.enabled;
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true, locked: ov === true || ov === false, enabled: u.runtimeConfig.enabled });
});

app.post("/api/refresh-groups", async (req, res) => {
  const u = req.user;
  try{ await u.fetchGroups(); res.json({ ok: true, groups: u.groupsCache }); }
  catch(e){ res.json({ ok: false, error: e.message }); }
});

/* ---------- واسطه تایید فیش ---------- */

app.get("/api/confirm", (req, res) => res.json(req.user.confirmPublic()));

app.post("/api/confirm/toggle", (req, res) => {
  const u = req.user;
  const ov = (u.meta.adminOverride || {}).confirm;
  u.confirmCfg.enabled = (ov === true || ov === false) ? ov : !!req.body.enabled;
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, locked: ov === true || ov === false, enabled: u.confirmCfg.enabled });
});

app.post("/api/confirm/owner", (req, res) => {
  const u = req.user;
  const { jid, name } = req.body;
  if(!jid || !jid.endsWith("@s.whatsapp.net")) return res.json({ ok: false, error: "شماره معتبر نیست" });
  u.confirmCfg.ownerJid = jid;
  u.confirmCfg.ownerName = name || "";
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/owner-clear", (req, res) => {
  const u = req.user;
  u.confirmCfg.ownerJid = null;
  u.confirmCfg.ownerName = "";
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/select-group", (req, res) => {
  const u = req.user;
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  const idx = u.confirmCfg.sourceGroups.findIndex(g => g.jid === jid);
  if(idx >= 0) u.confirmCfg.sourceGroups.splice(idx, 1);
  else u.confirmCfg.sourceGroups.push({ jid, name: name || "" });
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, selected: idx < 0, count: u.confirmCfg.sourceGroups.length });
});

app.post("/api/confirm/clear-groups", (req, res) => {
  const u = req.user;
  u.confirmCfg.sourceGroups = [];
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/select-all-groups", (req, res) => {
  const u = req.user;
  u.confirmCfg.sourceGroups = (u.groupsCache || []).map(g => ({ jid: g.jid, name: g.name || "" }));
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, count: u.confirmCfg.sourceGroups.length });
});

app.post("/api/confirm/add-contact", (req, res) => {
  const u = req.user;
  let num = String(req.body.number || "").replace(/\D/g, "");
  if(!num) return res.json({ ok: false, error: "شماره لازم است" });
  if(num.startsWith("00")) num = num.slice(2);
  if(num.startsWith("0")) num = num.slice(1);
  if(num.length <= 9) num = "93" + num; /* پیش‌فرض افغانستان اگر کد کشور داده نشد */
  const jid = num + "@s.whatsapp.net";
  u.confirmCfg.contacts[jid] = req.body.name || "";
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, jid });
});

/* ---------- WHATSAPP CONNECTION ---------- */

/* شروع اتصال (برای کاربر تازه‌وارد که هنوز باتش وصل نیست) */
app.post("/api/connect", (req, res) => {
  const u = req.user;
  if(u.sock || u.connecting){
    return res.json({ ok: true, already: true });
  }
  if(activeBotCount() >= MAX_CONCURRENT_BOTS && !fs.existsSync(path.join(u.authDir, "creds.json"))){
    return res.status(503).json({ ok: false, error: "ظرفیت سرور پر است — بعداً تلاش کن" });
  }
  u.connect().catch(() => {});
  res.json({ ok: true });
});

app.post("/api/logout", async (req, res) => {
  const u = req.user;
  try{
    await u.waLogout();
    res.json({ ok: true });
  }catch(e){ res.json({ ok: false, error: e.message }); }
});

/* ==================================================
   WS — احراز هویت با کوکی سشن
   ================================================== */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function heartbeat(){
  this.isAlive = true;
}

wss.on("connection", (ws, req) => {
  try{
    const gid = sessionGid(req);
    const u = gid ? getUser(gid) : null;
    if(!u){
      ws.close(4001, "unauthorized");
      return;
    }
    ws.gid = gid;
    ws.isAlive = true;
    ws.on("pong", heartbeat);
    u.clients.add(ws);
    ws.on("close", () => { u.clients.delete(ws); });
    ws.send(JSON.stringify(u.statePayload()));
    ws.send(JSON.stringify({
      type: "receipts",
      receipts: u.getReceiptsForPanel()
    }));
  }catch(e){
    try{ ws.close(); }catch(err){}
  }
});

setInterval(() => {
  wss.clients.forEach(c => {
    if(c.isAlive === false){ try{ c.terminate(); }catch(e){} return; }
    c.isAlive = false;
    try{ c.ping(); }catch(e){}
  });
}, 30000);

setInterval(() => {
  for(const u of users.values()) u.broadcast({ type: "keys", keys: keyManager.power() });
}, 5000);

/* ==================================================
   START
   ================================================== */

(async () => {
  await initSessionSecret();
  keyManager.init();

  execFile("pdftoppm", ["-v"], (err, stdout, stderr) => {
    const out = (stderr || stdout || "").split("\n")[0];
    if(err && !out){
      console.error("⚠️ pdftoppm نصب نیست!");
    }else{
      console.log("✅ pdftoppm:", out.trim());
    }
  });

  server.listen(PORT, () => {
    console.log("");
    console.log("🌐 پنل وب: http://localhost:" + PORT);
    console.log("🤖 نسخه چندکاربره v9.0.0 — ورود با گوگل");
    console.log("🔑 OAuth گوگل:", googleOAuthConfigured() ? "فعال" : "❌ تنظیم نشده");
    console.log("💾 حداکثر بات هم‌زمان:", MAX_CONCURRENT_BOTS);
    console.log("🎯 تشخیص تکراری سخت‌گیرانه (Strict)");
    console.log("📅 فرمت تاریخ: 2026/09/15 10:14 PM");
    console.log("");

    startCloudTasks();

    restoreAllFromGithub().finally(() => {
      ensureModels().catch(e => console.error("خطای اولیه مدل‌ها:", e.message));
    });
  });
})();
