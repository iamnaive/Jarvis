// /api/telegram.ts
// Edge webhook: LLM in groups only (DMs disabled), robust mention detection,
// optional in-chat diagnostics, safe handoff to /api/tg-worker, and smart thanks-only handling.

export const config = { runtime: "edge" };

// --- ENV ---
const TG_TOKEN        = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TG_SECRET       = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BOT_USERNAME    = (process.env.BOT_USERNAME || "").toLowerCase().replace(/^@/, "");
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";

const DEBUG_CHAT  = (process.env.DEBUG_CHAT  || "false").toLowerCase() === "true";  // verbose [DBG] messages in chat
const DEBUG_LLM   = (process.env.DEBUG_LLM   || "false").toLowerCase() === "true";  // send worker errors to chat
const PROBE_REPLY = (process.env.PROBE_REPLY || "false").toLowerCase() === "true";  // send "Working on it…" before LLM handoff

// --- Project constants ---
const CONTRACT_ADDR = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";

// Quick canned replies (English only)
const WL_LINES = [
  `Guaranteed whitelist = 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `Hold 5 Woolly Eggs — you’re guaranteed on the whitelist. Contract: ${CONTRACT_ADDR}`,
  `Whitelist is guaranteed when you hold 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `With 5 Woolly Eggs you’re auto-whitelisted. Contract: ${CONTRACT_ADDR}`,
];
const WE_ROLE_LINES = [
  "The Telegram WE role requires 10 Syndicate NFTs.",
  "To get the WE role in Telegram, hold 10 Syndicate NFTs.",
  "WE role → hold 10 Syndicate NFTs (Telegram).",
  "You’ll receive the WE Telegram role once you hold 10 Syndicate NFTs.",
];
const GAME_LINES = [
  "Want to earn some WOOL? Try the mini-game: https://wooligotchi.vercel.app/",
  "You can grind a bit of WOOL here: https://wooligotchi.vercel.app/",
  "Small WOOL boost: play https://wooligotchi.vercel.app/",
  "For a little WOOL, check: https://wooligotchi.vercel.app/",
];
const GWOOLLY_LINES = ["Gwoolly", "Gwoolly 🧶", "Gwoolly 🥚", "Gwoolly 🥚 🧶"];
const TWITTER_LINES = [
  "Official X (Twitter): https://x.com/WoollyEggs",
  "You can follow us on X here: https://x.com/WoollyEggs",
  "Our X (Twitter) page: https://x.com/WoollyEggs",
  "X link: https://x.com/WoollyEggs",
];
const SNAPSHOT_LINES = [
  "The snapshot will occur one day before the mainnet launch.",
  "Snapshot is planned for 24 hours prior to mainnet going live.",
  "Expect the snapshot a day ahead of the mainnet launch.",
  "Snapshot happens one day before mainnet.",
];
const GREET_LINES = [
  "Hey — Jarvis here. How can I help?",
  "Hi there, I’m Jarvis. What do you need?",
  "Hello! Jarvis on the line — how can I assist?",
  "Hey! Jarvis here. Ask away.",
];

// Regex triggers
const RE_WL       = /\b(whitelist|allowlist)\b/i;
const RE_WE       = /\b(we\s*role|we-?role|telegram\s*we\s*role)\b/i;
const RE_SYN      = /\b(syndicate)\b/i;
const RE_GWOOLLY  = /\bgwoolly\b/i;
const RE_TWITTER  = /\b(twitter|x\.com|x\s*\/?\s*woollyeggs|woolly\s*eggs\s*(twitter|x))\b/i;
const RE_SNAPSHOT = /\b(snapshot)\b/i;
const RE_JARVIS   = /\bjarvis\b/i;
const RE_GREET    = /\b(hi|hello|hey|yo|hiya|howdy|gm|good\s*morning|good\s*evening|good\s*night|sup|what'?s\s*up)\b/i;

// Utils
function rnd<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

async function tg(method: string, payload: unknown) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function looksLikeQuestion(txt?: string) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  if (s.includes("?")) return true;
  return /\b(how|what|why|when|where|who|which|can|could|should|help|guide|idea|price|cost|how much)\b/.test(s);
}
function containsProjectKeywords(txt?: string) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  return /\b(woolly\s*eggs|woolly|eggs|syndicate|wooligotchi|whitelist|allowlist|we\s*role|we-?role|mini-?game|wool|snapshot)\b/.test(s);
}
function isCommandy(txt?: string) {
  if (!txt) return false;
  const s = txt.trim().toLowerCase();
  return /\b(tell|show|give|make|start|run|explain|calculate|calc|share|provide|list)\b/.test(s);
}
function shouldReplyPassive(text?: string) {
  let score = 0;
  if (looksLikeQuestion(text)) score++;
  if (containsProjectKeywords(text)) score++;
  if (isCommandy(text)) score++;
  return score >= 2;
}

