'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod-' + crypto.randomBytes(8).toString('hex');

// Bot
const PROFIT_DAY_PCT = 0.007;       // 0.7% of capital per day (production)
const TRADES_PER_DAY = 2;            // exactly 2 trades per day per user (production)


// Referral program
const MIN_DEPOSIT_AMOUNT = 50;             // any "deposit" must be ≥ $50 (also the joining minimum)
const MIN_QUALIFYING_DEPOSIT = MIN_DEPOSIT_AMOUNT; // first deposit ≥ $50 fires bonuses
const REFERRER_COMMISSION_PCT = 0.05;      // referrer earns 5% of referee's qualifying deposit
const SIGNUP_BONUS_PCT = 0.05;             // referee gets 5% signup bonus
const REFERRAL_ACHIEVEMENT_BONUS = 10;     // bonus when 3 quality referrals are reached
const REFERRAL_ACHIEVEMENT_COUNT = 3;
const REFERRAL_ACHIEVEMENT_WINDOW_DAYS = 60;
const REFERRAL_WALLET_MIN_PAYOUT = 45;     // min ref-balance to move-to-trading or withdraw

// KYC
const KYC_MAX_IMAGE_BYTES = 800 * 1024;    // ~800 KB per image (data URL)

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const DB_DIR = path.dirname(DB_PATH);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DB_DIR, 'backups');
const RESTORE_STAGING = path.join(DB_DIR, 'restore.pending.db');
const PRE_RESTORE_BAK = DB_PATH + '.pre-restore.bak';
const BACKUP_RETENTION = Number(process.env.BACKUP_RETENTION || 7);
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// Make sure dirs exist before opening the DB
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}

// If a previous /restore upload was staged, swap it in BEFORE opening the DB.
// Validates the SQLite magic header so a bad upload can never replace data silently.
function applyPendingRestore() {
  if (!fs.existsSync(RESTORE_STAGING)) return;
  let header;
  try {
    const fd = fs.openSync(RESTORE_STAGING, 'r');
    header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
  } catch (err) {
    console.warn('[restore] could not read staged file:', err.message);
    return;
  }
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    console.warn('[restore] staged file is not a valid SQLite db — discarding');
    try { fs.unlinkSync(RESTORE_STAGING); } catch {}
    return;
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, PRE_RESTORE_BAK);
    fs.renameSync(RESTORE_STAGING, DB_PATH);
    console.log('[restore] applied staged restore from upload — previous DB saved as', PRE_RESTORE_BAK);
  } catch (err) {
    console.error('[restore] failed to apply staged file:', err.message);
  }
}
applyPendingRestore();
const USDT_PRICE_REFRESH_MS = 60_000;
const USDT_PRICE_FALLBACK = 1.00;
const USDT_MIN_TRADE = 1;          // minimum USD amount for withdraw/add-fund
const USDT_MIN_TRANSFER = 0.01;    // minimum USDT for internal transfer

// ---------- DB setup ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE NOT NULL,
    referred_by INTEGER,
    is_admin INTEGER NOT NULL DEFAULT 0,
    bot_active INTEGER NOT NULL DEFAULT 1,
    day_start_balance REAL NOT NULL DEFAULT 0,
    daily_pnl REAL NOT NULL DEFAULT 0,
    daily_pnl_date TEXT,
    daily_trade_count INTEGER NOT NULL DEFAULT 0,
    wallet_address TEXT,
    deposit_address TEXT,
    usdt_balance REAL NOT NULL DEFAULT 0,
    usdt_address TEXT UNIQUE,
    referral_balance REAL NOT NULL DEFAULT 0,
    bonus_balance REAL NOT NULL DEFAULT 0,
    total_deposits REAL NOT NULL DEFAULT 0,
    qualifying_deposit_at TEXT,
    achievement_paid INTEGER NOT NULL DEFAULT 0,
    mobile_number TEXT,
    kyc_status TEXT NOT NULL DEFAULT 'not_submitted',
    kyc_aadhar_data TEXT,
    kyc_pan_data TEXT,
    kyc_selfie_data TEXT,
    kyc_submitted_at TEXT,
    kyc_reviewed_at TEXT,
    kyc_reject_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    processed_at TEXT,
    txid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO config (key, value) VALUES
    ('deposit_address',  'TGW6jgbjv2o1H1HgJSX9rXVKFYyFBbCWSu'),
    ('deposit_network',  'TRC-20'),
    ('withdraw_fee_early_pct',  '0.25'),
    ('withdraw_fee_normal_pct', '0.20'),
    ('early_window_days',       '60');
  CREATE TABLE IF NOT EXISTS deposit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_usdt REAL NOT NULL,
    deposit_address TEXT NOT NULL,
    txid TEXT,
    screenshot_data TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    reviewed_at TEXT,
    reviewer_email TEXT,
    credited_usd REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS withdraw_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gross_usd REAL NOT NULL,
    fee_pct REAL NOT NULL,
    fee_usd REAL NOT NULL,
    net_usd REAL NOT NULL,
    net_usdt REAL NOT NULL,
    usdt_price REAL NOT NULL,
    to_address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'TRC-20',
    status TEXT NOT NULL DEFAULT 'pending',
    txid TEXT,
    reject_reason TEXT,
    reviewed_at TEXT,
    reviewer_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);
// Migration safety: add new columns to pre-existing DBs
try { db.exec('ALTER TABLE users ADD COLUMN bot_active INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN day_start_balance REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN daily_pnl REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN daily_pnl_date TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN deposit_address TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN usdt_balance REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN usdt_address TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN referral_balance REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN bonus_balance REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN total_deposits REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN qualifying_deposit_at TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN achievement_paid INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN mobile_number TEXT'); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'not_submitted'"); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_aadhar_data TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_pan_data TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_selfie_data TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_submitted_at TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_reviewed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_reject_reason TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN daily_trade_count INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN processed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN txid TEXT'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN usdt_amount REAL'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN counterparty_id INTEGER'); } catch {}
// Config + new request tables (migration-safe for existing DBs)
try { db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); } catch {}
try {
  db.exec(`INSERT OR IGNORE INTO config (key, value) VALUES
    ('deposit_address',  'TGW6jgbjv2o1H1HgJSX9rXVKFYyFBbCWSu'),
    ('deposit_network',  'TRC-20'),
    ('withdraw_fee_early_pct',  '0.25'),
    ('withdraw_fee_normal_pct', '0.20'),
    ('early_window_days',       '60')`);
} catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS deposit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount_usdt REAL NOT NULL,
  deposit_address TEXT NOT NULL, txid TEXT, screenshot_data TEXT,
  status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT,
  reviewed_at TEXT, reviewer_email TEXT, credited_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS withdraw_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  gross_usd REAL NOT NULL, fee_pct REAL NOT NULL, fee_usd REAL NOT NULL,
  net_usd REAL NOT NULL, net_usdt REAL NOT NULL, usdt_price REAL NOT NULL,
  to_address TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'TRC-20',
  status TEXT NOT NULL DEFAULT 'pending', txid TEXT, reject_reason TEXT,
  reviewed_at TEXT, reviewer_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}

function genReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// TRC-20 style deposit address (starts with T, base58 chars)
function genDepositAddress() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let s = 'T';
  for (let i = 0; i < 33; i++) {
    s += charset[crypto.randomInt(0, charset.length)];
  }
  return s;
}

