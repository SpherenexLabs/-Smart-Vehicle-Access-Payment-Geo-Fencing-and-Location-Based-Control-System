import React, { useEffect, useMemo, useRef, useState } from "react";

/*
  Smart Vehicle Access, Payment, Geo-Fencing and Location-Based Control System
  ---------------------------------------------------------------------------
  Single-file React prototype (App.jsx)

  Storage: browser localStorage on the laptop/device running the app.
  Maps: Google Maps JavaScript API loaded dynamically with the API key below.
  Payment: DEMO ONLY. No real money is charged.
  Hardware: vehicle/motor state is simulated now; replace the marked functions
            with Firebase/REST/MQTT/ESP32 calls later.
*/

const GOOGLE_MAPS_API_KEY = "AIzaSyD1mcosVgoTAA_hZGcXOvG9fbEoqrRZk94";
const SESSION_KEY = "smart_vehicle_access_session_v2";
const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 };
const EMERGENCY_DB_URL = "https://diet-planner-3bdf3-default-rtdb.firebaseio.com/ALZHEIMER_PATIENTS.json";
const OTP_TTL_MS = 60000;

function toE164India(mobile) {
  const digits = String(mobile || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("91") && digits.length === 12 ? `+${digits}` : `+91${digits.slice(-10)}`;
}

async function pushEmergencyUpdate(fields) {
  try {
    await fetch(EMERGENCY_DB_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  } catch (error) {
    console.error("Failed to update emergency alert database", error);
  }
}

const nowISO = () => new Date().toISOString();
const uid = (prefix = "ID") =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase()}`;

const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const money = (value) => `₹${Number(value || 0).toFixed(2)}`;
const numberOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

async function hashPassword(password) {
  try {
    if (!window.crypto?.subtle) return `plain:${password}`;
    const bytes = new TextEncoder().encode(password);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return `plain:${password}`;
  }
}

function geolocationErrorMessage(err) {
  if (err.code === err.PERMISSION_DENIED) {
    return "Location permission denied. Click the lock/info icon next to the address bar, set Location to Allow for this site, then try again.";
  }
  if (err.code === err.POSITION_UNAVAILABLE) {
    return "Location is unavailable. In Windows, open Settings > Privacy & security > Location and make sure Location services and Chrome access are turned on.";
  }
  if (err.code === err.TIMEOUT) {
    return "Location request timed out. Check that Windows Location services are on, then try again.";
  }
  return err.message || "Could not read your current location.";
}

async function requestGeolocation(options = { enableHighAccuracy: true, timeout: 15000 }) {
  if (!navigator.geolocation) {
    throw new Error("This browser does not support geolocation.");
  }
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "denied") {
        throw new Error(
          "Location access is blocked for this site in Chrome. Click the lock/info icon next to the address bar, set Location to Allow, then reload the page."
        );
      }
    } catch (permErr) {
      if (permErr instanceof Error && permErr.message.startsWith("Location access is blocked")) throw permErr;
    }
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => reject(new Error(geolocationErrorMessage(err))),
      options
    );
  });
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const q =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersects = yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isInsideGeoFence(point, fence) {
  if (!fence?.enabled) return true;
  if (!point) return false;
  if (fence.shape === "polygon") return pointInPolygon(point, fence.polygon);
  return distanceMeters(point, fence.center) <= Number(fence.radiusM);
}

function isValidLatLng(pos) {
  return Boolean(pos) &&
    Number.isFinite(pos.lat) && pos.lat >= -90 && pos.lat <= 90 &&
    Number.isFinite(pos.lng) && pos.lng >= -180 && pos.lng <= 180;
}

function safeRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function seedDb() {
  const created = nowISO();
  return {
    version: 4,
    meta: {
      project: "Smart Vehicle Access, Payment, Geo-Fencing and Location-Based Control System",
      quotation: "SPN-26082026-KS5723",
      createdAt: created,
      updatedAt: created,
    },
    settings: {
      geoFence: {
        shape: "circle",
        center: DEFAULT_CENTER,
        radiusM: 20000,
        polygon: [],
        arrivalRadiusM: 60,
        enabled: true,
      },
      trackingIntervalHintMs: 3000,
      fare: {
        baseFare: 20,
        perKmRate: 12,
      },
    },
    users: [],
    dropLocations: [
      { id: uid("DROP"), name: "Main Front Arch (Campus Entrance)", lat: 12.9038, lng: 77.4981, createdAt: created },
      { id: uid("DROP"), name: "Ganesha Circle (Central Junction)", lat: 12.9022, lng: 77.4975, createdAt: created },
      { id: uid("DROP"), name: "Gleneagles BGS Hospital", lat: 12.9032, lng: 77.4988, createdAt: created },
      { id: uid("DROP"), name: "Medical Block (BGS GIMS)", lat: 12.9015, lng: 77.4970, createdAt: created },
      { id: uid("DROP"), name: "BGS Global Institute of Allied Health Sciences", lat: 12.9012, lng: 77.4968, createdAt: created },
      { id: uid("DROP"), name: "BGS Global College of Nursing", lat: 12.9009, lng: 77.4965, createdAt: created },
      { id: uid("DROP"), name: "SJB Engineering Departments (SJBIT)", lat: 12.9004, lng: 77.4962, createdAt: created },
      { id: uid("DROP"), name: "Central Library Block", lat: 12.8998, lng: 77.4958, createdAt: created },
      { id: uid("DROP"), name: "SJB PU College", lat: 12.8991, lng: 77.4952, createdAt: created },
      { id: uid("DROP"), name: "Sports Ground / Outdoor Arena", lat: 12.8982, lng: 77.4945, createdAt: created },
    ],
    rides: [],
    payments: [],
    locationSamples: [],
    events: [
      {
        id: uid("EVT"),
        at: created,
        level: "info",
        type: "SYSTEM",
        actor: "System",
        message: "Dashboard database created on this browser.",
      },
    ],
    vehicle: {
      hardwareConnected: false,
      motorCommand: "OFF",
      lastCommandAt: created,
      lastCommandReason: "Dashboard-only prototype",
      esp32Status: "NOT CONNECTED",
    },
  };
}

function normalizeDb(input) {
  const base = seedDb();
  if (!input || typeof input !== "object") return base;
  return {
    ...base,
    ...input,
    meta: { ...base.meta, ...(input.meta || {}), updatedAt: nowISO() },
    settings: {
      ...base.settings,
      ...(input.settings || {}),
      geoFence: {
        ...base.settings.geoFence,
        ...(input.settings?.geoFence || {}),
        center: {
          ...base.settings.geoFence.center,
          ...(input.settings?.geoFence?.center || {}),
        },
      },
      fare: {
        ...base.settings.fare,
        ...(input.settings?.fare || {}),
      },
    },
    users: Array.isArray(input.users) ? input.users : [],
    dropLocations: Array.isArray(input.dropLocations) ? input.dropLocations : [],
    rides: Array.isArray(input.rides) ? input.rides : [],
    payments: Array.isArray(input.payments) ? input.payments : [],
    locationSamples: Array.isArray(input.locationSamples)
      ? input.locationSamples
      : [],
    events: Array.isArray(input.events) ? input.events : base.events,
    vehicle: { ...base.vehicle, ...(input.vehicle || {}) },
  };
}

function appendEvent(db, { level = "info", type, actor, message, data = null }) {
  const evt = {
    id: uid("EVT"),
    at: nowISO(),
    level,
    type,
    actor,
    message,
    data,
  };
  return {
    ...db,
    events: [evt, ...(db.events || [])].slice(0, 3000),
  };
}

function statusTone(status = "") {
  const s = String(status).toLowerCase();
  if (
    s.includes("success") ||
    s.includes("verified") ||
    s.includes("enabled") ||
    s.includes("inside") ||
    s.includes("completed") ||
    s.includes("reached") ||
    s === "paid"
  )
    return "good";
  if (
    s.includes("pending") ||
    s.includes("waiting") ||
    s.includes("approaching") ||
    s.includes("generated")
  )
    return "warn";
  if (
    s.includes("failed") ||
    s.includes("outside") ||
    s.includes("disabled") ||
    s.includes("locked") ||
    s.includes("cancel") ||
    s.includes("not connected")
  )
    return "bad";
  return "neutral";
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const duration = toast.type === "error" ? 8000 : 3500;
    const id = setTimeout(onClose, duration);
    return () => clearTimeout(id);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.type || "info"}`}>
      <strong>{toast.title || "Notice"}</strong>
      <span>{toast.message}</span>
      <button onClick={onClose}>×</button>
    </div>
  );
}

function Badge({ children, tone }) {
  return <span className={`badge ${tone || statusTone(children)}`}>{children}</span>;
}

function Empty({ text = "No records yet." }) {
  return <div className="empty">{text}</div>;
}

function Metric({ label, value, hint, icon }) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <div className="metric-value">{value}</div>
        <div className="metric-label">{label}</div>
        {hint ? <div className="metric-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, actions }) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="section-actions">{actions}</div> : null}
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function GoogleMapPanel({
  geoFence,
  currentLocation,
  deliveryPoint,
  pickupPoint,
  destinationPoint,
  onFenceCenterChange,
  onPolygonPointAdd,
  title = "Live Google Map",
  height = 430,
}) {
  const mapNode = useRef(null);
  const map = useRef(null);
  const overlays = useRef([]);
  const circle = useRef(null);
  const fencePolygon = useRef(null);
  const routeLine = useRef(null);
  const [apiState, setApiState] = useState(
    window.google?.maps ? "ready" : "loading"
  );
  const onFenceCenterChangeRef = useRef(onFenceCenterChange);
  const onPolygonPointAddRef = useRef(onPolygonPointAdd);
  useEffect(() => {
    onFenceCenterChangeRef.current = onFenceCenterChange;
    onPolygonPointAddRef.current = onPolygonPointAdd;
  });

  useEffect(() => {
    if (window.google?.maps) {
      setApiState("ready");
      return;
    }
    const existing = document.querySelector('script[data-smart-vehicle-google-map="1"]');
    if (existing) {
      const poll = setInterval(() => {
        if (window.google?.maps) {
          clearInterval(poll);
          setApiState("ready");
        }
      }, 200);
      return () => clearInterval(poll);
    }

    const script = document.createElement("script");
    script.dataset.smartVehicleGoogleMap = "1";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      GOOGLE_MAPS_API_KEY
    )}&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => setApiState("ready");
    script.onerror = () => setApiState("error");
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (apiState !== "ready" || !mapNode.current || !window.google?.maps) return;
    const center = [currentLocation, geoFence?.center, DEFAULT_CENTER].find(isValidLatLng) || DEFAULT_CENTER;
    if (!map.current) {
      map.current = new window.google.maps.Map(mapNode.current, {
        center,
        zoom: 14,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        gestureHandling: "greedy",
      });
      map.current.addListener("click", (e) => {
        const pos = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        if (onPolygonPointAddRef.current) onPolygonPointAddRef.current(pos);
        else onFenceCenterChangeRef.current?.(pos);
      });
    }
  }, [apiState, currentLocation, geoFence]);

  useEffect(() => {
    if (!map.current || apiState !== "ready" || !window.google?.maps) return;
    overlays.current.forEach((o) => o.setMap?.(null));
    overlays.current = [];
    circle.current?.setMap?.(null);
    fencePolygon.current?.setMap?.(null);
    routeLine.current?.setMap?.(null);

    const addMarker = (position, label, titleText, color = "#2563eb", variant = "dot") => {
      if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;
      const icon =
        variant === "pin"
          ? {
              path: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z",
              fillColor: color,
              fillOpacity: 1,
              strokeColor: "#7f1d1d",
              strokeWeight: 1,
              scale: 1.8,
              anchor: new window.google.maps.Point(12, 23),
              labelOrigin: new window.google.maps.Point(12, 9),
            }
          : {
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: color,
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            };
      const marker = new window.google.maps.Marker({
        map: map.current,
        position,
        title: titleText,
        label: label
          ? {
              text: String(label),
              color: "white",
              fontSize: "11px",
              fontWeight: "700",
            }
          : undefined,
        icon,
        zIndex: variant === "pin" ? 50 : 10,
      });
      overlays.current.push(marker);
    };

    if (geoFence?.enabled && geoFence?.shape === "polygon" && geoFence.polygon?.length >= 2) {
      fencePolygon.current = new window.google.maps.Polygon({
        map: map.current,
        paths: geoFence.polygon,
        fillColor: "#2563eb",
        fillOpacity: 0.14,
        strokeColor: "#2563eb",
        strokeOpacity: 0.9,
        strokeWeight: 3,
      });
    } else if (geoFence?.enabled && geoFence?.shape !== "polygon" && isValidLatLng(geoFence?.center) && numberOr(geoFence.radiusM, 0) > 0) {
      circle.current = new window.google.maps.Circle({
        map: map.current,
        center: geoFence.center,
        radius: numberOr(geoFence.radiusM, 1000),
        fillColor: "#2563eb",
        fillOpacity: 0.14,
        strokeColor: "#2563eb",
        strokeOpacity: 0.9,
        strokeWeight: 3,
      });
    }

    if (onPolygonPointAdd && Array.isArray(geoFence?.polygon)) {
      geoFence.polygon.forEach((pt, idx) => addMarker(pt, String(idx + 1), `Point ${idx + 1}`, "#2563eb"));
    }

    if (onFenceCenterChange && geoFence?.shape !== "polygon" && isValidLatLng(geoFence?.center)) {
      const centerMarker = new window.google.maps.Marker({
        map: map.current,
        position: geoFence.center,
        draggable: true,
        cursor: "move",
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#2563eb",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
        title: "Drag to move the geo-fence center, or click anywhere on the map",
        zIndex: 60,
      });
      centerMarker.addListener("dragend", (e) => {
        onFenceCenterChangeRef.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      });
      overlays.current.push(centerMarker);
    }

    if (pickupPoint)
      addMarker(pickupPoint, "P", "Pickup location (your GPS position)", "#dc2626", "pin");
    if (destinationPoint)
      addMarker(destinationPoint, "D", "Delivery destination", "#7c3aed", "pin");
    if (deliveryPoint)
      addMarker(deliveryPoint, "D", "Saved delivery address", "#ea580c");
    if (currentLocation)
      addMarker(currentLocation, null, "Your current location", "#dc2626", "pin");

    const routeStart = pickupPoint || currentLocation;
    const routeTarget = destinationPoint || deliveryPoint;
    if (routeStart && routeTarget) {
      routeLine.current = new window.google.maps.Polyline({
        map: map.current,
        path: [routeStart, routeTarget],
        strokeOpacity: 0,
        icons: [
          {
            icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#2563eb", scale: 3 },
            offset: "0",
            repeat: "14px",
          },
        ],
      });
    }

    const bounds = new window.google.maps.LatLngBounds();
    let hasBounds = false;
    if (routeStart) { bounds.extend(routeStart); hasBounds = true; }
    if (routeTarget?.lat && routeTarget?.lng) { bounds.extend(routeTarget); hasBounds = true; }
    if (hasBounds && routeStart && routeTarget) {
      map.current.fitBounds(bounds, 80);
    } else if (circle.current) {
      map.current.fitBounds(circle.current.getBounds(), 0);
    } else if (fencePolygon.current) {
      const polyBounds = new window.google.maps.LatLngBounds();
      geoFence.polygon.forEach((p) => polyBounds.extend(p));
      map.current.fitBounds(polyBounds, 30);
    } else {
      const focus = currentLocation || pickupPoint || destinationPoint || deliveryPoint || geoFence?.center;
      if (isValidLatLng({ lat: Number(focus?.lat), lng: Number(focus?.lng) })) {
        map.current.panTo({ lat: Number(focus.lat), lng: Number(focus.lng) });
      }
    }
  }, [geoFence, currentLocation, deliveryPoint, pickupPoint, destinationPoint, apiState]);

  return (
    <div className="map-card">
      <div className="map-title-row">
        <div>
          <strong>{title}</strong>
          <span>Google Maps • geo-fence • pickup & delivery • live position</span>
        </div>
        <Badge tone={apiState === "ready" ? "good" : apiState === "error" ? "bad" : "warn"}>
          {apiState === "ready" ? "Map Ready" : apiState === "error" ? "Map Error" : "Loading Map"}
        </Badge>
      </div>
      {apiState === "error" ? (
        <div className="map-error">
          Google Maps could not load. Check that the Maps JavaScript API is enabled and the API key's HTTP referrer restrictions allow this app.
        </div>
      ) : null}
      <div ref={mapNode} className="google-map" style={{ height }} />
    </div>
  );
}

