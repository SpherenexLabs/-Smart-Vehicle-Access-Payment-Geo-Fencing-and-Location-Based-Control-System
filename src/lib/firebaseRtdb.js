export const firebaseConfig = Object.freeze({
  apiKey: 'AIzaSyAr4IYnykpwovqOJWzfBd7abVdAma_Ig3Q',
  authDomain: 'diet-planner-3bdf3.firebaseapp.com',
  databaseURL: 'https://diet-planner-3bdf3-default-rtdb.firebaseio.com',
  projectId: 'diet-planner-3bdf3',
  storageBucket: 'diet-planner-3bdf3.firebasestorage.app',
  messagingSenderId: '927878354911',
  appId: '1:927878354911:web:2e616b171a267b9910566a',
  measurementId: 'G-MSYWCM58MT'
});

export const FIREBASE_ROOT = 'BMS_5580';
export const LOW_VOLTAGE = 3;
export const RECOVERY_VOLTAGE = 3.1;
export const MAX_SAFE_VOLTAGE = 3.8;
export const ZERO_VOLTAGE = 0;
export const EMPTY_VOLTAGE = 0;
export const FULL_VOLTAGE = 4.0;
export const RELAY_OFF_VALUE = 1;
export const RELAY_ON_VALUE = 0;
export const relayIsOn = value => value === RELAY_ON_VALUE;
export const relayIsOff = value => value === RELAY_OFF_VALUE;

const cleanPath = path => String(path || '')
  .split('/')
  .filter(Boolean)
  .map(encodeURIComponent)
  .join('/');

export function databaseUrl(path = '') {
  return `${firebaseConfig.databaseURL}/${cleanPath(path)}.json`;
}

export async function writeDatabase(path, value, method = 'PUT') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(databaseUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Firebase write failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response.json().catch(() => value);
  } finally {
    clearTimeout(timer);
  }
}

export function subscribeDatabase(path, handlers) {
  const stream = new EventSource(databaseUrl(path));
  const receive = event => {
    try {
      handlers.onData?.({ ...JSON.parse(event.data), type: event.type });
    } catch (error) {
      handlers.onError?.(error);
    }
  };
  stream.addEventListener('put', receive);
  stream.addEventListener('patch', receive);
  stream.onopen = () => handlers.onOpen?.();
  stream.onerror = () => handlers.onDisconnect?.();
  return () => stream.close();
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 6 ? number : null;
}

export function numberedValues(node, prefix, count = 14) {
  return Array.from({ length: count }, (_, index) => asNumber(node?.[`${prefix}${index + 1}`]));
}

export function voltageToSoc(voltage) {
  if (!Number.isFinite(voltage)) return null;
  // The hardware supplies an absolute 0-4.0 V reading for each battery, so
  // display charge as that battery's share of its 4.0 V full-scale value.
  return Math.max(0, Math.min(100, ((voltage - EMPTY_VOLTAGE) / (FULL_VOLTAGE - EMPTY_VOLTAGE)) * 100));
}

export function batterySocFromVoltages(cells) {
  const percentages = (Array.isArray(cells) ? cells : []).map(voltageToSoc).filter(Number.isFinite);
  return percentages.length ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length : null;
}

export function relayTargets(cells, currentRelays, low = LOW_VOLTAGE, recovery = RECOVERY_VOLTAGE, automatic = true) {
  return cells.map((voltage, index) => {
    if (!Number.isFinite(voltage)) return null;
    // A measured 0 V is a hard safety cutoff and is never disabled by the
    // automatic-control switch. Vn always controls the matching Relayn.
    if (voltage === ZERO_VOLTAGE) return RELAY_OFF_VALUE;
    if (!automatic) return null;
    if (voltage < low) return RELAY_OFF_VALUE;
    if (voltage >= recovery) return RELAY_ON_VALUE;
    const current = currentRelays[index];
    return current === 0 || current === 1 ? current : RELAY_OFF_VALUE;
  });
}

export function batteryHealthFromVoltages(cells, count = 14) {
  const readings = Array.isArray(cells) ? cells.slice(0, count) : [];
  const complete = readings.length === count && readings.every(Number.isFinite);
  const zeroVoltageCells = readings.flatMap((value, index) => value === ZERO_VOLTAGE ? [index + 1] : []);
  const lowVoltageCells = readings.flatMap((value, index) => Number.isFinite(value) && value > ZERO_VOLTAGE && value < LOW_VOLTAGE ? [index + 1] : []);
  const overVoltageCells = readings.flatMap((value, index) => Number.isFinite(value) && value > MAX_SAFE_VOLTAGE ? [index + 1] : []);
  const batteryStatus = !complete ? 'Unknown'
    : zeroVoltageCells.length ? 'Fault'
      : lowVoltageCells.length || overVoltageCells.length ? 'Attention'
        : 'OK';
  return {
    batteryOk: complete ? batteryStatus === 'OK' : null,
    batteryStatus,
    zeroVoltageCells,
    lowVoltageCells,
    overVoltageCells
  };
}

