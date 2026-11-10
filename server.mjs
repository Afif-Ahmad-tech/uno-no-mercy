import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOrigin, createRoom, doMove, getRoomState, joinRoom, readJson, sendJson, startGame } from "./lib/roomservice.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/style.css", "style.css"],
  ["/client.mjs", "client.mjs"],
  ["/game.mjs", "game.mjs"],
]);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };

export async function routeRequest(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  const match = /^\/api\/rooms((?:\/([A-F\d]{6}))?(?:\/(join|start|move))?)?$/.exec(pathname);
  if (!match) return null;
  const [, base, code, action] = match;
  if (req.method !== "GET") checkOrigin(req);
  if (!base) {
    if (req.method === "POST") await sendJson(res, 201, createRoom(await readJson(req)));
    else await sendJson(res, 404, { error: "Not found." });
    return true;
  }
  if (!action) {
    if (req.method === "GET") await sendJson(res, 200, getRoomState(code, req.headers.authorization));
    else await sendJson(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (req.method !== "POST") {
    await sendJson(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (action === "join") await sendJson(res, 201, joinRoom(code, await readJson(req)));
  else if (action === "start") await sendJson(res, 200, startGame(code, req.headers.authorization));
  else await sendJson(res, 200, doMove(code, req.headers.authorization, await readJson(req)));
  return true;
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if ((req.method === "GET" || req.method === "HEAD") && assets.has(pathname)) {
        const file = join(root, assets.get(pathname));
        const content = await readFile(file);
        res.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": content.length,
          "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          "Content-Type": mimeTypes[extname(file)],
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(req.method === "HEAD" ? undefined : content);
      }
      const handled = await routeRequest(req, res);
      if (handled) return;
      return sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status ?? 400, { error: error.message || "Request failed." });
      else res.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  server.listen(port, host, () => console.log(`Color Club is ready at http://localhost:${port}`));
}

export default createServer();
