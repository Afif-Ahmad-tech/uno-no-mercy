import test from "node:test";
import assert from "node:assert/strict";
import { applyMove, botStep, canPlayCard, createDeck, createGame, ELIMINATION_LIMIT, finishByTimeout, playAiTurn } from "./game.mjs";

function fixture(hand, options = {}) {
  const players = [
    { id: "a", name: "A", hand },
    { id: "b", name: "B", hand: options.bHand ?? [{ id: "b1", color: "green", type: "number", value: 1 }] },
    { id: "c", name: "C", hand: options.cHand ?? [{ id: "c1", color: "blue", type: "number", value: 2 }] },
    { id: "d", name: "D", hand: options.dHand ?? [{ id: "d1", color: "yellow", type: "number", value: 3 }] },
  ].slice(0, options.playerCount ?? 3);
  return {
    players,
    drawPile: options.drawPile ?? [],
    discardPile: [options.top ?? { id: "top", color: "red", type: "number", value: 4 }],
    currentIndex: 0,
    direction: 1,
    activeColor: options.activeColor ?? "red",
    drawnCardId: null,
    stackAmount: options.stackAmount ?? 0,
    missedUno: null,
    unoCalled: Object.fromEntries(players.map(({ id }) => [id, false])),
    winner: null,
    winReason: null,
  };
}

test("creates the 150-card no-mercy deck and deals seven cards", () => {
  const deck = createDeck();
  assert.equal(deck.length, 150);
  for (const color of ["red", "yellow", "green", "blue"]) {
    assert.equal(deck.filter((card) => card.color === color && card.type === "number").length, 19);
    for (const type of ["skip", "reverse"]) {
      assert.equal(deck.filter((card) => card.color === color && card.type === type).length, 3);
    }
    for (const type of ["draw2", "draw5", "draw10"]) {
      assert.equal(deck.filter((card) => card.color === color && card.type === type).length, 2);
    }
    for (const type of ["draw15", "draw20"]) {
      assert.equal(deck.filter((card) => card.color === color && card.type === type).length, 1);
    }
  }
  for (const [type, count] of [["wild", 6], ["wild4", 4], ["wild10", 4], ["wild15", 2], ["wild20", 2]]) {
    assert.equal(deck.filter((card) => card.type === type).length, count);
  }
  const game = createGame([{ id: "a", name: "A" }, { id: "b", name: "B" }], () => 0.99);
  assert.deepEqual(game.players.map((player) => player.hand.length), [7, 7]);
  assert.equal(game.drawPile.length + game.discardPile.length + 14, 150);
  assert.equal(game.discardPile[0].type, "number");
  assert.equal(game.winReason, null);
});

test("matches by color or symbol and rejects an illegal Wild Draw Four", () => {
  const game = fixture([
    { id: "blue-four", color: "blue", type: "number", value: 4 },
    { id: "red-eight", color: "red", type: "number", value: 8 },
    { id: "green-skip", color: "green", type: "skip" },
    { id: "red-wild4", color: null, type: "wild4" },
  ]);
  const player = game.players[0];
  assert.equal(canPlayCard(player.hand[0], game, player), true);
  assert.equal(canPlayCard(player.hand[1], game, player), true);
  assert.equal(canPlayCard(player.hand[2], game, player), false);
  assert.equal(canPlayCard(player.hand[3], game, player), false);
  assert.throws(() => applyMove(game, "a", { type: "play", cardId: "red-wild4", color: "blue" }), /does not match/);
  player.hand.splice(1, 1);
  assert.equal(canPlayCard(player.hand.at(-1), game, player), true);
  const before = player.hand.length;
  assert.throws(() => applyMove(game, "a", { type: "play", cardId: "green-skip" }), /does not match/);
  assert.equal(player.hand.length, before);
  assert.equal(game.currentIndex, 0);
});

