// api/telegram.js
// Edge webhook for Telegram bot: groups-only LLM, mention-gated, thanks-only handling.
// Comments: English only.

export const config = { runtime: "edge" };

/** ===== Env ===== */
const TG_TOKEN        = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TG_SECRET       = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BOT_USERNAME    = (process.env.BOT_USERNAME || "").toLowerCase().replace(/^@/, "");
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";

const DEBUG_CHAT  = (process.env.DEBUG_CHAT  || "false").toLowerCase() === "true";
const DEBUG_LLM   = (process.env.DEBUG_LLM   || "false").toLowerCase() === "true";
const PROBE_REPLY = (process.env.PROBE_REPLY || "false").toLowerCase() === "true";
const NO_EMOJI    = (process.env.NO_EMOJI    || "true").toLowerCase() === "true";

/** ===== Telegram helpers ===== */

const TG_API = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : "";

async function tgSend(chatId, text, opts = {}) {
  if (!TG_API) throw new Error("Missing TELEGRAM_TOKEN");
  const payload = { chat_id: chatId, text, parse_mode: "HTML", ...opts };
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.ok;
}

function getMessage(update) {
  return update?.message || update?.edited_message || update?.channel_post || null;
}

function extractText(msg) {
  let t = msg?.text || msg?.caption || "";
  if (typeof t !== "string") t = "";
  return t;
}

function isPrivateChat(msg) {
  return msg?.chat?.type === "private";
}

function isGroupChat(msg) {
  const t = msg?.chat?.type || "";
  return t === "group" || t === "supergroup";
}

function addressedToBot(text, entities) {
  if (!BOT_USERNAME) return false;
  if (!entities || !Array.isArray(entities)) return false;
  const lowers = (text || "").toLowerCase();
  for (const e of entities) {
    if (e.type === "mention") {
      const mention = lowers.slice(e.offset, e.offset + e.length);
      if (mention.replace(/^@/, "") === BOT_USERNAME) return true;
    }
  }
  return false;
}

function isStart(text) {
  return /^\/start\b/.test(text || "");
}

// Minimal safe greeting lines (no questions to avoid follow-up invites).
const GREET_LINES = [
  "Hey — Jarvis here.",
  "Hi there, I’m Jarvis.",
  "Hello! Jarvis here."
];

// Thanks-only detector: no question marks, mostly gratitude.
function isThanksOnly(text) {
  if (!text) return false;
  if (/[?!]/.test(text) && !/!$/.test(text)) return false; // treat '?' as not thanks-only
  const t = text.toLowerCase();
  return /\b(thanks|thank you|спасибо|thx|ty|appreciate it|благодарю)\b/.test(t)
    && !/\b(why|how|when|where|what|когда|как|почему|зачем)\b/.test(t);
}

/** ===== LLM bridge ===== */

function reqOrigin() {
  const v = process.env.VERCEL_URL || "";
  return v ? `https://${v}` : "http://127.0.0.1:3000";
}

async function callWorker(prompt, mode = "creative", extra = {}) {
  const url = new URL("/api/tg-worker", reqOrigin());
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INTERNAL_BEARER}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      mode,
      noEmoji: NO_EMOJI,
      ...extra
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Worker ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  return (data?.text || "").toString();
}

/** ===== Main handler ===== */

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!TG_TOKEN) return new Response("Bot token missing", { status: 500 });

    if (TG_SECRET) {
      const secret = req.headers.get("x-telegram-bot-api-secret-token") || "";
      if (secret !== TG_SECRET) return new Response("Forbidden", { status: 403 });
    }

    const update = await req.json();
    const msg = getMessage(update);
    if (!msg) return new Response("OK", { status: 200 });

    const chatId = msg.chat?.id;
    const text = extractText(msg);
    const entities = msg.entities || msg.caption_entities || [];

    const isGroup = isGroupChat(msg);
    const dm = isPrivateChat(msg);
    const hasMention = addressedToBot(text, entities);

    // DMs are disabled (LLM only in groups).
    if (dm) return new Response("OK", { status: 200 });

    // In groups: respond only if @mentioned.
    if (isGroup && !hasMention) return new Response("OK", { status: 200 });

    // /start greeting (groups only, on mention)
    if (isGroup && hasMention && isStart(text)) {
      const greet = GREET_LINES[Math.floor(Math.random() * GREET_LINES.length)];
      await tgSend(chatId, greet);
      return new Response("OK", { status: 200 });
    }

    // Thanks-only: acknowledge once, do not start a new thread of questions.
    if (isThanksOnly(text)) {
      // Short non-inviting ack; no questions.
      await tgSend(chatId, "You’re welcome.");
      return new Response("OK", { status: 200 });
    }

    // Optional probe so users see instant feedback.
    if (PROBE_REPLY) {
      await tgSend(chatId, "Working on it…");
    }

    // Simple routing: "factual" when technical keywords are present.
    const factual = /\b(contract|address|allowlist|whitelist|abi|rpc|tx|gas|wallet|mint|supply|redis|postgres|leaderboard)\b/i.test(
      text
    );
    const mode = factual ? "factual" : "creative";

    const CONTRACT = process.env.NFT_CONTRACT || "0x88c78d5852f45935324c6d100052958f694e8446";

    const reply = await (async () => {
      try {
        return await callWorker(text, mode, { contractAddr: CONTRACT });
      } catch (err) {
        if (DEBUG_LLM) {
          return `[LLM] ${err?.message || "error"}`;
        }
        return "Something went wrong. Try again later.";
      }
    })();

    await tgSend(chatId, reply);

    if (DEBUG_CHAT) {
      await tgSend(chatId, `[DBG] mode=${mode} mention=${hasMention} dm=${dm}`);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    // Best-effort soft error
    try {
      const body = await req.text();
      console.error("TG handler error:", err, " body:", body);
    } catch {}
    return new Response("OK", { status: 200 });
  }
}