function LoginScreen({ db, setDb, onLogin, toast }) {
  const [role, setRole] = useState("user");
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    name: "",
    username: "",
    password: "",
    mobile: "",
    email: "",
    contactAlt: "",
    address: "",
  });
  const [busy, setBusy] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (role === "admin") {
        if (
          form.username.trim().toLowerCase() === "admin@gmail.com" &&
          form.password === "admin@123"
        ) {
          onLogin({ role: "admin", userId: "ADMIN", name: "Administrator" });
          return;
        }
        toast("error", "Admin login failed", "Use admin@gmail.com / admin@123 for this local prototype.");
        return;
      }

      if (mode === "register") {
        const required = [form.name, form.username, form.password, form.mobile];
        if (required.some((v) => !String(v).trim())) {
          toast("error", "Missing details", "Name, username, password and mobile number are required.");
          return;
        }
        const duplicate = db.users.some(
          (u) =>
            u.username.toLowerCase() === form.username.trim().toLowerCase() ||
            u.mobile === form.mobile.trim()
        );
        if (duplicate) {
          toast("error", "Already registered", "That username or mobile number already exists.");
          return;
        }
        const passwordHash = await hashPassword(form.password);
        const user = {
          id: uid("USR"),
          name: form.name.trim(),
          username: form.username.trim(),
          passwordHash,
          mobile: form.mobile.trim(),
          email: form.email.trim(),
          contactAlt: form.contactAlt.trim(),
          address: form.address.trim(),
          deliveryAddress: "",
          deliveryLat: null,
          deliveryLng: null,
          createdAt: nowISO(),
          lastLoginAt: null,
          status: "ACTIVE",
        };
        setDb((prev) => {
          let next = { ...prev, users: [user, ...prev.users] };
          return appendEvent(next, {
            type: "USER_REGISTERED",
            actor: user.name,
            message: `New user registered with mobile ${user.mobile}.`,
          });
        });
        toast("success", "Registration completed", "Your account is stored on this laptop. You can now sign in.");
        setMode("login");
        setForm((f) => ({ ...f, password: "" }));
        return;
      }

      const loginId = form.username.trim().toLowerCase();
      const user = db.users.find(
        (u) =>
          u.username.toLowerCase() === loginId ||
          u.mobile.toLowerCase() === loginId
      );
      if (!user) {
        toast("error", "Login failed", "No user found with that username/mobile number.");
        return;
      }
      const passwordHash = await hashPassword(form.password);
      if (passwordHash !== user.passwordHash) {
        toast("error", "Login failed", "Incorrect password.");
        return;
      }
      setDb((prev) => {
        const users = prev.users.map((u) =>
          u.id === user.id ? { ...u, lastLoginAt: nowISO() } : u
        );
        let next = { ...prev, users };
        return appendEvent(next, {
          type: "USER_LOGIN",
          actor: user.name,
          message: "User signed in to the dashboard.",
        });
      });
      onLogin({ role: "user", userId: user.id, name: user.name });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-brand-panel">
        <div className="logo big">SV</div>
        <div className="eyebrow">SMART MOBILITY PLATFORM</div>
        <h1>Smart Vehicle Access & Geo-Control</h1>
        <p>
          One responsive dashboard for access authentication, Google Maps tracking,
          destination pricing, dummy payment, geo-fencing, vehicle authorization and full ride history.
        </p>
        <div className="auth-feature-grid">
          <div>📍 Live GPS & Geo-Fence</div>
          <div>🧾 Ride & Event History</div>
          <div>💳 Dummy Payments</div>
          <div>🔐 User + Admin Access</div>
        </div>
        <div className="local-note">
          <strong>Local prototype storage</strong>
          <span>All dashboard records are saved in this browser on your laptop.</span>
        </div>
      </div>

      <div className="auth-form-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="role-switch">
            <button type="button" className={role === "user" ? "active" : ""} onClick={() => setRole("user")}>
              User
            </button>
            <button type="button" className={role === "admin" ? "active" : ""} onClick={() => setRole("admin")}>
              Admin
            </button>
          </div>

          <div className="auth-title">
            <h2>{role === "admin" ? "Admin Login" : mode === "register" ? "Create User Account" : "User Login"}</h2>
            <p>
              {role === "admin"
                ? "Configure destinations, geo-fence and monitor all trips."
                : mode === "register"
                ? "Create a local user profile with contact and delivery details."
                : "Access your ride, payment, map and location controls."}
            </p>
          </div>

          {role === "user" && mode === "register" ? (
            <>
              <div className="grid-2">
                <Field label="Full name">
                  <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Enter full name" autoComplete="off" />
                </Field>
                <Field label="Mobile number">
                  <input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="10-digit mobile" inputMode="numeric" autoComplete="off" />
                </Field>
              </div>
              <div className="grid-2">
                <Field label="Username">
                  <input value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="Choose username" autoComplete="off" />
                </Field>
                <Field label="Password">
                  <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="Create password" autoComplete="new-password" />
                </Field>
              </div>
              <div className="grid-2">
                <Field label="Email">
                  <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@example.com" autoComplete="off" />
                </Field>
                <Field label="Alternate contact">
                  <input value={form.contactAlt} onChange={(e) => set("contactAlt", e.target.value)} placeholder="Optional contact" autoComplete="off" />
                </Field>
              </div>
              <Field label="Home / contact address" hint="You can add a delivery address later from inside your dashboard.">
                <textarea value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Complete address" autoComplete="off" />
              </Field>
            </>
          ) : (
            <>
              <Field label={role === "admin" ? "Admin email" : "Username or mobile number"}>
                <input value={form.username} onChange={(e) => set("username", e.target.value)} placeholder={role === "admin" ? "admin@gmail.com" : "Username / mobile"} autoComplete="username" />
              </Field>
              <Field label="Password">
                <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="Password" autoComplete="current-password" />
              </Field>
              {role === "admin" ? (
                <div className="demo-creds">Prototype login: <b>admin@gmail.com</b> / <b>admin@123</b></div>
              ) : null}
            </>
          )}

          <button className="primary wide" disabled={busy}>
            {busy ? "Please wait…" : role === "admin" ? "Open Admin Dashboard" : mode === "register" ? "Register User" : "Login"}
          </button>

          {role === "user" ? (
            <button type="button" className="text-btn" onClick={() => setMode(mode === "login" ? "register" : "login")}>
              {mode === "login" ? "New user? Create account" : "Already registered? Login"}
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function AdminDashboard({ db, setDb, session, logout, toast }) {
  const [tab, setTab] = useState("overview");
  const [fareForm, setFareForm] = useState({
    baseFare: db.settings.fare.baseFare,
    perKmRate: db.settings.fare.perKmRate,
  });
  const [dropLocationForm, setDropLocationForm] = useState({
    name: "",
    lat: db.settings.geoFence.center.lat,
    lng: db.settings.geoFence.center.lng,
  });
  const [editingDropLocationId, setEditingDropLocationId] = useState(null);
  const [fenceForm, setFenceForm] = useState({
    shape: db.settings.geoFence.shape || "circle",
    lat: db.settings.geoFence.center.lat,
    lng: db.settings.geoFence.center.lng,
    radiusM: db.settings.geoFence.radiusM,
    arrivalRadiusM: db.settings.geoFence.arrivalRadiusM,
    enabled: db.settings.geoFence.enabled,
  });
  const [polygonPoints, setPolygonPoints] = useState(db.settings.geoFence.polygon || []);
  const importRef = useRef(null);
  const [adminLocation, setAdminLocation] = useState(null);
  const [locatingAdmin, setLocatingAdmin] = useState(false);

  const activeRides = db.rides.filter((r) => !["TRIP COMPLETED", "CANCELLED"].includes(r.tripStatus));
  const paidTotal = db.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + Number(p.amount || 0), 0);

  const latestLocationByUser = useMemo(() => {
    const map = {};
    db.locationSamples.forEach((s) => {
      if (!map[s.userId] || new Date(s.at) > new Date(map[s.userId].at)) map[s.userId] = s;
    });
    return map;
  }, [db.locationSamples]);

  const nav = [
    ["overview", "Overview", "⌂"],
    ["map", "Live Map", "⌖"],
    ["fare", "Fare Settings", "₹"],
    ["dropLocations", "Drop Locations", "◆"],
    ["geofence", "Geo-Fence", "◎"],
    ["users", "Users", "♙"],
    ["rides", "Trips", "↗"],
    ["payments", "Payments", "₹"],
    ["events", "Event History", "≡"],
    ["storage", "Local Storage", "▣"],
  ];

  function saveFare(e) {
    e.preventDefault();
    const baseFare = Number(fareForm.baseFare);
    const perKmRate = Number(fareForm.perKmRate);
    if (!Number.isFinite(baseFare) || baseFare < 0 || !Number.isFinite(perKmRate) || perKmRate < 0) {
      toast("error", "Invalid fare", "Enter a valid base fare and per-km rate.");
      return;
    }
    setDb((prev) => appendEvent({ ...prev, settings: { ...prev.settings, fare: { baseFare, perKmRate } } }, {
      type: "FARE_UPDATED",
      actor: "Administrator",
      message: `Fare updated: base ${money(baseFare)} + ${money(perKmRate)}/km.`,
      data: { baseFare, perKmRate },
    }));
    toast("success", "Fare saved", "New rides will use this fare from now on.");
  }

  function saveDropLocation(e) {
    e.preventDefault();
    const name = dropLocationForm.name.trim();
    const lat = Number(dropLocationForm.lat);
    const lng = Number(dropLocationForm.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast("error", "Invalid location", "Enter a name, a valid latitude (-90 to 90) and a valid longitude (-180 to 180).");
      return;
    }
    if (editingDropLocationId) {
      setDb((prev) => appendEvent({
        ...prev,
        dropLocations: prev.dropLocations.map((d) => d.id === editingDropLocationId ? { ...d, name, lat, lng, updatedAt: nowISO() } : d),
      }, {
        type: "DROP_LOCATION_UPDATED",
        actor: "Administrator",
        message: `${name} was updated.`,
      }));
      setEditingDropLocationId(null);
      setDropLocationForm({ name: "", lat, lng });
      toast("success", "Drop location updated", `${name} was saved.`);
      return;
    }
    if (db.dropLocations.length >= 10) {
      toast("error", "Limit reached", "Only 10 drop locations can be configured. Delete one before adding another.");
      return;
    }
    const location = { id: uid("DROP"), name, lat, lng, createdAt: nowISO() };
    setDb((prev) => appendEvent({ ...prev, dropLocations: [...prev.dropLocations, location] }, {
      type: "DROP_LOCATION_CREATED",
      actor: "Administrator",
      message: `${location.name} added as a quick-pick drop location.`,
      data: location,
    }));
    setDropLocationForm({ name: "", lat, lng });
    toast("success", "Drop location added", `${location.name} is now available to users.`);
  }

  function startEditDropLocation(d) {
    setEditingDropLocationId(d.id);
    setDropLocationForm({ name: d.name, lat: d.lat, lng: d.lng });
  }

  function cancelEditDropLocation() {
    setEditingDropLocationId(null);
    setDropLocationForm({ name: "", lat: db.settings.geoFence.center.lat, lng: db.settings.geoFence.center.lng });
  }

  function removeDropLocation(id) {
    const d = db.dropLocations.find((x) => x.id === id);
    if (!window.confirm(`Delete ${d?.name || "this location"}?`)) return;
    if (editingDropLocationId === id) cancelEditDropLocation();
    setDb((prev) => appendEvent({ ...prev, dropLocations: prev.dropLocations.filter((x) => x.id !== id) }, {
      type: "DROP_LOCATION_DELETED",
      level: "warning",
      actor: "Administrator",
      message: `${d?.name || "Drop location"} was deleted.`,
    }));
  }

  function removeRide(id) {
    const r = db.rides.find((x) => x.id === id);
    if (!window.confirm(`Delete trip ${r?.id || id}? This also removes its payment and location records.`)) return;
    setDb((prev) => appendEvent({
      ...prev,
      rides: prev.rides.filter((x) => x.id !== id),
      payments: prev.payments.filter((p) => p.rideId !== id),
      locationSamples: prev.locationSamples.filter((s) => s.rideId !== id),
    }, {
      type: "TRIP_DELETED",
      level: "warning",
      actor: "Administrator",
      message: `Trip ${r?.id || id} and its related records were deleted.`,
    }));
  }

  function removePayment(id) {
    const p = db.payments.find((x) => x.id === id);
    if (!window.confirm(`Delete payment record ${p?.id || id}?`)) return;
    setDb((prev) => appendEvent({ ...prev, payments: prev.payments.filter((x) => x.id !== id) }, {
      type: "PAYMENT_DELETED",
      level: "warning",
      actor: "Administrator",
      message: `Payment record ${p?.id || id} was deleted.`,
    }));
  }

  function removeEvent(id) {
    if (!window.confirm("Delete this event log entry?")) return;
    setDb((prev) => ({ ...prev, events: prev.events.filter((x) => x.id !== id) }));
  }

  async function useAdminLocationForDropLocation() {
    try {
      const pos = await requestGeolocation();
      setDropLocationForm((f) => ({ ...f, lat: pos.coords.latitude, lng: pos.coords.longitude }));
      toast("success", "Location captured", "Current latitude and longitude copied to the form.");
    } catch (err) {
      toast("error", "Location permission", err.message);
    }
  }

  function addPolygonPoint(pos) {
    setPolygonPoints((pts) => [...pts, pos]);
  }

  function undoPolygonPoint() {
    setPolygonPoints((pts) => pts.slice(0, -1));
  }

  function clearPolygonPoints() {
    setPolygonPoints([]);
  }

  function saveFence(e) {
    e.preventDefault();
    const shape = fenceForm.shape === "polygon" ? "polygon" : "circle";
    const arrivalRadiusM = clamp(Number(fenceForm.arrivalRadiusM), 10, 2000);
    const enabled = Boolean(fenceForm.enabled);

    if (shape === "polygon") {
      if (polygonPoints.length < 3) {
        toast("error", "Not enough points", "Click at least 3 points on the map to draw a boundary shape.");
        return;
      }
      const center = {
        lat: polygonPoints.reduce((s, p) => s + p.lat, 0) / polygonPoints.length,
        lng: polygonPoints.reduce((s, p) => s + p.lng, 0) / polygonPoints.length,
      };
      const geoFence = { shape, polygon: polygonPoints, center, radiusM: db.settings.geoFence.radiusM, arrivalRadiusM, enabled };
      setDb((prev) => appendEvent({ ...prev, settings: { ...prev.settings, geoFence } }, {
        type: "GEOFENCE_UPDATED",
        actor: "Administrator",
        message: `Geo-fence updated: custom boundary with ${polygonPoints.length} points; arrival radius ${arrivalRadiusM} m.`,
        data: geoFence,
      }));
      toast("success", "Geo-fence saved", "All new live GPS updates will use this custom boundary shape.");
      return;
    }

    const center = { lat: Number(fenceForm.lat), lng: Number(fenceForm.lng) };
    const radiusM = clamp(Number(fenceForm.radiusM), 20, 100000);
    if (
      !Number.isFinite(center.lat) || !Number.isFinite(center.lng) ||
      center.lat < -90 || center.lat > 90 ||
      center.lng < -180 || center.lng > 180
    ) {
      toast("error", "Invalid geo-fence", "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    const geoFence = { shape, center, radiusM, polygon: db.settings.geoFence.polygon || [], arrivalRadiusM, enabled };
    setDb((prev) => appendEvent({ ...prev, settings: { ...prev.settings, geoFence } }, {
      type: "GEOFENCE_UPDATED",
      actor: "Administrator",
      message: `Geo-fence updated: ${radiusM} m radius; arrival radius ${arrivalRadiusM} m.`,
      data: geoFence,
    }));
    toast("success", "Geo-fence saved", "All new live GPS updates will use this boundary.");
  }

  async function useAdminLocationForFence() {
    try {
      const pos = await requestGeolocation();
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      setFenceForm((f) => ({ ...f, lat, lng }));
      toast("success", "Location captured", "Current latitude and longitude copied to the form.");
    } catch (err) {
      toast("error", "Location permission", err.message);
    }
  }

  async function locateAdmin() {
    setLocatingAdmin(true);
    try {
      const pos = await requestGeolocation();
      setAdminLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      toast("success", "Location found", "Your current position is now shown on the map.");
    } catch (err) {
      toast("error", "Location permission", err.message);
    } finally {
      setLocatingAdmin(false);
    }
  }

  function setVehicleCommand(command, reason = "Manual admin command") {
    setDb((prev) => appendEvent({
      ...prev,
      vehicle: {
        ...prev.vehicle,
        motorCommand: command,
        lastCommandAt: nowISO(),
        lastCommandReason: reason,
      },
    }, {
      type: "VEHICLE_COMMAND",
      actor: "Administrator",
      level: command === "OFF" ? "warning" : "info",
      message: `Simulated vehicle motor command changed to ${command}.`,
    }));
    toast(command === "ON" ? "success" : "warning", `Motor ${command}`, "Dashboard simulation updated. Hardware connection can be added later.");
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smart-vehicle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("success", "Backup downloaded", "The complete local dashboard database was exported as JSON.");
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = normalizeDb(JSON.parse(String(reader.result)));
        setDb(appendEvent(parsed, {
          type: "DATABASE_IMPORTED",
          actor: "Administrator",
          message: "Local dashboard database imported from JSON backup.",
        }));
        toast("success", "Data imported", "The local database has been restored.");
      } catch {
        toast("error", "Import failed", "The selected file is not a valid dashboard backup.");
      }
    };
    reader.readAsText(file);
  }

  function clearOperationalData() {
    if (!window.confirm("Clear rides, payments, location samples and events? Users will be kept.")) return;
    setDb((prev) => ({
      ...prev,
      rides: [],
      payments: [],
      locationSamples: [],
      events: [{ id: uid("EVT"), at: nowISO(), level: "warning", type: "DATA_CLEARED", actor: "Administrator", message: "Operational history was cleared locally." }],
      vehicle: { ...prev.vehicle, motorCommand: "OFF", lastCommandAt: nowISO(), lastCommandReason: "Operational data cleared" },
    }));
    toast("warning", "History cleared", "Operational data has been removed from this browser.");
  }

  const currentUserPositions = Object.values(latestLocationByUser).map((s) => ({
    ...s,
    lat: Number(s.lat),
    lng: Number(s.lng),
  }));
  const mapCurrent = currentUserPositions[0]
    ? { lat: currentUserPositions[0].lat, lng: currentUserPositions[0].lng }
    : adminLocation;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row"><div className="logo">SV</div><div><b>SmartVehicle</b><span>Control Center</span></div></div>
        <div className="sidebar-role"><span>ADMIN PORTAL</span><b>{session.name}</b></div>
        <nav>
          {nav.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <i>{icon}</i><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="hardware-mini"><span className="dot bad" /><div><b>ESP32</b><small>Hardware later</small></div></div>
          <button className="logout" onClick={logout}>↪ Logout</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">ADMIN DASHBOARD</div><h1>{nav.find((n) => n[0] === tab)?.[1]}</h1></div>
          <div className="top-actions">
            <Badge tone={db.vehicle.motorCommand === "ON" ? "good" : "bad"}>Motor {db.vehicle.motorCommand}</Badge>
            <span className="date-pill">{new Date().toLocaleDateString()}</span>
          </div>
        </header>

        <div className="content">
          {tab === "overview" ? (
            <>
              <SectionHeader
                title="System Overview"
                subtitle="Local dashboard monitoring for access, payment, trips and location."
                actions={<button className="ghost" onClick={locateAdmin} disabled={locatingAdmin}>{locatingAdmin ? "Locating…" : "📍 Locate Me"}</button>}
              />
              <div className="metrics-grid">
                <Metric icon="♙" label="Registered Users" value={db.users.length} hint={`${db.users.filter((u) => u.status === "ACTIVE").length} active`} />
                <Metric icon="↗" label="Active Trips" value={activeRides.length} hint={`${db.rides.length} total trips`} />
                <Metric icon="₹" label="Demo Collections" value={money(paidTotal)} hint={`${db.payments.filter((p) => p.status === "SUCCESS").length} successful`} />
                <Metric icon="◆" label="Fare Rate" value={money(db.settings.fare.perKmRate)} hint={`+ ${money(db.settings.fare.baseFare)} base fare`} />
              </div>

              <div className="grid-main-side">
                <GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={mapCurrent} height={430} />
                <div className="card">
                  <h3>Vehicle Control Simulation</h3>
                  <p className="muted">Use this now to verify dashboard behaviour. Later these commands can be sent to ESP32.</p>
                  <div className="vehicle-visual">
                    <div className={`power-ring ${db.vehicle.motorCommand === "ON" ? "on" : "off"}`}>⚡</div>
                    <b>Vehicle {db.vehicle.motorCommand === "ON" ? "Enabled" : "Disabled"}</b>
                    <span>{db.vehicle.lastCommandReason}</span>
                  </div>
                  <div className="button-row">
                    <button className="success" onClick={() => setVehicleCommand("ON")}>Enable Motor</button>
                    <button className="danger" onClick={() => setVehicleCommand("OFF")}>Disable Motor</button>
                  </div>
                  <div className="mini-list">
                    <div><span>ESP32</span><Badge tone="bad">Not Connected</Badge></div>
                    <div><span>Geo-Fence</span><Badge tone={db.settings.geoFence.enabled ? "good" : "warn"}>{db.settings.geoFence.enabled ? "Enabled" : "Disabled"}</Badge></div>
                    <div><span>Arrival Radius</span><b>{db.settings.geoFence.arrivalRadiusM} m</b></div>
                  </div>
                </div>
              </div>

              <div className="grid-2-cards">
                <div className="card">
                  <SectionHeader title="Recent Trips" subtitle="Latest user ride activity." actions={<button className="ghost" onClick={() => setTab("rides")}>View all</button>} />
                  {db.rides.length ? (
                    <div className="table-wrap"><table><thead><tr><th>Trip</th><th>User</th><th>Destination</th><th>Payment</th><th>Status</th></tr></thead><tbody>
                      {db.rides.slice(0, 6).map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.userName}</td><td>{r.destinationName}</td><td>{money(r.amount)}</td><td><Badge>{r.tripStatus}</Badge></td></tr>)}
                    </tbody></table></div>
                  ) : <Empty text="No trips yet. User rides will appear here." />}
                </div>
                <div className="card">
                  <SectionHeader title="Recent Events" subtitle="Authentication, payment and geo-fence activity." actions={<button className="ghost" onClick={() => setTab("events")}>View all</button>} />
                  <div className="timeline compact">
                    {db.events.slice(0, 7).map((e) => <div key={e.id} className="timeline-item"><span className={`event-dot ${e.level}`} /><div><b>{e.type}</b><p>{e.message}</p><small>{formatDate(e.at)} • {e.actor}</small></div></div>)}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {tab === "map" ? (
            <>
              <SectionHeader
                title="Live Location Map"
                subtitle="Shows the configured geo-fence and latest stored user GPS position."
                actions={<button className="ghost" onClick={locateAdmin} disabled={locatingAdmin}>{locatingAdmin ? "Locating…" : "📍 Locate Me"}</button>}
              />
              <GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={mapCurrent} height={610} />
              <div className="card top-gap">
                <h3>Latest User Locations</h3>
                {currentUserPositions.length ? <div className="table-wrap"><table><thead><tr><th>User</th><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Geo-Fence</th><th>Updated</th></tr></thead><tbody>
                  {currentUserPositions.map((s) => {
                    const user = db.users.find((u) => u.id === s.userId);
                    return <tr key={s.userId}><td>{user?.name || s.userId}</td><td>{Number(s.lat).toFixed(6)}</td><td>{Number(s.lng).toFixed(6)}</td><td>{Math.round(s.accuracy || 0)} m</td><td><Badge>{s.insideFence ? "INSIDE" : "OUTSIDE"}</Badge></td><td>{formatDate(s.at)}</td></tr>;
                  })}
                </tbody></table></div> : <Empty text="No live location samples stored yet." />}
              </div>
            </>
          ) : null}

          {tab === "fare" ? (
            <>
              <SectionHeader title="Fare Settings" subtitle="Users pick their own pickup and delivery latitude/longitude. Fare is calculated from the distance between them." />
              <div className="grid-main-side reverse-mobile">
                <form className="card" onSubmit={saveFare}>
                  <h3>Distance-Based Fare</h3>
                  <div className="grid-2">
                    <Field label="Base fare" hint="Charged on every ride regardless of distance."><input type="number" min="0" step="any" value={fareForm.baseFare} onChange={(e)=>setFareForm(f=>({...f,baseFare:e.target.value}))} placeholder="₹" /></Field>
                    <Field label="Rate per km" hint="Added on top of the base fare for each km travelled."><input type="number" min="0" step="any" value={fareForm.perKmRate} onChange={(e)=>setFareForm(f=>({...f,perKmRate:e.target.value}))} placeholder="₹/km" /></Field>
                  </div>
                  <button className="primary wide top-gap-sm">Save Fare Settings</button>
                </form>
                <div className="card">
                  <h3>Fare Preview</h3>
                  <div className="mini-list">
                    {[1, 3, 5, 10].map((km) => (
                      <div key={km}><span>{km} km trip</span><b>{money(Number(fareForm.baseFare || 0) + Number(fareForm.perKmRate || 0) * km)}</b></div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {tab === "dropLocations" ? (
            <>
              <SectionHeader title="Drop Locations" subtitle="Configure up to 10 quick-pick delivery locations. Users can also choose Other and enter a custom address." />
              <div className="grid-main-side reverse-mobile">
                <div className="card">
                  <h3>Configured Locations ({db.dropLocations.length}/10)</h3>
                  {db.dropLocations.length ? <div className="destination-list">
                    {db.dropLocations.map((d) => (
                      <div className={`destination-row ${editingDropLocationId===d.id?"selected":""}`} key={d.id}>
                        <div className="destination-info"><b>{d.name}</b><span>{Number(d.lat).toFixed(6)}, {Number(d.lng).toFixed(6)}</span></div>
                        <div className="destination-actions"><button className="mini primary" onClick={() => startEditDropLocation(d)}>Edit</button><button className="mini danger-outline" onClick={() => removeDropLocation(d.id)}>Delete</button></div>
                      </div>
                    ))}
                  </div> : <Empty text="No drop locations configured yet." />}
                </div>
                <form className="card" onSubmit={saveDropLocation}>
                  <h3>{editingDropLocationId ? "Edit Drop Location" : "Add Drop Location"}</h3>
                  <Field label="Location name"><input value={dropLocationForm.name} onChange={(e)=>setDropLocationForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Main Gate" /></Field>
                  <div className="grid-2"><Field label="Latitude"><input type="number" step="any" value={dropLocationForm.lat} onChange={(e)=>setDropLocationForm(f=>({...f,lat:e.target.value}))} /></Field><Field label="Longitude"><input type="number" step="any" value={dropLocationForm.lng} onChange={(e)=>setDropLocationForm(f=>({...f,lng:e.target.value}))} /></Field></div>
                  <button type="button" className="ghost wide" onClick={useAdminLocationForDropLocation}>Use My Current GPS Coordinates</button>
                  {editingDropLocationId ? (
                    <div className="button-row top-gap-sm"><button type="button" className="ghost" onClick={cancelEditDropLocation}>Cancel</button><button className="primary">Save Changes</button></div>
                  ) : (
                    <button className="primary wide top-gap-sm" disabled={db.dropLocations.length >= 10}>{db.dropLocations.length >= 10 ? "Limit Reached (10/10)" : "Add Drop Location"}</button>
                  )}
                </form>
              </div>
            </>
          ) : null}

          {tab === "geofence" ? (
            <>
              <SectionHeader title="Geo-Fence Configuration" subtitle={fenceForm.shape === "polygon" ? "Click on the map to place each corner of a custom boundary shape, in order." : "Click anywhere on the map, or drag the blue center marker, to choose the boundary location."} />
              <div className="grid-main-side reverse-mobile">
                <GoogleMapPanel
                  geoFence={fenceForm.shape === "polygon"
                    ? { ...db.settings.geoFence, shape: "polygon", polygon: polygonPoints, enabled: fenceForm.enabled }
                    : { ...db.settings.geoFence, shape: "circle", center: { lat: Number(fenceForm.lat), lng: Number(fenceForm.lng) }, radiusM: Number(fenceForm.radiusM), enabled: fenceForm.enabled }}
                  onFenceCenterChange={fenceForm.shape === "polygon" ? undefined : (pos) => setFenceForm(f => ({ ...f, lat: pos.lat, lng: pos.lng }))}
                  onPolygonPointAdd={fenceForm.shape === "polygon" ? addPolygonPoint : undefined}
                  height={540}
                />
                <form className="card" onSubmit={saveFence}>
                  <h3>Operating Boundary</h3>
                  <div className="role-switch">
                    <button type="button" className={fenceForm.shape !== "polygon" ? "active" : ""} onClick={() => setFenceForm(f => ({ ...f, shape: "circle" }))}>Circle</button>
                    <button type="button" className={fenceForm.shape === "polygon" ? "active" : ""} onClick={() => setFenceForm(f => ({ ...f, shape: "polygon" }))}>Custom Boundary</button>
                  </div>
                  {fenceForm.shape === "polygon" ? (
                    <>
                      <p className="muted">Click on the map to add corner points ({polygonPoints.length} placed, minimum 3 needed).</p>
                      <div className="button-row">
                        <button type="button" className="ghost" onClick={undoPolygonPoint} disabled={!polygonPoints.length}>Undo Last Point</button>
                        <button type="button" className="danger-outline" onClick={clearPolygonPoints} disabled={!polygonPoints.length}>Clear Points</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="muted">Click on the map or drag the center marker to pick a location — the coordinates below update automatically.</p>
                      <div className="grid-2"><Field label="Center latitude"><input type="number" step="any" value={fenceForm.lat} onChange={(e)=>setFenceForm(f=>({...f,lat:e.target.value}))}/></Field><Field label="Center longitude"><input type="number" step="any" value={fenceForm.lng} onChange={(e)=>setFenceForm(f=>({...f,lng:e.target.value}))}/></Field></div>
                      {!isValidLatLng({ lat: Number(fenceForm.lat), lng: Number(fenceForm.lng) }) ? <p className="field-error">Latitude must be -90 to 90 and longitude -180 to 180 — fix this before the boundary can be shown or saved.</p> : null}
                      <Field label="Permitted radius (meters)" hint="Vehicle is allowed only inside this circle."><input type="number" min="20" value={fenceForm.radiusM} onChange={(e)=>setFenceForm(f=>({...f,radiusM:e.target.value}))}/></Field>
                      <button type="button" className="ghost wide" onClick={useAdminLocationForFence}>Use My Current GPS as Center</button>
                    </>
                  )}
                  <Field label="Destination arrival radius (meters)" hint="Trip completes automatically when the user enters this radius around the selected destination."><input type="number" min="10" value={fenceForm.arrivalRadiusM} onChange={(e)=>setFenceForm(f=>({...f,arrivalRadiusM:e.target.value}))}/></Field>
                  <label className="toggle-line"><input type="checkbox" checked={fenceForm.enabled} onChange={(e)=>setFenceForm(f=>({...f,enabled:e.target.checked}))}/><span>Geo-fence enforcement enabled</span></label>
                  <button className="primary wide top-gap-sm">Save Geo-Fence</button>
                </form>
              </div>
            </>
          ) : null}

          {tab === "users" ? (
            <>
              <SectionHeader title="Registered Users" subtitle="Profile, contact and saved delivery-location details stored locally." />
              <div className="card">
                {db.users.length ? <div className="table-wrap"><table><thead><tr><th>User</th><th>Username</th><th>Mobile</th><th>Email</th><th>Delivery Address</th><th>Delivery Coordinates</th><th>Last Login</th></tr></thead><tbody>
                  {db.users.map((u)=><tr key={u.id}><td><b>{u.name}</b><br/><small>{u.id}</small></td><td>{u.username}</td><td>{u.mobile}</td><td>{u.email || "—"}</td><td className="wrap-cell">{u.deliveryAddress || "—"}</td><td>{u.deliveryLat != null && u.deliveryLng != null ? `${Number(u.deliveryLat).toFixed(5)}, ${Number(u.deliveryLng).toFixed(5)}` : "—"}</td><td>{formatDate(u.lastLoginAt)}</td></tr>)}
                </tbody></table></div> : <Empty text="No users have registered yet." />}
              </div>
            </>
          ) : null}

          {tab === "rides" ? (
            <>
              <SectionHeader title="Trip History" subtitle="Complete travel details including authentication, selected destination, payment and timing." />
              <div className="card">
                {db.rides.length ? <div className="table-wrap"><table><thead><tr><th>Trip ID</th><th>User</th><th>Destination</th><th>Amount</th><th>OTP</th><th>Payment</th><th>Geo</th><th>Start</th><th>End</th><th>Status</th><th>Reached</th><th>Driver</th><th>Actions</th></tr></thead><tbody>
                  {db.rides.map((r)=><tr key={r.id}><td>{r.id}</td><td>{r.userName}<br/><small>{r.mobile}</small></td><td>{r.destinationName}</td><td>{money(r.amount)}</td><td><Badge>{r.otpVerified ? "VERIFIED" : r.otp ? "GENERATED" : "WAITING"}</Badge></td><td><Badge>{r.paymentStatus || "PENDING"}</Badge></td><td><Badge>{r.geoStatus || "UNKNOWN"}</Badge></td><td>{formatDate(r.startTime)}</td><td>{formatDate(r.endTime)}</td><td><Badge>{r.tripStatus}</Badge></td><td>{r.reachedStatus?<Badge tone={r.reachedStatus==="REACHED"?"good":"bad"}>{r.reachedStatus==="REACHED"?"Reached":"Not Reached"}</Badge>:"—"}</td><td>{r.driverRating?<Badge tone={r.driverRating==="GOOD"?"good":"bad"}>{r.driverRating}</Badge>:"—"}</td><td><button className="mini danger-outline" onClick={()=>removeRide(r.id)}>Delete</button></td></tr>)}
                </tbody></table></div> : <Empty text="No trip records are stored yet." />}
              </div>
            </>
          ) : null}

          {tab === "payments" ? (
            <>
              <SectionHeader title="Dummy Payment Records" subtitle="Prototype transactions only — no real banking or gateway request is performed." />
              <div className="metrics-grid compact-metrics"><Metric icon="₹" label="Successful Amount" value={money(paidTotal)} /><Metric icon="✓" label="Successful" value={db.payments.filter((p)=>p.status==="SUCCESS").length} /><Metric icon="…" label="Pending" value={db.payments.filter((p)=>p.status==="PENDING").length} /><Metric icon="×" label="Failed" value={db.payments.filter((p)=>p.status==="FAILED").length} /></div>
              <div className="card">
                {db.payments.length ? <div className="table-wrap"><table><thead><tr><th>Payment ID</th><th>Trip</th><th>User</th><th>Destination</th><th>Method</th><th>Amount</th><th>Status</th><th>Reference</th><th>Time</th><th>Actions</th></tr></thead><tbody>
                  {db.payments.map((p)=><tr key={p.id}><td>{p.id}</td><td>{p.rideId}</td><td>{p.userName}</td><td>{p.destinationName}</td><td>{p.method}</td><td>{money(p.amount)}</td><td><Badge>{p.status}</Badge></td><td>{p.reference}</td><td>{formatDate(p.at)}</td><td><button className="mini danger-outline" onClick={()=>removePayment(p.id)}>Delete</button></td></tr>)}
                </tbody></table></div> : <Empty text="No payment records yet." />}
              </div>
            </>
          ) : null}

          {tab === "events" ? (
            <>
              <SectionHeader title="Event History" subtitle="Every major user, OTP, payment, trip, location and geo-fence event is retained locally." />
              <div className="card">
                <div className="timeline">
                  {db.events.map((e)=><div key={e.id} className="timeline-item"><span className={`event-dot ${e.level}`}/><div><div className="timeline-title"><b>{e.type}</b><span style={{display:"flex",alignItems:"center",gap:"8px"}}><Badge tone={e.level === "error" ? "bad" : e.level === "warning" ? "warn" : "neutral"}>{e.actor}</Badge><button className="mini danger-outline" onClick={()=>removeEvent(e.id)}>Delete</button></span></div><p>{e.message}</p><small>{formatDate(e.at)} • {e.id}</small></div></div>)}
                </div>
              </div>
            </>
          ) : null}

          {tab === "storage" ? (
            <>
              <SectionHeader title="Project Folder Data Storage" subtitle="This dashboard stores its complete prototype database in a JSON file inside this project folder, not in the browser." />
              <div className="storage-grid">
                <div className="card storage-card"><div className="storage-icon">▣</div><h3>Local File Database</h3><p>Users, hashed passwords, contact details, delivery coordinates, destinations, trips, payments, GPS samples and event history are saved to a file on disk, so the data survives browser restarts and cleared browser data.</p><div className="storage-stats"><span>Users <b>{db.users.length}</b></span><span>Trips <b>{db.rides.length}</b></span><span>GPS samples <b>{db.locationSamples.length}</b></span><span>Events <b>{db.events.length}</b></span></div></div>
                <div className="card"><h3>Backup / Restore</h3><p className="muted">Export the entire database to a JSON file you can keep separately, or import a backup to overwrite the current data file.</p><div className="stack-buttons"><button className="primary" onClick={exportData}>Download Full JSON Backup</button><button className="ghost" onClick={()=>importRef.current?.click()}>Import JSON Backup</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e)=>importData(e.target.files?.[0])}/><button className="danger-outline" onClick={clearOperationalData}>Clear Operational History</button></div></div>
              </div>
              <div className="card top-gap"><h3>Data File Location</h3><code>data/db.json</code><p className="muted">This file lives inside the project folder (created automatically the first time data is saved) and is served locally by the Vite dev server at the /api/db endpoint. Keep the dev server ('npm run dev') running while using the dashboard.</p></div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PaymentModal({ ride, onClose, onSuccess, toast }) {
  const [method, setMethod] = useState("WALLET");
  const [form, setForm] = useState({ bank: "State Bank", account: "", wallet: "Demo Wallet", walletMobile: "", upi: "", card: "", expiry: "", cvv: "" });
  const methods = [
    ["WALLET", "👛", "Wallet"],
    ["NET_BANKING", "🏦", "Net Banking"],
    ["UPI", "⌁", "UPI"],
    ["CARD", "💳", "Card"],
  ];

  function pay(e) {
    e.preventDefault();
    if (method === "NET_BANKING" && !form.account.trim()) return toast("error", "Enter account", "Enter any dummy account/login ID for the simulation.");
    if (method === "WALLET" && !form.walletMobile.trim()) return toast("error", "Enter wallet mobile", "Enter a dummy wallet mobile number.");
    if (method === "UPI" && !form.upi.trim()) return toast("error", "Enter UPI ID", "Enter a dummy UPI ID such as user@demo.");
    if (method === "CARD" && (!form.card.trim() || !form.expiry.trim() || !form.cvv.trim())) return toast("error", "Card details", "Enter dummy card number, expiry and CVV.");
    onSuccess(method, form);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal payment-modal" onMouseDown={(e)=>e.stopPropagation()}>
        <div className="modal-head"><div><div className="eyebrow">DEMO PAYMENT</div><h2>Complete Payment</h2></div><button className="close" onClick={onClose}>×</button></div>
        <div className="payment-summary"><div><span>Destination</span><b>{ride.destinationName}</b></div><div><span>Trip ID</span><b>{ride.id}</b></div><div className="amount"><span>Amount</span><b>{money(ride.amount)}</b></div></div>
        <div className="payment-methods">
          {methods.map(([id,icon,label])=><button key={id} className={method===id?"active":""} onClick={()=>setMethod(id)}><span>{icon}</span><b>{label}</b></button>)}
        </div>
        <form onSubmit={pay}>
          {method === "WALLET" ? <div className="grid-2"><Field label="Wallet"><select value={form.wallet} onChange={(e)=>setForm(f=>({...f,wallet:e.target.value}))}><option>Demo Wallet</option><option>Pay Wallet</option><option>Smart Wallet</option></select></Field><Field label="Registered mobile"><input value={form.walletMobile} onChange={(e)=>setForm(f=>({...f,walletMobile:e.target.value}))} placeholder="9876543210"/></Field></div> : null}
          {method === "NET_BANKING" ? <div className="grid-2"><Field label="Select bank"><select value={form.bank} onChange={(e)=>setForm(f=>({...f,bank:e.target.value}))}><option>State Bank</option><option>HDFC Demo Bank</option><option>ICICI Demo Bank</option><option>Axis Demo Bank</option></select></Field><Field label="Customer / account ID"><input value={form.account} onChange={(e)=>setForm(f=>({...f,account:e.target.value}))} placeholder="Dummy login ID"/></Field></div> : null}
          {method === "UPI" ? <Field label="UPI ID"><input value={form.upi} onChange={(e)=>setForm(f=>({...f,upi:e.target.value}))} placeholder="user@demo"/></Field> : null}
          {method === "CARD" ? <><Field label="Card number"><input value={form.card} onChange={(e)=>setForm(f=>({...f,card:e.target.value}))} placeholder="4111 1111 1111 1111"/></Field><div className="grid-2"><Field label="Expiry"><input value={form.expiry} onChange={(e)=>setForm(f=>({...f,expiry:e.target.value}))} placeholder="12/30"/></Field><Field label="CVV"><input type="password" maxLength="4" value={form.cvv} onChange={(e)=>setForm(f=>({...f,cvv:e.target.value}))} placeholder="123"/></Field></div></> : null}
          <div className="demo-banner">🔒 Demo mode only. No real banking network, card processor or wallet is contacted.</div>
          <button className="primary wide pay-button">Pay {money(ride.amount)}</button>
        </form>
      </div>
    </div>
  );
}

function ReviewModal({ ride, onClose, onSubmit }) {
  const [reached, setReached] = useState(null);
  const [driverRating, setDriverRating] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (!reached || !driverRating) return;
    onSubmit(reached, driverRating);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e)=>e.stopPropagation()}>
        <div className="modal-head"><div><div className="eyebrow">RATE YOUR RIDE</div><h2>{ride.destinationName}</h2></div><button className="close" onClick={onClose}>×</button></div>
        <form onSubmit={submit}>
          <Field label="Did the vehicle reach the destination?">
            <div className="button-row">
              <button type="button" className={reached==="REACHED"?"success":"ghost"} onClick={()=>setReached("REACHED")}>Reached</button>
              <button type="button" className={reached==="NOT_REACHED"?"danger":"ghost"} onClick={()=>setReached("NOT_REACHED")}>Not Reached</button>
            </div>
          </Field>
          <Field label="How was the driver?">
            <div className="button-row">
              <button type="button" className={driverRating==="GOOD"?"success":"ghost"} onClick={()=>setDriverRating("GOOD")}>Good</button>
              <button type="button" className={driverRating==="BAD"?"danger":"ghost"} onClick={()=>setDriverRating("BAD")}>Bad</button>
            </div>
          </Field>
          <button className="primary wide top-gap-sm" disabled={!reached||!driverRating}>Submit Review</button>
        </form>
      </div>
    </div>
  );
}

function UserDashboard({ db, setDb, session, logout, toast, dbLoaded }) {
  const [tab, setTab] = useState("home");
  const [tracking, setTracking] = useState(false);
  const [otpInput, setOtpInput] = useState("");
  const [paymentRide, setPaymentRide] = useState(null);
  const [profileForm, setProfileForm] = useState(null);
  const [bookingForm, setBookingForm] = useState(null);
  const [otpTick, setOtpTick] = useState(Date.now());
  const [reviewRide, setReviewRide] = useState(null);
  const watchRef = useRef(null);
  const autoPickupAttempted = useRef(false);

  const user = db.users.find((u) => u.id === session.userId);

  useEffect(() => {
    if (dbLoaded && !user) {
      toast("error", "Session expired", "Your saved profile could not be found. Please log in or register again.");
      logout();
    }
  }, [dbLoaded, user]);
  const userRides = db.rides.filter((r) => r.userId === session.userId);
  const currentRide = userRides.find((r) => !["TRIP COMPLETED", "CANCELLED"].includes(r.tripStatus)) || null;
  const userLocations = db.locationSamples.filter((s) => s.userId === session.userId);
  const latestLocation = userLocations[0] || null;
  const currentLocation = latestLocation ? { lat: Number(latestLocation.lat), lng: Number(latestLocation.lng) } : null;
  const destinationPoint = currentRide && currentRide.destinationLat != null && currentRide.destinationLng != null ? { lat: Number(currentRide.destinationLat), lng: Number(currentRide.destinationLng) } : null;
  const pickupPoint = currentRide && currentRide.pickupLat != null && currentRide.pickupLng != null ? { lat: Number(currentRide.pickupLat), lng: Number(currentRide.pickupLng) } : null;
  const deliveryPoint = user?.deliveryLat != null && user?.deliveryLng != null ? { lat: Number(user.deliveryLat), lng: Number(user.deliveryLng) } : null;
  const insideFence = currentLocation ? isInsideGeoFence(currentLocation, db.settings.geoFence) : null;
  const distanceToDestination = currentLocation && destinationPoint ? distanceMeters(currentLocation, destinationPoint) : null;
  const bookingPickupPreview = bookingForm && bookingForm.pickupLat !== "" && bookingForm.pickupLng !== "" && Number.isFinite(Number(bookingForm.pickupLat)) && Number.isFinite(Number(bookingForm.pickupLng)) ? { lat: Number(bookingForm.pickupLat), lng: Number(bookingForm.pickupLng) } : null;
  const bookingDeliveryPreview = bookingForm && bookingForm.deliveryLat !== "" && bookingForm.deliveryLng !== "" && Number.isFinite(Number(bookingForm.deliveryLat)) && Number.isFinite(Number(bookingForm.deliveryLng)) ? { lat: Number(bookingForm.deliveryLat), lng: Number(bookingForm.deliveryLng) } : null;
  const bookingDistanceKm = bookingPickupPreview && bookingDeliveryPreview ? distanceMeters(bookingPickupPreview, bookingDeliveryPreview) / 1000 : null;
  const bookingFare = bookingDistanceKm != null ? Number(db.settings.fare.baseFare) + Number(db.settings.fare.perKmRate) * bookingDistanceKm : null;
  const otpExpiresAt = currentRide?.otp && !currentRide.otpVerified && currentRide.otpGeneratedAt ? new Date(currentRide.otpGeneratedAt).getTime() + OTP_TTL_MS : null;
  const otpSecondsLeft = otpExpiresAt != null ? Math.max(0, Math.ceil((otpExpiresAt - otpTick) / 1000)) : null;
  const otpExpired = otpExpiresAt != null && otpTick >= otpExpiresAt;

  useEffect(() => {
    if (!otpExpiresAt) return undefined;
    const id = setInterval(() => setOtpTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [otpExpiresAt]);

  useEffect(() => {
    if (!otpExpired || !currentRide) return;
    setDb((prev) => {
      const rides = prev.rides.map((r) => r.id === currentRide.id ? { ...r, otp: null, otpGeneratedAt: null, tripStatus: "WAITING FOR AUTHENTICATION", locationStatus: "WAITING FOR AUTHENTICATION" } : r);
      return appendEvent({ ...prev, rides }, { type: "OTP_EXPIRED", level: "warning", actor: user.name, message: `OTP expired for trip ${currentRide.id}. Generate a new one.` });
    });
    pushEmergencyUpdate({ Emergency: 0 });
    toast("warning", "OTP expired", "The OTP was valid for 30 seconds. Generate a new one.");
  }, [otpExpired, currentRide?.id]);

  useEffect(() => {
    if (user && !profileForm) {
      setProfileForm({
        name: user.name || "",
        username: user.username || "",
        mobile: user.mobile || "",
        email: user.email || "",
        contactAlt: user.contactAlt || "",
        address: user.address || "",
        deliveryAddress: user.deliveryAddress || "",
        deliveryLat: user.deliveryLat ?? "",
        deliveryLng: user.deliveryLng ?? "",
      });
    }
  }, [user, profileForm]);

  useEffect(() => {
    if (user && !bookingForm) {
      setBookingForm({
        pickupAddress: "",
        pickupLat: currentLocation?.lat ?? "",
        pickupLng: currentLocation?.lng ?? "",
        deliveryMode: null,
        deliverySelectedId: null,
        deliveryAddress: "",
        deliveryLat: "",
        deliveryLng: "",
      });
    }
  }, [user, bookingForm]);

  useEffect(() => {
    if (bookingForm && currentLocation && bookingForm.pickupLat === "" && bookingForm.pickupLng === "") {
      setBookingForm((f) => ({ ...f, pickupLat: currentLocation.lat, pickupLng: currentLocation.lng }));
    }
    if (bookingForm && !currentLocation && bookingForm.pickupLat === "" && !autoPickupAttempted.current) {
      autoPickupAttempted.current = true;
      requestGeolocation()
        .then((pos) => setBookingForm((f) => ({ ...f, pickupLat: pos.coords.latitude, pickupLng: pos.coords.longitude })))
        .catch(() => {});
    }
  }, [currentLocation, bookingForm]);

  useEffect(() => {
    return () => {
      if (watchRef.current != null && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, []);

  function stopTracking(silent = false) {
    if (watchRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setTracking(false);
    if (!silent) toast("warning", "Location tracking stopped", "No new GPS samples will be stored until you start tracking again.");
  }

  function processLocation(position) {
    const coords = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      speed: position.coords.speed,
      heading: position.coords.heading,
      at: nowISO(),
    };

    setDb((prev) => {
      const u = prev.users.find((x) => x.id === session.userId);
      const fence = prev.settings.geoFence;
      const inFence = isInsideGeoFence(coords, fence);
      let rides = [...prev.rides];
      let vehicle = { ...prev.vehicle };
      let eventMessages = [];

      const idx = rides.findIndex((r) => r.userId === session.userId && !["TRIP COMPLETED", "CANCELLED"].includes(r.tripStatus));
      if (idx >= 0) {
        const ride = { ...rides[idx] };
        ride.currentLat = coords.lat;
        ride.currentLng = coords.lng;
        ride.geoStatus = inFence ? "INSIDE GEO-FENCE" : "OUTSIDE GEO-FENCE";
        ride.lastLocationAt = coords.at;

        const dest = ride.destinationLat != null && ride.destinationLng != null
          ? { lat: Number(ride.destinationLat), lng: Number(ride.destinationLng), name: ride.destinationName }
          : null;
        const destDistance = dest ? distanceMeters(coords, dest) : Infinity;
        ride.distanceToDestinationM = Number.isFinite(destDistance) ? Math.round(destDistance) : null;

        if (!inFence) {
          if (!ride.motorLocked) {
            eventMessages.push({ level: "error", type: "VEHICLE_LOCKED", message: `User moved outside the permitted geo-fence. Vehicle motor locked — re-verify OTP to resume.` });
          }
          ride.vehicleEnabled = false;
          ride.motorLocked = true;
          ride.otp = null;
          ride.otpVerified = false;
          ride.otpGeneratedAt = null;
          ride.tripStatus = "VEHICLE LOCKED";
          ride.locationStatus = "OUTSIDE GEO-FENCE";
          vehicle = { ...vehicle, motorCommand: "OFF", lastCommandAt: coords.at, lastCommandReason: "Outside geo-fence — motor locked" };
        } else if (ride.motorLocked) {
          ride.tripStatus = "VEHICLE LOCKED";
          ride.locationStatus = "LOCKED — VERIFY OTP TO RESUME";
        } else if (dest && destDistance <= Number(fence.arrivalRadiusM)) {
          if (ride.tripStatus !== "TRIP COMPLETED") eventMessages.push({ level: "info", type: "DESTINATION_REACHED", message: `${dest.name} reached. Vehicle disabled and trip completed.` });
          ride.vehicleEnabled = false;
          ride.tripStatus = "TRIP COMPLETED";
          ride.locationStatus = "DESTINATION REACHED";
          ride.endTime = ride.endTime || coords.at;
          vehicle = { ...vehicle, motorCommand: "OFF", lastCommandAt: coords.at, lastCommandReason: "Destination reached" };
        } else if (ride.paymentStatus === "SUCCESS" && ride.otpVerified && ride.startTime) {
          ride.tripStatus = "RIDE STARTED";
          ride.locationStatus = destDistance < 400 ? "APPROACHING DESTINATION" : "INSIDE GEO-FENCE";
          ride.vehicleEnabled = true;
          vehicle = { ...vehicle, motorCommand: "ON", lastCommandAt: coords.at, lastCommandReason: "Authenticated, paid and inside geo-fence" };
        }
        rides[idx] = ride;
      }

      const sample = {
        id: uid("LOC"),
        userId: session.userId,
        userName: u?.name || "User",
        rideId: idx >= 0 ? rides[idx].id : null,
        lat: coords.lat,
        lng: coords.lng,
        accuracy: coords.accuracy,
        speed: coords.speed,
        heading: coords.heading,
        insideFence: inFence,
        at: coords.at,
      };

      let next = {
        ...prev,
        rides,
        vehicle,
        locationSamples: [sample, ...prev.locationSamples].slice(0, 5000),
      };
      next = appendEvent(next, {
        type: "LOCATION_UPDATE",
        actor: u?.name || "User",
        message: `GPS updated: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)} • ${inFence ? "inside" : "outside"} geo-fence.`,
        level: inFence ? "info" : "error",
        data: sample,
      });
      eventMessages.forEach((msg) => {
        next = appendEvent(next, { ...msg, actor: u?.name || "User" });
      });
      return next;
    });
  }

  function startTracking() {
    if (!navigator.geolocation) {
      toast("error", "GPS not supported", "Your browser does not provide geolocation.");
      return;
    }
    if (watchRef.current != null) return;
    const id = navigator.geolocation.watchPosition(
      processLocation,
      (error) => {
        toast("error", "Location error", geolocationErrorMessage(error));
        stopTracking(true);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
    watchRef.current = id;
    setTracking(true);
    toast("success", "Live tracking started", "Each browser GPS update will be stored in local history while this dashboard remains open.");
  }

  async function captureLocationOnce(target = "tracking") {
    try {
      const pos = await requestGeolocation();
      if (target === "delivery") {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setProfileForm((f) => ({ ...f, deliveryLat: lat, deliveryLng: lng }));
        toast("success", "Delivery coordinates captured", "Current GPS latitude/longitude copied to your delivery address fields.");
      } else {
        processLocation(pos);
        toast("success", "Location captured", "Current GPS position stored in location history.");
      }
    } catch (err) {
      toast("error", "Location permission", err.message);
    }
  }

  async function captureBookingLocation(field) {
    try {
      const pos = await requestGeolocation();
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (field === "pickup") setBookingForm((f) => ({ ...f, pickupLat: lat, pickupLng: lng }));
      else setBookingForm((f) => ({ ...f, deliveryLat: lat, deliveryLng: lng }));
      toast("success", "Location captured", `Current GPS coordinates copied to the ${field} fields.`);
    } catch (err) {
      toast("error", "Location permission", err.message);
    }
  }

  function selectDropLocation(loc) {
    setBookingForm((f) => ({ ...f, deliveryMode: "preset", deliverySelectedId: loc.id, deliveryAddress: loc.name, deliveryLat: loc.lat, deliveryLng: loc.lng }));
  }

  function chooseOtherDelivery() {
    setBookingForm((f) => ({ ...f, deliveryMode: "other", deliverySelectedId: null, deliveryAddress: "", deliveryLat: "", deliveryLng: "" }));
  }

  function bookRide(e) {
    e.preventDefault();
    if (currentRide) {
      toast("warning", "Trip already active", "Complete or cancel the current trip before booking another ride.");
      return;
    }
    const pickupLat = bookingForm.pickupLat === "" ? NaN : Number(bookingForm.pickupLat);
    const pickupLng = bookingForm.pickupLng === "" ? NaN : Number(bookingForm.pickupLng);
    const deliveryLat = bookingForm.deliveryLat === "" ? NaN : Number(bookingForm.deliveryLat);
    const deliveryLng = bookingForm.deliveryLng === "" ? NaN : Number(bookingForm.deliveryLng);
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      toast("error", "Pickup location", "Enter or capture a valid pickup latitude and longitude.");
      return;
    }
    if (!bookingForm.deliveryMode || !Number.isFinite(deliveryLat) || !Number.isFinite(deliveryLng)) {
      toast("error", "Delivery location", "Choose a drop location or Other, and enter a valid delivery latitude and longitude.");
      return;
    }
    const distanceKm = Math.round((distanceMeters({ lat: pickupLat, lng: pickupLng }, { lat: deliveryLat, lng: deliveryLng }) / 1000) * 100) / 100;
    const amount = Math.round((Number(db.settings.fare.baseFare) + Number(db.settings.fare.perKmRate) * distanceKm) * 100) / 100;
    const destinationName = bookingForm.deliveryAddress.trim() || `${deliveryLat.toFixed(5)}, ${deliveryLng.toFixed(5)}`;
    const ride = {
      id: uid("TRIP"),
      userId: user.id,
      userName: user.name,
      mobile: user.mobile,
      pickupLat,
      pickupLng,
      pickupAddress: bookingForm.pickupAddress.trim(),
      destinationLat: deliveryLat,
      destinationLng: deliveryLng,
      destinationName,
      distanceKm,
      amount,
      otp: null,
      otpVerified: false,
      otpGeneratedAt: null,
      paymentStatus: "PENDING",
      paymentId: null,
      paymentMethod: null,
      vehicleEnabled: false,
      geoStatus: insideFence === false ? "OUTSIDE GEO-FENCE" : "UNKNOWN",
      locationStatus: "WAITING FOR AUTHENTICATION",
      tripStatus: "WAITING FOR AUTHENTICATION",
      createdAt: nowISO(),
      startTime: null,
      endTime: null,
      currentLat: currentLocation?.lat ?? pickupLat,
      currentLng: currentLocation?.lng ?? pickupLng,
    };
    setDb((prev) => appendEvent({ ...prev, rides: [ride, ...prev.rides] }, {
      type: "RIDE_BOOKED",
      actor: user.name,
      message: `Ride booked to ${destinationName} (${distanceKm} km) for ${money(amount)}.`,
    }));
    setTab("ride");
    toast("success", "Ride booked", "Generate OTP to continue vehicle access authentication.");
  }

  function generateOtp() {
    if (!currentRide) return;
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    setDb((prev) => {
      const rides = prev.rides.map((r) => r.id === currentRide.id ? { ...r, otp, otpVerified: false, otpGeneratedAt: nowISO(), tripStatus: "OTP GENERATED", locationStatus: "OTP GENERATED" } : r);
      return appendEvent({ ...prev, rides }, { type: "OTP_GENERATED", actor: user.name, message: `OTP generated for trip ${currentRide.id}.` });
    });
    setOtpInput("");
    pushEmergencyUpdate({
      Emergency: 1,
      EmergencyNumber: toE164India(user.mobile),
      HR: Number(otp),
      EmergencyCreatedAt: Date.now(),
    });
    toast("success", "OTP generated", `Your dashboard OTP is ${otp}. Enter it below to simulate vehicle keypad verification.`);
  }

  function verifyOtp() {
    if (!currentRide?.otp) return toast("warning", "Generate OTP first", "Generate an OTP before verification.");
    if (otpInput.trim() !== currentRide.otp) {
      setDb((prev) => appendEvent(prev, { type: "OTP_FAILED", level: "error", actor: user.name, message: `Incorrect OTP entered for ${currentRide.id}.` }));
      toast("error", "OTP incorrect", "The entered OTP does not match.");
      return;
    }
    pushEmergencyUpdate({ Emergency: 0 });
    const wasLocked = currentRide.motorLocked;
    setDb((prev) => {
      const rides = prev.rides.map((r) => r.id === currentRide.id ? {
        ...r,
        otpVerified: true,
        otpVerifiedAt: nowISO(),
        motorLocked: false,
        tripStatus: "OTP VERIFIED",
        locationStatus: wasLocked ? "AWAITING GPS CONFIRMATION" : "DESTINATION SELECTED",
      } : r);
      return appendEvent({ ...prev, rides }, { type: wasLocked ? "VEHICLE_UNLOCKED" : "OTP_VERIFIED", actor: user.name, message: wasLocked ? `Vehicle unlocked after re-verification for ${currentRide.id}.` : `OTP verified for ${currentRide.id}.` });
    });
    toast("success", wasLocked ? "Vehicle unlocked" : "OTP verified", wasLocked ? "Re-authentication successful. The motor will re-enable once GPS confirms you are back inside the geo-fence." : "Authentication successful. You can proceed to dummy payment.");
  }

  function completePayment(method, methodForm) {
    if (!paymentRide) return;
    const payment = {
      id: uid("PAY"),
      rideId: paymentRide.id,
      userId: user.id,
      userName: user.name,
      mobile: user.mobile,
      destinationName: paymentRide.destinationName,
      amount: Number(paymentRide.amount),
      method,
      methodMeta: method === "NET_BANKING" ? methodForm.bank : method === "WALLET" ? methodForm.wallet : method,
      reference: `DEMO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "SUCCESS",
      at: nowISO(),
    };
    setDb((prev) => {
      const fence = prev.settings.geoFence;
      const latest = prev.locationSamples.find((s) => s.userId === user.id);
      const loc = latest ? { lat: Number(latest.lat), lng: Number(latest.lng) } : null;
      const inFence = isInsideGeoFence(loc, fence);
      const rides = prev.rides.map((r) => r.id === paymentRide.id ? {
        ...r,
        paymentStatus: "SUCCESS",
        paymentId: payment.id,
        paymentMethod: method,
        tripStatus: inFence ? "PAYMENT SUCCESSFUL" : "VEHICLE DISABLED",
        locationStatus: inFence ? "PAYMENT SUCCESSFUL" : "OUTSIDE GEO-FENCE",
        vehicleEnabled: Boolean(inFence),
      } : r);
      let next = {
        ...prev,
        payments: [payment, ...prev.payments],
        rides,
        vehicle: {
          ...prev.vehicle,
          motorCommand: inFence ? "ON" : "OFF",
          lastCommandAt: nowISO(),
          lastCommandReason: inFence ? "Payment successful and geo-fence OK" : "Payment successful but user not confirmed inside geo-fence",
        },
      };
      next = appendEvent(next, { type: "PAYMENT_SUCCESS", actor: user.name, message: `${money(payment.amount)} paid by ${method} for ${payment.destinationName}.` });
      if (!inFence) next = appendEvent(next, { type: "VEHICLE_DISABLED", level: "warning", actor: user.name, message: "Payment succeeded, but vehicle remains disabled until a GPS update confirms the user is inside the geo-fence." });
      return next;
    });
    setPaymentRide(null);
    toast("success", "Demo payment successful", `${money(payment.amount)} recorded using ${method}.`);
  }

  function startRide() {
    if (!currentRide) return;
    if (!currentRide.otpVerified || currentRide.paymentStatus !== "SUCCESS") return toast("warning", "Ride not authorized", "OTP verification and successful payment are required.");
    if (!currentLocation) return toast("warning", "Location required", "Capture or start live GPS tracking before starting the ride.");
    if (db.settings.geoFence.enabled && !insideFence) return toast("error", "Outside geo-fence", "Vehicle cannot be enabled outside the permitted area.");
    setDb((prev) => {
      const rides = prev.rides.map((r)=>r.id===currentRide.id?{...r,startTime:r.startTime||nowISO(),tripStatus:"RIDE STARTED",locationStatus:"INSIDE GEO-FENCE",geoStatus:"INSIDE GEO-FENCE",vehicleEnabled:true}:r);
      return appendEvent({ ...prev, rides, vehicle:{...prev.vehicle,motorCommand:"ON",lastCommandAt:nowISO(),lastCommandReason:"Ride started: authenticated, paid and inside geo-fence"}}, {type:"RIDE_STARTED",actor:user.name,message:`Trip ${currentRide.id} started toward ${currentRide.destinationName}.`});
    });
    if (!tracking) startTracking();
    toast("success", "Ride started", "Vehicle is enabled in simulation and live geo-fence monitoring is active.");
  }

  function cancelRide() {
    if (!currentRide) return;
    if (!window.confirm("Cancel this trip?")) return;
    setDb((prev) => {
      const rides = prev.rides.map((r)=>r.id===currentRide.id?{...r,tripStatus:"CANCELLED",locationStatus:"VEHICLE DISABLED",vehicleEnabled:false,endTime:nowISO()}:r);
      return appendEvent({...prev,rides,vehicle:{...prev.vehicle,motorCommand:"OFF",lastCommandAt:nowISO(),lastCommandReason:"User cancelled trip"}}, {type:"TRIP_CANCELLED",level:"warning",actor:user.name,message:`Trip ${currentRide.id} cancelled.`});
    });
    toast("warning", "Trip cancelled", "The simulated vehicle has been disabled.");
  }

  function saveProfile(e) {
    e.preventDefault();
    const p = profileForm;
    if (!p?.name.trim() || !p.mobile.trim()) return toast("error", "Required details", "Name and mobile number are required.");
    const lat = p.deliveryLat === "" ? null : Number(p.deliveryLat);
    const lng = p.deliveryLng === "" ? null : Number(p.deliveryLng);
    if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) return toast("error", "Coordinates", "Enter valid delivery latitude and longitude.");
    setDb((prev) => {
      const users = prev.users.map((u)=>u.id===user.id?{...u,...p,deliveryLat:lat,deliveryLng:lng,updatedAt:nowISO()}:u);
      return appendEvent({...prev,users},{type:"PROFILE_UPDATED",actor:user.name,message:"User profile and delivery address were updated."});
    });
    toast("success", "Profile saved", "Contact and delivery-location details were stored locally.");
  }

  function submitReview(reached, driverRating) {
    if (!reviewRide) return;
    setDb((prev) => {
      const rides = prev.rides.map((r) => r.id === reviewRide.id ? { ...r, reachedStatus: reached, driverRating, reviewedAt: nowISO() } : r);
      return appendEvent({ ...prev, rides }, { type: "RIDE_REVIEWED", actor: user.name, message: `Review submitted for trip ${reviewRide.id}: ${reached === "REACHED" ? "reached" : "not reached"}, driver rated ${driverRating}.` });
    });
    setReviewRide(null);
    toast("success", "Review submitted", "Thanks for your feedback.");
  }

  const nav = [
    ["home", "Dashboard", "⌂"],
    ["ride", "Current Ride", "↗"],
    ["map", "Live Map", "⌖"],
    ["history", "Ride History", "≡"],
    ["payments", "Payments", "₹"],
    ["profile", "My Profile", "♙"],
  ];

  if (!user) return <div className="fatal">User profile not found. Please log out and register again.</div>;

  return (
    <div className="app-shell user-theme">
      <aside className="sidebar">
        <div className="brand-row"><div className="logo">SV</div><div><b>SmartVehicle</b><span>User Mobility</span></div></div>
        <div className="sidebar-role"><span>USER PORTAL</span><b>{user.name}</b><small>{user.mobile}</small></div>
        <nav>{nav.map(([id,label,icon])=><button key={id} className={tab===id?"active":""} onClick={()=>setTab(id)}><i>{icon}</i><span>{label}</span></button>)}</nav>
        <div className="sidebar-bottom">
          <div className="hardware-mini"><span className={`dot ${tracking?"good":"warn"}`}/><div><b>GPS Tracking</b><small>{tracking?"Live":"Stopped"}</small></div></div>
          <button className="logout" onClick={()=>{stopTracking(true);logout();}}>↪ Logout</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar"><div><div className="eyebrow">USER DASHBOARD</div><h1>{nav.find((n)=>n[0]===tab)?.[1]}</h1></div><div className="top-actions"><Badge tone={tracking?"good":"warn"}>{tracking?"GPS Live":"GPS Off"}</Badge><div className="user-chip"><span>{user.name.charAt(0).toUpperCase()}</span><div><b>{user.name}</b><small>{user.mobile}</small></div></div></div></header>

        <div className="content">
          {tab === "home" ? (
            <>
              <div className="welcome-card"><div><div className="eyebrow">WELCOME BACK</div><h2>{user.name}</h2><p>Enter pickup and delivery coordinates, authenticate, make a dummy payment and start live geo-fenced tracking.</p></div><div className="welcome-status"><span>Vehicle</span><b className={db.vehicle.motorCommand==="ON"?"green":"red"}>{db.vehicle.motorCommand}</b></div></div>
              <div className="metrics-grid"><Metric icon="⌖" label="Geo-Fence" value={insideFence == null ? "GPS Needed" : insideFence ? "Inside" : "Outside"} hint={`${db.settings.geoFence.radiusM} m permitted radius`} /><Metric icon="↗" label="Current Trip" value={currentRide ? currentRide.tripStatus : "No Active Trip"} hint={currentRide?.destinationName || "Book a ride"} /><Metric icon="₹" label="Payment" value={currentRide?.paymentStatus || "—"} hint={currentRide ? money(currentRide.amount) : "No amount due"} /><Metric icon="◎" label="GPS Samples" value={userLocations.length} hint={latestLocation ? `Last: ${formatDate(latestLocation.at)}` : "No location stored"} /></div>

              <div className="grid-main-side">
                <div className="card">
                  <SectionHeader title="Book a Ride" subtitle="Choose your own pickup and delivery latitude/longitude. Fare is calculated by distance." />
                  {currentRide ? (
                    <Empty text={`Trip in progress to ${currentRide.destinationName}. Complete or cancel it before booking another ride.`} />
                  ) : bookingForm ? (
                    <form className="booking-form" onSubmit={bookRide}>
                      <h3>Pickup</h3>
                      <Field label="Pickup address (optional)"><input value={bookingForm.pickupAddress} onChange={(e)=>setBookingForm(f=>({...f,pickupAddress:e.target.value}))} placeholder="e.g. Home"/></Field>
                      <div className={`gps-hero ${bookingForm.pickupLat!==""?"live":""}`}><div>⌖</div><b>{bookingForm.pickupLat!==""?"Pickup set to your current GPS location":"Detecting your current location…"}</b><span>{bookingForm.pickupLat!==""?`${Number(bookingForm.pickupLat).toFixed(6)}, ${Number(bookingForm.pickupLng).toFixed(6)}`:"Allow location access to auto-fill pickup"}</span></div>
                      <button type="button" className="ghost wide" onClick={()=>captureBookingLocation("pickup")}>Refresh My Location</button>

                      <h3 className="top-gap-sm">Delivery</h3>
                      <div className="destination-cards">
                        {db.dropLocations.map((d)=>(
                          <button type="button" key={d.id} className={`destination-card ${bookingForm.deliveryMode==="preset"&&bookingForm.deliverySelectedId===d.id?"selected":""}`} onClick={()=>selectDropLocation(d)}>
                            <div><b>{d.name}</b><small>{Number(d.lat).toFixed(5)}, {Number(d.lng).toFixed(5)}</small></div>
                          </button>
                        ))}
                        <button type="button" className={`destination-card ${bookingForm.deliveryMode==="other"?"selected":""}`} onClick={chooseOtherDelivery}>
                          <div><b>Other</b><small>Enter a custom address</small></div>
                        </button>
                      </div>
                      {bookingForm.deliveryMode === "other" ? (
                        <>
                          <Field label="Delivery address"><textarea value={bookingForm.deliveryAddress} onChange={(e)=>setBookingForm(f=>({...f,deliveryAddress:e.target.value}))} placeholder="Where should the vehicle go?"/></Field>
                          <div className="grid-2">
                            <Field label="Delivery latitude"><input type="number" step="any" value={bookingForm.deliveryLat} onChange={(e)=>setBookingForm(f=>({...f,deliveryLat:e.target.value}))}/></Field>
                            <Field label="Delivery longitude"><input type="number" step="any" value={bookingForm.deliveryLng} onChange={(e)=>setBookingForm(f=>({...f,deliveryLng:e.target.value}))}/></Field>
                          </div>
                          <button type="button" className="ghost wide" onClick={()=>captureBookingLocation("delivery")}>Use My Current GPS for Delivery</button>
                        </>
                      ) : bookingForm.deliveryMode === "preset" ? (
                        <div className="mini-list"><div><span>Selected location</span><b>{bookingForm.deliveryAddress}</b></div><div><span>Coordinates</span><b>{Number(bookingForm.deliveryLat).toFixed(5)}, {Number(bookingForm.deliveryLng).toFixed(5)}</b></div></div>
                      ) : db.dropLocations.length === 0 ? (
                        <Empty text="No drop locations configured yet. Choose Other to enter a custom address."/>
                      ) : null}

                      <div className="workflow-amount top-gap-sm">{bookingFare!=null?`${money(bookingFare)} • ${bookingDistanceKm.toFixed(2)} km`:"Enter pickup and delivery coordinates to see the fare"}</div>
                      <button className="primary wide top-gap-sm">Book Ride</button>
                    </form>
                  ) : null}
                </div>
                <div className="card">
                  <h3>Quick Location Control</h3>
                  <div className={`gps-hero ${tracking?"live":""}`}><div>⌖</div><b>{tracking?"Live tracking active":"Tracking stopped"}</b><span>{latestLocation?`${Number(latestLocation.lat).toFixed(6)}, ${Number(latestLocation.lng).toFixed(6)}`:"No GPS position stored yet"}</span></div>
                  <div className="stack-buttons">{!tracking?<button className="primary" onClick={startTracking}>Start Live Tracking</button>:<button className="danger" onClick={()=>stopTracking(false)}>Stop Tracking</button>}<button className="ghost" onClick={()=>captureLocationOnce("tracking")}>Capture Location Once</button></div>
                  {insideFence != null ? <div className={`geo-alert ${insideFence?"good":"bad"}`}><b>{insideFence?"Inside Geo-Fence":"Outside Geo-Fence"}</b><span>{insideFence?"Vehicle may operate after OTP and payment.":"Vehicle is automatically disabled in the simulation."}</span></div>:null}
                </div>
              </div>
              <div className="top-gap"><GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={currentLocation} deliveryPoint={deliveryPoint} pickupPoint={pickupPoint||bookingPickupPreview} destinationPoint={destinationPoint||bookingDeliveryPreview} height={470}/></div>
            </>
          ) : null}

          {tab === "ride" ? (
            <>
              <SectionHeader title="Current Ride Workflow" subtitle="OTP → payment → vehicle authorization → live location → destination arrival." />
              {!currentRide ? <div className="card"><Empty text="No active trip. Open Dashboard and book a ride with pickup and delivery coordinates."/><button className="primary center-btn" onClick={()=>setTab("home")}>Book a Ride</button></div> : (
                <>
                  <div className="ride-hero card"><div><span className="stop-number large">⌖</span></div><div className="ride-destination"><div className="eyebrow">DELIVERY DESTINATION</div><h2>{currentRide.destinationName}</h2><p>Pickup: {Number(currentRide.pickupLat).toFixed(6)}, {Number(currentRide.pickupLng).toFixed(6)}</p><p>Delivery: {Number(currentRide.destinationLat).toFixed(6)}, {Number(currentRide.destinationLng).toFixed(6)}</p><p>{currentRide.distanceKm} km</p></div><div className="ride-price"><span>Ride amount</span><b>{money(currentRide.amount)}</b></div></div>
                  {currentRide.motorLocked ? <div className="geo-alert bad"><b>⚠ Vehicle Locked — Outside Geo-Fence</b><span>The motor was locked automatically because you left the permitted area. Generate and verify a new OTP below to unlock it.</span></div> : null}
                  <div className="workflow-grid">
                    <div className={`workflow-card ${currentRide.otp?"done":"active"}`}><span className="step">1</span><h3>Generate OTP</h3><p>Simulates OTP displayed in the registered user web application. Valid for 30 seconds.</p>{currentRide.otp?<><div className="otp-display">{currentRide.otp}</div>{!currentRide.otpVerified?<small>Expires in {otpSecondsLeft}s</small>:null}</>:<button className="primary wide" onClick={generateOtp}>{currentRide.motorLocked?"Generate Unlock OTP":"Generate OTP"}</button>}</div>
                    <div className={`workflow-card ${currentRide.otpVerified&&!currentRide.motorLocked?"done":currentRide.otp?"active":""}`}><span className="step">2</span><h3>Verify OTP</h3><p>Enter the same OTP to simulate the vehicle keypad authentication.</p><input className="otp-input" inputMode="numeric" maxLength="6" value={otpInput} onChange={(e)=>setOtpInput(e.target.value.replace(/\D/g,""))} placeholder="000000"/><button className="primary wide" disabled={!currentRide.otp||(currentRide.otpVerified&&!currentRide.motorLocked)} onClick={verifyOtp}>{currentRide.otpVerified&&!currentRide.motorLocked?"OTP Verified ✓":"Verify OTP"}</button></div>
                    <div className={`workflow-card ${currentRide.paymentStatus==="SUCCESS"?"done":currentRide.otpVerified?"active":""}`}><span className="step">3</span><h3>Dummy Payment</h3><p>Select wallet, net banking, UPI or card. No real payment is made.</p><div className="workflow-amount">{money(currentRide.amount)}</div><button className="primary wide" disabled={!currentRide.otpVerified||currentRide.paymentStatus==="SUCCESS"} onClick={()=>setPaymentRide(currentRide)}>{currentRide.paymentStatus==="SUCCESS"?`Paid via ${currentRide.paymentMethod} ✓`:"Pay Now"}</button></div>
                    <div className={`workflow-card ${currentRide.startTime&&!currentRide.motorLocked?"done":currentRide.paymentStatus==="SUCCESS"?"active":""}`}><span className="step">4</span><h3>Start Ride</h3><p>Requires verified OTP, successful payment and current location inside geo-fence.</p><div className="workflow-status"><Badge>{currentRide.geoStatus||"GPS REQUIRED"}</Badge><Badge tone={currentRide.motorLocked?"bad":undefined}>{currentRide.motorLocked?"VEHICLE LOCKED":currentRide.vehicleEnabled?"VEHICLE ENABLED":"VEHICLE DISABLED"}</Badge></div><button className="success wide" disabled={Boolean(currentRide.startTime)} onClick={startRide}>{currentRide.motorLocked?"Locked — Verify OTP":currentRide.startTime?"Ride Running ✓":"Start Ride"}</button></div>
                  </div>
                  <div className="grid-main-side top-gap">
                    <GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={currentLocation} pickupPoint={pickupPoint} destinationPoint={destinationPoint} deliveryPoint={deliveryPoint} height={470}/>
                    <div className="card"><h3>Live Ride Status</h3><div className="mini-list big"><div><span>Trip ID</span><b>{currentRide.id}</b></div><div><span>Trip Status</span><Badge>{currentRide.tripStatus}</Badge></div><div><span>Location Status</span><Badge>{currentRide.locationStatus}</Badge></div><div><span>Payment</span><Badge>{currentRide.paymentStatus}</Badge></div><div><span>Motor</span><Badge>{currentRide.vehicleEnabled?"ENABLED":"DISABLED"}</Badge></div><div><span>Distance to destination</span><b>{distanceToDestination==null?"GPS required":distanceToDestination>1000?`${(distanceToDestination/1000).toFixed(2)} km`:`${Math.round(distanceToDestination)} m`}</b></div></div><div className="stack-buttons top-gap-sm">{!tracking?<button className="primary" onClick={startTracking}>Start Live GPS</button>:<button className="danger" onClick={()=>stopTracking(false)}>Stop Live GPS</button>}<button className="danger-outline" onClick={cancelRide}>Cancel Trip</button></div></div>
                  </div>
                </>
              )}
            </>
          ) : null}

          {tab === "map" ? (
            <>
              <SectionHeader title="Live Google Map" subtitle="Current browser GPS, saved delivery coordinates, geo-fence and the active ride's pickup/delivery points." actions={<div className="button-row">{tracking?<button className="danger" onClick={()=>stopTracking(false)}>Stop GPS</button>:<button className="primary" onClick={startTracking}>Start GPS</button>}<button className="ghost" onClick={()=>captureLocationOnce("tracking")}>Locate Once</button></div>} />
              <GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={currentLocation} deliveryPoint={deliveryPoint} pickupPoint={pickupPoint} destinationPoint={destinationPoint} height={620}/>
              <div className="metrics-grid top-gap"><Metric icon="⌖" label="Latitude" value={currentLocation?currentLocation.lat.toFixed(6):"—"}/><Metric icon="⌖" label="Longitude" value={currentLocation?currentLocation.lng.toFixed(6):"—"}/><Metric icon="◎" label="GPS Accuracy" value={latestLocation?`${Math.round(latestLocation.accuracy||0)} m`:"—"}/><Metric icon="↗" label="Geo Status" value={insideFence==null?"Unknown":insideFence?"Inside":"Outside"}/></div>
            </>
          ) : null}

          {tab === "history" ? (
            <>
              <SectionHeader title="My Ride History" subtitle="Travel details stored on this laptop for your user account." />
              <div className="card">{userRides.length?<div className="table-wrap"><table><thead><tr><th>Trip ID</th><th>Delivery</th><th>Distance</th><th>Amount</th><th>Payment</th><th>Start</th><th>End</th><th>Status</th><th>Review</th></tr></thead><tbody>{userRides.map((r)=><tr key={r.id}><td>{r.id}</td><td>{r.destinationName}</td><td>{r.distanceKm!=null?`${r.distanceKm} km`:"—"}</td><td>{money(r.amount)}</td><td><Badge>{r.paymentStatus}</Badge></td><td>{formatDate(r.startTime)}</td><td>{formatDate(r.endTime)}</td><td><Badge>{r.tripStatus}</Badge></td><td>{["TRIP COMPLETED","CANCELLED"].includes(r.tripStatus)?(r.reviewedAt?<Badge tone={r.reachedStatus==="REACHED"?"good":"bad"}>{r.reachedStatus==="REACHED"?"Reached":"Not Reached"} • {r.driverRating}</Badge>:<button className="mini primary" onClick={()=>setReviewRide(r)}>Rate Ride</button>):"—"}</td></tr>)}</tbody></table></div>:<Empty text="No rides yet."/>}</div>
            </>
          ) : null}

          {tab === "payments" ? (
            <>
              <SectionHeader title="My Payments" subtitle="Dummy payment records for your rides." />
              <div className="card">{db.payments.filter((p)=>p.userId===user.id).length?<div className="table-wrap"><table><thead><tr><th>Payment ID</th><th>Trip</th><th>Destination</th><th>Method</th><th>Amount</th><th>Status</th><th>Reference</th><th>Time</th></tr></thead><tbody>{db.payments.filter((p)=>p.userId===user.id).map((p)=><tr key={p.id}><td>{p.id}</td><td>{p.rideId}</td><td>{p.destinationName}</td><td>{p.method}</td><td>{money(p.amount)}</td><td><Badge>{p.status}</Badge></td><td>{p.reference}</td><td>{formatDate(p.at)}</td></tr>)}</tbody></table></div>:<Empty text="No payment records yet."/>}</div>
            </>
          ) : null}

          {tab === "profile" && profileForm ? (
            <>
              <SectionHeader title="My Profile & Delivery Location" subtitle="Save username, contact details, address and exact delivery latitude/longitude." />
              <div className="grid-main-side reverse-mobile">
                <form className="card" onSubmit={saveProfile}>
                  <div className="grid-2"><Field label="Full name"><input value={profileForm.name} onChange={(e)=>setProfileForm(f=>({...f,name:e.target.value}))}/></Field><Field label="Username"><input value={profileForm.username} disabled/></Field></div>
                  <div className="grid-2"><Field label="Mobile number"><input value={profileForm.mobile} onChange={(e)=>setProfileForm(f=>({...f,mobile:e.target.value}))}/></Field><Field label="Alternate contact"><input value={profileForm.contactAlt} onChange={(e)=>setProfileForm(f=>({...f,contactAlt:e.target.value}))}/></Field></div>
                  <Field label="Email"><input type="email" value={profileForm.email} onChange={(e)=>setProfileForm(f=>({...f,email:e.target.value}))}/></Field>
                  <Field label="Home / contact address"><textarea value={profileForm.address} onChange={(e)=>setProfileForm(f=>({...f,address:e.target.value}))}/></Field>
                  <Field label="Delivery address"><textarea value={profileForm.deliveryAddress} onChange={(e)=>setProfileForm(f=>({...f,deliveryAddress:e.target.value}))} placeholder="Complete delivery address" autoComplete="off"/></Field>
                  <div className="grid-2"><Field label="Delivery latitude"><input type="number" step="any" value={profileForm.deliveryLat} onChange={(e)=>setProfileForm(f=>({...f,deliveryLat:e.target.value}))}/></Field><Field label="Delivery longitude"><input type="number" step="any" value={profileForm.deliveryLng} onChange={(e)=>setProfileForm(f=>({...f,deliveryLng:e.target.value}))}/></Field></div>
                  <div className="button-row"><button type="button" className="ghost" onClick={()=>captureLocationOnce("delivery")}>Use Current GPS for Delivery</button><button className="primary">Save Profile</button></div>
                </form>
                <div><GoogleMapPanel geoFence={db.settings.geoFence} currentLocation={currentLocation} deliveryPoint={profileForm.deliveryLat!==""&&profileForm.deliveryLng!==""?{lat:Number(profileForm.deliveryLat),lng:Number(profileForm.deliveryLng)}:null} height={515}/><div className="card top-gap-sm"><h3>Stored Tracking Summary</h3><div className="mini-list"><div><span>Total GPS samples</span><b>{userLocations.length}</b></div><div><span>Last location</span><b>{latestLocation?formatDate(latestLocation.at):"—"}</b></div><div><span>Delivery coordinates</span><b>{deliveryPoint?`${deliveryPoint.lat.toFixed(5)}, ${deliveryPoint.lng.toFixed(5)}`:"Not set"}</b></div></div></div></div>
              </div>
            </>
          ) : null}
        </div>
      </main>
      {paymentRide ? <PaymentModal ride={paymentRide} onClose={()=>setPaymentRide(null)} onSuccess={completePayment} toast={toast}/> : null}
      {reviewRide ? <ReviewModal ride={reviewRide} onClose={()=>setReviewRide(null)} onSubmit={submitReview}/> : null}
    </div>
  );
}

export default function App() {
  const [db, setDb] = useState(() => normalizeDb(null));
  const [dbLoaded, setDbLoaded] = useState(false);
  const [session, setSession] = useState(() => safeRead(SESSION_KEY, null));
  const [toastState, setToastState] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/db")
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setDb(normalizeDb(data));
      })
      .catch((error) => {
        console.error("Could not load data/db.json", error);
        if (!cancelled) {
          setToastState({
            id: Date.now(),
            type: "error",
            title: "Data file unavailable",
            message: "Could not reach the local data API. Make sure the app is running via 'npm run dev' (or 'npm run preview').",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setDbLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dbLoaded) return undefined;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const next = { ...db, meta: { ...db.meta, updatedAt: nowISO() } };
      fetch("/api/db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch((error) => console.error("Failed to save data/db.json", error));
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [db, dbLoaded]);

  useEffect(() => {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }, [session]);

  function showToast(type, title, message) {
    setToastState({ id: Date.now(), type, title, message });
  }

  function login(nextSession) {
    setSession({ ...nextSession, loginAt: nowISO() });
    showToast("success", "Login successful", `Welcome ${nextSession.name}.`);
  }

  function logout() {
    setSession(null);
    showToast("info", "Logged out", "Local data remains saved on this laptop.");
  }

  return (
    <>
      <style>{styles}</style>
      {!session ? (
        <LoginScreen db={db} setDb={setDb} onLogin={login} toast={showToast} />
      ) : session.role === "admin" ? (
        <AdminDashboard db={db} setDb={setDb} session={session} logout={logout} toast={showToast} />
      ) : (
        <UserDashboard db={db} setDb={setDb} session={session} logout={logout} toast={showToast} dbLoaded={dbLoaded} />
      )}
      <Toast toast={toastState} onClose={() => setToastState(null)} />
    </>
  );
}

const styles = String.raw`
*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}body{overflow-x:hidden}.auth-shell{min-height:100vh;display:grid;grid-template-columns:1.08fr .92fr;background:#eef3fb}.auth-brand-panel{padding:7vh 7vw;display:flex;flex-direction:column;justify-content:center;background:radial-gradient(circle at 20% 20%,rgba(59,130,246,.22),transparent 28%),linear-gradient(145deg,#07142d,#0c2853 55%,#164e63);color:white;position:relative;overflow:hidden}.auth-brand-panel:after{content:"";position:absolute;width:420px;height:420px;border:1px solid rgba(255,255,255,.08);border-radius:50%;right:-160px;bottom:-160px;box-shadow:0 0 0 60px rgba(255,255,255,.025),0 0 0 120px rgba(255,255,255,.02)}.logo{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#06b6d4);color:white;font-weight:900;box-shadow:0 10px 24px rgba(37,99,235,.28)}.logo.big{width:68px;height:68px;border-radius:21px;font-size:22px;margin-bottom:28px}.eyebrow{font-size:11px;letter-spacing:.16em;font-weight:800;color:#5f718c}.auth-brand-panel .eyebrow{color:#8dd6ff}.auth-brand-panel h1{font-size:clamp(38px,5vw,68px);line-height:1.02;max-width:760px;margin:14px 0 22px;letter-spacing:-.045em}.auth-brand-panel>p{font-size:17px;line-height:1.75;color:#c4d5eb;max-width:720px}.auth-feature-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px;max-width:700px}.auth-feature-grid div{padding:15px 16px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);border-radius:15px;font-weight:700;color:#e8f1ff}.local-note{margin-top:32px;display:flex;flex-direction:column;gap:5px;padding-left:15px;border-left:3px solid #38bdf8;color:#cfe6ff}.local-note strong{color:white}.auth-form-panel{display:grid;place-items:center;padding:36px}.auth-card{background:white;border-radius:26px;padding:34px;width:min(610px,100%);box-shadow:0 26px 70px rgba(15,23,42,.12);max-height:92vh;overflow:auto}.role-switch{display:grid;grid-template-columns:1fr 1fr;background:#eef2f8;border-radius:13px;padding:5px;margin-bottom:25px}.role-switch button{border:0;background:transparent;border-radius:10px;padding:11px;font-weight:800;color:#667085}.role-switch button.active{background:white;color:#1d4ed8;box-shadow:0 3px 14px rgba(15,23,42,.08)}.auth-title h2{font-size:28px;margin:0 0 8px}.auth-title p{color:#718096;margin:0 0 24px;line-height:1.55}.field{display:flex;flex-direction:column;gap:7px;margin-bottom:15px}.field>span{font-size:12px;font-weight:800;color:#40516b}.field small{font-size:11px;color:#8794a8}.field-error{font-size:12px;color:#be123c;margin:-8px 0 12px}.field input,.field textarea,.field select,.otp-input{width:100%;border:1px solid #dce3ed;border-radius:11px;padding:12px 13px;outline:none;background:#fbfcfe;color:#172033;transition:.18s}.field textarea{min-height:72px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus,.otp-input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.1);background:white}.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:13px}.primary,.success,.danger,.ghost,.danger-outline{border:0;border-radius:11px;padding:11px 15px;font-weight:800;transition:.15s}.primary{background:#2563eb;color:white;box-shadow:0 8px 18px rgba(37,99,235,.18)}.primary:hover{background:#1d4ed8}.success{background:#159447;color:white}.danger{background:#dc2626;color:white}.ghost{background:#eef3fa;color:#34445d}.danger-outline{background:#fff1f2;color:#be123c;border:1px solid #fecdd3}.wide{width:100%}.text-btn{border:0;background:transparent;color:#2563eb;font-weight:800;width:100%;margin-top:14px}.demo-creds{font-size:12px;color:#6b7280;background:#f8fafc;padding:10px;border-radius:9px;margin-bottom:15px}.app-shell{min-height:100vh}.sidebar{position:fixed;left:0;top:0;width:246px;height:100vh;background:#0d1b33;color:#c9d5e8;padding:19px 14px;display:flex;flex-direction:column;overflow-y:auto;z-index:20}.brand-row{display:flex;gap:11px;align-items:center;padding:4px 8px 17px;border-bottom:1px solid rgba(255,255,255,.08)}.brand-row>div:last-child{display:flex;flex-direction:column}.brand-row b{font-size:15px;color:white}.brand-row span{font-size:10px;color:#7387a9}.sidebar-role{display:flex;flex-direction:column;gap:4px;padding:20px 10px 10px}.sidebar-role>span{font-size:9px;letter-spacing:.15em;color:#6d82a7;font-weight:900}.sidebar-role b{font-size:13px;color:white}.sidebar-role small{font-size:11px;color:#8ea0bd}.sidebar nav{display:flex;flex-direction:column;gap:4px;margin-top:7px}.sidebar nav button{border:0;background:transparent;color:#93a6c4;padding:10px 11px;border-radius:10px;text-align:left;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700}.sidebar nav button i{font-style:normal;width:19px;text-align:center;font-size:16px}.sidebar nav button.active,.sidebar nav button:hover{background:#193255;color:white}.sidebar nav button.active{box-shadow:inset 3px 0 #38bdf8}.sidebar-bottom{margin-top:auto;border-top:1px solid rgba(255,255,255,.08);padding-top:15px}.hardware-mini{display:flex;gap:9px;align-items:center;padding:8px}.hardware-mini>div{display:flex;flex-direction:column}.hardware-mini b{font-size:11px;color:white}.hardware-mini small{font-size:10px;color:#7184a5}.dot{width:9px;height:9px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 4px rgba(148,163,184,.12)}.dot.good{background:#22c55e}.dot.warn{background:#f59e0b}.dot.bad{background:#ef4444}.logout{margin-top:7px;width:100%;border:0;background:rgba(255,255,255,.05);color:#9fb0c9;border-radius:10px;padding:10px;font-weight:700}.main{min-width:0;margin-left:246px}.topbar{height:78px;background:white;border-bottom:1px solid #e9eef5;display:flex;align-items:center;justify-content:space-between;padding:12px 28px;position:sticky;top:0;z-index:15}.topbar h1{font-size:20px;margin:2px 0 0}.top-actions{display:flex;align-items:center;gap:11px}.date-pill{font-size:12px;background:#f1f5f9;padding:8px 10px;border-radius:10px;color:#64748b}.user-chip{display:flex;align-items:center;gap:8px}.user-chip>span{width:35px;height:35px;border-radius:11px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-weight:900}.user-chip>div{display:flex;flex-direction:column}.user-chip b{font-size:12px}.user-chip small{font-size:10px;color:#8794a8}.content{padding:26px;max-width:1700px;margin:0 auto}.section-header{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin-bottom:17px}.section-header h2{margin:0;font-size:22px}.section-header p{margin:5px 0 0;color:#718096;font-size:13px;line-height:1.5}.section-actions{display:flex;gap:8px}.metrics-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric-card{background:white;border:1px solid #e9eef6;border-radius:15px;padding:17px;display:flex;gap:13px;align-items:flex-start;box-shadow:0 5px 20px rgba(15,23,42,.035)}.metric-icon{width:39px;height:39px;border-radius:12px;background:#eef4ff;color:#2563eb;display:grid;place-items:center;font-size:18px;font-weight:900}.metric-value{font-size:20px;font-weight:900;letter-spacing:-.02em}.metric-label{font-size:11px;font-weight:800;color:#5f6d82;margin-top:2px}.metric-hint{font-size:10px;color:#9aa5b5;margin-top:4px}.grid-main-side{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,.75fr);gap:17px}.grid-2-cards{display:grid;grid-template-columns:1fr 1fr;gap:17px;margin-top:17px}.card,.map-card{background:white;border:1px solid #e6ecf4;border-radius:16px;box-shadow:0 6px 22px rgba(15,23,42,.035)}.card{padding:18px}.card h3{margin:0 0 10px;font-size:15px}.muted{color:#77859a;font-size:12px;line-height:1.55}.map-card{overflow:hidden}.map-title-row{padding:13px 15px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #edf1f6}.map-title-row>div{display:flex;flex-direction:column;gap:3px}.map-title-row strong{font-size:13px}.map-title-row span{font-size:10px;color:#8895a7}.google-map{width:100%;background:#e8edf4}.map-error{padding:10px 14px;background:#fff1f2;color:#be123c;font-size:11px}.badge{display:inline-flex;align-items:center;justify-content:center;padding:5px 8px;border-radius:999px;font-size:9px;font-weight:900;letter-spacing:.03em;white-space:nowrap}.badge.good{background:#dcfce7;color:#15803d}.badge.bad{background:#fee2e2;color:#b91c1c}.badge.warn{background:#fef3c7;color:#a16207}.badge.neutral{background:#eef2f7;color:#526174}.vehicle-visual{display:flex;flex-direction:column;align-items:center;text-align:center;padding:16px 4px 20px}.power-ring{width:82px;height:82px;border-radius:50%;display:grid;place-items:center;font-size:30px;margin-bottom:12px}.power-ring.on{background:#dcfce7;color:#15803d;box-shadow:0 0 0 10px #f0fdf4}.power-ring.off{background:#fee2e2;color:#b91c1c;box-shadow:0 0 0 10px #fff1f2}.vehicle-visual b{font-size:16px}.vehicle-visual span{font-size:11px;color:#8491a3;margin-top:5px}.button-row{display:flex;gap:9px;flex-wrap:wrap}.button-row>*{flex:1}.mini-list{display:flex;flex-direction:column;margin-top:14px;border-top:1px solid #edf1f6}.mini-list>div{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #edf1f6;font-size:11px}.mini-list>div>span{color:#6f7d91}.mini-list.big>div{padding:13px 0}.mini-list.big>div>span{font-size:12px}.table-wrap{overflow:auto}.table-wrap table{width:100%;border-collapse:collapse;min-width:650px}.table-wrap th{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#8491a3;text-align:left;padding:10px;border-bottom:1px solid #e8edf4;background:#fbfcfe}.table-wrap td{padding:11px 10px;border-bottom:1px solid #eef2f6;font-size:11px;vertical-align:middle}.table-wrap tr:hover td{background:#fafcff}.table-wrap small{color:#8a97aa}.wrap-cell{min-width:180px;white-space:normal}.empty{text-align:center;padding:35px 16px;color:#93a0b2;font-size:12px}.timeline{display:flex;flex-direction:column}.timeline-item{display:grid;grid-template-columns:14px 1fr;gap:10px;padding:10px 0;border-bottom:1px solid #eef2f6}.timeline-item:last-child{border-bottom:0}.event-dot{width:8px;height:8px;border-radius:50%;margin-top:5px;background:#60a5fa}.event-dot.warning{background:#f59e0b}.event-dot.error{background:#ef4444}.event-dot.success{background:#22c55e}.timeline-item b{font-size:11px}.timeline-item p{font-size:11px;color:#58687e;line-height:1.4;margin:3px 0}.timeline-item small{font-size:9px;color:#96a1b1}.timeline.compact .timeline-item{padding:8px 0}.timeline-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.destination-list{display:flex;flex-direction:column}.destination-row{display:grid;grid-template-columns:1fr auto;gap:11px;align-items:center;padding:12px 0;border-bottom:1px solid #edf1f6}.destination-row.selected{background:#f3f8ff}.destination-number,.stop-number{width:34px;height:34px;border-radius:10px;background:#e8efff;color:#2563eb;display:grid;place-items:center;font-weight:900}.destination-info{display:flex;flex-direction:column;gap:3px}.destination-info b{font-size:12px}.destination-info span{font-size:10px;color:#8694a7}.destination-price{font-weight:900;font-size:13px}.destination-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.mini{border:0;border-radius:8px;padding:6px 8px;font-size:9px;font-weight:800}.toggle-line{display:flex;gap:9px;align-items:center;background:#f8fafc;padding:11px;border-radius:10px;font-size:12px;font-weight:700;margin:6px 0 14px}.top-gap{margin-top:17px}.top-gap-sm{margin-top:10px}.storage-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:17px}.storage-card{text-align:center}.storage-icon{width:66px;height:66px;border-radius:20px;background:#e8efff;color:#2563eb;display:grid;place-items:center;font-size:28px;margin:0 auto 14px}.storage-card p{max-width:650px;margin:0 auto 20px;color:#718096;font-size:12px;line-height:1.6}.storage-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.storage-stats span{background:#f8fafc;border-radius:10px;padding:10px;display:flex;flex-direction:column;font-size:9px;color:#7b8797}.storage-stats b{font-size:17px;color:#182337;margin-top:2px}.stack-buttons{display:flex;flex-direction:column;gap:8px}.card code{display:block;background:#101827;color:#d8e9ff;border-radius:10px;padding:12px;overflow:auto}.compact-metrics{margin-top:0}.user-theme .sidebar{background:#102622}.user-theme .sidebar nav button.active{background:#184139;box-shadow:inset 3px 0 #34d399}.user-theme .logo{background:linear-gradient(135deg,#059669,#0ea5e9)}.welcome-card{background:linear-gradient(125deg,#0f766e,#164e63);color:white;border-radius:18px;padding:24px 26px;display:flex;justify-content:space-between;align-items:center;margin-bottom:17px;box-shadow:0 12px 34px rgba(15,118,110,.2)}.welcome-card .eyebrow{color:#99f6e4}.welcome-card h2{font-size:28px;margin:5px 0}.welcome-card p{margin:0;color:#ccfbf1;font-size:12px}.welcome-status{display:flex;flex-direction:column;align-items:center;border:1px solid rgba(255,255,255,.2);border-radius:15px;padding:12px 20px;background:rgba(255,255,255,.07)}.welcome-status span{font-size:9px;color:#bceae4}.welcome-status b{font-size:25px}.green{color:#86efac}.red{color:#fecaca}.destination-cards{display:grid;grid-template-columns:1fr 1fr;gap:9px}.destination-card{border:1px solid #e3eaf3;background:#fbfdff;border-radius:13px;padding:12px;display:grid;grid-template-columns:1fr;gap:9px;align-items:center;text-align:left}.destination-card:hover:not(:disabled),.destination-card.selected{border-color:#60a5fa;background:#f3f8ff}.destination-card>div{display:flex;flex-direction:column;gap:3px}.destination-card b{font-size:11px}.destination-card small{font-size:9px;color:#8a97aa}.destination-card strong{font-size:12px;color:#0f766e}.gps-hero{padding:20px;text-align:center;background:#f8fafc;border-radius:14px;margin:12px 0}.gps-hero>div{font-size:30px}.gps-hero b{display:block;font-size:13px;margin:6px 0}.gps-hero span{font-size:10px;color:#7a8799}.gps-hero.live{background:#ecfdf5}.geo-alert{margin-top:13px;padding:11px;border-radius:11px;display:flex;flex-direction:column;gap:3px}.geo-alert.good{background:#ecfdf5;color:#166534}.geo-alert.bad{background:#fef2f2;color:#991b1b}.geo-alert b{font-size:11px}.geo-alert span{font-size:9px}.ride-hero{display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:13px}.stop-number.large{width:46px;height:46px;font-size:17px}.ride-destination h2{font-size:22px;margin:2px 0}.ride-destination p{font-size:10px;color:#8090a5;margin:0}.ride-price{text-align:right}.ride-price span{display:block;font-size:9px;color:#8996a7}.ride-price b{font-size:26px}.workflow-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}.workflow-card{position:relative;background:white;border:1px solid #e5eaf1;border-radius:15px;padding:16px;padding-top:22px;opacity:.72}.workflow-card.active{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.08);opacity:1}.workflow-card.done{border-color:#86efac;background:#fbfffc;opacity:1}.workflow-card .step{position:absolute;top:-10px;left:14px;width:23px;height:23px;border-radius:8px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-size:10px;font-weight:900}.workflow-card.done .step{background:#dcfce7;color:#15803d}.workflow-card h3{font-size:13px;margin:0 0 6px}.workflow-card p{font-size:10px;line-height:1.5;color:#78879a;min-height:46px}.otp-display{font-size:24px;letter-spacing:.16em;font-weight:900;text-align:center;background:#eff6ff;color:#1d4ed8;border-radius:10px;padding:10px}.otp-input{text-align:center;font-size:19px;font-weight:900;letter-spacing:.12em;margin:0 0 9px}.workflow-amount{text-align:center;font-size:23px;font-weight:900;color:#0f766e;margin:9px 0}.workflow-status{display:flex;gap:5px;flex-wrap:wrap;min-height:43px;align-items:center}.center-btn{display:block;margin:0 auto}.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:100;display:grid;place-items:center;padding:18px;backdrop-filter:blur(4px)}.modal{width:min(650px,100%);background:white;border-radius:20px;padding:22px;box-shadow:0 30px 90px rgba(0,0,0,.25)}.modal-head{display:flex;justify-content:space-between;align-items:flex-start}.modal-head h2{margin:3px 0 0}.close{width:35px;height:35px;border:0;border-radius:10px;background:#f1f5f9;font-size:22px}.payment-summary{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;background:#f8fafc;border-radius:12px;padding:12px;margin:16px 0}.payment-summary>div{display:flex;flex-direction:column;gap:3px}.payment-summary span{font-size:9px;color:#8390a1}.payment-summary b{font-size:11px}.payment-summary .amount b{font-size:20px;color:#0f766e}.payment-methods{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:15px}.payment-methods button{border:1px solid #e2e8f0;background:white;border-radius:11px;padding:10px;display:flex;flex-direction:column;align-items:center;gap:4px;color:#5d6b7e}.payment-methods button span{font-size:20px}.payment-methods button b{font-size:9px}.payment-methods button.active{border-color:#3b82f6;background:#eff6ff;color:#1d4ed8}.demo-banner{padding:10px;border-radius:10px;background:#fffbeb;color:#92400e;font-size:10px;margin-bottom:12px}.pay-button{padding:13px}.toast{position:fixed;right:20px;bottom:20px;z-index:200;width:min(370px,calc(100vw - 40px));background:#0f172a;color:white;border-radius:14px;padding:14px 42px 14px 15px;box-shadow:0 18px 50px rgba(15,23,42,.28);display:flex;flex-direction:column;gap:3px}.toast.success{background:#14532d}.toast.error{background:#7f1d1d}.toast.warning{background:#78350f}.toast strong{font-size:12px}.toast span{font-size:10px;color:rgba(255,255,255,.8);line-height:1.45}.toast button{position:absolute;right:10px;top:8px;border:0;background:transparent;color:white;font-size:20px}.fatal{min-height:100vh;display:grid;place-items:center;font-weight:800}.reverse-mobile{}.payment-modal select{cursor:pointer}
@media(max-width:1180px){.metrics-grid{grid-template-columns:1fr 1fr}.workflow-grid{grid-template-columns:1fr 1fr}.destination-row{grid-template-columns:1fr;row-gap:8px}.destination-actions{justify-content:flex-start}.grid-main-side{grid-template-columns:1fr}.storage-grid{grid-template-columns:1fr}.grid-2-cards{grid-template-columns:1fr}}
@media(max-width:820px){.auth-shell{grid-template-columns:1fr}.auth-brand-panel{display:none}.auth-form-panel{padding:17px;min-height:100vh}.auth-card{padding:22px;max-height:none}.sidebar{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;height:66px;padding:7px 8px;display:block;background:#0d1b33;z-index:50;border-top:1px solid rgba(255,255,255,.1);overflow-y:visible}.brand-row,.sidebar-role,.sidebar-bottom{display:none}.sidebar nav{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin:0;height:100%;overflow-x:auto}.sidebar nav button{padding:5px;display:flex;flex-direction:column;justify-content:center;gap:2px;text-align:center;min-width:58px}.sidebar nav button i{font-size:15px}.sidebar nav button span{font-size:8px}.sidebar nav button.active{box-shadow:none;background:#193255}.main{margin-left:0;padding-bottom:70px}.topbar{height:68px;padding:10px 14px}.topbar h1{font-size:17px}.date-pill,.user-chip>div{display:none}.content{padding:15px}.section-header{align-items:flex-start;flex-direction:column}.section-actions{width:100%}.section-actions>*{flex:1}.metrics-grid{grid-template-columns:1fr 1fr;gap:9px}.metric-card{padding:12px}.metric-value{font-size:16px}.metric-icon{width:34px;height:34px}.grid-2-cards{grid-template-columns:1fr}.grid-2{grid-template-columns:1fr}.destination-cards{grid-template-columns:1fr}.workflow-grid{grid-template-columns:1fr 1fr}.payment-methods{grid-template-columns:1fr 1fr}.payment-summary{grid-template-columns:1fr 1fr}.payment-summary .amount{grid-column:1/3}.storage-stats{grid-template-columns:1fr 1fr}.welcome-card{padding:18px}.welcome-card p{max-width:70%}.ride-hero{grid-template-columns:45px 1fr}.ride-price{grid-column:2;text-align:left}.map-title-row{align-items:flex-start;gap:8px}.google-map{min-height:320px}}
@media(max-width:520px){.auth-form-panel{padding:0}.auth-card{min-height:100vh;border-radius:0;box-shadow:none;padding:20px 16px}.metrics-grid{grid-template-columns:1fr}.workflow-grid{grid-template-columns:1fr}.sidebar nav{grid-template-columns:repeat(6,68px)}.top-actions .badge{display:none}.content{padding:12px}.card{padding:14px}.welcome-card{align-items:flex-start}.welcome-status{padding:9px 12px}.welcome-card p{max-width:100%}.destination-row{grid-template-columns:36px 1fr 70px}.destination-card{grid-template-columns:34px 1fr auto}.button-row{flex-direction:column}.payment-methods{grid-template-columns:1fr 1fr}.modal{padding:16px}.toast{right:12px;bottom:78px;width:calc(100vw - 24px)}.section-header h2{font-size:19px}}
`;
