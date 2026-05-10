// State
let ws = null;
let playerId = null;
let roomCode = null;
let gameState = { cards: {}, players: {} };
const cardElements = new Map(); // Store card elements so we can find them even when not in DOM
let hoveredCardId = null; // Track currently hovered card for keyboard shortcuts

// Tabbed opponent view: only one opponent's battlefield is visible at a time.
// activeOppId is the pid of the focused opponent (or null when there are no opponents).
let activeOppId = null;
const OPP_CARD_W = 70;
const OPP_CARD_H = 100;
const OPP_TOP_FRACTION = 0.5;

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getController(card) {
    return card.controller || card.owner;
}

// Check if current player controls a card
function isControlledByMe(card) {
    return getController(card) === playerId;
}

// DOM refs
const lobby = document.getElementById('lobby');
const game = document.getElementById('game');
const battlefield = document.getElementById('battlefield');
const hand = document.getElementById('hand');
const library = document.getElementById('library');
const graveyard = document.getElementById('graveyard');
const exile = document.getElementById('exile');
const command = document.getElementById('command');
const cardPreview = document.getElementById('card-preview');

// Lobby functions
function onStartingLifeChange() {
    const val = document.getElementById('starting-life-select').value;
    document.getElementById('starting-life-custom').classList.toggle('hidden', val !== 'custom');
}

function getStartingLife() {
    const sel = document.getElementById('starting-life-select');
    if (sel.value === 'custom') {
        return Math.max(1, Math.min(999, parseInt(document.getElementById('starting-life-custom').value) || 20));
    }
    return parseInt(sel.value);
}

async function createRoom() {
    const startingLife = getStartingLife();
    const r = await fetch('/api/room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starting_life: startingLife })
    });
    const data = await r.json();
    connectToRoom(data.code);
}

function joinRoom() {
    const code = document.getElementById('room-code').value.toUpperCase();
    if (code.length === 4) {
        connectToRoom(code);
    }
}

function connectToRoom(code) {
    roomCode = code;
    const playerName = document.getElementById('player-name').value || 'Player';
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/${code}/${playerName}`);

    ws.onopen = () => {
        lobby.classList.add('hidden');
        game.classList.remove('hidden');
        document.getElementById('room-display').textContent = `Room: ${code}`;
        // Keepalive ping every 25 seconds
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({type: 'ping'}));
            }
        }, 25000);
    };

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
    };

    ws.onclose = () => {
        alert('Disconnected from server');
        location.reload();
    };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'pong':
            return; // keepalive response
        case 'init':
            playerId = msg.player_id;
            gameState = msg.state;
            ensureValidActiveOpp();   // pick default tab BEFORE rendering opp cards (avoids 1-frame flash)
            renderAllCards();
            updatePlayerCount();
            updateMyLife();
            updateTurnUI();
            renderCommanderDamage();
            break;

        case 'player_joined':
            gameState.players[msg.player_id] = {
                name: msg.name,
                deck_loaded: false,
                life: msg.life ?? (gameState.starting_life || 20),
                counters: {},
                commander_damage: {}
            };
            if (msg.turn_order) gameState.turn_order = msg.turn_order;
            updatePlayerCount();
            renderCommanderDamage();
            addLogEntry(`${msg.name} joined`);
            break;

        case 'player_left': {
            const leavingName = gameState.players[msg.player_id]?.name || 'A player';
            delete gameState.players[msg.player_id];
            if (msg.turn_order) {
                gameState.turn_order = msg.turn_order;
                gameState.current_turn_index = msg.current_turn_index;
                updateTurnUI();
            }
            updatePlayerCount();
            renderCommanderDamage();
            addLogEntry(`${leavingName} left the game`);
            break;
        }

        case 'cards_added':
            msg.cards.forEach(card => {
                gameState.cards[card.id] = card;
                renderCard(card);
            });
            scheduleRenderOpponents();
            if (msg.cards.length >= 10) {
                const owner = gameState.players[msg.cards[0]?.owner];
                if (owner) addLogEntry(`${owner.name} loaded their deck`);
            }
            break;

        case 'card_moved':
            if (gameState.cards[msg.card_id]) {
                const card = gameState.cards[msg.card_id];
                card.x = msg.x;
                card.y = msg.y;
                if (msg.zone) card.zone = msg.zone;
                if (msg.face_down !== undefined) card.face_down = msg.face_down;
                updateCardPosition(msg.card_id);
                updateCardFlipped(msg.card_id);
                renderCardCounters(msg.card_id);
                scheduleRenderOpponents();
            }
            break;

        case 'card_tapped':
            if (gameState.cards[msg.card_id]) {
                gameState.cards[msg.card_id].tapped = msg.tapped;
                updateCardTapped(msg.card_id);
            }
            break;

        case 'card_flipped':
            if (gameState.cards[msg.card_id]) {
                gameState.cards[msg.card_id].face_down = msg.face_down;
                updateCardFlipped(msg.card_id);
            }
            break;

        case 'card_transformed':
            if (gameState.cards[msg.card_id]) {
                gameState.cards[msg.card_id].transformed = msg.transformed;
                updateCardImage(msg.card_id);
            }
            break;

        case 'player_shuffled':
            // Could show a notification
            break;

        case 'life_changed': {
            const lifePlr = gameState.players[msg.player_id];
            if (lifePlr) {
                const oldLife = lifePlr.life;
                lifePlr.life = msg.life;
                if (msg.player_id === playerId) updateMyLife();
                scheduleRenderOpponents();
                if (oldLife !== msg.life) addLogEntry(`${lifePlr.name}: ${oldLife} → ${msg.life} life`);
            }
            break;
        }

        case 'player_counter_changed':
            if (gameState.players[msg.player_id]) {
                gameState.players[msg.player_id].counters = msg.counters;
                if (msg.player_id === playerId) {
                    renderPlayerCounters();
                }
                scheduleRenderOpponents();
            }
            break;

        case 'card_counter_changed':
            if (gameState.cards[msg.card_id]) {
                gameState.cards[msg.card_id].counters = msg.counters;
                renderCardCounters(msg.card_id);
            }
            break;

        case 'control_changed':
            if (gameState.cards[msg.card_id]) {
                gameState.cards[msg.card_id].controller = msg.new_controller;
                updateCardControlIndicator(msg.card_id);
                updateCardPosition(msg.card_id);
                scheduleRenderOpponents();
            }
            break;

        case 'turn_changed': {
            gameState.current_turn_index = msg.current_turn_index;
            updateTurnUI();
            scheduleRenderOpponents();
            const newActiveName = gameState.players[msg.active_player_id]?.name;
            if (newActiveName) addLogEntry(`${newActiveName}'s turn`);
            break;
        }

        case 'commander_damage_changed':
            if (gameState.players[msg.target_player_id]) {
                if (!gameState.players[msg.target_player_id].commander_damage) {
                    gameState.players[msg.target_player_id].commander_damage = {};
                }
                gameState.players[msg.target_player_id].commander_damage[msg.source_player_id] = msg.amount;
                if (msg.target_player_id === playerId) renderCommanderDamage();
                scheduleRenderOpponents();
            }
            break;

        case 'chat':
            appendChatMessage(msg.player_name, msg.text, msg.player_id === playerId);
            break;
    }
}

function updatePlayerCount() {
    const count = Object.keys(gameState.players).length;
    document.getElementById('players-display').textContent = `Players: ${count}`;
    scheduleRenderOpponents();
}

let opponentRenderPending = false;
function scheduleRenderOpponents() {
    if (opponentRenderPending) return;
    opponentRenderPending = true;
    requestAnimationFrame(() => {
        opponentRenderPending = false;
        renderOpponents();
    });
}

function getActiveTurnPlayerId() {
    const order = gameState.turn_order || [];
    const idx = gameState.current_turn_index || 0;
    return order.length > 0 ? order[idx % order.length] : null;
}

