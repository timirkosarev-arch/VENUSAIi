
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const API_URL = "https://anymodel.org/v1/chat/completions";

const MODELS = Object.freeze({
  flash: "claude-haiku-5-5",
  high: "claude-sonnet-5-5"
});

const MAX_REQUEST_TOKENS = 30000;
const MAX_MESSAGES = 24;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const API_TIMEOUT_MS = Math.max(
  10000,
  Math.min(
    290000,
    Number(process.env.VENUS_API_TIMEOUT_MS) || 52000
  )
);

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function firebaseApp() {
  const old = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (old) return old;

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
    throw error(
      500,
      "Неверный FIREBASE_SERVICE_ACCOUNT_JSON."
    );
  }

  if (
    !account?.project_id ||
    !account?.client_email ||
    !account?.private_key
  ) {
    throw error(
      500,
      "Firebase Admin не настроен."
    );
  }

  if (!process.env.FIREBASE_DATABASE_URL) {
    throw error(
      500,
      "FIREBASE_DATABASE_URL не настроен."
    );
  }

  account.private_key =
    account.private_key.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert(account),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  }, "venus-ai-api");
}

async function authenticate(req) {
  const bearer = String(
    req.headers.authorization || ""
  ).match(/^Bearer\s+(.+)$/i)?.[1];

  if (!bearer) {
    throw error(
      401,
      "Войдите в Venus AI."
    );
  }

  try {
    return await getAuth(firebaseApp())
      .verifyIdToken(bearer);
  } catch {
    throw error(
      401,
      "Сессия истекла. Войдите в аккаунт заново."
    );
  }
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
    throw error(
      400,
      "Некорректная ссылка на фото."
    );
  }

  for (let i = 0; i < 5; i++) {
    if (!allowedImage(url)) {
      throw error(
        400,
        "Поддерживаются только ссылки ImgBB."
      );
    }

    const res = await fetch(url, {
      redirect: "manual",
      signal
    });

    if (
      [301, 302, 303, 307, 308].includes(res.status)
    ) {
      const next = res.headers.get("location");

      if (!next) {
        throw error(
          400,
          "Неверное перенаправление изображения."
        );
      }

      url = new URL(next, url);
      continue;
    }

    if (!res.ok) {
      throw error(
        502,
        `Ошибка ImgBB: ${res.status}.`
      );
    }

    const type = (
      res.headers.get("content-type") || ""
    ).split(";")[0].trim().toLowerCase();

    if (!IMAGE_MIME.has(type)) {
      throw error(
        400,
        "Тип фото не поддерживается."
      );
    }

    if (
      Number(
        res.headers.get("content-length") || 0
      ) > MAX_IMAGE_SIZE
    ) {
      throw error(
        413,
        "Изображение больше 5 МБ."
      );
    }

    if (!res.body) {
      throw error(
        502,
        "Фото пустое."
      );
    }

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > MAX_IMAGE_SIZE) {
          await reader.cancel();

          throw error(
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
      throw error(
        400,
        "Фото пустое."
      );
    }

    return (
      `data:${type};base64,` +
      Buffer.concat(chunks).toString("base64")
    );
  }

  throw error(
    400,
    "Слишком много перенаправлений ImgBB."
  );
}