export function voltageCondition(voltage) {
  if (!Number.isFinite(voltage)) return 'Unknown';
  if (voltage === ZERO_VOLTAGE) return 'No voltage';
  if (voltage < LOW_VOLTAGE) return 'Low';
  if (voltage > MAX_SAFE_VOLTAGE) return 'High';
  return 'Normal';
}

export function voltageSuggestion(condition, number) {
  const battery = `Battery ${String(number).padStart(2, '0')}`;
  if (condition === 'No voltage') return `${battery}: keep its relay OFF, verify wiring and fuse with a meter, and replace the battery if 0 V is confirmed.`;
  if (condition === 'Low') return `${battery}: reduce load, keep it isolated, recharge with the correct charger, then inspect or replace it if it stays below ${RECOVERY_VOLTAGE.toFixed(1)} V.`;
  if (condition === 'High') return `${battery}: stop charging, isolate the charger, verify BMS/charger settings, and balance or service the battery before reuse.`;
  if (condition === 'Normal') return `${battery}: voltage is within the configured range; continue monitoring and balancing.`;
  return `${battery}: reading is unavailable; check its sensor connection before making a maintenance decision.`;
}

export function analyzeVoltages(cells) {
  const readings = Array.isArray(cells) ? cells.slice(0, 14) : [];
  const finite = readings.map((voltage, index) => ({ voltage, number: index + 1 })).filter(item => Number.isFinite(item.voltage));
  const highestVoltage = finite.length ? Math.max(...finite.map(item => item.voltage)) : null;
  const highestCells = finite.filter(item => item.voltage === highestVoltage).map(item => item.number);
  const lowestVoltage = finite.length ? Math.min(...finite.map(item => item.voltage)) : null;
  return {
    highestVoltage,
    highestCells,
    lowestVoltage,
    cells: Array.from({ length: 14 }, (_, index) => {
      const voltage = readings[index];
      const condition = voltageCondition(voltage);
      return {
        number: index + 1,
        voltage,
        condition,
        isHighest: Number.isFinite(voltage) && voltage === highestVoltage,
        suggestion: voltageSuggestion(condition, index + 1)
      };
    })
  };
}

export function predictVoltageConditions(history, minutes = 30) {
  const records = (Array.isArray(history) ? history : [])
    .filter(point => Number.isFinite(point?.time) && Array.isArray(point?.cells))
    .sort((a, b) => a.time - b.time);
  return Array.from({ length: 14 }, (_, index) => {
    const samples = records.map(point => ({ time: point.time, voltage: point.cells[index] })).filter(point => Number.isFinite(point.voltage));
    const latest = samples.at(-1);
    let projectedVoltage = latest?.voltage ?? null;
    let trend = 'Insufficient history';
    if (samples.length >= 2) {
      const comparison = [...samples].reverse().find(point => latest.time - point.time >= 30000) || samples[0];
      const elapsedMinutes = (latest.time - comparison.time) / 60000;
      if (elapsedMinutes > 0) {
        const rate = (latest.voltage - comparison.voltage) / elapsedMinutes;
        projectedVoltage = Math.max(0, Math.min(6, latest.voltage + rate * minutes));
        trend = Math.abs(rate) < 0.0005 ? 'Stable' : rate > 0 ? 'Rising' : 'Falling';
      }
    }
    const condition = voltageCondition(projectedVoltage);
    return {
      number: index + 1,
      currentVoltage: latest?.voltage ?? null,
      projectedVoltage,
      minutes,
      trend,
      condition,
      suggestion: voltageSuggestion(condition, index + 1)
    };
  });
}

export function normalizeHistory(node, limit = 5000) {
  const entries = Array.isArray(node) ? node.map((value, index) => [String(index), value]) : Object.entries(node || {});
  const records = entries.map(([id, record]) => {
    const time = Number(record?.recordedAt ?? record?.time ?? id);
    const sourceCells = Array.isArray(record?.cells) ? record.cells : numberedValues(record?.Voltage, 'V');
    const cells = Array.from({ length: 14 }, (_, index) => asNumber(sourceCells[index]));
    const soc = Number(record?.soc);
    return { id, time, cells, soc: Number.isFinite(soc) ? soc : batterySocFromVoltages(cells) };
  }).filter(record => Number.isFinite(record.time) && record.cells.some(Number.isFinite));
  return records.sort((a, b) => a.time - b.time).slice(-limit);
}

