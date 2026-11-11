import { COLORS, applyMove, botStep, canPlayCard, createGame, currentPlayer } from "./game.mjs";

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
let mode = "menu";
let notice = "";
let localGame = null;
let session = null;
let roomState = null;
let roomPoll = null;
let botTimer = null;
let inviteCode = "";
let pendingCard = null;
let selectedColor = null;
let lastView = null;
let lastBotId = null;
let suppressOwnThrow = false;

const BOT_FIRST_GAP = 1700;
const BOT_STEP_GAP = 800;
const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function ensureFxLayer() {
  let layer = document.getElementById("fx-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fx-layer";
    document.body.appendChild(layer);
  }
  return layer;
}

function rectOf(selector) {
  const element = document.querySelector(selector);
  return element ? element.getBoundingClientRect() : null;
}

function flyCard({ html, from, to, duration = 620, startRotate = 0, endRotate = 0, width = 72 }) {
  if (!from || !to || prefersReducedMotion()) return Promise.resolve();
  const layer = ensureFxLayer();
  const el = document.createElement("span");
  el.className = "fx-card";
  el.innerHTML = html;
  el.style.left = `${Math.round(from.left + from.width / 2 - width / 2)}px`;
  el.style.top = `${Math.round(from.top + from.height / 2 - width * 0.72)}px`;
  el.style.width = `${width}px`;
  el.style.height = `${Math.round(width * 1.44)}px`;
  el.style.setProperty("--fx-d", `${duration}ms`);
  el.style.setProperty("--r0", `${startRotate}deg`);
  el.style.setProperty("--r1", `${endRotate}deg`);
  el.style.transform = "translate3d(0, 0, 0)";
  layer.appendChild(el);
  const dx = Math.round(to.left + to.width / 2 - (from.left + from.width / 2));
  const dy = Math.round(to.top + to.height / 2 - (from.top + from.height / 2));
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 220);
      resolve();
    }, duration);
    setTimeout(() => el.remove(), duration + 260);
  });
}

function animatePickups(view, viewerId) {
  const prev = lastView;
  if (!prev || prev.status !== "playing" || prefersReducedMotion()) return;
  const deck = rectOf(".draw-pile");
  if (!deck) return;
  for (const player of view.players) {
    const prevPlayer = prev.players.find((entry) => entry.id === player.id);
    if (!prevPlayer || !prevPlayer.cardCount || player.cardCount <= prevPlayer.cardCount) continue;
    const gained = Math.min(player.cardCount - prevPlayer.cardCount, 4);
    const to = player.id === viewerId
      ? rectOf(".hand-cards")
      : rectOf(`.opponent[data-player-id="${player.id}"]`);
    if (!to) continue;
    for (let index = 0; index < gained; index++) {
      setTimeout(() => {
        void flyCard({
          html: `<span class="back-card"></span>`,
          from: deck,
          to,
          duration: 700,
          startRotate: -8,
          endRotate: 14,
          width: 46,
        });
      }, index * 150);
    }
  }
}

