
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const API_URL = "https://anymodel.org/v1/chat/completions";

const MODELS = {
  flash: "cx/gpt-6-luna",
  high: "cx/gpt-6-sol",
  astro: "cx/gpt-6-astra"
};

const ADMIN_EMAIL = "flexadssq@gmail.com";
const PRO_MS = 30 * 24 * 60 * 60 * 1000;

const TOTAL_TIMEOUT_MS = 23000;
const MAX_TOKENS_PER_CALL = 2048;
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 250000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

const normalEmail = value =>
  String(value || "").trim().toLowerCase();

const fail = (status, message) =>
  Object.assign(new Error(message), { status });

function getAdminApp() {
  const existing = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (existing) return existing;

  let credentials;

  try {
    credentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : {
          project_id: process.env.FIREBASE_PROJECT_ID,
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          private_key: process.env.FIREBASE_PRIVATE_KEY
        };
  } catch {
    throw fail(
      500,
      "Некорректный FIREBASE_SERVICE_ACCOUNT_JSON."
    );
  }

  if (
    !credentials?.project_id ||
    !credentials?.client_email ||
    !credentials?.private_key
  ) {
    throw fail(
      500,
      "Firebase Admin не настроен в Vercel."
    );
  }

  if (!process.env.FIREBASE_DATABASE_URL) {
    throw fail(
      500,
      "Отсутствует FIREBASE_DATABASE_URL."
    );
  }

  credentials.private_key =
    credentials.private_key.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert(credentials),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  }, "venus-ai-api");
}

function bounded(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(
      fail(503, "Превышено время запроса.")
    );
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(
      fail(503, "Превышено время запроса.")
    );

    signal.addEventListener("abort", onAbort, {
      once: true
    });

    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

async function authenticate(req, signal) {
  const token = String(
    req.headers.authorization || ""
  ).match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    throw fail(
      401,
      "Войдите в аккаунт Venus AI."
    );
  }

  try {
    return await bounded(
      getAuth(getAdminApp()).verifyIdToken(token, true),
      signal
    );
  } catch (error) {
    if (signal.aborted) {
      throw fail(
        503,
        "Проверка Firebase заняла слишком много времени."
      );
    }

    throw fail(
      401,
      "Сессия Firebase недействительна. Войдите заново."
    );
  }
}

async function checkPro(user, signal) {
  const snapshot = await bounded(
    getDatabase(getAdminApp())
      .ref(`venusPro/grants/${user.uid}`)
      .get(),
    signal
  );

  const g = snapshot.val();
  const start = Number(g?.grantedAt);
  const end = Number(g?.expiresAt);
  const now = Date.now();

  const valid = g &&
    normalEmail(g.email) === normalEmail(user.email) &&
    normalEmail(g.grantedBy) === ADMIN_EMAIL &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= now + 300000 &&
    end > now &&
    end > start &&
    end - start <= PRO_MS + 300000;

  if (!valid) {
    throw fail(
      403,
      "Для Pro High нужна активная подписка Pro."
    );
  }
}

function allowedImageUrl(url) {
  return url.protocol === "https:" &&
    ["i.ibb.co", "i.ibb.co.com"].includes(
      url.hostname.toLowerCase()
    );
}

