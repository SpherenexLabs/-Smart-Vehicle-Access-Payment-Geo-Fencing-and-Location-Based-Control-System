#!/usr/bin/env python3
"""
AI-Powered Railway Track Inspection Robot
Single-file Flask + HTML + CSS + JavaScript dashboard.

Features
--------
- Loads a trained Ultralytics YOLO best.pt model.
- Webcam or IP/RTSP/HTTP camera selection.
- Live defect detection with bounding boxes, labels, and confidence.
- Inspection-round start/stop counter.
- Timestamped annotated fault-image saving.
- Persistent SQLite fault history.
- Total fault and per-defect counters.
- Mobile-responsive dashboard.

Expected model classes
----------------------
0: rail_crack
1: rail_gap
2: track_obstacle
3: damaged_sleeper
4: missing_track_section
5: track_misalignment

Install
-------
py -m pip install flask ultralytics opencv-python

Run
---
1. Keep this app.py and best.pt in the same folder.
2. Run: py app.py
3. Open: http://127.0.0.1:5001
"""

from __future__ import annotations

import atexit
import os
import sqlite3
import threading
import time
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import cv2
    import numpy as np
    import requests
    from flask import (
        Flask,
        Response,
        jsonify,
        render_template_string,
        request,
        send_from_directory,
    )
    from ultralytics import YOLO
except ImportError as exc:
    raise SystemExit(
        "\nMissing Python package: "
        f"{getattr(exc, 'name', str(exc))}\n\n"
        "Install the required packages with:\n"
        "py -m pip install flask ultralytics opencv-python requests\n"
    ) from exc


# ---------------------------------------------------------------------------
# Paths and application configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
SAVED_IMAGES_DIR = BASE_DIR / "saved_faults"
DATABASE_PATH = BASE_DIR / "railway_inspection.db"

SAVED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

APP_HOST = "0.0.0.0"
APP_PORT = 5001

DEFAULT_CONFIDENCE = 0.70
MINIMUM_CONFIDENCE = 0.50
DEFAULT_IOU = 0.45
# best.pt was trained at 512 px. Matching the training resolution gives the
# detector the same object scale it saw during training.
DEFAULT_IMAGE_SIZE = 512

# This checkpoint's weakest failure mode is labelling unrelated textures as a
# rail crack. Keep the user-selected threshold for other classes, but require
# stronger evidence for crack detections.
CLASS_CONFIDENCE_FLOORS = {
    "rail_crack": 0.75,
}

# Whole-frame detections are a common out-of-distribution failure (for example,
# when the camera points at a keyboard, monitor, or wall). Real defect boxes in
# this dataset are localised, so do not accept a box covering almost all of the
# camera image.
MAX_DETECTION_AREA_RATIO = 0.60

# Internal HSV marker rules (OpenCV hue range: 0..179).
# Marker detection runs alongside best.pt for every defect class.
# The saturation/value floors are deliberately low. A webcam frame under
# ordinary room lighting is washed out, so a pale pink or light blue marker
# lands near S=70; a floor of S=100 missed those markers entirely.
# Hue bands do not overlap, so a marker maps to exactly one defect class:
#   red     -> rail_crack              yellow/orange -> damaged_sleeper
#   green   -> track_misalignment      blue/cyan     -> track_obstacle
#   purple  -> missing_track_section   pink/magenta  -> rail_gap
MARKER_RULES = (
    (((0, 70, 55), (8, 255, 255)), ("rail_crack",)),
    (((177, 70, 55), (179, 255, 255)), ("rail_crack",)),
    (((14, 80, 70), (33, 255, 255)), ("damaged_sleeper",)),
    (((36, 60, 45), (86, 255, 255)), ("track_misalignment",)),
    (((87, 65, 45), (124, 255, 255)), ("track_obstacle",)),
    (((125, 60, 50), (152, 255, 255)), ("missing_track_section",)),
    (((153, 60, 50), (176, 255, 255)), ("rail_gap",)),
)

MARKER_MIN_AREA_RATIO = 0.0006
MARKER_MIN_PIXELS = 60
# Markers are colour masks, not a probability model, so they are scored and
# gated on their own scale instead of the model confidence slider.
MARKER_MIN_CONFIDENCE = 0.55
# Cap per class so a noisy frame cannot flood a round with marker faults.
MARKER_MAX_PER_CLASS = 3
# Rejects hairline bands along a frame edge while still allowing a long,
# reasonably elongated marker stroke.
MARKER_MAX_ASPECT_RATIO = 60.0
# Two marker rules claiming the same region mean one stroke straddled a hue
# boundary; only the strongest class is reported.
MARKER_CROSS_CLASS_IOU = 0.30

# ---------------------------------------------------------------------------
# Firebase Realtime Database (hardware bridge) configuration
# ---------------------------------------------------------------------------
# The ESP32/Arduino side of the robot reads/writes this same node:
#   Ax, Ay, Az   -> MPU6050 accelerometer readings (written by the device)
#   Button       -> physical button state on the robot (written by the device)
#   Buzzer       -> 1 = sound buzzer, 0 = silent (written by this app)
#   R_led/G_led  -> red/green status LED (written by this app)
#   direction    -> "F" forward, "B" backward, "S" stop (written by this app,
#                    read/applied by the device)
FIREBASE_DATABASE_URL = os.environ.get(
    "FIREBASE_DATABASE_URL",
    "https://diet-planner-3bdf3-default-rtdb.firebaseio.com",
).rstrip("/")
FIREBASE_NODE_PATH = os.environ.get(
    "FIREBASE_NODE_PATH",
    "AI_Powered_Railway_5645",
)
# Optional Realtime Database secret / ID token. Leave unset if the database
# rules allow public read/write (typical for a hobby/test-mode project).
FIREBASE_AUTH_TOKEN = os.environ.get("FIREBASE_AUTH_TOKEN", "").strip()

# Any axis reading beyond this magnitude is treated as a track-shock/impact
# alert from the MPU6050. Tune to match how the sensor is mounted/calibrated.
MPU_ACCEL_ALERT_THRESHOLD = float(
    os.environ.get("MPU_ACCEL_ALERT_THRESHOLD", "1.5")
)

FIREBASE_POLL_INTERVAL_SECONDS = 1.0
FIREBASE_HISTORY_LENGTH = 120

# The same physical fault is not counted repeatedly while it remains visible.
EVENT_MEMORY_SECONDS = 8.0
EVENT_MATCH_IOU = 0.25

JPEG_QUALITY = 85

FINAL_CLASS_NAMES = {
    0: "rail_crack",
    1: "rail_gap",
    2: "track_obstacle",
    3: "damaged_sleeper",
    4: "missing_track_section",
    5: "track_misalignment",
}

DISPLAY_NAMES = {
    "rail_crack": "Crack",
    "rail_gap": "Rail Gap",
    "track_obstacle": "Track Obstacle",
    "damaged_sleeper": "Damaged Sleeper",
    "missing_track_section": "Missing Track Section",
    "track_misalignment": "Track Misalignment",
}

# Handles minor naming differences in trained models.
CLASS_ALIASES = {
    "crack": "rail_crack",
    "rail crack": "rail_crack",
    "rail_crack": "rail_crack",
    "railway crack": "rail_crack",
    "railway cracks": "rail_crack",
    "railway-cracks": "rail_crack",

    "gap": "rail_gap",
    "rail gap": "rail_gap",
    "rail_gap": "rail_gap",
    "railway gap": "rail_gap",

    "obstacle": "track_obstacle",
    "track obstacle": "track_obstacle",
    "track_obstacle": "track_obstacle",

    "damaged sleeper": "damaged_sleeper",
    "damaged_sleeper": "damaged_sleeper",
    "slepper dam": "damaged_sleeper",

    "missing track section": "missing_track_section",
    "missing_track_section": "missing_track_section",
    "track cuted": "missing_track_section",
    "track break": "missing_track_section",

    "track misalignment": "track_misalignment",
    "track_misalignment": "track_misalignment",
    "misalignment": "track_misalignment",
}


def normalize_class_name(name: str) -> str:
    return " ".join(
        str(name)
        .strip()
        .lower()
        .replace("-", " ")
        .replace("_", " ")
        .split()
    )


def canonical_class_name(model_name: str, class_id: int) -> str:
    normalized = normalize_class_name(model_name)

    for alias, canonical in CLASS_ALIASES.items():
        if normalize_class_name(alias) == normalized:
            return canonical

    # Never guess a label from its numeric position. If a different checkpoint
    # is supplied, silently mapping its class 0 to rail_crack is unsafe.
    return normalized.replace(" ", "_") or f"class_{class_id}"


def validate_model_classes(model: YOLO) -> None:
    """Fail clearly when a checkpoint does not contain the expected classes."""
    names = getattr(model, "names", {})
    if isinstance(names, dict):
        model_items = names.items()
    elif isinstance(names, (list, tuple)):
        model_items = enumerate(names)
    else:
        raise ValueError("The model checkpoint has no readable class names.")

    canonical_names = {
        canonical_class_name(str(name), int(class_id))
        for class_id, name in model_items
    }
    expected_names = set(FINAL_CLASS_NAMES.values())
    if canonical_names != expected_names:
        missing = sorted(expected_names - canonical_names)
        unexpected = sorted(canonical_names - expected_names)
        raise ValueError(
            "Model classes do not match this app. "
            f"Missing: {missing or 'none'}; "
            f"unexpected: {unexpected or 'none'}."
        )


def locate_model_file() -> Path | None:
    """
    Model search order:
    1. MODEL_PATH environment variable.
    2. best.pt beside app.py.
    3. The first .pt file beside app.py.
    """
    environment_path = os.environ.get("MODEL_PATH", "").strip()
    if environment_path:
        candidate = Path(environment_path).expanduser().resolve()
        if candidate.exists():
            return candidate

    preferred = BASE_DIR / "best.pt"
    if preferred.exists():
        return preferred

    model_files = sorted(BASE_DIR.glob("*.pt"))
    return model_files[0] if model_files else None


# ---------------------------------------------------------------------------
# SQLite persistence
# ---------------------------------------------------------------------------

