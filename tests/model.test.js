import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyDemoCommand, tickDemo, applyTelemetry, validateTelemetry, cellSpread, getAlerts } from '../src/lib/model.js';
import { makeReportPdf } from '../src/lib/exportPdf.js';
import { analyzeVoltages, applyFirebaseEvent, batteryHealthFromVoltages, batterySocFromVoltages, firebaseSnapshotToTelemetry, historyRecord, MAX_SAFE_VOLTAGE, normalizeHistory, normalizeSteps, predictVoltageConditions, relayTargets, voltageToSoc } from '../src/lib/firebaseRtdb.js';

const now = 1791263400000;
const telemetry = () => ({
  type: 'telemetry', cells: Array(14).fill(4.05), soc: 65,
  automatic: false, balancing: false, weakCells: [8], chargingStatus: 'Idle',
  protection: { overvoltage: false, undervoltage: false, shortCircuit: false, cutoff: false },
  vehicle: { connected: true, status: 'Stationary' }
});

test('reference state contains fourteen stable cells, SOC/SOD and the weak-cell warning', () => {
  const s=createInitialState(now);
  assert.equal(s.cells.length,14); assert.equal(s.cells[7],3.86);
  assert.equal(s.soc,78); assert.equal(100-s.soc,22);
  assert.deepEqual(s.weakCells,[8]); assert.equal(s.history.length,61);
  assert.match(getAlerts(s)[0].title,/Cell 08/);
  assert.ok(Math.abs(cellSpread(s.cells)-0.21)<1e-9);
});

test('stopping balancing also disables automatic restart, and ticks preserve the stop', () => {
  const stopped=applyDemoCommand(createInitialState(now),{command:'set_balancing',enabled:false},now+1);
  assert.equal(stopped.balancing,false); assert.equal(stopped.automatic,false);
  const later=tickDemo(stopped,now+2000);
  assert.equal(later.balancing,false); assert.equal(later.automatic,false);
  assert.match(later.events[0].text,/stopped/);
});

test('manual and automatic balancing commands change demo state independently', () => {
  let s=applyDemoCommand(createInitialState(now),{command:'set_automatic',enabled:false},now);
  s=applyDemoCommand(s,{command:'set_balancing',enabled:true},now);
  assert.equal(s.balancing,true); assert.equal(s.automatic,false);
  s=applyDemoCommand(s,{command:'set_automatic',enabled:true},now);
  assert.equal(s.automatic,true); assert.equal(s.balancing,true);
});

test('live mode never applies simulated control state', () => {
  const s={...createInitialState(now),mode:'live'};
  assert.equal(applyDemoCommand(s,{command:'set_balancing',enabled:false}),s);
  assert.equal(tickDemo(s,now+2000),s);
});

test('ticks retain at most sixty minutes of history and respect the SOC boundary', () => {
  const s=tickDemo({...createInitialState(now),soc:0.001},now+3600001);
  assert.equal(s.soc,0);
  assert.ok(s.history.every(p=>p.time>=now+1));
});

test('valid telemetry supplies real device status without inferring protection thresholds', () => {
  const p=telemetry(); p.protection.shortCircuit=true; p.protection.cutoff=true;
  const s=applyTelemetry(createInitialState(now),p,now+2000);
  assert.equal(s.mode,'live'); assert.equal(s.soc,65); assert.equal(s.protection.cutoff,true);
  assert.equal(getAlerts(s).filter(a=>a.kind==='danger').length,2);
  p.cells[0]=0;
  assert.equal(s.cells[0],4.05,'state owns a copy of the readings');
});

test('bad telemetry cannot create missing cells, invalid SOC or invalid weak-cell identifiers', () => {
  const variants=[
    {...telemetry(),cells:[4.05]}, {...telemetry(),cells:Array(14).fill(NaN)},
    {...telemetry(),soc:101}, {...telemetry(),weakCells:[15]},
    {...telemetry(),automatic:'true'}, {...telemetry(),protection:{}},
    {...telemetry(),chargingStatus:'invented'}, {...telemetry(),vehicle:{connected:'yes',status:'Stationary'}}
  ];
  for(const p of variants) assert.throws(()=>validateTelemetry(p));
});

