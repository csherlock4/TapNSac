import asyncio
import logging
import os
import random
import re
import string
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal, Optional, Union

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

# Logging
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("tapnsac")

# Config
MAX_ROOMS = 500
SCRYFALL_TTL = 24 * 60 * 60          # card data is static; cache a day
SCRYFALL_MIN_INTERVAL = 0.1          # ~10 req/s ceiling to be a polite Scryfall client
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

http: Optional[httpx.AsyncClient] = None

# In-memory storage (rooms are intentionally ephemeral)
rooms = {}  # room_code -> {players: {ws: player_data}, game_state: {...}}

# Scryfall response cache: name/identifier -> (expires_at_monotonic, payload)
_card_cache: dict[str, tuple[float, dict]] = {}
_scryfall_lock = asyncio.Lock()
_scryfall_last = 0.0


@asynccontextmanager
async def lifespan(app):
    global http
    # Scryfall requires a descriptive User-Agent and an Accept header.
    http = httpx.AsyncClient(
        timeout=30,
        headers={
            "User-Agent": "TapNSac/1.0 (+https://www.tapnsac.com)",
            "Accept": "application/json",
        },
    )
    yield
    await http.aclose()


limiter = Limiter(key_func=get_remote_address)
app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


def sanitize_name(name):
    return re.sub(r'[<>&"\']', '', name).strip()[:20] or 'Player'


def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase, k=4))


def make_game_state():
    return {
        "cards": {},
        "players": {},
        "turn_order": [],
        "current_turn_index": 0,
        "starting_life": 20,
        "notes": {}
    }


def controls(state, pid, card_id):
    """True if player `pid` currently controls `card_id` (and it exists)."""
    card = state["cards"].get(card_id)
    return card is not None and card.get("controller") == pid


async def _scryfall_throttle():
    """Space outbound Scryfall calls to stay a polite shared client."""
    global _scryfall_last
    async with _scryfall_lock:
        wait = SCRYFALL_MIN_INTERVAL - (time.monotonic() - _scryfall_last)
        if wait > 0:
            await asyncio.sleep(wait)
        _scryfall_last = time.monotonic()


# ---------------------------------------------------------------------------
# Scryfall proxy (cached + throttled + rate-limited)
# ---------------------------------------------------------------------------
@app.get("/api/card/{name:path}")
@limiter.limit("60/minute")
async def get_card(request: Request, name: str, set: str = None):
    key = f"{name.lower()}|{(set or '').lower()}"
    cached = _card_cache.get(key)
    if cached and time.monotonic() < cached[0]:
        return cached[1]
    try:
        await _scryfall_throttle()
        params = {"exact": name}
        if set:
            params["set"] = set
        r = await http.get("https://api.scryfall.com/cards/named", params=params)
        if r.status_code == 404 and set:
            await _scryfall_throttle()
            r = await http.get("https://api.scryfall.com/cards/named", params={"exact": name})
        if r.status_code == 404:
            await _scryfall_throttle()
            r = await http.get("https://api.scryfall.com/cards/named", params={"fuzzy": name})
        data = r.json()
        if r.status_code == 200:
            _card_cache[key] = (time.monotonic() + SCRYFALL_TTL, data)
        return data
    except Exception as e:
        log.exception("get_card failed for %r", name)
        return {"object": "error", "details": str(e)}


@app.get("/api/search")
@limiter.limit("60/minute")
async def search_cards(request: Request, q: str):
    await _scryfall_throttle()
    r = await http.get("https://api.scryfall.com/cards/search", params={"q": q})
    return r.json()


@app.post("/api/cards/collection")
@limiter.limit("60/minute")
async def get_cards_collection(request: Request):
    identifiers = await request.json()
    if not isinstance(identifiers, list):
        return {"cards": {}}
    identifiers = identifiers[:1000]

    results = {}
    misses = []
    for item in identifiers:
        name = item.get("name", "") if isinstance(item, dict) else ""
        # Scryfall's collection endpoint only matches DFCs by front-face name.
        front = name.split(" // ")[0]
        cached = _card_cache.get(front.lower())
        if cached and time.monotonic() < cached[0]:
            card = cached[1]
            cname = card["name"].lower()
            results[cname] = card
            if " // " in cname:
                results[cname.split(" // ")[0]] = card
        elif front:
            misses.append(front)

    for i in range(0, len(misses), 75):
        batch = misses[i:i + 75]
        await _scryfall_throttle()
        r = await http.post(
            "https://api.scryfall.com/cards/collection",
            json={"identifiers": [{"name": n} for n in batch]},
        )
        data = r.json()
        for card in data.get("data", []):
            cname = card["name"].lower()
            expiry = time.monotonic() + SCRYFALL_TTL
            results[cname] = card
            _card_cache[cname] = (expiry, card)
            if " // " in cname:
                front = cname.split(" // ")[0]
                results[front] = card
                _card_cache[front] = (expiry, card)
    return {"cards": results}


