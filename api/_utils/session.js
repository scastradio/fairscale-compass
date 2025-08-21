import { createHmac, timingSafeEqual } from "crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";

const COOKIE_NAME = "sess";
const MAX_AGE = 60 * 60 * 24 * 3; // 3 days

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(data, secret) {
  return createHmac("sha256", secret).update(data).digest();
}

export function setSession(res, obj, secret) {
  const payload = b64url(JSON.stringify({ ...obj, iat: Math.floor(Date.now()/1000) }));
  const sig = b64url(sign(payload, secret));
  const token = `${payload}.${sig}`;
  const cookie = serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE
  });
  res.setHeader("Set-Cookie", cookie);
}

export function clearSession(res) {
  const cookie = serializeCookie(COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  res.setHeader("Set-Cookie", cookie);
}

export function getSession(req, secret) {
  const cookies = parseCookie(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expected = sign(payloadB64, secret);
  const got = fromB64url(sigB64);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const obj = JSON.parse(fromB64url(payloadB64).toString("utf8"));
    return obj || null;
  } catch {
    return null;
  }
}