function ensureDepositAddress(userId) {
  const u = db.prepare('SELECT deposit_address FROM users WHERE id = ?').get(userId);
  if (u && !u.deposit_address) {
    let addr;
    for (let i = 0; i < 5; i++) {
      addr = genDepositAddress();
      if (!db.prepare('SELECT id FROM users WHERE deposit_address = ?').get(addr)) break;
    }
    db.prepare('UPDATE users SET deposit_address = ? WHERE id = ?').run(addr, userId);
    return addr;
  }
  return u && u.deposit_address;
}

// Internal USDT receive address — unique per user, used for in-system transfers.
// Different from deposit_address (which tracks external on-chain deposits).
function genUsdtAddress() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let s = 'TQ';
  for (let i = 0; i < 32; i++) {
    s += charset[crypto.randomInt(0, charset.length)];
  }
  return s;
}

function ensureUsdtAddress(userId) {
  const u = db.prepare('SELECT usdt_address FROM users WHERE id = ?').get(userId);
  if (u && !u.usdt_address) {
    let addr;
    for (let i = 0; i < 5; i++) {
      addr = genUsdtAddress();
      if (!db.prepare('SELECT id FROM users WHERE usdt_address = ?').get(addr)) break;
    }
    db.prepare('UPDATE users SET usdt_address = ? WHERE id = ?').run(addr, userId);
    return addr;
  }
  return u && u.usdt_address;
}

// Backfill USDT addresses for any pre-existing user
const _missingUsdt = db.prepare("SELECT id FROM users WHERE usdt_address IS NULL OR usdt_address = ''").all();
for (const row of _missingUsdt) ensureUsdtAddress(row.id);

// Seed default super admin
const ADMIN_EMAIL = 'salman.tra4@gmail.com';
const ADMIN_PASSWORD = 'Secure@123';
const adminRow = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
if (!adminRow) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(`
    INSERT INTO users (email, password_hash, name, balance, referral_code, is_admin)
    VALUES (?, ?, ?, 0, ?, 1)
  `).run(ADMIN_EMAIL, hash, 'Super Admin', 'ADMIN001');
  console.log(`[seed] default admin created: ${ADMIN_EMAIL}`);
}

// ---------- App setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
// No-cache for HTML/JS so users always get the latest UI.
// Hashed third-party assets (CDN'd Tailwind, charts) are still cached by their
// own headers; only our own /app.js and /index.html are forced-fresh.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(html|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// ---------- Helpers ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    mobile_number: u.mobile_number || null,
    balance: Number(u.balance),
    usdt_balance: Number(u.usdt_balance || 0),
    usdt_address: u.usdt_address || null,
    referral_balance: Number(u.referral_balance || 0),  // commission earned by referring
    bonus_balance: Number(u.bonus_balance || 0),        // joining bonus + admin direct credits
    total_deposits: Number(u.total_deposits || 0),
    referral_code: u.referral_code,
    referred_by: u.referred_by,
    is_admin: !!u.is_admin,
    bot_active: !!u.bot_active,
    kyc_status: u.kyc_status || 'not_submitted',
    kyc_submitted_at: u.kyc_submitted_at || null,
    kyc_reviewed_at: u.kyc_reviewed_at || null,
    kyc_reject_reason: u.kyc_reject_reason || null,
    achievement_paid: !!u.achievement_paid,
    created_at: u.created_at,
  };
}

// ---------- Auth routes ----------
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name, referralCode } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  const normEmail = String(email).trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  let referrer = null;
  if (referralCode) {
    referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(String(referralCode).trim().toUpperCase());
    if (!referrer) return res.status(400).json({ error: 'invalid referral code' });
  }

  // Generate unique referral code
  let code;
  for (let i = 0; i < 5; i++) {
    code = genReferralCode();
    if (!db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code)) break;
  }

  const depAddr = genDepositAddress();
  let usdtAddr;
  for (let i = 0; i < 5; i++) {
    usdtAddr = genUsdtAddress();
    if (!db.prepare('SELECT id FROM users WHERE usdt_address = ?').get(usdtAddr)) break;
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, name, balance, referral_code, referred_by, is_admin, bot_active, deposit_address, usdt_address)
    VALUES (?, ?, ?, 0, ?, ?, 0, 1, ?, ?)
  `).run(normEmail, hash, String(name).trim(), code, referrer ? referrer.id : null, depAddr, usdtAddr);

  const newId = result.lastInsertRowid;

  // No instant referral bonus on signup — bonuses fire when referee makes
  // their first qualifying deposit (≥ MIN_QUALIFYING_DEPOSIT). See applyReferralBonuses().

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// ---------- User routes ----------
app.get('/api/me', authRequired, (req, res) => {
  ensureUsdtAddress(req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({
    user: publicUser(user),
    usdt_price: getUsdtPrice(),
  });
});

app.get('/api/me/transactions', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, amount, usdt_amount, note, status, created_at
    FROM transactions WHERE user_id = ?
    ORDER BY id DESC LIMIT 200
  `).all(req.user.id);
  res.json({ transactions: rows });
});

// ---------- Deposits (user submits proof, admin approves) ----------
app.get('/api/deposit-info', authRequired, (_req, res) => {
  res.json({
    address: getConfig('deposit_address'),
    network: getConfig('deposit_network', 'TRC-20'),
    min_usdt: MIN_DEPOSIT_AMOUNT,                       // currently $50
    usdt_price: getUsdtPrice().price,
  });
});

function validProofImage(s) {
  if (typeof s !== 'string') return false;
  if (!s.startsWith('data:image/')) return false;
  if (s.length > KYC_MAX_IMAGE_BYTES) return false;
  return true;
}