async function normalizeContent(content, signal) {
  if (typeof content === "string") {
    if (content.length > 250000) {
      throw error(
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
        throw error(
          413,
          "Слишком длинный текст файла."
        );
      }

      result.push({
        type: "text",
        text: part.text
      });
    } else if (
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
          throw error(
            400,
            "Некорректное фото или превышен размер 5 МБ."
          );
        }
      } else {
        url = await convertImage(
          url,
          signal
        );
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

function tokenParamError(status, detail) {
  return (
    [400, 422].includes(status) &&
    /(?:max[_ -]?(?:completion[_ -]?)?tokens?|output.{0,20}tokens?|context.{0,20}length)/i
      .test(detail)
  );
}

async function upstreamError(res) {
  const raw = (
    await res.text()
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

function isQuotaFailure(status, detail) {
  if (
    status === 402 ||
    status === 429
  ) {
    return true;
  }

  return /(?:insufficient[_\s-]?(?:quota|balance|credit|credits|funds)|(?:quota|balance|credits?)[_\s-]?(?:exceeded|exhausted|depleted|used\s*up)|(?:out\s+of|no\s+more)[_\s-]?(?:tokens?|credits?|funds)|billing[_\s-]?(?:limit|exceeded)|(?:баланс|квота|кредит)[^\n]{0,45}(?:законч|исчерп|недостаточ))/i
    .test(String(detail || ""));
}

function upstreamErrorMessage(data) {
  const item = data?.error ?? data?.message ?? data;

  if (typeof item === "string") {
    return item.slice(0, 600);
  }

  return [
    item?.message,
    item?.code,
    item?.type
  ].filter(Boolean).join(" ").slice(0, 600) ||
    JSON.stringify(item).slice(0, 600);
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

  if (
    dataText &&
    dataText !== "[DONE]"
  ) {
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
      version: "venus-chat-visible-errors-v2"
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
      throw error(
        500,
        "API_KEY не настроен в Vercel."
      );
    }

    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      throw error(
        400,
        "Некорректный запрос."
      );
    }

    const aliases = {
      ...MODELS,
      "cc/claude-haiku-5-5": MODELS.flash,
      "cc/claude-sonnet-5-5": MODELS.high,
      "cx/gpt-6-luna": MODELS.flash,
      "cx/gpt-6-sol": MODELS.high,
      "cx/gpt-6.1-sol": MODELS.high,
      "cx/gpt-6-astra": MODELS.high,
      "cc/claude-opus-5-5": MODELS.high,
      astro: MODELS.high,
      pro: MODELS.high
    };

    const model = aliases[body.model] || body.model;

    if (!Object.values(MODELS).includes(model)) {
      throw error(
        400,
        "Неизвестная модель."
      );
    }

    stage = "firebase_auth";

    await authenticate(req);

    if (controller.signal.aborted) {
      throw error(
        503,
        "Время авторизации истекло."
      );
    }

    if (
      !Array.isArray(body.messages) ||
      !body.messages.length
    ) {
      throw error(
        400,
        "Нет сообщений."
      );
    }

    stage = "normalize_messages";

    const messages = [];

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

      const content = await normalizeContent(
        message.content,
        controller.signal
      );

      if (
        content &&
        (!Array.isArray(content) || content.length)
      ) {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (!messages.some(
      m => m.role === "user"
    )) {
      throw error(
        400,
        "Нет запроса пользователя."
      );
    }

    const requested = Number(body.max_tokens);

    const maxTokens =
      Number.isFinite(requested) && requested > 0
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
      throw error(
        500,
        "Укажи API_KEY в Vercel."
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
        const headers = {
          Authorization: `Bearer ${keys[keyIndex]}`,
          "Content-Type": "application/json",
          Accept: stream
            ? "text/event-stream"
            : "application/json"
        };

        upstream = await fetch(API_URL, {
          method: "POST",
          headers,
          signal: controller.signal,
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
              "[Venus API] API quota exhausted",
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

          throw error(
            upstream.status === 429 ? 429 : 502,
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

            console.warn(
              "[Venus API] API quota exhausted in SSE",
              { key: keyIndex + 1 }
            );

            await streamPeek.reader.cancel()
              .catch(() => {});

            streamPeek = null;

            continue keyLoop;
          }
        } else {
          const raw = await upstream.text();

          try {
            jsonData = JSON.parse(raw);
          } catch {
            throw error(
              502,
              "AnyModel вернул не JSON."
            );
          }

          if (jsonData?.error) {
            const reason =
              upstreamErrorMessage(jsonData);

            if (
              isQuotaFailure(
                200,
                reason
              )
            ) {
              quotaMessage = reason;

              console.warn(
                "[Venus API] API quota exhausted in JSON",
                { key: keyIndex + 1 }
              );

              jsonData = null;

              continue keyLoop;
            }

            throw error(
              502,
              `AnyModel: ${reason}`
            );
          }
        }

        chosenKeyIndex = keyIndex;

        break keyLoop;
      }

      throw error(
        502,
        `AnyModel: ${lastError ||
          "параметр max_tokens не поддерживается"}`
      );
    }

    if (chosenKeyIndex < 0) {
      if (quotaMessage) {
        throw error(
          429,
          keys.length === 1
            ? "Баланс или квота основного AnyModel API закончились. Добавь API_KEY_2 в Vercel."
            : "Баланс или квота закончились на обоих API-ключах AnyModel."
        );
      }

      throw error(
        502,
        `AnyModel: ${lastError ||
          "не удалось получить ответ"}`
      );
    }

    res.setHeader(
      "X-Venus-Key-Fallback",
      chosenKeyIndex > 0 ? "true" : "false"
    );

    const ct =
      upstream.headers.get("content-type") || "";

    if (
      streamPeek &&
      stream &&
      ct.includes("text/event-stream")
    ) {
      stage = "streaming";

      res.writeHead(200, {
        "Content-Type":
          "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      });

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

        if (
          controller.signal.aborted &&
          !res.destroyed
        ) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message:
                  "Время запроса истекло. Продолжи генерацию файла."
              }
            })}\n\n`
          );
        }
      } catch (e) {
        if (!res.destroyed) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message:
                  "Ответ прервался: " +
                  (e.message || "ошибка потока")
              }
            })}\n\n`
          );
        }
      } finally {
        streamPeek.reader.releaseLock();
      }

      return res.end();
    }

    stage = "json_response";

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.status(200).json(jsonData);
  } catch (e) {
    const timedOut =
      controller.signal.aborted ||
      e.name === "AbortError";

    const status = timedOut
      ? 503
      : (e.status || 500);

    const message = timedOut
      ? "Слишком долгий ответ модели; можно продолжить файл."
      : e.message || "Ошибка сервера.";

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
