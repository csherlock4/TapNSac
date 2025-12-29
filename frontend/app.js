// State
let ws = null;
let playerId = null;
let roomCode = null;
let gameState = { cards: {}, players: {} };
const cardElements = new Map(); // Store card elements so we can find them even when not in DOM

// DOM refs
const lobby = document.getElementById('lobby');
const game = document.getElementById('game');
const battlefield = document.getElementById('battlefield');
const hand = document.getElementById('hand');
const library = document.getElementById('library');
const graveyard = document.getElementById('graveyard');
const exile = document.getElementById('exile');

// Lobby functions
async function createRoom() {
    const r = await fetch('/api/room/create', { method: 'POST' });
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
        case 'init':
            playerId = msg.player_id;
            gameState = msg.state;
            renderAllCards();
            updatePlayerCount();
            break;

        case 'player_joined':
            gameState.players[msg.player_id] = { name: msg.name, deck_loaded: false };
            updatePlayerCount();
            break;

        case 'player_left':
            delete gameState.players[msg.player_id];
            updatePlayerCount();
            // Remove their cards? or leave them? leaving for now
            break;

        case 'cards_added':
            msg.cards.forEach(card => {
                gameState.cards[card.id] = card;
                renderCard(card);
            });
            renderOpponents();
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
                renderOpponents();
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

        case 'player_shuffled':
            // Could show a notification
            break;
    }
}

function updatePlayerCount() {
    const count = Object.keys(gameState.players).length;
    document.getElementById('players-display').textContent = `Players: ${count}`;
    renderOpponents();
}

function renderOpponents() {
    const container = document.getElementById('opponent-battlefields');
    container.innerHTML = '';

    Object.entries(gameState.players).forEach(([pid, player]) => {
        if (pid === playerId) return;

        const handCount = Object.values(gameState.cards)
            .filter(c => c.owner === pid && c.zone === 'hand').length;
        const libraryCount = Object.values(gameState.cards)
            .filter(c => c.owner === pid && c.zone === 'library').length;

        const el = document.createElement('div');
        el.className = 'opponent-info';
        el.innerHTML = `
            <span class="name">${player.name}</span>
            <span class="stats">Hand: ${handCount} | Library: ${libraryCount}</span>
        `;
        container.appendChild(el);
    });
}

// Deck loading
function showDeckModal() {
    document.getElementById('deck-modal').classList.remove('hidden');
}

function hideDeckModal() {
    document.getElementById('deck-modal').classList.add('hidden');
}

async function loadDeck() {
    const input = document.getElementById('deck-input').value;
    const status = document.getElementById('load-status');
    const lines = input.trim().split('\n').filter(l => l.trim() && !l.startsWith('//'));

    status.textContent = 'Loading cards...';
    const cards = [];

    for (const line of lines) {
        const parsed = parseDeckLine(line);
        if (!parsed) continue;

        status.textContent = `Loading: ${parsed.name}...`;
        const cardData = await fetchCard(parsed.name, parsed.set);

        if (cardData && !cardData.error) {
            for (let i = 0; i < parsed.qty; i++) {
                cards.push({
                    id: crypto.randomUUID(),
                    name: cardData.name,
                    image: getCardImage(cardData),
                    x: 0,
                    y: 0,
                    zone: 'library',
                    tapped: false,
                    face_down: true
                });
            }
        } else {
            console.warn(`Card not found: ${parsed.name}`);
        }
    }

    if (cards.length > 0) {
        // Shuffle before adding
        shuffle(cards);
        ws.send(JSON.stringify({ type: 'add_cards', cards }));
        status.textContent = `Loaded ${cards.length} cards!`;
        setTimeout(hideDeckModal, 1000);
    } else {
        status.textContent = 'No cards loaded. Check your deck list format.';
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

    return { qty, name, set };
}

async function fetchCard(name, set) {
    let url = `/api/card/${encodeURIComponent(name)}`;
    if (set) url += `?set=${set}`;
    const r = await fetch(url);
    return r.json();
}

function getCardImage(card) {
    if (card.image_uris) {
        return card.image_uris.normal || card.image_uris.small;
    }
    if (card.card_faces && card.card_faces[0].image_uris) {
        return card.card_faces[0].image_uris.normal;
    }
    return '';
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
        el.style.backgroundImage = `url(${card.image})`;
        el.dataset.cardId = card.id;
        cardElements.set(card.id, el);

        // Drag handling
        el.addEventListener('mousedown', startDrag);
        el.addEventListener('dblclick', () => tapCard(card.id));
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            flipCard(card.id);
        });
    }

    updateCardPosition(card.id, el);
    updateCardTapped(card.id, el);
    updateCardFlipped(card.id, el);
}