app.post('/api/me/deposits', authRequired, (req, res) => {
  const amountUsdt = Number(req.body?.amount_usdt);
  const txid = req.body?.txid ? String(req.body.txid).trim().slice(0, 200) : null;
  const screenshot = req.body?.screenshot;
  if (!Number.isFinite(amountUsdt) || amountUsdt < MIN_DEPOSIT_AMOUNT) {
    return res.status(400).json({ error: `minimum deposit is ${MIN_DEPOSIT_AMOUNT} USDT` });
  }
  if (!validProofImage(screenshot)) {
    return res.status(400).json({ error: 'screenshot required (PNG/JPG, ≤ 600 KB)' });
  }
  const addr = getConfig('deposit_address');
  const network = getConfig('deposit_network', 'TRC-20');
  const r = db.prepare(`
    INSERT INTO deposit_requests (user_id, amount_usdt, deposit_address, txid, screenshot_data)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, +amountUsdt.toFixed(6), addr, txid, screenshot);
  const id = Number(r.lastInsertRowid);
  const created = db.prepare('SELECT created_at FROM deposit_requests WHERE id = ?').get(id);
  const me = db.prepare('SELECT email, name FROM users WHERE id = ?').get(req.user.id);
  res.json({
    ok: true, id,
    receipt: {
      id, type: 'deposit_submitted',
      amount_usdt: +amountUsdt.toFixed(6),
      txid, deposit_address: addr, network,
      usdt_price: usdtPriceCache.price,
      created_at: created?.created_at,
      user_email: me?.email, user_name: me?.name,
    },
  });
});

app.get('/api/me/deposits', authRequired, (req, res) => {
  // Don't return base64 screenshot in the list — too heavy. Just summary fields.
  const rows = db.prepare(`
    SELECT id, amount_usdt, deposit_address, txid, status, reject_reason,
           reviewed_at, credited_usd, created_at
    FROM deposit_requests WHERE user_id = ?
    ORDER BY id DESC LIMIT 100
  `).all(req.user.id);
  res.json({ deposits: rows });
});

// ---------- External withdrawals (Trading USD → user's external TRC-20) ----------
app.get('/api/me/withdraw-info', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const fee = calcWithdrawFee(user);
  res.json({
    ...fee,
    network: 'TRC-20',
    eta_hours: 24,
    kyc_required: true,
    kyc_status: user.kyc_status,
    usdt_price: getUsdtPrice().price,
    available_usd: Number(user.balance) || 0,
  });
});

app.post('/api/me/withdrawals', authRequired, (req, res) => {
  const grossUsd = Number(req.body?.amount_usd);
  const toAddr = String(req.body?.to_address || '').trim();
  if (!Number.isFinite(grossUsd) || grossUsd < 10) {
    return res.status(400).json({ error: 'minimum withdrawal is $10' });
  }
  if (!toAddr || toAddr.length < 25 || toAddr.length > 100) {
    return res.status(400).json({ error: 'invalid TRC-20 address' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.kyc_status !== 'approved') {
    return res.status(403).json({ error: 'complete KYC verification before withdrawing' });
  }
  if (Number(user.balance) < grossUsd - 1e-9) {
    return res.status(400).json({ error: 'insufficient trading balance' });
  }
  const { fee_pct } = calcWithdrawFee(user);
  const feeUsd = +(grossUsd * fee_pct).toFixed(2);
  const netUsd = +(grossUsd - feeUsd).toFixed(2);
  if (netUsd <= 0) return res.status(400).json({ error: 'amount too small after fee' });
  const price  = usdtPriceCache.price;
  const netUsdt = +(netUsd / price).toFixed(6);
  const grossR  = +grossUsd.toFixed(2);

  let newId = null;
  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(grossR, user.id);
    const r = db.prepare(`
      INSERT INTO withdraw_requests
        (user_id, gross_usd, fee_pct, fee_usd, net_usd, net_usdt, usdt_price,
         to_address, network, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TRC-20', 'pending')
    `).run(user.id, grossR, fee_pct, feeUsd, netUsd, netUsdt, price, toAddr);
    newId = Number(r.lastInsertRowid);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const created = db.prepare('SELECT created_at FROM withdraw_requests WHERE id = ?').get(newId);
  res.json({
    user: publicUser(updated),
    request: {
      id: newId,
      gross_usd: grossR, fee_pct, fee_usd: feeUsd, net_usd: netUsd,
      net_usdt: netUsdt, usdt_price: price, to_address: toAddr,
      network: 'TRC-20', status: 'pending', eta_hours: 24,
      created_at: created?.created_at,
      user_email: user.email, user_name: user.name,
    },
  });
});

app.get('/api/me/withdrawals', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, gross_usd, fee_pct, fee_usd, net_usd, net_usdt, usdt_price,
           to_address, network, status, txid, reject_reason, reviewed_at, created_at
    FROM withdraw_requests WHERE user_id = ?
    ORDER BY id DESC LIMIT 100
  `).all(req.user.id);
  res.json({ withdrawals: rows });
});

// ---------- Profile ----------
app.post('/api/me/profile', authRequired, (req, res) => {
  const mobile = String(req.body?.mobile_number || '').trim();
  // Loose validation: 6-20 digits with optional +/spaces — strict format varies by country.
  const cleaned = mobile.replace(/[\s\-()]/g, '');
  if (!/^\+?\d{6,20}$/.test(cleaned)) {
    return res.status(400).json({ error: 'invalid mobile number' });
  }
  db.prepare('UPDATE users SET mobile_number = ? WHERE id = ?').run(cleaned, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// ---------- KYC ----------
function validKycImage(s) {
  if (typeof s !== 'string') return false;
  if (!s.startsWith('data:image/')) return false;
  if (s.length > KYC_MAX_IMAGE_BYTES) return false;
  return true;
}

app.post('/api/me/kyc', authRequired, (req, res) => {
  const { aadhar, pan, selfie, mobile_number } = req.body || {};
  if (!validKycImage(aadhar)) return res.status(400).json({ error: 'invalid Aadhar image (PNG/JPG, ≤ 600 KB)' });
  if (!validKycImage(pan)) return res.status(400).json({ error: 'invalid PAN image (PNG/JPG, ≤ 600 KB)' });
  if (!validKycImage(selfie)) return res.status(400).json({ error: 'invalid selfie image (PNG/JPG, ≤ 600 KB)' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.kyc_status === 'pending') return res.status(400).json({ error: 'KYC already submitted — awaiting review' });
  if (user.kyc_status === 'approved') return res.status(400).json({ error: 'KYC already approved' });

  const mobile = String(mobile_number || user.mobile_number || '').trim().replace(/[\s\-()]/g, '');
  if (!/^\+?\d{6,20}$/.test(mobile)) {
    return res.status(400).json({ error: 'mobile number required for KYC' });
  }

  db.prepare(`
    UPDATE users SET
      mobile_number = ?,
      kyc_aadhar_data = ?, kyc_pan_data = ?, kyc_selfie_data = ?,
      kyc_status = 'pending',
      kyc_submitted_at = datetime('now'),
      kyc_reviewed_at = NULL,
      kyc_reject_reason = NULL
    WHERE id = ?
  `).run(mobile, aadhar, pan, selfie, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(updated) });
});

app.get('/api/me/kyc', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({
    status: user.kyc_status,
    mobile_number: user.mobile_number || null,
    submitted_at: user.kyc_submitted_at,
    reviewed_at: user.kyc_reviewed_at,
    reject_reason: user.kyc_reject_reason,
  });
});

// ---------- Referral / Joining-Bonus wallets (shared logic) ----------
function ensureKycApproved(user) { return user.kyc_status === 'approved'; }

// Map UI wallet type → DB column + transaction prefix.
const WALLETS = {
  commission: { col: 'referral_balance', label: 'referral commission', txMove: 'ref_to_trading',  txWd: 'ref_withdraw' },
  bonus:      { col: 'bonus_balance',    label: 'joining bonus',       txMove: 'bonus_to_trading', txWd: 'bonus_withdraw' },
};

function walletMove(req, res) {
  const cfg = WALLETS[req.params.type];
  if (!cfg) return res.status(400).json({ error: 'invalid wallet type' });
  const amount = Number(req.body?.amount);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const bal = Number(user[cfg.col] || 0);
  if (bal < REFERRAL_WALLET_MIN_PAYOUT) {
    return res.status(400).json({ error: `minimum $${REFERRAL_WALLET_MIN_PAYOUT} required in ${cfg.label} wallet` });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > bal + 1e-9) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  const amt = +Number(amount).toFixed(2);
  withTransaction(() => {
    db.prepare(`UPDATE users SET ${cfg.col} = ${cfg.col} - ?, balance = balance + ? WHERE id = ?`).run(amt, amt, user.id);
    db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)`)
      .run(user.id, cfg.txMove, amt, `Moved $${amt.toFixed(2)} from ${cfg.label} wallet to trading`);
  });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
}

function walletWithdraw(req, res) {
  const cfg = WALLETS[req.params.type];
  if (!cfg) return res.status(400).json({ error: 'invalid wallet type' });
  const amount = Number(req.body?.amount);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (!ensureKycApproved(user)) return res.status(403).json({ error: 'complete KYC verification before withdrawing' });
  const bal = Number(user[cfg.col] || 0);
  if (bal < REFERRAL_WALLET_MIN_PAYOUT) {
    return res.status(400).json({ error: `minimum $${REFERRAL_WALLET_MIN_PAYOUT} required in ${cfg.label} wallet` });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > bal + 1e-9) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  ensureUsdtAddress(user.id);
  const usd = +Number(amount).toFixed(2);
  const price = usdtPriceCache.price;
  const usdt = +(usd / price).toFixed(6);
  withTransaction(() => {
    db.prepare(`UPDATE users SET ${cfg.col} = ${cfg.col} - ?, usdt_balance = usdt_balance + ? WHERE id = ?`).run(usd, usdt, user.id);
    db.prepare(`INSERT INTO transactions (user_id, type, amount, usdt_amount, note) VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, cfg.txWd, -usd, usdt, `Withdrew $${usd.toFixed(2)} ${cfg.label} → ${usdt.toFixed(6)} USDT @ $${price.toFixed(4)}`);
  });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated), usd_withdrawn: usd, usdt_received: usdt });
}

