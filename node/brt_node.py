"""
BRT Node - HTTP API + WebSocket + Auto Block Producer
Run as standalone node. Packaged to .exe via PyInstaller.
"""

import asyncio
import json
import time
import threading
import os
import sys
import logging
from typing import Set
from flask import Flask, request, jsonify
from flask_cors import CORS
import websockets
import websockets.server

# Add parent dir for imports when running as exe
if getattr(sys, "frozen", False):
    base_dir = os.path.dirname(sys.executable)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.join(base_dir))

from brt_chain import BRTBlockchain, Wallet, Transaction, CLAIM_AMOUNT, BRT_DECIMALS

# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────
DATA_DIR     = os.path.join(base_dir, "brt_data")
HTTP_PORT    = 8545
WS_PORT      = 8546
NODE_WALLET_FILE = os.path.join(DATA_DIR, "node_wallet.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [BRT-NODE] %(levelname)s %(message)s",
    handlers=[logging.StreamHandler()]
)
log = logging.getLogger("brt-node")

# ─────────────────────────────────────────────
#  GLOBALS
# ─────────────────────────────────────────────
blockchain = BRTBlockchain(DATA_DIR)
ws_clients: Set[websockets.WebSocketServerProtocol] = set()
node_wallet: Wallet = None

app = Flask(__name__)
CORS(app, origins="*")


# ─────────────────────────────────────────────
#  NODE WALLET
# ─────────────────────────────────────────────
def load_or_create_node_wallet() -> Wallet:
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(NODE_WALLET_FILE):
        with open(NODE_WALLET_FILE) as f:
            data = json.load(f)
        w = Wallet(data["private_key"])
        log.info(f"Node wallet loaded: {w.address}")
        return w
    else:
        w = Wallet()
        with open(NODE_WALLET_FILE, "w") as f:
            json.dump(w.to_dict(), f, indent=2)
        log.info(f"Node wallet created: {w.address}")
        return w


# ─────────────────────────────────────────────
#  BLOCK PRODUCER
# ─────────────────────────────────────────────
def block_producer_loop():
    """Produce a block every BLOCK_TIME seconds"""
    from brt_chain import BLOCK_TIME
    while True:
        time.sleep(BLOCK_TIME)
        try:
            block = blockchain.produce_block(node_wallet.address)
            if block:
                log.info(f"Block #{block.index} produced | hash={block.block_hash[:16]}... | txs={len(block.transactions)}")
                # Broadcast to WS clients
                broadcast_event("new_block", {
                    "index": block.index,
                    "hash": block.block_hash,
                    "validator": block.validator,
                    "tx_count": len(block.transactions),
                    "timestamp": block.timestamp,
                })
        except Exception as e:
            log.error(f"Block production error: {e}")


def broadcast_event(event: str, data: dict):
    """Fire-and-forget broadcast to all WS clients"""
    if not ws_clients:
        return
    payload = json.dumps({"event": event, "data": data})
    asyncio.run_coroutine_threadsafe(
        _broadcast(payload), ws_loop
    )


async def _broadcast(payload: str):
    dead = set()
    for ws in ws_clients:
        try:
            await ws.send(payload)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


# ─────────────────────────────────────────────
#  REST API
# ─────────────────────────────────────────────
def ok(data):
    return jsonify({"ok": True, "result": data})

def err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


@app.get("/")
def index():
    return ok({"node": "BRT Node v1.0", "chain_id": "brt-mainnet-1"})


@app.get("/chain/info")
def chain_info():
    return ok(blockchain.get_chain_info())


@app.get("/chain/blocks")
def recent_blocks():
    n = min(int(request.args.get("n", 10)), 50)
    return ok(blockchain.get_recent_blocks(n))


@app.get("/chain/block/<int:index>")
def get_block(index):
    if index < 0 or index >= len(blockchain.chain):
        return err("block not found", 404)
    return ok(blockchain.chain[index].to_dict())


