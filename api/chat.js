
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const API_URL = "https://tooken.club/v1/chat/completions";
const MODEL = "ds/deepseek-v4-flash-vision";

const VENUS_SYSTEM_PROMPT = `
Ты Venus — технический специалист, инженер и разработчик Venus AI.

## Стиль общения

- Общайся на русском, если пользователь не попросил другой язык.
- Пиши прямо, понятно и без лишних вступлений.
- Используй дружелюбный, уверенный стиль общения на равных.
- Для коротких вопросов давай короткие ответы.
- Для сложных задач предоставляй законченные решения.
- Учитывай опечатки, сокращения и неправильную раскладку клавиатуры.
- Не задавай лишних вопросов, если задача понятна.
- Не выдумывай факты, результаты тестирования или содержимое файлов.
- По умолчанию можешь начинать ответ с «Venus ·».

## Программирование

- Если пользователь просит код, предоставляй рабочую реализацию.
- Не используй фиктивные заглушки, TODO и пропущенные части.
- Для одного файла предоставляй полный код.
- Для нескольких файлов показывай структуру проекта и содержимое файлов.
- Используй блоки Markdown с названием языка.
- Если пользователь просит только код, отвечай только кодом.
- Сохраняй существующий интерфейс и функциональность при доработке проектов.
- Учитывай предоставленные исходные файлы.
- Для веб-приложений обеспечивай адаптацию под телефон и плавные анимации.
- Проверяй согласованность импортов, функций, переменных и обработчиков.
- Не вставляй секретные API-ключи в публичный код.
- Не называй незавершённый проект готовым.
- Если код большой, предоставляй законченные файлы по частям.

## Работа с проектами

- Используй исходный код, если он предоставлен.
- Не утверждай, что видел файл, которого нет в контексте.
- Исправляй причину ошибок, а не только их сообщения.
- Не удаляй рабочие функции без необходимости.
- Сохраняй историю решений внутри текущего диалога.
- Если пользователь пишет «продолжи», продолжай предыдущую работу.
- Если пользователь пишет «desk», подготовь новую реализацию по контексту.

## Точность и безопасность

- Давай конкретные и проверяемые решения.
- Не утверждай, что выполнил тестирование, если его не было.
- Помогай с разработкой, отладкой, защитой и исследованием систем.
- Соблюдай применимые правила безопасности.
- Не раскрывай чужие секреты и персональные данные.

## Формат ответа

- Минимум вступления.
- Основной результат сразу.
- Код в обычных блоках Markdown.
- Пояснения только когда они необходимы.
`;

const MAX_REQUEST_TOKENS = 30000;
const MAX_MESSAGES = 24;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const API_TIMEOUT_MS = Math.max(
  10000,
  Math.min(
    270000,
    Number(process.env.VENUS_API_TIMEOUT_MS) || 240000
  )
);

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function createError(status, message) {
  return Object.assign(new Error(message), { status });
}

function firebaseApp() {
  const existing = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (existing) return existing;

  let account;

  try {
    account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : {
          project_id: process.env.FIREBASE_PROJECT_ID,
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          private_key: process.env.FIREBASE_PRIVATE_KEY
        };
  } catch {
    throw createError(
      500,
      "Неверный FIREBASE_SERVICE_ACCOUNT_JSON."
    );
  }

  if (
    !account?.project_id ||
    !account?.client_email ||
    !account?.private_key
  ) {
    throw createError(
      500,
      "Firebase Admin не настроен."
    );
  }

  account.private_key = account.private_key.replace(
    /\\n/g,
    "\n"
  );

  return initializeApp(
    {
      credential: cert(account),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    },
    "venus-ai-api"
  );
}

async function authenticate(req) {
  const bearer = String(
    req.headers.authorization || ""
  ).match(/^Bearer\s+(.+)$/i)?.[1];

  if (!bearer) {
    throw createError(401, "Токен отсутствует.");
  }

  try {
    return await getAuth(firebaseApp()).verifyIdToken(
      bearer
    );
  } catch {
    throw createError(
      401,
      "Сессия истекла. Войдите заново."
    );
  }
}