function animateThrowFromDiff(view, viewerId) {
  const prev = lastView;
  if (!prev || prev.status !== "playing" || !prev.topCard || !view.topCard) return false;
  if (prev.topCard.id === view.topCard.id) return false;
  if (suppressOwnThrow) return true;
  const actorId = prev.currentPlayerId;
  const from = actorId === viewerId
    ? rectOf(".hand-cards")
    : rectOf(`.opponent[data-player-id="${actorId}"]`);
  const to = rectOf(".discard-slot");
  if (from && to) {
    void flyCard({
      html: cardMarkup(view.topCard),
      from,
      to,
      duration: 620,
      startRotate: -12,
      endRotate: 6,
    });
  }
  return true;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const cardLabels = { skip: "SKIP", reverse: "↶", draw2: "+2", draw5: "+5", draw10: "+10", draw15: "+15", draw20: "+20", wild: "WILD", wild4: "+4", wild10: "+10", wild15: "+15", wild20: "+20" };
const cardName = (card) => card.type === "number" ? String(card.value) : cardLabels[card.type];
const isWildType = (type) => type.startsWith("wild");

const svgIcon = (paths) => `<span class="svg-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
const ICONS = {
  bots: svgIcon(`<path d="M8.5 11a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z"/><path d="M2.5 20c0-3 2.6-5 6-5s6 2 6 5"/><path d="M16 4.4a3.4 3.4 0 0 1 0 6.2"/><path d="M15.6 15.2c2.9.4 4.9 2.2 4.9 4.8"/>`),
  plus: svgIcon(`<path d="M12 5v14M5 12h14"/>`),
  clock: svgIcon(`<circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.7l3.1 1.9"/>`),
  burst: svgIcon(`<path d="M12 3v4M12 17v4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M3 12h4M17 12h4M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9"/>`),
  deck: svgIcon(`<rect x="7" y="4" width="11" height="15.5" rx="2.5"/><path d="M16.5 8h2A1.5 1.5 0 0 1 20 9.5v9A2.5 2.5 0 0 1 17.5 21H10.8"/>`),
  bolt: svgIcon(`<path d="M13 2 4.7 13.2h5.1L10.6 22l8.4-11.2h-5.1L13 2Z"/>`),
  copy: svgIcon(`<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>`),
  trophy: svgIcon(`<path d="M8 4h8v6a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5v2a3 3 0 0 0 3 3"/><path d="M16 5h3v2a3 3 0 0 1-3 3"/><path d="M12 14v4M8 21h8M10 18.5h4"/>`),
  replay: svgIcon(`<path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/>`),
};

const CARD_GLYPHS = {
  skip: `<svg class="card-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="m6.4 6.4 11.2 11.2"/></svg>`,
  reverse: `<svg class="card-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.4h13.6"/><path d="m14.3 5 3.6 3.4-3.6 3.4"/><path d="M20 15.6H6.4"/><path d="m9.7 12.2-3.6 3.4 3.6 3.4"/></svg>`,
  wild: `<svg class="card-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><path d="M12 2.4 14.3 9.7 21.6 12l-7.3 2.3L12 21.6 9.7 14.3 2.4 12l7.3-2.3Z"/></svg>`,
};

function cardMarkup(card) {
  const colorClass = card.color ?? "wild";
  const symbol = cardName(card);
  const glyph = CARD_GLYPHS[card.type];
  const center = card.type === "wild" ? CARD_GLYPHS.wild : (glyph ?? escapeHtml(symbol));
  const corner = glyph ?? escapeHtml(symbol);
  const word = !glyph && (symbol.length > 2 || card.type === "wild" || card.type === "wild10" || card.type === "wild15" || card.type === "wild20");
  return `<span class="card ${colorClass}" data-card-type="${escapeHtml(card.type)}" aria-hidden="true"><span class="card-corner">${corner}</span><span class="card-center${word ? " word" : ""}">${center}</span><span class="card-corner bottom">${corner}</span></span>`;
}

function currentView() {
  if (mode === "online") return roomState;
  if (mode !== "local" || !localGame) return null;
  return {
    status: localGame.winner ? "finished" : "playing",
    players: localGame.players.map((player) => ({
      ...player,
      cardCount: player.hand.length,
      unoCalled: localGame.unoCalled[player.id] === true,
      eliminated: player.eliminated === true,
    })),
    currentPlayerId: currentPlayer(localGame).id,
    activeColor: localGame.activeColor,
    topCard: localGame.discardPile.at(-1),
    direction: localGame.direction,
    drawCount: localGame.drawPile.length,
    drawnCardId: localGame.drawnCardId,
    stackAmount: localGame.stackAmount ?? 0,
    missedUno: localGame.missedUno?.playerId ?? null,
    winnerId: localGame.winner,
    winReason: localGame.winReason,
    timeLeftMs: null,
  };
}

function showNotice(message = "") {
  notice = message;
  render();
}

