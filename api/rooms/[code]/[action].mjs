import { checkOrigin, doMove, joinRoom, readJson, sendJson, startGame } from "../../../lib/roomservice.mjs";

const ACTIONS = { join: 201, start: 200, move: 200 };

export default async function handler(req, res) {
  try {
    const action = String(req.query.action ?? "");
    const code = String(req.query.code ?? "").toUpperCase();
    if (!ACTIONS[action] || !/^([A-F\d]{6})$/.test(code)) return sendJson(res, 404, { error: "Not found." });
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
    checkOrigin(req);
    if (action === "join") {
      const body = await readJson(req);
      return sendJson(res, 201, joinRoom(code, body));
    }
    if (action === "start") return sendJson(res, 200, startGame(code, req.headers.authorization));
    const body = await readJson(req);
    return sendJson(res, 200, doMove(code, req.headers.authorization, body));
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message || "Request failed." });
  }
}
