#!/usr/bin/env node
/**
 * Galactic Brain — Claude Code hook handler (v14.1)
 *
 * Reçoit l'input du hook via stdin (JSON), classifie l'event, et append
 * dans _brain/events.jsonl du vault Obsidian.
 *
 * Modes (passé en argv[2]) :
 *   - "edit"   : PostToolUse hook sur Edit/Write/NotebookEdit
 *   - "stop"   : Stop hook (fin de session)
 *
 * Doit rester ULTRA rapide (timeout hook par défaut = 60s mais on vise <100ms)
 * et silencieux (pas de print sur stdout/stderr sauf erreur grave).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';

const VAULT = process.env.GALACTIC_VAULT_PATH || 'C:\\Users\\PC\\Documents\\Obsidian Vault';
const EVENTS_PATH = path.join(VAULT, 'GalacticBrain', '_brain', 'events.jsonl');
const HANDOFF_PATH = path.join(VAULT, 'GalacticBrain', '_handoff.json');
const MODE = process.argv[2] || 'edit';

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Safety: si pas de stdin dans 500ms, on continue
    setTimeout(() => resolve(data), 500);
  });
}

function logEvent(obj) {
  try {
    ensureDir(EVENTS_PATH);
    appendFileSync(EVENTS_PATH, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    // silencieux — un hook qui crash bloquerait l'utilisateur
    process.stderr.write(`[gb-hook] write fail: ${e.message}\n`);
  }
}

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    const t = Date.now();
    const sessionId = input.session_id || input.sessionId || 'unknown';

    if (MODE === 'edit') {
      // PostToolUse hook sur Edit/Write/NotebookEdit
      // Claude Code passe : { tool_name, tool_input: {...}, tool_response: {...}, ... }
      const tool = input.tool_name || input.tool || 'unknown';
      const ti = input.tool_input || {};
      logEvent({
        type: 'file_change',
        t,
        session: sessionId,
        tool,
        path: ti.file_path || ti.notebook_path || null,
        kind: tool === 'Write' ? 'write' : tool === 'Edit' ? 'edit' : 'notebook',
        // captures les premières lignes pour contexte (limit 200 chars)
        snippet: (ti.new_string || ti.content || '').toString().slice(0, 200) || null,
      });
    } else if (MODE === 'stop') {
      // Stop hook — fin de session Claude
      // On lit le events.jsonl récent pour faire un mini-résumé
      let recentEvents = [];
      try {
        const txt = await fs.readFile(EVENTS_PATH, 'utf8').catch(() => '');
        const lines = txt.split('\n').filter(Boolean).slice(-200);
        const cutoff = Date.now() - 6 * 3600 * 1000; // 6h
        recentEvents = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(e => e && e.t > cutoff && e.session === sessionId);
      } catch { /* ignore */ }

      const filesTouched = [...new Set(recentEvents.filter(e => e.type === 'file_change').map(e => e.path).filter(Boolean))];
      const toolCalls = recentEvents.length;

      logEvent({
        type: 'session_stop',
        t,
        session: sessionId,
        duration_ms: recentEvents.length ? t - Math.min(...recentEvents.map(e => e.t)) : 0,
        tool_calls: toolCalls,
        files_touched: filesTouched.slice(0, 30),
        files_count: filesTouched.length,
      });

      // Met à jour le handoff pour la prochaine session
      try {
        ensureDir(HANDOFF_PATH);
        const summary = filesTouched.length
          ? `Session ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} · ${filesTouched.length} fichiers touchés (${filesTouched.slice(0, 3).map(f => path.basename(f)).join(', ')}${filesTouched.length > 3 ? '…' : ''})`
          : `Session ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} · session courte (${toolCalls} actions)`;
        const handoff = {
          saved_at: new Date(t).toISOString(),
          context: summary,
          next: '_(à définir par la prochaine session via brain_brief)_',
          session_id: sessionId,
          auto: true,
        };
        await fs.writeFile(HANDOFF_PATH, JSON.stringify(handoff, null, 2), 'utf8');
      } catch (e) {
        process.stderr.write(`[gb-hook stop] handoff write fail: ${e.message}\n`);
      }
    }

    // Output JSON pour Claude Code (vide = pas de modification du flow)
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[gb-hook] fatal: ${e.message}\n`);
    process.exit(0); // exit 0 pour ne JAMAIS bloquer Claude Code
  }
})();
