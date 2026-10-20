#!/usr/bin/env python3
"""
braze_watch.py: gives the brazing cell eyes, and it runs on a plain Mac (no NVIDIA GPU).

This is a small version of the world-model idea. Record a few good runs and it learns
what the camera and the arm's joints should look like at each moment. During a live
run it flags the moment things stop matching (an alarm), and at each joint checkpoint
it looks at the joint and says GOOD, REDO or CHECK BY EYE (can't see / unsure).

SETUP (once)
    cd ~/ur-arms/braze_watch
    python3 -m venv .venv && source .venv/bin/activate
    pip install numpy opencv-python           # required
    pip install torch torchvision             # optional, better image features (CPU is fine)
  - macOS: allow Terminal to use the camera (System Settings > Privacy & Security > Camera).
  - Keep relay.py running (python3 relay.py) so this script can read the UR joints.
    No robot handy? Add --no-robot (camera only).

TEACH IT
    python3 braze_watch.py snap good          # space = save photo of a GOOD brazed joint
    python3 braze_watch.py snap missing       # photos of unbrazed / bad joints
                                              # (any folder name = a new class: cold, too_much...)
    python3 braze_watch.py record run01       # record a GOOD run. Press c each time the camera
    python3 braze_watch.py record run02       #   is looking at a finished joint. q = stop.
    python3 braze_watch.py train              # 2+ runs lets it calibrate its own alarm levels

USE IT
    python3 braze_watch.py watch              # live monitor + per-joint report at the end
    python3 braze_watch.py watch --stop       # also sends stopj to the arm when an alarm fires
    python3 braze_watch.py check              # live: space = "is this joint OK?"
    python3 braze_watch.py check a.jpg b.jpg  # check saved photos

Useful flags: --camera 1 (USB / iPhone camera), --ip 169.254.190.160, --no-robot,
--tolerance 1.5 (fewer alarms) or 0.7 (more), --fps 5.

Data lives in braze_watch/data/ (runs, photos, model.npz, reports).
NOT A SAFETY DEVICE. Keep a hand on the e-stop. --stop is a convenience, not a safety stop.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.request
from collections import deque
from datetime import datetime
from pathlib import Path

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("OpenCV is missing. Run:  pip install numpy opencv-python")

HERE = Path(__file__).resolve().parent
OK_LABELS = {"good", "ok", "pass", "brazed"}
FRAME_W = 640                                  # every frame is resized to this width first
FEAT_VERSION = 2                               # bump when features change (invalidates caches)
STOP_SCRIPT = "def bw_stop():\n  stopj(2.0)\nend\n"
GREEN, RED, AMBER, WHITE = (80, 200, 80), (60, 60, 230), (0, 180, 255), (235, 235, 235)


def unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


def prep(frame):
    h, w = frame.shape[:2]
    if w == FRAME_W:
        return frame
    return cv2.resize(frame, (FRAME_W, int(round(h * FRAME_W / w))), interpolation=cv2.INTER_AREA)


def roi(frame, frac):
    """Centre crop: joints are judged from the middle of the view (the box drawn on screen)."""
    h, w = frame.shape[:2]
    bw, bh = int(w * frac), int(h * frac)
    x, y = (w - bw) // 2, (h - bh) // 2
    return frame[y:y + bh, x:x + bw]


# ───────────────────────────── image features ──────────────────────────────
class Features:
    """Turns a frame into a short vector. Similar scenes give similar vectors (cosine)."""

    def __init__(self, backend="auto"):
        self.name, self._net = "simple", None
        if backend in ("auto", "mobilenet"):
            try:
                import torch
                import torchvision
                weights = torchvision.models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
                net = torchvision.models.mobilenet_v3_small(weights=weights)
                net.classifier = torch.nn.Identity()
                self._net, self._torch = net.eval(), torch
                self._mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
                self._std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
                self.name = "mobilenet"
            except Exception as e:  # torch missing, or weights can't download
                if backend == "mobilenet":
                    sys.exit(f"Can't load MobileNet ({e}). Try: pip install torch torchvision")
                print(f"[features] Using simple image features ({type(e).__name__}). "
                      "For better accuracy: pip install torch torchvision")

    def __call__(self, bgr):
        if self._net is None:
            return simple_features(bgr)
        torch = self._torch
        rgb = cv2.cvtColor(cv2.resize(bgr, (224, 224), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        x = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).float().div(255).unsqueeze(0)
        with torch.no_grad():
            v = self._net((x - self._mean) / self._std)[0].numpy()
        return unit(v.astype(np.float32))


def simple_features(bgr):
    """No-torch fallback: coarse layout + edge directions + colour."""
    img = cv2.resize(bgr, (64, 48), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lay = cv2.resize(cv2.GaussianBlur(gray, (0, 0), 2), (8, 6), interpolation=cv2.INTER_AREA).ravel()
    lay = (lay - lay.mean()) / (lay.std() + 8.0)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag, ang = cv2.cartToPolar(gx, gy)
    bins = np.clip((np.mod(ang, np.pi) / np.pi * 8).astype(int), 0, 7)
    cell = (np.arange(48)[:, None] // 8) * 8 + (np.arange(64)[None, :] // 8)
    hog = np.sqrt(np.bincount((cell * 8 + bins).ravel(), weights=mag.ravel(), minlength=48 * 8))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    col = np.sqrt(cv2.calcHist([hsv], [0, 1], None, [12, 4], [0, 180, 0, 256]).ravel())
    val = np.sqrt(np.histogram(gray, bins=16, range=(0, 256))[0].astype(np.float32))
    return unit(np.concatenate([0.5 * unit(lay), unit(hog), 0.5 * unit(col), 0.7 * unit(val)]).astype(np.float32))


def sharpness(bgr):
    g = cv2.cvtColor(cv2.resize(bgr, (320, max(1, int(320 * bgr.shape[0] / bgr.shape[1])))), cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var()), float(g.mean())


def ref_img(frame, frac):
    """Small blurred grayscale copy of the joint box, for golden-image comparison."""
    g = cv2.cvtColor(roi(frame, frac), cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(cv2.resize(g, (160, 120), interpolation=cv2.INTER_AREA), (0, 0), 1.0)


def ref_diff(live, ref):
    """How different is the joint from a known-good view of the same joint? Aligns small shifts,
    ignores brightness/contrast, and scores the most-changed patch (a missing fillet is local)."""
    a, b = live.astype(np.float32), ref.astype(np.float32)
    (dx, dy), _ = cv2.phaseCorrelate(b, a)
    if abs(dx) > 24 or abs(dy) > 18:
        dx = dy = 0.0
    a = cv2.warpAffine(a, np.float32([[1, 0, -dx], [0, 1, -dy]]), (a.shape[1], a.shape[0]),
                       borderMode=cv2.BORDER_REFLECT)
    a, b = a[12:-12, 12:-12], b[12:-12, 12:-12]
    za, zb = (a - a.mean()) / (a.std() + 5), (b - b.mean()) / (b.std() + 5)
    return float(np.percentile(cv2.blur(np.abs(za - zb), (9, 9)), 99))


def cant_see(bgr, sharp_ref=None):
    """Returns a reason string if the camera can't see properly, else None."""
    s, m = sharpness(bgr)
    if m < 25:
        return "too dark"
    if m > 235:
        return "glare / washed out"
    if s < (0.2 * sharp_ref if sharp_ref else 15.0):
        return "blurry, smoky or blocked"
    return None


