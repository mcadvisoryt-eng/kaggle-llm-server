# Kaggle LLM — auto-managed server with a password-protected control page

Run a >8B model on Kaggle's free GPU, keep it alive on a schedule, Start/Stop it
from a web page, and point Open WebUI at a URL that never changes.

```
                         ┌──────────────────────────────┐
   you ── password ──────►│   Cloudflare Worker          │
   (control page)         │   • password gate            │
                          │   • Start → GitHub enable+   │
                          │     dispatch                 │
                          │   • Stop  → session stop +   │
                          │     GitHub disable           │
   Open WebUI ── /v1 ────►│   • /v1 → live tunnel        │
                          └───────────┬──────────────────┘
                                      │ GitHub API
                          ┌───────────▼──────────────────┐
                          │  GitHub Actions (cron)       │
                          │  kaggle_manager.py: blind    │
                          │  push + random delay + ntfy  │
                          └───────────┬──────────────────┘
                                      │ kaggle kernels push
                          ┌───────────▼──────────────────┐
                          │  Kaggle kernel (GPU)         │
                          │  Ollama + FastAPI panel      │
                          │  cloudflared tunnel → Worker │
                          │  self-terminates at ~9.5 h   │
                          └──────────────────────────────┘
```

## Files and where they go

| File | Goes to |
|---|---|
| `worker.js` | Cloudflare Worker (paste into the dashboard or `wrangler deploy`) |
| `kaggle-schedule.yml` | `.github/workflows/kaggle-schedule.yml` |
| `kaggle_manager.py` | repo root |
| `kaggle-llm-server.ipynb` | imported into Kaggle as your notebook |

## How Start / Stop actually behave

- **Start** → the Worker calls `PUT .../workflows/kaggle-schedule.yml/enable`, then
  `POST .../dispatches` with `{action: "start", delay_min}`. The workflow runs
  `kaggle_manager.py start`, which waits out the random delay and blind-pushes the
  notebook. *Enable must come first — GitHub refuses to dispatch a disabled
  workflow (422).*
- **Stop** → the Worker asks the live session to shut down
  (`POST <tunnel>/admin/stop`), then `PUT .../disable`. Disabling is what stops the
  cron from booting it again — nothing re-enables it automatically.

## Setup

### 1. The repo
Create a repo, add `.github/workflows/kaggle-schedule.yml`, `kaggle_manager.py`,
and import `kaggle-llm-server.ipynb` into Kaggle (File → Import notebook).

### 2. Kaggle credentials + notebook slug
Kaggle → Account → **Create New API Token** (gives `KAGGLE_USERNAME` and
`KAGGLE_KEY`). Your notebook slug is `youruser/your-notebook-title`.

### 3. GitHub repo secrets
Settings → Secrets and variables → Actions:
`KAGGLE_USERNAME`, `KAGGLE_KEY`, `KAGGLE_NOTEBOOK`, and optionally `NTFY_TOPIC`,
`TG_BOT_TOKEN`, `TG_CHAT_ID`.

### 4. The Cloudflare Worker
1. Dashboard → Workers & Pages → Create Worker → paste `worker.js` → Deploy.
2. Create a **KV namespace** (e.g. `kaggle_llm`) and bind it to the Worker as
   `TUNNEL_KV`.
3. Add variables/secrets:
   - `GITHUB_TOKEN` (secret) — a **fine-grained PAT**: *Actions: Read and write*
     and *Contents: Read* on **just this repo**.
   - `GITHUB_REPO` — `youruser/yourrepo`
   - `WORKFLOW_FILE` — `kaggle-schedule.yml`
   - `GITHUB_REF` — `main`
   - `PANEL_PASS` (secret) — your control-page password
   - `WORKER_SECRET` (secret) — any long random string
   - `API_KEY` (secret) — the bearer key Open WebUI will send
   - `NTFY_TOPIC` (optional)

### 5. Kaggle notebook secrets
In the notebook: Add-ons → Secrets → add `WORKER_URL`
(`https://<your-worker>.workers.dev`) and `WORKER_SECRET` (same value as the Worker).

### 6. Use it
- Open `https://<your-worker>.workers.dev/`, log in, press **Start**.
- Open WebUI → Settings → Admin → Connections → Add Connection → Standard/Compatible:
  - API URL `https://<your-worker>.workers.dev/v1`
  - API Key = your `API_KEY`
- Subscribe to the ntfy topic for start/stop pushes.

## Notes / gotchas

- **Change `PANEL_PASS` and `API_KEY`** in the notebook config cell (and matching
  Worker secrets). The ntfy topic is randomised on purpose.
- **Cache the model.** Models under `/kaggle/working` vanish when the session ends.
  Save `ollama-models` as a Kaggle Dataset, attach it as input, and point
  `OLLAMA_MODELS` at the dataset path — otherwise every session re-downloads ~9 GB.
- **GPU type:** the Kaggle API can't choose it, so a headless push may land on a
  P100 instead of T4 x2. Select the accelerator once in the browser if it matters.
- **60-day auto-disable:** GitHub disables scheduled workflows in a public repo
  after 60 days with no activity — harmless here (re-enabling resets it).
- **This pattern is against Kaggle's acceptable-use policy** ("server farming /
  activity unrelated to ML data science"). Treat it as a personal test rig.