function renderOpponents() {
    const tableArea  = document.getElementById('table-area');
    const topSlot    = document.getElementById('opp-top');
    const leftSlot   = document.getElementById('opp-left');
    const rightSlot  = document.getElementById('opp-right');

    topSlot.innerHTML   = '';
    leftSlot.innerHTML  = '';
    rightSlot.innerHTML = '';
    tableArea.classList.remove('has-top', 'has-left', 'has-right');

    const activeId  = getActiveTurnPlayerId();
    const opponents = Object.entries(gameState.players).filter(([pid]) => pid !== playerId);

    // Refresh tab bar + ensure activeOppId is valid for the current opp set.
    ensureValidActiveOpp();
    renderOppTabs();
    applyOppCardVisibility();

    if (!opponents.length) return;

    // Assign positions: 1→left, 2→left+right, 3→top+left+right, 4+→top(2)+left+right
    let top = [], left = [], right = [];
    if (opponents.length === 1) {
        left = opponents;
    } else if (opponents.length === 2) {
        left  = [opponents[0]];
        right = [opponents[1]];
    } else if (opponents.length === 3) {
        top   = [opponents[0]];
        left  = [opponents[1]];
        right = [opponents[2]];
    } else {
        top   = opponents.slice(0, 2);
        left  = [opponents[2]];
        right = opponents.slice(3);
    }

    function buildCard(pid, player) {
        const handCount  = Object.values(gameState.cards).filter(c => c.owner === pid && c.zone === 'hand').length;
        const libCount   = Object.values(gameState.cards).filter(c => c.owner === pid && c.zone === 'library').length;
        const commanders = Object.values(gameState.cards).filter(c => c.owner === pid && c.zone === 'command');

        const el = document.createElement('div');
        el.className = 'opponent-info-compact';
        if (pid === activeId) el.classList.add('active-turn');

        commanders.forEach(c => {
            const cmdEl = document.createElement('div');
            cmdEl.className = 'opponent-commander';
            cmdEl.style.backgroundImage = `url(${getDisplayImage(c)})`;
            cmdEl.title = c.name;
            cmdEl.addEventListener('mouseenter', () => {
                cardPreview.style.backgroundImage = `url(${getDisplayImage(c)})`;
                cardPreview.classList.remove('hidden');
            });
            cmdEl.addEventListener('mouseleave', hideCardPreview);
            el.appendChild(cmdEl);
        });

        const nameEl = document.createElement('div');
        nameEl.className = 'opp-name';
        nameEl.textContent = player.name + (pid === activeId ? ' ▶' : '');
        el.appendChild(nameEl);

        const lifeEl = document.createElement('div');
        lifeEl.className = 'opp-life';
        lifeEl.textContent = player.life ?? 20;
        el.appendChild(lifeEl);

        const cmdDmg = player.commander_damage?.[playerId] || 0;
        const statsEl = document.createElement('div');
        statsEl.className = 'opp-stats';
        statsEl.textContent = `H:${handCount} L:${libCount}` + (commanders.length ? ` C:${cmdDmg}` : '');
        el.appendChild(statsEl);

        if (player.counters && Object.keys(player.counters).length) {
            const ctrEl = document.createElement('div');
            ctrEl.className = 'opp-counters';
            ctrEl.innerHTML = Object.entries(player.counters)
                .map(([n, v]) => `<span class="opponent-counter">${esc(n)}:${v}</span>`).join('');
            el.appendChild(ctrEl);
        }
        return el;
    }

    if (top.length)   { tableArea.classList.add('has-top');   top.forEach(([pid, p])   => topSlot.appendChild(buildCard(pid, p))); }
    if (left.length)  { tableArea.classList.add('has-left');  left.forEach(([pid, p])  => leftSlot.appendChild(buildCard(pid, p))); }
    if (right.length) { tableArea.classList.add('has-right'); right.forEach(([pid, p]) => rightSlot.appendChild(buildCard(pid, p))); }
}

function getOppOrder() {
    const fromTurn = (gameState.turn_order || []).filter(pid => pid !== playerId && gameState.players[pid]);
    if (fromTurn.length) return fromTurn;
    return Object.keys(gameState.players).filter(pid => pid !== playerId);
}

function ensureValidActiveOpp() {
    const order = getOppOrder();
    if (!order.length) { activeOppId = null; return; }
    if (!activeOppId || !order.includes(activeOppId)) activeOppId = order[0];
}

function renderOppTabs() {
    const bar = document.getElementById('opp-tab-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const order = getOppOrder();
    if (order.length <= 1) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    order.forEach(pid => {
        const p = gameState.players[pid];
        if (!p) return;
        const btn = document.createElement('button');
        btn.className = 'opp-tab' + (pid === activeOppId ? ' active' : '');
        btn.dataset.pid = pid;
        btn.textContent = `${p.name}  ❤${p.life ?? 20}`;
        btn.addEventListener('click', () => setActiveOpp(pid));
        bar.appendChild(btn);
    });
}

function applyOppCardVisibility() {
    Object.values(gameState.cards).forEach(c => {
        if (c.zone !== 'battlefield') return;
        if (isControlledByMe(c)) return;
        const el = cardElements.get(c.id);
        if (!el) return;
        el.style.display = (getController(c) === activeOppId) ? '' : 'none';
    });
}

function setActiveOpp(pid) {
    if (pid === activeOppId) return;
    activeOppId = pid;
    applyOppCardVisibility();
    renderOppTabs();
    const sideLabel = document.querySelector('.side-label.opponent-side');
    if (sideLabel) {
        const name = activeOppId ? (gameState.players[activeOppId]?.name || '') : '';
        sideLabel.textContent = name ? `${name}'s Side` : "Opponent's Side";
    }
}

function updateMyLife() {
    const player = gameState.players[playerId];
    const life = player ? (player.life ?? 20) : 20;
    document.getElementById('my-life').textContent = life;
}

function adjustLife(delta) {
    const player = gameState.players[playerId];
    if (!player) return;

    const newLife = (player.life ?? 20) + delta;
    player.life = newLife;
    updateMyLife();

    ws.send(JSON.stringify({ type: 'set_life', life: newLife }));
}

// Turn order
function passTurn() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pass_turn' }));
    }
}

function updateTurnUI() {
    const activeId = getActiveTurnPlayerId();
    const isMyTurn = activeId === playerId;
    const indicator = document.getElementById('turn-indicator');
    const topBar = document.getElementById('top-bar');
    if (indicator) indicator.classList.toggle('hidden', !isMyTurn);
    if (topBar) topBar.classList.toggle('my-turn', isMyTurn);
}

// Commander damage
function renderCommanderDamage() {
    const container = document.getElementById('commander-damage');
    if (!container) return;
    container.innerHTML = '';

    const myPlayer = gameState.players[playerId];
    if (!myPlayer) return;

    const opponents = Object.entries(gameState.players).filter(([pid]) => pid !== playerId);
    if (opponents.length === 0) return;

    opponents.forEach(([pid, opponent]) => {
        const damage = myPlayer.commander_damage?.[pid] || 0;
        const chip = document.createElement('div');
        chip.className = 'cmd-damage-chip';
        if (damage >= 21) chip.classList.add('lethal');
        else if (damage >= 15) chip.classList.add('warning');
        chip.title = `Commander damage from ${opponent.name}. Click +1, Shift+Click -1`;
        chip.innerHTML = `<span class="cmd-dmg-name">${esc(opponent.name)}</span><span class="cmd-dmg-val">${damage}</span>`;
        chip.addEventListener('click', (e) => adjustCommanderDamage(pid, e.shiftKey ? -1 : 1));
        container.appendChild(chip);
    });
}