function clockFor(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderMenu() {
  const hostView = mode === "host";
  const joinView = mode === "join";
  app.innerHTML = `
    <section class="menu">
      <div class="menu-intro">
        <div class="eyebrow">No mercy one-on-ones</div>
        <h1>Shuffle.<br><em>Nuke.</em><br>Repeat.</h1>
        <p class="menu-copy">The ruthless table: a 150-card deck with +10, +15 and +20 bombardments, a 40-card bust rule, and up to eight players. Outdraw your rivals or watch them burst.</p>
        <div class="menu-cards" aria-hidden="true">
          ${cardMarkup({ type: "number", value: 7, color: "red" })}
          ${cardMarkup({ type: "draw10", color: "yellow" })}
          ${cardMarkup({ type: "draw20", color: "green" })}
          ${cardMarkup({ type: "wild20", color: null })}
        </div>
      </div>
      <section class="mode-panel" aria-label="Choose a game mode">
        ${hostView || joinView ? renderSetupForm() : `
          <div class="eyebrow">Choose your table</div>
          <h2>How do you want to play?</h2>
          <div class="stat-chips">
            <span class="stat-chip">${ICONS.deck}<strong>150</strong>-card deck</span>
            <span class="stat-chip">${ICONS.bolt}+10 · +15 · +20</span>
            <span class="stat-chip">${ICONS.burst}bust at 40</span>
            <span class="stat-chip">${ICONS.bots}<strong>2–8</strong> players</span>
          </div>
          <div class="button-stack">
            <button class="button button-primary" data-action="solo">${ICONS.bots}<span>Play with bots</span></button>
            <button class="button button-secondary" data-action="host">${ICONS.plus}<span>Create an online room</span></button>
          </div>
          <div class="mode-split"><span>OR JOIN A FRIEND</span></div>
          <form data-form="join-inline">
            <label class="field-label" for="quick-room">Room code</label>
            <div class="field-row">
              <input id="quick-room" class="field room-code" name="room" maxlength="6" placeholder="ABC123" autocomplete="off" required>
              <button class="button button-quiet" type="submit">Join</button>
            </div>
          </form>
          <p class="panel-foot">150-card no-mercy deck · +10/+15/+20 strikes · bust at 40 cards · 2 to 8 players · host sets the clock.</p>
        `}
        <p class="notice" role="status">${escapeHtml(notice)}</p>
      </section>
    </section>`;
}

function renderSetupForm() {
  if (mode === "host") {
    const timeOptions = Array.from({ length: 18 }, (_, index) => index + 3).map((minutes) => `<option value="${minutes}" ${minutes === 10 ? "selected" : ""}>${minutes} minutes</option>`).join("");
    return `
      <div class="eyebrow">Invite your people</div><h2>Create a no-mercy table</h2>
      <form data-form="host">
        <div class="name-row">
          <label><span class="field-label">Your name</span><input class="field" name="name" maxlength="20" placeholder="Player" value="Player" required></label>
          <label><span class="field-label">Game time limit</span><select class="field" name="timeLimit">${timeOptions}</select></label>
        </div>
        <div class="button-stack"><button class="button button-primary" type="submit">Create room</button><button class="button button-quiet" type="button" data-action="menu">Back</button></div>
      </form><p class="panel-foot">Share the code with up to seven friends (8 players total). The clock runs from 3 to 20 minutes — if nobody finishes in time, the fewest cards win.</p>`;
  }
  return `
    <div class="eyebrow">Your friend saved you a seat</div><h2>Join an online table</h2>
    <form data-form="join">
      <div class="name-row">
        <label><span class="field-label">Your name</span><input class="field" name="name" maxlength="20" placeholder="Player" value="Player" required></label>
        <label><span class="field-label">Room code</span><input class="field room-code" name="room" maxlength="6" placeholder="ABC123" value="${escapeHtml(inviteCode)}" autocomplete="off" required></label>
      </div>
      <div class="button-stack"><button class="button button-primary" type="submit">Join room</button><button class="button button-quiet" type="button" data-action="menu">Back</button></div>
    </form><p class="panel-foot">Room codes are private. Only share yours with people you want at the table.</p>`;
}

function renderLobby(view) {
  const players = view.players ?? [];
  const isHost = session?.isHost;
  return `
    <section class="waiting-card">
      <div class="eyebrow">Private online table</div>
      <h1>${isHost ? "Your room is ready" : "You’re at the table"}</h1>
      <p>Share this link with your friends. The host starts the no-mercy game once two or more players have joined — up to eight at the table, ${escapeHtml(view.timeLimitMinutes)} minute${view.timeLimitMinutes === 1 ? "" : "s"} on the clock.</p>
      <div class="room-share"><code>${escapeHtml(view.roomCode)}</code><button class="button button-quiet button-small" data-action="copy-room">${ICONS.copy}<span>Copy invite link</span></button></div>
      <ul class="lobby-list">${players.map((player) => `<li><span>${escapeHtml(player.name)}${player.isHost ? " · host" : ""}</span><small>${player.isHost ? "HOST" : "READY"}</small></li>`).join("")}</ul>
      ${isHost ? `<button class="button button-primary" data-action="start-room" ${players.length < 2 ? "disabled" : ""}>Start game · ${players.length} joined</button>` : `<span class="pill"><i class="pill-dot"></i> Waiting for the host</span>`}
      <p class="notice" role="status">${escapeHtml(notice)}</p>
      <div><button class="button button-quiet button-small" data-action="exit">Leave room</button></div>
    </section>`;
}

function renderOpponent(player, view, viewerId, seatIndex, seatCount) {
  const bot = mode === "local";
  const initial = [...player.name][0]?.toUpperCase() ?? "?";
  const isSelf = player.id === viewerId;
  const backs = player.eliminated || isSelf ? "" : Array.from({ length: Math.min(player.cardCount, 6) }, () => `<i class="mini-back"></i>`).join("");
  const badge = player.eliminated ? `<span class="out-badge">BUST</span>` : player.unoCalled ? `<span class="uno-badge">UNO</span>` : "";
  const isTurn = player.id === view.currentPlayerId && view.status === "playing" && !player.eliminated;
  // Equal spacing around the round table: the viewer always sits at the
  // bottom, everyone else follows at even angles.
  const angle = Math.PI / 2 + (seatIndex * 2 * Math.PI) / seatCount;
  const x = (50 + 39.5 * Math.cos(angle)).toFixed(2);
  const y = (50 + 39.5 * Math.sin(angle)).toFixed(2);
  return `<div class="opponent${isSelf ? " is-self" : ""}${isTurn ? " is-turn" : ""}${player.eliminated ? " is-out" : ""}" style="--seat-x: ${x}%; --seat-y: ${y}%" data-player-id="${escapeHtml(player.id)}">
    <span class="avatar ${isSelf ? "you" : bot ? "bot" : "friend"}" aria-hidden="true">${escapeHtml(initial)}</span>
    <span class="seat-copy"><span class="player-name">${escapeHtml(isSelf ? "You" : player.name)}</span><span class="player-count">${player.eliminated ? "out at 40" : `${player.cardCount} cards`}</span></span>
    <span class="mini-hand" aria-hidden="true">${badge}${backs}</span>
  </div>`;
}

function canChooseCard(card, own, view) {
  if (view.currentPlayerId !== own.id || view.status !== "playing" || own.eliminated) return false;
  if (view.drawnCardId && view.drawnCardId !== card.id) return false;
  const rulesPlayer = { ...own, hand: own.hand };
  return canPlayCard(card, { activeColor: view.activeColor, discardPile: [view.topCard], stackAmount: view.stackAmount ?? 0 }, rulesPlayer);
}

function renderGame(view) {
  const viewerId = mode === "local" ? "you" : session.playerId;
  const own = view.players.find((player) => player.id === viewerId);
  if (!own) {
    mode = "menu";
    session = null;
    return renderMenu();
  }
  const opponents = view.players.filter((player) => player.id !== viewerId);
  const viewerIndex = Math.max(0, view.players.findIndex((player) => player.id === viewerId));
  const seatOrder = [...view.players.slice(viewerIndex), ...view.players.slice(0, viewerIndex)];
  const yourTurn = view.currentPlayerId === viewerId && view.status === "playing" && !own.eliminated;
  const winner = view.players.find((player) => player.id === view.winnerId);
  const called = own.unoCalled === true;
  const canCall = own.cardCount === 1 && !called && !own.eliminated && (yourTurn || view.missedUno === viewerId);
  const canCatch = view.missedUno && view.missedUno !== viewerId && view.status === "playing";
  const cards = own.hand ?? [];
  const prevOwn = lastView?.players?.find?.((entry) => entry.id === viewerId) ?? null;
  const prevOwnIds = new Set(prevOwn?.hand?.map((entry) => entry.id) ?? []);
  const justDrawnIds = cards.filter((card) => !prevOwnIds.has(card.id)).map((card) => card.id);
  const stackPending = (view.stackAmount ?? 0) > 0;
  const stackButton = stackPending && yourTurn
    ? `<button class="button button-danger button-small" data-action="pay-stack">Take stack (+${view.stackAmount})</button>`
    : "";
  const drawButton = stackPending
    ? ""
    : view.drawnCardId
      ? `<button class="button button-quiet button-small" data-action="pass" ${!yourTurn ? "disabled" : ""}>Pass turn</button>`
      : `<button class="button button-secondary button-small" data-action="draw" ${!yourTurn ? "disabled" : ""}>Draw a card</button>`;
  const timeLeft = view.timeLeftMs == null ? "" : `<span class="time-chip${view.timeLeftMs < 60_000 ? " low" : ""}">${ICONS.clock} ${clockFor(view.timeLeftMs)}</span>`;
  const turnMessage = winner
    ? "The table has a winner."
    : own.eliminated
      ? "You busted out at 40 cards — watching the rest play out."
      : yourTurn
        ? (stackPending
          ? `A +${view.stackAmount} stack is open — stack an equal-or-bigger +card or take the pile.`
          : view.drawnCardId ? "Play the card you drew, or pass." : "Your turn · play a matching card or draw.")
        : `Waiting for ${escapeHtml(view.players.find((player) => player.id === view.currentPlayerId)?.name ?? "a player")}${stackPending ? ` to answer the +${view.stackAmount} stack` : ""}`;
  const handCards = cards.length
    ? cards.map((card) => {
      const playable = canChooseCard(card, own, view) && (own.cardCount !== 1 || called);
      const freshlyTaken = justDrawnIds.includes(card.id);
      return `<button class="hand-card${playable ? " is-playable" : ""}${freshlyTaken ? " just-drawn" : ""}" data-action="pick-card" data-card="${escapeHtml(card.id)}" aria-label="${escapeHtml(cardName(card))} ${escapeHtml(card.color ?? "wild")} card${playable ? ", playable" : ""}" ${playable ? "" : "disabled"}>${cardMarkup(card)}</button>`;
    }).join("")
    : `<span class="empty-hand">Your cards are private to you.</span>`;
  const activeColorClass = COLORS.includes(view.activeColor) ? view.activeColor : "red";
  const eliminatedCount = opponents.filter((player) => player.eliminated).length;

  const topChanged = animateThrowFromDiff(view, viewerId);
  animatePickups(view, viewerId);
  suppressOwnThrow = false;
  const discardClass = topChanged ? " landed" : "";

  app.innerHTML = `
    <section class="game-page">
      <div class="game-toolbar">
        <div class="game-title"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>NO MERCY</strong><small>${mode === "local" ? "Solo table · 3 bots" : `Room ${escapeHtml(view.roomCode)}`}</small></span></div>
        <div class="toolbar-actions">${timeLeft}${mode === "online" ? `<span class="pill"><i class="pill-dot"></i> Room ${escapeHtml(view.roomCode)}</span>` : ""}${eliminatedCount ? `<span class="pill bust-pill">${ICONS.burst} ${eliminatedCount} bust${eliminatedCount === 1 ? "" : "s"}</span>` : ""}<button class="button button-quiet button-small" data-action="exit">Leave table</button></div>
      </div>
      <section class="arena seats-${view.players.length}" aria-label="Game table">
        ${seatOrder.map((player, index) => renderOpponent(player, view, viewerId, index, seatOrder.length)).join("")}
        <div class="table-center">
          <div class="pile-wrap"><button class="draw-pile" data-action="draw" aria-label="Draw a card" ${!yourTurn || view.drawnCardId || stackPending ? "disabled" : ""}><span class="back-card"></span></button><span class="pile-caption">Draw · ${view.drawCount}</span></div>
          <div class="pile-wrap"><div class="discard-slot${discardClass}"><span class="color-ring" data-color="${activeColorClass}" aria-hidden="true"></span>${view.topCard ? cardMarkup(view.topCard) : ""}</div><span class="pile-caption${stackPending ? " stack-live" : ""}">${stackPending ? `Stack +${view.stackAmount}` : "Played card"}</span></div>
        </div>
      </section>
      <div class="turn-callout"><i class="turn-indicator"></i><span>${turnMessage}</span><span class="active-color"><i class="active-swatch ${activeColorClass}"></i>${activeColorClass} · ${view.direction === 1 ? "clockwise" : "counterclockwise"}</span></div>
      <div class="control-row">${stackButton}${drawButton}${canCall ? `<button class="button button-primary button-small" data-action="call-uno">Say UNO</button>` : ""}${canCatch ? `<button class="button button-danger button-small" data-action="catch-uno">Call out missed UNO</button>` : ""}${view.status === "finished" ? `<button class="button button-primary button-small" data-action="exit">Play again</button>` : ""}</div>
      <section class="hand-area" aria-label="Your hand">
        <div class="hand-heading"><div><strong>YOUR HAND</strong><span>${own.cardCount} ${own.cardCount === 1 ? "card" : "cards"}${own.cardCount >= 35 && !own.eliminated ? " · bust at 40!" : ""}</span></div>${own.cardCount === 1 ? `<span>${called ? "UNO called" : "Call UNO before your last card"}</span>` : ""}</div>
        <div class="hand-cards${yourTurn ? "" : " waiting"}">${handCards}</div>
      </section>
      ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
    </section>`;

}

function renderWinner(view) {
  const winner = view.players.find((player) => player.id === view.winnerId);
  if (!winner) return;
  const reason = view.winReason === "timeout"
    ? "Time expired — fewest cards takes the table."
    : view.winReason === "last-standing"
      ? "Every rival hit 40 cards. Last one standing."
      : "That’s the final card. Nice playing.";
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="winner-title"><div class="finish-mark">${ICONS.trophy}</div><h2 id="winner-title">${escapeHtml(winner.name)} wins!</h2><p>${reason}</p><div class="modal-actions"><button class="button button-primary" data-action="exit">${ICONS.replay}<span>Play again</span></button></div></section></div>`;


}

function renderPlayModal() {
  if (!pendingCard) {
    modalRoot.innerHTML = "";
    return;
  }
  const own = currentView().players.find((player) => player.id === (mode === "local" ? "you" : session.playerId));
  const isWild = isWildType(pendingCard.type);
  const colorPicker = isWild ? `<p>Choose the color that continues play.</p><div class="color-options">${COLORS.map((color) => `<button class="color-choice ${color}" data-action="choose-color" data-color="${color}" aria-label="Choose ${color}" title="${color}"></button>`).join("")}</div>` : `<p>Put this card on the discard pile?</p>`;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="play-title"><h2 id="play-title">Play ${escapeHtml(cardName(pendingCard))}${pendingCard.color ? ` ${escapeHtml(pendingCard.color)}` : ""}</h2>${colorPicker}${own.cardCount === 2 ? `<label class="uno-check"><input id="declare-uno" type="checkbox" checked> Say UNO with this play</label>` : ""}<div class="modal-actions"><button class="button button-quiet" data-action="cancel-play">Cancel</button><button class="button button-primary" data-action="confirm-play" ${isWild && !selectedColor ? "disabled" : ""}>Play card</button></div></section></div>`;
}

function render() {
  if (mode === "online" && roomState?.status === "waiting") {
    lastView = roomState;
    app.innerHTML = `<section class="game-page">${renderLobby(roomState)}</section>`;
  } else if ((mode === "online" && roomState) || (mode === "local" && localGame)) {
    const view = currentView();
    renderGame(view);
    lastView = view;
    if (view.winnerId) {
      renderWinner(view);
      return;
    }
  } else {
    lastView = null;
    renderMenu();
  }
  renderPlayModal();
}

async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The request failed.");
  return result;
}