app.post('/api/me/wallet/:type/move-to-trading', authRequired, walletMove);
app.post('/api/me/wallet/:type/withdraw',        authRequired, walletWithdraw);

// Legacy aliases (existing UI / clients may still POST these).
app.post('/api/me/ref/move-to-trading', authRequired, (req, res) => { req.params.type = 'commission'; walletMove(req, res); });
app.post('/api/me/ref/withdraw',        authRequired, (req, res) => { req.params.type = 'commission'; walletWithdraw(req, res); });

// ---------- Referral bonus engine (called on first qualifying deposit) ----------
function applyReferralBonuses(userId, depositAmount) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  if (user.qualifying_deposit_at) return null; // already qualified once
  if (depositAmount < MIN_QUALIFYING_DEPOSIT) return null;

  const events = [];

  // Mark this deposit as the qualifying one
  db.prepare("UPDATE users SET qualifying_deposit_at = datetime('now') WHERE id = ?").run(userId);

  // Joining bonus to the new user (5% of qualifying deposit) → their JOINING BONUS wallet
  const joinBonus = +(depositAmount * SIGNUP_BONUS_PCT).toFixed(2);
  if (joinBonus > 0) {
    db.prepare('UPDATE users SET bonus_balance = bonus_balance + ? WHERE id = ?').run(joinBonus, userId);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, note)
      VALUES (?, 'ref_signup_bonus', ?, ?)
    `).run(userId, joinBonus, `Joining bonus 5% of $${depositAmount.toFixed(2)} qualifying deposit`);
    events.push({ to: userId, kind: 'signup_bonus', amount: joinBonus });
  }

  // Commission to referrer (5% of qualifying deposit) → their referral wallet
  if (user.referred_by) {
    const commission = +(depositAmount * REFERRER_COMMISSION_PCT).toFixed(2);
    if (commission > 0) {
      db.prepare('UPDATE users SET referral_balance = referral_balance + ? WHERE id = ?').run(commission, user.referred_by);
      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, note, counterparty_id)
        VALUES (?, 'ref_commission', ?, ?, ?)
      `).run(user.referred_by, commission, `5% commission from ${user.email} ($${depositAmount.toFixed(2)})`, userId);
      events.push({ to: user.referred_by, kind: 'commission', amount: commission });
    }

    // Achievement: 3 quality referrals (those who hit qualifying deposit)
    // within REFERRAL_ACHIEVEMENT_WINDOW_DAYS of the referrer's signup.
    const referrer = db.prepare('SELECT * FROM users WHERE id = ?').get(user.referred_by);
    if (referrer && !referrer.achievement_paid) {
      const cutoff = `datetime('${referrer.created_at}', '+${REFERRAL_ACHIEVEMENT_WINDOW_DAYS} days')`;
      const qualifiedRefs = db.prepare(`
        SELECT COUNT(*) AS c FROM users
        WHERE referred_by = ? AND qualifying_deposit_at IS NOT NULL
          AND datetime(qualifying_deposit_at) <= ${cutoff}
      `).get(referrer.id).c;
      if (qualifiedRefs >= REFERRAL_ACHIEVEMENT_COUNT) {
        db.prepare('UPDATE users SET referral_balance = referral_balance + ?, achievement_paid = 1 WHERE id = ?')
          .run(REFERRAL_ACHIEVEMENT_BONUS, referrer.id);
        db.prepare(`
          INSERT INTO transactions (user_id, type, amount, note)
          VALUES (?, 'ref_achievement', ?, ?)
        `).run(referrer.id, REFERRAL_ACHIEVEMENT_BONUS, `Achievement: 3 referrals within ${REFERRAL_ACHIEVEMENT_WINDOW_DAYS} days`);
        events.push({ to: referrer.id, kind: 'achievement', amount: REFERRAL_ACHIEVEMENT_BONUS });
      }
    }
  }

  return events;
}

// ---------- Admin · KYC ----------
app.get('/api/admin/kyc', authRequired, adminRequired, (req, res) => {
  const filter = req.query.status || null;
  let rows;
  if (filter) {
    rows = db.prepare(`
      SELECT id, name, email, mobile_number, kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_reject_reason
      FROM users WHERE is_admin = 0 AND kyc_status = ?
      ORDER BY kyc_submitted_at DESC LIMIT 200
    `).all(filter);
  } else {
    rows = db.prepare(`
      SELECT id, name, email, mobile_number, kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_reject_reason
      FROM users WHERE is_admin = 0 AND kyc_status != 'not_submitted'
      ORDER BY
        CASE kyc_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        kyc_submitted_at DESC LIMIT 200
    `).all();
  }
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN kyc_status = 'pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN kyc_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN kyc_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN kyc_status = 'not_submitted' THEN 1 ELSE 0 END) AS not_submitted
    FROM users WHERE is_admin = 0
  `).get();
  res.json({ kyc: rows, counts });
});

app.get('/api/admin/kyc/:userId', authRequired, adminRequired, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({
    user: publicUser(u),
    aadhar: u.kyc_aadhar_data || null,
    pan: u.kyc_pan_data || null,
    selfie: u.kyc_selfie_data || null,
  });
});

app.post('/api/admin/kyc/:userId/approve', authRequired, adminRequired, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.kyc_status !== 'pending') return res.status(400).json({ error: `cannot approve from ${u.kyc_status}` });
  db.prepare(`UPDATE users SET kyc_status='approved', kyc_reviewed_at=datetime('now'), kyc_reject_reason=NULL WHERE id=?`).run(u.id);
  res.json({ ok: true });
});

app.post('/api/admin/kyc/:userId/reject', authRequired, adminRequired, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.kyc_status !== 'pending') return res.status(400).json({ error: `cannot reject from ${u.kyc_status}` });
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : 'Documents could not be verified';
  db.prepare(`UPDATE users SET kyc_status='rejected', kyc_reviewed_at=datetime('now'), kyc_reject_reason=? WHERE id=?`).run(reason, u.id);
  res.json({ ok: true });
});

app.get('/api/me/referrals', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, email, name, created_at
    FROM users WHERE referred_by = ?
    ORDER BY id DESC
  `).all(req.user.id);
  res.json({ referrals: rows });
});


