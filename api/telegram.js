// api/telegram.js — Edge Runtime (до ~30s). Без Telegraf.
// Env: BOT_TOKEN, OPENAI_API_KEY, MODEL_ID (напр. gpt-4o-mini), SYSTEM_PROMPT (optional)
export const runtime = 'edge';

const MODEL_ID = process.env.MODEL_ID || 'gpt-4o-mini';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'You are an assistant. Always reply in concise, natural English. Do not switch languages.';

function buildPrompt(userText) {
  const englishRule = 'Always respond in English. Do not switch languages, even if the user writes in another language.';
  return `System: ${SYSTEM_PROMPT}\n${englishRule}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(userText, signal) {
  const prompt = buildPrompt(userText);
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL_ID, input: prompt }),
    signal
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json();
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? 'I could not produce a response.';
}

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

export default async function handler(req) {
  if (req.method === 'GET') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('Not Found', { status: 404 });

  const update = await req.json().catch(() => ({}));
  const chatId = update?.message?.chat?.id;
  const text   = update?.message?.text ?? update?.message?.caption ?? '';

  if (!chatId || !text) return new Response('ok', { status: 200 });

  try {
    // показываем "typing"
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    }).catch(()=>{});

    // даём модели до ~25s (Edge держит до ~30s)
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);

    let reply;
    try {
      reply = await askLLM(text, ctrl.signal);
    } finally {
      clearTimeout(to);
    }

    await sendMessage(chatId, reply);
    return new Response('ok', { status: 200 });
  } catch (e) {
    const msg = String(e?.message || e || 'unknown error');
    await sendMessage(chatId,
      msg.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
      msg.includes('model_not_found') ? 'Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini).' :
      msg.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
      `Oops: ${msg}`
    );
    return new Response('ok', { status: 200 });
  }
}