# ---------------------------------------------------------------------------
# Room management
# ---------------------------------------------------------------------------
@app.post("/api/room/create")
@limiter.limit("20/minute")
async def create_room(request: Request):
    if len(rooms) >= MAX_ROOMS:
        raise HTTPException(status_code=503, detail="Server is at capacity, try again later.")
    try:
        body = await request.json()
        starting_life = int(body.get("starting_life", 20))
    except Exception:
        starting_life = 20
    starting_life = max(1, min(starting_life, 999))
    code = generate_room_code()
    while code in rooms:
        code = generate_room_code()
    state = make_game_state()
    state["starting_life"] = starting_life
    rooms[code] = {"players": {}, "game_state": state}
    log.info("room %s created (starting_life=%s)", code, starting_life)
    return {"code": code}


@app.get("/api/room/{code}/exists")
async def room_exists(code: str):
    return {"exists": code.upper() in rooms}


@app.get("/health")
async def health():
    return {"status": "ok", "rooms": len(rooms)}


# ---------------------------------------------------------------------------
# WebSocket message schema (validated before dispatch)
# ---------------------------------------------------------------------------
Zone = Literal["battlefield", "hand", "library", "graveyard", "exile", "command"]


class _Msg(BaseModel):
    # extra="allow" preserves any forward-compat fields a client sends so they
    # survive model_dump() and reach the handlers unchanged.
    model_config = ConfigDict(extra="allow")


class CardModel(_Msg):
    id: str = Field(max_length=64)
    name: str = Field(default="", max_length=200)


class NoteModel(_Msg):
    id: str = Field(max_length=64)
    text: str = Field(default="", max_length=500)
    x: float = 0
    y: float = 0


class _CardAction(_Msg):
    card_id: str = Field(max_length=64)


class AddCards(_Msg):
    type: Literal["add_cards"]
    cards: list[CardModel] = Field(max_length=250)


class MoveCard(_Msg):
    type: Literal["move_card"]
    card_id: str = Field(max_length=64)
    x: float
    y: float
    zone: Optional[Zone] = None
    face_down: Optional[bool] = None


class TapCard(_CardAction):
    type: Literal["tap_card"]


class FlipCard(_CardAction):
    type: Literal["flip_card"]


class TransformCard(_CardAction):
    type: Literal["transform_card"]


class ShuffleLibrary(_Msg):
    type: Literal["shuffle_library"]


class SetLife(_Msg):
    type: Literal["set_life"]
    life: int = Field(ge=-9999, le=9999)


class SetPlayerCounter(_Msg):
    type: Literal["set_player_counter"]
    name: str = Field(max_length=40)
    value: int = Field(ge=-9999, le=9999)


class SetCardCounter(_Msg):
    type: Literal["set_card_counter"]
    card_id: str = Field(max_length=64)
    name: str = Field(max_length=40)
    value: int = Field(ge=-9999, le=9999)


class ChangeControl(_Msg):
    type: Literal["change_control"]
    card_id: str = Field(max_length=64)
    new_controller: str = Field(max_length=64)


class PassTurn(_Msg):
    type: Literal["pass_turn"]


class SetCommanderDamage(_Msg):
    type: Literal["set_commander_damage"]
    target_player_id: str = Field(max_length=64)
    source_player_id: str = Field(max_length=64)
    amount: int = Field(ge=0, le=999)


class Chat(_Msg):
    type: Literal["chat"]
    text: str = Field(max_length=200)


class AddNote(_Msg):
    type: Literal["add_note"]
    note: NoteModel


class MoveNote(_Msg):
    type: Literal["move_note"]
    note_id: str = Field(max_length=64)
    x: float
    y: float


class UpdateNote(_Msg):
    type: Literal["update_note"]
    note_id: str = Field(max_length=64)
    text: str = Field(max_length=500)


class DeleteNote(_Msg):
    type: Literal["delete_note"]
    note_id: str = Field(max_length=64)


Incoming = Annotated[
    Union[
        AddCards, MoveCard, TapCard, FlipCard, TransformCard, ShuffleLibrary,
        SetLife, SetPlayerCounter, SetCardCounter, ChangeControl, PassTurn,
        SetCommanderDamage, Chat, AddNote, MoveNote, UpdateNote, DeleteNote,
    ],
    Field(discriminator="type"),
]
MSG_ADAPTER = TypeAdapter(Incoming)


