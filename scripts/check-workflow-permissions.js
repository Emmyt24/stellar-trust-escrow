#!/usr/bin/env node
'use strict';

/**
 * Workflow least-privilege validator.
 *
 * Parses `.github/workflows/*.yml` and enforces:
 *   1. Every workflow declares an explicit top-level `permissions:` block.
 *   2. The branch-parity workflow grants only `contents: read`.
 *   3. Every `actions/checkout` step sets `persist-credentials: false`.
 *   4. No secrets are referenced in the branch-parity workflow.
 *
 * Exits non-zero with a deterministic, secret-free message on violation.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_WORKFLOW_DIR = path.join('.github', 'workflows');
const PARITY_WORKFLOW_NAME = 'branch-parity.yml';
const PARITY_WORKFLOW_PATTERN = /branch[-_]?parity/i;

/**
 * Minimal, dependency-free YAML scanner sufficient for workflow permission
 * checks. We intentionally avoid a full YAML parser so this script has no
 * external dependencies and behaves deterministically in CI.
 */

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      // A comment starts at '#' preceded by whitespace or at line start.
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Returns the list of top-level keys declared in a YAML document.
 */
function topLevelKeys(content) {
  const keys = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    if (isBlankOrComment(raw)) continue;
    const line = stripInlineComment(raw);
    if (indentOf(line) !== 0) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * Extracts the block of lines belonging to a top-level key.
 */
function topLevelBlock(content, key) {
  const lines = content.split(/\r?\n/);
  const block = [];
  let capturing = false;
  for (const raw of lines) {
    const line = stripInlineComment(raw);
    if (isBlankOrComment(raw)) {
      if (capturing) block.push('');
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
      if (match && match[1] === key) {
        capturing = true;
        // Capture inline value (e.g. `permissions: read-all`).
        const rest = line.slice(match[0].length).trim();
        if (rest) block.push(rest);
        continue;
      }
      if (capturing) break;
    } else if (capturing) {
      block.push(line);
    }
  }
  return block;
}

/**
 * Parses a `permissions:` block into a map of scope -> access level.
 * Supports both mapping form and the shorthand string form.
 */
function parsePermissions(content) {
  const block = topLevelBlock(content, 'permissions');
  if (block.length === 0) {
    return { present: false, scopes: {} };
  }
  const scopes = {};
  // Shorthand: `permissions: read-all` / `permissions: write-all` / `permissions: {}`.
  const first = block[0].trim();
  if (first && !first.includes(':')) {
    if (first === 'read-all') {
      scopes['*'] = 'read';
    } else if (first === 'write-all') {
      scopes['*'] = 'write';
    } else if (first === '{}') {
      // Explicit empty permissions.
    } else {
      scopes['*'] = first;
    }
    return { present: true, scopes };
  }
  for (const raw of block) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (match) {
      scopes[match[1]] = match[2];
    }
  }
  return { present: true, scopes };
}

/**
 * Returns true when any `actions/checkout` step lacks
 * `persist-credentials: false`.
 */
function findCheckoutViolations(content) {
  const lines = content.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i]);
    if (!/uses\s*:\s*['"]?actions\/checkout/.test(line)) continue;
    const stepIndent = indentOf(line);
    // Scan the step block (lines more indented than the `uses:` line).
    let hasPersistFalse = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = stripInlineComment(lines[j]);
      if (isBlankOrComment(next)) continue;
      if (indentOf(next) <= stepIndent) break;
      if (/persist-credentials\s*:\s*false\b/.test(next)) {
        hasPersistFalse = true;
      }
    }
    if (!hasPersistFalse) {
      violations.push(i + 1);
    }
  }
  return violations;
}

/**
 * Returns true when the content references any secret expression.
 */
function referencesSecrets(content) {
  return /\$\{\{\s*secrets\./.test(content);
}

function listWorkflowFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function isParityWorkflow(filePath, content) {
  const base = path.basename(filePath);
  if (PARITY_WORKFLOW_PATTERN.test(base)) return true;
  if (base === PARITY_WORKFLOW_NAME) return true;
  // Fall back to a name declaration inside the workflow.
  return /^name\s*:\s*.*branch[-_]?parity/im.test(content);
}

/**
 * Validates a single workflow file's content.
 * Returns an array of deterministic, secret-free error strings.
 */
function validateWorkflow(filePath, content) {
  const errors = [];
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const keys = topLevelKeys(content);

  if (!keys.includes('permissions')) {
    errors.push(`${rel}: missing explicit top-level 'permissions:' block`);
  }

  const parity = isParityWorkflow(filePath, content);

  if (parity) {
    const perms = parsePermissions(content);
    if (perms.present) {
      const scopes = perms.scopes;
      const scopeNames = Object.keys(scopes);
      const allowed = scopeNames.length === 1 && scopeNames[0] === 'contents' && scopes.contents === 'read';
      if (!allowed) {
        errors.push(
          `${rel}: branch-parity workflow must grant only 'contents: read'`
        );
      }
    }
    if (referencesSecrets(content)) {
      errors.push(`${rel}: branch-parity workflow must not reference secrets`);
    }
  }

  const checkoutViolations = findCheckoutViolations(content);
  for (const lineNo of checkoutViolations) {
    errors.push(
      `${rel}: actions/checkout at line ${lineNo} must set 'persist-credentials: false'`
    );
  }

  return errors;
}

function validateDirectory(dir) {
  const files = listWorkflowFiles(dir);
  const errors = [];
  if (files.length === 0) {
    errors.push(`${dir}: no workflow files found`);
    return errors;
  }
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    errors.push(...validateWorkflow(file, content));
  }
  return errors;
}

function main(argv) {
  const dir = argv[2] || DEFAULT_WORKFLOW_DIR;
  const errors = validateDirectory(dir);
  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(`error: ${err}\n`);
    }
    process.stderr.write(
      `workflow least-privilege check failed with ${errors.length} violation(s)\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('workflow least-privilege check passed\n');
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  topLevelKeys,
  topLevelBlock,
  parsePermissions,
  findCheckoutViolations,
  referencesSecrets,
  isParityWorkflow,
  validateWorkflow,
  validateDirectory,
  listWorkflowFiles,
};