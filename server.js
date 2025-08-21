// server.js — server-side rendered gauge PNG (no client canvas)
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { TwitterApi } from "twitter-api-v2";
import path from "path";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  SESSION_SECRET = "devsecret",
  TWITTER_CLIENT_ID,
  TWITTER_CLIENT_SECRET,
  CALLBACK_URL,
  TWITTERAPI_IO_KEY,
  TWEET_COUNT = "25",
  INCLUDE_REPLIES = "false",
  WEBHOOK_URL,

  // Gauge layout on background image (pixels)
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

  // Profile picture & handle placement (pixels)
  PFP_X = "175",
  PFP_Y = "200",
  PFP_SIZE = "100",

  HANDLE_X = "300",
  HANDLE_Y = "200",
  HANDLE_FONT_PX = "70",
  HANDLE_COLOR = "#ffffff",
} = process.env;

// ---------- helpers ----------
function required(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
["TWITTER_CLIENT_ID","TWITTER_CLIENT_SECRET","CALLBACK_URL","TWITTERAPI_IO_KEY","WEBHOOK_URL"].forEach(required);

function intish(v, def = 0) {
  const m = String(v ?? "").match(/-?\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

// logger
const stamp = () => new Date().toISOString().replace("T"," ").replace("Z","");
function slog(...args){ console.log(`[${stamp()}]`, ...args); }

// ---------- app ----------
const COOKIE_NAME = "fx_sess";
const COOKIE_SECRET = SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const app = express();
app.use(cookieParser(COOKIE_SECRET));
app.use("/assets", express.static(path.join(process.cwd(), "assets")));
app.use(express.json({ limit: "512kb" }));

// cookie "session" helpers
app.use((req, res, next) => {
  let sess = {};
  try {
    const raw = req.signedCookies?.[COOKIE_NAME];
    sess = raw ? JSON.parse(raw) : {};
  } catch {}
  req.sess = sess;
  res.saveSess = (obj) => {
    res.cookie(COOKIE_NAME, JSON.stringify(obj), {
      httpOnly: true, sameSite: "lax", secure: true, signed: true, path: "/",
      maxAge: 60 * 60 * 1000,
    });
  };
  next();
});

// font
try {
  GlobalFonts.registerFromPath(
    path.join(process.cwd(), "assets/fonts/Manrope-Bold.ttf"),
    "Manrope"
  );
  slog("Font registered: Manrope");
} catch (e) {
  slog("Font registration failed (Manrope).", String(e));
}

// twitter oauth client (OAuth2)
const oauthClient = new TwitterApi({
  clientId: TWITTER_CLIENT_ID,
  clientSecret: TWITTER_CLIENT_SECRET,
});

// ---------- routes ----------
app.get("/", (req, res) => {
  if (req.sess?.accessToken && req.sess?.username) return res.redirect("/fetch");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
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
  <p class="desc">Connect your X account and we’ll generate a sleek sentiment gauge from your recent posts, then render a server-side PNG you can download/share.</p>
  <a class="cta" href="/login"><span class="x">𝕏</span> Connect with X</a>
  <p class="fine">By continuing you agree to simulate non-production scores.</p>
  </section></main></body></html>`);
});

// OAuth start
app.get("/login", (req, res) => {
  const { url, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: ["tweet.read", "users.read", "offline.access"],
  });
  const sess = { ...(req.sess || {}) };
  sess.state = state; sess.codeVerifier = codeVerifier;
  res.saveSess(sess);
  slog("OAuth start", { state, redirect: url.slice(0, 90) + "…" });
  res.redirect(url);
});

// OAuth callback
app.get("/callback", async (req, res) => {
  const { state, code } = req.query;
  if (!state || !code || state !== req.sess?.state) return res.status(400).send("Invalid OAuth2 callback");
  try {
    const { client, accessToken, refreshToken, expiresIn, scope } = await oauthClient.loginWithOAuth2({
      code, codeVerifier: req.sess.codeVerifier, redirectUri: CALLBACK_URL,
    });
    const sess = { ...(req.sess || {}) };
    sess.accessToken = accessToken; sess.refreshToken = refreshToken; sess.expiresIn = expiresIn; sess.scope = scope;

    try {
      const me = await client.v2.me();
      sess.userId = me.data.id; sess.username = me.data.username;
      slog("v2.me()", { id: sess.userId, username: sess.username });
    } catch (e) {
      slog("v2.me() failed", String(e?.message || e));
      return res.status(429).send("Twitter rate limit while fetching your username. Try again later.");
    }

    // PFP via twitterapi.io
    try {
      const infoUrl = new URL("https://api.twitterapi.io/twitter/user/info");
      infoUrl.searchParams.set("userName", sess.username);
      const infoResp = await fetch(infoUrl.toString(), {
        headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" },
      });
      slog("twitterapi.io user/info", { status: infoResp.status });
      if (infoResp.ok) {
        const info = await infoResp.json().catch(()=> ({}));
        let pfp = info?.data?.profilePicture || "";
        if (pfp && pfp.includes("_normal")) pfp = pfp.replace("_normal","_400x400");
        if (pfp) { sess.profileImageUrl = pfp; slog("PFP set", { pfp }); }
        if (info?.data?.id) sess.userId = info.data.id;
      }
    } catch (e) {
      slog("twitterapi.io user/info error", String(e));
    }

    res.saveSess(sess);
    res.redirect("/fetch");
  } catch (e) {
    slog("OAuth callback error", String(e?.message || e));
    res.status(500).send("Callback failed");
  }
});

// Fetch tweets → webhook → compute score → redirect to preview
app.get("/fetch", async (req, res) => {
  if (!req.sess?.accessToken || !req.sess?.username) return res.redirect("/login");

  const desired = Math.max(1, Number(TWEET_COUNT) || 50);
  const includeReplies = String(INCLUDE_REPLIES).toLowerCase() === "true";
  slog("/fetch begin", { user: req.sess.username, desired, includeReplies });

  try {
    const collected = [];
    let cursor = "";
    while (collected.length < desired) {
      const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
      url.searchParams.set("userName", req.sess.username);
      url.searchParams.set("includeReplies", includeReplies ? "true" : "false");
      if (cursor) url.searchParams.set("cursor", cursor);

      slog("last_tweets request", { cursor: cursor || "<first>" });
      const resp = await fetch(url.toString(), {
        headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`TwitterAPI.io ${resp.status}`);
      const data = await resp.json();
      const page = Array.isArray(data.data?.tweets) ? data.data.tweets : [];
      collected.push(...page);
      slog("last_tweets page", { got: page.length, total: collected.length, has_next: !!data.has_next_page });
      if (!data.has_next_page || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    const tweetsToSend = collected.slice(0, desired);
    slog("POST webhook", { url: WEBHOOK_URL, tweets: tweetsToSend.length });

    const webhookResp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { id: req.sess.userId, username: req.sess.username },
        count: tweetsToSend.length,
        tweets: tweetsToSend,
        source: "twitterapi.io",
      }),
    });
    const bodyText = await webhookResp.text();
    slog("Webhook response", { status: webhookResp.status, length: bodyText.length, preview: bodyText.slice(0, 240) });

    // compute score
    let displayScore = null;
    try {
      const parsedAny = JSON.parse(bodyText);
      let P = 0, Neut = 0, Neg = 0;
      if (Array.isArray(parsedAny)) {
        for (const obj of parsedAny) {
          if (!obj || typeof obj !== "object") continue;
          if (typeof obj.Positive === "number") P += obj.Positive;
          if (typeof obj.Neutral === "number")  Neut += obj.Neutral;
          if (typeof obj.Negative === "number") Neg += obj.Negative;
        }
      } else if (typeof parsedAny === "object") {
        if (typeof parsedAny.Positive === "number") P = parsedAny.Positive;
        if (typeof parsedAny.Neutral === "number")  Neut = parsedAny.Neutral;
        if (typeof parsedAny.Negative === "number") Neg = parsedAny.Negative;
      }
      const T = P + Neut + Neg || tweetsToSend.length || 0;
      if (T > 0) displayScore = Math.round(((P - Neg + T) / (2 * T)) * 100);
    } catch {
      // ignore parse errors (we already logged preview)
    }

    const sess = { ...(req.sess || {}) };
    sess.lastScore = displayScore;
    res.saveSess(sess);

    if (displayScore === null) {
      return res.type("html").send(`<p style="font-family:system-ui;color:#eee;">Sent ${tweetsToSend.length} tweets from @${req.sess.username} to webhook.</p>
      <pre style="white-space:pre-wrap;color:#ccc;background:#111;padding:12px;border-radius:8px;">Webhook response: ${bodyText.replace(/</g,"&lt;")}</pre>
      <p><a href="/" style="color:#9cf;">Back</a></p>`);
    }

    res.redirect("/preview");
  } catch (e) {
    slog("fetch/webhook error", String(e?.message || e));
    res.status(500).send("Failed to fetch tweets or send to webhook.");
  }
});

// Preview page (server-side image)
app.get("/preview", (req, res) => {
  if (!req.sess?.username) return res.redirect("/");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
  <title>Gauge — Preview</title><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>:root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;background:#0f0f10;color:#e6e6e6;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center}
  img{max-width:100%;height:auto;border-radius:12px;border:1px solid #222;background:#111}
  .row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:16px}
  .btn{padding:10px 16px;border-radius:999px;border:1px solid #2a2a2a;background:#1a1a1b;color:#e6e6e6;text-decoration:none}
  .btn:hover{background:#222}</style></head>
  <body><main class="wrap">
    <div>
      <h2>Preview for @${req.sess.username}</h2>
      <img src="/gauge" alt="Gauge"/>
      <div class="row">
        <a class="btn" href="/gauge?download=1">Download PNG</a>
        <a class="btn" href="/logout">Logout</a>
      </div>
    </div>
  </main></body></html>`);
});

// Gauge image endpoint (PNG)
app.get("/gauge", async (req, res) => {
  if (!req.sess?.username) return res.redirect("/");
  try {
    const buf = await renderGaugeBuffer(req.sess);
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", 'attachment; filename="sentiment-gauge.png"');
    }
    res.setHeader("Content-Type", "image/png");
    res.end(buf);
  } catch (e) {
    slog("gauge render error", String(e?.message || e));
    res.status(500).send("Gauge render failed");
  }
});

// logout
app.get("/logout", (req, res) => {
  res.cookie(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", secure: true, signed: true, path: "/", maxAge: 0 });
  res.redirect("/");
});

// ------------- server-side renderer -------------
async function renderGaugeBuffer(sess) {
  const {
    username = "",
    profileImageUrl = "",
    lastScore = 50,
  } = sess || {};

  // thresholds
  const tSB = Math.max(0, Math.min(100, intish(THRESH_SB, 20)));
  const tB  = Math.max(tSB, Math.min(100, intish(THRESH_B, 40)));
  const tN  = Math.max(tB,  Math.min(100, intish(THRESH_N, 60)));
  const tBU = Math.max(tN,  Math.min(100, intish(THRESH_BU, 80)));
  const s = Math.max(0, Math.min(100, Number(lastScore) || 0));

  let bgFile = "strongly-bearish.png";
  if (s >= tSB && s < tB)   bgFile = "bearish.png";
  else if (s >= tB && s < tN)  bgFile = "neutral.png";
  else if (s >= tN && s < tBU) bgFile = "bullish.png";
  else if (s >= tBU)           bgFile = "strongly-bullish.png";
  const bgPath = path.join(process.cwd(), "assets", bgFile);

  slog("Background chosen", { score: s, bgFile });

  // load background first to get size
  const bg = await loadImage(bgPath);
  const W = bg.width, H = bg.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // draw background
  ctx.drawImage(bg, 0, 0, W, H);

  // draw pfp (if available)
  if (profileImageUrl) {
    try {
      const pfpResp = await fetch(profileImageUrl, { redirect: "follow", headers: { "User-Agent": "Fairscale-Compass/1.0" } });
      if (pfpResp.ok) {
        const pfpBuf = Buffer.from(await pfpResp.arrayBuffer());
        const pfpImg = await loadImage(pfpBuf);
        const PFP = {
          x: intish(PFP_X, 32),
          y: intish(PFP_Y, 32),
          size: Math.max(1, intish(PFP_SIZE, 96)),
        };
        ctx.drawImage(pfpImg, PFP.x, PFP.y, PFP.size, PFP.size);
      } else {
        slog("PFP fetch failed", { status: pfpResp.status });
      }
    } catch (e) {
      slog("PFP fetch error", String(e));
    }
  }

  // handle text
  try {
    ctx.fillStyle = String(HANDLE_COLOR || "#ffffff");
    const px = Math.max(8, intish(HANDLE_FONT_PX, 36));
    ctx.font = `${px}px Manrope`;
    ctx.textBaseline = "top";
    ctx.fillText(`@${username}`, intish(HANDLE_X, 144), intish(HANDLE_Y, 48));
  } catch (e) {
    slog("handle draw error", String(e));
  }

  // gauge needle
  try {
    const envLeft = intish(GAUGE_LEFT, 0);
    const envRight = intish(GAUGE_RIGHT, 0);
    const envTop = intish(GAUGE_TOP, 0);
    const envBottom = intish(GAUGE_BOTTOM, 0);

    const rect = {
      x: envLeft,
      y: envTop,
      w: Math.max(0, W - envLeft - envRight),
      h: Math.max(0, H - envTop - envBottom),
    };
    const r = Math.max(1, Math.min(rect.w/2, rect.h));
    const cx = Math.round(rect.x + rect.w / 2);
    const cy = Math.round(rect.y + rect.h);

    const needleScale = Math.max(0.1, Number(NEEDLE_LEN_SCALE) || 1.0);
    const needleWidthFrac = Math.max(0.003, Number(NEEDLE_WIDTH_FRAC) || 0.025);

    const start = Math.PI, end = 2 * Math.PI;
    const a = start + (s/100)*(end-start);

    const r1d = r - Math.max(10, Math.round(r * 0.30));
    const r2d = r + Math.max(8,  Math.round(r * 0.05));
    const mid = (r1d + r2d) / 2;
    const half = (r2d - r1d) / 2;

    const halfNew = half * needleScale;
    const r1 = mid - halfNew;
    const r2 = mid + halfNew;

    const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
    const x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * r2;

    ctx.save();
    ctx.strokeStyle = "#e6e6e8";
    ctx.lineWidth = Math.max(2, Math.round(r * needleWidthFrac));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  } catch (e) {
    slog("needle draw error", String(e));
  }

  return canvas.toBuffer("image/png");
}

// Debug: see current cookie session (redacted)
app.get("/debug/session", (req, res) => {
  const s = { ...(req.sess || {}) };
  if (s.accessToken)  s.accessToken  = `…${String(s.accessToken).slice(-6)}`;
  if (s.refreshToken) s.refreshToken = `…${String(s.refreshToken).slice(-6)}`;
  res.type("json").send(JSON.stringify(s, null, 2));
});

// ------------- export / run -------------
// For Vercel / serverless:
export default app;

// For local / Docker / Kubernetes, uncomment:
// app.listen(Number(PORT), () => {
//   slog(`Server running: http://localhost:${Number(PORT)}`);
// });