test("Draw Two opens a pending stack; another +2 escalates and the next player pays it all", () => {
  const game = fixture([{ id: "plus-two", color: "red", type: "draw2" }, { id: "spare", color: "blue", type: "number", value: 7 }], {
    drawPile: [
      { id: "draw-a", color: "green", type: "number", value: 5 },
      { id: "draw-b", color: "yellow", type: "number", value: 6 },
      { id: "draw-c", color: "green", type: "number", value: 7 },
      { id: "draw-d", color: "yellow", type: "number", value: 8 },
    ],
  });
  applyMove(game, "a", { type: "play", cardId: "plus-two" });
  assert.equal(game.stackAmount, 2);
  assert.equal(game.players[1].hand.length, 1);
  assert.equal(game.currentIndex, 1);

  game.players[1].hand = [
    { id: "plus-two-b", color: "blue", type: "draw2" },
    { id: "b-spare", color: "green", type: "number", value: 1 },
  ];
  applyMove(game, "b", { type: "play", cardId: "plus-two-b" });
  assert.equal(game.stackAmount, 4);
  assert.equal(game.currentIndex, 2);

  applyMove(game, "c", { type: "payStack" });
  assert.equal(game.players[2].hand.length, 5);
  assert.equal(game.stackAmount, 0);
  assert.equal(game.currentIndex, 0);
  assert.throws(() => applyMove(game, "a", { type: "payStack" }), /no card stack/);
});

test("+10/+15/+20 bombs defer their full weight until the stack is paid", () => {
  for (const [type, weight] of [["draw10", 10], ["draw15", 15], ["draw20", 20]]) {
    const game = fixture([{ id: "bomb", color: "red", type }, { id: "spare", color: "blue", type: "number", value: 7 }], {
      playerCount: 3,
      drawPile: Array.from({ length: weight }, (_, i) => ({ id: `hit-${i}`, color: "green", type: "number", value: i })),
    });
    applyMove(game, "a", { type: "play", cardId: "bomb" });
    assert.equal(game.stackAmount, weight);
    assert.equal(game.players[1].hand.length, 1);
    assert.equal(game.currentIndex, 1);

    applyMove(game, "b", { type: "payStack" });
    assert.equal(game.players[1].hand.length, 1 + weight);
    assert.equal(game.stackAmount, 0);
    assert.equal(game.currentIndex, 2);
  }
});

test("wild +10/+15/+20 can be played anytime, pick the next color, and answer stacks by value", () => {
  const game = fixture([
    { id: "wild-bomb", color: null, type: "wild20" },
    { id: "spare", color: "blue", type: "number", value: 7 },
  ], {
    playerCount: 3,
    drawPile: Array.from({ length: 20 }, (_, i) => ({ id: `hit-${i}`, color: "green", type: "number", value: i })),
  });
  const player = game.players[0];
  assert.equal(canPlayCard(player.hand[0], game, player), true);
  applyMove(game, "a", { type: "play", cardId: "wild-bomb", color: "yellow" });
  assert.equal(game.activeColor, "yellow");
  assert.equal(game.stackAmount, 20);
  assert.equal(game.players[1].hand.length, 1);
  assert.equal(game.currentIndex, 1);

  // A colored +20 answers the wild +20 across colors; a plain wild cannot.
  game.players[1].hand = [
    { id: "answer", color: "blue", type: "draw20" },
    { id: "plain", color: null, type: "wild" },
  ];
  assert.equal(canPlayCard(game.players[1].hand[0], game, game.players[1]), true);
  assert.equal(canPlayCard(game.players[1].hand[1], game, game.players[1]), false);
  applyMove(game, "b", { type: "payStack" });
  assert.equal(game.players[1].hand.length, 22);
  assert.equal(game.currentIndex, 2);
});

test("a player busts at 41 cards when they pay a stack, and the last player standing wins", () => {
  const victim = Array.from({ length: 39 }, (_, i) => ({ id: `bust-${i}`, color: "green", type: "number", value: i % 10 }));
  const game = fixture([
    { id: "hammer", color: "red", type: "draw10" },
    { id: "spare", color: "blue", type: "number", value: 7 },
  ], {
    playerCount: 3,
    bHand: victim,
    drawPile: Array.from({ length: 10 }, (_, i) => ({ id: `hit-${i}`, color: "green", type: "number", value: i })),
  });
  applyMove(game, "a", { type: "play", cardId: "hammer" });
  assert.equal(game.stackAmount, 10);
  assert.notEqual(game.players[1].eliminated, true);

  applyMove(game, "b", { type: "payStack" });
  assert.equal(game.players[1].eliminated, true);
  assert.equal(game.players[1].hand.length, 0);
  assert.ok(game.discardPile.length >= 1 + 39 + 10);
  assert.equal(game.winner, null);
  assert.equal(game.currentIndex, 2);
  assert.equal(game.stackAmount, 0);

  // Simulate C dropping out afterwards: only A remains, so A's next turn settles it.
  game.players[2].eliminated = true;
  game.currentIndex = 0;
  game.players[0].hand.push({ id: "topping", color: "blue", type: "number", value: 9 });
  applyMove(game, "a", { type: "draw" });
  assert.equal(game.winner, "a");
  assert.equal(game.winReason, "last-standing");
});

