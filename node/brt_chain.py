"""
BRT Blockchain - Core Implementation
Custom blockchain for BRT token with PoS consensus
"""

import hashlib
import json
import time
import uuid
import os
import threading
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict, field
from collections import defaultdict
import ecdsa
import base58
import secrets

# ─────────────────────────────────────────────
#  CONSTANTS
# ─────────────────────────────────────────────
CHAIN_ID        = "brt-mainnet-1"
BRT_DECIMALS    = 8
TOTAL_SUPPLY    = 100_000_000 * (10 ** BRT_DECIMALS)   # 100M BRT
BLOCK_REWARD    = 10 * (10 ** BRT_DECIMALS)             # 10 BRT per block
CLAIM_AMOUNT    = 100 * (10 ** BRT_DECIMALS)            # 100 BRT faucet claim
CLAIM_COOLDOWN  = 86_400                                 # 24h in seconds
MIN_STAKE       = 1000 * (10 ** BRT_DECIMALS)           # 1000 BRT min stake
BLOCK_TIME      = 5                                      # seconds
GENESIS_ADDRESS = "BRT1GENESIS0000000000000000000000000"
FAUCET_ADDRESS  = "BRT1FAUCET00000000000000000000000000"
FAUCET_SUPPLY   = 10_000_000 * (10 ** BRT_DECIMALS)     # 10M BRT for faucet


# ─────────────────────────────────────────────
#  WALLET
# ─────────────────────────────────────────────
class Wallet:
    def __init__(self, private_key_hex: str = None):
        if private_key_hex:
            self.private_key = ecdsa.SigningKey.from_string(
                bytes.fromhex(private_key_hex), curve=ecdsa.SECP256k1
            )
        else:
            self.private_key = ecdsa.SigningKey.generate(curve=ecdsa.SECP256k1)

        self.public_key = self.private_key.get_verifying_key()
        self.address = self._derive_address()

    def _derive_address(self) -> str:
        pub_bytes = self.public_key.to_string()
        sha = hashlib.sha256(pub_bytes).digest()
        ripe = hashlib.new("ripemd160", sha).digest()
        versioned = b"\x05" + ripe  # version byte 0x05 for BRT
        checksum = hashlib.sha256(hashlib.sha256(versioned).digest()).digest()[:4]
        full = versioned + checksum
        return "BRT" + base58.b58encode(full).decode()

    def sign(self, data: str) -> str:
        return self.private_key.sign(data.encode(), hashfunc=hashlib.sha256).hex()

    def export_private_key(self) -> str:
        return self.private_key.to_string().hex()

    @staticmethod
    def verify_signature(address: str, data: str, signature_hex: str, public_key_hex: str) -> bool:
        try:
            pub = ecdsa.VerifyingKey.from_string(
                bytes.fromhex(public_key_hex), curve=ecdsa.SECP256k1
            )
            pub.verify(bytes.fromhex(signature_hex), data.encode(), hashfunc=hashlib.sha256)
            return True
        except Exception:
            return False

    def to_dict(self) -> dict:
        return {
            "address": self.address,
            "public_key": self.public_key.to_string().hex(),
            "private_key": self.export_private_key()
        }


# ─────────────────────────────────────────────
#  TRANSACTION
# ─────────────────────────────────────────────
@dataclass
class Transaction:
    tx_id:      str
    sender:     str
    recipient:  str
    amount:     int          # in smallest unit (satoshi-like)
    fee:        int
    tx_type:    str          # transfer | stake | unstake | claim | rental_pay | rental_create
    data:       dict
    timestamp:  float
    signature:  str = ""
    public_key: str = ""

    def to_signable(self) -> str:
        return json.dumps({
            "tx_id": self.tx_id,
            "sender": self.sender,
            "recipient": self.recipient,
            "amount": self.amount,
            "fee": self.fee,
            "tx_type": self.tx_type,
            "data": self.data,
            "timestamp": self.timestamp,
        }, sort_keys=True)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Transaction":
        return cls(**d)

    @staticmethod
    def create(sender: str, recipient: str, amount: int, fee: int,
               tx_type: str, data: dict, wallet: "Wallet") -> "Transaction":
        tx_id = hashlib.sha256(
            f"{sender}{recipient}{amount}{time.time()}{secrets.token_hex(8)}".encode()
        ).hexdigest()
        tx = Transaction(
            tx_id=tx_id, sender=sender, recipient=recipient,
            amount=amount, fee=fee, tx_type=tx_type, data=data,
            timestamp=time.time()
        )
        tx.signature = wallet.sign(tx.to_signable())
        tx.public_key = wallet.public_key.to_string().hex()
        return tx


