// /api/telegram.ts
// Comments: English only. Edge webhook: LLM in groups only, disabled in DMs.

export const config = { runtime: "edge" };

const TG_TOKEN  = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").toLowerCase().replace(/^@/, "");
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";

const CONTRACT_ADDR = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";

// Quick canned replies
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
const GWOOLLY_LINES = ["Gwoolly", "Gwoolly", "Gwoolly"];
const TWITTER_LINES = [
  "Official X (Twitter): https://x.com/WoollyEggs",
  "You can follow us on X here: https://x.com/WoollyEggs",
  "Our X (Twitter) page: https://x.com/WoollyEggs",
];
const SNAPSHOT_LINES = [
  "The snapshot will occur one day before the mainnet launch.",
  "Snapshot is planned for 24 hours prior to mainnet going live.",
  "Expect the snapshot a day ahead of the mainnet launch.",
];
const GREET_LINES = [
  "Hey — Jarvis here. How can I help?",
  "Hi there, I’m Jarvis. What do you need?",
  "Hello! Jarvis on the line — how can I assist?",
];

// Regex triggers
const RE_WL       = /\b(whitelist|allowlist)\b/i;
const RE_WE       = /\b(we\s*role|we-?role|telegram\s*we\s*role)\b/i;
const RE_SYN      = /\b(syndicate)\b/i;
const RE_GAME     = /\b(wooligotchi|wooli?gotchi|mini-?game|game|wool)\b/i;
const RE_BYE      = /\b(thanks|thank you|ok|okay|got it|all good|bye|goodbye)\b/i;
const RE_GWOOLLY  = /\bgwoolly\b/i;
const RE_TWITTER  = /\b(twitter|x\.com|x\s*\/?\s*woollyeggs|woolly\s*eggs\s*(twitter|x))\b/i;
const RE_SNAPSHOT = /\b(snapshot)\b/i;
const RE_JARVIS   = /\bjarvis\b/i;
const RE_GREET    = /\b(hi|hello|hey|yo|hiya|howdy|gm|good\s*morning|good\s*evening|good\s*night|sup|what'?s\s*up)\b/i;

function rnd<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }
async function tg(method: string, payload: unknown) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(()=>{});
}

// Light heuristics for passive replies in groups
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

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("ok");

  // Verify Telegram secret header
  if (TG_SECRET) {
    const sec = req.headers.get("x-telegram-bot-api-secret-token");
    if (sec !== TG_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update: any = {};
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg      = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId   = msg?.chat?.id;
  const text     = (msg?.text ?? msg?.caption ?? "").trim();
  const chatType = msg?.chat?.type; // private | group | supergroup | channel
  const isGroup  = chatType === "group" || chatType === "supergroup";
  const isDM     = chatType === "private";
  if (!chatId) return new Response("ok");

  const lower = (text || "").toLowerCase();

  // --- MUST / canned triggers BEFORE gating
  if (RE_GWOOLLY.test(lower)) { await tg("sendMessage", { chat_id: chatId, text: rnd(GWOOLLY_LINES), reply_to_message_id: msg?.message_id }); return new Response("ok"); }
  if (RE_TWITTER.test(lower)) { await tg("sendMessage", { chat_id: chatId, text: rnd(TWITTER_LINES),  reply_to_message_id: msg?.message_id }); return new Response("ok"); }
  if (RE_SNAPSHOT.test(lower)){ await tg("sendMessage", { chat_id: chatId, text: rnd(SNAPSHOT_LINES),  reply_to_message_id: msg?.message_id }); return new Response("ok"); }
  if (RE_WL.test(lower))      { await tg("sendMessage", { chat_id: chatId, text: rnd(WL_LINES),       reply_to_message_id: msg?.message_id }); if (RE_GAME.test(lower)) await tg("sendMessage", { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg?.message_id }); return new Response("ok"); }
  if (RE_WE.test(lower) || (RE_WE.test(lower) && RE_SYN.test(lower))) {
    await tg("sendMessage", { chat_id: chatId, text: rnd(WE_ROLE_LINES), reply_to_message_id: msg?.message_id });
    return new Response("ok");
  }
  if (RE_GAME.test(lower))    { await tg("sendMessage", { chat_id: chatId, text: rnd(GAME_LINES),     reply_to_message_id: msg?.message_id }); return new Response("ok"); }

  // Greetings
  const mentioned  = BOT_USERNAME && lower.includes(`@${BOT_USERNAME}`);
  const replyToBot = !!(msg?.reply_to_message?.from?.is_bot &&
    (!msg?.reply_to_message?.from?.username ||
      msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME));
  const nameCalled = RE_JARVIS.test(lower);
  if ((mentioned || nameCalled) && RE_GREET.test(lower)) {
    await tg("sendMessage", { chat_id: chatId, text: rnd(GREET_LINES), reply_to_message_id: msg?.message_id });
    return new Response("ok");
  }

  // Short close
  if (RE_BYE.test(lower)) {
    await tg("sendMessage", { chat_id: chatId, text: rnd([
      "Anytime. Take care!",
      "You're welcome. Have a good one!",
      "Glad to help. See you!",
    ]), reply_to_message_id: msg?.message_id });
    return new Response("ok");
  }

  // DM policy: never call LLM in private chats
  if (isDM) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "DM LLM is off. Ask me in the group.",
      reply_to_message_id: msg?.message_id
    });
    return new Response("ok");
  }

  // Group gating: mention/reply/name or heuristics
  if (isGroup) {
    let pass = false;
    if (mentioned || replyToBot || nameCalled) pass = true;
    else pass = shouldReplyPassive(text);
    if (!pass) return new Response("ok");
  }

  // Groups: allow LLM
  try {
    if (INTERNAL_BEARER) {
      const url = new URL("/api/tg-worker", req.url);
      await fetch(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${INTERNAL_BEARER}`,
        },
        body: JSON.stringify({
          chatId,
          text,
          replyTo: msg?.message_id ?? null,
          threadId: msg?.message_thread_id ?? null,
          // fromId not needed for this policy
        }),
      });
    } else {
      // Safety fallback: simple echo if worker is not wired
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Jarvis online: "${text.slice(0,200)}"`,
        reply_to_message_id: msg?.message_id
      });
    }
  } catch {}

  return new Response("ok");
}
