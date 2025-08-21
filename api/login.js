import { TwitterApi } from "twitter-api-v2";
import { setSession, getSession } from "./_utils/session.js";

export default async function handler(req, res) {
  const {
    TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET,
    CALLBACK_URL,
    SESSION_SECRET = "devsecret"
  } = process.env;

  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET || !CALLBACK_URL) {
    res.status(500).end("Missing Twitter OAuth env vars");
    return;
  }

  const oauthClient = new TwitterApi({
    clientId: TWITTER_CLIENT_ID,
    clientSecret: TWITTER_CLIENT_SECRET
  });

  const { url, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: ["tweet.read", "users.read", "offline.access"]
  });

  // Store minimal oauth state in cookie
  const prior = getSession(req, SESSION_SECRET) || {};
  setSession(res, { ...prior, oauth_state: state, oauth_verifier: codeVerifier }, SESSION_SECRET);

  res.statusCode = 307;
  res.setHeader("Location", url);
  res.end();
}
