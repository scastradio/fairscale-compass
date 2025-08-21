// server.js
import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { TwitterApi } from "twitter-api-v2";
import path from "path";

dotenv.config();

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

  // Score thresholds for background switching
  // [0..THRESH_SB-1] strongly-bearish
  // [THRESH_SB..THRESH_B-1] bearish
  // [THRESH_B..THRESH_N-1] neutral
  // [THRESH_N..THRESH_BU-1] bullish
  // [THRESH_BU..100] strongly-bullish
  THRESH_SB = "20",
  THRESH_B  = "40",
  THRESH_N  = "60",
  THRESH_BU = "80",

  // Needle tuning
  NEEDLE_LEN_SCALE = "1.0",     // 1.0 = default length; scales around midpoint
  NEEDLE_WIDTH_FRAC = "0.025",  // thickness as fraction of radius

  // Profile picture & handle placement (pixels)
  PFP_X = "175",
  PFP_Y = "200",
  PFP_SIZE = "100",

  HANDLE_X = "300",
  HANDLE_Y = "200",
  HANDLE_FONT_PX = "70",
  HANDLE_COLOR = "#ffffff",
} = process.env;

// Lenient integer parser: pulls first integer from a string (e.g., "150x" -> 150)
function intish(v, def = 0) {
  const m = String(v ?? "").match(/-?\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

function required(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET", "CALLBACK_URL", "TWITTERAPI_IO_KEY", "WEBHOOK_URL"].forEach(required);

const app = express();
app.use("/assets", express.static(path.join(process.cwd(), "assets")));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));

const oauthClient = new TwitterApi({ clientId: TWITTER_CLIENT_ID, clientSecret: TWITTER_CLIENT_SECRET });

// --- Same-origin proxy for the user's Twitter profile image (so canvas exports aren't tainted) ---
app.get("/pfp", async (req, res) => {
  try {
    const url = req.session?.profileImageUrl;
    if (!url) return res.status(404).send("No profile image URL");
    const r = await fetch(url, { headers: { "User-Agent": "Fairscale-Compass/1.0" } });
    if (!r.ok) return res.status(502).send("Failed to fetch avatar");
    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = await r.arrayBuffer();
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.end(Buffer.from(buf));
  } catch (e) {
    console.error("PFP proxy error:", e);
    return res.status(500).send("PFP proxy error");
  }
});

app.get("/", (req, res) => {
  if (req.session?.accessToken && req.session?.username) return res.redirect("/fetch");
  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
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
  <p class="desc">Connect your X account and we’ll generate a sleek sentiment gauge from your recent posts. We’ll fetch your handle and render a preview with the needle positioned by your latest activity — perfect for demos, teasers, and social sharing.</p>
  <a class="cta" href="/login"><span class="x">𝕏</span> Connect with X</a>
  <p class="fine">By continuing you agree to simulate non-production scores.</p>
  </section></main></body></html>`);
});

app.get("/login", async (req, res) => {
  // We will call v2.me() ONCE after OAuth to get username/id, cache it, and never call X again.
  const { url, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: ["tweet.read", "users.read", "offline.access"],
  });
  req.session.state = state;
  req.session.codeVerifier = codeVerifier;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const { state, code } = req.query;
  if (!state || !code || state !== req.session.state) return res.status(400).send("Invalid OAuth2 callback");
  try {
    const { client, accessToken, refreshToken, expiresIn, scope } = await oauthClient.loginWithOAuth2({
      code,
      codeVerifier: req.session.codeVerifier,
      redirectUri: CALLBACK_URL,
    });

    // Cache tokens (we won't use X REST after this)
    req.session.accessToken = accessToken;
    req.session.refreshToken = refreshToken;
    req.session.expiresIn = expiresIn;
    req.session.scope = scope;

    // --- SINGLE call to X API to get id + username (cached) ---
    // This should be well under per-user 25/day if you only do it on initial login.
    if (!req.session.username || !req.session.userId) {
      try {
        const me = await client.v2.me(); // DO NOT loop/retry; one shot
        req.session.userId = me.data.id;
        req.session.username = me.data.username;
      } catch (e) {
        console.error("v2.me() failed; cannot derive username from OAuth:", e?.code || e?.message || e);
        // If this fails (e.g., 429), we cannot guess username from the OAuth token itself.
        // Surface a clear message and stop here so we do not loop or hit more limits.
        return res.status(429).send(
          "Twitter rate limit hit while fetching your username. Please retry login later."
        );
      }
    }

    // --- Fetch PFP from twitterapi.io ONCE and cache ---
    try {
      const infoUrl = new URL("https://api.twitterapi.io/twitter/user/info");
      infoUrl.searchParams.set("userName", req.session.username);
      const infoResp = await fetch(infoUrl.toString(), {
        method: "GET",
        headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" },
      });
      if (infoResp.ok) {
        const info = await infoResp.json().catch(() => ({}));
        let pfp = info?.data?.profilePicture || "";
        if (pfp && typeof pfp === "string" && pfp.includes("_normal")) {
          pfp = pfp.replace("_normal", "_400x400");
        }
        if (pfp) req.session.profileImageUrl = pfp;
        if (info?.data?.id) req.session.userId = info.data.id; // prefer the same id they use
      } else {
        console.warn("twitterapi.io /twitter/user/info failed:", infoResp.status);
      }
    } catch (e) {
      console.warn("twitterapi.io /twitter/user/info error:", e);
    }

    res.redirect("/fetch");
  } catch (e) {
    console.error("OAuth2 callback error:", e);
    res.status(500).send("Callback failed");
  }
});

app.get("/fetch", async (req, res) => {
  if (!req.session?.accessToken || !req.session?.username) return res.redirect("/login");

  const desired = Math.max(1, Number(TWEET_COUNT) || 50);
  const includeReplies = String(INCLUDE_REPLIES).toLowerCase() === "true";

  try {
    // Tweets via twitterapi.io (no Twitter REST calls)
    const collected = [];
    let cursor = "";
    while (collected.length < desired) {
      const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
      url.searchParams.set("userName", req.session.username);
      url.searchParams.set("includeReplies", includeReplies ? "true" : "false");
      if (cursor) url.searchParams.set("cursor", cursor);

      const resp = await fetch(url.toString(), { method: "GET", headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" } });
      if (!resp.ok) throw new Error(`TwitterAPI.io error ${resp.status}: ${await resp.text().catch(() => "")}`);

      const data = await resp.json();
      const page = Array.isArray(data.data?.tweets) ? data.data.tweets : [];
      if (page.length === 0) break;
      collected.push(...page);
      if (!data.has_next_page || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    const tweetsToSend = collected.slice(0, desired);

    const webhookResp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { id: req.session.userId, username: req.session.username },
        count: tweetsToSend.length,
        tweets: tweetsToSend,
        source: "twitterapi.io",
      }),
    });

    const bodyText = await webhookResp.text();

    let displayScore = null;
    try {
      const parsedAny = JSON.parse(bodyText);
      let P = 0, Neut = 0, Neg = 0;
      if (Array.isArray(parsedAny)) {
        for (const obj of parsedAny) {
          if (obj && typeof obj === "object") {
            if (typeof obj.Positive === "number") P += obj.Positive;
            if (typeof obj.Neutral === "number") Neut += obj.Neutral;
            if (typeof obj.Negative === "number") Neg += obj.Negative;
          }
        }
      } else if (typeof parsedAny === "object") {
        if (typeof parsedAny.Positive === "number") P = parsedAny.Positive;
        if (typeof parsedAny.Neutral === "number") Neut = parsedAny.Neutral;
        if (typeof parsedAny.Negative === "number") Neg = parsedAny.Negative;
      }
      const T = P + Neut + Neg || tweetsToSend.length || 0;
      if (T > 0) displayScore = Math.round(((P - Neg + T) / (2 * T)) * 100);
    } catch {
      console.log(`Webhook response (raw): ${bodyText}`);
    }

    if (displayScore !== null) {
      // Read env-driven layout + thresholds + overlay text/pfp config
      const envLeft = intish(GAUGE_LEFT, 0);
      const envRight = intish(GAUGE_RIGHT, 0);
      const envTop = intish(GAUGE_TOP, 0);
      const envBottom = intish(GAUGE_BOTTOM, 0);

      const tSB = Math.max(0, Math.min(100, intish(THRESH_SB, 20)));
      const tB  = Math.max(tSB, Math.min(100, intish(THRESH_B, 40)));
      const tN  = Math.max(tB,  Math.min(100, intish(THRESH_N, 60)));
      const tBU = Math.max(tN,  Math.min(100, intish(THRESH_BU, 80)));

      const needleScale = Math.max(0.1, Number(NEEDLE_LEN_SCALE) || 1.0);
      const needleWidthFrac = Math.max(0.003, Number(NEEDLE_WIDTH_FRAC) || 0.025);

      const s = Math.max(0, Math.min(100, displayScore));
      let bgFile = "strongly-bearish.png";
      if (s >= tSB && s < tB)   bgFile = "bearish.png";
      else if (s >= tB && s < tN)  bgFile = "neutral.png";
      else if (s >= tN && s < tBU) bgFile = "bullish.png";
      else if (s >= tBU)           bgFile = "strongly-bullish.png";
      const bgPath = `/assets/${bgFile}`;

      const PFP = {
        x: intish(PFP_X, 32),
        y: intish(PFP_Y, 32),
        size: Math.max(1, intish(PFP_SIZE, 96)),
      };
      const HANDLE = {
        x: intish(HANDLE_X, 144),
        y: intish(HANDLE_Y, 48),
        fontPx: Math.max(8, intish(HANDLE_FONT_PX, 36)),
        color: String(HANDLE_COLOR || "#ffffff"),
      };

      const username = req.session.username || "";
      const hasPfp = Boolean(req.session.profileImageUrl);

      return res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Fairscale Compass — Gauge</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>:root{color-scheme:dark}
@font-face{font-family:ManropeBold;src:url('/assets/fonts/Manrope-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
body{background:#0f0f10;color:#e8e6e6;font-family:ManropeBold,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px}
.wrap{max-width:1000px;margin:0 auto;text-align:center}
#stage{width:100%;height:auto;display:block;margin:0 auto}
.btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:18px}
button,a.btn{font-size:15px;padding:10px 16px;border:1px solid #2a2a2a;border-radius:10px;background:#1a1a1b;color:#e6e6e6;cursor:pointer;text-decoration:none}
button:hover,a.btn:hover{background:#222}</style></head>
<body>
  <div class="wrap">
    <canvas id="stage"></canvas>
    <div class="btns">
      <button id="downloadPng">Download</button>
      <a class="btn" href="/logout">Logout</a>
    </div>
  </div>

<script>(async function(){
  const value = Math.max(0, Math.min(100, ${displayScore}));
  const CFG = {
    left: ${envLeft},
    right: ${envRight},
    top: ${envTop},
    bottom: ${envBottom},
    needleScale: ${needleScale},
    needleWidthFrac: ${needleWidthFrac},
    bg: ${JSON.stringify(bgPath)},
    pfp: { present: ${hasPfp ? "true" : "false"}, url: "/pfp", x: ${PFP.x}, y: ${PFP.y}, size: ${PFP.size} },
    handle: { text: ${JSON.stringify('@' + username)}, x: ${HANDLE.x}, y: ${HANDLE.y}, fontPx: ${HANDLE.fontPx}, color: ${JSON.stringify(HANDLE.color)} }
  };

  const C_RED = 'rgb(217,83,79)';
  const C_ORG = 'rgb(240,173,78)';
  const C_GRN = 'rgb(92,184,92)';

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');

  try { await document.fonts.load('700 ' + CFG.handle.fontPx + 'px ManropeBold'); } catch(e){}

  const bg = new Image();
  bg.src = CFG.bg;

  const pfp = new Image();
  if (CFG.pfp.present) {
    pfp.crossOrigin = 'anonymous';
    pfp.src = CFG.pfp.url;
  }

  await new Promise((resolve)=>{ bg.onload = resolve; bg.onerror = resolve; });
  await new Promise((resolve)=>{ if(!CFG.pfp.present){return resolve();} pfp.onload = resolve; pfp.onerror = resolve; });

  canvas.width = bg.naturalWidth || bg.width;
  canvas.height = bg.naturalHeight || bg.height;

  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

  if (CFG.pfp.present && pfp.width && pfp.height) {
    ctx.drawImage(pfp, CFG.pfp.x, CFG.pfp.y, CFG.pfp.size, CFG.pfp.size);
  }

  ctx.save();
  ctx.fillStyle = CFG.handle.color;
  ctx.font = '700 ' + CFG.handle.fontPx + 'px ManropeBold';
  ctx.textBaseline = 'top';
  ctx.fillText(CFG.handle.text, CFG.handle.x, CFG.handle.y);
  ctx.restore();

  const rect = {
    x: CFG.left,
    y: CFG.top,
    w: Math.max(0, canvas.width - CFG.left - CFG.right),
    h: Math.max(0, canvas.height - CFG.top - CFG.bottom),
  };

  const r = Math.max(1, Math.min(rect.w / 2, rect.h));
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h);

  const trackW = Math.max(6, Math.round(r * 0.11));
  const valueW = Math.max(4, Math.round(r * 0.08));
  const start = Math.PI;
  const end = 2 * Math.PI;

  function drawTrack(){
    ctx.save();
    ctx.lineCap='round';
    ctx.lineWidth=trackW;
    ctx.strokeStyle='#090f00';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end, false);
    ctx.stroke();
    ctx.restore();
  }

  function drawValue(v){
    const thetaEnd = start + (v/100)*(end-start);
    const capAngle = (valueW/2) / r;

    if (thetaEnd <= start + capAngle) {
      ctx.save();
      ctx.lineCap='round';
      ctx.lineWidth=valueW;
      ctx.strokeStyle=C_RED;
      ctx.beginPath();
      ctx.arc(cx,cy,r,start,thetaEnd,false);
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.lineCap='round';
    ctx.lineWidth=valueW;
    ctx.strokeStyle=C_RED;
    ctx.beginPath();
    ctx.arc(cx,cy,r,start,start+capAngle,false);
    ctx.stroke();
    ctx.restore();

    const gradStart = start + capAngle + 1e-4;
    const grad = ctx.createConicGradient(gradStart, cx, cy);
    grad.addColorStop(0.00,  C_RED);
    grad.addColorStop(0.50,  C_ORG);
    grad.addColorStop(1.00,  C_GRN);

    ctx.save();
    ctx.lineCap='butt';
    ctx.lineWidth=valueW;
    ctx.strokeStyle=grad;
    ctx.beginPath();
    ctx.arc(cx,cy,r,start+capAngle,thetaEnd,false);
    ctx.stroke();
    ctx.restore();
  }

  function drawNeedle(v){
    const a = start + (v/100)*(end-start);

    const r1_def = r - Math.max(10, Math.round(r * 0.30));
    const r2_def = r + Math.max(8,  Math.round(r * 0.05));
    const mid_def = (r1_def + r2_def) / 2;
    const halfLen_def = (r2_def - r1_def) / 2;

    const halfLen_new = halfLen_def * CFG.needleScale;
    const r1 = mid_def - halfLen_new;
    const r2 = mid_def + halfLen_new;

    const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
    const x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * r2;

    ctx.save();
    ctx.strokeStyle='#e6e6e8';
    ctx.lineWidth = Math.max(2, Math.round(r * CFG.needleWidthFrac));
    ctx.lineCap='round';
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x2,y2);
    ctx.stroke();
    ctx.restore();
  }

  drawTrack();
  drawValue(value);
  drawNeedle(value);

  document.getElementById('downloadPng').addEventListener('click',()=>{
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sentiment-gauge-' + Date.now() + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
})();</script>
</body></html>`);
    }

    res.send(`<p style="font-family:system-ui;color:#eee;">Sent ${tweetsToSend.length} tweets from @${req.session.username} to webhook.</p>
    <pre style="white-space:pre-wrap;color:#ccc;background:#111;padding:12px;border-radius:8px;">Webhook response: ${bodyText}</pre>
    <p><a href="/" style="color:#9cf;">Back</a></p>`);
  } catch (e) {
    console.error("Error fetching/sending tweets:", e);
    res.status(500).send("Failed to fetch tweets or send to webhook.");
  }
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.listen(Number(PORT), () => {
  console.log(`Server running: http://localhost:${Number(PORT)}`);
});
