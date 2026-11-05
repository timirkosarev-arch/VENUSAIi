
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const API_URL = "https://anymodel.org/v1/chat/completions";
const ADMIN_EMAIL = "flexadssq@gmail.com";
const PRO_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 250000;

const MODELS = {
  flash: "cx/gpt-6-luna",
  high: "cx/gpt-6.1-sol",
  astro: "cx/gpt-6-astra",
  "cx/gpt-6-luna": "cx/gpt-6-luna",
  "cx/gpt-6.1-sol": "cx/gpt-6.1-sol",
  "cx/gpt-6-astra": "cx/gpt-6-astra"
};

const PRO_MODEL = "cx/gpt-6-astra";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getFirebaseApp() {
  const existing = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (existing) return existing;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_MISSING");
  if (!databaseURL) throw new Error("FIREBASE_DATABASE_URL_MISSING");

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_INVALID");
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL
  }, "venus-ai-api");
}

function getBearerToken(req) {
  const header =
    req.headers?.authorization ||
    req.headers?.Authorization ||
    "";

  const match = String(header).match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

async function verifyUser(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error("UNAUTHORIZED");
    error.statusCode = 401;
    throw error;
  }

  const app = getFirebaseApp();

  try {
    return await getAuth(app).verifyIdToken(token, true);
  } catch {
    const error = new Error("INVALID_FIREBASE_TOKEN");
    error.statusCode = 401;
    throw error;
  }
}

async function hasActivePro(user) {
  const email = normalizeEmail(user.email);

  if (email === ADMIN_EMAIL) return true;
  if (!user.uid || !email) return false;

  const app = getFirebaseApp();

  const snapshot = await getDatabase(app)
    .ref(`venusPro/grants/${user.uid}`)
    .get();

  if (!snapshot.exists()) return false;

  const grant = snapshot.val();

  const grantedAt = Number(grant?.grantedAt);
  const expiresAt = Number(grant?.expiresAt);
  const now = Date.now();

  return Boolean(
    grant &&
    normalizeEmail(grant.email) === email &&
    normalizeEmail(grant.grantedBy) === ADMIN_EMAIL &&
    Number.isFinite(grantedAt) &&
    Number.isFinite(expiresAt) &&
    grantedAt <= now + 300000 &&
    expiresAt > now &&
    expiresAt > grantedAt &&
    expiresAt - grantedAt <= PRO_DURATION_MS + 300000
  );
}

function isImgBBHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  return (
    host === "ibb.co" ||
    host === "www.ibb.co" ||
    host === "i.ibb.co" ||
    host.endsWith(".ibb.co")
  );
}

async function fetchImgBBResponse(sourceUrl) {
  let current;

  try {
    current = new URL(sourceUrl);
  } catch {
    throw new Error("INVALID_IMAGE_URL");
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    if (
      current.protocol !== "https:" ||
      !isImgBBHost(current.hostname)
    ) {
      throw new Error("IMAGE_HOST_NOT_ALLOWED");
    }

    const response = await fetch(current, {
      method: "GET",
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/gif"
      },
      redirect: "manual"
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");

      if (!location) {
        throw new Error("INVALID_IMAGE_REDIRECT");
      }

      current = new URL(location, current);
      continue;
    }

    return response;
  }

  throw new Error("TOO_MANY_IMAGE_REDIRECTS");
}

async function fetchImgBBAsDataUrl(sourceUrl) {
  const response = await fetchImgBBResponse(sourceUrl);

  if (!response.ok) {
    throw new Error(`IMGBB_HTTP_${response.status}`);
  }

  const contentType = (
    response.headers.get("content-type") || ""
  ).split(";")[0].trim().toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error("UNSUPPORTED_IMAGE_TYPE");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new Error("IMAGE_TOO_LARGE");
  }

  if (!response.body) {
    throw new Error("EMPTY_IMAGE_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("IMAGE_TOO_LARGE");
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (!total) {
    throw new Error("EMPTY_IMAGE_RESPONSE");
  }

  return `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`;
}

function validateDataImage(dataUrl) {
  const match = String(dataUrl).match(
    /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=]+)$/i
  );

  if (!match) return false;

  const mime = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(mime)) return false;

  const bytes = Buffer.from(match[2], "base64").byteLength;

  return bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}

