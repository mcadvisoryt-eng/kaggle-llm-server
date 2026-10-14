#!/usr/bin/env python3
"""Fetch the Kaggle kernel status + latest log, for debugging the session."""
import json
import os
import subprocess
import sys


def sh(a):
    r = subprocess.run(a, capture_output=True, text=True)
    print(">>>", " ".join(a), "-> rc", r.returncode, flush=True)
    if r.stdout:
        print(r.stdout[-2500:], flush=True)
    if r.stderr:
        print(r.stderr[-1000:], file=sys.stderr, flush=True)
    return r


def main():
    d = json.loads(os.environ["KAGGLE_JSON"])
    user = d["username"]
    os.makedirs(os.path.expanduser("~/.kaggle"), exist_ok=True)
    p = os.path.expanduser("~/.kaggle/kaggle.json")
    with open(p, "w") as f:
        json.dump({"username": user, "key": d["key"]}, f)
    os.chmod(p, 0o600)

    slug = f"{user}/kaggle-llm-server"
    sh(["kaggle", "kernels", "status", slug])
    sh(["kaggle", "kernels", "list", "-m", "--user", user])

    subprocess.run(["kaggle", "kernels", "pull", slug, "-p", "meta", "-m"], capture_output=True, text=True)
    mp = os.path.join("meta", "kernel-metadata.json")
    if os.path.exists(mp):
        print("===== applied kernel-metadata.json =====", flush=True)
        print(open(mp).read(), flush=True)
    else:
        print("(no pulled metadata)", flush=True)

    subprocess.run(["kaggle", "kernels", "output", slug, "-p", "out"], capture_output=True, text=True)
    found = False
    for root, _, files in os.walk("out"):
        for fn in files:
            fp = os.path.join(root, fn)
            found = True
            print(f"===== {fp} =====", flush=True)
            try:
                print(open(fp, errors="ignore").read()[-6000:], flush=True)
            except Exception as e:
                print("(unreadable)", e)
    if not found:
        print("no output files yet (kernel may still be queued/running)")


if __name__ == "__main__":
    main()
