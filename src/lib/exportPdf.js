import { cellLabel, getAlerts } from './model.js';
import { analyzeVoltages, batteryHealthFromVoltages, predictVoltageConditions, voltageCondition } from './firebaseRtdb.js';

// Self-contained PDF writer. No external API, printer dialog or PDF dependency.
const clean = text => String(text ?? '').replace(/[^\x20-\x7e]/g, '-').replace(/([\\()])/g, '\\$1');

class Pdf {
  constructor() { this.pages = []; this.operations = []; }
  page() { this.operations = []; this.pages.push(this.operations); }
  text(x, y, value, size = 10, bold = false, color = [0.08, 0.17, 0.27]) {
    this.operations.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg 1 0 0 1 ${x} ${842-y} Tm (${clean(value)}) Tj ET`);
  }
  line(x1, y1, x2, y2, color = [0.83, 0.87, 0.9], width = 1) {
    this.operations.push(`${color.join(' ')} RG ${width} w ${x1} ${842-y1} m ${x2} ${842-y2} l S`);
  }
  rect(x, y, w, h, color) { this.operations.push(`${color.join(' ')} rg ${x} ${842-y-h} ${w} ${h} re f`); }
  finish() {
    const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
    const kids = [];
    for (const ops of this.pages) {
      const pageNumber = objects.length, streamNumber = pageNumber + 1;
      kids.push(`${pageNumber} 0 R`);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNumber} 0 R >>`);
      const stream = ops.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
    objects[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;
    let output = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i++) { offsets.push(output.length); output += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = output.length;
    output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
    output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(output);
  }
}

const voltage = v => Number.isFinite(v) ? `${v.toFixed(3)} V` : 'Unavailable';
const percentage = v => Number.isFinite(v) ? `${Math.round(v)}%` : 'Unavailable';

function header(pdf, state, title, number) {
  pdf.page();
  pdf.rect(0, 0, 595, 82, [0.08, 0.18, 0.29]);
  pdf.text(38, 32, 'Battery Performance Report', 18, true, [1, 1, 1]);
  pdf.text(38, 57, title, 11, false, [0.75, 0.89, 0.92]);
  pdf.text(38, 105, `Generated: ${new Date().toLocaleString()} | ${state.mode === 'demo' ? 'DEMO DATA' : 'LIVE TELEMETRY'}`, 9);
  pdf.text(38, 126, 'Pack specification: 14 cells | 24V nominal | 4400mAh', 10);
  pdf.line(38, 791, 557, 791);
  pdf.text(38, 811, state.mode === 'demo' ? 'Illustrative data. This report does not contain measured hardware results.' : `Connection status at export: ${state.connection}.`, 8);
  pdf.text(520, 811, `Page ${number}`, 8);
}

function graph(pdf, history, weakCells, top) {
  const left = 64, width = 470, height = 160;
  const ymin = 3.2, ymax = 4.4;
  pdf.text(38, top - 15, 'Individual cell voltage history', 14, true);
  const start = history[0]?.time || 0, duration = (history.at(-1)?.time || start) - start || 1;
  const x = t => left + (t-start) / duration * width;
  const y = v => top + height - (v-ymin) / (ymax-ymin) * height;
  for (const v of [3.2, 3.6, 4, 4.4]) { pdf.line(left, y(v), left+width, y(v)); pdf.text(38, y(v)+3, v.toFixed(1), 9); }
  pdf.line(left, top, left, top+height, [0.4, 0.5, 0.6]);
  pdf.line(left, top+height, left+width, top+height, [0.4, 0.5, 0.6]);
  for (let n = 0; n < 14; n++) {
    const color = weakCells.includes(n+1) ? [0.92, 0.58, 0] : [0, 0.64, 0.57];
    const step = Math.max(1, Math.floor(history.length / 180));
    const points = history.filter((_, i) => i % step === 0);
    for (let i = 1; i < points.length; i++) {
      const previous = points[i-1].cells?.[n], current = points[i].cells?.[n];
      if (Number.isFinite(previous) && Number.isFinite(current)) pdf.line(x(points[i-1].time), y(previous), x(points[i].time), y(current), color, 0.8);
    }
  }
  if (!history.length) pdf.text(205, top+80, 'No telemetry available.', 11);
  pdf.text(left, top+height+19, history.length ? new Date(start).toLocaleTimeString() : '-', 8);
  pdf.text(468, top+height+19, history.length ? new Date(history.at(-1).time).toLocaleTimeString() : '-', 8);
  pdf.text(left, top+height+38, 'Teal: normal cells     Amber: cells marked weak by the data source', 9);
}

