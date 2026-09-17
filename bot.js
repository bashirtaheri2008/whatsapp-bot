/* ==================================================
   WhatsApp AI Bot — نسخه صرافی (نهایی)
   Multi-Key • Fuzzy Vision • ریپلای با تاریخ
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
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

/* ==================================================
   🔑 API KEYS
   ================================================== */

/* ==================================================
   AI GATEWAY — دروازه هوش مصنوعی متمرک
   همه درخواست‌های AI از طریق سرور مرکزی (همگاب) می‌روند.
   کلیدهای واقعی روی گیت‌وی مدیریت و می‌چرخند.
   قدرت = کلیدهای فعال × ۷۰۰ کردیت در دقیقه
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
const AUTH_DIR = path.join(__dirname, "auth_info");
const CONFIG_FILE = path.join(__dirname, "config.json");
const RECEIPTS_FILE = path.join(__dirname, "receipts.json");
const PIN_FILE = path.join(__dirname, "pin.json");

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

const STRONG_THRESHOLD = 0.90;
const MEDIUM_THRESHOLD = 0.82;

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
const CONFIRM_FILE = path.join(__dirname, "confirm.json");
const CONFIRM_SCAN = "🔍";
const CONFIRM_WAIT = "⏫";

/* ==================================================
   STATE
   ================================================== */

let sock = null;
let botJid = null;
let botNumber = null;
let currentQR = null, currentQRImage = null;
let connectionState = "disconnected";
let groupsCache = [];

const runtimeConfig = {
  targetGroups: [],
  allowedNumbers: [],
  enabled: true
};

let receipts = { list: [] };

/* ==================================================
   CONFIRM — واسطه تایید فیش
   گروه‌ها فیش می‌فرستند → فوروارد به صاحب کارت →
   ری‌اکشن صاحب کارت روی فیش گروه منتقل می‌شود
   ================================================== */

let confirmCfg = {
  enabled: false,
  ownerJid: null,
  ownerName: "",
  sourceGroups: [],
  contacts: {},
  queue: {}
};

function loadConfirm(){
  try{
    if(fs.existsSync(CONFIRM_FILE)){
      confirmCfg = Object.assign(confirmCfg, JSON.parse(fs.readFileSync(CONFIRM_FILE, "utf8")));
    }
  }catch(e){ console.error("loadConfirm:", e.message); }
}

function saveConfirm(){
  try{ fs.writeFileSync(CONFIRM_FILE, JSON.stringify(confirmCfg, null, 2)); }catch(e){}
}

function trimConfirmQueue(){
  const keys = Object.keys(confirmCfg.queue);
  if(keys.length > 200){
    for(let i = 0; i < keys.length - 200; i++) delete confirmCfg.queue[keys[i]];
  }
}

function confirmPublic(){
  trimConfirmQueue();
  const contacts = Object.entries(confirmCfg.contacts).map(([jid, name]) => ({ jid, name: name || jid.split("@")[0] }));
  const seen = new Set(contacts.map(c => c.jid));
  for(const r of receipts.list){
    const jid = r.sender + "@s.whatsapp.net";
    if(!seen.has(jid)){ contacts.push({ jid, name: r.sender, fromReceipts: true }); seen.add(jid); }
  }
  const queue = Object.values(confirmCfg.queue);
  return {
    enabled: confirmCfg.enabled,
    ownerJid: confirmCfg.ownerJid,
    ownerName: confirmCfg.ownerName,
    sourceGroups: confirmCfg.sourceGroups,
    pending: queue.filter(q => !q.answered).length,
    queue: queue.slice(-30).reverse(),
    contacts
  };
}

/* ==================================================
   QUEUE
   ================================================== */

const processingQueue = [];
let isProcessing = false;
let lastProcessTime = 0;

function enqueueTask(task){
  processingQueue.push(task);
  console.log("📋 صف: " + processingQueue.length + " در انتظار");
  processQueue();
}

async function processQueue(){
  if(isProcessing) return;
  if(!processingQueue.length) return;
  isProcessing = true;
  while(processingQueue.length){
    const task = processingQueue.shift();
    const now = Date.now();
    const timeSinceLast = now - lastProcessTime;
    if(timeSinceLast < QUEUE_DELAY_MS) await sleep(QUEUE_DELAY_MS - timeSinceLast);
    try{ await task(); }
    catch(e){ console.error("خطا در صف:", e.message); }
    lastProcessTime = Date.now();
  }
  isProcessing = false;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ==================================================
   RECEIPTS STORE
   ================================================== */

function loadReceipts(){
  try{
    if(fs.existsSync(RECEIPTS_FILE)){
      const raw = fs.readFileSync(RECEIPTS_FILE, "utf8").trim();
      if(!raw){ receipts = { list: [] }; saveReceipts(); return; }
      const data = JSON.parse(raw);
      receipts = { list: [], ...data };
      console.log("💾", receipts.list.length, "فیش بارگذاری شد");
    }
  }catch(e){
    console.error("loadReceipts:", e.message);
    receipts = { list: [] };
    saveReceipts();
  }
}

function saveReceipts(){
  try{ fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2)); }
  catch(e){ console.error("saveReceipts:", e.message); }
  scheduleBackup();
}