// ---------- Admin routes ----------
app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const users = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id) AS referral_count
    FROM users u
    ORDER BY u.id DESC
  `).all();
  res.json({ users: users.map(u => ({ ...publicUser(u), referral_count: u.referral_count })) });
});

app.get('/api/admin/transactions', authRequired, adminRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.email, u.name
    FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.id DESC LIMIT 500
  `).all();
  res.json({ transactions: rows });
});

app.get('/api/admin/stats', authRequired, adminRequired, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0').get().c;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance),0) as s FROM users WHERE is_admin = 0').get().s;
  const totalUsdt = db.prepare('SELECT COALESCE(SUM(usdt_balance),0) as s FROM users WHERE is_admin = 0').get().s;
  const totalDeposits = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'deposit'").get().s;
  const totalReferralBonus = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'referral_bonus'").get().s;
  const totalAdminCredit = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'admin_credit'").get().s;
  res.json({
    totalUsers,
    totalBalance: Number(totalBalance),
    totalUsdt: Number(totalUsdt),
    totalDeposits: Number(totalDeposits),
    totalReferralBonus: Number(totalReferralBonus),
    totalAdminCredit: Number(totalAdminCredit),
    usdt_price: usdtPriceCache.price,
  });
});

// ---------- Admin · Deposit address config ----------
app.get('/api/admin/config/deposit-address', authRequired, adminRequired, (_req, res) => {
  res.json({
    address: getConfig('deposit_address'),
    network: getConfig('deposit_network', 'TRC-20'),
  });
});

app.post('/api/admin/config/deposit-address', authRequired, adminRequired, (req, res) => {
  const address = String(req.body?.address || '').trim();
  const network = String(req.body?.network || 'TRC-20').trim();
  if (!address || address.length < 20 || address.length > 100) {
    return res.status(400).json({ error: 'invalid address' });
  }
  setConfig('deposit_address', address);
  setConfig('deposit_network', network);
  res.json({ ok: true, address, network });
});

// ---------- Admin · Deposit requests ----------
app.get('/api/admin/deposits', authRequired, adminRequired, (req, res) => {
  const status = req.query.status || null;
  const where = status ? 'AND d.status = ?' : '';
  const args = status ? [status] : [];
  const rows = db.prepare(`
    SELECT d.id, d.user_id, d.amount_usdt, d.deposit_address, d.txid, d.status,
           d.reject_reason, d.reviewed_at, d.reviewer_email, d.credited_usd, d.created_at,
           u.email, u.name
    FROM deposit_requests d JOIN users u ON u.id = d.user_id
    WHERE 1=1 ${where}
    ORDER BY
      CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      d.id DESC
    LIMIT 300
  `).all(...args);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      COUNT(*) AS total
    FROM deposit_requests
  `).get();
  res.json({ deposits: rows, counts });
});

app.get('/api/admin/deposits/:id', authRequired, adminRequired, (req, res) => {
  const row = db.prepare(`
    SELECT d.*, u.email, u.name, u.balance, u.referred_by, u.qualifying_deposit_at
    FROM deposit_requests d JOIN users u ON u.id = d.user_id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ deposit: row });
});

app.post('/api/admin/deposits/:id/approve', authRequired, adminRequired, (req, res) => {
  const dep = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: `already ${dep.status}` });

  const price = usdtPriceCache.price;
  const usd = +(Number(dep.amount_usdt) * price).toFixed(2);
  let bonusEvents = null;
  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance + ?, total_deposits = total_deposits + ? WHERE id = ?')
      .run(usd, usd, dep.user_id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, note)
      VALUES (?, 'deposit', ?, ?)
    `).run(dep.user_id, usd, `Approved deposit · ${Number(dep.amount_usdt).toFixed(6)} USDT @ $${price.toFixed(4)}` + (dep.txid ? ` · TXID ${String(dep.txid).slice(0, 12)}…` : ''));
    db.prepare(`
      UPDATE deposit_requests
      SET status = 'approved', reviewed_at = datetime('now'), reviewer_email = ?, credited_usd = ?
      WHERE id = ?
    `).run(req.user.email, usd, dep.id);
    if (usd >= MIN_QUALIFYING_DEPOSIT) {
      bonusEvents = applyReferralBonuses(dep.user_id, usd);
    }
  });
  res.json({ ok: true, credited_usd: usd, referral_bonuses: bonusEvents });
});

app.post('/api/admin/deposits/:id/reject', authRequired, adminRequired, (req, res) => {
  const dep = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: `already ${dep.status}` });
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : 'Could not verify payment';
  db.prepare(`
    UPDATE deposit_requests
    SET status = 'rejected', reviewed_at = datetime('now'), reviewer_email = ?, reject_reason = ?
    WHERE id = ?
  `).run(req.user.email, reason, dep.id);
  res.json({ ok: true });
});

// ---------- Admin · External withdraw requests ----------
app.get('/api/admin/withdrawals-ext', authRequired, adminRequired, (req, res) => {
  const status = req.query.status || null;
  const where = status ? 'AND w.status = ?' : '';
  const args = status ? [status] : [];
  const rows = db.prepare(`
    SELECT w.*, u.email, u.name, u.balance
    FROM withdraw_requests w JOIN users u ON u.id = w.user_id
    WHERE 1=1 ${where}
    ORDER BY
      CASE w.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      w.id DESC
    LIMIT 300
  `).all(...args);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      COUNT(*) AS total
    FROM withdraw_requests
  `).get();
  res.json({ withdrawals: rows, counts });
});

app.post('/api/admin/withdrawals-ext/:id/approve', authRequired, adminRequired, (req, res) => {
  const w = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `already ${w.status}` });
  const txid = req.body?.txid ? String(req.body.txid).trim().slice(0, 200) : null;
  withTransaction(() => {
    db.prepare(`
      UPDATE withdraw_requests SET status = 'approved', reviewed_at = datetime('now'),
        reviewer_email = ?, txid = ? WHERE id = ?
    `).run(req.user.email, txid, w.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note, status, txid)
      VALUES (?, 'usdt_withdraw', ?, ?, ?, 'success', ?)
    `).run(w.user_id, -w.gross_usd, -w.net_usdt,
      `External withdraw · ${w.net_usdt.toFixed(6)} USDT to ${w.to_address} (${(w.fee_pct * 100).toFixed(0)}% fee)`,
      txid);
  });
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals-ext/:id/reject', authRequired, adminRequired, (req, res) => {
  const w = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `already ${w.status}` });
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : 'Withdrawal rejected';
  withTransaction(() => {
    // Refund the gross amount back to trading balance
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(w.gross_usd, w.user_id);
    db.prepare(`
      UPDATE withdraw_requests SET status = 'rejected', reviewed_at = datetime('now'),
        reviewer_email = ?, reject_reason = ? WHERE id = ?
    `).run(req.user.email, reason, w.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, note)
      VALUES (?, 'admin_credit', ?, ?)
    `).run(w.user_id, w.gross_usd, `Refund · withdrawal rejected (${reason})`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }
  const normEmail = String(email).trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail)) {
    return res.status(409).json({ error: 'email already registered' });
  }
  let code;
  for (let i = 0; i < 5; i++) {
    code = genReferralCode();
    if (!db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code)) break;
  }
  const depAddr = genDepositAddress();
  let usdtAddr;
  for (let i = 0; i < 5; i++) {
    usdtAddr = genUsdtAddress();
    if (!db.prepare('SELECT id FROM users WHERE usdt_address = ?').get(usdtAddr)) break;
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, name, balance, referral_code, is_admin, bot_active, deposit_address, usdt_address)
    VALUES (?, ?, ?, 0, ?, 0, 1, ?, ?)
  `).run(normEmail, hash, String(name).trim(), code, depAddr, usdtAddr);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.json({ user: publicUser(user) });
});

// Admin: credit (or debit) a user's joining-bonus wallet directly.
app.post('/api/admin/users/:id/credit-bonus', authRequired, adminRequired, (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'invalid amount' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const newBal = Number(target.bonus_balance || 0) + amount;
  if (newBal < -1e-9) return res.status(400).json({ error: 'cannot debit below 0' });
  const usd = +Number(amount).toFixed(2);
  const note = req.body?.note || (amount > 0
    ? `Joining-bonus credit by ${req.user.email}`
    : `Joining-bonus debit by ${req.user.email}`);
  withTransaction(() => {
    db.prepare('UPDATE users SET bonus_balance = bonus_balance + ? WHERE id = ?').run(usd, userId);
    db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'bonus_credit', ?, ?)`)
      .run(userId, usd, note);
  });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ user: publicUser(updated) });
});