export function makeReportPdf(state, history = state.history) {
  const pdf = new Pdf();
  const analysis = analyzeVoltages(state.cells);
  const predictions = predictVoltageConditions(history);
  const flagged = [...new Set([...(state.weakCells || []), ...(state.overVoltageCells || [])])];

  header(pdf, state, 'Current battery health and voltage conditions', 1);
  pdf.text(38, 165, `SOC: ${percentage(state.soc)}     SOD: ${percentage(Number.isFinite(state.soc) ? 100-state.soc : null)}     Charging status: ${state.chargingStatus}`, 11, true);
  pdf.text(38, 190, `Automatic balancing: ${state.automatic ? 'ON' : 'OFF'} | Balancing: ${state.balancing ? 'Active' : 'Stopped'}`, 10);
  pdf.text(38, 215, `Battery health: ${state.batteryStatus || 'Unknown'} | Batteries requiring inspection: ${flagged.length}`, 10);
  pdf.text(38, 234, `Highest battery: ${analysis.highestCells.length ? analysis.highestCells.map(cellLabel).join(', ') : 'Unavailable'}${Number.isFinite(analysis.highestVoltage) ? ` at ${analysis.highestVoltage.toFixed(3)} V` : ''}`, 10, true);
  pdf.rect(38, 250, 519, 26, [0.92, 0.96, 0.98]);
  pdf.text(48, 267, 'Battery', 10, true); pdf.text(185, 267, 'Voltage', 10, true); pdf.text(318, 267, 'Health condition', 10, true); pdf.text(475, 267, 'Highest', 10, true);
  state.cells.forEach((v, i) => {
    const y = 297 + i*22;
    const condition = voltageCondition(v);
    pdf.text(48, y, cellLabel(i+1), 10); pdf.text(185, y, voltage(v), 10);
    pdf.text(318, y, condition === 'No voltage' ? 'No voltage - relay OFF' : condition, 10);
    pdf.text(475, y, analysis.highestCells.includes(i+1) ? 'YES' : '-', 10, analysis.highestCells.includes(i+1));
    pdf.line(38, y+8, 557, y+8);
  });
  pdf.text(38, 630, 'Battery protection', 14, true);
  Object.entries({ overvoltage: 'Overvoltage', undervoltage: 'Undervoltage', shortCircuit: 'Short circuit', cutoff: 'Automatic cutoff' }).forEach(([key, label], i) => {
    const status = !Number.isFinite(state.soc) ? 'Unknown' : state.protection[key] ? 'ACTIVE' : key === 'cutoff' ? 'Inactive' : 'Clear';
    pdf.text(48, 656+i*22, `${label}: ${status}`, 10);
  });
  pdf.text(38, 758, 'Thresholds: low below 3.0 V | high above 3.8 V | 0 V forces relay OFF', 9);

  header(pdf, state, 'Firebase historical voltage and health evidence', 2);
  graph(pdf, history, flagged, 150);
  pdf.text(38, 367, `Historical samples included: ${history.length}`, 10);
  pdf.text(38, 397, 'Latest historical health records', 14, true);
  pdf.rect(38, 412, 519, 24, [0.92, 0.96, 0.98]);
  [['Date / time',48],['Health',185],['Lowest',265],['Highest battery',340],['Problems',465]].forEach(([label,x]) => pdf.text(x,428,label,8,true));
  const historyRows = [...history].reverse().slice(0, 10);
  if (!historyRows.length) pdf.text(48, 465, 'No Firebase historical records are available yet.', 10);
  historyRows.forEach((record, index) => {
    const rowAnalysis = analyzeVoltages(record.cells), health = batteryHealthFromVoltages(record.cells), y = 460 + index*29;
    const problems = [...health.zeroVoltageCells, ...health.lowVoltageCells, ...health.overVoltageCells];
    pdf.text(48,y,new Date(record.time).toLocaleString().slice(0,20),8);
    pdf.text(185,y,health.batteryStatus,8,true);
    pdf.text(265,y,voltage(rowAnalysis.lowestVoltage),8);
    pdf.text(340,y,rowAnalysis.highestCells.length ? `${rowAnalysis.highestCells.map(n=>String(n).padStart(2,'0')).join(',')} / ${voltage(rowAnalysis.highestVoltage)}` : 'Unavailable',8);
    pdf.text(465,y,problems.length ? problems.map(n=>String(n).padStart(2,'0')).join(', ') : 'None',8);
    pdf.line(38,y+9,557,y+9);
  });

  header(pdf, state, 'All battery predictions and suggested actions', 3);
  pdf.text(38, 155, '30-minute voltage condition forecast', 14, true);
  pdf.text(38, 176, 'Trend projection is advisory; current measured voltage controls all safety actions.', 9);
  pdf.rect(38, 190, 519, 25, [0.92, 0.96, 0.98]);
  [['Battery',48],['Current',112],['Trend',181],['Predicted',255],['Condition',332],['Suggested action',405]].forEach(([label,x]) => pdf.text(x,207,label,8,true));
  predictions.forEach((item,index) => {
    const y = 237 + index*38;
    pdf.text(48,y,cellLabel(item.number),8,true);
    pdf.text(112,y,voltage(item.currentVoltage),8);
    pdf.text(181,y,item.trend,8);
    pdf.text(255,y,voltage(item.projectedVoltage),8);
    pdf.text(332,y,item.condition,8,item.condition!=='Normal');
    pdf.text(405,y,item.suggestion.replace(/^Battery \d+: /,'').slice(0,38),7);
    pdf.text(405,y+12,item.suggestion.replace(/^Battery \d+: /,'').slice(38,82),7);
    pdf.line(38,y+17,557,y+17);
  });

  header(pdf, state, 'Active alerts, device events and cycle records', 4);
  pdf.text(38, 155, 'Active health and maintenance alerts', 14, true);
  const alerts = getAlerts(state);
  if (!alerts.length) pdf.text(48, 181, 'No active alerts.', 10);
  alerts.slice(0, 5).forEach((alert,index) => {
    const y=181+index*35;
    pdf.text(48,y,alert.title,9,true); pdf.text(48,y+14,alert.detail.slice(0,100),8);
  });
  const cyclesTop = Math.max(380, 205 + Math.min(alerts.length,5)*35);
  pdf.text(38, cyclesTop, 'Recorded charge / discharge cycles', 14, true);
  pdf.rect(38, cyclesTop+16, 519, 25, [0.92, 0.96, 0.98]);
  [['Cycle',48],['Date',105],['Voltage range',225],['Charge / discharge',335],['Health',465]].forEach(([label,x]) => pdf.text(x,cyclesTop+33,label,8,true));
  if (!state.cycles.length) pdf.text(48,cyclesTop+70,'No cycle records supplied by the data source.',10);
  state.cycles.slice(0,10).forEach((cycle,index) => {
    const y=cyclesTop+65+index*27;
    pdf.text(48,y,cycle.id,8); pdf.text(105,y,new Date(cycle.date).toLocaleDateString(),8);
    pdf.text(225,y,`${cycle.min.toFixed(2)}-${cycle.max.toFixed(2)} V`,8);
    pdf.text(335,y,`${cycle.charge} / ${cycle.discharge} min`,8); pdf.text(465,y,cycle.health,8);
    pdf.line(38,y+9,557,y+9);
  });
  return pdf.finish();
}

export function downloadReport(state, history) {
  const bytes = makeReportPdf(state, history);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = `Battery_Performance_Report_${new Date().toISOString().slice(0,10)}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
