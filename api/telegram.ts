// api/telegram.js
// Edge webhook for Telegram bot: groups-only, mention-gated,
// canned (regex) responses for project FAQs, and LLM fallback.
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

/** Project links & facts via ENV (safe defaults are empty strings) */
const LINK_SITE       = process.env.LINK_SITE       || "";
const LINK_TWITTER    = process.env.LINK_TWITTER    || "";
const LINK_DISCORD    = process.env.LINK_DISCORD    || "";
const LINK_WECUTROOM  = process.env.LINK_WECUTROOM  || "";  // e.g. Notion/Mirror/Docs
const LINK_GAMES      = process.env.LINK_GAMES      || "";  // hub/landing for games
const NFT_CONTRACT    = process.env.NFT_CONTRACT    || "0x88c78d5852f45935324c6d100052958f694e8446";

const SNAPSHOT_DATE   = (process.env.SNAPSHOT_DATE || "").trim(); // e.g. "2025-10-24 13:00 UTC"
const SNAPSHOT_NOTE   = (process.env.SNAPSHOT_NOTE || "").trim(); // free-form, optional

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

// Minimal safe greeting lines (no questions).
const GREET_LINES = [
  "Hey — Jarvis here.",
  "Hi there, I’m Jarvis.",
  "Hello! Jarvis here."
];

// Thanks-only detector: acknowledge without starting a new thread.
function isThanksOnly(text) {
  if (!text) return false;
  if (/[?]/.test(text)) return false; // has a question mark -> not thanks-only
  const t = text.toLowerCase();
  return /\b(thanks|thank you|спасибо|thx|ty|appreciate it|благодарю)\b/.test(t)
    && !/\b(why|how|when|where|what|когда|как|почему|зачем)\b/.test(t);
}

/** ===== Canned responses (project FAQ) =====
 * Order matters: first match wins. Keep answers short, no emojis, no questions.
 * Add/modify patterns and texts as needed.
 */
const CANNED = [
  {
    // Syndicate NFTs: role and FCFS info
    id: "syndicate_role_fcfs",
    re: /\b(syndicate|синдикат)\b/i,
    text: () => [
      "Syndicate NFTs:",
      "• WE Telegram role requires 10 Syndicate NFTs.",
      "• 1 Syndicate NFT grants an FCFS slot on mainnet.",
      LINK_TWITTER ? `More: ${LINK_TWITTER}` : ""
    ].filter(Boolean).join("\n")
  },
  {
    // Whitelist requirement: 5 WE NFTs
    id: "whitelist_requirement",
    re: /\b(whitelist|allowlist|вайтлист|аллоулист|wl)\b/i,
    text: () => [
      "Guaranteed whitelist requires 5 Woolly Eggs NFTs.",
      `Contract: ${NFT_CONTRACT}`,
      LINK_SITE ? `Site: ${LINK_SITE}` : ""
    ].filter(Boolean).join("\n")
  },
  {
    // Snapshot
    id: "snapshot",
    re: /\b(snapshot|снэпшот|снапшот)\b/i,
    text: () => {
      const lines = ["Snapshot:"];
      if (SNAPSHOT_DATE) lines.push(`• Date: ${SNAPSHOT_DATE}`);
      if (SNAPSHOT_NOTE) lines.push(`• Note: ${SNAPSHOT_NOTE}`);
      if (!SNAPSHOT_DATE && !SNAPSHOT_NOTE) lines.push("• Details: TBA");
      if (LINK_TWITTER) lines.push(`Updates: ${LINK_TWITTER}`);
      return lines.join("\n");
    }
  },
  {
    // Games info
    id: "games",
    re: /\b(game|игра|игры|mini-?game|minigame)\b/i,
    text: () => [
      "We are shipping playable mini-games already.",
      LINK_GAMES ? `Hub: ${LINK_GAMES}` : (LINK_SITE ? `More: ${LINK_SITE}` : "")
    ].filter(Boolean).join("\n")
  },
  {
    // WE Cut Room / content room
    id: "wecutroom",
    re: /\b(wecutroom|cut\s*room|векатрум|катрум)\b/i,
    text: () => [
      "WECutRoom: curated clips and content for the community.",
      LINK_WECUTROOM ? `Link: ${LINK_WECUTROOM}` : ""
    ].filter(Boolean).join("\n")
  },
  {
    // TG agent / bot mention
    id: "tg_agent",
    re: /\b(agent|jarvis|бот|bot|assistant)\b/i,
    text: () => [
      "Telegram agent is live in groups with mention-gated replies.",
      "Creative mode by default, specific project triggers are deterministic."
    ].join("\n")
  },
  {
    // Wallet gate / vault
    id: "wallet_gate",
    re: /\b(wallet|vault|кошел[её]к|gate|gated)\b/i,
    text: () => [
      "Access is wallet-gated by NFTs.",
      `Accepted: ERC-721 from ${NFT_CONTRACT}`,
      LINK_SITE ? `More: ${LINK_SITE}` : ""
    ].filter(Boolean).join("\n")
  },
  {
    // WE lore mention without prompting LLM to go cinematic
    id: "we_is_not_just_nft",
    re: /\b(we\s*is\s*not\s*just\s*nft|we\s*это\s*не\s*просто\s*nft|not\s+just\s+nft)\b/i,
    text: () => [
      "WE is not just an NFT — we already ship products:",
      LINK_WECUTROOM ? `• WECutRoom: ${LINK_WECUTROOM}` : "• WECutRoom",
      LINK_GAMES ? `• Games: ${LINK_GAMES}` : "• Games",
      "• Telegram agent for the community.",
      LINK_TWITTER ? `Follow: ${LINK_TWITTER}` : ""
    ].filter(Boolean).join("\n")
  }
];

