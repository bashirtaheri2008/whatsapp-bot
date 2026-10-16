/* ==================================================
   WhatsApp AI Bot — نسخه چندکاربره (Multi-Tenant) v9.8.9 (گروه تأیید کننده + عکس نمایه گروه‌ها) (ورود با نام کاربری/رمز)
   هر کاربر با گوگل وارد می‌شود → حساب جدا → شماره واتساپ خودش
   دیتای هر کاربر (فیش/تنظیمات/نشست) کاملاً ایزوله است
   ================================================== */

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  downloadContentFromMessage
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

/* ==================================================
   AI DIRECT — اتصال مستقیم به Groq (بدون گیت‌وی) v12
   چند کلید Groq که خود ربات می‌چرخاند؛ 429 → استراحت کلید و رفتن به بعدی
   ================================================== */

const GROQ_API_URL = "https://api.groq.com/openai/v1";

const _K_B64 = "Z3NrX2pVc3M1MDNjaWpnSlJRMWdHVjFpV0dkeWIzRllvakJacVlyZ0hpMkY3dm10WngzM0FoeW0sZ3NrX2I3STJ6TW1MTEp1M2JnM3h6bTlZV0dkeWIzRllmeGtQMWk5RlB4V0ZYUlduazBpeHVSSXQsZ3NrXzZ6UTZJTVduSlV1NUl1b1M0amVwV0dkeWIzRlkyQjlQSFFlUGxlOWdDNjdlb2duV3BFRncsZ3NrXzRBN2tiUDhjWHdwN0pubWN3aTZzV0dkeWIzRlk0VThkT0xSUUlmSkVBbVBlZFRhd3dRT1gsZ3NrXzFtQjFUeWVHYjNqeDRkV2RMUWMwV0dkeWIzRllFQnRpeGxlOTVDT053ako3Y0xOUk1XTDAsZ3NrXzFFODRsbnZhbXF0c2tVTUd0QzVWV0dkeWIzRlkzVE9DU3pkNzBMMHBPTGcyQ3FRMWU1Wm4sZ3NrX3ZIclUzNEptN1l1NVQ1eVo2NmlFV0dkeWIzRllhOU94SG41YUVlUFFqcWE5V2wxRDFyYnAsZ3NrX1JNeUFaTmtFMjFYSzdtUWhadTV4V0dkeWIzRllZTE12OThsaG1URTg4RVRDaVhUSzl4bTUsZ3NrX3pkOHVRenZ1Zzh4OXBGamVxRTc0V0dkeWIzRlkyQUNENnI1eXdmUjl6d01ZenFqbW52a08sZ3NrX3dkaUkwNDZQTUp3ZmhBcFV5YTgzV0dkeWIzRllCaE8zWjFzY1lFYUxQemNwaWs1RGd4ZDQsZ3NrX1RJUFNhbkU3YkFjQWpDTGR0MWR4V0dkeWIzRllwMTVBM0ZTM292cDNsVDgxT25QSHJXSXo=";

const GROQ_KEYS = (
  process.env.GROQ_KEYS ? process.env.GROQ_KEYS.split(",").map(k => k.trim()).filter(Boolean)
  : Buffer.from(_K_B64, "base64").toString("utf8").split(",").filter(Boolean)
);

