import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './components/Icon.jsx';
import Chart, { cycleSeries, historySeries } from './components/Chart.jsx';
import Robot from './components/Robot.jsx';
import Cells3D from './components/Cells3D.jsx';
import SafetyAlert3D from './components/SafetyAlert3D.jsx';
import useBattery from './lib/useBattery.js';
import { cellLabel, cellSpread, getAlerts } from './lib/model.js';
import { downloadReport } from './lib/exportPdf.js';
import { analyzeVoltages, batteryHealthFromVoltages, LOW_VOLTAGE, MAX_SAFE_VOLTAGE, predictVoltageConditions, RECOVERY_VOLTAGE, relayIsOff, relayIsOn, voltageSuggestion, voltageToSoc } from './lib/firebaseRtdb.js';

const NAV = [
  ['overview','home','Overview'], ['cells','cells','Cell Monitoring'], ['balancing','balance','Relay Control'],
  ['protection','shield','Protection'], ['vehicle','car','Vehicle Testing'], ['reports','report','Reports']
];
const PROTECTION = [['overvoltage','Overvoltage'],['undervoltage','Undervoltage'],['shortCircuit','Short circuit'],['cutoff','Automatic cutoff']];
const percent = v => Number.isFinite(v) ? `${Math.round(v)}%` : '—';

function Panel({ title, icon, action, className = '', children, id }) {
  return <section id={id} className={`panel ${className}`} aria-label={title}>
    <div className="panel-heading"><h2><Icon name={icon}/>{title}</h2>{action}</div>{children}
  </section>;
}

function Badge({ children, type = 'normal' }) { return <span className={`badge ${type}`}>{children}</span>; }
function Legend({ color, children }) { return <span className="legend"><span style={{background:color}}/>{children}</span>; }

function CellGrid({ state, onSelect, expanded = false }) {
  const analysis = analyzeVoltages(state.cells);
  return <div className={`cell-grid ${expanded ? 'expanded-grid' : ''}`}>
    {state.cells.map((v,i) => {
      const zero = state.zeroVoltageCells?.includes(i+1), weak = state.weakCells.includes(i+1), over = state.overVoltageCells?.includes(i+1), known = Number.isFinite(v);
      const highest = analysis.highestCells.includes(i + 1);
      const level = voltageToSoc(v) ?? 0;
      const condition = zero ? 'No voltage' : weak ? 'Low voltage' : over ? 'High voltage' : known ? 'Normal' : 'Unknown';
      const status = highest && known ? `Highest · ${condition}` : condition;
      return <button className={`cell-tile ${zero ? 'zero' : weak ? 'weak' : over ? 'over' : highest ? 'highest' : ''}`} key={i} onClick={()=>onSelect(i+1)} aria-label={`View ${cellLabel(i+1)}, ${known ? v.toFixed(2)+' volts' : 'unavailable'}, ${status}`}>
        <span className="cell-name">{cellLabel(i+1)}</span>
        <strong>{known ? v.toFixed(2) : '—'} <small>V</small></strong>
        <span className="mini-track"><span style={{width:`${level}%`}}/></span>
        <span className="cell-status">{status}</span>
        {expanded && <span className="cell-link">View history <Icon name="chevron" size={12}/></span>}
      </button>;
    })}
  </div>;
}

function CellWarning({ state, onSelect }) {
  if (!state.weakCells.length) return null;
  const zeroCells = state.zeroVoltageCells || [];
  const weakCells = state.weakCells.filter(number => !zeroCells.includes(number));
  const message = zeroCells.length
    ? `${zeroCells.map(cellLabel).join(', ')}: 0 V detected; matching relay forced OFF.${weakCells.length ? ` Also inspect ${weakCells.map(cellLabel).join(', ')}.` : ''}`
    : `${state.weakCells.map(cellLabel).join(', ')}: abnormal voltage behavior. Inspect and replace if required.`;
  return <button className="warning-strip" onClick={()=>onSelect(state.weakCells[0])}>
    <Icon name="alert" size={18}/><span>{message}</span>
  </button>;
}

function BatteryGauge({ soc, charging }) {
  return <div className={`battery-gauge ${charging ? 'charging' : ''}`} role="img" aria-label={`Battery state of charge ${percent(soc)}`}>
    <span className="battery-terminal"/><div className="battery-body"><div className="battery-liquid" style={{height:`${Number.isFinite(soc) ? soc : 0}%`}}><i/></div><strong>{percent(soc)}</strong></div>
  </div>;
}

