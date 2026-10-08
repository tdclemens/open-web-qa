#!/usr/bin/env node
"use strict";

/**
 * Demo blog app server (zero dependencies, Node >= 22, CommonJS).
 *
 * Endpoints:
 *   GET  /            -> serves index.html (text/html)
 *   GET  /index.html  -> serves index.html (text/html)
 *   POST /api/login   {email,password}
 *        200 {ok:true,user:{email}} + Set-Cookie: session=<hex32>; HttpOnly; SameSite=Lax; Path=/
 *        401 {ok:false,error:'Invalid email or password'}
 *   POST /api/logout  -> 200 {ok:true} + clears the session cookie
 *   GET  /api/session -> 200 {user:{email}} or {user:null}
 *   GET  /api/posts   -> 200 {posts:[{id,title,author,body,createdAt}]} (public)
 *   POST /api/posts   {title,body}
 *        201 {ok:true,post:{id,title,author,body,createdAt}} (author = session email)
 *        401 {ok:false,error:'Login required'}
 *   any other route   -> 404 {ok:false,error:'not found'}
 *   unparseable JSON body on a POST /api/* route
 *                       -> 400 {ok:false,error:'invalid JSON'}
 *
 * State is in-memory (sessions: Map token->email, posts: array).
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 4173;

// Seeded demo user. Plaintext compare is fine for a demo.
const USER = { email: "qa@example.com", password: "s3cret" };

// Session store: token -> email
const sessions = new Map();

// Posts: auto-increment ids; one seeded welcome post.
let nextPostId = 2;
const posts = [
  {
    id: 1,
    title: "Welcome to the blog",
    author: "qa@example.com",
    body: "This is the first post. Log in to write your own.",
    createdAt: "2024-01-01T00:00:00.000Z",
  },
];

const INDEX_HTML_PATH = path.join(__dirname, "index.html");

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function serveIndex(res) {
  let html;
  try {
    html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  } catch {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== "string" || header.length === 0) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function sessionEmail(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (token && sessions.has(token)) return sessions.get(token);
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Parse a JSON request body. Returns { ok: true, value } on success,
 * or a ready-to-send error response ({ ok: false, status, payload }) on
 * an unparseable body.
 */
async function parseJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false, status: 400, payload: { ok: false, error: "invalid JSON" } };
  }
  let value;
  try {
    value = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, status: 400, payload: { ok: false, error: "invalid JSON" } };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, payload: { ok: false, error: "invalid JSON" } };
  }
  return { ok: true, value };
}

function handleLogin(req, res) {
  parseJsonBody(req).then(({ ok, value, status, payload }) => {
    if (!ok) return sendJson(res, status, payload);
    // Demo: plaintext comparison against the seeded user.
    if (value.email === USER.email && value.password === USER.password) {
      const token = crypto.randomBytes(16).toString("hex");
      sessions.set(token, USER.email);
      sendJson(res, 200, { ok: true, user: { email: USER.email } }, {
        "Set-Cookie": `session=${token}; HttpOnly; SameSite=Lax; Path=/`,
      });
    } else {
      sendJson(res, 401, { ok: false, error: "Invalid email or password" });
    }
  });
}

function handleLogout(req, res) {
  // Drop the session token if present (cookie is cleared for the client).
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  sendJson(res, 200, { ok: true }, {
    "Set-Cookie": "session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
  });
}

function handleCreatePost(req, res) {
  parseJsonBody(req).then(({ ok, value, status, payload }) => {
    if (!ok) return sendJson(res, status, payload);
    const author = sessionEmail(req);
    if (!author) {
      return sendJson(res, 401, { ok: false, error: "Login required" });
    }
    const title = value.title;
    const body = value.body;
    if (typeof title !== "string" || title.length === 0) {
      return sendJson(res, 400, { ok: false, error: "title is required" });
    }
    if (typeof body !== "string" || body.length === 0) {
      return sendJson(res, 400, { ok: false, error: "body is required" });
    }
    const post = {
      id: nextPostId++,
      title,
      author,
      body,
      createdAt: new Date().toISOString(),
    };
    posts.push(post);
    sendJson(res, 201, { ok: true, post });
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }

  const route = `${req.method} ${pathname}`;

  switch (route) {
    case "GET /":
    case "GET /index.html":
      serveIndex(res);
      return;
    case "POST /api/login":
      handleLogin(req, res);
      return;
    case "POST /api/logout":
      handleLogout(req, res);
      return;
    case "GET /api/session":
      sendJson(res, 200, { user: sessionEmail(req) ? { email: sessionEmail(req) } : null });
      return;
    case "GET /api/posts":
      sendJson(res, 200, { posts });
      return;
    case "POST /api/posts":
      handleCreatePost(req, res);
      return;
    default:
      sendJson(res, 404, { ok: false, error: "not found" });
  }
});

server.listen(PORT, () => {
  console.log(`Blog server listening on http://localhost:${PORT}`);
});
