import EntryChart from "../components/EntryChart.jsx";

const isAbnormalTemp = v => { const n = parseFloat(v); return !isNaN(n) && (n < 36.1 || n > 37.5); };
const isAbnormalPulse = v => { const n = parseFloat(v); return !isNaN(n) && (n < 60 || n > 100); };
const isAbnormalResp = v => { const n = parseFloat(v); return !isNaN(n) && (n < 12 || n > 20); };
const isAbnormalSpo2 = v => { const n = parseFloat(v); return !isNaN(n) && n < 95; };
const isAbnormalBP = v => {
  const m = String(v).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return false;
  const sys = parseInt(m[1], 10), dia = parseInt(m[2], 10);
  return sys < 90 || sys > 140 || dia < 60 || dia > 90;
};

const columns = [
  { key: 'time', label: 'Time', type: 'datetime-local' },
  { key: 'temp', label: 'Temp (°C)', type: 'text', abnormal: isAbnormalTemp },
  { key: 'pulse', label: 'Pulse', type: 'text', abnormal: isAbnormalPulse },
  { key: 'resp', label: 'Resp Rate', type: 'text', abnormal: isAbnormalResp },
  { key: 'bp', label: 'BP', type: 'text', abnormal: isAbnormalBP },
  { key: 'spo2', label: 'SpO2 (%)', type: 'text', abnormal: isAbnormalSpo2 },
  { key: 'notes', label: 'Notes', type: 'text' }
];

export default function Vitals() {
  return <EntryChart title="Vital Signs Chart" collectionName="vitals" columns={columns} entryNoun="Reading" />;
}