function RelayControls({ state, setAutomation, busy, large = false }) {
  const disabled = busy || state.connection !== 'connected';
  const onCount = state.relays?.filter(relayIsOn).length || 0;
  return <Panel title="Battery & Relay Protection" icon="settings" className={`balance-panel relay-panel ${large ? 'balance-large' : ''}`}>
    <div className="battery-controls"><BatteryGauge soc={state.soc} charging={state.chargingStatus==='Charging'}/>
      <div className="balance-options">
        <p className="charging-status">Charging status: <strong>{state.chargingStatus}</strong></p>
        <div className="switch-row"><span>Automatic low-voltage control</span><button type="button" role="switch" aria-checked={state.automatic} aria-label="Automatic low-voltage relay control" disabled={disabled} className={`switch ${state.automatic ? 'on' : ''}`} onClick={()=>setAutomation(!state.automatic)}><span/></button></div>
        <p className="threshold-note">0 V → always OFF = 1 · Below {LOW_VOLTAGE.toFixed(2)} V → OFF · At {RECOVERY_VOLTAGE.toFixed(2)} V → ON</p>
        <div className="remote-label">Firebase relay status {busy && <span>· Sending…</span>}</div>
        <p className="control-status"><span className={`dot ${state.connection==='connected'?'green':'red'}`}/>{onCount} of 14 relays ON</p>
      </div>
    </div>
    {large && <div className="relay-grid">{state.relays.map((value,index)=><div className={`relay-chip ${relayIsOn(value)?'on':relayIsOff(value)?'off':'unknown'}`} key={index}><span>Relay {index+1}</span><strong>{relayIsOn(value)?'ON':relayIsOff(value)?'OFF':'—'}</strong><small>{Number.isFinite(state.cells[index])?`${state.cells[index].toFixed(2)} V · ${state.cells[index]===0?'safety cutoff':`value ${value}`}`:'Voltage unavailable'}</small></div>)}</div>}
  </Panel>;
}

function VoltagePanel({ state, expanded = false, onlyCell, history = state.history }) {
  return <Panel title={onlyCell ? `${cellLabel(onlyCell)} Voltage History` : 'Cell Voltage Trends'} icon="chart" className="chart-panel" action={!onlyCell && <div className="chart-legend"><Legend color="#00bda4">Normal cells</Legend><Legend color="#ee9c00">Weak cells</Legend></div>}>
    <Chart series={historySeries(history,state.weakCells,onlyCell)} height={expanded ? 275 : 162} title={onlyCell ? `${cellLabel(onlyCell)} voltage over time` : 'Fourteen cell voltages over time'}/>
  </Panel>;
}

function CyclePanel({ state, expanded = false }) {
  return <Panel title="Charge / Discharge Cycles" icon="cycle" className="chart-panel" action={<div className="chart-legend"><Legend color="#00bda4">Charge</Legend><Legend color="#2476ed">Discharge</Legend></div>}>
    <Chart series={state.mode === 'demo' ? cycleSeries() : []} height={expanded ? 275 : 162} title="Illustrative charge and discharge voltage profiles"/>
    {state.mode==='live' && <p className="muted-text chart-footnote">Cycle history requires records from your battery data source.</p>}
  </Panel>;
}

function ProtectionPanel({ state, onOpen, extended = false, reviewed = [], onReview }) {
  const known = Number.isFinite(state.soc), alerts = getAlerts(state);
  return <Panel title="Protection & Alerts" icon="shield" className="protection-panel">
    <div className="protection-list">{PROTECTION.map(([key,label]) => <div className="protection-row" key={key}><span><i className={`dot ${!known ? 'muted' : state.protection[key] ? 'red' : key==='cutoff' ? 'muted' : 'green'}`}/>{label}</span><strong className={!known ? 'muted-text' : state.protection[key] ? 'danger-text' : key==='cutoff' ? 'muted-text' : 'success-text'}>{!known ? 'Unknown' : state.protection[key] ? 'Active' : key==='cutoff' ? 'Inactive' : 'Clear'}</strong></div>)}</div>
    {extended ? <div className="alert-list">{alerts.map(a => <article className={`alert-entry ${a.kind}`} key={a.id}><Icon name="alert"/><div><strong>{a.title}</strong><p>{a.detail}</p>{reviewed.includes(a.id) ? <Badge>Reviewed</Badge> : <button className="text-button" onClick={()=>onReview(a.id)}>Mark reviewed</button>}</div></article>)}{!alerts.length && <div className="empty-state"><Icon name="check"/><p>No active alerts.</p></div>}</div>
      : alerts.length ? <button className={`alert-summary ${alerts[0].kind}`} onClick={onOpen}><Icon name="alert"/><span><strong>{alerts[0].title}</strong><small>{alerts[0].kind==='danger' ? 'Protection requires attention' : 'Maintenance recommended'}</small></span></button> : <p className="all-clear"><Icon name="check" size={16}/>No active battery alerts</p>}
  </Panel>;
}

function OLED({ state }) {
  const firstZero = state.zeroVoltageCells?.[0];
  return <div className="oled" aria-label="Local OLED display preview"><span>SOC: {percent(state.soc).padEnd(4)} DIR: {state.direction}</span><span>REL: {state.relays.filter(relayIsOn).length}/14 ON</span><span>{firstZero ? `CELL ${String(firstZero).padStart(2,'0')}: 0V/OFF` : state.weakCells.length ? `CELL ${String(state.weakCells[0]).padStart(2,'0')}: LOW` : Number.isFinite(state.soc) ? 'BATTERY: OK' : 'WAITING FOR DATA'}</span></div>;
}

