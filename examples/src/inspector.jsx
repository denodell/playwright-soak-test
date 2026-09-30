import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { subscribe, publish } from './store.js';

const ROWS = 40;

// Module scope, so it outlives every component that registers with it. Plenty of
// real code keeps a registry like this for observers, tooltips or focus.
const mounted = new Map();
let nextId = 1;

function Row({ label, value }) {
  return (
    <div className="report-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Inspector({ onReady }) {
  const hostRef = useRef(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribe(setTick);
    const id = nextId++;
    mounted.set(id, hostRef.current);
    onReady();

    return () => {
      unsubscribe();
      // The leak: the cleanup drops the subscription but forgets the registry,
      // so every section this component ever rendered is still in `mounted`
      // after it has left the page.
      if (!__LEAK__) mounted.delete(id);
      window.__inspectorRegistry = mounted.size;
    };
  }, []);

  return (
    <section className="inspector" ref={hostRef}>
      <h2>Inspector</h2>
      {Array.from({ length: ROWS }, (_, i) => (
        <Row key={i} label={`metric ${i}`} value={tick * ROWS + i} />
      ))}
    </section>
  );
}

let reactRoot = null;

// React renders off the caller's stack, so opening resolves once the component
// is mounted. Without that a soak pass can close it before it ever appears.
export function openInspector() {
  reactRoot = createRoot(document.getElementById('inspector-host'));
  return new Promise((resolve) => {
    reactRoot.render(<Inspector onReady={resolve} />);
  }).then(publish);
}

export function closeInspector() {
  reactRoot?.unmount();
  reactRoot = null;
}