// Admin: credit (or debit, with negative amount) a user's USDT wallet.
// Used when an off-platform deposit lands or for cash-out reversals.
app.post('/api/admin/users/:id/credit-usdt', authRequired, adminRequired, (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'user not found' });

  const newBal = Number(target.usdt_balance || 0) + amount;
  if (newBal < -1e-9) return res.status(400).json({ error: 'cannot debit below 0' });

  const note = req.body?.note || (amount > 0
    ? `USDT credit by ${req.user.email}`
    : `USDT debit by ${req.user.email}`);
  const usdt = +Number(amount).toFixed(6);

  withTransaction(() => {
    db.prepare('UPDATE users SET usdt_balance = usdt_balance + ? WHERE id = ?').run(usdt, userId);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note)
      VALUES (?, 'admin_credit', 0, ?, ?)
    `).run(userId, usdt, note);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ user: publicUser(updated) });
});

app.post('/api/admin/users/:id/credit', authRequired, adminRequired, (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'user not found' });

  // If marked as deposit (or "txid" provided), log as 'deposit' so it shows naturally to user
  const asDeposit = !!req.body?.as_deposit || !!req.body?.txid;
  if (asDeposit && amount < MIN_DEPOSIT_AMOUNT) {
    return res.status(400).json({ error: `minimum deposit is $${MIN_DEPOSIT_AMOUNT}` });
  }
  const txType = asDeposit ? 'deposit' : 'admin_credit';
  let note = req.body?.note;
  if (asDeposit) {
    const txid = req.body?.txid ? String(req.body.txid).trim() : null;
    note = note || (txid
      ? `On-chain deposit · TXID ${txid.slice(0, 12)}...${txid.slice(-6)}`
      : `Deposit confirmed`);
  } else {
    note = note || `Admin credit by ${req.user.email}`;
  }

  let bonusEvents = null;
  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
    if (asDeposit && amount > 0) {
      db.prepare('UPDATE users SET total_deposits = total_deposits + ? WHERE id = ?').run(amount, userId);
    }
    db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)`)
      .run(userId, txType, amount, note);

    // Fire referral bonuses if this is the user's first qualifying deposit
    if (asDeposit && amount >= MIN_QUALIFYING_DEPOSIT) {
      bonusEvents = applyReferralBonuses(userId, amount);
    }
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ user: publicUser(updated), referral_bonuses: bonusEvents });
});

// ---------- Admin · Withdrawals ----------
app.get('/api/admin/withdrawals', authRequired, adminRequired, (req, res) => {
  const status = req.query.status || null;
  let rows;
  if (status) {
    rows = db.prepare(`
      SELECT t.*, u.email, u.name, u.wallet_address, u.balance, u.usdt_balance
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.type IN ('withdrawal', 'usdt_withdraw') AND t.status = ?
      ORDER BY t.id DESC LIMIT 300
    `).all(status);
  } else {
    rows = db.prepare(`
      SELECT t.*, u.email, u.name, u.wallet_address, u.balance, u.usdt_balance
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.type IN ('withdrawal', 'usdt_withdraw')
      ORDER BY
        CASE t.status WHEN 'pending' THEN 0 WHEN 'success' THEN 1 ELSE 2 END,
        t.id DESC
      LIMIT 300
    `).all();
  }
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      COUNT(*) AS total
    FROM transactions WHERE type IN ('withdrawal', 'usdt_withdraw')
  `).get();
  res.json({ withdrawals: rows, counts });
});

app.post('/api/admin/withdrawals/:id/approve', authRequired, adminRequired, (req, res) => {
  const wd = db.prepare("SELECT * FROM transactions WHERE id = ? AND type IN ('withdrawal', 'usdt_withdraw')").get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'not found' });
  if (wd.status !== 'pending') return res.status(400).json({ error: `already ${wd.status}` });
  const txid = req.body?.txid ? String(req.body.txid).trim() : null;
  db.prepare(`UPDATE transactions SET status = 'success', processed_at = datetime('now'), txid = ? WHERE id = ?`)
    .run(txid, wd.id);
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals/:id/reject', authRequired, adminRequired, (req, res) => {
  const wd = db.prepare("SELECT * FROM transactions WHERE id = ? AND type IN ('withdrawal', 'usdt_withdraw')").get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'not found' });
  if (wd.status !== 'pending') return res.status(400).json({ error: `already ${wd.status}` });

  // Refund: USD withdrawals use 'amount' (negative); USDT withdrawals use 'usdt_amount' (negative).
  // Subtracting a negative refunds the balance.
  if (wd.type === 'usdt_withdraw') {
    db.prepare('UPDATE users SET usdt_balance = usdt_balance - ? WHERE id = ?').run(Number(wd.usdt_amount) || 0, wd.user_id);
  } else {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(wd.amount, wd.user_id);
  }
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : null;
  db.prepare(`UPDATE transactions SET status = 'rejected', processed_at = datetime('now'), note = COALESCE(?, note) WHERE id = ?`)
    .run(reason ? `Rejected: ${reason}` : null, wd.id);
  res.json({ ok: true });
});

app.get('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'not found' });
  const transactions = db.prepare(`
    SELECT id, type, amount, note, created_at FROM transactions
    WHERE user_id = ? ORDER BY id DESC LIMIT 200
  `).all(userId);
  const referrals = db.prepare(`
    SELECT id, email, name, created_at FROM users WHERE referred_by = ?
  `).all(userId);
  res.json({ user: publicUser(user), transactions, referrals });
});

// ---------- USDT / USD Price (live, cached) ----------
const usdtPriceCache = {
  price: USDT_PRICE_FALLBACK,
  fetchedAt: 0,
  source: 'fallback',
};

async function refreshUsdtPrice() {
  // CoinGecko: simple price endpoint, no auth, free tier
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd',
      { signal: ctrl.signal, headers: { 'accept': 'application/json' } }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error('coingecko ' + res.status);
    const data = await res.json();
    const p = Number(data?.tether?.usd);
    if (Number.isFinite(p) && p > 0.5 && p < 2.0) {
      usdtPriceCache.price = p;
      usdtPriceCache.fetchedAt = Date.now();
      usdtPriceCache.source = 'coingecko';
    }
  } catch {
    // silent — keep last good price
  }
}

function getUsdtPrice() {
  return {
    price: Number(usdtPriceCache.price.toFixed(6)),
    fetched_at: usdtPriceCache.fetchedAt,
    source: usdtPriceCache.source,
    age_ms: Date.now() - usdtPriceCache.fetchedAt,
  };
}

// kick off immediately, then periodically
refreshUsdtPrice();
setInterval(refreshUsdtPrice, USDT_PRICE_REFRESH_MS);

app.get('/api/usdt/price', (_req, res) => {
  res.json(getUsdtPrice());
});

// ---------- USDT · Buy / Sell / Send / Withdraw ----------
function round2(n) { return +Number(n).toFixed(2); }
function round6(n) { return +Number(n).toFixed(6); }

// ---------- Config (admin-mutable runtime settings) ----------
function getConfig(key, fallback = null) {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setConfig(key, value) {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// Account-age based fee — within `early_window_days` it's `early_pct`, else `normal_pct`.
function calcWithdrawFee(user) {
  const earlyDays = Number(getConfig('early_window_days', '60')) || 60;
  const earlyPct  = Number(getConfig('withdraw_fee_early_pct',  '0.25')) || 0.25;
  const normalPct = Number(getConfig('withdraw_fee_normal_pct', '0.20')) || 0.20;
  // Compute days since account creation in UTC.
  const createdMs = Date.parse((user.created_at || '').replace(' ', 'T') + 'Z');
  const ageDays   = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 86400000 : 9999;
  const isEarly   = ageDays < earlyDays;
  return { fee_pct: isEarly ? earlyPct : normalPct, is_early: isEarly, age_days: +ageDays.toFixed(1), early_window_days: earlyDays };
}

// node:sqlite DatabaseSync has no transaction() helper — emulate one.
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

// Withdraw to USDT Wallet (Trading USD → Platform USDT). Requires KYC approved.
app.post('/api/usdt/buy', authRequired, (req, res) => {
  const usd = Number(req.body?.usd_amount);
  if (!Number.isFinite(usd) || usd < USDT_MIN_TRADE) {
    return res.status(400).json({ error: `minimum amount is $${USDT_MIN_TRADE}` });
  }
  if (usd > 1_000_000) return res.status(400).json({ error: 'amount too large' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.kyc_status !== 'approved') {
    return res.status(403).json({ error: 'complete KYC verification before withdrawing to wallet' });
  }
  if (Number(user.balance) < usd) return res.status(400).json({ error: 'insufficient USD balance' });

  ensureUsdtAddress(user.id);

  const price = usdtPriceCache.price;
  const usdt = round6(usd / price);
  const note = `Buy ${usdt.toFixed(6)} USDT @ $${price.toFixed(4)}`;

  let txId = null;
  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance - ?, usdt_balance = usdt_balance + ? WHERE id = ?')
      .run(round2(usd), usdt, user.id);
    const r = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note)
      VALUES (?, 'usdt_buy', ?, ?, ?)
    `).run(user.id, -round2(usd), usdt, note);
    txId = Number(r.lastInsertRowid);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const tx = db.prepare('SELECT created_at FROM transactions WHERE id = ?').get(txId);
  res.json({
    user: publicUser(updated), price, usdt_received: usdt,
    receipt: {
      id: txId, type: 'usdt_buy',
      usd_paid: round2(usd), usdt_received: usdt, price,
      usdt_address: updated.usdt_address || null,
      created_at: tx?.created_at,
      user_email: user.email, user_name: user.name,
    },
  });
});