const guestHits = new Map();
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const GUEST_REQUESTS_PER_HOUR = 30;

function enforceGuestLimit(req, res) {
  const ip = String(
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  )
    .split(",")[0]
    .trim()
    .slice(0, 128);

  const now = Date.now();

  if (guestHits.size > 5000) {
    for (const [key, value] of guestHits) {
      if (now - value.start >= GUEST_WINDOW_MS) {
        guestHits.delete(key);
      }
    }

    if (guestHits.size > 5000) {
      guestHits.clear();
    }
  }

  const previous = guestHits.get(ip);

  const entry =
    !previous ||
    now - previous.start >= GUEST_WINDOW_MS
      ? { start: now, count: 0 }
      : previous;

  if (entry.count >= GUEST_REQUESTS_PER_HOUR) {
    const retry = Math.max(
      1,
      Math.ceil(
        (
          GUEST_WINDOW_MS -
          (now - entry.start)
        ) / 1000
      )
    );

    res.setHeader("Retry-After", String(retry));

    throw createError(
      429,
      "Гостевой лимит запросов исчерпан. Попробуйте позже."
    );
  }

  entry.count++;

  guestHits.set(ip, entry);
}

function allowedImage(url) {
  return (
    url.protocol === "https:" &&
    ["i.ibb.co", "i.ibb.co.com"].includes(
      url.hostname.toLowerCase()
    )
  );
}

async function convertImage(link, signal) {
  let url;

  try {
    url = new URL(link);
  } catch {
    throw createError(
      400,
      "Некорректная ссылка на фото."
    );
  }

  for (let i = 0; i < 5; i++) {
    if (!allowedImage(url)) {
      throw createError(
        400,
        "Поддерживаются только ссылки ImgBB."
      );
    }

    const response = await fetch(url, {
      redirect: "manual",
      signal
    });

    if (
      [301, 302, 303, 307, 308].includes(
        response.status
      )
    ) {
      const next = response.headers.get("location");

      if (!next) {
        throw createError(
          400,
          "Неверное перенаправление изображения."
        );
      }

      url = new URL(next, url);
      continue;
    }

    if (!response.ok) {
      throw createError(
        502,
        `Ошибка ImgBB: ${response.status}.`
      );
    }

    const type = (
      response.headers.get("content-type") || ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!IMAGE_MIME.has(type)) {
      throw createError(
        400,
        "Тип фото не поддерживается."
      );
    }

    if (
      Number(
        response.headers.get("content-length") || 0
      ) > MAX_IMAGE_SIZE
    ) {
      throw createError(
        413,
        "Изображение больше 5 МБ."
      );
    }

    if (!response.body) {
      throw createError(502, "Фото пустое.");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > MAX_IMAGE_SIZE) {
          await reader.cancel();

          throw createError(
            413,
            "Изображение больше 5 МБ."
          );
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    if (!size) {
      throw createError(
        400,
        "Фото пустое."
      );
    }

    return (
      `data:${type};base64,` +
      Buffer.concat(chunks).toString("base64")
    );
  }

  throw createError(
    400,
    "Слишком много перенаправлений ImgBB."
  );
}

async function normalizeContent(content, signal) {
  if (typeof content === "string") {
    if (content.length > 250000) {
      throw createError(
        413,
        "Слишком длинное сообщение."
      );
    }

    return content;
  }

  if (!Array.isArray(content)) return null;

  const result = [];

  for (const part of content) {
    if (
      part?.type === "text" &&
      typeof part.text === "string"
    ) {
      if (part.text.length > 250000) {
        throw createError(
          413,
          "Слишком длинный текст файла."
        );
      }

      result.push({
        type: "text",
        text: part.text
      });
    }

    if (
      part?.type === "image_url" &&
      typeof part.image_url?.url === "string"
    ) {
      let url = part.image_url.url;

      if (url.startsWith("data:")) {
        const match = url.match(
          /^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=]+)$/i
        );

        if (
          !match ||
          Buffer.from(
            match[2],
            "base64"
          ).length > MAX_IMAGE_SIZE
        ) {
          throw createError(
            400,
            "Некорректное фото или превышен размер 5 МБ."
          );
        }
      } else {
        url = await convertImage(url, signal);
      }

      result.push({
        type: "image_url",
        image_url: {
          url,
          detail: "auto"
        }
      });
    }
  }

  return result.length ? result : null;
}