const keyManager = {
  exhausted: new Array(GROQ_KEYS.length).fill(0),
  cursor: 0,
  cache: { totalKeys: GROQ_KEYS.length, active: GROQ_KEYS.length, cooling: 0 },
  rpmPerKey: 30,

  init(){
    console.log("🤖 حالت مستقیم Groq —", GROQ_KEYS.length, "کلید فعال (بدون گیت‌وی)");
    this.refreshStatus();
    setInterval(() => this.refreshStatus(), 30 * 1000);
  },

  async refreshStatus(){
    const now = Date.now();
    let active = 0, cooling = 0;
    for(const t of this.exhausted){ if(t > now) cooling++; else active++; }
    this.cache = { totalKeys: GROQ_KEYS.length, active, cooling };
  },

  getNext(){
    const now = Date.now();
    for(let i = 0; i < GROQ_KEYS.length; i++){
      const idx = (this.cursor + i) % GROQ_KEYS.length;
      if(this.exhausted[idx] <= now){
        this.cursor = (idx + 1) % GROQ_KEYS.length;
        return { key: GROQ_KEYS[idx], index: idx };
      }
    }
    return { key: GROQ_KEYS[0], index: 0 };
  },

  markExhausted(index, waitMs){
    this.exhausted[index] = Date.now() + waitMs;
    console.log("⏳ کلید " + (index + 1) + "/" + GROQ_KEYS.length + " → استراحت " + (waitMs / 1000).toFixed(1) + " ثانیه");
  },

  markHealthy(index){
    this.exhausted[index] = 0;
  },

  power(){
    const c = this.cache;
    return {
      totalKeys: c.totalKeys,
      active: c.active,
      cooling: c.cooling,
      rpmPerKey: this.rpmPerKey,
      totalPower: c.active * this.rpmPerKey,
      gateway: "direct-groq"
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
  "qwen/qwen3.8-27b"
];

const VISION_PRIORITY = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b"
];

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const MAX_PDF_SIZE = 10 * 1024 * 1024;
/* v10.0.0: موقتاً بالا — بعداً با پلن‌ها محدود می‌شود */
const MAX_CONCURRENT_BOTS = 20;

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
  let s = toEnglishDigits(String(str || "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if(s.length > 4){
    const cc = s.slice(0, 2);
    const rest = s.slice(2).replace(/O/g, "0").replace(/[IJL|]/g, "1").replace(/S/g, "5")
      .replace(/Z/g, "2").replace(/B/g, "8").replace(/E/g, "8").replace(/G/g, "6")
      .replace(/Q/g, "0").replace(/D/g, "0");
    s = cc + rest;
  }
  return s;
}

function normalizeCodeId(str){
  let s = toEnglishDigits(String(str || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
  return s.replace(/o/g, "0").replace(/[il|]/g, "1").replace(/s/g, "5")
          .replace(/z/g, "2").replace(/g/g, "6").replace(/q/g, "9").replace(/b/g, "8");
}


function trFold(s){
  return toEnglishDigits(String(s || "")).toLowerCase()
    .replace(/[ıİ]/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c");
}

function parseAmountSmart(raw){
  let s = toEnglishDigits(String(raw || "")).replace(/[^\d.,]/g, "").trim();
  if(!s) return "";
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  let intPart, decPart = "";
  if(lastDot >= 0 && lastComma >= 0){
    if(lastComma > lastDot){          /* 80.000,00 → نقطه هزارگان، ویرگول اعشار */
      intPart = s.slice(0, lastComma).replace(/\./g, "");
      decPart = s.slice(lastComma + 1);
    }else{                            /* 5,000.00 → ویرگول هزارگان، نقطه اعشار */
      intPart = s.slice(0, lastDot).replace(/,/g, "");
      decPart = s.slice(lastDot + 1);
    }
  }else if(lastDot >= 0){
    const tail = s.slice(lastDot + 1);
    if(tail.length === 3){            /* 80.000 → هزارگان ترکی */
      intPart = s.replace(/\./g, "");
    }else{                            /* 4991.00 → اعشار */
      intPart = s.slice(0, lastDot);
      decPart = tail;
    }
  }else if(lastComma >= 0){
    const tail = s.slice(lastComma + 1);
    if(tail.length === 1 || tail.length === 2){   /* 4991,5 یا 4991,00 → اعشار */
      intPart = s.slice(0, lastComma).replace(/\./g, "");
      decPart = tail;
    }else{                            /* 5,000 یا 80,000 → هزارگان */
      intPart = s.replace(/,/g, "");
    }
  }else{
    intPart = s;
  }
  intPart = String(intPart || "").replace(/^[0]+(?=\d)/, "");
  if(!intPart) intPart = "0";
  if(decPart) decPart = (decPart + "00").slice(0, 2);
  if(decPart && decPart !== "00") return intPart + "." + decPart;
  return intPart;
}

/* v11: فرمت ترکی (80.000,00) و انگلیسی (5,000.00) هر دو درست تجزیه می‌شوند —
   باگ قدیمی که «80.000,00» را به «80.00000» تبدیل می‌کرد رفع شد */
function normalizeAmount(str){
  return parseAmountSmart(str);
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

function extractIbans(text){
  const out = [];
  const t = String(text || "").replace(/\s+/g, " ");
  const re = /TR[0-9A-Za-z]{1,2}(?: ?[0-9]{4}){4,6} ?[0-9]{2,4}|TR[0-9A-Za-z]{1,2}[0-9A-Za-z ]{16,40}/g;
  const seen = new Set();
  let m;
  while((m = re.exec(t))){
    const ib = normalizeIban(m[0]);
    const digits = (ib.slice(2).match(/\d/g) || []).length;
    if(ib.length === 26 && digits >= 20 && !seen.has(ib)){ seen.add(ib); out.push(ib); }
  }
  return out;
}

function segAfterLabel(raw, T, labelRegex, span){
  const m = T.match(labelRegex);
  if(!m) return "";
  const start = (m.index || 0) + m[0].length;
  return raw.substring(start, span ? Math.min(raw.length, start + span) : raw.length);
}

function cleanName(s){
  return String(s || "").replace(/[^A-Za-z\u0600-\u06FF. ]/g, " ").replace(/\s+/g, " ").trim();
}

function parseBankReceipt(ocrText){
  const raw = String(ocrText || "");
  const T = trFold(raw); /* بدون collapse — اندیس‌ها با raw یکی‌اند */
  const info = {
    isReceipt: null, bank: "", bankBranch: "", amount: "", currency: "TL",
    date: "", time: "", trackingNo: "", receiptNo: "", referenceCode: "",
    senderName: "", senderIban: "", receiverName: "", receiverIban: "", description: ""
  };
  let bankKey = "";

  if(/enpara/.test(T)) bankKey = "enpara";
  else if(/akbank/.test(T)) bankKey = "akbank";
  else if(/ziraat/.test(T)) bankKey = "ziraat";
  else return { bankKey: "", info, quality: 0 };

  info.bank = bankKey === "enpara" ? "Enpara Bank A.S." :
              bankKey === "akbank" ? "Akbank" : "T.C. Ziraat Bankasi";

  try{
    if(bankKey === "enpara"){
      /* SORGU NO — طولانی‌ترین occurrence (در جدول کوتاه خوانده می‌شود) */
      let bestSorgu = "";
      for(const m of T.matchAll(/sorgu\s*no\s*:?\s*(\d{6,})/g)){
        if(m[1].length > bestSorgu.length) bestSorgu = m[1];
      }
      info.trackingNo = bestSorgu;
      const mSira = T.match(/s[ıi]ra\s*no\s*:?\s*([\d\-]{8,})/);
      if(mSira) info.receiptNo = mSira[1];
      const mFis = T.match(/f[ıi][şsg]{0,2}n?\s*o\s*:?\s*(\d{10,})/);
      if(mFis) info.referenceCode = mFis[1];
      /* مبلغ: بزرگ‌ترین Tutar معتبر */
      let amt = "";
      for(const m of T.matchAll(/tutar[ıi]?\s*:?\s*([\d.,]{3,})/g)){
        const v = parseAmountSmart(m[1]);
        if(v && parseFloat(v) > 0 && (!amt || parseFloat(v) > parseFloat(amt))) amt = v;
      }
      info.amount = amt;
      const mDT = T.match(/islem tarihi ve saati\s*:?\s*(\d{2})[.\/](\d{2})[.\/](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if(mDT){
        info.date = mDT[1] + "/" + mDT[2] + "/" + mDT[3];
        info.time = mDT[4].padStart(2, "0") + ":" + mDT[5] + (mDT[6] ? ":" + mDT[6] : "");
      }
      /* فرستنده: MUSTERI UNVANI ... IBAN */
      const segSender = segAfterLabel(raw, T, /musteri unvani\s*:?\s*/, 120);
      const mSender = segSender.match(/^([^:]*?)\s*IBAN\s*:?\s*(TR[\dA-Za-z ]{16,40})/i);
      if(mSender){
        info.senderName = cleanName(mSender[1]).toUpperCase();
        info.senderIban = mSender[2];
      }
      const segRecv = segAfterLabel(raw, T, /al[ıi]c[ıi] unvan[ıi]?\s*:?\s*/, 120);
      const mRecvName = segRecv.match(/^([^:]*?)\s*AL[İI]C[İI]\s+IBAN/i);
      if(mRecvName) info.receiverName = cleanName(mRecvName[1]).toUpperCase();
      const segRecvIban = segAfterLabel(raw, T, /al[ıi]c[ıi] iban\s*:?\s*/, 60);
      const mRecvIban = segRecvIban.match(/TR[\dA-Za-z ]{16,40}/i);
      if(mRecvIban) info.receiverIban = mRecvIban[0];
    }

    if(bankKey === "akbank"){
      /* تاریخ + ساعت: 16.09.2026 182756 */
      const mDT = T.match(/(\d{2})[.\/](\d{2})[.\/](\d{4})\s+(\d{2})(\d{2})(\d{2})\b/);
      if(mDT){
        info.date = mDT[1] + "/" + mDT[2] + "/" + mDT[3];
        info.time = mDT[4] + ":" + mDT[5] + ":" + mDT[6];
      }
      /* مبلغ: سطر به سطر — سطرهای TOPLAM/KOMISYON/BSMV/MEVDUAT حذف؛ در غیر این صورت TOPLAM پشتیبان */
      let amt = "", amtToplam = "";
      for(const line of raw.split(/\r?\n/)){
        const L = line.toLowerCase();
        const isExcluded = /toplam|komisyon|bsmv|mevduat/.test(L);
        const re = /([\d.,]{4,})\s*TL/gi;
        let m;
        while((m = re.exec(line))){
          const v = parseAmountSmart(m[1]);
          if(!v || parseFloat(v) <= 0) continue;
          if(isExcluded){ if(/toplam/.test(L)) amtToplam = v; }
          else if(!amt || parseFloat(v) > parseFloat(amt)) amt = v;
        }
      }
      info.amount = amt || amtToplam;
      /* فرستنده/گیرنده: سطر دو ستونه با | و برچسب Unvan */
      for(const line of raw.split(/\r?\n/)){
        if(/unvan/i.test(line) && line.includes("|")){
          const parts = line.split("|");
          const nm = p => {
            let s = p;
            if(s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1); /* ستون با دونقطه */
            else s = s.split(/\s+/).filter(w => !/^(ad|adh|adi|adsoyad|soyad|soyadi|soyadit|soyadiunvan|soyadituinvan|unvan|uinvan|invan|unvani|soyaditunvan)/i.test(w)).join(" ");
            return cleanName(s).toUpperCase();
          };
          if(parts[0]) info.senderName = nm(parts[0]);
          if(parts[1]) info.receiverName = nm(parts[1]);
        }
      }
      /* دقیق‌تر: سطر İşlem Yapan Ad-Soyad برای فرستنده */
      for(const line of raw.split(/\r?\n/)){
        if(/yapan ad[- ]?soyad/i.test(line)){
          const m = line.match(/soyad[ıi]?\s*:?\s*(.+)$/i);
          if(m) info.senderName = cleanName(m[1]).toUpperCase();
        }
      }
      /* گیرنده: ALACAKLI HESAP NO TR... */
      const segRecv = segAfterLabel(raw, T, /alacakl\w*\s+hesap no\s*:?\s*/, 60);
      const mRecv = segRecv.match(/TR[\dA-Za-z ]{16,40}/i);
      if(mRecv) info.receiverIban = mRecv[0];
    }

    if(bankKey === "ziraat"){
      /* ISLEM TARIHI 16/09/2026-14:30:19 - F04104 */
      /* جداکننده تاریخ ممکن است در OCR حذف شود: 160972026 یا 16/0972026 — هر دو پذیرفته می‌شوند */
      const mDT = T.match(/islem tarihi\s*[:\s]*(\d{2})[.\/]?(\d{2,3})[.\/]?(\d{4})-(\d{2}):(\d{2}):(\d{2})\s*-?\s*([a-z0-9]+)?/)
                 || T.match(/(\d{2})[.\/]?(\d{2,3})[.\/]?(\d{4})-(\d{2}):(\d{2}):(\d{2})/);
      if(mDT){
        let month = mDT[2];
        if(month.length === 3) month = month.slice(0, 2); /* خطای OCR: 097 → 09 */
        info.date = mDT[1] + "/" + month + "/" + mDT[3];
        info.time = mDT[4] + ":" + mDT[5] + ":" + mDT[6];
        if(mDT[7]) info.referenceCode = mDT[7].toUpperCase();
      }
      /* مبلغ: Havale Tutari */
      const mAmt = T.match(/havale tutar[ıi]\s*:?\s*([\d.,]{3,})/);
      if(mAmt) info.amount = parseAmountSmart(mAmt[1]);
      /* فرستنده: اولین IBAN + SAYIN نام */
      const ibans = extractIbans(raw);
      if(ibans.length) info.senderIban = ibans[0];
      /* نام فرستنده بعد از IBAN در همان سطر */
      const mSenderName = T.match(/tr[0-9a-z][0-9a-z]?(?: ?[0-9]{4}){4,6}(?: ?[0-9]{2,4})?\s+([a-z.]{2,}(?: [a-z.]{2,}){1,5})/);
      if(mSenderName) info.senderName = cleanName(mSenderName[1]).toUpperCase();
      /* گیرنده: Alacakli IBAN / Adi Soyadi */
      const segRecvIban = segAfterLabel(raw, T, /alacakl[ıi] iban\s*:?\s*/, 60);
      const mRecvIban = segRecvIban.match(/TR[\dA-Za-z ]{16,40}/i);
      if(mRecvIban) info.receiverIban = mRecvIban[0];
      const mRecvName = T.match(/alacakl[ıi] adi soyadi\s*:?\s*([a-z. ]{3,40})/);
      if(mRecvName) info.receiverName = cleanName(mRecvName[1]).toUpperCase();
      /* شعبه */
      const mSube = T.match(/sube kodu\/adi\s*([\d\/a-z]+)/);
      if(mSube) info.bankBranch = mSube[1];
    }
  }catch(e){
    console.error("parseBankReceipt:", e.message);
    return { bankKey, info, quality: 0 };
  }

  /* کیفیت استخراج */
  let q = 0;
  if(info.amount) q += 0.25;
  if(info.date) q += 0.15;
  if(info.time) q += 0.1;
  if(info.receiverIban) q += 0.1;
  const idOk = (bankKey === "enpara" && info.trackingNo) ||
               ((bankKey === "akbank" || bankKey === "ziraat") && info.time && info.time.split(":").length === 3);
  if(idOk) q += 0.2;
  return { bankKey, info, quality: q };
}

function buildFingerprint(info, bankKey){
  const a = normalizeAmount(info.amount);
  const d = normalizeDate(info.date);
  const t = normalizeTime(info.time);
  if(!a || !d) return "";
  if(bankKey === "enpara"){
    const s = normalizeCodeId(info.trackingNo);
    if(s) return "EP|" + s;
  }
  if(bankKey === "akbank" || bankKey === "ziraat"){
    const r = normalizeIban(info.receiverIban);
    if(t) return (bankKey === "akbank" ? "AK|" : "ZB|") + d + "|" + t + "|" + a + (r ? "|" + r : "");
  }
  const r = normalizeIban(info.receiverIban);
  return "GN|" + d + (t ? "|" + t : "") + "|" + a + (r ? "|" + r : "");
}

/* ── گارد آگاه به خطای OCR ── */
function checkGuardDiffers(a, b){
  const aa = normalizeAmount(a.amount), bb = normalizeAmount(b.amount);
  if(aa && bb){
    const na = parseFloat(aa), nb = parseFloat(bb);
    if(isNaN(na) || isNaN(nb)){ if(aa !== bb) return { differs: true, label: "مبلغ" }; }
    else if(Math.abs(na - nb) > 0.011) return { differs: true, label: "مبلغ" };
  }
  const da = normalizeDate(a.date), db = normalizeDate(b.date);
  if(da && db && da !== db) return { differs: true, label: "تاریخ" };
  for(const k of ["senderIban", "receiverIban"]){
    const ia = normalizeIban(a[k]), ib = normalizeIban(b[k]);
    if(ia && ib && ia !== ib && similarity(ia, ib) < 0.95)
      return { differs: true, label: k === "senderIban" ? "IBAN فرستنده" : "IBAN گیرنده" };
  }
  for(const k of ["trackingNo", "receiptNo", "referenceCode"]){
    const ca = normalizeCodeId(a[k]), cb = normalizeCodeId(b[k]);
    if(ca && cb && ca !== cb && similarity(ca, cb) < 0.85)
      return { differs: true, label: "کد یکتا" };
  }
  const ta = normalizeTime(a.time), tb = normalizeTime(b.time);
  if(ta && tb && !timeExactMatch(ta, tb)) return { differs: true, label: "ساعت" };
  return { differs: false, label: "" };
}

/* ==================================================
   FIND DUPLICATE v11 — اثر انگشت بانکی + گارد OCR-aware + کد یکتا نرمال‌شده
   ================================================== */

function findDuplicateByVision(list, newInfo){
  if(!list || !list.length) return null;
  const nFp = newInfo.fingerprint || buildFingerprint(newInfo, newInfo.bankKey || "");

  for(const existing of list){
    const rd = existing.data || {};

    /* لایه صفر: اثر انگشت بانکی */
    const eFp = rd.fingerprint || buildFingerprint(rd, rd.bankKey || "");
    if(nFp && eFp && nFp === eFp){
      return { score: 1.0, layer: "fingerprint", record: existing,
        details: [{ key: "fingerprint", label: "اثر انگشت بانکی", status: "exact", match: true, a: eFp, b: nFp }] };
    }

    /* گارد */
    const guard = checkGuardDiffers(newInfo, rd);
    if(guard.differs) continue;

    /* لایه کد یکتا (با نرمال‌سازی خطای OCR) */
    const idChecks = [
      { key: "trackingNo",    label: "شماره پیگیری",    min: 5 },
      { key: "receiptNo",     label: "شماره قواره فیش", min: 5 },
      { key: "referenceCode", label: "کد مرجع",         min: 5 },
    ];
    for(const c of idChecks){
      const nv = normalizeCodeId(newInfo[c.key]);
      const ov = normalizeCodeId(rd[c.key]);
      if(nv && nv.length >= c.min && nv === ov){
        return { score: 1.0, layer: c.key, record: existing,
          details: [{ key: c.key, label: c.label, status: "exact", match: true, a: rd[c.key], b: newInfo[c.key] }] };
      }
    }

    /* لایه ترکیب کامل */
    const nS = normalizeIban(newInfo.senderIban), oS = normalizeIban(rd.senderIban);
    const nA = normalizeAmount(newInfo.amount),  oA = normalizeAmount(rd.amount);
    const nR = normalizeIban(newInfo.receiverIban), oR = normalizeIban(rd.receiverIban);
    const nD = normalizeDate(newInfo.date), oD = normalizeDate(rd.date);
    const amountEq = (x, y) => {
      const px = parseFloat(x), py = parseFloat(y);
      if(isNaN(px) || isNaN(py)) return x === y;
      return Math.abs(px - py) <= 0.011;
    };
    if(nS && oS && nA && oA && nR && oR && nD && oD &&
       nS === oS && amountEq(nA, oA) && nR === oR && nD === oD){
      return { score: 0.99, layer: "Strict-Full-Match", record: existing,
        details: [
          { key: "senderIban", label: "IBAN فرستنده", status: "exact", match: true, a: rd.senderIban, b: newInfo.senderIban },
          { key: "amount", label: "مبلغ", status: "exact", match: true, a: rd.amount, b: newInfo.amount },
          { key: "receiverIban", label: "IBAN گیرنده", status: "exact", match: true, a: rd.receiverIban, b: newInfo.receiverIban },
          { key: "date", label: "تاریخ", status: "exact", match: true, a: rd.date, b: newInfo.date }
        ] };
    }
  }
  return null;
}

/* ==================================================
   VERIFY DUPLICATE — راستی‌آزمایی دومرحله‌ای پیش از اعلام قطعی
   قانون: تکراری فقط وقتی اعلام می‌شود که دو خواندن مستقل همنظر باشند.
   ================================================== */

function readableCode(v){
  if(!v) return null;
  const n = normalizeCodeId(v);
  return n && n.length >= 5 ? n : null;
}

function verifyDuplicateDecision(info, info2, record, layer){
  const rd = (record && record.data) || {};
  if(!info2 || info2.isReceipt === false)
    return { confirmed: false, reason: "خواندن دوم ناموفق" };

  /* لایه اثر انگشت */
  if(layer === "fingerprint"){
    const f1 = info.fingerprint || buildFingerprint(info, info.bankKey || "");
    const f2 = info2.fingerprint || buildFingerprint(info2, info2.bankKey || "");
    const f0 = rd.fingerprint || buildFingerprint(rd, rd.bankKey || "");
    if(f1 && f1 === f2 && f1 === f0)
      return { confirmed: true, reason: "اثر انگشت بانکی در دو خواندن مستقل تأیید شد" };
    return { confirmed: false, reason: "اثر انگشت در خواندن دوم تأیید نشد" };
  }

  /* ثبات خوانش */
  if(normalizeAmount(info.amount) && normalizeAmount(info2.amount) &&
     normalizeAmount(info.amount) !== normalizeAmount(info2.amount))
    return { confirmed: false, reason: "مبلغ در دو خواندن متفاوت خوانده شد" };
  if(normalizeIban(info.senderIban) && normalizeIban(info2.senderIban) &&
     normalizeIban(info.senderIban) !== normalizeIban(info2.senderIban))
    return { confirmed: false, reason: "IBAN فرستنده در دو خواندن متفاوت خوانده شد" };

  const UNIQUE_KEYS = ["trackingNo", "receiptNo", "referenceCode"];
  if(UNIQUE_KEYS.includes(layer)){
    const v1 = normalizeCodeId(info[layer]);
    const v2 = normalizeCodeId(info2[layer]);
    const v0 = normalizeCodeId(rd[layer]);
    if(v1 && v2 && v1 === v2 && v1 === v0)
      return { confirmed: true, reason: "کد یکتا (" + layer + ") در دو خواندن مستقل تأیید شد" };
    return { confirmed: false, reason: "خواندن دوم کد یکتا را تأیید نکرد" };
  }

  if(layer === "Strict-Full-Match"){
    for(const k of UNIQUE_KEYS){
      if(readableCode(info[k]) || readableCode(info2[k]))
        return { confirmed: false, reason: "شماره یکتا در خوانش‌ها حاضر است — لایه ترکیب قابل اتکا نیست" };
    }
    const hasSeconds = t => t && t.split(":").length === 3;
    const t1 = normalizeTime(info.time);
    const t2 = normalizeTime(info2.time);
    const t0 = normalizeTime(rd.time);
    if(hasSeconds(t1) && hasSeconds(t2) && hasSeconds(t0) && t1 === t2 && t1 === t0)
      return { confirmed: true, reason: "ترکیب کامل + ساعت با ثانیه در دو خواندن تأیید شد" };
    return { confirmed: false, reason: "ساعت با ثانیه در هر سه خوانش تأیید نشد" };
  }

  return { confirmed: false, reason: "لایه ناشناخته" };
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
    const res = await fetch(GROQ_API_URL + "/models", {
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
            .sharpen({ sigma: 1.2 })
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
            .sharpen({ sigma: 1.2 })
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
   OCR ENGINE (tesseract.js) — لایه اول دقت v11
   OCR متن فیش را استخراج می‌کند → parser مخصوص بانک
   فیلدها را دقیق و قطعی بیرون می‌کشد؛ vision فقط fallback
   و تکمیل‌کننده است. تشخیص تکراری با «اثر انگشت بانکی».
   ================================================== */

let _ocrWorker = null;
let _ocrBroken = false;
let _ocrInitPromise = null;

async function getOcrWorker(){
  if(_ocrBroken) return null;
  if(_ocrWorker) return _ocrWorker;
  if(_ocrInitPromise) return _ocrInitPromise;
  _ocrInitPromise = (async () => {
    try{
      const Tesseract = require("tesseract.js");
      const w = await Tesseract.createWorker("eng", 1, { logger: () => {} });
      _ocrWorker = w;
      console.log("📖 موتور OCR فعال شد (tesseract.js/eng)");
      return w;
    }catch(e){
      _ocrBroken = true;
      console.warn("⚠️ OCR فعال نشد — ادامه فقط با vision:", e.message);
      return null;
    }finally{
      _ocrInitPromise = null;
    }
  })();
  return _ocrInitPromise;
}

async function preprocessForOcr(buffer){
  if(!sharp || !buffer) return buffer;
  try{
    return await sharp(buffer)
      .resize(1800, 1800, { fit: "inside", withoutEnlargement: true })
      .grayscale()
      .normalise()
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();
  }catch(e){ return buffer; }
}

async function runOcr(buffer){
  const w = await getOcrWorker();
  if(!w) return { text: "", confidence: 0 };
  try{
    const { data } = await w.recognize(await preprocessForOcr(buffer));
    return {
      text: (data && data.text) || "",
      confidence: (data && typeof data.confidence === "number") ? data.confidence : 0
    };
  }catch(e){
    console.error("OCR recognize:", e.message);
    try{ await w.terminate(); }catch(_){}
    _ocrWorker = null;
    return { text: "", confidence: 0 };
  }
}

/* ==================================================
   EXTRACT RECEIPT INFO — خط دومعی OCR-first v11
   ۱) OCR → ۲) parser مخصوص بانک (قطعی، رایگان) →
   ۳) در صورت ناکافی بودن: vision با راهنمای متن OCR → مرج
   خروجی همان JSON قبلی + bankKey + fingerprint + ocrConfidence
   ================================================== */

async function extractReceiptInfo(imageInput){
  /* ورودی: رشته base64 (سازگاری قدیمی) یا { buffer, base64 } */
  const imageData = typeof imageInput === "string"
    ? { base64: imageInput, buffer: null }
    : (imageInput || {});

  /* ── ۱) OCR ── */
  let ocr = { text: "", confidence: 0 };
  if(imageData.buffer){
    try{ ocr = await runOcr(imageData.buffer); }
    catch(e){ console.error("OCR:", e.message); }
  }

  /* ── ۲) parser مخصوص بانک ── */
  const parsed = parseBankReceipt(ocr.text);
  let info = null;

  if(parsed.quality >= 0.8){
    info = Object.assign({}, parsed.info, { isReceipt: true });
    console.log("🏦 " + parsed.bankKey + " — پارس کامل با OCR (بدون AI) | conf:", Math.round(ocr.confidence));
  }else{
    /* ── ۳) vision fallback با grounding متن OCR ── */
    const vinfo = await extractWithVision(imageData.base64, ocr.text, parsed.bankKey);
    if(parsed.quality > 0.2 && vinfo && vinfo.isReceipt !== false){
      info = mergeParsedWithVision(parsed, vinfo);
      console.log("🤝 مرج OCR+vision | bank:", parsed.bankKey || "?", "| quality:", parsed.quality.toFixed(2));
    }else{
      info = vinfo;
    }
  }

  if(!info) throw new Error("استخراج ناموفق");

  info.bankKey = info.bankKey || parsed.bankKey || "";
  info.ocrConfidence = Math.round(ocr.confidence);
  info.fingerprint = buildFingerprint(info, info.bankKey);
  return info;
}

function extractBankNote(bankKey){
  if(bankKey === "enpara")
    return "این فیش Enpara است: SORGU NO همان شماره پیگیری (trackingNo) مهم است؛ مبلغ اصلی همان Tutar است.";
  if(bankKey === "akbank")
    return "این فیش Akbank است: مبلغ حواله (نه TOPLAM) را در amount بگذار؛ IBAN مقابل ALACAKLI HESAP NO مال گیرنده است؛ تاریخ و ساعت دقیق با ثانیه از İşlem Tarihi/Saati خوانده شود.";
  if(bankKey === "ziraat")
    return "این فیش Ziraat است: IBAN بالای رسید (زیر SAYIN) مال فرستنده است و Alacakli IBAN مال گیرنده؛ مبلغ اصلی Havale Tutari است نه ردیف Hesabinizdan؛ ساعت دقیق با ثانیه از ISLEM TARIHI خوانده شود.";
  return "";
}

function mergeParsedWithVision(parsed, vinfo){
  const out = Object.assign({}, vinfo);
  const P = parsed.info;
  /* فیلدهای پایدارِ parser برنده‌اند؛ vision فقط جاهای خالی را پر می‌کند */
  for(const k of ["bank","trackingNo","receiptNo","referenceCode","date","time",
                  "amount","currency","senderIban","receiverIban","senderName","receiverName","bankBranch"]){
    if(P[k] && String(P[k]).trim()) out[k] = P[k];
  }
  return out;
}

async function extractWithVision(imageDataBase64, ocrText, bankKey){
  let prompt = `تو یک کارشناس خبره استخراج اطلاعات از فیش‌های بانکی هستی. این تصویر را با بیشترین دقت و ذره‌ذره بررسی کن.

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
11. مبلغ را به فرمت عددی ساده بدون جداکننده هزارگان بنویس (مثال: 5000 یا 4991.00)

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

  if(ocrText && ocrText.trim().length > 40){
    prompt += `

🔍 متن OCR استخراج‌شده از همین تصویر (ممکن است خطای کاراکتر داشته باشد — آن را با آنچه می‌بینی تطبیق بده؛ هرجا متن با تصویر هم‌خوان بود به آن اعتماد کن):
<<<
${ocrText.trim()}
>>>`;
  }

  const bankNote = extractBankNote(bankKey);
  if(bankNote) prompt += "\n\n🏦 راهنمای این بانک: " + bankNote;

  const MAX_ATTEMPTS = 6; // گیت‌وی خودش کلیدها را می‌چرخاند

  for(let attempt = 0; attempt < MAX_ATTEMPTS; attempt++){
    const { key, index } = keyManager.getNext();

    try{
      console.log("🔑 تلاش " + (attempt + 1) + "/" + MAX_ATTEMPTS + " — دروازه مرکزی");
      const res = await fetch(GROQ_API_URL + "/chat/completions", {
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
              { type: "image_url", image_url: { url: imageDataBase64 } }
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
      console.log("📄 اطلاعات استخراج‌شده (vision):");
      console.log("   مبلغ:", info.amount, info.currency);
      console.log("   تاریخ:", info.date, info.time);
      console.log("   Tracking:", info.trackingNo);
      console.log("   Reference:", info.referenceCode);
      console.log("   IBAN فرستنده:", info.senderIban);
      console.log("   IBAN گیرنده:", info.receiverIban);
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

/* v9.9.3: چندتوکنی — GITHUB_TOKEN می‌تواند چند توکن با کاما جدا کند.
   با تمام‌شدن سهمیه یا بی‌اعتبار شدن هر توکن، خودکار به توکن بعدی می‌چرخد. */
const GH_TOKENS = (process.env.GITHUB_TOKEN || "").split(",").map(t => t.trim()).filter(Boolean);
const GH_REPO = process.env.GITHUB_REPO || "";
const GH_BASE = process.env.GH_BASE || "https://api.github.com";

function cloudEnabled(){
  return !!(GH_TOKENS.length && GH_REPO);
}

let ghTokenIdx = 0;
function ghCurToken(){ return GH_TOKENS[ghTokenIdx] || ""; }
function ghNextToken(){
  if(GH_TOKENS.length > 1) ghTokenIdx = (ghTokenIdx + 1) % GH_TOKENS.length;
  return ghCurToken();
}

let ghPausedUntil = 0; /* تا این زمان بکاپ‌ها متوقف می‌مانند (لی‌میت) */

function ghRateLimited(){
  return Date.now() < ghPausedUntil;
}

/* v9.9.2/v9.8.6: محافظ دیتا — اگر بوت با سهمیه‌ی گیت‌هابِ تموم‌شده بالا بیاید و
   بازیابی شکست بخورد، هیچ پوشی انجام نمی‌شود تا دیتای خالی جای بکاپ واقعی را نگیرد.
   با برگشتن سهمیه، خودکار رفع و بازیابی دوباره انجام می‌شود. */
let cloudBlocked = false;
async function ghQuotaOK(){
  /* بررسی سهمیه رایگان است — همه توکن‌ها چک می‌شوند و بهترین انتخاب می‌شود */
  for(let i = 0; i < GH_TOKENS.length; i++){
    try{
      const r = await fetch(GH_BASE + "/rate_limit", { headers: { Authorization: "token " + ghCurToken(), Accept: "application/vnd.github+json", "User-Agent": "wa-bot-multiuser" } });
      const d = await r.json();
      const rem = d.resources && d.resources.core && d.resources.core.remaining;
      if(r.ok && typeof rem === "number" && rem > 100) return true;
      ghNextToken();
    }catch(e){ return true; } /* اگر بررسی ممکن نشد، پوش آزاد می‌ماند */
  }
  return false;
}

const GH_FAKE_RES = { ok: false, status: 0, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };

async function ghApi(method, urlPath, body){
  for(let attempt = 0; attempt < Math.max(GH_TOKENS.length, 1); attempt++){
    try{
      const headers = {
        "Authorization": "token " + ghCurToken(),
        "Accept": "application/vnd.github+json",
        "User-Agent": "wa-bot-multiuser"
      };
      const opts = { method, headers };
      if(body) opts.body = JSON.stringify(body);
      const r = await fetch(GH_BASE + urlPath, opts);
      if((r.status === 401 || r.status === 403 || r.status === 429) && GH_TOKENS.length > 1){
        ghNextToken(); /* این توکن تمام شد — توکن بعدی */
        continue;
      }
      if(r.status === 403 || r.status === 429){
        /* لی‌میت خورد — ۱۵ دقیقه بکاپ بخواب */
        ghPausedUntil = Date.now() + 15 * 60 * 1000;
        console.warn("⏸️ لی‌میت گیت‌هاب — بکاپ‌ها تا ۱۵ دقیقه متوقف شد");
      }
      return r;
    }catch(e){
      return GH_FAKE_RES;
    }
  }
  return GH_FAKE_RES;
}

/* ==== v9.9.3: بکاپ فله با Git Tree API — کل تغییرات یک کاربر با ۳-۵ درخواست ==== */
let ghDefaultBranch = null;
async function ghBranch(){
  if(ghDefaultBranch) return ghDefaultBranch;
  try{
    const r = await ghApi("GET", "/repos/" + GH_REPO);
    if(r.ok) ghDefaultBranch = (await r.json()).default_branch || "main";
  }catch(e){}
  return ghDefaultBranch || "main";
}

function ghIsBinary(file){
  try{ return fs.readFileSync(file).includes(0); }catch(e){ return false; }
}
function ghRemoteKey(remotePath, localFile){
  return remotePath + (ghIsBinary(localFile) ? ".b64" : "");
}

async function ghCommitPairs(pairs, message){
  /* کل فایل‌های تغییرکرده را با Git Tree API در چند درخواست کامیت می‌کند.
     فایل‌های باینری با پسوند .b64 و کدگذاری base64 ذخیره می‌شوند. */
  if(!pairs || !pairs.length) return 0;
  const branch = await ghBranch();
  const ref = await ghApi("GET", "/repos/" + GH_REPO + "/git/ref/heads/" + branch);
  let parentSha = null, baseTree = null;
  if(ref.ok){
    parentSha = (await ref.json()).object.sha;
    const c = await ghApi("GET", "/repos/" + GH_REPO + "/git/commits/" + parentSha);
    if(c.ok) baseTree = (await c.json()).tree.sha;
  }
  /* آماده‌سازی ورودی‌ها + تقسیم به قطعات */
  const chunks = [];
  let cur = [], curSize = 0;
  for(const pair of pairs){
    let buf;
    try{ buf = fs.readFileSync(pair[1]); }catch(e){ continue; }
    const bin = buf.includes(0);
    const content = bin ? buf.toString("base64") : buf.toString("utf8");
    if(cur.length && (cur.length >= 250 || curSize + content.length > 20000000)){
      chunks.push(cur); cur = []; curSize = 0;
    }
    cur.push({ path: pair[0] + (bin ? ".b64" : ""), mode: "100644", type: "blob", content: content });
    curSize += content.length;
  }
  if(cur.length) chunks.push(cur);
  let done = 0, lastCommit = parentSha, lastTree = baseTree;
  for(const chunk of chunks){
    const t = await ghApi("POST", "/repos/" + GH_REPO + "/git/trees",
      { ...(lastTree ? { base_tree: lastTree } : {}), tree: chunk });
    if(!t.ok) return done;
    lastTree = (await t.json()).sha;
    const c = await ghApi("POST", "/repos/" + GH_REPO + "/git/commits",
      { message: message, tree: lastTree, ...(lastCommit ? { parents: [lastCommit] } : {}) });
    if(!c.ok) return done;
    lastCommit = (await c.json()).sha;
    done += chunk.length;
  }
  if(lastCommit){
    const u = await ghApi("PATCH", "/repos/" + GH_REPO + "/git/refs/heads/" + branch, { sha: lastCommit });
    if(!u.ok){
      /* شاخه هنوز وجود ندارد (مخزن خالی) — ساخته می‌شود */
      const c2 = await ghApi("POST", "/repos/" + GH_REPO + "/git/refs", { ref: "refs/heads/" + branch, sha: lastCommit });
      if(!c2.ok) return 0;
    }
  }else{
    return 0;
  }
  /* کش sha تا دفعات بعد دوباره پوش نشود */
  for(const pair of pairs){
    try{ pushedShaCache.set(ghRemoteKey(pair[0], pair[1]), blobSha(pair[1])); }catch(e){}
  }
  return pairs.length;
}

/* ==== v9.9.3: بازیابی فله — کل دیتا با «یک» درخواست (tarball) ==== */
async function ghFetchTarball(){
  try{
    const branch = await ghBranch();
    const r = await ghApi("GET", "/repos/" + GH_REPO + "/tarball/" + branch);
    if(!r.ok){
      if(r.status === 404){ console.log("☁️ مخزن ابری خالی است — شروع تازه"); return null; }
      console.log("⚠️ دانلود فله ناموفق (" + r.status + ") — بازیابی فایل‌به‌فایل");
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const tag = Date.now();
    const tgz = path.join(os.tmpdir(), "gh-restore-" + tag + ".tgz");
    const dir = path.join(os.tmpdir(), "gh-restore-" + tag + "-d");
    fs.writeFileSync(tgz, buf);
    fs.mkdirSync(dir, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"], err => err ? reject(err) : resolve());
    });
    try{ fs.unlinkSync(tgz); }catch(e){}
    console.log("☁️ دیتای ابری در یک درخواست دانلود شد (" + Math.round(buf.length / 1024) + "KB)");
    return dir;
  }catch(e){
    console.log("⚠️ استخراج tarball ممکن نشد — بازیابی فایل‌به‌فایل: " + e.message);
    return null;
  }
}

function ghTakeFromCloud(cloudDir, remote, local){
  /* کپی از دیتای tarball-extract شده — فقط وقتی فایل محلی غایب یا خالی است (ضد بازنویسی) */
  try{
    let src = path.join(cloudDir, remote);
    let wasB64 = false;
    if(!fs.existsSync(src) && fs.existsSync(src + ".b64")){ src = src + ".b64"; wasB64 = true; }
    if(!fs.existsSync(src)) return false;
    const need = !fs.existsSync(local) || fs.statSync(local).size === 0;
    if(!need) return false;
    fs.mkdirSync(path.dirname(local), { recursive: true });
    if(wasB64){
      fs.writeFileSync(local, Buffer.from(fs.readFileSync(src, "utf8").trim(), "base64"));
    }else{
      fs.copyFileSync(src, local);
    }
    try{ pushedShaCache.set(ghRemoteKey(remote, local), blobSha(local)); }catch(e){}
    return true;
  }catch(e){ return false; }
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
  let buf = Buffer.from(j.content, "base64");
  if(/\.b64$/.test(remotePath)) buf = Buffer.from(buf.toString("utf8").trim(), "base64");
  fs.writeFileSync(localFile, buf);
  try{ pushedShaCache.set(remotePath, blobSha(localFile)); }catch(e){}
  return true;
}

let backupBusy = false;
const lastBackupReqByUser = new Map();

async function backupUser(gid, reason){
  if(!cloudEnabled() || cloudBlocked || backupBusy || ghRateLimited()) return;
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
    if(fs.existsSync(u.planReqFile)) files.push([remote("plan-req.json"), u.planReqFile]);
    if(fs.existsSync(u.authDir)){
      fs.readdirSync(u.authDir).forEach(f => {
        const p = path.join(u.authDir, f);
        if(fs.statSync(p).isFile()) files.push([remote("auth_info/" + f), p]);
      });
    }
    /* v9.9.3: همه فایل‌های تغییرکرده با Git Tree API در چند درخواست پوش می‌شوند */
    const changed = [];
    for(const pair of files){
      let localSha;
      try{ localSha = blobSha(pair[1]); }catch(e){ continue; }
      if(pushedShaCache.get(ghRemoteKey(pair[0], pair[1])) === localSha) continue;
      changed.push(pair);
    }
    if(!changed.length){
      console.log("☁️ بکاپ [" + gid.slice(0, 10) + "] " + reason + ": بدون تغییر");
    }else{
      const ok = await ghCommitPairs(changed, "backup: " + gid.slice(0, 10) + " (" + reason + ")");
      console.log("☁️ بکاپ [" + gid.slice(0, 10) + "] " + reason + ": " + (ok ? (ok + " فایل در چند درخواست") : "ناموفق — بعداً دوباره"));
    }
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
    if(cloudEnabled() && !cloudBlocked){
      let inCache = false;
      try{ inCache = pushedShaCache.get("users/index.json") === blobSha(local); }catch(e){}
      if(!inCache) ghPutFile("users/index.json", local).catch(() => {});
    }
  }catch(e){ console.error("saveUserIndex:", e.message); }
}

async function restoreAllFromGithub(){
  if(!cloudEnabled()){
    console.log("☁️ بکاپ ابری غیرفعال (GITHUB_TOKEN ست نشده)");
    /* v10.2: بدون بکاپ ابری هم سیاست ادمین و کاربران نام‌کاربری/رمز از دیسک بارگذاری شوند */
    loadAdmin();
    loadCredentials();
    return;
  }
  /* v9.9.2: با سهمیه‌ی تمام‌شده بازیابی نمی‌کنیم و پوش را تا ریست می‌بندیم */
  if(!(await ghQuotaOK())){
    cloudBlocked = true;
    console.log("⛔ سهمیه گیت‌هاب تمام است — بازیابی به تعویق افتاد و پوش مسدود شد (محافظ دیتا)");
    return;
  }
  try{
    /* v9.9.3: کل دیتای ابری با «یک» درخواست (tarball) — در نبودش فایل‌به‌فایل */
    const cloudDir = await ghFetchTarball();
    const take = (remote, local) => {
      if(cloudDir && ghTakeFromCloud(cloudDir, remote, local)) return true;
      return false;
    };
    /* رمز امضای سشن */
    const secretFile = path.join(DATA_ROOT, "server-secret.txt");
    if(!fs.existsSync(secretFile)){
      if(!take("server-secret.txt", secretFile)) await ghGetFile("server-secret.txt", secretFile);
    }
    /* تنظیمات مدیریت */
    try{
      if(!fs.existsSync(ADMIN_FILE)){
        if(!take("admin.json", ADMIN_FILE)) await ghGetFile("admin.json", ADMIN_FILE);
      }
    }catch(e){}
    loadAdmin();
    /* v9.8.5: بازیابی کاربران نام‌کاربری/رمز */
    try{
      if(!fs.existsSync(CRED_FILE)){
        if(!take("credentials.json", CRED_FILE)) await ghGetFile("credentials.json", CRED_FILE);
      }
    }catch(e){}
    loadCredentials();
    /* v10.3: تنظیمات پرداخت */
    try{
      if(!fs.existsSync(PAY_FILE)){
        if(!take("payments.json", PAY_FILE)) await ghGetFile("payments.json", PAY_FILE);
      }
    }catch(e){}
    loadPay();
    /* فهرست کاربران */
    const idxLocal = path.join(USERS_DIR, "index.json");
    let index = null;
    try{
      if(fs.existsSync(idxLocal)) index = JSON.parse(fs.readFileSync(idxLocal, "utf8"));
    }catch(e){}
    if(!index){
      if(!take("users/index.json", idxLocal)) await ghGetFile("users/index.json", idxLocal);
      try{ index = JSON.parse(fs.readFileSync(idxLocal, "utf8")); }catch(e){ index = null; }
    }
    const list = (index && Array.isArray(index.users)) ? index.users : [];
    console.log("☁️ بازیابی: " + list.length + " کاربر از گیت‌هاب");
    for(const item of list){
      try{
        const gid = item.gid;
        if(!gid || !/^[A-Za-z0-9_\-]{5,}$/.test(gid)) continue;
        /* v10.0.0: سیاست ادمین با حساب (gid پایه) گره می‌خورد، نه با هر شماره */
        const _adminKey = parseSlotKey(gid).gid;
        /* v9.8.3: کاربران موجود ثبت/قفل می‌شوند تا سیاست سراسری جدید اثری بر آن‌ها نداشته باشد */
        if(!adminState.users[_adminKey]) adminState.users[_adminKey] = adminDefaults();
        const u = ensureUser(gid, { email: item.email || "" }, true); /* deferSave: پروفایل خالی نوشته نشود */
        if(cloudDir){
          /* v9.9.3: بازیابی فله — همه فایل‌ها از tarball محلی کپی می‌شوند (صفر درخواست API) */
          take("users/" + gid + "/meta.json", u.metaFile);
          if(!fs.existsSync(u.metaFile)){
            console.log("⚠️ پروفایل ابری یافت نشد [" + gid.slice(0, 10) + "] — ذخیره خالی انجام نمی‌شود");
          }
          take("users/" + gid + "/receipts.json", u.receiptsFile);
          take("users/" + gid + "/config.json", u.configFile);
          take("users/" + gid + "/confirm.json", u.confirmFile);
          take("users/" + gid + "/plan-req.json", u.planReqFile);
          /* نشست واتساپ — کل پوشه یکجا */
          const srcAuth = path.join(cloudDir, "users", gid, "auth_info");
          if(fs.existsSync(srcAuth)){
            fs.mkdirSync(u.authDir, { recursive: true });
            let n = 0;
            for(const f of fs.readdirSync(srcAuth)){
              try{
                const realName = f.replace(/\.b64$/, "");
                const lp = path.join(u.authDir, realName);
                if(!fs.existsSync(lp) || fs.statSync(lp).size === 0){
                  if(/\.b64$/.test(f)){
                    fs.writeFileSync(lp, Buffer.from(fs.readFileSync(path.join(srcAuth, f), "utf8").trim(), "base64"));
                  }else{
                    fs.copyFileSync(path.join(srcAuth, f), lp);
                  }
                  try{ pushedShaCache.set(ghRemoteKey("users/" + gid + "/auth_info/" + realName, lp), blobSha(lp)); }catch(e){}
                  n++;
                }
              }catch(e){}
            }
            console.log("☁️ نشست [" + gid.slice(0, 10) + "]: " + n + " فایل");
          }
        }else{
          /* حالت جایگزین: بازیابی فایل‌به‌فایل */
          if(!fs.existsSync(u.metaFile)){
            const okMeta = await ghGetFile("users/" + gid + "/meta.json", u.metaFile);
            if(!okMeta) console.log("⚠️ پروفایل ابری یافت نشد [" + gid.slice(0, 10) + "] — ذخیره خالی انجام نمی‌شود");
          }
          if(!fs.existsSync(u.receiptsFile)) await ghGetFile("users/" + gid + "/receipts.json", u.receiptsFile);
          if(!fs.existsSync(u.configFile)) await ghGetFile("users/" + gid + "/config.json", u.configFile);
          if(!fs.existsSync(u.confirmFile)) await ghGetFile("users/" + gid + "/confirm.json", u.confirmFile);
          if(!fs.existsSync(u.planReqFile)) await ghGetFile("users/" + gid + "/plan-req.json", u.planReqFile);
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
        }
        if(fs.existsSync(u.metaFile)){
          try{ u.meta = Object.assign(u.meta, JSON.parse(fs.readFileSync(u.metaFile, "utf8"))); }catch(e){}
          u.saveMeta(); /* فقط وقتی پروفایل واقعی موجود است ذخیره می‌شود */
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
    saveAdmin(); /* v9.8.3: ثبت یکجای کاربران بازیابی‌شده در admin.json */
    if(cloudDir){ try{ fs.rmSync(cloudDir, { recursive: true, force: true }); }catch(e){} }
    console.log("☁️ بازیابی از گیت‌هاب کامل شد");
  }catch(e){
    console.error("restore:", e.message);
  }
}

function startCloudTasks(){
  if(!cloudEnabled()) return;
  setInterval(async () => {
    if(cloudBlocked){
      if(await ghQuotaOK()){
        cloudBlocked = false;
        console.log("✅ سهمیه گیت‌هاب برگشت — محافظ دیتا برداشته شد");
        if(users.size === 0){ await restoreAllFromGithub(); }
      }else{
        return; /* هنوز تمام — در این چرخه هیچ پوشی نمی‌شود */
      }
    }
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
/* v10.0.0: چندشماره‌ای — اسلات. کوکی «waslot» شماره فعال مرورگر را نگه می‌دارد.
   اسلات ۱ = همان کاربر قدیمی (کاملاً سازگار با دیتای موجود)؛ اسلات‌های بعدی: gid--N */
const SLOT_COOKIE = "waslot";
const SLOT_SEP = "--";
function slotKey(gid, slot){ return (slot && slot > 1) ? gid + SLOT_SEP + slot : gid; }
/* v10.2: پلن‌های اشتراک — رایگان / پرو / ویژه */
const PLANS = {
  free:    { name: "رایگان", price: "۰ افغانی / هفته",     days: 7,  maxSlots: 1,  maxGroups: 7, dailyReceipts: 100, bothFeatures: false,
             features: ["۱ حساب واتساپ", "حداکثر ۷ گروه", "۱۰۰ فیش در روز", "یک قابلیت همزمان (دریافت یا تأیید)", "اعتبار ۷ روز"] },
  pro:     { name: "پرو",    price: "۵۰۰ افغانی / ماه",     days: 30, maxSlots: 3,  maxGroups: 0, dailyReceipts: 0, bothFeatures: true,
             features: ["تا ۳ حساب واتساپ", "گروه‌های نامحدود", "فیش نامحدود", "هر دو قابلیت همزمان", "تأیید و تأیید کننده بدون محدودیت", "اعتبار ۳۰ روز"] },
  premium: { name: "ویژه",   price: "۹۹۹ افغانی / ۳ ماه",   days: 90, maxSlots: 20, maxGroups: 0, dailyReceipts: 0, bothFeatures: true,
             features: ["حساب‌های واتساپ نامحدود", "همه امکانات پرو", "همه امکانات جدید در آینده", "همه امکانات همزمان", "اعتبار ۹۰ روز"] }
};

function planInfo(gidBase){
  let u = users.get(gidBase);
  if(!u) u = ensureUser(gidBase, {});
  const now = Date.now();
  let p = u.meta.plan;
  if(!p || !PLANS[p.type]){
    p = { type: "free", at: now, expires: now + PLANS.free.days * 86400000 };
    u.meta.plan = p;
    u.saveMeta();
  }
  const cfg = PLANS[p.type];
  return { u, p, cfg, type: p.type, expired: now > p.expires };
}

function planPublic(gidBase){
  const info = planInfo(gidBase);
  const now = Date.now();
  return {
    type: info.type, name: info.cfg.name, price: info.cfg.price,
    expiresAt: info.p.expires,
    daysLeft: Math.max(0, Math.ceil((info.p.expires - now) / 86400000)),
    expired: info.expired,
    maxSlots: info.cfg.maxSlots, maxGroups: info.cfg.maxGroups,
    dailyReceipts: info.cfg.dailyReceipts, bothFeatures: info.cfg.bothFeatures,
    usedToday: (info.u.meta.usage && info.u.meta.usage.day === new Date().toISOString().slice(0, 10)) ? info.u.meta.usage.count : 0
  };
}

/* شمارش فیش روزانه — false = سقف رسیده یا پلن منقضی */
function usageBump(gidBase){
  const info = planInfo(gidBase);
  if(info.expired) return false;
  if(!info.cfg.dailyReceipts) return true; /* نامحدود */
  const t = new Date().toISOString().slice(0, 10);
  let us = info.u.meta.usage || {};
  if(us.day !== t) us = { day: t, count: 0 };
  if(us.count >= info.cfg.dailyReceipts) return false;
  us.count++;
  info.u.meta.usage = us;
  info.u.saveMeta();
  return true;
}

function toFaDigits(n){ return String(n).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[+d]); }
function parseSlotKey(key){
  key = String(key || "");
  const i = key.indexOf(SLOT_SEP);
  if(i === -1) return { gid: key, slot: 1 };
  const base = key.slice(0, i);
  const num = key.slice(i + SLOT_SEP.length);
  return (/^\d+$/.test(num) && num.length <= 2) ? { gid: base, slot: parseInt(num, 10) } : { gid: key, slot: 1 };
}
function sessionSlot(req){
  const c = parseCookies(req);
  const n = parseInt(c[SLOT_COOKIE] || "1", 10);
  return (n >= 1 && n <= 99) ? n : 1;
}
/* append تا با کوکی سشن (setHeader) تداخل نکند */
function setSlotCookie(res, slot, secure){
  res.append("Set-Cookie",
    SLOT_COOKIE + "=" + slot +
    "; Path=/; SameSite=" + (secure ? "None; Secure" : "Lax") + "; Max-Age=" + Math.floor(30 * 24 * 3600));
}
/* اسلات مؤثر: اگر کوکی به اسلات حذف‌شده اشاره کند → اسلات ۱ */
function effSlot(gid, slot){
  if(slot > 1 && !fs.existsSync(path.join(USERS_DIR, slotKey(gid, slot)))) return 1;
  return slot;
}
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
    "; Path=/; HttpOnly; SameSite=" + (secure ? "None; Secure" : "Lax") + "; Max-Age=" + Math.floor(SESSION_MAX_AGE / 1000));
}

function clearSessionCookie(res){
  const secure = true; /* روی ریندر همیشه HTTPS */
  res.setHeader("Set-Cookie",
    SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=" + (secure ? "None; Secure" : "Lax") + "; Max-Age=0");
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

function ensureUser(gid, profile, deferSave){
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
  /* v10.0.0: اسلات‌های دوم به بعد پروفایل را از کاربر پایه به ارث می‌برند */
  const _ps = parseSlotKey(gid);
  if(_ps.slot > 1){
    let prof = users.get(_ps.gid);
    let pm = prof ? prof.meta : null;
    if(!pm){
      try{ pm = JSON.parse(fs.readFileSync(path.join(USERS_DIR, _ps.gid, "meta.json"), "utf8")); }catch(e){ pm = null; }
    }
    if(pm) profile = { email: pm.email || "", name: pm.name || "", picture: pm.picture || "" };
  }
  u = new UserBot(gid, profile || {});
  users.set(gid, u);
  u.meta.lastSeen = Date.now();
  u.meta.slot = _ps.slot;
  /* v10.0.0: سیاست ادمین برای همه اسلات‌ها یکی است — کلید = gid پایه */
  const _adminKey = _ps.gid;
  /* v9.8.3: کاربر تازه‌وارد سیاست لحظه ثبت را به عنوان وضعیت اختصاصی خودش می‌گیرد؛
     تغییرهای بعدی سیاست سراسری فقط بر کاربرانِ آینده اثر می‌گذارد */
  if(!adminState.users[_adminKey]){
    adminState.users[_adminKey] = adminDefaults();
    saveAdmin();
  }
  if(deferSave){
    /* v9.8.1: ذخیره به تعویق — تا پروفایل واقعی از بکاپ ابری بازیابی نشده،
       هیچ فایل خالی روی دیسک نوشته نمی‌شود تا جایگزین نسخه اصلی نشود */
  }else{
    u.saveMeta();
    saveUserIndex();
  }
  console.log("👤 کاربر جدید: " + (profile?.email || gid));
  return u;
}

function getUser(gid){ return users.get(gid) || null; }

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
    this.planReqFile = path.join(this.dir, "plan-req.json");

    this.meta = {
      gid,
      email: profile.email || "",
      name: profile.name || "",
      picture: profile.picture || "",
      createdAt: Date.now(),
      lastSeen: Date.now()
    };

    /* v10.6: کاربر تازه‌کار با قابلیت‌ها خاموش شروع می‌کند؛ خودش روشن می‌کند */
    this.runtimeConfig = { targetGroups: [], allowedNumbers: [], enabled: false };
    this.receipts = { list: [] };
    this.confirmCfg = {
      enabled: false, /* v10.6: پیش‌فرض خاموش برای کاربر تازه‌کار؛ کاربران قبلی با وضعیت ذخیره‌شده می‌مانند */
      ownerJid: null,
      ownerName: "",
      sourceGroups: [],
      verifierGroups: [], /* v9.8.8: گروه‌های تأیید کننده — [{jid, name}] */
      contacts: {},
      queue: {}
    };

    this.sock = null;
    this.botJid = null;
    this.picCache = {}; /* v9.8.9: کش عکس نمایه گروه‌ها — jid → {b64, ts} */
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

    /* v10.1: اگر متای قبلی روی دیسک هست (مثل برچسب حساب) از بین نرود */
    try{
      if(fs.existsSync(this.metaFile)){
        const _m = JSON.parse(fs.readFileSync(this.metaFile, "utf8"));
        this.meta = Object.assign({}, this.meta, _m, { gid });
      }
    }catch(e){}
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

  /* v10.3: درخواست‌های پرداخت اشتراک */
  loadPlanReq(){
    this.planReq = [];
    try{
      if(fs.existsSync(this.planReqFile)) this.planReq = JSON.parse(fs.readFileSync(this.planReqFile, "utf8")) || [];
    }catch(e){ this.planReq = []; }
    return this.planReq;
  }
  savePlanReq(){
    try{ fs.writeFileSync(this.planReqFile, JSON.stringify(this.planReq || [], null, 2)); }catch(e){}
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
      verifierGroups: this.confirmCfg.verifierGroups || [],
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
    /* v9.8.2: پنل وضعیت واقعی را می‌بیند — بخشِ قفل‌شده توسط مدیر = تیک خاموش
       (وضعیت ذخیره‌شده کاربر دست‌نخورده می‌ماند؛ پس از آزادسازی همان وضعیت برمی‌گردد) */
    const ov = adminOverrides(this.gid);
    const cfg = Object.assign({}, this.runtimeConfig);
    if(!ov.allowDup) cfg.enabled = false;
    const confirm = this.confirmPublic();
    if(!ov.allowConfirm) confirm.enabled = false;
    return {
      type: "state",
      state: this.connectionState, qr: this.currentQR, qrImage: this.currentQRImage, botNumber: this.botNumber,
      groups: this.groupsCache, config: cfg,
      confirm: confirm,
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
          /* v9.8.8: ری‌اکشن از چت شخصی تأیید کننده یا از هر عضو گروه تأیید کننده */
          if(rMsg && rMsg.text && !rJid.endsWith("@broadcast") && !msg.key.fromMe){
            const inVerifierGroup = rJid.endsWith("@g.us") &&
              (this.confirmCfg.verifierGroups || []).some(v => v.jid === rJid);
            const entry = this.confirmCfg.queue[rMsg.key?.id];
            if(entry && (inVerifierGroup || !rJid.endsWith("@g.us"))){
              entry.answered = true;
              entry.answer = rMsg.text;
              entry.answeredBy = msg.key.participant || rJid;
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

          /* v10.2: کنترل پلن — پلن منقضی → ربات کاملاً غیرفعال */
          const baseGid = parseSlotKey(this.gid).gid;
          const pInfo = planInfo(baseGid);
          if(pInfo.expired) continue;

          /* جریان واسطه تایید فیش — مستقل از ربات اصلی */
          const hasVerifierTarget = (this.confirmCfg.ownerJid || (this.confirmCfg.verifierGroups || []).length > 0);
          const isVerifierGroupJid = (this.confirmCfg.verifierGroups || []).some(v => v.jid === rJid);
          if(this.confirmCfg.enabled && hasVerifierTarget && rJid.endsWith("@g.us") && !msg.key.fromMe){
            if(!isVerifierGroupJid && this.confirmCfg.sourceGroups.some(g => g.jid === rJid)){
              const cType = getMessageType(msg);
              if(cType === "image" || cType === "pdf"){
                const senderJidC = msg.key.participant || rJid;
                const senderNumC = senderJidC.split("@")[0].split(":")[0];
                if(!usageBump(baseGid)){
                  console.log("⛔ [" + this.gid.slice(0, 10) + "] سقف فیش روزانه پلن " + pInfo.cfg.name + " پر شد — فیش نادیده گرفته شد");
                  continue;
                }
                console.log("📩 [" + this.gid.slice(0, 10) + "] تایید: ورودی از", senderNumC, "| گروه:", this.groupNameOf(rJid) || rJid);
                this.enqueueTask(() => this.processConfirmTask(msg, cType));
              }
            }
          }

          if(!rJid.endsWith("@g.us")) continue;
          if(msg.key.fromMe) continue;
          if(!this.runtimeConfig.enabled) continue;
          /* v10.2.1: هیچ گروهی انتخاب نشده = ربات در هیچ گروهی کار نمی‌کند (قبلاً: خالی = همه گروه‌ها) */
          if(!this.runtimeConfig.targetGroups.some(t => t.jid === msg.key.remoteJid)) continue;

          const msgType = getMessageType(msg);
          const senderJid = msg.key.participant || msg.key.remoteJid;
          const senderNumber = senderJid.split("@")[0].split(":")[0];

          if(this.runtimeConfig.allowedNumbers.length > 0 &&
             !this.runtimeConfig.allowedNumbers.includes(senderNumber)) continue;

          /* v12.1: فرمان .vv — باز کردن عکس/ویدیوی «یک‌بارمصرف» (view once) که روی آن ریپلای شده */
          {
            const rawText = String(msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
            if(rawText === ".vv"){
              this.enqueueTask(async () => {
                try{
                  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {};
                  let media = null, kind = null;
                  for(const w of [q, q.viewOnceMessage, q.viewOnceMessageV2, q.viewOnceMessageV3]){
                    if(!w) continue;
                    for(const k of ["image", "video"]){
                      const m = w[k + "Message"];
                      if(m){ media = m; kind = k; break; }
                    }
                    if(media) break;
                  }
                  const isVO = !media ? false
                    : !!(media.viewOnce || media.viewOnceV2 || media.viewOnceV3) || !!(q.viewOnceMessage || q.viewOnceMessageV2 || q.viewOnceMessageV3);
                  if(!media || !isVO){
                    await sock.sendMessage(rJid,
                      { text: "❌ روی یک عکس یا ویدیوی «یک‌بارمصرف» ریپلای کن و بنویس .vv" },
                      { quoted: msg });
                    return;
                  }
                  const stream = await downloadContentFromMessage(media, kind);
                  let buffer = Buffer.alloc(0);
                  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                  await sock.sendMessage(rJid,
                    kind === "image" ? { image: buffer } : { video: buffer },
                    { quoted: msg });
                  console.log("👁 [" + this.gid.slice(0, 10) + "] .vv: " + kind + " باز شد");
                }catch(e){
                  console.error(".vv:", e.message);
                  try{
                    await sock.sendMessage(rJid,
                      { text: "❌ باز کردن فایل ممکن نشد؛ ممکن است منقضی شده باشد. دوباره امتحان کن." },
                      { quoted: msg });
                  }catch(_){}
                }
              });
              continue;
            }
          }

          if(msgType !== "image" && msgType !== "pdf") continue;

          if(!usageBump(baseGid)){
            console.log("⛔ [" + this.gid.slice(0, 10) + "] سقف فیش روزانه پلن " + pInfo.cfg.name + " پر شد — فیش نادیده گرفته شد");
            continue;
          }
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
      info = await extractReceiptInfo(imageData);
    }catch(e){
      console.error("extractReceiptInfo نهایی:", e.message);
      return { status: "error", message: source === "pdf" ? MSG_PDF_ERROR : MSG_ERROR };
    }

    if(info.isReceipt === false) return { status: "not_receipt", message: MSG_NOT_RECEIPT };

    const dup = findDuplicateByVision(this.receipts.list, info);

    if(dup){
      /* ── راستی‌آزمایی دومرحله‌ای: پیش از اعلام قطعی، یک خواندن مستقل دیگر ── */
      console.log("🔁 کاندید تکراری (لایه " + dup.layer + ") — راستی‌آزمایی با خواندن دوم...");
      let verdict = { confirmed: false, reason: "خواندن دوم انجام نشد" };
      try{
        const info2 = await extractReceiptInfo(imageData);
        verdict = verifyDuplicateDecision(info, info2, dup.record, dup.layer);
        /* دقت ثبت: کدهای جاافتاده از خواندن دوم پر می‌شوند (فقط فیلدهای خالی) */
        if(info2 && info2.isReceipt !== false){
          for(const k of ["trackingNo", "receiptNo", "referenceCode"]){
            if(!normalizeText(info[k]) && normalizeText(info2[k])) info[k] = info2[k];
          }
        }
      }catch(e){
        verdict = { confirmed: false, reason: "خطا در خواندن دوم: " + e.message };
      }
      if(verdict.confirmed){
        console.log("✅ تکراری تأییدشده: " + verdict.reason);
        return { status: "duplicate", score: dup.score, matched: dup.record, layer: dup.layer, verified: verdict.reason };
      }
      console.log("🛡 تکراری تأیید نشد → ثبت فیش جدید (" + verdict.reason + ")");
      /* تأیید نشد → فیش واقعی است؛ ادامه به ذخیره */
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
    if(!adminOverrides(this.gid).allowDup) return; /* بخش قفل است — پردازش متوقف، اتصال واتساپ پابرجا */
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
    if(!adminOverrides(this.gid).allowConfirm) return; /* بخش قفل است */
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
      try{ info = await extractReceiptInfo(imageData); }catch(e){ info = null; }

      if(!info || info.isReceipt === false){
        /* فیش نبود — بی‌صدا رها کن */
        try{ await this.sock.sendMessage(groupJid, { react: { text: "", key: msg.key } }); }catch(e){}
        console.log("🤫 تایید: فیش نبود — نادیده گرفته شد");
        return;
      }

      /* فوروارد فایل اصلی به تأیید کننده */
      const raw = await downloadMediaMessage(msg, "buffer", {},
        { logger: pino({ level: "silent" }), reuploadRequest: this.sock.updateMediaMessage });

      /* v9.8.8: مقصدهای تأیید — شماره تأیید کننده + گروه‌های تأیید کننده */
      const targets = [];
      if(this.confirmCfg.ownerJid) targets.push({ jid: this.confirmCfg.ownerJid, via: "owner" });
      for(const vg of (this.confirmCfg.verifierGroups || [])) targets.push({ jid: vg.jid, via: "group", name: vg.name || "" });
      let sentOk = 0;
      for(const t of targets){
        try{
          let sent = null;
          if(msgType === "pdf"){
            sent = await this.sock.sendMessage(t.jid, {
              document: raw, mimetype: "application/pdf", fileName: "receipt.pdf"
            });
          }else{
            const mt = msg.message?.imageMessage?.mimetype || "image/jpeg";
            sent = await this.sock.sendMessage(t.jid, {
              image: raw, mimetype: mt
            });
          }
          if(!sent || !sent.key || !sent.key.id) continue;
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
            answer: "",
            via: t.via,
            viaName: t.name || ""
          };
          sentOk++;
        }catch(e){ console.error("تایید: فوروارد به", t.via, e.message); }
      }
      if(sentOk === 0){
        console.error("تایید: فوروارد ناموفق");
        try{ await this.sock.sendMessage(groupJid, { react: { text: "⚠️", key: msg.key } }); }catch(e){}
        return;
      }
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

/* ==================================================
   ADMIN API — پنل مدیریت مستقل (CORS برای هاست خارجی)
   کنترل دو بخش: فیش تکراری (dup) و فیش به تأیید (confirm)
   ================================================== */
const ADMIN_KEY = process.env.ADMIN_KEY || "hamgap-admin-2026";
const ADMIN_FILE = path.join(DATA_ROOT, "admin.json");
/* v9.8.5: کاربران نام‌کاربری/رمز (بدون گوگل) */
const CRED_FILE = path.join(DATA_ROOT, "credentials.json");
let credentials = { users: {} }; /* uname → { gid, salt, hash, name, createdAt } */
function loadCredentials(){
  try{
    if(fs.existsSync(CRED_FILE)) credentials = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  }catch(e){ console.error("loadCredentials:", e.message); }
}
function saveCredentials(){
  try{
    fs.writeFileSync(CRED_FILE, JSON.stringify(credentials, null, 2));
    if(cloudEnabled() && !cloudBlocked) ghPutFile("credentials.json", CRED_FILE).catch(() => {});
  }catch(e){ console.error("saveCredentials:", e.message); }
}
function hashPass(password, salt){
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}
function verifyCred(uname, password){
  try{
    const rec = credentials.users[uname];
    if(!rec) return false;
    const h = Buffer.from(hashPass(password, rec.salt), "hex");
    const s = Buffer.from(rec.hash, "hex");
    return h.length === s.length && crypto.timingSafeEqual(h, s);
  }catch(e){ return false; }
}
const loginFails = new Map(); /* v9.8.5: uname → { count, until } — قفل ۱۰ دقیقه بعد از ۵ خطا */
let adminState = { users: {}, defaults: { allowDup: false, allowConfirm: false } };
/* کاربر تازه: هر دو بخش قفل تا مدیر از پنل فعال کند */
/* v9.8.3: سیاست پیش‌فرض کاربران جدید — از پنل ادمین قابل تنظیم است */
function adminDefaults(){
  const d = adminState.defaults || {};
  return { allowDup: !!d.allowDup, allowConfirm: !!d.allowConfirm };
}
function adminOverrides(gid){
  /* v10.0.0: سیاست برای همه شماره‌های یک حساب یکی است */
  gid = parseSlotKey(gid).gid;
  return Object.assign(adminDefaults(), (adminState.users && adminState.users[gid]) || {});
}
function loadAdmin(){
  try{
    if(fs.existsSync(ADMIN_FILE)){
      const d = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
      adminState = { users: (d && d.users) || {} };
      const df = d && d.defaults;
      adminState.defaults = (df && typeof df.allowDup === "boolean" && typeof df.allowConfirm === "boolean")
        ? { allowDup: df.allowDup, allowConfirm: df.allowConfirm }
        : { allowDup: false, allowConfirm: false };
    }
  }catch(e){ console.error("loadAdmin:", e.message); }
}
function saveAdmin(){
  try{
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminState, null, 2));
  }catch(e){ console.error("saveAdmin:", e.message); }
  if(cloudEnabled() && !cloudBlocked) ghPutFile("admin.json", ADMIN_FILE).catch(() => {});
}
loadAdmin();

/* ==================================================
   v10.3: پرداخت واقعی — حسابپی + درخواست اشتراک
   ================================================== */
const PAY_FILE = path.join(DATA_ROOT, "payments.json");
let payState = { hesabpay: "+93745872028", autompay: "", note: "" };
function loadPay(){
  try{
    if(fs.existsSync(PAY_FILE)) payState = Object.assign(payState, JSON.parse(fs.readFileSync(PAY_FILE, "utf8")));
  }catch(e){}
}
function savePay(){
  try{
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(PAY_FILE, JSON.stringify(payState, null, 2));
  }catch(e){ console.error("savePay:", e.message); }
  if(cloudEnabled() && !cloudBlocked) ghPutFile("payments.json", PAY_FILE).catch(() => {});
}
loadPay();

/* یافتن درخواست پرداخت در همه کاربران */
function findPlanRequest(id){
  for(const [key, u] of users.entries()){
    if(!fs.existsSync(u.planReqFile)) continue;
    u.loadPlanReq();
    const r = (u.planReq || []).find(x => x.id === id);
    if(r) return { u, req: r, gid: parseSlotKey(key).gid };
  }
  return null;
}

/* CORS + احراز کلید مدیریت */
app.use("/api/admin", (req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  });
  if(req.method === "OPTIONS") return res.sendStatus(204);
  if(String(req.headers["x-admin-key"] || "") !== ADMIN_KEY){
    return res.status(401).json({ ok: false, error: "کلید مدیریت نادرست است" });
  }
  next();
});
app.get("/api/admin/check", (req, res) => res.json({ ok: true }));
app.get("/api/admin/users", (req, res) => {
  const list = [];
  let connected = 0, receiptsTotal = 0;
  for(const [gid, u] of users.entries()){
    if(u.connectionState === "connected") connected++;
    const rc = (u.receipts && u.receipts.list) ? u.receipts.list.length : 0;
    receiptsTotal += rc;
    const ov = adminOverrides(gid);
    list.push({
      gid, slot: parseSlotKey(gid).slot, email: u.meta.email || "", name: u.meta.name || "", picture: u.meta.picture || "",
      connected: u.connectionState === "connected", state: u.connectionState,
      botNumber: u.botNumber || null,
      receipts: rc,
      groups: (u.runtimeConfig.targetGroups || []).length,
      confirmEnabled: !!(u.confirmCfg && u.confirmCfg.enabled),
      allowDup: ov.allowDup, allowConfirm: ov.allowConfirm,
      username: (credentials.users && Object.entries(credentials.users).find(([, c]) => c.gid === gid) || [])[0] || null,
      lastSeen: u.meta.lastSeen || null, createdAt: u.meta.createdAt || null,
      /* v10.3.1: اطلاعات پلن برای پنل مدیریت جدا */
      planType: planInfo(gid).type,
      planName: PLANS[planInfo(gid).type].name,
      planExpired: planInfo(gid).expired,
      planExpiresAt: planInfo(gid).p.expires,
      planDaysLeft: Math.max(0, Math.ceil((planInfo(gid).p.expires - Date.now()) / 86400000))
    });
  }
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ ok: true, users: list, total: list.length, connected, receiptsTotal, defaults: adminDefaults() });
});
/* v10.7: جزئیات کامل یک کاربر برای پنل مدیریت */
app.get("/api/admin/user-detail", (req, res) => {
  const gid = String(req.query.gid || "");
  const u = users.get(gid);
  if(!u) return res.status(404).json({ ok: false, error: "کاربر پیدا نشد" });
  const contacts = Object.entries(u.confirmCfg.contacts || {}).map(([jid, name]) => ({ jid, name: name || String(jid).split("@")[0] }));
  res.json({
    ok: true,
    gid,
    name: u.meta.name || "", email: u.meta.email || "", picture: u.meta.picture || "",
    username: credForGid(gid),
    state: u.connectionState, botNumber: u.botNumber || null,
    lastSeen: u.meta.lastSeen || null, createdAt: u.meta.createdAt || null,
    plan: planPublic(gid),
    overrides: adminOverrides(gid),
    dup: {
      enabled: u.runtimeConfig.enabled,
      groups: u.runtimeConfig.targetGroups || [],
      allowedNumbers: u.runtimeConfig.allowedNumbers || []
    },
    confirm: {
      enabled: !!(u.confirmCfg && u.confirmCfg.enabled),
      ownerJid: u.confirmCfg.ownerJid || null,
      ownerName: u.confirmCfg.ownerName || "",
      sourceGroups: u.confirmCfg.sourceGroups || [],
      verifierGroups: u.confirmCfg.verifierGroups || [],
      contacts: contacts, queue: Object.keys(u.confirmCfg.queue || {}).length
    },
    receipts: u.getReceiptsForPanel().slice(0, 50),
    receiptsTotal: (u.receipts.list || []).length,
    queue: { pending: u.queue.length, busy: u.isProcessing }
  });
});

/* v10.8: پاک‌سازی کامل سیستم — همه کاربران از صفر (فقط با کلید ادمین + تأیید WIPE) */
app.post("/api/admin/wipe-all", async (req, res) => {
  if(String((req.body || {}).confirm || "") !== "WIPE"){
    return res.json({ ok: false, error: "برای تأیید کامل، فیلد confirm با مقدار WIPE لازم است" });
  }
  cloudBlocked = true; /* هیچ بکاپی حین پاک‌سازی پوش نشود */
  let removed = 0;
  try{
    /* ۱) قطع اتصال همه ربات‌های واتساپ و خالی کردن حافظه */
    for(const [key, u] of Array.from(users.entries())){
      try{
        if(u.sock){ try{ await u.sock.logout(); }catch(e){} try{ u.sock.end(undefined); }catch(e){} }
        u.sock = null;
      }catch(e){}
      users.delete(key);
      removed++;
    }
    /* ۲) پاک‌سازی کامل دیتای دیسک (پروفایل‌ها، فیش‌ها، سشن‌های واتساپ) */
    try{ fs.rmSync(USERS_DIR, { recursive: true, force: true }); }catch(e){ console.error("rm users:", e.message); }
    fs.mkdirSync(USERS_DIR, { recursive: true });
    /* ۳) حساب‌های ورود خالی؛ سیاست هرکاربر پاک، فقط پیش‌فرض‌ها می‌ماند */
    credentials.users = {};
    fs.writeFileSync(CRED_FILE, JSON.stringify(credentials, null, 2));
    adminState.users = {};
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminState, null, 2));
    /* ۴) ایندکس کاربران صفر */
    pushedShaCache.clear();
    saveUserIndex();
    cloudBlocked = false;
    /* ۵) فایل‌های پاک‌شده به مخزن ابری پوش شوند */
    saveCredentials();
    saveAdmin();
    if(cloudEnabled()){
      ghPutFile("users/index.json", path.join(USERS_DIR, "index.json")).catch(() => {});
    }
    console.log("🧹 پاک‌سازی کامل انجام شد — " + removed + " کاربر حذف شد؛ سیستم از صفر");
    res.json({ ok: true, removed: removed });
  }catch(e){
    cloudBlocked = false;
    console.error("wipe-all:", e.message);
    res.json({ ok: false, error: "خطا در پاک‌سازی: " + e.message });
  }
});

/* v10.3.1: تغییر دستی پلن کاربر از پنل مدیریت جدا */
app.post("/api/admin/user-plan", (req, res) => {
  const gid = String(req.body.gid || "");
  const type = String(req.body.type || "");
  if(!gid || !PLANS[type]) return res.status(400).json({ ok: false, error: "درخواست نامعتبر" });
  const u = users.get(gid);
  if(!u) return res.status(404).json({ ok: false, error: "کاربر پیدا نشد" });
  const now = Date.now();
  u.meta.plan = { type, at: now, expires: now + PLANS[type].days * 86400000 };
  u.saveMeta();
  backupSoon(`plan-admin-${gid.split("/")[0]}`);
  res.json({ ok: true, plan: planPublic(gid) });
});

/* v9.8.5: ساخت/ویرایش کاربر نام‌کاربری/رمز از پنل مدیریت */
app.get("/api/admin/credentials", (req, res) => {
  const list = Object.entries(credentials.users).map(([uname, rec]) => ({
    username: uname, gid: rec.gid, name: rec.name || "", createdAt: rec.createdAt || null
  }));
  res.json({ ok: true, credentials: list });
});
app.post("/api/admin/credential", (req, res) => {
  const uname = String((req.body || {}).username || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  const name = String((req.body || {}).name || "").trim();
  if(!/^[a-z0-9_.]{3,24}$/.test(uname)){
    return res.json({ ok: false, error: "نام کاربری: ۳ تا ۲۴ حرف انگلیسی کوچک، عدد، نقطه یا آندرلاین" });
  }
  if(password.length < 4){
    return res.json({ ok: false, error: "رمز عبور حداقل ۴ کاراکتر باشد" });
  }
  const prev = credentials.users[uname];
  const salt = crypto.randomBytes(16).toString("hex");
  const gid = prev ? prev.gid : ("up_" + uname.replace(/[^a-z0-9_]/g, "") + "_" + crypto.randomBytes(2).toString("hex"));
  credentials.users[uname] = {
    gid, salt, hash: hashPass(password, salt),
    name: name || (prev ? prev.name : ""), createdAt: prev ? (prev.createdAt || Date.now()) : Date.now()
  };
  saveCredentials();
  /* ساخت فوری حساب ایزوله تا لاگین بی‌درنگ کار کند */
  if(!users.get(gid)) ensureUser(gid, { name: name || uname, email: "" }).loadLocal();
  console.log("🔑 کاربر نام‌کاربری ساخته/ویرایش شد:", uname);
  res.json({ ok: true, username: uname, gid });
});
app.post("/api/admin/credential-delete", (req, res) => {
  const uname = String((req.body || {}).username || "").trim().toLowerCase();
  if(!credentials.users[uname]) return res.json({ ok: false, error: "چنین نام کاربری وجود ندارد" });
  delete credentials.users[uname];
  saveCredentials();
  res.json({ ok: true });
});

/* v10.3: فهرست درخواست‌های پرداخت برای ادمین */
app.get("/api/admin/plan-requests", (req, res) => {
  const out = [];
  for(const [key, u] of users.entries()){
    if(!fs.existsSync(u.planReqFile)) continue;
    u.loadPlanReq();
    (u.planReq || []).forEach(r => {
      out.push({
        id: r.id, gid: parseSlotKey(key).gid,
        email: u.meta.email || "", name: u.meta.name || "",
        type: r.type, planName: (PLANS[r.type] || {}).name || r.type,
        method: r.method || "hesabpay",
        note: r.note || "", image: r.image || "",
        status: r.status, at: r.at, decidedAt: r.decidedAt || null, reason: r.reason || ""
      });
    });
  }
  out.sort((a, b) => {
    if((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return b.at - a.at;
  });
  res.json({ ok: true, requests: out, count: out.filter(r => r.status === "pending").length });
});

/* تأیید درخواست → فعال‌سازی پلن از همین لحظه */
app.post("/api/admin/plan-request/approve", (req, res) => {
  const id = String((req.body || {}).id || "");
  const found = findPlanRequest(id);
  if(!found) return res.status(404).json({ ok: false, error: "درخواست پیدا نشد" });
  if(found.req.status !== "pending") return res.status(400).json({ ok: false, error: "این درخواست قبلاً تعیین تکلیف شده است" });
  const type = found.req.type;
  const now = Date.now();
  const info = planInfo(found.gid);
  info.u.meta.plan = { type, at: now, expires: now + PLANS[type].days * 86400000 };
  info.u.saveMeta();
  found.req.status = "approved";
  found.req.decidedAt = now;
  found.u.savePlanReq();
  backupUser(found.gid, "plan-approve");
  console.log("✅ درخواست " + id + " تأیید شد — پلن " + PLANS[type].name + " فعال شد برای " + found.gid.slice(0, 12));
  res.json({ ok: true, plan: planPublic(found.gid) });
});

/* رد درخواست با دلیل */
app.post("/api/admin/plan-request/reject", (req, res) => {
  const id = String((req.body || {}).id || "");
  const reason = String((req.body || {}).reason || "").trim().slice(0, 200) || "درخواست رد شد";
  const found = findPlanRequest(id);
  if(!found) return res.status(404).json({ ok: false, error: "درخواست پیدا نشد" });
  if(found.req.status !== "pending") return res.status(400).json({ ok: false, error: "این درخواست قبلاً تعیین تکلیف شده است" });
  found.req.status = "rejected";
  found.req.reason = reason;
  found.req.decidedAt = Date.now();
  found.u.savePlanReq();
  backupUser(parseSlotKey(found.u.gid).gid, "plan-reject");
  console.log("❌ درخواست " + id + " رد شد — " + reason);
  res.json({ ok: true });
});

/* حذف درخواست (پاک‌سازی) */
app.post("/api/admin/plan-request/delete", (req, res) => {
  const id = String((req.body || {}).id || "");
  const found = findPlanRequest(id);
  if(!found) return res.status(404).json({ ok: false, error: "درخواست پیدا نشد" });
  found.u.planReq = (found.u.planReq || []).filter(r => r.id !== id);
  found.u.savePlanReq();
  backupUser(parseSlotKey(found.u.gid).gid, "plan-req-delete");
  res.json({ ok: true });
});

/* تنظیمات پرداخت: شماره حسابپی + یادداشت */
app.get("/api/admin/pay-settings", (req, res) => {
  res.json({ ok: true, pay: { hesabpay: payState.hesabpay, autompay: payState.autompay || "", note: payState.note || "" } });
});
app.post("/api/admin/pay-settings", (req, res) => {
  const hp = String((req.body || {}).hesabpay || "").replace(/[\s-]/g, "");
  const note = String((req.body || {}).note || "").trim().slice(0, 300);
  if(!/^\+?\d{9,15}$/.test(hp)) return res.json({ ok: false, error: "شماره حسابپی معتبر نیست (مثلاً +93745872028)" });
  if(req.body && req.body.autompay !== undefined){
    const ap = String(req.body.autompay || "").replace(/[\s-]/g, "");
    if(ap && !/^\+?\d{9,15}$/.test(ap)) return res.json({ ok: false, error: "شماره اتوماپی معتبر نیست" });
    payState.autompay = ap ? (ap.startsWith("+") ? ap : "+" + ap) : "";
  }
  payState.hesabpay = hp.startsWith("+") ? hp : "+" + hp;
  payState.note = note;
  savePay();
  console.log("⚙️ تنظیمات پرداخت به‌روز شد — حسابپی: " + payState.hesabpay + " — اتوماپی: " + (payState.autompay || "—"));
  res.json({ ok: true, pay: { hesabpay: payState.hesabpay, autompay: payState.autompay, note } });
});

app.post("/api/admin/defaults", (req, res) => {
  const cur = adminDefaults();
  adminState.defaults = {
    allowDup: req.body.allowDup === undefined ? cur.allowDup : !!req.body.allowDup,
    allowConfirm: req.body.allowConfirm === undefined ? cur.allowConfirm : !!req.body.allowConfirm
  };
  saveAdmin();
  console.log("⚙️ سیاست کاربران جدید: فیش تکراری=" + (adminState.defaults.allowDup ? "خودکار فعال" : "قفل") + " | فیش تأیید=" + (adminState.defaults.allowConfirm ? "خودکار فعال" : "قفل"));
  res.json({ ok: true, defaults: adminState.defaults });
});
app.post("/api/admin/user", (req, res) => {
  const gid = String(req.body.gid || "");
  const u = users.get(gid);
  if(!u) return res.status(404).json({ ok: false, error: "کاربر پیدا نشد" });
  const cur = adminOverrides(gid);
  const ov = {
    allowDup: req.body.allowDup === undefined ? cur.allowDup : !!req.body.allowDup,
    allowConfirm: req.body.allowConfirm === undefined ? cur.allowConfirm : !!req.body.allowConfirm
  };
  adminState.users[gid] = ov;
  saveAdmin();
  /* قفل = سوییچ خود کاربر هم همان لحظه خاموش می‌شود (وضعیتش ذخیره و به پنلش پخش می‌شود) */
  if(!ov.allowDup && u.runtimeConfig.enabled){
    u.runtimeConfig.enabled = false;
    u.saveConfig(); u.broadcastState();
  }
  if(!ov.allowConfirm && u.confirmCfg && u.confirmCfg.enabled){
    u.confirmCfg.enabled = false;
    u.saveConfirm(); u.broadcastState();
  }
  /* آزاد = اختیار با خود کاربر؛ هر وضعیتی دارد نگه داشته می‌شود و می‌تواند عوض کند */
  res.json({ ok: true, overrides: ov, userState: { enabled: u.runtimeConfig.enabled, confirmEnabled: !!u.confirmCfg.enabled } });
});




/* احراز هویت سشن — همه APIها به جز auth نیاز به کوکی دارند */
/* CORS برای فرانت‌اند جدا (هاست خارجی) — کوکی سشن همراه درخواست ارسال می‌شود */
app.use("/api", (req, res, next) => {
  const o = req.headers.origin;
  if(o){
    res.set({
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
      "Vary": "Origin"
    });
  }
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api", (req, res, next) => {
  if(req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/admin/")) return next();
  const gid = sessionGid(req);
  if(!gid) return res.status(401).json({ error: "unauthorized" });
  /* v10.0.0: کاربر فعال = حساب + اسلات (شماره واتساپ انتخابی) */
  const slot = effSlot(gid, sessionSlot(req));
  const key = slotKey(gid, slot);
  /* کوکی امضاشده = خودمان صادرش کرده‌ایم؛ اگر کاربر هنوز ثبت نشده، ساخته می‌شود */
  let u = getUser(key);
  if(!u) u = ensureUser(key, {});
  req.user = u;
  req.accountGid = gid;
  req.slot = slot;
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
    prompt: "select_account",
    state: (typeof req.query.next === "string" && /^https?:\/\//.test(req.query.next)) ? req.query.next : ""
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
    const back = (typeof req.query.state === "string" && /^https?:\/\//.test(req.query.state)) ? req.query.state : "/?auth=ok";
    res.redirect(back);
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
  res.json({ gid: u.gid, email: u.meta.email, name: u.meta.name, picture: u.meta.picture, username: credForGid(u.gid) || "" });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* v9.9.7: پروفایل کاربر — نام/عکس نمایه + تعیین نام کاربری برای ورود بدون ایمیل */
function credForGid(gid){
  for(const un in credentials.users){
    if(credentials.users[un].gid === gid) return un;
  }
  return null;
}

app.post("/api/profile", (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if(name) u.meta.name = name.slice(0, 48);
  if(typeof b.picture === "string"){
    if(b.picture === ""){
      u.meta.picture = "";
    }else if(/^data:image\/(png|jpe?g|webp);base64,/.test(b.picture) && b.picture.length < 400000){
      u.meta.picture = b.picture;
    }else{
      return res.json({ ok: false, error: "فرمت یا حجم عکس نمایه نامعتبر است" });
    }
  }
  u.saveMeta();
  const un = credForGid(u.gid);
  if(un && name){ credentials.users[un].name = u.meta.name; saveCredentials(); }
  res.json({ ok: true, name: u.meta.name, picture: u.meta.picture || "" });
});

app.post("/api/profile/username", (req, res) => {
  const u = req.user;
  const uname = String((req.body || {}).username || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  if(!/^[a-z0-9_.]{3,24}$/.test(uname)){
    return res.json({ ok: false, error: "نام کاربری: ۳ تا ۲۴ حرف انگلیسی کوچک، عدد، نقطه یا آندرلاین" });
  }
  if(password.length < 4){
    return res.json({ ok: false, error: "رمز عبور حداقل ۴ کاراکتر باشد" });
  }
  if(credentials.users[uname] && credentials.users[uname].gid !== u.gid){
    return res.json({ ok: false, error: "این نام کاربری قبلاً گرفته شده — یکی دیگر انتخاب کن" });
  }
  const old = credForGid(u.gid);
  if(old && old !== uname) delete credentials.users[old];
  const salt = crypto.randomBytes(16).toString("hex");
  credentials.users[uname] = { gid: u.gid, salt, hash: hashPass(password, salt), name: u.meta.name || uname, createdAt: Date.now() };
  saveCredentials();
  console.log("🔑 نام کاربری تعیین‌شده برای " + u.gid + ": " + uname);
  res.json({ ok: true, username: uname });
});

/* v9.8.5: ورود با نام کاربری/رمز عبور (بدون گوگل) */
/* v9.9.4: ثبت‌نام خودِ کاربر از صفحه ورود (پنل مستقل هم پشتیبانی می‌کند) */
app.post("/api/auth/register", (req, res) => {
  /* ضد اسپم: حداکثر ۵ ثبت‌نام در ساعت از هر IP */
  const rip = req.ip || "x";
  const rl = regThrottle.get(rip) || { n: 0, until: 0 };
  if(rl.until > Date.now() && rl.n >= 5){
    return res.status(429).json({ ok: false, error: "ثبت‌نام زیاد — یک ساعت بعد دوباره امتحان کن" });
  }
  if(rl.until < Date.now()){ rl.n = 0; rl.until = Date.now() + 3600000; }
  rl.n++;
  regThrottle.set(rip, rl);
  const uname = String((req.body || {}).username || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  const name = String((req.body || {}).name || "").trim();
  if(!/^[a-z0-9_.]{3,24}$/.test(uname)){
    return res.json({ ok: false, error: "نام کاربری: ۳ تا ۲۴ حرف انگلیسی کوچک، عدد، نقطه یا آندرلاین" });
  }
  if(password.length < 4){
    return res.json({ ok: false, error: "رمز عبور حداقل ۴ کاراکتر باشد" });
  }
  if(credentials.users[uname]){
    return res.json({ ok: false, error: "این نام کاربری قبلاً گرفته شده — یکی دیگر انتخاب کن" });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const gid = "up_" + uname.replace(/[^a-z0-9_]/g, "") + "_" + crypto.randomBytes(2).toString("hex");
  credentials.users[uname] = { gid, salt, hash: hashPass(password, salt), name: name || uname, createdAt: Date.now() };
  saveCredentials();
  ensureUser(gid, { name: name || uname, email: "" }).loadLocal();
  console.log("🔑 ثبت‌نام نام کاربری:", uname);
  const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
  setSessionCookie(res, gid, secure);
  res.json({ ok: true, username: uname });
});

const regThrottle = new Map();

app.post("/api/auth/login", (req, res) => {
  const uname = String((req.body || {}).username || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  const rec = credentials.users[uname];
  if(!rec){
    return res.status(401).json({ ok: false, error: "نام کاربری یا رمز عبور نادرست است" });
  }
  const f = loginFails.get(uname);
  if(f && f.until > Date.now()){
    return res.status(429).json({ ok: false, error: "تلاش زیاد — چند دقیقه بعد دوباره امتحان کن" });
  }
  if(!verifyCred(uname, password)){
    const c = ((f && f.count) || 0) + 1;
    loginFails.set(uname, { count: c, until: c >= 5 ? Date.now() + 10 * 60000 : 0 });
    return res.status(401).json({ ok: false, error: "نام کاربری یا رمز عبور نادرست است" });
  }
  loginFails.delete(uname);
  /* کاربر همان‌طور که گوگل وصل می‌شود وصل می‌شود: حساب ایزوله + اتصال خودکار واتساپ */
  let u = users.get(rec.gid);
  if(!u){
    u = ensureUser(rec.gid, { name: rec.name || uname, email: "" });
    u.loadLocal();
  }
  if(!u.sock && !u.connecting){
    if(activeBotCount() < MAX_CONCURRENT_BOTS || fs.existsSync(path.join(u.authDir, "creds.json"))){
      u.connect().catch(e => console.error("اتصال کاربر پس از ورود:", e.message));
    }
  }
  const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
  setSessionCookie(res, rec.gid, secure);
  res.json({ ok: true });
});

/* ---------- STATUS / DATA ---------- */

app.get("/api/status", (req, res) => {
  const u = req.user;
  const ov = adminOverrides(u.gid);
  const cfg = Object.assign({}, u.runtimeConfig);
  if(!ov.allowDup) cfg.enabled = false; /* نمایش وضعیت واقعی: بخش قفل = تیک خاموش */
  res.json({
    state: u.connectionState, qr: u.currentQR, qrImage: u.currentQRImage, botNumber: u.botNumber,
    groups: u.groupsCache, config: cfg,
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

/* v9.8.9: عکس نمایه گروه — با کش حافظه (۱۲ ساعت)؛ اگر عکس نبود 404 و پنل حرف اول را نشان می‌دهد */
app.get("/api/group-pic", async (req, res) => {
  const jid = String(req.query.jid || "");
  if(!jid.endsWith("@g.us")) return res.status(400).end();
  const u = req.user;
  try{
    const hit = u.picCache[jid];
    if(hit && Date.now() - hit.ts < 12 * 3600 * 1000){
      res.set("Content-Type", hit.ct || "image/jpeg");
      res.set("Cache-Control", "private, max-age=43200");
      return res.end(Buffer.from(hit.b64, "base64"));
    }
    if(!u.sock) return res.status(404).end();
    if(typeof u.sock.profilePictureUrl !== "function") return res.status(404).end();
    const url = await u.sock.profilePictureUrl(jid, "preview");
    if(!url) return res.status(404).end();
    const r = await fetch(url);
    if(!r.ok) return res.status(404).end();
    const ct = r.headers.get("content-type") || "image/jpeg";
    if(!ct.startsWith("image/")) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    u.picCache[jid] = { b64: buf.toString("base64"), ct, ts: Date.now() };
    res.set("Content-Type", ct);
    res.set("Cache-Control", "private, max-age=43200");
    res.end(buf);
  }catch(e){
    res.status(404).end();
  }
});

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
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  const idx = u.runtimeConfig.targetGroups.findIndex(t => t.jid === jid);
  if(idx >= 0){
    u.runtimeConfig.targetGroups.splice(idx, 1);
    u.saveConfig(); u.broadcastState();
    return res.json({ ok: true, selected: false, count: u.runtimeConfig.targetGroups.length });
  }
  /* v10.2: سقف گروه بر اساس پلن */
  const info = planInfo(parseSlotKey(u.gid).gid);
  if(info.cfg.maxGroups > 0 && u.runtimeConfig.targetGroups.length >= info.cfg.maxGroups)
    return res.status(403).json({ ok: false, error: "پلن " + info.cfg.name + " اجازه بیشتر از " + toFaDigits(info.cfg.maxGroups) + " گروه نمی‌دهد — ارتقا بده" });
  u.runtimeConfig.targetGroups.push({ jid, name: name || "" });
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true, selected: true, count: u.runtimeConfig.targetGroups.length });
});

app.post("/api/clear-group", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  u.runtimeConfig.targetGroups = [];
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true });

app.post("/api/select-all-groups", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  let all = (u.groupsCache || []).map(g => ({ jid: g.jid, name: g.name || "" }));
  /* v10.2: سقف گروه بر اساس پلن */
  const info = planInfo(parseSlotKey(u.gid).gid);
  if(info.cfg.maxGroups > 0 && all.length > info.cfg.maxGroups) all = all.slice(0, info.cfg.maxGroups);
  u.runtimeConfig.targetGroups = all;
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true, count: u.runtimeConfig.targetGroups.length });
});
});

app.post("/api/allowed-numbers", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  u.runtimeConfig.allowedNumbers = (req.body.numbers || []).filter(n => /^\d+$/.test(n));
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/toggle", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  const on = !!req.body.enabled;
  const info = planInfo(parseSlotKey(u.gid).gid);
  if(on && info.expired) return res.status(403).json({ ok: false, error: "پلن منقضی شده — از تنظیمات پلن را تمدید کن" });
  u.runtimeConfig.enabled = on;
  /* v10.2: پلن رایگان — روشن کردن یک قابلیت، دیگری را خاموش می‌کند */
  if(on && !info.cfg.bothFeatures && u.confirmCfg.enabled){
    u.confirmCfg.enabled = false;
    u.saveConfirm();
  }
  u.saveConfig(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/refresh-groups", async (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowDup) return res.status(403).json({ ok: false, error: "بخش فیش تکراری برای شما فعال نیست" });
  try{ await u.fetchGroups(); res.json({ ok: true, groups: u.groupsCache }); }
  catch(e){ res.json({ ok: false, error: e.message }); }
});

/* ---------- واسطه تایید فیش ---------- */

app.get("/api/confirm", (req, res) => res.json(req.user.confirmPublic()));

app.post("/api/confirm/toggle", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  const on = !!req.body.enabled;
  const info = planInfo(parseSlotKey(u.gid).gid);
  if(on && info.expired) return res.status(403).json({ ok: false, error: "پلن منقضی شده — از تنظیمات پلن را تمدید کن" });
  u.confirmCfg.enabled = on;
  /* v10.2: پلن رایگان — روشن کردن تأیید، دریافت فیش را خاموش می‌کند */
  if(on && !info.cfg.bothFeatures && u.runtimeConfig.enabled){
    u.runtimeConfig.enabled = false;
    u.saveConfig();
  }
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/owner", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  const { jid, name } = req.body;
  if(!jid || !jid.endsWith("@s.whatsapp.net")) return res.json({ ok: false, error: "شماره معتبر نیست" });
  u.confirmCfg.ownerJid = jid;
  u.confirmCfg.ownerName = name || "";
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/owner-clear", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  u.confirmCfg.ownerJid = null;
  u.confirmCfg.ownerName = "";
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/select-group", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
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
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  u.confirmCfg.sourceGroups = [];
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/select-all-groups", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  u.confirmCfg.sourceGroups = (u.groupsCache || []).map(g => ({ jid: g.jid, name: g.name || "" }));
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, count: u.confirmCfg.sourceGroups.length });
});

app.post("/api/confirm/verifier-group", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  const { jid, name } = req.body;
  if(!jid) return res.json({ ok: false, error: "jid لازم است" });
  if(!u.confirmCfg.verifierGroups) u.confirmCfg.verifierGroups = [];
  const idx = u.confirmCfg.verifierGroups.findIndex(g => g.jid === jid);
  if(idx >= 0) u.confirmCfg.verifierGroups.splice(idx, 1);
  else u.confirmCfg.verifierGroups.push({ jid, name: name || "" });
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true, selected: idx < 0, count: u.confirmCfg.verifierGroups.length });
});

app.post("/api/confirm/verifier-groups-clear", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
  u.confirmCfg.verifierGroups = [];
  u.saveConfirm(); u.broadcastState();
  res.json({ ok: true });
});

app.post("/api/confirm/add-contact", (req, res) => {
  const u = req.user;
  if(!adminOverrides(u.gid).allowConfirm) return res.status(403).json({ ok: false, error: "بخش فیش به تأیید برای شما فعال نیست" });
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

/* ---------- v10.0.0: چندشماره‌ای (اسلات‌ها) ---------- */

function listSlots(gid){
  const esc = String(gid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + esc + SLOT_SEP + "(\\d{1,2})$");
  const slots = [];
  const add = (slot) => {
    const key = slotKey(gid, slot);
    const u = users.get(key) || null;
    const hasCreds = fs.existsSync(path.join(USERS_DIR, key, "auth_info", "creds.json"));
    let label = "";
    if(u){ label = u.meta.label || ""; }
    else{
      try{ label = (JSON.parse(fs.readFileSync(path.join(USERS_DIR, key, "meta.json"), "utf8")) || {}).label || ""; }catch(e){}
    }
    slots.push({
      slot,
      phone: u ? (u.botNumber || null) : null,
      state: u ? u.connectionState : "disconnected",
      hasCreds,
      label,
      exists: fs.existsSync(path.join(USERS_DIR, key)) || !!u
    });
  };
  add(1);
  let max = 1;
  try{
    for(const name of fs.readdirSync(USERS_DIR)){
      const m = name.match(rx);
      if(m){
        const n = parseInt(m[1], 10);
        if(n >= 2 && n <= 99 && !slots.some(s => s.slot === n)){
          add(n);
          if(n > max) max = n;
        }
      }
    }
  }catch(e){}
  /* اسلات‌های فقط-در-حافظه (تازه ساخته شده و هنوز فایلی ندارد) */
  for(const [key, u] of users.entries()){
    const ps = parseSlotKey(key);
    if(ps.gid === gid && ps.slot >= 2 && !slots.some(s => s.slot === ps.slot)){
      add(ps.slot);
      if(ps.slot > max) max = ps.slot;
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  return { slots, nextSlot: Math.min(max + 1, 99) };
}

/* v10.2: پلن اشتراک — مشاهده و فعال‌سازی (فعلاً کلیکی؛ پرداخت واقعی بعداً) */
app.get("/api/plan", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const plans = Object.keys(PLANS).map(k => ({ type: k, name: PLANS[k].name, price: PLANS[k].price, features: PLANS[k].features, paid: k !== "free" }));
  const info = planInfo(gid);
  info.u.loadPlanReq();
  const list = info.u.planReq || [];
  const pending = list.find(r => r.status === "pending") || null;
  let lastResult = null;
  for(let i = list.length - 1; i >= 0; i--){
    if(list[i].status !== "pending"){ lastResult = list[i]; break; }
  }
  res.json({
    ok: true,
    plan: planPublic(gid),
    plans,
    pay: { hesabpay: payState.hesabpay, autompay: payState.autompay || "", note: payState.note || "" },
    request: pending ? { id: pending.id, type: pending.type, status: "pending", at: pending.at } : null,
    lastResult: lastResult ? { type: lastResult.type, status: lastResult.status, at: lastResult.decidedAt || lastResult.at, reason: lastResult.reason || "" } : null
  });
});

app.post("/api/plan/set", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const type = String((req.body || {}).type || "");
  if(!PLANS[type]) return res.status(400).json({ ok: false, error: "پلن نامعتبر است" });
  if(type !== "free"){
    return res.status(403).json({ ok: false, error: "پلن‌های پولی فقط بعد از پرداخت فعال می‌شوند — از دکمه «خرید» اقدام کن" });
  }
  const info = planInfo(gid);
  const now = Date.now();
  info.u.meta.plan = { type, at: now, expires: now + PLANS[type].days * 86400000 };
  info.u.saveMeta();
  console.log("💳 پلن " + PLANS[type].name + " فعال شد — " + gid.slice(0, 12));
  res.json({ ok: true, plan: planPublic(gid) });
});

/* v10.3: ارسال درخواست خرید پلن پولی + عکس رسید حسابپی */
app.post("/api/plan/request", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const type = String((req.body || {}).type || "");
  const method = (req.body || {}).method === "autompay" ? "autompay" : "hesabpay";
  const note = String((req.body || {}).note || "").trim().slice(0, 300);
  const image = String((req.body || {}).image || "");
  if(!PLANS[type] || type === "free") return res.status(400).json({ ok: false, error: "پلن نامعتبر است" });
  if(!image.startsWith("data:image/")) return res.status(400).json({ ok: false, error: "عکس رسید واریزی الزامی است" });
  const buf = Buffer.from(image.split(",")[1] || "", "base64");
  if(buf.length < 500) return res.status(400).json({ ok: false, error: "فایل عکس معتبر نیست" });
  if(buf.length > 3 * 1024 * 1024) return res.status(400).json({ ok: false, error: "حجم عکس زیاد است — حداکثر ۳ مگابایت" });
  const info = planInfo(gid);
  const u = info.u;
  u.loadPlanReq();
  if((u.planReq || []).some(r => r.status === "pending")){
    return res.status(409).json({ ok: false, error: "یک درخواست در انتظار بررسی داری" });
  }
  const entry = {
    id: gid.slice(0, 10) + "-" + Date.now().toString(36),
    type, method, note, image, status: "pending", at: Date.now()
  };
  u.planReq.push(entry);
  u.savePlanReq();
  backupUser(gid, "plan-request");
  console.log("💳 درخواست پلن " + PLANS[type].name + " از " + gid.slice(0, 12) + " — در انتظار تأیید");
  res.json({ ok: true, request: { id: entry.id, type: entry.type, status: "pending", at: entry.at } });
});

app.get("/api/slots", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  res.json(Object.assign({ ok: true, active: req.slot || 1 }, listSlots(gid)));
});

/* سوییچ بین شماره‌ها — کوکی اسلات عوض می‌شود، همه APIها از این پس مال شماره جدید‌اند */
app.post("/api/slot", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const slot = parseInt((req.body || {}).slot, 10);
  if(!(slot >= 1) || slot > 99) return res.status(400).json({ ok: false, error: "حساب نامعتبر است" });
  if(slot > 1 && !fs.existsSync(path.join(USERS_DIR, slotKey(gid, slot)))){
    return res.status(404).json({ ok: false, error: "این حساب وجود ندارد" });
  }
  const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
  setSlotCookie(res, slot, secure);
  res.json({ ok: true, slot });
});

/* افزودن شماره جدید — اسلات بعدی ساخته و فعال می‌شود؛ QR از همان جریان همیشگی می‌آید */
app.post("/api/slot/add", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const info = planInfo(gid);
  if(info.expired) return res.status(403).json({ ok: false, error: "پلن منقضی شده — اول از تنظیمات پلن را تمدید کن" });
  const cur = listSlots(gid).slots.filter(s => s.exists).length;
  if(cur >= info.cfg.maxSlots) return res.status(403).json({ ok: false, error: "پلن " + info.cfg.name + " اجازه بیشتر از " + toFaDigits(info.cfg.maxSlots) + " حساب نمی‌دهد — از تنظیمات ارتقا بده" });
  const { nextSlot } = listSlots(gid);
  if(nextSlot >= 99) return res.status(400).json({ ok: false, error: "حداکثر تعداد حساب رسیده است" });
  const key = slotKey(gid, nextSlot);
  const u = ensureUser(key, {});
  u.loadLocal();
  const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
  setSlotCookie(res, nextSlot, secure);
  saveUserIndex();
  console.log("📱 حساب جدید (اسلات " + nextSlot + ") برای " + gid.slice(0, 12));
  res.json({ ok: true, slot: nextSlot });
});

/* حذف شماره (فقط اسلات‌های دوم به بعد) */
app.post("/api/slot/remove", async (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const slot = parseInt((req.body || {}).slot, 10);
  if(!(slot >= 1) || slot > 99) return res.status(400).json({ ok: false, error: "حساب نامعتبر است" });
  const key = slotKey(gid, slot);
  const u = users.get(key);
  try{
    if(u){
      if(u.sock){ try{ await u.sock.logout(); }catch(e){} try{ u.sock.end(undefined); }catch(e){} }
      u.sock = null;
      users.delete(key);
    }
  }catch(e){}
  if(slot === 1){
    /* v10.1: حساب اصلی — پروفایل می‌ماند، دیتای واتساپ کامل پاک می‌شود */
    const _prof = { email: (u && u.meta.email) || "", name: (u && u.meta.name) || "", picture: (u && u.meta.picture) || "" };
    try{ fs.rmSync(path.join(USERS_DIR, key, "auth_info"), { recursive: true, force: true }); }catch(e){}
    for(const f of ["receipts.json", "config.json", "confirm.json"]){
      try{ fs.rmSync(path.join(USERS_DIR, key, f), { force: true }); }catch(e){}
    }
    /* کاربرِ خالی بازسازی شود تا سشن پنل سالم بماند */
    const nu = ensureUser(key, _prof);
    delete nu.meta.label;
    nu.saveMeta();
    nu.loadLocal();
  }else{
    try{ fs.rmSync(path.join(USERS_DIR, key), { recursive: true, force: true }); }catch(e){}
  }
  /* sha cache این اسلات باطل شود */
  for(const k of pushedShaCache.keys()){
    if(k.startsWith("users/" + key + "/")) pushedShaCache.delete(k);
  }
  const secure = (req.headers["x-forwarded-proto"] === "https") || !!process.env.RENDER_EXTERNAL_URL;
  if((req.slot || 1) === slot){
    const rem = listSlots(gid).slots;
    setSlotCookie(res, rem.length ? rem[0].slot : 1, secure);
  }
  saveUserIndex();
  console.log("🗑️ حساب (اسلات " + slot + ") حذف شد — " + gid.slice(0, 12));
  res.json({ ok: true });
});

/* v10.1: ویرایش نام (برچسب) حساب */
app.post("/api/slot/rename", (req, res) => {
  const gid = parseSlotKey(req.user.gid).gid;
  const slot = parseInt((req.body || {}).slot, 10);
  const label = String((req.body || {}).label || "").trim().slice(0, 30);
  if(!(slot >= 1) || slot > 99) return res.status(400).json({ ok: false, error: "حساب نامعتبر است" });
  const key = slotKey(gid, slot);
  if(!fs.existsSync(path.join(USERS_DIR, key))) return res.status(404).json({ ok: false, error: "این حساب وجود ندارد" });
  let u = users.get(key);
  if(!u) u = ensureUser(key, {});
  u.meta.label = label || "";
  u.saveMeta();
  res.json({ ok: true });
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
    /* v10.0.0: جریان وضعیت مال اسلات فعال است */
    const u = gid ? getUser(slotKey(gid, effSlot(gid, sessionSlot(req)))) : null;
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
    console.log("🤖 نسخه چندکاربره v10.0.0 — چندحسابی");
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