class InspectionDatabase:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path,
            timeout=30,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self.lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS inspection_rounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    source_type TEXT NOT NULL,
                    source_value TEXT NOT NULL,
                    fault_count INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS faults (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    round_id INTEGER NOT NULL,
                    detected_at TEXT NOT NULL,
                    defect_key TEXT NOT NULL,
                    defect_name TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    image_filename TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_value TEXT NOT NULL,
                    FOREIGN KEY(round_id)
                        REFERENCES inspection_rounds(id)
                        ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_faults_detected_at
                    ON faults(detected_at DESC);

                CREATE INDEX IF NOT EXISTS idx_faults_round_id
                    ON faults(round_id);
                """
            )

            # Close incomplete rounds after an unexpected previous shutdown.
            connection.execute(
                """
                UPDATE inspection_rounds
                SET ended_at = COALESCE(ended_at, started_at)
                WHERE ended_at IS NULL
                """
            )
            connection.commit()

    def start_round(
        self,
        source_type: str,
        source_value: str,
    ) -> int:
        started_at = datetime.now().isoformat(timespec="seconds")

        with self.lock, self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO inspection_rounds (
                    started_at,
                    source_type,
                    source_value
                )
                VALUES (?, ?, ?)
                """,
                (started_at, source_type, source_value),
            )
            connection.commit()
            return int(cursor.lastrowid)

    def stop_round(self, round_id: int) -> None:
        ended_at = datetime.now().isoformat(timespec="seconds")

        with self.lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE inspection_rounds
                SET ended_at = ?
                WHERE id = ?
                """,
                (ended_at, round_id),
            )
            connection.commit()

    def add_fault(
        self,
        round_id: int,
        defect_key: str,
        defect_name: str,
        confidence: float,
        image_filename: str,
        source_type: str,
        source_value: str,
    ) -> int:
        detected_at = datetime.now().isoformat(timespec="seconds")

        with self.lock, self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO faults (
                    round_id,
                    detected_at,
                    defect_key,
                    defect_name,
                    confidence,
                    image_filename,
                    source_type,
                    source_value
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    round_id,
                    detected_at,
                    defect_key,
                    defect_name,
                    float(confidence),
                    image_filename,
                    source_type,
                    source_value,
                ),
            )

            connection.execute(
                """
                UPDATE inspection_rounds
                SET fault_count = fault_count + 1
                WHERE id = ?
                """,
                (round_id,),
            )
            connection.commit()
            return int(cursor.lastrowid)

    def totals(self) -> dict[str, Any]:
        with self.lock, self._connect() as connection:
            total_rounds = int(
                connection.execute(
                    "SELECT COUNT(*) FROM inspection_rounds"
                ).fetchone()[0]
            )
            total_faults = int(
                connection.execute(
                    "SELECT COUNT(*) FROM faults"
                ).fetchone()[0]
            )

            rows = connection.execute(
                """
                SELECT defect_key, COUNT(*) AS count
                FROM faults
                GROUP BY defect_key
                """
            ).fetchall()

        defect_totals = {
            class_name: 0
            for class_name in FINAL_CLASS_NAMES.values()
        }
        for row in rows:
            defect_totals[str(row["defect_key"])] = int(row["count"])

        return {
            "total_rounds": total_rounds,
            "total_faults": total_faults,
            "defect_totals": defect_totals,
        }

    def round_counts(self, round_id: int | None) -> dict[str, int]:
        counts = {
            class_name: 0
            for class_name in FINAL_CLASS_NAMES.values()
        }

        if round_id is None:
            return counts

        with self.lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT defect_key, COUNT(*) AS count
                FROM faults
                WHERE round_id = ?
                GROUP BY defect_key
                """,
                (round_id,),
            ).fetchall()

        for row in rows:
            counts[str(row["defect_key"])] = int(row["count"])

        return counts

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))

        with self.lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    round_id,
                    detected_at,
                    defect_key,
                    defect_name,
                    confidence,
                    image_filename,
                    source_type,
                    source_value
                FROM faults
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        return [dict(row) for row in rows]

    def clear_history(self, keep_round_id: int | None = None) -> list[str]:
        """
        Delete all fault records and finished rounds. The active round, if
        any, is kept (with its count reset) so detection can continue.
        Returns the evidence image filenames that were referenced.
        """
        with self.lock, self._connect() as connection:
            filenames = [
                str(row["image_filename"])
                for row in connection.execute(
                    "SELECT image_filename FROM faults"
                ).fetchall()
            ]

            connection.execute("DELETE FROM faults")
            if keep_round_id is None:
                connection.execute("DELETE FROM inspection_rounds")
            else:
                connection.execute(
                    "DELETE FROM inspection_rounds WHERE id != ?",
                    (keep_round_id,),
                )
                connection.execute(
                    "UPDATE inspection_rounds SET fault_count = 0 WHERE id = ?",
                    (keep_round_id,),
                )
            connection.commit()

        return filenames


# ---------------------------------------------------------------------------
# Firebase Realtime Database bridge (robot hardware link)
# ---------------------------------------------------------------------------

class FirebaseBridge:
    """
    Talks to the Firebase Realtime Database node shared with the robot's
    microcontroller, using the plain REST API so no extra service-account
    setup is required.

    Responsibilities:
    - Poll Ax/Ay/Az/Button written by the device and keep a short rolling
      history for the dashboard graph.
    - Raise an "alert" (Buzzer=1, R_led=1, G_led=0, direction="S") whenever
      the AI vision pipeline detects a defect, the robot's Button reads 1,
      OR the MPU6050 reports a shock/tilt beyond MPU_ACCEL_ALERT_THRESHOLD.
    - Clear the alert (Buzzer=0, R_led=0, G_led=1) once all conditions are
      gone, leaving movement direction under manual/joystick control.
    - Apply manual joystick direction commands (F/B/S), refusing to move
      while an alert is active.
    """

    def __init__(
        self,
        database_url: str,
        node_path: str,
        auth_token: str = "",
    ) -> None:
        self.database_url = database_url
        self.node_path = node_path.strip("/")
        self.auth_token = auth_token

        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.poll_thread: threading.Thread | None = None
        self.session = requests.Session()

        self.connected = False
        self.last_error = ""

        self.mpu = {"Ax": 0.0, "Ay": 0.0, "Az": 0.0}
        self.button = 0
        self.direction = "S"
        self.buzzer = 0
        self.r_led = 0
        self.g_led = 1

        self.vision_fault_active = False
        self.mpu_fault_active = False
        self.button_fault_active = False
        self._last_pushed: dict[str, Any] = {}

        self.history: list[dict[str, Any]] = []

    # -- REST helpers ------------------------------------------------------

    def _endpoint(self, child: str = "") -> str:
        suffix = f"/{child}" if child else ""
        url = f"{self.database_url}/{self.node_path}{suffix}.json"
        if self.auth_token:
            url += f"?auth={self.auth_token}"
        return url

    def _read_all(self) -> dict[str, Any]:
        response = self.session.get(self._endpoint(), timeout=5)
        response.raise_for_status()
        return response.json() or {}

    def _patch(self, values: dict[str, Any]) -> None:
        # Only push fields that actually changed, to avoid flooding the
        # database with redundant writes on every poll/detection frame.
        changed = {
            key: value
            for key, value in values.items()
            if self._last_pushed.get(key) != value
        }
        if not changed:
            return

        response = self.session.patch(
            self._endpoint(),
            json=changed,
            timeout=5,
        )
        response.raise_for_status()
        self._last_pushed.update(changed)

    # -- Fault/alert state ---------------------------------------------------

    @property
    def fault_active(self) -> bool:
        return (
            self.vision_fault_active
            or self.mpu_fault_active
            or self.button_fault_active
        )

    def _apply_alert_state(self) -> None:
        active = self.fault_active

        with self.lock:
            self.buzzer = 1 if active else 0
            self.r_led = 1 if active else 0
            self.g_led = 0 if active else 1
            if active:
                self.direction = "S"

            payload = {
                "Buzzer": self.buzzer,
                "R_led": self.r_led,
                "G_led": self.g_led,
                "direction": self.direction,
            }

        try:
            self._patch(payload)
            with self.lock:
                self.connected = True
                self.last_error = ""
        except Exception as exc:
            with self.lock:
                self.connected = False
                self.last_error = f"Firebase write error: {exc}"

    def report_vision_fault(self, active: bool) -> None:
        """Called by the AI detection loop for every processed frame."""
        with self.lock:
            changed = active != self.vision_fault_active
            self.vision_fault_active = active

        if changed:
            self._apply_alert_state()

    def set_direction(self, direction: str) -> None:
        direction = direction.strip().upper()
        if direction not in {"F", "B", "S"}:
            raise ValueError("Direction must be F, B, or S.")

        with self.lock:
            if self.fault_active and direction != "S":
                raise RuntimeError(
                    "Movement blocked: a fault is active and the robot "
                    "is held at STOP."
                )
            self.direction = direction

        try:
            self._patch({"direction": direction})
            with self.lock:
                self.connected = True
                self.last_error = ""
        except Exception as exc:
            with self.lock:
                self.last_error = f"Firebase write error: {exc}"
            raise RuntimeError(f"Could not reach Firebase: {exc}") from exc

    # -- Background polling of device-written fields -------------------------

    def _poll_once(self) -> None:
        data = self._read_all()

        def as_float(value: Any) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0

        ax = as_float(data.get("Ax"))
        ay = as_float(data.get("Ay"))
        az = as_float(data.get("Az"))
        button = int(as_float(data.get("Button")))

        mpu_fault = (
            abs(ax) >= MPU_ACCEL_ALERT_THRESHOLD
            or abs(ay) >= MPU_ACCEL_ALERT_THRESHOLD
            or abs(az) >= MPU_ACCEL_ALERT_THRESHOLD
        )

        with self.lock:
            self.mpu = {"Ax": ax, "Ay": ay, "Az": az}
            self.button = button
            self.connected = True
            self.last_error = ""

            self.history.append(
                {
                    "t": datetime.now().isoformat(timespec="seconds"),
                    "Ax": ax,
                    "Ay": ay,
                    "Az": az,
                }
            )
            if len(self.history) > FIREBASE_HISTORY_LENGTH:
                self.history = self.history[-FIREBASE_HISTORY_LENGTH:]

            mpu_fault_changed = mpu_fault != self.mpu_fault_active
            self.mpu_fault_active = mpu_fault

            # Button=1 on the robot raises the same alert as a detected
            # defect (red LED on, green LED off, buzzer on, STOP).
            button_fault = button == 1
            button_fault_changed = button_fault != self.button_fault_active
            self.button_fault_active = button_fault

        if mpu_fault_changed or button_fault_changed:
            self._apply_alert_state()

    def _poll_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self._poll_once()
            except Exception as exc:
                with self.lock:
                    self.connected = False
                    self.last_error = f"Firebase read error: {exc}"

            self.stop_event.wait(FIREBASE_POLL_INTERVAL_SECONDS)

    def start(self) -> None:
        # Push an initial "everything normal" state so the robot starts
        # in a known-safe condition.
        self._apply_alert_state()

        self.poll_thread = threading.Thread(
            target=self._poll_loop,
            name="firebase-poll",
            daemon=True,
        )
        self.poll_thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.poll_thread and self.poll_thread.is_alive():
            self.poll_thread.join(timeout=5.0)

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "connected": self.connected,
                "last_error": self.last_error,
                "mpu": dict(self.mpu),
                "button": self.button,
                "direction": self.direction,
                "buzzer": self.buzzer,
                "r_led": self.r_led,
                "g_led": self.g_led,
                "vision_fault_active": self.vision_fault_active,
                "mpu_fault_active": self.mpu_fault_active,
                "button_fault_active": self.button_fault_active,
                "fault_active": self.fault_active,
                "mpu_alert_threshold": MPU_ACCEL_ALERT_THRESHOLD,
                "history": list(self.history),
            }


# ---------------------------------------------------------------------------
# Detection and camera engine
# ---------------------------------------------------------------------------

