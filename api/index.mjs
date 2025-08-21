// Server-side rendering version (Vercel serverless, no Express required)
// Renders the final card as PNG server-side using @napi-rs/canvas
import { TwitterApi } from "twitter-api-v2";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");

// ======== ENV ========
const {
  TWITTER_CLIENT_ID,
  TWITTER_CLIENT_SECRET,
  CALLBACK_URL,
  TWITTERAPI_IO_KEY,
  WEBHOOK_URL,
  SESSION_SECRET = "devsecret_change_me",

  // Options
  TWEET_COUNT = "25",
  INCLUDE_REPLIES = "false",

  // Gauge layout on background (pixels)
  GAUGE_LEFT = "500",
  GAUGE_RIGHT = "500",
  GAUGE_TOP = "100",
  GAUGE_BOTTOM = "400",

  // Score thresholds
  THRESH_SB = "20",
  THRESH_B  = "40",
  THRESH_N  = "60",
  THRESH_BU = "80",

  // Needle tuning
  NEEDLE_LEN_SCALE = "1.0",
  NEEDLE_WIDTH_FRAC = "0.025",

  // PFP & handle
  PFP_X = "175",
  PFP_Y = "200",
  PFP_SIZE = "100",

  HANDLE_X = "300",
  HANDLE_Y = "200",
  HANDLE_FONT_PX = "70",
  HANDLE_COLOR = "#ffffff",
} = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env: ${name}`);
}

// ======== cookie utils (signed, compact) ========
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const b64urlDecode = (s) => Buffer.from(s, "base64url").toString("utf8");

function sign(val) {
  return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(val).digest());
}
function parseCookies(req) {
  const h = req.headers["cookie"];
  if (!h) return {};
  const out = {};
  for (const part of h.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}
function makeSignedCookie(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const payload = b64url(json);
  const sig = sign(payload);
  return `${payload}.${sig}`;
}
function readSignedCookie(req, name) {
  const cookies = parseCookies(req);
  const raw = cookies[name];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (sign(payload) !== sig) return null;
  try { return JSON.parse(b64urlDecode(payload)); } catch { return null; }
}

function isSecure(req) {
  const xfProto = (req.headers["x-forwarded-proto"] || "").toString().toLowerCase();
  if (xfProto) return xfProto === "https";
  const host = (req.headers.host || "").toLowerCase();
  return host.endsWith(".vercel.app");
}
function setCookie(req, res, name, value, { maxAgeSec, path = "/", httpOnly = true, sameSite = "Lax", secure } = {}) {
  const useSecure = typeof secure === "boolean" ? secure : isSecure(req);
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (useSecure) parts.push("Secure");
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  const cookie = parts.join("; ");
  const prev = res.getHeader("Set-Cookie");
  if (prev) res.setHeader("Set-Cookie", Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
  else res.setHeader("Set-Cookie", cookie);
}
function clearCookie(req, res, name) {
  setCookie(req, res, name, "", { maxAgeSec: 0 });
}

// ======== helpers ========
const intish = (v, d=0) => {
  const m = String(v ?? "").match(/-?\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) ? n : d;
};

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}

// Register font once (if present)
(function registerFontOnce(){
  const fontPath = path.join(ASSETS_DIR, "fonts", "Manrope-Bold.ttf");
  if (fileExists(fontPath)) {
    try { GlobalFonts.registerFromPath(fontPath, "ManropeBold"); } catch {}
  }
})();

// ======== SSR image rendering ========
async function renderCardPNG({ score, username, pfpUrl }) {
  // Select background by score
  const tSB = Math.max(0, Math.min(100, intish(THRESH_SB, 20)));
  const tB  = Math.max(tSB, Math.min(100, intish(THRESH_B, 40)));
  const tN  = Math.max(tB,  Math.min(100, intish(THRESH_N, 60)));
  const tBU = Math.max(tN,  Math.min(100, intish(THRESH_BU, 80)));

  const s = Math.max(0, Math.min(100, Number(score) || 0));
  let bgFile = "strongly-bearish.png";
  if (s >= tSB && s < tB) bgFile = "bearish.png";
  else if (s >= tB && s < tN) bgFile = "neutral.png";
  else if (s >= tN && s < tBU) bgFile = "bullish.png";
  else if (s >= tBU) bgFile = "strongly-bullish.png";

  const bgPath = path.join(ASSETS_DIR, bgFile);
  if (!fileExists(bgPath)) throw new Error(`Missing background asset: ${bgPath}`);

  const bg = await loadImage(bgPath);
  const width = bg.width || 1200;
  const height = bg.height || 628;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // draw bg
  ctx.drawImage(bg, 0, 0, width, height);

  // optional PFP
  const PFP = { x: intish(PFP_X, 32), y: intish(PFP_Y, 32), size: Math.max(1, intish(PFP_SIZE, 96)) };
  if (pfpUrl) {
    try {
      const r = await fetch(pfpUrl, { headers: { "User-Agent": "Fairscale-Compass/1.0" }});
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const pimg = await loadImage(buf);
        ctx.drawImage(pimg, PFP.x, PFP.y, PFP.size, PFP.size);
      }
    } catch (e) {
      console.warn("PFP load failed:", e?.message || e);
    }
  }

  // handle text
  const HANDLE = {
    x: intish(HANDLE_X, 144),
    y: intish(HANDLE_Y, 48),
    fontPx: Math.max(8, intish(HANDLE_FONT_PX, 36)),
    color: String(HANDLE_COLOR || "#ffffff"),
  };

  ctx.fillStyle = HANDLE.color;
  ctx.font = `700 ${HANDLE.fontPx}px ManropeBold, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "top";
  const handleText = username ? `@${username}` : "";
  ctx.fillText(handleText, HANDLE.x, HANDLE.y);

  // gauge geometry
  const rect = {
    x: intish(GAUGE_LEFT, 0),
    y: intish(GAUGE_TOP, 0),
    w: Math.max(0, width - intish(GAUGE_LEFT, 0) - intish(GAUGE_RIGHT, 0)),
    h: Math.max(0, height - intish(GAUGE_TOP, 0) - intish(GAUGE_BOTTOM, 0)),
  };
  const r = Math.max(1, Math.min(rect.w / 2, rect.h));
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h);
  const trackW = Math.max(6, Math.round(r * 0.11));
  const valueW = Math.max(4, Math.round(r * 0.08));
  const start = Math.PI;
  const end = 2 * Math.PI;

  // track
  ctx.lineCap = "round";
  ctx.lineWidth = trackW;
  ctx.strokeStyle = "#090f00";
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end, false);
  ctx.stroke();

  // value gradient (approximate client logic without conic gradient; use segments)
  const gradStops = [
    { t: 0.0, color: [217, 83, 79] },   // red
    { t: 0.5, color: [240, 173, 78] },  // orange
    { t: 1.0, color: [92, 184, 92] },   // green
  ];
  const thetaEnd = start + (s / 100) * (end - start);
  const capAngle = (valueW / 2) / r;

  function strokeArc(c1, c2, a0, a1) {
    const [r0,g0,b0] = c1, [r1,g1,b1] = c2;
    // simple linear blend mid color for strokeStyle (server-side: no conic gradient)
    const mid = [ Math.round((r0+r1)/2), Math.round((g0+g1)/2), Math.round((b0+b1)/2) ];
    ctx.strokeStyle = `rgb(${mid[0]},${mid[1]},${mid[2]})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1, false);
    ctx.stroke();
  }

  ctx.lineWidth = valueW;
  // initial cap segment (red)
  const segStart = start;
  const firstEnd = Math.min(thetaEnd, start + capAngle);
  ctx.strokeStyle = "rgb(217,83,79)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, segStart, firstEnd, false);
  ctx.stroke();

  if (thetaEnd > start + capAngle) {
    const span = (end - start) - capAngle;
    const segs = 24; // smooth enough
    const usableStart = start + capAngle;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const a0 = usableStart + t0 * span;
      const a1 = usableStart + t1 * span;
      if (a0 >= thetaEnd) break;
      const a1clamped = Math.min(a1, thetaEnd);

      // pick colors by t along [0..1]
      const colAt = (t) => {
        if (t <= 0.5) {
          const u = t / 0.5;
          const c0 = gradStops[0].color, c1 = gradStops[1].color;
          return [ c0[0]+(c1[0]-c0[0])*u, c0[1]+(c1[1]-c0[1])*u, c0[2]+(c1[2]-c0[2])*u ];
        } else {
          const u = (t - 0.5) / 0.5;
          const c0 = gradStops[1].color, c1 = gradStops[2].color;
          return [ c0[0]+(c1[0]-c0[0])*u, c0[1]+(c1[1]-c0[1])*u, c0[2]+(c1[2]-c0[2])*u ];
        }
      };
      strokeArc(colAt(t0), colAt(t1), a0, a1clamped);
      if (a1 >= thetaEnd) break;
    }
  }

  // needle
  const a = start + (s / 100) * (end - start);
  const needleScale = Math.max(0.1, Number(NEEDLE_LEN_SCALE) || 1.0);
  const needleWidthFrac = Math.max(0.003, Number(NEEDLE_WIDTH_FRAC) || 0.025);

  const r1_def = r - Math.max(10, Math.round(r * 0.30));
  const r2_def = r + Math.max(8,  Math.round(r * 0.05));
  const mid_def = (r1_def + r2_def) / 2;
  const halfLen_def = (r2_def - r1_def) / 2;
  const halfLen_new = halfLen_def * needleScale;
  const r1n = mid_def - halfLen_new;
  const r2n = mid_def + halfLen_new;
  const x1 = cx + Math.cos(a) * r1n, y1 = cy + Math.sin(a) * r1n;
  const x2 = cx + Math.cos(a) * r2n, y2 = cy + Math.sin(a) * r2n;

  ctx.strokeStyle = "#e6e6e8";
  ctx.lineWidth = Math.max(2, Math.round(r * needleWidthFrac));
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  return canvas.toBuffer("image/png");
}

// ======== HTML renderers (no client canvas; show final PNG) ========
function landingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Fairscale Compass</title><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>:root{color-scheme:dark}*{box-sizing:border-box}
  @font-face{font-family:ManropeBold;src:url('/assets/fonts/Manrope-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
  body{margin:0;background:#000;color:#fff;font-family:ManropeBold,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.container{max-width:960px;text-align:center}
  .logo{height:76px;width:auto;margin-bottom:16px}.title{font-weight:800;font-size:46px;color:#f4c217;margin:10px 0 16px}
  .desc{color:#c9c9c9;font-size:19px;line-height:1.7;margin:0 auto 28px;max-width:820px}
  .cta{display:inline-flex;align-items:center;gap:10px;background:#f4c217;color:#000;font-weight:800;font-size:18px;padding:14px 22px;border-radius:999px;border:0;cursor:pointer;box-shadow:0 10px 30px rgba(244,194,23,.25);text-decoration:none}
  .cta:hover{background:#ffd54a}.cta .x{font-size:22px;line-height:1}.fine{margin-top:22px;color:#9a9a9a;font-size:12px}
  @media(max-width:640px){.logo{height:60px}.title{font-size:34px}.desc{font-size:17px}}</style></head>
  <body><main class="wrap"><section class="container">
  <img class="logo" src="/assets/logo.png" alt="Fairscale Logo"/>
  <h1 class="title">Fairscale Compass</h1>
  <p class="desc">Connect your X account and we’ll generate a sleek sentiment gauge from your recent posts. The final card is rendered server-side and delivered as a PNG for easy download & sharing.</p>
  <a class="cta" href="/login"><span class="x">𝕏</span> Connect with X</a>
  <p class="fine">By continuing you agree to simulate non-production scores.</p>
  </section></main></body></html>`;
}