// Sell USDT for USD balance
app.post('/api/usdt/sell', authRequired, (req, res) => {
  const usdt = Number(req.body?.usdt_amount);
  if (!Number.isFinite(usdt) || usdt < USDT_MIN_TRANSFER) {
    return res.status(400).json({ error: `minimum sell is ${USDT_MIN_TRANSFER} USDT` });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (Number(user.usdt_balance) < usdt - 1e-9) {
    return res.status(400).json({ error: 'insufficient USDT balance' });
  }

  const price = usdtPriceCache.price;
  const usd = round2(usdt * price);
  if (usd <= 0) return res.status(400).json({ error: 'amount too small' });
  const note = `Sell ${usdt.toFixed(6)} USDT @ $${price.toFixed(4)}`;

  let txId = null;
  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance + ?, usdt_balance = usdt_balance - ? WHERE id = ?')
      .run(usd, round6(usdt), user.id);
    const r = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note)
      VALUES (?, 'usdt_sell', ?, ?, ?)
    `).run(user.id, usd, -round6(usdt), note);
    txId = Number(r.lastInsertRowid);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const tx = db.prepare('SELECT created_at FROM transactions WHERE id = ?').get(txId);
  res.json({
    user: publicUser(updated), price, usd_received: usd,
    receipt: {
      id: txId, type: 'usdt_sell',
      usdt_paid: round6(usdt), usd_received: usd, price,
      created_at: tx?.created_at,
      user_email: user.email, user_name: user.name,
    },
  });
});

// User-to-user transfers are disabled by design. Internal USDT stays in
// each user's wallet — no on-platform transfer between users.

// ---------- Admin · Backup & Migration ----------
// Hot, consistent SQLite snapshot. VACUUM INTO produces a checkpointed copy
// even while the bot is mid-write — safe to download and restore elsewhere.
function makeSnapshot(targetPath) {
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

function listSnapshots() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const p = path.join(BACKUP_DIR, f);
        const st = fs.statSync(p);
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

function rotateSnapshots() {
  const snaps = listSnapshots();
  // Keep the newest BACKUP_RETENTION; only auto-rotate files we created (snapshot- prefix)
  const auto = snaps.filter(s => s.name.startsWith('snapshot-'));
  for (const old of auto.slice(BACKUP_RETENTION)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch {}
  }
}

function autoSnapshotFilename() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `snapshot-${ts}.db`;
}

function takeAutoSnapshot() {
  const name = autoSnapshotFilename();
  const target = path.join(BACKUP_DIR, name);
  try {
    makeSnapshot(target);
    rotateSnapshots();
    console.log('[backup] daily snapshot created:', name);
    return name;
  } catch (err) {
    console.error('[backup] snapshot failed:', err.message);
    return null;
  }
}

// Take one immediately on boot if no snapshot exists yet, then daily.
if (listSnapshots().length === 0) takeAutoSnapshot();
setInterval(takeAutoSnapshot, BACKUP_INTERVAL_MS);

// Live download — generates a fresh hot snapshot, streams it, deletes the temp.
app.get('/api/admin/backup/download', authRequired, adminRequired, (req, res) => {
  const tmp = path.join(BACKUP_DIR, `download-${Date.now()}.tmp.db`);
  try {
    makeSnapshot(tmp);
  } catch (err) {
    return res.status(500).json({ error: 'snapshot failed: ' + err.message });
  }
  const stat = fs.statSync(tmp);
  const filename = `quantedge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', stat.size);
  const stream = fs.createReadStream(tmp);
  stream.pipe(res);
  stream.on('close', () => { try { fs.unlinkSync(tmp); } catch {} });
  stream.on('error', () => { try { fs.unlinkSync(tmp); } catch {} });
});

// Save a snapshot to disk on demand (manual checkpoint before risky operations).
app.post('/api/admin/backup/snapshot', authRequired, adminRequired, (req, res) => {
  const name = takeAutoSnapshot();
  if (!name) return res.status(500).json({ error: 'snapshot failed' });
  res.json({ ok: true, name });
});

