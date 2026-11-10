import { checkOrigin, createRoom, readJson, sendJson } from "../lib/roomservice.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendJson(res, 404, { error: "Not found." });
    checkOrigin(req);
    const body = await readJson(req);
    return sendJson(res, 201, createRoom(body));
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message || "Request failed." });
  }
}