async function normalizeContent(content) {
  if (typeof content === "string") {
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error("MESSAGE_TOO_LARGE");
    }

    return content;
  }

  if (!Array.isArray(content)) {
    throw new Error("INVALID_MESSAGE_CONTENT");
  }

  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      if (part.text.length > MAX_CONTENT_CHARS) {
        throw new Error("MESSAGE_TOO_LARGE");
      }

      parts.push({
        type: "text",
        text: part.text
      });

      continue;
    }

    if (
      part.type === "image_url" &&
      typeof part.image_url?.url === "string"
    ) {
      const url = part.image_url.url;
      let imageUrl = null;

      if (url.startsWith("data:")) {
        if (validateDataImage(url)) {
          imageUrl = url;
        }
      } else if (/^https:\/\//i.test(url)) {
        imageUrl = await fetchImgBBAsDataUrl(url);
      }

      if (imageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: imageUrl,
            detail: ["low", "high"].includes(
              part.image_url.detail
            )
              ? part.image_url.detail
              : "auto"
          }
        });
      }
    }
  }

  return parts.length ? parts : null;
}

function parseBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("INVALID_JSON_BODY");
    }
  }

  return body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method not allowed");
  }

  try {
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
      return jsonError(res, 500, "API_KEY_MISSING");
    }

    const body = parseBody(req.body);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(res, 400, "INVALID_REQUEST_BODY");
    }

    const user = await verifyUser(req);

    const modelId = MODELS[String(body.model || "")];

    if (!modelId) {
      return jsonError(res, 400, "UNKNOWN_MODEL");
    }

    if (
      modelId === PRO_MODEL &&
      !(await hasActivePro(user))
    ) {
      return jsonError(res, 403, "PRO_REQUIRED");
    }

    if (!Array.isArray(body.messages) || !body.messages.length) {
      return jsonError(res, 400, "NO_MESSAGES");
    }

    if (body.messages.length > MAX_MESSAGES) {
      return jsonError(res, 400, "TOO_MANY_MESSAGES");
    }

    const messages = [];

    for (const message of body.messages) {
      if (
        !message ||
        !["system", "user", "assistant"].includes(message.role)
      ) {
        continue;
      }

      const content = await normalizeContent(message.content);

      if (content !== null && content !== "") {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (
      !messages.length ||
      !messages.some(message => message.role === "user")
    ) {
      return jsonError(res, 400, "NO_VALID_USER_MESSAGE");
    }

    const stream = body.stream !== false;

    const requestBody = {
      model: modelId,
      messages,
      stream,
      max_tokens: Number.isInteger(body.max_tokens)
        ? Math.max(1, Math.min(body.max_tokens, 8192))
        : 8192
    };

    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: stream
          ? "text/event-stream"
          : "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!upstream.ok) {
      const raw = await upstream.text();

      console.error(
        "AnyModel API error:",
        upstream.status,
        raw.slice(0, 1200)
      );

      return jsonError(
        res,
        502,
        `ANYMODEL_HTTP_${upstream.status}`
      );
    }

    const contentType =
      upstream.headers.get("content-type") || "application/json";

    if (
      contentType.includes("text/event-stream") &&
      upstream.body
    ) {
      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
      );

      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const reader = upstream.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done || res.destroyed) break;

          res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();

        if (!res.destroyed) {
          res.end();
        }
      }

      return;
    }

    const result = await upstream.text();

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");

    return res.end(result);

  } catch (error) {
    console.error("Venus AI chat function failed:", error);

    if (res.headersSent) {
      return res.end();
    }

    const status = Number(error?.statusCode);

    if (status === 401) {
      return jsonError(res, 401, error.message);
    }

    if (error.message === "PRO_REQUIRED") {
      return jsonError(res, 403, error.message);
    }

    if (error.message === "INVALID_JSON_BODY") {
      return jsonError(res, 400, error.message);
    }

    const safeMessages = new Set([
      "FIREBASE_SERVICE_ACCOUNT_JSON_MISSING",
      "FIREBASE_DATABASE_URL_MISSING",
      "FIREBASE_SERVICE_ACCOUNT_JSON_INVALID",
      "MESSAGE_TOO_LARGE",
      "INVALID_MESSAGE_CONTENT",
      "IMAGE_TOO_LARGE",
      "UNSUPPORTED_IMAGE_TYPE",
      "IMAGE_HOST_NOT_ALLOWED",
      "INVALID_IMAGE_URL",
      "INVALID_IMAGE_REDIRECT",
      "TOO_MANY_IMAGE_REDIRECTS",
      "EMPTY_IMAGE_RESPONSE"
    ]);

    if (safeMessages.has(error?.message)) {
      return jsonError(
        res,
        error.message.startsWith("FIREBASE_") ? 500 : 400,
        error.message
      );
    }

    return jsonError(res, 500, "INTERNAL_SERVER_ERROR");
  }
}
