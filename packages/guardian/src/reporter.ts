/**
 * Reporter — generates markdown build reports from BuildReport data.
 */

import type { BuildReport, BloatAlert } from './index';

/**
 * Generate a full markdown build report.
 */
export function generateReport(report: BuildReport): string {
  const lines: string[] = [];

  lines.push('# Build Budget Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date(report.generatedAt).toISOString()}`);
  lines.push(`**Routes:** ${report.totalRoutes}`);
  lines.push(`**Total build time:** ${formatDuration(report.totalBuildTimeMs)}`);
  lines.push(`**Total bundle size:** ${formatBytes(report.totalBundleSizeBytes)}`);
  lines.push('');

  const summary = generateSummary(report);
  lines.push(summary);
  lines.push('');

  if (report.alerts.length > 0) {
    lines.push('## ⚠️ Bloat Alerts');
    lines.push('');
    for (const alert of report.alerts) {
      lines.push(formatBloatAlert(alert));
      lines.push('');
    }
  }

  if (report.violations.length > 0) {
    lines.push('## 🚫 Budget Violations');
    lines.push('');
    for (const v of report.violations) {
      lines.push(`- **${v.route}**: ${v.reason}`);
    }
    lines.push('');
  }

  if (report.scores.length > 0) {
    lines.push('## Conservation Scores');
    lines.push('');
    lines.push('Higher score = bigger optimization target (size × frequency × complexity).');
    lines.push('');
    lines.push('| Route | Score | Size | Freq | Modules |');
    lines.push('|-------|------:|-----:|-----:|--------:|');
    for (const s of report.scores.slice(0, 20)) {
      const routeMetric = report.routeMetrics.find((m) => m.route === s.route);
      lines.push(
        `| ${s.route} | ${s.score.toFixed(1)} | ${routeMetric ? formatBytes(routeMetric.bundleSizeBytes) : '—'} | ${s.frequency}/day | ${s.complexity} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Per-Route Breakdown');
  lines.push('');
  lines.push('| Route | Build Time | Bundle Size | Memory Peak |');
  lines.push('|-------|-----------:|------------:|------------:|');
  for (const m of report.routeMetrics) {
    lines.push(`| ${m.route} | ${formatDuration(m.buildTimeMs)} | ${formatBytes(m.bundleSizeBytes)} | ${formatBytes(m.memoryPeakBytes)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate the one-paragraph executive summary.
 */
export function generateSummary(report: BuildReport): string {
  const parts: string[] = [];

  parts.push(`Your build takes ${formatDuration(report.totalBuildTimeMs)}.`);

  const sortedByTime = [...report.routeMetrics].sort((a, b) => b.buildTimeMs - a.buildTimeMs);
  if (sortedByTime.length >= 3 && report.totalBuildTimeMs > 0) {
    const top3 = sortedByTime.slice(0, 3);
    const top3Pct = Math.round((top3.reduce((s, m) => s + m.buildTimeMs, 0) / report.totalBuildTimeMs) * 100);
    parts.push(`${top3.length} routes account for ${top3Pct}% of that time.`);
  }

  const sortedBySize = [...report.routeMetrics].sort((a, b) => b.bundleSizeBytes - a.bundleSizeBytes);
  if (sortedBySize.length > 0) {
    const largest = sortedBySize[0];
    parts.push(`${largest.route} is the largest at ${formatBytes(largest.bundleSizeBytes)}.`);
  }

  if (report.alerts.length > 0) {
    const worst = report.alerts.sort((a, b) => b.growthPercent - a.growthPercent)[0];
    parts.push(
      `${worst.route} grew ${Math.round(worst.growthPercent * 100)}% from last build${
        worst.addedDependencies.length > 0 ? ` — added: ${worst.addedDependencies.slice(0, 3).join(', ')}` : ''
      }.`,
    );
  }

  if (report.violations.length > 0) {
    parts.push(`${report.violations.length} route(s) exceed their budget.`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBloatAlert(alert: BloatAlert): string {
  const pct = `${Math.round(alert.growthPercent * 100)}%`;
  const icon = alert.severity === 'critical' ? '🔴' : '🟡';
  let line = `${icon} **${alert.route}**: ${formatBytes(alert.previousSizeBytes)} → ${formatBytes(alert.currentSizeBytes)} (**+${pct}**)`;
  if (alert.addedDependencies.length > 0) {
    line += `. Added: ${alert.addedDependencies.join(', ')}`;
  }
  return line;
}
