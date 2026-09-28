import { useEffect, useState } from "react";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import {
  SOUND_OPTIONS, APPEARANCE_OPTIONS, REPEAT_OPTIONS, ALL_FREQUENCIES, GLUCOSE_INTERVAL_OPTIONS,
  OVERDUE_REPEAT_OPTIONS, loadAlarmSettings, saveAlarmSettings as persistAlarmSettings
} from "../lib/alarm-settings.js";
import { useTimeFormat } from "../lib/time-format.js";
import Topbar from "../components/Topbar.jsx";

// 12-hour AM/PM time control (value / onChange use 24-hour "HH:MM"). Replaces
// <input type="time">, which follows the phone's own clock setting.
function Time12Select({ value, onChange }) {
  const [h24, m] = (value || "00:00").split(":").map(Number);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minutes = Array.from({ length: 12 }, (_, k) => k * 5);
  if (!minutes.includes(m)) { minutes.push(m); minutes.sort((a, b) => a - b); }
  const emit = (hh, mm, ap) => {
    const h = (hh % 12) + (ap === "PM" ? 12 : 0);
    onChange(String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0"));
  };
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select value={h12} onChange={(e) => emit(Number(e.target.value), m, ampm)}>
        {[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <select value={m} onChange={(e) => emit(h12, Number(e.target.value), ampm)}>
        {minutes.map((mm) => <option key={mm} value={mm}>{String(mm).padStart(2, "0")}</option>)}
      </select>
      <select value={ampm} onChange={(e) => emit(h12, m, e.target.value)}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}

export default function AlarmSettings() {
  const { profile } = useAuth();
  const goBack = useGoBack('/admin');

  useTimeFormat();

  const [alarm, setAlarm] = useState(null); // null while loading
  const [freqChecked, setFreqChecked] = useState({});
  const [alarmSaving, setAlarmSaving] = useState(false);
  const [alarmMsg, setAlarmMsg] = useState(null);

  useEffect(() => {
    (async () => {
      const settings = await loadAlarmSettings(db);
      setAlarm(settings);
      const checked = {};
      ALL_FREQUENCIES.forEach(f => { checked[f] = settings.frequencies.includes(f); });
      setFreqChecked(checked);
    })();
  }, []);

  function toggleFreq(f) { setFreqChecked((c) => ({ ...c, [f]: !c[f] })); }

  async function saveAlarmSettings() {
    const selectedFrequencies = ALL_FREQUENCIES.filter(f => freqChecked[f]);
    if (!selectedFrequencies.length) {
      setAlarmMsg({ type: 'error', text: 'Select at least one frequency, or nurses will never get an alert.' });
      return;
    }
    setAlarmSaving(true);
    setAlarmMsg(null);
    try {
      const saved = await persistAlarmSettings(db, { ...alarm, frequencies: selectedFrequencies });
      setAlarm(saved);
      setAlarmMsg({ type: 'info', text: 'Alarm settings saved.' });
    } catch (e) {
      setAlarmMsg({ type: 'error', text: e.message || 'Failed to save alarm settings.' });
    } finally {
      setAlarmSaving(false);
    }
  }

  if (!profile) return null;

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Alarm Settings">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Drug-Due Alarm Settings</h3>
          <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
            Controls the alert nurses get when a drug dose is due — see "Alerts" on the Profile page for how a nurse
            opts a device in. Changes here apply to every nurse's device; already-open tabs pick them up live, no
            reload needed.
          </p>
          {alarm && (
            <>
              <div className="field">
                <label>Alarm Sound</label>
                <select value={alarm.sound} onChange={(e) => setAlarm({ ...alarm, sound: e.target.value })}>
                  {SOUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Alarm Type (how it appears)</label>
                <select value={alarm.appearance} onChange={(e) => setAlarm({ ...alarm, appearance: e.target.value })}>
                  {APPEARANCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Repeat Behavior</label>
                <select value={alarm.repeat} onChange={(e) => setAlarm({ ...alarm, repeat: e.target.value })}>
                  {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>
                  <input type="checkbox" style={{ width: 'auto', marginRight: 6, verticalAlign: 'middle' }}
                    checked={alarm.quietHours.enabled} onChange={(e) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, enabled: e.target.checked } })} />
                  Quiet Hours (mute alerts overnight)
                </label>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>Quiet From</label>
                  <Time12Select value={alarm.quietHours.start} onChange={(v) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, start: v } })} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Quiet Until</label>
                  <Time12Select value={alarm.quietHours.end} onChange={(v) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, end: v } })} />
                </div>
              </div>
              <div className="field">
                <label>Repeat While Overdue</label>
                <select value={String(alarm.overdueRepeatMinutes)} onChange={(e) => setAlarm({ ...alarm, overdueRepeatMinutes: Number(e.target.value) })}>
                  {OVERDUE_REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p style={{ fontSize: 12, color: '#666', margin: '2px 0 0' }}>
                  If a dose stays overdue (not yet given), nurses keep getting pushed a reminder at this interval
                  until it's given — instead of only the one alert when it first became due.
                </p>
              </div>
              <div className="field">
                <label>Alarm Schedule — Which Frequencies Alert</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 4 }}>
                  {ALL_FREQUENCIES.map(f => (
                    <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 'normal', fontSize: 13 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={!!freqChecked[f]} onChange={() => toggleFreq(f)} />{f}
                    </label>
                  ))}
                </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '18px 0' }} />

              <div className="field">
                <label>
                  <input type="checkbox" style={{ width: 'auto', marginRight: 6, verticalAlign: 'middle' }}
                    checked={alarm.glucose.enabled} onChange={(e) => setAlarm({ ...alarm, glucose: { ...alarm.glucose, enabled: e.target.checked } })} />
                  Glycemic Check Reminders
                </label>
                <p style={{ fontSize: 12, color: '#666', margin: '2px 0 0' }}>
                  Reminds nurses when a patient's blood glucose reading is overdue, timed from their last recorded
                  reading (see the Time column on the Glycemic Chart) — same alarm sound/appearance/quiet-hours above.
                </p>
              </div>
              <div className="field">
                <label>Remind Every</label>
                <select value={String(alarm.glucose.intervalHours)} onChange={(e) => setAlarm({ ...alarm, glucose: { ...alarm.glucose, intervalHours: Number(e.target.value) } })}>
                  {GLUCOSE_INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <button className="btn btn-primary" disabled={alarmSaving} onClick={saveAlarmSettings}>Save Alarm Settings</button>
              {alarmMsg && <div className={alarmMsg.type === 'error' ? 'error-msg' : 'info-msg'}>{alarmMsg.text}</div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
