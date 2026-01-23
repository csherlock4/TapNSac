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
        "cards": {},  # card_id -> {id, name, image, x, y, zone, tapped, face_down, owner, controller}
        "players": {}  # player_id -> {name, deck_loaded}
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
        r = await http.post(
            "https://api.scryfall.com/cards/collection",
            json={"identifiers": batch}
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
async def create_room():
    code = generate_room_code()
    while code in rooms:
        code = generate_room_code()
    rooms[code] = {"players": {}, "game_state": make_game_state()}
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
    room["game_state"]["players"][player_id] = {"name": player_name, "deck_loaded": False, "life": 20, "counters": {}}

    # Send current state to new player
    await websocket.send_json({
        "type": "init",
        "player_id": player_id,
        "state": room["game_state"]
    })

    # Notify others
    await broadcast(room, {"type": "player_joined", "player_id": player_id, "name": player_name}, exclude=websocket)

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
        await broadcast(room, {"type": "player_left", "player_id": player_id})

        # Clean up empty rooms
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
            state["cards"][card_id]["x"] = data["x"]
            state["cards"][card_id]["y"] = data["y"]
            if "zone" in data:
                state["cards"][card_id]["zone"] = data["zone"]
            if "face_down" in data:
                state["cards"][card_id]["face_down"] = data["face_down"]
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

# Serve frontend
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
