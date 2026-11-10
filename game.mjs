export const COLORS = ["red", "yellow", "green", "blue"];
export const ELIMINATION_LIMIT = 40;
export const WILD_TYPES = ["wild", "wild4", "wild10", "wild15", "wild20"];

const DRAW_COUNT = { draw2: 2, draw5: 5, draw10: 10, draw15: 15, draw20: 20, wild4: 4, wild10: 10, wild15: 15, wild20: 20 };

export function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ id: `${color}-0`, color, type: "number", value: 0 });
    for (let value = 1; value <= 9; value++) {
      for (let copy = 1; copy <= 2; copy++) {
        deck.push({ id: `${color}-${value}-${copy}`, color, type: "number", value });
      }
    }
    for (const type of ["skip", "reverse"]) {
      for (let copy = 1; copy <= 3; copy++) deck.push({ id: `${color}-${type}-${copy}`, color, type });
    }
    for (const type of ["draw2", "draw5", "draw10"]) {
      for (let copy = 1; copy <= 2; copy++) deck.push({ id: `${color}-${type}-${copy}`, color, type });
    }
    for (const type of ["draw15", "draw20"]) deck.push({ id: `${color}-${type}`, color, type });
  }
  for (let copy = 1; copy <= 6; copy++) deck.push({ id: `wild-${copy}`, color: null, type: "wild" });
  for (let copy = 1; copy <= 4; copy++) deck.push({ id: `wild4-${copy}`, color: null, type: "wild4" });
  for (let copy = 1; copy <= 4; copy++) deck.push({ id: `wild10-${copy}`, color: null, type: "wild10" });
  deck.push({ id: "wild15-1", color: null, type: "wild15" });
  deck.push({ id: "wild15-2", color: null, type: "wild15" });
  deck.push({ id: "wild20-1", color: null, type: "wild20" });
  deck.push({ id: "wild20-2", color: null, type: "wild20" });
  return deck;
}

function shuffle(cards, random = Math.random) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createGame(players, random = Math.random) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("A game needs 2 to 8 players.");
  }
  const ids = players.map((player) => player.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new Error("Player IDs must be unique.");
  const seats = players.map(({ id, name }) => ({ id, name, hand: [], eliminated: false }));
  const drawPile = shuffle(createDeck(), random);
  for (let count = 0; count < 7; count++) {
    for (const player of seats) player.hand.push(drawPile.pop());
  }
  let firstCard = drawPile.pop();
  while (firstCard.type !== "number") {
    drawPile.unshift(firstCard);
    firstCard = drawPile.pop();
  }
  return {
    players: seats,
    drawPile,
    discardPile: [firstCard],
    currentIndex: 0,
    direction: 1,
    activeColor: firstCard.color,
    drawnCardId: null,
    missedUno: null,
    unoCalled: Object.fromEntries(ids.map((id) => [id, false])),
    winner: null,
    winReason: null,
  };
}

export function currentPlayer(state) {
  return state.players[state.currentIndex];
}

export function isWildCard(card) {
  return WILD_TYPES.includes(card.type);
}

export function isDrawCard(card) {
  return card.type in DRAW_COUNT;
}

export function canPlayCard(card, state, player) {
  if (card.type === "wild" || card.type === "wild10" || card.type === "wild15" || card.type === "wild20") return true;
  if (card.type === "wild4") return !player.hand.some((held) => held.id !== card.id && held.color === state.activeColor);
  const top = state.discardPile.at(-1);
  return card.color === state.activeColor || (
    top.color && card.type === top.type && (card.type !== "number" || card.value === top.value)
  );
}

export function playableCards(state, player = currentPlayer(state)) {
  const cards = state.drawnCardId
    ? player.hand.filter((card) => card.id === state.drawnCardId)
    : player.hand;
  return cards.filter((card) => canPlayCard(card, state, player));
}

function playerById(state, id) {
  const player = state.players.find((seat) => seat.id === id);
  if (!player) throw new Error("Unknown player.");
  return player;
}

function activePlayers(state) {
  return state.players.filter((player) => player.eliminated !== true);
}

