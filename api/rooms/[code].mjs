import { getRoomState, sendJson } from "../../lib/roomservice.mjs";

export default async function handler(req, res) {
  try {
    const match = /^([A-F\d]{6})$/.exec(String(req.query.code ?? "").toUpperCase());
    if (!match) return sendJson(res, 404, { error: "Not found." });
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed." });
    return sendJson(res, 200, getRoomState(match[1], req.headers.authorization));
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message || "Request failed." });
  }
}
