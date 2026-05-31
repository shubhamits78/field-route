import { useState, useEffect, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// ============================================================
// INDEXEDDB  — DB_VERSION 3 adds nothing new structurally,
//              just ensures clean upgrade path
// ============================================================
const DB_NAME = "FieldRoutePlannerDB";
const DB_VERSION = 3;
const STORE_NAME = "days";
const MASTER_STORE = "masterShops";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "day" });
      if (!db.objectStoreNames.contains(MASTER_STORE))
        db.createObjectStore(MASTER_STORE, { keyPath: "locationNum" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDay(data) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function loadAllDays() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function saveMasterLocation(locationNum, shops) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(MASTER_STORE, "readwrite");
    tx.objectStore(MASTER_STORE).put({ locationNum, shops });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function loadAllMasterLocations() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(MASTER_STORE, "readonly");
    const req = tx.objectStore(MASTER_STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
// ============================================================
// EXPORT / IMPORT
// ============================================================
function exportShops(masterShops) {
  const data = { version: 1, exportedAt: new Date().toISOString(), masterShops };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fieldroute-shops-${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importShops(file, setMasterShops, setStatus) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const shops = data.masterShops;
    if (!shops || typeof shops !== "object") throw new Error("Invalid file format");
    const next = {};
    for (const [locNum, locShops] of Object.entries(shops)) {
      const patched = locShops.map(s => ({
        frequency: "weekly",
        openTime: "09:00",
        closeTime: "20:00",
        lastVisited: null,
        visitNote: "",
        ...s,
      }));
      next[Number(locNum)] = patched;
      await saveMasterLocation(Number(locNum), patched);
    }
    setMasterShops(prev => ({ ...prev, ...next }));
    setStatus("✓ Shops imported successfully");
  } catch (e) {
    setStatus(`✗ Import failed: ${e.message}`);
  }
}
// ============================================================
// HELPERS
// ============================================================
function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

function resetVisitedIfNewDay(dayObj) {
  const today = getTodayDate();
  if (!dayObj.lastUsedDate || dayObj.lastUsedDate !== today) {
    return {
      ...dayObj,
      locations: dayObj.locations.map(l => ({ ...l, visited: false })),
      lastUsedDate: today,
    };
  }
  return dayObj;
}

// Day → Location: Day 1,7,13,19 → Loc 1 | Day 2,8,14,20 → Loc 2 etc.
const getDayLocation = (day) => ((day - 1) % 6) + 1;

// Days since last visit
const daysSince = (dateStr) => {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

// Overdue check based on frequency
const isOverdue = (shop) => {
  if (!shop.lastVisited || !shop.frequency) return false;
  const days = daysSince(shop.lastVisited);
  if (shop.frequency === "weekly") return days >= 7;
  if (shop.frequency === "biweekly") return days >= 14;
  if (shop.frequency === "monthly") return days >= 30;
  return false;
};

const fmtTime = (s) => {
  if (!s) return "0m";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtDist = (m) => {
  if (!m) return "0 km";
  return (m / 1000).toFixed(1) + " km";
};

const DAYS = Array.from({ length: 24 }, (_, i) => i + 1);
const EMPTY_DAY = (day) => ({ day, locations: [], optimizedOrder: null, routeGeometry: null, totalTime: 0, totalDist: 0, updatedAt: null });
const EMPTY_MASTER = () => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i + 1, []]));

const FREQ_LABELS = { weekly: "7d", biweekly: "14d", monthly: "30d" };

// ============================================================
// GEOCODING
// ============================================================
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ", Surat, Gujarat, India")}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (!data.length) throw new Error("Address not found");
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

// ============================================================
// OSRM
// ============================================================
async function getDistanceMatrix(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error("OSRM error");
  return data.durations;
}

async function getRouteGeometry(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== "Ok") return null;
  return {
    coordinates: data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: data.routes[0].distance,
    duration: data.routes[0].duration,
  };
}

