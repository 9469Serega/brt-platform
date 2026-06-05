# ⬡ BRT Platform — Decentralized Rental Marketplace

## Quick Start

### 1 — Run the Node
```bash
cd node
pip install -r requirements.txt
cp ../blockchain/brt_chain.py .
python brt_node.py
```
**Or on Windows:** run `build.bat` → double-click `dist/brt_node.exe`

Node: HTTP `localhost:8545` · WebSocket `localhost:8546`

### 2 — Run the Website
```bash
cd website
npm install
npm run dev    # http://localhost:3000
npm run build  # production build → website/dist/
```

## Structure
```
brt-project/
├── blockchain/brt_chain.py     # Core blockchain + PoS + BRT token
├── node/
│   ├── brt_node.py             # Flask API + WebSocket + block producer
│   ├── requirements.txt        # pip deps
│   ├── brt_node.spec           # PyInstaller → .exe
│   └── build.bat               # Windows build script
└── website/
    ├── src/App.jsx             # Full React SPA
    ├── package.json
    └── vite.config.js
```

## API Reference
| Method | Path | Description |
|--------|------|-------------|
| GET | /chain/info | Height, validators, mempool |
| GET | /wallet/balance/:addr | Balance + claim status |
| POST | /wallet/create | New keypair |
| POST | /tx/transfer | Send BRT |
| POST | /tx/claim | Faucet (100 BRT/24h) |
| POST | /tx/stake | Become validator |
| GET | /listings | Rental listings |
| POST | /listings/create | List an item |
| POST | /listings/rent | Rent an item |

## Token Info
- Ticker: **BRT** · Supply: **100M** · Block reward: **10 BRT**
- Block time: **~5s** · Min stake: **1,000 BRT** · Fee: **2.5%**
