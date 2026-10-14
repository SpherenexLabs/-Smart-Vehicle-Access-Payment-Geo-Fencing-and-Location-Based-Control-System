export const INITIAL_VOLTAGES = [4.06, 4.05, 4.07, 4.06, 4.04, 4.05, 4.06, 3.86, 4.05, 4.06, 4.04, 4.05, 4.06, 4.04];

export function createInitialState(now = Date.now()) {
  const history = Array.from({ length: 61 }, (_, i) => ({
    time: now - (60 - i) * 60000,
    cells: INITIAL_VOLTAGES.map((v, n) => Number((v + Math.sin(i * 0.3 + n) * 0.009).toFixed(3))),
    soc: Number((80 - i / 30).toFixed(2))
  }));
  history[60] = { time: now, cells: [...INITIAL_VOLTAGES], soc: 78 };
  return {
    mode: 'demo', connection: 'connected', updatedAt: now,
    cells: [...INITIAL_VOLTAGES], soc: 78, automatic: true, balancing: true,
    weakCells: [8], chargingStatus: 'Discharging',
    batteryOk: false, batteryStatus: 'Attention', zeroVoltageCells: [], lowVoltageCells: [], overVoltageCells: [],
    protection: { overvoltage: false, undervoltage: false, shortCircuit: false, cutoff: false },
    vehicle: { connected: true, status: 'Stationary' }, direction: 'S',
    relays: Array(14).fill(0), routes: [], current: 0, chargingVoltage: 0,
    socStatus: 'NOT CHARGING', sodStatus: 'IDLE', led: false,
    history, events: [{ time: now, text: 'Automatic balancing enabled', kind: 'info' }],
    cycles: [
      { id: '01', date: new Date(now - 86400000 * 2).toISOString(), health: 'Normal', weakCells: [], min: 3.55, max: 4.17, charge: 96, discharge: 105 },
      { id: '02', date: new Date(now - 86400000).toISOString(), health: 'Normal', weakCells: [], min: 3.52, max: 4.16, charge: 98, discharge: 102 },
      { id: '03', date: new Date(now).toISOString(), health: 'Cell 08 warning', weakCells: [8], min: 3.49, max: 4.15, charge: 102, discharge: 93 }
    ]
  };
}

export function addEvent(state, text, kind = 'info', now = Date.now()) {
  return { ...state, events: [{ time: now, text, kind }, ...state.events].slice(0, 150) };
}

export function applyDemoCommand(state, command, now = Date.now()) {
  if (state.mode !== 'demo') return state;
  const enabled = command.enabled === true;
  if (command.command === 'set_automatic') {
    return addEvent({ ...state, automatic: enabled, balancing: enabled }, `Automatic balancing ${enabled ? 'enabled' : 'disabled'}`, 'info', now);
  }
  if (command.command === 'set_balancing') {
    return addEvent({ ...state, balancing: enabled, automatic: enabled ? state.automatic : false }, `Balancing ${enabled ? 'started' : 'stopped'}`, 'info', now);
  }
  return state;
}

export function tickDemo(state, now = Date.now()) {
  if (state.mode !== 'demo') return state;
  const phase = (now - state.history[0].time) / 15000;
  const cells = INITIAL_VOLTAGES.map((base, i) => Number((base + Math.sin(phase + i * 0.73) * 0.006).toFixed(3)));
  const soc = Math.max(0, state.soc - (now - state.updatedAt) / 3600000 * 0.5);
  return {
    ...state, cells, soc, updatedAt: now,
    history: [...state.history, { time: now, cells, soc }].filter(p => p.time >= now - 3600000).slice(-1900)
  };
}

export function validateTelemetry(packet) {
  if (!packet || typeof packet !== 'object') throw new Error('Telemetry must be an object.');
  if (!Array.isArray(packet.cells) || packet.cells.length !== 14 || packet.cells.some(v => !Number.isFinite(v) || v < 0 || v > 6)) {
    throw new Error('Telemetry requires exactly 14 numeric cell voltages between 0 and 6 V.');
  }
  if (!Number.isFinite(packet.soc) || packet.soc < 0 || packet.soc > 100) throw new Error('SOC must be between 0 and 100.');
  if (!Array.isArray(packet.weakCells) || packet.weakCells.some(n => !Number.isInteger(n) || n < 1 || n > 14)) throw new Error('weakCells must list cell numbers 1-14.');
  if (typeof packet.automatic !== 'boolean' || typeof packet.balancing !== 'boolean') throw new Error('Balancing states must be boolean.');
  for (const key of ['overvoltage', 'undervoltage', 'shortCircuit', 'cutoff']) {
    if (typeof packet.protection?.[key] !== 'boolean') throw new Error(`Protection flag ${key} is required.`);
  }
  if (!['Charging', 'Discharging', 'Idle'].includes(packet.chargingStatus)) throw new Error('Invalid charging status.');
  if (typeof packet.vehicle?.connected !== 'boolean' || typeof packet.vehicle?.status !== 'string' || packet.vehicle.status.length > 80) throw new Error('Invalid vehicle status.');
  return packet;
}

export function applyTelemetry(state, packet, now = Date.now()) {
  validateTelemetry(packet);
  const cells = [...packet.cells];
  return {
    ...state, mode: 'live', connection: 'connected', cells, soc: packet.soc,
    automatic: packet.automatic, balancing: packet.balancing,
    weakCells: [...new Set(packet.weakCells)], chargingStatus: packet.chargingStatus,
    protection: { ...packet.protection }, vehicle: { ...packet.vehicle }, updatedAt: now,
    history: [...state.history, { time: now, cells, soc: packet.soc }].filter(p => p.time >= now - 3600000).slice(-1900)
  };
}

export const cellLabel = number => `Cell ${String(number).padStart(2, '0')}`;
export const socLabel = soc => `${Math.round(soc)}%`;
export const cellSpread = cells => Math.max(...cells) - Math.min(...cells);

export function getAlerts(state) {
  const zeroCells = state.zeroVoltageCells || [];
  const alerts = state.weakCells.filter(number => !zeroCells.includes(number)).map(number => ({ id: `weak-${number}`, kind: 'warning', title: `Weak cell detected: ${cellLabel(number)}`, detail: 'Abnormal voltage behavior. Inspect and replace if required.' }));
  for (const number of zeroCells) alerts.unshift({ id: `zero-${number}`, kind: 'danger', title: `No voltage: ${cellLabel(number)}`, detail: `0 V detected. Relay ${number} is forced OFF for safety.` });
  const names = { overvoltage: 'Overvoltage detected', undervoltage: 'Undervoltage detected', shortCircuit: 'Short circuit detected', cutoff: 'Automatic cutoff active' };
  for (const key of Object.keys(names)) if (state.protection[key]) alerts.unshift({ id: key, kind: 'danger', title: names[key], detail: 'Battery protection is active. Check the battery system.' });
  if (state.mode !== 'demo' && state.connection !== 'connected') alerts.unshift({ id: 'connection', kind: 'warning', title: 'Live telemetry unavailable', detail: 'Displayed readings may be stale. Firebase commands are disabled until telemetry resumes.' });
  return alerts;
}