function isQuotaFailure(status, detail) {
  if (status === 402 || status === 429) {
    return true;
  }

  return /(?:insufficient[_\s-]?(?:quota|balance|credit|credits|funds)|(?:quota|balance|credits?)[_\s-]?(?:exceeded|exhausted|depleted|used\s*up)|(?:out\s+of|no\s+more)[_\s-]?(?:tokens?|credits?|funds)|billing[_\s-]?(?:limit|exceeded)|(?:баланс|квота|кредит)[^\n]{0,45}(?:законч|исчерп|недостаточ))/i.test(
    String(detail || "")
  );
}

function tokenParamError(status, detail) {
  return (
    [400, 422].includes(status) &&
    /(?:max[_ -]?(?:completion[_ -]?)?tokens?|output.{0,20}tokens?|context.{0,20}length)/i.test(
      detail
    )
  );
}

async function upstreamError(response) {
  const raw = (
    await response.text()
  ).slice(0, 1200);

  try {
    const parsed = JSON.parse(raw);

    return String(
      parsed.error?.message ||
      parsed.error ||
      parsed.message ||
      raw
    ).slice(0, 600);
  } catch {
    return raw.slice(0, 600);
  }
}

function upstreamErrorMessage(data) {
  const item = data?.error ?? data?.message ?? data;

  if (typeof item === "string") {
    return item.slice(0, 600);
  }

  return (
    [
      item?.message,
      item?.code,
      item?.type
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 600) ||
    JSON.stringify(item).slice(0, 600)
  );
}