# ───────────────────────── joint photo classifier ──────────────────────────
class JointClassifier:
    """Few-shot k-nearest-neighbour on image features. Learns from a handful of photos."""

    def __init__(self, X, y, labels):
        self.X, self.y, self.labels = X.astype(np.float32), np.asarray(y, int), list(labels)
        d = [self._vote(self.X[i], exclude=i)[1] for i in range(len(self.X))] if len(self.X) >= 3 else []
        self.ood = float(np.max(d) * 1.5 + 0.02) if d else 2.0   # "doesn't look like anything I know"

    def _vote(self, f, exclude=None):
        sims = self.X @ f
        if exclude is not None:
            sims = sims.copy()
            sims[exclude] = -np.inf
        k = min(5, len(sims) - (exclude is not None))
        top = np.argpartition(-sims, k - 1)[:k]
        w = np.exp((sims[top] - sims[top].max()) / 0.05)
        votes = np.bincount(self.y[top], weights=w, minlength=len(self.labels))
        return votes / votes.sum(), 1.0 - float(sims[top].max())

    def predict(self, f):
        p, nearest = self._vote(f)
        i = int(np.argmax(p))
        return self.labels[i], float(p[i]), nearest > self.ood

    def loo_accuracy(self):
        if len(self.X) < 3:
            return None
        hits = sum(int(np.argmax(self._vote(self.X[i], exclude=i)[0]) == self.y[i]) for i in range(len(self.X)))
        return hits, len(self.X)


# ──────────────────────────── run monitor ("world model lite") ─────────────
class RunMonitor:
    """Tracks where a live run is compared with each good run and scores how surprising it looks.

    With joints: finds the matching moment by arm pose (prefers moving forward in time).
    Without joints: finds it by image similarity in a sliding window.
    Surprise = 1 - best cosine similarity to the good runs' frames at that moment (smoothed).
    """

    def __init__(self, runs, fps, use_q):
        self.runs, self.fps, self.use_q = runs, float(fps), use_q
        self.reset()

    def reset(self):
        self.ptr = [0] * len(self.runs)
        self.ema = None

    def step(self, f, q, t):
        imgs, qs, prog = [], [], []
        back = max(2, int(self.fps))
        for i, r in enumerate(self.runs):
            n, p = len(r["f"]), self.ptr[i]
            if self.use_q and q is not None and r["q"] is not None:
                lo = max(0, p - back)
                d = np.linalg.norm(r["q"][lo:] - q, axis=1)
                cost = d + 0.003 * np.abs(np.arange(lo, n) - (p + 1)) / self.fps
                j = lo + int(np.argmin(cost))
                qs.append(float(d[j - lo]))
                a, b = max(0, j - 2), min(n, j + 3)
                best = float(np.max(r["f"][a:b] @ f))
            else:
                lo, hi = max(0, p - back), min(n, p + 3 * back + 1)
                sims = r["f"][lo:hi] @ f
                j = lo + int(np.argmax(sims))
                best = float(sims[j - lo])
            self.ptr[i] = j
            imgs.append(1.0 - best)
            prog.append(j / max(1, n - 1))
        s = min(imgs)
        self.ema = s if self.ema is None else 0.5 * self.ema + 0.5 * s
        k = int(np.argmin(imgs))
        return self.ema, (min(qs) if qs else None), float(prog[k])


