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

## Railway deployment

1. Connect this repo on https://railway.com
2. Service auto-deploys via Nixpacks (Node 22)
3. Add a **Volume** mounted at `/data` and set env `DB_PATH=/data/data.db`
4. Set `JWT_SECRET` to a long random string
5. Railway provides `PORT` automatically

The bot tick keeps running while the dyno is up; the SQLite file on the volume survives restarts.
