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
const REFERRAL_BONUS = 20;
const PROFIT_DAY_PCT = 0.01;       // 1% daily profit cap
const LOSS_DAY_PCT = -0.005;       // 0.5% loss day (rare)
const HARD_CAP_MULTIPLIER = 1.4;   // brief excursion up to 1.4x target before strong mean reversion
const PLATFORM_DEPOSIT_ADDRESS = 'TGW6jgbjv2o1H1HgJSX9rXVKFYyFBbCWSu';
const PLATFORM_NETWORK = 'TRC-20';
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
const USDT_MIN_TRADE = 1;          // minimum USD amount for buy/sell
const USDT_MIN_TRANSFER = 0.01;    // minimum USDT for transfer/withdraw
const USDT_WITHDRAW_FEE_PCT = 0.01; // 1% network fee on external USDT withdrawal

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
    wallet_address TEXT,
    deposit_address TEXT,
    usdt_balance REAL NOT NULL DEFAULT 0,
    usdt_address TEXT UNIQUE,
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
try { db.exec("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN processed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN txid TEXT'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN usdt_amount REAL'); } catch {}
try { db.exec('ALTER TABLE transactions ADD COLUMN counterparty_id INTEGER'); } catch {}

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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    balance: Number(u.balance),
    usdt_balance: Number(u.usdt_balance || 0),
    usdt_address: u.usdt_address || null,
    referral_code: u.referral_code,
    referred_by: u.referred_by,
    is_admin: !!u.is_admin,
    bot_active: !!u.bot_active,
    wallet_address: u.wallet_address || null,
    deposit_address: u.deposit_address || null,
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

  // Credit referral bonus
  if (referrer) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(REFERRAL_BONUS, referrer.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, note)
      VALUES (?, 'referral_bonus', ?, ?)
    `).run(referrer.id, REFERRAL_BONUS, `Referral signup: ${normEmail}`);
  }

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
    deposit_address: PLATFORM_DEPOSIT_ADDRESS,
    network: PLATFORM_NETWORK,
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

app.get('/api/me/referrals', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, email, name, created_at
    FROM users WHERE referred_by = ?
    ORDER BY id DESC
  `).all(req.user.id);
  res.json({ referrals: rows });
});

app.post('/api/me/deposit', authRequired, (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  if (amount > 1_000_000) {
    return res.status(400).json({ error: 'amount too large' });
  }
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, req.user.id);
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, note)
    VALUES (?, 'deposit', ?, ?)
  `).run(req.user.id, amount, req.body?.note || 'USD deposit');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/me/wallet', authRequired, (req, res) => {
  const wallet = String(req.body?.wallet_address || '').trim();
  if (wallet.length < 8 || wallet.length > 200) {
    return res.status(400).json({ error: 'invalid wallet address' });
  }
  db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?').run(wallet, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/me/withdraw', authRequired, (req, res) => {
  const amount = Number(req.body?.amount);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (!user.wallet_address) {
    return res.status(400).json({ error: 'add a withdrawal wallet address first' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  const maxAllowed = +(Number(user.balance) * 0.10).toFixed(2);
  if (amount > maxAllowed + 0.001) {
    return res.status(400).json({ error: `daily withdrawal limit is 10% of balance ($${maxAllowed.toFixed(2)})` });
  }
  if (amount > Number(user.balance)) {
    return res.status(400).json({ error: 'insufficient balance' });
  }
  // One withdrawal per day (any status counts)
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare(`
    SELECT id FROM transactions
    WHERE user_id = ? AND type = 'withdrawal'
      AND status IN ('pending', 'success')
      AND substr(created_at, 1, 10) = ?
    LIMIT 1
  `).get(req.user.id, today);
  if (existing) {
    return res.status(400).json({ error: 'only one withdrawal per day is allowed' });
  }

  // Deduct balance immediately, mark request as pending
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, req.user.id);
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, note, status)
    VALUES (?, 'withdrawal', ?, ?, 'pending')
  `).run(req.user.id, -amount, `Withdrawal to ${user.wallet_address}`);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(updated) });
});