@app.get("/wallet/balance/<address>")
def get_balance(address):
    bal = blockchain.get_balance(address)
    stake = blockchain.get_stake(address)
    can_claim, cooldown = blockchain.can_claim(address)
    return ok({
        "address": address,
        "balance": bal,
        "balance_brt": bal / 10**BRT_DECIMALS,
        "stake": stake,
        "stake_brt": stake / 10**BRT_DECIMALS,
        "can_claim": can_claim,
        "claim_cooldown_seconds": cooldown,
    })


@app.post("/wallet/create")
def create_wallet():
    w = Wallet()
    return ok(w.to_dict())


@app.post("/wallet/import")
def import_wallet():
    data = request.json or {}
    pk = data.get("private_key")
    if not pk:
        return err("private_key required")
    try:
        w = Wallet(pk)
        return ok({"address": w.address, "public_key": w.public_key.to_string().hex()})
    except Exception as e:
        return err(str(e))


@app.post("/tx/transfer")
def send_transfer():
    data = request.json or {}
    required = ["private_key", "recipient", "amount"]
    if not all(k in data for k in required):
        return err(f"required: {required}")
    try:
        wallet = Wallet(data["private_key"])
        amount = int(float(data["amount"]) * 10**BRT_DECIMALS)
        fee = max(int(amount * 0.001), 1000)  # 0.1% fee, min 0.00001 BRT
        tx = Transaction.create(
            wallet.address, data["recipient"],
            amount, fee, "transfer", {}, wallet
        )
        ok_, result = blockchain.add_to_mempool(tx)
        if not ok_:
            return err(result)
        broadcast_event("new_tx", {"tx_id": tx.tx_id, "type": "transfer"})
        return ok({"tx_id": tx.tx_id})
    except Exception as e:
        return err(str(e))


@app.post("/tx/claim")
def claim_tokens():
    data = request.json or {}
    address = data.get("address")
    if not address:
        return err("address required")

    can, cooldown = blockchain.can_claim(address)
    if not can:
        return err(f"cooldown: {int(cooldown)}s remaining")

    # Claim tx is special - signed by faucet (no wallet needed)
    tx = Transaction(
        tx_id=f"claim-{address}-{int(time.time())}",
        sender="FAUCET",
        recipient=address,
        amount=CLAIM_AMOUNT,
        fee=0,
        tx_type="claim",
        data={"note": "faucet claim"},
        timestamp=time.time()
    )
    ok_, result = blockchain.add_to_mempool(tx)
    if not ok_:
        return err(result)
    broadcast_event("new_tx", {"tx_id": tx.tx_id, "type": "claim", "recipient": address})
    return ok({"tx_id": tx.tx_id, "amount": CLAIM_AMOUNT, "amount_brt": CLAIM_AMOUNT / 10**BRT_DECIMALS})


@app.post("/tx/stake")
def stake_tokens():
    data = request.json or {}
    required = ["private_key", "amount"]
    if not all(k in data for k in required):
        return err(f"required: {required}")
    try:
        wallet = Wallet(data["private_key"])
        amount = int(float(data["amount"]) * 10**BRT_DECIMALS)
        tx = Transaction.create(
            wallet.address, wallet.address,
            amount, 0, "stake", {}, wallet
        )
        ok_, result = blockchain.add_to_mempool(tx)
        if not ok_:
            return err(result)
        return ok({"tx_id": tx.tx_id})
    except Exception as e:
        return err(str(e))


@app.get("/listings")
def get_listings():
    active_only = request.args.get("active", "true").lower() == "true"
    return ok(blockchain.get_listings(active_only))


