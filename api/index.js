export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"/>
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
  <p class="desc">Connect your X account and we’ll generate a sleek sentiment gauge from your recent posts. We’ll fetch your handle and render a preview — no extra inputs.</p>
  <a class="cta" href="/login"><span class="x">𝕏</span> Connect with X</a>
  <p class="fine">By continuing you agree to simulate non-production scores.</p>
  </section></main></body></html>`);
}
