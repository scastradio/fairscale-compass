import { clearSession } from "./_utils/session.js";

export default async function handler(req, res) {
  clearSession(res);
  res.statusCode = 307;
  res.setHeader("Location", "/");
  res.end();
}