test('stale telemetry adds an alert without removing an active battery fault', () => {
  const s={...createInitialState(now),mode:'live',connection:'stale',protection:{overvoltage:true,undervoltage:false,shortCircuit:false,cutoff:true}};
  const alerts=getAlerts(s);
  assert.ok(alerts.some(a=>a.id==='connection')); assert.ok(alerts.some(a=>a.id==='overvoltage'));
});

test('PDF is an actual four-page document with health predictions, suggestions and exact byte offsets', () => {
  const bytes=makeReportPdf(createInitialState(now));
  const text=new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.endsWith('%%EOF'));
  assert.match(text,/\/Count 4/); assert.match(text,/DEMO DATA/); assert.match(text,/Cell 14/);
  assert.match(text,/All battery predictions and suggested actions/); assert.match(text,/Highest battery/);
  assert.doesNotMatch(text,/KS\d{4}|ks\d{4}|NaN|Infinity/);
  const xref=Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref,xref+4),'xref');
  const section=text.slice(xref).split('\n');
  const count=Number(section[1].split(' ')[1]);
  for(let i=1;i<count;i++) {
    const offset=Number(section[i+2].slice(0,10));
    assert.ok(text.slice(offset).startsWith(`${i} 0 obj`));
  }
});

test('PDF handles unavailable telemetry without presenting NaN values', () => {
  const s={...createInitialState(now),mode:'live',connection:'offline',cells:Array(14).fill(null),soc:null,weakCells:[],cycles:[],history:[]};
  const text=new TextDecoder().decode(makeReportPdf(s));
  assert.match(text,/Unavailable/); assert.match(text,/Unknown/);
  assert.doesNotMatch(text,/NaN|Infinity/);
});

test('Firebase voltage, relay, current and charge-state keys map correctly without temperature', () => {
  const Voltage={}, Relay={};
  for(let i=1;i<=14;i++){Voltage[`V${i}`]=i===10?2.9:3.8;Relay[`Relay${i}`]=1;}
  const state=firebaseSnapshotToTelemetry({Voltage,Relay,Temp:26.7,Current:0.74369,ChargingVoltage:12.4,SOC_Status:'NOT CHARGING',SOD_Status:'IDLE',Vehicle:{Direction:'L'}},{automatic:true});
  assert.equal(state.cells[9],2.9); assert.equal(state.relays[13],1);
  assert.deepEqual(state.weakCells,[10]); assert.equal(state.direction,'L');
  assert.equal(state.current,0.74369); assert.equal(state.chargingVoltage,12.4);
  assert.equal('temperature' in state,false);
  assert.equal(state.socStatus,'NOT CHARGING'); assert.equal(state.sodStatus,'IDLE');
  assert.equal(state.chargingStatus,'Idle');
});

test('requested voltage alert boundary is strict', () => {
  const atVoltage=batteryHealthFromVoltages(Array(14).fill(MAX_SAFE_VOLTAGE));
  assert.deepEqual(atVoltage.overVoltageCells,[]);
  const above=Array(14).fill(MAX_SAFE_VOLTAGE); above[2]=MAX_SAFE_VOLTAGE+0.01;
  assert.deepEqual(batteryHealthFromVoltages(above).overVoltageCells,[3]);
});

test('historical Firebase records retain voltages and health metadata', () => {
  const cells=Array(14).fill(3.5); cells[2]=2.8; cells[8]=3.9;
  const telemetry={...firebaseSnapshotToTelemetry({Voltage:Object.fromEntries(cells.map((value,index)=>[`V${index+1}`,value])),Relay:{}}),cells};
  const stored=historyRecord(telemetry,now);
  assert.deepEqual(stored.lowVoltageCells,[3]); assert.deepEqual(stored.highVoltageCells,[9]);
  assert.deepEqual(stored.highestCells,[9]);
  const [restored]=normalizeHistory({[Math.floor(now/60000)]:stored});
  assert.equal(restored.time,now); assert.deepEqual(restored.cells,cells);
});

test('all batteries receive a condition, highest marker and trend-based suggestion', () => {
  const earlier=Array(14).fill(3.0), latest=Array(14).fill(3.0);
  latest[0]=2.99; latest[1]=3.9; latest[2]=0;
  const analysis=analyzeVoltages(latest);
  assert.deepEqual(analysis.highestCells,[2]);
  assert.equal(analysis.cells[0].condition,'Low'); assert.equal(analysis.cells[1].condition,'High'); assert.equal(analysis.cells[2].condition,'No voltage');
  const predictions=predictVoltageConditions([{time:now-60000,cells:earlier},{time:now,cells:latest}]);
  assert.equal(predictions.length,14); assert.equal(predictions[0].trend,'Falling'); assert.match(predictions[0].suggestion,/reduce load/i);
});