function VehiclePanel({ state, large = false }) {
  const alerts = getAlerts(state), known = Number.isFinite(state.soc);
  return <Panel title="Vehicle & Local Display" icon="car" className={`vehicle-panel ${large ? 'vehicle-large' : ''}`}>
    <div className="vehicle-layout"><Robot large={large}/><div className="vehicle-info"><strong>4-wheel vehicle</strong><p><i className={`dot ${state.vehicle.connected ? 'green' : 'muted'}`}/>{state.vehicle.connected ? 'Battery connected' : 'Battery disconnected'}</p><p><i className={`dot ${state.direction!=='S'&&state.connection==='connected'?'green':'muted'}`}/>Vehicle movement: <b>{state.vehicle.status}</b></p><div className="local-displays"><div><label>OLED Display (preview)</label><OLED state={state}/></div><div className="led-status"><label>LED Status</label><span><i className={`dot ${known ? 'green' : 'muted'}`}/>Power</span><span><i className={`dot ${state.connection==='connected' ? 'green' : 'muted'}`}/>Link</span><span><i className={`dot ${alerts.length ? 'amber' : 'muted'}`}/>Alert</span></div></div></div></div>
  </Panel>;
}

const DIRECTIONS = [
  { code: 'F', label: 'Forward', symbol: '↑', area: 'forward' },
  { code: 'L', label: 'Left', symbol: '←', area: 'left' },
  { code: 'S', label: 'Stop', symbol: '■', area: 'stop' },
  { code: 'R', label: 'Right', symbol: '→', area: 'right' },
  { code: 'B', label: 'Backward', symbol: '↓', area: 'backward' }
];
const directionName = code => DIRECTIONS.find(item => item.code === code)?.label || code;
const MOVEMENT = {
  F: { label: 'Moving Forward', symbol: '↑' },
  B: { label: 'Moving Backward', symbol: '↓' },
  L: { label: 'Turning Left', symbol: '←' },
  R: { label: 'Turning Right', symbol: '→' },
  S: { label: 'Stopped', symbol: '■' }
};

function Joystick({ direction, disabled, onCommand, holdHandlers }) {
  return <div className="joystick" aria-label="Vehicle direction controls">
    {DIRECTIONS.map(item => <button
      type="button" key={item.code} className={`joystick-button ${item.area} ${direction===item.code?'active':''}`}
      aria-label={item.label} aria-pressed={direction===item.code} disabled={disabled}
      onClick={holdHandlers ? undefined : () => onCommand(item.code)}
      onPointerDown={holdHandlers ? event => holdHandlers.start(item.code, event) : undefined}
      onPointerUp={holdHandlers ? event => holdHandlers.stop(item.code, event) : undefined}
      onPointerCancel={holdHandlers ? event => holdHandlers.stop(item.code, event) : undefined}
      onKeyDown={holdHandlers ? event => { if (!event.repeat && (event.key==='Enter'||event.key===' ')) { event.preventDefault(); holdHandlers.start(item.code, event); } } : undefined}
      onKeyUp={holdHandlers ? event => { if (event.key==='Enter'||event.key===' ') { event.preventDefault(); holdHandlers.stop(item.code, event); } } : undefined}
    ><strong>{item.symbol}</strong><span>{item.label}</span></button>)}
  </div>;
}