# ─────────────────────────────────────────────
#  BLOCK
# ─────────────────────────────────────────────
@dataclass
class Block:
    index:        int
    timestamp:    float
    transactions: List[dict]
    previous_hash: str
    validator:    str
    block_hash:   str = ""
    nonce:        int = 0

    def compute_hash(self) -> str:
        content = json.dumps({
            "index": self.index,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "previous_hash": self.previous_hash,
            "validator": self.validator,
            "nonce": self.nonce,
        }, sort_keys=True)
        return hashlib.sha256(content.encode()).hexdigest()

    def finalize(self):
        self.block_hash = self.compute_hash()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Block":
        b = cls(**d)
        return b


# ─────────────────────────────────────────────
#  RENTAL LISTING
# ─────────────────────────────────────────────
@dataclass
class RentalListing:
    listing_id:   str
    owner:        str
    title:        str
    description:  str
    price_per_day: int    # in BRT units
    deposit:      int     # in BRT units
    category:     str
    image_url:    str
    created_at:   float
    active:       bool = True
    renter:       str = ""
    rented_until: float = 0.0


# ─────────────────────────────────────────────
#  BLOCKCHAIN
# ─────────────────────────────────────────────
class BRTBlockchain:
    def __init__(self, data_dir: str = "./brt_data"):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

        self.chain: List[Block] = []
        self.mempool: List[Transaction] = []
        self.balances: Dict[str, int] = defaultdict(int)
        self.stakes: Dict[str, int] = defaultdict(int)
        self.validators: List[str] = []
        self.claim_history: Dict[str, float] = {}
        self.listings: Dict[str, RentalListing] = {}
        self.nonces: Dict[str, int] = defaultdict(int)

        self._lock = threading.Lock()
        self._load_or_genesis()

    # ── Genesis ───────────────────────────────
    def _create_genesis(self) -> Block:
        genesis_tx = Transaction(
            tx_id="genesis",
            sender="COINBASE",
            recipient=FAUCET_ADDRESS,
            amount=FAUCET_SUPPLY,
            fee=0,
            tx_type="genesis",
            data={"note": "BRT Genesis Block"},
            timestamp=time.time()
        )
        block = Block(
            index=0,
            timestamp=time.time(),
            transactions=[genesis_tx.to_dict()],
            previous_hash="0" * 64,
            validator=GENESIS_ADDRESS,
        )
        block.finalize()
        self.balances[FAUCET_ADDRESS] = FAUCET_SUPPLY
        return block

    # ── Persistence ───────────────────────────
    def _chain_path(self) -> str:
        return os.path.join(self.data_dir, "chain.json")

    def _state_path(self) -> str:
        return os.path.join(self.data_dir, "state.json")

    def _load_or_genesis(self):
        if os.path.exists(self._chain_path()):
            try:
                self._load()
            except Exception as e:
                print(f"[WARN] Chain file corrupt ({e}), resetting to genesis...")
                for f in [self._chain_path(), self._state_path()]:
                    try: os.remove(f)
                    except: pass
                genesis = self._create_genesis()
                self.chain.append(genesis)
                self._save()
        else:
            genesis = self._create_genesis()
            self.chain.append(genesis)
            self._save()

    def _save(self):
        with open(self._chain_path(), "w") as f:
            json.dump([b.to_dict() for b in self.chain], f)
        state = {
            "balances": dict(self.balances),
            "stakes": dict(self.stakes),
            "validators": self.validators,
            "claim_history": self.claim_history,
            "listings": {k: asdict(v) for k, v in self.listings.items()},
            "nonces": dict(self.nonces),
        }
        with open(self._state_path(), "w") as f:
            json.dump(state, f)

    def _load(self):
        with open(self._chain_path()) as f:
            chain_data = json.load(f)
        self.chain = [Block.from_dict(b) for b in chain_data]

        if os.path.exists(self._state_path()):
            with open(self._state_path()) as f:
                state = json.load(f)
            self.balances = defaultdict(int, {k: int(v) for k, v in state.get("balances", {}).items()})
            self.stakes = defaultdict(int, {k: int(v) for k, v in state.get("stakes", {}).items()})
            self.validators = state.get("validators", [])
            self.claim_history = state.get("claim_history", {})
            self.nonces = defaultdict(int, state.get("nonces", {}))
            for lid, ld in state.get("listings", {}).items():
                self.listings[lid] = RentalListing(**ld)

    # ── Validation ────────────────────────────
    def validate_transaction(self, tx: Transaction) -> Tuple[bool, str]:
        if tx.tx_type == "genesis":
            return True, "ok"
        if tx.tx_type == "claim":
            last = self.claim_history.get(tx.recipient, 0)
            if time.time() - last < CLAIM_COOLDOWN:
                return False, "claim cooldown active"
            if self.balances[FAUCET_ADDRESS] < CLAIM_AMOUNT:
                return False, "faucet empty"
            return True, "ok"
        if tx.sender == "COINBASE":
            return True, "ok"

        # Signature check
        if not Wallet.verify_signature(tx.sender, tx.to_signable(), tx.signature, tx.public_key):
            return False, "invalid signature"

        # Balance check
        total_needed = tx.amount + tx.fee
        if self.balances[tx.sender] < total_needed:
            return False, f"insufficient balance: have {self.balances[tx.sender]}, need {total_needed}"

        return True, "ok"

    # ── Mempool ───────────────────────────────
    def add_to_mempool(self, tx: Transaction) -> Tuple[bool, str]:
        with self._lock:
            ok, reason = self.validate_transaction(tx)
            if not ok:
                return False, reason
            self.mempool.append(tx)
            return True, tx.tx_id

    # ── Block Production ──────────────────────
    def produce_block(self, validator_address: str) -> Optional[Block]:
        with self._lock:
            txs = self.mempool[:50]  # max 50 tx per block
            self.mempool = self.mempool[50:]

            # Coinbase reward
            reward_tx = Transaction(
                tx_id=f"coinbase-{len(self.chain)}",
                sender="COINBASE",
                recipient=validator_address,
                amount=BLOCK_REWARD,
                fee=0,
                tx_type="coinbase",
                data={},
                timestamp=time.time()
            )

            all_txs = [reward_tx] + txs
            block = Block(
                index=len(self.chain),
                timestamp=time.time(),
                transactions=[tx.to_dict() for tx in all_txs],
                previous_hash=self.chain[-1].block_hash,
                validator=validator_address,
            )
            block.finalize()

            # Apply transactions
            for tx_dict in block.transactions:
                tx = Transaction.from_dict(tx_dict)
                self._apply_transaction(tx)

            self.chain.append(block)
            self._save()
            return block

    def _apply_transaction(self, tx: Transaction):
        if tx.tx_type == "genesis":
            self.balances[tx.recipient] += tx.amount
        elif tx.tx_type == "coinbase":
            self.balances[tx.recipient] += tx.amount
        elif tx.tx_type == "claim":
            self.balances[FAUCET_ADDRESS] -= CLAIM_AMOUNT
            self.balances[tx.recipient] += CLAIM_AMOUNT
            self.claim_history[tx.recipient] = time.time()
        elif tx.tx_type == "transfer":
            self.balances[tx.sender] -= (tx.amount + tx.fee)
            self.balances[tx.recipient] += tx.amount
            self.balances[GENESIS_ADDRESS] += tx.fee
        elif tx.tx_type == "stake":
            self.balances[tx.sender] -= tx.amount
            self.stakes[tx.sender] += tx.amount
            if tx.sender not in self.validators and self.stakes[tx.sender] >= MIN_STAKE:
                self.validators.append(tx.sender)
        elif tx.tx_type == "unstake":
            unstake_amt = min(tx.amount, self.stakes[tx.sender])
            self.stakes[tx.sender] -= unstake_amt
            self.balances[tx.sender] += unstake_amt
            if self.stakes[tx.sender] < MIN_STAKE and tx.sender in self.validators:
                self.validators.remove(tx.sender)
        elif tx.tx_type == "rental_create":
            listing = RentalListing(**tx.data["listing"])
            self.listings[listing.listing_id] = listing
        elif tx.tx_type == "rental_pay":
            lid = tx.data.get("listing_id")
            days = tx.data.get("days", 1)
            if lid in self.listings:
                listing = self.listings[lid]
                total = listing.price_per_day * days + listing.deposit
                fee = int(total * 0.025)  # 2.5% platform fee in BRT
                self.balances[tx.sender] -= (total + fee)
                self.balances[listing.owner] += (total - fee)
                self.balances[GENESIS_ADDRESS] += fee * 2
                listing.renter = tx.sender
                listing.rented_until = time.time() + days * 86400
                listing.active = False

    # ── Queries ───────────────────────────────
    def get_balance(self, address: str) -> int:
        return self.balances.get(address, 0)

    def get_stake(self, address: str) -> int:
        return self.stakes.get(address, 0)

    def get_chain_info(self) -> dict:
        return {
            "chain_id": CHAIN_ID,
            "height": len(self.chain),
            "latest_hash": self.chain[-1].block_hash if self.chain else "",
            "total_validators": len(self.validators),
            "total_supply": TOTAL_SUPPLY,
            "circulating": sum(self.balances.values()),
            "mempool_size": len(self.mempool),
        }

    def get_recent_blocks(self, n: int = 10) -> List[dict]:
        return [b.to_dict() for b in reversed(self.chain[-n:])]

    def get_listings(self, active_only: bool = True) -> List[dict]:
        result = []
        for l in self.listings.values():
            if active_only and not l.active:
                continue
            result.append(asdict(l))
        return result

    def can_claim(self, address: str) -> Tuple[bool, float]:
        last = self.claim_history.get(address, 0)
        elapsed = time.time() - last
        if elapsed >= CLAIM_COOLDOWN:
            return True, 0
        return False, CLAIM_COOLDOWN - elapsed


if __name__ == "__main__":
    bc = BRTBlockchain("./test_data")
    w = Wallet()
    print("Wallet:", w.address)
    print("Chain info:", bc.get_chain_info())
    print("Faucet balance:", bc.get_balance(FAUCET_ADDRESS) / 10**8, "BRT")