async function imageToDataUrl(source, signal) {
  let url;

  try {
    url = new URL(source);
  } catch {
    throw fail(
      400,
      "Неверная ссылка на фото."
    );
  }

  for (let i = 0; i < 5; i++) {
    if (!allowedImageUrl(url)) {
      throw fail(
        400,
        "Разрешены только ссылки ImgBB."
      );
    }

    const response = await bounded(
      fetch(url, {
        redirect: "manual",
        headers: {
          Accept: "image/jpeg,image/png,image/webp,image/gif"
        },
        signal
      }),
      signal
    );

    if (
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");

      if (!location) {
        throw fail(
          400,
          "ImgBB вернул некорректный редирект."
        );
      }

      url = new URL(location, url);
      continue;
    }

    if (!response.ok) {
      throw fail(
        502,
        `ImgBB HTTP ${response.status}.`
      );
    }

    const type = (
      response.headers.get("content-type") || ""
    ).split(";")[0].trim();

    if (!IMAGE_TYPES.has(type)) {
      throw fail(
        400,
        "Неподдерживаемый тип изображения."
      );
    }

    if (
      Number(response.headers.get("content-length") || 0) >
      MAX_IMAGE_BYTES
    ) {
      throw fail(
        413,
        "Изображение превышает 5 МБ."
      );
    }

    if (!response.body) {
      throw fail(
        502,
        "ImgBB вернул пустое изображение."
      );
    }

    const reader = response.body.getReader();
    let total = 0;
    const chunks = [];

    try {
      while (true) {
        const { done, value } = await bounded(
          reader.read(),
          signal
        );

        if (done) break;

        total += value.byteLength;

        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();

          throw fail(
            413,
            "Изображение превышает 5 МБ."
          );
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    if (!total) {
      throw fail(
        502,
        "ImgBB вернул пустой файл."
      );
    }

    return (
      `data:${type};base64,` +
      Buffer.concat(chunks).toString("base64")
    );
  }

  throw fail(
    400,
    "Слишком много редиректов ImgBB."
  );
}

async function cleanContent(content, signal) {
  if (typeof content === "string") {
    return content.slice(0, MAX_CONTENT_CHARS);
  }

  if (!Array.isArray(content)) return null;

  const parts = [];

  for (const item of content) {
    if (
      item?.type === "text" &&
      typeof item.text === "string"
    ) {
      parts.push({
        type: "text",
        text: item.text.slice(0, MAX_CONTENT_CHARS)
      });

      continue;
    }

    if (
      item?.type !== "image_url" ||
      typeof item.image_url?.url !== "string"
    ) {
      continue;
    }

    let url = item.image_url.url;

    if (url.startsWith("data:")) {
      const match = url.match(
        /^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=]+)$/i
      );

      if (
        !match ||
        Buffer.from(match[2], "base64").length >
        MAX_IMAGE_BYTES
      ) {
        throw fail(
          400,
          "Некорректное изображение или размер превышает 5 МБ."
        );
      }
    } else {
      url = await imageToDataUrl(url, signal);
    }

    parts.push({
      type: "image_url",
      image_url: {
        url,
        detail: "auto"
      }
    });
  }

  return parts.length ? parts : null;
}

function readText(data) {
  const message = data?.choices?.[0]?.message;
  const value = message?.content;

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(
      part => part?.text || ""
    ).join("");
  }

  return "";
}