function nextActiveIndex(state, from) {
  const size = state.players.length;
  let index = from;
  for (let step = 0; step < size; step++) {
    index = (index + state.direction + size) % size;
    if (state.players[index].eliminated !== true) return index;
  }
  return from;
}

function advance(state, spaces = 1) {
  let index = state.currentIndex;
  for (let step = 0; step < spaces; step++) index = nextActiveIndex(state, index);
  state.currentIndex = index;
  state.drawnCardId = null;
}

function drawOne(state) {
  if (!state.drawPile.length && state.discardPile.length > 1) {
    const top = state.discardPile.pop();
    state.drawPile = shuffle(state.discardPile);
    state.discardPile = [top];
  }
  return state.drawPile.pop() ?? null;
}

function drawMany(state, player, count) {
  for (let i = 0; i < count; i++) {
    const card = drawOne(state);
    if (!card) break;
    player.hand.push(card);
  }
}

function checkEliminations(state) {
  for (const player of state.players) {
    if (player.eliminated !== true && player.hand.length > ELIMINATION_LIMIT) player.eliminated = true;
  }
  const alive = activePlayers(state);
  if (!state.winner && alive.length === 1) {
    state.winner = alive[0].id;
    state.winReason = "last-standing";
  }
}

export function finishByTimeout(state) {
  if (state.winner) return state;
  const alive = activePlayers(state);
  if (!alive.length) return state;
  const fewest = [...alive].sort((a, b) => a.hand.length - b.hand.length)[0];
  state.winner = fewest.id;
  state.winReason = "timeout";
  return state;
}

function closeMissedUnoWindow(state, actingPlayerId) {
  if (state.missedUno?.expiresOn === actingPlayerId) {
    state.unoCalled[state.missedUno.playerId] = true;
    state.missedUno = null;
  }
}

export function applyMove(state, playerId, move) {
  if (state.winner) throw new Error("This game is over.");
  const player = playerById(state, playerId);
  if (player.eliminated === true) throw new Error("You are out of this game.");

  if (move.type === "callUno") {
    if (player.hand.length !== 1 || (state.missedUno?.playerId !== playerId && currentPlayer(state).id !== playerId)) {
      throw new Error("You can call UNO when you have one card.");
    }
    state.unoCalled[playerId] = true;
    if (state.missedUno?.playerId === playerId) state.missedUno = null;
    return state;
  }

  if (move.type === "catchUno") {
    if (!state.missedUno || state.missedUno.playerId === playerId) throw new Error("There is no missed UNO to call out.");
    drawMany(state, playerById(state, state.missedUno.playerId), 2);
    state.unoCalled[state.missedUno.playerId] = true;
    state.missedUno = null;
    checkEliminations(state);
    return state;
  }

  if (currentPlayer(state).id !== playerId) throw new Error("It is not your turn.");

  if (move.type === "play") {
    const cardIndex = player.hand.findIndex((card) => card.id === move.cardId);
    if (cardIndex < 0) throw new Error("That card is not in your hand.");
    const card = player.hand[cardIndex];
    if (state.drawnCardId && state.drawnCardId !== card.id) throw new Error("Play the card you just drew, or pass.");
    if (!canPlayCard(card, state, player)) throw new Error("That card does not match the color or symbol.");
    if (isWildCard(card) && !COLORS.includes(move.color)) {
      throw new Error("Choose a color for a wild card.");
    }
    if (!isWildCard(card) && move.color !== undefined) {
      throw new Error("Only a wild card can change the color.");
    }
    if (typeof move.declareUno !== "undefined" && typeof move.declareUno !== "boolean") {
      throw new Error("UNO declaration must be true or false.");
    }
    if (move.declareUno && player.hand.length !== 2) throw new Error("Declare UNO only when this play leaves one card.");
    if (player.hand.length === 1 && !state.unoCalled[playerId]) throw new Error("Call UNO before playing your last card.");

    closeMissedUnoWindow(state, playerId);
    player.hand.splice(cardIndex, 1);
    state.discardPile.push(card);
    state.activeColor = card.color ?? move.color;
    state.drawnCardId = null;
    if (player.hand.length === 1) {
      state.unoCalled[playerId] = move.declareUno === true;
      state.missedUno = move.declareUno ? null : { playerId, expiresOn: null };
    }
    if (!player.hand.length) {
      state.winner = playerId;
      state.winReason = "hand-empty";
      state.missedUno = null;
      return state;
    }

    if (isDrawCard(card)) {
      const target = state.players[nextActiveIndex(state, state.currentIndex)];
      drawMany(state, target, DRAW_COUNT[card.type]);
      if (card.type === "reverse") state.direction *= -1;
      checkEliminations(state);
      if (state.winner) return state;
      advance(state, target.eliminated === true ? 1 : 2);
      if (state.missedUno) state.missedUno.expiresOn = currentPlayer(state).id;
      return state;
    }

    if (card.type === "reverse") state.direction *= -1;
    const spaces = 1 + Number(card.type === "skip") + (card.type === "reverse" && state.players.length === 2 ? 1 : 0);
    advance(state, spaces);
    if (state.missedUno) state.missedUno.expiresOn = currentPlayer(state).id;
    return state;
  }

  if (move.type === "draw") {
    closeMissedUnoWindow(state, playerId);
    const card = drawOne(state);
    if (card) player.hand.push(card);
    checkEliminations(state);
    if (state.winner) return state;
    if (player.eliminated === true) {
      advance(state);
      return state;
    }
    if (card && canPlayCard(card, state, player)) state.drawnCardId = card.id;
    else advance(state);
    return state;
  }

  if (move.type === "pass") {
    if (!state.drawnCardId) throw new Error("Draw a card before passing.");
    closeMissedUnoWindow(state, playerId);
    advance(state);
    return state;
  }

  throw new Error("Unknown move.");
}