function VehicleControl({ state, busy, setDirection, saveRoute, deleteRoute, notify }) {
  const [mode, setMode] = useState('manual');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [running, setRunning] = useState(null);
  const active = useRef(null);
  const runToken = useRef(0);

  const stopActive = useCallback(() => {
    if (!active.current) return;
    const item = active.current;
    active.current = null;
    const duration = Math.max(100, Math.min(120000, Date.now() - item.startedAt));
    setSteps(current => [...current, { direction: item.direction, duration }]);
    setDirection('S');
  }, [setDirection]);

  const holdHandlers = {
    start(code, event) {
      if (!recording || running) return;
      if (active.current) stopActive();
      if (event?.pointerId !== undefined) event.currentTarget?.setPointerCapture?.(event.pointerId);
      active.current = { direction: code, startedAt: Date.now() };
      setDirection(code);
    },
    stop(code) {
      if (active.current?.direction === code) stopActive();
    }
  };

  const play = useCallback(async (route, kind = 'route') => {
    if (!route.steps.length) { notify('Add at least one recorded direction.', 'error'); return; }
    const token = ++runToken.current;
    setRunning(kind === 'test' ? 'test' : route.id);
    try {
      for (const step of route.steps) {
        if (runToken.current !== token) break;
        const sent = await setDirection(step.direction);
        if (!sent) break;
        await new Promise(resolve => setTimeout(resolve, step.duration));
      }
    } finally {
      await setDirection('S');
      if (runToken.current === token) setRunning(null);
    }
  }, [notify, setDirection]);

  const stopRun = () => { runToken.current += 1; setRunning(null); setDirection('S'); };
  const beginRecording = () => {
    if (!name.trim()) { notify('Enter a direction route name first.', 'error'); return; }
    if (state.connection !== 'connected') { notify('Connect to Firebase before recording a route.', 'error'); return; }
    setSteps([]); setRecording(true); setDirection('S');
  };
  const newRoute = () => { stopRun(); setName(''); setSteps([]); setEditingId(null); setRecording(false); };
  const finishRecording = () => { stopActive(); setRecording(false); setDirection('S'); };
  const persist = async () => {
    if (!name.trim() || !steps.length) { notify('Enter a name and record at least one direction.', 'error'); return; }
    const id = await saveRoute({ id: editingId, name, steps });
    if (id) { setEditingId(id); setRecording(false); }
  };
  const edit = route => { stopRun(); setMode('auto'); setName(route.name); setSteps(route.steps); setEditingId(route.id); setRecording(false); };
  const remove = route => { if (window.confirm(`Delete “${route.name}”?`)) deleteRoute(route.id); };
  const changeMode = next => { stopRun(); setRecording(false); active.current = null; setMode(next); };

  return <Panel title="Direction Control" icon="car" className="direction-panel" action={<Badge type={mode==='manual'?'normal':'demo'}>{mode.toUpperCase()}</Badge>}>
    <div className="mode-tabs" role="tablist" aria-label="Direction mode"><button className={mode==='manual'?'active':''} onClick={()=>changeMode('manual')}>Manual</button><button className={mode==='auto'?'active':''} onClick={()=>changeMode('auto')}>Auto routes</button></div>
    <div className="direction-live"><span>Firebase: <code>Vehicle/Direction</code></span><strong>{state.direction} · {directionName(state.direction)}</strong></div>
    {mode==='manual' ? <><p className="control-help">Click a direction. The vehicle keeps that command until another direction or Stop is selected.</p><Joystick direction={state.direction} disabled={busy||state.connection!=='connected'} onCommand={setDirection}/></> : <div className="route-builder">
      <label className="route-name">Direction name<input value={name} maxLength={80} disabled={recording||Boolean(running)} onChange={event=>setName(event.target.value)} placeholder="Example: Warehouse loop"/></label>
      <div className="recorder-toolbar"><button className="button primary" disabled={recording||Boolean(running)} onClick={beginRecording}>{editingId?'Re-record route':'Start recording'}</button><button className="button outline" disabled={!recording} onClick={finishRecording}>Finish recording</button>{editingId&&<button className="button outline" disabled={recording||Boolean(running)} onClick={newRoute}>New route</button>}</div>
      <p className="control-help">{recording?'Press and hold each joystick button. Release it to save that direction and its exact duration.':'Enter a name, record the route, test it, then save it.'}</p>
      <Joystick direction={state.direction} disabled={!recording||Boolean(running)||state.connection!=='connected'} onCommand={setDirection} holdHandlers={holdHandlers}/>
      <div className="step-list">{steps.map((step,index)=><div key={`${index}-${step.direction}`}><span>{index+1}</span><strong>{directionName(step.direction)}</strong><time>{(step.duration/1000).toFixed(2)} s</time><button aria-label={`Remove step ${index+1}`} onClick={()=>setSteps(current=>current.filter((_,i)=>i!==index))}>×</button></div>)}{!steps.length&&<p>No directions recorded yet.</p>}</div>
      <div className="route-actions"><button className="button outline" disabled={!steps.length||recording||Boolean(running)} onClick={()=>play({steps},'test')}><Icon name="play" size={14}/>Test before saving</button><button className="button primary" disabled={!steps.length||recording||Boolean(running)||busy} onClick={persist}>{editingId?'Update route':'Save route'}</button>{running&&<button className="button danger-button" onClick={stopRun}><Icon name="stop" size={13}/>Stop run</button>}</div>
      <div className="saved-routes"><h3>Saved Firebase routes</h3>{state.routes.map(route=><article key={route.id}><div><strong>{route.name}</strong><small>{route.steps.length} steps · {(route.steps.reduce((sum,step)=>sum+step.duration,0)/1000).toFixed(1)} s</small></div><div><button className="text-button" disabled={Boolean(running)} onClick={()=>play(route)}>Run</button><button className="text-button" disabled={Boolean(running)} onClick={()=>edit(route)}>Edit</button><button className="text-button delete" disabled={Boolean(running)} onClick={()=>remove(route)}>Delete</button></div></article>)}{!state.routes.length&&<p className="muted-text">No saved routes.</p>}</div>
    </div>}
  </Panel>;
}

function Trend({ cycles }) {
  const counts = cycles.map(c=>c.weakCells.length);
  const max = Math.max(1,...counts);
  const points = counts.map((count,i)=>`${10+i*110/Math.max(1,counts.length-1)},${42-count/max*30}`).join(' ');
  return <div className="degradation"><label>Degradation trend</label><svg viewBox="0 0 130 64" aria-label="Number of weak cells per recorded cycle" role="img"><path d="M10 6V45H123" stroke="#d9e3ef" fill="none"/>{counts.length>0 ? <><polygon points={`10,45 ${points} 120,45`} fill="#fff1cc"/><polyline points={points} stroke="#eea000" strokeWidth="2" fill="none"/>{counts.map((c,i)=><circle key={i} cx={10+i*110/Math.max(1,counts.length-1)} cy={42-c/max*30} r="2.8" fill="white" stroke="#eea000"/>)}</> : <text x="66" y="28" textAnchor="middle" fontSize="9" fill="#6a819a">No records</text>}<text x="66" y="60" textAnchor="middle" fontSize="8" fill="#6a819a">Weak cells / cycle</text></svg></div>;
}