/** Try canned first; return string or empty string if no match. */
function cannedReply(text) {
  if (!text) return "";
  for (const item of CANNED) {
    if (item.re.test(text)) {
      try {
        const out = typeof item.text === "function" ? item.text() : String(item.text || "");
        return (out || "").trim();
      } catch {
        // ignore and continue
      }
    }
  }
  return "";
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

    // Optional Telegram secret
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

    // DMs: disabled (LLM only in groups)
    if (dm) return new Response("OK", { status: 200 });

    // Groups: respond only when @mentioned
    if (isGroup && !hasMention) return new Response("OK", { status: 200 });

    // /start greeting (groups only, on mention)
    if (isGroup && hasMention && isStart(text)) {
      const greet = GREET_LINES[Math.floor(Math.random() * GREET_LINES.length)];
      await tgSend(chatId, greet);
      return new Response("OK", { status: 200 });
    }

    // Thanks-only short ack
    if (isThanksOnly(text)) {
      await tgSend(chatId, "You’re welcome.");
      return new Response("OK", { status: 200 });
    }

    // Canned reply (deterministic, no LLM)
    const canned = cannedReply(text);
    if (canned) {
      await tgSend(chatId, canned);
      if (DEBUG_CHAT) await tgSend(chatId, `[DBG] canned=true`);
      return new Response("OK", { status: 200 });
    }

    // Optional probe so users see instant feedback
    if (PROBE_REPLY) {
      await tgSend(chatId, "Working on it…");
    }

    // Simple routing for LLM fallback
    const factual = /\b(contract|address|allowlist|whitelist|abi|rpc|tx|gas|wallet|mint|supply|redis|postgres|leaderboard)\b/i.test(
      text
    );
    const mode = factual ? "factual" : "creative";

    const reply = await (async () => {
      try {
        return await callWorker(text, mode, { contractAddr: NFT_CONTRACT });
      } catch (err) {
        if (DEBUG_LLM) return `[LLM] ${err?.message || "error"}`;
        return "Something went wrong. Try again later.";
      }
    })();

    await tgSend(chatId, reply);

    if (DEBUG_CHAT) {
      await tgSend(chatId, `[DBG] mode=${mode} canned=false mention=${hasMention} dm=${dm}`);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    // Soft error
    try {
      const body = await req.text();
      console.error("TG handler error:", err, " body:", body);
    } catch {}
    return new Response("OK", { status: 200 });
  }
}
