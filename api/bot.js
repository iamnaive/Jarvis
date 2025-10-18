const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_URL = process.env.VERCEL_URL || 'https://jarvis-drab-three.vercel.app';

// Store conversation contexts
const chatContexts = new Map();

// Clean up old contexts every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [chatId, data] of chatContexts.entries()) {
    if (now - data.lastActivity > 30 * 60 * 1000) { // 30 minutes
      chatContexts.delete(chatId);
    }
  }
}, 10 * 60 * 1000);

// Send message via Telegram API
async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      payload,
      { timeout: 10000 }
    );
    
    console.log('Message sent successfully');
    return response.data;
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    throw error;
  }
}

// Get bot info from Telegram
async function getBotInfo() {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (error) {
    console.error('Error getting bot info:', error.response?.data || error.message);
    throw error;
  }
}

// Set webhook for Telegram
async function setWebhook() {
  try {
    const webhookUrl = `${VERCEL_URL}/api/bot`;
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}&drop_pending_updates=true`,
      { timeout: 10000 }
    );
    
    console.log('Webhook set successfully');
    return response.data;
  } catch (error) {
    console.error('Error setting webhook:', error.response?.data || error.message);
    throw error;
  }
}

// Main webhook handler
app.post('/api/bot', async (req, res) => {
  console.log('Received Telegram update');
  
  try {
    const update = req.body;
    
    // Process message if it exists
    if (update.message) {
      await handleMessage(update.message);
    }
    
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Error processing update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function handleMessage(msg) {
  // Ignore messages older than 60 seconds
  if (Date.now() / 1000 - msg.date > 60) {
    console.log('Ignoring old message');
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  console.log(`Processing message from ${msg.from?.username}: ${text}`);

  // Get bot username
  let botUsername;
  try {
    const botInfo = await getBotInfo();
    botUsername = botInfo.result.username;
    console.log('Bot username:', botUsername);
  } catch (error) {
    console.error('Error getting bot username:', error);
    return;
  }

  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
  const isPrivate = msg.chat.type === 'private';
  const isMentioned = isGroup && text.includes(`@${botUsername}`);
  const isReplyToBot = msg.reply_to_message && 
                      msg.reply_to_message.from && 
                      msg.reply_to_message.from.username === botUsername;

  console.log('Message analysis:', {
    isGroup,
    isPrivate,
    isMentioned,
    isReplyToBot
  });

  // Respond only if:
  // - Private chat OR
  // - Bot mentioned OR 
  // - Reply to bot's message
  if (!isPrivate && !isMentioned && !isReplyToBot) {
    console.log('Ignoring message - not addressed to bot');
    return;
  }

  try {
    // Clean message from mentions
    const cleanText = text.replace(new RegExp(`@${botUsername}`, 'g'), '').trim();
    
    if (!cleanText) {
      await sendTelegramMessage(chatId, 'Hello! How can I help you?', msg.message_id);
      return;
    }

    console.log('Processing with OpenAI:', cleanText);

    // Initialize or get conversation context
    if (!chatContexts.has(chatId)) {
      chatContexts.set(chatId, {
        messages: [
          { 
            role: 'system', 
            content: `You are a helpful AI assistant in a Telegram chat. Respond in English only.
                     Be concise and natural in your responses.
                     Current date: ${new Date().toLocaleString('en-US')}`
          }
        ],
        lastActivity: Date.now()
      });
    }

    const contextData = chatContexts.get(chatId);
    contextData.lastActivity = Date.now();
    
    const context = contextData.messages;
    
    // Add user message to context
    context.push({ role: 'user', content: cleanText });

    // Get response from OpenAI
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini', // Can use 'gpt-4', 'gpt-4o'
        messages: context,
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();
    console.log('OpenAI response:', aiResponse);
    
    // Update context with AI response
    context.push({ role: 'assistant', content: aiResponse });
    
    // Limit context size (keep last 10 messages)
    if (context.length > 10) {
      context.splice(1, context.length - 10);
    }

    // Send response
    await sendTelegramMessage(chatId, aiResponse, msg.message_id);

  } catch (error) {
    console.error('Error in handleMessage:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

    let errorMessage = 'Sorry, an error occurred. Please try again.';
    
    if (error.response?.status === 429) {
      errorMessage = 'Too many requests. Please wait a moment.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Request timeout. Please try again.';
    } else if (error.response?.status === 401) {
      errorMessage = 'API authentication error. Please check OpenAI key.';
    }

    await sendTelegramMessage(chatId, errorMessage, msg.message_id);
  }
}

// Status endpoint
app.get('/api/bot', async (req, res) => {
  try {
    const botInfo = await getBotInfo();
    const webhookInfo = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    
    res.json({
      status: 'Bot is running!',
      timestamp: new Date().toISOString(),
      bot_username: botInfo.result.username,
      webhook_url: webhookInfo.data.result.url,
      webhook_status: webhookInfo.data.result.pending_update_count > 0 ? 'pending' : 'ready',
      active_chats: chatContexts.size
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Diagnostic failed', 
      details: error.message 
    });
  }
});

// Set webhook endpoint
app.post('/api/bot/set-webhook', async (req, res) => {
  try {
    const result = await setWebhook();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Debug endpoint
app.get('/api/bot/debug', (req, res) => {
  res.json({
    has_telegram_token: !!TELEGRAM_TOKEN,
    has_openai_key: !!OPENAI_API_KEY,
    telegram_token_length: TELEGRAM_TOKEN ? TELEGRAM_TOKEN.length : 0,
    openai_key_prefix: OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 7) + '...' : 'none',
    vercel_url: VERCEL_URL
  });
});

// Clear context endpoint
app.delete('/api/bot/context/:chatId', (req, res) => {
  const chatId = parseInt(req.params.chatId);
  chatContexts.delete(chatId);
  res.json({ success: true, message: 'Context cleared' });
});

// Initialize bot on startup
async function initializeBot() {
  console.log('Initializing Telegram Bot...');
  
  try {
    const botInfo = await getBotInfo();
    console.log('Bot username:', botInfo.result.username);
    
    await setWebhook();
    console.log('Webhook set successfully');
  } catch (error) {
    console.error('Initialization failed:', error.message);
  }
}

// Start initialization
initializeBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
  console.log(`Webhook URL: ${VERCEL_URL}/api/bot`);
});

module.exports = app;