app.get('/api/me/withdraw/status', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const today = new Date().toISOString().slice(0, 10);
  const todays = db.prepare(`
    SELECT id, amount, note, created_at FROM transactions
    WHERE user_id = ? AND type = 'withdrawal' AND substr(created_at, 1, 10) = ?
    ORDER BY id DESC LIMIT 1
  `).get(req.user.id, today);
  const maxAllowed = +(Number(user.balance) * 0.10).toFixed(2);
  res.json({
    max_withdrawal: maxAllowed,
    used_today: !!todays,
    todays_withdrawal: todays || null,
    wallet_address: user.wallet_address || null,
    balance: Number(user.balance),
  });
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
  const txType = asDeposit ? 'deposit' : 'admin_credit';
  let note = req.body?.note;
  if (asDeposit) {
    const txid = req.body?.txid ? String(req.body.txid).trim() : null;
    note = note || (txid
      ? `On-chain deposit · TXID ${txid.slice(0, 12)}...${txid.slice(-6)}`
      : `Deposit confirmed to ${target.deposit_address || 'wallet'}`);
  } else {
    note = note || `Admin credit by ${req.user.email}`;
  }

  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
  db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)`)
    .run(userId, txType, amount, note);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ user: publicUser(updated) });
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

// Buy USDT with USD balance
app.post('/api/usdt/buy', authRequired, (req, res) => {
  const usd = Number(req.body?.usd_amount);
  if (!Number.isFinite(usd) || usd < USDT_MIN_TRADE) {
    return res.status(400).json({ error: `minimum buy is $${USDT_MIN_TRADE}` });
  }
  if (usd > 1_000_000) return res.status(400).json({ error: 'amount too large' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (Number(user.balance) < usd) return res.status(400).json({ error: 'insufficient USD balance' });

  ensureUsdtAddress(user.id);

  const price = usdtPriceCache.price;
  const usdt = round6(usd / price);
  const note = `Buy ${usdt.toFixed(6)} USDT @ $${price.toFixed(4)}`;

  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance - ?, usdt_balance = usdt_balance + ? WHERE id = ?')
      .run(round2(usd), usdt, user.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note)
      VALUES (?, 'usdt_buy', ?, ?, ?)
    `).run(user.id, -round2(usd), usdt, note);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated), price, usdt_received: usdt });
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

  withTransaction(() => {
    db.prepare('UPDATE users SET balance = balance + ?, usdt_balance = usdt_balance - ? WHERE id = ?')
      .run(usd, round6(usdt), user.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note)
      VALUES (?, 'usdt_sell', ?, ?, ?)
    `).run(user.id, usd, -round6(usdt), note);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated), price, usd_received: usd });
});

// Send USDT to another user (internal — instant)
app.post('/api/usdt/send', authRequired, (req, res) => {
  const usdt = Number(req.body?.usdt_amount);
  const toAddr = String(req.body?.to_address || '').trim();
  if (!toAddr || toAddr.length < 10) return res.status(400).json({ error: 'invalid recipient address' });
  if (!Number.isFinite(usdt) || usdt < USDT_MIN_TRANSFER) {
    return res.status(400).json({ error: `minimum transfer is ${USDT_MIN_TRANSFER} USDT` });
  }

  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!sender) return res.status(404).json({ error: 'not found' });
  ensureUsdtAddress(sender.id);

  const recipient = db.prepare('SELECT * FROM users WHERE usdt_address = ?').get(toAddr);
  if (!recipient) return res.status(404).json({ error: 'recipient not found in this system' });
  if (recipient.id === sender.id) return res.status(400).json({ error: 'cannot send to your own address' });

  if (Number(sender.usdt_balance) < usdt - 1e-9) {
    return res.status(400).json({ error: 'insufficient USDT balance' });
  }

  const amt = round6(usdt);
  const senderNote = `Sent ${amt.toFixed(6)} USDT to ${recipient.email}`;
  const recvNote = `Received ${amt.toFixed(6)} USDT from ${sender.email}`;

  withTransaction(() => {
    db.prepare('UPDATE users SET usdt_balance = usdt_balance - ? WHERE id = ?').run(amt, sender.id);
    db.prepare('UPDATE users SET usdt_balance = usdt_balance + ? WHERE id = ?').run(amt, recipient.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note, counterparty_id)
      VALUES (?, 'usdt_send', 0, ?, ?, ?)
    `).run(sender.id, -amt, senderNote, recipient.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note, counterparty_id)
      VALUES (?, 'usdt_receive', 0, ?, ?, ?)
    `).run(recipient.id, amt, recvNote, sender.id);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(sender.id);
  res.json({
    user: publicUser(updated),
    sent_to: { name: recipient.name, email: recipient.email, address: recipient.usdt_address },
    amount: amt,
  });
});

// Withdraw USDT to external crypto wallet — pending, processed within 24h
app.post('/api/usdt/withdraw', authRequired, (req, res) => {
  const usdt = Number(req.body?.usdt_amount);
  const toAddr = String(req.body?.to_address || '').trim();
  const network = String(req.body?.network || 'TRC-20').trim().toUpperCase();
  if (!toAddr || toAddr.length < 10 || toAddr.length > 200) {
    return res.status(400).json({ error: 'invalid external wallet address' });
  }
  if (!['TRC-20', 'ERC-20', 'BEP-20'].includes(network)) {
    return res.status(400).json({ error: 'unsupported network' });
  }
  if (!Number.isFinite(usdt) || usdt < USDT_MIN_TRANSFER) {
    return res.status(400).json({ error: `minimum withdrawal is ${USDT_MIN_TRANSFER} USDT` });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });

  // Don't let a user withdraw to one of OUR internal addresses via the external path
  const internalMatch = db.prepare('SELECT id FROM users WHERE usdt_address = ?').get(toAddr);
  if (internalMatch) {
    return res.status(400).json({ error: 'this is an internal address — use Send USDT instead' });
  }

  if (Number(user.usdt_balance) < usdt - 1e-9) {
    return res.status(400).json({ error: 'insufficient USDT balance' });
  }

  const amt = round6(usdt);
  const fee = round6(amt * USDT_WITHDRAW_FEE_PCT);
  const netAmount = round6(amt - fee);
  if (netAmount <= 0) return res.status(400).json({ error: 'amount too small after fee' });

  const note = `Withdraw ${amt.toFixed(6)} USDT to ${toAddr} (${network}) · fee ${fee.toFixed(6)}`;

  withTransaction(() => {
    db.prepare('UPDATE users SET usdt_balance = usdt_balance - ? WHERE id = ?').run(amt, user.id);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, usdt_amount, note, status)
      VALUES (?, 'usdt_withdraw', 0, ?, ?, 'pending')
    `).run(user.id, -amt, note);
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({
    user: publicUser(updated),
    requested: amt,
    fee,
    net_amount: netAmount,
    eta_hours: 24,
  });
});