function adjustCommanderDamage(sourcePlayerId, delta) {
    const myPlayer = gameState.players[playerId];
    if (!myPlayer) return;
    if (!myPlayer.commander_damage) myPlayer.commander_damage = {};
    const current = myPlayer.commander_damage[sourcePlayerId] || 0;
    const newAmount = Math.max(0, current + delta);
    myPlayer.commander_damage[sourcePlayerId] = newAmount;
    renderCommanderDamage();
    ws.send(JSON.stringify({
        type: 'set_commander_damage',
        target_player_id: playerId,
        source_player_id: sourcePlayerId,
        amount: newAmount
    }));
}

// Chat / Log panel
let chatPanelOpen = false;
let activeChatTab = 'chat';

function toggleChatPanel() {
    chatPanelOpen = !chatPanelOpen;
    const panel = document.getElementById('chat-panel');
    const toggleBtn = document.getElementById('chat-toggle-btn');
    panel.classList.toggle('hidden', !chatPanelOpen);
    if (toggleBtn) toggleBtn.textContent = chatPanelOpen ? 'Hide Chat' : 'Chat';
    document.body.classList.toggle('chat-open', chatPanelOpen);
}

function switchChatTab(tab) {
    activeChatTab = tab;
    document.getElementById('chat-messages').classList.toggle('hidden', tab !== 'chat');
    document.getElementById('log-messages').classList.toggle('hidden', tab !== 'log');
    document.querySelectorAll('.chat-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
}

function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    input.value = '';
}

