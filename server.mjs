import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMove, createGame, finishByTimeout, publicState } from "./game.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const assets = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/style.css", "style.css"],
  ["/client.mjs", "client.mjs"],
  ["/game.mjs", "game.mjs"],
]);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, value) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw httpError(415, "Send JSON content.");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw httpError(413, "Request is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw httpError(400, "Invalid JSON.");
  }
}

function readName(value) {
  if (typeof value !== "string") throw httpError(400, "Enter a player name.");
  const name = value.trim();
  if (!name || name.length > 20 || /[\u0000-\u001f\u007f]/.test(name)) throw httpError(400, "Player names must be 1 to 20 characters.");
  return name;
}

function readTimeLimit(value) {
  if (value === undefined || value === null || value === "") return 10;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 3 || minutes > 20) {
    throw httpError(400, "Pick a game time limit between 3 and 20 minutes.");
  }
  return Math.round(minutes);
}

function publicRoom(room, viewerId) {
  expireByDeadline(room);
  if (!room.game) {
    return {
      status: "waiting",
      roomCode: room.code,
      hostId: room.hostId,
      timeLimitMinutes: room.timeLimit,
      timeLeftMs: null,
      players: room.members.map(({ id, name }) => ({ id, name, cardCount: 0, hand: null, isHost: id === room.hostId })),
    };
  }
  const state = publicState(room.game, viewerId);
  state.roomCode = room.code;
  state.timeLimitMinutes = room.timeLimit;
  state.timeLeftMs = state.status === "playing" ? Math.max(0, room.deadline - Date.now()) : null;
  state.players = state.players.map((player) => ({ ...player, isHost: player.id === room.hostId }));
  return state;
}

function expireByDeadline(room) {
  if (room.game && !room.game.winner && room.deadline && Date.now() >= room.deadline) finishByTimeout(room.game);
}

function makeRoomCode() {
  let code;
  do code = randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
}

function memberFor(req, room) {
  const token = /^Bearer ([a-f\d]{64})$/i.exec(req.headers.authorization ?? "")?.[1];
  const member = room.members.find((seat) => seat.token === token);
  if (!member) throw httpError(401, "This room session is not valid.");
  return member;
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    throw httpError(403, "Cross-origin requests are not allowed.");
  }
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") checkOrigin(req);
        if (req.method === "POST" && url.pathname === "/api/rooms") {
          const body = await readJson(req);
          const host = { id: randomUUID(), token: randomBytes(32).toString("hex"), name: readName(body.name) };
          const room = { code: makeRoomCode(), hostId: host.id, members: [host], game: null, timeLimit: readTimeLimit(body.timeLimit), deadline: null };
          rooms.set(room.code, room);
          return send(res, 201, { roomCode: room.code, playerId: host.id, playerToken: host.token, state: publicRoom(room, host.id) });
        }

        const match = /^\/api\/rooms\/([A-F\d]{6})(?:\/(join|start|move))?$/.exec(url.pathname);
        if (!match) return send(res, 404, { error: "Not found." });
        const [, code, action] = match;
        const room = rooms.get(code);
        if (!room) throw httpError(404, "Room not found.");

        if (action === "join" && req.method === "POST") {
          const body = await readJson(req);
          if (room.game) throw httpError(409, "This game has already started.");
          if (room.members.length >= 8) throw httpError(409, "This room is full (8 players maximum).");
          const member = { id: randomUUID(), token: randomBytes(32).toString("hex"), name: readName(body.name) };
          room.members.push(member);
          return send(res, 201, { roomCode: room.code, playerId: member.id, playerToken: member.token, state: publicRoom(room, member.id) });
        }

        const member = memberFor(req, room);
        if (!action && req.method === "GET") return send(res, 200, publicRoom(room, member.id));
        if (action === "start" && req.method === "POST") {
          if (member.id !== room.hostId) throw httpError(403, "Only the host can start the game.");
          if (room.game) throw httpError(409, "This game has already started.");
          if (room.members.length < 2) throw httpError(409, "A second player must join before starting.");
          room.game = createGame(room.members.map(({ id, name }) => ({ id, name })), Math.random);
          room.deadline = Date.now() + room.timeLimit * 60_000;
          return send(res, 200, publicRoom(room, member.id));
        }
        if (action === "move" && req.method === "POST") {
          if (!room.game) throw httpError(409, "The host has not started this game yet.");
          expireByDeadline(room);
          const body = await readJson(req);
          const nextGame = structuredClone(room.game);
          applyMove(nextGame, member.id, body);
          room.game = nextGame;
          return send(res, 200, publicRoom(room, member.id));
        }
        return send(res, 405, { error: "Method not allowed." });
      }

      if ((req.method === "GET" || req.method === "HEAD") && assets.has(url.pathname)) {
        const file = join(root, assets.get(url.pathname));
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
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 400, { error: error.message || "Request failed." });
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
