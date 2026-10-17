#!/usr/bin/env node
'use strict';

/**
 * Branch parity check for `main` and `develop`.
 *
 * Compares `origin/main` and `origin/develop` and produces a deterministic
 * report describing divergence (commits and changed files) plus ahead/behind
 * counts. The report is byte-identical across repeated runs for the same
 * repository state so it can be hashed and compared for reproducibility.
 *
 * Usage:
 *   node scripts/branch-parity.js [--out <path>] [--base <ref>] [--head <ref>]
 *
 * Exit codes:
 *   0  branches are in sync
 *   1  branches have drifted (divergent commits and/or changed files)
 *   2  a branch (or ref) is missing / could not be resolved
 *   3  unexpected error
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_BASE = 'origin/main';
const DEFAULT_HEAD = 'origin/develop';

// Telemetry size caps (bytes / counts) to keep records bounded.
const TELEMETRY_MAX_BYTES = 2048;
const TELEMETRY_MAX_ITEMS = 50;

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit.
 */
function git(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Run a git command and return { ok, stdout, stderr } without throwing.
 */
function gitSafe(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || err.message || '').toString().trim(),
    };
  }
}

/**
 * Resolve a ref to a commit SHA, or null if it does not exist.
 */
function resolveRef(ref, options = {}) {
  const res = gitSafe(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options);
  if (!res.ok || !res.stdout) {
    return null;
  }
  return res.stdout;
}

/**
 * Sort helper producing a stable, locale-independent ordering.
 */