// ============================================================
// TSP SOLVER — untouched
// ============================================================
function solveTSP(matrix) {
  const n = matrix.length;
  if (n <= 1) return { order: [0], totalTime: 0 };
  let bestOrder = null, bestTime = Infinity;
  for (let start = 0; start < n; start++) {
    const visited = new Array(n).fill(false);
    const order = [start];
    visited[start] = true;
    let current = start, totalTime = 0;
    for (let i = 1; i < n; i++) {
      let nearest = -1, nearestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && matrix[current][j] < nearestDist) {
          nearestDist = matrix[current][j]; nearest = j;
        }
      }
      if (nearest === -1) break;
      visited[nearest] = true; order.push(nearest);
      totalTime += nearestDist; current = nearest;
    }
    if (totalTime < bestTime) { bestTime = totalTime; bestOrder = [...order]; }
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const [a, b, c, d] = [bestOrder[i - 1], bestOrder[i], bestOrder[j], bestOrder[j + 1]];
        if (matrix[a][c] + matrix[b][d] < matrix[a][b] + matrix[c][d]) {
          bestOrder.splice(i, j - i + 1, ...bestOrder.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  let total = 0;
  for (let i = 0; i < bestOrder.length - 1; i++) total += matrix[bestOrder[i]][bestOrder[i + 1]];
  return { order: bestOrder, totalTime: total };
}

// ============================================================
// MAP COMPONENT — untouched logic, minor marker style refresh
// ============================================================
function MapView({ locations, route, onToggleVisited, isFullscreen }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView([21.17, 72.83], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(leafletMap.current);
    L.control.zoom({ position: "bottomright" }).addTo(leafletMap.current);
  }, []);

  useEffect(() => {
    if (!leafletMap.current) return;
    setTimeout(() => leafletMap.current.invalidateSize(), 300);
  }, [isFullscreen]);

  useEffect(() => {
    if (!leafletMap.current) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    if (polylineRef.current) { polylineRef.current.remove(); polylineRef.current = null; }
    if (!locations.length) return;

    const bounds = [];
    locations.forEach((loc, idx) => {
      const isStart = loc.id === "__home__";
      const isEnd = loc.id === "__office__";
      const color = isStart ? "#10b981" : isEnd ? "#ef4444" : loc.visited ? "#10b981" : "#f97316";
      const border = isStart ? "#059669" : isEnd ? "#b91c1c" : loc.visited ? "#059669" : "#ea580c";
      const num = isStart ? "S" : isEnd ? "E" : loc.optimizedIndex !== undefined ? loc.optimizedIndex + 1 : idx + 1;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:32px;height:32px;background:${color};border:2px solid ${border};border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,0.6);">
          <span style="transform:rotate(45deg);color:#fff;font-weight:900;font-size:11px;font-family:monospace;">${num}</span>
        </div>`,
        iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -36],
      });
      const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(leafletMap.current);
      marker.bindPopup(`
        <div style="font-family:sans-serif;min-width:180px;padding:4px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:2px;">#${num} ${loc.name || "Location"}</div>
          <div style="font-size:11px;color:#666;margin-bottom:10px;">${loc.address || ""}</div>
          <div style="display:flex;gap:6px;">
            <button onclick="window.frpToggle('${loc.id}')" style="flex:1;padding:6px;background:${loc.visited ? "#ef4444" : "#10b981"};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
              ${loc.visited ? "↩ Undo" : "✓ Done"}
            </button>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}" target="_blank"
              style="flex:1;padding:6px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;text-align:center;">
              ↗ Go
            </a>
          </div>
        </div>
      `);
      bounds.push([loc.lat, loc.lng]);
      markersRef.current.push(marker);
    });

    if (route) {
      polylineRef.current = L.polyline(route, { color: "#f97316", weight: 3, opacity: 0.9, dashArray: "8,4" }).addTo(leafletMap.current);
    }
    if (bounds.length) leafletMap.current.fitBounds(bounds, { padding: [50, 50] });
    window.frpToggle = (id) => onToggleVisited(id);
  }, [locations, route]);

  return <div ref={mapRef} style={{ width: "100%", height: "100%", background: "#0f1923" }} />;
}

// ============================================================
// ADD SHOP MODAL — now includes frequency + opening hours
// ============================================================
function AddShopModal({ locationNum, onClose, onAdd, geocoding }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [openTime, setOpenTime] = useState("09:00");
  const [closeTime, setCloseTime] = useState("20:00");

  const handleAdd = () => {
    if (!name.trim() || !url.trim()) return;
    onAdd(name.trim(), url.trim(), frequency, openTime, closeTime);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.8)", display: "flex",
      alignItems: "flex-end", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "#111827",
        borderRadius: "20px 20px 0 0",
        border: "1px solid #1f2937",
        borderBottom: "none",
        padding: "20px 16px 36px",
        width: "100%", maxWidth: 480,
      }} onClick={e => e.stopPropagation()}>

        {/* Handle bar */}
        <div style={{ width: 36, height: 4, background: "#374151", borderRadius: 4, margin: "0 auto 20px" }} />

        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 16, color: "#f97316" }}>
            New Shop
          </div>
          <div style={{ marginLeft: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#4b5563", background: "#1f2937", padding: "2px 8px", borderRadius: 4 }}>
            LOC {locationNum}
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "#4b5563", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <input
          className="field"
          placeholder="Shop name"
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ marginBottom: 10 }}
          autoFocus
        />
        <input
          className="field"
          placeholder="Paste Google Maps link or address"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
          style={{ marginBottom: 14 }}
        />

        {/* Frequency selector */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#6b7280", marginBottom: 6, letterSpacing: 1 }}>VISIT FREQUENCY</div>
          <div style={{ display: "flex", gap: 6 }}>
            {["weekly", "biweekly", "monthly"].map(f => (
              <button key={f} onClick={() => setFrequency(f)} style={{
                flex: 1, padding: "8px 4px",
                background: frequency === f ? "#f97316" : "#1f2937",
                border: frequency === f ? "none" : "1px solid #374151",
                borderRadius: 8, color: frequency === f ? "#0c0f14" : "#6b7280",
                fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
                fontWeight: frequency === f ? 700 : 400, cursor: "pointer",
                transition: "all 0.15s",
              }}>
                {f === "weekly" ? "Weekly" : f === "biweekly" ? "2 Weeks" : "Monthly"}
              </button>
            ))}
          </div>
        </div>

        {/* Opening hours */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#6b7280", marginBottom: 6, letterSpacing: 1 }}>OPENING HOURS</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="time" value={openTime} onChange={e => setOpenTime(e.target.value)}
              className="field" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} />
            <span style={{ color: "#4b5563", fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>to</span>
            <input type="time" value={closeTime} onChange={e => setCloseTime(e.target.value)}
              className="field" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} />
          </div>
        </div>

        <button
          className="btn-primary"
          onClick={handleAdd}
          disabled={geocoding || !name.trim() || !url.trim()}
          style={{ width: "100%" }}
        >
          {geocoding ? "Saving..." : "Add Shop"}
        </button>
      </div>
    </div>
  );
}
// ============================================================
// SHOP LIST (Add Stop Tab)
// ============================================================
function ShopList({ shops, currentDayLocIds, selectedIds, onToggle, onDeleteShop, onRemoveFromDay, onEditShop }) {
  if (!shops.length) {
    return (
      <div style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🏪</div>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "#374151", lineHeight: 1.8 }}>
          No shops yet.<br />Tap <span style={{ color: "#f97316" }}>+ Shop</span> to build your list.
        </div>
      </div>
    );
  }

  // Sort: overdue first, then normal, then already added
  const sorted = [...shops].sort((a, b) => {
    const aAdded = currentDayLocIds.has(a.id);
    const bAdded = currentDayLocIds.has(b.id);
    if (aAdded && !bAdded) return 1;
    if (!aAdded && bAdded) return -1;
    const aOver = isOverdue(a), bOver = isOverdue(b);
    if (aOver && !bOver) return -1;
    if (!aOver && bOver) return 1;
    return 0;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 12px 120px" }}>
      {sorted.map(shop => {
        const added = currentDayLocIds.has(shop.id);
        const selected = selectedIds.has(shop.id);
        const overdue = isOverdue(shop);
        const ds = daysSince(shop.lastVisited);

        return (
          <div
            key={shop.id}
            onClick={() => added ? onRemoveFromDay(shop.id) : onToggle(shop.id)}
            style={{
              background: added ? "#0a1f12" : selected ? "#0f2218" : "#111827",
              border: `1px solid ${added ? "#14532d" : selected ? "#22c55e" : overdue ? "#7c2d12" : "#1f2937"}`,
              borderRadius: 12,
              padding: "12px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              transition: "all 0.12s",
            }}
          >
            {/* Checkbox */}
            <div style={{
              width: 22, height: 22, minWidth: 22,
              borderRadius: 7,
              border: `2px solid ${added || selected ? "#22c55e" : overdue ? "#ea580c" : "#374151"}`,
              background: added || selected ? "#22c55e" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, color: "#000", fontWeight: 900,
              flexShrink: 0, transition: "all 0.12s",
            }}>
              {(added || selected) ? "✓" : ""}
            </div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
                fontSize: 14, color: added ? "#4b5563" : "#f3f4f6",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                textDecoration: added ? "line-through" : "none",
              }}>
                {shop.name}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                {shop.frequency && (
                  <span style={{
                    fontFamily: "'JetBrains Mono',monospace", fontSize: 9,
                    color: overdue ? "#f97316" : "#4b5563",
                    background: overdue ? "#1c1007" : "#1f2937",
                    padding: "1px 6px", borderRadius: 4,
                    border: overdue ? "1px solid #7c2d12" : "none",
                  }}>
                    {overdue ? "⚠ OVERDUE" : FREQ_LABELS[shop.frequency]}
                  </span>
                )}
                {ds !== null && (
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151" }}>
                    {ds === 0 ? "visited today" : `${ds}d ago`}
                  </span>
                )}
                {shop.openTime && (
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151" }}>
                    {shop.openTime}–{shop.closeTime}
                  </span>
                )}
              </div>
            </div>

{/* Edit */}
            <button
              onClick={e => { e.stopPropagation(); onEditShop(shop); }}
              style={{
                background: "#1f2937", border: "none", color: "#60a5fa",
                width: 28, height: 28, borderRadius: 7,
                fontSize: 13, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}
            >✎</button>
            {/* Delete */}
            <button
              onClick={e => { e.stopPropagation(); onDeleteShop(shop.id); }}
              style={{
                background: "#1f2937", border: "none", color: "#374151",
                width: 28, height: 28, borderRadius: 7,
                fontSize: 16, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}
            >×</button>
          </div>
        );
      })}
    </div>
  );
}
// ============================================================
// EDIT SHOP MODAL
// ============================================================
function EditShopModal({ shop, onClose, onSave }) {
  const [name, setName] = useState(shop.name);
  const [frequency, setFrequency] = useState(shop.frequency || "weekly");
  const [openTime, setOpenTime] = useState(shop.openTime || "09:00");
  const [closeTime, setCloseTime] = useState(shop.closeTime || "20:00");

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ ...shop, name: name.trim(), frequency, openTime, closeTime });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.8)", display: "flex",
      alignItems: "flex-end", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "#111827", borderRadius: "20px 20px 0 0",
        border: "1px solid #1f2937", borderBottom: "none",
        padding: "20px 16px 36px", width: "100%", maxWidth: 480,
      }} onClick={e => e.stopPropagation()}>
        <div style={{ width: 36, height: 4, background: "#374151", borderRadius: 4, margin: "0 auto 20px" }} />
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 16, color: "#f97316" }}>
            Edit Shop
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "#4b5563", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>

        <input
          className="field"
          placeholder="Shop name"
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ marginBottom: 14 }}
          autoFocus
        />

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#6b7280", marginBottom: 6, letterSpacing: 1 }}>VISIT FREQUENCY</div>
          <div style={{ display: "flex", gap: 6 }}>
            {["weekly", "biweekly", "monthly"].map(f => (
              <button key={f} onClick={() => setFrequency(f)} style={{
                flex: 1, padding: "8px 4px",
                background: frequency === f ? "#f97316" : "#1f2937",
                border: frequency === f ? "none" : "1px solid #374151",
                borderRadius: 8, color: frequency === f ? "#0c0f14" : "#6b7280",
                fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
                fontWeight: frequency === f ? 700 : 400, cursor: "pointer",
                transition: "all 0.15s",
              }}>
                {f === "weekly" ? "Weekly" : f === "biweekly" ? "2 Weeks" : "Monthly"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#6b7280", marginBottom: 6, letterSpacing: 1 }}>OPENING HOURS</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="time" value={openTime} onChange={e => setOpenTime(e.target.value)}
              className="field" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} />
            <span style={{ color: "#4b5563", fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>to</span>
            <input type="time" value={closeTime} onChange={e => setCloseTime(e.target.value)}
              className="field" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} />
          </div>
        </div>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={!name.trim()}
          style={{ width: "100%" }}
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [activeDay, setActiveDay] = useState(() => {
    const s = localStorage.getItem("frp_active_day");
    return s ? parseInt(s) : 1;
  });
  const [activeWeek, setActiveWeek] = useState(() => {
    const s = localStorage.getItem("frp_active_week");
    return s ? parseInt(s) : 1;
  });
  const [dayData, setDayData] = useState(() => Object.fromEntries(DAYS.map(d => [d, EMPTY_DAY(d)])));
  const [masterShops, setMasterShops] = useState(EMPTY_MASTER());
  const [locationNames, setLocationNames] = useState(() => {
    const s = localStorage.getItem("frp_loc_names");
    return s ? JSON.parse(s) : { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" };
  });
  const [selectedShopIds, setSelectedShopIds] = useState(new Set());
  const [showAddShopModal, setShowAddShopModal] = useState(false);
  const [modalGeocoding, setModalGeocoding] = useState(false);
  const [editingShop, setEditingShop] = useState(null);

  // One-off add
  const [addressInput, setAddressInput] = useState("");
  const [nameInput, setNameInput] = useState("");

  const [status, setStatus] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [activeTab, setActiveTab] = useState("list");
  const [mainTab, setMainTab] = useState("route");

  const [homeAddress, setHomeAddress] = useState(() => localStorage.getItem("frp_home") || "");
  const [officeAddress, setOfficeAddress] = useState(() => localStorage.getItem("frp_office") || "");
  const [homeCoords, setHomeCoords] = useState(() => {
    const s = localStorage.getItem("frp_home_coords");
    return s ? JSON.parse(s) : null;
  });
  const [officeCoords, setOfficeCoords] = useState(() => {
    const s = localStorage.getItem("frp_office_coords");
    return s ? JSON.parse(s) : null;
  });

  // Load on mount
  useEffect(() => {
    Promise.all([loadAllDays(), loadAllMasterLocations()]).then(([rows, masterRows]) => {
      if (rows.length) {
        setDayData(prev => {
          const next = { ...prev };
          rows.forEach(r => { next[r.day] = resetVisitedIfNewDay(r); });
          return next;
        });
        const today = getTodayDate();
        rows.forEach(r => {
          if (!r.lastUsedDate || r.lastUsedDate !== today) {
            saveDay({ ...r, locations: r.locations.map(l => ({ ...l, visited: false })), lastUsedDate: today }).catch(console.error);
          }
        });
      }
      if (masterRows.length) {
        setMasterShops(prev => {
          const next = { ...prev };
          masterRows.forEach(r => { next[r.locationNum] = r.shops || []; });
          return next;
        });
      }
      setDbReady(true);
    }).catch(() => setDbReady(true));
  }, []);

  const currentDay = dayData[activeDay];
  const currentLocationNum = getDayLocation(activeDay);
  const currentMasterShops = masterShops[currentLocationNum] || [];
  const currentDayLocIds = new Set(currentDay.locations.map(l => l.id));

  const sortedMiddle = [...currentDay.locations].sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    if (a.optimizedIndex == null && b.optimizedIndex == null) return 0;
    if (a.optimizedIndex == null) return 1;
    if (b.optimizedIndex == null) return -1;
    return a.optimizedIndex - b.optimizedIndex;
  });

  const sortedLocs = [
    ...(currentDay.startLoc ? [{ ...currentDay.startLoc, optimizedIndex: 0 }] : []),
    ...sortedMiddle,
    ...(currentDay.endLoc ? [{ ...currentDay.endLoc, optimizedIndex: 9999 }] : []),
  ];

  const visited = currentDay.locations.filter(l => l.visited).length;
  const pending = currentDay.locations.length - visited;
  const progress = currentDay.locations.length ? (visited / currentDay.locations.length) * 100 : 0;
  const totalStopsCount = currentDay.locations.length + (currentDay.startLoc ? 1 : 0) + (currentDay.endLoc ? 1 : 0);
  const overdueCount = currentMasterShops.filter(s => isOverdue(s) && !currentDayLocIds.has(s.id)).length;
  const selectedNotAdded = [...selectedShopIds].filter(id => !currentDayLocIds.has(id)).length;

  useEffect(() => {
  localStorage.setItem("frp_active_day", activeDay);
  localStorage.setItem("frp_active_week", activeWeek);
  setSelectedShopIds(new Set());
}, [activeDay, activeWeek]);
  const updateCurrentDay = useCallback((updater) => {
    setDayData(prev => {
      const updated = { ...prev, [activeDay]: updater(prev[activeDay]) };
      saveDay({ ...updated[activeDay], updatedAt: new Date().toISOString(), lastUsedDate: getTodayDate() })
        .catch(e => console.error("✗ Save failed", e));
      return updated;
    });
  }, [activeDay]);

  const updateLocationName = (num, name) => {
    setLocationNames(prev => {
      const next = { ...prev, [num]: name };
      localStorage.setItem("frp_loc_names", JSON.stringify(next));
      return next;
    });
  };

  const updateMasterShops = useCallback((locationNum, updater) => {
    setMasterShops(prev => {
      const newShops = updater(prev[locationNum] || []);
      const next = { ...prev, [locationNum]: newShops };
      saveMasterLocation(locationNum, newShops).catch(console.error);
      return next;
    });
  }, []);

  // Add shop to master list — now includes frequency + hours
  const handleAddShopToMaster = async (name, urlOrAddress, frequency, openTime, closeTime) => {
    setModalGeocoding(true);
    try {
      const gmatch =
        urlOrAddress.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
        urlOrAddress.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
        urlOrAddress.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
      let lat, lng, address;
      if (gmatch) {
        lat = parseFloat(gmatch[1]); lng = parseFloat(gmatch[2]);
        address = urlOrAddress;
      } else {
        const geo = await geocodeAddress(urlOrAddress);
        lat = geo.lat; lng = geo.lng; address = urlOrAddress;
      }
      const shop = { id: crypto.randomUUID(), name, address, lat, lng, frequency, openTime, closeTime, lastVisited: null, visitNote: "" };
      updateMasterShops(currentLocationNum, shops => [...shops, shop]);
      setStatus(`✓ "${name}" added`);
      setShowAddShopModal(false);
    } catch (e) {
      setStatus(`✗ ${e.message}`);
    } finally {
      setModalGeocoding(false);
    }
  };

  const handleDeleteShopFromMaster = (shopId) => {
    updateMasterShops(currentLocationNum, shops => shops.filter(s => s.id !== shopId));
    setSelectedShopIds(prev => { const n = new Set(prev); n.delete(shopId); return n; });
  };

  const toggleShopSelection = (shopId) => {
    setSelectedShopIds(prev => {
      const n = new Set(prev);
      n.has(shopId) ? n.delete(shopId) : n.add(shopId);
      return n;
    });
  };

  const addSelectedToDay = () => {
    const toAdd = currentMasterShops
      .filter(s => selectedShopIds.has(s.id) && !currentDayLocIds.has(s.id))
      .map(s => ({ ...s, visited: false, optimizedIndex: undefined }));
    if (!toAdd.length) return;
    updateCurrentDay(d => ({
      ...d,
      locations: [...d.locations, ...toAdd],
      optimizedOrder: null,
      routeGeometry: null,
    }));
    setSelectedShopIds(new Set());
    setStatus(`✓ ${toAdd.length} shop${toAdd.length > 1 ? "s" : ""} added`);
    setActiveTab("list");
  };

  // Plan my day — auto-selects overdue shops and adds them
  const planMyDay = () => {
    const overdue = currentMasterShops.filter(s => isOverdue(s) && !currentDayLocIds.has(s.id));
    if (!overdue.length) { setStatus("No overdue shops for today"); return; }
    const toAdd = overdue.map(s => ({ ...s, visited: false, optimizedIndex: undefined }));
    updateCurrentDay(d => ({
      ...d,
      locations: [...d.locations, ...toAdd],
      optimizedOrder: null,
      routeGeometry: null,
    }));
    setStatus(`✓ ${toAdd.length} overdue shop${toAdd.length > 1 ? "s" : ""} added`);
    setActiveTab("list");
  };

const toggleVisited = (id) => {
    const today = getTodayDate();
    const loc = currentDay.locations.find(l => l.id === id);
    updateCurrentDay(d => ({
      ...d,
      locations: d.locations.map(l => l.id === id ? { ...l, visited: !l.visited } : l),
    }));
    if (loc && !loc.visited) {
      const isMaster = currentMasterShops.some(s => s.id === id);
      if (isMaster) {
        updateMasterShops(currentLocationNum, shops =>
          shops.map(s => s.id === id ? { ...s, lastVisited: today } : s)
        );
      }
    }
  };
  const removeLocation = (id) => {
    updateCurrentDay(d => ({ ...d, locations: d.locations.filter(l => l.id !== id), optimizedOrder: null, routeGeometry: null, totalTime: 0, totalDist: 0 }));
  };

  const togglePriority = (id) => {
    updateCurrentDay(d => ({
      ...d,
      locations: d.locations.map(l => l.id === id ? { ...l, priority: !l.priority } : l),
      optimizedOrder: null, routeGeometry: null,
    }));
  };

  const clearDay = () => {
    if (!confirm("Clear all stops for today?")) return;
    updateCurrentDay(() => EMPTY_DAY(activeDay));
    setStatus("Cleared");
  };

  // One-off add
  const addLocation = async () => {
    const addr = addressInput.trim();
    if (!addr) return;
    const googleMatch =
      addr.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
      addr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      addr.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (googleMatch) {
      const loc = { id: crypto.randomUUID(), address: addr, name: nameInput.trim() || "Stop", lat: parseFloat(googleMatch[1]), lng: parseFloat(googleMatch[2]), visited: false, optimizedIndex: undefined };
      updateCurrentDay(d => ({ ...d, locations: [...d.locations, loc], optimizedOrder: null, routeGeometry: null }));
      setAddressInput(""); setNameInput(""); setStatus("✓ Stop added"); setActiveTab("list");
      return;
    }
    setGeocoding(true); setStatus("Finding location...");
    try {
      const geo = await geocodeAddress(addr);
      const loc = { id: crypto.randomUUID(), address: addr, name: nameInput.trim() || addr.split(",")[0], lat: geo.lat, lng: geo.lng, visited: false, optimizedIndex: undefined };
      updateCurrentDay(d => ({ ...d, locations: [...d.locations, loc], optimizedOrder: null, routeGeometry: null }));
      setAddressInput(""); setNameInput(""); setStatus(`✓ ${loc.name} added`); setActiveTab("list");
    } catch (e) { setStatus(`✗ ${e.message}`); }
    finally { setGeocoding(false); }
  };

  const saveHomeOffice = async (type, address) => {
    setStatus(`Saving...`);
    try {
      const gm =
        address.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
        address.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
        address.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
      let geo;
      if (gm) {
        const lat = parseFloat(gm[1]), lng = parseFloat(gm[2]);
        if (isNaN(lat) || isNaN(lng)) throw new Error("Invalid coordinates");
        geo = { lat, lng };
      } else {
        geo = await geocodeAddress(address);
      }
      const coords = { lat: geo.lat, lng: geo.lng };
      if (type === "home") {
        setHomeCoords(coords);
        localStorage.setItem("frp_home", address);
        localStorage.setItem("frp_home_coords", JSON.stringify(coords));
        setStatus("✓ Start saved");
      } else {
        setOfficeCoords(coords);
        localStorage.setItem("frp_office", address);
        localStorage.setItem("frp_office_coords", JSON.stringify(coords));
        setStatus("✓ End saved");
      }
    } catch (e) { setStatus(`✗ ${e.message}`); }
  };

  // Optimize route — untouched logic
  const optimizeRoute = async () => {
    const priorityLocs = currentDay.locations.filter(l => l.priority);
    const normalLocs = currentDay.locations.filter(l => !l.priority);
    const middleLocs = [...priorityLocs, ...normalLocs];
    if (middleLocs.length < 1) { setStatus("Add at least 1 stop first"); return; }
    const startLoc = homeCoords ? { id: "__home__", name: "Start", address: homeAddress, lat: homeCoords.lat, lng: homeCoords.lng, visited: false, optimizedIndex: undefined } : null;
    const endLoc = officeCoords ? { id: "__office__", name: "End", address: officeAddress, lat: officeCoords.lat, lng: officeCoords.lng, visited: false, optimizedIndex: undefined } : null;
    const locs = [...(startLoc ? [startLoc] : []), ...middleLocs, ...(endLoc ? [endLoc] : [])];
    setOptimizing(true); setStatus("Building matrix...");
    try {
      const matrix = await getDistanceMatrix(locs);
      setStatus("Solving route...");
      let order, totalTime;
      if (startLoc && endLoc && middleLocs.length >= 1) {
        const n = middleLocs.length;
        const officeIdx = n + 1;
        const np = priorityLocs.length;
        const subMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => matrix[i + 1][j + 1]));
        let bestMiddle = Array.from({ length: n }, (_, i) => i);
        let bestCost = Infinity;
        const startCandidates = np > 0 ? Array.from({ length: np }, (_, i) => i) : Array.from({ length: n }, (_, i) => i);
        for (let s of startCandidates) {
          const vis = new Array(n).fill(false);
          const ord = [s]; vis[s] = true; let cur = s, t = 0;
          for (let i = 1; i < n; i++) {
            let near = -1, nearD = Infinity;
            const stillInPriority = ord.length < np;
            for (let j = 0; j < n; j++) {
              if (vis[j]) continue;
              if (stillInPriority && j >= np) continue;
              if (subMatrix[cur][j] < nearD) { nearD = subMatrix[cur][j]; near = j; }
            }
            if (near === -1) {
              for (let j = 0; j < n; j++) {
                if (!vis[j] && subMatrix[cur][j] < nearD) { nearD = subMatrix[cur][j]; near = j; }
              }
            }
            if (near === -1) break;
            vis[near] = true; ord.push(near); t += nearD; cur = near;
          }
          const homeCost = matrix[0][ord[0] + 1];
          const officeCost = matrix[ord[ord.length - 1] + 1][officeIdx];
          const totalCost = homeCost + t + officeCost;
          if (totalCost < bestCost) { bestCost = totalCost; bestMiddle = [...ord]; }
        }
        order = [0, ...bestMiddle.map(i => i + 1), officeIdx];
        totalTime = bestCost;
      } else if (startLoc && !endLoc && middleLocs.length >= 1) {
        const n = middleLocs.length;
        let bestMiddle = Array.from({ length: n }, (_, i) => i);
        let bestCost = Infinity;
        for (let s = 0; s < n; s++) {
          const vis = new Array(n).fill(false);
          const ord = [s]; vis[s] = true; let cur = s, t = 0;
          for (let i = 1; i < n; i++) {
            let near = -1, nearD = Infinity;
            for (let j = 0; j < n; j++) {
              if (!vis[j] && matrix[cur + 1][j + 1] < nearD) { nearD = matrix[cur + 1][j + 1]; near = j; }
            }
            if (near === -1) break;
            vis[near] = true; ord.push(near); t += nearD; cur = near;
          }
          const totalCost = matrix[0][ord[0] + 1] + t;
          if (totalCost < bestCost) { bestCost = totalCost; bestMiddle = [...ord]; }
        }
        order = [0, ...bestMiddle.map(i => i + 1)];
        totalTime = bestCost;
      } else {
        ({ order, totalTime } = solveTSP(matrix));
      }
      const orderedLocs = order.map((idx, pos) => ({ ...locs[idx], optimizedIndex: pos }));
      const indexMap = Object.fromEntries(orderedLocs.map(l => [l.id, l.optimizedIndex]));
      setStatus("Fetching path...");
      const routeData = await getRouteGeometry(orderedLocs);
      updateCurrentDay(d => ({
        ...d,
        locations: d.locations.map(l => indexMap[l.id] !== undefined ? { ...l, optimizedIndex: indexMap[l.id] } : l),
        optimizedOrder: order,
        routeGeometry: routeData?.coordinates || null,
        totalTime,
        totalDist: routeData?.distance || 0,
        startLoc: startLoc || null,
        endLoc: endLoc || null,
      }));
      setStatus(`✓ ${fmtDist(routeData?.distance)} · ${fmtTime(routeData?.duration)} · ${locs.length} stops`);
    } catch (e) { setStatus(`✗ ${e.message}`); }
    finally { setOptimizing(false); }
  };

  const visibleDays = DAYS.filter(d => {
    if (activeWeek === 1) return d <= 6;
    if (activeWeek === 2) return d > 6 && d <= 12;
    if (activeWeek === 3) return d > 12 && d <= 18;
    return d > 18;
  });

  const locName = locationNames[currentLocationNum] || `Loc ${currentLocationNum}`;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; overflow: hidden; overscroll-behavior: none; -webkit-overflow-scrolling: touch; }
        #root { position: fixed; inset: 0; display: flex; flex-direction: column; background: #080d14; }
        body { font-family: 'Space Grotesk', sans-serif; color: #f3f4f6; }

        /* ── HEADER ── */
        .header {
          background: #080d14;
          border-bottom: 1px solid #111827;
          flex-shrink: 0;
          padding: 10px 14px 0;
        }
        .header-top {
          display: flex; align-items: center; gap: 6px; margin-bottom: 10px;
        }
        .logo {
          font-family: 'Space Grotesk', sans-serif;
          font-size: 16px; font-weight: 700;
          color: #f97316; letter-spacing: -0.3px;
          margin-right: auto;
        }
        .logo span { color: #9ca3af; font-weight: 500; }
        .week-btn {
          padding: 4px 10px;
          border: 1px solid #1f2937;
          background: transparent; color: #4b5563;
          border-radius: 6px; font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          cursor: pointer; transition: all 0.15s;
        }
        .week-btn.active {
          background: #f97316; color: #080d14;
          border-color: #f97316; font-weight: 700;
        }
        .ready-dot {
          font-size: 9px; font-family: 'JetBrains Mono', monospace;
          color: #1f2937; white-space: nowrap;
        }
        .ready-dot.on { color: #10b981; }

        /* Day tabs */
        .day-tabs { display: flex; overflow-x: auto; scrollbar-width: none; }
        .day-tabs::-webkit-scrollbar { display: none; }
        .day-tab {
          padding: 7px 16px; background: transparent; border: none;
          color: #4b5563; font-family: 'JetBrains Mono', monospace;
          font-size: 11px; cursor: pointer;
          border-bottom: 2px solid transparent;
          white-space: nowrap; transition: all 0.15s; flex-shrink: 0;
        }
        .day-tab.active { color: #f97316; border-bottom-color: #f97316; }
        .day-tab .ct {
          display: inline-block; margin-left: 4px;
          background: #111827; color: #4b5563;
          border-radius: 10px; padding: 0 5px; font-size: 9px;
        }
        .day-tab.active .ct { background: #1c1007; color: #f97316; }

        /* Status bar */
        .status-bar {
          background: #050810; border-bottom: 1px solid #0f1623;
          padding: 5px 14px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: #374151;
          flex-shrink: 0; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
          min-height: 26px; display: flex; align-items: center; gap: 6px;
        }
        .spinner {
          width: 10px; height: 10px; flex-shrink: 0;
          border: 2px solid #f97316; border-top-color: transparent;
          border-radius: 50%; animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Map */
        .map-wrapper {
          height: 34vh; min-height: 150px; flex-shrink: 0;
          position: relative; background: #0f1923;
        }
        .map-wrapper.fullscreen {
          position: fixed; inset: 0; height: 100% !important; z-index: 9999;
        }
        .map-btn {
          position: absolute; top: 10px; right: 10px; z-index: 1000;
          background: rgba(8,13,20,0.92); border: 1px solid #1f2937;
          color: #9ca3af; border-radius: 8px; padding: 6px 12px;
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          cursor: pointer; font-weight: 500;
        }

        /* Bottom panel */
        .bottom-panel {
          flex: 1; display: flex; flex-direction: column;
          min-height: 0; background: #080d14; overflow: hidden;
        }

        /* Stats */
        .stats-bar {
          display: flex; flex-shrink: 0;
          border-bottom: 1px solid #111827;
        }
        .stat-cell {
          flex: 1; padding: 8px 4px; text-align: center;
          background: #050810;
        }
        .stat-cell + .stat-cell { border-left: 1px solid #111827; }
        .stat-v {
          font-family: 'JetBrains Mono', monospace;
          font-size: 20px; font-weight: 700;
          color: #f97316; line-height: 1;
        }
        .stat-l {
          font-size: 8px; color: #374151; margin-top: 2px;
          text-transform: uppercase; letter-spacing: 1.5px;
          font-family: 'JetBrains Mono', monospace;
        }

        /* Progress */
        .progress-wrap { height: 2px; background: #111827; flex-shrink: 0; }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #10b981, #059669);
          transition: width 0.6s ease;
        }

        /* Action bar */
        .action-bar {
          display: flex; gap: 8px; padding: 10px 12px;
          flex-shrink: 0; border-bottom: 1px solid #111827;
        }
        .btn-primary {
          flex: 1; padding: 12px;
          background: #f97316;
          color: #080d14; border: none; border-radius: 10px;
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 700; font-size: 13px;
          cursor: pointer; transition: all 0.15s;
          letter-spacing: 0.2px;
        }
        .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
        .btn-secondary {
          padding: 12px 14px;
          background: #111827; color: #9ca3af;
          border: 1px solid #1f2937; border-radius: 10px;
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600; font-size: 12px;
          cursor: pointer; white-space: nowrap;
          transition: all 0.15s;
        }
        .btn-danger {
          padding: 12px 13px;
          background: transparent; color: #ef4444;
          border: 1px solid #1f2937; border-radius: 10px;
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600; font-size: 13px; cursor: pointer;
        }

        /* Panel tabs */
        .panel-tabs {
          display: flex; border-bottom: 1px solid #111827; flex-shrink: 0;
        }
        .panel-tab {
          flex: 1; padding: 10px; border: none;
          background: transparent; color: #4b5563;
          font-family: 'Space Grotesk', sans-serif;
          font-size: 12px; font-weight: 600;
          cursor: pointer; border-bottom: 2px solid transparent;
          transition: all 0.15s;
        }
        .panel-tab.active {
          color: #f97316; border-bottom-color: #f97316;
          background: #050810;
        }

        /* Scroll area */
        .scroll-area {
          flex: 1; overflow-y: auto;
          -webkit-overflow-scrolling: touch; min-height: 0;
        }
        ::-webkit-scrollbar { width: 2px; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 2px; }

        /* Stop list */
        .loc-list { padding: 8px 12px; }
        .loc-item {
          background: #0d1421; border: 1px solid #131e2e;
          border-radius: 12px; padding: 11px 13px;
          margin-bottom: 6px; display: flex; gap: 10px;
          align-items: center; transition: all 0.12s;
        }
        .loc-item.visited { background: #081510; border-color: #0f2d1a; }
        .loc-num {
          width: 30px; height: 30px; min-width: 30px;
          border-radius: 50%; background: #f97316;
          color: #080d14; font-family: 'JetBrains Mono', monospace;
          font-weight: 700; font-size: 11px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .loc-item.visited .loc-num { background: #10b981; }
        .loc-info { flex: 1; min-width: 0; }
        .loc-name {
          font-size: 13px; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .loc-item.visited .loc-name { color: #374151; text-decoration: line-through; }
        .loc-addr {
          font-size: 10px; color: #374151;
          font-family: 'JetBrains Mono', monospace;
          white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; margin-top: 2px;
        }
        .loc-note {
          font-size: 10px; color: #6b7280;
          font-family: 'JetBrains Mono', monospace;
          margin-top: 2px; font-style: italic;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .loc-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .icon-btn {
          width: 30px; height: 30px; background: #111827;
          border: none; border-radius: 8px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          color: #4b5563; font-size: 13px; transition: all 0.12s;
        }
        .icon-btn.done { background: #0a2218; color: #10b981; }
        .icon-btn.priority { background: #1c1007; color: #f97316; }
        .icon-btn.nav-btn { background: #0f1e3a; color: #60a5fa; text-decoration: none; }
        .icon-btn.del { background: #1a0d0d; color: #f87171; }

        /* Empty state */
        .empty {
          padding: 48px 24px; text-align: center; color: #1f2937;
        }
        .empty-icon { font-size: 40px; margin-bottom: 12px; }
        .empty-text {
          font-size: 13px; line-height: 1.8;
          font-family: 'JetBrains Mono', monospace;
          color: #374151;
        }

        /* Forms */
        .add-form {
          padding: 14px; display: flex; flex-direction: column; gap: 10px;
        }
        .field {
          background: #0d1421; border: 1px solid #1f2937;
          color: #f3f4f6; padding: 11px 13px; border-radius: 10px;
          font-size: 13px; font-family: 'JetBrains Mono', monospace;
          outline: none; transition: border-color 0.15s; width: 100%;
        }
        .field:focus { border-color: #f97316; }
        .field::placeholder { color: #1f2937; }
        textarea.field { resize: none; }

        /* Add Stop tab header */
        .add-stop-header {
          display: flex; align-items: center; padding: 10px 12px;
          border-bottom: 1px solid #111827; flex-shrink: 0; gap: 8px;
        }
        .btn-add-shop {
          background: #111827; border: 1px solid #1f2937;
          color: #9ca3af; border-radius: 8px; padding: 7px 12px;
          font-family: 'Space Grotesk', sans-serif; font-size: 12px;
          font-weight: 600; cursor: pointer; white-space: nowrap;
          display: flex; align-items: center; gap: 4px;
          transition: all 0.15s; flex-shrink: 0;
        }
        .btn-add-shop:active { border-color: #f97316; color: #f97316; }

        /* Plan my day banner */
        .plan-banner {
          margin: 8px 12px 0;
          background: #1c1007; border: 1px solid #7c2d12;
          border-radius: 10px; padding: 10px 14px;
          display: flex; align-items: center; gap: 10px;
          cursor: pointer; transition: all 0.15s;
        }
        .plan-banner-text {
          flex: 1; font-family: 'Space Grotesk', sans-serif;
          font-size: 12px; font-weight: 600; color: #f97316;
        }
        .plan-banner-sub {
          font-size: 10px; color: #92400e;
          font-family: 'JetBrains Mono', monospace; margin-top: 1px;
        }

        /* One-off add */
        .oneoff-toggle {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 14px; border-top: 1px solid #111827;
          cursor: pointer; flex-shrink: 0;
        }
        .oneoff-toggle-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: #374151; flex: 1;
        }
        .oneoff-form {
          padding: 10px 14px 14px; border-top: 1px solid #111827;
          display: flex; flex-direction: column; gap: 8px;
        }

        /* Bottom nav */
        .bottom-nav {
          display: flex; flex-shrink: 0;
          border-top: 1px solid #111827; background: #080d14;
        }
        .nav-btn {
          flex: 1; padding: 13px 0; border: none;
          background: transparent; cursor: pointer;
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 600; font-size: 12px;
          transition: all 0.15s; letter-spacing: 0.3px;
          border-top: 2px solid transparent;
        }
        .nav-btn.active {
          background: #050810; color: #f97316;
          border-top-color: #f97316;
        }
        .nav-btn:not(.active) { color: #374151; }

        /* Settings */
        .settings-section {
          padding: 14px; display: flex; flex-direction: column; gap: 10px;
        }
        .settings-label {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          color: #374151; letter-spacing: 1.5px;
          text-transform: uppercase; margin-bottom: 2px;
        }
        .settings-saved {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          color: #10b981;
        }

        .leaflet-container { width: 100% !important; height: 100% !important; }
        .leaflet-control-zoom { margin-bottom: 16px !important; margin-right: 16px !important; }
      `}</style>

    
      {/* EDIT SHOP MODAL */}
      {editingShop && (
        <EditShopModal
          shop={editingShop}
          onClose={() => setEditingShop(null)}
          onSave={(updated) => {
            updateMasterShops(currentLocationNum, shops =>
              shops.map(s => s.id === updated.id ? updated : s)
            );
            setEditingShop(null);
            setStatus(`✓ "${updated.name}" updated`);
          }}
        />
      )}

      {/* ADD SHOP MODAL */}
      {mainTab === "route" && showAddShopModal && (
        <AddShopModal
          locationNum={currentLocationNum}
          onClose={() => setShowAddShopModal(false)}
          onAdd={handleAddShopToMaster}
          geocoding={modalGeocoding}
        />
      )}

      {/* ORDER TAB */}
      {mainTab === "order" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <OrderTab masterShops={masterShops} locationNames={locationNames} currentLocationNum={currentLocationNum} />
        </div>
      )}

      {/* ROUTE TAB */}
      {mainTab === "route" && (
        <>
          {/* Header */}
          <div className="header">
            <div className="header-top">
              <div className="logo">Field<span>Route</span></div>
              {[1,2,3,4].map(w => (
                <button key={w} className={`week-btn ${activeWeek === w ? "active" : ""}`}
                  onClick={() => { setActiveWeek(w); setActiveDay((w-1)*6+1); }}>
                  W{w}
                </button>
              ))}
              <div className={`ready-dot ${dbReady ? "on" : ""}`}>●</div>
            </div>
            <div className="day-tabs">
              {visibleDays.map(d => (
                <button key={d} className={`day-tab ${activeDay === d ? "active" : ""}`} onClick={() => setActiveDay(d)}>
                  D{activeWeek === 1 ? d : activeWeek === 2 ? d - 6 : activeWeek === 3 ? d - 12 : d - 18}
                  <span className="ct">{dayData[d].locations.length}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Status bar */}
          <div className="status-bar">
            {(optimizing || geocoding || modalGeocoding) && <div className="spinner" />}
            <span>{status || `${locName} · ${currentMasterShops.length} shops${overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}`}</span>
          </div>

          {/* Map */}
          <div className={`map-wrapper ${mapFullscreen ? "fullscreen" : ""}`}>
            <MapView locations={sortedLocs} route={currentDay.routeGeometry} onToggleVisited={toggleVisited} isFullscreen={mapFullscreen} />
            <button className="map-btn" onClick={() => setMapFullscreen(v => !v)}>
              {mapFullscreen ? "✕ Close" : "⤢ Expand"}
            </button>
          </div>

          {!mapFullscreen && (
            <div className="bottom-panel">
              {/* Stats */}
              <div className="stats-bar">
                <div className="stat-cell">
                  <div className="stat-v">{totalStopsCount}</div>
                  <div className="stat-l">Stops</div>
                </div>
                <div className="stat-cell">
                  <div className="stat-v" style={{ color: "#10b981" }}>{visited}</div>
                  <div className="stat-l">Done</div>
                </div>
                <div className="stat-cell">
                  <div className="stat-v" style={{ color: pending > 0 ? "#f97316" : "#10b981" }}>{pending}</div>
                  <div className="stat-l">Left</div>
                </div>
                {currentDay.totalDist > 0 && (
                  <div className="stat-cell">
                    <div className="stat-v" style={{ color: "#818cf8", fontSize: 14 }}>{fmtDist(currentDay.totalDist)}</div>
                    <div className="stat-l">{fmtTime(currentDay.totalTime)}</div>
                  </div>
                )}
              </div>

              <div className="progress-wrap">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>

              {/* Action bar — removed Next button */}
              <div className="action-bar">
                <button className="btn-primary" onClick={optimizeRoute} disabled={optimizing || currentDay.locations.length < 1}>
                  {optimizing ? "Optimizing..." : "⚡ Optimize"}
                </button>
                <button className="btn-danger" onClick={clearDay}>✕</button>
              </div>

              {/* Panel tabs */}
              <div className="panel-tabs">
                <button className={`panel-tab ${activeTab === "list" ? "active" : ""}`} onClick={() => setActiveTab("list")}>
                  Stops{currentDay.locations.length > 0 ? ` (${currentDay.locations.length})` : ""}
                </button>
                <button className={`panel-tab ${activeTab === "add" ? "active" : ""}`} onClick={() => { setActiveTab("add"); setSelectedShopIds(new Set()); }}>
                  + Add
                </button>
                <button className={`panel-tab ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}>
                  Settings
                </button>
              </div>

              <div className="scroll-area">

                {/* ── STOPS TAB ── */}
                {activeTab === "list" && (
                  <div className="loc-list">
                    {sortedLocs.length === 0 ? (
                      <div className="empty">
                        <div className="empty-icon">🗺️</div>
                        <div className="empty-text">No stops yet.<br />Go to Add to pick shops.</div>
                      </div>
                    ) : sortedLocs.map((loc, idx) => {
                      const isFixed = loc.id === "__home__" || loc.id === "__office__";
                      // Find visit note from master
                      const masterShop = currentMasterShops.find(s => s.id === loc.id);
                      return (
                        <div key={loc.id} className={`loc-item ${loc.visited ? "visited" : ""}`}
                          style={isFixed ? { borderColor: "#0f1e3a", background: "#080e1c" } : {}}>
                          <div className="loc-num"
                            style={isFixed ? { background: "#3b82f6", fontSize: 9 } : loc.priority ? { background: "#ea580c" } : {}}>
                            {loc.id === "__home__" ? "S" : loc.id === "__office__" ? "E" : idx + 1}
                          </div>
                          <div className="loc-info">
                            <div className="loc-name">{loc.name}</div>
                            {masterShop?.visitNote && loc.visited && (
                              <div className="loc-note">"{masterShop.visitNote}"</div>
                            )}
                            {!loc.visited && masterShop?.lastVisited && (
                              <div className="loc-addr">{daysSince(masterShop.lastVisited)}d since last visit</div>
                            )}
                          </div>
                          <div className="loc-actions">
                            {!isFixed && (
                              <>
                                <button className={`icon-btn ${loc.priority ? "priority" : ""}`} onClick={() => togglePriority(loc.id)}>★</button>
                                <button className={`icon-btn ${loc.visited ? "done" : ""}`} onClick={() => toggleVisited(loc.id)}>{loc.visited ? "✓" : "○"}</button>
                                <a href={`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`} target="_blank" rel="noopener noreferrer" className="icon-btn nav-btn">↗</a>
                                <button className="icon-btn del" onClick={() => removeLocation(loc.id)}>×</button>
                              </>
                            )}
                            {isFixed && (
                              <a href={`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`} target="_blank" rel="noopener noreferrer" className="icon-btn nav-btn">↗</a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ── ADD STOP TAB ── */}
                {activeTab === "add" && (
                  <div style={{ display: "flex", flexDirection: "column" }}>

                    {/* Header */}
                    <div className="add-stop-header">
                      <input
                        className="field"
                        placeholder={`Name this location`}
                        value={locationNames[currentLocationNum] || ""}
                        onChange={e => updateLocationName(currentLocationNum, e.target.value)}
                        style={{ flex: 1, padding: "7px 11px", fontSize: 12 }}
                      />
                      {selectedNotAdded > 0 && (
                        <button
                          onClick={addSelectedToDay}
                          style={{
                            background: "#10b981", border: "none", color: "#080d14",
                            borderRadius: 8, padding: "7px 12px", cursor: "pointer",
                            fontFamily: "'Space Grotesk',sans-serif", fontSize: 12,
                            fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0,
                          }}
                        >
                          + {selectedNotAdded}
                        </button>
                      )}
                      <button className="btn-add-shop" onClick={() => setShowAddShopModal(true)}>
                        + Shop
                      </button>
                    </div>

                    {/* Shop list */}
                    <ShopList
                      shops={currentMasterShops}
                      currentDayLocIds={currentDayLocIds}
                      selectedIds={selectedShopIds}
                      onToggle={toggleShopSelection}
                      onDeleteShop={handleDeleteShopFromMaster}
                      onRemoveFromDay={removeLocation}
                      onEditShop={(shop) => setEditingShop(shop)}
                    />

                    {/* One-off add */}
                    <OneOffAdd
                      nameInput={nameInput}
                      addressInput={addressInput}
                      setNameInput={setNameInput}
                      setAddressInput={setAddressInput}
                      geocoding={geocoding}
                      onAdd={addLocation}
                    />
                  </div>
                )}

              {/* ── SETTINGS TAB ── */}
                {activeTab === "settings" && (
                  <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 20 }}>

{/* Route points */}
                    <RoutePointsEditor
                      homeAddress={homeAddress} setHomeAddress={setHomeAddress}
                      homeCoords={homeCoords}
                      officeAddress={officeAddress} setOfficeAddress={setOfficeAddress}
                      officeCoords={officeCoords}
                      onSave={saveHomeOffice}
                    />

                    {/* Shop data */}
                    <div style={{ background: "#0d1421", border: "1px solid #1f2937", borderRadius: 14, padding: "14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#374151", letterSpacing: 1.5 }}>SHOP DATA</div>
                      <button className="btn-primary" onClick={() => exportShops(masterShops)}>
                        ⬇ Export All Shops
                      </button>
                      <label style={{
                        display: "block", padding: "12px", background: "#111827",
                        border: "1px solid #1f2937",
                        borderRadius: 10, color: "#9ca3af",
                        fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600,
                        fontSize: 13, cursor: "pointer", textAlign: "center",
                      }}>
                        ⬆ Import Shops
                        <input type="file" accept=".json" style={{ display: "none" }}
                          onChange={e => {
                            const file = e.target.files[0];
                            if (file) importShops(file, setMasterShops, setStatus);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <button
                        onClick={() => {
                          if (!confirm("Clear all shops and stops? This cannot be undone.")) return;
                          const empty = EMPTY_MASTER();
                          setMasterShops(empty);
                          [1,2,3,4,5,6].forEach(n => saveMasterLocation(n, []).catch(console.error));
                          const clearedDays = Object.fromEntries(DAYS.map(d => [d, EMPTY_DAY(d)]));
                          setDayData(clearedDays);
                          DAYS.forEach(d => saveDay(EMPTY_DAY(d)).catch(console.error));
                          setStatus("✓ All shops and stops cleared");
                        }}
                        style={{
                          padding: "12px", background: "transparent",
                          border: "1px solid #7f1d1d", borderRadius: 10,
                          color: "#ef4444", fontFamily: "'Space Grotesk',sans-serif",
                          fontWeight: 600, fontSize: 13, cursor: "pointer",
                        }}
                      >
                        🗑 Clear All Shops
                      </button>
                      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#374151", textAlign: "center" }}>
                        Import replaces existing shops per location
                      </div>
                    </div>

                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* BOTTOM NAV */}
      <div className="bottom-nav">
        <button className={`nav-btn ${mainTab === "route" ? "active" : ""}`} onClick={() => setMainTab("route")}>
          🗺 Route
        </button>
        <button className={`nav-btn ${mainTab === "order" ? "active" : ""}`} onClick={() => setMainTab("order")}>
          📦 Orders
        </button>
      </div>
    </>
  );
}

// ============================================================
// ORDER TAB — tap to log, order history, shop profile
// ============================================================
function OrderTab({ masterShops, locationNames, currentLocationNum }) {
  // orders stored as { shopId: [{ amount, date, note }] }
  const [orders, setOrders] = useState(() => {
    const s = localStorage.getItem("frp_orders_v2");
    return s ? JSON.parse(s) : {};
  });
  const [activeLocTab, setActiveLocTab] = useState(currentLocationNum || 1);
  const [activeShop, setActiveShop] = useState(null); // shop object for drawer
  const [drawerAmount, setDrawerAmount] = useState("");
  const [drawerNote, setDrawerNote] = useState("");
  const [drawerOwner, setDrawerOwner] = useState("");
  const [drawerPhone, setDrawerPhone] = useState("");

  // Sync location tab when currentLocationNum changes (user switches day in Route)
  useEffect(() => {
    if (currentLocationNum) setActiveLocTab(currentLocationNum);
  }, [currentLocationNum]);

  const shops = masterShops[activeLocTab] || [];

  const getHistory = (shopId) => orders[shopId] || [];
  const getTotal = (shopId) => getHistory(shopId).reduce((sum, e) => sum + Number(e.amount), 0);

  const saveOrders = (next) => {
    setOrders(next);
    localStorage.setItem("frp_orders_v2", JSON.stringify(next));
  };

  const addEntry = () => {
    if (!drawerAmount || isNaN(drawerAmount) || !activeShop) return;
    const entry = {
      amount: Number(drawerAmount),
      date: getTodayDate(),
      note: drawerNote.trim(),
    };
    const prev = orders[activeShop.id] || [];
    saveOrders({ ...orders, [activeShop.id]: [entry, ...prev] });
    setDrawerAmount("");
    setDrawerNote("");
  };

  // Save contact details per shop in localStorage
  const contactKey = (shopId) => `frp_contact_${shopId}`;
  const loadContact = (shopId) => {
    const s = localStorage.getItem(contactKey(shopId));
    return s ? JSON.parse(s) : { owner: "", phone: "" };
  };
  const saveContact = (shopId) => {
    localStorage.setItem(contactKey(shopId), JSON.stringify({ owner: drawerOwner, phone: drawerPhone }));
  };

  const openDrawer = (shop) => {
    setActiveShop(shop);
    const contact = loadContact(shop.id);
    setDrawerOwner(contact.owner);
    setDrawerPhone(contact.phone);
    setDrawerAmount("");
    setDrawerNote("");
  };

  const closeDrawer = () => {
    if (activeShop) saveContact(activeShop.id);
    setActiveShop(null);
  };

  const deleteEntry = (shopId, idx) => {
    const updated = (orders[shopId] || []).filter((_, i) => i !== idx);
    saveOrders({ ...orders, [shopId]: updated });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#080d14", position: "relative" }}>

      {/* Location tabs — synced to current day */}
      <div style={{
        display: "flex", overflowX: "auto", scrollbarWidth: "none",
        borderBottom: "1px solid #111827", flexShrink: 0,
      }}>
        {[1,2,3,4,5,6].map(n => {
          const label = locationNames[n] || `Loc ${n}`;
          const count = (masterShops[n] || []).length;
          return (
            <button key={n} onClick={() => setActiveLocTab(n)} style={{
              padding: "10px 16px", background: "transparent", border: "none",
              color: activeLocTab === n ? "#f97316" : "#4b5563",
              fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
              cursor: "pointer",
              borderBottom: activeLocTab === n ? "2px solid #f97316" : "2px solid transparent",
              whiteSpace: "nowrap", flexShrink: 0, transition: "all 0.15s",
            }}>
              {label}
              <span style={{
                display: "inline-block", marginLeft: 5,
                background: activeLocTab === n ? "#1c1007" : "#111827",
                color: activeLocTab === n ? "#f97316" : "#374151",
                borderRadius: 8, padding: "0 5px", fontSize: 9,
              }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Shop list — tap to open drawer */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px 80px" }}>
        {shops.length === 0 ? (
          <div className="empty" style={{ paddingTop: 48 }}>
            <div className="empty-icon">📦</div>
            <div className="empty-text">No shops here yet.<br />Add from the Route tab.</div>
          </div>
        ) : shops.map(shop => {
          const total = getTotal(shop.id);
          const hit = total >= 1000;
          const pct = Math.min((total / 1000) * 100, 100);
          const lastEntry = (orders[shop.id] || [])[0];
          return (
            <div
              key={shop.id}
              onClick={() => openDrawer(shop)}
              style={{
                background: hit ? "#081510" : "#0d1421",
                border: `1px solid ${hit ? "#0f2d1a" : "#131e2e"}`,
                borderRadius: 12, padding: "13px 14px", marginBottom: 7,
                cursor: "pointer", transition: "all 0.12s",
                display: "flex", alignItems: "center", gap: 12,
              }}
            >
              {/* Status dot */}
              <div style={{
                width: 8, height: 8, minWidth: 8, borderRadius: "50%",
                background: hit ? "#10b981" : total > 0 ? "#f97316" : "#1f2937",
              }} />

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
                  fontSize: 14, color: "#f3f4f6",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{shop.name}</div>
                {lastEntry && (
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                    Last: ₹{lastEntry.amount.toLocaleString()} · {lastEntry.date}
                  </div>
                )}
              </div>

              {/* Total + progress */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{
                  fontFamily: "'JetBrains Mono',monospace", fontSize: 15,
                  fontWeight: 700, color: hit ? "#10b981" : total > 0 ? "#f97316" : "#374151",
                }}>₹{total.toLocaleString()}</div>
                <div style={{ width: 60, height: 3, background: "#1f2937", borderRadius: 4, marginTop: 4 }}>
                  <div style={{
                    height: "100%", borderRadius: 4,
                    background: hit ? "#10b981" : "#f97316",
                    width: `${pct}%`, transition: "width 0.4s ease",
                  }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* SHOP DRAWER */}
      {activeShop && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "flex-end",
        }} onClick={closeDrawer}>
          <div style={{
            background: "#111827", borderRadius: "20px 20px 0 0",
            border: "1px solid #1f2937", borderBottom: "none",
            width: "100%", maxHeight: "88vh",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }} onClick={e => e.stopPropagation()}>

            {/* Handle + header */}
            <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #1f2937", flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, background: "#374151", borderRadius: 4, margin: "0 auto 14px" }} />
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
                    fontSize: 16, color: "#f3f4f6",
                  }}>{activeShop.name}</div>
                  <div style={{
                    fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
                    color: "#f97316", marginTop: 2,
                  }}>₹{getTotal(activeShop.id).toLocaleString()} this month</div>
                </div>
                <button onClick={closeDrawer} style={{
                  background: "none", border: "none", color: "#4b5563",
                  fontSize: 22, cursor: "pointer", lineHeight: 1, flexShrink: 0,
                }}>×</button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 24px" }}>

              {/* Contact details */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151", letterSpacing: 1.5, marginBottom: 8 }}>CONTACT</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="field"
                    placeholder="Owner name"
                    value={drawerOwner}
                    onChange={e => setDrawerOwner(e.target.value)}
                    onBlur={() => saveContact(activeShop.id)}
                    style={{ flex: 1, padding: "8px 11px", fontSize: 12 }}
                  />
                  <a
                    href={drawerPhone ? `tel:${drawerPhone}` : undefined}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 40, borderRadius: 10, flexShrink: 0,
                      background: drawerPhone ? "#0a2218" : "#1f2937",
                      color: drawerPhone ? "#10b981" : "#374151",
                      fontSize: 18, textDecoration: "none",
                      border: `1px solid ${drawerPhone ? "#14532d" : "#1f2937"}`,
                    }}
                  >
                    📞
                  </a>
              <input
                  className="field"
                  placeholder="Phone number"
                  value={drawerPhone}
                  type="tel"
                  onChange={e => setDrawerPhone(e.target.value)}
                  style={{ marginTop: 8, padding: "8px 11px", fontSize: 12 }}
                />
                <button
                  onClick={() => { saveContact(activeShop.id); setStatus("✓ Contact saved"); }}
                  style={{
                    marginTop: 8, padding: "9px", background: "#111827",
                    border: "1px solid #1f2937", borderRadius: 10,
                    color: "#9ca3af", fontFamily: "'Space Grotesk',sans-serif",
                    fontWeight: 600, fontSize: 12, cursor: "pointer", width: "100%",
                  }}
                >
                  Save Contact
                </button>
              </div>

              {/* Log order */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151", letterSpacing: 1.5, marginBottom: 8 }}>LOG ORDER</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    className="field"
                    type="number"
                    placeholder="₹ Amount"
                    value={drawerAmount}
                    onChange={e => setDrawerAmount(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addEntry()}
                    style={{ flex: 1, padding: "10px 12px", fontSize: 14 }}
                    autoFocus
                  />
                  <button onClick={addEntry} disabled={!drawerAmount} style={{
                    background: drawerAmount ? "#f97316" : "#1f2937",
                    border: "none", color: drawerAmount ? "#080d14" : "#374151",
                    borderRadius: 10, padding: "10px 16px", cursor: "pointer",
                    fontFamily: "'Space Grotesk',sans-serif", fontSize: 13, fontWeight: 700,
                    transition: "all 0.15s", flexShrink: 0,
                  }}>Add</button>
                </div>
                <input
                  className="field"
                  placeholder="Note (optional) — e.g. paid cash, follow up"
                  value={drawerNote}
                  onChange={e => setDrawerNote(e.target.value)}
                  style={{ padding: "8px 11px", fontSize: 12 }}
                />
              </div>

              {/* Order history */}
              <div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151", letterSpacing: 1.5, marginBottom: 8 }}>
                  HISTORY · {getHistory(activeShop.id).length} ENTRIES
                </div>
                {getHistory(activeShop.id).length === 0 ? (
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#1f2937", padding: "12px 0" }}>
                    No orders yet. Log your first one above.
                  </div>
                ) : getHistory(activeShop.id).map((entry, idx) => (
                  <div key={idx} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 0",
                    borderBottom: idx < getHistory(activeShop.id).length - 1 ? "1px solid #111827" : "none",
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontFamily: "'JetBrains Mono',monospace", fontWeight: 700,
                        fontSize: 14, color: "#f97316",
                      }}>₹{Number(entry.amount).toLocaleString()}</div>
                      {entry.note && (
                        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                          {entry.note}
                        </div>
                      )}
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#374151" }}>
                      {entry.date}
                    </div>
                    <button onClick={() => deleteEntry(activeShop.id, idx)} style={{
                      background: "none", border: "none", color: "#374151",
                      fontSize: 16, cursor: "pointer", padding: "0 2px",
                    }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ============================================================
// ROUTE POINTS EDITOR
// ============================================================
function RoutePointsEditor({ homeAddress, setHomeAddress, homeCoords, officeAddress, setOfficeAddress, officeCoords, onSave }) {
  const [editingHome, setEditingHome] = useState(false);
  const [editingOffice, setEditingOffice] = useState(false);

  return (
    <div style={{ background: "#0d1421", border: "1px solid #1f2937", borderRadius: 14, overflow: "hidden" }}>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#374151", letterSpacing: 1.5, padding: "12px 14px 8px" }}>
        ROUTE POINTS
      </div>

      {/* START */}
      <div style={{ padding: "0 14px 12px" }}>
        {!editingHome ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}
            onClick={() => setEditingHome(true)}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: homeCoords ? "#10b981" : "#374151", flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151", letterSpacing: 1 }}>START</div>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 13, color: homeCoords ? "#f3f4f6" : "#374151", marginTop: 2 }}>
                {homeCoords ? homeAddress.substring(0, 40) : "Tap to set start point"}
              </div>
            </div>
            <div style={{ color: "#374151", fontSize: 12 }}>✎</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#10b981", letterSpacing: 1 }}>● START</div>
            <input className="field" placeholder="Home address or Google Maps link"
              value={homeAddress} onChange={e => setHomeAddress(e.target.value)}
              autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary" style={{ flex: 1 }}
                onClick={() => { onSave("home", homeAddress); setEditingHome(false); }}
                disabled={!homeAddress.trim()}>
                Save
              </button>
              <button onClick={() => setEditingHome(false)} style={{
                padding: "10px 14px", background: "transparent",
                border: "1px solid #1f2937", borderRadius: 10,
                color: "#6b7280", fontFamily: "'Space Grotesk',sans-serif",
                fontSize: 13, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "#1f2937" }} />

      {/* END */}
      <div style={{ padding: "12px 14px 14px" }}>
        {!editingOffice ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}
            onClick={() => setEditingOffice(true)}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: officeCoords ? "#ef4444" : "#374151", flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#374151", letterSpacing: 1 }}>END</div>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 13, color: officeCoords ? "#f3f4f6" : "#374151", marginTop: 2 }}>
                {officeCoords ? officeAddress.substring(0, 40) : "Tap to set end point"}
              </div>
            </div>
            <div style={{ color: "#374151", fontSize: 12 }}>✎</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#ef4444", letterSpacing: 1 }}>● END</div>
            <input className="field" placeholder="Office address or Google Maps link"
              value={officeAddress} onChange={e => setOfficeAddress(e.target.value)}
              autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary" style={{ flex: 1 }}
                onClick={() => { onSave("office", officeAddress); setEditingOffice(false); }}
                disabled={!officeAddress.trim()}>
                Save
              </button>
              <button onClick={() => setEditingOffice(false)} style={{
                padding: "10px 14px", background: "transparent",
                border: "1px solid #1f2937", borderRadius: 10,
                color: "#6b7280", fontFamily: "'Space Grotesk',sans-serif",
                fontSize: 13, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
// ============================================================
// ONE-OFF ADD
// ============================================================
function OneOffAdd({ nameInput, addressInput, setNameInput, setAddressInput, geocoding, onAdd }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid #111827", flexShrink: 0, background: "#080d14" }}>
      <div className="oneoff-toggle" onClick={() => setOpen(v => !v)}>
        <span className="oneoff-toggle-label">+ One-off stop (not saved to list)</span>
        <span style={{ fontSize: 10, color: "#374151" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="oneoff-form">
          <input className="field" placeholder="Name (optional)" value={nameInput} onChange={e => setNameInput(e.target.value)} />
          <input className="field" placeholder="Address or Google Maps link" value={addressInput}
            onChange={e => setAddressInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && onAdd()} />
          <button className="btn-primary" onClick={onAdd} disabled={geocoding || !addressInput.trim()}>
            {geocoding ? "Finding..." : "Add Stop"}
          </button>
        </div>
      )}
    </div>
  );
}
