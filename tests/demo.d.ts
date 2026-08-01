declare global {
  interface Window {
    __drawer: { open: () => void; close: () => void };
    __ticker: { open: () => void; close: () => void };
    __tickCount: number;
    __feed: { open: () => Promise<void>; close: () => void };
    __shortcuts: { open: () => void; close: () => void };
    __shortcutHits: number;
    __shortcutPanels: number;
    __pool: { show: (count: number) => void };
    __poolSize: number;
    __feedRows: number;
    __feedHistory: number;
    __build: 'leak' | 'fixed';
    __pollCount: number;
  }
}

export { };
