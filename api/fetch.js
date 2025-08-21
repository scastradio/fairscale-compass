import { getSession } from "./_utils/session.js";

function intish(v, def = 0) {
  const m = String(v ?? "").match(/-?\d+/);
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export default async function handler(req, res) {
  const {
    TWITTERAPI_IO_KEY,
    WEBHOOK_URL,
    SESSION_SECRET = "devsecret",
    TWEET_COUNT = "25",
    INCLUDE_REPLIES = "false",

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

    PFP_X = "175", PFP_Y = "200", PFP_SIZE = "100",
    HANDLE_X = "300", HANDLE_Y = "200", HANDLE_FONT_PX = "70", HANDLE_COLOR = "#ffffff"
  } = process.env;

  if (!TWITTERAPI_IO_KEY || !WEBHOOK_URL) {
    res.status(500).end("Missing required env vars");
    return;
  }

  const sess = getSession(req, SESSION_SECRET);
  if (!sess?.accessToken || !sess?.username) {
    res.statusCode = 307;
    res.setHeader("Location", "/login");
    res.end();
    return;
  }

  const desired = Math.max(1, Number(TWEET_COUNT) || 50);
  const includeReplies = String(INCLUDE_REPLIES).toLowerCase() === "true";

  try {
    const collected = [];
    let cursor = "";
    while (collected.length < desired) {
      const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
      url.searchParams.set("userName", sess.username);
      url.searchParams.set("includeReplies", includeReplies ? "true" : "false");
      if (cursor) url.searchParams.set("cursor", cursor);

      const r = await fetch(url, { headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" } });
      if (!r.ok) throw new Error(`TwitterAPI.io error ${r.status}: ${await r.text().catch(()=>"")}`);
      const j = await r.json();
      const page = Array.isArray(j.data?.tweets) ? j.data.tweets : [];
      if (page.length === 0) break;
      collected.push(...page);
      if (!j.has_next_page || !j.next_cursor) break;
      cursor = j.next_cursor;
    }

    const tweetsToSend = collected.slice(0, desired);

    const webhookResp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { id: sess.userId, username: sess.username },
        count: tweetsToSend.length,
        tweets: tweetsToSend,
        source: "twitterapi.io"
      })
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
      } else if (typeof parsedAny === "object" && parsedAny) {
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

      const PFP = { x: intish(PFP_X, 32), y: intish(PFP_Y, 32), size: Math.max(1, intish(PFP_SIZE, 96)) };
      const HANDLE = {
        x: intish(HANDLE_X, 144),
        y: intish(HANDLE_Y, 48),
        fontPx: Math.max(8, intish(HANDLE_FONT_PX, 36)),
        color: String(HANDLE_COLOR || "#ffffff")
      };

      const username = sess.username || "";
      const hasPfp = Boolean(sess.profileImageUrl);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
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
    left: ${envLeft}, right: ${envRight}, top: ${envTop}, bottom: ${envBottom},
    needleScale: ${needleScale}, needleWidthFrac: ${needleWidthFrac},
    bg: ${JSON.stringify(bgPath)},
    pfp: { present: ${hasPfp ? "true" : "false"}, url: "/pfp", x: ${PFP.x}, y: ${PFP.y}, size: ${PFP.size} },
    handle: { text: ${JSON.stringify('@' + username)}, x: ${HANDLE.x}, y: ${HANDLE.y}, fontPx: ${HANDLE.fontPx}, color: ${JSON.stringify(HANDLE.color)} }
  };

  const C_RED='rgb(217,83,79)', C_ORG='rgb(240,173,78)', C_GRN='rgb(92,184,92)';
  const canvas=document.getElementById('stage'); const ctx=canvas.getContext('2d');
  try{ await document.fonts.load('700 '+CFG.handle.fontPx+'px ManropeBold'); }catch(e){}
  const bg=new Image(); bg.src=CFG.bg;
  const pfp=new Image(); if(CFG.pfp.present){ pfp.crossOrigin='anonymous'; pfp.src=CFG.pfp.url; }
  await new Promise(r=>{bg.onload=r;bg.onerror=r}); await new Promise(r=>{if(!CFG.pfp.present)return r(); pfp.onload=r; pfp.onerror=r;});
  canvas.width=bg.naturalWidth||bg.width; canvas.height=bg.naturalHeight||bg.height;
  ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(bg,0,0,canvas.width,canvas.height);
  if(CFG.pfp.present&&pfp.width&&pfp.height){ ctx.drawImage(pfp,CFG.pfp.x,CFG.pfp.y,CFG.pfp.size,CFG.pfp.size); }
  ctx.save(); ctx.fillStyle=CFG.handle.color; ctx.font='700 '+CFG.handle.fontPx+'px ManropeBold'; ctx.textBaseline='top'; ctx.fillText(CFG.handle.text,CFG.handle.x,CFG.handle.y); ctx.restore();
  const rect={ x:CFG.left, y:CFG.top, w:Math.max(0,canvas.width-CFG.left-CFG.right), h:Math.max(0,canvas.height-CFG.top-CFG.bottom) };
  const r=Math.max(1,Math.min(rect.w/2,rect.h)), cx=Math.round(rect.x+rect.w/2), cy=Math.round(rect.y+rect.h);
  const trackW=Math.max(6,Math.round(r*0.11)), valueW=Math.max(4,Math.round(r*0.08)); const start=Math.PI, end=2*Math.PI;

  function drawTrack(){ ctx.save(); ctx.lineCap='round'; ctx.lineWidth=trackW; ctx.strokeStyle='#090f00'; ctx.beginPath(); ctx.arc(cx,cy,r,start,end,false); ctx.stroke(); ctx.restore(); }
  function drawValue(v){
    const thetaEnd = start + (v/100)*(end-start); const capAngle=(valueW/2)/r;
    if(thetaEnd<=start+capAngle){ ctx.save(); ctx.lineCap='round'; ctx.lineWidth=valueW; ctx.strokeStyle=C_RED; ctx.beginPath(); ctx.arc(cx,cy,r,start,thetaEnd,false); ctx.stroke(); ctx.restore(); return; }
    ctx.save(); ctx.lineCap='round'; ctx.lineWidth=valueW; ctx.strokeStyle=C_RED; ctx.beginPath(); ctx.arc(cx,cy,r,start,start+capAngle,false); ctx.stroke(); ctx.restore();
    const gradStart=start+capAngle+1e-4; const grad=ctx.createConicGradient(gradStart,cx,cy); grad.addColorStop(0.00,C_RED); grad.addColorStop(0.50,C_ORG); grad.addColorStop(1.00,C_GRN);
    ctx.save(); ctx.lineCap='butt'; ctx.lineWidth=valueW; ctx.strokeStyle=grad; ctx.beginPath(); ctx.arc(cx,cy,r,start+capAngle,thetaEnd,false); ctx.stroke(); ctx.restore();
  }
  function drawNeedle(v){
    const a=start+(v/100)*(end-start);
    const r1d=r-Math.max(10,Math.round(r*0.30)), r2d=r+Math.max(8,Math.round(r*0.05)), mid=(r1d+r2d)/2, half=(r2d-r1d)/2;
    const halfNew=half*CFG.needleScale, r1=mid-halfNew, r2=mid+halfNew;
    const x1=cx+Math.cos(a)*r1, y1=cy+Math.sin(a)*r1, x2=cx+Math.cos(a)*r2, y2=cy+Math.sin(a)*r2;
    ctx.save(); ctx.strokeStyle='#e6e6e8'; ctx.lineWidth=Math.max(2,Math.round(r*CFG.needleWidthFrac)); ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); ctx.restore();
  }
  drawTrack(); drawValue(value); drawNeedle(value);
  document.getElementById('downloadPng').addEventListener('click',()=>{ const url=canvas.toDataURL('image/png'); const a=document.createElement('a'); a.href=url; a.download='sentiment-gauge-'+Date.now()+'.png'; document.body.appendChild(a); a.click(); a.remove(); });
})();</script>
</body></html>`);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<p style="font-family:system-ui;color:#eee;">Sent ${tweetsToSend.length} tweets from @${sess.username} to webhook.</p>
<pre style="white-space:pre-wrap;color:#ccc;background:#111;padding:12px;border-radius:8px;">Webhook response: ${bodyText}</pre>
<p><a href="/" style="color:#9cf;">Back</a></p>`);
  } catch (e) {
    console.error("Error fetching/sending tweets:", e);
    res.status(500).end("Failed to fetch tweets or send to webhook.");
  }
}
