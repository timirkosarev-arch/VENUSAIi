const MODEL = 'google/gemma-4-26b-a4b-it:free';
const SYSTEM = `Ты — Venus AI, полезный и внимательный ИИ-помощник на основе Google Gemma.
Отвечай на языке пользователя, понятно и по делу. Используй Markdown для оформления.
Анализируй прикреплённые изображения. Если текст на фото неразборчив, честно скажи об этом.
Не представляй себя ChatGPT или продуктом OpenAI. Не выдумывай выполненные действия,
доступ к интернету, результаты поиска или факты, которых не знаешь.`;

function error(message, status = 400) {
  return Response.json({ error: message }, {
    status, headers: { 'Cache-Control': 'no-store' }
  });
}

function imageURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'i.ibb.co' &&
      !u.username && !u.password && !u.port;
  } catch { return false; }
}

function normalize(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) {
    throw new Error('Отправьте от 1 до 40 сообщений.');
  }
  let size = 0;
  let images = 0;
  const cleaned = messages.map(m => {
    if (!m || !['user', 'assistant'].includes(m.role)) {
      throw new Error('Недопустимая роль сообщения.');
    }
    if (typeof m.content === 'string') {
      const limit = m.role === 'user' ? 30000 : 110000;
      if (!m.content.trim() || m.content.length > limit) {
        throw new Error('Сообщение пустое или слишком длинное.');
      }
      size += m.content.length;
      return { role: m.role, content: m.content };
    }
    if (m.role !== 'user' || !Array.isArray(m.content) ||
        !m.content.length || m.content.length > 5) {
      throw new Error('Некорректное содержимое сообщения.');
    }
    const content = m.content.map(p => {
      if (p?.type === 'text' && typeof p.text === 'string' &&
          p.text.trim() && p.text.length <= 30000) {
        size += p.text.length;
        return { type: 'text', text: p.text };
      }
      if (p?.type === 'image_url' && imageURL(p.image_url?.url)) {
        images++;
        return { type: 'image_url', image_url: { url: p.image_url.url } };
      }
      throw new Error('Прикрепите изображение через кнопку «+».');
    });
    return { role: 'user', content };
  });
  if (size > 120000 || images > 24) {
    throw new Error('Слишком большой контекст. Начните новый чат.');
  }
  if (cleaned.at(-1).role !== 'user') {
    throw new Error('Последнее сообщение должно быть от пользователя.');
  }
  return cleaned;
}

function providerError(status) {
  if (status === 401) return 'API отклонил ключ. Проверьте API_KEY и адрес API в Vercel.';
  if (status === 402) return 'Провайдер требует пополнить баланс или изменить лимит ключа.';
  if (status === 403) return 'Провайдер запретил запрос. Проверьте доступ к модели и настройки данных.';
  if (status === 404) return `Модель ${MODEL} недоступна у выбранного провайдера.`;
  if (status === 429) return 'Лимит бесплатной модели исчерпан. Попробуйте позже.';
  if (status >= 500) return 'Сервис модели временно недоступен. Попробуйте ещё раз.';
  return `Провайдер отклонил запрос (${status}). Попробуйте новый чат или другое фото.`;
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return error('Запрос разрешён только с этого сайта.', 403);
  }
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return error('Ожидается application/json.', 415);
  }
  const key = (process.env.OPENROUTER_API_KEY || process.env.API_KEY || '').trim();
  if (!key) return error('Добавьте API_KEY или OPENROUTER_API_KEY в Vercel и выполните Redeploy.', 503);
  let messages;
  try {
    if (Number(request.headers.get('content-length')) > 250000) {
      return error('Запрос слишком большой.', 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 250000) {
      return error('Запрос слишком большой.', 413);
    }
    messages = normalize(JSON.parse(raw).messages);
  } catch (e) {
    return error(e instanceof SyntaxError ? 'Некорректный JSON запроса.' : e.message);
  }

  const base = (process.env.API_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const endpoint = process.env.API_URL || `${base}/chat/completions`;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch {
    return error('API_URL должен содержать полный HTTPS-адрес chat/completions.', 503);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(275000)]);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Title': 'Venus AI'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
        stream: true,
        max_tokens: 8192
      }),
      signal
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      console.error('chat upstream status:', upstream.status);
      return error(providerError(upstream.status), upstream.status);
    }
    const type = upstream.headers.get('content-type') || '';
    if (type.includes('text/event-stream') && upstream.body) {
      return new Response(upstream.body, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, no-transform',
          'X-Accel-Buffering': 'no'
        }
      });
    }
    if (type.includes('application/json')) {
      const data = await upstream.json();
      if (data.error) return error(providerError(Number(data.error.code) || 502), 502);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return Response.json({ content }, { headers: { 'Cache-Control': 'no-store' } });
      }
    } else {
      await upstream.body?.cancel();
    }
    return error('API вернул пустой ответ или HTML вместо ответа модели. Проверьте API_URL.', 502);
  } catch (e) {
    if (request.signal.aborted) return error('Запрос остановлен.', 499);
    if (signal.aborted) return error('Модель не ответила вовремя. Попробуйте ещё раз.', 504);
    console.error('chat network failure:', e.name);
    return error('Не удалось связаться с API. Проверьте адрес сервиса в Vercel.', 502);
  }
}
