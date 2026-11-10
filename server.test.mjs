import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.mjs";

test("online rooms validate turns and keep every other hand private", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (method, body, token, headers = {}) => ({
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const created = await fetch(`${origin}/api/rooms`, json("POST", { name: "Host" }));
  assert.equal(created.status, 201);
  const host = await created.json();
  const joined = await fetch(`${origin}/api/rooms/${host.roomCode}/join`, json("POST", { name: "Guest" }));
  assert.equal(joined.status, 201);
  const guest = await joined.json();
  assert.equal(guest.state.status, "waiting");

  const premature = await fetch(`${origin}/api/rooms/${host.roomCode}/move`, json("POST", { type: "draw" }, host.playerToken));
  assert.equal(premature.status, 409);
  const started = await fetch(`${origin}/api/rooms/${host.roomCode}/start`, json("POST", {}, host.playerToken));
  assert.equal(started.status, 200);
  const hostState = await started.json();
  assert.equal(hostState.players.find((player) => player.id === hostState.currentPlayerId).hand.length, 7);
  assert.equal(hostState.players.find((player) => player.id !== hostState.currentPlayerId).hand, null);
  assert.equal("drawPile" in hostState, false);

  const guestResponse = await fetch(`${origin}/api/rooms/${host.roomCode}`, json("GET", null, guest.playerToken));
  const guestState = await guestResponse.json();
  assert.equal(guestState.players.find((player) => player.id === guestState.currentPlayerId).hand, null);
  assert.equal(guestState.players.find((player) => player.id !== guestState.currentPlayerId).hand.length, 7);

  const invalid = await fetch(`${origin}/api/rooms/${host.roomCode}/move`, json("POST", { type: "play", cardId: "not-in-hand" }, host.playerToken));
  assert.equal(invalid.status, 400);
  const outOfTurn = await fetch(`${origin}/api/rooms/${host.roomCode}/move`, json("POST", { type: "draw" }, guest.playerToken));
  assert.equal(outOfTurn.status, 400);
  const rejectedOrigin = await fetch(`${origin}/api/rooms/${host.roomCode}/move`, json("POST", { type: "draw" }, host.playerToken, { Origin: "https://other.example" }));
  assert.equal(rejectedOrigin.status, 403);

  const hand = hostState.players.find((player) => player.id === hostState.currentPlayerId).hand;
  const card = hand.find((held) => held.type !== "wild4" && (held.type === "wild" || held.color === hostState.activeColor || (
    held.type === hostState.topCard.type && (held.type !== "number" || held.value === hostState.topCard.value)
  ))) ?? hand.find((held) => held.type === "wild4" && !hand.some((item) => item.color === hostState.activeColor));
  const move = card
    ? { type: "play", cardId: card.id, ...(card.type === "wild" || card.type === "wild4" ? { color: "green" } : {}) }
    : { type: "draw" };
  const played = await fetch(`${origin}/api/rooms/${host.roomCode}/move`, json("POST", move, host.playerToken));
  assert.equal(played.status, 200);
  const after = await played.json();
  if (card) assert.equal(after.topCard.id, card.id);
  else assert.equal(after.players.find((player) => player.id === hostState.currentPlayerId).hand.length, 8);
  if (!card) assert.equal(after.topCard.id, hostState.topCard.id);
  assert.equal(after.players.find((player) => player.id !== hostState.currentPlayerId).hand, null);

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Color Club/);
});

test("rooms seat at most 8 players, require 2, and validate the time limit", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (method, body, token) => ({
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const rejectedLimit = await fetch(`${origin}/api/rooms`, json("POST", { name: "Host", timeLimit: 25 }));
  assert.equal(rejectedLimit.status, 400);

  const created = await fetch(`${origin}/api/rooms`, json("POST", { name: "Host", timeLimit: 15 }));
  const host = await created.json();
  assert.equal(host.state.timeLimitMinutes, 15);

  const premStart = await fetch(`${origin}/api/rooms/${host.roomCode}/start`, json("POST", {}, host.playerToken));
  assert.equal(premStart.status, 409);

  const seatTokens = [];
  for (let seat = 0; seat < 7; seat++) {
    const joined = await fetch(`${origin}/api/rooms/${host.roomCode}/join`, json("POST", { name: `Guest ${seat}` }));
    assert.equal(joined.status, 201);
    const seatData = await joined.json();
    seatTokens.push(seatData.playerToken);
    assert.equal(seatData.playerId !== undefined, true);
  }
  const overflow = await fetch(`${origin}/api/rooms/${host.roomCode}/join`, json("POST", { name: "Too many" }));
  assert.equal(overflow.status, 409);

  const started = await fetch(`${origin}/api/rooms/${host.roomCode}/start`, json("POST", {}, host.playerToken));
  assert.equal(started.status, 200);
  const state = await started.json();
  assert.equal(state.players.length, 8);
  assert.equal(state.timeLimitMinutes, 15);
  assert.ok(state.timeLeftMs > 0 && state.timeLeftMs <= 15 * 60_000);
  assert.ok(state.players.every((player) => player.hand === null || player.hand.length === 7));
});
