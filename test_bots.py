"""
test_bots.py — Connects 3 bot players with real cards to a TapNSac room.

Usage:
    python test_bots.py ABCD          # join room ABCD
    python test_bots.py               # prompts for room code
    python test_bots.py --create      # creates a new room and prints the code

Each bot loads a Commander deck, sets a commander, and plays a few permanents
onto the battlefield so the UI has real card art to display. Ctrl+C to quit.
"""

import asyncio
import json
import random
import sys
import uuid
import urllib.request
import urllib.parse

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

BASE = "http://127.0.0.1:8000"
WS_BASE = "ws://127.0.0.1:8000"

# Each bot: name, starting life, commander, and battlefield/hand cards
BOTS = [
    {
        "name": "Aragorn",
        "life": 40,
        "commander": "Atraxa, Praetors' Voice",
        "battlefield": ["Sol Ring", "Command Tower", "Arcane Signet", "Rhystic Study"],
        "hand": ["Counterspell", "Swords to Plowshares", "Wrath of God"],
        "library": ["Brainstorm", "Cyclonic Rift", "Swan Song", "Ponder",
                    "Island", "Island", "Island", "Plains", "Plains",
                    "Swamp", "Forest", "Avacyn, Angel of Hope"],
    },
    {
        "name": "Saskia",
        "life": 40,
        "commander": "Krenko, Mob Boss",
        "battlefield": ["Sol Ring", "Mana Crypt", "Goblin Guide", "Lightning Greaves"],
        "hand": ["Lightning Bolt", "Blasphemous Act", "Purphoros, God of the Forge"],
        "library": ["Mountain", "Mountain", "Mountain", "Mountain", "Mogg Fanatic",
                    "Goblin Matron", "Goblin Recruiter", "Goblin Chieftain",
                    "Shared Animosity", "Empty the Warrens", "Goblin War Strike"],
    },
    {
        "name": "Thrasios",
        "life": 40,
        "commander": "Muldrotha, the Gravetide",
        "battlefield": ["Sol Ring", "Fabled Passage", "Sylvan Library", "Eternal Witness"],
        "hand": ["Demonic Tutor", "Kodama's Reach", "Assassin's Trophy"],
        "library": ["Forest", "Forest", "Forest", "Island", "Swamp",
                    "Cultivate", "Yavimaya Elder", "Mulch", "Frantic Search",
                    "Life from the Loam", "Constant Mists", "Mystic Remora"],
    },
]


def http_get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read())


def http_post(url, body=b"{}"):
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def create_room():
    return http_post(f"{BASE}/api/room/create")["code"]


def fetch_card(name):
    encoded = urllib.parse.quote(name, safe="")
    try:
        return http_get(f"{BASE}/api/card/{encoded}")
    except Exception as e:
        print(f"    warn: could not fetch '{name}': {e}")
        return None


def card_images(data):
    if not data or data.get("object") == "error":
        return None, None
    if "image_uris" in data:
        img = data["image_uris"].get("normal") or data["image_uris"].get("small", "")
        return img, None
    faces = data.get("card_faces", [])
    if faces and "image_uris" in faces[0]:
        front = faces[0]["image_uris"].get("normal", "")
        back = faces[1]["image_uris"].get("normal", "") if len(faces) > 1 else None
        return front, back
    return "", None


def make_card(name, zone, x=0.0, y=0.0, tapped=False, face_down=False, front_url="", back_url=None):
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "image": front_url,
        "back_image": back_url,
        "transformed": False,
        "x": x,
        "y": y,
        "zone": zone,
        "tapped": tapped,
        "face_down": face_down,
    }


async def run_bot(room_code, cfg):
    name = cfg["name"]
    print(f"  [{name}] fetching card data...")

    # Fetch all unique card names
    all_names = (
        [cfg["commander"]]
        + cfg["battlefield"]
        + cfg["hand"]
        + cfg["library"]
    )
    unique_names = list(dict.fromkeys(all_names))
    card_cache = {}
    for cname in unique_names:
        data = fetch_card(cname)
        front, back = card_images(data)
        if front:
            card_cache[cname] = (data.get("name", cname), front, back)
        await asyncio.sleep(0.1)  # gentle rate limit

    def lookup(cname):
        return card_cache.get(cname, (cname, "", None))

    # Build card list
    cards = []

    # Commander → command zone
    real_name, front, back = lookup(cfg["commander"])
    cmd_card = make_card(real_name, "command", front_url=front, back_url=back)
    cards.append(cmd_card)
    cmd_id = cmd_card["id"]

    # Battlefield cards — spread them out across the opponent side (y~0.7, x spread)
    bf_xs = [0.15, 0.32, 0.50, 0.68, 0.82]
    for i, cname in enumerate(cfg["battlefield"]):
        real_name, front, back = lookup(cname)
        x = bf_xs[i % len(bf_xs)]
        tapped = (i % 3 == 2)  # tap every 3rd for visual variety
        cards.append(make_card(real_name, "battlefield", x=x, y=0.72,
                                tapped=tapped, front_url=front, back_url=back))

    # Hand cards
    for cname in cfg["hand"]:
        real_name, front, back = lookup(cname)
        cards.append(make_card(real_name, "hand", front_url=front, back_url=back))

    # Library (face-down)
    lib_cards = list(cfg["library"])
    random.shuffle(lib_cards)
    for cname in lib_cards:
        real_name, front, back = lookup(cname)
        cards.append(make_card(real_name, "library", face_down=True, front_url=front, back_url=back))

    # Connect
    uri = f"{WS_BASE}/ws/{room_code}/{name}"
    print(f"  [{name}] connecting...")

    async with websockets.connect(uri) as ws:
        raw = await ws.recv()
        msg = json.loads(raw)
        if msg.get("type") != "init":
            print(f"  [{name}] unexpected message: {msg.get('type')}")
            return
        player_id = msg["player_id"]
        print(f"  [{name}] joined as {player_id[:6]}  |  {len(cards)} cards loaded")

        # Send all cards
        await ws.send(json.dumps({"type": "add_cards", "cards": cards}))

        # Small delay then set life
        await asyncio.sleep(0.5)
        await ws.send(json.dumps({"type": "set_life", "life": cfg["life"]}))

        async def heartbeat():
            while True:
                await asyncio.sleep(25)
                try:
                    await ws.send(json.dumps({"type": "ping"}))
                except Exception:
                    break

        async def life_flicker():
            current = cfg["life"]
            while True:
                await asyncio.sleep(random.uniform(12, 22))
                delta = random.choice([-1, -2, -3, -1, 1])
                current = max(0, current + delta)
                try:
                    await ws.send(json.dumps({"type": "set_life", "life": current}))
                    print(f"  [{name}] life → {current}")
                except Exception:
                    break

        async def recv_loop():
            async for _ in ws:
                pass  # bots don't react to server messages

        await asyncio.gather(heartbeat(), life_flicker(), recv_loop())


async def main():
    args = sys.argv[1:]

    if "--create" in args:
        code = create_room()
        print(f"\n  Created room: {code}")
        print(f"  Open http://localhost:8000 and join room '{code}'\n")
    elif args:
        code = args[0].upper()
    else:
        code = input("Room code: ").strip().upper()
        if not code:
            print("No room code provided.")
            return

    print(f"\nSpinning up 3 bots for room {code}...\n")

    tasks = [asyncio.create_task(run_bot(code, cfg)) for cfg in BOTS]
    # stagger connections slightly
    await asyncio.sleep(0.4)

    print(f"\nAll bots running. Ctrl+C to disconnect.\n")

    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBots disconnected.")