function appendChatMessage(playerName, text, isSelf) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-message' + (isSelf ? ' self' : '');
    el.innerHTML = `<span class="chat-name">${esc(playerName)}</span><span class="chat-text">${esc(text)}</span>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    // If panel closed, briefly highlight toggle button
    if (!chatPanelOpen) {
        const btn = document.getElementById('chat-toggle-btn');
        if (btn) { btn.classList.add('chat-unread'); setTimeout(() => btn.classList.remove('chat-unread'), 3000); }
    }
}

function addLogEntry(text) {
    const container = document.getElementById('log-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

// Counter system
let counterTarget = null; // 'player' or card ID

function showAddCounterModal(target) {
    counterTarget = target;
    document.getElementById('counter-name-input').value = '';
    document.getElementById('counter-modal').classList.remove('hidden');
    document.getElementById('counter-name-input').focus();
}

function hideCounterModal() {
    document.getElementById('counter-modal').classList.add('hidden');
    counterTarget = null;
}

function confirmAddCounter() {
    const name = document.getElementById('counter-name-input').value.trim();
    if (!name) return;

    if (counterTarget === 'player') {
        addPlayerCounter(name);
    } else if (counterTarget) {
        addCardCounter(counterTarget, name);
    }
    hideCounterModal();
}

function addPlayerCounter(name) {
    const player = gameState.players[playerId];
    if (!player.counters) player.counters = {};
    player.counters[name] = (player.counters[name] || 0) + 1;
    renderPlayerCounters();
    ws.send(JSON.stringify({ type: 'set_player_counter', name, value: player.counters[name] }));
}

function adjustPlayerCounter(name, delta) {
    const player = gameState.players[playerId];
    if (!player.counters) player.counters = {};
    const newVal = (player.counters[name] || 0) + delta;
    if (newVal <= 0) {
        delete player.counters[name];
    } else {
        player.counters[name] = newVal;
    }
    renderPlayerCounters();
    ws.send(JSON.stringify({ type: 'set_player_counter', name, value: newVal }));
}

function removePlayerCounter(name) {
    const player = gameState.players[playerId];
    if (player.counters) delete player.counters[name];
    renderPlayerCounters();
    ws.send(JSON.stringify({ type: 'set_player_counter', name, value: 0 }));
}

function renderPlayerCounters() {
    const container = document.getElementById('player-counters');
    container.innerHTML = '';

    const player = gameState.players[playerId];
    if (!player || !player.counters) return;

    Object.entries(player.counters).forEach(([name, value]) => {
        const el = document.createElement('div');
        el.className = 'player-counter';
        el.innerHTML = `
            <span class="counter-name">${esc(name)}</span>
            <button onclick="adjustPlayerCounter('${esc(name)}', -1)">-</button>
            <span class="counter-value">${value}</span>
            <button onclick="adjustPlayerCounter('${esc(name)}', 1)">+</button>
            <button class="remove-counter" onclick="removePlayerCounter('${esc(name)}')">x</button>
        `;
        container.appendChild(el);
    });
}

// Card counters
function addCardCounter(cardId, name) {
    const card = gameState.cards[cardId];
    if (!card) return;
    if (!card.counters) card.counters = {};
    card.counters[name] = (card.counters[name] || 0) + 1;
    renderCardCounters(cardId);
    ws.send(JSON.stringify({ type: 'set_card_counter', card_id: cardId, name, value: card.counters[name] }));
}

function adjustCardCounter(cardId, name, delta) {
    const card = gameState.cards[cardId];
    if (!card || !card.counters) return;
    const newVal = (card.counters[name] || 0) + delta;
    if (newVal <= 0) {
        delete card.counters[name];
    } else {
        card.counters[name] = newVal;
    }
    renderCardCounters(cardId);
    ws.send(JSON.stringify({ type: 'set_card_counter', card_id: cardId, name, value: newVal }));
}

function renderCardCounters(cardId) {
    const el = cardElements.get(cardId);
    if (!el) return;

    let countersEl = el.querySelector('.card-counters');
    if (!countersEl) {
        countersEl = document.createElement('div');
        countersEl.className = 'card-counters';
        el.appendChild(countersEl);
    }

    const card = gameState.cards[cardId];
    if (!card || !card.counters || Object.keys(card.counters).length === 0) {
        countersEl.innerHTML = '';
        return;
    }

    countersEl.innerHTML = Object.entries(card.counters).map(([name, val]) =>
        `<span class="card-counter" onclick="event.stopPropagation(); adjustCardCounter('${cardId}', '${esc(name)}', event.shiftKey ? -1 : 1)" title="Click +1, Shift+Click -1">${esc(name)}: <span class="counter-val">${val}</span></span>`
    ).join('');
}

// Deck loading
function showDeckModal() {
    document.getElementById('deck-modal').classList.remove('hidden');
}

function hideDeckModal() {
    document.getElementById('deck-modal').classList.add('hidden');
}

function exportDeck() {
    const myCards = Object.values(gameState.cards).filter(c => c.owner === playerId);
    if (myCards.length === 0) {
        document.getElementById('load-status').textContent = 'No cards to export.';
        return;
    }

    // Count cards by name
    const counts = {};
    for (const card of myCards) {
        counts[card.name] = (counts[card.name] || 0) + 1;
    }

    // Generate deck list
    const lines = Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, qty]) => `${qty} ${name}`);

    const deckText = lines.join('\n');
    document.getElementById('deck-input').value = deckText;
    document.getElementById('load-status').textContent = `Exported ${myCards.length} cards (${lines.length} unique).`;

    // Copy to clipboard
    navigator.clipboard.writeText(deckText).then(() => {
        document.getElementById('load-status').textContent += ' Copied to clipboard!';
    }).catch(() => {});
}

// Saved decks
function getSavedDecks() {
    try {
        return JSON.parse(localStorage.getItem('savedDecks') || '{}');
    } catch { return {}; }
}

function saveDeck() {
    const name = document.getElementById('deck-name-input').value.trim();
    const deckList = document.getElementById('deck-input').value.trim();
    if (!name) {
        document.getElementById('load-status').textContent = 'Enter a deck name first.';
        return;
    }
    if (!deckList) {
        document.getElementById('load-status').textContent = 'No deck list to save.';
        return;
    }
    const decks = getSavedDecks();
    decks[name] = deckList;
    localStorage.setItem('savedDecks', JSON.stringify(decks));
    document.getElementById('load-status').textContent = `Saved "${name}"!`;
    document.getElementById('deck-name-input').value = '';
    refreshSavedDecksList();
}

function loadSavedDeck() {
    const select = document.getElementById('saved-decks-select');
    const name = select.value;
    if (!name) return;
    const decks = getSavedDecks();
    if (decks[name]) {
        document.getElementById('deck-input').value = decks[name];
        document.getElementById('deck-name-input').value = name;
        document.getElementById('load-status').textContent = `Loaded "${name}".`;
    }
}

function deleteSavedDeck() {
    const select = document.getElementById('saved-decks-select');
    const name = select.value;
    if (!name) {
        document.getElementById('load-status').textContent = 'Select a deck to delete.';
        return;
    }
    const decks = getSavedDecks();
    delete decks[name];
    localStorage.setItem('savedDecks', JSON.stringify(decks));
    document.getElementById('load-status').textContent = `Deleted "${name}".`;
    refreshSavedDecksList();
}

function refreshSavedDecksList() {
    const select = document.getElementById('saved-decks-select');
    const decks = getSavedDecks();
    select.innerHTML = '<option value="">-- Saved Decks --</option>';
    for (const name of Object.keys(decks).sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
}

// Initialize saved decks list on page load
refreshSavedDecksList();

// Card cache helpers
function getCardCache() {
    try {
        return JSON.parse(localStorage.getItem('cardCache') || '{}');
    } catch { return {}; }
}

function saveToCardCache(cards) {
    const cache = getCardCache();
    for (const [name, data] of Object.entries(cards)) {
        cache[name] = data;
    }
    try {
        localStorage.setItem('cardCache', JSON.stringify(cache));
    } catch { /* storage full, ignore */ }
}

async function loadDeck() {
    const input = document.getElementById('deck-input').value;
    const status = document.getElementById('load-status');
    const lines = input.trim().split('\n').filter(l => l.trim() && !l.startsWith('//'));

    status.textContent = 'Parsing deck list...';

    // Parse all lines first
    const parsed = lines.map(parseDeckLine).filter(Boolean);
    if (parsed.length === 0) {
        status.textContent = 'No cards found. Check your deck list format.';
        return;
    }

    // Get unique card names and check cache
    const uniqueNames = [...new Set(parsed.map(p => p.name))];
    const cache = getCardCache();
    const cardMap = {};
    const uncached = [];

    for (const name of uniqueNames) {
        const cached = cache[name.toLowerCase()];
        if (cached) {
            cardMap[name.toLowerCase()] = cached;
        } else {
            uncached.push(name);
        }
    }

    // Fetch only uncached cards
    if (uncached.length > 0) {
        status.textContent = `Fetching ${uncached.length} cards (${uniqueNames.length - uncached.length} cached)...`;
        const identifiers = uncached.map(name => ({ name }));
        const r = await fetch('/api/cards/collection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(identifiers)
        });
        const { cards: fetched } = await r.json();
        Object.assign(cardMap, fetched);
        saveToCardCache(fetched);
    } else {
        status.textContent = `All ${uniqueNames.length} cards loaded from cache!`;
    }

    // Build cards array
    const cards = [];
    const failed = [];

    for (const p of parsed) {
        const cardData = cardMap[p.name.toLowerCase()];
        if (cardData) {
            const images = getCardImages(cardData);
            for (let i = 0; i < p.qty; i++) {
                cards.push({
                    id: crypto.randomUUID(),
                    name: cardData.name,
                    image: images.front,
                    back_image: images.back,
                    transformed: false,
                    x: 0,
                    y: 0,
                    zone: 'library',
                    tapped: false,
                    face_down: true
                });
            }
        } else {
            failed.push(`${p.qty} ${p.name}`);
        }
    }

    if (cards.length > 0) {
        shuffle(cards);
        ws.send(JSON.stringify({ type: 'add_cards', cards }));
        let msg = `Loaded ${cards.length} cards!`;
        if (failed.length > 0) {
            msg += ` (${failed.length} failed: ${failed.join(', ')})`;
        }
        status.textContent = msg;
        setTimeout(() => {
            hideDeckModal();
            showCommanderPrompt();
        }, 1500);
    } else {
        status.textContent = 'No cards loaded. Check your deck list format.';
        if (failed.length > 0) {
            status.textContent += ` Failed: ${failed.join(', ')}`;
        }
    }
}

function parseDeckLine(line) {
    // Formats: "1 Card Name", "1x Card Name", "1 Card Name (SET)", "1 Card Name [SET] 123"
    line = line.trim();

    // Match quantity at start
    const qtyMatch = line.match(/^(\d+)x?\s+(.+)$/i);
    if (!qtyMatch) {
        return line ? { qty: 1, name: line, set: null } : null;
    }

    const qty = parseInt(qtyMatch[1]);
    let name = qtyMatch[2].trim();
    let set = null;

    // Strip [SET] 123 or (SET) 123 from end
    const setMatch = name.match(/^(.+?)\s*[\[\(](\w+)[\]\)]\s*\d*$/);
    if (setMatch) {
        name = setMatch[1].trim();
        set = setMatch[2];
    }

    // Normalize card name for Scryfall
    name = normalizeCardName(name);

    return { qty, name, set };
}

function normalizeCardName(name) {
    return name
        // Fix curly apostrophes/quotes to straight
        .replace(/['']/g, "'")
        .replace(/[""]/g, '"')
        // Single slash to double for DFCs (but not if already double)
        .replace(/(?<!\/)\/(?!\/)/g, ' // ')
        // Clean up multiple spaces
        .replace(/\s+/g, ' ')
        .trim();
}

function getCardImages(card) {
    // Regular card - single image
    if (card.image_uris) {
        return { front: card.image_uris.normal || card.image_uris.small, back: null };
    }
    // DFC - has card_faces array with separate images
    if (card.card_faces && card.card_faces[0]?.image_uris) {
        return {
            front: card.card_faces[0].image_uris.normal,
            back: card.card_faces[1]?.image_uris?.normal || null
        };
    }
    return { front: '', back: null };
}

function getCardImage(card) {
    return getCardImages(card).front;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// Card rendering
function renderAllCards() {
    Object.values(gameState.cards).forEach(renderCard);
    updateLibraryCount();
}

function updateLibraryCount() {
    let counter = document.getElementById('library-count');
    if (!counter) {
        counter = document.createElement('span');
        counter.id = 'library-count';
        counter.className = 'library-count';
        library.appendChild(counter);
    }
    const count = Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.zone === 'library').length;
    counter.textContent = count;
}

function renderCard(card) {
    let el = cardElements.get(card.id);
    if (!el) {
        el = document.createElement('div');
        el.id = `card-${card.id}`;
        el.className = 'card';
        el.style.backgroundImage = `url(${getDisplayImage(card)})`;
        el.dataset.cardId = card.id;
        cardElements.set(card.id, el);

        // Drag handling
        el.addEventListener('mousedown', (e) => {
            if (e.button === 1) {
                // Middle click - add counter
                e.preventDefault();
                showAddCounterModal(card.id);
            } else {
                startDrag(e);
            }
        });
        el.addEventListener('dblclick', () => tapCard(card.id));

        // Card preview on hover and track hovered card for keyboard shortcuts
        el.addEventListener('mouseenter', () => {
            hoveredCardId = card.id;
            showCardPreview(card.id);
        });
        el.addEventListener('mouseleave', () => {
            hoveredCardId = null;
            hideCardPreview();
        });
    }

    updateCardPosition(card.id, el);
    updateCardTapped(card.id, el);
    updateCardFlipped(card.id, el);
    renderCardCounters(card.id);
    updateCardControlIndicator(card.id);
    el.classList.toggle('token', !!card.token);
}

function updateCardPosition(cardId, el) {
    const card = gameState.cards[cardId];
    el = el || cardElements.get(cardId);
    if (!el || !card) return;

    const zone = card.zone;
    const isControlled = isControlledByMe(card);
    const isOwn = card.owner === playerId;

    if (zone === 'battlefield') {
        const bfRect = battlefield.getBoundingClientRect();

        if (isControlled) {
            const pixelX = card.x * bfRect.width;
            const pixelY = card.y * bfRect.height;
            el.style.left = pixelX + 'px';
            el.style.top = pixelY + 'px';
            el.classList.remove('opponent-card');
            el.style.display = '';
        } else {
            // Project opponent's full 0..1 play area into the top half at full width.
            // Visibility is gated by activeOppId so only the focused opp's cards show.
            const cx = Math.max(0, Math.min(1, card.x));
            const cy = Math.max(0, Math.min(1, card.y));
            const topH = bfRect.height * OPP_TOP_FRACTION;
            const px = cx * Math.max(0, bfRect.width - OPP_CARD_W);
            const py = (1 - cy) * Math.max(0, topH - OPP_CARD_H);
            el.style.left = px + 'px';
            el.style.top  = py + 'px';
            el.classList.add('opponent-card');
            el.style.display = (getController(card) === activeOppId) ? '' : 'none';
        }
        el.classList.remove('card-in-hand', 'card-in-zone');
        if (el.parentElement !== battlefield) {
            el.remove();
            battlefield.appendChild(el);
        }
    } else {
        el.style.left = '';
        el.style.top = '';
        el.style.display = '';
        const isZone = zone !== 'hand';
        el.classList.toggle('card-in-hand', !isZone);
        el.classList.toggle('card-in-zone', isZone);

        const targets = { hand, library, graveyard, exile, command };
        const target = targets[zone];
        if (isOwn && target && el.parentElement !== target) {
            el.remove();
            target.appendChild(el);
        } else if (!isOwn && el.parentElement) {
            el.remove();
        }
    }
    updateLibraryCount();
}

function updateCardTapped(cardId, el) {
    const card = gameState.cards[cardId];
    el = el || cardElements.get(cardId);
    if (!el || !card) return;
    el.classList.toggle('tapped', card.tapped);
}

function updateCardFlipped(cardId, el) {
    const card = gameState.cards[cardId];
    el = el || cardElements.get(cardId);
    if (!el || !card) return;
    el.classList.toggle('face-down', card.face_down);
}

function getDisplayImage(card) {
    if (!card) return '';
    return card.transformed && card.back_image ? card.back_image : card.image;
}

function updateCardImage(cardId, el) {
    const card = gameState.cards[cardId];
    el = el || cardElements.get(cardId);
    if (!el || !card) return;
    el.style.backgroundImage = `url(${getDisplayImage(card)})`;
}

function showCardPreview(cardId) {
    const card = gameState.cards[cardId];
    if (!card || card.face_down) {
        hideCardPreview();
        return;
    }
    cardPreview.style.backgroundImage = `url(${getDisplayImage(card)})`;
    cardPreview.classList.remove('hidden');
}

function hideCardPreview() {
    cardPreview.classList.add('hidden');
}

// Card actions
function tapCard(cardId) {
    ws.send(JSON.stringify({ type: 'tap_card', card_id: cardId }));
    // Optimistic update
    gameState.cards[cardId].tapped = !gameState.cards[cardId].tapped;
    updateCardTapped(cardId);
}

function flipCard(cardId) {
    ws.send(JSON.stringify({ type: 'flip_card', card_id: cardId }));
    gameState.cards[cardId].face_down = !gameState.cards[cardId].face_down;
    updateCardFlipped(cardId);
}

function transformCard(cardId) {
    const card = gameState.cards[cardId];
    if (!card || !card.back_image) return;
    ws.send(JSON.stringify({ type: 'transform_card', card_id: cardId }));
    card.transformed = !card.transformed;
    updateCardImage(cardId);
}

function shuffleLibrary() {
    // Get card elements in library
    const libraryCardEls = Array.from(library.querySelectorAll('.card'));
    if (libraryCardEls.length === 0) return;

    // Shuffle the elements array
    shuffle(libraryCardEls);

    // Re-append in new order
    libraryCardEls.forEach(el => library.appendChild(el));

    ws.send(JSON.stringify({ type: 'shuffle_library' }));
}

function drawCard() {
    // Get top card from DOM order (last card element in library)
    const topCardEl = library.querySelector('.card:last-of-type');
    if (!topCardEl) return;

    const topCard = gameState.cards[topCardEl.dataset.cardId];
    if (!topCard) return;
    topCard.zone = 'hand';
    topCard.face_down = false;
    updateCardPosition(topCard.id);
    updateCardFlipped(topCard.id);

    ws.send(JSON.stringify({ type: 'move_card', card_id: topCard.id, x: 0, y: 0, zone: 'hand', face_down: false }));
}

function untapAll() {
    Object.values(gameState.cards)
        .filter(c => isControlledByMe(c) && c.tapped)
        .forEach(card => tapCard(card.id));
}

// Drag and drop
let dragging = null;
let dragOffset = { x: 0, y: 0 };
let dragStartPos = { x: 0, y: 0 };
let hasDragged = false;

function startDrag(e) {
    if (e.button !== 0) return; // left click only
    e.preventDefault();

    const el = e.target.closest('.card');
    if (!el) return;

    const cardId = el.dataset.cardId;
    const card = gameState.cards[cardId];
    if (!card) return;

    // Only controller can drag
    if (!isControlledByMe(card)) return;

    hideCardPreview();
    dragging = { el, cardId, card };
    dragStartPos = { x: e.clientX, y: e.clientY };
    hasDragged = false;

    const rect = el.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
}

function onDrag(e) {
    if (!dragging) return;

    // Check if we've moved enough to consider it a drag
    const dx = e.clientX - dragStartPos.x;
    const dy = e.clientY - dragStartPos.y;
    if (!hasDragged && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

    hasDragged = true;
    dragging.el.classList.add('dragging');

    // Move to battlefield while dragging
    const battlefieldRect = battlefield.getBoundingClientRect();
    const x = e.clientX - battlefieldRect.left - dragOffset.x;
    const y = e.clientY - battlefieldRect.top - dragOffset.y;

    dragging.el.style.left = x + 'px';
    dragging.el.style.top = y + 'px';

    if (dragging.card.zone !== 'battlefield') {
        dragging.card.zone = 'battlefield';
        dragging.card.face_down = false;
        dragging.el.classList.remove('card-in-hand', 'card-in-zone');
        battlefield.appendChild(dragging.el);
        updateCardFlipped(dragging.cardId);
    }
}

function endDrag(e) {
    if (!dragging) return;

    const { el, cardId, card } = dragging;
    el.classList.remove('dragging');

    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);

    // If we didn't actually drag, just clean up
    if (!hasDragged) {
        dragging = null;
        return;
    }

    // Check what zone we dropped on
    const dropZone = getDropZone(e.clientX, e.clientY);
    const battlefieldRect = battlefield.getBoundingClientRect();

    let x = e.clientX - battlefieldRect.left - dragOffset.x;
    let y = e.clientY - battlefieldRect.top - dragOffset.y;
    let zone = 'battlefield';

    if (dropZone) {
        zone = dropZone.dataset.zone;
        x = 0;
        y = 0;
        if (zone === 'library') {
            card.face_down = true;
            updateCardFlipped(cardId);
        } else {
            card.face_down = false;
            updateCardFlipped(cardId);
        }
    }

    // Normalize coordinates to percentages (0-1) for cross-screen sync
    const normalizedX = zone === 'battlefield' ? x / battlefieldRect.width : 0;
    const normalizedY = zone === 'battlefield' ? y / battlefieldRect.height : 0;

    card.x = normalizedX;
    card.y = normalizedY;
    card.zone = zone;
    updateCardPosition(cardId);

    ws.send(JSON.stringify({ type: 'move_card', card_id: cardId, x: normalizedX, y: normalizedY, zone, face_down: card.face_down }));

    dragging = null;
}

function getDropZone(x, y) {
    const zones = [hand, library, graveyard, exile, command];
    for (const zone of zones) {
        const rect = zone.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return zone;
        }
    }
    return null;
}

// Keyboard shortcuts for modals
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Enter' && e.target.id === 'counter-name-input') {
            confirmAddCounter();
        }
        if (e.key === 'Escape') {
            hideZoneModal();
            hideDeckModal();
            hideCounterModal();
            hideTokenModal();
        }
        return;
    }
    if (e.key === 'Escape') {
        hideZoneModal();
        hideDeckModal();
        hideCounterModal();
        hideTokenModal();
    }
});

// Zone viewer
let currentViewingZone = null;

graveyard.classList.add('clickable');
exile.classList.add('clickable');
library.classList.add('clickable');

graveyard.addEventListener('click', (e) => {
    if (e.target.classList.contains('card')) return;
    showZoneModal('graveyard');
});

exile.addEventListener('click', (e) => {
    if (e.target.classList.contains('card')) return;
    showZoneModal('exile');
});

function showZoneModal(zoneName) {
    currentViewingZone = zoneName;
    const modal = document.getElementById('zone-modal');
    const title = document.getElementById('zone-modal-title');
    const container = document.getElementById('zone-modal-cards');

    title.textContent = zoneName.charAt(0).toUpperCase() + zoneName.slice(1);
    container.innerHTML = '';

    const cards = Object.values(gameState.cards)
        .filter(c => c.zone === zoneName && c.owner === playerId);

    if (cards.length === 0) {
        container.innerHTML = '<div class="zone-empty">No cards</div>';
    } else {
        cards.forEach(card => {
            const wrapper = document.createElement('div');
            wrapper.className = 'zone-card-wrapper';

            const cardEl = document.createElement('div');
            cardEl.className = 'zone-card';
            cardEl.style.backgroundImage = `url(${getDisplayImage(card)})`;
            cardEl.addEventListener('mouseenter', () => showCardPreview(card.id));
            cardEl.addEventListener('mouseleave', hideCardPreview);

            const actions = document.createElement('div');
            actions.className = 'zone-card-actions';

            if (isControlledByMe(card)) {
                const toHand = document.createElement('button');
                toHand.textContent = 'Hand';
                toHand.onclick = () => moveCardFromZone(card.id, 'hand');

                const toBattlefield = document.createElement('button');
                toBattlefield.textContent = 'Play';
                toBattlefield.onclick = () => moveCardFromZone(card.id, 'battlefield');

                actions.appendChild(toHand);
                actions.appendChild(toBattlefield);
            }

            wrapper.appendChild(cardEl);
            wrapper.appendChild(actions);
            container.appendChild(wrapper);
        });
    }

    modal.classList.remove('hidden');
}

function hideZoneModal() {
    document.getElementById('zone-modal').classList.add('hidden');
    currentViewingZone = null;
}

function moveCardFromZone(cardId, targetZone) {
    const card = gameState.cards[cardId];
    if (!card || !isControlledByMe(card)) return;

    const bfRect = battlefield.getBoundingClientRect();
    card.zone = targetZone;
    card.face_down = false;
    // Use normalized coordinates (0-1) for battlefield, 0 for zones
    card.x = targetZone === 'battlefield' ? 100 / bfRect.width : 0;
    card.y = targetZone === 'battlefield' ? (bfRect.height - 150) / bfRect.height : 0;

    updateCardPosition(cardId);
    updateCardFlipped(cardId);

    ws.send(JSON.stringify({
        type: 'move_card',
        card_id: cardId,
        x: card.x,
        y: card.y,
        zone: targetZone,
        face_down: false
    }));

    // Refresh the modal
    if (currentViewingZone) {
        showZoneModal(currentViewingZone);
    }
}

// Context Menu System
const contextMenu = document.getElementById('context-menu');
const contextSearch = document.getElementById('context-search');
const contextActions = document.getElementById('context-actions');
let contextTarget = null; // card id or null for general actions
let selectedActionIndex = 0;

const cardActions = [
    { id: 'tap', label: 'Tap / Untap', shortcut: 'T', card: true, needsControl: true },
    { id: 'flip', label: 'Flip Face Down/Up', shortcut: 'F', card: true, needsControl: true },
    { id: 'transform', label: 'Show Other Side', shortcut: 'R', card: true, needsControl: true, needsDFC: true },
    { id: 'counter', label: 'Add Counter', shortcut: 'C', card: true, needsControl: true },
    { id: 'divider1', divider: true },
    { id: 'hand', label: 'Move to Hand', shortcut: 'H', card: true, needsControl: true },
    { id: 'graveyard', label: 'Move to Graveyard', shortcut: 'G', card: true, needsControl: true },
    { id: 'exile', label: 'Move to Exile', shortcut: 'X', card: true, needsControl: true },
    { id: 'library-top', label: 'Put on Library (Top)', shortcut: '', card: true, needsControl: true },
    { id: 'library-bottom', label: 'Put on Library (Bottom)', shortcut: '', card: true, needsControl: true },
    { id: 'library-shuffle', label: 'Shuffle into Library', shortcut: '', card: true, needsControl: true },
    { id: 'command', label: 'Move to Command Zone', shortcut: '', card: true, needsControl: true },
    { id: 'divider2', divider: true },
    { id: 'clone', label: 'Copy as Token', shortcut: '', card: true, needsControl: true },
    { id: 'take-control', label: 'Take Control', shortcut: '', card: true, needsControl: false },
    { id: 'return-control', label: 'Return to Owner', shortcut: '', card: true, needsControl: true, needsNotOwner: true },
    { id: 'token', label: 'Create Token...', shortcut: 'K', card: false },
    { id: 'divider3', divider: true },
    { id: 'draw', label: 'Draw Card', shortcut: 'D', card: false },
    { id: 'untap-all', label: 'Untap All', shortcut: 'U', card: false },
    { id: 'shuffle', label: 'Shuffle Library', shortcut: 'S', card: false },
];

function showContextMenu(x, y, cardId) {
    contextTarget = cardId;
    contextSearch.value = '';
    selectedActionIndex = 0;
    renderContextActions('');

    // Position menu
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.remove('hidden');

    // Adjust if off screen
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        contextMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }

    contextSearch.focus();
}

function hideContextMenu() {
    contextMenu.classList.add('hidden');
    contextTarget = null;
}

function renderContextActions(filter) {
    contextActions.innerHTML = '';
    const lowerFilter = filter.toLowerCase();

    const card = contextTarget ? gameState.cards[contextTarget] : null;
    const hasCard = contextTarget !== null;
    const iControlIt = card && isControlledByMe(card);
    const iOwnIt = card && card.owner === playerId;

    let visibleIndex = 0;
    cardActions.forEach(action => {
        if (action.divider) {
            if (filter === '') {
                const div = document.createElement('div');
                div.className = 'context-divider';
                contextActions.appendChild(div);
            }
            return;
        }

        // Filter by search
        if (filter && !action.label.toLowerCase().includes(lowerFilter)) {
            return;
        }

        // Check if action should be shown
        const isCardAction = action.card;

        // Skip "Take Control" if we already control the card or no card selected
        if (action.id === 'take-control' && (!hasCard || iControlIt)) {
            return;
        }

        // Skip "Return to Owner" if we don't control it or we own it
        if (action.id === 'return-control' && (!hasCard || !iControlIt || iOwnIt)) {
            return;
        }

        // Skip "Transform" for non-DFC cards
        if (action.needsDFC && (!card || !card.back_image)) {
            return;
        }

        // Determine if action should be disabled
        let isDisabled = false;
        if (isCardAction && !hasCard) {
            isDisabled = true;
        } else if (action.needsControl && !iControlIt) {
            isDisabled = true;
        }

        const el = document.createElement('div');
        el.className = 'context-action';
        if (isDisabled) {
            el.classList.add('disabled');
        }
        if (visibleIndex === selectedActionIndex) {
            el.classList.add('selected');
        }

        el.innerHTML = `
            <span class="label">${action.label}</span>
            ${action.shortcut ? `<span class="shortcut">${action.shortcut}</span>` : ''}
        `;

        if (!isDisabled) {
            el.addEventListener('click', () => executeAction(action.id));
        }
        el.addEventListener('mouseenter', () => {
            selectedActionIndex = visibleIndex;
            updateSelectedAction();
        });

        contextActions.appendChild(el);
        visibleIndex++;
    });
}

function updateSelectedAction() {
    const actions = contextActions.querySelectorAll('.context-action:not(.disabled)');
    actions.forEach((el, i) => {
        el.classList.toggle('selected', i === selectedActionIndex);
    });
}

function executeAction(actionId) {
    const card = contextTarget ? gameState.cards[contextTarget] : null;

    switch (actionId) {
        case 'tap':
            if (card && isControlledByMe(card)) tapCard(contextTarget);
            break;
        case 'flip':
            if (card && isControlledByMe(card)) flipCard(contextTarget);
            break;
        case 'transform':
            if (card && isControlledByMe(card) && card.back_image) transformCard(contextTarget);
            break;
        case 'counter':
            if (card && isControlledByMe(card)) showAddCounterModal(contextTarget);
            break;
        case 'hand':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'hand');
            break;
        case 'graveyard':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'graveyard');
            break;
        case 'exile':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'exile');
            break;
        case 'library-top':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'library', 'top');
            break;
        case 'library-bottom':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'library', 'bottom');
            break;
        case 'library-shuffle':
            if (card && isControlledByMe(card)) {
                moveCardTo(contextTarget, 'library');
                shuffleLibrary();
            }
            break;
        case 'command':
            if (card && isControlledByMe(card)) moveCardTo(contextTarget, 'command');
            break;
        case 'clone':
            if (card && isControlledByMe(card)) cloneCard(contextTarget);
            break;
        case 'take-control':
            if (card && !isControlledByMe(card)) takeControl(contextTarget);
            break;
        case 'return-control':
            if (card && isControlledByMe(card) && card.owner !== playerId) returnControl(contextTarget);
            break;
        case 'token':
            showTokenModal();
            break;
        case 'draw':
            drawCard();
            break;
        case 'untap-all':
            untapAll();
            break;
        case 'shuffle':
            shuffleLibrary();
            break;
    }

    hideContextMenu();
}

function moveCardTo(cardId, zone, position) {
    const card = gameState.cards[cardId];
    if (!card || !isControlledByMe(card)) return;

    const bfRect = battlefield.getBoundingClientRect();
    card.zone = zone;
    card.face_down = zone === 'library'; // Only library is face-down
    // Use normalized coordinates (0-1) for battlefield, 0 for zones
    card.x = zone === 'battlefield' ? 100 / bfRect.width : 0;
    card.y = zone === 'battlefield' ? (bfRect.height - 150) / bfRect.height : 0;

    updateCardPosition(cardId);
    updateCardFlipped(cardId);

    // Handle library position
    if (zone === 'library' && position === 'bottom') {
        const el = cardElements.get(cardId);
        if (el && el.parentElement === library) {
            library.insertBefore(el, library.querySelector('.card-in-zone'));
        }
    }

    ws.send(JSON.stringify({
        type: 'move_card',
        card_id: cardId,
        x: card.x,
        y: card.y,
        zone: zone,
        face_down: card.face_down
    }));
}

function cloneCard(cardId) {
    const card = gameState.cards[cardId];
    if (!card) return;

    // Offset by ~20px in normalized coords
    const bfRect = battlefield.getBoundingClientRect();
    const clone = {
        id: crypto.randomUUID(),
        name: card.name,
        image: card.image,
        back_image: card.back_image,
        transformed: card.transformed,
        x: card.x + 20 / bfRect.width,
        y: card.y + 20 / bfRect.height,
        zone: 'battlefield',
        tapped: false,
        face_down: false,
        token: true
    };

    ws.send(JSON.stringify({ type: 'add_cards', cards: [clone] }));
}

// Control change functions
function takeControl(cardId) {
    const card = gameState.cards[cardId];
    if (!card || isControlledByMe(card)) return;

    // Optimistic update
    card.controller = playerId;
    updateCardControlIndicator(cardId);
    updateCardPosition(cardId);

    ws.send(JSON.stringify({ type: 'change_control', card_id: cardId, new_controller: playerId }));
}

function returnControl(cardId) {
    const card = gameState.cards[cardId];
    if (!card || !isControlledByMe(card) || card.owner === playerId) return;

    // Optimistic update - return to owner
    card.controller = card.owner;
    updateCardControlIndicator(cardId);
    updateCardPosition(cardId);

    ws.send(JSON.stringify({ type: 'change_control', card_id: cardId, new_controller: card.owner }));
}

function updateCardControlIndicator(cardId) {
    const card = gameState.cards[cardId];
    const el = cardElements.get(cardId);
    if (!el || !card) return;

    // Add/remove "stolen" class for cards we control but don't own
    const isStolen = isControlledByMe(card) && card.owner !== playerId;
    el.classList.toggle('controlled-card', isStolen);

    // Add/remove "lost-control" class for cards we own but don't control
    const lostControl = card.owner === playerId && !isControlledByMe(card);
    el.classList.toggle('lost-control', lostControl);
}

// Context menu event handlers
contextSearch.addEventListener('input', (e) => {
    selectedActionIndex = 0;
    renderContextActions(e.target.value);
});

contextSearch.addEventListener('keydown', (e) => {
    const actions = contextActions.querySelectorAll('.context-action:not(.disabled)');

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedActionIndex = Math.min(selectedActionIndex + 1, actions.length - 1);
        updateSelectedAction();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedActionIndex = Math.max(selectedActionIndex - 1, 0);
        updateSelectedAction();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = actions[selectedActionIndex];
        if (selected) selected.click();
    } else if (e.key === 'Escape') {
        hideContextMenu();
    }
});

// Right-click handler for cards and battlefield
document.addEventListener('contextmenu', (e) => {
    // Only in game area
    if (!game.contains(e.target)) return;

    // Check if clicking a card
    const cardEl = e.target.closest('.card');
    const cardId = cardEl ? cardEl.dataset.cardId : null;

    // Always show our context menu for cards (we'll show Take Control for opponent cards)

    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, cardId);
});

// Close context menu on click outside
document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
        hideContextMenu();
    }
});

// Global keyboard shortcuts (when context menu is closed)
document.addEventListener('keydown', (e) => {
    // Skip if in input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }

    // Skip if context menu is open (it handles its own keys)
    if (!contextMenu.classList.contains('hidden')) {
        return;
    }

    const key = e.key.toUpperCase();
    const action = cardActions.find(a => a.shortcut === key);

    if (action) {
        if (action.card) {
            // Card-specific action - use hovered card
            if (hoveredCardId) {
                const card = gameState.cards[hoveredCardId];
                if (card && isControlledByMe(card)) {
                    contextTarget = hoveredCardId;
                    executeAction(action.id);
                    contextTarget = null;
                }
            }
        } else {
            // General action (no card needed)
            executeAction(action.id);
        }
    }
});

// Token Modal
let tokenSearchTimeout = null;

function showTokenModal() {
    document.getElementById('token-modal').classList.remove('hidden');
    document.getElementById('token-search-input').value = '';
    document.getElementById('token-results').innerHTML = '<div class="zone-empty">Search for tokens above</div>';
    document.getElementById('token-status').textContent = '';
    document.getElementById('token-search-input').focus();
}

function hideTokenModal() {
    document.getElementById('token-modal').classList.add('hidden');
}

async function searchTokens(query) {
    if (!query.trim()) {
        document.getElementById('token-results').innerHTML = '<div class="zone-empty">Search for tokens above</div>';
        document.getElementById('token-status').textContent = '';
        return;
    }

    document.getElementById('token-status').textContent = 'Searching...';

    try {
        const r = await fetch(`/api/search?q=${encodeURIComponent('type:token ' + query)}`);
        const data = await r.json();

        const container = document.getElementById('token-results');
        container.innerHTML = '';

        if (data.data && data.data.length > 0) {
            data.data.slice(0, 20).forEach(card => {
                const image = getCardImage(card);
                if (!image) return;

                const el = document.createElement('div');
                el.className = 'token-option';
                el.style.backgroundImage = `url(${image})`;
                el.innerHTML = `<div class="token-name">${esc(card.name)}</div>`;
                el.addEventListener('click', () => createToken(card));
                el.addEventListener('mouseenter', () => {
                    cardPreview.style.backgroundImage = `url(${image})`;
                    cardPreview.classList.remove('hidden');
                });
                el.addEventListener('mouseleave', hideCardPreview);
                container.appendChild(el);
            });
            document.getElementById('token-status').textContent = `Found ${data.data.length} tokens`;
        } else {
            container.innerHTML = '<div class="zone-empty">No tokens found</div>';
            document.getElementById('token-status').textContent = '';
        }
    } catch (err) {
        document.getElementById('token-status').textContent = 'Search failed';
    }
}

function createToken(cardData) {
    const bfRect = battlefield.getBoundingClientRect();
    const token = {
        id: crypto.randomUUID(),
        name: cardData.name,
        image: getCardImage(cardData),
        x: (100 + Math.random() * 100) / bfRect.width,
        y: (bfRect.height - 150) / bfRect.height,
        zone: 'battlefield',
        tapped: false,
        face_down: false,
        token: true
    };

    ws.send(JSON.stringify({ type: 'add_cards', cards: [token] }));
    hideTokenModal();
}

// Token search input handler
document.getElementById('token-search-input').addEventListener('input', (e) => {
    clearTimeout(tokenSearchTimeout);
    tokenSearchTimeout = setTimeout(() => searchTokens(e.target.value), 300);
});

document.getElementById('token-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideTokenModal();
    }
});

// Commander Selection
let selectedCommanders = new Set();

function showCommanderPrompt() {
    command.classList.remove('hidden');
    document.getElementById('commander-prompt').classList.remove('hidden');
}

function hideCommandZone() {
    command.classList.add('hidden');
}

function showCommanderSelect() {
    document.getElementById('commander-prompt').classList.add('hidden');
    selectedCommanders.clear();
    renderCommanderCardList('');
    document.getElementById('commander-modal').classList.remove('hidden');
    document.getElementById('commander-search-input').value = '';
    document.getElementById('commander-search-input').focus();
}

function hideCommanderModal() {
    document.getElementById('commander-modal').classList.add('hidden');
    // Show prompt again if no commanders selected
    if (getMyCommandZoneCards().length === 0) {
        document.getElementById('commander-prompt').classList.remove('hidden');
    }
}

function getMyLibraryCards() {
    return Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.zone === 'library');
}

function getMyCommandZoneCards() {
    return Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.zone === 'command');
}

function renderCommanderCardList(filter) {
    const container = document.getElementById('commander-card-list');
    container.innerHTML = '';

    const cards = getMyLibraryCards();
    const lowerFilter = filter.toLowerCase();

    // Get unique cards by name
    const uniqueCards = new Map();
    cards.forEach(card => {
        if (!uniqueCards.has(card.name)) {
            uniqueCards.set(card.name, card);
        }
    });

    uniqueCards.forEach((card, name) => {
        if (filter && !name.toLowerCase().includes(lowerFilter)) return;

        const el = document.createElement('div');
        el.className = 'commander-card-option';
        if (selectedCommanders.has(card.id)) {
            el.classList.add('selected');
        }
        el.style.backgroundImage = `url(${getDisplayImage(card)})`;
        el.title = name;

        el.addEventListener('click', () => {
            if (selectedCommanders.has(card.id)) {
                selectedCommanders.delete(card.id);
                el.classList.remove('selected');
            } else {
                selectedCommanders.add(card.id);
                el.classList.add('selected');
            }
        });

        el.addEventListener('mouseenter', () => {
            cardPreview.style.backgroundImage = `url(${getDisplayImage(card)})`;
            cardPreview.classList.remove('hidden');
        });
        el.addEventListener('mouseleave', hideCardPreview);

        container.appendChild(el);
    });

    if (container.children.length === 0) {
        container.innerHTML = '<div class="zone-empty">No cards in library</div>';
    }
}

function confirmCommanders() {
    selectedCommanders.forEach(cardId => {
        moveCardTo(cardId, 'command');
    });

    document.getElementById('commander-modal').classList.add('hidden');
    document.getElementById('commander-prompt').classList.add('hidden');

    if (selectedCommanders.size === 0) {
        hideCommandZone();
    }

    selectedCommanders.clear();
}

document.getElementById('commander-search-input').addEventListener('input', (e) => {
    renderCommanderCardList(e.target.value);
});

document.getElementById('commander-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideCommanderModal();
    }
});

// Library Search functionality
let selectedLibraryCard = null;

function openLibrarySearch() {
    selectedLibraryCard = null;
    document.getElementById('library-search-actions').classList.add('hidden');
    document.getElementById('library-search-input').value = '';
    renderLibrarySearchList('');
    document.getElementById('library-search-modal').classList.remove('hidden');
    document.getElementById('library-search-input').focus();
}

function closeLibrarySearch(shouldShuffle) {
    document.getElementById('library-search-modal').classList.add('hidden');
    selectedLibraryCard = null;
    if (shouldShuffle) {
        shuffleLibrary();
    }
}

function renderLibrarySearchList(filter) {
    const container = document.getElementById('library-card-list');
    container.innerHTML = '';

    const cards = getMyLibraryCards();
    const lowerFilter = filter.toLowerCase();

    // Sort cards alphabetically by name
    cards.sort((a, b) => a.name.localeCompare(b.name));

    cards.forEach(card => {
        if (filter && !card.name.toLowerCase().includes(lowerFilter)) return;

        const el = document.createElement('div');
        el.className = 'library-card-option';
        if (selectedLibraryCard === card.id) {
            el.classList.add('selected');
        }
        el.style.backgroundImage = `url(${getDisplayImage(card)})`;
        el.title = card.name;

        el.addEventListener('click', () => {
            // Deselect previous
            container.querySelectorAll('.library-card-option').forEach(opt => opt.classList.remove('selected'));

            selectedLibraryCard = card.id;
            el.classList.add('selected');

            document.getElementById('selected-card-name').textContent = card.name;
            document.getElementById('library-search-actions').classList.remove('hidden');
        });

        el.addEventListener('mouseenter', () => {
            cardPreview.style.backgroundImage = `url(${getDisplayImage(card)})`;
            cardPreview.classList.remove('hidden');
        });
        el.addEventListener('mouseleave', hideCardPreview);

        container.appendChild(el);
    });

    if (container.children.length === 0) {
        container.innerHTML = '<div class="zone-empty">No cards found</div>';
    }
}

function librarySearchMoveTo(destination) {
    if (!selectedLibraryCard) return;

    if (destination === 'hand') {
        moveCardTo(selectedLibraryCard, 'hand');
    } else if (destination === 'battlefield') {
        moveCardTo(selectedLibraryCard, 'battlefield');
    } else if (destination === 'top') {
        moveCardTo(selectedLibraryCard, 'library', 'top');
    } else if (destination === 'bottom') {
        moveCardTo(selectedLibraryCard, 'library', 'bottom');
    }

    // Re-render and clear selection
    selectedLibraryCard = null;
    document.getElementById('library-search-actions').classList.add('hidden');
    renderLibrarySearchList(document.getElementById('library-search-input').value);
}

document.getElementById('library-search-input').addEventListener('input', (e) => {
    renderLibrarySearchList(e.target.value);
});

document.getElementById('library-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLibrarySearch(false);
    }
});

// Click on library to search
library.addEventListener('click', (e) => {
    // Only trigger if clicking the zone itself, not a card
    if (e.target === library || e.target.classList.contains('library-count')) {
        openLibrarySearch();
    }
});

// Chat input
document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
    if (e.key === 'Escape') toggleChatPanel();
});