function HistoricalDataPanel({ history }) {
  const records = [...history].reverse().slice(0, 30);
  return <Panel title="Firebase Historical Health Data" icon="clock" className="history-panel" action={<Badge>{history.length} records</Badge>}>
    <div className="table-scroll"><table className="history-table"><thead><tr><th>Date & time</th><th>Pack health</th><th>Lowest</th><th>Highest battery</th><th>Condition details</th></tr></thead><tbody>{records.map((record,index)=>{
      const analysis=analyzeVoltages(record.cells), health=batteryHealthFromVoltages(record.cells);
      const problems=[
        health.zeroVoltageCells.length&&`No voltage: ${health.zeroVoltageCells.map(cellLabel).join(', ')}`,
        health.lowVoltageCells.length&&`Low: ${health.lowVoltageCells.map(cellLabel).join(', ')}`,
        health.overVoltageCells.length&&`High: ${health.overVoltageCells.map(cellLabel).join(', ')}`
      ].filter(Boolean).join(' · ')||'All batteries within configured voltage range';
      return <tr key={record.id||`${record.time}-${index}`}><td>{new Date(record.time).toLocaleString()}</td><td><Badge type={health.batteryStatus==='OK'?'normal':health.batteryStatus==='Unknown'?'demo':'warning'}>{health.batteryStatus}</Badge></td><td>{Number.isFinite(analysis.lowestVoltage)?`${analysis.lowestVoltage.toFixed(3)} V`:'—'}</td><td>{analysis.highestCells.length?`${analysis.highestCells.map(cellLabel).join(', ')} (${analysis.highestVoltage.toFixed(3)} V)`:'—'}</td><td>{problems}</td></tr>;
    })}</tbody></table>{!records.length&&<p className="empty-table">No Firebase history is available yet. A voltage snapshot is saved once per minute.</p>}</div>
  </Panel>;
}

function PredictionPanel({ state, history = state.history }) {
  const predictions = predictVoltageConditions(history);
  return <Panel title="AI Voltage Suggestions & 30-Minute Prediction" icon="heart" className="prediction-panel">
    <p className="prediction-note">Predictions use the recorded voltage trend. Safety decisions must use the current measured voltage and qualified inspection.</p>
    <div className="table-scroll"><table className="prediction-table"><thead><tr><th>Battery</th><th>Current</th><th>Trend</th><th>Predicted</th><th>Predicted condition</th><th>Suggested action</th></tr></thead><tbody>{predictions.map(item=><tr key={item.number} className={item.condition==='Normal'?'':'attention-row'}><td>{cellLabel(item.number)}</td><td>{Number.isFinite(item.currentVoltage)?`${item.currentVoltage.toFixed(3)} V`:'—'}</td><td>{item.trend}</td><td>{Number.isFinite(item.projectedVoltage)?`${item.projectedVoltage.toFixed(3)} V`:'—'}</td><td><Badge type={item.condition==='Normal'?'normal':item.condition==='Unknown'?'demo':'warning'}>{item.condition}</Badge></td><td>{item.suggestion}</td></tr>)}</tbody></table></div>
  </Panel>;
}

function ReportPanel({ state, onExport, onOpen, expanded = false }) {
  return <Panel title="Performance Reports" icon="report" className={`reports-panel ${expanded ? 'reports-large' : ''}`}>
    <div className="report-content"><div className="table-scroll"><table className="cycle-table"><thead><tr><th>Cycle</th>{expanded&&<><th>Date</th><th>Voltage range</th><th>Charge</th><th>Discharge</th></>}<th>Health</th></tr></thead><tbody>{state.cycles.map(c=><tr key={c.id}><td>{c.id}</td>{expanded&&<><td>{new Date(c.date).toLocaleDateString()}</td><td>{c.min.toFixed(2)}–{c.max.toFixed(2)} V</td><td>{c.charge} min</td><td>{c.discharge} min</td></>}<td><i className={`dot ${c.weakCells.length ? 'amber' : 'green'}`}/>{c.health}</td></tr>)}</tbody></table>{!state.cycles.length&&<p className="muted-text">No cycle records available.</p>}</div><Trend cycles={state.cycles}/></div>
    <p className="report-caption">Firebase history • Voltage prediction • Battery health • Suggested actions</p><button className="button primary full-width" onClick={onExport}><Icon name="report" size={17}/>Generate PDF Report</button>{expanded&&<p className="muted-text report-note">The PDF includes current conditions for all 14 batteries, historical Firebase records, voltage predictions, and maintenance suggestions.</p>}
  </Panel>;
}

function Metrics({ state }) {
  const known = Number.isFinite(state.soc), weak = state.weakCells.length, zero = state.zeroVoltageCells?.length || 0;
  const movement = state.connection === 'connected' ? MOVEMENT[state.direction] || MOVEMENT.S : null;
  const moving = movement && state.direction !== 'S';
  return <div className="metrics-grid">
    <article className="metric"><Icon name="battery" className="metric-icon"/><div><h2>State of Charge</h2><strong>{percent(state.soc)}</strong><div className="progress"><span style={{width:`${state.soc || 0}%`}}/></div></div></article>
    <article className="metric"><Icon name="discharge" className="metric-icon blue"/><div><h2>State of Discharge</h2><strong>{percent(known ? 100-state.soc : null)}</strong><div className="progress blue-track"><span style={{width:`${known ? 100-state.soc : 0}%`}}/></div></div></article>
    <article className="metric balance-metric"><Icon name="balance" className="metric-icon"/><div><h2>Relay Protection</h2><strong>{!known ? '—' : state.automatic ? 'AUTO' : 'PAUSED'}</strong><p>{!known ? 'Waiting for data' : `${state.relays.filter(relayIsOn).length}/14 relays on`}</p></div></article>
    <article className={`metric health-metric ${zero ? 'fault-metric' : weak || state.batteryStatus==='Attention' ? 'warning-metric' : ''}`}><Icon name="heart" className="metric-icon"/><div><h2>Battery Status</h2><strong>{state.batteryStatus || (!known ? 'Unknown' : weak ? 'Attention' : 'OK')}</strong><p>{!known ? 'Waiting for data' : zero ? `${zero} zero-voltage batter${zero>1?'ies':'y'}; relay OFF` : weak ? `${weak} low-voltage batter${weak>1?'ies':'y'} detected` : state.batteryOk === true ? 'Calculated from all 14 voltages' : 'Check voltage readings'}</p></div></article>
    <article className={`metric movement-metric ${moving?'moving':'stopped'}`} aria-live="polite"><Icon name="car" className="metric-icon"/><div><h2>Vehicle Movement</h2><strong><span>{movement?.symbol || '•'}</span>{movement?.label || 'Unknown'}</strong><p>{movement ? `Firebase direction: ${state.direction}` : 'Waiting for vehicle status'}</p></div></article>
  </div>;
}

