#!/usr/bin/env python3
"""
kaggle_manager.py — Kaggle LLM session manager (run by GitHub Actions)
=====================================================================
The "start/stop" brain. It lives on the GitHub runner (not in the notebook),
so it survives when a Kaggle session dies.

  python kaggle_manager.py start    # push the notebook -> new session
  python kaggle_manager.py ensure   # push only if inside active hours
  python kaggle_manager.py stop     # notification only (notebook self-terminates)
  python kaggle_manager.py status   # best-effort status print

Design notes carried over from the reference project:
  * BLIND PUSH — no status check first. Reading the status of a private
    notebook often throws "Permission denied"; pushing blind avoids it.
  * HUMAN-LIKE TIMING — a randomised delay inside the morning/evening window
    plus small jitter, so starts don't land on the same second every day.
  * A `kaggle kernels push` while a session is already running does NOT restart
    it — the pushed version just sits in the repo. The notebook itself watches
    the repo build and exits when it changes (see the notebook).

Environment (GitHub Secrets):
  KAGGLE_USERNAME, KAGGLE_KEY   Kaggle credentials
  KAGGLE_NOTEBOOK               slug, e.g. "youruser/kaggle-llm-server"
  NTFY_TOPIC                    optional ntfy.sh topic
  TG_BOT_TOKEN, TG_CHAT_ID      optional Telegram
  DELAY_MIN                     optional forced delay (minutes) from the control page
  KAGGLE_FORCE=1                start even outside active hours (manual Start)
"""
import os
import sys
import json
import time
import random
import subprocess
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))

# Active window (IST) and the morning start / evening stop windows.
ACTIVE_START_HOUR = 6
ACTIVE_END_HOUR = 23
START_WINDOW = (6, 0, 6, 30)    # begin h,m -> end h,m
STOP_WINDOW = (22, 30, 23, 0)
MAX_JITTER_MINUTES = 5


def now_ist():
    return datetime.now(IST)


def log(msg):
    print(f"[{now_ist().strftime('%Y-%m-%d %H:%M:%S IST')}] {msg}", flush=True)


def in_window(win):
    now = now_ist()
    b = now.replace(hour=win[0], minute=win[1], second=0, microsecond=0)
    e = now.replace(hour=win[2], minute=win[3], second=0, microsecond=0)
    return b <= now <= e


def in_active_hours():
    return ACTIVE_START_HOUR <= now_ist().hour < ACTIVE_END_HOUR


def random_delay(end_win):
    """Sleep a random slice of the remaining window (up to 80%)."""
    now = now_ist()
    end = now.replace(hour=end_win[2], minute=end_win[3], second=0, microsecond=0)
    remaining = (end - now).total_seconds()
    if remaining <= 0:
        return
    secs = random.uniform(0, remaining * 0.8)
    log(f"Human-like delay: sleeping {secs / 60:.1f} min inside the window")
    time.sleep(secs)


# ------------------------------------------------------------------ notify
def notify(event, extra=""):
    labels = {
        "start": ("Kaggle LLM: starting notebook", "green_circle"),
        "stop": ("Kaggle LLM: stopping notebook", "red_circle"),
        "skip": ("Kaggle LLM: skipped", "fast_forward"),
        "error": ("Kaggle LLM: error", "warning"),
    }
    title, tag = labels.get(event, ("Kaggle LLM", "memo"))
    message = f"{title}\nTime: {now_ist().strftime('%H:%M:%S IST')}"
    if extra:
        message += f"\n{extra}"

    topic = os.environ.get("NTFY_TOPIC", "")
    if topic:
        try:
            req = urllib.request.Request(f"https://ntfy.sh/{topic}",
                                         data=message.encode("utf-8"), method="POST")
            req.add_header("Title", title.encode("ascii", "replace").decode())
            req.add_header("Tags", tag)
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log(f"ntfy error: {e}")

    token = os.environ.get("TG_BOT_TOKEN", "")
    chat = os.environ.get("TG_CHAT_ID", "")
    if token and chat:
        try:
            data = urllib.parse.urlencode({"chat_id": chat, "text": message}).encode()
            urllib.request.urlopen(
                urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                       data=data, method="POST"), timeout=10)
        except Exception as e:
            log(f"Telegram error: {e}")


# ------------------------------------------------------------------ Kaggle
def setup_credentials():
    """Write ~/.kaggle/kaggle.json.

    Accepts EITHER a single KAGGLE_JSON secret (paste the whole contents of the
    kaggle.json you download from Kaggle) OR the two separate values
    KAGGLE_USERNAME + KAGGLE_KEY. KAGGLE_JSON wins if both are present.
    """
    d = os.path.expanduser("~/.kaggle")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "kaggle.json")

    raw = (os.environ.get("KAGGLE_JSON") or "").strip()
    if raw:
        try:
            obj = json.loads(raw)
        except Exception:
            log("ERROR: KAGGLE_JSON is not valid JSON — paste the kaggle.json contents verbatim.")
            sys.exit(1)
        user, key = obj.get("username", ""), obj.get("key", "")
        if not user or not key:
            log("ERROR: KAGGLE_JSON is missing 'username' or 'key'.")
            sys.exit(1)
        with open(p, "w") as f:
            json.dump({"username": user, "key": key}, f)
        os.chmod(p, 0o600)
        log(f"Kaggle credentials written from KAGGLE_JSON for {user}")
        return user

    user = os.environ.get("KAGGLE_USERNAME")
    key = os.environ.get("KAGGLE_KEY")
    if not user or not key:
        log("ERROR: set KAGGLE_JSON (the whole kaggle.json) OR KAGGLE_USERNAME + KAGGLE_KEY.")
        sys.exit(1)
    with open(p, "w") as f:
        json.dump({"username": user, "key": key}, f)
    os.chmod(p, 0o600)
    log(f"Kaggle credentials configured for {user}")
    return user