function describeError(error, signal) {
  if (
    signal.aborted ||
    error?.name === "AbortError"
  ) {
    return {
      status: 503,
      message: "Ответ слишком долгий. Venus AI может повторить запрос меньшей частью."
    };
  }

  return {
    status: error?.status || 500,
    message: error?.message ||
      "Ошибка сервера Venus AI."
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: "venus-timeout-fix-2"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const started = Date.now();
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TOTAL_TIMEOUT_MS
  );

  let stage = "start";

  try {
    if (!process.env.API_KEY) {
      throw fail(
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
      throw fail(
        400,
        "Некорректное тело запроса."
      );
    }

    const aliases = {
      ...MODELS,
      "cx/gpt-6.1-sol": MODELS.high
    };

    const model =
      aliases[body.model] || body.model;

    if (!Object.values(MODELS).includes(model)) {
      throw fail(
        400,
        "Неизвестная модель."
      );
    }

    stage = "firebase_auth";

    const user = await authenticate(
      req,
      controller.signal
    );

    if (model === MODELS.astro) {
      stage = "pro_check";

      await checkPro(
        user,
        controller.signal
      );
    }

    if (
      !Array.isArray(body.messages) ||
      !body.messages.length
    ) {
      throw fail(
        400,
        "Нет сообщений."
      );
    }

    stage = "messages";

    const messages = [];

    for (const msg of body.messages.slice(-MAX_MESSAGES)) {
      if (
        !["system", "user", "assistant"].includes(msg?.role)
      ) {
        continue;
      }

      const content = await cleanContent(
        msg.content,
        controller.signal
      );

      if (
        content !== null &&
        content !== "" &&
        (!Array.isArray(content) || content.length)
      ) {
        messages.push({
          role: msg.role,
          content
        });
      }
    }

    if (!messages.some(m => m.role === "user")) {
      throw fail(
        400,
        "Нет сообщения пользователя."
      );
    }

    const requested = Number(body.max_tokens);

    const maxTokens =
      Number.isFinite(requested) && requested > 0
        ? Math.min(
            MAX_TOKENS_PER_CALL,
            Math.floor(requested)
          )
        : MAX_TOKENS_PER_CALL;

    const stream = body.stream === true;

    const payload = {
      model,
      messages,
      stream,
      max_tokens: maxTokens
    };

    const headers = {
      Authorization: `Bearer ${process.env.API_KEY}`,
      "Content-Type": "application/json",
      Accept: stream
        ? "text/event-stream"
        : "application/json"
    };

    stage = "anymodel";

    let response;
    let upstreamError = "";

    for (const limit of [
      ...new Set(
        [maxTokens, 1024, 512].filter(n => n <= maxTokens)
      )
    ]) {
      payload.max_tokens = limit;

      response = await bounded(
        fetch(API_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        }),
        controller.signal
      );

      if (response.ok) break;

      upstreamError = (
        await bounded(
          response.text(),
          controller.signal
        )
      ).slice(0, 600);

      if (
        !(
          [400, 422].includes(response.status) &&
          /(?:max[_ -]?(?:completion[_ -]?)?tokens?|output.{0,20}tokens?|context.{0,20}length)/i.test(upstreamError)
        )
      ) {
        throw fail(
          502,
          `AnyModel HTTP ${response.status}: ${upstreamError}`
        );
      }
    }

    if (!response?.ok) {
      throw fail(
        502,
        `AnyModel: ${upstreamError || "ошибка модели"}`
      );
    }

    const type =
      response.headers.get("content-type") || "";

    if (
      stream &&
      type.includes("text/event-stream") &&
      response.body
    ) {
      stage = "streaming";

      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
      );

      res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
      );

      res.setHeader(
        "X-Accel-Buffering",
        "no"
      );

      try {
        let sentBytes = 0;

        for await (const chunk of response.body) {
          if (
            controller.signal.aborted ||
            res.destroyed
          ) {
            break;
          }

          sentBytes += chunk.byteLength;
          res.write(chunk);
        }

        if (!sentBytes && !res.destroyed) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: "Модель вернула пустой поток. Повторите запрос."
              }
            })}\n\n`
          );
        }
      } catch (error) {
        const info = describeError(
          error,
          controller.signal
        );

        if (!res.destroyed) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: info.message
              }
            })}\n\n`
          );
        }
      }

      return res.end();
    }

    stage = "json_response";

    const raw = await bounded(
      response.text(),
      controller.signal
    );

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      throw fail(
        502,
        "AnyModel вернул некорректный JSON."
      );
    }

    if (data?.error) {
      throw fail(
        502,
        String(
          data.error.message || data.error
        ).slice(0, 500)
      );
    }

    if (!readText(data).trim()) {
      throw fail(
        502,
        "Модель вернула пустой ответ. Повторите меньшей частью."
      );
    }

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.status(200).json(data);

  } catch (error) {
    const info = describeError(
      error,
      controller.signal
    );

    console.error("[Venus API]", {
      stage,
      elapsedMs: Date.now() - started,
      status: info.status,
      message: info.message
    });

    if (res.headersSent) {
      return res.end();
    }

    return res.status(info.status).json({
      error: info.message,
      stage
    });

  } finally {
    clearTimeout(timer);
  }
}