function ElectricalStatus({ state }) {
  const connected = state.connection === 'connected';
  const showStatus = value => connected && value && value !== 'UNKNOWN' ? value : 'Unknown';
  return <section className="electrical-status" aria-label="Live charging, discharging and current status">
    <div><span className="status-symbol current-symbol">A</span><p><label>Current</label><strong>{connected&&Number.isFinite(state.current)?`${state.current.toFixed(3)} A`:'—'}</strong></p></div>
    <div><span className={`dot ${showStatus(state.socStatus)==='CHARGING'?'green':'muted'}`}/><p><label>State of Charging</label><strong>{showStatus(state.socStatus)}</strong></p></div>
    <div><span className={`dot ${showStatus(state.sodStatus)==='DISCHARGING'?'amber':'muted'}`}/><p><label>State of Discharging</label><strong>{showStatus(state.sodStatus)}</strong></p></div>
  </section>;
}

function Events({ state }) {
  return <Panel title="Relay Activity" icon="clock" className="events-panel"><div className="event-list">{state.events.map((e,i)=><div key={`${e.time}-${i}`}><span className="dot green"/><time>{new Date(e.time).toLocaleTimeString()}</time><p>{e.text}</p></div>)}{!state.events.length&&<p className="muted-text">No automatic relay changes recorded.</p>}</div></Panel>;
}