def calibrate(runs, fps, use_q):
    """Leave-one-out over the good runs: how surprised does a GOOD run look? Alarm above that."""
    if len(runs) < 2:
        f = runs[0]["f"]
        step = max(1, int(fps))
        d = 1.0 - np.sum(f[step:] * f[:-step], axis=1) if len(f) > step else np.array([0.05])
        return max(0.06, float(np.percentile(d, 90))), 0.15, False
    img, jq = [], []
    for i, r in enumerate(runs):
        mon = RunMonitor(runs[:i] + runs[i + 1:], fps, use_q)
        for k in range(len(r["f"])):
            s_img, s_q, _ = mon.step(r["f"][k], r["q"][k] if (use_q and r["q"] is not None) else None, r["t"][k])
            img.append(s_img)
            if s_q is not None:
                jq.append(s_q)
    thr_img = max(float(np.max(img)) * 1.25 + 0.01, 0.03)
    thr_q = max(float(np.max(jq)) * 1.5 + 0.02, 0.05) if jq else 0.15
    return thr_img, thr_q, True


# ────────────────────────────── robot link ─────────────────────────────────
class RobotLink(threading.Thread):
    """Reads UR joints from relay.py (same thing the browser app uses)."""

    def __init__(self, relay, ip):
        super().__init__(daemon=True)
        self.relay, self.ip = relay, ip
        self.q, self.t, self.error = None, 0.0, None
        self._open = urllib.request.build_opener(urllib.request.ProxyHandler({})).open

    def _post(self, body, timeout=1.0):
        req = urllib.request.Request(self.relay, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with self._open(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")

    def run(self):
        while True:
            try:
                r = self._post({"ip": self.ip, "action": "state"})
                if r.get("ok") and r.get("joints"):
                    self.q, self.t, self.error = np.asarray(r["joints"], float), time.monotonic(), None
                else:
                    self.error = r.get("error", "no joints yet")
            except Exception as e:
                self.error = f"relay not reachable ({e.__class__.__name__})"
            time.sleep(0.1)

    def get(self):
        return self.q if self.q is not None and time.monotonic() - self.t < 1.0 else None

    def stop_robot(self):
        try:
            return bool(self._post({"ip": self.ip, "action": "send", "code": STOP_SCRIPT}, 2.0).get("ok"))
        except Exception:
            return False


# ─────────────────────────────── camera ────────────────────────────────────
class Camera:
    """Live camera (index) or a video file. Yields (t, frame) at roughly `fps`."""

    def __init__(self, src, fps):
        self.is_file = not str(src).isdigit()
        self.cap = cv2.VideoCapture(str(src) if self.is_file else int(src))
        if not self.cap.isOpened():
            sys.exit(f"Can't open camera {src}. On macOS allow Terminal camera access "
                     "(Privacy & Security > Camera), or try --camera 1.")
        self.fps, self.i = float(fps), 0
        if not self.is_file:
            for _ in range(10):          # let auto-exposure settle
                self.cap.read()
        self.t0, self.next = time.monotonic(), 0.0

    def read(self):
        if self.is_file:
            ok, fr = self.cap.read()
            if not ok:
                return None, None
            self.i += 1
            return (self.i - 1) / self.fps, prep(fr)
        while True:
            ok, fr = self.cap.read()
            if not ok:
                return None, None
            t = time.monotonic() - self.t0
            if t >= self.next:
                self.next = max(self.next + 1.0 / self.fps, t + 0.5 / self.fps)
                return t, prep(fr)


def show(win, img, lines, enabled, box=None):
    """Draws status lines (and the joint box) on a copy of the frame; returns the key pressed."""
    if not enabled:
        return ""
    out = img.copy()
    if box:
        h, w = out.shape[:2]
        bw, bh = int(w * box), int(h * box)
        cv2.rectangle(out, ((w - bw) // 2, (h - bh) // 2), ((w + bw) // 2, (h + bh) // 2), AMBER, 1)
    cv2.rectangle(out, (0, 0), (out.shape[1], 12 + 24 * len(lines)), (20, 20, 20), -1)
    for i, (txt, col) in enumerate(lines):
        cv2.putText(out, txt, (10, 26 + 24 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2, cv2.LINE_AA)
    cv2.imshow(win, out)
    k = cv2.waitKey(1) & 0xFF
    return chr(k).lower() if k != 255 else ""


def bar(v, thr):
    n = int(min(1.5, v / thr) * 10) if thr else 0
    return "#" * n + "." * (15 - n)


# ─────────────────────────────── data ──────────────────────────────────────
def dirs(a):
    d = Path(a.data)
    return d, d / "runs", d / "photos", d / "reports", d / "model.npz"


def load_run(folder, feat):
    meta = json.loads((folder / "run.json").read_text())
    S = meta["samples"]
    cache = folder / f"feats_{feat.name}_v{FEAT_VERSION}.npy"
    if cache.exists() and np.load(cache).shape[0] == len(S):
        F = np.load(cache)
    else:
        F = np.stack([feat(cv2.imread(str(folder / "frames" / s["frame"]))) for s in S])
        np.save(cache, F)
    have = [s["q"] is not None for s in S]
    Q = None
    if S and np.mean(have) >= 0.8:
        idx = np.flatnonzero(have)
        Q = np.array([S[idx[np.argmin(np.abs(idx - k))]]["q"] for k in range(len(S))], float)
    return {"name": folder.name, "t": np.array([s["t"] for s in S], float), "q": Q, "f": F,
            "checkpoints": meta.get("checkpoints", []), "fps": meta.get("fps", 5.0)}


def save_model(path, m):
    arrays = {}
    for i, r in enumerate(m["runs"]):
        arrays[f"r{i}_f"], arrays[f"r{i}_t"] = r["f"], r["t"]
        if r["q"] is not None:
            arrays[f"r{i}_q"] = r["q"]
    if m["clf"] is not None:
        arrays["clf_X"], arrays["clf_y"] = m["clf"].X, m["clf"].y
    for i, R in enumerate(m["cp_refs"]):
        arrays[f"cp{i}_ref"] = R.astype(np.uint8)
    meta = {k: v for k, v in m.items() if k not in ("runs", "clf", "cp_refs")}
    meta["n_refs"] = len(m["cp_refs"])
    meta["run_names"] = [r["name"] for r in m["runs"]]
    meta["labels"] = m["clf"].labels if m["clf"] is not None else []
    np.savez_compressed(path, meta=np.array(json.dumps(meta)), **arrays)


def load_model(path):
    if not path.exists():
        sys.exit("No model yet. Run:  python3 braze_watch.py train")
    z = np.load(path)
    m = json.loads(str(z["meta"]))
    m["runs"] = [{"name": n, "f": z[f"r{i}_f"], "t": z[f"r{i}_t"],
                  "q": z[f"r{i}_q"] if f"r{i}_q" in z.files else None} for i, n in enumerate(m["run_names"])]
    m["clf"] = JointClassifier(z["clf_X"], z["clf_y"], m["labels"]) if "clf_X" in z.files else None
    m["cp_refs"] = [z[f"cp{i}_ref"] for i in range(m.get("n_refs", 0))]
    return m


def judge(m, feat, frames, cp=None):
    """Looks at one joint (last few frames). Two opinions, combined:
       - ref: does it match how this joint looked when finished in your good runs? (no labelling needed)
       - photo model: what do your labelled photos say? (names the problem: missing, cold, ...)
    Returns dict(verdict ok|redo|check, label, conf, note)."""
    why = cant_see(frames[-1], m.get("sharp_ref"))
    if why:
        return {"verdict": "check", "label": "can't see", "conf": 0.0, "note": why}
    f = unit(np.mean([feat(roi(fr, m["roi"])) for fr in frames], axis=0))
    refs = m["cp_refs"][cp] if (cp is not None and cp < len(m["cp_refs"])) else None
    ref_d = None
    if refs is not None and len(refs):
        ref_d = float(np.median([min(ref_diff(ref_img(fr, m["roi"]), R) for R in refs) for fr in frames]))
    ref_ok = None if ref_d is None else ref_d <= m["thr_ref"]
    ref_note = "" if ref_d is None else f"diff {ref_d:.2f} (limit {m['thr_ref']:.2f})"
    label, conf, clf_ok, clf_note = None, 0.0, None, ""
    if m["clf"] is not None:
        label, conf, ood = m["clf"].predict(f)
        if ood:
            clf_note = "doesn't look like any training photo"
        elif conf < 0.6:
            clf_note = f"maybe {label}"
        else:
            clf_ok = label in OK_LABELS
    if ref_ok is None and m["clf"] is None:
        return {"verdict": "check", "label": "not taught", "conf": 0.0,
                "note": "no joint photos (snap good / snap missing) and no checkpoint refs"}
    if clf_ok is not None and ref_ok is not None and clf_ok != ref_ok:     # the two opinions disagree
        return {"verdict": "check", "label": "disagree", "conf": conf,
                "note": (f"photos say {label}, but it " + ("matches" if ref_ok else "doesn't match")
                         + " your good runs; " + ref_note)}
    if clf_ok is not None:
        return {"verdict": "ok" if clf_ok else "redo", "label": label, "conf": conf, "note": ref_note}
    if ref_ok is True:
        return {"verdict": "ok", "label": "matches", "conf": 0.0, "note": ref_note}
    if ref_ok is False:
        return {"verdict": "redo", "label": "mismatch", "conf": 0.0,
                "note": "doesn't match the finished joint in your good runs; " + ref_note}
    return {"verdict": "check", "label": "unsure", "conf": conf, "note": clf_note}


def verdict_text(r):
    conf = f" {r['conf']:.0%}" if r["conf"] else ""
    return f"{r['label'].upper()}{conf} -> {r['verdict']}  {r['note']}".rstrip()


# ─────────────────────────────── watcher ───────────────────────────────────
class Watcher:
    """One live run: alarms + per-joint inspection + report."""

    def __init__(self, m, feat, tolerance=1.0, stop_fn=None, out_dir=None):
        self.m, self.feat, self.stop_fn, self.out = m, feat, stop_fn, out_dir
        self.fps = float(m["fps"])
        self.mon = RunMonitor(m["runs"], self.fps, m["use_q"])
        self.thr_img, self.thr_q = m["thr_img"] * tolerance, m["thr_q"] * tolerance
        self.cps = [np.asarray(c["q"], float) for c in m["checkpoints"]]
        self.cp_names = [c["name"] for c in m["checkpoints"]]
        gaps = [np.linalg.norm(a - b) for i, a in enumerate(self.cps) for b in self.cps[i + 1:]]
        self.cp_radius = min([0.05] + [0.5 * g for g in gaps if g > 1e-6])
        self.recent_q = deque(maxlen=max(3, int(0.6 * self.fps) + 1))
        self.recent_frames = deque(maxlen=3)
        self.results, self.cp_last = {}, {}
        self.streak = {"scene": 0, "path": 0, "blind": 0}
        self.active, self.events = set(), []
        self.last = {"s_img": 0.0, "s_q": None, "prog": 0.0, "t": 0.0}
        if out_dir:
            out_dir.mkdir(parents=True, exist_ok=True)

    def step(self, t, frame, q):
        f = self.feat(frame)
        self.recent_frames.append(frame)
        blind = cant_see(frame, self.m.get("sharp_ref"))
        s_img, s_q, prog = self.mon.step(f, q if self.m["use_q"] else None, t)
        self.last = {"s_img": s_img, "s_q": s_q, "prog": prog, "t": t}

        self.streak["blind"] = self.streak["blind"] + 1 if blind else 0
        self.streak["scene"] = self.streak["scene"] + 1 if (not blind and s_img > self.thr_img) else 0
        self.streak["path"] = self.streak["path"] + 1 if (s_q is not None and s_q > self.thr_q) else 0
        need = {"blind": max(2, int(self.fps)), "scene": 2, "path": 2}
        msgs = {"blind": f"camera can't see: {blind}", "scene": "scene doesn't match the good runs",
                "path": f"arm is off the taught path ({(s_q or 0):.2f} rad)"}
        now = {k for k in need if self.streak[k] >= need[k]}
        for k in now - self.active:                       # rising edge → log once
            ev = {"t": round(t, 2), "kind": k, "msg": msgs[k]}
            if self.out:
                ev["frame"] = f"alarm_{len(self.events):02d}_{k}.jpg"
                cv2.imwrite(str(self.out / ev["frame"]), frame)
            if self.stop_fn:
                ev["stop_sent"] = bool(self.stop_fn())
            self.events.append(ev)
            print(f"[{t:6.1f}s] ALARM: {msgs[k]}" + (" -> stop sent" if ev.get("stop_sent") else ""))
        self.active = now

        if q is not None:
            self.recent_q.append(np.asarray(q, float))
            still = (len(self.recent_q) == self.recent_q.maxlen and
                     float(np.max(np.abs(self.recent_q[-1] - self.recent_q[0]))) < 0.01)
            if still and self.cps:
                d = [float(np.linalg.norm(c - q)) for c in self.cps]
                i = int(np.argmin(d))
                if d[i] < self.cp_radius and t - self.cp_last.get(i, -1e9) >= 1.0:
                    self.cp_last[i] = t
                    res = judge(self.m, self.feat, list(self.recent_frames), cp=i)
                    if res["verdict"] == "redo" and "scene" in now:      # something was in the way
                        res.update(verdict="check", note="view looked blocked/odd during the look; " + res["note"])
                    res["t"] = round(t, 2)
                    prev = self.results.get(i)
                    self.results[i] = res          # latest look at this joint wins
                    if self.out:
                        cv2.imwrite(str(self.out / f"{self.cp_names[i].replace(' ', '_')}.jpg"), frame)
                    if prev is None or prev["label"] != res["label"]:
                        print(f"[{t:6.1f}s] {self.cp_names[i]}: {res['label'].upper()} "
                              f"{res['conf']:.0%} {res['note']}".rstrip())
        return now

    def lines(self):
        L = self.last
        lines = [(f"WATCH {L['t']:5.1f}s   run progress {L['prog']:.0%}", WHITE),
                 (f"scene {bar(L['s_img'], self.thr_img)} {L['s_img']:.3f}/{self.thr_img:.3f}",
                  RED if L["s_img"] > self.thr_img else GREEN)]
        if L["s_q"] is not None:
            lines.append((f"path  {bar(L['s_q'], self.thr_q)} {L['s_q']:.3f}/{self.thr_q:.3f} rad",
                          RED if L["s_q"] > self.thr_q else GREEN))
        for k in sorted(self.active):
            lines.append(("! " + {"blind": "CAN'T SEE", "scene": "SCENE LOOKS WRONG",
                                  "path": "OFF THE TAUGHT PATH"}[k], RED))
        if self.results:
            i = max(self.results, key=lambda k: self.results[k]["t"])
            r = self.results[i]
            lines.append((f"{self.cp_names[i]}: {r['label'].upper()} {r['conf']:.0%}",
                          GREEN if r["verdict"] == "ok" else (RED if r["verdict"] == "redo" else AMBER)))
        return lines

    def report(self):
        rows = []
        for i, name in enumerate(self.cp_names):
            r = self.results.get(i) or {"verdict": "not reached", "label": "-", "conf": 0.0, "note": ""}
            rows.append({"joint": name, **r})
        rep = {"finished": datetime.now().isoformat(timespec="seconds"), "joints": rows, "alarms": self.events,
               "redo": [r["joint"] for r in rows if r["verdict"] == "redo"],
               "check_by_eye": [r["joint"] for r in rows if r["verdict"] in ("check", "not reached")]}
        if self.out:
            (self.out / "report.json").write_text(json.dumps(rep, indent=2))
        print("\n──────── run report ────────")
        if not rows:
            print(" (no joint checkpoints — press c during `record` to add them)")
        for r in rows:
            tag = {"ok": "ok", "redo": "REDO", "check": "check by eye", "not reached": "not reached"}[r["verdict"]]
            conf = f"{r['conf']:.0%}" if r["conf"] else ""
            print(f" {r['joint']:<9} {r['label']:<11} {conf:>4}  {tag:<13} {r['note']}")
        print(f" alarms: {len(self.events)}" + "".join(f"\n   {e['t']:6.1f}s  {e['msg']}" for e in self.events))
        print(f" REDO: {', '.join(rep['redo']) or 'none'}")
        if rep["check_by_eye"]:
            print(f" check by eye: {', '.join(rep['check_by_eye'])}")
        if self.out:
            print(f" saved: {self.out}")
        return rep


# ─────────────────────────────── commands ──────────────────────────────────
def robot(a):
    if a.no_robot:
        return None
    link = RobotLink(a.relay, a.ip)
    link.start()
    return link


def cmd_record(a):
    _, RUNS, _, _, _ = dirs(a)
    out = RUNS / a.name
    if out.exists() and not a.overwrite:
        sys.exit(f"{out} already exists (use --overwrite or a new name)")
    (out / "frames").mkdir(parents=True, exist_ok=True)
    (out / "checkpoints").mkdir(exist_ok=True)
    cam, link = Camera(a.camera, a.fps), robot(a)
    samples, cps, warned = [], [], False
    print("Recording a GOOD run. c = this joint is finished and in the box, q = stop.")
    while True:
        t, frame = cam.read()
        if frame is None:
            break
        q = link.get() if link else None
        if link and q is None and t > 2 and not warned:
            print(f"(no joints: {link.error}. Is relay.py running and the robot pinged? "
                  "Camera-only: --no-robot)")
            warned = True
        fn = f"{len(samples):05d}.jpg"
        cv2.imwrite(str(out / "frames" / fn), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        samples.append({"t": round(t, 3), "q": None if q is None else [round(float(x), 5) for x in q], "frame": fn})
        key = show("braze_watch record", frame, [
            (f"REC {t:5.1f}s  joints {'OK' if q is not None else 'none'}  checkpoints {len(cps)}", RED),
            ("c = joint done & in the box    q = stop", WHITE)], not a.no_window, a.roi)
        if key == "c":
            if q is None:
                print("Can't add a checkpoint without joints (relay/robot).")
            else:
                name = f"joint {len(cps) + 1}"
                cps.append({"name": name, "q": samples[-1]["q"], "t": round(t, 3), "frame": fn})
                cv2.imwrite(str(out / "checkpoints" / f"{name.replace(' ', '_')}.jpg"), frame)
                print(f"[{t:6.1f}s] checkpoint {name}")
        if key == "q" or (a.seconds and t >= a.seconds):
            break
    (out / "run.json").write_text(json.dumps({"fps": a.fps, "created": datetime.now().isoformat(timespec="seconds"),
                                              "samples": samples, "checkpoints": cps}))
    print(f"Saved {len(samples)} frames, {len(cps)} checkpoints -> {out}")


def cmd_snap(a):
    _, _, PHOTOS, _, _ = dirs(a)
    out = PHOTOS / a.label.lower()
    out.mkdir(parents=True, exist_ok=True)
    cam, n, last = Camera(a.camera, a.fps), len(list(out.glob("*.jpg"))), -1e9
    print(f"Photos for '{a.label}'. space = save, q = quit." + (f" Auto-saving every {a.every}s." if a.every else ""))
    while True:
        t, frame = cam.read()
        if frame is None:
            break
        key = show("braze_watch snap", frame, [(f"SNAP '{a.label}'  saved {n}", WHITE),
                                               ("joint in the box. space = save, q = quit", WHITE)],
                   not a.no_window, a.roi)
        if key == " " or (a.every and t - last >= a.every):
            last = t
            cv2.imwrite(str(out / f"{datetime.now():%Y%m%d-%H%M%S}-{n:03d}.jpg"), frame)
            n += 1
            print(f"saved {n}")
        if key == "q" or (a.seconds and t >= a.seconds):
            break


def cmd_train(a):
    _, RUNS, PHOTOS, _, MODEL = dirs(a)
    feat = Features(a.features)
    runs = [load_run(d, feat) for d in sorted(RUNS.glob("*")) if (d / "run.json").exists()]
    runs = [r for r in runs if len(r["f"]) >= 3]
    sharp = []
    m = {"backend": feat.name, "fps": 5.0, "thr_img": 0.1, "thr_q": 0.15, "use_q": False, "roi": a.roi,
         "calibrated": False, "checkpoints": [], "runs": runs, "clf": None, "cp_refs": [], "thr_ref": 0.15}
    if runs:
        m["fps"] = float(np.median([r["fps"] for r in runs]))
        m["use_q"] = all(r["q"] is not None for r in runs)
        m["thr_img"], m["thr_q"], m["calibrated"] = calibrate(runs, m["fps"], m["use_q"])
        best = max(runs, key=lambda r: len(r["checkpoints"]))
        m["checkpoints"] = [{"name": c["name"], "q": c["q"]} for c in best["checkpoints"]]
        for r in runs:
            frames = sorted((RUNS / r["name"] / "frames").glob("*.jpg"))
            sharp += [sharpness(cv2.imread(str(p)))[0] for p in frames[:: max(1, len(frames) // 30)]]
        print(f"Runs: {len(runs)} ({'with joints' if m['use_q'] else 'camera only'}), "
              f"{sum(len(r['f']) for r in runs)} frames")
        if m["calibrated"]:
            print(f"  alarm levels learned from the good runs: scene {m['thr_img']:.3f}"
                  + (f", path {m['thr_q']:.3f} rad" if m["use_q"] else ""))
        else:
            print("  only 1 run: using rough alarm levels. Record a 2nd good run so it can calibrate.")
        counts = {len(r["checkpoints"]) for r in runs if r["checkpoints"]}
        print(f"  checkpoints: {len(m['checkpoints'])} (from {best['name']})"
              + ("  ⚠ runs disagree on checkpoint count" if len(counts) > 1 else ""))
        # what each finished joint looked like in the good runs (the frame where you pressed c)
        loo = []
        for i in range(len(m["checkpoints"])):
            R = np.stack([ref_img(cv2.imread(str(RUNS / r["name"] / "frames" / r["checkpoints"][i]["frame"])), a.roi)
                          for r in runs if i < len(r["checkpoints"])])
            m["cp_refs"].append(R)
            for j in range(len(R)) if len(R) >= 2 else []:
                loo.append(min(ref_diff(R[j], R[k]) for k in range(len(R)) if k != j))
        if loo:
            m["thr_ref"] = float(np.max(loo)) * 1.3 + 0.1
            print(f"  finished-joint references: {len(m['cp_refs'])} joints, limit {m['thr_ref']:.2f}")
        elif m["cp_refs"]:
            m["thr_ref"] = 1.2
            print("  finished-joint references from 1 run only: rough limit. A 2nd run calibrates it.")
    else:
        print("Runs: none yet (record some with: python3 braze_watch.py record run01)")

    labels = sorted(d.name for d in PHOTOS.glob("*") if d.is_dir() and any(d.glob("*.jpg")))
    X, y = [], []
    for li, lab in enumerate(labels):
        for p in sorted((PHOTOS / lab).glob("*.jpg")):
            img = cv2.imread(str(p))
            if img is None:
                continue
            img = prep(img)
            X.append(feat(roi(img, a.roi)))
            y.append(li)
            sharp.append(sharpness(img)[0])
    if len(labels) >= 2:
        m["clf"] = JointClassifier(np.stack(X), y, labels)
        acc = m["clf"].loo_accuracy()
        print("Joint photos: " + ", ".join(f"{lab} {y.count(i)}" for i, lab in enumerate(labels))
              + (f" -> self-test accuracy {acc[0] / acc[1]:.0%} ({acc[0]}/{acc[1]})" if acc else ""))
        if not OK_LABELS & set(labels):
            print("  ⚠ no 'good' folder — name the OK class 'good' so the report knows what passes")
        if acc and acc[0] / acc[1] < 0.85:
            print("  tip: add more photos (10+ per class, different angles/lighting)")
    else:
        print("Joint photos: need 2+ classes (e.g. snap good + snap missing) to judge joints")
    m["sharp_ref"] = float(np.median(sharp)) if sharp else None
    if not runs and m["clf"] is None:
        sys.exit("Nothing to train on yet.")
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    save_model(MODEL, m)
    print(f"Saved {MODEL}  (features: {feat.name})")


def cmd_check(a):
    _, _, _, _, MODEL = dirs(a)
    m = load_model(MODEL)
    feat = Features(m["backend"])
    if a.images:
        for p in a.images:
            img = cv2.imread(p)
            if img is None:
                print(f"{p}: can't read")
                continue
            r = judge(m, feat, [prep(img)])
            print(f"{p}: {verdict_text(r)}")
        return
    if m["clf"] is None:
        print("(no joint photos trained, so check can only spot can't-see. Use snap good / snap missing + train)")
    cam, res, until = Camera(a.camera, a.fps), None, 0
    print("space = check the joint in the box, q = quit")
    while True:
        t, frame = cam.read()
        if frame is None:
            break
        lines = [("CHECK  space = is this joint OK?   q = quit", WHITE)]
        if res and t < until:
            col = GREEN if res["verdict"] == "ok" else (RED if res["verdict"] == "redo" else AMBER)
            lines.append((verdict_text(res), col))
        key = show("braze_watch check", frame, lines, not a.no_window, m["roi"])
        if key == " ":
            res, until = judge(m, feat, [frame]), t + 3
            print(verdict_text(res))
        if key == "q" or (a.seconds and t >= a.seconds):
            break


def cmd_watch(a):
    _, _, _, REPORTS, MODEL = dirs(a)
    m = load_model(MODEL)
    if not m["runs"]:
        sys.exit("No good runs in the model. Record one (record run01) and train.")
    if a.fps != m["fps"]:
        a.fps = m["fps"]
    feat = Features(m["backend"])
    link = robot(a)
    if m["use_q"] and not link:
        print("(--no-robot: tracking by camera only; joint checkpoints are off)")
    out = REPORTS / f"{datetime.now():%Y%m%d-%H%M%S}"
    w = Watcher(m, feat, a.tolerance, link.stop_robot if (link and a.stop) else None, out)
    cam = Camera(a.camera, a.fps)
    print("Watching. Start the run now. q = finish and print the report.")
    try:
        while True:
            t, frame = cam.read()
            if frame is None:
                break
            w.step(t, frame, link.get() if link else None)
            key = show("braze_watch watch", frame, w.lines(), not a.no_window, m["roi"])
            if key == "q" or (a.seconds and t >= a.seconds):
                break
    except KeyboardInterrupt:
        pass
    w.report()


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    c = argparse.ArgumentParser(add_help=False)
    c.add_argument("--camera", default="0", help="camera index (0 built-in, 1 USB/iPhone) or a video file")
    c.add_argument("--fps", type=float, default=5.0, help="frames per second to sample (default 5)")
    c.add_argument("--ip", default="169.254.190.160", help="robot IP (passed to relay.py)")
    c.add_argument("--relay", default="http://localhost:5678", help="relay.py address")
    c.add_argument("--no-robot", action="store_true", help="camera only, don't read joints")
    c.add_argument("--no-window", action="store_true", help="no preview window")
    c.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = until q)")
    c.add_argument("--data", default=str(HERE / "data"), help="data folder")
    c.add_argument("--roi", type=float, default=0.5, help="size of the centre joint box (fraction of view)")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("record", parents=[c], help="record a good run (camera + joints)")
    s.add_argument("name")
    s.add_argument("--overwrite", action="store_true")
    s = sub.add_parser("snap", parents=[c], help="save labelled joint photos")
    s.add_argument("label", help="good, missing, cold, ... (folder name = class)")
    s.add_argument("--every", type=float, default=0, help="auto-save every N seconds")
    s = sub.add_parser("train", parents=[c], help="learn from runs + photos")
    s.add_argument("--features", choices=["auto", "mobilenet", "simple"], default="auto")
    sub.add_parser("check", parents=[c], help="judge a joint (live or photos)").add_argument("images", nargs="*")
    s = sub.add_parser("watch", parents=[c], help="watch a live run, report per joint")
    s.add_argument("--tolerance", type=float, default=1.0, help=">1 = fewer alarms, <1 = more")
    s.add_argument("--stop", action="store_true", help="send stopj to the arm on an alarm (not a safety stop)")
    a = p.parse_args(argv)
    {"record": cmd_record, "snap": cmd_snap, "train": cmd_train, "check": cmd_check, "watch": cmd_watch}[a.cmd](a)
    if not a.no_window:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