function stableSort(values) {
  return values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Parse `git rev-list --left-right --count base...head` output.
 * Returns { ahead, behind } where ahead = commits in head not in base,
 * behind = commits in base not in head.
 */
function parseCounts(output) {
  const parts = String(output || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const behind = Number.parseInt(parts[0], 10);
  const ahead = Number.parseInt(parts[1], 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

/**
 * List commit SHAs present in one side but not the other.
 */
function listDivergentCommits(base, head, options = {}) {
  const res = gitSafe(['rev-list', '--left-right', `${base}...${head}`], options);
  if (!res.ok) {
    throw new Error(`git rev-list failed: ${res.stderr}`);
  }
  const left = [];
  const right = [];
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const marker = trimmed[0];
    const sha = trimmed.slice(1).trim();
    if (!sha) continue;
    if (marker === '<') left.push(sha);
    else if (marker === '>') right.push(sha);
  }
  return {
    baseOnly: stableSort(left),
    headOnly: stableSort(right),
  };
}

/**
 * List changed file paths between two refs (symmetric difference of trees).
 */
function listChangedFiles(base, head, options = {}) {
  const res = gitSafe(
    ['diff', '--name-only', '--no-renames', '--no-color', `${base}...${head}`],
    options
  );
  if (!res.ok) {
    throw new Error(`git diff failed: ${res.stderr}`);
  }
  const files = res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return stableSort(Array.from(new Set(files)));
}

/**
 * Build a deterministic parity report.
 *
 * @param {object} params
 * @param {string} params.base
 * @param {string} params.head
 * @param {object} [params.options] git options (e.g. cwd)
 * @returns {object} report
 */
function buildReport({ base, head, options = {} }) {
  const baseSha = resolveRef(base, options);
  const headSha = resolveRef(head, options);

  const missing = [];
  if (!baseSha) missing.push(base);
  if (!headSha) missing.push(head);

  if (missing.length > 0) {
    return {
      status: 'missing-branch',
      base,
      head,
      baseSha: baseSha || null,
      headSha: headSha || null,
      missing,
      inSync: false,
      ahead: 0,
      behind: 0,
      divergentCommits: { baseOnly: [], headOnly: [] },
      changedFiles: [],
    };
  }

  const countsRes = gitSafe(
    ['rev-list', '--left-right', '--count', `${base}...${head}`],
    options
  );
  if (!countsRes.ok) {
    throw new Error(`git rev-list --count failed: ${countsRes.stderr}`);
  }
  const { ahead, behind } = parseCounts(countsRes.stdout);

  const divergentCommits = listDivergentCommits(base, head, options);
  const changedFiles = listChangedFiles(base, head, options);

  const inSync =
    baseSha === headSha &&
    ahead === 0 &&
    behind === 0 &&
    divergentCommits.baseOnly.length === 0 &&
    divergentCommits.headOnly.length === 0 &&
    changedFiles.length === 0;

  return {
    status: inSync ? 'in-sync' : 'drift',
    base,
    head,
    baseSha,
    headSha,
    missing: [],
    inSync,
    ahead,
    behind,
    divergentCommits,
    changedFiles,
  };
}

/**
 * Serialize a report to stable JSON (sorted keys, no timestamps).
 */
function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Build a bounded telemetry record. Contains no secrets and no timestamps
 * that would break reproducibility; `runId` is supplied by the caller.
 */
function buildTelemetry({ report, durationMs, runId }) {
  const record = {
    event: 'branch-parity',
    status: report.status,
    base: report.base,
    head: report.head,
    inSync: report.inSync,
    ahead: report.ahead,
    behind: report.behind,
    divergentCommitCount:
      report.divergentCommits.baseOnly.length + report.divergentCommits.headOnly.length,
    changedFileCount: report.changedFiles.length,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    runId: runId ? String(runId).slice(0, 128) : null,
  };

  // Bound list sizes so telemetry stays small.
  record.divergentCommits = {
    baseOnly: report.divergentCommits.baseOnly.slice(0, TELEMETRY_MAX_ITEMS),
    headOnly: report.divergentCommits.headOnly.slice(0, TELEMETRY_MAX_ITEMS),
  };
  record.changedFiles = report.changedFiles.slice(0, TELEMETRY_MAX_ITEMS);

  let json = JSON.stringify(record);
  if (Buffer.byteLength(json, 'utf8') > TELEMETRY_MAX_BYTES) {
    // Drop the largest variable-length fields first.
    record.changedFiles = record.changedFiles.slice(0, 10);
    record.divergentCommits = {
      baseOnly: record.divergentCommits.baseOnly.slice(0, 10),
      headOnly: record.divergentCommits.headOnly.slice(0, 10),
    };
    json = JSON.stringify(record);
    if (Buffer.byteLength(json, 'utf8') > TELEMETRY_MAX_BYTES) {
      record.changedFiles = [];
      record.divergentCommits = { baseOnly: [], headOnly: [] };
      json = JSON.stringify(record);
    }
  }
  return record;
}

/**
 * Format an actionable message describing drift.
 */
function formatDriftMessage(report) {
  const lines = [];
  lines.push(
    `Branch parity drift detected between ${report.base} (${report.baseSha}) and ${report.head} (${report.headSha}).`
  );
  lines.push(`Ahead of ${report.base}: ${report.ahead} commit(s).`);
  lines.push(`Behind ${report.base}: ${report.behind} commit(s).`);

  const baseOnly = report.divergentCommits.baseOnly;
  const headOnly = report.divergentCommits.headOnly;
  if (baseOnly.length > 0) {
    lines.push(`Commits only in ${report.base}:`);
    for (const sha of baseOnly) lines.push(`  - ${sha}`);
  }
  if (headOnly.length > 0) {
    lines.push(`Commits only in ${report.head}:`);
    for (const sha of headOnly) lines.push(`  - ${sha}`);
  }
  if (report.changedFiles.length > 0) {
    lines.push('Changed files:');
    for (const file of report.changedFiles) lines.push(`  - ${file}`);
  }
  lines.push(
    'Action: rebase or merge the branches so they share the same history, then re-run the parity check.'
  );
  return lines.join('\n');
}

/**
 * Format a message for a missing branch.
 */
function formatMissingMessage(report) {
  return [
    `Branch parity check failed: could not resolve ref(s): ${report.missing.join(', ')}.`,
    'Ensure the workflow fetches both branches (e.g. `git fetch origin main develop`)',
    'and that the refs exist on the remote.',
  ].join('\n');
}

/**
 * Parse CLI arguments.
 */
function parseArgs(argv) {
  const args = { out: null, base: DEFAULT_BASE, head: DEFAULT_HEAD };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg === '--base') {
      args.base = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--base=')) {
      args.base = arg.slice('--base='.length);
    } else if (arg === '--head') {
      args.head = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--head=')) {
      args.head = arg.slice('--head='.length);
    }
  }
  return args;
}

/**
 * Main entry point. Returns an exit code.
 */
function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const startedAt = Date.now();
  const runId = env.GITHUB_RUN_ID || env.CI_PIPELINE_ID || null;

  let report;
  try {
    report = buildReport({ base: args.base, head: args.head });
  } catch (err) {
    process.stderr.write(`Branch parity check error: ${err.message}\n`);
    return 3;
  }

  const durationMs = Date.now() - startedAt;
  const telemetry = buildTelemetry({ report, durationMs, runId });

  const serialized = serializeReport(report);
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }

  // Emit bounded telemetry to stderr so stdout stays a clean artifact.
  process.stderr.write(`telemetry ${JSON.stringify(telemetry)}\n`);

  if (report.status === 'missing-branch') {
    process.stderr.write(`${formatMissingMessage(report)}\n`);
    return 2;
  }

  if (!report.inSync) {
    process.stderr.write(`${formatDriftMessage(report)}\n`);
    return 1;
  }

  process.stdout.write(`Branches ${report.base} and ${report.head} are in sync.\n`);
  return 0;
}

module.exports = {
  git,
  gitSafe,
  resolveRef,
  parseCounts,
  listDivergentCommits,
  listChangedFiles,
  buildReport,
  serializeReport,
  buildTelemetry,
  formatDriftMessage,
  formatMissingMessage,
  parseArgs,
  main,
  DEFAULT_BASE,
  DEFAULT_HEAD,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_ITEMS,
};

if (require.main === module) {
  process.exit(main());
}