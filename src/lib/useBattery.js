import { useCallback, useEffect, useRef, useState } from 'react';
import { addEvent, createInitialState } from './model.js';
import {
  applyFirebaseEvent, firebaseSnapshotToTelemetry, FIREBASE_ROOT, historyRecord,
  LOW_VOLTAGE, normalizeHistory, RECOVERY_VOLTAGE, relayIsOn, relayTargets, subscribeDatabase, writeDatabase
} from './firebaseRtdb.js';

const HISTORY_INTERVAL_MS = 60000;

function mergeHistory(...groups) {
  const byTime = new Map();
  groups.flat().forEach(point => {
    if (Number.isFinite(point?.time) && Array.isArray(point?.cells)) byTime.set(point.time, point);
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-5000);
}

const unavailableState = () => ({
  ...createInitialState(), mode: 'firebase', connection: 'connecting',
  cells: Array(14).fill(null), relays: Array(14).fill(null), soc: null,
  weakCells: [], history: [], cycles: [], events: [], direction: 'S',
  current: null, chargingVoltage: null, socStatus: 'UNKNOWN', sodStatus: 'UNKNOWN',
  batteryOk: null, batteryStatus: 'Unknown', zeroVoltageCells: [], lowVoltageCells: [], overVoltageCells: [],
  led: false, routes: [], automatic: true, balancing: false,
  chargingStatus: 'Unknown', vehicle: { connected: false, status: 'Unknown' }
});

export default function useBattery(notify) {
  const [state, setState] = useState(unavailableState);
  const [busy, setBusy] = useState(false);
  const raw = useRef({});
  const automation = useRef(true);
  const relayWrite = useRef(false);
  const pendingRelayTelemetry = useRef(null);
  const lastHistoryBucket = useRef(null);
  const historyWriteWarning = useRef(false);

  const syncRelays = useCallback(async telemetry => {
    pendingRelayTelemetry.current = telemetry;
    if (relayWrite.current) return;
    relayWrite.current = true;
    try {
      while (pendingRelayTelemetry.current) {
        const latest = pendingRelayTelemetry.current;
        pendingRelayTelemetry.current = null;
        const targets = relayTargets(latest.cells, latest.relays, LOW_VOLTAGE, RECOVERY_VOLTAGE, automation.current);
        const changes = {};
        targets.forEach((target, index) => {
          if (target !== null && latest.relays[index] !== target) changes[`Relay${index + 1}`] = target;
        });
        if (!Object.keys(changes).length) continue;
        await writeDatabase(`${FIREBASE_ROOT}/Relay`, changes, 'PATCH');
        const labels = Object.entries(changes).map(([name, value]) => `${name} ${relayIsOn(value) ? 'ON (0)' : 'OFF (1)'}`).join(', ');
        const hardCutoff = Object.keys(changes).some(name => latest.cells[Number(name.replace('Relay', '')) - 1] === 0);
        setState(current => addEvent(current, `${hardCutoff ? 'Zero-voltage safety cutoff' : 'Automatic voltage protection'}: ${labels}`, hardCutoff ? 'danger' : 'info'));
      }
    } catch (error) {
      notify(`Relay update failed. Check Firebase Rules. ${error.message}`, 'error');
    } finally {
      relayWrite.current = false;
    }
  }, [notify]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribeDatabase(FIREBASE_ROOT, {
      onOpen: () => !disposed && setState(current => ({ ...current, connection: 'connected' })),
      onDisconnect: () => !disposed && setState(current => ({ ...current, connection: 'offline', vehicle: { ...current.vehicle, connected: false } })),
      onError: error => !disposed && notify(`Invalid Firebase update: ${error.message}`, 'error'),
      onData: event => {
        if (disposed) return;
        raw.current = applyFirebaseEvent(raw.current, event);
        const now = Date.now();
        const telemetry = firebaseSnapshotToTelemetry(raw.current, { automatic: automation.current });
        const isHistoryEvent = event.path === '/History' || event.path.startsWith('/History/');
        if (!isHistoryEvent) queueMicrotask(() => syncRelays(telemetry));
        setState(current => {
          const storedHistory = normalizeHistory(raw.current?.History);
          const livePoint = !isHistoryEvent && telemetry.cells.some(Number.isFinite)
            ? [{ time: now, cells: [...telemetry.cells], soc: telemetry.soc }]
            : [];
          const history = mergeHistory(storedHistory, current.history, livePoint);
          return { ...current, ...telemetry, connection: 'connected', updatedAt: now, history };
        });
        if (!isHistoryEvent && telemetry.cells.some(Number.isFinite)) {
          const bucket = Math.floor(now / HISTORY_INTERVAL_MS);
          if (lastHistoryBucket.current !== bucket) {
            lastHistoryBucket.current = bucket;
            writeDatabase(`${FIREBASE_ROOT}/History/${bucket}`, historyRecord(telemetry, now)).then(() => {
              historyWriteWarning.current = false;
            }).catch(error => {
              if (!historyWriteWarning.current) notify(`Historical data could not be stored. Check Firebase Rules. ${error.message}`, 'error');
              historyWriteWarning.current = true;
            });
          }
        }
      }
    });
    return () => { disposed = true; unsubscribe(); };
  }, [notify, syncRelays]);

  const setDirection = useCallback(async code => {
    const direction = String(code).toUpperCase();
    if (!['F', 'B', 'L', 'R', 'S'].includes(direction)) return false;
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Direction`, direction);
      setState(current => ({ ...current, direction, vehicle: { connected: true, status: { F: 'Moving forward', B: 'Moving backward', L: 'Turning left', R: 'Turning right', S: 'Stationary' }[direction] } }));
      return true;
    } catch (error) {
      notify(`Direction command failed. ${error.message}`, 'error');
      return false;
    } finally { setBusy(false); }
  }, [notify]);

  const setRelayAutomation = useCallback(enabled => {
    automation.current = Boolean(enabled);
    setState(current => ({ ...current, automatic: automation.current }));
    notify(`Automatic relay protection ${automation.current ? 'enabled' : 'paused'}.`, automation.current ? 'success' : 'error');
    syncRelays(firebaseSnapshotToTelemetry(raw.current, { automatic: automation.current }));
  }, [notify, syncRelays]);

  const saveRoute = useCallback(async route => {
    const id = route.id || `route_${Date.now()}`;
    const value = { name: route.name.trim(), steps: route.steps, updatedAt: Date.now() };
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Routes/${id}`, value);
      notify(route.id ? 'Route updated in Firebase.' : 'Route saved in Firebase.');
      return id;
    } catch (error) {
      notify(`Route could not be saved. ${error.message}`, 'error');
      return null;
    } finally { setBusy(false); }
  }, [notify]);

  const deleteRoute = useCallback(async id => {
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Routes/${id}`, null);
      notify('Route deleted.');
      return true;
    } catch (error) {
      notify(`Route could not be deleted. ${error.message}`, 'error');
      return false;
    } finally { setBusy(false); }
  }, [notify]);

  return { state, busy, setDirection, setRelayAutomation, saveRoute, deleteRoute };
}