function stopPolling() {
  clearInterval(roomPoll);
  roomPoll = null;
}

function startPolling() {
  stopPolling();
  roomPoll = setInterval(async () => {
    if (!session) return;
    try {
      const nextState = await request(`/api/rooms/${session.roomCode}`, { token: session.playerToken });
      if (JSON.stringify(nextState) !== JSON.stringify(roomState)) {
        roomState = nextState;
        if (!pendingCard) render();
      }
    } catch (error) {
      showNotice(error.message);
      stopPolling();
    }
  }, 900);
}

function enterRoom(result, isHost) {
  stopPolling();
  clearTimeout(botTimer);
  localGame = null;
  session = { roomCode: result.roomCode, playerId: result.playerId, playerToken: result.playerToken, isHost };
  roomState = result.state;
  mode = "online";
  notice = "";
  inviteCode = "";
  history.replaceState(null, "", location.pathname);
  render();
  startPolling();
}

function startSolo() {
  stopPolling();
  clearTimeout(botTimer);
  session = null;
  roomState = null;
  localGame = createGame([
    { id: "you", name: "You" },
    { id: "bot-milo", name: "Milo" },
    { id: "bot-nova", name: "Nova" },
    { id: "bot-ash", name: "Ash" },
  ]);
  mode = "local";
  notice = "";
  lastBotId = null;
  lastView = null;
  render();
  scheduleBot();
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (mode !== "local" || localGame.winner) return;
  const current = currentPlayer(localGame);
  if (current.id === "you") {
    lastBotId = null;
    return;
  }
  const gap = (lastBotId === current.id ? BOT_STEP_GAP : BOT_FIRST_GAP) + Math.floor(Math.random() * 500);
  botTimer = setTimeout(() => {
    if (mode !== "local" || localGame.winner) return;
    const bot = currentPlayer(localGame);
    if (!bot || bot.id === "you") {
      lastBotId = null;
      render();
      scheduleBot();
      return;
    }
    botStep(localGame);
    notice = "";
    lastBotId = currentPlayer(localGame)?.id === bot.id ? bot.id : null;
    render();
    scheduleBot();
  }, gap);
}

