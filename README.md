# parcels-tracker-bot

Telegram bot for parcel tracking via Track123.

## Features

- `/track <tracking_number> [carrier:code] [label]`
- `/status [tracking_number] [carrier_code]`
- `/list`
- `/untrack <tracking_number> [carrier_code]`
- Auto polling updates to Telegram
- Auto remove watch entries when parcel reaches terminal status
- Auto delete tracking from Track123 on terminal status and `/untrack` (when carrier is known)
- Access control with `ALLOWED_USER_IDS`
- UTF-8 labels (for example: `/track SPXVN064584367312 áo cho mập`)

## Required Environment Variables

- `TELEGRAM_BOT_TOKEN`
- `TRACK123_API_SECRET`
- `ALLOWED_USER_IDS` (comma-separated Telegram user IDs)

Example:

```env
TELEGRAM_BOT_TOKEN=123456:abc
TRACK123_API_SECRET=your_track123_secret
ALLOWED_USER_IDS=123456789,987654321
```

## Optional Environment Variables

- `TRACK123_BASE_URL` default: `https://api.track123.com/gateway/open-api`
- `DB_PATH` default: `./data/bot.db` (JSON store file; Docker image sets `/data/bot.db`)
- `TIMEZONE` default: `UTC` (example: `Asia/Ho_Chi_Minh`)
- `POLL_INTERVAL_SECONDS` default: `300`
- `TRACK123_MAX_RPS` default: `2`
- `TRACK123_MAX_CONCURRENCY` default: `2`
- `LOG_LEVEL` default: `info`

## Local Run

```bash
npm install
npm run build
npm start
```

## Track Command Examples

```bash
/track SPXVN064584367312 áo cho mập
/track SPXVN064584367312 carrier:SPXVN áo cho mập
/status
/status SPXVN064584367312
```

## Docker Run

Use a mount path so tracked data survives container restarts.

```bash
docker run -d --name parcels-tracker-bot \
  -e TELEGRAM_BOT_TOKEN=... \
  -e TRACK123_API_SECRET=... \
  -e ALLOWED_USER_IDS=123456789 \
  -v parcels_bot_data:/data \
  ghcr.io/foxy1402/parcels-tracker-bot:latest
```

Image:

- `ghcr.io/foxy1402/parcels-tracker-bot:latest`

## Kubernetes Storage (Important)

This image stores watch data at `DB_PATH=/data/bot.db` by default.

If your platform says "Add Storage", set mount path to:

- `/data`

Without mounting `/data`, your tracked parcel list will be lost on pod/container restart.

If `/data` is mounted but you get `EACCES: permission denied, open '/data/bot.db.tmp'`,
your volume permissions do not allow the container user to write.

This image now handles restricted platforms automatically:

- It tries to use `DB_PATH` (default `/data/bot.db`).
- If not writable, it auto-falls back to `/tmp/bot.db` so the bot still starts.

Important:

- `/tmp/bot.db` is non-persistent (data resets on restart).
- For persistence, storage at `/data` must be writable.

## GitHub Actions -> GHCR

Workflow file: `.github/workflows/docker-publish.yml`

On push to `main` or tags `v*`, image is pushed as:

`ghcr.io/foxy1402/parcels-tracker-bot:latest`