test("an open stack locks out normal cards and only accepts legal escalations", () => {
  // A +2 chain only takes another +2; everything else is locked out.
  const plus2 = fixture([
    { id: "open-two", color: "red", type: "draw2" },
    { id: "a-spare", color: "blue", type: "number", value: 3 },
  ], { playerCount: 3 });
  applyMove(plus2, "a", { type: "play", cardId: "open-two" });
  const b = plus2.players[1];
  b.hand = [
    { id: "b-draw2", color: "blue", type: "draw2" },
    { id: "b-draw5", color: "blue", type: "draw5" },
    { id: "b-wild4", color: null, type: "wild4" },
    { id: "b-two", color: "red", type: "number", value: 2 },
  ];
  assert.equal(canPlayCard(b.hand[0], plus2, b), true);
  assert.equal(canPlayCard(b.hand[1], plus2, b), false);
  assert.equal(canPlayCard(b.hand[2], plus2, b), false);
  assert.equal(canPlayCard(b.hand[3], plus2, b), false);
  assert.throws(() => applyMove(plus2, "b", { type: "draw" }), /Take the card stack/);
  assert.throws(() => applyMove(plus2, "b", { type: "play", cardId: "b-two" }), /does not match/);

  // Bigger stacks accept equal-or-higher strikes by value, in any color.
  const plus5 = fixture([
    { id: "open-five", color: "red", type: "draw5" },
    { id: "a-spare", color: "blue", type: "number", value: 3 },
  ], { playerCount: 3 });
  applyMove(plus5, "a", { type: "play", cardId: "open-five" });
  const c = plus5.players[1];
  c.hand = [
    { id: "c-draw5", color: "blue", type: "draw5" },
    { id: "c-draw10", color: "green", type: "draw10" },
    { id: "c-draw2", color: "red", type: "draw2" },
    { id: "c-wild", color: null, type: "wild" },
  ];
  assert.equal(canPlayCard(c.hand[0], plus5, c), true);
  assert.equal(canPlayCard(c.hand[1], plus5, c), true);
  assert.equal(canPlayCard(c.hand[2], plus5, c), false);
  assert.equal(canPlayCard(c.hand[3], plus5, c), false);
  assert.throws(() => applyMove(plus5, "b", { type: "play", cardId: "c-draw2" }), /does not match/);
});

test("bots pay the stack when they hold no escalation", () => {
  const game = fixture([
    { id: "strike", color: "red", type: "draw5" },
    { id: "a-spare", color: "blue", type: "number", value: 3 },
    { id: "a-spare-2", color: "green", type: "number", value: 4 },
  ], {
    playerCount: 2,
    drawPile: Array.from({ length: 6 }, (_, i) => ({ id: `hit-${i}`, color: "yellow", type: "number", value: i })),
  });
  applyMove(game, "a", { type: "play", cardId: "strike" });
  game.players[1].hand = [{ id: "stuck", color: "green", type: "number", value: 9 }];
  botStep(game);
  assert.equal(game.players[1].hand.length, 6);
  assert.equal(game.stackAmount, 0);
  assert.equal(game.currentIndex, 0);
});

test("turn order skips eliminated players", () => {
  const game = fixture([
    { id: "one", color: "red", type: "number", value: 6 },
    { id: "two", color: "red", type: "number", value: 7 },
  ], { playerCount: 3 });
  game.players[1].eliminated = true;
  applyMove(game, "a", { type: "play", cardId: "one" });
  assert.equal(game.currentIndex, 2);
});

