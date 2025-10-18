// /api/bot.js — Telegram webhook on Vercel (Node serverless, NO Express)
// Env: TELEGRAM_TOKEN (or BOT_TOKEN), OPENAI_API_KEY, MODEL_ID (e.g., gpt-4o-mini), optional SYSTEM_PROMPT, BOT_USERNAME

const TG_TOKEN     = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const MODEL_ID     = process.env.MODEL_ID || 'gpt-4o-mini';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').toLowerCase(); // e.g. "jarviseggsbot"

const CONTRACT_ADDR = '0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7';

const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const log = (...a) => { try { console.log(...a); } catch {} };

// ---------- Quick canned replies (EN only) ----------
const WL_LINES = [
  `Guaranteed whitelist = 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `Hold 5 Woolly Eggs — you’re guaranteed on the whitelist. Contract: ${CONTRACT_ADDR}`,
  `Whitelist is guaranteed when you hold 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `With 5 Woolly Eggs you’re auto-whitelisted. Contract: ${CONTRACT_ADDR}`
];
const WE_ROLE_LINES = [
  "The Telegram WE role requires 10 Syndicate NFTs.",
  "To get the WE role in Telegram, hold 10 Syndicate NFTs.",
  "WE role → hold 10 Syndicate NFTs (Telegram).",
  "You’ll receive the WE Telegram role once you hold 10 Syndicate NFTs."
];
const GAME_LINES = [
  "Want to earn some WOOL? Try the mini-game: https://wooligotchi.vercel.app/",
  "You can grind a bit of WOOL here: https://wooligotchi.vercel.app/",
  "Small WOOL boost: play https://wooligotchi.vercel.app/",
  "For a little WOOL, check: https://wooligotchi.vercel.app/"
];
const GWOOLLY_LINES = [
  "Gwoolly",
  "Gwoolly 🧶",
  "Gwoolly 🥚",
  "Gwoolly 🥚 🧶"
];
const TWITTER_LINES = [
  "Official X (Twitter): https://x.com/WoollyEggs",
  "You can follow us on X here: https://x.com/WoollyEggs",
  "Our X (Twitter) page: https://x.com/WoollyEggs",
  "X link: https://x.com/WoollyEggs"
];
const SNAPSHOT_LINES = [
  "The snapshot will occur one day before the mainnet launch.",
  "Snapshot is planned for 24 hours prior to mainnet going live.",
  "Expect the snapshot a day ahead of the mainnet launch.",
  "Snapshot happens one day before mainnet."
];
const GREET_LINES = [
  "Hey — Jarvis here. How can I help?",
  "Hi there, I’m Jarvis. What do you need?",
  "Hello! Jarvis on the line — how can I assist?",
  "Hey! Jarvis here. Ask away."
];

// ---------- English-only keyword triggers ----------
const RE_WL       = /\b(whitelist|allowlist)\b/i;
const RE_WE       = /\b(we\s*role|we-?role|telegram\s*we\s*role)\b/i;
const RE_SYN      = /\b(syndicate)\b/i;
const RE_GAME     = /\b(wooligotchi|wooli?gotchi|mini-?game|game|wool)\b/i;
const RE_BYE      = /^(thanks|thank you|ok|okay|got it|all good|bye|goodbye)$/i;
const RE_GWOOLLY  = /\bgwoolly\b/i;
const RE_TWITTER  = /\b(twitter|x\.com|x\s*\/?\s*woollyeggs|woolly\s*eggs\s*(twitter|x))\b/i;
const RE_SNAPSHOT = /\b(snapshot)\b/i;
const RE_JARVIS   = /\bjarvis\b/i;
const RE_GREET    = /\b(hi|hello|hey|yo|hiya|howdy|gm|good\s*morning|good\s*evening|good\s*night|sup|what'?s\s*up)\b/i;

// ---------- Telegram helper ----------
async function tg(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      log('TG error', method, r.status, t);
    }
  } catch (e) { log('TG fetch error', method, String(e?.message || e)); }
}

// ---------- LLM ----------
function systemPrompt() {
  const base = process.env.SYSTEM_PROMPT || `
You are “Jarvis”, a concise, friendly assistant and a resident of the Woolly Eggs universe (NFT collection).
Always reply in ENGLISH only.
Style: calm, neutral, laconic. No small talk unless the user clearly wants it.
Rules:
- Be brief: 1–3 sentences or up to 5 short bullets (<= ~90 words).
- Do NOT proactively continue the conversation or ask follow-ups unless necessary.
- If user says thanks/ok/bye, reply with one short closing line and stop.
- If something about Woolly Eggs is unknown, say “I’m not sure” (do NOT invent lore).
- If asked about whitelist: guaranteed whitelist requires 5 Woolly Eggs NFTs (contract: ${CONTRACT_ADDR}).
- If asked about the Telegram WE role: it requires 10 Syndicate NFTs.
- If user asks about earning a bit of WOOL, suggest the mini-game: https://wooligotchi.vercel.app/
`;
  return base.trim();
}
function buildPrompt(userText) {
  const enforceEN = "Always respond in English. Do not switch languages, even if the user writes in another language.";
  return `System: ${systemPrompt()}\n${enforceEN}\nUser: ${userText}\nAssistant:`;
}
async function askLLM(text, signal) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(text) }),
    signal
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json().catch(() => ({}));
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "I couldn't produce a response.";
}