async function peekSse(response) {
  const reader = response.body.getReader();
  const pending = [];
  const decoder = new TextDecoder();

  let prefix = "";
  let done = false;

  while (prefix.length < 16384) {
    const result = await reader.read();

    done = result.done;

    if (done) break;

    pending.push(result.value);

    prefix += decoder.decode(
      result.value,
      { stream: true }
    );

    if (/\r?\n\r?\n/.test(prefix)) {
      break;
    }
  }

  const firstEvent = prefix.split(
    /\r?\n\r?\n/,
    1
  )[0];

  const dataText = firstEvent
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");

  if (dataText && dataText !== "[DONE]") {
    try {
      const event = JSON.parse(dataText);

      if (event?.error) {
        const reason = upstreamErrorMessage(event);

        return {
          reader,
          pending,
          done,
          reason,
          quota: isQuotaFailure(200, reason)
        };
      }
    } catch {}
  }

  return {
    reader,
    pending,
    done,
    reason: "",
    quota: false
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: "venus-user-prompt-v8"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      error: "Метод не поддерживается."
    });
  }

  const began = Date.now();
  let stage = "start";

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS
  );

  try {
    if (!process.env.API_KEY) {
      throw createError(
        500,
        "API_KEY не настроен в Vercel."
      );
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      throw createError(
        400,
        "Некорректный запрос."
      );
    }

    // Модель закреплена на сервере.
    const model = MODEL;

    stage = "visitor_access";

    const authorization = String(
      req.headers.authorization || ""
    ).trim();

    if (authorization) {
      if (!/^Bearer\s+\S+$/i.test(authorization)) {
        throw createError(
          401,
          "Неверный формат токена авторизации."
        );
      }

      await authenticate(req);
    } else {
      enforceGuestLimit(req, res);
    }

    if (controller.signal.aborted) {
      throw createError(
        503,
        "Время ожидания истекло."
      );
    }

    if (
      !Array.isArray(body.messages) ||
      !body.messages.length
    ) {
      throw createError(
        400,
        "Нет сообщений."
      );
    }

    stage = "normalize_messages";

    const messages = [
      {
        role: "system",
        content: VENUS_SYSTEM_PROMPT
      }
    ];

    let userStylePreferences = "";

    for (
      const message of body.messages.slice(-MAX_MESSAGES)
    ) {
      if (
        !["system", "user", "assistant"].includes(
          message?.role
        )
      ) {
        continue;
      }

      if (message.role === "system") {
        if (typeof message.content === "string") {
          userStylePreferences =
            message.content.slice(0, 6000);
        }

        continue;
      }

      const content = await normalizeContent(
        message.content,
        controller.signal
      );

      if (
        content &&
        (
          !Array.isArray(content) ||
          content.length
        )
      ) {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (
      !messages.some(message => message.role === "user")
    ) {
      throw createError(
        400,
        "Нет запроса пользователя."
      );
    }

    if (
      userStylePreferences &&
      userStylePreferences !== VENUS_SYSTEM_PROMPT
    ) {
      messages.splice(1, 0, {
        role: "user",
        content:
          "Дополнительные пожелания к стилю ответа, " +
          "совместимые с основной инструкцией:\n" +
          userStylePreferences
      });
    }

    const requested = Number(body.max_tokens);

    const maxTokens =
      Number.isFinite(requested) &&
      requested > 0
        ? Math.min(
            Math.floor(requested),
            MAX_REQUEST_TOKENS
          )
        : 3072;

    const stream = body.stream === true;

    const keys = [
      process.env.API_KEY,
      process.env.API_KEY_2
    ]
      .map(value => String(value || "").trim())
      .filter(
        (value, index, arr) =>
          value && arr.indexOf(value) === index
      );

    if (!keys.length) {
      throw createError(
        500,
        "API-ключи не настроены."
      );
    }

    const budgets = [
      ...new Set(
        [maxTokens, 3072, 2048, 1024]
          .filter(n => n <= maxTokens)
      )
    ];

    let upstream = null;
    let streamPeek = null;
    let jsonData = null;

    let chosenKeyIndex = -1;
    let quotaMessage = "";
    let lastError = "";

    stage = "anymodel";

    keyLoop:
    for (
      let keyIndex = 0;
      keyIndex < keys.length;
      keyIndex++
    ) {
      for (const tokens of budgets) {
        upstream = await fetch(API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${keys[keyIndex]}`,
            "Content-Type": "application/json",
            Accept: stream
              ? "text/event-stream"
              : "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            stream,
            max_tokens: tokens
          })
        });

        if (!upstream.ok) {
          lastError = await upstreamError(upstream);

          if (
            isQuotaFailure(
              upstream.status,
              lastError
            )
          ) {
            quotaMessage = lastError;

            console.warn(
              "[Venus API] Quota exhausted",
              {
                key: keyIndex + 1,
                status: upstream.status
              }
            );

            continue keyLoop;
          }

          if (
            tokenParamError(
              upstream.status,
              lastError
            )
          ) {
            continue;
          }

          throw createError(
            502,
            `AnyModel ${upstream.status}: ${lastError}`
          );
        }

        const contentType =
          upstream.headers.get("content-type") || "";

        if (
          stream &&
          contentType.includes("text/event-stream") &&
          upstream.body
        ) {
          streamPeek = await peekSse(upstream);

          if (streamPeek.quota) {
            quotaMessage = streamPeek.reason;

            await streamPeek.reader
              .cancel()
              .catch(() => {});

            streamPeek = null;

            continue keyLoop;
          }
        } else {
          const raw = await upstream.text();

          try {
            jsonData = JSON.parse(raw);
          } catch {
            throw createError(
              502,
              "AnyModel вернул не JSON."
            );
          }

          if (jsonData?.error) {
            const reason =
              upstreamErrorMessage(jsonData);

            if (isQuotaFailure(200, reason)) {
              quotaMessage = reason;
              jsonData = null;

              continue keyLoop;
            }

            throw createError(
              502,
              `AnyModel: ${reason}`
            );
          }
        }

        chosenKeyIndex = keyIndex;

        break keyLoop;
      }

      throw createError(
        502,
        `AnyModel: ${
          lastError ||
          "параметр max_tokens не поддерживается"
        }`
      );
    }

    if (chosenKeyIndex < 0) {
      if (quotaMessage) {
        throw createError(
          429,
          keys.length === 1
            ? "Баланс основного API закончился. Настрой API_KEY_2."
            : "Баланс или квота закончились на обоих API-ключах."
        );
      }

      throw createError(
        502,
        `AnyModel: ${
          lastError ||
          "Не удалось получить ответ."
        }`
      );
    }

    res.setHeader(
      "X-Venus-Key-Fallback",
      chosenKeyIndex > 0 ? "true" : "false"
    );

    const contentType =
      upstream.headers.get("content-type") || "";

    if (
      streamPeek &&
      stream &&
      contentType.includes("text/event-stream")
    ) {
      stage = "streaming";

      res.writeHead(200, {
        "Content-Type":
          "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      });

      const heartbeat = setInterval(() => {
        if (
          !res.destroyed &&
          !res.writableEnded
        ) {
          res.write(": venus-ping\n\n");
        }
      }, 15000);

      let errorSent = false;

      const reportStreamError = message => {
        if (
          errorSent ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }

        errorSent = true;

        res.write(
          `data: ${JSON.stringify({
            error: { message }
          })}\n\n`
        );
      };

      try {
        for (const chunk of streamPeek.pending) {
          if (
            !res.destroyed &&
            !controller.signal.aborted
          ) {
            res.write(chunk);
          }
        }

        let done = streamPeek.done;

        while (
          !done &&
          !res.destroyed &&
          !controller.signal.aborted
        ) {
          const part =
            await streamPeek.reader.read();

          done = part.done;

          if (!done) {
            res.write(part.value);
          }
        }

        if (controller.signal.aborted) {
          reportStreamError(
            "Время ожидания AnyModel истекло. " +
            "Полученный текст сохранён."
          );
        }
      } catch (e) {
        if (
          controller.signal.aborted ||
          e?.name === "AbortError"
        ) {
          reportStreamError(
            "Превышено время ожидания AnyModel. " +
            "Полученный текст сохранён."
          );
        } else {
          reportStreamError(
            "Соединение с AnyModel прервалось: " +
            (e?.message || "ошибка сети")
          );
        }
      } finally {
        clearInterval(heartbeat);

        try {
          streamPeek.reader.releaseLock();
        } catch {}
      }

      if (
        !res.writableEnded &&
        !res.destroyed
      ) {
        res.end();
      }

      return;
    }

    stage = "json_response";

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json(jsonData);
  } catch (e) {
    const timedOut =
      controller.signal.aborted ||
      e?.name === "AbortError";

    const status = timedOut
      ? 503
      : (e.status || 500);

    const message = timedOut
      ? "AnyModel не завершил ответ до установленного времени ожидания."
      : (e.message || "Ошибка сервера.");

    console.error("[Venus API]", {
      stage,
      elapsedMs: Date.now() - began,
      status,
      message
    });

    if (res.headersSent) {
      if (!res.destroyed) {
        try {
          res.write(
            `data: ${JSON.stringify({
              error: { message }
            })}\n\n`
          );
        } catch {}
      }

      return res.end();
    }

    return res.status(status).json({
      error: message,
      stage
    });
  } finally {
    clearTimeout(timer);
  }
}