// List snapshots on disk + DB stats.
app.get('/api/admin/backup/list', authRequired, adminRequired, (req, res) => {
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_PATH).size; } catch {}
  res.json({
    db_path: DB_PATH,
    db_size: dbSize,
    backup_dir: BACKUP_DIR,
    retention: BACKUP_RETENTION,
    pending_restore: fs.existsSync(RESTORE_STAGING),
    snapshots: listSnapshots(),
  });
});

// Restore: upload .db file as raw octet-stream. We DON'T swap the live DB at runtime
// (lock-prone, risky). Instead the file is staged and applied on next server restart.
app.post('/api/admin/backup/restore',
  authRequired, adminRequired,
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) {
      return res.status(400).json({ error: 'no file received' });
    }
    if (buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      return res.status(400).json({ error: 'not a valid SQLite database file' });
    }
    try {
      fs.writeFileSync(RESTORE_STAGING, buf);
    } catch (err) {
      return res.status(500).json({ error: 'write failed: ' + err.message });
    }
    res.json({
      ok: true,
      staged: RESTORE_STAGING,
      size: buf.length,
      note: 'Restart the server to apply. The previous DB will be saved as ' + path.basename(PRE_RESTORE_BAK),
    });
  }
);

// Delete a specific snapshot file (only inside BACKUP_DIR, only .db).
app.delete('/api/admin/backup/:name', authRequired, adminRequired, (req, res) => {
  const name = path.basename(String(req.params.name));
  if (!name.endsWith('.db')) return res.status(400).json({ error: 'invalid name' });
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(p); } catch (err) { return res.status(500).json({ error: err.message }); }
  res.json({ ok: true });
});

// ---------- Bot (algo trading simulator) ----------
const SYMBOLS = ['EUR/USD', 'BTC/USD', 'GOLD', 'ETH/USD', 'GBP/USD', 'NAS100', 'XAU/USD', 'AAPL'];
const BOT_MIN_PNL = 0.05;

app.get('/api/me/bot/trades', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, amount, note, created_at
    FROM transactions WHERE user_id = ? AND type = 'bot_trade'
    ORDER BY id DESC LIMIT 30
  `).all(req.user.id);
  res.json({ trades: rows });
});

// Trade history with period summaries (daily / weekly / monthly / yearly / lifetime)
const PERIOD_FILTERS = {
  daily:    "AND date(created_at) = date('now')",
  weekly:   "AND datetime(created_at) >= datetime('now', '-7 days')",
  monthly:  "AND datetime(created_at) >= datetime('now', '-30 days')",
  yearly:   "AND datetime(created_at) >= datetime('now', '-365 days')",
  lifetime: '',
};

app.get('/api/me/bot/history', authRequired, (req, res) => {
  const period = String(req.query.period || 'daily').toLowerCase();
  if (!(period in PERIOD_FILTERS)) {
    return res.status(400).json({ error: 'invalid period (daily|weekly|monthly|yearly|lifetime)' });
  }

  // All-period summaries computed in one pass (each is a fast indexed query
  // on a small per-user trade set).
  const summaries = {};
  for (const [p, where] of Object.entries(PERIOD_FILTERS)) {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(amount), 0)            AS pnl,
        SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS losses,
        COUNT(*)                            AS count
      FROM transactions
      WHERE user_id = ? AND type = 'bot_trade' ${where}
    `).get(req.user.id);
    const wins = Number(row.wins) || 0;
    const losses = Number(row.losses) || 0;
    const total = wins + losses;
    summaries[p] = {
      pnl: +Number(row.pnl).toFixed(2),
      wins,
      losses,
      count: Number(row.count) || 0,
      win_rate: total > 0 ? +(100 * wins / total).toFixed(1) : null,
    };
  }

  // Trades for the selected period (most recent 200)
  const where = PERIOD_FILTERS[period];
  const trades = db.prepare(`
    SELECT id, amount, note, created_at
    FROM transactions
    WHERE user_id = ? AND type = 'bot_trade' ${where}
    ORDER BY id DESC LIMIT 200
  `).all(req.user.id);

  res.json({ period, summaries, trades });
});

app.get('/api/me/bot/status', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const today = new Date().toISOString().slice(0, 10);
  const dailyPnl = (user.daily_pnl_date === today) ? Number(user.daily_pnl) : 0;
  const tradeCount = (user.daily_pnl_date === today) ? Number(user.daily_trade_count || 0) : 0;
  const effectiveStart = Math.max(1, Number(user.balance) - dailyPnl);

  const targetPnl = +(effectiveStart * PROFIT_DAY_PCT).toFixed(2);
  res.json({
    mode: 'profit',
    is_profit_day: true,
    target_pct: PROFIT_DAY_PCT,
    target_pnl: targetPnl,
    daily_pnl: dailyPnl,
    day_start_balance: effectiveStart,
    trades_per_day: TRADES_PER_DAY,
    daily_trade_count: tradeCount,
    progress_pct: targetPnl !== 0 ? Math.max(0, Math.min(100, (dailyPnl / targetPnl) * 100)) : 0,
  });
});

function botTick() {
  const today = new Date().toISOString().slice(0, 10);

  // Only users who haven't been booked today yet — at start-of-day we credit
  // the full PROFIT_DAY_PCT immediately as 2 quick back-to-back trades.
  const dueUsers = db.prepare(`
    SELECT id, balance, email
    FROM users
    WHERE bot_active = 1 AND is_admin = 0 AND balance > 0.5
      AND (daily_pnl_date IS NULL OR daily_pnl_date != ?)
  `).all(today);
  if (dueUsers.length === 0) return;

  const insertTx = db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'bot_trade', ?, ?)`);
  const finalize  = db.prepare(`
    UPDATE users SET balance = balance + ?, daily_pnl = ?, daily_trade_count = ?, daily_pnl_date = ?
    WHERE id = ?
  `);

  for (const u of dueUsers) {
    const start = Math.max(1, Number(u.balance));
    const target = +(start * PROFIT_DAY_PCT).toFixed(2);
    if (target < BOT_MIN_PNL) continue;
    // Split into 2 trades with 40-60% randomness so the feed reads naturally.
    const portion = 0.40 + Math.random() * 0.20;
    const t1 = +(target * portion).toFixed(2);
    const t2 = +(target - t1).toFixed(2);

    for (const pnl of [t1, t2]) {
      const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
      insertTx.run(u.id, pnl, `${side} ${symbol} TP hit`);
    }
    finalize.run(target, target, TRADES_PER_DAY, today, u.id);
  }
}
// Tick every 15 seconds — booking is once per user per day, but we want
// freshly-credited / newly-deposited users to see profit fast.
setInterval(botTick, 15_000);
botTick();

// PWA manifest — lets users "install" the site as an app on iOS/Android home screens.
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: 'QuantEdge',
    short_name: 'QuantEdge',
    description: 'Algorithmic trading platform',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0e17',
    theme_color: '#0a0e17',
    icons: [
      {
        src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMGEwZTE3Ii8+PHBhdGggZD0iTTI0IDg4bDMyLTMyIDIwIDIwIDM2LTM2IiBmaWxsPSJub25lIiBzdHJva2U9IiMyMmQzYTciIHN0cm9rZS13aWR0aD0iOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+',
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMGEwZTE3Ii8+PHBhdGggZD0iTTI0IDg4bDMyLTMyIDIwIDIwIDM2LTM2IiBmaWxsPSJub25lIiBzdHJva2U9IiMyMmQzYTciIHN0cm9rZS13aWR0aD0iOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Algo Trading Platform`);
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  Admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}\n`);
});
