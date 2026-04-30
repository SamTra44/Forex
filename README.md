# QuantEdge — Algo Trading Platform

Node.js platform with simulated algo bot, referral system, and integrated USDT wallet (buy/sell/internal-transfer/external-withdraw).

## Local run

```bash
npm install
npm start
```

Opens on `http://localhost:5000`. Default admin login (change in production):

- Email: `salman.tra4@gmail.com`
- Password: `Secure@123`

## Stack

- Node 22.5+ with built-in `node:sqlite` (no native build)
- Express + JWT auth
- Tailwind via CDN, vanilla JS frontend
- Live USDT/USD price from CoinGecko (60s cache)
- Live BTC/ETH/etc. candles from Binance public WS

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `JWT_SECRET` | random per boot | **Set this in production** |
| `DB_PATH` | `./data.db` | Use a persistent volume on Railway |
| `BACKUP_DIR` | `<dir of DB_PATH>/backups` | Where daily snapshots live |
| `BACKUP_RETENTION` | `7` | How many auto snapshots to keep |

## Backup & Migration (host-agnostic)

The Admin Console has a **Backup & Migration** tab that lets you:

- **Download** a hot, consistent SQLite snapshot anytime (uses `VACUUM INTO` so it's safe while the bot is mid-write).
- **Snapshot to volume** — write a timestamped copy to `BACKUP_DIR`. Daily auto-snapshots run for free; the oldest beyond retention are pruned.
- **Restore from file** — upload any `.db` file, the server validates the SQLite header and stages it. On the **next restart** the live DB is swapped in (the previous DB is preserved as `data.db.pre-restore.bak`).

### Move from Railway to any other host
1. Open Admin Console → Backup & Migration → **Download .db file**.
2. On the new host, set `DB_PATH=/path/on/new/host/data.db` and place the downloaded file at exactly that path. Start the server.
3. Done — every user, balance, transaction, USDT address, and referral graph comes with you.

Alternative (no SSH): boot the new host empty, log in as admin, upload the `.db` via the UI, restart. Same result.

## Railway deployment

1. Connect this repo on https://railway.com
2. Service auto-deploys via Nixpacks (Node 22)
3. Add a **Volume** mounted at `/data` and set env `DB_PATH=/data/data.db`
4. Set `JWT_SECRET` to a long random string
5. Railway provides `PORT` automatically

The bot tick keeps running while the dyno is up; the SQLite file on the volume survives restarts.