// ---------- Heuristics (EN only) for passive group replies ----------
function looksLikeQuestion(txt) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  if (s.includes('?')) return true;
  const Q = /\b(how|what|why|when|where|who|which|can|could|should|help|guide|idea|price|cost|how much)\b/;
  return Q.test(s);
}
function containsProjectKeywords(txt) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  return /\b(woolly\s*eggs|woolly|eggs|syndicate|wooligotchi|whitelist|allowlist|we\s*role|we-?role|mini-?game|wool|snapshot)\b/.test(s);
}
function isCommandy(txt) {
  if (!txt) return false;
  const s = txt.trim().toLowerCase();
  const RE = /\b(tell|show|give|make|start|run|explain|calculate|calc|share|provide|list)\b/;
  return RE.test(s);
}
function shouldReplyPassive(text) {
  let score = 0;
  if (looksLikeQuestion(text)) score++;
  if (containsProjectKeywords(text)) score++;
  if (isCommandy(text)) score++;
  return score >= 2; // require at least 2 signals
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!TG_TOKEN) return res.status(200).send('ok');

  // raw body
  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
  let update = {};
  try { update = body ? JSON.parse(body) : {}; } catch {}

  const msg      = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId   = msg?.chat?.id;
  const text     = (msg?.text ?? msg?.caption ?? '').trim();
  const chatType = msg?.chat?.type; // private | group | supergroup | channel
  const isGroup  = chatType === 'group' || chatType === 'supergroup';
  const isPrivate = chatType === 'private';

  const ACK = () => res.status(200).send('ok');
  if (!chatId) return ACK();

  // Ignore DMs entirely
  if (isPrivate) return ACK();

  // Short graceful close (groups only)
  if (RE_BYE.test((text || '').toLowerCase())) {
    await tg('sendMessage', { chat_id: chatId, text: rnd([
      "Anytime. Take care!",
      "You're welcome. Have a good one!",
      "Glad to help. See you!"
    ]), reply_to_message_id: msg.message_id });
    return ACK();
  }

  const lower = (text || '').toLowerCase();

  // ---- MUST-REPLY (no tag) triggers:
  if (RE_GWOOLLY.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(GWOOLLY_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }
  if (RE_TWITTER.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(TWITTER_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }
  if (RE_SNAPSHOT.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(SNAPSHOT_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }

  // ---- NEW: Greeting when tagged or when "Jarvis" is used
  const mentioned  = BOT_USERNAME && lower.includes(`@${BOT_USERNAME}`);
  const nameCalled = RE_JARVIS.test(lower);
  if ((mentioned || nameCalled) && RE_GREET.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(GREET_LINES), reply_to_message_id: msg.message_id });
    return ACK(); // reply once; follow-up messages will be handled as usual
  }

  // Group routing: mention/reply or passive heuristics
  let pass = true;
  if (isGroup) {
    const replyToBot = msg?.reply_to_message?.from?.is_bot &&
      (!msg?.reply_to_message?.from?.username ||
       msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME);
    if (!mentioned && !replyToBot && !nameCalled) {
      pass = shouldReplyPassive(text); // for Privacy OFF case
    }
  }
  if (!pass) return ACK();

  // CANNED (instant)
  if (RE_WL.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(WL_LINES), reply_to_message_id: msg.message_id });
    if (RE_GAME.test(lower)) {
      await tg('sendMessage', { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg.message_id });
    }
    return ACK();
  }
  if (RE_WE.test(lower) || (RE_WE.test(lower) && RE_SYN.test(lower))) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(WE_ROLE_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }
  if (RE_GAME.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }

  if (!text) {
    await tg('sendMessage', { chat_id: chatId, text: "What do you need?", reply_to_message_id: msg.message_id });
    return ACK();
  }

  // typing (fire-and-forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(()=>{});

  if (!OPENAI_KEY) {
    await tg('sendMessage', { chat_id: chatId, text: "OpenAI API key is missing on the server." });
    return ACK();
  }

  // LLM path (short timeout; serverless friendly)
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    let reply;
    try { reply = await askLLM(text, ctrl.signal); }
    finally { clearTimeout(to); }
    await tg('sendMessage', { chat_id: chatId, text: reply, reply_to_message_id: msg.message_id });
  } catch (e) {
    const m = String(e?.message || e || 'unknown error');
    const friendly =
      m.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
      m.includes('model_not_found') ? 'Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini).' :
      m.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
      `Oops: ${m}`;
    await tg('sendMessage', { chat_id: chatId, text: friendly, reply_to_message_id: msg.message_id });
  }

  return ACK();
}