// Thanks/ack detection: true if message is a plain thanks/ack without a question
function isThanksOnly(txt?: string): boolean {
  if (!txt) return false;
  const s = txt.toLowerCase().trim();
  const hasThanks = /\b(thanks|thank you|ty|ok|okay|got it|all good|appreciated|cheers)\b/i.test(s);
  const hasQuestion = s.includes("?") || /\b(how|what|why|when|where|who|which|can|could|should|help|price|cost|how much)\b/i.test(s);
  return hasThanks && !hasQuestion;
}

// Send a single compact debug message (if DEBUG_CHAT=true)
async function flushDebug(chatId: number, logs: string[], threadId?: number) {
  if (!DEBUG_CHAT || logs.length === 0) return;
  const txt = `[DBG]\n` + logs.join("\n").slice(0, 3500);
  await tg("sendMessage", { chat_id: chatId, text: txt, message_thread_id: threadId });
}

// --- Handler ---
export default async function handler(req: Request): Promise<Response> {
  const logs: string[] = [];
  const log = async (chatId: number, s: string) => { if (DEBUG_CHAT) logs.push(s); };

  if (req.method === "GET") return new Response("ok");

  // Verify Telegram secret header (matches setWebhook secret_token)
  if (TG_SECRET) {
    const sec = req.headers.get("x-telegram-bot-api-secret-token");
    if (sec !== TG_SECRET) return new Response("forbidden", { status: 403 });
  }

  // Parse Telegram update
  let update: any = {};
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg      = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId   = msg?.chat?.id;
  const text     = (msg?.text ?? msg?.caption ?? "").trim();
  const chatType = msg?.chat?.type; // private | group | supergroup | channel
  const isGroup  = chatType === "group" || chatType === "supergroup";
  const isDM     = chatType === "private";
  const threadId = msg?.message_thread_id ?? undefined;
  const entities = (msg?.entities || msg?.caption_entities || []) as Array<any>;
  if (!chatId) return new Response("ok");

  await log(chatId, `▶ update ok | chatType=${chatType} | thread=${threadId ?? "none"}`);
  if (DEBUG_CHAT && text) await log(chatId, `text="${text.slice(0,180)}"`);

  // Robust mention / reply / name-called / greeting detection
  const lower = (text || "").toLowerCase();

  const mentionedByText = BOT_USERNAME ? lower.includes(`@${BOT_USERNAME}`) : false;
  const mentionedByEntity = (() => {
    if (!BOT_USERNAME || !text) return false;
    return entities.some((e) => {
      if (e?.type !== "mention") return false;
      const slice = text.slice(e.offset, e.offset + e.length).toLowerCase();
      return slice === `@${BOT_USERNAME}`;
    });
  })();
  const mentionedUserEntity = (() => {
    if (!BOT_USERNAME) return false;
    return entities.some((e) => {
      if (e?.type !== "text_mention") return false;
      const u = e.user;
      return !!(u?.is_bot && u?.username && u.username.toLowerCase() === BOT_USERNAME);
    });
  })();
  const mentioned  = mentionedByText || mentionedByEntity || mentionedUserEntity;

  const replyToBot = !!(msg?.reply_to_message?.from?.is_bot &&
    (!msg?.reply_to_message?.from?.username ||
      msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME));

  const nameCalled = RE_JARVIS.test(lower);
  const greeted    = RE_GREET.test(lower);

  await log(chatId, `gate: mentioned=${mentioned} (text=${mentionedByText} ent=${mentionedByEntity} userEnt=${mentionedUserEntity}) replyToBot=${!!replyToBot} nameCalled=${!!nameCalled}`);

  // Canned triggers (instant replies; do NOT go to LLM)
  if (RE_GWOOLLY.test(lower)) { await tg("sendMessage", { chat_id: chatId, text: rnd(GWOOLLY_LINES), reply_to_message_id: msg?.message_id, message_thread_id: threadId }); await flushDebug(chatId, logs, threadId); return new Response("ok"); }
  if (RE_TWITTER.test(lower)) { await tg("sendMessage", { chat_id: chatId, text: rnd(TWITTER_LINES),  reply_to_message_id: msg?.message_id, message_thread_id: threadId }); await flushDebug(chatId, logs, threadId); return new Response("ok"); }
  if (RE_SNAPSHOT.test(lower)){ await tg("sendMessage", { chat_id: chatId, text: rnd(SNAPSHOT_LINES),  reply_to_message_id: msg?.message_id, message_thread_id: threadId }); await flushDebug(chatId, logs, threadId); return new Response("ok"); }
  if (RE_WL.test(lower))      { await tg("sendMessage", { chat_id: chatId, text: rnd(WL_LINES),       reply_to_message_id: msg?.message_id, message_thread_id: threadId }); if (RE_GAME.test(lower)) await tg("sendMessage", { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg?.message_id, message_thread_id: threadId }); await flushDebug(chatId, logs, threadId); return new Response("ok"); }
  if (RE_WE.test(lower) || (RE_WE.test(lower) && RE_SYN.test(lower))) {
    await tg("sendMessage", { chat_id: chatId, text: rnd(WE_ROLE_LINES), reply_to_message_id: msg?.message_id, message_thread_id: threadId });
    await flushDebug(chatId, logs, threadId); return new Response("ok");
  }
  if (RE_GAME.test(lower))    { await tg("sendMessage", { chat_id: chatId, text: rnd(GAME_LINES),     reply_to_message_id: msg?.message_id, message_thread_id: threadId }); await flushDebug(chatId, logs, threadId); return new Response("ok"); }

  // Greetings policy:
  // - DMs: send canned greeting (LLM is off in DMs) and exit.
  // - Groups: DO NOT send canned greeting; allow it to fall through to LLM.
  if (isDM && (mentioned || nameCalled) && greeted) {
    await tg("sendMessage", { chat_id: chatId, text: rnd(GREET_LINES), reply_to_message_id: msg?.message_id, message_thread_id: threadId });
    await flushDebug(chatId, logs, threadId);
    return new Response("ok");
  }

  // Short close: pure thanks/ack (no question) → reply once and stop
  if (isThanksOnly(text)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: rnd(["Anytime. Take care.", "You're welcome.", "Glad to help."]),
      reply_to_message_id: msg?.message_id,
      message_thread_id: threadId
    });
    await flushDebug(chatId, logs, threadId);
    return new Response("ok");
  }

  // DMs policy: never call LLM
  if (isDM) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "DM LLM is off. Ask me in the group.",
      reply_to_message_id: msg?.message_id,
      message_thread_id: threadId
    });
    await flushDebug(chatId, logs, threadId);
    return new Response("ok");
  }

  // Group gate: allow LLM on mention/reply/name OR greeting OR heuristics
  if (isGroup) {
    const heur = shouldReplyPassive(text);
    const pass = mentioned || replyToBot || nameCalled || greeted || heur;
    await log(chatId, `group gate pass=${pass} (heuristics=${heur} greeted=${greeted})`);
    if (!pass) { await flushDebug(chatId, logs, threadId); return new Response("ok"); }
  }

  // Delegate to Node worker (/api/tg-worker)
  const url = new URL("/api/tg-worker", req.url);
  try {
    if (PROBE_REPLY) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Working on it…",
        reply_to_message_id: msg?.message_id,
        message_thread_id: threadId
      });
      await log(chatId, `probe sent`);
    }

    if (!INTERNAL_BEARER) {
      await tg("sendMessage", { chat_id: chatId, text: "Worker secret not set (INTERNAL_BEARER).", reply_to_message_id: msg?.message_id, message_thread_id: threadId });
      await log(chatId, `handoff skipped: INTERNAL_BEARER missing`);
      await flushDebug(chatId, logs, threadId);
      return new Response("ok");
    }

    const r = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${INTERNAL_BEARER}`,
      },
      body: JSON.stringify({
        chatId,
        text,
        replyTo: msg?.message_id ?? null,
        threadId,
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      const brief =
        r.status === 403 ? "403 (forbidden) — INTERNAL_BEARER mismatch?" :
        r.status === 500 ? "500 (server) — check OPENAI_API_KEY/MODEL_ID?" :
        `${r.status} — ${t.slice(0,140)}`;
      if (DEBUG_LLM) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `LLM worker error: ${brief}`,
          reply_to_message_id: msg?.message_id,
          message_thread_id: threadId
        });
      }
      await log(chatId, `worker status=${r.status} body="${t.slice(0,200)}"`);
    } else {
      await log(chatId, `worker status=200 ok`);
    }
  } catch (e: any) {
    const em = String(e?.message || e);
    if (DEBUG_LLM) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `LLM handoff failed: ${em}`,
        reply_to_message_id: msg?.message_id,
        message_thread_id: threadId
      });
    }
    await log(chatId, `handoff exception: ${em}`);
  }

  await flushDebug(chatId, logs, threadId);
  return new Response("ok");
}
