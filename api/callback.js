import { TwitterApi } from "twitter-api-v2";
import { getSession, setSession } from "./_utils/session.js";

export default async function handler(req, res) {
  const {
    TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET,
    CALLBACK_URL,
    TWITTERAPI_IO_KEY,
    SESSION_SECRET = "devsecret"
  } = process.env;

  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET || !CALLBACK_URL || !TWITTERAPI_IO_KEY) {
    res.status(500).end("Missing required env vars");
    return;
  }

  const session = getSession(req, SESSION_SECRET) || {};
  const url = new URL(req.url, `https://${req.headers.host}`);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state || !code || state !== session.oauth_state) {
    res.status(400).end("Invalid OAuth2 callback");
    return;
  }

  try {
    const oauthClient = new TwitterApi({
      clientId: TWITTER_CLIENT_ID,
      clientSecret: TWITTER_CLIENT_SECRET
    });

    const { client, accessToken, refreshToken, expiresIn, scope } = await oauthClient.loginWithOAuth2({
      code,
      codeVerifier: session.oauth_verifier,
      redirectUri: CALLBACK_URL
    });

    // One call to X to get username/id
    let userId = null, username = null;
    try {
      const me = await client.v2.me();
      userId = me.data.id;
      username = me.data.username;
    } catch (e) {
      console.error("v2.me() failed:", e?.code || e?.message || e);
      res.status(429).end("Rate limited while fetching your username. Please retry later.");
      return;
    }

    // Pull PFP from twitterapi.io (cache best effort)
    let profileImageUrl = "";
    try {
      const infoUrl = new URL("https://api.twitterapi.io/twitter/user/info");
      infoUrl.searchParams.set("userName", username);
      const r = await fetch(infoUrl, { headers: { "x-api-key": TWITTERAPI_IO_KEY, accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        let pfp = j?.data?.profilePicture || "";
        if (pfp && typeof pfp === "string" && pfp.includes("_normal")) pfp = pfp.replace("_normal", "_400x400");
        if (pfp) profileImageUrl = pfp;
        if (j?.data?.id) userId = j.data.id; // align ids
      } else {
        console.warn("twitterapi.io info failed:", r.status);
      }
    } catch (e) {
      console.warn("twitterapi.io info error:", e);
    }

    setSession(res, {
      userId, username, profileImageUrl,
      accessToken, refreshToken, expiresIn, scope
    }, SESSION_SECRET);

    res.statusCode = 307;
    res.setHeader("Location", "/fetch");
    res.end();
  } catch (e) {
    console.error("OAuth2 callback error:", e);
    res.status(500).end("Callback failed");
  }
}