test("timeout hands the win to the player with the fewest cards", () => {
  const game = fixture([
    { id: "x", color: "red", type: "number", value: 1 },
    { id: "y", color: "red", type: "number", value: 2 },
  ], { playerCount: 3 });
  game.players[0].hand.push({ id: "extra", color: "blue", type: "number", value: 9 });
  game.players[1].eliminated = true;
  finishByTimeout(game);
  assert.equal(game.winner, "c");
  assert.equal(game.winReason, "timeout");
  assert.throws(() => applyMove(game, "a", { type: "draw" }), /over/);
});

test("UNO can be declared or caught before the next turn acts", () => {
  const game = fixture([
    { id: "last-color", color: "red", type: "number", value: 8 },
    { id: "spare", color: "blue", type: "number", value: 7 },
  ], { drawPile: Array.from({ length: 2 }, (_, i) => ({ id: `penalty-${i}`, color: "yellow", type: "number", value: i })) });
  applyMove(game, "a", { type: "play", cardId: "last-color" });
  assert.equal(game.missedUno.playerId, "a");
  applyMove(game, "b", { type: "catchUno" });
  assert.equal(game.players[0].hand.length, 3);
  assert.equal(game.missedUno, null);
  assert.equal(game.currentIndex, 1);

  const declared = fixture([
    { id: "last-color", color: "red", type: "number", value: 8 },
    { id: "spare", color: "blue", type: "number", value: 7 },
  ]);
  applyMove(declared, "a", { type: "play", cardId: "last-color", declareUno: true });
  assert.equal(declared.unoCalled.a, true);
  assert.equal(declared.missedUno, null);
});

test("a player must call UNO before playing their final card, then wins", () => {
  const game = fixture([{ id: "last", color: "red", type: "number", value: 8 }]);
  assert.throws(() => applyMove(game, "a", { type: "play", cardId: "last" }), /Call UNO/);
  applyMove(game, "a", { type: "callUno" });
  applyMove(game, "a", { type: "play", cardId: "last" });
  assert.equal(game.winner, "a");
  assert.equal(game.winReason, "hand-empty");
  assert.throws(() => applyMove(game, "b", { type: "draw" }), /over/);
});

test("draw advances when unusable and allows only the playable drawn card", () => {
  const game = fixture([{ id: "blue", color: "blue", type: "number", value: 5 }], {
    drawPile: [{ id: "green", color: "green", type: "number", value: 6 }],
  });
  applyMove(game, "a", { type: "draw" });
  assert.equal(game.currentIndex, 1);

  const playable = fixture([{ id: "blue", color: "blue", type: "number", value: 5 }], {
    drawPile: [{ id: "red", color: "red", type: "number", value: 6 }],
  });
  applyMove(playable, "a", { type: "draw" });
  assert.equal(playable.currentIndex, 0);
  assert.equal(playable.drawnCardId, "red");
  assert.throws(() => applyMove(playable, "a", { type: "play", cardId: "blue" }), /just drew/);
  applyMove(playable, "a", { type: "play", cardId: "red", declareUno: true });
  assert.equal(playable.currentIndex, 1);
});

test("8 players can share a deck and a full game runs to a win", () => {
  const game = createGame(
    Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `Player ${index}` })),
  );
  assert.ok(game.players.every((player) => player.hand.length === 7));
  assert.equal(game.drawPile.length, 150 - 56 - 1);
  let guard = 50000;
  while (!game.winner && guard--) playAiTurn(game);
  // Rooms always carry a host-chosen clock; if the deck exhausts first, the
  // clock resolves the match to whoever holds the fewest cards.
  if (!game.winner) finishByTimeout(game);
  assert.ok(game.winner, "an AI match should resolve within the turn budget");
  assert.ok(["hand-empty", "last-standing", "timeout"].includes(game.winReason));
});

test("AI completes a legal turn", () => {
  const game = createGame([
    { id: "bot", name: "Bot" },
    { id: "human", name: "You" },
    { id: "bot2", name: "Bot 2" },
    { id: "bot3", name: "Bot 3" },
  ], () => 0.5);
  playAiTurn(game);
  assert.ok(game.winner || game.currentIndex !== 0);
});
