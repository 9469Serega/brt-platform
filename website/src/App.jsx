import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────
//  CONFIG — замени NODE_URL на свой сервер если есть
// ─────────────────────────────────────────────────────────
const NODE_URL = import.meta.env.VITE_NODE_URL || "http://localhost:8545";
const WS_URL   = import.meta.env.VITE_WS_URL   || "ws://localhost:8546";
const DECIMALS = 1e8;
const fmt  = (n) => (Number(n) / DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 4 });

// ─────────────────────────────────────────────────────────
//  CLIENT-SIDE CRYPTO (без ноды)
//  Используем Web Crypto API — встроен в браузер
// ─────────────────────────────────────────────────────────

// Генерация случайных байт
function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Hex утилиты
const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));

// Base58
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let num = BigInt('0x' + Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join(''));
  let result = '';
  while (num > 0n) {
    result = B58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = '1' + result; else break;
  }
  return result;
}

// SHA-256 (async)
async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

// Дважды SHA-256
async function sha256d(data) {
  return sha256(await sha256(data));
}

// Вывод BRT-адреса из публичного ключа
async function pubKeyToAddress(pubKeyHex) {
  const pubBytes = fromHex(pubKeyHex);
  const sha = await sha256(pubBytes);
  // RIPEMD160 эмулируем через двойной SHA256 (в браузере нет RIPEMD)
  const ripe = (await sha256(sha)).slice(0, 20);
  const versioned = new Uint8Array([0x05, ...ripe]);
  const checksum = (await sha256d(versioned)).slice(0, 4);
  const full = new Uint8Array([...versioned, ...checksum]);
  return 'BRT' + base58Encode(full);
}

// Генерация ECDSA P-256 ключевой пары (Web Crypto)
async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  const privRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const pubRaw  = await crypto.subtle.exportKey('spki',  keyPair.publicKey);
  const privHex = toHex(privRaw);
  const pubHex  = toHex(pubRaw);
  const address = await pubKeyToAddress(pubHex);
  return { address, public_key: pubHex, private_key: privHex };
}

// Импорт приватного ключа
async function importPrivateKey(privHex) {
  try {
    const privBytes = fromHex(privHex);
    const privKey = await crypto.subtle.importKey(
      'pkcs8', privBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign']
    );
    const pubKey = await crypto.subtle.importKey(
      'pkcs8', privBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign']
    );
    // Деривируем публичный из приватного через exportKey round-trip
    const jwk = await crypto.subtle.exportKey('jwk', privKey);
    // Реконструируем публичный ключ из JWK
    const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const pubKeyObj = await crypto.subtle.importKey(
      'jwk', pubJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['verify']
    );
    const pubRaw = await crypto.subtle.exportKey('spki', pubKeyObj);
    const pubHex = toHex(pubRaw);
    const address = await pubKeyToAddress(pubHex);
    return { address, public_key: pubHex, private_key: privHex };
  } catch(e) {
    throw new Error('Invalid private key format');
  }
}

// Простая валидация адреса
function isValidAddress(addr) {
  return typeof addr === 'string' && addr.startsWith('BRT') && addr.length >= 20;
}

// ─────────────────────────────────────────────────────────
//  API — обращения к ноде
// ─────────────────────────────────────────────────────────
async function api(path, method = "GET", body = null) {
  try {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(NODE_URL + path, opts);
    return r.json();
  } catch {
    return { ok: false, error: "Node offline — запусти brt_node.exe" };
  }
}

// ─────────────────────────────────────────────────────────
//  HOOKS
// ─────────────────────────────────────────────────────────
function useWallet() {
  const [wallet, setWallet] = useState(() => {
    try { const s = localStorage.getItem("brt_wallet"); return s ? JSON.parse(s) : null; }
    catch { return null; }
  });
  const [balance, setBalance] = useState(null);
  const [nodeOnline, setNodeOnline] = useState(false);

  const save  = (w) => { setWallet(w); localStorage.setItem("brt_wallet", JSON.stringify(w)); };
  const clear = ()  => { setWallet(null); setBalance(null); localStorage.removeItem("brt_wallet"); };

  const refresh = useCallback(async () => {
    if (!wallet?.address) return;
    const r = await api(`/wallet/balance/${wallet.address}`);
    if (r.ok) { setBalance(r.result); setNodeOnline(true); }
    else setNodeOnline(false);
  }, [wallet?.address]);

  useEffect(() => { refresh(); }, [refresh]);
  return { wallet, balance, nodeOnline, save, clear, refresh };
}

function useNode() {
  const [info, setInfo]     = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [connected, setConn] = useState(false);

  useEffect(() => {
    let ws, timer;
    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);
        ws.onopen    = () => setConn(true);
        ws.onclose   = () => { setConn(false); timer = setTimeout(connect, 5000); };
        ws.onerror   = () => {};
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.event === "connected") setInfo(m.data);
          if (m.event === "new_block") {
            setBlocks(p => [m.data, ...p].slice(0, 15));
            setInfo(p => p ? { ...p, height: (m.data.index || 0) + 1 } : p);
          }
        };
      } catch {}
    };
    connect();
    api("/chain/info").then(r  => { if (r.ok) setInfo(r.result); });
    api("/chain/blocks?n=15").then(r => { if (r.ok) setBlocks(r.result); });
    return () => { ws?.close(); clearTimeout(timer); };
  }, []);

  return { info, blocks, connected };
}

// ─────────────────────────────────────────────────────────
//  DEMO DATA
// ─────────────────────────────────────────────────────────
const CATEGORIES = [
  { id:"all",         label:"All",         emoji:"🌐" },
  { id:"electronics", label:"Electronics", emoji:"💻" },
  { id:"transport",   label:"Transport",   emoji:"🚗" },
  { id:"tools",       label:"Tools",       emoji:"🔧" },
  { id:"sport",       label:"Sport",       emoji:"⚽" },
  { id:"fashion",     label:"Fashion",     emoji:"👗" },
  { id:"other",       label:"Other",       emoji:"📦" },
];