async function submitMove(move) {
  if (mode === "local") {
    applyMove(localGame, "you", move);
    notice = "";
    render();
    scheduleBot();
    return;
  }
  const nextState = await request(`/api/rooms/${session.roomCode}/move`, { method: "POST", body: move, token: session.playerToken });
  roomState = nextState;
  notice = "";
  render();
}

function leaveTable() {
  stopPolling();
  clearTimeout(botTimer);
  pendingCard = null;
  selectedColor = null;
  localGame = null;
  roomState = null;
  session = null;
  mode = "menu";
  notice = "";
  lastView = null;
  lastBotId = null;
  suppressOwnThrow = false;
  ensureFxLayer().replaceChildren();
  render();
}

function beginPlay(cardId) {
  const view = currentView();
  const playerId = mode === "local" ? "you" : session.playerId;
  const own = view.players.find((player) => player.id === playerId);
  const card = own?.hand?.find((held) => held.id === cardId);
  if (!card || !canChooseCard(card, own, view)) return;
  if (own.cardCount === 1 && !own.unoCalled) {
    notice = "Say UNO before playing your last card.";
    render();
    return;
  }
  pendingCard = card;
  selectedColor = card.color;
  if (isWildType(card.type) || own.cardCount === 2) renderPlayModal();
  else void confirmPlay(false);
}