function CellModal({ number, state, onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  useEffect(()=>{
    const previous = document.activeElement;
    closeButton.current?.focus();
    const onKey = e => {
      if(e.key==='Escape') onClose();
      if(e.key==='Tab') {
        const items=[...dialog.current.querySelectorAll('button, [href], input, select, [tabindex="0"]')].filter(el=>!el.disabled);
        const first=items[0],last=items.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow='hidden';
    document.addEventListener('keydown',onKey);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',onKey);previous?.focus();};
  },[onClose]);
  const voltage=state.cells[number-1], weak=state.weakCells.includes(number), zero=state.zeroVoltageCells?.includes(number), over=state.overVoltageCells?.includes(number);
  const condition=zero?'No voltage':weak?'Low':over?'High':Number.isFinite(voltage)?'Normal':'Unknown';
  return <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><section className="cell-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cell-title"><div className="dialog-top"><h2 id="cell-title">{cellLabel(number)} Details</h2><button ref={closeButton} className="icon-button" onClick={onClose} aria-label="Close cell details"><Icon name="close"/></button></div><div className="cell-summary"><strong>{Number.isFinite(voltage)?voltage.toFixed(3):'—'} <small>V</small></strong><Badge type={condition==='Normal'?'normal':condition==='Unknown'?'demo':'warning'}>{condition}</Badge></div><VoltagePanel state={state} onlyCell={number} expanded/><div className={`dialog-suggestion ${condition==='Normal'?'normal':''}`}><Icon name={condition==='Normal'?'check':'alert'}/><div><strong>AI suggestion</strong><p>{voltageSuggestion(condition,number)}</p></div></div></section></div>;
}

function safetyConditions(state) {
  if (state.connection !== 'connected') return [];
  const over = state.cells.flatMap((value, index) => Number.isFinite(value) && value > MAX_SAFE_VOLTAGE ? [index + 1] : []);
  const low = state.cells.flatMap((value, index) => Number.isFinite(value) && value < LOW_VOLTAGE ? [index + 1] : []);
  const conditions = [];
  if (over.length) {
    const peak = Math.max(...over.map(number => state.cells[number - 1]));
    conditions.push({ type: 'over-voltage', value: `${peak.toFixed(2)} V`, detail: `${over.map(cellLabel).join(', ')} ${over.length === 1 ? 'is' : 'are'} above ${MAX_SAFE_VOLTAGE.toFixed(1)} V. Stop charging and inspect the battery pack.` });
  }
  if (low.length) {
    const minimum = Math.min(...low.map(number => state.cells[number - 1]));
    conditions.push({ type: 'low-voltage', value: `${minimum.toFixed(2)} V`, detail: `${low.map(cellLabel).join(', ')} ${low.length === 1 ? 'is' : 'are'} below ${LOW_VOLTAGE.toFixed(1)} V. The matching relay protection will switch off.` });
  }
  return conditions;
}

export default function App() {
  const [tab,setTab]=useState('overview'), [mobile,setMobile]=useState(false), [cell,setCell]=useState(null), [toast,setToast]=useState(null), [range,setRange]=useState('60');
  const [safetyAlerts,setSafetyAlerts]=useState([]);
  const activeSafetyTypes=useRef(new Set());
  const [reviewed,setReviewed]=useState(()=>{try{const value=JSON.parse(localStorage.getItem('bms-reviewed-alerts')||'[]');return Array.isArray(value)?value.filter(v=>typeof v==='string'):[];}catch{return [];}});
  const toastTimer=useRef(null);
  const notify=useCallback((message,type='success')=>{clearTimeout(toastTimer.current);setToast({message,type});toastTimer.current=setTimeout(()=>setToast(null),5000);},[]);
  useEffect(()=>()=>clearTimeout(toastTimer.current),[]);
  const {state,busy,setDirection,setRelayAutomation,saveRoute,deleteRoute}=useBattery(notify);
  useEffect(()=>{
    const current=safetyConditions(state);
    const currentTypes=new Set(current.map(alert=>alert.type));
    const newlyActive=current.filter(alert=>!activeSafetyTypes.current.has(alert.type));
    activeSafetyTypes.current=currentTypes;
    setSafetyAlerts(existing=>{
      const latestByType=new Map(current.map(alert=>[alert.type,alert]));
      const retained=existing.filter(alert=>currentTypes.has(alert.type)).map(alert=>latestByType.get(alert.type));
      const queued=new Set(retained.map(alert=>alert.type));
      const additions=newlyActive.filter(alert=>!queued.has(alert.type));
      return [...retained,...additions];
    });
  },[state.cells,state.connection]);
  const closeCell=useCallback(()=>setCell(null),[]);
  const selectedHistory=state.history.filter(p=>range==='session'||p.time>=state.updatedAt-Number(range)*60000);
  const exportPdf=()=>{try{downloadReport(state,tab==='reports'?selectedHistory:state.history);notify('PDF report downloaded.');}catch{notify('The PDF report could not be generated.','error');}};
  const navigate=key=>{setTab(key);setMobile(false);window.scrollTo({top:0,behavior:'smooth'});};
  const review=id=>{setReviewed(previous=>{const next=[...new Set([...previous,id])];try{localStorage.setItem('bms-reviewed-alerts',JSON.stringify(next));}catch{}return next;});notify('Alert marked reviewed. Its active warning remains visible.');};
  const known=Number.isFinite(state.soc), goodCells=state.cells.filter(Number.isFinite), voltageAnalysis=analyzeVoltages(state.cells);
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),3000);return()=>clearInterval(timer);},[]);

  return <div className="app-shell">
    {mobile&&<button className="sidebar-backdrop" aria-label="Close navigation" onClick={()=>setMobile(false)}/>}
    <aside className={`sidebar ${mobile?'open':''}`}><div className="brand"><div className="brand-battery"><Icon name="battery" size={52}/></div><span>BMS</span></div><nav aria-label="Main navigation">{NAV.map(([key,icon,label])=><button key={key} className={tab===key?'active':''} aria-current={tab===key?'page':undefined} onClick={()=>navigate(key)}><Icon name={icon} size={25}/><span>{label}</span></button>)}</nav><div className="sidebar-footer">BMS Monitor</div></aside>
    <main className="main-content"><header className="topbar"><div className="title-area"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={()=>setMobile(true)}><Icon name="menu"/></button><div><h1>{tab==='overview'?'Battery Management Dashboard':NAV.find(n=>n[0]===tab)[2]}</h1><p>14 cells <span>|</span> 24V nominal <span>|</span> 4400mAh</p></div></div><div className="header-actions"><span className="connection" title={state.mode==='demo'?'Demo simulation is running':`Device telemetry: ${state.connection}`}><i className={`dot ${state.connection==='connected'?'green':state.connection==='connecting'?'amber':'red'}`}/>{state.connection==='connected'?'Connected':state.connection==='connecting'?'Connecting':state.connection==='stale'?'Stale data':'Offline'}</span><Badge type={state.mode==='demo'?'demo':'normal'}>{state.mode==='demo'?'DEMO DATA':'LIVE DATA'}</Badge><button className="button export-button" onClick={exportPdf}><Icon name="report" size={19}/>Export PDF</button></div></header>
    <Metrics state={state}/><ElectricalStatus state={state}/>

    {tab==='overview'&&<div className="overview-grid">
      <Panel title="Individual Cell Voltages" icon="cells" className="cells-panel"><CellGrid state={state} onSelect={setCell}/><CellWarning state={state} onSelect={setCell}/></Panel>
      <RelayControls state={state} setAutomation={setRelayAutomation} busy={busy}/>
      <Panel title="3D Cell Charge Levels" icon="battery" className="cells3d-panel" action={<Badge>Firebase values</Badge>}><Cells3D values={state.cells} onSelect={setCell}/></Panel>
      <div className="charts-row"><VoltagePanel state={state}/><CyclePanel state={state}/></div>
      <div className="bottom-row"><ProtectionPanel state={state} onOpen={()=>navigate('protection')}/><VehiclePanel state={state}/><ReportPanel state={state} onExport={exportPdf}/></div>
    </div>}

    {tab==='cells'&&<div className="page-stack"><Panel title="Individual Cell Voltages" icon="cells" action={<Badge>{state.cells.length} cells</Badge>}><CellGrid state={state} onSelect={setCell} expanded/><CellWarning state={state} onSelect={setCell}/></Panel><Panel title="3D Cell Charge Levels" icon="battery" action={<Badge>Firebase values</Badge>}><Cells3D values={state.cells} onSelect={setCell}/></Panel><div className="stat-strip"><div><label>Highest battery</label><strong>{voltageAnalysis.highestCells.length?voltageAnalysis.highestCells.map(cellLabel).join(', '):'—'}</strong><small>{Number.isFinite(voltageAnalysis.highestVoltage)?`${voltageAnalysis.highestVoltage.toFixed(3)} V`:'Voltage unavailable'}</small></div><div><label>Lowest cell voltage</label><strong>{goodCells.length?Math.min(...goodCells).toFixed(3):'—'} V</strong></div><div><label>Cell voltage difference</label><strong>{goodCells.length?cellSpread(goodCells).toFixed(3):'—'} V</strong></div><div><label>Cells requiring inspection</label><strong>{known?[...(state.weakCells||[]),...(state.overVoltageCells||[])].filter((value,index,list)=>list.indexOf(value)===index).length:'—'}</strong></div></div><PredictionPanel state={state}/><VoltagePanel state={state} expanded/></div>}

    {tab==='balancing'&&<div className="page-stack"><div className="two-column"><RelayControls state={state} setAutomation={setRelayAutomation} busy={busy} large/><Events state={state}/></div><Panel title="Voltage-to-Relay Overview" icon="balance"><CellGrid state={state} onSelect={setCell}/><CellWarning state={state} onSelect={setCell}/><p className="muted-text panel-note">Voltage difference: {goodCells.length?cellSpread(goodCells).toFixed(3)+' V':'Unavailable'} · {state.automatic?'Automatic relay protection enabled':'Automatic relay protection paused'}</p></Panel><VoltagePanel state={state} expanded/></div>}

    {tab==='protection'&&<div className="page-stack"><ProtectionPanel state={state} extended reviewed={reviewed} onReview={review}/><PredictionPanel state={state}/><Panel title="Cell Voltage Protection" icon="cells"><CellGrid state={state} onSelect={setCell}/><CellWarning state={state} onSelect={setCell}/><p className="muted-text panel-note">Alerts activate below {LOW_VOLTAGE.toFixed(1)} V or above {MAX_SAFE_VOLTAGE.toFixed(1)} V. A 0 V reading always forces the matching relay OFF.</p></Panel></div>}

    {tab==='vehicle'&&<div className="page-stack"><VehicleControl state={state} busy={busy} setDirection={setDirection} saveRoute={saveRoute} deleteRoute={deleteRoute} notify={notify}/><div className="two-column"><VehiclePanel state={state} large/><Panel title="Vehicle Battery Monitoring" icon="battery"><div className="vehicle-reading"><BatteryGauge soc={state.soc} charging={state.chargingStatus==='Charging'}/><dl><div><dt>State of charge</dt><dd>{percent(state.soc)}</dd></div><div><dt>State of discharge</dt><dd>{percent(known?100-state.soc:null)}</dd></div><div><dt>Current</dt><dd>{Number.isFinite(state.current)?`${state.current.toFixed(3)} A`:'—'}</dd></div><div><dt>Charging state</dt><dd>{state.socStatus}</dd></div><div><dt>Discharging state</dt><dd>{state.sodStatus}</dd></div><div><dt>Direction</dt><dd>{state.direction} · {directionName(state.direction)}</dd></div><div><dt>Battery status</dt><dd>{state.batteryStatus || 'Unknown'}</dd></div></dl></div></Panel></div><VoltagePanel state={state} expanded/><ProtectionPanel state={state} onOpen={()=>navigate('protection')}/></div>}

    {tab==='reports'&&<div className="page-stack"><div className="report-toolbar"><div><h2>Battery performance & health</h2><p>Review Firebase voltage history, health conditions, predictions, and suggested actions.</p></div><label>Voltage history <select value={range} onChange={e=>setRange(e.target.value)}><option value="60">Last 60 minutes</option><option value="15">Last 15 minutes</option><option value="1440">Last 24 hours</option><option value="session">All Firebase history</option></select></label></div><ReportPanel state={state} onExport={exportPdf} expanded/><HistoricalDataPanel history={selectedHistory}/><PredictionPanel state={state} history={selectedHistory}/><VoltagePanel state={state} history={selectedHistory} expanded/><CyclePanel state={state} expanded/></div>}

    <footer className="app-footer"><span><i className="dot green"/>Firebase Realtime Database · BMS_5580</span><span>{known?`Updated ${Math.max(0,Math.floor((clock-state.updatedAt)/1000))}s ago`:'Waiting for battery telemetry'}</span></footer>
    </main>
    {safetyAlerts[0]&&<SafetyAlert3D alert={safetyAlerts[0]} onClose={()=>setSafetyAlerts(current=>current.slice(1))}/>} 
    {cell&&<CellModal number={cell} state={state} onClose={closeCell}/>}
    {toast&&<div className={`toast ${toast.type}`} role="status" aria-live="polite"><Icon name={toast.type==='error'?'alert':'check'} size={20}/><span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={()=>setToast(null)}><Icon name="close" size={17}/></button></div>}
  </div>;
}
