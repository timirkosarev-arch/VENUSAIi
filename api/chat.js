
export const config = {
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const API_KEY = process.env.API_KEY;

    if (!API_KEY) {
      return res.status(500).json({ error: 'API_KEY не настроен в Vercel' });
    }

    const { messages } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'Нет сообщений' });
    }

    const safeMessages = messages
      .filter(m =>
        ['user', 'assistant'].includes(m.role) &&
        typeof m.content === 'string'
      )
      .slice(-30);

    const response = await fetch(
      'https://anymodel.org/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'am/nemotron-3-ultra-550b-a55b',
          messages: safeMessages,
          stream: true
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('API ERROR:', response.status, error);

      return res.status(502).json({
        error: `Ошибка API ${response.status}: ${error.slice(0, 400)}`
      });
    }

    if (!response.body) {
      return res.status(502).json({ error: 'Пустой ответ API' });
    }

    const type = response.headers.get('content-type') || '';

    if (!type.includes('text/event-stream')) {
      const error = await response.text();

      return res.status(502).json({
        error: 'API вернул не SSE: ' + error.slice(0, 300)
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    for await (const chunk of response.body) {
      res.write(chunk);
    }

    res.end();

  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: error.message || 'Ошибка сервера'
      });
    }

    res.end();
  }
}
