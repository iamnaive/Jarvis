// api/tg-worker.ts
// Edge worker: calls the LLM and post-processes text.
// Comments: English only.

export const config = { runtime: "edge" };

/** ===== Env ===== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_JSON || "";
const MODEL_ID = process.env.LLM_MODEL_ID || "gpt-5-mini"; // keep your default
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const NO_EMOJI = (process.env.NO_EMOJI || "true").toLowerCase() === "true";

/** ===== Text filters ===== */

// Conservative emoji/decoration stripper.
function stripEmojis(s: string): string {
  if (!s) return s;
  return s.replace(
    /[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\u200D\uFE0F]/gu,
    ""
  );
}

// Trim brand-y tails and over-branding lines.
function softBrandTrim(userText: string, s: string): string {
  if (!s) return s;
  let out = s.trim();

  const brandTail: RegExp[] = [
    /\b(?:within|in|inside)\s+the\s+Woolly\s+Eggs\s+universe\b[.,!?\s]*$/i,
    /\bthis\s+is\s+how\s+it\s+works\s+in\s+Woolly\s+Eggs\b[.,!?\s]*$/i
  ];
  for (const re of brandTail) out = out.replace(re, "").trim();

  if (!/woolly\s*eggs/i.test(userText)) {
    out = out.replace(/^\s*In\s+the\s+Woolly\s+Eggs(?:\s+universe)?[,:]\s*/i, "");
  }

  return out.trim();
}

// Remove generic "keep-talking" invites that models often append.
function stripGenericInvites(s: string): string {
  if (!s) return s;
  let out = String(s).trim();

  const patterns: RegExp[] = [
    /(?:what'?s|what is)\s+on your mind(?:\s+today)?\??$/i,
    /anything else on your mind\??$/i,
    /how can i (?:help|assist)(?: you)?(?: today)?\??$/i,
    /what do you need\??$/i,
    /what would you like to talk about(?: today)?\??$/i,
    /is there anything else (?:i can help with|you(?:'|’)d like to discuss)\??$/i
  ];
  for (const re of patterns) out = out.replace(re, "").trim();

  // Also remove leading filler that often precedes invites.
  out = out.replace(/^(?:sure|of course|okay|ok|alright)[,!\s-]+/i, "").trim();

  return out || " ";
}

/** ===== System prompts ===== */

function systemPromptCreative(): string {
  return `
You are “Jarvis”, a witty, imaginative assistant.
Do not mention “Woolly Eggs universe” unless the user explicitly mentions Woolly Eggs or the topic requires it.
Do not ask follow-up questions unless the user asks for more.
Never add generic invitations like “What’s on your mind today?”, “Anything else on your mind?”, or “How can I help today?”.
Never end the message with a question unless the user asked one.
Tone: playful, concise, cinematic when appropriate. Keep answers short (1–3 sentences or up to 5 bullets).
Do not use emojis, kaomoji, emoji-like unicode, or decorative symbols.
If the topic is sensitive or dangerous, refuse safely.
`.trim();
}

function systemPromptFactual(contractAddr: string): string {
  return `
You are “Jarvis”, a concise, friendly project assistant.
Do not mention “Woolly Eggs universe” unless the user explicitly mentions Woolly Eggs or the topic requires it.
Do not ask follow-up questions unless the user asks for more.
Never add generic invitations like “What’s on your mind today?”, “Anything else on your mind?”, or “How can I help today?”.
Never end the message with a question unless the user asked one.
Reply in ENGLISH only. Be brief (1–3 sentences or up to 5 short bullets). Prefer clear, factual answers for project topics.
Do not invent real-world facts. Do not use emojis, kaomoji, emoji-like unicode, or decorative symbols.
Project facts:
- Guaranteed whitelist requires 5 Woolly Eggs NFTs (contract: ${contractAddr}).
- WE Telegram role requires 10 Syndicate NFTs.
- 1 Syndicate NFT grants FCFS slot on mainnet.
`.trim();
}

/** ===== LLM call ===== */

async function askLLM(prompt: string, sys: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const body = {
    model: MODEL_ID,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt }
    ]
    // Avoid unsupported params like temperature for some models.
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const raw =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.delta?.content ??
    "";

  return (raw || "").toString();
}

/** ===== Types ===== */

type WorkerRequest = {
  prompt: string;
  mode?: "creative" | "factual";
  contractAddr?: string;
  noEmoji?: boolean;
};

type WorkerResponse = { text: string };

/** ===== Handler ===== */

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // Bearer check for internal calls
    const auth = req.headers.get("authorization") || "";
    if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = (await req.json()) as WorkerRequest;
    const userPrompt = (body?.prompt ?? "").toString();
    if (!userPrompt) {
      return Response.json({ text: "" } satisfies WorkerResponse);
    }

    const mode = body.mode === "factual" ? "factual" : "creative";
    const sys =
      mode === "factual"
        ? systemPromptFactual(body.contractAddr || "0x88c78d5852f45935324c6d100052958f694e8446")
        : systemPromptCreative();

    const raw = await askLLM(userPrompt, sys);

    const out0 = (body.noEmoji ?? NO_EMOJI) ? stripEmojis(raw) : raw;
    const out1 = softBrandTrim(userPrompt, out0);
    const out = stripGenericInvites(out1);

    return Response.json({ text: out } satisfies WorkerResponse);
  } catch (err: any) {
    const msg = (err?.message || "Worker error").toString();
    return Response.json({ text: `[ERR] ${msg}` }, { status: 200 });
  }
}