@app.post("/listings/create")
def create_listing():
    data = request.json or {}
    required = ["private_key", "title", "description", "price_per_day", "deposit", "category"]
    if not all(k in data for k in required):
        return err(f"required: {required}")
    try:
        import uuid as _uuid
        wallet = Wallet(data["private_key"])
        from brt_chain import RentalListing
        import dataclasses
        listing = RentalListing(
            listing_id=str(_uuid.uuid4()),
            owner=wallet.address,
            title=data["title"],
            description=data["description"],
            price_per_day=int(float(data["price_per_day"]) * 10**BRT_DECIMALS),
            deposit=int(float(data["deposit"]) * 10**BRT_DECIMALS),
            category=data.get("category", "other"),
            image_url=data.get("image_url", ""),
            created_at=time.time(),
        )
        tx = Transaction.create(
            wallet.address, wallet.address,
            0, int(0.01 * 10**BRT_DECIMALS), "rental_create",
            {"listing": dataclasses.asdict(listing)}, wallet
        )
        ok_, result = blockchain.add_to_mempool(tx)
        if not ok_:
            return err(result)
        return ok({"tx_id": tx.tx_id, "listing_id": listing.listing_id})
    except Exception as e:
        return err(str(e))


@app.post("/listings/rent")
def rent_item():
    data = request.json or {}
    required = ["private_key", "listing_id", "days"]
    if not all(k in data for k in required):
        return err(f"required: {required}")
    try:
        wallet = Wallet(data["private_key"])
        listing_id = data["listing_id"]
        days = int(data["days"])

        listing = blockchain.listings.get(listing_id)
        if not listing:
            return err("listing not found", 404)
        if not listing.active:
            return err("listing not available")

        total = listing.price_per_day * days + listing.deposit
        fee = int(total * 0.025)

        tx = Transaction.create(
            wallet.address, listing.owner,
            total, fee, "rental_pay",
            {"listing_id": listing_id, "days": days}, wallet
        )
        ok_, result = blockchain.add_to_mempool(tx)
        if not ok_:
            return err(result)
        broadcast_event("new_rental", {"listing_id": listing_id, "renter": wallet.address})
        return ok({"tx_id": tx.tx_id, "total_brt": total / 10**BRT_DECIMALS})
    except Exception as e:
        return err(str(e))


@app.get("/node/info")
def node_info():
    return ok({
        "node_address": node_wallet.address,
        "node_stake": blockchain.get_stake(node_wallet.address),
        "validators": blockchain.validators,
        "mempool_size": len(blockchain.mempool),
    })


# ─────────────────────────────────────────────
#  WEBSOCKET SERVER
# ─────────────────────────────────────────────
async def ws_handler(websocket):
    ws_clients.add(websocket)
    log.info(f"WS client connected: {websocket.remote_address}")
    try:
        # Send chain info on connect
        await websocket.send(json.dumps({
            "event": "connected",
            "data": blockchain.get_chain_info()
        }))
        async for message in websocket:
            try:
                msg = json.loads(message)
                if msg.get("type") == "subscribe":
                    pass  # Future: topic-based subscriptions
            except Exception:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        ws_clients.discard(websocket)
        log.info(f"WS client disconnected")


ws_loop = asyncio.new_event_loop()


def run_ws():
    asyncio.set_event_loop(ws_loop)

    async def serve():
        async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
            log.info(f"WebSocket server on ws://0.0.0.0:{WS_PORT}")
            await asyncio.Future()

    ws_loop.run_until_complete(serve())


# ─────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────
def main():
    global node_wallet
    node_wallet = load_or_create_node_wallet()

    log.info("=" * 50)
    log.info("  BRT Blockchain Node v1.0")
    log.info(f"  Node: {node_wallet.address}")
    log.info(f"  HTTP: http://0.0.0.0:{HTTP_PORT}")
    log.info(f"  WS:   ws://0.0.0.0:{WS_PORT}")
    log.info(f"  Data: {DATA_DIR}")
    log.info("=" * 50)

    # Start WS in separate thread
    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()

    # Start block producer
    producer_thread = threading.Thread(target=block_producer_loop, daemon=True)
    producer_thread.start()

    # Start HTTP (main thread)
    app.run(host="0.0.0.0", port=HTTP_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