const DEMO_LISTINGS = [
  { listing_id:"l1", title:"DJI Drone Mavic 3",  category:"electronics", emoji:"🚁", price_per_day:150*DECIMALS, deposit:500*DECIMALS,  description:"Professional 4K drone, 46min flight time, obstacle avoidance.", active:true },
  { listing_id:"l2", title:"Tesla Model 3",       category:"transport",   emoji:"🚗", price_per_day:80*DECIMALS,  deposit:2000*DECIMALS, description:"2023 Long Range, Autopilot, 580km range.", active:true },
  { listing_id:"l3", title:"Canon EOS R5",        category:"electronics", emoji:"📷", price_per_day:120*DECIMALS, deposit:1000*DECIMALS, description:"45MP mirrorless + RF 24-70mm + RF 70-200mm.", active:true },
  { listing_id:"l4", title:"Electric Scooter",    category:"transport",   emoji:"🛴", price_per_day:25*DECIMALS,  deposit:200*DECIMALS,  description:"Xiaomi Pro 3. 45km range, foldable.", active:true },
  { listing_id:"l5", title:"Camping Tent 4P",     category:"sport",       emoji:"⛺", price_per_day:20*DECIMALS,  deposit:100*DECIMALS,  description:"MSR Hubba Hubba NX. Ultralight 1.7kg.", active:true },
  { listing_id:"l6", title:"MacBook Pro 16\"",    category:"electronics", emoji:"💻", price_per_day:60*DECIMALS,  deposit:800*DECIMALS,  description:"M3 Max, 128GB RAM, 2TB SSD.", active:true },
  { listing_id:"l7", title:"Makita Drill Set",    category:"tools",       emoji:"🔩", price_per_day:15*DECIMALS,  deposit:80*DECIMALS,   description:"18V brushless + 6 attachments + 2 batteries.", active:true },
  { listing_id:"l8", title:"Mountain Bike",       category:"sport",       emoji:"🚵", price_per_day:30*DECIMALS,  deposit:300*DECIMALS,  description:"Trek Marlin 7 29\". Hydraulic brakes, lockout fork.", active:true },
  { listing_id:"l9", title:"Leather Jacket",      category:"fashion",     emoji:"🧥", price_per_day:12*DECIMALS,  deposit:150*DECIMALS,  description:"Genuine lambskin. Size M/L.", active:true },
];

// ─────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --glass:rgba(255,255,255,0.07);--glass-b:rgba(255,255,255,0.14);
  --glass-s:0 8px 32px rgba(0,0,0,0.4);--blur:blur(22px);
  --blue:#0A84FF;--green:#30D158;--orange:#FF9F0A;--red:#FF453A;--purple:#BF5AF2;
  --t1:rgba(255,255,255,0.95);--t2:rgba(255,255,255,0.55);--t3:rgba(255,255,255,0.28);
  --r:20px;--r2:13px;--font:'Figtree',-apple-system,sans-serif;
}
html{scroll-behavior:smooth}
body{font-family:var(--font);background:#000;color:var(--t1);min-height:100vh;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:0;
  background:radial-gradient(ellipse 110% 70% at 15% 5%,#071433 0%,transparent 60%),
  radial-gradient(ellipse 80% 80% at 85% 0%,#14062e 0%,transparent 55%),
  radial-gradient(ellipse 60% 60% at 55% 90%,#061a0e 0%,transparent 60%),#000}
.orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.35;pointer-events:none;animation:fl 10s ease-in-out infinite}
.o1{width:600px;height:600px;background:rgba(10,132,255,.35);top:-150px;left:-100px}
.o2{width:450px;height:450px;background:rgba(48,209,88,.22);bottom:-80px;right:8%;animation-delay:-4s}
.o3{width:350px;height:350px;background:rgba(191,90,242,.18);top:38%;right:-80px;animation-delay:-7s}
.o4{width:280px;height:280px;background:rgba(255,159,10,.14);top:55%;left:30%;animation-delay:-2s}
@keyframes fl{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-40px) scale(1.07)}}
.g{background:var(--glass);border:1px solid var(--glass-b);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border-radius:var(--r);box-shadow:var(--glass-s)}
.gs{background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:var(--r2)}
.app{position:relative;z-index:1;min-height:100vh}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px}
.nav{position:fixed;top:0;left:0;right:0;z-index:100;height:58px;display:flex;align-items:center;padding:0 22px;gap:6px;
  background:rgba(0,0,0,.5);border-bottom:1px solid rgba(255,255,255,0.07);backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px)}
.nav-logo{font-size:17px;font-weight:800;letter-spacing:-.5px;margin-right:14px;flex-shrink:0;
  background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.55) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:2px;flex:1;overflow-x:auto}.nav-links::-webkit-scrollbar{display:none}
.nb{background:none;border:none;cursor:pointer;color:var(--t2);font-size:13px;font-weight:500;
  padding:6px 13px;border-radius:9px;transition:all .15s;white-space:nowrap;font-family:var(--font)}
.nb:hover{background:rgba(255,255,255,0.07);color:var(--t1)}.nb.on{background:rgba(255,255,255,0.11);color:var(--t1)}
.nav-r{display:flex;gap:8px;align-items:center;margin-left:auto;flex-shrink:0}
.ndot{width:7px;height:7px;border-radius:50%}
.ndot.live{background:var(--green);box-shadow:0 0 8px var(--green);animation:pu 2s infinite}
.ndot.off{background:var(--red)}
@keyframes pu{0%,100%{opacity:1}50%{opacity:.35}}
.nadr{font-family:monospace;font-size:11px;padding:4px 10px;border-radius:8px;
  background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:background .15s}
