#!/usr/bin/env python3
"""
bootstrap_dataset.py — one-time setup run by GitHub Actions.

  1. writes ~/.kaggle/kaggle.json from the KAGGLE_JSON repo secret
  2. prints the Kaggle username (never the key)
  3. creates/updates a PRIVATE Kaggle dataset holding the runtime config
     (config.env with WORKER_URL, WORKER_SECRET, API_KEY, PANEL_PASS)

Why a dataset and not Kaggle Secrets: the Kaggle API can manage datasets but
cannot set notebook Secrets, so a private dataset is the only config channel
the workflow can fully drive.
"""
import json
import os
import subprocess
import sys

DATASET_TITLE = "kaggle-llm-config"
CONFIG_KEYS = ["WORKER_URL", "WORKER_SECRET", "API_KEY", "PANEL_PASS"]


def env(name, default=""):
    return os.environ.get(name, default)


def run(args):
    print(">>>", " ".join(args), flush=True)
    r = subprocess.run(args, capture_output=True, text=True)
    if r.stdout:
        print(r.stdout[-2000:], flush=True)
    if r.stderr:
        print(r.stderr[-1000:], file=sys.stderr, flush=True)
    return r.returncode


def main():
    raw = env("KAGGLE_JSON").strip()
    if not raw:
        sys.exit("ERROR: KAGGLE_JSON repo secret is not set.")
    try:
        creds = json.loads(raw)
    except Exception:
        sys.exit("ERROR: KAGGLE_JSON is not valid JSON.")
    user, key = creds.get("username", ""), creds.get("key", "")
    if not user or not key:
        sys.exit("ERROR: KAGGLE_JSON missing username/key.")

    d = os.path.expanduser("~/.kaggle")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "kaggle.json")
    with open(p, "w") as f:
        json.dump({"username": user, "key": key}, f)
    os.chmod(p, 0o600)
    print("KAGGLE_USERNAME =", user)

    gh_env = env("GITHUB_ENV")
    if gh_env:
        with open(gh_env, "a") as f:
            f.write(f"KAGGLE_USER={user}\n")

    # build the dataset folder
    os.makedirs("cfg", exist_ok=True)
    with open("cfg/config.env", "w") as f:
        for k in CONFIG_KEYS:
            f.write(f'{k}="{env(k)}"\n')
    with open("cfg/dataset-metadata.json", "w") as f:
        json.dump({"title": DATASET_TITLE, "id": f"{user}/{DATASET_TITLE}",
                   "licenses": [{"name": "CC0-1.0"}]}, f, indent=2)
    ds = f"{user}/{DATASET_TITLE}"
    print("dataset id:", ds)

    if run(["kaggle", "datasets", "files", ds]) != 0:
        print("dataset does not exist -> creating")
        rc = run(["kaggle", "datasets", "create", "-p", "cfg"])
    else:
        print("dataset exists -> new version")
        rc = run(["kaggle", "datasets", "version", "-p", "cfg", "-m", "update config"])

    print("RESULT:", "ok" if rc == 0 else "failed")
    sys.exit(0 if rc == 0 else 1)


if __name__ == "__main__":
    main()
