from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import httpx
import json
import random
import string
import re

http = None

@asynccontextmanager
async def lifespan(app):
    global http
    http = httpx.AsyncClient(timeout=30)
    yield
    await http.aclose()

app = FastAPI(lifespan=lifespan)

# In-memory storage
rooms = {}  # room_code -> {players: {ws: player_data}, game_state: {...}}

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

# Scryfall proxy
@app.get("/api/card/{name:path}")
async def get_card(name: str, set: str = None):
    try:
        params = {"exact": name}
        if set:
            params["set"] = set
        r = await http.get("https://api.scryfall.com/cards/named", params=params)
        if r.status_code == 404 and set:
            r = await http.get("https://api.scryfall.com/cards/named", params={"exact": name})
        if r.status_code == 404:
            r = await http.get("https://api.scryfall.com/cards/named", params={"fuzzy": name})
        return r.json()
    except Exception as e:
        return {"object": "error", "details": str(e)}

@app.get("/api/search")
async def search_cards(q: str):
    r = await http.get("https://api.scryfall.com/cards/search", params={"q": q})
    return r.json()

@app.post("/api/cards/collection")
async def get_cards_collection(request: Request):
    identifiers = await request.json()
    results = {}
    for i in range(0, len(identifiers), 75):
        batch = identifiers[i:i+75]
        # Scryfall collection endpoint only matches DFCs by front-face name
        normalized = [
            {"name": item["name"].split(" // ")[0]} if " // " in item.get("name", "") else item
            for item in batch
        ]
        r = await http.post(
            "https://api.scryfall.com/cards/collection",
            json={"identifiers": normalized}
        )
        data = r.json()
        for card in data.get("data", []):
            name = card["name"].lower()
            results[name] = card
            if " // " in name:
                results[name.split(" // ")[0]] = card
    return {"cards": results}

# Room management
@app.post("/api/room/create")
async def create_room(request: Request):
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
    return {"code": code}

@app.get("/api/room/{code}/exists")
async def room_exists(code: str):
    return {"exists": code.upper() in rooms}

# WebSocket for game sync
@app.websocket("/ws/{room_code}/{player_name}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, player_name: str):
    player_name = sanitize_name(player_name)
    room_code = room_code.upper()

    # Create room if doesn't exist
    if room_code not in rooms:
        rooms[room_code] = {"players": {}, "game_state": make_game_state()}

    room = rooms[room_code]
    await websocket.accept()

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
            data = await websocket.receive_json()
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
            else:
                await handle_message(room, websocket, data)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
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
        if not room["players"] and room_code in rooms:
            del rooms[room_code]

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

    if msg_type == "add_cards":
        # Player loaded a deck
        for card in data["cards"]:
            card["owner"] = player["id"]
            card["controller"] = player["id"]  # Controller starts as owner
            state["cards"][card["id"]] = card
        state["players"][player["id"]]["deck_loaded"] = True
        await broadcast(room, {"type": "cards_added", "cards": data["cards"]})

    elif msg_type == "move_card":
        card_id = data["card_id"]
        if card_id in state["cards"]:
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
        if card_id in state["cards"]:
            state["cards"][card_id]["tapped"] = not state["cards"][card_id].get("tapped", False)
            await broadcast(room, {"type": "card_tapped", "card_id": card_id, "tapped": state["cards"][card_id]["tapped"]}, exclude=websocket)

    elif msg_type == "flip_card":
        card_id = data["card_id"]
        if card_id in state["cards"]:
            state["cards"][card_id]["face_down"] = not state["cards"][card_id].get("face_down", False)
            await broadcast(room, {"type": "card_flipped", "card_id": card_id, "face_down": state["cards"][card_id]["face_down"]}, exclude=websocket)

    elif msg_type == "transform_card":
        card_id = data["card_id"]
        if card_id in state["cards"]:
            state["cards"][card_id]["transformed"] = not state["cards"][card_id].get("transformed", False)
            await broadcast(room, {"type": "card_transformed", "card_id": card_id, "transformed": state["cards"][card_id]["transformed"]}, exclude=websocket)

    elif msg_type == "shuffle_library":
        # Just notify others, actual shuffle happens client-side
        await broadcast(room, {"type": "player_shuffled", "player_id": player["id"]}, exclude=websocket)

    elif msg_type == "set_life":
        life = data["life"]
        state["players"][player["id"]]["life"] = life
        await broadcast(room, {"type": "life_changed", "player_id": player["id"], "life": life})

    elif msg_type == "set_player_counter":
        name = data["name"]
        value = data["value"]
        if value <= 0:
            state["players"][player["id"]]["counters"].pop(name, None)
        else:
            state["players"][player["id"]]["counters"][name] = value
        await broadcast(room, {
            "type": "player_counter_changed",
            "player_id": player["id"],
            "counters": state["players"][player["id"]]["counters"]
        })

    elif msg_type == "set_card_counter":
        card_id = data["card_id"]
        name = data["name"]
        value = data["value"]
        if card_id in state["cards"]:
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
        if card_id in state["cards"]:
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
        if target_id in state["players"]:
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
                "player_id": player["id"],
                "player_name": player["name"],
                "text": text
            })

    elif msg_type == "add_note":
        note = data.get("note") or {}
        nid = note.get("id")
        if nid:
            note["author_id"] = player["id"]
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

# Serve frontend
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