function updateCardPosition(cardId, el) {
    const card = gameState.cards[cardId];
    el = el || cardElements.get(cardId);
    if (!el || !card) return;

    // Remove from current parent
    el.remove();

    const zone = card.zone;
    const isOwn = card.owner === playerId;

    if (zone === 'battlefield') {
        el.style.left = card.x + 'px';
        el.style.top = card.y + 'px';
        el.classList.remove('card-in-hand', 'card-in-zone');
        battlefield.appendChild(el);
    } else if (zone === 'hand') {
        el.style.left = '';
        el.style.top = '';
        el.classList.add('card-in-hand');
        el.classList.remove('card-in-zone');
        if (isOwn) {
            hand.appendChild(el);
        }
        // opponent hands handled separately
    } else if (zone === 'library') {
        el.style.left = '';
        el.style.top = '';
        el.classList.add('card-in-zone');
        el.classList.remove('card-in-hand');
        if (isOwn) {
            library.appendChild(el);
        }
    } else if (zone === 'graveyard') {
        el.style.left = '';
        el.style.top = '';
        el.classList.add('card-in-zone');
        el.classList.remove('card-in-hand');
        graveyard.appendChild(el);
    } else if (zone === 'exile') {
        el.style.left = '';
        el.style.top = '';
        el.classList.add('card-in-zone');
        el.classList.remove('card-in-hand');
        exile.appendChild(el);
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

function shuffleLibrary() {
    const myLibraryCards = Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.zone === 'library');
    shuffle(myLibraryCards);
    // Re-render order
    myLibraryCards.forEach(card => {
        const el = cardElements.get(card.id);
        if (el) library.appendChild(el);
    });
    ws.send(JSON.stringify({ type: 'shuffle_library' }));
}

function drawCard() {
    const myLibrary = Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.zone === 'library');
    if (myLibrary.length === 0) return;

    // Draw the "top" card (last in library zone)
    const topCard = myLibrary[myLibrary.length - 1];
    topCard.zone = 'hand';
    topCard.face_down = false;
    updateCardPosition(topCard.id);
    updateCardFlipped(topCard.id);

    ws.send(JSON.stringify({ type: 'move_card', card_id: topCard.id, x: 0, y: 0, zone: 'hand', face_down: false }));
}

function untapAll() {
    Object.values(gameState.cards)
        .filter(c => c.owner === playerId && c.tapped)
        .forEach(card => tapCard(card.id));
}

// Drag and drop
let dragging = null;
let dragOffset = { x: 0, y: 0 };

function startDrag(e) {
    if (e.button !== 0) return; // left click only
    const el = e.target;
    const cardId = el.dataset.cardId;
    const card = gameState.cards[cardId];

    // Only owner can drag
    if (card.owner !== playerId) return;

    dragging = { el, cardId, card };
    el.classList.add('dragging');

    const rect = el.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
}

function onDrag(e) {
    if (!dragging) return;

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

    card.x = x;
    card.y = y;
    card.zone = zone;
    updateCardPosition(cardId);

    ws.send(JSON.stringify({ type: 'move_card', card_id: cardId, x, y, zone, face_down: card.face_down }));

    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
    dragging = null;
}

function getDropZone(x, y) {
    const zones = [hand, library, graveyard, exile];
    for (const zone of zones) {
        const rect = zone.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return zone;
        }
    }
    return null;
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') {
        drawCard();
    }
    if (e.key === 'u' || e.key === 'U') {
        untapAll();
    }
});
