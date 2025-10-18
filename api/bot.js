const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_USERNAME = process.env.BOT_USERNAME || 'Jarviseggsbot'; // Hardcode your bot username
const VERCEL_URL = process.env.VERCEL_URL || 'https://jarvis-drab-three.vercel.app';

// Store conversation contexts
const chatContexts = new Map();

// Fast Telegram API call with better error handling
async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  try {
    // Use fetch instead of axios for better performance
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error('Telegram API error:', await response.text());
      return false;
    }

    console.log('✅ Message sent successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to send message:', error.message);
    return false;
  }
}

// Quick OpenAI request
async function getAIResponse(messages) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 7000 // 7 seconds max
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ OpenAI API error:', error.message);
    throw error;
  }
}

// Main webhook handler - optimized for Vercel
app.post('/api/bot', async (req, res) => {
  console.log('📨 Received Telegram update');
  
  // Immediately respond to Telegram to avoid timeout
  res.status(200).json({ status: 'ok' });
  
  try {
    const update = req.body;
    
    // Process message if it exists (async, after response)
    if (update.message) {
      await handleMessage(update.message);
    }
  } catch (error) {
    console.error('❌ Error processing update:', error);
  }
});

async function handleMessage(msg) {
  // Ignore messages older than 60 seconds
  if (Date.now() / 1000 - msg.date > 60) {
    console.log('⏭️ Ignoring old message');
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  console.log(`👤 Processing message: ${text.substring(0, 100)}`);

  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
  const isPrivate = msg.chat.type === 'private';
  
  // Use hardcoded bot username to avoid Telegram API calls
  const isMentioned = isGroup && text.includes(`@${BOT_USERNAME}`);
  const isReplyToBot = msg.reply_to_message && 
                      msg.reply_to_message.from && 
                      msg.reply_to_message.from.username === BOT_USERNAME;

  console.log('🔍 Message analysis:', {
    isGroup,
    isPrivate,
    isMentioned,
    isReplyToBot,
    botUsername: BOT_USERNAME
  });

  // Respond only if:
  // - Private chat OR
  // - Bot mentioned OR 
  // - Reply to bot's message
  if (!isPrivate && !isMentioned && !isReplyToBot) {
    console.log('⏭️ Ignoring message - not addressed to bot');
    return;
  }

  try {
    // Clean message from mentions
    const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, 'g'), '').trim();
    
    if (!cleanText) {
      await sendTelegramMessage(chatId, 'Привет! Чем могу помочь?', msg.message_id);
      return;
    }

    console.log('🧠 Processing with OpenAI:', cleanText);

    // Initialize or get conversation context
    const contextKey = `${chatId}`;
    if (!chatContexts.has(contextKey)) {
      chatContexts.set(contextKey, {
        messages: [
          { 
            role: 'system', 
            content: `Ты полезный AI ассистент в Telegram. Отвечай на русском языке.
                     Будь кратким и естественным в ответах.
                     Текущая дата: ${new Date().toLocaleString('ru-RU')}`
          }
        ],
        lastActivity: Date.now()
      });
    }

    const contextData = chatContexts.get(contextKey);
    contextData.lastActivity = Date.now();
    
    const context = contextData.messages;
    
    // Add user message to context
    context.push({ role: 'user', content: cleanText });

    // Get response from OpenAI with timeout protection
    const aiResponse = await getAIResponse(context);
    console.log('✅ OpenAI response received');
    
    // Update context with AI response
    context.push({ role: 'assistant', content: aiResponse });
    
    // Limit context size (keep last 6 messages for speed)
    if (context.length > 6) {
      context.splice(1, context.length - 6);
    }

    // Send response - don't wait for completion to avoid timeout
    sendTelegramMessage(chatId, aiResponse, msg.message_id).catch(e => {
      console.error('❌ Failed to send message (non-blocking):', e.message);
    });

  } catch (error) {
    console.error('❌ Error in handleMessage:', error.message);

    let errorMessage = 'Извините, произошла ошибка. Попробуйте еще раз.';
    
    if (error.response?.status === 429) {
      errorMessage = 'Слишком много запросов. Подождите немного.';
    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      errorMessage = 'Время ответа истекло. Попробуйте более короткий запрос.';
    }

    // Send error message without waiting
    sendTelegramMessage(chatId, errorMessage, msg.message_id).catch(e => {
      console.error('❌ Failed to send error message:', e.message);
    });
  }
}

// Status endpoint
app.get('/api/bot', (req, res) => {
  res.json({
    status: 'Bot is running!',
    timestamp: new Date().toISOString(),
    bot_username: BOT_USERNAME,
    active_chats: chatContexts.size,
    vercel_url: VERCEL_URL
  });
});

// Manual webhook setup endpoint
app.get('/api/bot/setup', async (req, res) => {
  try {
    const webhookUrl = `${VERCEL_URL}/api/bot`;
    const setupUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`;
    
    res.json({
      instructions: 'Open this URL in your browser to setup webhook:',
      setup_url: setupUrl,
      webhook_url: webhookUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup old contexts
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, data] of chatContexts.entries()) {
    if (now - data.lastActivity > 30 * 60 * 1000) { // 30 minutes
      chatContexts.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} old contexts`);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot server running on port ${PORT}`);
  console.log(`🌐 Webhook URL: ${VERCEL_URL}/api/bot`);
  console.log(`🤖 Bot username: ${BOT_USERNAME}`);
});

module.exports = app;
