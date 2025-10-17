// api/telegram.js — Edge webhook (Vercel). Robust, always 200 on errors.
export const runtime = 'edge';

const MODEL_ID = process.env.MODEL_ID || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are an assistant. Always reply in concise, natural English. Do not switch languages.';

function buildPrompt(userText) {
  const englishRule =
    'Always respond in English. Do not switch languages, even if the user writes in another language.';
  return `System: ${SYSTEM_PROMPT}\n${englishRule}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(userText, signal) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(userText) }),
    signal
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json().catch(() => ({}));
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? 'I could not produce a response.';
}

async function tg(method, payload) {
  // не кидаем исключений из Telegram-запросов — чтобы не уронить функцию
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch { /* ignore */ }
}

export default async function handler(req) {
  // health check
  if (req.method === 'GET') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response('ok', { status: 200 });
  }

  // поддержим разные типы апдейтов
  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId = msg?.chat?.id;
  const text = msg?.text ?? msg?.caption ?? '';

  // если это не текст — просто подтвердим приём
  if (!chatId || !text) return new Response('ok', { status: 200 });

  // проверим env заранее
  if (!process.env.BOT_TOKEN || !process.env.OPENAI_API_KEY) {
    await tg('sendMessage', { chat_id: chatId, text: 'Oops: missing server configuration (API key or bot token).' });
    return new Response('ok', { status: 200 });
  }

  // show typing (не ждём)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    // до ~25с на ответ модели
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    let reply;
    try { reply = await askLLM(text, ctrl.signal); }
    finally { clearTimeout(to); }

    await tg('sendMessage', { chat_id: chatId, text: reply });
  } catch (e) {
    const msg = String(e?.message || e || 'unknown error');
    const friendly =
      msg.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
      msg.includes('model_not_found') ? 'Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini).' :
      msg.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
      `Oops: ${msg}`;
    await tg('sendMessage', { chat_id: chatId, text: friendly });
  }

  // Telegram должен получить 200, иначе он будет ретраить
  return new Response('ok', { status: 200 });
}
