import type { SoakSample, SoakTrend } from './types.js';

export function linearFit(points: Array<{ x: number; y: number }>): { slope: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 1 };

  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - meanX) * (p.y - meanY);
    sxx += (p.x - meanX) ** 2;
  }
  if (sxx === 0) return { slope: 0, r2: 1 };

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }

  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, r2 };
}

/**
 * Sorts growth into the shapes that mean different things: every pass, one jump,
 * or an early climb that levels off. Only the first is a leak.
 */
export function classifyShape(
  samples: SoakSample[],
  key: 'heap' | 'nodes' | 'listeners',
  slope: number,
  r2: number,
  total: number,
): Pick<SoakTrend, 'shape' | 'stepAtPass'> {
  if (total === 0) return { shape: 'flat' };

  const deltas: Array<{ pass: number; delta: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    deltas.push({ pass: samples[i]!.pass, delta: samples[i]![key] - samples[i - 1]![key] });
  }

  // A real leak spreads growth evenly, so its largest delta is a small fraction
  // of the total and never trips this.
  if (deltas.length >= 4) {
    let biggest = deltas[0]!;
    for (const d of deltas) {
      if (Math.abs(d.delta) > Math.abs(biggest.delta)) biggest = d;
    }
    const rest = deltas.reduce((sum, d) => sum + (d === biggest ? 0 : Math.abs(d.delta)), 0);
    if (Math.abs(biggest.delta) >= 0.7 * Math.abs(total) && rest <= 0.3 * Math.abs(total)) {
      return { shape: 'step', stepAtPass: biggest.pass };
    }
  }

  // An early climb that levels off. Warmup and JIT do this, and so does anything
  // that fills a cache once, which is why it wants telling apart from a leak that
  // never stops. Measured against the back half of the run rather than a line,
  // since a curve like this fits a line poorly and would land in 'noisy'.
  if (total > 0 && samples.length >= 6) {
    const middle = samples[Math.floor(samples.length / 2)]!;
    const lateGrowth = samples[samples.length - 1]![key] - middle[key];
    if (lateGrowth <= 0.2 * total) return { shape: 'settled' };
  }

  if (r2 >= 0.9 && slope !== 0) return { shape: 'linear' };

  return { shape: 'noisy' };
}

export function trendOf(
  samples: SoakSample[],
  key: 'heap' | 'nodes' | 'listeners',
  baselineValue: number,
  finalValue: number,
): SoakTrend {
  const { slope, r2 } = linearFit(samples.map((s) => ({ x: s.pass, y: s[key] })));
  const total = finalValue - baselineValue;
  return { perPass: slope, r2, total, ...classifyShape(samples, key, slope, r2, total) };
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatSigned(n: number): string {
  const rounded = Math.round(n);
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded).toLocaleString('en-US')}`;
}

export function formatPerPass(n: number): string {
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(decimals)}`;
}

const BLOCKS = '▁▂▃▄▅▆▇█';

function bucket(values: number[], width: number): number[] {
  const out: number[] = [];
  const size = values.length / width;
  for (let i = 0; i < width; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    const slice = values.slice(from, to);
    out.push(slice.reduce((sum, v) => sum + v, 0) / slice.length);
  }
  return out;
}

/**
 * The readings as one line of blocks, scaled to their own range. Single-width
 * characters, so a padded column stays padded.
 *
 * `floor` is the smallest range worth drawing. Without it a count wobbling by one
 * fills the whole height and a flat row looks like a mountain range, which is the
 * opposite of what a reader needs from it.
 */
export function sparkline(
  values: number[],
  { width = 24, floor = 0 }: { width?: number; floor?: number } = {},
): string {
  if (values.length === 0) return '';
  const points = values.length <= width ? values : bucket(values, width);
  const min = Math.min(...points);
  const max = Math.max(...points);
  if (max - min < Math.max(floor, Number.EPSILON)) return BLOCKS[0]!.repeat(points.length);
  return points
    .map((v) => BLOCKS[Math.round(((v - min) / (max - min)) * (BLOCKS.length - 1))]!)
    .join('');
}

export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

export function formatSignedBytes(bytes: number): string {
  return `${bytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`;
}

export function percentGrowth(baseline: number, after: number): number {
  if (!baseline) return 0;
  return ((after - baseline) / baseline) * 100;
}

export function formatPercent(pct: number): string {
  return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`;
}