def intersection_over_union(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> float:
    ax1, ay1, ax2, ay2 = first
    bx1, by1, bx2, by2 = second

    intersection_x1 = max(ax1, bx1)
    intersection_y1 = max(ay1, by1)
    intersection_x2 = min(ax2, bx2)
    intersection_y2 = min(ay2, by2)

    intersection_width = max(0, intersection_x2 - intersection_x1)
    intersection_height = max(0, intersection_y2 - intersection_y1)
    intersection_area = intersection_width * intersection_height

    first_area = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    second_area = max(0, bx2 - bx1) * max(0, by2 - by1)
    union_area = first_area + second_area - intersection_area

    if union_area <= 0:
        return 0.0

    return intersection_area / union_area


class RailwayInspectionEngine:
    def __init__(
        self,
        model: YOLO | None,
        model_path: Path | None,
        model_error: str | None,
        database: InspectionDatabase,
        firebase: "FirebaseBridge | None" = None,
    ) -> None:
        self.model = model
        self.model_path = model_path
        self.model_error = model_error
        self.database = database
        self.firebase = firebase

        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.worker_thread: threading.Thread | None = None
        self.capture: cv2.VideoCapture | None = None

        self.camera_running = False
        self.camera_connected = False
        self.source_type = "webcam"
        self.source_value = "0"

        self.confidence_threshold = DEFAULT_CONFIDENCE
        self.iou_threshold = DEFAULT_IOU
        self.image_size = DEFAULT_IMAGE_SIZE

        self.round_active = False
        self.current_round_id: int | None = None

        self.latest_jpeg = self._placeholder_jpeg(
            "Camera is stopped"
        )
        self.latest_detection = {
            "defect": "None",
            "confidence": 0.0,
            "timestamp": "",
        }

        self.last_error = model_error or ""
        self.fps = 0.0
        self.detection_fps = 0.0

        self.recent_events: list[dict[str, Any]] = []

        # The capture loop publishes frames here; the inference loop reads
        # them independently so a slow model never blocks the video stream.
        self.inference_thread: threading.Thread | None = None
        self.latest_raw_frame: np.ndarray | None = None
        self.latest_overlay_detections: list[dict[str, Any]] = []

    @staticmethod
    def _placeholder_jpeg(message: str) -> bytes:
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        image[:] = (18, 25, 38)

        cv2.putText(
            image,
            "AI-Powered Railway Track Inspection Robot",
            (80, 290),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.25,
            (233, 240, 248),
            3,
            cv2.LINE_AA,
        )
        cv2.putText(
            image,
            message,
            (80, 360),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.95,
            (94, 234, 212),
            2,
            cv2.LINE_AA,
        )

        success, encoded = cv2.imencode(
            ".jpg",
            image,
            [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
        )
        return encoded.tobytes() if success else b""

    def _model_class_name(self, class_id: int) -> str:
        if self.model is None:
            return FINAL_CLASS_NAMES.get(
                class_id,
                f"class_{class_id}",
            )

        names = getattr(self.model, "names", FINAL_CLASS_NAMES)

        if isinstance(names, dict):
            return str(names.get(class_id, f"class_{class_id}"))

        if isinstance(names, (list, tuple)):
            if 0 <= class_id < len(names):
                return str(names[class_id])

        return FINAL_CLASS_NAMES.get(class_id, f"class_{class_id}")

    def _open_capture(self) -> cv2.VideoCapture:
        if self.source_type == "webcam":
            webcam_index = int(self.source_value)

            if os.name == "nt":
                capture = cv2.VideoCapture(
                    webcam_index,
                    cv2.CAP_DSHOW,
                )
            else:
                capture = cv2.VideoCapture(webcam_index)

            # MJPG must be requested before resolution/FPS on the DSHOW
            # backend, otherwise many webcams fall back to raw YUY2 that
            # gets misread as garbled/static frames, and streaming is
            # limited to a much lower FPS ceiling.
            capture.set(
                cv2.CAP_PROP_FOURCC,
                cv2.VideoWriter_fourcc(*"MJPG"),
            )
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            capture.set(cv2.CAP_PROP_FPS, 30)
        else:
            # CAP_FFMPEG is useful for most RTSP/HTTP IP-camera streams.
            capture = cv2.VideoCapture(
                self.source_value,
                cv2.CAP_FFMPEG,
            )

        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return capture

    def start_camera(
        self,
        source_type: str,
        source_value: str,
        confidence: float,
    ) -> None:
        if self.model is None:
            raise RuntimeError(
                self.model_error
                or "The YOLO model could not be loaded."
            )

        if source_type not in {"webcam", "ip"}:
            raise ValueError("Camera type must be webcam or ip.")

        if source_type == "webcam":
            try:
                int(source_value)
            except ValueError as exc:
                raise ValueError(
                    "Webcam index must be a number such as 0 or 1."
                ) from exc
        elif not source_value.strip():
            raise ValueError(
                "Enter the RTSP or HTTP IP-camera stream URL."
            )

        confidence = max(
            MINIMUM_CONFIDENCE,
            min(float(confidence), 0.95),
        )

        self.stop_camera()

        with self.lock:
            self.source_type = source_type
            self.source_value = source_value.strip()
            self.confidence_threshold = confidence
            self.camera_running = True
            self.camera_connected = False
            self.last_error = ""
            self.latest_jpeg = self._placeholder_jpeg(
                "Connecting to camera..."
            )
            self.recent_events.clear()
            self.stop_event.clear()
            self.latest_raw_frame = None
            self.latest_overlay_detections = []

            self.worker_thread = threading.Thread(
                target=self._capture_loop,
                name="railway-camera-capture",
                daemon=True,
            )
            self.worker_thread.start()

            self.inference_thread = threading.Thread(
                target=self._inference_loop,
                name="railway-camera-inference",
                daemon=True,
            )
            self.inference_thread.start()

    def stop_camera(self) -> None:
        with self.lock:
            self.stop_event.set()
            worker = self.worker_thread
            inference_worker = self.inference_thread

        if worker and worker.is_alive():
            worker.join(timeout=5.0)
        if inference_worker and inference_worker.is_alive():
            inference_worker.join(timeout=5.0)

        with self.lock:
            if self.capture is not None:
                self.capture.release()
                self.capture = None

            if self.round_active and self.current_round_id is not None:
                self.database.stop_round(self.current_round_id)

            self.round_active = False
            self.current_round_id = None
            self.camera_running = False
            self.camera_connected = False
            self.worker_thread = None
            self.inference_thread = None
            self.recent_events.clear()
            self.latest_raw_frame = None
            self.latest_overlay_detections = []
            self.latest_jpeg = self._placeholder_jpeg(
                "Camera is stopped"
            )
            self.fps = 0.0
            self.detection_fps = 0.0

    def start_round(self) -> int:
        with self.lock:
            if not self.camera_running:
                raise RuntimeError(
                    "Start the camera before starting an inspection round."
                )

            if not self.camera_connected:
                raise RuntimeError(
                    "Wait until the camera connection is active."
                )

            if self.round_active:
                raise RuntimeError(
                    f"Inspection round {self.current_round_id} is already active."
                )

            round_id = self.database.start_round(
                self.source_type,
                self.source_value,
            )

            self.current_round_id = round_id
            self.round_active = True
            self.recent_events.clear()
            return round_id

    def stop_round(self) -> int:
        with self.lock:
            if not self.round_active or self.current_round_id is None:
                raise RuntimeError("No inspection round is active.")

            round_id = self.current_round_id
            self.database.stop_round(round_id)
            self.round_active = False
            self.current_round_id = None
            self.recent_events.clear()
            return round_id

    def clear_history(self) -> int:
        """Delete saved fault records and their evidence images."""
        with self.lock:
            keep_round_id = (
                self.current_round_id if self.round_active else None
            )
            self.recent_events.clear()
            filenames = self.database.clear_history(keep_round_id)

        # Remove every evidence image, including orphans from failed writes.
        for image_path in SAVED_IMAGES_DIR.glob("*.jpg"):
            try:
                image_path.unlink()
            except OSError:
                pass

        return len(filenames)

    def _is_new_fault_event(
        self,
        class_key: str,
        bbox: tuple[int, int, int, int],
        timestamp: float,
    ) -> bool:
        self.recent_events = [
            event
            for event in self.recent_events
            if timestamp - float(event["last_seen"])
            <= EVENT_MEMORY_SECONDS
        ]

        best_event: dict[str, Any] | None = None
        best_iou = 0.0

        for event in self.recent_events:
            if event["class_key"] != class_key:
                continue

            event_iou = intersection_over_union(
                bbox,
                event["bbox"],
            )
            if event_iou > best_iou:
                best_iou = event_iou
                best_event = event

        if best_event is not None and best_iou >= EVENT_MATCH_IOU:
            best_event["bbox"] = bbox
            best_event["last_seen"] = timestamp
            return False

        self.recent_events.append(
            {
                "class_key": class_key,
                "bbox": bbox,
                "last_seen": timestamp,
            }
        )
        return True

    def _save_fault_image(
        self,
        annotated_frame: np.ndarray,
        class_key: str,
    ) -> str:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        safe_class = "".join(
            character
            for character in class_key
            if character.isalnum() or character in {"_", "-"}
        )
        filename = (
            f"{timestamp}_{safe_class}_{uuid.uuid4().hex[:6]}.jpg"
        )
        output_path = SAVED_IMAGES_DIR / filename

        if not cv2.imwrite(
            str(output_path),
            annotated_frame,
            [cv2.IMWRITE_JPEG_QUALITY, 95],
        ):
            raise RuntimeError(
                f"Could not save fault image: {output_path}"
            )

        return filename

    @staticmethod
    def _detection_color(class_id: int) -> tuple[int, int, int]:
        return (
            40 + (class_id * 53) % 190,
            90 + (class_id * 79) % 150,
            220 - (class_id * 31) % 170,
        )

    @staticmethod
    def _draw_detection_box(
        image: np.ndarray,
        detection: dict[str, Any],
    ) -> None:
        x1, y1, x2, y2 = detection["bbox"]
        color = detection["color"]
        label = (
            f"{detection['display_name']} "
            f"{detection['confidence'] * 100:.1f}%"
        )
        frame_height, frame_width = image.shape[:2]

        cv2.rectangle(image, (x1, y1), (x2, y2), color, 3)

        (label_width, label_height), baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            2,
        )

        label_top = max(0, y1 - label_height - baseline - 12)
        cv2.rectangle(
            image,
            (x1, label_top),
            (
                min(frame_width - 1, x1 + label_width + 14),
                y1,
            ),
            color,
            -1,
        )
        cv2.putText(
            image,
            label,
            (x1 + 7, max(label_height + 3, y1 - 7)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

    def _detect_markers(self, frame: np.ndarray) -> list[dict[str, Any]]:
        """Convert visible markers to defects without exposing marker names."""
        # Blur before thresholding: raw webcam noise speckles the mask and
        # splits one pen stroke into fragments that each fall under the
        # minimum area, so an obvious marker produced no detection at all.
        blurred = cv2.GaussianBlur(frame, (5, 5), 0)
        hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
        saturation = hsv[:, :, 1]
        height, width = frame.shape[:2]
        frame_area = height * width
        minimum_area = max(MARKER_MIN_PIXELS, frame_area * MARKER_MIN_AREA_RATIO)

        masks: dict[tuple[str, ...], np.ndarray] = {}
        for (lower, upper), class_keys in MARKER_RULES:
            mask = cv2.inRange(
                hsv,
                np.array(lower, dtype=np.uint8),
                np.array(upper, dtype=np.uint8),
            )
            if class_keys in masks:
                mask = cv2.bitwise_or(masks[class_keys], mask)
            masks[class_keys] = mask

        detections = []
        class_ids = {key: index for index, key in FINAL_CLASS_NAMES.items()}
        open_kernel = np.ones((3, 3), dtype=np.uint8)
        close_kernel = np.ones((7, 7), dtype=np.uint8)
        for class_keys, mask in masks.items():
            # Open drops isolated noise pixels; close rejoins the gaps a thin
            # or broken marker stroke leaves behind so it stays one contour.
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, open_kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel)
            area_floor = minimum_area
            contours, _ = cv2.findContours(
                mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
            )
            candidates: list[tuple[float, dict[str, Any]]] = []
            for contour in contours:
                area = cv2.contourArea(contour)
                if area < area_floor:
                    continue
                x, y, box_width, box_height = cv2.boundingRect(contour)
                box_area = box_width * box_height
                short_side = min(box_width, box_height)
                aspect = max(box_width, box_height) / max(1, short_side)
                # A hairline band spanning the frame edge is compression or
                # letterbox trim, never a marker, so require some thickness
                # and a sane aspect ratio as well as an area.
                if (
                    short_side < 5
                    or aspect > MARKER_MAX_ASPECT_RATIO
                    or box_area / frame_area > MAX_DETECTION_AREA_RATIO
                ):
                    continue
                # Marker confidence describes how convincing the coloured
                # region is, not a model probability that a real railway
                # defect is present. Scoring it on bounding-box fill alone
                # (as before) rejected every real marker, because a hand-drawn
                # stroke covers only a fraction of its box; colour purity and
                # size carry the rest of the score.
                region_mask = mask[y:y + box_height, x:x + box_width]
                fill_score = min(1.0, (area / box_area) / 0.55)
                size_score = min(1.0, area / (area_floor * 6.0))
                mean_saturation = float(cv2.mean(
                    saturation[y:y + box_height, x:x + box_width],
                    mask=region_mask,
                )[0])
                purity_score = min(1.0, mean_saturation / 160.0)
                confidence = min(
                    0.99,
                    0.45
                    + 0.25 * fill_score
                    + 0.22 * purity_score
                    + 0.08 * size_score,
                )
                if confidence < MARKER_MIN_CONFIDENCE:
                    continue
                candidates.append((area, {
                    "confidence": confidence,
                    "bbox": (x, y, x + box_width, y + box_height),
                }))

            candidates.sort(key=lambda item: item[0], reverse=True)
            for _, candidate in candidates[:MARKER_MAX_PER_CLASS]:
                for class_key in class_keys:
                    detections.append({
                        "class_key": class_key,
                        "display_name": DISPLAY_NAMES[class_key],
                        "confidence": candidate["confidence"],
                        "bbox": candidate["bbox"],
                        "color": self._detection_color(class_ids[class_key]),
                    })

        # A marker whose hue sits on a band boundary (a pink stroke reaching
        # into the red band, for example) matches two rules and used to be
        # reported as two different defects. Keep the strongest class for any
        # one physical region.
        detections.sort(
            key=lambda item: (
                item["confidence"],
                (item["bbox"][2] - item["bbox"][0])
                * (item["bbox"][3] - item["bbox"][1]),
            ),
            reverse=True,
        )
        kept: list[dict[str, Any]] = []
        for detection in detections:
            overlaps = any(
                other["class_key"] != detection["class_key"]
                and intersection_over_union(
                    other["bbox"], detection["bbox"]
                ) >= MARKER_CROSS_CLASS_IOU
                for other in kept
            )
            if not overlaps:
                kept.append(detection)
        return kept

    def _detect(self, frame: np.ndarray) -> list[dict[str, Any]]:
        # Always run best.pt as well as the internal marker detector.
        detections = self._detect_model(frame)
        for marker in self._detect_markers(frame):
            duplicate = any(
                item["class_key"] == marker["class_key"]
                and intersection_over_union(item["bbox"], marker["bbox"]) >= EVENT_MATCH_IOU
                for item in detections
            )
            if not duplicate:
                detections.append(marker)
        return detections

    def _detect_model(self, frame: np.ndarray) -> list[dict[str, Any]]:
        assert self.model is not None

        results = self.model.predict(
            source=frame,
            conf=self.confidence_threshold,
            iou=self.iou_threshold,
            imgsz=self.image_size,
            verbose=False,
        )

        detections: list[dict[str, Any]] = []

        if not results:
            return detections

        boxes = getattr(results[0], "boxes", None)
        if boxes is None or len(boxes) == 0:
            return detections

        xyxy_values = boxes.xyxy.cpu().numpy()
        confidence_values = boxes.conf.cpu().numpy()
        class_values = boxes.cls.cpu().numpy().astype(int)
        frame_height, frame_width = frame.shape[:2]

        for bbox_array, confidence, class_id in zip(
            xyxy_values,
            confidence_values,
            class_values,
        ):
            class_id = int(class_id)
            x1, y1, x2, y2 = [
                int(round(value)) for value in bbox_array.tolist()
            ]
            x1 = max(0, min(x1, frame_width - 1))
            y1 = max(0, min(y1, frame_height - 1))
            x2 = max(0, min(x2, frame_width - 1))
            y2 = max(0, min(y2, frame_height - 1))

            model_name = self._model_class_name(class_id)
            class_key = canonical_class_name(model_name, class_id)
            if class_key not in DISPLAY_NAMES:
                continue

            required_confidence = max(
                self.confidence_threshold,
                CLASS_CONFIDENCE_FLOORS.get(class_key, 0.0),
            )
            if float(confidence) < required_confidence:
                continue

            box_width = max(0, x2 - x1)
            box_height = max(0, y2 - y1)
            frame_area = max(1, frame_width * frame_height)
            box_area_ratio = (box_width * box_height) / frame_area
            if (
                box_width < 4
                or box_height < 4
                or box_area_ratio > MAX_DETECTION_AREA_RATIO
            ):
                continue

            display_name = DISPLAY_NAMES.get(
                class_key,
                class_key.replace("_", " ").title(),
            )

            detections.append(
                {
                    "class_key": class_key,
                    "display_name": display_name,
                    "confidence": float(confidence),
                    "bbox": (x1, y1, x2, y2),
                    "color": self._detection_color(class_id),
                }
            )

        return detections

    def _handle_detections(
        self,
        frame: np.ndarray,
        detections: list[dict[str, Any]],
    ) -> None:
        with self.lock:
            round_active = self.round_active
            round_id = self.current_round_id
            source_type = self.source_type
            source_value = self.source_value

        current_time = time.monotonic()

        if self.firebase is not None:
            self.firebase.report_vision_fault(bool(detections))

        if detections:
            highest = max(
                detections,
                key=lambda detection: detection["confidence"],
            )
            with self.lock:
                self.latest_detection = {
                    "defect": ", ".join(dict.fromkeys(
                        detection["display_name"] for detection in detections
                    )),
                    "confidence": round(
                        highest["confidence"] * 100,
                        2,
                    ),
                    "timestamp": datetime.now().isoformat(
                        timespec="seconds"
                    ),
                }
        else:
            # Do not leave a previous fault displayed after the current frame
            # is clean; that made a one-frame false positive look permanent.
            with self.lock:
                self.latest_detection = {
                    "defect": "None",
                    "confidence": 0.0,
                    "timestamp": "",
                }

        # Save and count only while an inspection round is active.
        if not (round_active and round_id is not None):
            return

        for detection in detections:
            is_new = self._is_new_fault_event(
                detection["class_key"],
                detection["bbox"],
                current_time,
            )

            if not is_new:
                continue

            try:
                evidence = frame.copy()
                self._draw_detection_box(evidence, detection)
                image_filename = self._save_fault_image(
                    evidence,
                    detection["class_key"],
                )
                self.database.add_fault(
                    round_id=round_id,
                    defect_key=detection["class_key"],
                    defect_name=detection["display_name"],
                    confidence=detection["confidence"],
                    image_filename=image_filename,
                    source_type=source_type,
                    source_value=source_value,
                )
            except Exception as exc:
                with self.lock:
                    self.last_error = f"Fault record error: {exc}"

    def _draw_overlay(
        self,
        frame: np.ndarray,
        detections: list[dict[str, Any]],
        round_active: bool,
        round_id: int | None,
    ) -> np.ndarray:
        annotated = frame

        for detection in detections:
            self._draw_detection_box(annotated, detection)

        status_text = (
            f"ROUND {round_id} ACTIVE"
            if round_active and round_id is not None
            else "INSPECTION ROUND NOT ACTIVE"
        )
        status_color = (
            (35, 220, 120)
            if round_active
            else (65, 165, 255)
        )

        cv2.rectangle(
            annotated,
            (12, 12),
            (510, 58),
            (10, 18, 30),
            -1,
        )
        cv2.putText(
            annotated,
            status_text,
            (26, 44),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.73,
            status_color,
            2,
            cv2.LINE_AA,
        )

        cv2.putText(
            annotated,
            f"Stream {self.fps:.1f} FPS   AI {self.detection_fps:.1f} FPS",
            (annotated.shape[1] - 400, 42),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.62,
            (240, 245, 250),
            2,
            cv2.LINE_AA,
        )

        return annotated

    def _inference_loop(self) -> None:
        frame_counter = 0
        fps_started_at = time.perf_counter()

        while not self.stop_event.is_set():
            with self.lock:
                frame = self.latest_raw_frame
                model_ready = self.model is not None

            if frame is None or not model_ready:
                time.sleep(0.01)
                continue

            try:
                detections = self._detect(frame)

                with self.lock:
                    self.latest_overlay_detections = detections

                self._handle_detections(frame, detections)

                frame_counter += 1
                elapsed = time.perf_counter() - fps_started_at
                if elapsed >= 1.0:
                    self.detection_fps = frame_counter / elapsed
                    frame_counter = 0
                    fps_started_at = time.perf_counter()

            except Exception as exc:
                with self.lock:
                    self.last_error = f"Detection error: {exc}"
                time.sleep(0.5)

    def _capture_loop(self) -> None:
        consecutive_read_failures = 0
        frame_counter = 0
        fps_started_at = time.perf_counter()

        while not self.stop_event.is_set():
            try:
                if self.capture is None or not self.capture.isOpened():
                    if self.capture is not None:
                        self.capture.release()

                    self.capture = self._open_capture()

                    if not self.capture.isOpened():
                        with self.lock:
                            self.camera_connected = False
                            self.last_error = (
                                "Could not open the selected camera. "
                                "Check the webcam index or IP-camera URL."
                            )
                            self.latest_jpeg = self._placeholder_jpeg(
                                "Camera connection failed; retrying..."
                            )
                        time.sleep(2.0)
                        continue

                    with self.lock:
                        self.camera_connected = True
                        self.last_error = ""

                success, frame = self.capture.read()

                if (
                    success
                    and frame is not None
                    and float(frame.std()) < 10.0
                ):
                    # A near-flat/uniform frame is almost always a broken
                    # MJPG decode (common with Windows camera-effects
                    # drivers fighting over the device), not a real image.
                    # Treat it the same as a failed read instead of
                    # displaying or running detection on garbage.
                    success = False
                    frame = None

                if not success or frame is None:
                    consecutive_read_failures += 1

                    if consecutive_read_failures >= 20:
                        with self.lock:
                            self.camera_connected = False
                            self.last_error = (
                                "Camera frames stopped. Reconnecting..."
                            )
                        self.capture.release()
                        self.capture = None
                        consecutive_read_failures = 0
                        time.sleep(1.0)
                    else:
                        time.sleep(0.03)
                    continue

                consecutive_read_failures = 0
                with self.lock:
                    self.camera_connected = True
                    self.latest_raw_frame = frame

                frame_counter += 1
                elapsed = time.perf_counter() - fps_started_at
                if elapsed >= 1.0:
                    self.fps = frame_counter / elapsed
                    frame_counter = 0
                    fps_started_at = time.perf_counter()

                with self.lock:
                    detections_snapshot = list(
                        self.latest_overlay_detections
                    )
                    round_active = self.round_active
                    round_id = self.current_round_id

                annotated = self._draw_overlay(
                    frame.copy(),
                    detections_snapshot,
                    round_active,
                    round_id,
                )

                success, encoded = cv2.imencode(
                    ".jpg",
                    annotated,
                    [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
                )
                if success:
                    with self.lock:
                        self.latest_jpeg = encoded.tobytes()

            except Exception as exc:
                with self.lock:
                    self.last_error = f"Processing error: {exc}"
                    self.camera_connected = False
                    self.latest_jpeg = self._placeholder_jpeg(
                        "Detection error; see dashboard status"
                    )
                time.sleep(1.0)

        with self.lock:
            if self.capture is not None:
                self.capture.release()
                self.capture = None
            self.camera_connected = False

    def jpeg_stream(self):
        while True:
            with self.lock:
                frame_bytes = self.latest_jpeg

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + frame_bytes
                + b"\r\n"
            )
            time.sleep(0.015)

    def status(self) -> dict[str, Any]:
        with self.lock:
            round_id = self.current_round_id
            status_data = {
                "camera_running": self.camera_running,
                "camera_connected": self.camera_connected,
                "source_type": self.source_type,
                "source_value": self.source_value,
                "confidence_threshold": self.confidence_threshold,
                "round_active": self.round_active,
                "current_round_id": round_id,
                "latest_detection": dict(self.latest_detection),
                "current_detections": [
                    {
                        "class_key": detection["class_key"],
                        "display_name": detection["display_name"],
                        "confidence": round(
                            float(detection["confidence"]) * 100, 1
                        ),
                    }
                    for detection in sorted(
                        self.latest_overlay_detections,
                        key=lambda item: item["confidence"],
                        reverse=True,
                    )
                ] if self.camera_running else [],
                "last_error": self.last_error,
                "fps": round(self.fps, 1),
                "detection_fps": round(self.detection_fps, 1),
                "model_loaded": self.model is not None,
                "model_path": (
                    str(self.model_path)
                    if self.model_path is not None
                    else ""
                ),
                "model_classes": (
                    getattr(self.model, "names", {})
                    if self.model is not None
                    else {}
                ),
            }

        status_data.update(self.database.totals())
        status_data["current_round_counts"] = (
            self.database.round_counts(round_id)
        )
        return status_data


# ---------------------------------------------------------------------------
# Load model
# ---------------------------------------------------------------------------

MODEL_PATH = locate_model_file()
MODEL: YOLO | None = None
MODEL_ERROR: str | None = None

if MODEL_PATH is None:
    MODEL_ERROR = (
        "No .pt model was found. Put best.pt in the same folder as app.py."
    )
else:
    try:
        MODEL = YOLO(str(MODEL_PATH))
        validate_model_classes(MODEL)
    except Exception as exc:
        MODEL = None
        MODEL_ERROR = (
            f"Could not load model '{MODEL_PATH.name}': {exc}"
        )


database = InspectionDatabase(DATABASE_PATH)
firebase_bridge = FirebaseBridge(
    database_url=FIREBASE_DATABASE_URL,
    node_path=FIREBASE_NODE_PATH,
    auth_token=FIREBASE_AUTH_TOKEN,
)
firebase_bridge.start()

engine = RailwayInspectionEngine(
    model=MODEL,
    model_path=MODEL_PATH,
    model_error=MODEL_ERROR,
    database=database,
    firebase=firebase_bridge,
)


# ---------------------------------------------------------------------------
# Flask application and embedded user interface
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


INDEX_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >
    <meta name="theme-color" content="#07111f">
    <title>AI-Powered Railway Track Inspection Robot</title>

    <style>
        :root {
            --bg: #07111f;
            --panel: rgba(15, 28, 46, 0.92);
            --panel-soft: rgba(20, 38, 61, 0.78);
            --line: rgba(148, 163, 184, 0.18);
            --text: #eef6ff;
            --muted: #9fb2c9;
            --primary: #22d3ee;
            --primary-dark: #0891b2;
            --success: #34d399;
            --warning: #fbbf24;
            --danger: #fb7185;
            --shadow: 0 18px 55px rgba(0, 0, 0, 0.28);
            --radius: 20px;
        }

        * {
            box-sizing: border-box;
        }

        html {
            scroll-behavior: smooth;
        }

        body {
            margin: 0;
            min-height: 100vh;
            color: var(--text);
            background:
                radial-gradient(
                    circle at 10% 0%,
                    rgba(34, 211, 238, 0.14),
                    transparent 34%
                ),
                radial-gradient(
                    circle at 100% 12%,
                    rgba(99, 102, 241, 0.13),
                    transparent 32%
                ),
                var(--bg);
            font-family:
                Inter, ui-sans-serif, system-ui, -apple-system,
                BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        button,
        input,
        select {
            font: inherit;
        }

        .page {
            width: min(1540px, 100%);
            margin: 0 auto;
            padding: 22px;
        }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            margin-bottom: 20px;
            padding: 18px 20px;
            border: 1px solid var(--line);
            border-radius: var(--radius);
            background: var(--panel);
            box-shadow: var(--shadow);
            backdrop-filter: blur(16px);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 14px;
            min-width: 0;
        }

        .brand-icon {
            display: grid;
            place-items: center;
            width: 52px;
            height: 52px;
            flex: 0 0 auto;
            border-radius: 16px;
            color: #02131b;
            background:
                linear-gradient(135deg, #67e8f9, #22d3ee);
            box-shadow: 0 12px 30px rgba(34, 211, 238, 0.25);
            font-size: 26px;
            font-weight: 900;
        }

        .brand h1 {
            margin: 0;
            font-size: clamp(1rem, 2.2vw, 1.55rem);
            line-height: 1.2;
        }

        .brand p {
            margin: 5px 0 0;
            color: var(--muted);
            font-size: 0.9rem;
        }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 9px 13px;
            border: 1px solid var(--line);
            border-radius: 999px;
            background: rgba(15, 23, 42, 0.72);
            color: var(--muted);
            white-space: nowrap;
        }

        .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #64748b;
            box-shadow: 0 0 0 4px rgba(100, 116, 139, 0.14);
        }

        .dot.online {
            background: var(--success);
            box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.14);
        }

        .dot.warning {
            background: var(--warning);
            box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.14);
        }

        .dashboard {
            display: grid;
            grid-template-columns: minmax(0, 1.65fr) minmax(310px, 0.72fr);
            gap: 20px;
        }

        .panel {
            border: 1px solid var(--line);
            border-radius: var(--radius);
            background: var(--panel);
            box-shadow: var(--shadow);
            backdrop-filter: blur(16px);
            overflow: hidden;
        }

        .panel-heading {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 16px 18px;
            border-bottom: 1px solid var(--line);
        }

        .panel-heading h2 {
            margin: 0;
            font-size: 1rem;
        }

        .panel-heading span {
            color: var(--muted);
            font-size: 0.82rem;
        }

        .video-wrap {
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
            min-height: 280px;
            background: #020817;
            overflow: hidden;
        }

        .video-wrap img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .live-badge {
            position: absolute;
            top: 14px;
            right: 14px;
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 7px 11px;
            border-radius: 999px;
            color: #fff;
            background: rgba(2, 8, 23, 0.72);
            border: 1px solid rgba(255, 255, 255, 0.15);
            font-size: 0.78rem;
            font-weight: 700;
            backdrop-filter: blur(10px);
        }

        .controls {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 12px;
            padding: 17px;
        }

        .field {
            grid-column: span 3;
        }

        .field.wide {
            grid-column: span 6;
        }

        .field label {
            display: block;
            margin-bottom: 7px;
            color: var(--muted);
            font-size: 0.8rem;
            font-weight: 650;
        }

        input,
        select {
            width: 100%;
            height: 44px;
            padding: 0 12px;
            color: var(--text);
            border: 1px solid var(--line);
            border-radius: 12px;
            outline: none;
            background: rgba(2, 8, 23, 0.52);
            transition:
                border-color 0.2s ease,
                box-shadow 0.2s ease;
        }

        input:focus,
        select:focus {
            border-color: rgba(34, 211, 238, 0.7);
            box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.12);
        }

        .action-row {
            grid-column: 1 / -1;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            padding-top: 2px;
        }

        .btn {
            min-height: 42px;
            padding: 0 15px;
            border: 0;
            border-radius: 12px;
            cursor: pointer;
            color: #06121d;
            background: var(--primary);
            font-weight: 800;
            transition:
                transform 0.15s ease,
                opacity 0.15s ease,
                box-shadow 0.15s ease;
        }

        .btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 10px 25px rgba(34, 211, 238, 0.19);
        }

        .btn:disabled {
            cursor: not-allowed;
            opacity: 0.42;
        }

        .btn.secondary {
            color: var(--text);
            background: #334155;
        }

        .btn.success {
            color: #032218;
            background: var(--success);
        }

        .btn.danger {
            color: #2b0710;
            background: var(--danger);
        }

        .sidebar {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .metric-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
            padding: 15px;
        }

        .metric {
            min-height: 112px;
            padding: 15px;
            border: 1px solid var(--line);
            border-radius: 16px;
            background:
                linear-gradient(
                    145deg,
                    rgba(30, 52, 80, 0.82),
                    rgba(10, 21, 37, 0.72)
                );
        }

        .metric .label {
            color: var(--muted);
            font-size: 0.78rem;
            font-weight: 700;
        }

        .metric .value {
            margin-top: 8px;
            font-size: clamp(1.45rem, 3.5vw, 2.15rem);
            font-weight: 900;
            letter-spacing: -0.04em;
        }

        .metric .sub {
            margin-top: 6px;
            color: var(--muted);
            font-size: 0.73rem;
        }

        .latest-detection {
            padding: 18px;
        }

        .latest-box {
            padding: 17px;
            border: 1px solid rgba(34, 211, 238, 0.26);
            border-radius: 16px;
            background: rgba(34, 211, 238, 0.07);
        }

        .latest-box strong {
            display: block;
            margin-bottom: 8px;
            font-size: 1.15rem;
        }

        .confidence {
            color: var(--primary);
            font-size: 1.8rem;
            font-weight: 900;
        }

        .current-detection {
            padding: 18px;
        }

        .current-state {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 12px;
            padding: 12px 14px;
            border: 1px solid var(--line);
            border-radius: 14px;
            background: rgba(2, 8, 23, 0.4);
            font-weight: 800;
        }

        .current-state.alert {
            border-color: rgba(251, 113, 133, 0.45);
            color: #fff1f2;
            background: rgba(190, 18, 60, 0.3);
        }

        .current-state.clear {
            border-color: rgba(52, 211, 153, 0.4);
            color: var(--success);
            background: rgba(52, 211, 153, 0.08);
        }

        .current-state small {
            color: var(--muted);
            font-weight: 600;
        }

        .current-list {
            display: flex;
            flex-direction: column;
            gap: 9px;
        }

        .current-item {
            padding: 10px 12px;
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--panel-soft);
        }

        .current-item .row {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            font-size: 0.86rem;
            font-weight: 800;
        }

        .current-item .row span:last-child {
            color: var(--primary);
        }

        .conf-bar {
            height: 6px;
            margin-top: 7px;
            border-radius: 999px;
            background: rgba(148, 163, 184, 0.18);
            overflow: hidden;
        }

        .conf-bar i {
            display: block;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, var(--primary), var(--danger));
        }

        .current-empty {
            color: var(--muted);
            font-size: 0.82rem;
            text-align: center;
            padding: 8px 0 2px;
        }

        .heading-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .btn.small {
            min-height: 34px;
            padding: 0 12px;
            font-size: 0.8rem;
        }

        .error-box {
            display: none;
            margin: 0 17px 17px;
            padding: 12px 13px;
            border: 1px solid rgba(251, 113, 133, 0.3);
            border-radius: 13px;
            color: #fecdd3;
            background: rgba(136, 19, 55, 0.25);
            white-space: pre-wrap;
            word-break: break-word;
            font-size: 0.82rem;
        }

        .defects-panel,
        .history-panel {
            margin-top: 20px;
        }

        .defect-grid {
            display: grid;
            grid-template-columns: repeat(6, minmax(0, 1fr));
            gap: 12px;
            padding: 16px;
        }

        .defect-card {
            padding: 14px;
            border: 1px solid var(--line);
            border-radius: 15px;
            background: var(--panel-soft);
        }

        .defect-card .name {
            min-height: 34px;
            color: var(--muted);
            font-size: 0.78rem;
            font-weight: 700;
        }

        .defect-card .count {
            margin-top: 8px;
            font-size: 1.55rem;
            font-weight: 900;
        }

        .defect-card .round-count {
            margin-top: 4px;
            color: var(--primary);
            font-size: 0.72rem;
        }

        .history-container {
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 850px;
        }

        th,
        td {
            padding: 12px 14px;
            border-bottom: 1px solid var(--line);
            text-align: left;
            vertical-align: middle;
            font-size: 0.82rem;
        }

        th {
            color: var(--muted);
            background: rgba(2, 8, 23, 0.38);
            font-weight: 800;
        }

        .thumb {
            width: 110px;
            height: 68px;
            object-fit: cover;
            border: 1px solid var(--line);
            border-radius: 10px;
            background: #020817;
        }

        .fault-name {
            font-weight: 800;
        }

        .empty-row {
            padding: 30px;
            color: var(--muted);
            text-align: center;
        }

        .footer {
            padding: 22px 4px 4px;
            color: var(--muted);
            text-align: center;
            font-size: 0.78rem;
        }

        .fault-banner {
            margin: 0 17px 17px;
            padding: 13px 15px;
            border: 1px solid rgba(251, 113, 133, 0.4);
            border-radius: 13px;
            color: #fff1f2;
            background: rgba(190, 18, 60, 0.35);
            font-weight: 800;
            letter-spacing: 0.01em;
            animation: fault-pulse 1.4s ease-in-out infinite;
        }

        @keyframes fault-pulse {
            0%, 100% { box-shadow: 0 0 0 rgba(251, 113, 133, 0.0); }
            50% { box-shadow: 0 0 0 6px rgba(251, 113, 133, 0.12); }
        }

        .control-grid {
            display: grid;
            grid-template-columns: minmax(220px, 0.85fr) minmax(0, 1.4fr);
            gap: 18px;
            padding: 17px;
        }

        .joystick-block {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
        }

        .joystick {
            display: grid;
            grid-template-columns: repeat(3, 64px);
            grid-template-rows: repeat(3, 64px);
            gap: 8px;
            place-items: center;
        }

        .joy-btn {
            grid-column: 2;
            width: 64px;
            height: 64px;
            border: 1px solid var(--line);
            border-radius: 16px;
            color: var(--text);
            background: rgba(2, 8, 23, 0.55);
            font-size: 0.68rem;
            font-weight: 800;
            line-height: 1.3;
            cursor: pointer;
            transition:
                transform 0.15s ease,
                background 0.15s ease,
                opacity 0.15s ease;
        }

        .joy-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            background: rgba(34, 211, 238, 0.16);
        }

        .joy-btn:disabled {
            cursor: not-allowed;
            opacity: 0.35;
        }

        #dirForward {
            grid-row: 1;
        }

        #dirStop {
            grid-row: 2;
            color: #2b0710;
            background: var(--danger);
        }

        #dirStop:hover:not(:disabled) {
            background: var(--danger);
            opacity: 0.9;
        }

        #dirBackward {
            grid-row: 3;
        }

        .direction-readout {
            color: var(--muted);
            font-size: 0.85rem;
        }

        .direction-readout strong {
            color: var(--primary);
            font-size: 1.1rem;
        }

        .sensor-block {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .sensor-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
            gap: 10px;
        }

        .sensor-chip {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 11px 12px;
            border: 1px solid var(--line);
            border-radius: 13px;
            background: var(--panel-soft);
        }

        .sensor-chip .label {
            color: var(--muted);
            font-size: 0.72rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        .sensor-chip .value {
            font-size: 1.15rem;
            font-weight: 800;
        }

        .sensor-chip.active .value {
            color: var(--danger);
        }

        .sensor-chip.normal .value {
            color: var(--success);
        }

        .graph-wrap {
            padding: 17px;
        }

        #mpuChart {
            display: block;
            width: 100%;
            height: 260px;
            border: 1px solid var(--line);
            border-radius: 14px;
            background: #020817;
        }

        .graph-legend {
            display: flex;
            gap: 18px;
            margin-top: 10px;
            color: var(--muted);
            font-size: 0.78rem;
        }

        .legend-item {
            display: inline-flex;
            align-items: center;
            gap: 7px;
        }

        .legend-item i {
            width: 11px;
            height: 11px;
            border-radius: 3px;
        }

        @media (max-width: 720px) {
            .control-grid {
                grid-template-columns: 1fr;
            }
        }

        .toast {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 100;
            width: min(390px, calc(100vw - 40px));
            padding: 13px 15px;
            border: 1px solid var(--line);
            border-radius: 14px;
            color: var(--text);
            background: rgba(15, 28, 46, 0.97);
            box-shadow: var(--shadow);
            opacity: 0;
            transform: translateY(16px);
            pointer-events: none;
            transition: 0.25s ease;
        }

        .toast.show {
            opacity: 1;
            transform: translateY(0);
        }

        .hidden {
            display: none !important;
        }

        @media (max-width: 1100px) {
            .dashboard {
                grid-template-columns: 1fr;
            }

            .sidebar {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            .defect-grid {
                grid-template-columns: repeat(3, minmax(0, 1fr));
            }
        }

        @media (max-width: 720px) {
            .page {
                padding: 10px;
            }

            .topbar {
                align-items: flex-start;
                padding: 14px;
                border-radius: 16px;
            }

            .brand-icon {
                width: 44px;
                height: 44px;
                border-radius: 13px;
            }

            .brand p {
                display: none;
            }

            .status-pill {
                padding: 7px 9px;
                font-size: 0.73rem;
            }

            .panel {
                border-radius: 16px;
            }

            .video-wrap {
                min-height: 210px;
            }

            .controls {
                grid-template-columns: 1fr;
                padding: 13px;
            }

            .field,
            .field.wide,
            .action-row {
                grid-column: 1 / -1;
            }

            .action-row .btn {
                flex: 1 1 calc(50% - 8px);
            }

            .sidebar {
                grid-template-columns: 1fr;
            }

            .metric-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            .defect-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            .panel-heading {
                padding: 14px;
            }
        }

        @media (max-width: 420px) {
            .topbar {
                flex-direction: column;
            }

            .metric-grid {
                grid-template-columns: 1fr;
            }

            .action-row .btn {
                flex-basis: 100%;
            }

            .defect-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>

<body>
    <main class="page">
        <header class="topbar">
            <div class="brand">
                <div class="brand-icon">AI</div>
                <div>
                    <h1>AI-Powered Railway Track Inspection Robot</h1>
                    <p>
                        Real-time railway fault detection, evidence capture,
                        and inspection history
                    </p>
                </div>
            </div>

            <div class="status-pill">
                <span id="cameraDot" class="dot"></span>
                <span id="cameraStatus">Camera stopped</span>
            </div>
        </header>

        <section class="dashboard">
            <article class="panel">
                <div class="panel-heading">
                    <h2>Live AI Inspection</h2>
                    <span id="fpsText">0.0 FPS</span>
                </div>

                <div class="video-wrap">
                    <img
                        id="videoFeed"
                        src="/video_feed"
                        alt="Live railway inspection video"
                    >
                    <div class="live-badge">
                        <span id="roundDot" class="dot"></span>
                        <span id="roundStatus">Round inactive</span>
                    </div>
                </div>

                <div class="controls">
                    <div class="field">
                        <label for="sourceType">Camera Source</label>
                        <select id="sourceType">
                            <option value="webcam">Webcam</option>
                            <option value="ip">IP / RTSP Camera</option>
                        </select>
                    </div>

                    <div id="webcamField" class="field">
                        <label for="webcamIndex">Webcam Index</label>
                        <input
                            id="webcamIndex"
                            type="number"
                            min="0"
                            step="1"
                            value="0"
                        >
                    </div>

                    <div id="ipField" class="field wide hidden">
                        <label for="ipUrl">IP-Camera Stream URL</label>
                        <input
                            id="ipUrl"
                            type="text"
                            placeholder="rtsp://username:password@192.168.1.10:554/stream"
                        >
                    </div>

                    <div class="field">
                        <label for="confidence">
                            Minimum Confidence
                        </label>
                        <input
                            id="confidence"
                            type="number"
                            min="0.50"
                            max="0.95"
                            step="0.05"
                            value="0.70"
                        >
                    </div>

                    <div class="action-row">
                        <button
                            id="startCameraButton"
                            class="btn"
                            type="button"
                        >
                            Start Camera
                        </button>

                        <button
                            id="stopCameraButton"
                            class="btn secondary"
                            type="button"
                        >
                            Stop Camera
                        </button>

                        <button
                            id="startRoundButton"
                            class="btn success"
                            type="button"
                        >
                            Start Inspection Round
                        </button>

                        <button
                            id="stopRoundButton"
                            class="btn danger"
                            type="button"
                        >
                            End Inspection Round
                        </button>
                    </div>
                </div>

                <div id="errorBox" class="error-box"></div>
            </article>

            <aside class="sidebar">
                <article class="panel">
                    <div class="panel-heading">
                        <h2>Inspection Summary</h2>
                        <span>Persistent totals</span>
                    </div>

                    <div class="metric-grid">
                        <div class="metric">
                            <div class="label">Inspection Rounds</div>
                            <div id="totalRounds" class="value">0</div>
                            <div id="currentRound" class="sub">
                                Current: none
                            </div>
                        </div>

                        <div class="metric">
                            <div class="label">Total Detected Faults</div>
                            <div id="totalFaults" class="value">0</div>
                            <div class="sub">
                                Saved with timestamped evidence
                            </div>
                        </div>

                        <div class="metric">
                            <div class="label">Stream FPS</div>
                            <div id="metricFps" class="value">0.0</div>
                            <div id="metricDetectionFps" class="sub">
                                AI inference: 0.0 fps
                            </div>
                        </div>

                        <div class="metric">
                            <div class="label">AI Model</div>
                            <div
                                id="modelState"
                                class="value"
                                style="font-size: 1.35rem"
                            >
                                Loading
                            </div>
                            <div
                                id="modelFile"
                                class="sub"
                                title=""
                            >
                                best.pt
                            </div>
                        </div>
                    </div>
                </article>

                <article class="panel">
                    <div class="panel-heading">
                        <h2>Current Detection</h2>
                        <span>Live frame</span>
                    </div>

                    <div class="current-detection">
                        <div id="currentState" class="current-state">
                            <span id="currentStateText">Camera stopped</span>
                            <small id="currentStateCount">0 in frame</small>
                        </div>
                        <div id="currentList" class="current-list">
                            <div class="current-empty">
                                Start the camera to see live detections.
                            </div>
                        </div>
                    </div>
                </article>

                <article class="panel">
                    <div class="panel-heading">
                        <h2>Latest AI Detection</h2>
                        <span>Highest confidence</span>
                    </div>

                    <div class="latest-detection">
                        <div class="latest-box">
                            <strong id="latestDefect">
                                No defect detected
                            </strong>
                            <div id="latestConfidence" class="confidence">
                                0.0%
                            </div>
                            <div
                                id="latestTime"
                                style="
                                    margin-top: 7px;
                                    color: var(--muted);
                                    font-size: 0.78rem;
                                "
                            >
                                Waiting for camera
                            </div>
                        </div>
                    </div>
                </article>
            </aside>
        </section>

        <section class="panel defects-panel">
            <div class="panel-heading">
                <h2>Defect-Type Counters</h2>
                <span>
                    Total count Â· current inspection round
                </span>
            </div>

            <div id="defectGrid" class="defect-grid"></div>
        </section>

        <section class="panel control-panel">
            <div class="panel-heading">
                <h2>Robot Remote Control &amp; Track Sensor</h2>
                <span id="firebaseStatus">Firebase: connectingâ€¦</span>
            </div>

            <div id="faultBanner" class="fault-banner hidden">
                FAULT DETECTED â€” robot stopped automatically
            </div>

            <div class="control-grid">
                <div class="joystick-block">
                    <div class="joystick">
                        <button
                            id="dirForward"
                            class="joy-btn"
                            type="button"
                        >â–²<br>Forward</button>
                        <button
                            id="dirStop"
                            class="joy-btn"
                            type="button"
                        >â– <br>Stop</button>
                        <button
                            id="dirBackward"
                            class="joy-btn"
                            type="button"
                        >â–¼<br>Backward</button>
                    </div>
                    <div class="direction-readout">
                        Direction:
                        <strong id="directionValue">S</strong>
                    </div>
                </div>

                <div class="sensor-block">
                    <div class="sensor-row">
                        <div class="sensor-chip">
                            <span class="label">Ax</span>
                            <span id="mpuAx" class="value">0.00</span>
                        </div>
                        <div class="sensor-chip">
                            <span class="label">Ay</span>
                            <span id="mpuAy" class="value">0.00</span>
                        </div>
                        <div class="sensor-chip">
                            <span class="label">Az</span>
                            <span id="mpuAz" class="value">0.00</span>
                        </div>
                        <div class="sensor-chip">
                            <span class="label">Button</span>
                            <span id="mpuButton" class="value">0</span>
                        </div>
                    </div>
                    <div class="sensor-row">
                        <div id="chipBuzzer" class="sensor-chip">
                            <span class="label">Buzzer</span>
                            <span id="mpuBuzzer" class="value">0</span>
                        </div>
                        <div id="chipRled" class="sensor-chip">
                            <span class="label">R LED</span>
                            <span id="mpuRled" class="value">0</span>
                        </div>
                        <div id="chipGled" class="sensor-chip">
                            <span class="label">G LED</span>
                            <span id="mpuGled" class="value">0</span>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <section class="panel graph-panel">
            <div class="panel-heading">
                <h2>Track Vibration â€” MPU6050 Accelerometer</h2>
                <span>
                    Alert threshold: Â±<span id="thresholdValue">1.5</span>
                </span>
            </div>

            <div class="graph-wrap">
                <canvas id="mpuChart" width="1200" height="260"></canvas>
                <div class="graph-legend">
                    <span class="legend-item">
                        <i style="background: #22d3ee"></i>Ax
                    </span>
                    <span class="legend-item">
                        <i style="background: #34d399"></i>Ay
                    </span>
                    <span class="legend-item">
                        <i style="background: #fbbf24"></i>Az
                    </span>
                </div>
            </div>
        </section>

        <section class="panel history-panel">
            <div class="panel-heading">
                <h2>Fault History and Image Records</h2>
                <div class="heading-actions">
                    <span id="historyCount">Latest records</span>
                    <button
                        id="clearHistoryButton"
                        class="btn danger small"
                        type="button"
                    >
                        Delete History
                    </button>
                </div>
            </div>

            <div class="history-container">
                <table>
                    <thead>
                        <tr>
                            <th>Evidence</th>
                            <th>Date and Time</th>
                            <th>Round</th>
                            <th>Defect</th>
                            <th>AI Confidence</th>
                            <th>Camera Source</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody">
                        <tr>
                            <td class="empty-row" colspan="6">
                                No saved faults yet.
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <footer class="footer">
            Images are stored in the
            <strong>saved_faults</strong> folder beside app.py.
        </footer>
    </main>

    <div id="toast" class="toast"></div>

    <script>
        const DEFECTS = [
            ["rail_crack", "Crack"],
            ["rail_gap", "Rail Gap"],
            ["track_obstacle", "Track Obstacle"],
            ["damaged_sleeper", "Damaged Sleeper"],
            ["missing_track_section", "Missing Track Section"],
            ["track_misalignment", "Track Misalignment"],
        ];

        const elements = {
            sourceType: document.getElementById("sourceType"),
            webcamField: document.getElementById("webcamField"),
            ipField: document.getElementById("ipField"),
            webcamIndex: document.getElementById("webcamIndex"),
            ipUrl: document.getElementById("ipUrl"),
            confidence: document.getElementById("confidence"),

            startCameraButton:
                document.getElementById("startCameraButton"),
            stopCameraButton:
                document.getElementById("stopCameraButton"),
            startRoundButton:
                document.getElementById("startRoundButton"),
            stopRoundButton:
                document.getElementById("stopRoundButton"),

            cameraDot: document.getElementById("cameraDot"),
            cameraStatus: document.getElementById("cameraStatus"),
            roundDot: document.getElementById("roundDot"),
            roundStatus: document.getElementById("roundStatus"),
            fpsText: document.getElementById("fpsText"),
            metricFps: document.getElementById("metricFps"),
            metricDetectionFps: document.getElementById(
                "metricDetectionFps"
            ),

            totalRounds: document.getElementById("totalRounds"),
            totalFaults: document.getElementById("totalFaults"),
            currentRound: document.getElementById("currentRound"),

            latestDefect: document.getElementById("latestDefect"),
            latestConfidence:
                document.getElementById("latestConfidence"),
            latestTime: document.getElementById("latestTime"),

            modelState: document.getElementById("modelState"),
            modelFile: document.getElementById("modelFile"),
            errorBox: document.getElementById("errorBox"),

            defectGrid: document.getElementById("defectGrid"),
            historyBody: document.getElementById("historyBody"),
            historyCount: document.getElementById("historyCount"),
            clearHistoryButton:
                document.getElementById("clearHistoryButton"),
            currentState: document.getElementById("currentState"),
            currentStateText: document.getElementById("currentStateText"),
            currentStateCount:
                document.getElementById("currentStateCount"),
            currentList: document.getElementById("currentList"),
            toast: document.getElementById("toast"),

            firebaseStatus: document.getElementById("firebaseStatus"),
            faultBanner: document.getElementById("faultBanner"),
            dirForward: document.getElementById("dirForward"),
            dirStop: document.getElementById("dirStop"),
            dirBackward: document.getElementById("dirBackward"),
            directionValue: document.getElementById("directionValue"),
            mpuAx: document.getElementById("mpuAx"),
            mpuAy: document.getElementById("mpuAy"),
            mpuAz: document.getElementById("mpuAz"),
            mpuButton: document.getElementById("mpuButton"),
            mpuBuzzer: document.getElementById("mpuBuzzer"),
            mpuRled: document.getElementById("mpuRled"),
            mpuGled: document.getElementById("mpuGled"),
            chipBuzzer: document.getElementById("chipBuzzer"),
            chipRled: document.getElementById("chipRled"),
            chipGled: document.getElementById("chipGled"),
            thresholdValue: document.getElementById("thresholdValue"),
            mpuChart: document.getElementById("mpuChart"),
        };

        let latestHistorySignature = "";
        let toastTimer = null;
        let lastFaultActive = false;

        function escapeHtml(value) {
            return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#039;");
        }

        function showToast(message) {
            elements.toast.textContent = message;
            elements.toast.classList.add("show");

            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                elements.toast.classList.remove("show");
            }, 3200);
        }

        async function apiRequest(url, options = {}) {
            const response = await fetch(url, {
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {}),
                },
                ...options,
            });

            let payload = {};
            try {
                payload = await response.json();
            } catch (error) {
                payload = {};
            }

            if (!response.ok || payload.ok === false) {
                throw new Error(
                    payload.error
                    || `Request failed with status ${response.status}`
                );
            }

            return payload;
        }

        function updateSourceFields() {
            const isWebcam = elements.sourceType.value === "webcam";
            elements.webcamField.classList.toggle(
                "hidden",
                !isWebcam,
            );
            elements.ipField.classList.toggle(
                "hidden",
                isWebcam,
            );
        }

        function buildDefectCards(
            totals = {},
            roundCounts = {},
        ) {
            elements.defectGrid.innerHTML = DEFECTS
                .map(([key, name]) => `
                    <div class="defect-card">
                        <div class="name">${escapeHtml(name)}</div>
                        <div class="count">
                            ${Number(totals[key] || 0)}
                        </div>
                        <div class="round-count">
                            Current round:
                            ${Number(roundCounts[key] || 0)}
                        </div>
                    </div>
                `)
                .join("");
        }

        function formatTimestamp(value) {
            if (!value) {
                return "â€”";
            }

            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) {
                return value;
            }

            return parsed.toLocaleString();
        }

        function renderHistory(records) {
            const signature = records
                .map((record) => record.id)
                .join(",");

            if (signature === latestHistorySignature) {
                return;
            }
            latestHistorySignature = signature;

            elements.historyCount.textContent =
                `${records.length} latest record(s)`;

            if (!records.length) {
                elements.historyBody.innerHTML = `
                    <tr>
                        <td class="empty-row" colspan="6">
                            No saved faults yet.
                        </td>
                    </tr>
                `;
                return;
            }

            elements.historyBody.innerHTML = records
                .map((record) => `
                    <tr>
                        <td>
                            <a
                                href="/saved/${encodeURIComponent(
                                    record.image_filename
                                )}"
                                target="_blank"
                                rel="noopener"
                            >
                                <img
                                    class="thumb"
                                    src="/saved/${encodeURIComponent(
                                        record.image_filename
                                    )}"
                                    alt="${escapeHtml(record.defect_name)}"
                                    loading="lazy"
                                >
                            </a>
                        </td>
                        <td>
                            ${escapeHtml(
                                formatTimestamp(record.detected_at)
                            )}
                        </td>
                        <td>#${Number(record.round_id)}</td>
                        <td class="fault-name">
                            ${escapeHtml(record.defect_name)}
                        </td>
                        <td>
                            ${(Number(record.confidence) * 100).toFixed(1)}%
                        </td>
                        <td>
                            ${escapeHtml(record.source_type)}
                            <br>
                            <small style="color: var(--muted)">
                                ${escapeHtml(record.source_value)}
                            </small>
                        </td>
                    </tr>
                `)
                .join("");
        }

        function renderCurrentDetections(data) {
            const detections = data.current_detections || [];
            const cameraOnline =
                data.camera_running && data.camera_connected;

            elements.currentState.className = "current-state";
            elements.currentStateCount.textContent =
                `${detections.length} in frame`;

            if (!cameraOnline) {
                elements.currentStateText.textContent =
                    data.camera_running ? "Connectingâ€¦" : "Camera stopped";
                elements.currentList.innerHTML = `
                    <div class="current-empty">
                        Start the camera to see live detections.
                    </div>
                `;
                return;
            }

            if (!detections.length) {
                elements.currentState.classList.add("clear");
                elements.currentStateText.textContent = "Track clear";
                elements.currentList.innerHTML = `
                    <div class="current-empty">
                        No defect in the current frame.
                    </div>
                `;
                return;
            }

            elements.currentState.classList.add("alert");
            elements.currentStateText.textContent = "Defect in view";
            elements.currentList.innerHTML = detections
                .map((detection) => {
                    const confidence = Number(detection.confidence || 0);
                    return `
                        <div class="current-item">
                            <div class="row">
                                <span>${escapeHtml(detection.display_name)}</span>
                                <span>${confidence.toFixed(1)}%</span>
                            </div>
                            <div class="conf-bar">
                                <i style="width: ${Math.min(100, confidence)}%"></i>
                            </div>
                        </div>
                    `;
                })
                .join("");
        }

        function updateStatus(data) {
            renderCurrentDetections(data);

            const cameraOnline =
                data.camera_running && data.camera_connected;
            const cameraConnecting =
                data.camera_running && !data.camera_connected;

            elements.cameraDot.className = "dot";
            if (cameraOnline) {
                elements.cameraDot.classList.add("online");
                elements.cameraStatus.textContent = "Camera connected";
            } else if (cameraConnecting) {
                elements.cameraDot.classList.add("warning");
                elements.cameraStatus.textContent = "Camera connecting";
            } else {
                elements.cameraStatus.textContent = "Camera stopped";
            }

            elements.roundDot.className = "dot";
            if (data.round_active) {
                elements.roundDot.classList.add("online");
                elements.roundStatus.textContent =
                    `Round ${data.current_round_id} active`;
            } else {
                elements.roundStatus.textContent = "Round inactive";
            }

            elements.fpsText.textContent =
                `${Number(data.fps || 0).toFixed(1)} FPS`;
            elements.metricFps.textContent =
                Number(data.fps || 0).toFixed(1);
            elements.metricDetectionFps.textContent =
                `AI inference: ${
                    Number(data.detection_fps || 0).toFixed(1)
                } fps`;

            elements.totalRounds.textContent =
                Number(data.total_rounds || 0);
            elements.totalFaults.textContent =
                Number(data.total_faults || 0);
            elements.currentRound.textContent =
                data.round_active
                    ? `Current: #${data.current_round_id}`
                    : "Current: none";

            const latest = data.latest_detection || {};
            const hasLatest =
                latest.defect && latest.defect !== "None";

            elements.latestDefect.textContent =
                hasLatest
                    ? latest.defect
                    : "No defect detected";
            elements.latestConfidence.textContent =
                `${Number(latest.confidence || 0).toFixed(1)}%`;
            elements.latestTime.textContent =
                latest.timestamp
                    ? formatTimestamp(latest.timestamp)
                    : "Waiting for detection";

            elements.modelState.textContent =
                data.model_loaded ? "Ready" : "Error";
            elements.modelState.style.color =
                data.model_loaded
                    ? "var(--success)"
                    : "var(--danger)";

            const modelPath = data.model_path || "No model";
            const modelFile = modelPath.split(/[\\/]/).pop();
            elements.modelFile.textContent = modelFile;
            elements.modelFile.title = modelPath;

            if (data.last_error) {
                elements.errorBox.style.display = "block";
                elements.errorBox.textContent = data.last_error;
            } else {
                elements.errorBox.style.display = "none";
                elements.errorBox.textContent = "";
            }

            elements.startCameraButton.disabled =
                data.camera_running || !data.model_loaded;
            elements.stopCameraButton.disabled =
                !data.camera_running;
            elements.startRoundButton.disabled =
                !cameraOnline || data.round_active;
            elements.stopRoundButton.disabled =
                !data.round_active;

            buildDefectCards(
                data.defect_totals || {},
                data.current_round_counts || {},
            );
        }

        async function refreshStatus() {
            try {
                const response = await fetch(
                    "/api/status",
                    { cache: "no-store" },
                );

                if (!response.ok) {
                    throw new Error("Could not read application status.");
                }

                const data = await response.json();
                updateStatus(data);
            } catch (error) {
                elements.errorBox.style.display = "block";
                elements.errorBox.textContent = error.message;
            }
        }

        async function refreshHistory() {
            try {
                const response = await fetch(
                    "/api/history?limit=100",
                    { cache: "no-store" },
                );

                if (!response.ok) {
                    throw new Error("Could not load fault history.");
                }

                const data = await response.json();
                renderHistory(data.records || []);
            } catch (error) {
                console.error(error);
            }
        }

        function drawMpuChart(history, threshold) {
            const canvas = elements.mpuChart;
            const context = canvas.getContext("2d");
            const width = canvas.clientWidth || canvas.width;
            const height = canvas.clientHeight || canvas.height;

            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;

            context.clearRect(0, 0, width, height);

            if (!history.length) {
                context.fillStyle = "rgba(159, 178, 201, 0.7)";
                context.font = "13px Inter, sans-serif";
                context.fillText(
                    "Waiting for accelerometer data from Firebase...",
                    16,
                    height / 2,
                );
                return;
            }

            const padding = 14;
            const plotWidth = width - padding * 2;
            const plotHeight = height - padding * 2;

            const allValues = history.flatMap((point) => [
                point.Ax,
                point.Ay,
                point.Az,
            ]);
            let maxAbs = Math.max(
                threshold,
                ...allValues.map((value) => Math.abs(value)),
            );
            maxAbs = maxAbs * 1.15 || 1;

            const midY = padding + plotHeight / 2;
            const scaleY = (plotHeight / 2) / maxAbs;

            function yFor(value) {
                return midY - value * scaleY;
            }

            function xFor(index) {
                if (history.length <= 1) return padding;
                return padding + (index / (history.length - 1)) * plotWidth;
            }

            // Zero line
            context.strokeStyle = "rgba(148, 163, 184, 0.25)";
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(padding, midY);
            context.lineTo(width - padding, midY);
            context.stroke();

            // Alert threshold lines
            context.strokeStyle = "rgba(251, 113, 133, 0.35)";
            context.setLineDash([5, 4]);
            [threshold, -threshold].forEach((value) => {
                context.beginPath();
                context.moveTo(padding, yFor(value));
                context.lineTo(width - padding, yFor(value));
                context.stroke();
            });
            context.setLineDash([]);

            function drawSeries(key, color) {
                context.strokeStyle = color;
                context.lineWidth = 2;
                context.beginPath();
                history.forEach((point, index) => {
                    const x = xFor(index);
                    const y = yFor(Number(point[key]) || 0);
                    if (index === 0) {
                        context.moveTo(x, y);
                    } else {
                        context.lineTo(x, y);
                    }
                });
                context.stroke();
            }

            drawSeries("Ax", "#22d3ee");
            drawSeries("Ay", "#34d399");
            drawSeries("Az", "#fbbf24");
        }

        function setChipState(chipEl, valueEl, active) {
            valueEl.textContent = active ? "1" : "0";
            chipEl.classList.toggle("active", active);
            chipEl.classList.toggle("normal", !active);
        }

        function updateFirebaseUI(data) {
            elements.firebaseStatus.textContent = data.connected
                ? "Firebase: connected"
                : `Firebase: ${data.last_error || "disconnected"}`;

            const mpu = data.mpu || {};
            elements.mpuAx.textContent = Number(mpu.Ax || 0).toFixed(2);
            elements.mpuAy.textContent = Number(mpu.Ay || 0).toFixed(2);
            elements.mpuAz.textContent = Number(mpu.Az || 0).toFixed(2);
            elements.mpuButton.textContent = Number(data.button || 0);

            setChipState(
                elements.chipBuzzer,
                elements.mpuBuzzer,
                Boolean(data.buzzer),
            );
            setChipState(
                elements.chipRled,
                elements.mpuRled,
                Boolean(data.r_led),
            );
            setChipState(
                elements.chipGled,
                elements.mpuGled,
                Boolean(data.g_led),
            );

            elements.directionValue.textContent = data.direction || "S";
            elements.thresholdValue.textContent =
                data.mpu_alert_threshold ?? "1.5";

            const faultActive = Boolean(data.fault_active);
            elements.faultBanner.classList.toggle("hidden", !faultActive);
            elements.dirForward.disabled = faultActive;
            elements.dirBackward.disabled = faultActive;

            if (faultActive && !lastFaultActive) {
                showToast(
                    "Fault detected â€” robot stopped, buzzer and red LED on.",
                );
            }
            lastFaultActive = faultActive;

            drawMpuChart(data.history || [], data.mpu_alert_threshold || 1.5);
        }

        async function refreshFirebaseState() {
            try {
                const response = await fetch(
                    "/api/firebase/state",
                    { cache: "no-store" },
                );

                if (!response.ok) {
                    throw new Error("Could not read hardware status.");
                }

                const data = await response.json();
                updateFirebaseUI(data);
            } catch (error) {
                elements.firebaseStatus.textContent =
                    `Firebase: ${error.message}`;
            }
        }

        async function sendDirection(direction) {
            try {
                await apiRequest("/api/firebase/direction", {
                    method: "POST",
                    body: JSON.stringify({ direction }),
                });
                showToast(`Direction set to ${direction}.`);
                await refreshFirebaseState();
            } catch (error) {
                showToast(error.message);
            }
        }

        elements.dirForward.addEventListener("click", () => {
            sendDirection("F");
        });
        elements.dirStop.addEventListener("click", () => {
            sendDirection("S");
        });
        elements.dirBackward.addEventListener("click", () => {
            sendDirection("B");
        });

        elements.sourceType.addEventListener(
            "change",
            updateSourceFields,
        );

        elements.startCameraButton.addEventListener(
            "click",
            async () => {
                try {
                    const sourceType = elements.sourceType.value;
                    const sourceValue =
                        sourceType === "webcam"
                            ? elements.webcamIndex.value.trim()
                            : elements.ipUrl.value.trim();

                    await apiRequest("/api/camera/start", {
                        method: "POST",
                        body: JSON.stringify({
                            source_type: sourceType,
                            source_value: sourceValue,
                            confidence:
                                Number(elements.confidence.value),
                        }),
                    });

                    showToast("Camera startup requested.");
                    await refreshStatus();
                } catch (error) {
                    showToast(error.message);
                }
            },
        );

        elements.stopCameraButton.addEventListener(
            "click",
            async () => {
                try {
                    await apiRequest("/api/camera/stop", {
                        method: "POST",
                        body: "{}",
                    });

                    showToast("Camera stopped.");
                    await refreshStatus();
                } catch (error) {
                    showToast(error.message);
                }
            },
        );

        elements.startRoundButton.addEventListener(
            "click",
            async () => {
                try {
                    const result = await apiRequest(
                        "/api/round/start",
                        {
                            method: "POST",
                            body: "{}",
                        },
                    );

                    showToast(
                        `Inspection round ${result.round_id} started.`,
                    );
                    await Promise.all([
                        refreshStatus(),
                        refreshHistory(),
                    ]);
                } catch (error) {
                    showToast(error.message);
                }
            },
        );

        elements.stopRoundButton.addEventListener(
            "click",
            async () => {
                try {
                    const result = await apiRequest(
                        "/api/round/stop",
                        {
                            method: "POST",
                            body: "{}",
                        },
                    );

                    showToast(
                        `Inspection round ${result.round_id} ended.`,
                    );
                    await Promise.all([
                        refreshStatus(),
                        refreshHistory(),
                    ]);
                } catch (error) {
                    showToast(error.message);
                }
            },
        );

        elements.clearHistoryButton.addEventListener(
            "click",
            async () => {
                const confirmed = window.confirm(
                    "Delete all fault history, inspection rounds and saved "
                    + "evidence images? This cannot be undone.",
                );
                if (!confirmed) {
                    return;
                }

                elements.clearHistoryButton.disabled = true;
                try {
                    const result = await apiRequest(
                        "/api/history/clear",
                        {
                            method: "POST",
                            body: "{}",
                        },
                    );

                    showToast(
                        `History deleted (${result.deleted} record(s)).`,
                    );
                    latestHistorySignature = null;
                    await Promise.all([
                        refreshStatus(),
                        refreshHistory(),
                    ]);
                } catch (error) {
                    showToast(error.message);
                } finally {
                    elements.clearHistoryButton.disabled = false;
                }
            },
        );

        updateSourceFields();
        buildDefectCards();
        refreshStatus();
        refreshHistory();
        refreshFirebaseState();

        setInterval(refreshStatus, 1000);
        setInterval(refreshHistory, 2500);
        setInterval(refreshFirebaseState, 1000);
        window.addEventListener("resize", refreshFirebaseState);
    </script>
