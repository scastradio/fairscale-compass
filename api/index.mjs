// Minimal Vercel serverless handler (no Express)
// Save as: api/index.mjs
import { TwitterApi } from "twitter-api-v2";
import crypto from "node:crypto";
import { URL } from "node:url";

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

  // Gauge layout
  GAUGE_LEFT = "500",
  GAUGE_RIGHT = "500",
  GAUGE_TOP = "100",
  GAUGE_BOTTOM = "400",

  THRESH_SB = "20",
  THRESH_B  = "40",
  THRESH_N  = "60",
  THRESH_BU = "80",

  NEEDLE_LEN_SCALE = "1.0",
  NEEDLE_WIDTH_FRAC = "0.025",

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

// ======== tiny utils ========
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const b64urlDecode = (s) => Buffer.from(s, "base64url").toString("utf8");

function sign(val) {
  return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(val).digest());
}
function setCookie(res, name, value, { maxAgeSec, path = "/", httpOnly = true, sameSite = "Lax", secure = true } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  const cookie = parts.join("; ");
  const prev = res.getHeader("Set-Cookie");
  if (prev) res.setHeader("Set-Cookie", Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
  else res.setHeader("Set-Cookie", cookie);
}
function clearCookie(res, name) {
  setCookie(res, name, "", { maxAgeSec: 0 });
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
  try {
    return JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
}

// Small helpers
const intish = (v, d=0) => {
  const m = String(v ?? "").match(/-?\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) ? n : d;
};

// ======== Router ========
export default async function handler(req, res) {
  try {
    const { pathname, searchParams } = new URL(req.url, "http://x"); // base doesn't matter

    if (pathname === "/healthz") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");
      return;
    }

    if (pathname === "/") {
      // Pure sync landing; never blocks.
      const sess = readSignedCookie(req, "fs:user"); // { username, userId, pfp }
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
      const { url, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(CALLBACK_URL, {
        scope: ["tweet.read", "users.read", "offline.access"],
      });
      // store only state+verifier temporarily (maxAge short)
      const tmp = makeSignedCookie({ state, codeVerifier, t: Date.now() });
      setCookie(res, "fs:oauth", tmp, { maxAgeSec: 600 });
      res.statusCode = 302;
      res.setHeader("Location", url);
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
      // Finish OAuth
      const oauthClient = new TwitterApi({ clientId: TWITTER_CLIENT_ID, clientSecret: TWITTER_CLIENT_SECRET });
      let username = null, userId = null;
      try {
        const { client } = await oauthClient.loginWithOAuth2({
          code,
          codeVerifier: oauthCookie.codeVerifier,
          redirectUri: CALLBACK_URL,
        });
        // single call to X for username/id
        const me = await client.v2.me();
        username = me?.data?.username || null;
        userId = me?.data?.id || null;
      } catch (e) {
        console.error("OAuth/me error:", e);
        res.statusCode = 429;
        res.end("Twitter rate limit or auth error while fetching username. Try again later.");
        return;
      }

      // fetch PFP via twitterapi.io (optional)
      let pfp = "";
      try {
        if (username) {
          must("TWITTERAPI_IO_KEY");
          const infoUrl = new URL("https://api.twitterapi.io/twitter/user/info");
          infoUrl.searchParams.set("userName", username);
          const r = await fetch(infoUrl.toString(), { headers: { "x-api-key": TWITTERAPI_IO_KEY }});
          if (r.ok) {
            const j = await r.json();
            pfp = j?.data?.profilePicture || "";
            if (pfp.includes("_normal")) pfp = pfp.replace("_normal", "_400x400");
            // prefer their ID if present
            if (j?.data?.id) userId = j.data.id;
          }
        }
      } catch (e) {
        console.warn("twitterapi.io user/info error:", e);
      }

      // store compact user session (no tokens)
      clearCookie(res, "fs:oauth");
      setCookie(res, "fs:user", makeSignedCookie({ username, userId, pfp, t: Date.now() }), { maxAgeSec: 60 * 60 * 24 * 30 });
      res.statusCode = 302;
      res.setHeader("Location", "/fetch");
      res.end();
      return;
    }

    if (pathname === "/logout") {
      clearCookie(res, "fs:user");
      clearCookie(res, "fs:oauth");
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.end();
      return;
    }

    if (pathname === "/pfp") {
      // same-origin proxy to avoid canvas taint
      const sess = readSignedCookie(req, "fs:user");
      if (!sess?.pfp) {
        res.statusCode = 404;
        res.end("No profile image URL");
        return;
      }
      try {
        const r = await fetch(sess.pfp, { headers: { "User-Agent": "Fairscale-Compass/1.0" } });
        if (!r.ok) {
          res.statusCode = 502;
          res.end("Failed to fetch avatar");
          return;
        }
        const ct = r.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "private, max-age=300");
        res.end(buf);
      } catch (e) {
        console.error("PFP proxy error:", e);
        res.statusCode = 500;
        res.end("PFP proxy error");
      }
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

      // Collect tweets via twitterapi.io
      const desired = Math.max(1, Number(TWEET_COUNT) || 50);
      const includeReplies = String(INCLUDE_REPLIES).toLowerCase() === "true";

      const collected = [];
      let cursor = "";
      let pages = 0;
      const MAX_PAGES = 5;
      try {
        while (collected.length < desired) {
          const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
          url.searchParams.set("userName", sess.username);
          url.searchParams.set("includeReplies", includeReplies ? "true" : "false");
          if (cursor) url.searchParams.set("cursor", cursor);

          const resp = await fetch(url.toString(), {
            headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" }
          });
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
        const html = gaugeHtml({
          score: displayScore,
          username: sess.username,
          pfpPresent: Boolean(sess.pfp),
          // env layout/tuning
          env: {
            left: intish(GAUGE_LEFT, 0),
            right: intish(GAUGE_RIGHT, 0),
            top: intish(GAUGE_TOP, 0),
            bottom: intish(GAUGE_BOTTOM, 0),
            tSB: Math.max(0, Math.min(100, intish(THRESH_SB, 20))),
            tB:  Math.max(0, Math.min(100, intish(THRESH_B, 40))),
            tN:  Math.max(0, Math.min(100, intish(THRESH_N, 60))),
            tBU: Math.max(0, Math.min(100, intish(THRESH_BU, 80))),
            needleScale: Math.max(0.1, Number(NEEDLE_LEN_SCALE) || 1.0),
            needleWidthFrac: Math.max(0.003, Number(NEEDLE_WIDTH_FRAC) || 0.025),
            pfp: { x: intish(PFP_X,32), y:intish(PFP_Y,32), size: Math.max(1,intish(PFP_SIZE,96)) },
            handle: { x:intish(HANDLE_X,144), y:intish(HANDLE_Y,48), fontPx:Math.max(8,intish(HANDLE_FONT_PX,36)), color:String(HANDLE_COLOR||"#fff") }
          }
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
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

    // 404
    res.statusCode = 404;
    res.end("Not found");
  } catch (e) {
    console.error("Top-level error:", e);
    res.statusCode = 500;
    res.end("Internal error");
  }
}

// ======== HTML renderers ========
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
  <p class="desc">Connect your X account and we’ll generate a sleek sentiment gauge from your recent posts. We’ll fetch your handle and render a preview with the needle positioned by your latest activity — perfect for demos, teasers, and social sharing.</p>
  <a class="cta" href="/login"><span class="x">𝕏</span> Connect with X</a>
  <p class="fine">By continuing you agree to simulate non-production scores.</p>
  </section></main></body></html>`;
}

function gaugeHtml({ score, username, pfpPresent, env }) {
  const s = Math.max(0, Math.min(100, score));
  let bgFile = "strongly-bearish.png";
  if (s >= env.tSB && s < env.tB) bgFile = "bearish.png";
  else if (s >= env.tB && s < env.tN) bgFile = "neutral.png";
  else if (s >= env.tN && s < env.tBU) bgFile = "bullish.png";
  else if (s >= env.tBU) bgFile = "strongly-bullish.png";
  const bgPath = `/assets/${bgFile}`;

  return `<!doctype html>
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
  const value = ${s};
  const CFG = {
    left:${env.left}, right:${env.right}, top:${env.top}, bottom:${env.bottom},
    needleScale:${env.needleScale}, needleWidthFrac:${env.needleWidthFrac},
    bg:${JSON.stringify(bgPath)},
    pfp:{ present:${pfpPresent ? "true" : "false"}, url:"/pfp", x:${env.pfp.x}, y:${env.pfp.y}, size:${env.pfp.size} },
    handle:{ text:${JSON.stringify('@' + (username || ""))}, x:${env.handle.x}, y:${env.handle.y}, fontPx:${env.handle.fontPx}, color:${JSON.stringify(env.handle.color)} }
  };

  const C_RED='rgb(217,83,79)', C_ORG='rgb(240,173,78)', C_GRN='rgb(92,184,92)';
  const canvas=document.getElementById('stage'); const ctx=canvas.getContext('2d');

  try { await document.fonts.load('700 ' + CFG.handle.fontPx + 'px ManropeBold'); } catch(e){ console.log('font load err', e); }

  const bg=new Image(); bg.src=CFG.bg;
  const pfp=new Image(); if (CFG.pfp.present){ pfp.crossOrigin='anonymous'; pfp.src=CFG.pfp.url; }

  await new Promise(r=>{ bg.onload=r; bg.onerror=r; });
  await new Promise(r=>{ if(!CFG.pfp.present){return r();} pfp.onload=r; pfp.onerror=r; });

  const bw=bg.naturalWidth||bg.width||1200, bh=bg.naturalHeight||bg.height||628;
  if(!bw||!bh) console.log('bg zero-size; using fallback canvas 1200 628');
  canvas.width=bw||1200; canvas.height=bh||628;

  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(bw&&bh) ctx.drawImage(bg,0,0,canvas.width,canvas.height);
  if(CFG.pfp.present && pfp.width && pfp.height) ctx.drawImage(pfp, CFG.pfp.x, CFG.pfp.y, CFG.pfp.size, CFG.pfp.size);

  ctx.save();
  ctx.fillStyle=CFG.handle.color;
  ctx.font='700 ' + CFG.handle.fontPx + 'px ManropeBold';
  ctx.textBaseline='top';
  ctx.fillText(CFG.handle.text, CFG.handle.x, CFG.handle.y);
  ctx.restore();

  const rect={x:CFG.left,y:CFG.top,w:Math.max(0,canvas.width-CFG.left-CFG.right),h:Math.max(0,canvas.height-CFG.top-CFG.bottom)};
  const r=Math.max(1,Math.min(rect.w/2,rect.h));
  const cx=Math.round(rect.x+rect.w/2), cy=Math.round(rect.y+rect.h);
  const trackW=Math.max(6,Math.round(r*0.11)), valueW=Math.max(4,Math.round(r*0.08));
  const start=Math.PI, end=2*Math.PI;

  function drawTrack(){ ctx.save(); ctx.lineCap='round'; ctx.lineWidth=trackW; ctx.strokeStyle='#090f00'; ctx.beginPath(); ctx.arc(cx,cy,r,start,end,false); ctx.stroke(); ctx.restore(); }
  function drawValue(v){
    const thetaEnd=start+(v/100)*(end-start);
    const capAngle=(valueW/2)/r;
    if(thetaEnd<=start+capAngle){
      ctx.save(); ctx.lineCap='round'; ctx.lineWidth=valueW; ctx.strokeStyle=C_RED; ctx.beginPath(); ctx.arc(cx,cy,r,start,thetaEnd,false); ctx.stroke(); ctx.restore(); return;
    }
    ctx.save(); ctx.lineCap='round'; ctx.lineWidth=valueW; ctx.strokeStyle=C_RED; ctx.beginPath(); ctx.arc(cx,cy,r,start,start+capAngle,false); ctx.stroke(); ctx.restore();
    const gradStart=start+capAngle+1e-4, grad=ctx.createConicGradient(gradStart,cx,cy);
    grad.addColorStop(0.00,C_RED); grad.addColorStop(0.50,C_ORG); grad.addColorStop(1.00,C_GRN);
    ctx.save(); ctx.lineCap='butt'; ctx.lineWidth=valueW; ctx.strokeStyle=grad; ctx.beginPath(); ctx.arc(cx,cy,r,start+capAngle,thetaEnd,false); ctx.stroke(); ctx.restore();
  }
  function drawNeedle(v){
    const a=start+(v/100)*(end-start);
    const r1_def=r-Math.max(10,Math.round(r*0.30)), r2_def=r+Math.max(8,Math.round(r*0.05));
    const mid_def=(r1_def+r2_def)/2, halfLen_def=(r2_def-r1_def)/2, halfLen_new=halfLen_def*${Number(NEEDLE_LEN_SCALE)||1};
    const r1=mid_def-halfLen_new, r2=mid_def+halfLen_new;
    const x1=cx+Math.cos(a)*r1, y1=cy+Math.sin(a)*r1;
    const x2=cx+Math.cos(a)*r2, y2=cy+Math.sin(a)*r2;
    ctx.save(); ctx.strokeStyle='#e6e6e8'; ctx.lineWidth=Math.max(2,Math.round(r*${Number(NEEDLE_WIDTH_FRAC)||0.025})); ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); ctx.restore();
  }

  drawTrack(); drawValue(value); drawNeedle(value);

  document.getElementById('downloadPng').addEventListener('click', ()=>{
    const url=canvas.toDataURL('image/png');
    const a=document.createElement('a'); a.href=url; a.download='sentiment-gauge-'+Date.now()+'.png';
    document.body.appendChild(a); a.click(); a.remove();
  });

  console.log('draw complete', { value, canvas:{ w:canvas.width, h:canvas.height }});
})();</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