function getReceiptsForPanel(){
  return receipts.list
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

/* ==================================================
   FORMAT DATE — 12 ساعته با AM/PM
   ================================================== */

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

/* ==================================================
   NORMALIZE
   ================================================== */

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

/* ==================================================
   SIMILARITY
   ================================================== */

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

/* ==================================================
   COMPARE
   ================================================== */

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
   FIND DUPLICATE — 6 لایه
   ================================================== */

function timeMatches(t1, t2){
  if(!t1 || !t2) return null;
  const min1 = t1.split(":").slice(0, 2).join(":");
  const min2 = t2.split(":").slice(0, 2).join(":");
  if(min1 !== min2) return false;
  if(t1.includes(":") && t2.split(":").length > 2 && t1.split(":").length > 2){
    return t1.split(":")[2] === t2.split(":")[2];
  }
  return true;
}

/* ==================================================
   FIND DUPLICATE — حالت سخت‌گیرانه (Strict) v2
   قانون طلایی: هر فیلد عددی (پیگیری، قواره، مرجع، مبلغ،
   IBAN فرستنده/گیرنده، تاریخ، ساعت) که در هر دو فیش خوانده
   شده و حتی یک رقم/مقدار فرق داشته باشد → قطعاً تکراری نیست.
   تکراری فقط با یکی از این دو شرط اعلام می‌شود:
   ۱) کد یکتای تراکنش (پیگیری / قواره / مرجع) دقیقاً یکسان
   ۲) IBAN فرستنده + مبلغ + IBAN گیرنده + تاریخ — همه در هر دو
      فیش خوانده شده و دقیقاً یکسان (ساعت هم اگر هر دو دارند دقیقاً یکسان)
   هیچ مقایسه نرم، شباهت درصدی یا حدس دیگری وجود ندارد.
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

function findDuplicateByVision(newInfo){
  if(!receipts.list.length) return null;

  const nTime = normalizeTime(newInfo.time);

  for(const existing of receipts.list){
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
   CONFIG
   ================================================== */

function saveConfig(){
  try{ fs.writeFileSync(CONFIG_FILE, JSON.stringify(runtimeConfig, null, 2)); }
  catch(e){ console.error("saveConfig:", e.message); }
}

function loadConfig(){
  try{
    if(fs.existsSync(CONFIG_FILE)){
      Object.assign(runtimeConfig, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
    }
    if(runtimeConfig.targetGroupJid && !(runtimeConfig.targetGroups||[]).length){
      runtimeConfig.targetGroups = [{ jid: runtimeConfig.targetGroupJid, name: runtimeConfig.targetGroupName || "" }];
    }
    delete runtimeConfig.targetGroupJid;
    delete runtimeConfig.targetGroupName;
    runtimeConfig.targetGroups = runtimeConfig.targetGroups || [];
  }catch(e){ console.error("loadConfig:", e.message); }
}

/* ==================================================
   PANEL PIN LOCK
   ================================================== */

const crypto = require("crypto");
const authTokens = new Set();

function loadPinData(){
  try{
    if(fs.existsSync(PIN_FILE)) return JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
  }catch(e){ console.error("loadPin:", e.message); }
  return null;
}
function hasPin(){ return !!loadPinData(); }
function setPin(pin){
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + String(pin)).digest("hex");
  try{ fs.writeFileSync(PIN_FILE, JSON.stringify({ salt, hash }, null, 2)); }
  catch(e){ console.error("savePin:", e.message); }
}
function verifyPin(pin){
  const d = loadPinData();
  if(!d) return false;
  const h = crypto.createHash("sha256").update(d.salt + String(pin)).digest("hex");
  return h === d.hash;
}
function issueToken(){
  const t = crypto.randomBytes(24).toString("hex");
  authTokens.add(t);
  return t;
}
function tokenValid(t){ return !!t && authTokens.has(t); }

/* ==================================================
   CLOUD BACKUP (GitHub)
   نشست واتساپ + فیش‌ها + تنظیمات را در ریپوی خصوصی ذخیره می‌کند
   متغیرهای محیطی: GITHUB_TOKEN و GITHUB_REPO
   ================================================== */

const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || ""; /* مثل "user/wa-bot-data" */
const GH_BASE = process.env.GH_BASE || "https://api.github.com";
function cloudEnabled(){ return !!(GH_TOKEN && GH_REPO); }

async function ghApi(method, urlPath, body){
  return fetch(GH_BASE + urlPath, {
    method,
    headers: {
      "Authorization": "Bearer " + GH_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "wa-bot",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
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

  /* قبلاً پوش شده و تغییری نکرده — بدون هیچ درخواستی رد شو */
  if(pushedShaCache.get(remotePath) === localSha) return true;

  const content = fs.readFileSync(localFile).toString("base64");
  let sha;
  try{
    const g = await ghApi("GET", "/repos/" + GH_REPO + "/contents/" + encodeURI(remotePath));
    if(g.ok){
      sha = (await g.json()).sha;
      if(sha === localSha){
        pushedShaCache.set(remotePath, localSha);
        return true; /* ریموت هم همین محتواست */
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
let lastBackupReq = 0;
async function backupNow(reason){
  if(!cloudEnabled() || backupBusy) return;
  backupBusy = true;
  try{
    /* اول دیتاهای حیاتی — بعد نشست (نشست شامل صد‌ها فایل lid-mapping است) */
    const files = [];
    if(fs.existsSync(RECEIPTS_FILE)) files.push(["receipts.json", RECEIPTS_FILE]);
    if(fs.existsSync(CONFIG_FILE)) files.push(["config.json", CONFIG_FILE]);
    if(fs.existsSync(PIN_FILE)) files.push(["pin.json", PIN_FILE]);
    if(fs.existsSync(CONFIRM_FILE)) files.push(["confirm.json", CONFIRM_FILE]);
    if(fs.existsSync(AUTH_DIR)){
      fs.readdirSync(AUTH_DIR).forEach(f => {
        const p = path.join(AUTH_DIR, f);
        if(fs.statSync(p).isFile()) files.push(["auth_info/" + f, p]);
      });
    }
    let ok = 0;
    let changed = 0;
    for(const pair of files){
      const localSha = blobSha(pair[1]);
      const already = pushedShaCache.get(pair[0]) === localSha;
      if(already) continue; /* بدون تغییر */
      changed++;
      if(await ghPutFile(pair[0], pair[1])) ok++;
    }
    console.log("☁️ بکاپ " + reason + ": " + (changed ? (ok + "/" + changed + " فایل تغییرکرده") : "بدون تغییر — همه یکسان"));
  }catch(e){
    console.error("backup:", e.message);
  }finally{
    backupBusy = false;
  }
}
function scheduleBackup(){
  if(!cloudEnabled()) return;
  if(Date.now() - lastBackupReq < 90000) return;
  lastBackupReq = Date.now();
  setTimeout(() => backupNow("رویداد"), 1500);
}

async function restoreFromGithub(){
  if(!cloudEnabled()){
    console.log("☁️ بکاپ ابری غیرفعال (GITHUB_TOKEN ست نشده)");
    return;
  }
  try{
    if(!fs.existsSync(RECEIPTS_FILE)) await ghGetFile("receipts.json", RECEIPTS_FILE);
    if(!fs.existsSync(CONFIG_FILE)) await ghGetFile("config.json", CONFIG_FILE);
    if(!fs.existsSync(PIN_FILE)) await ghGetFile("pin.json", PIN_FILE);
    if(!fs.existsSync(CONFIRM_FILE)) await ghGetFile("confirm.json", CONFIRM_FILE);
  }catch(e){ console.error("restore (json):", e.message); }
  try{
    const r = await ghApi("GET", "/repos/" + GH_REPO + "/contents/auth_info");
    if(r.ok){
      const list = await r.json();
      let n = 0;
      for(const item of list){
        try{
          const local = path.join(AUTH_DIR, item.name);
          if(!fs.existsSync(local) && (await ghGetFile("auth_info/" + item.name, local))) n++;
        }catch(e){ console.error("restore (" + item.name + "):", e.message); }
      }
      console.log("☁️ بازیابی نشست: " + n + " فایل");
    }
  }catch(e){ console.error("restore (session):", e.message); }
  loadConfig();
  loadReceipts();
  console.log("☁️ بازیابی از گیت‌هاب کامل شد");
}

function startCloudTasks(){
  if(!cloudEnabled()) return;
  /* بکاپ دوره‌ای هر ۵ دقیقه */
  setInterval(() => backupNow("خودکار"), 5 * 60 * 1000);
  /* ضد خواب ریندر: پینگ خودکار هر ۱۰ دقیقه */
  const extUrl = process.env.RENDER_EXTERNAL_URL;
  if(extUrl){
    setInterval(() => { fetch(extUrl + "/api/auth/status").catch(() => {}); }, 10 * 60 * 1000);
    console.log("⏰ پینگ ضد خواب فعال:", extUrl);
  }
}

process.on("SIGTERM", () => {
  if(!cloudEnabled()) process.exit(0);
  backupNow("خاموشی").finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 15000);
});

/* ==================================================
   EXPRESS + WS
   ================================================== */

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* قفل پنل — همه APIها به جز auth نیاز به توکن دارند */
app.use("/api", (req, res, next) => {
  if(req.path.startsWith("/auth/")) return next();
  if(tokenValid(req.headers["x-auth-token"])) return next();
  return res.status(401).json({ error: "unauthorized" });
});

app.get("/api/auth/status", (req, res) => res.json({ hasPin: hasPin() }));

app.post("/api/auth/setup", (req, res) => {
  if(hasPin()) return res.status(409).json({ ok: false, error: "pin-exists" });
  const pin = String((req.body || {}).pin || "");
  if(!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, error: "invalid" });
  setPin(pin);
  console.log("🔒 پین پنل تنظیم شد");
  res.json({ ok: true, token: issueToken() });
});

app.post("/api/auth/login", (req, res) => {
  const pin = String((req.body || {}).pin || "");
  if(!hasPin()) return res.status(400).json({ ok: false, error: "no-pin" });
  if(verifyPin(pin)){
    console.log("🔓 پنل با پین باز شد");
    return res.json({ ok: true, token: issueToken() });
  }
  console.log("❌ پین اشتباه وارد شد");
  res.status(401).json({ ok: false, error: "wrong" });
});

app.get("/api/auth/check", (req, res) => {
  if(tokenValid(req.headers["x-auth-token"])) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.post("/api/auth/change", (req, res) => {
  if(!tokenValid(req.headers["x-auth-token"])) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { currentPin, newPin } = req.body || {};
  if(!verifyPin(currentPin)) return res.status(401).json({ ok: false, error: "wrong" });
  if(!/^\d{4}$/.test(String(newPin || ""))) return res.status(400).json({ ok: false, error: "invalid" });
  setPin(String(newPin));
  console.log("🔑 پین پنل تغییر کرد");
  res.json({ ok: true });
});

app.post("/api/auth/remove", (req, res) => {
  if(!tokenValid(req.headers["x-auth-token"])) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { currentPin } = req.body || {};
  if(!verifyPin(currentPin)) return res.status(401).json({ ok: false, error: "wrong" });
  try{ fs.unlinkSync(PIN_FILE); }catch(e){}
  console.log("🔓 قفل پنل حذف شد");
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(data){
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function broadcastState(){
  broadcast({
    type: "state",
    state: connectionState, qr: currentQR, qrImage: currentQRImage, botNumber,
    groups: groupsCache, config: runtimeConfig,
    confirm: confirmPublic(),
    models: { text: TEXT_MODEL, vision: VISION_MODEL },
    keys: keyManager.power()
  });
}

/* ==================================================
   API ROUTES
   ================================================== */

app.get("/api/status", (req, res) => {
  res.json({
    state: connectionState, qr: currentQR, qrImage: currentQRImage, botNumber,
    groups: groupsCache, config: runtimeConfig,
    models: { text: TEXT_MODEL, vision: VISION_MODEL },
    keys: keyManager.power(),
    queue: { pending: processingQueue.length, busy: isProcessing }
  });
});

app.get("/api/keys", async (req, res) => {
  await keyManager.refreshStatus();
  res.json({ keys: keyManager.power() });
});
app.get("/api/receipts", (req, res) => res.json({ receipts: getReceiptsForPanel() }));

app.delete("/api/receipts/:id", (req, res) => {
  const idx = receipts.list.findIndex(r => r.id === req.params.id);
  if(idx < 0) return res.json({ ok: false, error: "not found" });
  receipts.list.splice(idx, 1);
  saveReceipts();
  broadcast({ type: "receipts", receipts: getReceiptsForPanel() });
  res.json({ ok: true });
});

app.delete("/api/receipts", (req, res) => {
  receipts = { list: [] };
  saveReceipts();
  broadcast({ type: "receipts", receipts: [] });
  res.json({ ok: true });
});

app.post("/api/select-group", (req, res) => {
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  const idx = runtimeConfig.targetGroups.findIndex(t => t.jid === jid);
  if(idx >= 0){
    runtimeConfig.targetGroups.splice(idx, 1);
    saveConfig(); broadcastState();
    return res.json({ ok: true, selected: false, count: runtimeConfig.targetGroups.length });
  }
  runtimeConfig.targetGroups.push({ jid, name: name || "" });
  saveConfig(); broadcastState();
  res.json({ ok: true, selected: true, count: runtimeConfig.targetGroups.length });
});

app.post("/api/clear-group", (req, res) => {
  runtimeConfig.targetGroups = [];
  saveConfig(); broadcastState();
  res.json({ ok: true });
});

/* ---------- واسطه تایید فیش ---------- */
app.get("/api/confirm", (req, res) => res.json(confirmPublic()));

app.post("/api/confirm/toggle", (req, res) => {
  confirmCfg.enabled = !!req.body.enabled;
  saveConfirm(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/owner", (req, res) => {
  const { jid, name } = req.body;
  if(!jid || !jid.endsWith("@s.whatsapp.net")) return res.json({ ok: false, error: "شماره معتبر نیست" });
  confirmCfg.ownerJid = jid;
  confirmCfg.ownerName = name || "";
  saveConfirm(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/owner-clear", (req, res) => {
  confirmCfg.ownerJid = null;
  confirmCfg.ownerName = "";
  saveConfirm(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/select-group", (req, res) => {
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  const idx = confirmCfg.sourceGroups.findIndex(g => g.jid === jid);
  if(idx >= 0) confirmCfg.sourceGroups.splice(idx, 1);
  else confirmCfg.sourceGroups.push({ jid, name: name || "" });
  saveConfirm(); broadcastState();
  res.json({ ok: true, selected: idx < 0, count: confirmCfg.sourceGroups.length });
});

app.post("/api/confirm/clear-groups", (req, res) => {
  confirmCfg.sourceGroups = [];
  saveConfirm(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/add-contact", (req, res) => {
  let num = String(req.body.number || "").replace(/\D/g, "");
  if(!num) return res.json({ ok: false, error: "شماره لازم است" });
  if(num.startsWith("00")) num = num.slice(2);
  if(num.startsWith("0")) num = num.slice(1);
  if(num.length <= 10) num = "90" + num; /* پیش‌فرض ترکیه اگر کد کشور داده نشد */
  const jid = num + "@s.whatsapp.net";
  confirmCfg.contacts[jid] = req.body.name || "";
  saveConfirm(); broadcastState();
  res.json({ ok: true, jid });
});

app.post("/api/allowed-numbers", (req, res) => {
  runtimeConfig.allowedNumbers = (req.body.numbers || []).filter(n => /^\d+$/.test(n));
  saveConfig(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/toggle", (req, res) => {
  runtimeConfig.enabled = !!req.body.enabled;
  saveConfig(); broadcastState();
  res.json({ ok: true });
});

app.post("/api/refresh-groups", async (req, res) => {
  try{ await fetchGroups(); res.json({ ok: true, groups: groupsCache }); }
  catch(e){ res.json({ ok: false, error: e.message }); }
});

app.post("/api/logout", async (req, res) => {
  try{
    if(sock){ try{ await sock.logout(); }catch{} sock = null; }
    if(fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionState = "disconnected";
    currentQR = null; currentQRImage = null; botJid = null; botNumber = null; groupsCache = [];
    broadcastState();
    res.json({ ok: true });
    setTimeout(connectToWhatsApp, 1500);
  }catch(e){ res.json({ ok: false, error: e.message }); }
});

/* ==================================================
   GROUPS
   ================================================== */

async function fetchGroups(){
  if(!sock || connectionState !== "connected") return [];
  const chats = await sock.groupFetchAllParticipating();
  const list = Object.keys(chats).map(jid => ({
    jid, name: chats[jid].subject,
    participants: chats[jid].participants?.length || 0
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  groupsCache = list;
}

/* ==================================================
   DETECT MODELS
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

async function sendReaction(msg, emoji){
  try{
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key }
    });
    return true;
  }catch(e){ return false; }
}

/* ==================================================
   IMAGE PROCESSING
   ================================================== */

let sharp = null;
try{
  sharp = require("sharp");
  console.log("✅ sharp بارگذاری شد");
}catch(e){
  console.warn("⚠️ sharp نصب نیست — فشرده‌سازی کار نمی‌کنه");
}

async function downloadImage(msg){
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

/* ==================================================
   PDF PROCESSING
   ================================================== */

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

async function downloadPdf(msg){
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
   EXTRACT RECEIPT INFO
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
  "isReceipt": true اگر فیش بانکی است، false اگر نیست,
  "bank": "نام بانک",
  "bankBranch": "نام یا کد شعبه اگر روی فیش هست",
  "amount": "مبلغ به عدد انگلیسی بدون کاما (مثال: 5000)",
  "currency": "TL یا USD یا EUR",
  "date": "تاریخ به فرمت DD/MM/YYYY",
  "time": "ساعت دقیق — HH:MM:SS اگر ثانیه روی فیش هست، وگرنه HH:MM",
  "trackingNo": "شماره پیگیری اصلی (مهم‌ترین فیلد)",
  "receiptNo": "شماره قواره فیش / شماره سند (اگر جدا از شماره پیگیری هست، وگرنه خالی)",
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
   MAIN HANDLER
   ================================================== */

async function handleReceipt(imageData, senderNumber, source = "image", msgKey = null){
  let info;
  try{
    info = await extractReceiptInfo(imageData.base64);
  }catch(e){
    console.error("extractReceiptInfo نهایی:", e.message);
    return { status: "error", message: source === "pdf" ? MSG_PDF_ERROR : MSG_ERROR };
  }

  if(info.isReceipt === false) return { status: "not_receipt", message: MSG_NOT_RECEIPT };

  const dup = findDuplicateByVision(info);

  if(dup){
    console.log("🔁 تکراری — لایه: " + dup.layer + " — " + (dup.score * 100).toFixed(1) + "%");
    return { status: "duplicate", score: dup.score, matched: dup.record, layer: dup.layer };
  }

  const id = "rc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const record = { id, data: info, sender: senderNumber, timestamp: Date.now(), source, msgKey: msgKey || null };
  receipts.list.push(record);
  saveReceipts();
  broadcast({ type: "receipts", receipts: getReceiptsForPanel() });
  console.log("✅ فیش جدید ذخیره شد:", id);
  return { status: "saved", id };
}

/* ==================================================
   QUOTED
   ================================================== */

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
   PROCESS TASK
   ================================================== */

async function processReceiptTask(msg, msgType, senderNumber){
  try{
    await sendReaction(msg, REACTION_PROCESSING);

    let imageData = null;
    let source = "image";

    if(msgType === "image"){
      imageData = await downloadImage(msg);
    }else if(msgType === "pdf"){
      source = "pdf";
      imageData = await downloadPdf(msg);
    }

    if(!imageData){
      await sendReaction(msg, REACTION_ERROR);
      await sock.sendMessage(msg.key.remoteJid, {
        text: msgType === "pdf" ? MSG_PDF_ERROR : MSG_ERROR
      }, { quoted: msg });
      return;
    }

    const result = await handleReceipt(imageData, senderNumber, source, msg.key);

    if(result.status === "duplicate"){
      await sendReaction(msg, REACTION_DUPLICATE);

      // ---- ریپلای ۱: به پیام فعلی ----
      await sock.sendMessage(msg.key.remoteJid, {
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

          await sock.sendMessage(msg.key.remoteJid, {
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
      // عکس فیش نبود — کاملاً بی‌صدا: نه ریپلای، نه ری‌اکشن (حتی ری‌اکشن در حال پردازش هم پاک می‌شود)
      try{ await sock.sendMessage(msg.key.remoteJid, { react: { text: "", key: msg.key } }); }catch{}
      console.log("🤫 عکس فیش نبود — نادیده گرفته شد (بی‌صدا)");
    }
    else if(result.status === "error"){
      await sendReaction(msg, REACTION_ERROR);
      await sock.sendMessage(msg.key.remoteJid, { text: result.message || MSG_ERROR }, { quoted: msg });
    }
    else if(result.status === "saved"){
      await sendReaction(msg, REACTION_NEW);
      console.log("📤 جدید 🆕");
    }
  }catch(err){
    console.error("❌ خطا processReceiptTask:", err.message);
    try{ await sendReaction(msg, REACTION_ERROR); }catch{}
  }
}

/* ==================================================
   CONFIRM FLOW — پردازش و فوروارد فیش به صاحب کارت
   ================================================== */

function groupNameOf(jid){
  const g = groupsCache.find(x => x.jid === jid);
  return g ? g.name : "";
}

async function processConfirmTask(msg, msgType){
  try{
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderNum = senderJid.split("@")[0].split(":")[0];
    const groupJid = msg.key.remoteJid;
    const gName = groupNameOf(groupJid) || groupJid;

    /* 🔍 در حال اسکن */
    try{ await sock.sendMessage(groupJid, { react: { text: CONFIRM_SCAN, key: msg.key } }); }catch{}

    let imageData = null;
    if(msgType === "image") imageData = await downloadImage(msg);
    else imageData = await downloadPdf(msg);

    if(!imageData){
      try{ await sock.sendMessage(groupJid, { react: { text: "", key: msg.key } }); }catch{}
      return;
    }

    let info = null;
    try{ info = await extractReceiptInfo(imageData.base64); }catch(e){ info = null; }

    if(!info || info.isReceipt === false){
      /* فیش نبود — بی‌صدا رها کن */
      try{ await sock.sendMessage(groupJid, { react: { text: "", key: msg.key } }); }catch{}
      console.log("🤫 تایید: فیش نبود — نادیده گرفته شد");
      return;
    }

    /* فوروارد فایل اصلی به صاحب کارت */
    const raw = await downloadMediaMessage(msg, "buffer", {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });

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
      sent = await sock.sendMessage(confirmCfg.ownerJid, {
        document: raw, mimetype: "application/pdf", fileName: "receipt.pdf",
        caption: lines.join("\n")
      });
    }else{
      const mt = msg.message?.imageMessage?.mimetype || "image/jpeg";
      sent = await sock.sendMessage(confirmCfg.ownerJid, {
        image: raw, mimetype: mt, caption: lines.join("\n")
      });
    }

    if(!sent || !sent.key || !sent.key.id){
      console.error("تایید: فوروارد ناموفق");
      try{ await sock.sendMessage(groupJid, { react: { text: "⚠️", key: msg.key } }); }catch{}
      return;
    }

    confirmCfg.queue[sent.key.id] = {
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
    trimConfirmQueue();
    saveConfirm();
    broadcastState();

    /* ⏫ در انتظار تأیید */
    await sock.sendMessage(groupJid, { react: { text: CONFIRM_WAIT, key: msg.key } });
    console.log("📤 تایید: فیش به صاحب کارت فوروارد شد | گروه:", gName);
  }catch(e){
    console.error("processConfirmTask:", e.message);
    try{ await sock.sendMessage(msg.key.remoteJid, { react: { text: "⚠️", key: msg.key } }); }catch{}
  }
}

/* ==================================================
   WHATSAPP
   ================================================== */

async function connectToWhatsApp(){
  connectionState = "connecting";
  broadcastState();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try{ ({ version } = await fetchLatestWaWebVersion()); }
  catch(e){ console.warn("⚠️ دریافت نسخه واتساپ ناموفق — از پیش‌فرض استفاده می‌شود"); }

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if(qr){
      currentQR = qr;
      connectionState = "qr";
      try{ currentQRImage = await QRCode.toDataURL(qr, { margin: 2, width: 320 }); }
      catch(e){ currentQRImage = null; }
      broadcastState();
      console.log("📱 QR جدید");
    }

    if(connection === "open"){
      connectionState = "connected";
      currentQR = null; currentQRImage = null;
      botJid = sock.user.id;
      botNumber = botJid.split(":")[0].split("@")[0];
      console.log("✅ متصل شد | شماره:", botNumber);

      try{ await detectModels(); }catch(e){ console.error("detectModels:", e.message); }
      try{ await fetchGroups(); console.log("📋", groupsCache.length, "گروه"); }catch(e){}
      broadcastState();
    }

    if(connection === "close"){
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      connectionState = "disconnected";
      broadcastState();
      console.log("❌ قطع. کد:", code);
      if(reconnect) setTimeout(connectToWhatsApp, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    /* توجه: ری‌اکشن‌ها گاهی با type=append می‌آیند — برای ری‌اکشن و کش مخاطبین هر دو نوع پردازش می‌شود */
    if(type !== "notify" && type !== "append") return;

    for(const msg of messages){
      try{
        const rJid = msg.key.remoteJid || "";

        /* کش مخاطبین — شامل jidهای @lid (واتساپ جدید) — برای انتخاب صاحب کارت در پنل */
        if((rJid.endsWith("@s.whatsapp.net") || rJid.endsWith("@lid")) && !msg.key.fromMe){
          const known = confirmCfg.contacts[rJid];
          if(!known || (msg.pushName && msg.pushName !== known)){
            confirmCfg.contacts[rJid] = msg.pushName || known || "";
            saveConfirm();
          }
        }

        /* ری‌اکشن روی فیش فورواردشده → انتقال به گروه
           (شناسایی فقط با id پیام ردیابی‌شده — چنین id فقط در چت صاحب کارت وجود دارد؛
           بررسی سخت‌گیرانه ownerJid حذف شد چون چت خصوصی ممکن است با jid typu @lid بیاید) */
        const rMsg = msg.message?.reactionMessage;
        if(rMsg && rMsg.text && !rJid.endsWith("@g.us") && !rJid.endsWith("@broadcast") && !msg.key.fromMe){
          const entry = confirmCfg.queue[rMsg.key?.id];
          if(entry){
            entry.answered = true;
            entry.answer = rMsg.text;
            entry.answeredBy = rJid;
            saveConfirm();
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
              console.log("✅ تایید: صاحب کارت ری‌اکشن زد", rMsg.text, "→ گروه:", entry.group);
            }catch(e){ console.error("انتقال ری‌اکشن:", e.message); }
            broadcastState();
          }else{
            console.log("🔎 تایید: ری‌اکشن خارج از صف از", rJid, "| هدف:", (rMsg.key?.id || "").slice(0, 14), "|", rMsg.text);
          }
        }

        /* از اینجا به بعد فقط پیام‌های جدید (notify) */
        if(type !== "notify") continue;

        /* جریان واسطه تایید فیش — مستقل از ربات اصلی */
        if(confirmCfg.enabled && confirmCfg.ownerJid && rJid.endsWith("@g.us") && !msg.key.fromMe){
          if(confirmCfg.sourceGroups.some(g => g.jid === rJid)){
            const cType = getMessageType(msg);
            if(cType === "image" || cType === "pdf"){
              const senderJidC = msg.key.participant || rJid;
              const senderNumC = senderJidC.split("@")[0].split(":")[0];
              console.log("📩 تایید: ورودی از", senderNumC, "| گروه:", groupNameOf(rJid) || rJid);
              enqueueTask(() => processConfirmTask(msg, cType));
            }
          }
        }

        if(!rJid.endsWith("@g.us")) continue;
        if(msg.key.fromMe) continue;
        if(!runtimeConfig.enabled) continue;
        if(runtimeConfig.targetGroups.length > 0 &&
           !runtimeConfig.targetGroups.some(t => t.jid === msg.key.remoteJid)) continue;

        const msgType = getMessageType(msg);
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const senderNumber = senderJid.split("@")[0].split(":")[0];

        if(runtimeConfig.allowedNumbers.length > 0 &&
           !runtimeConfig.allowedNumbers.includes(senderNumber)) continue;

        if(msgType !== "image" && msgType !== "pdf") continue;

        console.log("📥 ورودی از:", senderNumber, "| نوع:", msgType);
        enqueueTask(() => processReceiptTask(msg, msgType, senderNumber));

      }catch(err){
        console.error("❌ خطا:", err.message);
      }
    }
  });

  sock.ev.on("groups.update", async () => {
    try{ await fetchGroups(); broadcastState(); }catch{}
  });
  sock.ev.on("group-participants.update", async () => {
    try{ await fetchGroups(); broadcastState(); }catch{}
  });
}

/* ==================================================
   WS
   ================================================== */

wss.on("connection", (ws, req) => {
  try{
    const u = new URL(req.url, "http://localhost");
    if(!tokenValid(u.searchParams.get("token"))){
      ws.close(4001, "unauthorized");
      return;
    }
  }catch(e){ ws.close(); return; }
  ws.send(JSON.stringify({
    type: "state",
    state: connectionState, qr: currentQR, qrImage: currentQRImage, botNumber,
    groups: groupsCache, config: runtimeConfig,
    confirm: confirmPublic(),
    models: { text: TEXT_MODEL, vision: VISION_MODEL },
    keys: keyManager.power()
  }));
  ws.send(JSON.stringify({
    type: "receipts",
    receipts: getReceiptsForPanel()
  }));
});

setInterval(() => {
  broadcast({ type: "keys", keys: keyManager.power() });
}, 5000);

/* ==================================================
   START
   ================================================== */

keyManager.init();
loadConfig();
loadReceipts();
loadConfirm();

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
  console.log("🤖 دروازه هوش مصنوعی مرکزی فعال — قدرت:", keyManager.power().totalPower, "کردیت/دقیقه");
  console.log("💾 فیش‌های ذخیره‌شده:", receipts.list.length);
  console.log("🎯 تشخیص تکراری سخت‌گیرانه (Strict)");
  console.log("🔒 قفل پنل:", hasPin() ? "فعال" : "غیرفعال — اولین ورود پین می‌سازد");
  console.log(confirmCfg.enabled
    ? "🤝 واسطه تایید فیش: فعال — صاحب کارت: " + (confirmCfg.ownerJid || "انتخاب نشده")
    : "🤝 واسطه تایید فیش: غیرفعال");
  console.log("📅 فرمت تاریخ: 2026/09/15 10:14 PM");
  console.log("");
  startCloudTasks();
  restoreFromGithub().finally(() => {
    connectToWhatsApp().catch(e => {
      console.error("❌ خطای اتصال اولیه:", e.message);
      console.log("🔁 تلاش مجدد تا 10 ثانیه دیگر...");
      setTimeout(() => connectToWhatsApp().catch(()=>{}), 10000);
    });
  });
});