NOTEBOOK_SLUG = "kaggle-llm-server"
CONFIG_DATASET = "kaggle-llm-config"


def slug(user=None):
    """KAGGLE_NOTEBOOK if set, else '<user>/kaggle-llm-server'."""
    s = os.environ.get("KAGGLE_NOTEBOOK")
    if s:
        return s
    if not user:
        cf = os.path.expanduser("~/.kaggle/kaggle.json")
        if os.path.exists(cf):
            user = json.load(open(cf)).get("username")
    if not user:
        log("ERROR: cannot determine notebook slug (no KAGGLE_NOTEBOOK, no credentials).")
        sys.exit(1)
    return f"{user}/{NOTEBOOK_SLUG}"


def write_kernel_metadata(user):
    """Generate kernel-metadata.json so `kaggle kernels push -p .` works.

    The username is only known at run time (from KAGGLE_JSON), so the metadata
    is generated here rather than committed.
    """
    meta = {
        "id": f"{user}/{NOTEBOOK_SLUG}",
        "title": NOTEBOOK_SLUG,
        "code_file": "kaggle-llm-server.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": "true",
        "enable_gpu": "true",
        "enable_tpu": "false",
        "enable_internet": "true",
        "dataset_sources": [f"{user}/{CONFIG_DATASET}"],
        "competition_sources": [],
        "kernel_sources": [],
        "model_sources": [],
    }
    with open("kernel-metadata.json", "w") as f:
        json.dump(meta, f, indent=2)
    log(f"wrote kernel-metadata.json (id={meta['id']}, dataset={meta['dataset_sources'][0]})")


def kaggle(args):
    log(f">>> kaggle {args}")
    r = subprocess.run(f"kaggle {args}", shell=True, text=True, capture_output=True)
    if r.stdout:
        log(r.stdout.strip())
    if r.stderr:
        log(f"stderr: {r.stderr.strip()}")
    return r


def blind_push():
    """Push without a status check — avoids 'Permission denied' on private notebooks."""
    log("Blind push (no status check)…")
    for attempt in (1, 2):
        r = kaggle("kernels push -p .")
        if r.returncode == 0:
            log("Notebook pushed — a new session is starting.")
            notify("start", "Notebook pushed. Server coming online.")
            return True
        log(f"Push attempt {attempt} failed; retrying in 15s…" if attempt == 1 else "Push failed.")
        if attempt == 1:
            time.sleep(15)
    notify("error", "Failed to push notebook after retry.")
    return False


# ------------------------------------------------------------------ actions
def action_start():
    s = slug()
    force = os.environ.get("KAGGLE_FORCE") == "1"
    delay_min = int(os.environ.get("DELAY_MIN", "0") or "0")

    if not in_active_hours() and not force:
        log(f"Outside active hours ({now_ist().strftime('%H:%M')} IST) — skipping.")
        notify("skip", "Outside active hours.")
        return

    if delay_min > 0:
        log(f"Forced delay from control page: {delay_min} min")
        time.sleep(delay_min * 60)
    elif in_window(START_WINDOW):
        random_delay(START_WINDOW)
    else:
        j = random.randint(0, MAX_JITTER_MINUTES)
        log(f"Adding {j} min jitter")
        time.sleep(j * 60)

    log(f"Starting: {s}")
    notify("start", f"Notebook: {s}")
    blind_push()


def action_stop():
    s = slug()
    if in_window(STOP_WINDOW):
        random_delay(STOP_WINDOW)
    else:
        time.sleep(random.randint(0, MAX_JITTER_MINUTES) * 60)
    log(f"Stopping: {s}")
    notify("stop", f"Notebook: {s} (self-terminates)")
    log("Notebook self-terminates; this is the backup notification.")


def action_ensure():
    if in_active_hours():
        log("In active hours — ensuring the notebook is running.")
        action_start()
    else:
        log("Outside active hours — nothing to ensure.")


def action_status():
    kaggle(f"kernels status {slug()}")


def main():
    if len(sys.argv) < 2:
        print("Usage: kaggle_manager.py <start|stop|ensure|status>")
        sys.exit(1)
    action = sys.argv[1].lower()
    user = setup_credentials()
    write_kernel_metadata(user)
    log(f"=== Kaggle Manager: {action.upper()} ===")
    {"start": action_start, "stop": action_stop,
     "ensure": action_ensure, "status": action_status}.get(action, lambda: log(f"unknown action {action}"))()
    log("=== Done ===")


if __name__ == "__main__":
    main()