function playHand(state, player) {
  const cards = playableCards(state, player);
  if (!cards.length) return false;
  const severity = (card) => (DRAW_COUNT[card.type] ?? 0) * 2 + (card.type === "skip" ? 6 : 0) + (card.type === "reverse" ? 4 : 0) + Number(card.type !== "number");
  const card = [...cards].sort((a, b) => severity(b) - severity(a))[0];
  const remaining = player.hand.filter((held) => held.id !== card.id);
  const colorCounts = COLORS.map((color) => ({ color, count: remaining.filter((held) => held.color === color).length }));
  colorCounts.sort((a, b) => b.count - a.count);
  applyMove(state, player.id, {
    type: "play",
    cardId: card.id,
    ...(isWildCard(card) ? { color: colorCounts[0].color } : {}),
    ...(player.hand.length === 2 ? { declareUno: true } : {}),
  });
  return true;
}

export function botStep(state) {
  const player = currentPlayer(state);
  const seatId = player.id;
  if (state.missedUno && state.missedUno.playerId !== seatId) {
    applyMove(state, seatId, { type: "catchUno" });
    return state;
  }
  if (state.drawnCardId) {
    if (!playHand(state, player)) applyMove(state, seatId, { type: "pass" });
    return state;
  }
  if (playHand(state, player)) return state;
  applyMove(state, seatId, { type: "draw" });
  return state;
}

export function playAiTurn(state) {
  const seat = currentPlayer(state).id;
  for (let steps = 0; steps < 4 && !state.winner && currentPlayer(state).id === seat; steps++) botStep(state);
  return state;
}

export function publicState(state, viewerId) {
  return {
    status: state.winner ? "finished" : "playing",
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      cardCount: player.hand.length,
      hand: player.id === viewerId ? player.hand : null,
      unoCalled: state.unoCalled[player.id] === true,
      eliminated: player.eliminated === true,
    })),
    currentPlayerId: currentPlayer(state).id,
    direction: state.direction,
    activeColor: state.activeColor,
    topCard: state.discardPile.at(-1),
    drawCount: state.drawPile.length,
    drawnCardId: state.drawnCardId,
    missedUno: state.missedUno?.playerId ?? null,
    winnerId: state.winner,
    winReason: state.winReason,
  };
}