// Lookup recipient by USDT internal address (so UI can preview before sending)
app.get('/api/usdt/lookup', authRequired, (req, res) => {
  const addr = String(req.query.address || '').trim();
  if (!addr) return res.status(400).json({ error: 'address required' });
  const u = db.prepare('SELECT id, name, email, usdt_address FROM users WHERE usdt_address = ?').get(addr);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({
    found: true,
    name: u.name,
    email: u.email,
    address: u.usdt_address,
    is_self: u.id === req.user.id,
  });
});

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
const BOT_TICK_MS = 2500;
const BOT_MIN_PNL = 0.5;
const BOT_MAX_PNL = 50;

app.get('/api/me/bot/trades', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, amount, note, created_at
    FROM transactions WHERE user_id = ? AND type = 'bot_trade'
    ORDER BY id DESC LIMIT 30
  `).all(req.user.id);
  res.json({ trades: rows });
});

// Deterministic-by-day pseudo-random: same day → same outcome across the platform.
function dayHash(day, salt) {
  let h = ((day | 0) * 2654435761 ^ (salt * 1664525)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}

const BOOM_PROBABILITY = 0.12;        // ~12% of days are boom days (~1 in 8)
const BOOM_MIN_PCT = 0.10;            // boom day target: 10–20%
const BOOM_MAX_PCT = 0.20;
const RECOVERY_MIN_USD = 10;          // recovery loss: $10–$20 (capped at 5% of balance)
const RECOVERY_MAX_USD = 20;
const RECOVERY_BAL_CAP_PCT = 0.05;
const NORMAL_LOSS_PROBABILITY = 0.18; // ~18% of normal days are loss days

function computeDayTarget(effectiveStart) {
  const dayNum = Math.floor(Date.now() / 86400000);

  const isBoomToday = dayHash(dayNum, 1) < BOOM_PROBABILITY;
  const wasBoomYesterday = !isBoomToday && dayHash(dayNum - 1, 1) < BOOM_PROBABILITY;

  if (isBoomToday) {
    const pct = BOOM_MIN_PCT + dayHash(dayNum, 2) * (BOOM_MAX_PCT - BOOM_MIN_PCT);
    const targetPnl = +(effectiveStart * pct).toFixed(2);
    return { mode: 'boom', isProfitDay: true, target_pct: pct, targetPnl };
  }
  if (wasBoomYesterday) {
    const baseUsd = RECOVERY_MIN_USD + dayHash(dayNum, 3) * (RECOVERY_MAX_USD - RECOVERY_MIN_USD);
    const cappedUsd = Math.max(0.5, Math.min(baseUsd, effectiveStart * RECOVERY_BAL_CAP_PCT));
    const targetPnl = -+cappedUsd.toFixed(2);
    const pct = effectiveStart > 0 ? targetPnl / effectiveStart : 0;
    return { mode: 'recovery', isProfitDay: false, target_pct: pct, targetPnl };
  }
  const isProfitDay = dayHash(dayNum, 4) >= NORMAL_LOSS_PROBABILITY;
  const pct = isProfitDay ? PROFIT_DAY_PCT : LOSS_DAY_PCT;
  const targetPnl = +(effectiveStart * pct).toFixed(2);
  return { mode: isProfitDay ? 'profit' : 'loss', isProfitDay, target_pct: pct, targetPnl };
}

app.get('/api/me/bot/status', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const today = new Date().toISOString().slice(0, 10);
  const dailyPnl = (user.daily_pnl_date === today) ? Number(user.daily_pnl) : 0;
  const effectiveStart = Math.max(1, Number(user.balance) - dailyPnl);
  const { mode, isProfitDay, target_pct, targetPnl } = computeDayTarget(effectiveStart);
  res.json({
    mode,
    is_profit_day: isProfitDay,
    target_pct,
    target_pnl: targetPnl,
    daily_pnl: dailyPnl,
    day_start_balance: effectiveStart,
    progress_pct: targetPnl !== 0 ? Math.max(0, Math.min(100, (dailyPnl / targetPnl) * 100)) : 0,
  });
});

function botTick() {
  const today = new Date().toISOString().slice(0, 10);

  const activeUsers = db.prepare(`
    SELECT id, balance, daily_pnl, daily_pnl_date
    FROM users WHERE bot_active = 1 AND is_admin = 0 AND balance > 0.5
  `).all();
  if (activeUsers.length === 0) return;

  const resetDay = db.prepare(`UPDATE users SET daily_pnl = 0, daily_pnl_date = ? WHERE id = ?`);
  const updateBalanceAndPnl = db.prepare(`UPDATE users SET balance = balance + ?, daily_pnl = daily_pnl + ? WHERE id = ?`);
  const insertTx = db.prepare(`INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'bot_trade', ?, ?)`);

  for (const u of activeUsers) {
    let dailyPnl = Number(u.daily_pnl) || 0;

    if (u.daily_pnl_date !== today) {
      dailyPnl = 0;
      resetDay.run(today, u.id);
    }

    const effectiveStart = Math.max(1, Number(u.balance) - dailyPnl);
    const { isProfitDay, targetPnl } = computeDayTarget(effectiveStart);

    // Overshoot ratio: how far daily_pnl has drifted relative to target
    // 0 = at target, +1 = at 2x target, -1 = at 0 (or opposite of target)
    const targetAbs = Math.max(0.5, Math.abs(targetPnl));
    const dist = (dailyPnl - targetPnl) / targetAbs; // negative = below profit target

    // Direction probability with mean reversion
    let upProbability;
    if (isProfitDay) {
      if (dist > 0.4) upProbability = 0.10;       // above target: strong negative
      else if (dist > 0.1) upProbability = 0.30;
      else if (dist < -0.6) upProbability = 0.85; // way below: push up
      else if (dist < -0.2) upProbability = 0.70;
      else upProbability = 0.55;                   // near target: slight up
    } else {
      // Loss day: target is negative; invert
      if (dist < -0.4) upProbability = 0.85;       // below loss target (further loss): push up
      else if (dist < -0.1) upProbability = 0.65;
      else if (dist > 0.6) upProbability = 0.20;   // above (less loss): push down
      else if (dist > 0.2) upProbability = 0.35;
      else upProbability = 0.45;
    }

    const direction = Math.random() < upProbability ? 1 : -1;

    // Trade magnitude: scaled to target so ~5-10 trades can swing the daily PnL by full target
    const baseMag = Math.max(0.5, Math.abs(targetPnl) / 6);
    let magnitude = baseMag * (0.3 + Math.random() * 1.5);
    // 8% chance of bigger swing (2-4x base) for excitement
    if (Math.random() < 0.08) magnitude *= 2 + Math.random() * 2;
    // Per-trade cap scales with target so boom days (10-20%) actually reach their target
    const dynamicMax = Math.max(BOT_MAX_PNL, Math.abs(targetPnl) * 0.5);
    magnitude = Math.max(BOT_MIN_PNL, Math.min(dynamicMax, magnitude));
    magnitude = +magnitude.toFixed(2);

    let pnl = +(direction * magnitude).toFixed(2);

    // Hard cap: don't allow daily_pnl to exceed 1.4x target in profit direction
    const projected = dailyPnl + pnl;
    if (Math.sign(targetPnl) > 0 && projected > targetPnl * HARD_CAP_MULTIPLIER && pnl > 0) {
      pnl = -Math.abs(pnl);
    } else if (Math.sign(targetPnl) < 0 && projected < targetPnl * HARD_CAP_MULTIPLIER && pnl < 0) {
      pnl = Math.abs(pnl);
    }

    // Don't go below $1 balance
    if (pnl < 0 && Math.abs(pnl) > Number(u.balance) - 1) {
      pnl = -(Number(u.balance) - 1);
      pnl = +pnl.toFixed(2);
    }
    if (Math.abs(pnl) < 0.01) continue;

    const win = pnl >= 0;
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
    const note = `${side} ${symbol} ${win ? 'TP hit' : 'SL hit'}`;

    updateBalanceAndPnl.run(pnl, pnl, u.id);
    insertTx.run(u.id, pnl, note);
  }
}
setInterval(botTick, BOT_TICK_MS);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Algo Trading Platform`);
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  Admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}\n`);
});
