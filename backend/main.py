from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import httpx
import json
import random
import string

app = FastAPI()

# In-memory storage
rooms = {}  # room_code -> {players: {ws: player_data}, game_state: {...}}

def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase, k=4))

def make_game_state():
    return {
        "cards": {},  # card_id -> {id, name, image, x, y, zone, tapped, face_down, owner}
        "players": {}  # player_id -> {name, deck_loaded}
    }

# Scryfall proxy
@app.get("/api/card/{name:path}")
async def get_card(name: str, set: str = None):
    async with httpx.AsyncClient() as client:
        url = f"https://api.scryfall.com/cards/named?exact={name}"
        if set:
            url += f"&set={set}"
        r = await client.get(url)
        if r.status_code == 404 and set:
            # retry without set
            r = await client.get(f"https://api.scryfall.com/cards/named?exact={name}")
        return r.json()

@app.get("/api/search")
async def search_cards(q: str):
    async with httpx.AsyncClient() as client:
        r = await client.get(f"https://api.scryfall.com/cards/search?q={q}")
        return r.json()

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
    room_code = room_code.upper()

    # Create room if doesn't exist
    if room_code not in rooms:
        rooms[room_code] = {"players": {}, "game_state": make_game_state()}

    room = rooms[room_code]
    await websocket.accept()

    player_id = ''.join(random.choices(string.ascii_lowercase, k=8))
    room["players"][websocket] = {"id": player_id, "name": player_name}
    room["game_state"]["players"][player_id] = {"name": player_name, "deck_loaded": False}

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
            await handle_message(room, websocket, data)
    except WebSocketDisconnect:
        del room["players"][websocket]
        if player_id in room["game_state"]["players"]:
            del room["game_state"]["players"][player_id]
        await broadcast(room, {"type": "player_left", "player_id": player_id})

        # Clean up empty rooms
        if not room["players"]:
            del rooms[room_code]

async def broadcast(room, message, exclude=None):
    for ws in room["players"]:
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                pass

async def handle_message(room, websocket, data):
    msg_type = data.get("type")
    state = room["game_state"]
    player = room["players"][websocket]

    if msg_type == "add_cards":
        # Player loaded a deck
        for card in data["cards"]:
            card["owner"] = player["id"]
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
            await broadcast(room, {"type": "card_tapped", "card_id": card_id, "tapped": state["cards"][card_id]["tapped"]})

    elif msg_type == "flip_card":
        card_id = data["card_id"]
        if card_id in state["cards"]:
            state["cards"][card_id]["face_down"] = not state["cards"][card_id].get("face_down", False)
            await broadcast(room, {"type": "card_flipped", "card_id": card_id, "face_down": state["cards"][card_id]["face_down"]})

    elif msg_type == "shuffle_library":
        # Just notify others, actual shuffle happens client-side
        await broadcast(room, {"type": "player_shuffled", "player_id": player["id"]}, exclude=websocket)

    elif msg_type == "draw_card":
        await broadcast(room, {"type": "card_drawn", "card_id": data["card_id"], "player_id": player["id"]})

# Serve frontend
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