function gaugePageHtml(username) {
  const ts = Date.now();
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Fairscale Compass — Gauge</title><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>:root{color-scheme:dark}
  body{background:#0f0f10;color:#e8e6e6;font-family:ManropeBold,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px}
  .wrap{max-width:1000px;margin:0 auto;text-align:center}
  img{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:18px}
  a.btn,button{font-size:15px;padding:10px 16px;border:1px solid #2a2a2a;border-radius:10px;background:#1a1a1b;color:#e6e6e6;cursor:pointer;text-decoration:none}
  a.btn:hover,button:hover{background:#222}</style></head>
  <body><div class="wrap">
    <img id="card" src="/card.png?ts=${ts}" alt="Sentiment Gauge for @${username}"/>
    <div class="btns">
      <a class="btn" href="/card.png?dl=1&ts=${ts}" download="sentiment-gauge.png">Download PNG</a>
      <a class="btn" href="/logout">Logout</a>
    </div>
  </div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ======== Router (single serverless handler) ========
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const { pathname, searchParams } = url;

    if (pathname === "/healthz") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");
      return;
    }

    if (pathname === "/") {
      const sess = readSignedCookie(req, "fs:user");
      if (sess?.username) {
        res.statusCode = 302;
        res.setHeader("Location", "/fetch");
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(landingHtml());
      return;
    }

    if (pathname === "/login") {
      must("TWITTER_CLIENT_ID"); must("TWITTER_CLIENT_SECRET"); must("CALLBACK_URL");
      const oauthClient = new TwitterApi({ clientId: TWITTER_CLIENT_ID, clientSecret: TWITTER_CLIENT_SECRET });
      const { url: authUrl, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(CALLBACK_URL, {
        scope: ["tweet.read", "users.read", "offline.access"],
      });
      const tmp = makeSignedCookie({ state, codeVerifier, t: Date.now() });
      setCookie(req, res, "fs:oauth", tmp, { maxAgeSec: 600 });
      res.statusCode = 302;
      res.setHeader("Location", authUrl);
      res.end();
      return;
    }

    if (pathname === "/callback") {
      must("TWITTER_CLIENT_ID"); must("TWITTER_CLIENT_SECRET"); must("CALLBACK_URL");
      const state = searchParams.get("state");
      const code = searchParams.get("code");
      const oauthCookie = readSignedCookie(req, "fs:oauth");
      if (!state || !code || !oauthCookie || oauthCookie.state !== state) {
        res.statusCode = 400;
        res.end("Invalid OAuth2 callback");
        return;
      }
      const oauthClient = new TwitterApi({ clientId: TWITTER_CLIENT_ID, clientSecret: TWITTER_CLIENT_SECRET });
      let username = null, userId = null, pfp = "";
      try {
        const { client } = await oauthClient.loginWithOAuth2({
          code,
          codeVerifier: oauthCookie.codeVerifier,
          redirectUri: CALLBACK_URL,
        });
        const me = await client.v2.me();
        username = me?.data?.username || null;
        userId = me?.data?.id || null;
      } catch (e) {
        console.error("OAuth/me error:", e);
        res.statusCode = 429;
        res.end("Twitter rate limit or auth error while fetching username. Try again later.");
        return;
      }

      try {
        if (username) {
          must("TWITTERAPI_IO_KEY");
          const infoUrl = new URL("https://api.twitterapi.io/twitter/user/info");
          infoUrl.searchParams.set("userName", username);
          const r = await fetch(infoUrl.toString(), { headers: { "x-api-key": TWITTERAPI_IO_KEY }});
          if (r.ok) {
            const j = await r.json();
            pfp = j?.data?.profilePicture || "";
            if (typeof pfp === "string" && pfp.includes("_normal")) pfp = pfp.replace("_normal", "_400x400");
            if (j?.data?.id) userId = j.data.id;
          }
        }
      } catch (e) {
        console.warn("twitterapi.io user/info error:", e);
      }

      clearCookie(req, res, "fs:oauth");
      setCookie(req, res, "fs:user", makeSignedCookie({ username, userId, pfp, t: Date.now() }), { maxAgeSec: 60 * 60 * 24 * 30 });
      res.statusCode = 302;
      res.setHeader("Location", "/fetch");
      res.end();
      return;
    }

    if (pathname === "/logout") {
      clearCookie(req, res, "fs:user");
      clearCookie(req, res, "fs:render");
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.end();
      return;
    }

    if (pathname === "/fetch") {
      must("TWITTERAPI_IO_KEY"); must("WEBHOOK_URL");
      const sess = readSignedCookie(req, "fs:user");
      if (!sess?.username) {
        res.statusCode = 302;
        res.setHeader("Location", "/");
        res.end();
        return;
      }

      const desired = Math.max(1, Number(TWEET_COUNT) || 50);
      const includeReplies = String(INCLUDE_REPLIES).toLowerCase() === "true";

      const collected = [];
      let cursor = "";
      let pages = 0;
      const MAX_PAGES = 5;
      try {
        while (collected.length < desired) {
          const u = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
          u.searchParams.set("userName", sess.username);
          u.searchParams.set("includeReplies", includeReplies ? "true" : "false");
          if (cursor) u.searchParams.set("cursor", cursor);

          const resp = await fetch(u.toString(), { headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" } });
          if (!resp.ok) throw new Error(`TwitterAPI.io ${resp.status}: ${await resp.text().catch(()=> "")}`);
          const data = await resp.json();
          const page = Array.isArray(data.data?.tweets) ? data.data.tweets : [];
          if (!page.length) break;
          collected.push(...page);
          if (!data.has_next_page || !data.next_cursor) break;
          cursor = data.next_cursor;
          pages += 1;
          if (pages >= MAX_PAGES) break;
        }
      } catch (e) {
        console.error("Fetch tweets error:", e);
      }
      const tweetsToSend = collected.slice(0, desired);

      // Score via webhook
      let displayScore = null;
      let webhookRaw = "";
      try {
        const wr = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: { id: sess.userId, username: sess.username },
            count: tweetsToSend.length,
            tweets: tweetsToSend,
            source: "twitterapi.io",
          })
        });
        webhookRaw = await wr.text();
        try {
          const parsed = JSON.parse(webhookRaw);
          let P = 0, Neut = 0, Neg = 0;
          if (Array.isArray(parsed)) {
            for (const o of parsed) {
              if (o && typeof o === "object") {
                if (typeof o.Positive === "number") P += o.Positive;
                if (typeof o.Neutral  === "number") Neut += o.Neutral;
                if (typeof o.Negative === "number") Neg += o.Negative;
              }
            }
          } else if (parsed && typeof parsed === "object") {
            if (typeof parsed.Positive === "number") P = parsed.Positive;
            if (typeof parsed.Neutral  === "number") Neut = parsed.Neutral;
            if (typeof parsed.Negative === "number") Neg = parsed.Negative;
          }
          const T = P + Neut + Neg || tweetsToSend.length || 0;
          if (T > 0) displayScore = Math.round(((P - Neg + T) / (2 * T)) * 100);
        } catch {
          console.log("Webhook response (raw):", webhookRaw);
        }
      } catch (e) {
        console.error("Webhook error:", e);
      }

      if (displayScore !== null) {
        // store short-lived render cookie with params for /card.png
        setCookie(
          req,
          res,
          "fs:render",
          makeSignedCookie({ score: displayScore, username: sess.username, pfp: sess.pfp, ts: Date.now() }),
          { maxAgeSec: 300 } // 5 minutes
        );

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(gaugePageHtml(sess.username));
        return;
      }

      // Fallback debug page
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#eee;background:#111;padding:12px;border-radius:8px;">
Sent ${tweetsToSend.length} tweets from @${sess.username} to webhook.
Webhook raw:
${escapeHtml(webhookRaw || "(empty)")}
</pre>
<p><a href="/" style="color:#9cf;font-family:system-ui;">Back</a></p>`);
      return;
    }

    if (pathname === "/card.png") {
      const rc = readSignedCookie(req, "fs:render");
      if (!rc || typeof rc.score !== "number") {
        res.statusCode = 400;
        res.end("Missing render context");
        return;
      }
      try {
        const png = await renderCardPNG({ score: rc.score, username: rc.username, pfpUrl: rc.pfp });
        res.setHeader("Content-Type", "image/png");
        if (searchParams.get("dl")) res.setHeader("Content-Disposition", 'attachment; filename="sentiment-gauge.png"');
        // Some caching leeway for the same score within a session
        res.setHeader("Cache-Control", "private, max-age=120");
        res.end(png);
      } catch (e) {
        console.error("Render error:", e);
        res.statusCode = 500;
        res.end("Render failed");
      }
      return;
    }

    // 404
    res.statusCode = 404;
    res.end("Not found");
  } catch (e) {
    console.error("Top-level error:", e);
    res.statusCode = 500;
    res.end("Internal error");
  }
}