# ---------------------------------------------------------------------------
# WebSocket for game sync
# ---------------------------------------------------------------------------
@app.websocket("/ws/{room_code}/{player_name}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, player_name: str):
    player_name = sanitize_name(player_name)
    room_code = room_code.upper()

    await websocket.accept()

    # Create room if it doesn't exist (bounded to protect memory)
    if room_code not in rooms:
        if len(rooms) >= MAX_ROOMS:
            await websocket.close(code=1013)  # try again later
            return
        rooms[room_code] = {"players": {}, "game_state": make_game_state()}

    room = rooms[room_code]

    player_id = ''.join(random.choices(string.ascii_lowercase, k=8))
    room["players"][websocket] = {"id": player_id, "name": player_name}
    room["game_state"]["players"][player_id] = {
        "name": player_name,
        "deck_loaded": False,
        "life": room["game_state"]["starting_life"],
        "counters": {},
        "commander_damage": {}
    }
    room["game_state"]["turn_order"].append(player_id)
    log.info("player %s (%s) joined room %s", player_name, player_id, room_code)

    # Send current state to new player
    await websocket.send_json({
        "type": "init",
        "player_id": player_id,
        "state": room["game_state"]
    })

    # Notify others
    await broadcast(room, {
        "type": "player_joined",
        "player_id": player_id,
        "name": player_name,
        "life": room["game_state"]["starting_life"],
        "turn_order": room["game_state"]["turn_order"]
    }, exclude=websocket)

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except (ValueError, TypeError):
                continue  # malformed frame — ignore, keep the socket alive
            if not isinstance(data, dict):
                continue
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            try:
                msg = MSG_ADAPTER.validate_python(data)
            except ValidationError:
                continue  # invalid/out-of-bounds payload — drop it
            await handle_message(room, websocket, msg.model_dump(exclude_unset=True))
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("WebSocket error in room %s", room_code)
    finally:
        if websocket in room["players"]:
            del room["players"][websocket]
        if player_id in room["game_state"]["players"]:
            del room["game_state"]["players"][player_id]
        turn_order = room["game_state"]["turn_order"]
        if player_id in turn_order:
            turn_order.remove(player_id)
            if turn_order and room["game_state"]["current_turn_index"] >= len(turn_order):
                room["game_state"]["current_turn_index"] = 0
        await broadcast(room, {
            "type": "player_left",
            "player_id": player_id,
            "turn_order": list(turn_order),
            "current_turn_index": room["game_state"]["current_turn_index"]
        })
        log.info("player %s left room %s", player_id, room_code)
        if not room["players"] and room_code in rooms:
            del rooms[room_code]
            log.info("room %s emptied and removed", room_code)


async def broadcast(room, message, exclude=None):
    for ws in room["players"]:
        if ws != exclude:
            try:
                await ws.send_json(message)
            except Exception:
                pass


async def handle_message(room, websocket, data):
    msg_type = data.get("type")
    state = room["game_state"]
    player = room["players"][websocket]
    pid = player["id"]

    if msg_type == "add_cards":
        # Player loaded a deck
        for card in data["cards"]:
            card["owner"] = pid
            card["controller"] = pid  # Controller starts as owner
            state["cards"][card["id"]] = card
        state["players"][pid]["deck_loaded"] = True
        await broadcast(room, {"type": "cards_added", "cards": data["cards"]})

    elif msg_type == "move_card":
        card_id = data["card_id"]
        if controls(state, pid, card_id):
            card = state["cards"][card_id]
            new_zone = data.get("zone")
            # Tokens cease to exist when leaving the battlefield (CR 111.7)
            if card.get("token") and new_zone and new_zone != "battlefield":
                name = card.get("name", "Token")
                del state["cards"][card_id]
                await broadcast(room, {"type": "card_removed", "card_id": card_id, "card_name": name})
                return
            card["x"] = data["x"]
            card["y"] = data["y"]
            if "zone" in data:
                card["zone"] = data["zone"]
            if "face_down" in data:
                card["face_down"] = data["face_down"]
            await broadcast(room, {
                "type": "card_moved",
                "card_id": card_id,
                "x": data["x"],
                "y": data["y"],
                "zone": data.get("zone"),
                "face_down": data.get("face_down")
            }, exclude=websocket)

    elif msg_type == "tap_card":
        card_id = data["card_id"]
        if controls(state, pid, card_id):
            state["cards"][card_id]["tapped"] = not state["cards"][card_id].get("tapped", False)
            await broadcast(room, {"type": "card_tapped", "card_id": card_id, "tapped": state["cards"][card_id]["tapped"]}, exclude=websocket)

    elif msg_type == "flip_card":
        card_id = data["card_id"]
        if controls(state, pid, card_id):
            state["cards"][card_id]["face_down"] = not state["cards"][card_id].get("face_down", False)
            await broadcast(room, {"type": "card_flipped", "card_id": card_id, "face_down": state["cards"][card_id]["face_down"]}, exclude=websocket)

    elif msg_type == "transform_card":
        card_id = data["card_id"]
        if controls(state, pid, card_id):
            state["cards"][card_id]["transformed"] = not state["cards"][card_id].get("transformed", False)
            await broadcast(room, {"type": "card_transformed", "card_id": card_id, "transformed": state["cards"][card_id]["transformed"]}, exclude=websocket)

    elif msg_type == "shuffle_library":
        # Just notify others, actual shuffle happens client-side
        await broadcast(room, {"type": "player_shuffled", "player_id": pid}, exclude=websocket)

    elif msg_type == "set_life":
        life = data["life"]
        state["players"][pid]["life"] = life
        await broadcast(room, {"type": "life_changed", "player_id": pid, "life": life})

    elif msg_type == "set_player_counter":
        name = data["name"]
        value = data["value"]
        if value <= 0:
            state["players"][pid]["counters"].pop(name, None)
        else:
            state["players"][pid]["counters"][name] = value
        await broadcast(room, {
            "type": "player_counter_changed",
            "player_id": pid,
            "counters": state["players"][pid]["counters"]
        })

    elif msg_type == "set_card_counter":
        card_id = data["card_id"]
        name = data["name"]
        value = data["value"]
        if controls(state, pid, card_id):
            if "counters" not in state["cards"][card_id]:
                state["cards"][card_id]["counters"] = {}
            if value <= 0:
                state["cards"][card_id]["counters"].pop(name, None)
            else:
                state["cards"][card_id]["counters"][name] = value
            await broadcast(room, {
                "type": "card_counter_changed",
                "card_id": card_id,
                "counters": state["cards"][card_id]["counters"]
            })

    elif msg_type == "change_control":
        card_id = data["card_id"]
        new_controller = data["new_controller"]
        # Only allow taking control yourself, or returning a card you control.
        if (card_id in state["cards"] and new_controller in state["players"]
                and (new_controller == pid or controls(state, pid, card_id))):
            state["cards"][card_id]["controller"] = new_controller
            await broadcast(room, {
                "type": "control_changed",
                "card_id": card_id,
                "new_controller": new_controller,
                "owner": state["cards"][card_id]["owner"]
            })

    elif msg_type == "pass_turn":
        if state["turn_order"]:
            new_idx = (state["current_turn_index"] + 1) % len(state["turn_order"])
            state["current_turn_index"] = new_idx
            active = state["turn_order"][new_idx]
            await broadcast(room, {
                "type": "turn_changed",
                "active_player_id": active,
                "current_turn_index": new_idx
            })

    elif msg_type == "set_commander_damage":
        target_id = data.get("target_player_id")
        source_id = data.get("source_player_id")
        amount = max(0, int(data.get("amount", 0)))
        if target_id in state["players"] and source_id in state["players"]:
            if "commander_damage" not in state["players"][target_id]:
                state["players"][target_id]["commander_damage"] = {}
            state["players"][target_id]["commander_damage"][source_id] = amount
            await broadcast(room, {
                "type": "commander_damage_changed",
                "target_player_id": target_id,
                "source_player_id": source_id,
                "amount": amount
            })

    elif msg_type == "chat":
        text = str(data.get("text", "")).strip()[:200]
        if text:
            await broadcast(room, {
                "type": "chat",
                "player_id": pid,
                "player_name": player["name"],
                "text": text
            })

    elif msg_type == "add_note":
        note = data.get("note") or {}
        nid = note.get("id")
        if nid:
            note["author_id"] = pid
            note["text"] = str(note.get("text", ""))[:500]
            state["notes"][nid] = note
            await broadcast(room, {"type": "note_added", "note": note})

    elif msg_type == "move_note":
        nid = data.get("note_id")
        if nid in state["notes"]:
            state["notes"][nid]["x"] = data["x"]
            state["notes"][nid]["y"] = data["y"]
            await broadcast(room, {
                "type": "note_moved",
                "note_id": nid,
                "x": data["x"],
                "y": data["y"]
            }, exclude=websocket)

    elif msg_type == "update_note":
        nid = data.get("note_id")
        if nid in state["notes"]:
            state["notes"][nid]["text"] = str(data.get("text", ""))[:500]
            await broadcast(room, {
                "type": "note_updated",
                "note_id": nid,
                "text": state["notes"][nid]["text"]
            }, exclude=websocket)

    elif msg_type == "delete_note":
        nid = data.get("note_id")
        if nid in state["notes"]:
            del state["notes"][nid]
            await broadcast(room, {"type": "note_deleted", "note_id": nid})


# Serve frontend (must remain the LAST route so /api, /ws, /health resolve first)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