function flyOwnPlay(card) {
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(card.id) : card.id;
  const from = document.querySelector(`.hand-card[data-card="${id}"]`)?.getBoundingClientRect() ?? rectOf(".hand-cards");
  const to = rectOf(".discard-slot");
  if (from && to) void flyCard({ html: cardMarkup(card), from, to, duration: 600, startRotate: -16, endRotate: 6 });
}

async function confirmPlay(declareUno) {
  if (!pendingCard) return;
  const card = pendingCard;
  const color = selectedColor;
  suppressOwnThrow = true;
  flyOwnPlay(card);
  pendingCard = null;
  selectedColor = null;
  modalRoot.innerHTML = "";
  try {
    await submitMove({ type: "play", cardId: card.id, ...(isWildType(card.type) ? { color } : {}), ...(declareUno ? { declareUno: true } : {}) });
  } catch (error) {
    showNotice(error.message);
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "solo") return startSolo();
    if (action === "host") { mode = "host"; notice = ""; return render(); }
    if (action === "join") { mode = "join"; notice = ""; return render(); }
    if (action === "menu") { mode = "menu"; notice = ""; inviteCode = ""; return render(); }
    if (action === "exit") return leaveTable();
    if (action === "start-room") {
      const result = await request(`/api/rooms/${session.roomCode}/start`, { method: "POST", body: {}, token: session.playerToken });
      roomState = result;
      notice = "";
      render();
      return;
    }
    if (action === "copy-room") {
      const link = `${location.origin}/?room=${roomState.roomCode}`;
      await navigator.clipboard.writeText(link);
      notice = "Invite link copied.";
      return render();
    }
    if (action === "pay-stack") return await submitMove({ type: "payStack" });
    if (action === "draw" || action === "pass" || action === "call-uno" || action === "catch-uno") {
      const type = ({ draw: "draw", pass: "pass", "call-uno": "callUno", "catch-uno": "catchUno" })[action];
      await submitMove({ type });
      return;
    }
    if (action === "pick-card") return beginPlay(button.dataset.card);
    if (action === "choose-color") {
      selectedColor = button.dataset.color;
      return renderPlayModal();
    }
    if (action === "cancel-play") {
      pendingCard = null;
      selectedColor = null;
      modalRoot.innerHTML = "";
      return;
    }
    if (action === "confirm-play") {
      const declareUno = document.querySelector("#declare-uno")?.checked === true;
      return await confirmPlay(declareUno);
    }
  } catch (error) {
    showNotice(error.message);
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  try {
    if (form.dataset.form === "host") {
      const result = await request("/api/rooms", { method: "POST", body: { name: values.get("name"), timeLimit: Number(values.get("timeLimit")) } });
      enterRoom(result, true);
    } else if (form.dataset.form === "join" || form.dataset.form === "join-inline") {
      const roomCode = String(values.get("room") ?? inviteCode).trim().toUpperCase();
      if (!/^[A-F\d]{6}$/.test(roomCode)) throw new Error("Enter the six-character room code.");
      const result = await request(`/api/rooms/${roomCode}/join`, { method: "POST", body: { name: values.get("name") || "Player" } });
      enterRoom(result, false);
    }
  } catch (error) {
    showNotice(error.message);
  }
});

const sharedRoom = new URLSearchParams(location.search).get("room");
if (sharedRoom && /^[A-F\d]{6}$/i.test(sharedRoom)) {
  mode = "join";
  inviteCode = sharedRoom.toUpperCase();
}
render();
