
const admin = require("firebase-admin");

const API_URL = "https://anymodel.org/v1/chat/completions";
const ADMIN_EMAIL = "flexadssq@gmail.com";

const MODELS = {
  flash: "cx/gpt-6-luna",
  high: "cx/gpt-6.1-sol",
  astro: "cx/gpt-6-astra"
};

function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!raw || !databaseURL) {
    throw new Error("FIREBASE_ENV_MISSING");
  }

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL
  });
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function verifyUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    throw new Error("UNAUTHORIZED");
  }

  initFirebase();

  return admin.auth().verifyIdToken(token);
}

async function hasPro(uid) {
  const snapshot = await admin
    .database()
    .ref(`proUsers/${uid}`)
    .once("value");

  const data = snapshot.val();

  return Boolean(
    data &&
    data.active === true &&
    Number(data.expiresAt) > Date.now()
  );
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("INVALID_MESSAGES");
  }

  if (messages.length > 40) {
    throw new Error("TOO_MANY_MESSAGES");
  }

  return messages.map(message => {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role)
    ) {
      throw new Error("INVALID_MESSAGE_ROLE");
    }

    const content = message.content;

    if (
      typeof content !== "string" &&
      !Array.isArray(content)
    ) {
      throw new Error("INVALID_MESSAGE_CONTENT");
    }

    if (typeof content === "string" && content.length > 250000) {
      throw new Error("MESSAGE_TOO_LARGE");
    }

    return {
      role: message.role,
      content
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendError(res, 405, "Method not allowed");
  }

  try {
    const user = await verifyUser(req);

    const body = req.body || {};
    const requestedModel = body.model || "flash";

    const model = MODELS[requestedModel];

    if (!model) {
      return sendError(res, 400, "Unknown model");
    }

    const isAdmin =
      user.email &&
      user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

    if (requestedModel === "astro" && !isAdmin) {
      const allowed = await hasPro(user.uid);

      if (!allowed) {
        return sendError(res, 403, "PRO_REQUIRED");
      }
    }

    const messages = normalizeMessages(body.messages);

    const apiKey = process.env.API_KEY;

    if (!apiKey) {
      throw new Error("API_KEY_MISSING");
    }

    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: body.stream === true
      })
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();

      console.error(
        "AnyModel error:",
        upstream.status,
        errorText.slice(0, 2000)
      );

      return sendError(
        res,
        upstream.status,
        "AI_PROVIDER_ERROR"
      );
    }

    if (body.stream === true) {
      if (!upstream.body) {
        return sendError(res, 502, "EMPTY_STREAM");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const reader = upstream.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          if (res.destroyed) {
            await reader.cancel();
            break;
          }

          res.write(Buffer.from(value));
        }
      } finally {
        if (!res.destroyed) res.end();
      }

      return;
    }

    const result = await upstream.json();
    return res.status(200).json(result);

  } catch (error) {
    console.error("Chat API error:", error);

    if (error.message === "UNAUTHORIZED") {
      return sendError(res, 401, "UNAUTHORIZED");
    }

    if (
      error.code === "auth/argument-error" ||
      error.code === "auth/id-token-expired" ||
      error.code === "auth/invalid-id-token"
    ) {
      return sendError(res, 401, "INVALID_TOKEN");
    }

    if (error.message === "INVALID_MESSAGES") {
      return sendError(res, 400, "INVALID_MESSAGES");
    }

    if (error.message === "TOO_MANY_MESSAGES") {
      return sendError(res, 400, "TOO_MANY_MESSAGES");
    }

    if (error.message === "MESSAGE_TOO_LARGE") {
      return sendError(res, 413, "MESSAGE_TOO_LARGE");
    }

    if (error.message === "INVALID_MESSAGE_ROLE" ||
        error.message === "INVALID_MESSAGE_CONTENT") {
      return sendError(res, 400, error.message);
    }

    return sendError(res, 500, "INTERNAL_SERVER_ERROR");
  }
};
