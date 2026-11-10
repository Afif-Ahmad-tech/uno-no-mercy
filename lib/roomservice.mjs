import { randomBytes, randomUUID } from "node:crypto";
import { applyMove, createGame, finishByTimeout, publicState } from "../game.mjs";

const MAX_SEATS = 8;
export const rooms = new Map();

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function sendJson(res, status, value) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(value));
}

export async function readJson(req) {
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

function makeRoomCode() {
  let code;
  do code = randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
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

function tokenFrom(authorization) {
  return /^Bearer ([a-f\d]{64})$/i.exec(authorization ?? "")?.[1] ?? "";
}

function seatFor(room, token) {
  if (!token) throw httpError(401, "This room session is not valid.");
  const member = room.members.find((seat) => seat.token === token);
  if (!member) throw httpError(401, "This room session is not valid.");
  return member;
}

export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    throw httpError(403, "Cross-origin requests are not allowed.");
  }
}

function mustRoom(code) {
  const room = rooms.get(String(code ?? "").toUpperCase());
  if (!room) throw httpError(404, "Room not found.");
  return room;
}

export function createRoom(body) {
  const host = { id: randomUUID(), token: randomBytes(32).toString("hex"), name: readName(body.name) };
  const room = { code: makeRoomCode(), hostId: host.id, members: [host], game: null, timeLimit: readTimeLimit(body.timeLimit), deadline: null };
  rooms.set(room.code, room);
  return { roomCode: room.code, playerId: host.id, playerToken: host.token, state: publicRoom(room, host.id) };
}

export function joinRoom(code, body) {
  const room = mustRoom(code);
  if (room.game) throw httpError(409, "This game has already started.");
  if (room.members.length >= MAX_SEATS) throw httpError(409, "This room is full (8 players maximum).");
  const member = { id: randomUUID(), token: randomBytes(32).toString("hex"), name: readName(body.name) };
  room.members.push(member);
  return { roomCode: room.code, playerId: member.id, playerToken: member.token, state: publicRoom(room, member.id) };
}

export function getRoomState(code, authorization) {
  const room = mustRoom(code);
  const member = seatFor(room, tokenFrom(authorization));
  return publicRoom(room, member.id);
}

export function startGame(code, authorization) {
  const room = mustRoom(code);
  const member = seatFor(room, tokenFrom(authorization));
  if (member.id !== room.hostId) throw httpError(403, "Only the host can start the game.");
  if (room.game) throw httpError(409, "This game has already started.");
  if (room.members.length < 2) throw httpError(409, "A second player must join before starting.");
  room.game = createGame(room.members.map(({ id, name }) => ({ id, name })), Math.random);
  room.deadline = Date.now() + room.timeLimit * 60_000;
  return publicRoom(room, member.id);
}

export function doMove(code, authorization, move) {
  const room = mustRoom(code);
  const member = seatFor(room, tokenFrom(authorization));
  if (!room.game) throw httpError(409, "The host has not started this game yet.");
  expireByDeadline(room);
  const nextGame = structuredClone(room.game);
  applyMove(nextGame, member.id, move);
  room.game = nextGame;
  return publicRoom(room, member.id);
}