export function historyRecord(telemetry, now = Date.now()) {
  const analysis = analyzeVoltages(telemetry.cells);
  return {
    recordedAt: now,
    cells: telemetry.cells.map(value => Number.isFinite(value) ? value : null),
    soc: Number.isFinite(telemetry.soc) ? Number(telemetry.soc.toFixed(2)) : null,
    batteryStatus: telemetry.batteryStatus || 'Unknown',
    highestCells: analysis.highestCells,
    highestVoltage: analysis.highestVoltage,
    zeroVoltageCells: telemetry.zeroVoltageCells || [],
    lowVoltageCells: telemetry.lowVoltageCells || [],
    highVoltageCells: telemetry.overVoltageCells || []
  };
}

export function normalizeSteps(value) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return list.map(step => ({
    direction: String(step?.direction || '').toUpperCase(),
    duration: Math.round(Number(step?.duration))
  })).filter(step => ['F', 'B', 'L', 'R', 'S'].includes(step.direction) && Number.isFinite(step.duration) && step.duration >= 100 && step.duration <= 120000);
}

export function normalizeRoutes(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).map(([id, route]) => ({
    id,
    name: String(route?.name || 'Unnamed route').slice(0, 80),
    steps: normalizeSteps(route?.steps),
    updatedAt: Number(route?.updatedAt) || 0
  })).filter(route => route.steps.length).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function applyFirebaseEvent(current, event) {
  if (!event || typeof event.path !== 'string') return current;
  const patchValue = (existing, update) => {
    const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
    for (const [key, value] of Object.entries(update || {})) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  };
  if (event.path === '/') {
    if (event.type === 'patch') return patchValue(current, event.data);
    return event.data && typeof event.data === 'object' ? event.data : {};
  }
  const clone = structuredClone(current || {});
  const segments = event.path.split('/').filter(Boolean);
  let target = clone;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  const key = segments.at(-1);
  if (event.data === null) delete target[key];
  else if (event.type === 'patch') target[key] = patchValue(target[key], event.data);
  else target[key] = event.data;
  return clone;
}

export function firebaseSnapshotToTelemetry(data, previous = {}) {
  const cells = numberedValues(data?.Voltage, 'V');
  const relays = numberedValues(data?.Relay, 'Relay').map(value => value === null ? null : value ? 1 : 0);
  const health = batteryHealthFromVoltages(cells);
  // Convert each battery to a bounded percentage before averaging. This makes
  // one low/zero battery contribute 1/14 of the pack estimate instead of
  // pulling the raw average voltage below the useful SOC range.
  const soc = batterySocFromVoltages(cells);
  const weakCells = [...health.zeroVoltageCells, ...health.lowVoltageCells].sort((a, b) => a - b);
  const currentValue = Number(data?.Current);
  const current = Number.isFinite(currentValue) ? currentValue : null;
  const chargingVoltageValue = Number(data?.ChargingVoltage);
  const chargingVoltage = Number.isFinite(chargingVoltageValue) ? chargingVoltageValue : null;
  const cleanStatus = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 60).toUpperCase() : 'UNKNOWN';
  const socStatus = cleanStatus(data?.SOC_Status);
  const sodStatus = cleanStatus(data?.SOD_Status);
  const chargingStatus = socStatus === 'CHARGING' ? 'Charging'
    : sodStatus === 'DISCHARGING' ? 'Discharging'
      : socStatus !== 'UNKNOWN' || sodStatus !== 'UNKNOWN' ? 'Idle'
        : current === null || Math.abs(current) < 0.05 ? 'Idle' : current > 0 ? 'Charging' : 'Discharging';
  const direction = ['F', 'B', 'L', 'R', 'S'].includes(String(data?.Vehicle?.Direction || '').toUpperCase())
    ? String(data.Vehicle.Direction).toUpperCase() : 'S';
  const status = { F: 'Moving forward', B: 'Moving backward', L: 'Turning left', R: 'Turning right', S: 'Stationary' }[direction];
  return {
    cells, relays, soc, weakCells, ...health, current, chargingVoltage, socStatus, sodStatus, led: Number(data?.LED) === 1,
    chargingStatus,
    protection: { overvoltage: health.overVoltageCells.length > 0, undervoltage: weakCells.length > 0, shortCircuit: false, cutoff: relays.some(relayIsOff) },
    direction,
    vehicle: { connected: true, status },
    routes: normalizeRoutes(data?.Vehicle?.Routes),
    automatic: previous.automatic ?? true,
    balancing: relays.some(relayIsOff)
  };
}