test('relay automation cuts low cells, restores recovered cells, and holds in hysteresis band', () => {
  assert.deepEqual(relayTargets([2.99,3.05,3.11,null],[0,0,1,0]),[1,0,0,null]);
  assert.deepEqual(relayTargets([3.05],[null]),[1]);
});

test('zero voltage always cuts the matching relay even when automation is paused', () => {
  assert.deepEqual(relayTargets([3.4,0,3.8],[0,0,0],3.5,3.6,false),[null,1,null]);
  assert.deepEqual(relayTargets([0],[1],3.5,3.6,false),[1]);
});

test('battery OK is calculated only from a complete safe set of fourteen voltages', () => {
  const ok=batteryHealthFromVoltages(Array(14).fill(3.8));
  assert.equal(ok.batteryOk,true); assert.equal(ok.batteryStatus,'OK');
  const values=Array(14).fill(3.8); values[4]=0; values[8]=2.9; values[12]=4.3;
  const fault=batteryHealthFromVoltages(values);
  assert.equal(fault.batteryOk,false); assert.equal(fault.batteryStatus,'Fault');
  assert.deepEqual(fault.zeroVoltageCells,[5]); assert.deepEqual(fault.lowVoltageCells,[9]); assert.deepEqual(fault.overVoltageCells,[13]);
  assert.equal(batteryHealthFromVoltages([3.8]).batteryStatus,'Unknown');
});

test('pack SOC averages bounded per-battery estimates so one low reading has proportional impact', () => {
  assert.equal(voltageToSoc(0),0); assert.equal(voltageToSoc(4.0),100); assert.equal(voltageToSoc(3.4),85);
  const voltages=Array(14).fill(3.85); voltages[6]=3.12;
  const soc=batterySocFromVoltages(voltages);
  assert.ok(soc>94 && soc<96,`expected one reduced battery to have proportional impact, got ${soc}`);
  voltages[6]=0;
  assert.ok(batterySocFromVoltages(voltages)>89,'one 0 V battery should affect only one of fourteen SOC contributions');
});

test('the observed 3.33-3.40 V pack is healthy and estimates about eighty-four percent', () => {
  const voltages=[3.35,3.36,3.35,3.34,3.35,3.36,3.35,3.37,3.36,3.37,3.37,3.40,3.38,3.33];
  const soc=batterySocFromVoltages(voltages);
  assert.ok(soc>83 && soc<85,`expected screenshot readings near 84%, got ${soc}`);
  assert.equal(batteryHealthFromVoltages(voltages).batteryStatus,'OK');
  assert.deepEqual(relayTargets(voltages,Array(14).fill(1)),Array(14).fill(0));
});

test('Firebase zero-voltage readings produce a fault and a matching safety cutoff target', () => {
  const Voltage={}, Relay={};
  for(let i=1;i<=14;i++){Voltage[`V${i}`]=i===6?0:3.8;Relay[`Relay${i}`]=0;}
  const state=firebaseSnapshotToTelemetry({Voltage,Relay});
  assert.equal(state.batteryOk,false); assert.equal(state.batteryStatus,'Fault');
  assert.deepEqual(state.zeroVoltageCells,[6]); assert.ok(state.weakCells.includes(6));
  assert.equal(relayTargets(state.cells,state.relays)[5],1);
});

test('Firebase stream patches preserve siblings and route steps reject invalid commands', () => {
  const first={Voltage:{V1:3.8,V2:3.9},Relay:{Relay1:1,Relay2:1}};
  const next=applyFirebaseEvent(first,{type:'patch',path:'/Relay',data:{Relay1:0}});
  assert.deepEqual(next.Relay,{Relay1:0,Relay2:1}); assert.equal(next.Voltage.V2,3.9);
  assert.deepEqual(normalizeSteps([{direction:'f',duration:500},{direction:'S',duration:200},{direction:'X',duration:1000}]),[{direction:'F',duration:500},{direction:'S',duration:200}]);
});
