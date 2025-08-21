import { getSession } from "./_utils/session.js";

export default async function handler(req, res) {
  const { SESSION_SECRET = "devsecret" } = process.env;
  const sess = getSession(req, SESSION_SECRET);
  try {
    const url = sess?.profileImageUrl;
    if (!url) { res.status(404).end("No profile image URL"); return; }
    const r = await fetch(url, { headers: { "User-Agent": "Fairscale-Compass/1.0" } });
    if (!r.ok) { res.status(502).end("Failed to fetch avatar"); return; }
    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(buf);
  } catch (e) {
    console.error("PFP proxy error:", e);
    res.status(500).end("PFP proxy error");
  }
}