</body>
</html>
"""


@app.get("/")
def index():
    return render_template_string(INDEX_HTML)


@app.get("/video_feed")
def video_feed():
    return Response(
        engine.jpeg_stream(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.post("/api/camera/start")
def start_camera():
    payload = request.get_json(silent=True) or {}

    source_type = str(
        payload.get("source_type", "webcam")
    ).strip().lower()
    source_value = str(
        payload.get("source_value", "0")
    ).strip()

    try:
        confidence = float(
            payload.get(
                "confidence",
                DEFAULT_CONFIDENCE,
            )
        )
        engine.start_camera(
            source_type=source_type,
            source_value=source_value,
            confidence=confidence,
        )
        return jsonify(
            {
                "ok": True,
                "message": "Camera startup requested.",
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 400


@app.post("/api/camera/stop")
def stop_camera():
    try:
        engine.stop_camera()
        return jsonify(
            {
                "ok": True,
                "message": "Camera stopped.",
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 500


@app.post("/api/round/start")
def start_round():
    try:
        round_id = engine.start_round()
        return jsonify(
            {
                "ok": True,
                "round_id": round_id,
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 400


@app.post("/api/round/stop")
def stop_round():
    try:
        round_id = engine.stop_round()
        return jsonify(
            {
                "ok": True,
                "round_id": round_id,
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 400


@app.get("/api/status")
def status():
    return jsonify(engine.status())


@app.get("/api/history")
def history():
    try:
        limit = int(request.args.get("limit", 100))
    except ValueError:
        limit = 100

    return jsonify(
        {
            "ok": True,
            "records": database.history(limit),
        }
    )


@app.post("/api/history/clear")
def clear_history():
    try:
        deleted = engine.clear_history()
        return jsonify(
            {
                "ok": True,
                "deleted": deleted,
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 500


@app.get("/api/firebase/state")
def firebase_state():
    return jsonify(firebase_bridge.status())


@app.post("/api/firebase/direction")
def firebase_direction():
    payload = request.get_json(silent=True) or {}
    direction = str(payload.get("direction", "")).strip().upper()

    try:
        firebase_bridge.set_direction(direction)
        return jsonify(
            {
                "ok": True,
                "direction": direction,
            }
        )
    except (ValueError, RuntimeError) as exc:
        return jsonify(
            {
                "ok": False,
                "error": str(exc),
            }
        ), 400


@app.get("/saved/<path:filename>")
def saved_image(filename: str):
    return send_from_directory(
        SAVED_IMAGES_DIR,
        filename,
        as_attachment=False,
    )


def shutdown() -> None:
    engine.stop_camera()
    firebase_bridge.stop()


atexit.register(shutdown)


if __name__ == "__main__":
    print("\n" + "=" * 72)
    print("AI-Powered Railway Track Inspection Robot")
    print("=" * 72)

    if MODEL is not None and MODEL_PATH is not None:
        print(f"Model loaded: {MODEL_PATH}")
        print(f"Model classes: {getattr(MODEL, 'names', {})}")
    else:
        print(f"MODEL ERROR: {MODEL_ERROR}")

    print(f"Saved images: {SAVED_IMAGES_DIR}")
    print(f"Database:     {DATABASE_PATH}")
    print(f"Dashboard:    http://127.0.0.1:{APP_PORT}")
    print(
        "Mobile/LAN:  open http://<THIS-PC-IP>:"
        f"{APP_PORT} on a device connected to the same network"
    )
    print("=" * 72 + "\n")

    app.run(
        host=APP_HOST,
        port=APP_PORT,
        debug=False,
        threaded=True,
        use_reloader=False,
    )