.nadr:hover{background:rgba(255,255,255,0.12)}
.main{padding-top:76px;padding-bottom:70px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:900px){.g3{grid-template-columns:1fr 1fr}}
@media(max-width:640px){.g2,.g3,.g4{grid-template-columns:1fr}}
.sec{margin-bottom:36px}
.stitle{font-size:21px;font-weight:800;letter-spacing:-.5px;margin-bottom:16px}
.ssub{font-size:14px;color:var(--t2);margin:-12px 0 16px;line-height:1.6}
.scard{padding:20px 22px}
.slbl{font-size:10px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.sval{font-size:24px;font-weight:800;letter-spacing:-1px}
.ssb{font-size:11px;color:var(--t2);margin-top:3px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:11px 22px;border-radius:13px;font-size:14px;font-weight:600;
  cursor:pointer;border:none;transition:all .15s;font-family:var(--font);white-space:nowrap}
.btn:disabled{opacity:.38;cursor:not-allowed;transform:none!important;box-shadow:none!important}
.bp{background:var(--blue);color:#fff}.bp:hover:not(:disabled){background:#0070e0;transform:translateY(-1px);box-shadow:0 6px 24px rgba(10,132,255,.4)}
.bg2{background:var(--green);color:#fff}.bg2:hover:not(:disabled){background:#25b34d;transform:translateY(-1px)}
.bgl{background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.14);color:var(--t1);backdrop-filter:blur(8px)}
.bgl:hover:not(:disabled){background:rgba(255,255,255,0.15)}
.bd{background:var(--red);color:#fff}.bd:hover:not(:disabled){background:#d93b31;transform:translateY(-1px)}
.bsm{padding:8px 15px;font-size:13px;border-radius:10px}
.bfl{width:100%}
.inp{width:100%;background:rgba(255,255,255,0.055);border:1px solid rgba(255,255,255,0.11);
  border-radius:12px;padding:12px 15px;color:var(--t1);font-size:14px;font-family:var(--font);outline:none;transition:border-color .15s}
.inp:focus{border-color:var(--blue);background:rgba(255,255,255,0.08)}
.inp::placeholder{color:var(--t3)}
select.inp{cursor:pointer}
select.inp option{background:#111;color:#fff}
.igrp{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.ilbl{font-size:11px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.6px}
.tag{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
.tb{background:rgba(10,132,255,.18);color:#5dbfff;border:1px solid rgba(10,132,255,.3)}
.tg{background:rgba(48,209,88,.18);color:#65e68b;border:1px solid rgba(48,209,88,.3)}
.to{background:rgba(255,159,10,.18);color:#ffc94d;border:1px solid rgba(255,159,10,.3)}
.tr{background:rgba(255,69,58,.18);color:#ff8078;border:1px solid rgba(255,69,58,.3)}
.tp{background:rgba(191,90,242,.18);color:#d18fff;border:1px solid rgba(191,90,242,.3)}
.al{padding:12px 15px;border-radius:12px;font-size:13px;margin-bottom:14px;line-height:1.5}
.al-ok{background:rgba(48,209,88,.1);border:1px solid rgba(48,209,88,.3);color:#65e68b}
.al-er{background:rgba(255,69,58,.1);border:1px solid rgba(255,69,58,.3);color:#ff8078}
.al-in{background:rgba(10,132,255,.1);border:1px solid rgba(10,132,255,.3);color:#5dbfff}
.al-wa{background:rgba(255,159,10,.1);border:1px solid rgba(255,159,10,.3);color:#ffc94d}
.div{height:1px;background:rgba(255,255,255,0.07);margin:18px 0}
.bitem{display:flex;align-items:center;gap:12px;padding:11px 15px;border-radius:12px;
  background:rgba(255,255,255,0.036);border:1px solid rgba(255,255,255,0.065);
  margin-bottom:7px;font-size:13px;animation:si .35s ease}
@keyframes si{from{transform:translateY(-6px);opacity:0}to{transform:translateY(0);opacity:1}}
.bnum{font-weight:800;color:var(--blue);min-width:52px;font-size:14px}
.bhash{font-family:monospace;font-size:10px;color:var(--t2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lcard{padding:20px;transition:transform .18s,box-shadow .18s}
.lcard:hover{transform:translateY(-4px);box-shadow:0 24px 48px rgba(0,0,0,.55)}
.limg{width:100%;height:150px;border-radius:13px;margin-bottom:14px;
  background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;font-size:52px}
.ltitle{font-weight:700;font-size:15px;margin-bottom:5px}
.ldesc{font-size:12px;color:var(--t2);margin-bottom:12px;line-height:1.55;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lprice{font-size:17px;font-weight:800;color:var(--green)}
.lprice span{font-size:12px;font-weight:400;color:var(--t2)}
.pills{display:flex;gap:3px;background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:4px;margin-bottom:20px}
.pill{flex:1;text-align:center;padding:8px;border-radius:9px;font-size:13px;font-weight:600;
  cursor:pointer;color:var(--t2);transition:all .15s;border:none;background:none;font-family:var(--font)}
.pill.on{background:rgba(255,255,255,0.11);color:var(--t1)}
.pill:hover:not(.on){color:var(--t1)}
.mover{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.75);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  display:flex;align-items:center;justify-content:center;padding:20px;animation:fo .2s ease}
@keyframes fo{from{opacity:0}to{opacity:1}}
.modal{width:100%;max-width:500px;padding:28px;position:relative;max-height:90vh;overflow-y:auto}
.mtitle{font-size:20px;font-weight:800;margin-bottom:20px}
.mclose{position:absolute;top:14px;right:14px;background:rgba(255,255,255,0.08);
  border:none;color:var(--t1);width:30px;height:30px;border-radius:8px;
  cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:background .15s}
.mclose:hover{background:rgba(255,255,255,0.15)}
.wadr{font-family:monospace;font-size:11px;color:var(--t2);word-break:break-all;margin-top:5px;line-height:1.6}
.wbal{font-size:42px;font-weight:900;letter-spacing:-2px;margin:14px 0 3px;
  background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.62) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.camt{font-size:38px;font-weight:900;letter-spacing:-1.5px;
  background:linear-gradient(135deg,var(--green),var(--blue));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:8px 0}
.hero{padding:56px 0 36px;text-align:center}
.htitle{font-size:clamp(34px,6vw,68px);font-weight:900;letter-spacing:-3px;line-height:1.04;
  background:linear-gradient(180deg,#fff 0%,rgba(255,255,255,.42) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:14px}
.hsub{font-size:17px;color:var(--t2);max-width:480px;margin:0 auto 28px;line-height:1.65}
.hbtns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.sp{width:18px;height:18px;border:2px solid rgba(255,255,255,.2);
  border-top-color:currentColor;border-radius:50%;animation:spin .65s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.cbtn{background:none;border:none;cursor:pointer;color:var(--t3);font-size:11px;
  padding:2px 6px;border-radius:4px;transition:all .15s;font-family:var(--font)}
.cbtn:hover{background:rgba(255,255,255,0.07);color:var(--t1)}
.code{background:rgba(0,0,0,.45);border-radius:10px;padding:16px;
  font-family:monospace;font-size:12px;line-height:2;overflow-x:auto;white-space:pre}
.code.gr{color:#65e68b}.code.bl{color:#5dbfff}.code.or{color:#ffc94d}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;
  border-bottom:1px solid rgba(255,255,255,0.055);font-size:13px}
.row:last-child{border-bottom:none}
.row-lbl{color:var(--t2)}.row-val{font-weight:600}
.ticker-wrap{overflow:hidden;border-radius:10px;background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.07);padding:10px 0;margin-bottom:28px}
.ticker{display:flex;gap:40px;animation:tick 25s linear infinite;width:max-content;padding:0 20px}
@keyframes tick{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.tick-item{font-size:12px;font-weight:600;white-space:nowrap;color:var(--t2)}
.tick-item span{color:var(--t1);margin-left:6px}
.pb{height:4px;border-radius:2px;background:rgba(255,255,255,0.07);overflow:hidden;margin-top:6px}
.pf{height:100%;border-radius:2px;background:var(--blue);transition:width .4s}
.catbtn{background:rgba(255,255,255,0.055);border:1px solid rgba(255,255,255,0.09);
  color:var(--t2);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:12px;
  font-weight:600;transition:all .15s;font-family:var(--font)}
.catbtn.on{background:rgba(10,132,255,0.22);border-color:rgba(10,132,255,.45);color:#5dbfff}
.catbtn:hover:not(.on){background:rgba(255,255,255,0.09);color:var(--t1)}
.footer{position:fixed;bottom:0;left:0;right:0;z-index:50;
  background:rgba(0,0,0,.55);border-top:1px solid rgba(255,255,255,0.06);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  height:46px;display:flex;align-items:center;justify-content:center;gap:28px}
.fitem{font-size:11px;color:var(--t3)}
.fitem span{color:var(--t2);font-weight:600}
.node-banner{background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.2);
  border-radius:12px;padding:10px 16px;margin-bottom:16px;
  display:flex;align-items:center;gap:10px;font-size:13px;color:var(--orange)}
`;

// ─────────────────────────────────────────────────────────
//  COMPONENTS
// ─────────────────────────────────────────────────────────

function NodeBanner({ connected }) {
  if (connected) return null;
  return (
    <div className="node-banner">
      <span>⚠️</span>
      <span>Нода офлайн — кошелёк работает без неё, но транзакции требуют запущенного <strong>brt_node.exe</strong></span>
    </div>
  );
}

function Ticker({ info }) {
  const items = [
    ["BRT/USD","$0.0024"],["BRT/BTC","₿0.000000041"],["24h Vol","2.4M BRT"],
    ["Market Cap","$240K"],["Block Height",`#${info?.height??0}`],
    ["Validators",info?.total_validators??0],["Mempool",`${info?.mempool_size??0} tx`],
    ["Total Supply","100M BRT"],
  ];
  return (
    <div className="ticker-wrap">
      <div className="ticker">
        {[...items,...items].map(([k,v],i)=>(
          <div key={i} className="tick-item">{k}<span>{v}</span></div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  HOME
// ─────────────────────────────────────────────────────────
function HomePage({ wallet, balance, nodeInfo, blocks, connected, setPage }) {
  return (
    <div>
      <div className="hero">
        <div className="htitle">Rent Anything.<br/>Pay with BRT.</div>
        <div className="hsub">Decentralized peer-to-peer rental marketplace powered by the BRT blockchain.</div>
        <div className="hbtns">
          <button className="btn bp" onClick={()=>setPage("market")}>Browse Listings</button>
          <button className="btn bgl" onClick={()=>setPage("claim")}>🎁 Get Free BRT</button>
          <button className="btn bgl" onClick={()=>setPage("node")}>Run a Node</button>
        </div>
      </div>
      <Ticker info={nodeInfo}/>
      <div className="g4 sec">
        {[
          {l:"Block Height", v:nodeInfo?`#${nodeInfo.height}`:"—",       s:"Latest confirmed",   c:"var(--blue)"},
          {l:"Validators",   v:nodeInfo?.total_validators??0,            s:"Active nodes",        c:"var(--green)"},
          {l:"Mempool",      v:nodeInfo?.mempool_size??0,                s:"Pending txs",         c:"var(--orange)"},
          {l:"Your Balance", v:balance?`${fmt(balance.balance)} BRT`:wallet?"...":"—",
           s:wallet?(balance?.can_claim?"✓ Claim ready":"⏱ Claimed"):"No wallet", c:"var(--t1)"},
        ].map(s=>(
          <div key={s.l} className="g scard">
            <div className="slbl">{s.l}</div>
            <div className="sval" style={{color:s.c}}>{s.v}</div>
            <div className="ssb">{s.s}</div>
          </div>
        ))}
      </div>
      <div className="sec">
        <div className="stitle">⛓ Live Block Feed</div>
        {!connected && (
          <div className="g" style={{padding:"20px",textAlign:"center",color:"var(--t2)"}}>
            Нода офлайн. Запусти <code style={{color:"var(--orange)"}}>START_NODE.bat</code> для получения блоков в реальном времени.
          </div>
        )}
        {blocks.map((b,i)=>(
          <div key={i} className="bitem">
            <div className="bnum">#{b.index??i}</div>
            <div className="bhash">{b.hash??b.block_hash??"—"}</div>
            <div className="tag tb">{b.tx_count??b.transactions?.length??0} tx</div>
            <div className="tag tg">{b.validator?b.validator.slice(0,8)+"…":"—"}</div>
            <div style={{fontSize:"10px",color:"var(--t3)",whiteSpace:"nowrap"}}>
              {new Date((b.timestamp||0)*1000).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
      <div className="g2 sec">
        <div className="g" style={{padding:"24px"}}>
          <div className="stitle" style={{fontSize:"16px"}}>Как это работает</div>
          {[["🔑","Создай кошелёк","Прямо в браузере, без установок. Приватный ключ только у тебя."],
            ["🎁","Получи BRT","100 BRT бесплатно с фаусета каждые 24 часа."],
            ["🛒","Арендуй вещи","Находи нужные вещи, платишь BRT — 2.5% комиссия платформы."],
            ["📦","Сдавай в аренду","Зарабатывай BRT выставляя свои вещи для аренды."],
          ].map(([icon,title,desc])=>(
            <div key={title} style={{display:"flex",gap:"14px",alignItems:"flex-start",marginBottom:"16px"}}>
              <div style={{fontSize:"22px",flexShrink:0}}>{icon}</div>
              <div><div style={{fontWeight:"700",fontSize:"14px",marginBottom:"3px"}}>{title}</div>
              <div style={{fontSize:"13px",color:"var(--t2)"}}>{desc}</div></div>
            </div>
          ))}
        </div>
        <div className="g" style={{padding:"24px"}}>
          <div className="stitle" style={{fontSize:"16px"}}>Токен BRT</div>
          {[["Тикер","BRT"],["Общий выпуск","100,000,000 BRT"],["Награда за блок","10 BRT"],
            ["Время блока","~5 секунд"],["Минимальный стейк","1,000 BRT"],
            ["Комиссия платформы","2.5%"],["Фаусет","100 BRT / 24ч"],["Консенсус","Proof of Stake"],
          ].map(([k,v])=>(
            <div key={k} className="row"><span className="row-lbl">{k}</span><span className="row-val">{v}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  MARKET
// ─────────────────────────────────────────────────────────
function RentModal({ listing, wallet, connected, onClose, onRefresh }) {
  const [days, setDays]    = useState(1);
  const [loading, setLoad] = useState(false);
  const [msg, setMsg]      = useState(null);
  const rentCost = (listing.price_per_day/DECIMALS)*days;
  const deposit  = listing.deposit/DECIMALS;
  const fee      = rentCost*0.025;
  const total    = rentCost+deposit+fee;

  const doRent = async () => {
    if (!wallet) return setMsg({t:"er",s:"Подключи кошелёк на странице Wallet."});
    if (!connected) return setMsg({t:"er",s:"Нода офлайн. Запусти brt_node.exe."});
    setLoad(true); setMsg(null);
    const r = await api("/listings/rent","POST",{private_key:wallet.private_key,listing_id:listing.listing_id,days});
    setLoad(false);
    if (r.ok) { setMsg({t:"ok",s:`✓ Аренда подтверждена! TX: ${r.result.tx_id.slice(0,18)}…`}); onRefresh?.(); }
    else setMsg({t:"er",s:r.error});
  };

  return (
    <div className="mover" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="g modal">
        <button className="mclose" onClick={onClose}>✕</button>
        <div className="mtitle">{listing.emoji} {listing.title}</div>
        {msg && <div className={`al al-${msg.t==="ok"?"ok":"er"}`}>{msg.s}</div>}
        <div style={{color:"var(--t2)",fontSize:"13px",marginBottom:"16px",lineHeight:"1.6"}}>{listing.description}</div>
        <div className="igrp">
          <div className="ilbl">Дней аренды</div>
          <input className="inp" type="number" min="1" max="30" value={days}
            onChange={e=>setDays(Math.max(1,Math.min(30,parseInt(e.target.value)||1)))}/>
        </div>
        <div className="gs" style={{padding:"15px",marginBottom:"16px"}}>
          {[["Стоимость/день",`${fmt(listing.price_per_day)} BRT`],
            ["Дней",`${days}`],
            ["Аренда",`${rentCost.toFixed(4)} BRT`],
            ["Депозит",`${deposit.toFixed(4)} BRT`],
            ["Комиссия (2.5%)",`${fee.toFixed(4)} BRT`],
          ].map(([k,v])=>(
            <div key={k} className="row"><span className="row-lbl">{k}</span><span>{v}</span></div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",paddingTop:"10px",fontWeight:"800",fontSize:"15px"}}>
            <span>Итого</span><span style={{color:"var(--green)"}}>{total.toFixed(4)} BRT</span>
          </div>
        </div>
        <button className="btn bp bfl" onClick={doRent} disabled={loading}>
          {loading?<><span className="sp"/>Обработка…</>:`Арендовать — ${total.toFixed(2)} BRT`}
        </button>
      </div>
    </div>
  );
}

function MarketPage({ wallet, connected }) {
  const [cat, setCat]    = useState("all");
  const [search, setSrch] = useState("");
  const [modal, setMod]  = useState(null);
  const [listings, setListings] = useState(DEMO_LISTINGS);

  useEffect(()=>{
    if(connected) api("/listings?active=true").then(r=>{if(r.ok&&r.result.length>0)setListings(r.result);});
  },[connected]);

  const filtered = listings.filter(l=>
    (cat==="all"||l.category===cat)&&
    (!search||l.title.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      {modal?.type==="rent" && <RentModal listing={modal.listing} wallet={wallet} connected={connected} onClose={()=>setMod(null)}/>}
      <div className="sec">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"16px"}}>
          <div className="stitle" style={{marginBottom:0}}>🛒 Маркетплейс</div>
          <button className="btn bp bsm" onClick={()=>setMod({type:"create"})}>+ Добавить</button>
        </div>
        <input className="inp" placeholder="Поиск…" value={search} onChange={e=>setSrch(e.target.value)} style={{marginBottom:"14px"}}/>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap",marginBottom:"20px"}}>
          {CATEGORIES.map(c=>(
            <button key={c.id} className={`catbtn ${cat===c.id?"on":""}`} onClick={()=>setCat(c.id)}>
              {c.emoji} {c.label}
            </button>
          ))}
        </div>
        <div className="g3">
          {filtered.map(l=>(
            <div key={l.listing_id} className="g lcard">
              <div className="limg">{l.emoji||"📦"}</div>
              <div style={{display:"flex",gap:"6px",marginBottom:"10px"}}>
                <span className="tag tb">{CATEGORIES.find(c=>c.id===l.category)?.label||l.category}</span>
                <span className={`tag ${l.active?"tg":"tr"}`}>{l.active?"Доступно":"Занято"}</span>
              </div>
              <div className="ltitle">{l.title}</div>
              <div className="ldesc">{l.description}</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginTop:"12px"}}>
                <div>
                  <div className="lprice">{fmt(l.price_per_day)} BRT <span>/ день</span></div>
                  <div style={{fontSize:"11px",color:"var(--t3)"}}>Депозит: {fmt(l.deposit)} BRT</div>
                </div>
                {l.active&&<button className="btn bp bsm" onClick={()=>setMod({type:"rent",listing:l})}>Арендовать</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  CLAIM
// ─────────────────────────────────────────────────────────
function ClaimPage({ wallet, balance, connected, onRefresh }) {
  const [addr, setAddr]    = useState(wallet?.address||"");
  const [loading, setLoad] = useState(false);
  const [msg, setMsg]      = useState(null);
  const [balInfo, setBal]  = useState(null);

  useEffect(()=>{ if(wallet?.address) setAddr(wallet.address); },[wallet?.address]);

  useEffect(()=>{
    if(!addr||addr.length<10||!connected){setBal(null);return;}
    const t=setTimeout(async()=>{
      const r=await api(`/wallet/balance/${addr}`);
      if(r.ok) setBal(r.result);
    },600);
    return()=>clearTimeout(t);
  },[addr,connected]);

  const doClaim = async () => {
    if (!connected) return setMsg({t:"er",s:"Нода офлайн. Запусти brt_node.exe."});
    if (!isValidAddress(addr)) return setMsg({t:"er",s:"Введи корректный BRT-адрес."});
    setLoad(true); setMsg(null);
    const r = await api("/tx/claim","POST",{address:addr});
    setLoad(false);
    if (r.ok) { setMsg({t:"ok",s:`✓ 100 BRT отправлены! TX: ${r.result.tx_id.slice(0,18)}…`}); onRefresh(); }
    else setMsg({t:"er",s:r.error});
  };

  const pct = balInfo&&!balInfo.can_claim ? ((86400-balInfo.claim_cooldown_seconds)/86400)*100 : 100;
  const hrs = balInfo&&!balInfo.can_claim ? Math.ceil(balInfo.claim_cooldown_seconds/3600) : 0;

  return (
    <div>
      <div className="sec">
        <div className="stitle">🎁 Получить BRT токены</div>
        <div className="ssub">Бесплатные BRT с сетевого фаусета. 100 BRT на кошелёк каждые 24 часа.</div>
        {!connected && <div className="al al-wa">⚠️ Нода офлайн — клейм требует запущенный brt_node.exe</div>}
        <div className="g2">
          <div>
            <div className="g" style={{padding:"24px",textAlign:"center",marginBottom:"14px"}}>
              <div className="slbl">Сумма клейма</div>
              <div className="camt">100 BRT</div>
              <div style={{fontSize:"12px",color:"var(--t2)"}}>≈ $0.24 · Раз в 24 часа</div>
              {balInfo&&!balInfo.can_claim&&(
                <div style={{marginTop:"12px"}}>
                  <div style={{fontSize:"12px",color:"var(--orange)",marginBottom:"4px"}}>⏱ Осталось ~{hrs}ч</div>
                  <div className="pb"><div className="pf" style={{width:`${pct}%`,background:"var(--orange)"}}/></div>
                </div>
              )}
              {balInfo?.can_claim && <div style={{marginTop:"10px"}} className="tag tg">✓ Можно клеймить</div>}
            </div>
            {msg && <div className={`al al-${msg.t==="ok"?"ok":"er"}`}>{msg.s}</div>}
            <div className="g" style={{padding:"22px"}}>
              <div className="igrp">
                <div className="ilbl">Адрес кошелька</div>
                <div style={{position:"relative"}}>
                  <input className="inp" placeholder="BRT1..." value={addr} onChange={e=>setAddr(e.target.value)} style={{paddingRight:"90px"}}/>
                  {wallet?.address && (
                    <button className="btn bgl bsm" onClick={()=>setAddr(wallet.address)}
                      style={{position:"absolute",right:"6px",top:"50%",transform:"translateY(-50%)",padding:"4px 8px",fontSize:"11px"}}>
                      Мой
                    </button>
                  )}
                </div>
              </div>
              {balInfo&&(
                <div className="gs" style={{padding:"12px",marginBottom:"14px"}}>
                  <div className="row"><span className="row-lbl">Баланс</span><span className="row-val">{fmt(balInfo.balance)} BRT</span></div>
                  <div className="row"><span className="row-lbl">После клейма</span><span className="row-val" style={{color:"var(--green)"}}>{fmt(balInfo.balance+100*DECIMALS)} BRT</span></div>
                </div>
              )}
              <button className="btn bg2 bfl" onClick={doClaim} disabled={loading||(balInfo&&!balInfo.can_claim)||!addr||!connected}>
                {loading?<><span className="sp"/>Отправка…</>:"Получить 100 BRT →"}
              </button>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
            <div className="g" style={{padding:"22px"}}>
              <div className="stitle" style={{fontSize:"15px",marginBottom:"14px"}}>Как получить</div>
              {[["1","Создай или подключи кошелёк","blue"],
                ["2","Введи адрес или нажми «Мой»","green"],
                ["3","Нажми «Получить 100 BRT»","orange"],
                ["4","Жди ~5с — транзакция попадёт в блок","blue"],
              ].map(([n,t,c])=>(
                <div key={n} style={{display:"flex",gap:"12px",alignItems:"flex-start",marginBottom:"14px"}}>
                  <div style={{minWidth:"26px",height:"26px",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",
                    fontWeight:"800",fontSize:"13px",flexShrink:0,
                    background:`rgba(${c==="blue"?"10,132,255":c==="green"?"48,209,88":"255,159,10"},0.18)`,
                    color:c==="blue"?"#5dbfff":c==="green"?"#65e68b":"#ffc94d"}}>{n}</div>
                  <div style={{fontSize:"13px",color:"var(--t2)",paddingTop:"3px"}}>{t}</div>
                </div>
              ))}
            </div>
            {balance&&(
              <div className="g" style={{padding:"20px"}}>
                <div className="slbl">Твой баланс</div>
                <div style={{fontSize:"26px",fontWeight:"800",marginTop:"4px"}}>{fmt(balance.balance)} BRT</div>
                <div style={{fontSize:"12px",color:"var(--t2)",marginTop:"2px"}}>Стейк: {fmt(balance.stake)} BRT</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  WALLET — полностью клиентский, без ноды
// ─────────────────────────────────────────────────────────
function WalletPage({ wallet, balance, connected, onSave, onClear, onRefresh }) {
  const [tab, setTab]       = useState(wallet?"overview":"import");
  const [pkInput, setPK]    = useState("");
  const [recip, setRecip]   = useState("");
  const [amt, setAmt]       = useState("");
  const [loading, setLoad]  = useState(false);
  const [msg, setMsg]       = useState(null);
  const [showPK, setShowPK] = useState(false);
  const [copiedAddr, setCA] = useState(false);
  const [copiedKey, setCK]  = useState(false);

  useEffect(()=>{ if(wallet) setTab("overview"); else setTab("import"); },[!!wallet]);

  const copy = (text, which) => {
    navigator.clipboard.writeText(text).catch(()=>{});
    which==="key"?(setCK(true),setTimeout(()=>setCK(false),1500)):(setCA(true),setTimeout(()=>setCA(false),1500));
  };

  const createWallet = async () => {
    setLoad(true); setMsg(null);
    try {
      const w = await generateKeyPair();
      onSave(w);
      setMsg({t:"ok",s:"✓ Новый кошелёк создан и сохранён в браузере!"});
      setTab("overview");
    } catch(e) {
      setMsg({t:"er",s:`Ошибка: ${e.message}`});
    }
    setLoad(false);
  };

  const importWallet = async () => {
    if (!pkInput.trim()) return setMsg({t:"er",s:"Введи приватный ключ."});
    setLoad(true); setMsg(null);
    try {
      const w = await importPrivateKey(pkInput.trim());
      onSave(w);
      setMsg({t:"ok",s:"✓ Кошелёк импортирован!"});
      setPK(""); setTab("overview");
    } catch(e) {
      setMsg({t:"er",s:`Неверный приватный ключ: ${e.message}`});
    }
    setLoad(false);
  };

  const sendTx = async () => {
    if (!wallet||!recip||!amt) return;
    if (!connected) return setMsg({t:"er",s:"Нода офлайн. Запусти brt_node.exe."});
    if (!isValidAddress(recip)) return setMsg({t:"er",s:"Неверный адрес получателя."});
    setLoad(true); setMsg(null);
    const r = await api("/tx/transfer","POST",{private_key:wallet.private_key,recipient:recip,amount:amt});
    setLoad(false);
    if (r.ok) { setMsg({t:"ok",s:`✓ TX отправлен! ID: ${r.result.tx_id.slice(0,18)}…`}); onRefresh(); setRecip(""); setAmt(""); }
    else setMsg({t:"er",s:r.error});
  };

  const tabs = wallet
    ? [["overview","Обзор"],["send","Отправить"],["import","Импорт/Создать"]]
    : [["import","Подключить кошелёк"]];

  return (
    <div>
      <div className="sec">
        <div className="stitle">👛 Кошелёк</div>
        <div className="pills">
          {tabs.map(([id,lbl])=>(
            <button key={id} className={`pill ${tab===id?"on":""}`} onClick={()=>{setTab(id);setMsg(null);}}>{lbl}</button>
          ))}
        </div>
        {msg && <div className={`al al-${msg.t==="ok"?"ok":"er"}`}>{msg.s}</div>}

        {/* OVERVIEW */}
        {tab==="overview" && wallet && (
          <div className="g2">
            <div className="g" style={{padding:"26px"}}>
              <div className="slbl">Адрес</div>
              <div className="wadr">
                {wallet.address}
                <button className="cbtn" onClick={()=>copy(wallet.address,"addr")}>{copiedAddr?"✓":"⎘"}</button>
              </div>
              <div className="wbal">{connected&&balance ? fmt(balance.balance) : "—"}</div>
              <div style={{color:"var(--t2)",fontSize:"13px"}}>BRT{!connected&&<span style={{color:"var(--orange)",marginLeft:"8px",fontSize:"11px"}}>• нода офлайн</span>}</div>
              <div className="div"/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"14px"}}>
                <div><div className="slbl">Стейк</div><div style={{fontWeight:"700"}}>{connected&&balance?fmt(balance.stake):"—"} BRT</div></div>
                <div><div className="slbl">Фаусет</div><div style={{fontWeight:"700",color:balance?.can_claim?"var(--green)":"var(--t3)"}}>{!connected?"N/A":balance?.can_claim?"✓ Готово":"⏱ Скоро"}</div></div>
              </div>
              <div className="div"/>
              <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
                <button className="btn bgl bsm" onClick={onRefresh} disabled={!connected}>↻ Обновить</button>
                <button className="btn bgl bsm" onClick={()=>setTab("send")}>↗ Отправить</button>
                <button className="btn bd bsm" onClick={onClear}>Отключить</button>
              </div>
            </div>
            <div className="g" style={{padding:"26px"}}>
              <div className="slbl" style={{marginBottom:"10px"}}>Приватный ключ</div>
              <div style={{background:"rgba(0,0,0,.4)",borderRadius:"9px",padding:"12px",
                fontFamily:"monospace",fontSize:"11px",wordBreak:"break-all",lineHeight:"1.7",color:"var(--t2)"}}>
                {showPK ? wallet.private_key : "•".repeat(Math.min(wallet.private_key?.length||64,64))}
              </div>
              <div style={{display:"flex",gap:"8px",marginTop:"10px"}}>
                <button className="btn bgl bsm" onClick={()=>setShowPK(p=>!p)}>{showPK?"Скрыть":"Показать"}</button>
                <button className="btn bgl bsm" onClick={()=>copy(wallet.private_key,"key")}>{copiedKey?"✓ Скопировано":"Копировать"}</button>
              </div>
              <div className="al al-wa" style={{marginTop:"12px",fontSize:"12px"}}>⚠️ Никому не давай приватный ключ — он даёт полный доступ к кошельку.</div>
            </div>
          </div>
        )}

        {/* SEND */}
        {tab==="send" && wallet && (
          <div style={{maxWidth:"480px"}}>
            {!connected && <div className="al al-wa">Нода офлайн — отправка недоступна.</div>}
            <div className="g" style={{padding:"24px"}}>
              <div className="igrp">
                <div className="ilbl">Адрес получателя</div>
                <input className="inp" placeholder="BRT1…" value={recip} onChange={e=>setRecip(e.target.value)}/>
              </div>
              <div className="igrp">
                <div className="ilbl">Сумма (BRT)</div>
                <input className="inp" type="number" step="0.0001" placeholder="0.0000" value={amt} onChange={e=>setAmt(e.target.value)}/>
              </div>
              {recip&&amt&&Number(amt)>0&&(
                <div className="gs" style={{padding:"13px",marginBottom:"14px"}}>
                  <div className="row"><span className="row-lbl">Сумма</span><span>{amt} BRT</span></div>
                  <div className="row"><span className="row-lbl">Комиссия (0.1%)</span><span>{(Number(amt)*0.001).toFixed(6)} BRT</span></div>
                  <div className="div" style={{margin:"8px 0"}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontWeight:"700"}}>
                    <span>Итого</span><span>{(Number(amt)*1.001).toFixed(6)} BRT</span>
                  </div>
                </div>
              )}
              <button className="btn bp bfl" onClick={sendTx} disabled={loading||!recip||!amt||!connected}>
                {loading?<><span className="sp"/>Отправка…</>:"Отправить BRT →"}
              </button>
              <div style={{fontSize:"12px",color:"var(--t3)",marginTop:"8px"}}>
                Доступно: {connected&&balance?fmt(balance.balance):"—"} BRT
              </div>
            </div>
          </div>
        )}

        {/* IMPORT / CREATE */}
        {tab==="import" && (
          <div className="g2">
            <div className="g" style={{padding:"24px"}}>
              <div style={{fontSize:"15px",fontWeight:"700",marginBottom:"6px"}}>Создать новый кошелёк</div>
              <div style={{fontSize:"13px",color:"var(--t2)",marginBottom:"16px",lineHeight:"1.6"}}>
                Генерируется прямо в браузере через Web Crypto API. Приватный ключ хранится только в твоём браузере — <strong>сохрани его сразу</strong>.
              </div>
              <button className="btn bg2 bfl" onClick={createWallet} disabled={loading}>
                {loading?<><span className="sp"/>Генерация…</>:"🔑 Создать новый кошелёк"}
              </button>
            </div>
            <div className="g" style={{padding:"24px"}}>
              <div style={{fontSize:"15px",fontWeight:"700",marginBottom:"14px"}}>Импорт существующего</div>
              <div className="igrp">
                <div className="ilbl">Приватный ключ (hex)</div>
                <input className="inp" type="password" placeholder="pkcs8 hex…" value={pkInput} onChange={e=>setPK(e.target.value)}/>
              </div>
              <button className="btn bp bfl" onClick={importWallet} disabled={loading||!pkInput}>
                {loading?<><span className="sp"/>Импорт…</>:"Импортировать"}
              </button>
              <div className="al al-in" style={{marginTop:"12px",fontSize:"12px"}}>
                Кошелёк работает без ноды. Для транзакций нужен запущенный brt_node.exe.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  STAKING
// ─────────────────────────────────────────────────────────
function StakingPage({ wallet, balance, connected, onRefresh }) {
  const [stakeAmt, setSA]  = useState("");
  const [loading, setLoad] = useState(false);
  const [msg, setMsg]      = useState(null);

  const doStake = async (type) => {
    if (!wallet||!stakeAmt) return;
    if (!connected) return setMsg({t:"er",s:"Нода офлайн."});
    setLoad(true); setMsg(null);
    const r = await api(type==="stake"?"/tx/stake":"/tx/unstake","POST",{private_key:wallet.private_key,amount:stakeAmt});
    setLoad(false);
    if (r.ok) { setMsg({t:"ok",s:`✓ ${type==="stake"?"Застейкано":"Анстейкано"} ${stakeAmt} BRT!`}); onRefresh(); setSA(""); }
    else setMsg({t:"er",s:r.error});
  };

  const isValidator = balance&&(balance.stake/DECIMALS)>=1000;

  return (
    <div>
      <div className="sec">
        <div className="stitle">🔒 Стейкинг</div>
        <div className="ssub">Стейкай BRT чтобы стать валидатором и получать награды за блоки. Минимум 1,000 BRT.</div>
        {!connected&&<div className="al al-wa">⚠️ Нода офлайн — стейкинг недоступен.</div>}
        <div className="g2">
          <div>
            {msg&&<div className={`al al-${msg.t==="ok"?"ok":"er"}`}>{msg.s}</div>}
            <div className="g" style={{padding:"24px",marginBottom:"14px"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px",marginBottom:"20px"}}>
                <div><div className="slbl">Твой стейк</div>
                  <div className="sval" style={{fontSize:"20px",color:"var(--blue)"}}>{connected&&balance?fmt(balance.stake):"—"} BRT</div></div>
                <div><div className="slbl">Статус</div>
                  <div className="sval" style={{fontSize:"18px",color:isValidator?"var(--green)":"var(--t3)"}}>
                    {!connected?"Офлайн":isValidator?"✓ Валидатор":"Не стейкнут"}</div></div>
              </div>
              <div className="igrp">
                <div className="ilbl">Сумма (BRT)</div>
                <input className="inp" type="number" placeholder="1000" value={stakeAmt} onChange={e=>setSA(e.target.value)}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
                <button className="btn bp" onClick={()=>doStake("stake")} disabled={loading||!wallet||!stakeAmt||!connected}>Стейкнуть</button>
                <button className="btn bgl" onClick={()=>doStake("unstake")} disabled={loading||!wallet||!stakeAmt||!connected}>Анстейк</button>
              </div>
            </div>
          </div>
          <div className="g" style={{padding:"22px"}}>
            <div className="stitle" style={{fontSize:"15px",marginBottom:"14px"}}>Параметры стейкинга</div>
            {[["Награда за блок","10 BRT"],["Время блока","~5 секунд"],
              ["Мин. стейк","1,000 BRT"],["Выбор валидатора","Round-robin PoS"],
              ["Разблокировка","Мгновенно"],["Примерный APY","~18%"],
            ].map(([k,v])=>(
              <div key={k} className="row"><span className="row-lbl">{k}</span><span className="row-val">{v}</span></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  NODE PAGE
// ─────────────────────────────────────────────────────────
function NodePage({ nodeInfo, connected }) {
  return (
    <div>
      <div className="sec">
        <div className="stitle">🖥 Запуск ноды</div>
        <div className="ssub">Скачай и запусти BRT ноду чтобы валидировать блоки и зарабатывать награды.</div>
        <div className="g2" style={{marginBottom:"20px"}}>
          {[
            {l:"HTTP API",   v:"localhost:8545", c:"var(--blue)"},
            {l:"WebSocket",  v:"localhost:8546", c:"var(--green)"},
            {l:"Блок",       v:"~5 секунд",      c:"var(--orange)"},
            {l:"Консенсус",  v:"Proof of Stake", c:"var(--purple)"},
          ].map(s=>(
            <div key={s.l} className="g scard">
              <div className="slbl">{s.l}</div>
              <div style={{fontWeight:"700",fontSize:"14px",color:s.c,marginTop:"4px",fontFamily:"monospace"}}>{s.v}</div>
            </div>
          ))}
        </div>
        <div className="g2">
          <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
            <div className="g" style={{padding:"24px"}}>
              <div style={{fontSize:"15px",fontWeight:"700",marginBottom:"12px"}}>🪟 Windows — через Python</div>
              <div className="code gr">{`1. Установи Python с python.org
   (галочка "Add to PATH"!)
2. Открой папку node/ из архива
3. Двойной клик на START_NODE.bat
4. Нода запустится автоматически`}</div>
            </div>
            <div className="g" style={{padding:"24px"}}>
              <div style={{fontSize:"15px",fontWeight:"700",marginBottom:"12px"}}>📦 Собрать .exe самому</div>
              <div className="code or">{`cd node
pip install pyinstaller
build.bat
→ dist/brt_node.exe`}</div>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
            {nodeInfo&&(
              <div className="g" style={{padding:"22px"}}>
                <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"16px"}}>
                  <span style={{fontWeight:"700",fontSize:"15px"}}>Статус ноды</span>
                  <span className={`tag ${connected?"tg":"tr"}`}>{connected?"● Онлайн":"● Офлайн"}</span>
                </div>
                {Object.entries(nodeInfo).slice(0,8).map(([k,v])=>(
                  <div key={k} className="row">
                    <span className="row-lbl">{k.replace(/_/g," ")}</span>
                    <span className="row-val" style={{fontFamily:"monospace",fontSize:"12px"}}>{String(v).slice(0,30)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="g" style={{padding:"22px"}}>
              <div style={{fontWeight:"700",fontSize:"15px",marginBottom:"14px"}}>API эндпоинты</div>
              {[["GET","/chain/info","Статус цепочки"],["GET","/wallet/balance/:addr","Баланс"],
                ["POST","/wallet/create","Создать кошелёк"],["POST","/tx/transfer","Отправить BRT"],
                ["POST","/tx/claim","Клейм фаусет"],["POST","/tx/stake","Стейкинг"],
                ["GET","/listings","Листинги"],["POST","/listings/rent","Арендовать"],
              ].map(([m,p,d])=>(
                <div key={p} style={{display:"flex",gap:"8px",alignItems:"center",marginBottom:"7px",fontSize:"12px"}}>
                  <span className={`tag ${m==="GET"?"tb":"tg"}`}>{m}</span>
                  <span style={{fontFamily:"monospace",color:"var(--t2)",flex:1}}>{p}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  APP ROOT
// ─────────────────────────────────────────────────────────
const PAGES = [
  {id:"home",l:"Home"},{id:"market",l:"Marketplace"},
  {id:"claim",l:"Claim BRT"},{id:"wallet",l:"Wallet"},
  {id:"staking",l:"Staking"},{id:"node",l:"Node"},
];

export default function App() {
  const [page, setPage] = useState("home");
  const { wallet, balance, nodeOnline, save, clear, refresh } = useWallet();
  const { info, blocks, connected } = useNode();

  return (
    <>
      <style>{CSS}</style>
      <div className="bg">
        <div className="orb o1"/><div className="orb o2"/>
        <div className="orb o3"/><div className="orb o4"/>
      </div>
      <div className="app">
        <nav className="nav">
          <div className="nav-logo">⬡ BRT</div>
          <div className="nav-links">
            {PAGES.map(p=>(
              <button key={p.id} className={`nb ${page===p.id?"on":""}`} onClick={()=>setPage(p.id)}>{p.l}</button>
            ))}
          </div>
          <div className="nav-r">
            <div className={`ndot ${connected?"live":"off"}`}/>
            <span style={{fontSize:"12px",color:"var(--t2)"}}>
              {connected?`Block #${info?.height??0}`:"Node offline"}
            </span>
            {wallet ? (
              <div className="nadr" onClick={()=>setPage("wallet")}>
                {wallet.address.slice(0,6)}…{wallet.address.slice(-4)}
              </div>
            ) : (
              <button className="btn bgl bsm" onClick={()=>setPage("wallet")} style={{fontSize:"12px",padding:"5px 12px"}}>
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
        <main className="main">
          <div className="wrap">
            <NodeBanner connected={connected}/>
            {page==="home"    && <HomePage    wallet={wallet} balance={balance} nodeInfo={info} blocks={blocks} connected={connected} setPage={setPage}/>}
            {page==="market"  && <MarketPage  wallet={wallet} connected={connected}/>}
            {page==="claim"   && <ClaimPage   wallet={wallet} balance={balance} connected={connected} onRefresh={refresh}/>}
            {page==="wallet"  && <WalletPage  wallet={wallet} balance={balance} connected={connected} onSave={save} onClear={clear} onRefresh={refresh}/>}
            {page==="staking" && <StakingPage wallet={wallet} balance={balance} connected={connected} onRefresh={refresh}/>}
            {page==="node"    && <NodePage    nodeInfo={info} connected={connected}/>}
          </div>
        </main>
        <footer className="footer">
          <div className="fitem">Chain <span>brt-mainnet-1</span></div>
          <div className="fitem">Height <span>{info?.height??0}</span></div>
          <div className="fitem">Supply <span>100M BRT</span></div>
          <div className="fitem">Node <span style={{color:connected?"var(--green)":"var(--red)"}}>{connected?"Online":"Offline"}</span></div>
          {wallet && <div className="fitem">Wallet <span style={{color:"var(--green)"}}>✓ Connected</span></div>}
        </footer>
      </div>
    </>
  );
}
