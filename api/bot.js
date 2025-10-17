const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = `${process.env.VERCEL_URL}/api/bot`;

const bot = new TelegramBot(TELEGRAM_TOKEN);

// Хранилище контекста диалогов (в продакшене используйте БД)
const chatContexts = new Map();

// Инициализация вебхука
bot.setWebHook(WEBHOOK_URL);

app.post('/api/bot', async (req, res) => {
  try {
    const update = req.body;
    if (update.message) {
      await handleMessage(update.message);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing update:', error);
    res.sendStatus(500);
  }
});

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const username = bot.options.username;

  // Проверяем, обращаются ли к боту в группе
  const isGroup = msg.chat.type.includes('group');
  const isMentioned = isGroup && (text.includes(`@${username}`) || msg.reply_to_message?.from?.username === username);
  
  if (!isGroup || isMentioned) {
    try {
      // Получаем или инициализируем контекст
      if (!chatContexts.has(chatId)) {
        chatContexts.set(chatId, [
          { role: 'system', content: 'You are a helpful assistant in a Telegram group chat. Keep responses concise and natural.' }
        ]);
      }

      const context = chatContexts.get(chatId);
      
      // Добавляем сообщение пользователя в контекст
      const userMessage = text.replace(`@${username}`, '').trim();
      context.push({ role: 'user', content: userMessage });

      // Получаем ответ от OpenAI
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: context,
          max_tokens: 150,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const aiResponse = response.data.choices[0].message.content.trim();
      
      // Обновляем контекст и сохраняем ответ
      context.push({ role: 'assistant', content: aiResponse });
      
      // Ограничиваем размер контекста (последние 10 сообщений)
      if (context.length > 10) {
        context.splice(1, 2);
      }

      // Отправляем ответ в чат
      await bot.sendMessage(chatId, aiResponse, {
        reply_to_message_id: msg.message_id
      });

    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
      await bot.sendMessage(chatId, 'Произошла ошибка при обработке запроса', {
        reply_to_message_id: msg.message_id
      });
    }
  }
}

// Эндпоинт для проверки работоспособности
app.get('/api/bot', (req, res) => {
  res.json({ status: 'Bot is running!', timestamp: new Date().toISOString() });
});

module.exports = app;
