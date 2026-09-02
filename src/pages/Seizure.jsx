import EntryChart from "../components/EntryChart.jsx";

const columns = [
  { key: 'time', label: 'Time', type: 'datetime-local' },
  { key: 'duration', label: 'Duration', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' }
];

export default function Seizure() {
  return <EntryChart title="Seizure Chart" collectionName="seizure" columns={columns} entryNoun="Entry" />;
}
