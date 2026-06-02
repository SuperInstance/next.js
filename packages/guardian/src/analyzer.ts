/**
 * Bundle Analyzer — extracts per-module sizes from webpack/turbopack stats.
 *
 * Accepts a webpack `stats` object (or its `toJson()` output) and produces
 * a structured ModuleEntry[] per route chunk.
 */

import type { ModuleEntry } from './index';

export interface ChunkAnalysis {
  /** Chunk / route name */
  name: string;
  /** Total size of the chunk in bytes */
  totalSizeBytes: number;
  /** Per-module breakdown */
  modules: ModuleEntry[];
  /** Parsed asset name (e.g. "pages/dashboard.js") */
  assetFile?: string;
}

/**
 * Analyze webpack compilation stats and return per-chunk module breakdowns.
 */
export function analyzeWebpackStats(statsJson: WebpackStatsJson): ChunkAnalysis[] {
  const chunkMap = new Map<number, ChunkAnalysis>();

  if (statsJson.chunks) {
    for (const chunk of statsJson.chunks) {
      chunkMap.set(chunk.id, {
        name: chunk.names?.[0] ?? String(chunk.id),
        totalSizeBytes: chunk.size ?? 0,
        modules: [],
      });
    }
  }

  if (statsJson.modules) {
    for (const mod of statsJson.modules) {
      if (!mod.chunks) continue;

      const subModules = (mod as { modules?: Array<{ name?: string; size?: number }> }).modules;
      if (subModules) {
        for (const sub of subModules) {
          const subEntry: ModuleEntry = {
            name: cleanModuleName(sub.name ?? ''),
            sizeBytes: sub.size ?? 0,
          };
          for (const chunkId of mod.chunks) {
            const analysis = chunkMap.get(chunkId);
            if (analysis) {
              analysis.modules.push(subEntry);
            }
          }
        }
      } else {
        const entry: ModuleEntry = {
          name: cleanModuleName(mod.name ?? ''),
          sizeBytes: mod.size ?? 0,
        };
        for (const chunkId of mod.chunks) {
          const analysis = chunkMap.get(chunkId);
          if (analysis) {
            analysis.modules.push(entry);
          }
        }
      }
    }
  }

  if (statsJson.assets) {
    const assetChunkMap = new Map<number, string>();
    for (const asset of statsJson.assets) {
      if (asset.chunks) {
        for (const cid of asset.chunks) {
          assetChunkMap.set(cid, asset.name ?? '');
        }
      }
    }
    for (const [chunkId, analysis] of chunkMap) {
      analysis.assetFile = assetChunkMap.get(chunkId);
    }
  }

  return Array.from(chunkMap.values());
}

/**
 * Convert chunk/asset name to route path.
 * "pages/dashboard.js" → "/dashboard", "pages/api/users.js" → "/api/users"
 */
export function chunkNameToRoute(name: string): string {
  return name
    .replace(/^pages\//, '/')
    .replace(/^src\/pages\//, '/')
    .replace(/\.js$/, '')
    .replace(/\.jsx$/, '')
    .replace(/\.ts$/, '')
    .replace(/\.tsx$/, '')
    .replace(/\/index$/, '') || '/';
}

/**
 * Classify a module as first-party or third-party based on its path.
 */
export function isThirdParty(moduleName: string): boolean {
  return (
    moduleName.startsWith('node_modules/') ||
    moduleName.startsWith('./node_modules/') ||
    moduleName.startsWith('../node_modules/') ||
    moduleName.startsWith('external ') ||
    (!moduleName.startsWith('.') && !moduleName.startsWith('/'))
  );
}

/**
 * Get the top N largest modules across all chunks.
 */
export function getTopModules(analyses: ChunkAnalysis[], n: number = 10): ModuleEntry[] {
  const all = analyses.flatMap((a) => a.modules);
  const merged = new Map<string, number>();
  for (const m of all) {
    merged.set(m.name, (merged.get(m.name) ?? 0) + m.sizeBytes);
  }
  return Array.from(merged.entries())
    .map(([name, sizeBytes]) => ({ name, sizeBytes }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function cleanModuleName(raw: string): string {
  return raw
    .replace(/^.\/\s*/, '')
    .replace(/^external\s+/, '')
    .replace(/\s+\d+\s*:\d+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Type stubs for webpack stats JSON
// ---------------------------------------------------------------------------

interface WebpackStatsJson {
  chunks?: Array<{
    id: number;
    names?: string[];
    size?: number;
  }>;
  modules?: Array<{
    name?: string;
    size?: number;
    chunks?: number[];
    modules?: Array<{
      name?: string;
      size?: number;
    }>;
  }>;
  assets?: Array<{
    name?: string;
    chunks?: number[];
    size?: number;
  }>;
}
