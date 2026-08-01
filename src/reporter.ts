import fs from 'node:fs';
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { buildFailureMessage, describeMetrics, isOneOff } from './diagnose.js';
import { formatPercent, formatSigned, percentGrowth } from './stats.js';
import type { SoakResult } from './types.js';

const ATTACHMENT_NAME = 'soak-metrics';

const colors = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  bold: '\u001b[1m',
};

type Color = keyof typeof colors;

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;

  return Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR);
}

function paint(text: string, color: Color): string {
  return useColor() ? `${colors[color]}${text}${colors.reset}` : text;
}

function rowColor(result: SoakResult, metric: 'listeners' | 'nodes' | 'heap'): Color | null {
  const failure = result.failures.find((f) => f.metric === metric);
  if (!failure) return null;
  return failure.trend.shape === 'step' || failure.trend.shape === 'settled' ? 'yellow' : 'red';
}

function verdictColorForSummary(verdict: string): Color {
  if (verdict === 'PASS') return 'green';
  return verdict === 'OVER' ? 'yellow' : 'red';
}

function verdictColor(verdict: string): Color {
  if (verdict === 'PASS') return 'green';
  return verdict === 'LEAK DETECTED' ? 'red' : 'yellow';
}

interface BoxLine {
  text: string;
  color?: Color | null;
}

function box(title: string, verdict: string, lines: BoxLine[]): string {
  const width = Math.max(title.length + verdict.length + 3, ...lines.map((l) => l.text.length)) + 2;
  const top = `┌${'─'.repeat(width)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;
  const gap = width - 2 - title.length - verdict.length;
  const header =
    `│ ${paint(title, 'bold')}${' '.repeat(Math.max(1, gap))}` +
    `${paint(verdict, verdictColor(verdict))} │`;
  const body = lines.map((l) => {
    const padded = l.text.padEnd(width - 2);
    return `│ ${l.color ? paint(padded, l.color) : padded} │`;
  });
  return [top, header, `├${'─'.repeat(width)}┤`, ...body, bottom].join('\n');
}

function readAttachment(attachment: TestResult['attachments'][number]): SoakResult | null {
  try {
    const raw = attachment.body
      ? attachment.body.toString('utf8')
      : attachment.path
        ? fs.readFileSync(attachment.path, 'utf8')
        : null;
    return raw ? (JSON.parse(raw) as SoakResult) : null;
  } catch {
    return null;
  }
}

function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

interface Row {
  title: string;
  result: SoakResult;
  passed: boolean;
}

export default class SoakReporter implements Reporter {
  private rows: Row[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name !== ATTACHMENT_NAME) continue;
      const soak = readAttachment(attachment);
      if (!soak) continue;

      this.rows.push({ title: test.title, result: soak, passed: !soak.leaking });

      const metrics: Array<'listeners' | 'nodes' | 'heap'> = ['listeners', 'nodes', 'heap'];
      const lines: BoxLine[] = describeMetrics(soak).map((text, i) => ({
        text,
        color: rowColor(soak, metrics[i]!),
      }));
      if (soak.leaking) {
        lines.push({ text: '' }, { text: `${soak.passes} passes, warmup ${soak.warmup}` });
      }

      const verdict = soak.leaking
        ? isOneOff(soak)
          ? 'OVER ALLOWANCE'
          : 'LEAK DETECTED'
        : 'PASS';
      console.log(`\n${box(soak.label, verdict, lines)}`);

      if (soak.leaking && process.env.GITHUB_ACTIONS) {
        console.log(
          `::error title=Soak: ${soak.label}::${escapeAnnotation(buildFailureMessage(soak))}`,
        );
      }
    }
  }

  onEnd(_result: FullResult): void {
    if (this.rows.length === 0) return;

    if (this.rows.length > 1) {
      const cells = this.rows.map((row) => ({
        title: row.title,
        nodes: formatSigned(row.result.trends.nodes.total),
        listeners: formatSigned(row.result.trends.listeners.total),
        heap: formatPercent(percentGrowth(row.result.baseline.heap, row.result.after.heap)),
        verdict: row.passed ? 'PASS' : isOneOff(row.result) ? 'OVER' : 'LEAK',
      }));

      const w = {
        title: Math.max(4, ...cells.map((c) => c.title.length)),
        nodes: Math.max(5, ...cells.map((c) => c.nodes.length)),
        listeners: Math.max(9, ...cells.map((c) => c.listeners.length)),
        heap: Math.max(4, ...cells.map((c) => c.heap.length)),
      };

      console.log(`\n${paint('SOAK SUMMARY', 'bold')}`);
      console.log(
        paint(
          `  ${'test'.padEnd(w.title)}  ${'nodes'.padStart(w.nodes)}` +
          `  ${'listeners'.padStart(w.listeners)}  ${'heap'.padStart(w.heap)}  verdict`,
          'dim',
        ),
      );
      for (const c of cells) {
        console.log(
          `  ${c.title.padEnd(w.title)}  ${c.nodes.padStart(w.nodes)}` +
          `  ${c.listeners.padStart(w.listeners)}  ${c.heap.padStart(w.heap)}  ` +
          paint(c.verdict, verdictColorForSummary(c.verdict)),
        );
      }
      console.log('');
    }

    this.writeStepSummary();
  }

  private writeStepSummary(): void {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target) return;

    const lines = [
      '## Soak test results',
      '',
      '| Test | DOM nodes | Listeners | Heap | Verdict |',
      '| --- | ---: | ---: | ---: | --- |',
      ...this.rows.map((row) => {
        const heap = formatPercent(percentGrowth(row.result.baseline.heap, row.result.after.heap));
        return (
          `| ${row.title} | ${formatSigned(row.result.trends.nodes.total)}` +
          ` | ${formatSigned(row.result.trends.listeners.total)} | ${heap}` +
          ` | ${row.passed ? 'pass' : '**leak**'} |`
        );
      }),
      '',
    ];

    try {
      fs.appendFileSync(target, `${lines.join('\n')}\n`);
    } catch { }
  }
}
