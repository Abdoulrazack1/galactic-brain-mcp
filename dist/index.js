/**
 * Galactic Brain MCP Server v4
 * Refactor complet du v3 — tous les P0/P1/P2/P3 traités.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

const VAULT_PATH = process.env.GALACTIC_VAULT_PATH || process.argv[2];
const EXPORT_REL = process.env.GALACTIC_EXPORT_REL || 'GalacticBrain/_mcp_export.json';

if (!VAULT_PATH) {
  console.error('❌ Set GALACTIC_VAULT_PATH env var or pass vault path as first arg');
  process.exit(1);
}

const VAULT_RESOLVED = path.resolve(VAULT_PATH);
const EXPORT_PATH = path.join(VAULT_PATH, EXPORT_REL);

// ── Path safety (P1) ─────────────────────────────────────
function safeVaultPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('Chemin invalide : doit être une string non vide');
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`Chemin absolu refusé : "${rel}"`);
  }
  const abs = path.resolve(VAULT_RESOLVED, rel);
  if (abs !== VAULT_RESOLVED && !abs.startsWith(VAULT_RESOLVED + path.sep)) {
    throw new Error(`Chemin sort du vault : "${rel}"`);
  }
  return abs;
}

let dataCache = null;
let indexCache = null;
let indexDirty = false;

async function loadData() {
  try {
    const stat = await fs.stat(EXPORT_PATH);
    if (dataCache && dataCache.mtime === stat.mtimeMs) return dataCache.data;
    const raw = await fs.readFile(EXPORT_PATH, 'utf-8');
    const data = JSON.parse(raw);
    dataCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (e) {
    throw new Error(`Cannot read export at ${EXPORT_PATH}: ${e.message}\nDid you run "Sync" + "🧠 Claude" in Obsidian?`);
  }
}

async function readNote(notePath) {
  try { return await fs.readFile(safeVaultPath(notePath), 'utf-8'); }
  catch { return null; }
}

async function writeNote(notePath, content) {
  const full = safeVaultPath(notePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
  indexDirty = true;
}

async function deleteFile(notePath) {
  await fs.unlink(safeVaultPath(notePath));
  indexDirty = true;
}

async function noteExists(notePath) {
  try { await fs.access(safeVaultPath(notePath)); return true; }
  catch { return false; }
}

function nowIso() { return new Date().toISOString(); }
function todayDate() { return new Date().toISOString().slice(0, 10); }

function escapeMd(s) {
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function slug(title) {
  const s = String(title ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return s.length > 0 ? s : `note-${Date.now().toString(36)}`;
}

async function resolveRepo(name) {
  const data = await loadData();
  const repo = data.repos.find(r =>
    r.name === name || r.name.toLowerCase() === String(name).toLowerCase()
  );
  if (!repo) {
    const closest = data.repos.slice(0, 10).map(r => r.name).join(', ');
    throw new Error(`Repo "${name}" introuvable. Premières options: ${closest}`);
  }
  const notesFolder = path.dirname(repo.note_path).split(path.sep).join('/');
  return {
    repo,
    settings: {
      notesFolder,
      claudeFolder: `${notesFolder}/_claude`,
      improvementsFolder: `${notesFolder}/_improvements`,
    },
  };
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return { fm: {}, body: content };
  const lines = content.split('\n');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  if (endIdx === -1) return { fm: {}, body: content };
  const fm = {};
  for (let i = 1; i < endIdx; i++) {
    const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    fm[m[1]] = val;
  }
  const body = lines.slice(endIdx + 1).join('\n');
  return { fm, body };
}

function buildFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(s => JSON.stringify(s)).join(', ')}]`);
    } else if (typeof v === 'string' && /[:#"'\[\]]/.test(v)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function splitNote(content) {
  const lines = content.split('\n');
  const chunks = [];
  let currentHeading = '_intro';
  let currentBody = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)/);
    if (m) {
      if (currentBody.length > 0) chunks.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      currentHeading = m[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) chunks.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  const out = [];
  for (const c of chunks) {
    if (c.body.length <= 1500) { out.push(c); continue; }
    const paras = c.body.split(/\n\n+/);
    let buf = [], len = 0;
    for (const p of paras) {
      if (len + p.length > 1200 && buf.length > 0) {
        out.push({ heading: c.heading, body: buf.join('\n\n') });
        buf = []; len = 0;
      }
      buf.push(p); len += p.length;
    }
    if (buf.length > 0) out.push({ heading: c.heading, body: buf.join('\n\n') });
  }
  return out;
}

const STOP = new Set([
  'le','la','les','de','des','un','une','et','ou','à','en','dans','sur','pour',
  'avec','par','que','qui','est','ce','cette','ces','mes','mon','ma','tu','je',
  'il','elle','nous','vous','ils','elles','the','an','of','to','in','for','on',
  'with','as','at','by','this','that','is','are','was','were','be','been'
]);
function tokenize(s) {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}_\-+#]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 1 && !STOP.has(w));
}

async function buildIndex() {
  const stat = await fs.stat(EXPORT_PATH);
  if (indexCache && !indexDirty && indexCache.mtime === stat.mtimeMs) return indexCache.index;
  const data = await loadData();
  const chunks = [];
  for (const repo of data.repos) {
    const note = await readNote(repo.note_path);
    if (!note) continue;
    for (const sec of splitNote(note)) {
      const text = sec.body.length > 600 ? sec.body.slice(0, 600) : sec.body;
      chunks.push({
        repo: repo.name, notePath: repo.note_path, section: sec.heading, text,
        keywords: tokenize(text + ' ' + repo.name + ' ' + (repo.description ?? '')),
      });
    }
  }
  const claudeBase = 'GalacticBrain/_claude';
  try {
    const dirs = await fs.readdir(safeVaultPath(claudeBase)).catch(() => []);
    for (const sub of dirs) {
      const subRel = `${claudeBase}/${sub}`;
      const stat2 = await fs.stat(safeVaultPath(subRel)).catch(() => null);
      if (!stat2?.isDirectory()) continue;
      const files = await fs.readdir(safeVaultPath(subRel)).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const rel = `${subRel}/${f}`;
        const note = await readNote(rel);
        if (!note) continue;
        for (const sec of splitNote(note)) {
          const text = sec.body.length > 600 ? sec.body.slice(0, 600) : sec.body;
          chunks.push({
            repo: sub, notePath: rel, section: `[satellite] ${sec.heading}`, text,
            keywords: tokenize(text + ' ' + sub + ' ' + f),
          });
        }
      }
    }
  } catch {}
  const index = { chunks };
  indexCache = { mtime: stat.mtimeMs, index };
  indexDirty = false;
  return index;
}

// ── Okapi BM25 (remplace TF-IDF) ─────────────────────────────────
// k1=1.5 : saturation TF — b=0.75 : normalisation longueur doc
// Avantage : meilleure précision sur courts documents, sans sur-pondération
// des répétitions, IDF symétrique (n+0.5 au lieu de ln((N+1)/(n+1))).
const _BM25_K1 = 1.5;
const _BM25_B  = 0.75;

async function smartSearch(query, limit = 5) {
  const index = await buildIndex();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const N = index.chunks.length || 1;
  // Document frequency
  const df = {};
  let totalLen = 0;
  for (const c of index.chunks) {
    const seen = new Set(c.keywords);
    for (const k of seen) df[k] = (df[k] ?? 0) + 1;
    totalLen += c.keywords.length;
  }
  const avgdl = totalLen / N;

  const scored = index.chunks.map(c => {
    const dl = c.keywords.length;
    let score = 0;

    for (const q of queryTokens) {
      // tf = nombre de keywords qui matchent (exact ou préfixe)
      const tf = c.keywords.filter(k => k === q || k.startsWith(q) || q.startsWith(k)).length;
      if (tf === 0) continue;
      const n = df[q] ?? 1;
      // IDF Okapi (toujours positif, même si n > N/2)
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      // BM25 term score avec normalisation longueur
      const bm25 = idf * (tf * (_BM25_K1 + 1)) / (tf + _BM25_K1 * (1 - _BM25_B + _BM25_B * dl / avgdl));
      score += bm25;
    }

    // Bonus phrase : tokens consécutifs dans l'ordre exact (+4)
    if (queryTokens.length >= 2) {
      const lcText = c.text.toLowerCase();
      const phrase = queryTokens.join(' ');
      if (lcText.includes(phrase)) score += 4;
      // Bonus bigram (+1.5 par paire consécutive trouvée)
      for (let i = 0; i < queryTokens.length - 1; i++) {
        if (lcText.includes(queryTokens[i] + ' ' + queryTokens[i + 1])) score += 1.5;
      }
    } else {
      // Fallback verbatim pour requêtes mono-token
      const lcText = c.text.toLowerCase();
      if (lcText.includes(queryTokens[0])) score += 1.5;
    }

    return { c, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  return scored.map(({ c, score }) => ({
    repo: c.repo, section: c.section,
    score: Math.round(score * 100) / 100,
    notePath: c.notePath,
    excerpt: c.text.length > 280 ? c.text.slice(0, 280) + '…' : c.text,
  }));
}

async function resolveWriteConflict(filePath, strategy = 'error') {
  const existed = await noteExists(filePath);
  if (!existed) return { finalPath: filePath, mode: 'create', existed: false };
  if (strategy === 'overwrite') return { finalPath: filePath, mode: 'overwrite', existed: true };
  if (strategy === 'append')    return { finalPath: filePath, mode: 'append', existed: true };
  if (strategy === 'version') {
    const parsed = path.parse(filePath);
    for (let i = 2; i < 100; i++) {
      const candidate = `${parsed.dir}/${parsed.name}-${i}${parsed.ext}`;
      if (!(await noteExists(candidate))) {
        return { finalPath: candidate, mode: 'create', existed: true };
      }
    }
    throw new Error('Trop de versions du même fichier (>100), abandon.');
  }
  const e = new Error(`Le fichier existe déjà : ${filePath}. Utilisez conflict_strategy: 'overwrite' | 'append' | 'version', ou update_satellite.`);
  e.code = 'EEXIST';
  throw e;
}

const VERSION = '14.1.0';

// ═════════════════════════════════════════════════════════════════
// v13.4 — LEARNING LAYER : Galactic Brain devient adaptatif
//
// Log persistant des events (routing, recherches, feedback) →
// distillation périodique → cache des routings appris →
// fast-path dans understand. Le brain devient + intelligent à
// chaque utilisation, sans dépendance externe.
// ═════════════════════════════════════════════════════════════════

const _BRAIN_DIR     = 'GalacticBrain/_brain';
const _EVENT_LOG     = `${_BRAIN_DIR}/events.jsonl`;
const _LEARNED_JSON  = `${_BRAIN_DIR}/learned.json`;
let _learnedCache = null;
let _learnedMtime = 0;

async function _ensureBrainDir() {
  try { await fs.mkdir(path.join(VAULT_PATH, _BRAIN_DIR), { recursive: true }); } catch {}
}

/** Append-only event log (fire-and-forget, jamais bloquant) */
function _logEvent(type, data) {
  // Fire-and-forget — pas de await ici, ne ralentit pas les tools
  (async () => {
    try {
      await _ensureBrainDir();
      const line = JSON.stringify({ t: Date.now(), type, ...data }) + '\n';
      await fs.appendFile(path.join(VAULT_PATH, _EVENT_LOG), line, 'utf8');
    } catch {}
  })();
}

/** Lit les events bruts (filtrable par type, fenêtre temporelle) */
async function _readEvents(opts = {}) {
  try {
    const raw = await fs.readFile(path.join(VAULT_PATH, _EVENT_LOG), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const cutoff = opts.since_days ? Date.now() - opts.since_days * 86400000 : 0;
    const events = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (cutoff && e.t < cutoff) continue;
        if (opts.type && e.type !== opts.type) continue;
        events.push(e);
      } catch {}
    }
    return events;
  } catch { return []; }
}

/** Charge le cache "learned" — cache en mémoire avec invalidation mtime */
async function _loadLearned() {
  try {
    const abs = path.join(VAULT_PATH, _LEARNED_JSON);
    const st = await fs.stat(abs);
    if (_learnedCache && _learnedMtime === st.mtimeMs) return _learnedCache;
    const raw = await fs.readFile(abs, 'utf8');
    _learnedCache = JSON.parse(raw);
    _learnedMtime = st.mtimeMs;
    return _learnedCache;
  } catch {
    return { query_routes: {}, hot_notes: [], cold_queries: [], lexicon: {}, last_consolidate: 0 };
  }
}

/** Normalise une requête pour clé de cache : minuscules, accents, ponctuation */
function _normQuery(q) {
  return q.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').sort().join(' '); // ordre indépendant
}
const server = new McpServer({ name: 'galactic-brain', version: VERSION },
  { capabilities: { tools: {} } });

// ─────────────── READ TOOLS ───────────────

server.registerTool('user_summary', {
  title: 'User profile overview',
  description: 'CHEAP. Always call this FIRST. ~50 tokens.',
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const u = data.user_summary;
  return { content: [{ type: 'text', text: `# ${data.github_username}
${u.total_repos} repos · ${u.total_stars}⭐ · top: **${u.most_used_language}** · most active: **${u.most_active_repo}**
${u.languages_count} languages · synced ${new Date(data.generated_at).toLocaleDateString('fr-FR')}` }] };
});

server.registerTool('list_repos', {
  title: 'List repos (compact)',
  description: 'One-liner per repo.',
  inputSchema: {
    sort_by: z.enum(['stars', 'updated', 'name']).optional(),
    language: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
}, async (args) => {
  const data = await loadData();
  let repos = data.repos;
  if (args.language) repos = repos.filter(r => r.language === args.language);
  if (args.sort_by === 'stars') repos = [...repos].sort((a, b) => b.stars - a.stars);
  else if (args.sort_by === 'name') repos = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  else repos = [...repos].sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  repos = repos.slice(0, args.limit ?? 20);
  const lines = repos.map(r =>
    `- **${r.name}** [${r.language ?? '?'}] ⭐${r.stars} ${r.topics.slice(0,3).map(t=>'#'+t).join(' ')}`
    + (r.description ? `\n  ${r.description.slice(0, 100)}${r.description.length > 100 ? '…' : ''}` : '')
  );
  return { content: [{ type: 'text', text: `${repos.length} repos:\n\n${lines.join('\n')}` }] };
});

server.registerTool('get_repo_summary', {
  title: 'Get repo summary',
  description: 'Metrics + stack + recent commits ONLY.',
  inputSchema: { name: z.string() },
}, async (args) => {
  const { repo } = await resolveRepo(args.name);
  const note = await readNote(repo.note_path);
  const sections = note ? splitNote(note) : [];
  const wanted = sections.filter(s => /Métriques|Stack technique|Timeline/.test(s.heading));
  const compact = wanted.map(s => `## ${s.heading}\n${s.body.slice(0, 500)}`).join('\n\n');
  return { content: [{ type: 'text', text:
    `# ${repo.name}\n${repo.description}\n${repo.language ? `Language: ${repo.language}` : ''} · ⭐${repo.stars}\n\n${compact || 'No detailed note yet.'}` }] };
});

server.registerTool('get_repo_section', {
  title: 'Read ONE section of a repo note',
  description: 'Returns only the requested section.',
  inputSchema: { name: z.string(), section: z.string() },
}, async (args) => {
  const { repo } = await resolveRepo(args.name);
  const note = await readNote(repo.note_path);
  if (!note) return { content: [{ type: 'text', text: `❌ Note non trouvée pour ${repo.name}.` }], isError: true };
  const sections = splitNote(note);
  const q = args.section.toLowerCase();
  const matches = sections.filter(s => s.heading.toLowerCase().includes(q));
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `Section "${args.section}" non trouvée. Disponibles: ${sections.map(s => `"${s.heading}"`).join(', ')}` }] };
  }
  const text = matches.map(s => `## ${s.heading}\n\n${s.body}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text: text.slice(0, 4000) }] };
});

server.registerTool('get_repo_full', {
  title: 'Read entire repo note',
  description: 'EXPENSIVE in tokens.',
  inputSchema: { name: z.string() },
}, async (args) => {
  const { repo } = await resolveRepo(args.name);
  const note = await readNote(repo.note_path);
  return { content: [{ type: 'text', text: note ?? '❌ Note non disponible.' }] };
});

server.registerTool('search_brain', {
  title: 'Smart search across all notes',
  description: 'TF-IDF ranked search.',
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(10).optional() },
}, async (args) => {
  const results = await smartSearch(args.query, args.limit ?? 5);
  if (results.length === 0) return { content: [{ type: 'text', text: `Aucun résultat pour "${args.query}"` }] };
  const lines = results.map((r, i) =>
    `### ${i + 1}. **${r.repo}** > ${r.section} _(score ${r.score})_\n> ${r.excerpt}\n_path: ${r.notePath}_`
  );
  return { content: [{ type: 'text', text: `${results.length} matches:\n\n${lines.join('\n\n')}` }] };
});

server.registerTool('get_stack', {
  title: 'Tech stack breakdown',
  description: "Tech stack by category. ~200 tokens.",
  inputSchema: {
    category: z.enum(['frontend', 'backend', 'database', 'devops', 'ml', 'mobile', 'tooling', 'language', 'other']).optional(),
  },
}, async (args) => {
  const data = await loadData();
  let stack = data.stack;
  if (args.category) stack = stack.filter(s => s.category === args.category);
  const grouped = {};
  stack.forEach(s => { (grouped[s.category] ??= []).push(s); });
  const lines = [];
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`\n**${cat.toUpperCase()}**: ${items.map(t => `${t.icon}${t.name}(×${t.count})`).join(' · ')}`);
  }
  return { content: [{ type: 'text', text: `# Stack ${data.github_username}${lines.join('')}` }] };
});

server.registerTool('get_topics', {
  title: 'Cross-cutting topics',
  description: 'Topics shared between ≥2 repos.',
  inputSchema: { min_repos: z.number().int().min(1).optional() },
}, async (args) => {
  const data = await loadData();
  const min = args.min_repos ?? 2;
  const items = data.topic_constellations
    .filter(c => c.repo_names.length >= min)
    .sort((a, b) => b.repo_names.length - a.repo_names.length);
  if (items.length === 0) return { content: [{ type: 'text', text: 'No shared topics.' }] };
  const lines = items.map(c => `- **#${c.topic}**: ${c.repo_names.join(', ')}`);
  return { content: [{ type: 'text', text: `${items.length} shared topics:\n${lines.join('\n')}` }] };
});

server.registerTool('read_note', {
  title: 'Read a vault note by path',
  description: 'Vault-relative paths only — absolute paths and `..` refused.',
  inputSchema: { path: z.string() },
}, async (args) => {
  try {
    const note = await readNote(args.path);
    if (!note) return { content: [{ type: 'text', text: `❌ Note "${args.path}" introuvable.` }], isError: true };
    return { content: [{ type: 'text', text: note.length > 8000 ? note.slice(0, 8000) + '\n\n_(truncated)_' : note }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
});

server.registerTool('get_recent_activity', {
  title: 'What moved recently',
  description: 'Repos with commits in the last N days.',
  inputSchema: { days: z.number().int().min(1).max(90).optional() },
}, async (args) => {
  const data = await loadData();
  const days = args.days ?? 7;
  const cutoff = Date.now() - days * 86400000;
  const active = data.repos
    .filter(r => new Date(r.last_pushed).getTime() > cutoff)
    .sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  if (active.length === 0) return { content: [{ type: 'text', text: `Aucun repo actif depuis ${days} jours.` }] };
  const lines = active.map(r => {
    const d = Math.floor((Date.now() - new Date(r.last_pushed).getTime()) / 86400000);
    return `- **${r.name}** [${r.language ?? '?'}] — il y a ${d}j`;
  });
  return { content: [{ type: 'text', text: `${active.length} repos actifs sur ${days}j:\n\n${lines.join('\n')}` }] };
});

server.registerTool('find_similar_repos', {
  title: 'Find repos similar to a given one',
  description: 'Repos sharing language or topics.',
  inputSchema: { name: z.string(), limit: z.number().int().min(1).max(10).optional() },
}, async (args) => {
  const { repo: target } = await resolveRepo(args.name);
  const data = await loadData();
  const targetTopics = new Set(target.topics);
  const scored = data.repos
    .filter(r => r.id !== target.id)
    .map(r => {
      let score = 0;
      if (r.language && r.language === target.language) score += 3;
      r.topics.forEach(t => { if (targetTopics.has(t)) score += 2; });
      return { r, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit ?? 5);
  if (scored.length === 0) return { content: [{ type: 'text', text: `Aucun repo similaire à "${args.name}".` }] };
  const lines = scored.map(({ r, score }) => {
    const shared = r.topics.filter(t => targetTopics.has(t));
    return `- **${r.name}** _(score ${score})_ — ${r.language ?? '?'} ${shared.length ? `· shared: ${shared.join(',')}` : ''}`;
  });
  return { content: [{ type: 'text', text: `Repos similaires à **${target.name}**:\n\n${lines.join('\n')}` }] };
});

server.registerTool('compose_brief', {
  title: 'Compose a focused brief',
  description: 'Top-N hits par repo.',
  inputSchema: {
    subject: z.string(),
    max_repos: z.number().int().min(1).max(8).optional(),
    hits_per_repo: z.number().int().min(1).max(3).optional(),
  },
}, async (args) => {
  const max = args.max_repos ?? 4;
  const perRepo = args.hits_per_repo ?? 2;
  const results = await smartSearch(args.subject, max * 5);
  if (results.length === 0) return { content: [{ type: 'text', text: `Pas de matériel sur "${args.subject}".` }] };
  const byRepo = new Map();
  for (const r of results) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    if (byRepo.get(r.repo).length < perRepo) byRepo.get(r.repo).push(r);
  }
  const top = Array.from(byRepo.entries()).slice(0, max);
  const lines = [`# Brief: ${args.subject}\n`];
  for (const [repo, hits] of top) {
    lines.push(`## ${repo}`);
    for (const h of hits) {
      lines.push(`### ${h.section} _(score ${h.score})_`);
      lines.push(`> ${h.excerpt}`);
    }
    lines.push('');
  }
  lines.push(`_${results.length} matches across ${byRepo.size} repos._`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ─────────────── WRITE TOOLS ───────────────

server.registerTool('add_improvement', {
  title: 'Add an improvement',
  description: 'Append an actionable improvement.',
  inputSchema: {
    repo: z.string(), title: z.string(), rationale: z.string(),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.enum(['perf', 'security', 'ux', 'code-quality', 'testing', 'docs', 'feature', 'bug', 'devops', 'architecture']),
    effort: z.enum(['<1h', '1-4h', '1d', '2-3d', '1w']).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.improvementsFolder}/${repo.name}.md`;
  let existing = await readNote(filePath);
  if (!existing) {
    existing = `---
parent_repo: ${repo.name}
kind: improvements
generated_by: claude
---

# ⚙️ Améliorations — ${repo.name}

| Statut | Priorité | Catégorie | Effort | Titre | Rationale | Ajoutée le |
|--------|----------|-----------|--------|-------|-----------|------------|
`;
  }
  const effort = args.effort ?? '1d';
  const row = `| [ ] | ${args.priority} | ${args.category} | ${effort} | ${escapeMd(args.title)} | ${escapeMd(args.rationale)} | ${todayDate()} |`;
  await writeNote(filePath, existing + row + '\n');
  return { content: [{ type: 'text', text: `✓ Amélioration ajoutée à ${filePath}` }] };
});

server.registerTool('check_improvement', {
  title: 'Mark an improvement as done',
  description: 'Find by partial title match and mark [x].',
  inputSchema: { repo: z.string(), title_match: z.string(), resolution: z.string().optional() },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.improvementsFolder}/${repo.name}.md`;
  const existing = await readNote(filePath);
  if (!existing) return { content: [{ type: 'text', text: `❌ Pas d'améliorations pour ${repo.name}.` }], isError: true };
  const lines = existing.split('\n');
  let matchIdx = -1;
  const needle = args.title_match.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('| [ ]') && !line.startsWith('| [x]')) continue;
    if (line.toLowerCase().includes(needle)) { matchIdx = i; break; }
  }
  if (matchIdx < 0) return { content: [{ type: 'text', text: `❌ Aucune amélioration ne contient "${args.title_match}".` }], isError: true };
  lines[matchIdx] = lines[matchIdx].replace('| [ ] |', '| [x] |');
  if (args.resolution) lines[matchIdx] += ` <!-- ${todayDate()}: ${escapeMd(args.resolution)} -->`;
  await writeNote(filePath, lines.join('\n'));
  return { content: [{ type: 'text', text: `✓ Coché : ${args.title_match}` }] };
});

server.registerTool('list_improvements', {
  title: 'List improvements',
  description: 'Read the improvements file.',
  inputSchema: { repo: z.string(), only_open: z.boolean().optional() },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.improvementsFolder}/${repo.name}.md`;
  const existing = await readNote(filePath);
  if (!existing) return { content: [{ type: 'text', text: `Aucune amélioration enregistrée pour ${repo.name}.` }] };
  const lines = existing.split('\n');
  const open = lines.filter(l => l.startsWith('| [ ]')).length;
  const done = lines.filter(l => l.startsWith('| [x]')).length;
  const onlyOpen = args.only_open ?? true;
  const rows = lines.filter(l => onlyOpen ? l.startsWith('| [ ]') : (l.startsWith('| [ ]') || l.startsWith('| [x]')));
  return { content: [{ type: 'text', text:
    `# Améliorations ${repo.name}\n\n${open} ouverte(s) · ${done} faite(s)\n\n` +
    `| Statut | Priorité | Catégorie | Effort | Titre | Rationale | Ajoutée le |\n` +
    `|--------|----------|-----------|--------|-------|-----------|------------|\n` +
    rows.join('\n') }] };
});

server.registerTool('delete_improvement', {
  title: 'Remove an improvement',
  description: 'Permanently removes a row by partial title match.',
  inputSchema: { repo: z.string(), title_match: z.string() },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.improvementsFolder}/${repo.name}.md`;
  const existing = await readNote(filePath);
  if (!existing) return { content: [{ type: 'text', text: `❌ Pas d'améliorations pour ${repo.name}.` }], isError: true };
  const lines = existing.split('\n');
  const needle = args.title_match.toLowerCase();
  const before = lines.length;
  const filtered = lines.filter(l => {
    const isRow = l.startsWith('| [ ]') || l.startsWith('| [x]');
    return !(isRow && l.toLowerCase().includes(needle));
  });
  const removed = before - filtered.length;
  if (removed === 0) return { content: [{ type: 'text', text: `❌ Aucune ligne ne contient "${args.title_match}".` }], isError: true };
  await writeNote(filePath, filtered.join('\n'));
  return { content: [{ type: 'text', text: `✓ ${removed} ligne(s) supprimée(s) du backlog ${repo.name}` }] };
});

server.registerTool('add_conversation', {
  title: 'Persist a conversation insight',
  description: 'Saves a Q/A insight as a satellite note.',
  inputSchema: {
    repo: z.string(), title: z.string(), summary: z.string(),
    body: z.string().optional(), tags: z.array(z.string()).optional(),
    conflict_strategy: z.enum(['error', 'overwrite', 'append', 'version']).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.claudeFolder}/${repo.name}/${todayDate()}-${slug(args.title)}.md`;
  const tags = (args.tags ?? []).concat(['claude', 'conversation', `repo/${repo.name}`]);
  const newContent = buildFrontmatter({
    parent_repo: repo.name, kind: 'conversation', created: nowIso(), tags,
  }) + `\n# 💬 ${args.title}\n\n> ${escapeMd(args.summary)}\n\n${args.body ?? ''}\n`;
  try {
    const { finalPath, mode } = await resolveWriteConflict(filePath, args.conflict_strategy ?? 'error');
    if (mode === 'append') {
      const prev = (await readNote(finalPath)) ?? '';
      await writeNote(finalPath, prev + `\n\n---\n\n## Update ${nowIso()}\n\n> ${escapeMd(args.summary)}\n\n${args.body ?? ''}\n`);
    } else {
      await writeNote(finalPath, newContent);
    }
    return { content: [{ type: 'text', text: `✓ Conversation persistée : ${finalPath}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
});

server.registerTool('add_reflection', {
  title: 'Save a strategic reflection',
  description: 'Deep insights about architecture, design.',
  inputSchema: {
    repo: z.string(), title: z.string(), insight: z.string(),
    implications: z.array(z.string()).optional(),
    conflict_strategy: z.enum(['error', 'overwrite', 'append', 'version']).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.claudeFolder}/${repo.name}/${todayDate()}-reflection-${slug(args.title)}.md`;
  const impl = (args.implications ?? []).map(i => `- ${i}`).join('\n');
  const newContent = buildFrontmatter({
    parent_repo: repo.name, kind: 'reflection', created: nowIso(),
    tags: ['claude', 'reflection', 'architecture', `repo/${repo.name}`],
  }) + `\n# 🧠 ${args.title}\n\n${args.insight}\n\n${impl ? `## Implications\n\n${impl}\n` : ''}`;
  try {
    const { finalPath, mode } = await resolveWriteConflict(filePath, args.conflict_strategy ?? 'error');
    if (mode === 'append') {
      const prev = (await readNote(finalPath)) ?? '';
      await writeNote(finalPath, prev + `\n\n---\n\n## Update ${nowIso()}\n\n${args.insight}\n${impl ? `\n${impl}\n` : ''}`);
    } else {
      await writeNote(finalPath, newContent);
    }
    return { content: [{ type: 'text', text: `✓ Réflexion enregistrée : ${finalPath}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
});

server.registerTool('save_session', {
  title: 'Save the current session',
  description: 'CALL ONLY when user explicitly asks.',
  inputSchema: {
    repo: z.string(),
    actions: z.array(z.string()),
    remarks: z.array(z.string()).optional(),
    improvements: z.array(z.string()).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `Projets/${repo.name}/Suivi.md`;
  const existing = (await readNote(filePath)) ?? `---
parent_repo: ${repo.name}
kind: session_log
---

`;
  let insertAt = 0;
  const fmEnd = existing.indexOf('\n---\n', 4);
  if (existing.startsWith('---\n') && fmEnd > 0) insertAt = fmEnd + 5;
  const session = `## Session du ${todayDate()} — ${nowIso().slice(11, 16)}

### 🔹 Actions / décisions
${args.actions.map(a => `- ${a}`).join('\n')}

${args.remarks?.length ? `### 🔹 Remarques & blocages\n${args.remarks.map(r => `- ${r}`).join('\n')}\n\n` : ''}${args.improvements?.length ? `### 🔹 Améliorations potentielles\n${args.improvements.map(i => `- ${i}`).join('\n')}\n\n` : ''}---

`;
  const newContent = existing.slice(0, insertAt) + session + existing.slice(insertAt);
  await writeNote(filePath, newContent);
  let satellite = `${settings.claudeFolder}/${repo.name}/${todayDate()}-session.md`;
  const { finalPath } = await resolveWriteConflict(satellite, 'version');
  satellite = finalPath;
  await writeNote(satellite, buildFrontmatter({
    parent_repo: repo.name, kind: 'session', created: nowIso(), mirror_of: filePath,
  }) + '\n' + session);
  return { content: [{ type: 'text', text: `✓ Session sauvegardée\n  → ${filePath}\n  → ${satellite}` }] };
});

server.registerTool('create_satellite_note', {
  title: 'Create an arbitrary satellite note',
  description: 'Generic write.',
  inputSchema: {
    repo: z.string(), title: z.string(), content: z.string(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    conflict_strategy: z.enum(['error', 'overwrite', 'append', 'version']).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const kind = args.kind ?? 'note';
  const filePath = `${settings.claudeFolder}/${repo.name}/${todayDate()}-${kind}-${slug(args.title)}.md`;
  const tags = (args.tags ?? []).concat(['claude', kind, `repo/${repo.name}`]);
  const fullContent = buildFrontmatter({
    parent_repo: repo.name, kind, created: nowIso(), tags,
  }) + `\n# ${args.title}\n\n${args.content}\n`;
  try {
    const { finalPath } = await resolveWriteConflict(filePath, args.conflict_strategy ?? 'error');
    await writeNote(finalPath, fullContent);
    return { content: [{ type: 'text', text: `✓ Note satellite créée : ${finalPath}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
});

server.registerTool('update_satellite', {
  title: 'Update an existing satellite',
  description: 'Replace body of existing satellite.',
  inputSchema: {
    path: z.string().optional(),
    repo: z.string().optional(),
    slug: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    add_tags: z.array(z.string()).optional(),
  },
}, async (args) => {
  let target = args.path;
  if (!target) {
    if (!args.repo || !args.slug) return { content: [{ type: 'text', text: '❌ Fournir soit `path`, soit (`repo` + `slug`).' }], isError: true };
    const { repo, settings } = await resolveRepo(args.repo);
    const dir = `${settings.claudeFolder}/${repo.name}`;
    let files = [];
    try { files = await fs.readdir(safeVaultPath(dir)); }
    catch { return { content: [{ type: 'text', text: `❌ Pas de dossier satellite pour ${repo.name}.` }], isError: true }; }
    const needle = args.slug.toLowerCase();
    const matches = files.filter(f => f.endsWith('.md') && f.toLowerCase().includes(needle));
    if (matches.length === 0) return { content: [{ type: 'text', text: `❌ Aucun satellite ne matche "${args.slug}".\nFichiers : ${files.join(', ')}` }], isError: true };
    if (matches.length > 1) return { content: [{ type: 'text', text: `❌ ${matches.length} candidats — précisez :\n${matches.map(m => '  - ' + m).join('\n')}` }], isError: true };
    target = `${dir}/${matches[0]}`;
  }
  const existing = await readNote(target);
  if (existing == null) return { content: [{ type: 'text', text: `❌ "${target}" n'existe pas.` }], isError: true };
  const { fm } = parseFrontmatter(existing);
  fm.last_updated = nowIso();
  if (args.add_tags?.length) {
    const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []);
    for (const t of args.add_tags) if (!tags.includes(t)) tags.push(t);
    fm.tags = tags;
  }
  const heading = args.title ? `# ${args.title}` : '';
  const newContent = buildFrontmatter(fm) + (heading ? '\n' + heading + '\n\n' : '\n') + args.content + '\n';
  await writeNote(target, newContent);
  return { content: [{ type: 'text', text: `✓ Satellite mis à jour : ${target}` }] };
});

server.registerTool('delete_satellite', {
  title: 'Delete a Claude satellite note',
  description: 'SAFETY: only deletes inside _claude/.',
  inputSchema: {
    path: z.string().optional(),
    repo: z.string().optional(),
    slug: z.string().optional(),
    confirm: z.boolean().optional(),
  },
}, async (args) => {
  let target = args.path;
  if (!target) {
    if (!args.repo || !args.slug) return { content: [{ type: 'text', text: '❌ Fournir soit `path`, soit (`repo` + `slug`).' }], isError: true };
    const { repo, settings } = await resolveRepo(args.repo);
    const dir = `${settings.claudeFolder}/${repo.name}`;
    let files = [];
    try { files = await fs.readdir(safeVaultPath(dir)); }
    catch { return { content: [{ type: 'text', text: `❌ Pas de dossier satellite pour ${repo.name}.` }], isError: true }; }
    const needle = args.slug.toLowerCase();
    const matches = files.filter(f => f.endsWith('.md') && f.toLowerCase().includes(needle));
    if (matches.length === 0) return { content: [{ type: 'text', text: `❌ Aucun satellite ne matche "${args.slug}".\nFichiers : ${files.join(', ')}` }], isError: true };
    if (matches.length > 1) return { content: [{ type: 'text', text: `❌ ${matches.length} candidats — préciser :\n${matches.map(m => '  - ' + m).join('\n')}` }], isError: true };
    target = `${dir}/${matches[0]}`;
  }
  const norm = target.replace(/\\/g, '/');
  if (!norm.includes('/_claude/') && !norm.includes('GalacticBrain/_claude')) {
    return { content: [{ type: 'text', text: `❌ Refusé : delete_satellite ne supprime QUE des fichiers sous _claude/. Reçu : ${target}` }], isError: true };
  }
  if (!(await noteExists(target))) return { content: [{ type: 'text', text: `❌ "${target}" n'existe pas.` }], isError: true };
  if (args.confirm !== true) {
    return { content: [{ type: 'text', text: `⚠️ DRY-RUN : prêt à supprimer\n  ${target}\n\nRappeler avec confirm=true pour exécuter.` }] };
  }
  await deleteFile(target);
  return { content: [{ type: 'text', text: `🗑 Satellite supprimé : ${target}` }] };
});

server.registerTool('list_satellites', {
  title: 'List Claude satellite notes',
  description: 'With date, kind, size. Filter by kind.',
  inputSchema: {
    repo: z.string(),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const dir = `${settings.claudeFolder}/${repo.name}`;
  let entries = [];
  try {
    const files = (await fs.readdir(safeVaultPath(dir))).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const rel = `${dir}/${f}`;
      const content = await readNote(rel);
      if (!content) continue;
      const { fm } = parseFrontmatter(content);
      const stat = await fs.stat(safeVaultPath(rel));
      entries.push({
        file: f, path: rel, kind: fm.kind ?? 'note',
        created: fm.created ?? null, bytes: stat.size,
      });
    }
  } catch {
    return { content: [{ type: 'text', text: `Aucun satellite Claude pour ${repo.name}.` }] };
  }
  if (entries.length === 0) return { content: [{ type: 'text', text: `Aucun satellite Claude pour ${repo.name}.` }] };
  if (args.kind) entries = entries.filter(e => e.kind === args.kind);
  entries.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  const limited = entries.slice(0, args.limit ?? 20);
  const lines = limited.map(e => {
    const date = e.created?.slice(0, 10) ?? '?';
    const kb = (e.bytes / 1024).toFixed(1);
    return `- \`${e.file.replace(/\.md$/, '')}\`\n    ${date} · **${e.kind}** · ${kb} KB`;
  });
  const filterNote = args.kind ? ` (kind=${args.kind})` : '';
  return { content: [{ type: 'text', text: `# ${entries.length} satellite(s) pour ${repo.name}${filterNote}\n\n${lines.join('\n')}\n\nFolder: ${dir}/` }] };
});

server.registerTool('vault_stats', {
  title: 'Stats across the brain',
  description: 'Counts by kind, total size, recent activity.',
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const claudeBase = 'GalacticBrain/_claude';
  let totalSatellites = 0, totalBytes = 0;
  const byKind = {}, byRepo = {};
  let latestCreated = '';
  try {
    const dirs = await fs.readdir(safeVaultPath(claudeBase));
    for (const sub of dirs) {
      const subRel = `${claudeBase}/${sub}`;
      const stat = await fs.stat(safeVaultPath(subRel)).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = (await fs.readdir(safeVaultPath(subRel)).catch(() => [])).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const rel = `${subRel}/${f}`;
        const content = await readNote(rel);
        if (!content) continue;
        const { fm } = parseFrontmatter(content);
        const fst = await fs.stat(safeVaultPath(rel));
        totalSatellites++;
        totalBytes += fst.size;
        byKind[fm.kind ?? 'note'] = (byKind[fm.kind ?? 'note'] ?? 0) + 1;
        byRepo[sub] = (byRepo[sub] ?? 0) + 1;
        if (fm.created && fm.created > latestCreated) latestCreated = fm.created;
      }
    }
  } catch {}
  const kindLines = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  - ${k} : ${n}`).join('\n');
  const topRepos = Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([r, n]) => `  - ${r} : ${n}`).join('\n');
  return { content: [{ type: 'text', text:
`# 🌌 Vault stats

**Repos indexés** : ${data.repos.length}
**Satellites Claude** : ${totalSatellites}  (${(totalBytes / 1024).toFixed(1)} KB)
**Dernière activité** : ${latestCreated || 'jamais'}

## Par kind
${kindLines || '  (aucun)'}

## Top repos par nombre de satellites
${topRepos || '  (aucun)'}
` }] };
});

server.registerTool('find_duplicates', {
  title: 'Find satellites that look like duplicates',
  description: 'Same kind + same date = likely duplicates.',
  inputSchema: { repo: z.string().optional() },
}, async (args) => {
  const claudeBase = 'GalacticBrain/_claude';
  let dirs;
  try { dirs = await fs.readdir(safeVaultPath(claudeBase)); }
  catch { return { content: [{ type: 'text', text: 'Aucun dossier _claude/ trouvé.' }] }; }
  if (args.repo) dirs = dirs.filter(d => d === args.repo);
  const groups = new Map();
  for (const sub of dirs) {
    const subRel = `${claudeBase}/${sub}`;
    const stat = await fs.stat(safeVaultPath(subRel)).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = (await fs.readdir(safeVaultPath(subRel)).catch(() => [])).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const content = await readNote(`${subRel}/${f}`);
      if (!content) continue;
      const { fm } = parseFrontmatter(content);
      const date = (fm.created ?? '').slice(0, 10);
      const key = `${sub}|${date}|${fm.kind ?? 'note'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${subRel}/${f}`);
    }
  }
  const dupes = [...groups.entries()].filter(([_, v]) => v.length > 1);
  if (dupes.length === 0) return { content: [{ type: 'text', text: '✓ Aucun doublon détecté.' }] };
  const lines = dupes.map(([key, files]) => {
    const [repo, date, kind] = key.split('|');
    return `### ${repo} · ${date} · ${kind} (${files.length} fichiers)\n${files.map(f => '  - ' + f).join('\n')}`;
  });
  return { content: [{ type: 'text', text: `# Doublons probables\n\n${lines.join('\n\n')}\n\n_Utilise \`delete_satellite\` pour nettoyer._` }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v5 — "Monstre" ═══════════════════
// ═════════════════════════════════════════════════════════════════════

// Pondérations sémantiques pour scoring
const PRIORITY_WEIGHT = { critical: 100, high: 50, medium: 20, low: 5 };
const CATEGORY_WEIGHT = {
  security: 1.5, bug: 1.4, perf: 1.2, architecture: 1.15,
  testing: 1.1, 'code-quality': 1.0, devops: 1.0,
  feature: 0.9, ux: 0.85, docs: 0.6,
};
const EFFORT_HOURS = { '<1h': 0.5, '1-4h': 2.5, '1d': 8, '2-3d': 20, '1w': 40 };

function parseImprovementRow(line) {
  // | [ ] | priority | category | effort | title | rationale | date |
  const m = line.match(/^\|\s*\[(.)\]\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
  if (!m) return null;
  return {
    done: m[1] === 'x',
    priority: m[2].trim(),
    category: m[3].trim(),
    effort: m[4].trim(),
    title: m[5].trim(),
    rationale: m[6].trim(),
    date: m[7].trim(),
  };
}

async function listImprovementsFolder() {
  const folder = 'GalacticBrain/_improvements';
  try {
    const files = (await fs.readdir(safeVaultPath(folder))).filter(f => f.endsWith('.md'));
    const all = [];
    for (const f of files) {
      const content = await readNote(`${folder}/${f}`);
      if (!content) continue;
      const repoName = f.replace(/\.md$/, '');
      for (const line of content.split('\n')) {
        const row = parseImprovementRow(line);
        if (row) all.push({ ...row, repo: repoName });
      }
    }
    return all;
  } catch { return []; }
}

async function listAllSatellites() {
  const claudeBase = 'GalacticBrain/_claude';
  const out = [];
  try {
    const dirs = await fs.readdir(safeVaultPath(claudeBase));
    for (const sub of dirs) {
      const subRel = `${claudeBase}/${sub}`;
      const stat = await fs.stat(safeVaultPath(subRel)).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = (await fs.readdir(safeVaultPath(subRel)).catch(() => [])).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const rel = `${subRel}/${f}`;
        const content = await readNote(rel);
        if (!content) continue;
        const { fm, body } = parseFrontmatter(content);
        const fst = await fs.stat(safeVaultPath(rel));
        out.push({ repo: sub, path: rel, fm, body, size: fst.size, mtime: fst.mtimeMs });
      }
    }
  } catch {}
  return out;
}

// Tool 23: prioritize — across-repo backlog ranking
server.registerTool('prioritize', {
  title: 'Cross-repo improvement priority queue',
  description: "Renvoie le top N d'améliorations ouvertes à travers TOUS les repos, classées par score = (priorité × catégorie) / coût. La réponse est ce que Claude devrait pousser à faire en premier. ~250 tokens.",
  inputSchema: {
    limit: z.number().int().min(1).max(20).optional(),
    min_priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  },
}, async (args) => {
  const all = await cachedImprovements();
  const open = all.filter(i => !i.done);
  if (open.length === 0) return { content: [{ type: 'text', text: '✓ Aucun item ouvert dans le backlog cross-repo.' }] };
  const minIdx = ['critical', 'high', 'medium', 'low'].indexOf(args.min_priority ?? 'low');
  const filtered = open.filter(i => ['critical', 'high', 'medium', 'low'].indexOf(i.priority) <= minIdx);
  const scored = filtered.map(i => {
    const pw = PRIORITY_WEIGHT[i.priority] ?? 1;
    const cw = CATEGORY_WEIGHT[i.category] ?? 1;
    const eh = EFFORT_HOURS[i.effort] ?? 8;
    const score = (pw * cw) / eh;
    return { ...i, score: Math.round(score * 100) / 100 };
  }).sort((a, b) => b.score - a.score).slice(0, args.limit ?? 10);
  const lines = scored.map((i, n) =>
    `**${n + 1}. ${i.repo}** · _${i.priority}/${i.category}/${i.effort}_ · score ${i.score}\n   ${i.title}\n   _${i.rationale.slice(0, 140)}${i.rationale.length > 140 ? '…' : ''}_`
  );
  return { content: [{ type: 'text', text:
    `# 🎯 Top ${scored.length} priorités (cross-repo)\n\n${lines.join('\n\n')}\n\n_Formule : (priorité × catégorie) / heures-effort. Sécurité/perf/bug pondérés à la hausse, docs/ux à la baisse._`,
  }] };
});

// Tool 24: repo_health — score 0-100 par repo
server.registerTool('repo_health', {
  title: 'Repo health score (0-100)',
  description: 'Score composite : récence d\'activité + ratio improvements résolues + satellites + age du repo. Renvoie un classement de tous les repos.',
  inputSchema: { name: z.string().optional() },
}, async (args) => {
  const data = await loadData();
  const allImp = await cachedImprovements();
  const sats = await cachedSatellites();
  const now = Date.now();
  let repos = data.repos;
  if (args.name) repos = repos.filter(r => r.name.toLowerCase() === args.name.toLowerCase());
  const scored = repos.map(r => {
    const daysSincePush = (now - new Date(r.last_pushed).getTime()) / 86400000;
    const recencyScore = Math.max(0, 30 - daysSincePush) / 30 * 30;
    const imp = allImp.filter(i => i.repo === r.name);
    const open = imp.filter(i => !i.done).length;
    const done = imp.filter(i => i.done).length;
    const total = open + done;
    const resolveRatio = total > 0 ? done / total : 0.5;
    const resolveScore = resolveRatio * 25;
    const openPenalty = Math.min(open * 2, 20);
    const satCount = sats.filter(s => s.repo === r.name).length;
    const satScore = Math.min(satCount * 5, 20);
    const docScore = (r.description ? 5 : 0);
    const score = Math.max(0, Math.min(100, Math.round(recencyScore + resolveScore - openPenalty + satScore + docScore)));
    let badge = '🟢'; if (score < 70) badge = '🟡'; if (score < 40) badge = '🔴';
    return { name: r.name, score, badge, daysSincePush: Math.round(daysSincePush), open, done, sats: satCount };
  }).sort((a, b) => b.score - a.score);
  const lines = scored.map(s =>
    `${s.badge} **${s.name}** : ${s.score}/100 · push ${s.daysSincePush}j · open ${s.open} · done ${s.done} · sats ${s.sats}`
  );
  return { content: [{ type: 'text', text:
    `# 🩺 Health repos\n\n${lines.join('\n')}\n\n_recency(30) + résolution(25) - openPenalty + satellites(20) + doc(5)_`,
  }] };
});

// Tool 25: cross_repo_insights — détection de patterns
server.registerTool('cross_repo_insights', {
  title: 'Patterns transverses détectés',
  description: 'Identifie les patterns qui touchent plusieurs repos : sans tests, sans CI, sans satellites, stagnants, gros dans le vault, etc. Utile pour planifier des sprints de fond.',
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const sats = await cachedSatellites();
  const allImp = await cachedImprovements();
  const now = Date.now();
  const noSats = data.repos.filter(r => !sats.find(s => s.repo === r.name));
  const stagnant = data.repos.filter(r => (now - new Date(r.last_pushed).getTime()) > 60 * 86400000);
  const noTests = allImp.filter(i => i.category === 'testing' && !i.done).map(i => i.repo);
  const noTestsSet = [...new Set(noTests)];
  const securityOpen = allImp.filter(i => i.category === 'security' && !i.done);
  const heavyRepos = data.repos.filter(r => r.id && r.note_path).slice(0, 0);
  // gros satellites
  const bigSats = sats.filter(s => s.size > 20000).map(s => `${s.repo}/${path.basename(s.path)} (${(s.size/1024).toFixed(0)}KB)`);
  const sections = [];
  if (noSats.length) sections.push(`## 🌑 Repos sans satellites (${noSats.length})\n${noSats.map(r => '- ' + r.name).join('\n')}`);
  if (stagnant.length) sections.push(`## 💤 Stagnants (>60j)\n${stagnant.map(r => '- ' + r.name).join('\n')}`);
  if (noTestsSet.length) sections.push(`## 🧪 Backlog testing ouvert\n${noTestsSet.map(r => '- ' + r).join('\n')}`);
  if (securityOpen.length) sections.push(`## 🔐 Sécurité ouverte (${securityOpen.length})\n${securityOpen.map(i => `- **${i.repo}** · ${i.title}`).join('\n')}`);
  if (bigSats.length) sections.push(`## 🐘 Satellites lourds (>20KB) — candidats consolidation\n${bigSats.map(s => '- ' + s).join('\n')}`);
  if (sections.length === 0) return { content: [{ type: 'text', text: '✓ Aucun pattern préoccupant détecté.' }] };
  return { content: [{ type: 'text', text: `# 🔭 Insights transverses\n\n${sections.join('\n\n')}` }] };
});

// Tool 26: daily_brief — composite cheap
server.registerTool('daily_brief', {
  title: 'État du brain en une commande',
  description: 'Composite cheap : vault stats + top 3 priorités + repos actifs 7j + alertes. À utiliser comme premier appel d\'une session. ~400 tokens.',
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const sats = await cachedSatellites();
  const allImp = await cachedImprovements();
  const now = Date.now();
  const recent = data.repos.filter(r => (now - new Date(r.last_pushed).getTime()) < 7 * 86400000)
    .sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  const open = allImp.filter(i => !i.done);
  const scored = open.map(i => ({
    ...i,
    score: (PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8),
  })).sort((a, b) => b.score - a.score).slice(0, 3);
  const critical = open.filter(i => i.priority === 'critical' || (i.priority === 'high' && i.category === 'security'));
  const totalKB = sats.reduce((s, x) => s + x.size, 0) / 1024;
  return { content: [{ type: 'text', text:
    `# 🌅 Daily brief — ${todayDate()}\n\n` +
    `**Vault** : ${data.repos.length} repos · ${sats.length} satellites (${totalKB.toFixed(1)} KB) · ${open.length} improvements ouvertes\n\n` +
    `## 🎯 Top 3 à pousser\n${scored.map((i, n) => `${n + 1}. **${i.repo}** — ${i.title} _(${i.priority}/${i.category})_`).join('\n') || '_aucune_'}\n\n` +
    `## 🔥 Actif sur 7 jours (${recent.length})\n${recent.slice(0, 5).map(r => `- ${r.name} [${r.language ?? '?'}]`).join('\n') || '_silence radio_'}\n\n` +
    `## ⚠️ Alertes critiques (${critical.length})\n${critical.slice(0, 5).map(i => `- **${i.repo}** · ${i.title}`).join('\n') || '_clean_'}`,
  }] };
});

// Tool 27: link_satellites — similarité cross-repo
server.registerTool('link_satellites', {
  title: 'Trouver des satellites liés sémantiquement',
  description: "Cherche les satellites les plus proches d'un satellite source via tokens partagés. Utile pour relier des réflexions cross-repo.",
  inputSchema: {
    path: z.string().describe('Chemin vault-relatif du satellite source'),
    limit: z.number().int().min(1).max(10).optional(),
  },
}, async (args) => {
  const source = await readNote(args.path);
  if (!source) return { content: [{ type: 'text', text: `❌ Source ${args.path} introuvable.` }], isError: true };
  const sourceTokens = new Set(tokenize(source).filter(t => t.length > 3));
  const sats = await cachedSatellites();
  const scored = sats.filter(s => s.path !== args.path).map(s => {
    const tokens = new Set(tokenize(s.body).filter(t => t.length > 3));
    let shared = 0;
    for (const t of tokens) if (sourceTokens.has(t)) shared++;
    const score = shared / Math.max(1, Math.sqrt(tokens.size * sourceTokens.size));
    return { path: s.path, repo: s.repo, kind: s.fm.kind, title: (s.body.match(/^#\s+(.+)/m)?.[1] ?? path.basename(s.path)), score };
  }).filter(x => x.score > 0.05).sort((a, b) => b.score - a.score).slice(0, args.limit ?? 5);
  if (scored.length === 0) return { content: [{ type: 'text', text: 'Aucun lien sémantique significatif.' }] };
  const lines = scored.map(s => `- **${s.repo}** · _${s.kind ?? 'note'}_ · sim ${s.score.toFixed(2)}\n  ${s.title}\n  _${s.path}_`);
  return { content: [{ type: 'text', text: `# 🔗 Satellites liés à ${path.basename(args.path)}\n\n${lines.join('\n\n')}` }] };
});

// Tool 28: consolidation_audit — détection de slim-able
server.registerTool('consolidation_audit', {
  title: 'Audit de consolidation du vault',
  description: 'Détecte les satellites lourds, anciens, ou les backlogs avec >50% d\'items cochés (candidats au slim). Retourne un plan d\'action.',
  inputSchema: {},
}, async () => {
  const sats = await cachedSatellites();
  const now = Date.now();
  const heavy = sats.filter(s => s.size > 15000)
    .sort((a, b) => b.size - a.size)
    .map(s => `- **${s.repo}** · ${path.basename(s.path)} · ${(s.size / 1024).toFixed(1)} KB`);
  const stale = sats.filter(s => (now - s.mtime) > 30 * 86400000 && s.fm.kind !== 'reflection' && s.fm.kind !== 'index')
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, 10)
    .map(s => {
      const days = Math.floor((now - s.mtime) / 86400000);
      return `- **${s.repo}** · ${path.basename(s.path)} · ${days}j`;
    });
  // backlogs slim-ables
  const allImp = await cachedImprovements();
  const byRepo = {};
  for (const i of allImp) {
    if (!byRepo[i.repo]) byRepo[i.repo] = { open: 0, done: 0 };
    if (i.done) byRepo[i.repo].done++; else byRepo[i.repo].open++;
  }
  const slimmable = Object.entries(byRepo)
    .filter(([_, c]) => c.done > c.open && c.done >= 5)
    .map(([r, c]) => `- **${r}** · ${c.done} ✅ vs ${c.open} ⏸️ · candidat archivage`);
  const sections = [];
  if (heavy.length) sections.push(`## 🐘 Satellites lourds (>15KB)\n${heavy.join('\n')}`);
  if (stale.length) sections.push(`## 🕸️ Satellites anciens (>30j, non-reflection)\n${stale.join('\n')}`);
  if (slimmable.length) sections.push(`## ✂️ Backlogs slim-ables\n${slimmable.join('\n')}`);
  if (sections.length === 0) return { content: [{ type: 'text', text: '✓ Vault déjà propre.' }] };
  return { content: [{ type: 'text', text: `# 🧹 Audit consolidation\n\n${sections.join('\n\n')}\n\n_Pour agir : update_satellite (slim) ou delete_satellite (purge)._` }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v6 — "Predictive" ════════════════
// ═════════════════════════════════════════════════════════════════════

// Cache LRU pour les outils chers (réduit massivement les tokens en session)
const _toolCache = new Map();
const _CACHE_TTL = 60_000; // 60s
async function cached(key, fn) {
  const hit = _toolCache.get(key);
  if (hit && Date.now() - hit.t < _CACHE_TTL) return hit.v;
  const v = await fn();
  _toolCache.set(key, { t: Date.now(), v });
  if (_toolCache.size > 30) _toolCache.delete(_toolCache.keys().next().value);
  return v;
}

// Tool 29: pulse — état du brain en UNE ligne (~30 tokens)
server.registerTool('pulse', {
  title: 'État du brain en 1 ligne',
  description: 'ULTRA-CHEAP (~30 tokens). À appeler à chaque début de session AVANT user_summary si tu veux juste savoir si quelque chose bouge. Format : "X repos · Y open · Z crit · top: <repo>".',
  inputSchema: {},
}, async () => {
  return cached('pulse', async () => {
    const data = await loadData();
    const allImp = await cachedImprovements();
    const open = allImp.filter(i => !i.done);
    const crit = open.filter(i => i.priority === 'critical').length;
    const now = Date.now();
    const recent = data.repos.filter(r => (now - new Date(r.last_pushed).getTime()) < 7 * 86400000);
    const topRecent = recent.sort((a, b) => b.last_pushed.localeCompare(a.last_pushed))[0];
    return { content: [{ type: 'text', text:
      `${data.repos.length}r · ${open.length}o · ${crit}!! · 7j:${recent.length} · ${topRecent?.name ?? '—'}`,
    }] };
  });
});

// Tool 30: intent — devine ce que l'user veut faire MAINTENANT
server.registerTool('intent', {
  title: 'Prédire l\'intention courante',
  description: "Analyse l'activité récente (commits, satellites créés, improvements ouvertes, reflections) pour deviner sur quoi l'user veut bosser. Retourne 1-3 hypothèses scorées avec contexte minimal. ~150 tokens.",
  inputSchema: {
    horizon_days: z.number().int().min(1).max(30).optional(),
  },
}, async (args) => {
  return cached(`intent:${args.horizon_days ?? 7}`, async () => {
    const horizon = (args.horizon_days ?? 7) * 86400000;
    const now = Date.now();
    const data = await loadData();
    const sats = await cachedSatellites();
    const allImp = await cachedImprovements();
    // Signal 1 : repos avec activité git récente
    const gitActive = new Map();
    for (const r of data.repos) {
      const age = now - new Date(r.last_pushed).getTime();
      if (age < horizon) gitActive.set(r.name, 1 - age / horizon);
    }
    // Signal 2 : satellites créés récemment
    const satScore = new Map();
    for (const s of sats) {
      const age = now - s.mtime;
      if (age < horizon) satScore.set(s.repo, (satScore.get(s.repo) ?? 0) + (1 - age / horizon) * 0.7);
    }
    // Signal 3 : improvements ouvertes prioritaires
    const impScore = new Map();
    for (const i of allImp.filter(x => !x.done)) {
      const w = (PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / 5000;
      impScore.set(i.repo, (impScore.get(i.repo) ?? 0) + w);
    }
    // Combine
    const combined = new Map();
    const allRepos = new Set([...gitActive.keys(), ...satScore.keys(), ...impScore.keys()]);
    for (const r of allRepos) {
      const score = (gitActive.get(r) ?? 0) * 3 + (satScore.get(r) ?? 0) * 2 + (impScore.get(r) ?? 0);
      combined.set(r, score);
    }
    const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (ranked.length === 0) return { content: [{ type: 'text', text: 'Aucun signal récent. Demande à l\'user ce qu\'il veut faire.' }] };
    const lines = ranked.map(([repo, s], i) => {
      const reasons = [];
      if (gitActive.has(repo)) reasons.push('git récent');
      if (satScore.has(repo)) reasons.push('notes récentes');
      const imp = allImp.filter(x => !x.done && x.repo === repo);
      if (imp.length) {
        const top = imp.sort((a, b) => (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0))[0];
        reasons.push(`${imp.length} open (top: ${top.title.slice(0, 60)})`);
      }
      return `${i + 1}. **${repo}** _(score ${s.toFixed(2)})_ — ${reasons.join(' · ')}`;
    });
    return { content: [{ type: 'text', text:
      `# 🔮 Intention probable\n\n${lines.join('\n')}\n\n_Pour creuser : \`get_repo_summary <name>\` ou \`list_improvements <name>\`._`,
    }] };
  });
});

// Tool 31: next_action — UNE action concrète à proposer maintenant
server.registerTool('next_action', {
  title: 'Proposer LA prochaine action',
  description: "Renvoie UNE seule action concrète et nommée, choisie par l'intersection de (intent × prioritize × repo_health). Le but : éviter que Claude demande \"par quoi tu veux commencer ?\". ~80 tokens.",
  inputSchema: {},
}, async () => {
  return cached('next_action', async () => {
    const horizon = 7 * 86400000;
    const now = Date.now();
    const data = await loadData();
    const sats = await cachedSatellites();
    const allImp = await cachedImprovements();
    // Repos avec activité (intent)
    const intentScore = {};
    for (const r of data.repos) {
      const age = now - new Date(r.last_pushed).getTime();
      if (age < horizon) intentScore[r.name] = 1 - age / horizon;
    }
    for (const s of sats) {
      const age = now - s.mtime;
      if (age < horizon) intentScore[s.repo] = (intentScore[s.repo] ?? 0) + (1 - age / horizon) * 0.5;
    }
    // Choisir l'improvement avec score le plus haut PARMI les repos in-intent (si possible)
    const open = allImp.filter(i => !i.done);
    const scored = open.map(i => {
      const pw = PRIORITY_WEIGHT[i.priority] ?? 1;
      const cw = CATEGORY_WEIGHT[i.category] ?? 1;
      const eh = EFFORT_HOURS[i.effort] ?? 8;
      const baseScore = (pw * cw) / eh;
      const intentBoost = 1 + (intentScore[i.repo] ?? 0) * 2;
      return { ...i, score: baseScore * intentBoost };
    }).sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      return { content: [{ type: 'text', text: 'Backlog vide. Suggestion : `cross_repo_insights` pour trouver des sprints de fond.' }] };
    }
    const pick = scored[0];
    return { content: [{ type: 'text', text:
      `🎯 **Prochaine action** (repo: **${pick.repo}**)\n\n${pick.title}\n\n` +
      `_${pick.priority}/${pick.category}/${pick.effort}_ · score ${pick.score.toFixed(2)}\n\n` +
      `**Pourquoi** : ${pick.rationale}\n\n` +
      `Dis "go" pour démarrer, ou \`list_improvements ${pick.repo}\` pour voir les alternatives.`,
    }] };
  });
});

// Tool 32: micro_search — search_brain mais avec excerpts ultra-courts (60 chars)
server.registerTool('micro_search', {
  title: 'Search ultra-frugal',
  description: 'Comme search_brain mais retourne uniquement le repo · section · score (PAS d\'extraits). ~10 tokens par hit. Utiliser pour scanner avant un appel cher.',
  inputSchema: {
    query: z.string(),
    limit: z.number().int().min(1).max(15).optional(),
  },
}, async (args) => {
  const results = await smartSearch(args.query, args.limit ?? 8);
  if (results.length === 0) return { content: [{ type: 'text', text: `∅ "${args.query}"` }] };
  const lines = results.map(r => `${r.repo}/${r.section} (${r.score})`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// Tool 33: explain_score — pourquoi une priorité est haute/basse
server.registerTool('explain_score', {
  title: 'Décomposer un score de priorité',
  description: "Explique pourquoi une improvement a tel score : montre les coefficients priorité/catégorie/effort. Utile pour debugger les classements.",
  inputSchema: {
    repo: z.string(),
    title_match: z.string(),
  },
}, async (args) => {
  const all = await cachedImprovements();
  const needle = args.title_match.toLowerCase();
  const match = all.find(i => i.repo === args.repo && i.title.toLowerCase().includes(needle));
  if (!match) return { content: [{ type: 'text', text: `❌ "${args.title_match}" non trouvée dans ${args.repo}.` }], isError: true };
  const pw = PRIORITY_WEIGHT[match.priority] ?? 1;
  const cw = CATEGORY_WEIGHT[match.category] ?? 1;
  const eh = EFFORT_HOURS[match.effort] ?? 8;
  const score = (pw * cw) / eh;
  return { content: [{ type: 'text', text:
    `# ${match.title}\n\n` +
    `- Priorité **${match.priority}** → poids ${pw}\n` +
    `- Catégorie **${match.category}** → coef ${cw}\n` +
    `- Effort **${match.effort}** → ${eh}h\n\n` +
    `→ score = (${pw} × ${cw}) / ${eh} = **${score.toFixed(2)}**\n\n` +
    `${match.done ? '✅ Fait' : '⏸️ Ouverte'} · ajoutée ${match.date}`,
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v7 — "Persistent" ════════════════
// ═════════════════════════════════════════════════════════════════════

const PREFS_PATH = 'GalacticBrain/_prefs.json';
const HANDOFF_PATH = 'GalacticBrain/_handoff.json';

// ── Cache global v8 — TTL simple 15s, AUCUNE récursion ──
// BUG v8 corrigé en v11.1 : précédemment les wrappers s'appelaient eux-mêmes (sed accidentel).
let _satCache = null;   // { ts, data }
let _impCache = null;
const _CACHE_TTL_FS = 15000;
async function cachedSatellites() {
  const now = Date.now();
  if (_satCache && now - _satCache.ts < _CACHE_TTL_FS) return _satCache.data;
  const data = await listAllSatellites();
  _satCache = { ts: now, data };
  return data;
}
async function cachedImprovements() {
  const now = Date.now();
  if (_impCache && now - _impCache.ts < _CACHE_TTL_FS) return _impCache.data;
  const data = await listImprovementsFolder();
  _impCache = { ts: now, data };
  return data;
}
function _invalidateFsCache() { _satCache = null; _impCache = null; }

async function readJson(rel, fallback) {
  try {
    const raw = await fs.readFile(safeVaultPath(rel), 'utf-8');
    return JSON.parse(raw);
  } catch { return fallback; }
}
async function writeJson(rel, data) {
  await fs.writeFile(safeVaultPath(rel), JSON.stringify(data, null, 2), 'utf-8');
}

// Tool 34: quick_note — drop a thought without ceremony, auto-routed
server.registerTool('quick_note', {
  title: 'Capture rapide d\'une idée',
  description: "Drop une note SANS ceremony. Si tu mentionnes un nom de repo, elle est routée. Sinon elle va dans GalacticBrain/_inbox. ~20 tokens.",
  inputSchema: {
    text: z.string(),
    repo: z.string().optional(),
  },
}, async (args) => {
  const data = await loadData();
  let target = args.repo;
  if (!target) {
    const lc = args.text.toLowerCase();
    target = data.repos.find(r => lc.includes(r.name.toLowerCase()))?.name;
  }
  const today = todayDate();
  const slug2 = slug(args.text.slice(0, 40));
  if (target) {
    const repo = data.repos.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!repo) return { content: [{ type: 'text', text: `❌ Repo "${target}" non trouvé.` }], isError: true };
    const folder = path.dirname(repo.note_path).split(path.sep).join('/') + '/_claude/' + repo.name;
    await fs.mkdir(safeVaultPath(folder), { recursive: true });
    const filePath = `${folder}/${today}-note-${slug2}.md`;
    const body = `---\nparent_repo: ${repo.name}\nkind: note\ncreated: ${nowIso()}\n---\n\n${args.text}\n`;
    await writeNote(filePath, body);
    return { content: [{ type: 'text', text: `✓ → ${repo.name}/${slug2}` }] };
  }
  const folder = 'GalacticBrain/_inbox';
  await fs.mkdir(safeVaultPath(folder), { recursive: true });
  const filePath = `${folder}/${today}-${slug2}.md`;
  await writeNote(filePath, `# ${args.text.split('\n')[0].slice(0, 80)}\n\n${args.text}\n\n_captured ${nowIso()}_`);
  return { content: [{ type: 'text', text: `✓ → _inbox/${slug2}` }] };
});

// Tool 35: session_handoff — save state + auto-restore
server.registerTool('session_handoff', {
  title: 'Sauver/restaurer l\'état de session',
  description: "Sans args = lit le dernier handoff (cheap). Avec args = écrit un nouveau. À appeler à la fin d'une session avec ce qu'il reste à faire ; au début de la suivante pour reprendre le fil.",
  inputSchema: {
    save: z.object({
      context: z.string().describe('Sur quoi on bossait'),
      next: z.string().describe('Prochaine étape concrète'),
      repo: z.string().optional(),
    }).optional(),
  },
}, async (args) => {
  if (args.save) {
    await writeJson(HANDOFF_PATH, {
      ...args.save,
      saved_at: nowIso(),
    });
    return { content: [{ type: 'text', text: `✓ Handoff sauvegardé pour la prochaine session.` }] };
  }
  const prev = await readJson(HANDOFF_PATH, null);
  if (!prev) return { content: [{ type: 'text', text: '∅ Aucun handoff précédent.' }] };
  const ageH = Math.round((Date.now() - new Date(prev.saved_at).getTime()) / 3600000);
  return { content: [{ type: 'text', text:
    `# 🔁 Reprise (il y a ${ageH}h)\n\n` +
    `**Repo** : ${prev.repo ?? '—'}\n` +
    `**Contexte** : ${prev.context}\n` +
    `**Next** : ${prev.next}\n\n` +
    `_Pour effacer : session_handoff avec save vide._`,
  }] };
});

// Tool 36: pref — préférences persistantes
server.registerTool('pref', {
  title: 'Préférences utilisateur persistantes',
  description: "Get ou set une préférence. Sans args = liste. Le brain s'en sert pour adapter son comportement (langue, verbosité, repos favoris, etc.).",
  inputSchema: {
    key: z.string().optional(),
    value: z.string().optional(),
  },
}, async (args) => {
  const prefs = await readJson(PREFS_PATH, {});
  if (args.key && args.value !== undefined) {
    prefs[args.key] = args.value;
    await writeJson(PREFS_PATH, prefs);
    return { content: [{ type: 'text', text: `✓ ${args.key} = ${args.value}` }] };
  }
  if (args.key) {
    return { content: [{ type: 'text', text: prefs[args.key] !== undefined ? String(prefs[args.key]) : '∅' }] };
  }
  const keys = Object.keys(prefs);
  if (keys.length === 0) return { content: [{ type: 'text', text: '∅ aucune préférence' }] };
  return { content: [{ type: 'text', text: keys.map(k => `- ${k}: ${prefs[k]}`).join('\n') }] };
});

// Tool 37: since_last_visit — quoi de neuf depuis dernier appel à pulse/handoff
server.registerTool('since_last_visit', {
  title: 'Quoi de neuf depuis la dernière session',
  description: "Compare timestamps avec le dernier handoff et liste : commits récents, nouvelles improvements, nouveaux satellites. ~150 tokens.",
  inputSchema: {},
}, async () => {
  const handoff = await readJson(HANDOFF_PATH, null);
  const since = handoff ? new Date(handoff.saved_at).getTime() : Date.now() - 7 * 86400000;
  const data = await loadData();
  const sats = await cachedSatellites();
  const newCommits = data.repos.filter(r => new Date(r.last_pushed).getTime() > since)
    .sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  const newSats = sats.filter(s => s.mtime > since)
    .sort((a, b) => b.mtime - a.mtime);
  const ageH = Math.round((Date.now() - since) / 3600000);
  const lines = [];
  lines.push(`# 📰 ${ageH}h écoulées`);
  if (newCommits.length) lines.push(`\n## 🔥 Commits (${newCommits.length})\n${newCommits.slice(0, 5).map(r => `- ${r.name}`).join('\n')}`);
  if (newSats.length) lines.push(`\n## 📝 Notes (${newSats.length})\n${newSats.slice(0, 5).map(s => `- ${s.repo}/${path.basename(s.path)}`).join('\n')}`);
  if (!newCommits.length && !newSats.length) lines.push('\n_Rien de neuf._');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// Tool 38: recommend — meta : étant donné une phrase user, suggère LE bon outil MCP
server.registerTool('recommend', {
  title: 'Recommander le bon outil MCP',
  description: "Étant donné une phrase utilisateur, suggère LE meilleur outil à appeler en premier. Évite à Claude de tâtonner. Quasi-gratuit (~40 tokens).",
  inputSchema: { phrase: z.string() },
}, async (args) => {
  const p = args.phrase.toLowerCase();
  const rules = [
    [/sur quoi.*je.*(travaill|bossai|bosse)|qu'est.*je.*fai|reprend/, 'session_handoff puis intent'],
    [/quoi.*neuf|depuis|nouveau/, 'since_last_visit'],
    [/par quoi.*commenc|action|prochain|next/, 'next_action'],
    [/priorité|priorit|importanc|top/, 'prioritize'],
    [/santé|health|état/, 'repo_health'],
    [/pattern|transvers|tous mes repos|sans test|sans ci/, 'cross_repo_insights'],
    [/nettoy|consolid|slim|allég/, 'consolidation_audit'],
    [/cherch|trouv|où|où est/, 'micro_search puis search_brain'],
    [/résum|brief|tour|aperç/, 'daily_brief'],
    [/note|capt|idée|drop/, 'quick_note'],
    [/score|pourquoi|explique/, 'explain_score'],
    [/préfér|config|réglage/, 'pref'],
    [/lié|similaire|related/, 'link_satellites OU find_similar_repos'],
    [/améli|improvement|backlog/, 'list_improvements OU add_improvement'],
  ];
  for (const [re, tool] of rules) if (re.test(p)) return { content: [{ type: 'text', text: `→ ${tool}` }] };
  return { content: [{ type: 'text', text: '→ pulse (par défaut)' }] };
});

// Tool 39: focus_session — plan d'une session ciblée (3 actions séquentielles)
server.registerTool('focus_session', {
  title: 'Plan de session ciblée',
  description: "Renvoie 3 actions séquentielles optimales pour une session de N heures. Combine intent + prioritize + effort budget.",
  inputSchema: {
    hours: z.number().min(0.5).max(8).optional(),
    repo: z.string().optional(),
  },
}, async (args) => {
  const budget = args.hours ?? 2;
  const all = await cachedImprovements();
  let pool = all.filter(i => !i.done);
  if (args.repo) pool = pool.filter(i => i.repo.toLowerCase() === args.repo.toLowerCase());
  // Boost intent
  const data = await loadData();
  const sats = await cachedSatellites();
  const now = Date.now();
  const intentScore = {};
  for (const r of data.repos) {
    const age = now - new Date(r.last_pushed).getTime();
    if (age < 7 * 86400000) intentScore[r.name] = 1 - age / (7 * 86400000);
  }
  for (const s of sats) {
    const age = now - s.mtime;
    if (age < 7 * 86400000) intentScore[s.repo] = (intentScore[s.repo] ?? 0) + (1 - age / (7 * 86400000)) * 0.5;
  }
  // Knapsack greedy : score / effort, respect budget
  const scored = pool.map(i => ({
    ...i,
    hours: EFFORT_HOURS[i.effort] ?? 8,
    score: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)) * (1 + (intentScore[i.repo] ?? 0)),
  })).sort((a, b) => b.score - a.score);
  const plan = [];
  let used = 0;
  for (const x of scored) {
    if (used + x.hours > budget * 1.1) continue;
    plan.push(x);
    used += x.hours;
    if (plan.length >= 3) break;
  }
  if (plan.length === 0) return { content: [{ type: 'text', text: `Aucune action ne tient en ${budget}h. Réduis ou choisis un repo plus chargé.` }] };
  const lines = plan.map((p, i) => `${i + 1}. **[${p.repo}]** ${p.title} _(${p.effort}, ${p.category}/${p.priority})_`);
  return { content: [{ type: 'text', text:
    `# 🎯 Plan de session (${budget}h, ${used.toFixed(1)}h planifiés)\n\n${lines.join('\n')}\n\n` +
    `_Lance avec next_action pour la #1, puis check_improvement pour clore._`,
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v8 — "Omniscient" ════════════════
// ═════════════════════════════════════════════════════════════════════

// Tool 40: digest — JSON-compact ultra-frugal (~80 tokens pour vault entier)
server.registerTool('digest', {
  title: 'JSON-compact du vault entier',
  description: "ULTRA-CHEAP. JSON one-shot avec repos[name,lang,age,open,health] + top_actions[3]. Pour démarrer une session en 1 seul appel. ~80 tokens.",
  inputSchema: {},
}, async () => {
  return cached('digest', async () => {
    const data = await loadData();
    const sats = await cachedSatellites();
    const imp = await cachedImprovements();
    const now = Date.now();
    const open = imp.filter(i => !i.done);
    const repos = data.repos.map(r => {
      const ageD = Math.floor((now - new Date(r.last_pushed).getTime()) / 86400000);
      const o = open.filter(i => i.repo === r.name).length;
      const d = imp.filter(i => i.done && i.repo === r.name).length;
      const sat = sats.filter(s => s.repo === r.name).length;
      const h = Math.max(0, Math.min(100, Math.round(Math.max(0, 30 - ageD) + (d / Math.max(1, o + d)) * 25 - Math.min(o * 2, 20) + Math.min(sat * 5, 20))));
      return { n: r.name, l: r.language, a: ageD, o, h };
    }).sort((a, b) => b.h - a.h);
    const top = open.map(i => ({
      r: i.repo, t: i.title.slice(0, 50),
      s: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)).toFixed(1),
    })).sort((a, b) => parseFloat(b.s) - parseFloat(a.s)).slice(0, 3);
    return { content: [{ type: 'text', text: JSON.stringify({ repos, top, open: open.length, sats: sats.length }) }] };
  });
});

// Tool 41: estimate — temps de complétion réaliste
server.registerTool('estimate', {
  title: 'Estimer le temps réel',
  description: "Au-delà du champ effort, calcule un temps probable basé sur catégorie + dépendances détectées (mots-clés 'blocked', 'attente', 'décision').",
  inputSchema: { repo: z.string(), title_match: z.string() },
}, async (args) => {
  const all = await cachedImprovements();
  const needle = args.title_match.toLowerCase();
  const i = all.find(x => x.repo === args.repo && x.title.toLowerCase().includes(needle));
  if (!i) return { content: [{ type: 'text', text: `❌ "${args.title_match}" non trouvée.` }], isError: true };
  const baseH = EFFORT_HOURS[i.effort] ?? 8;
  const friction = { security: 1.4, architecture: 1.6, perf: 1.3, testing: 1.2, devops: 1.3, 'code-quality': 1.0, feature: 1.5, bug: 1.1, ux: 1.2, docs: 0.8 };
  const f = friction[i.category] ?? 1;
  const blocked = /blocked by|attente|coordination|décision|access/i.test(i.rationale);
  const totalH = baseH * f * (blocked ? 1.5 : 1);
  const days = totalH / 6;
  return { content: [{ type: 'text', text:
    `**${i.title}**\n` +
    `Effort déclaré : ${i.effort} (~${baseH}h)\n` +
    `Friction catégorie : ×${f}\n` +
    `${blocked ? 'Blocage détecté : ×1.5\n' : ''}` +
    `→ **${totalH.toFixed(1)}h** (~${days.toFixed(1)} jours productifs)`,
  }] };
});

// Tool 42: anomaly — détection d'anomalies vs moyenne
server.registerTool('anomaly', {
  title: 'Détecter ce qui cloche',
  description: "Compare l'activité récente à la moyenne 30j. Détecte silence, surcharge criticals, ratio dégradé, vieux items en attente.",
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const sats = await cachedSatellites();
  const imp = await cachedImprovements();
  const now = Date.now();
  const week = 7 * 86400000;
  const month = 30 * 86400000;
  const recentSats = sats.filter(s => now - s.mtime < week).length;
  const olderSats = sats.filter(s => now - s.mtime >= week && now - s.mtime < month).length / 3;
  const reposPushed7 = data.repos.filter(r => now - new Date(r.last_pushed).getTime() < week).length;
  const reposPushed30 = data.repos.filter(r => now - new Date(r.last_pushed).getTime() < month).length / 4;
  const alerts = [];
  if (recentSats < olderSats * 0.4) alerts.push(`📉 Création de notes en chute (${recentSats}/7j vs ~${olderSats.toFixed(1)}/sem)`);
  if (reposPushed7 < reposPushed30 * 0.5 && reposPushed30 > 0) alerts.push(`💤 Activité git réduite (${reposPushed7} vs ~${reposPushed30.toFixed(1)}/sem)`);
  const openCrit = imp.filter(i => !i.done && i.priority === 'critical');
  if (openCrit.length > 3) alerts.push(`🔥 ${openCrit.length} criticals ouverts (>3 = surcharge)`);
  const ratioOpen = imp.length > 0 ? imp.filter(i => !i.done).length / imp.length : 0;
  if (ratioOpen > 0.7 && imp.length > 5) alerts.push(`📊 ${(ratioOpen * 100).toFixed(0)}% du backlog ouvert (résolution stagnante)`);
  const oldOpen = imp.filter(i => !i.done && i.date && (Date.now() - new Date(i.date).getTime()) > 60 * 86400000);
  if (oldOpen.length > 2) alerts.push(`🦴 ${oldOpen.length} items >60j (dette de décision)`);
  if (alerts.length === 0) return { content: [{ type: 'text', text: '✓ Aucune anomalie. Rythme normal.' }] };
  return { content: [{ type: 'text', text: `# ⚠️ Anomalies\n\n${alerts.join('\n\n')}` }] };
});

// Tool 43: auto_link — paires de satellites cross-repo à wiki-linker
server.registerTool('auto_link', {
  title: 'Suggérer des wiki-links cross-repo',
  description: "Détecte les paires cross-repo avec haute similarité mais sans lien Obsidian. Top 5 paires à wiki-linker manuellement.",
  inputSchema: { threshold: z.number().min(0).max(1).optional() },
}, async (args) => {
  const sats = await cachedSatellites();
  const threshold = args.threshold ?? 0.18;
  const tokenized = sats.map(s => ({ ...s, tokens: new Set(tokenize(s.body).filter(t => t.length > 3)) }));
  const pairs = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      if (tokenized[i].repo === tokenized[j].repo) continue;
      let shared = 0;
      for (const t of tokenized[i].tokens) if (tokenized[j].tokens.has(t)) shared++;
      const sim = shared / Math.max(1, Math.sqrt(tokenized[i].tokens.size * tokenized[j].tokens.size));
      if (sim < threshold) continue;
      const aBase = path.basename(tokenized[i].path, '.md');
      const bBase = path.basename(tokenized[j].path, '.md');
      if (tokenized[i].body.includes(bBase) || tokenized[j].body.includes(aBase)) continue;
      pairs.push({ a: tokenized[i], b: tokenized[j], sim });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  const top = pairs.slice(0, 5);
  if (top.length === 0) return { content: [{ type: 'text', text: `Aucun lien suggéré (seuil ${threshold}).` }] };
  const lines = top.map(p => `- **${p.a.repo}** ↔ **${p.b.repo}** _(sim ${p.sim.toFixed(2)})_\n  ${path.basename(p.a.path)} ↔ ${path.basename(p.b.path)}`);
  return { content: [{ type: 'text', text: `# 🔗 Wiki-links suggérés\n\n${lines.join('\n\n')}` }] };
});

// Tool 44: cache_status — debug perf
server.registerTool('cache_status', {
  title: 'État du cache global',
  description: 'Status du cache (gratuit). Permet de débugger la perf.',
  inputSchema: {},
}, async () => {
  return { content: [{ type: 'text', text:
    `sat:${_satCache ? _satCache.data.length + ' items' : 'cold'} · ` +
    `imp:${_impCache ? _impCache.data.length + ' items' : 'cold'} · ` +
    `tools:${_toolCache.size}`,
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v9 — "Cohesive" ══════════════════
// ═════════════════════════════════════════════════════════════════════

const GOALS_PATH = 'GalacticBrain/_goals.json';
const DECISIONS_PATH = 'GalacticBrain/_decisions.jsonl';

// Tool 45: wake_up — UN appel = digest + handoff + since + intent. Le call de démarrage parfait.
server.registerTool('wake_up', {
  title: 'Single-call session start',
  description: "LE point d'entrée d'une session : retourne en 1 appel un compact session-reboot (handoff + delta + intent + top 3). Remplace 4 appels séparés. ~250 tokens.",
  inputSchema: {},
}, async () => {
  const [handoff, data, sats, imp] = await Promise.all([
    readJson(HANDOFF_PATH, null),
    loadData(),
    cachedSatellites(),
    cachedImprovements(),
  ]);
  const now = Date.now();
  const since = handoff ? new Date(handoff.saved_at).getTime() : now - 7 * 86400000;
  const newCommits = data.repos.filter(r => new Date(r.last_pushed).getTime() > since).length;
  const newSats = sats.filter(s => s.mtime > since).length;
  const open = imp.filter(i => !i.done);
  // Intent
  const intentScore = {};
  for (const r of data.repos) {
    const age = now - new Date(r.last_pushed).getTime();
    if (age < 7 * 86400000) intentScore[r.name] = 1 - age / (7 * 86400000);
  }
  for (const s of sats) {
    const age = now - s.mtime;
    if (age < 7 * 86400000) intentScore[s.repo] = (intentScore[s.repo] ?? 0) + (1 - age / (7 * 86400000)) * 0.5;
  }
  const intent = [...Object.entries(intentScore)].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  // Top 3 actions
  const top = open.map(i => ({
    ...i,
    score: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)) * (1 + (intentScore[i.repo] ?? 0)),
  })).sort((a, b) => b.score - a.score).slice(0, 3);
  const ageH = handoff ? Math.round((now - new Date(handoff.saved_at).getTime()) / 3600000) : null;
  return { content: [{ type: 'text', text:
    `# ☀️ Wake up\n\n` +
    (handoff
      ? `**Reprise (${ageH}h)** : ${handoff.context}\n→ ${handoff.next}\n\n`
      : `**Pas de handoff précédent.**\n\n`) +
    `**Δ depuis** : ${newCommits} commits · ${newSats} notes\n` +
    `**Foyer d'activité** : ${intent.join(', ') || '—'}\n\n` +
    `**Top 3 à pousser :**\n` +
    top.map((i, n) => `${n + 1}. [${i.repo}] ${i.title.slice(0, 70)} _(${i.priority}/${i.category})_`).join('\n'),
  }] };
});

// Tool 46: commit_intent — extrait intention d'une phrase + propose action
server.registerTool('commit_intent', {
  title: 'Extraire l\'intention d\'une phrase et proposer une action',
  description: "Étant donné une phrase user (\"je veux pousser auth en prod\", \"il faut nettoyer Cycling\"), extrait : repo cible, type d'action, et propose l'outil + arguments.",
  inputSchema: { phrase: z.string() },
}, async (args) => {
  const data = await loadData();
  const p = args.phrase.toLowerCase();
  const repo = data.repos.find(r => p.includes(r.name.toLowerCase()))?.name ?? null;
  const verbMap = [
    [/(nettoy|clean|slim|all[eé]g|consolid)/, { tool: 'consolidation_audit', desc: 'audit ce qui peut être consolidé' }],
    [/(pousse|ship|deploy|prod|relea)/, { tool: 'prioritize', desc: 'priorités à closer avant ship' }],
    [/(audit|s[eé]cur|cve|vuln)/, { tool: 'prioritize', args: { min_priority: 'high' }, desc: 'high+critical seulement' }],
    [/(reprend|continu|hier|recommen)/, { tool: 'wake_up', desc: 'reprise complète' }],
    [/(quoi|qu'est|sur quoi|fais-moi)/, { tool: 'digest', desc: 'vue d\'ensemble' }],
    [/(ajou|nouveau|n[oô]te|capt)/, { tool: 'quick_note', desc: 'capture' }],
    [/(plan|session|aujourd|ce matin)/, { tool: 'focus_session', desc: 'plan de session' }],
    [/(état|sant|health)/, { tool: 'repo_health', desc: 'santé des repos' }],
    [/(neuf|nouveau|change)/, { tool: 'since_last_visit', desc: 'delta' }],
    [/(comparer|patterns|sans test)/, { tool: 'cross_repo_insights', desc: 'patterns transverses' }],
    [/(idée|brainstorm|réfléchi)/, { tool: 'compose_brief', desc: 'brief composite' }],
    [/(suivant|prochain|next|que faire)/, { tool: 'next_action', desc: 'action immédiate' }],
  ];
  const matches = verbMap.filter(([re]) => re.test(p)).map(([_, v]) => v);
  if (matches.length === 0) {
    return { content: [{ type: 'text', text:
      `Aucune intention claire. Suggestion : \`wake_up\` ou \`digest\`.\n\nPhrase : "${args.phrase}"`,
    }] };
  }
  const lines = matches.slice(0, 3).map((m, i) =>
    `${i + 1}. **${m.tool}**${m.args ? ` ${JSON.stringify(m.args)}` : ''} ${repo ? `(repo=${repo})` : ''} — ${m.desc}`
  );
  return { content: [{ type: 'text', text: `# 🎯 Intent\n\nRepo détecté : **${repo ?? '—'}**\n\n${lines.join('\n')}` }] };
});

// Tool 47: goals — long-term goal tracking (persistence JSON)
server.registerTool('goals', {
  title: 'Objectifs long-terme',
  description: "Gestion d'objectifs : list (par défaut), add {title,deadline,repo?}, complete {title_match}, remove {title_match}.",
  inputSchema: {
    action: z.enum(['list', 'add', 'complete', 'remove']).optional(),
    title: z.string().optional(),
    deadline: z.string().optional(),
    repo: z.string().optional(),
    title_match: z.string().optional(),
  },
}, async (args) => {
  const action = args.action ?? 'list';
  const goals = await readJson(GOALS_PATH, []);
  if (action === 'add') {
    if (!args.title) return { content: [{ type: 'text', text: '❌ title requis.' }], isError: true };
    goals.push({ title: args.title, deadline: args.deadline ?? null, repo: args.repo ?? null, created: todayDate(), done: false });
    await writeJson(GOALS_PATH, goals);
    return { content: [{ type: 'text', text: `✓ Objectif ajouté : ${args.title}` }] };
  }
  if (action === 'complete' || action === 'remove') {
    const needle = (args.title_match ?? '').toLowerCase();
    const idx = goals.findIndex(g => g.title.toLowerCase().includes(needle));
    if (idx < 0) return { content: [{ type: 'text', text: `❌ "${args.title_match}" non trouvé.` }], isError: true };
    if (action === 'complete') { goals[idx].done = true; goals[idx].completed = todayDate(); }
    else goals.splice(idx, 1);
    await writeJson(GOALS_PATH, goals);
    return { content: [{ type: 'text', text: `✓ ${action} : ${args.title_match}` }] };
  }
  if (goals.length === 0) return { content: [{ type: 'text', text: '∅ Aucun objectif. Utilise `goals action:add title:"..."`.' }] };
  const now = Date.now();
  const lines = goals.map(g => {
    let status = g.done ? '✅' : '🎯';
    let suffix = '';
    if (g.deadline) {
      const days = Math.round((new Date(g.deadline).getTime() - now) / 86400000);
      suffix = ` · ${days >= 0 ? `J-${days}` : `+${-days}j retard`}`;
    }
    if (g.repo) suffix += ` · [${g.repo}]`;
    return `${status} ${g.title}${suffix}`;
  });
  return { content: [{ type: 'text', text: `# 🎯 Objectifs (${goals.length})\n\n${lines.join('\n')}` }] };
});

// Tool 48: decision — log/query décisions architecturales (append-only JSONL)
server.registerTool('decision', {
  title: 'Logger ou consulter une décision',
  description: "Log append-only des décisions : log {repo,title,reason,alternatives?}, list {repo?,limit?}. Crée le rationale durable d'une architecture.",
  inputSchema: {
    action: z.enum(['log', 'list']),
    repo: z.string().optional(),
    title: z.string().optional(),
    reason: z.string().optional(),
    alternatives: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
}, async (args) => {
  if (args.action === 'log') {
    if (!args.title || !args.reason) return { content: [{ type: 'text', text: '❌ title + reason requis.' }], isError: true };
    const entry = { date: nowIso(), repo: args.repo ?? null, title: args.title, reason: args.reason, alternatives: args.alternatives ?? null };
    const existing = await readNote(DECISIONS_PATH);
    await fs.writeFile(safeVaultPath(DECISIONS_PATH), (existing ?? '') + JSON.stringify(entry) + '\n', 'utf-8');
    return { content: [{ type: 'text', text: `✓ Décision loggée : ${args.title}` }] };
  }
  const raw = await readNote(DECISIONS_PATH);
  if (!raw) return { content: [{ type: 'text', text: '∅ Aucune décision loggée.' }] };
  let entries = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (args.repo) entries = entries.filter(e => e.repo === args.repo);
  entries = entries.slice(-((args.limit ?? 10))).reverse();
  const lines = entries.map(e => `**${e.date.slice(0, 10)}** · ${e.repo ?? 'cross'}\n  ${e.title}\n  _${e.reason.slice(0, 120)}_`);
  return { content: [{ type: 'text', text: `# 📜 Décisions (${entries.length})\n\n${lines.join('\n\n')}` }] };
});

// Tool 49: timeline — vue chronologique unifiée
server.registerTool('timeline', {
  title: 'Vue chronologique du brain',
  description: "Mélange commits + satellites + improvements + décisions par date décroissante. Filtrable par repo. ~250 tokens pour 15 entrées.",
  inputSchema: {
    repo: z.string().optional(),
    limit: z.number().int().min(1).max(30).optional(),
  },
}, async (args) => {
  const limit = args.limit ?? 15;
  const data = await loadData();
  const sats = await cachedSatellites();
  const imp = await cachedImprovements();
  const events = [];
  for (const r of data.repos) {
    if (args.repo && r.name !== args.repo) continue;
    events.push({ t: new Date(r.last_pushed).getTime(), kind: 'commit', repo: r.name, label: `git push ${r.name}` });
  }
  for (const s of sats) {
    if (args.repo && s.repo !== args.repo) continue;
    events.push({ t: s.mtime, kind: 'sat', repo: s.repo, label: `${s.fm.kind ?? 'note'} · ${path.basename(s.path).slice(0, 50)}` });
  }
  for (const i of imp) {
    if (args.repo && i.repo !== args.repo) continue;
    const t = i.date ? new Date(i.date).getTime() : 0;
    if (t > 0) events.push({ t, kind: i.done ? 'done' : 'open', repo: i.repo, label: `${i.done ? '✅' : '➕'} ${i.title.slice(0, 50)}` });
  }
  const dec = await readNote(DECISIONS_PATH);
  if (dec) {
    for (const line of dec.split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (args.repo && e.repo !== args.repo) continue;
        events.push({ t: new Date(e.date).getTime(), kind: 'decision', repo: e.repo ?? 'cross', label: `📜 ${e.title}` });
      } catch {}
    }
  }
  events.sort((a, b) => b.t - a.t);
  const top = events.slice(0, limit);
  if (top.length === 0) return { content: [{ type: 'text', text: '∅ rien à afficher.' }] };
  const fmt = t => new Date(t).toISOString().slice(0, 10);
  const icons = { commit: '🔥', sat: '📝', done: '✅', open: '➕', decision: '📜' };
  const lines = top.map(e => `${fmt(e.t)} ${icons[e.kind]} [${e.repo}] ${e.label}`);
  return { content: [{ type: 'text', text: `# 🕒 Timeline\n\n${lines.join('\n')}` }] };
});

// Tool 50: dry_run — preview ce qu'un outil ferait sans exécuter
server.registerTool('dry_run', {
  title: 'Simuler un appel d\'outil sans effet',
  description: "Décrit ce que tool ferait avec args sans l'exécuter (pour confirmation user). Ne mute jamais le vault.",
  inputSchema: {
    tool: z.string(),
    args: z.record(z.any()).optional(),
  },
}, async (args) => {
  const sims = {
    add_improvement: (a) => `→ Ajouterait une amélioration "${a?.title}" à ${a?.repo} (priorité=${a?.priority}, catégorie=${a?.category}).`,
    delete_satellite: (a) => `→ Supprimerait ${a?.path ?? `${a?.repo}/${a?.slug}`} (irréversible).`,
    update_satellite: (a) => `→ Remplacerait le body de ${a?.path ?? `${a?.repo}/${a?.slug}`} (${a?.content ? a.content.length + ' chars' : 'sans content'}).`,
    create_satellite_note: (a) => `→ Créerait satellite "${a?.title}" dans ${a?.repo} (kind=${a?.kind}).`,
    check_improvement: (a) => `→ Cocherait l'improvement matchant "${a?.title_match}" dans ${a?.repo}.`,
    delete_improvement: (a) => `→ Supprimerait l'improvement matchant "${a?.title_match}" dans ${a?.repo}.`,
    quick_note: (a) => `→ Drop note ${a?.repo ? `vers ${a.repo}` : `dans _inbox`} : "${a?.text?.slice(0, 60)}…"`,
    session_handoff: (a) => a?.save ? `→ Sauvegarde handoff : ${a.save.next}` : `→ Lit le dernier handoff.`,
    pref: (a) => a?.key && a?.value !== undefined ? `→ Set ${a.key} = ${a.value}` : `→ Get ${a?.key ?? 'all'}`,
    goals: (a) => a?.action === 'add' ? `→ Ajouterait objectif "${a.title}"` : a?.action === 'complete' ? `→ Cocherait "${a.title_match}"` : `→ List goals`,
    decision: (a) => a?.action === 'log' ? `→ Loggerait décision "${a.title}"` : `→ List decisions`,
  };
  const sim = sims[args.tool];
  if (!sim) return { content: [{ type: 'text', text: `Outil "${args.tool}" : pas de simulation dédiée (read-only ou inconnu). Effet probable : aucune mutation.` }] };
  return { content: [{ type: 'text', text: `[DRY] ${sim(args.args ?? {})}` }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v10 — "Operational" ══════════════
// ═════════════════════════════════════════════════════════════════════

// Tool 51: launch_check — diagnostique l'installation
server.registerTool('launch_check', {
  title: 'Diagnostic d\'installation',
  description: "Vérifie : vault accessible, export présent, satellites/improvements lisibles, plugin styles installé. Renvoie un rapport pour debug.",
  inputSchema: {},
}, async () => {
  const checks = [];
  // Vault
  try { await fs.access(VAULT_RESOLVED); checks.push('✓ Vault accessible : ' + VAULT_RESOLVED); }
  catch { checks.push('✗ Vault inaccessible : ' + VAULT_RESOLVED); }
  // Export
  try {
    const st = await fs.stat(EXPORT_PATH);
    const ageH = Math.round((Date.now() - st.mtimeMs) / 3600000);
    checks.push(`✓ Export trouvé (${(st.size/1024).toFixed(1)} KB, il y a ${ageH}h)`);
  } catch { checks.push('✗ Export absent. Lance "Sync + 🧠 Claude" dans Obsidian.'); }
  // Satellites
  try {
    const sats = await cachedSatellites();
    checks.push(`✓ ${sats.length} satellites lisibles`);
  } catch (e) { checks.push('✗ Satellites : ' + e.message); }
  // Improvements
  try {
    const imp = await cachedImprovements();
    checks.push(`✓ ${imp.length} improvements lisibles`);
  } catch (e) { checks.push('✗ Improvements : ' + e.message); }
  // Plugin styles
  const stylesPath = path.join(VAULT_RESOLVED, '.obsidian/plugins/galactic-brain/styles.css');
  try {
    const st = await fs.stat(stylesPath);
    checks.push(`✓ Plugin styles.css : ${(st.size/1024).toFixed(1)} KB`);
  } catch { checks.push('⚠ styles.css absent — visuel non personnalisé'); }
  // Persistence
  for (const [name, p] of [['prefs', PREFS_PATH], ['handoff', HANDOFF_PATH], ['goals', GOALS_PATH]]) {
    try { await fs.access(safeVaultPath(p)); checks.push(`✓ ${name} initialisé`); }
    catch { checks.push(`◦ ${name} pas encore créé`); }
  }
  return { content: [{ type: 'text', text: `# 🔧 Diagnostic v${VERSION}\n\n${checks.join('\n')}` }] };
});

// Tool 52: heatmap — calendrier d'activité ASCII (30 jours × repos top 5)
server.registerTool('heatmap', {
  title: 'Heatmap ASCII d\'activité 30j',
  description: "Calendrier ASCII : 1 ligne par repo (top 5 par activité), 1 colonne par jour. Caractères : · faible, ▒ moyen, █ fort.",
  inputSchema: { days: z.number().int().min(7).max(60).optional() },
}, async (args) => {
  const days = args.days ?? 30;
  const data = await loadData();
  const sats = await cachedSatellites();
  const now = Date.now();
  const start = now - days * 86400000;
  // Pour chaque repo, count d'activité par jour (commit OR satellite)
  const buckets = {};
  for (const r of data.repos) buckets[r.name] = new Array(days).fill(0);
  for (const r of data.repos) {
    const t = new Date(r.last_pushed).getTime();
    if (t > start) {
      const d = Math.floor((now - t) / 86400000);
      if (d < days) buckets[r.name][days - 1 - d] += 3; // commit pèse 3
    }
  }
  for (const s of sats) {
    if (s.mtime > start) {
      const d = Math.floor((now - s.mtime) / 86400000);
      if (d < days && buckets[s.repo]) buckets[s.repo][days - 1 - d] += 1;
    }
  }
  const totals = Object.entries(buckets).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (totals[0]?.[1] === 0) return { content: [{ type: 'text', text: `∅ Aucune activité sur ${days}j.` }] };
  const ch = n => n === 0 ? '·' : n < 2 ? '░' : n < 4 ? '▒' : '█';
  const header = '         ' + Array.from({length: days}, (_, i) => i % 7 === 0 ? '|' : ' ').join('');
  const lines = totals.map(([repo]) => {
    const b = buckets[repo];
    return repo.padEnd(8).slice(0, 8) + ' ' + b.map(ch).join('');
  });
  return { content: [{ type: 'text', text: `# 📊 Heatmap ${days}j (· faible · ░ ▒ █ fort)\n\n\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\`` }] };
});

// Tool 53: deadlines — objectifs en retard ou imminents
server.registerTool('deadlines', {
  title: 'Échéances imminentes',
  description: "Liste les goals avec deadline triés par urgence. Identifie les retards. Ultra-cheap (~80 tokens).",
  inputSchema: { within_days: z.number().int().min(1).max(365).optional() },
}, async (args) => {
  const within = args.within_days ?? 14;
  const goals = await readJson(GOALS_PATH, []);
  const now = Date.now();
  const dated = goals.filter(g => !g.done && g.deadline);
  const enriched = dated.map(g => {
    const d = Math.round((new Date(g.deadline).getTime() - now) / 86400000);
    return { ...g, days: d };
  }).filter(g => g.days <= within).sort((a, b) => a.days - b.days);
  if (enriched.length === 0) return { content: [{ type: 'text', text: `✓ Rien sous ${within}j.` }] };
  const lines = enriched.map(g => {
    const tag = g.days < 0 ? `🔴 RETARD +${-g.days}j` : g.days === 0 ? `🟠 AUJOURD'HUI` : g.days <= 3 ? `🟡 J-${g.days}` : `🟢 J-${g.days}`;
    return `${tag} · ${g.title}${g.repo ? ` [${g.repo}]` : ''}`;
  });
  return { content: [{ type: 'text', text: `# ⏰ Échéances (≤${within}j)\n\n${lines.join('\n')}` }] };
});

// Tool 54: morning_routine — composite : anomaly + wake_up + deadlines + heatmap quick
server.registerTool('morning_routine', {
  title: 'Routine du matin',
  description: "Composite quotidien : wake_up + deadlines + anomalies + cache_status. À appeler une fois par jour. ~400 tokens.",
  inputSchema: {},
}, async () => {
  const [handoff, data, sats, imp, goals] = await Promise.all([
    readJson(HANDOFF_PATH, null),
    loadData(),
    cachedSatellites(),
    cachedImprovements(),
    readJson(GOALS_PATH, []),
  ]);
  const now = Date.now();
  const since = handoff ? new Date(handoff.saved_at).getTime() : now - 86400000;
  const newCommits = data.repos.filter(r => new Date(r.last_pushed).getTime() > since).length;
  const newSats = sats.filter(s => s.mtime > since).length;
  const open = imp.filter(i => !i.done);
  const crit = open.filter(i => i.priority === 'critical');
  // Deadlines urgentes
  const urgent = goals.filter(g => !g.done && g.deadline)
    .map(g => ({ ...g, days: Math.round((new Date(g.deadline).getTime() - now) / 86400000) }))
    .filter(g => g.days <= 7).sort((a, b) => a.days - b.days).slice(0, 3);
  // Top action
  const intentScore = {};
  for (const r of data.repos) {
    const age = now - new Date(r.last_pushed).getTime();
    if (age < 7 * 86400000) intentScore[r.name] = 1 - age / (7 * 86400000);
  }
  const topAction = open.map(i => ({
    ...i,
    score: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)) * (1 + (intentScore[i.repo] ?? 0)),
  })).sort((a, b) => b.score - a.score)[0];
  const hour = new Date().getHours();
  const salut = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
  return { content: [{ type: 'text', text:
    `# ☕ ${salut} — ${todayDate()}\n\n` +
    (handoff ? `**Hier** : ${handoff.context}\n→ ${handoff.next}\n\n` : `_(pas de handoff précédent)_\n\n`) +
    `**Pendant ton absence** : ${newCommits} commits · ${newSats} notes\n` +
    `**Backlog** : ${open.length} ouvertes · ${crit.length} critical\n\n` +
    `## 🎯 Action #1\n${topAction ? `**[${topAction.repo}]** ${topAction.title}` : '_aucune_'}\n\n` +
    (urgent.length ? `## ⏰ Échéances 7j\n${urgent.map(g => `- J${g.days >= 0 ? '-' + g.days : '+' + (-g.days) + ' retard'} · ${g.title}`).join('\n')}\n\n` : '') +
    `_Pour creuser : \`next_action\` ou \`focus_session hours:N\`._`,
  }] };
});

// Tool 55: tag_suggest — propose des tags pour un satellite
server.registerTool('tag_suggest', {
  title: 'Suggérer des tags pour un satellite',
  description: "Analyse le body d'un satellite et propose des tags basés sur tokens fréquents non-stop + frontmatter existant.",
  inputSchema: { path: z.string() },
}, async (args) => {
  const note = await readNote(args.path);
  if (!note) return { content: [{ type: 'text', text: `❌ ${args.path} introuvable.` }], isError: true };
  const { fm, body } = parseFrontmatter(note);
  const tokens = tokenize(body).filter(t => t.length > 4);
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
  const top = Object.entries(freq).filter(([_, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
  const existing = Array.isArray(fm.tags) ? fm.tags : [];
  const newOnes = top.filter(t => !existing.some(e => e.includes(t)));
  return { content: [{ type: 'text', text:
    `# 🏷️ Tags suggérés\n\n` +
    `**Existants** : ${existing.length ? existing.join(', ') : '_aucun_'}\n` +
    `**Suggérés** : ${newOnes.slice(0, 6).join(', ') || '_rien de pertinent_'}`,
  }] };
});

// Tool 56: bulk_check — cocher plusieurs improvements d'un coup
server.registerTool('bulk_check', {
  title: 'Cocher plusieurs improvements en lot',
  description: "Match par contains sur les titres. Renvoie ce qui a été coché vs non trouvé. Utile post-merge.",
  inputSchema: {
    repo: z.string(),
    title_matches: z.array(z.string()),
  },
}, async (args) => {
  const filePath = `GalacticBrain/_improvements/${args.repo}.md`;
  const existing = await readNote(filePath);
  if (!existing) return { content: [{ type: 'text', text: `❌ Pas d'improvements pour ${args.repo}.` }], isError: true };
  const lines = existing.split('\n');
  const checked = [], notFound = [];
  for (const needle of args.title_matches) {
    const nLow = needle.toLowerCase();
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('| [ ]')) continue;
      if (lines[i].toLowerCase().includes(nLow)) {
        lines[i] = lines[i].replace('| [ ] |', '| [x] |');
        checked.push(needle);
        found = true;
        break;
      }
    }
    if (!found) notFound.push(needle);
  }
  if (checked.length > 0) await writeNote(filePath, lines.join('\n'));
  return { content: [{ type: 'text', text:
    `# Bulk check ${args.repo}\n\n✓ Cochés (${checked.length}) :\n${checked.map(c => `  - ${c}`).join('\n') || '_aucun_'}\n\n${notFound.length ? `✗ Non trouvés :\n${notFound.map(c => `  - ${c}`).join('\n')}` : ''}`,
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// ═══════════════ INTELLIGENCE LAYER v11 — "Reasoning" ═════════════════
// ═════════════════════════════════════════════════════════════════════

const HYPOTHESES_PATH = 'GalacticBrain/_hypotheses.jsonl';
const TASKS_PATH = 'GalacticBrain/_tasks.json';
const TIMELOG_PATH = 'GalacticBrain/_timelog.jsonl';
const BOOKMARKS_PATH = 'GalacticBrain/_bookmarks.json';
const INDEX_PERSIST_PATH = 'GalacticBrain/_search_index.json';

// ── Persistance de l'index pour bootstrap instantané ──
async function persistIndex() {
  try {
    const idx = await buildIndex();
    const minimal = {
      chunks: idx.chunks.map(c => ({ r: c.repo, p: c.notePath, s: c.section, t: c.text, k: c.keywords })),
      built_at: nowIso(),
    };
    await writeJson(INDEX_PERSIST_PATH, minimal);
    return minimal.chunks.length;
  } catch { return 0; }
}

// Tool 57: reason — multi-hop reasoning sur question ouverte
server.registerTool('reason', {
  title: 'Raisonnement multi-hop',
  description: "Chain-of-thought structuré : décompose une question en hops (recherche → satellites → improvements → décisions), construit la chaîne de raisonnement, conclut. Plus profond que compose_brief.",
  inputSchema: {
    question: z.string(),
    max_hops: z.number().int().min(2).max(5).optional(),
  },
}, async (args) => {
  const maxHops = args.max_hops ?? 3;
  const hops = [];
  // Hop 1 : micro_search sur la question
  const search = await smartSearch(args.question, 5);
  hops.push({
    n: 1, label: 'Recherche sémantique',
    found: search.slice(0, 3).map(r => `${r.repo}/${r.section}`).join(', ') || 'rien',
  });
  // Hop 2 : repos impliqués → improvements ouvertes correspondantes
  const reposInvolved = [...new Set(search.map(r => r.repo))];
  const imp = await cachedImprovements();
  const relatedImp = imp.filter(i => reposInvolved.includes(i.repo) && !i.done).slice(0, 5);
  hops.push({
    n: 2, label: 'Improvements liées',
    found: relatedImp.map(i => `[${i.repo}] ${i.title.slice(0, 50)}`).join(' · ') || 'aucune',
  });
  // Hop 3 : décisions historiques pertinentes
  let decisions = [];
  if (maxHops >= 3) {
    const decRaw = await readNote(DECISIONS_PATH);
    if (decRaw) {
      const qTok = new Set(tokenize(args.question));
      decisions = decRaw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map(d => {
          let score = 0;
          const dTok = tokenize(d.title + ' ' + d.reason);
          for (const t of dTok) if (qTok.has(t)) score++;
          return { d, score };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.d);
      hops.push({
        n: 3, label: 'Décisions historiques',
        found: decisions.map(d => `${d.date.slice(0, 10)} · ${d.title}`).join(' · ') || 'aucune',
      });
    } else {
      hops.push({ n: 3, label: 'Décisions historiques', found: 'aucune (vide)' });
    }
  }
  // Hop 4 : satellites reflection sur le sujet
  if (maxHops >= 4) {
    const sats = await cachedSatellites();
    const qTok = new Set(tokenize(args.question).filter(t => t.length > 3));
    const reflections = sats.filter(s => s.fm.kind === 'reflection')
      .map(s => {
        const sTok = new Set(tokenize(s.body).filter(t => t.length > 3));
        let shared = 0; for (const t of qTok) if (sTok.has(t)) shared++;
        return { s, score: shared / Math.max(1, Math.sqrt(qTok.size * sTok.size)) };
      }).filter(x => x.score > 0.05).sort((a, b) => b.score - a.score).slice(0, 2);
    hops.push({
      n: 4, label: 'Réflexions antérieures',
      found: reflections.map(x => `${x.s.repo}/${path.basename(x.s.path).slice(0, 40)}`).join(' · ') || 'aucune',
    });
  }
  // Synthèse
  const synth = [];
  if (search.length === 0 && relatedImp.length === 0) synth.push('Le brain ne contient pas de signal sur ce sujet. Démarre par une `quick_note` ou un `add_improvement`.');
  else {
    if (search.length) synth.push(`Le sujet apparaît dans **${reposInvolved.join(', ')}**.`);
    if (relatedImp.length) {
      const top = relatedImp[0];
      synth.push(`Action immédiate liée : **[${top.repo}] ${top.title}** (${top.priority}/${top.category}).`);
    }
    if (decisions.length) synth.push(`${decisions.length} décision(s) passée(s) éclairent ce sujet.`);
  }
  return { content: [{ type: 'text', text:
    `# 🧩 Raisonnement : ${args.question}\n\n` +
    hops.map(h => `**Hop ${h.n}** — ${h.label}\n  ${h.found}`).join('\n\n') +
    `\n\n## Synthèse\n${synth.join('\n')}`,
  }] };
});

// Tool 58: compare_repos — side-by-side analytique
server.registerTool('compare_repos', {
  title: 'Comparer 2 repos sur 10 dimensions',
  description: "Side-by-side : language, age, commits 30j, open/done, sats, top topic, health, tests présents, CI présente, README. ~300 tokens.",
  inputSchema: { a: z.string(), b: z.string() },
}, async (args) => {
  const data = await loadData();
  const A = data.repos.find(r => r.name.toLowerCase() === args.a.toLowerCase());
  const B = data.repos.find(r => r.name.toLowerCase() === args.b.toLowerCase());
  if (!A || !B) return { content: [{ type: 'text', text: `❌ Repo introuvable : ${!A ? args.a : args.b}` }], isError: true };
  const sats = await cachedSatellites();
  const imp = await cachedImprovements();
  const now = Date.now();
  const row = (label, va, vb) => `| ${label} | ${va} | ${vb} |`;
  const ageD = r => Math.floor((now - new Date(r.last_pushed).getTime()) / 86400000);
  const impFor = r => imp.filter(i => i.repo === r.name);
  const impA = impFor(A), impB = impFor(B);
  const noteA = await readNote(A.note_path);
  const noteB = await readNote(B.note_path);
  const hasTests = n => n && /test|spec|jest|mocha|vitest|pytest|cargo test/i.test(n);
  const hasCI = n => n && /\.github\/workflows|gitlab-ci|circleci|jenkins/i.test(n);
  return { content: [{ type: 'text', text:
    `# 🆚 ${A.name} vs ${B.name}\n\n` +
    `| Dimension | ${A.name} | ${B.name} |\n|---|---|---|\n` +
    row('Language', A.language ?? '?', B.language ?? '?') + '\n' +
    row('⭐ Stars', A.stars, B.stars) + '\n' +
    row('Age push (j)', ageD(A), ageD(B)) + '\n' +
    row('Topics', A.topics.slice(0, 3).join(',') || '∅', B.topics.slice(0, 3).join(',') || '∅') + '\n' +
    row('Sats Claude', sats.filter(s => s.repo === A.name).length, sats.filter(s => s.repo === B.name).length) + '\n' +
    row('Open imp.', impA.filter(i => !i.done).length, impB.filter(i => !i.done).length) + '\n' +
    row('Done imp.', impA.filter(i => i.done).length, impB.filter(i => i.done).length) + '\n' +
    row('Tests détectés', hasTests(noteA) ? '✓' : '✗', hasTests(noteB) ? '✓' : '✗') + '\n' +
    row('CI détectée', hasCI(noteA) ? '✓' : '✗', hasCI(noteB) ? '✓' : '✗'),
  }] };
});

// Tool 59: what_if — simule l'effet de clore N improvements
server.registerTool('what_if', {
  title: 'Simulation : et si je closais N items ?',
  description: "Renvoie le delta sur le backlog : temps cumulé, repos touchés, gain de health score estimé. Pas de mutation.",
  inputSchema: {
    scenario: z.enum(['close_top_n', 'close_all_critical', 'close_repo']).describe('Type de simulation'),
    n: z.number().int().min(1).max(50).optional(),
    repo: z.string().optional(),
  },
}, async (args) => {
  const all = await cachedImprovements();
  let target = all.filter(i => !i.done);
  if (args.scenario === 'close_all_critical') target = target.filter(i => i.priority === 'critical');
  else if (args.scenario === 'close_repo') {
    if (!args.repo) return { content: [{ type: 'text', text: '❌ repo requis.' }], isError: true };
    target = target.filter(i => i.repo === args.repo);
  } else if (args.scenario === 'close_top_n') {
    target = target.map(i => ({
      ...i,
      score: (PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8),
    })).sort((a, b) => b.score - a.score).slice(0, args.n ?? 5);
  }
  if (target.length === 0) return { content: [{ type: 'text', text: '∅ Rien à simuler.' }] };
  const totalH = target.reduce((s, i) => s + (EFFORT_HOURS[i.effort] ?? 8), 0);
  const totalDays = totalH / 6;
  const reposTouched = [...new Set(target.map(i => i.repo))];
  const byPrio = {};
  for (const i of target) byPrio[i.priority] = (byPrio[i.priority] ?? 0) + 1;
  // Health gain estimate : chaque close +2 points sur repo (approximation)
  const healthGain = {};
  for (const r of reposTouched) healthGain[r] = target.filter(i => i.repo === r).length * 2;
  return { content: [{ type: 'text', text:
    `# 🔮 Simulation : ${args.scenario}\n\n` +
    `**Items concernés** : ${target.length}\n` +
    `**Effort cumulé** : ${totalH}h (~${totalDays.toFixed(1)}j)\n` +
    `**Répartition** : ${Object.entries(byPrio).map(([k, v]) => `${k}=${v}`).join(' · ')}\n\n` +
    `**Repos touchés (${reposTouched.length}) — gain health estimé** :\n` +
    Object.entries(healthGain).map(([r, g]) => `- ${r} : +${g} pts`).join('\n'),
  }] };
});

// Tool 60: pattern_learn — détecte biais récurrents
server.registerTool('pattern_learn', {
  title: 'Détecter les biais récurrents',
  description: "Analyse l'historique : sous-estimes-tu toujours testing ? Closes-tu plus vite security ? Quelle catégorie traîne ? ~250 tokens.",
  inputSchema: {},
}, async () => {
  const all = await cachedImprovements();
  const done = all.filter(i => i.done);
  const open = all.filter(i => !i.done);
  if (done.length < 3) return { content: [{ type: 'text', text: 'Pas assez d\'historique (≥3 done items requis).' }] };
  const byCat = {};
  for (const i of all) {
    if (!byCat[i.category]) byCat[i.category] = { open: 0, done: 0, totalEffort: 0 };
    if (i.done) { byCat[i.category].done++; byCat[i.category].totalEffort += EFFORT_HOURS[i.effort] ?? 8; }
    else byCat[i.category].open++;
  }
  const patterns = [];
  for (const [cat, c] of Object.entries(byCat)) {
    if (c.open + c.done < 3) continue;
    const ratio = c.done / (c.open + c.done);
    if (ratio > 0.75 && c.open + c.done >= 4) patterns.push(`⚡ **${cat}** : tu closes vite (${(ratio*100).toFixed(0)}% done).`);
    if (ratio < 0.3 && c.open >= 3) patterns.push(`🐌 **${cat}** : tu accumules (${c.open} open vs ${c.done} done).`);
  }
  // Bias : priorité 'low' qui reste, vs 'critical' fermée vite
  const critDone = done.filter(i => i.priority === 'critical').length;
  const critTotal = all.filter(i => i.priority === 'critical').length;
  const lowOpen = open.filter(i => i.priority === 'low').length;
  if (critTotal > 0) patterns.push(`🔥 Critical fermés : ${critDone}/${critTotal} (${critTotal > 0 ? Math.round(critDone/critTotal*100) : 0}%).`);
  if (lowOpen > 5) patterns.push(`🦴 ${lowOpen} items 'low' ouverts — bruit de fond à purger ?`);
  // Repos avec ratio open/done > 2 (accumulation)
  const byRepo = {};
  for (const i of all) {
    if (!byRepo[i.repo]) byRepo[i.repo] = { open: 0, done: 0 };
    if (i.done) byRepo[i.repo].done++; else byRepo[i.repo].open++;
  }
  const stuck = Object.entries(byRepo).filter(([_, c]) => c.open > c.done * 2 && c.open > 2).map(([r]) => r);
  if (stuck.length) patterns.push(`🚧 Repos en accumulation : ${stuck.join(', ')}.`);
  if (patterns.length === 0) return { content: [{ type: 'text', text: '✓ Pas de pattern marquant. Comportement équilibré.' }] };
  return { content: [{ type: 'text', text: `# 📈 Patterns détectés\n\n${patterns.join('\n')}` }] };
});

// Tool 61: hypothesis — register / check predictions
server.registerTool('hypothesis', {
  title: 'Hypothèses prédictives',
  description: "Log {claim, repo, check_after_days} pour vérifier plus tard. List {open?} sans args.",
  inputSchema: {
    action: z.enum(['log', 'list', 'verify']),
    claim: z.string().optional(),
    repo: z.string().optional(),
    check_after_days: z.number().int().min(1).max(180).optional(),
    id: z.string().optional(),
    outcome: z.enum(['confirmed', 'refuted', 'inconclusive']).optional(),
  },
}, async (args) => {
  const raw = await readNote(HYPOTHESES_PATH);
  let all = raw ? raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  if (args.action === 'log') {
    if (!args.claim) return { content: [{ type: 'text', text: '❌ claim requis.' }], isError: true };
    const id = `h${Date.now().toString(36)}`;
    const entry = { id, date: nowIso(), claim: args.claim, repo: args.repo ?? null, check_after_days: args.check_after_days ?? 30, status: 'open' };
    await fs.writeFile(safeVaultPath(HYPOTHESES_PATH), (raw ?? '') + JSON.stringify(entry) + '\n', 'utf-8');
    return { content: [{ type: 'text', text: `✓ Hypothèse ${id} loggée.` }] };
  }
  if (args.action === 'verify') {
    if (!args.id || !args.outcome) return { content: [{ type: 'text', text: '❌ id + outcome requis.' }], isError: true };
    const idx = all.findIndex(h => h.id === args.id);
    if (idx < 0) return { content: [{ type: 'text', text: `❌ id "${args.id}" non trouvé.` }], isError: true };
    all[idx].status = args.outcome;
    all[idx].verified_at = nowIso();
    await fs.writeFile(safeVaultPath(HYPOTHESES_PATH), all.map(h => JSON.stringify(h)).join('\n') + '\n', 'utf-8');
    return { content: [{ type: 'text', text: `✓ Hypothèse ${args.id} : ${args.outcome}` }] };
  }
  const now = Date.now();
  const open = all.filter(h => h.status === 'open');
  const due = open.filter(h => (now - new Date(h.date).getTime()) > h.check_after_days * 86400000);
  if (open.length === 0) return { content: [{ type: 'text', text: '∅ Aucune hypothèse ouverte.' }] };
  const lines = open.map(h => {
    const ageD = Math.round((now - new Date(h.date).getTime()) / 86400000);
    const tag = due.includes(h) ? '🔔 À vérifier' : `J+${ageD}/${h.check_after_days}`;
    return `**${h.id}** ${tag} ${h.repo ? `[${h.repo}]` : ''}\n  ${h.claim}`;
  });
  return { content: [{ type: 'text', text: `# 🔬 Hypothèses ouvertes (${open.length}, ${due.length} à vérifier)\n\n${lines.join('\n\n')}` }] };
});

// Tool 62: task — multi-step task avec sub-actions
server.registerTool('task', {
  title: 'Tâches multi-étapes',
  description: "create {title, steps[]} | progress {id, step_idx, status} | list | done {id}. Pour orchestrer des chantiers > 1 improvement.",
  inputSchema: {
    action: z.enum(['create', 'progress', 'list', 'done', 'show']),
    id: z.string().optional(),
    title: z.string().optional(),
    steps: z.array(z.string()).optional(),
    step_idx: z.number().int().min(0).optional(),
    status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
  },
}, async (args) => {
  const tasks = await readJson(TASKS_PATH, []);
  if (args.action === 'create') {
    if (!args.title || !args.steps) return { content: [{ type: 'text', text: '❌ title + steps requis.' }], isError: true };
    const id = `t${Date.now().toString(36)}`;
    tasks.push({ id, title: args.title, created: nowIso(), steps: args.steps.map(s => ({ label: s, status: 'todo' })) });
    await writeJson(TASKS_PATH, tasks);
    return { content: [{ type: 'text', text: `✓ Tâche ${id} créée avec ${args.steps.length} étapes.` }] };
  }
  if (args.action === 'progress') {
    const t = tasks.find(x => x.id === args.id);
    if (!t) return { content: [{ type: 'text', text: `❌ id ${args.id} non trouvé.` }], isError: true };
    if (args.step_idx === undefined || !t.steps[args.step_idx]) return { content: [{ type: 'text', text: '❌ step_idx invalide.' }], isError: true };
    t.steps[args.step_idx].status = args.status ?? 'done';
    await writeJson(TASKS_PATH, tasks);
    return { content: [{ type: 'text', text: `✓ ${t.title} · étape ${args.step_idx} → ${t.steps[args.step_idx].status}` }] };
  }
  if (args.action === 'done') {
    const idx = tasks.findIndex(x => x.id === args.id);
    if (idx < 0) return { content: [{ type: 'text', text: `❌ id ${args.id} non trouvé.` }], isError: true };
    tasks[idx].completed = nowIso();
    await writeJson(TASKS_PATH, tasks);
    return { content: [{ type: 'text', text: `✓ Tâche ${args.id} clôturée.` }] };
  }
  if (args.action === 'show') {
    const t = tasks.find(x => x.id === args.id);
    if (!t) return { content: [{ type: 'text', text: `❌ id ${args.id}.` }], isError: true };
    const ic = { todo: '◯', doing: '◐', done: '●', blocked: '⊗' };
    return { content: [{ type: 'text', text: `# ${t.title}\n\n${t.steps.map((s, i) => `${ic[s.status]} ${i}. ${s.label}`).join('\n')}` }] };
  }
  // list
  const open = tasks.filter(t => !t.completed);
  if (open.length === 0) return { content: [{ type: 'text', text: '∅ Aucune tâche en cours.' }] };
  return { content: [{ type: 'text', text:
    `# 📋 Tâches (${open.length})\n\n` +
    open.map(t => {
      const dn = t.steps.filter(s => s.status === 'done').length;
      return `**${t.id}** · ${t.title} (${dn}/${t.steps.length})`;
    }).join('\n'),
  }] };
});

// Tool 63: auto_fix — propose patches pour repos manquants CI/tests/README
server.registerTool('auto_fix', {
  title: 'Suggérer des patches drop-in',
  description: "Pour un repo : détecte les manques (CI absent, tests absents, README court) et propose des improvements à créer en lot. Optionnel : --apply pour les créer.",
  inputSchema: {
    repo: z.string(),
    apply: z.boolean().optional(),
  },
}, async (args) => {
  const data = await loadData();
  const repo = data.repos.find(r => r.name.toLowerCase() === args.repo.toLowerCase());
  if (!repo) return { content: [{ type: 'text', text: `❌ ${args.repo} introuvable.` }], isError: true };
  const note = await readNote(repo.note_path);
  const suggestions = [];
  if (!note || !/\.github\/workflows|gitlab-ci|circleci/i.test(note)) {
    suggestions.push({ title: `Ajouter une CI GitHub Actions (lint + tests)`, priority: 'medium', category: 'devops', effort: '1-4h', rationale: 'Aucun workflow CI détecté. Filet de sécurité essentiel pour ne pas régresser.' });
  }
  if (!note || !/test\/|spec\/|jest|mocha|vitest|pytest/i.test(note)) {
    suggestions.push({ title: `Ajouter une couche de tests unitaires`, priority: 'medium', category: 'testing', effort: '1d', rationale: 'Aucun framework de test détecté. Bloque un refactor confiant.' });
  }
  if (!repo.description || repo.description.length < 30) {
    suggestions.push({ title: `Améliorer la description du repo (GitHub)`, priority: 'low', category: 'docs', effort: '<1h', rationale: 'Description absente ou trop courte (<30 chars).' });
  }
  if (note && note.length < 500) {
    suggestions.push({ title: `Étoffer le README (use case, install, exemples)`, priority: 'low', category: 'docs', effort: '1-4h', rationale: 'README < 500 chars : difficile à reprendre pour un futur toi.' });
  }
  if (suggestions.length === 0) return { content: [{ type: 'text', text: `✓ ${repo.name} a déjà CI/tests/README minimum.` }] };
  if (args.apply) {
    const filePath = `GalacticBrain/_improvements/${repo.name}.md`;
    let existing = await readNote(filePath);
    if (!existing) existing = `---\nparent_repo: ${repo.name}\nkind: improvements\ngenerated_by: claude\n---\n\n# ⚙️ Améliorations — ${repo.name}\n\n| Statut | Priorité | Catégorie | Effort | Titre | Rationale | Ajoutée le |\n|--------|----------|-----------|--------|-------|-----------|------------|\n`;
    for (const s of suggestions) {
      existing += `| [ ] | ${s.priority} | ${s.category} | ${s.effort} | ${escapeMd(s.title)} | ${escapeMd(s.rationale)} | ${todayDate()} |\n`;
    }
    await writeNote(filePath, existing);
    return { content: [{ type: 'text', text: `✓ ${suggestions.length} improvements ajoutées à ${repo.name}.` }] };
  }
  return { content: [{ type: 'text', text:
    `# 🩹 Patches suggérés pour ${repo.name}\n\n` +
    suggestions.map((s, i) => `${i + 1}. **[${s.priority}/${s.category}/${s.effort}]** ${s.title}\n   _${s.rationale}_`).join('\n\n') +
    `\n\n_Re-appelle avec \`apply:true\` pour les créer en lot._`,
  }] };
});

// Tool 64: bookmark — épingler des satellites pour accès rapide
server.registerTool('bookmark', {
  title: 'Bookmarks de satellites',
  description: "add {path, label?} | list | remove {path}. Pour épingler des notes consultées souvent.",
  inputSchema: {
    action: z.enum(['add', 'list', 'remove']),
    path: z.string().optional(),
    label: z.string().optional(),
  },
}, async (args) => {
  const bm = await readJson(BOOKMARKS_PATH, []);
  if (args.action === 'add') {
    if (!args.path) return { content: [{ type: 'text', text: '❌ path requis.' }], isError: true };
    if (bm.find(b => b.path === args.path)) return { content: [{ type: 'text', text: 'Déjà bookmarké.' }] };
    bm.push({ path: args.path, label: args.label ?? path.basename(args.path, '.md'), added: nowIso() });
    await writeJson(BOOKMARKS_PATH, bm);
    return { content: [{ type: 'text', text: `✓ ${args.label ?? args.path}` }] };
  }
  if (args.action === 'remove') {
    const idx = bm.findIndex(b => b.path === args.path);
    if (idx < 0) return { content: [{ type: 'text', text: '∅ pas trouvé.' }] };
    bm.splice(idx, 1);
    await writeJson(BOOKMARKS_PATH, bm);
    return { content: [{ type: 'text', text: '✓ retiré.' }] };
  }
  if (bm.length === 0) return { content: [{ type: 'text', text: '∅ aucun bookmark.' }] };
  return { content: [{ type: 'text', text: `# ⭐ Bookmarks (${bm.length})\n\n${bm.map(b => `- ${b.label}\n  ${b.path}`).join('\n')}` }] };
});

// Tool 65: time_log — log temps réel passé sur une improvement
server.registerTool('time_log', {
  title: 'Logger du temps sur une improvement',
  description: "log {repo, title_match, hours} | summary {repo?}. Permet de comparer effort déclaré vs réel pour calibrer pattern_learn.",
  inputSchema: {
    action: z.enum(['log', 'summary']),
    repo: z.string().optional(),
    title_match: z.string().optional(),
    hours: z.number().min(0.1).max(80).optional(),
  },
}, async (args) => {
  if (args.action === 'log') {
    if (!args.repo || !args.title_match || args.hours === undefined) return { content: [{ type: 'text', text: '❌ repo + title_match + hours requis.' }], isError: true };
    const entry = { date: nowIso(), repo: args.repo, title_match: args.title_match, hours: args.hours };
    const existing = await readNote(TIMELOG_PATH);
    await fs.writeFile(safeVaultPath(TIMELOG_PATH), (existing ?? '') + JSON.stringify(entry) + '\n', 'utf-8');
    return { content: [{ type: 'text', text: `✓ ${args.hours}h logué sur ${args.repo}/${args.title_match}` }] };
  }
  const raw = await readNote(TIMELOG_PATH);
  if (!raw) return { content: [{ type: 'text', text: '∅ Aucun log.' }] };
  let entries = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (args.repo) entries = entries.filter(e => e.repo === args.repo);
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const byRepo = {};
  for (const e of entries) byRepo[e.repo] = (byRepo[e.repo] ?? 0) + e.hours;
  const top = Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { content: [{ type: 'text', text:
    `# ⏱️ Time log\n\n**Total** : ${total.toFixed(1)}h sur ${entries.length} entrées\n\n` +
    top.map(([r, h]) => `- ${r} : ${h.toFixed(1)}h`).join('\n'),
  }] };
});

// Tool 66: introspect — meta : catalogue compact de TOUS les outils
server.registerTool('introspect', {
  title: 'Catalogue compact de tous les outils',
  description: "Liste les 77 outils MCP groupés par couche, ~150 tokens. À utiliser quand Claude ne sait pas quel outil appeler.",
  inputSchema: {},
}, async () => {
  return { content: [{ type: 'text', text:
    `# 🛠️ Catalogue v${VERSION}\n\n` +
    `**READ (12)** : user_summary, list_repos, get_repo_summary/section/full, search_brain, get_stack/topics, read_note, get_recent_activity, find_similar_repos, compose_brief\n\n` +
    `**WRITE (5)** : add_improvement, check_improvement, list_improvements, delete_improvement, add_conversation\n\n` +
    `**NOTES (6)** : add_reflection, save_session, create_satellite_note, update_satellite, delete_satellite, list_satellites\n\n` +
    `**STATS (2)** : vault_stats, find_duplicates\n\n` +
    `**INTEL v5 (6)** : prioritize, repo_health, cross_repo_insights, daily_brief, link_satellites, consolidation_audit\n\n` +
    `**PREDICTIVE v6 (5)** : pulse, intent, next_action, micro_search, explain_score\n\n` +
    `**PERSIST v7 (6)** : quick_note, session_handoff, pref, since_last_visit, recommend, focus_session\n\n` +
    `**OMNISCIENT v8 (5)** : digest, estimate, anomaly, auto_link, cache_status\n\n` +
    `**COHESIVE v9 (6)** : wake_up, commit_intent, goals, decision, timeline, dry_run\n\n` +
    `**OPERATIONAL v10 (6)** : launch_check, heatmap, deadlines, morning_routine, tag_suggest, bulk_check\n\n` +
    `**REASONING v11 (10)** : reason, compare_repos, what_if, pattern_learn, hypothesis, task, auto_fix, bookmark, time_log, introspect\n\n` +
    `**ADAPTIVE v12 (8)** : calibrate, sprint_plan, dedup_check, weekly_report, cluster_improvements, deep_reason, adaptive_score, insight_summary\n` +
    `  ↳ + BM25 activé sur search_brain / compose_brief / micro_search / reason\n\n` +
    `**Recommandés au démarrage** : wake_up | morning_routine | digest\n` +
    `**v12 nouveautés** : dedup_check avant add_improvement · sprint_plan pour planifier · deep_reason pour raisonner · weekly_report pour le bilan`,
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// ══════════════ INTELLIGENCE LAYER v12 — "ADAPTIVE" ══════════════════
// ═════════════════════════════════════════════════════════════════════
// 8 outils : calibrate, sprint_plan, dedup_check, weekly_report,
// cluster_improvements, deep_reason, adaptive_score, insight_summary
//
// + BM25 (déjà activé dans smartSearch ci-dessus)

const CALIB_KEY = 'effort_calib';

async function getCalibrationMultipliers() {
  const prefs = await readJson(PREFS_PATH, {});
  const raw = prefs[CALIB_KEY];
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ─── Tool 70: calibrate ──────────────────────────────────────────
server.registerTool('calibrate', {
  title: 'Calibrer les estimations d\'effort',
  description: "Lit le time_log (heures réelles) vs les improvements (heures déclarées), calcule les ratios par catégorie, et stocke des multiplicateurs dans _prefs. Améliore la précision de sprint_plan et adaptive_score. Appeler après ≥5 entrées dans time_log.",
  inputSchema: {},
}, async () => {
  const raw = await readNote(TIMELOG_PATH);
  if (!raw) return { content: [{ type: 'text', text: '∅ Aucune entrée time_log. Commence avec `time_log action:log`.' }] };
  const entries = raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (entries.length < 3) return { content: [{ type: 'text', text: `Seulement ${entries.length} entrée(s). Minimum 3 pour calibrer.` }] };
  const all = await cachedImprovements();
  const byCategory = {};
  for (const e of entries) {
    const needle = (e.title_match ?? '').toLowerCase();
    const matched = all.find(i => i.title.toLowerCase().includes(needle) && i.repo === e.repo);
    if (!matched) continue;
    const declared = EFFORT_HOURS[matched.effort] ?? 8;
    const cat = matched.category;
    if (!byCategory[cat]) byCategory[cat] = { declared: 0, actual: 0, n: 0 };
    byCategory[cat].declared += declared;
    byCategory[cat].actual += e.hours;
    byCategory[cat].n++;
  }
  if (Object.keys(byCategory).length === 0) {
    return { content: [{ type: 'text', text: '∅ Aucun match time_log ↔ improvement. Vérifie que title_match correspond au titre.' }] };
  }
  const multipliers = {};
  const lines = [];
  for (const [cat, v] of Object.entries(byCategory)) {
    if (v.n < 2) { lines.push(`- **${cat}** : ${v.n} entrée — insuffisant (≥2)`); continue; }
    const mult = Math.round((v.actual / Math.max(0.1, v.declared)) * 100) / 100;
    multipliers[cat] = mult;
    const bias = mult > 1.1 ? '⬆ sous-estimé' : mult < 0.9 ? '⬇ sur-estimé' : '✓ calibré';
    lines.push(`- **${cat}** : ×${mult} ${bias} (${v.actual.toFixed(1)}h réel / ${v.declared.toFixed(1)}h déclaré, n=${v.n})`);
  }
  const prefs = await readJson(PREFS_PATH, {});
  prefs[CALIB_KEY] = JSON.stringify(multipliers);
  await writeJson(PREFS_PATH, prefs);
  return { content: [{ type: 'text', text:
    `# ⚖️ Calibration sauvegardée\n\n${lines.join('\n')}\n\n` +
    `_Multiplicateurs utilisés automatiquement par sprint_plan et adaptive_score._`,
  }] };
});

// ─── Tool 71: sprint_plan ─────────────────────────────────────────
server.registerTool('sprint_plan', {
  title: 'Planifier un sprint N jours',
  description: "Pack le backlog en un plan jour-par-jour (6h productives/j). Utilise les heures calibrées si disponibles. Minimise les context-switches en groupant par repo. ~300 tokens.",
  inputSchema: {
    days: z.number().min(1).max(14).describe('Nombre de jours de sprint'),
    repo: z.string().optional().describe('Limiter à un repo'),
    min_priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  },
}, async (args) => {
  const budgetTotal = args.days * 6;
  const all = await cachedImprovements();
  let pool = all.filter(i => !i.done);
  if (args.repo) pool = pool.filter(i => i.repo.toLowerCase() === args.repo.toLowerCase());
  const priorities = ['critical', 'high', 'medium', 'low'];
  const minIdx = priorities.indexOf(args.min_priority ?? 'low');
  pool = pool.filter(i => priorities.indexOf(i.priority) <= minIdx);
  const calib = await getCalibrationMultipliers();
  const hasCalib = Object.keys(calib).length > 0;
  // Score chaque item avec effort calibré
  const scored = pool.map(i => {
    const baseH = EFFORT_HOURS[i.effort] ?? 8;
    const calibH = baseH * (calib[i.category] ?? 1.0);
    const pw = PRIORITY_WEIGHT[i.priority] ?? 1;
    const cw = CATEGORY_WEIGHT[i.category] ?? 1;
    return { ...i, calibH, score: (pw * cw) / calibH };
  }).sort((a, b) => b.score - a.score);
  // Greedy knapsack par jour
  const dayBudget = 6;
  const days = [];
  let usedH = 0;
  let currentDay = { n: 1, items: [], hoursUsed: 0 };
  for (const item of scored) {
    if (usedH + item.calibH > budgetTotal * 1.05) continue;
    if (currentDay.hoursUsed + item.calibH > dayBudget * 1.1) {
      if (currentDay.items.length > 0) { days.push(currentDay); }
      if (days.length >= args.days) break;
      currentDay = { n: days.length + 1, items: [], hoursUsed: 0 };
    }
    currentDay.items.push(item);
    currentDay.hoursUsed += item.calibH;
    usedH += item.calibH;
  }
  if (currentDay.items.length > 0) days.push(currentDay);
  if (days.length === 0) return { content: [{ type: 'text', text: `∅ Aucune tâche dans le budget de ${args.days}j.` }] };
  const lines = days.slice(0, args.days).map(d => {
    const items = d.items.map(i =>
      `  - **[${i.repo}]** ${i.title.slice(0, 60)} _(${i.priority}/${i.category}, ${i.calibH.toFixed(1)}h)_`
    ).join('\n');
    return `### Jour ${d.n} — ${d.hoursUsed.toFixed(1)}h\n${items}`;
  });
  return { content: [{ type: 'text', text:
    `# 📅 Sprint ${args.days}j — ${usedH.toFixed(1)}/${budgetTotal}h planifiées\n` +
    `${hasCalib ? '_Effort calibré depuis time_log_\n' : '_Sans calibration — appelle `calibrate` après time_logs_\n'}\n` +
    lines.join('\n\n'),
  }] };
});

// ─── Tool 72: dedup_check ─────────────────────────────────────────
server.registerTool('dedup_check', {
  title: 'Vérifier les doublons avant add_improvement',
  description: "Calcule la similarité Jaccard (titre + rationale) entre une nouvelle amélioration et toutes les existantes pour le repo. Retourne les matches >40%. Appeler AVANT add_improvement pour éviter les doublons silencieux.",
  inputSchema: {
    repo: z.string(),
    title: z.string(),
    rationale: z.string().optional(),
    threshold: z.number().min(0.2).max(0.95).optional(),
  },
}, async (args) => {
  const { repo, settings } = await resolveRepo(args.repo);
  const filePath = `${settings.improvementsFolder}/${repo.name}.md`;
  const existing = await readNote(filePath);
  if (!existing) return { content: [{ type: 'text', text: `✓ Aucune amélioration pour ${repo.name} — libre d'ajouter.` }] };
  const threshold = args.threshold ?? 0.40;
  const newTokens = new Set(tokenize((args.title + ' ' + (args.rationale ?? '')).toLowerCase()).filter(t => t.length > 2));
  const rows = existing.split('\n').filter(l => l.startsWith('| [ ]') || l.startsWith('| [x]'));
  const matches = [];
  for (const row of rows) {
    const parsed = parseImprovementRow(row);
    if (!parsed) continue;
    const existTokens = new Set(tokenize((parsed.title + ' ' + parsed.rationale).toLowerCase()).filter(t => t.length > 2));
    let inter = 0;
    for (const t of newTokens) if (existTokens.has(t)) inter++;
    const union = newTokens.size + existTokens.size - inter;
    const sim = union > 0 ? inter / union : 0;
    if (sim >= threshold) matches.push({ parsed, sim });
  }
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `✓ Aucun doublon (threshold=${threshold}). Tu peux ajouter.` }] };
  }
  matches.sort((a, b) => b.sim - a.sim);
  const lines = matches.map(m =>
    `- sim **${(m.sim * 100).toFixed(0)}%** · ${m.parsed.done ? '✅' : '⏸️'} [${m.parsed.priority}/${m.parsed.category}]\n  _${m.parsed.title}_`
  );
  return { content: [{ type: 'text', text:
    `# ⚠️ Doublons probables pour "${args.title}"\n\n${lines.join('\n\n')}\n\n` +
    `_Si réellement distinct, continue avec \`add_improvement\`. Sinon, complète l'existant._`,
  }] };
});

// ─── Tool 73: weekly_report ───────────────────────────────────────
server.registerTool('weekly_report', {
  title: 'Rapport hebdomadaire complet',
  description: "Synthèse des 7 derniers jours : commits, satellites créés, améliorations ajoutées, backlog critique, deadlines, plan semaine prochaine. ~500 tokens.",
  inputSchema: {
    weeks_back: z.number().int().min(1).max(4).optional(),
  },
}, async (args) => {
  const weeksBack = args.weeks_back ?? 1;
  const since = Date.now() - weeksBack * 7 * 86400000;
  const [data, sats, imp, goals] = await Promise.all([
    loadData(), cachedSatellites(), cachedImprovements(), readJson(GOALS_PATH, []),
  ]);
  const now = Date.now();
  const activRepos = data.repos.filter(r => new Date(r.last_pushed).getTime() > since)
    .sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  const newSats = sats.filter(s => s.mtime > since).sort((a, b) => b.mtime - a.mtime);
  const recentAdded = imp.filter(i => !i.done && i.date && new Date(i.date).getTime() > since);
  const openCrit = imp.filter(i => !i.done && i.priority === 'critical');
  const doneLifttime = imp.filter(i => i.done).length;
  const stagnant = data.repos.filter(r =>
    (now - new Date(r.last_pushed).getTime()) > 14 * 86400000 &&
    imp.filter(i => i.repo === r.name && !i.done).length > 0
  );
  const urgent = goals.filter(g => !g.done && g.deadline)
    .map(g => ({ ...g, days: Math.round((new Date(g.deadline).getTime() - now) / 86400000) }))
    .filter(g => g.days <= 14).sort((a, b) => a.days - b.days);
  const intentScore = {};
  for (const r of data.repos) {
    const age = now - new Date(r.last_pushed).getTime();
    if (age < 7 * 86400000) intentScore[r.name] = 1 - age / (7 * 86400000);
  }
  const topNext = imp.filter(i => !i.done).map(i => ({
    ...i,
    score: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)) * (1 + (intentScore[i.repo] ?? 0)),
  })).sort((a, b) => b.score - a.score).slice(0, 3);
  const startDate = new Date(since).toISOString().slice(0, 10);
  return { content: [{ type: 'text', text:
    `# 📊 Rapport ${startDate} → ${todayDate()}\n\n` +
    `## 🔥 Repos actifs (${activRepos.length})\n${activRepos.slice(0, 6).map(r => `- ${r.name} [${r.language ?? '?'}]`).join('\n') || '_aucun_'}\n\n` +
    `## 📝 Notes créées (${newSats.length})\n${newSats.slice(0, 5).map(s => `- [${s.repo}] ${path.basename(s.path, '.md').slice(0, 50)}`).join('\n') || '_aucune_'}\n\n` +
    `## ➕ Améliorations ajoutées (${recentAdded.length})\n${recentAdded.slice(0, 5).map(i => `- [${i.repo}/${i.priority}] ${i.title.slice(0, 60)}`).join('\n') || '_aucune_'}\n\n` +
    `## ✅ Total faites (lifetime : ${doneLifttime})\n\n` +
    (openCrit.length ? `## ⚠️ Criticals ouverts (${openCrit.length})\n${openCrit.map(i => `- **${i.repo}** · ${i.title}`).join('\n')}\n\n` : '') +
    (stagnant.length ? `## 💤 Stagnants avec backlog\n${stagnant.map(r => `- ${r.name}`).join(', ')}\n\n` : '') +
    (urgent.length ? `## ⏰ Échéances ≤14j\n${urgent.map(g => `- J${g.days >= 0 ? '-' + g.days : '+' + (-g.days) + ' retard'} · ${g.title}`).join('\n')}\n\n` : '') +
    `## 🎯 Plan semaine prochaine\n${topNext.map((i, n) => `${n + 1}. **[${i.repo}]** ${i.title.slice(0, 70)} _(${i.priority}/${i.category})_`).join('\n') || '_backlog vide_'}`,
  }] };
});

// ─── Tool 74: cluster_improvements ───────────────────────────────
server.registerTool('cluster_improvements', {
  title: 'Clustering sémantique des améliorations',
  description: "Regroupe les améliorations ouvertes par similarité Jaccard (tokens titre + rationale + catégorie). Révèle des clusters thématiques à traiter ensemble pour maximiser l'efficacité. ~200 tokens.",
  inputSchema: {
    repo: z.string().optional(),
    threshold: z.number().min(0.15).max(0.8).optional(),
    min_cluster_size: z.number().int().min(2).max(10).optional(),
  },
}, async (args) => {
  const all = await cachedImprovements();
  let pool = all.filter(i => !i.done);
  if (args.repo) pool = pool.filter(i => i.repo.toLowerCase() === args.repo.toLowerCase());
  if (pool.length < 3) return { content: [{ type: 'text', text: `∅ Trop peu d'items (${pool.length}) pour clustériser (min 3).` }] };
  const threshold = args.threshold ?? 0.25;
  const minSize = args.min_cluster_size ?? 2;
  const tokenized = pool.map(i => ({
    ...i,
    tokens: new Set(tokenize(i.title + ' ' + i.rationale + ' ' + i.category).filter(t => t.length > 2)),
  }));
  // Single-linkage clustering (greedy)
  const assigned = new Array(pool.length).fill(-1);
  const clusterMap = new Map();
  let nextCluster = 0;
  for (let i = 0; i < tokenized.length; i++) {
    if (assigned[i] !== -1) continue;
    const cluster = nextCluster++;
    assigned[i] = cluster;
    clusterMap.set(cluster, [i]);
    for (let j = i + 1; j < tokenized.length; j++) {
      if (assigned[j] !== -1) continue;
      let inter = 0;
      for (const t of tokenized[i].tokens) if (tokenized[j].tokens.has(t)) inter++;
      const union = tokenized[i].tokens.size + tokenized[j].tokens.size - inter;
      const sim = union > 0 ? inter / union : 0;
      if (sim >= threshold) { assigned[j] = cluster; clusterMap.get(cluster).push(j); }
    }
  }
  const clusters = [...clusterMap.entries()]
    .filter(([_, idxs]) => idxs.length >= minSize)
    .sort((a, b) => b[1].length - a[1].length);
  if (clusters.length === 0) return { content: [{ type: 'text', text: `∅ Aucun cluster ≥${minSize} (threshold=${threshold}). Essaie un threshold plus bas.` }] };
  const lines = clusters.map(([_, idxs], ci) => {
    const items = idxs.map(i => tokenized[i]);
    const totalH = items.reduce((s, i) => s + (EFFORT_HOURS[i.effort] ?? 8), 0);
    const cats = [...new Set(items.map(i => i.category))];
    return `### Cluster ${ci + 1} — ${items.length} items · ${totalH}h · [${cats.join('/')}]\n` +
      items.map(i => `  - **[${i.repo}/${i.priority}]** ${i.title.slice(0, 55)}`).join('\n');
  });
  return { content: [{ type: 'text', text:
    `# 🧩 Clusters d'améliorations (threshold=${threshold})\n\n${lines.join('\n\n')}\n\n` +
    `_${clusters.length} cluster(s). Utilise \`sprint_plan\` pour planifier un cluster._`,
  }] };
});

// ─── Tool 75: deep_reason ─────────────────────────────────────────
server.registerTool('deep_reason', {
  title: 'Raisonnement profond avec chaîne d\'évidence',
  description: "Version avancée de reason : construit une chaîne d'évidence (notes BM25 + décisions + hypothèses + improvements), attribue un score de confiance 0-100, détecte les contradictions, et formule une recommendation actionnable. ~400 tokens.",
  inputSchema: {
    question: z.string(),
    depth: z.enum(['shallow', 'medium', 'deep']).optional(),
  },
}, async (args) => {
  const depth = args.depth ?? 'medium';
  const searchLimit = depth === 'shallow' ? 3 : depth === 'medium' ? 6 : 10;
  const evidence = [];
  const contradictions = [];
  const qTok = new Set(tokenize(args.question).filter(t => t.length > 2));

  // Phase 1 : BM25 search
  const searchHits = await smartSearch(args.question, searchLimit);
  for (const h of searchHits) {
    evidence.push({ type: 'note', weight: Math.min(h.score / 5, 1), source: `${h.repo}/${h.section}`, excerpt: h.excerpt.slice(0, 100) });
  }

  // Phase 2 : improvements liées
  const imp = await cachedImprovements();
  const relImp = imp.filter(i => tokenize(i.title + ' ' + i.rationale).some(t => qTok.has(t))).slice(0, 5);
  for (const i of relImp) {
    evidence.push({ type: i.done ? 'resolved' : 'open', weight: i.done ? 0.4 : 0.6, source: `${i.repo}/${i.category}`, excerpt: i.title.slice(0, 80) });
  }

  // Phase 3 : décisions historiques
  if (depth !== 'shallow') {
    const decRaw = await readNote(DECISIONS_PATH);
    if (decRaw) {
      const decisions = decRaw.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(d => tokenize(d.title + ' ' + (d.reason ?? '')).some(t => qTok.has(t))).slice(0, 3);
      for (const d of decisions) {
        evidence.push({ type: 'decision', weight: 0.8, source: `${d.date?.slice(0, 10)} [${d.repo ?? 'cross'}]`, excerpt: (d.title + ' — ' + (d.reason ?? '')).slice(0, 80) });
      }
    }
  }

  // Phase 4 : hypothèses (deep seulement)
  if (depth === 'deep') {
    const hypRaw = await readNote(HYPOTHESES_PATH);
    if (hypRaw) {
      const hyps = hypRaw.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(h => tokenize(h.claim ?? '').some(t => qTok.has(t))).slice(0, 2);
      for (const h of hyps) {
        const entry = { type: 'hypothesis', weight: 0.3, source: `h:${h.id}`, excerpt: (h.claim ?? '').slice(0, 80) };
        if (h.status === 'refuted') contradictions.push(entry); else evidence.push(entry);
      }
    }
  }

  // Score de confiance
  const evidenceWeight = evidence.reduce((s, e) => s + e.weight, 0);
  const rawConf = Math.min(evidenceWeight / Math.max(searchLimit * 0.8, 1), 1);
  const confidence = Math.max(0, Math.round((rawConf - contradictions.length * 0.1) * 100));
  const confLabel = confidence >= 70 ? '🟢 Haute' : confidence >= 40 ? '🟡 Moyenne' : '🔴 Basse';

  // Synthèse
  const reposInvolved = [...new Set([...searchHits.map(h => h.repo), ...relImp.map(i => i.repo)])];
  const openRel = relImp.filter(i => !i.done);
  const synth = [];
  if (reposInvolved.length) synth.push(`Le sujet touche : **${reposInvolved.join(', ')}**.`);
  if (evidence.some(e => e.type === 'decision')) synth.push('Des décisions architecturales documentées sont pertinentes.');
  if (openRel.length) {
    const top = openRel.sort((a, b) => (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0))[0];
    synth.push(`Action directe : **[${top.repo}] ${top.title}** _(${top.priority})_.`);
  }
  if (contradictions.length) synth.push(`⚠️ ${contradictions.length} contradiction(s) avec des hypothèses précédentes.`);
  if (!evidence.length) synth.push('Vault sans signal sur ce sujet — commence par `quick_note` ou `add_improvement`.');

  return { content: [{ type: 'text', text:
    `# 🧠 Deep Reason : ${args.question.slice(0, 60)}\n\n` +
    `**Confiance** : ${confidence}/100 ${confLabel} · ${evidence.length} preuves · ${contradictions.length} contradictions\n\n` +
    `## Chaîne d'évidence\n${evidence.slice(0, 6).map(e => `  - [${e.type}] ${e.source} · _${e.excerpt}_`).join('\n') || '_aucune_'}\n\n` +
    (contradictions.length ? `## Contradictions\n${contradictions.map(e => `  - ⚡ [${e.type}] ${e.source} · _${e.excerpt}_`).join('\n')}\n\n` : '') +
    `## Synthèse\n${synth.join('\n') || '_Données insuffisantes._'}\n\n` +
    `_depth=${depth} · Pour enrichir : \`deep_reason depth:deep\` ou alimente le vault._`,
  }] };
});

// ─── Tool 76: adaptive_score ─────────────────────────────────────
server.registerTool('adaptive_score', {
  title: 'Priorités calibrées (vs statiques)',
  description: "Comme prioritize mais utilise les multiplicateurs d'effort calibrés depuis time_log. Affiche le delta vs scoring standard (↑ = monte, ↓ = descend). Requiert une calibration préalable via `calibrate`.",
  inputSchema: {
    limit: z.number().int().min(1).max(20).optional(),
    repo: z.string().optional(),
  },
}, async (args) => {
  const all = await cachedImprovements();
  let open = all.filter(i => !i.done);
  if (args.repo) open = open.filter(i => i.repo.toLowerCase() === args.repo.toLowerCase());
  if (open.length === 0) return { content: [{ type: 'text', text: '∅ Aucun item ouvert.' }] };
  const calib = await getCalibrationMultipliers();
  const hasCalib = Object.keys(calib).length > 0;
  const scored = open.map(i => {
    const pw = PRIORITY_WEIGHT[i.priority] ?? 1;
    const cw = CATEGORY_WEIGHT[i.category] ?? 1;
    const baseH = EFFORT_HOURS[i.effort] ?? 8;
    const calibH = baseH * (calib[i.category] ?? 1.0);
    const standardScore = (pw * cw) / baseH;
    const adaptiveScore = (pw * cw) / calibH;
    return { ...i, standardScore, adaptiveScore, calibH, delta: adaptiveScore - standardScore };
  }).sort((a, b) => b.adaptiveScore - a.adaptiveScore).slice(0, args.limit ?? 10);
  const lines = scored.map((i, n) => {
    const delta = i.delta > 0.1 ? ` ↑+${i.delta.toFixed(1)}` : i.delta < -0.1 ? ` ↓${i.delta.toFixed(1)}` : '';
    const calibNote = hasCalib && calib[i.category] ? ` (×${calib[i.category]} calib)` : '';
    return `**${n + 1}. ${i.repo}** · _${i.priority}/${i.category}_ · score **${i.adaptiveScore.toFixed(2)}**${delta}\n   ${i.title.slice(0, 70)}\n   _${i.effort} → ${i.calibH.toFixed(1)}h réel estimé${calibNote}_`;
  });
  return { content: [{ type: 'text', text:
    `# 🎯 Priorités adaptatives${hasCalib ? ' (calibrées)' : ' (non calibrées — identique à prioritize)'}\n\n` +
    lines.join('\n\n') +
    `\n\n_↑ = plus urgent qu'estimé, ↓ = moins. Lance \`calibrate\` pour activer._`,
  }] };
});

// ─── Tool 77: insight_summary ─────────────────────────────────────
server.registerTool('insight_summary', {
  title: 'Résumé narratif d\'un sujet',
  description: "Génère un résumé en prose (non une liste) sur un sujet en combinant BM25 search, improvements, et décisions. Plus lisible que compose_brief pour comprendre rapidement l'état d'un sujet. ~200 tokens.",
  inputSchema: {
    topic: z.string(),
    repo: z.string().optional(),
  },
}, async (args) => {
  const hits = await smartSearch(args.topic, 6);
  const imp = await cachedImprovements();
  const qTok = new Set(tokenize(args.topic).filter(t => t.length > 2));
  let relImp = imp.filter(i => {
    if (args.repo && i.repo.toLowerCase() !== args.repo.toLowerCase()) return false;
    return tokenize(i.title + ' ' + i.rationale).some(t => qTok.has(t));
  });
  const repos = [...new Set([...hits.map(h => h.repo), ...relImp.map(i => i.repo)])];
  const openImp = relImp.filter(i => !i.done);
  const doneImp = relImp.filter(i => i.done);
  if (hits.length === 0 && openImp.length === 0) {
    return { content: [{ type: 'text', text: `∅ Pas de matériel sur "${args.topic}". Commence par \`quick_note\` ou une session active.` }] };
  }
  const parts = [];
  if (repos.length > 0) {
    parts.push(`Le sujet **"${args.topic}"** est présent dans ${repos.length === 1 ? `**${repos[0]}**` : `**${repos.join('**, **')}**`}.`);
  }
  if (hits.length > 0) {
    const top = hits[0];
    parts.push(`Documentation principale dans \`${top.repo}/${top.section}\` (BM25 score: ${top.score}).`);
    if (top.excerpt.length > 20) parts.push(`> _${top.excerpt.slice(0, 120).replace(/\n/g, ' ')}…_`);
  }
  if (openImp.length > 0) {
    const best = openImp.sort((a, b) => (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0))[0];
    parts.push(`${openImp.length} amélioration(s) ouverte(s) — la plus urgente : **${best.title}** _(${best.priority}/${best.category})_.`);
  }
  if (doneImp.length > 0) parts.push(`${doneImp.length} item(s) déjà résolus montrent une progression.`);
  parts.push(openImp.length > 0
    ? `→ **Prochaine action** : \`list_improvements ${repos[0]}\` puis traiter la priorité ${openImp[0]?.priority}.`
    : `→ **Statut** : stable, pas d'action immédiate identifiée.`
  );
  return { content: [{ type: 'text', text: `# 💡 "${args.topic}"\n\n${parts.join('\n\n')}` }] };
});

// ═════════════════════════════════════════════════════════════════
// v13 — INTELLIGENCE LAYER (5 nouveaux outils)
//
// Le v12 expose 77 outils mais reste basé sur du keyword-matching pur.
// v13 ajoute une couche cognitive : suivi de wiki-links, scoring par
// récence, extractive summarization (TextRank), claim extraction et
// cartographie visuelle du vault.
// ═════════════════════════════════════════════════════════════════

// ── Helpers v13 ──────────────────────────────────────────────────

/** Extrait les wiki-links [[Note]] et [[Note|Alias]] d'un texte */
function extractWikiLinks(text) {
  if (!text) return [];
  const out = [];
  const re = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return [...new Set(out)];
}

/** Découpe un texte en phrases (heuristique simple FR + EN) */
function splitSentences(text) {
  if (!text) return [];
  // Préserver les abréviations courantes
  const cleaned = text
    .replace(/\b(M|Mme|Dr|Pr|St|Mr|Ms|Mrs|Sr|Jr|etc|cf|p|pp|vol|no|art|ed|eds)\.\s/gi, '$1<DOT> ')
    .replace(/\b(\d+)\.(\d+)/g, '$1<DOT>$2');
  return cleaned
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý])/)
    .map(s => s.replace(/<DOT>/g, '.').trim())
    .filter(s => s.length > 12 && s.length < 600);
}

/** Score TextRank-like simplifié : similarité par overlap de tokens normalisé */
function _sentSimilarity(toksA, toksB) {
  if (!toksA.length || !toksB.length) return 0;
  const setA = new Set(toksA);
  const setB = new Set(toksB);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  const norm = Math.log(toksA.length + 1) + Math.log(toksB.length + 1);
  return norm > 0 ? common / norm : 0;
}

/** Calcule un score par phrase via algorithme TextRank (PageRank sur graphe phrase-phrase) */
function textRankScores(sentences) {
  const toks = sentences.map(s => tokenize(s));
  const n = sentences.length;
  if (n === 0) return [];
  // Matrice de similarité (symétrique)
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = _sentSimilarity(toks[i], toks[j]);
      sim[i][j] = s; sim[j][i] = s;
    }
  }
  // Normalisation par ligne
  const rowSum = sim.map(row => row.reduce((a, b) => a + b, 0));
  // PageRank itératif (damping 0.85, 30 iter max)
  const damping = 0.85;
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 30; iter++) {
    const next = new Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || rowSum[j] === 0) continue;
        next[i] += damping * (sim[j][i] / rowSum[j]) * scores[j];
      }
    }
    scores = next;
  }
  return scores;
}

// ─────────────── v13/1 — semantic_recall ───────────────
server.registerTool('semantic_recall', {
  title: 'Hybrid recall: BM25 + wiki-links + recency',
  description: 'Combine la recherche BM25 avec le suivi des [[wiki-links]] et un boost récence. Plus pertinent que search_brain pour des questions ouvertes. ~300 tokens.',
  inputSchema: {
    query: z.string().describe('Question ou concept à explorer'),
    limit: z.number().int().min(1).max(15).optional().describe('Default: 8'),
    recency_boost: z.number().min(0).max(2).optional().describe('Coefficient récence (0=off, 1=normal, 2=fort). Default: 1'),
  },
}, async (args) => {
  const limit = args.limit ?? 8;
  const boost = args.recency_boost ?? 1;
  const seed = await smartSearch(args.query, Math.min(20, limit * 2));
  if (seed.length === 0) {
    return { content: [{ type: 'text', text: `Aucun résultat pour "${args.query}".` }] };
  }

  // 1) Collecte des wiki-links des top résultats
  const linkedPaths = new Set();
  for (const r of seed.slice(0, 5)) {
    const note = await readNote(r.notePath);
    if (!note) continue;
    for (const lk of extractWikiLinks(note)) {
      linkedPaths.add(lk.toLowerCase());
    }
  }

  // 2) Ré-scorer : BM25 + bonus wiki-link mentionné + recency
  const index = await buildIndex();
  const now = Date.now();
  const enriched = await Promise.all(seed.map(async r => {
    let score = r.score;
    // Bonus si la note est référencée par d'autres top résultats
    const baseName = r.notePath.split('/').pop()?.replace(/\.md$/, '').toLowerCase() || '';
    if (linkedPaths.has(baseName)) score += 2.5;
    // Bonus récence (basé sur la date du fichier)
    if (boost > 0) {
      try {
        const stat = await fs.stat(safeVaultPath(r.notePath));
        const ageDays = (now - stat.mtimeMs) / 86400000;
        const decay = Math.exp(-ageDays / 30); // demi-vie ~21j
        score += decay * 3 * boost;
      } catch {}
    }
    return { ...r, score: Math.round(score * 100) / 100 };
  }));
  enriched.sort((a, b) => b.score - a.score);
  const top = enriched.slice(0, limit);

  const lines = top.map((r, i) =>
    `### ${i + 1}. **${r.repo}** > ${r.section} _(score ${r.score})_\n${r.excerpt}\n_path: ${r.notePath}_`
  );
  const linkInfo = linkedPaths.size > 0
    ? `\n\n_${linkedPaths.size} wiki-links détectées dans le top 5 ont enrichi le scoring._`
    : '';
  return { content: [{ type: 'text', text: `${top.length} matches (semantic_recall):\n\n${lines.join('\n\n')}${linkInfo}` }] };
});

// ─────────────── v13/2 — auto_summary ───────────────
server.registerTool('auto_summary', {
  title: 'Extractive summary (TextRank) of a note',
  description: 'Génère un résumé extractif d\'une note (PageRank sur graphe phrase-phrase). Retourne 3-7 phrases clés dans l\'ordre du document. ~250 tokens.',
  inputSchema: {
    path: z.string().describe('Chemin vault de la note (.md)'),
    max_sentences: z.number().int().min(2).max(15).optional().describe('Default: 5'),
  },
}, async (args) => {
  const note = await readNote(args.path);
  if (!note) return { content: [{ type: 'text', text: `❌ Note "${args.path}" introuvable.` }], isError: true };
  // Strip frontmatter + headers pour ne garder que la prose
  const prose = note.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#{1,6}\s.*$/gm, '');
  const sentences = splitSentences(prose);
  if (sentences.length < 3) {
    return { content: [{ type: 'text', text: `Note trop courte (${sentences.length} phrases) — pas de résumé pertinent. Contenu :\n\n${prose.slice(0, 800)}` }] };
  }
  const max = args.max_sentences ?? Math.min(5, Math.max(3, Math.floor(sentences.length / 8)));
  const scores = textRankScores(sentences);
  // Sélection top-N en gardant l'ordre original
  const idx = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(x => x.i)
    .sort((a, b) => a - b);
  const summary = idx.map(i => sentences[i]).join(' ');
  return {
    content: [{
      type: 'text',
      text: `# 📝 Résumé extractif (${idx.length} phrases sur ${sentences.length})\n\n${summary}\n\n_Méthode : TextRank (PageRank sur graphe de similarité)_`,
    }],
  };
});

// ─────────────── v13/3 — brain_map ───────────────
server.registerTool('brain_map', {
  title: 'ASCII mind-map of the vault',
  description: 'Cartographie visuelle du vault : repos, satellites, improvements, dernière activité. Vue d\'ensemble compacte. ~400 tokens.',
  inputSchema: {
    sort_by: z.enum(['name', 'activity', 'satellites']).optional().describe('Default: activity'),
  },
}, async (args) => {
  const data = await loadData();
  const claudeBase = 'GalacticBrain/_claude';
  const repos = [...data.repos];

  // Compter les satellites par repo
  const satCount = {};
  try {
    const dirs = await fs.readdir(safeVaultPath(claudeBase)).catch(() => []);
    for (const sub of dirs) {
      const stat2 = await fs.stat(safeVaultPath(`${claudeBase}/${sub}`)).catch(() => null);
      if (!stat2?.isDirectory()) continue;
      const files = await fs.readdir(safeVaultPath(`${claudeBase}/${sub}`)).catch(() => []);
      satCount[sub] = files.filter(f => f.endsWith('.md')).length;
    }
  } catch {}

  // Sort
  if (args.sort_by === 'name') {
    repos.sort((a, b) => a.name.localeCompare(b.name));
  } else if (args.sort_by === 'satellites') {
    repos.sort((a, b) => (satCount[b.name] || 0) - (satCount[a.name] || 0));
  } else {
    repos.sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  }

  const lines = ['🌌 ' + data.github_username + ' / vault'];
  const total = repos.length;
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i];
    const isLast = i === total - 1;
    const branch = isLast ? '└─' : '├─';
    const ageDays = Math.floor((Date.now() - new Date(r.last_pushed).getTime()) / 86400000);
    const ageLabel = ageDays < 7 ? `🔥${ageDays}j` : ageDays < 30 ? `${ageDays}j` : ageDays < 365 ? `${Math.floor(ageDays/30)}mo` : `${Math.floor(ageDays/365)}y`;
    const sat = satCount[r.name] || 0;
    const satBadge = sat > 0 ? ` 🛰${sat}` : '';
    const langBadge = r.language ? `[${r.language}]` : '';
    lines.push(`${branch} ${r.name} ${langBadge} ⭐${r.stars} ${ageLabel}${satBadge}`);
    if (r.topics.length > 0 && sat > 0) {
      const indent = isLast ? '   ' : '│  ';
      lines.push(`${indent}└─ ${r.topics.slice(0, 4).map(t => '#' + t).join(' ')}`);
    }
  }
  lines.push('');
  lines.push(`_${repos.length} repos · ${Object.values(satCount).reduce((a, b) => a + b, 0)} satellites · synced ${new Date(data.generated_at).toLocaleDateString('fr-FR')}_`);
  return { content: [{ type: 'text', text: '```\n' + lines.join('\n') + '\n```' }] };
});

// ─────────────── v13/4 — whats_new ───────────────
server.registerTool('whats_new', {
  title: 'Recent changes across the vault',
  description: 'Liste les notes modifiées dans la fenêtre demandée, classées par récence + significance (longueur, type). ~200 tokens.',
  inputSchema: {
    hours: z.number().int().min(1).max(720).optional().describe('Fenêtre en heures. Default: 48'),
    limit: z.number().int().min(1).max(40).optional().describe('Default: 15'),
  },
}, async (args) => {
  const hours = args.hours ?? 48;
  const limit = args.limit ?? 15;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const found = [];

  async function walk(rel) {
    try {
      const abs = safeVaultPath(rel);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(childRel);
        else if (e.name.endsWith('.md')) {
          const st = await fs.stat(safeVaultPath(childRel));
          if (st.mtimeMs > cutoff) {
            found.push({ path: childRel, mtime: st.mtimeMs, size: st.size });
          }
        }
      }
    } catch {}
  }
  await walk('');

  if (found.length === 0) {
    return { content: [{ type: 'text', text: `Aucune note modifiée dans les ${hours}h.` }] };
  }
  // Score : récence + taille (les grandes notes = plus de signal)
  found.sort((a, b) => {
    const recencyA = (Date.now() - a.mtime) / 3600000;
    const recencyB = (Date.now() - b.mtime) / 3600000;
    const sizeWeight = Math.log(Math.max(a.size, 1)) - Math.log(Math.max(b.size, 1));
    return (recencyA - recencyB) - sizeWeight * 0.3;
  });
  const top = found.slice(0, limit);

  const lines = top.map(f => {
    const ageH = Math.round((Date.now() - f.mtime) / 3600000);
    const sizeKb = (f.size / 1024).toFixed(1);
    const ageLabel = ageH < 1 ? '< 1h' : ageH < 24 ? `${ageH}h` : `${Math.round(ageH / 24)}j`;
    return `- _${ageLabel}_ · **${f.path}** _(${sizeKb} ko)_`;
  });
  return { content: [{ type: 'text', text: `# 🕐 ${top.length} note(s) récentes (${hours}h):\n\n${lines.join('\n')}` }] };
});

// ─────────────── v13/5 — extract_claims ───────────────
server.registerTool('extract_claims', {
  title: 'Extract structured claims from a note',
  description: 'Détecte par patterns les énoncés saillants : décisions, hypothèses, bugs, intents, leçons. Sortie structurée par catégorie. ~250 tokens.',
  inputSchema: {
    path: z.string().describe('Chemin vault de la note (.md)'),
  },
}, async (args) => {
  const note = await readNote(args.path);
  if (!note) return { content: [{ type: 'text', text: `❌ Note "${args.path}" introuvable.` }], isError: true };

  const sentences = splitSentences(note);
  const PATTERNS = [
    { cat: 'décision',   re: /\b(d[ée]cision|on d[ée]cide|j[''']ai d[ée]cid[ée]|nous (?:avons )?d[ée]cid[ée]|choisi de|opt[ée] pour|retenu)\b/i },
    { cat: 'intention',  re: /\b(je veux|j[''']aimerais|on veut|on doit|il faut|objectif|but|TODO|à faire)\b/i },
    { cat: 'hypothèse',  re: /\b(hypoth[èe]se|je pense que|peut-[êe]tre que|si .{2,40} alors|probablement|sans doute)\b/i },
    { cat: 'bug',        re: /\b(bug|erreur|fail|crash|broken|cass[ée]|plante|exception|stacktrace|ne (?:marche|fonctionne) pas)\b/i },
    { cat: 'leçon',      re: /\b(le[çc]on|j[''']ai appris|retenir|next time|pour la prochaine|en r[ée]trospective)\b/i },
    { cat: 'risque',     re: /\b(risque|danger|attention|warning|caveat|gotcha|pi[èe]ge)\b/i },
    { cat: 'todo',       re: /^[\s\-\*]*\[\s*\]/i }, // checkbox markdown
    { cat: 'done',       re: /^[\s\-\*]*\[\s*[xX]\s*\]/i },
  ];

  const buckets = {};
  for (const s of sentences) {
    for (const p of PATTERNS) {
      if (p.re.test(s)) {
        (buckets[p.cat] = buckets[p.cat] || []).push(s);
        break;
      }
    }
  }

  if (Object.keys(buckets).length === 0) {
    return { content: [{ type: 'text', text: `Aucun énoncé saillant détecté dans "${args.path}". Essayez auto_summary pour un résumé global.` }] };
  }

  const ORDER = ['décision', 'intention', 'hypothèse', 'bug', 'leçon', 'risque', 'todo', 'done'];
  const ICONS = { 'décision': '⚖️', 'intention': '🎯', 'hypothèse': '💡', 'bug': '🐞', 'leçon': '📚', 'risque': '⚠️', 'todo': '☐', 'done': '☑' };

  const parts = [`# 🔍 Énoncés extraits — ${args.path.split('/').pop()}`];
  for (const cat of ORDER) {
    if (!buckets[cat]) continue;
    const items = buckets[cat].slice(0, 6); // cap à 6 par catégorie
    parts.push(`\n## ${ICONS[cat]} ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${buckets[cat].length})`);
    parts.push(items.map(s => `- ${s.length > 200 ? s.slice(0, 200) + '…' : s}`).join('\n'));
  }
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ═════════════════════════════════════════════════════════════════
// v13.1 — UNDERSTAND : meta-router en langage naturel
//
// Le user tape "qu'est-ce qui a bougé" → on route vers whats_new.
// Le user tape "résume Cycling" → on route vers auto_summary.
// Couvre les 82 outils via une table d'intents pondérés + extraction
// de paramètres (chemins, noms de repo, durées, nombres).
// ═════════════════════════════════════════════════════════════════

/**
 * Intent map : chaque entrée a (tool, weight_multiplier, keywords).
 * Le scoring est : somme des longueurs des keywords matched × multiplier.
 * → privilégie les keywords longs (plus spécifiques) sur les courts.
 */
const INTENTS = [
  // ─── Sessions / activity ───
  { tool: 'pulse',                m: 1.5, kw: ['pulse', 'ça va', 'quick check', 'check rapide', 'résumé court'] },
  { tool: 'wake_up',              m: 1.5, kw: ['réveille', 'wake', 'reprise', 'session reboot', 'reprend', 'on reprend'] },
  { tool: 'morning_routine',      m: 1.5, kw: ['matin', 'morning', 'bonjour', 'routine du jour', 'briefing'] },
  { tool: 'daily_brief',          m: 1.3, kw: ['daily', 'résumé du jour', 'aujourd\'hui', 'récapitulatif jour'] },
  { tool: 'since_last_visit',     m: 1.3, kw: ['depuis ma dernière', 'depuis dernière visite', 'que s\'est-il passé', 'évolutions'] },
  { tool: 'whats_new',            m: 1.4, kw: ['bougé', 'changé', 'récent', 'nouveau', 'modifié', 'what\'s new', 'récents', 'dernière modification'] },
  { tool: 'get_recent_activity',  m: 1.2, kw: ['activité récente', 'derniers commits', 'récents commits'] },
  { tool: 'session_handoff',      m: 1.3, kw: ['handoff', 'passer le flambeau', 'fin session', 'sauvegarder session'] },
  { tool: 'save_session',         m: 1.2, kw: ['sauve session', 'save session', 'enregistre session'] },
  { tool: 'heatmap',              m: 1.3, kw: ['heatmap', 'carte chaleur', 'activité par jour', 'graphe activité'] },
  { tool: 'timeline',             m: 1.3, kw: ['timeline', 'chronologie', 'évolution', 'historique projet'] },

  // ─── Lecture / découverte ───
  { tool: 'user_summary',         m: 1.5, kw: ['user summary', 'mon profil', 'qui suis-je', 'overview', 'survol'] },
  { tool: 'vault_stats',          m: 1.5, kw: ['stats vault', 'statistiques vault', 'taille vault', 'nb satellites'] },
  { tool: 'list_repos',           m: 1.4, kw: ['liste repos', 'list repos', 'tous mes repos', 'mes projets', 'quels projets'] },
  { tool: 'get_repo_summary',     m: 1.3, kw: ['résumé repo', 'résume le repo', 'summary repo', 'survol projet'] },
  { tool: 'get_repo_section',     m: 1.2, kw: ['section', 'partie du repo', 'lis section', 'read section'] },
  { tool: 'get_repo_full',        m: 1.2, kw: ['repo entier', 'note complète', 'full note', 'tout le contenu'] },
  { tool: 'get_stack',            m: 1.4, kw: ['stack', 'techno', 'technologies', 'mes outils', 'mes frameworks'] },
  { tool: 'get_topics',           m: 1.3, kw: ['topics', 'tags partagés', 'thèmes communs', 'sujets transverses'] },
  { tool: 'read_note',            m: 1.0, kw: ['lis la note', 'read note', 'ouvre note'] },

  // ─── Recherche ───
  { tool: 'search_brain',         m: 1.2, kw: ['cherche', 'search', 'trouve', 'find'] },
  { tool: 'semantic_recall',      m: 1.5, kw: ['recall', 'rappelle-moi', 'recherche sémantique', 'que sais-je sur', 'context sur'] },
  { tool: 'micro_search',         m: 1.2, kw: ['micro search', 'recherche compacte', 'quick find'] },
  { tool: 'compose_brief',        m: 1.3, kw: ['brief', 'briefing', 'fais-moi un brief', 'synthèse rapide sur'] },
  { tool: 'find_similar_repos',   m: 1.3, kw: ['similaire', 'similar', 'proche de', 'comme'] },
  { tool: 'compare_repos',        m: 1.3, kw: ['compare', 'différence entre', 'comparer'] },
  { tool: 'cross_repo_insights',  m: 1.3, kw: ['cross repo', 'transversal', 'tous mes repos', 'pattern global'] },
  { tool: 'find_duplicates',      m: 1.3, kw: ['doublons', 'duplicates', 'redondances'] },
  { tool: 'dedup_check',          m: 1.3, kw: ['dedup', 'déduplication', 'doublons sémantiques'] },

  // ─── Cognition v13 ───
  { tool: 'auto_summary',         m: 1.5, kw: ['résume', 'summarize', 'summary', 'résumé extractif', 'résumé', 'condense', 'tl;dr'] },
  { tool: 'brain_map',            m: 1.6, kw: ['carte', 'mind map', 'brain map', 'cartographie', 'vue d\'ensemble', 'arbre vault'] },
  { tool: 'extract_claims',       m: 1.5, kw: ['extrais', 'claims', 'énoncés', 'décisions et hypothèses', 'todos et bugs'] },

  // ─── Improvements (backlog) ───
  { tool: 'add_improvement',      m: 1.5, kw: ['ajoute amélioration', 'add improvement', 'note à faire', 'rajoute todo'] },
  { tool: 'list_improvements',    m: 1.5, kw: ['liste améliorations', 'list improvements', 'mes todos', 'mon backlog'] },
  { tool: 'check_improvement',    m: 1.5, kw: ['check improvement', 'marque fait', 'amélioration terminée', 'item résolu'] },
  { tool: 'delete_improvement',   m: 1.2, kw: ['supprime amélioration', 'delete improvement', 'enlève todo'] },
  { tool: 'cluster_improvements', m: 1.3, kw: ['regroupe améliorations', 'cluster', 'thèmes du backlog'] },
  { tool: 'bulk_check',           m: 1.2, kw: ['bulk check', 'check multiple', 'plusieurs items'] },
  { tool: 'consolidation_audit',  m: 1.2, kw: ['audit consolidation', 'consolider', 'audit backlog'] },
  { tool: 'auto_fix',             m: 1.3, kw: ['auto fix', 'corrige tout seul', 'fix automatique'] },

  // ─── Satellites ───
  { tool: 'create_satellite_note',m: 1.4, kw: ['crée note', 'create note', 'nouvelle note claude', 'écris note'] },
  { tool: 'update_satellite',     m: 1.3, kw: ['update note', 'mets à jour note', 'modifie note'] },
  { tool: 'delete_satellite',     m: 1.3, kw: ['supprime note', 'delete note', 'efface note'] },
  { tool: 'list_satellites',      m: 1.4, kw: ['liste notes', 'list notes', 'mes notes claude', 'list satellites'] },
  { tool: 'link_satellites',      m: 1.3, kw: ['relie notes', 'link notes', 'wikilink'] },

  // ─── Réflexion / journal ───
  { tool: 'add_reflection',       m: 1.5, kw: ['réflexion', 'reflection', 'j\'ai appris', 'leçon apprise', 'retex'] },
  { tool: 'add_conversation',     m: 1.3, kw: ['conversation', 'discussion notée', 'note de discussion'] },
  { tool: 'decision',             m: 1.5, kw: ['décision', 'je décide', 'on décide', 'décidé que', 'choix fait'] },
  { tool: 'commit_intent',        m: 1.3, kw: ['commit intent', 'intention de commit', 'message commit'] },
  { tool: 'intent',               m: 1.2, kw: ['intent', 'mon intention', 'objectif'] },
  { tool: 'bookmark',             m: 1.4, kw: ['bookmark', 'marque-page', 'signet', 'mets en favoris'] },
  { tool: 'quick_note',           m: 1.5, kw: ['note rapide', 'quick note', 'memo', 'mémo', 'jette une note'] },

  // ─── Planification ───
  { tool: 'sprint_plan',          m: 1.4, kw: ['sprint', 'plan sprint', 'planifie sprint'] },
  { tool: 'focus_session',        m: 1.4, kw: ['focus', 'session focus', 'concentre', 'deep work'] },
  { tool: 'prioritize',           m: 1.4, kw: ['priorise', 'prioritize', 'ordre de priorité', 'qu\'est-ce qui prime'] },
  { tool: 'next_action',          m: 1.5, kw: ['next', 'prochaine action', 'que faire ensuite', 'à faire maintenant'] },
  { tool: 'task',                 m: 1.3, kw: ['tâche', 'task', 'ajoute task'] },
  { tool: 'time_log',             m: 1.3, kw: ['time log', 'temps passé', 'log temps'] },
  { tool: 'goals',                m: 1.4, kw: ['objectifs', 'goals', 'mes objectifs'] },
  { tool: 'estimate',             m: 1.3, kw: ['estime', 'estimate', 'combien de temps'] },
  { tool: 'deadlines',            m: 1.4, kw: ['deadlines', 'échéances', 'dates limites'] },

  // ─── Raisonnement ───
  { tool: 'reason',               m: 1.4, kw: ['raisonne', 'réfléchis', 'reason', 'analyse', 'pense à'] },
  { tool: 'deep_reason',          m: 1.5, kw: ['raisonnement profond', 'deep reason', 'analyse approfondie'] },
  { tool: 'hypothesis',           m: 1.4, kw: ['hypothèse', 'hypothesis', 'théorie', 'pourquoi'] },
  { tool: 'what_if',              m: 1.5, kw: ['et si', 'what if', 'si je', 'imagine que'] },
  { tool: 'recommend',            m: 1.4, kw: ['recommande', 'recommend', 'suggère', 'conseil'] },
  { tool: 'pattern_learn',        m: 1.3, kw: ['pattern', 'apprends pattern', 'récurrence'] },
  { tool: 'introspect',           m: 1.3, kw: ['introspect', 'auto-analyse', 'que sais-je faire'] },
  { tool: 'insight_summary',      m: 1.3, kw: ['insight', 'éclairage', 'résumé insights'] },
  { tool: 'adaptive_score',       m: 1.2, kw: ['adaptive score', 'score adaptatif'] },
  { tool: 'explain_score',        m: 1.2, kw: ['explain score', 'pourquoi ce score', 'décompose le score'] },

  // ─── Health / audit ───
  { tool: 'repo_health',          m: 1.4, kw: ['santé repo', 'repo health', 'état du repo'] },
  { tool: 'launch_check',         m: 1.3, kw: ['launch check', 'prêt à lancer', 'check pré-prod'] },
  { tool: 'anomaly',              m: 1.4, kw: ['anomalie', 'anomaly', 'bizarre', 'détecte anomalie'] },
  { tool: 'cache_status',         m: 1.2, kw: ['cache status', 'état cache'] },
  { tool: 'dry_run',              m: 1.3, kw: ['dry run', 'simulation', 'simule'] },
  { tool: 'digest',               m: 1.3, kw: ['digest', 'condensé', 'récap'] },
  { tool: 'weekly_report',        m: 1.4, kw: ['weekly', 'rapport hebdo', 'récap semaine', 'bilan semaine'] },
  { tool: 'calibrate',            m: 1.3, kw: ['calibre', 'calibrate', 'recalibrer'] },

  // ─── Utilitaires ───
  { tool: 'pref',                 m: 1.2, kw: ['préférence', 'pref', 'paramètre user'] },
  { tool: 'tag_suggest',          m: 1.3, kw: ['tag suggest', 'suggère tags', 'quels tags'] },
  { tool: 'auto_link',            m: 1.3, kw: ['auto link', 'lie automatiquement', 'wiki links auto'] },

  // ─── Repo filesystem (v13.3) ───
  { tool: 'repo_tree',            m: 1.5, kw: ['arborescence', 'tree du repo', 'structure repo', 'liste fichiers repo', 'dossiers du repo'] },
  { tool: 'repo_file',            m: 1.5, kw: ['lis le fichier', 'ouvre le fichier', 'cat fichier', 'contenu fichier', 'lire fichier source'] },
  { tool: 'repo_grep',            m: 1.5, kw: ['grep dans', 'cherche dans le code', 'recherche dans repo', 'cherche dans les sources'] },
  { tool: 'repo_meta',            m: 1.5, kw: ['meta repo', 'package.json', 'readme rapide', 'overview repo', 'infos repo'] },
];

/** Détecte un nombre de jours/heures dans la requête : "depuis 7 jours", "24h", "1 semaine" */
function _extractDays(req) {
  let m = req.match(/(\d+)\s*(j(?:ours?)?|d(?:ays?)?)/i);
  if (m) return parseInt(m[1], 10);
  m = req.match(/(\d+)\s*(h(?:eures?)?)/i);
  if (m) return Math.max(1, Math.round(parseInt(m[1], 10) / 24));
  m = req.match(/(\d+)\s*(s(?:em(?:aines?)?)?|w(?:eeks?)?)/i);
  if (m) return parseInt(m[1], 10) * 7;
  if (/aujourd'hui|today/i.test(req)) return 1;
  if (/cette\s+semaine|this\s+week/i.test(req)) return 7;
  if (/ce\s+mois|this\s+month/i.test(req)) return 30;
  return null;
}

function _extractHours(req) {
  const m = req.match(/(\d+)\s*(h(?:eures?)?)/i);
  if (m) return parseInt(m[1], 10);
  const d = _extractDays(req);
  return d ? d * 24 : null;
}

/** Extrait un chemin de note (.md) ou un nom de repo capitalisé */
function _extractPath(req) {
  const mPath = req.match(/([A-Za-z0-9_\-]+\/[A-Za-z0-9_\-\/]+\.md)/);
  if (mPath) return mPath[1];
  return null;
}

function _extractRepoName(req, data) {
  // Cherche un nom de repo exact dans la requête (case insensitive)
  for (const r of data.repos) {
    const name = r.name;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(req)) return name;
  }
  return null;
}

// ─── Compact-mode helpers : économie de tokens ───────────────────
/** Tronque un texte sur frontière de phrase la plus proche du budget */
function _capTokens(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n\n'));
  return (lastEnd > maxChars * 0.6 ? slice.slice(0, lastEnd + 1) : slice) + ' …';
}
/** Strip markdown noise (## headers gardés en §, listes compactées) */
function _compact(md) {
  return md
    .replace(/^#+\s+/gm, '§ ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s\-\*]+/gm, '· ')
    .trim();
}

server.registerTool('understand', {
  title: '🧠 Natural-language router (mono ou multi-outil)',
  description: 'Tape une requête libre — je détecte le ou les outils pertinents parmi les 87 et j\'exécute en parallèle. Si plusieurs scores sont proches, augmente `max_tools`. `compact: true` pour réponse condensée. ~50-400 tokens selon `max_tools`.',
  inputSchema: {
    request: z.string().describe('Ta demande en langage naturel'),
    max_tools: z.number().int().min(1).max(5).optional().describe('Nb d\'outils à exécuter en parallèle si plusieurs intents matchent. Default: 1'),
    compact: z.boolean().optional().describe('Mode token-économe (default: true si max_tools≥2)'),
    explain: z.boolean().optional().describe('Affiche le raisonnement de routing'),
  },
}, async (args) => {
  const req = (args.request || '').trim();
  if (req.length < 2) {
    return { content: [{ type: 'text', text: '❌ Requête vide.' }], isError: true };
  }
  const lower = req.toLowerCase();
  const maxTools = Math.min(5, Math.max(1, args.max_tools ?? 1));
  const compact  = args.compact ?? (maxTools >= 2);

  // v13.4 — Fast-path : consultation du cache appris
  // Si on a déjà vu cette requête (≥3 fois, route stable), on raccourcit le scoring
  const learned = await _loadLearned();
  const qKey = _normQuery(req);
  const learnedRoute = learned.query_routes?.[qKey];
  if (learnedRoute && learnedRoute.confidence >= 0.7 && learnedRoute.count >= 3 && maxTools === 1) {
    // Boost massive du tool appris dans le scoring normal pour rester cohérent
    var _LEARNED_BOOST_TOOL = learnedRoute.tool;
    var _LEARNED_BOOST = learnedRoute.confidence * 100;
  }

  // Scoring : pour chaque intent, somme des longueurs des keywords matched × multiplier
  const scored = INTENTS.map(intent => {
    let score = 0;
    let matched = [];
    for (const k of intent.kw) {
      if (lower.includes(k)) {
        score += k.length * intent.m;
        matched.push(k);
      }
    }
    // v13.4 boost : si learnedRoute existe et match ce tool, on booste le score
    if (typeof _LEARNED_BOOST_TOOL !== 'undefined' && intent.tool === _LEARNED_BOOST_TOOL) {
      score += _LEARNED_BOOST;
      matched.push('[learned]');
    }
    return { tool: intent.tool, score, matched };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  // Fallback : aucun match clair → recherche BM25
  if (scored.length === 0) {
    const results = await smartSearch(req, compact ? 3 : 5);
    if (!results.length) return { content: [{ type: 'text', text: `Aucun outil ni résultat trouvé pour "${req}".` }] };
    const lines = results.map((r, i) =>
      compact
        ? `${i+1}. ${r.repo}/${r.section} (s=${r.score}) — ${r.excerpt.slice(0, 120)}`
        : `${i+1}. **${r.repo}** > ${r.section} _(s=${r.score})_\n   ${r.excerpt}`
    );
    return { content: [{ type: 'text', text: `_(aucun intent reconnu, recherche brute)_\n\n${lines.join(compact ? '\n' : '\n\n')}` }] };
  }

  // Sélection multi-tool : on prend ceux dont le score >= top*0.55, plafonné à max_tools
  const top = scored[0];
  const threshold = top.score * 0.55;
  const selected = scored.filter(s => s.score >= threshold).slice(0, maxTools);
  const explain = args.explain ?? false;

  const data = await loadData();
  const days = _extractDays(req);
  const hours = _extractHours(req);
  const repoName = _extractRepoName(req, data);
  const path = _extractPath(req);

  /** Génère les paramètres pour un outil donné */
  function paramsFor(toolName, matched) {
    const p = {};
    switch (toolName) {
      case 'whats_new':
        if (hours) p.hours = hours;
        break;
      case 'get_recent_activity':
      case 'heatmap':
      case 'since_last_visit':
        if (days) p.days = days;
        break;
      case 'auto_summary':
      case 'extract_claims':
      case 'read_note':
      case 'outline':
        if (path) p.path = path;
        else if (repoName) {
          const r = data.repos.find(x => x.name === repoName);
          if (r?.note_path) p.path = r.note_path;
        }
        break;
      case 'get_repo_summary':
      case 'get_repo_full':
      case 'get_repo_section':
      case 'find_similar_repos':
      case 'repo_health':
        if (repoName) p.name = repoName;
        break;
      case 'search_brain':
      case 'semantic_recall':
      case 'compose_brief':
      case 'reason':
      case 'deep_reason':
      case 'recommend':
      case 'hypothesis':
      case 'what_if':
      case 'micro_search':
      case 'concept_search':
      case 'contradiction_check':
      case 'recall_thread':
      case 'assert':
        p.query = req;
        if (toolName === 'compose_brief')   p.subject  = req;
        if (toolName === 'reason' || toolName === 'deep_reason') p.question = req;
        if (toolName === 'what_if')         p.scenario = req;
        if (toolName === 'recommend')       p.context  = req;
        if (toolName === 'hypothesis')      p.observation = req;
        if (toolName === 'assert')          p.claim    = req;
        if (toolName === 'recall_thread')   p.topic    = req;
        if (toolName === 'concept_search')  p.query    = req;
        if (toolName === 'contradiction_check') p.concept = req;
        break;
      case 'add_reflection':
      case 'decision':
      case 'quick_note':
      case 'bookmark':
      case 'intent':
      case 'commit_intent':
      case 'add_improvement':
      case 'task':
        let body = req;
        for (const k of matched) {
          const re = new RegExp('^\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-—,.]?\\s*', 'i');
          body = body.replace(re, '');
        }
        body = body.trim();
        p.content = body; p.text = body; p.title = body.slice(0, 80); p.note = body;
        if (repoName) p.repo = repoName;
        break;

      // v13.3 — repo filesystem
      case 'repo_tree':
      case 'repo_file':
      case 'repo_grep':
      case 'repo_meta':
        if (repoName) p.repo = repoName;
        if (toolName === 'repo_file' && path) p.path = path;
        if (toolName === 'repo_grep') {
          // Extrait le pattern : tout ce qui est entre guillemets ou après "grep "
          const quoted = req.match(/["'`]([^"'`]+)["'`]/);
          if (quoted) p.pattern = quoted[1];
          else {
            // Fallback : utilise les mots clés en tant que pattern
            const cleaned = req.replace(/\b(cherche|grep|find|dans|le repo|repo)\b/gi, '').trim();
            if (cleaned.length > 1) p.pattern = cleaned;
          }
        }
        break;
    }
    return p;
  }

  // Récupère un handler depuis le serveur (multi-fallback selon SDK)
  function getHandler(name) {
    const reg = server._registeredTools || server.registeredTools || server._tools;
    if (!reg) return null;
    const t = (typeof reg.get === 'function' ? reg.get(name) : reg[name]);
    return t?.callback || t?.handler || t?.fn || null;
  }

  // Exécute en parallèle
  const runs = await Promise.all(selected.map(async (s) => {
    const params = paramsFor(s.tool, s.matched);
    const handler = getHandler(s.tool);
    if (!handler) return { ...s, params, error: 'handler indisponible' };
    try {
      const r = await handler(params);
      const text = r?.content?.[0]?.text || '(vide)';
      return { ...s, params, text };
    } catch (e) {
      return { ...s, params, error: (e && e.message) || String(e) };
    }
  }));

  // v13.4 — Log de l'event pour apprentissage différé
  _logEvent('understand', {
    q: req,
    qkey: qKey,
    chose: runs.map(r => r.tool),
    scores: runs.map(r => Math.round(r.score)),
    used_learned: typeof _LEARNED_BOOST_TOOL !== 'undefined',
    errors: runs.filter(r => r.error).map(r => r.tool),
  });

  // Composition de la réponse
  if (selected.length === 1) {
    const r = runs[0];
    const hdr = explain
      ? `🎯 \`${r.tool}\` (s=${Math.round(r.score)})${Object.keys(r.params).length ? ` · params=${JSON.stringify(r.params)}` : ''}\n\n`
      : '';
    let body = r.error ? `❌ ${r.error}` : r.text;
    if (compact && body) body = _capTokens(_compact(body), 1400);
    return { content: [{ type: 'text', text: hdr + body }] };
  }

  // Multi-tool : panneau par outil avec séparateurs compacts
  const budget = Math.floor(2400 / selected.length); // budget de char par outil
  const parts = [];
  if (explain) {
    parts.push(`🎯 ${selected.length} outils en parallèle : ${selected.map(s => `\`${s.tool}\`(${Math.round(s.score)})`).join(' · ')}`);
    parts.push('');
  }
  for (const r of runs) {
    let body = r.error ? `❌ ${r.error}` : r.text;
    if (body && compact) body = _capTokens(_compact(body), budget);
    parts.push(`▼ **${r.tool}**\n${body}`);
  }
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
});

// ═════════════════════════════════════════════════════════════════
// v13.1 — 5 outils complémentaires
// ═════════════════════════════════════════════════════════════════

// ─── outline ── arborescence des headings d'une note (super cheap)
server.registerTool('outline', {
  title: 'Note outline (headings only)',
  description: 'Retourne juste l\'arborescence des titres ## d\'une note. ~30-80 tokens. Idéal avant get_repo_section.',
  inputSchema: { path: z.string().describe('Chemin vault de la note .md') },
}, async (args) => {
  const note = await readNote(args.path);
  if (!note) return { content: [{ type: 'text', text: `❌ "${args.path}" introuvable.` }], isError: true };
  const lines = [];
  for (const ln of note.split('\n')) {
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      const lvl = m[1].length;
      lines.push('  '.repeat(Math.max(0, lvl - 1)) + (lvl === 1 ? '# ' : '· ') + m[2].slice(0, 80));
    }
  }
  if (!lines.length) return { content: [{ type: 'text', text: `_(pas de structure markdown dans ${args.path})_` }] };
  return { content: [{ type: 'text', text: '```\n' + lines.join('\n') + '\n```' }] };
});

// ─── assert ── évaluer une affirmation : pour / contre / verdict
server.registerTool('assert', {
  title: 'Assert a claim against the vault',
  description: 'Pour une affirmation, cherche les passages POUR et CONTRE dans le vault et rend un verdict heuristique. ~250 tokens.',
  inputSchema: {
    claim: z.string().describe('Affirmation à vérifier'),
    limit: z.number().int().min(2).max(10).optional(),
  },
}, async (args) => {
  const limit = args.limit ?? 5;
  const hits = await smartSearch(args.claim, Math.min(15, limit * 2));
  if (!hits.length) return { content: [{ type: 'text', text: `Aucun élément dans le vault pour "${args.claim}".` }] };
  const NEG = /\b(non|pas|jamais|aucun|n['’]est|ne\s+\w+\s+pas|never|not|no\s|never\s|fail|cass[ée]|incorrect|faux)\b/i;
  const POS = /\b(oui|toujours|confirm[ée]|exact|vrai|fonctionne|works?|correct|valid[ée]?|done|fait)\b/i;
  const forArr = []; const againstArr = []; const neutralArr = [];
  for (const h of hits) {
    if (NEG.test(h.excerpt)) againstArr.push(h);
    else if (POS.test(h.excerpt)) forArr.push(h);
    else neutralArr.push(h);
  }
  const verdict = forArr.length > againstArr.length * 1.5 ? '✅ Confirmé'
                : againstArr.length > forArr.length * 1.5 ? '❌ Réfuté'
                : (forArr.length + againstArr.length === 0 ? '❓ Aucune preuve' : '⚖️ Mitigé');
  const fmt = (h) => `· _${h.repo}/${h.section}_ — ${h.excerpt.slice(0, 140)}`;
  const parts = [`# 🔬 \"${args.claim}\"`, `**${verdict}** _(${forArr.length} pour · ${againstArr.length} contre · ${neutralArr.length} neutre)_`];
  if (forArr.length)     parts.push(`\n**Pour :**\n${forArr.slice(0, limit).map(fmt).join('\n')}`);
  if (againstArr.length) parts.push(`\n**Contre :**\n${againstArr.slice(0, limit).map(fmt).join('\n')}`);
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─── recall_thread ── follow un sujet à travers les satellites chronologiquement
server.registerTool('recall_thread', {
  title: 'Follow a topic chronologically across satellites',
  description: 'Pour un sujet, retourne les satellites/notes qui en parlent triés par date (du plus ancien au plus récent). ~300 tokens.',
  inputSchema: {
    topic: z.string().describe('Sujet à suivre'),
    max_steps: z.number().int().min(2).max(15).optional(),
  },
}, async (args) => {
  const max = args.max_steps ?? 8;
  const hits = await smartSearch(args.topic, 30);
  if (!hits.length) return { content: [{ type: 'text', text: `Aucun matériel sur "${args.topic}".` }] };

  // Annoter avec mtime ; ne garder qu'une entrée par note
  const seen = new Set();
  const annotated = [];
  for (const h of hits) {
    if (seen.has(h.notePath)) continue;
    seen.add(h.notePath);
    let mtime = 0;
    try { mtime = (await fs.stat(safeVaultPath(h.notePath))).mtimeMs; } catch {}
    annotated.push({ ...h, mtime });
  }
  annotated.sort((a, b) => a.mtime - b.mtime);
  const thread = annotated.slice(-max);

  const parts = [`# 📚 Thread \"${args.topic}\" — ${thread.length} étapes (du plus ancien)`];
  for (const h of thread) {
    const date = h.mtime ? new Date(h.mtime).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' }) : '?';
    parts.push(`**${date}** · _${h.repo}/${h.section}_\n${h.excerpt.slice(0, 200)}`);
  }
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
});

// ─── concept_search ── recherche groupée par concept inféré (cluster simple)
server.registerTool('concept_search', {
  title: 'Search grouped by inferred concept',
  description: 'Comme search_brain mais regroupe les résultats par cluster sémantique (overlap de tokens). Vue plus claire des thèmes. ~300 tokens.',
  inputSchema: {
    query: z.string().describe('Sujet de recherche'),
    max_clusters: z.number().int().min(2).max(8).optional(),
  },
}, async (args) => {
  const max = args.max_clusters ?? 4;
  const hits = await smartSearch(args.query, 20);
  if (!hits.length) return { content: [{ type: 'text', text: `Aucun résultat pour \"${args.query}\".` }] };

  // Clustering simple : Jaccard de tokens entre excerpts ; seuil 0.25
  const toks = hits.map(h => new Set(tokenize(h.excerpt)));
  const clusters = []; // {tokens: Set, members: [hit]}
  for (let i = 0; i < hits.length; i++) {
    let placed = false;
    for (const c of clusters) {
      const inter = [...toks[i]].filter(t => c.tokens.has(t)).length;
      const uni   = new Set([...toks[i], ...c.tokens]).size;
      if (uni > 0 && inter / uni > 0.18) {
        c.members.push(hits[i]);
        for (const t of toks[i]) c.tokens.add(t);
        placed = true; break;
      }
    }
    if (!placed) clusters.push({ tokens: new Set(toks[i]), members: [hits[i]] });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  const top = clusters.slice(0, max);

  const parts = [`# 🧬 Clusters pour \"${args.query}\" — ${clusters.length} thèmes`];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    // Top 4 mots qui caractérisent le cluster (les + fréquents hors stop)
    const freq = {};
    for (const m of c.members) for (const t of tokenize(m.excerpt)) freq[t] = (freq[t] || 0) + 1;
    const top4 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t).join(', ');
    parts.push(`\n## Thème ${i + 1} _(${c.members.length} hits) — ${top4}_`);
    for (const m of c.members.slice(0, 3)) {
      parts.push(`· **${m.repo}** > ${m.section} — ${m.excerpt.slice(0, 140)}`);
    }
  }
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─── contradiction_check ── détecte les énoncés conflictuels sur un concept
server.registerTool('contradiction_check', {
  title: 'Find contradicting statements on a concept',
  description: 'Pour un concept, cherche les passages contenant des marqueurs opposés (oui/non, marche/cassé) et liste les paires potentiellement en conflit. ~250 tokens.',
  inputSchema: {
    concept: z.string().describe('Concept à analyser'),
    limit: z.number().int().min(2).max(10).optional(),
  },
}, async (args) => {
  const limit = args.limit ?? 4;
  const hits = await smartSearch(args.concept, 20);
  if (hits.length < 2) return { content: [{ type: 'text', text: `Pas assez de matériel sur \"${args.concept}\" pour détecter une contradiction.` }] };
  const NEG = /\b(non|pas|jamais|aucun|n['’]est|ne\s+\w+\s+pas|never|not|fail|cass[ée]|incorrect|faux|bloqu[ée]|abandonn[ée])\b/i;
  const POS = /\b(oui|toujours|confirm[ée]|exact|vrai|fonctionne|works?|correct|valid[ée]?|done|fait|résolu|fix[ée])\b/i;
  const pos = hits.filter(h => POS.test(h.excerpt) && !NEG.test(h.excerpt));
  const neg = hits.filter(h => NEG.test(h.excerpt) && !POS.test(h.excerpt));
  if (!pos.length || !neg.length) {
    return { content: [{ type: 'text', text: `# ✅ \"${args.concept}\"\nPas de contradiction détectée (${pos.length} affirmations · ${neg.length} négations).` }] };
  }
  const pairs = [];
  for (let i = 0; i < Math.min(pos.length, limit); i++) {
    for (let j = 0; j < Math.min(neg.length, limit); j++) {
      // Score : tokens partagés entre les deux excerpts
      const a = new Set(tokenize(pos[i].excerpt));
      const b = new Set(tokenize(neg[j].excerpt));
      const inter = [...a].filter(t => b.has(t)).length;
      if (inter >= 2) pairs.push({ pos: pos[i], neg: neg[j], score: inter });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  if (!pairs.length) {
    return { content: [{ type: 'text', text: `# ⚖️ \"${args.concept}\"\n${pos.length} affirmations vs ${neg.length} négations mais sans recouvrement de contexte (pas de contradiction stricte).` }] };
  }
  const parts = [`# ⚠️ Contradictions sur \"${args.concept}\" — ${pairs.length} paire(s)`];
  for (const p of pairs.slice(0, limit)) {
    parts.push(`\n**+** _${p.pos.repo}/${p.pos.section}_ — ${p.pos.excerpt.slice(0, 150)}`);
    parts.push(`**−** _${p.neg.repo}/${p.neg.section}_ — ${p.neg.excerpt.slice(0, 150)}`);
    parts.push(`_(overlap=${p.score} tokens)_`);
  }
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ═════════════════════════════════════════════════════════════════
// v13.3 — REPO FILESYSTEM BROWSING (token-efficient)
//
// Permet de naviguer le code source réel des repos GitHub locaux
// sans charger les fichiers entiers en RAM ni en tokens. Exclut
// automatiquement le bruit (node_modules, .git, dist, build, etc.)
// et applique des limites strictes par défaut.
// ═════════════════════════════════════════════════════════════════

// ── Config & helpers v13.3 ──────────────────────────────────────

/** Bases de recherche standard pour résoudre repo_name → chemin filesystem */
const _REPO_BASES = [
  process.env.GALACTIC_REPOS_BASE,
  'C:\\laragon\\www',
  'C:\\Users\\PC\\Documents\\GitHub',
  'C:\\Users\\PC\\projects',
  'C:\\Users\\PC\\Documents\\projects',
  'C:\\Users\\PC',
].filter(Boolean);

/** Dossiers à exclure systématiquement (bruit) */
const _EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'env',
  '.idea', '.vscode', '.cache', 'coverage', '.nyc_output', 'tmp',
  '.parcel-cache', '.svelte-kit', '.turbo', '.gradle', 'bin',
  'obj', '.terraform',
]);

/** Extensions binaires à skip pour grep/read */
const _BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp',
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.webm',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.docx', '.xlsx', '.pptx',
]);

const _repoPathCache = new Map();

async function _resolveRepoPath(repoName) {
  if (_repoPathCache.has(repoName)) return _repoPathCache.get(repoName);
  for (const base of _REPO_BASES) {
    const candidate = path.join(base, repoName);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) {
        _repoPathCache.set(repoName, candidate);
        return candidate;
      }
    } catch {}
  }
  _repoPathCache.set(repoName, null);
  return null;
}

/** Walk récursif limité avec exclusions */
async function _walkRepo(rootAbs, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 200;
  const out = [];
  async function walk(rel, depth) {
    if (depth > maxDepth) return;
    if (out.length >= maxEntries) return;
    let entries;
    try { entries = await fs.readdir(path.join(rootAbs, rel), { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.gitignore' && e.name !== '.github') continue;
      if (_EXCLUDE_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.push({ rel: childRel, isDir: e.isDirectory(), depth });
      if (e.isDirectory()) await walk(childRel, depth + 1);
    }
  }
  await walk('', 0);
  return out;
}

// ─────────────── v13.3/1 — repo_tree ───────────────
server.registerTool('repo_tree', {
  title: '🌳 Tree filesystem d\'un repo (compact)',
  description: 'Affiche l\'arborescence d\'un repo local en mode compact (exclut node_modules, .git, dist, build...). Très peu gourmand en tokens. ~200-400 tokens selon depth.',
  inputSchema: {
    repo: z.string().describe('Nom du repo (ex: "Cycling")'),
    depth: z.number().int().min(1).max(6).optional().describe('Profondeur max (default: 2)'),
    max_entries: z.number().int().min(10).max(500).optional().describe('Default: 150'),
    subpath: z.string().optional().describe('Sous-chemin à explorer (ex: "src/components")'),
  },
}, async (args) => {
  const repoAbs = await _resolveRepoPath(args.repo);
  if (!repoAbs) {
    return { content: [{ type: 'text', text: `❌ Repo "${args.repo}" introuvable.\nBases testées : ${_REPO_BASES.join(', ')}.\nDéfinir GALACTIC_REPOS_BASE pour ajouter une base.` }], isError: true };
  }
  const root = args.subpath ? path.join(repoAbs, args.subpath) : repoAbs;
  try { const st = await fs.stat(root); if (!st.isDirectory()) throw new Error(); }
  catch { return { content: [{ type: 'text', text: `❌ Sous-chemin invalide : "${args.subpath || ''}"` }], isError: true }; }

  const entries = await _walkRepo(root, { maxDepth: args.depth ?? 2, maxEntries: args.max_entries ?? 150 });
  if (entries.length === 0) {
    return { content: [{ type: 'text', text: `_(répertoire vide ou tout exclu)_` }] };
  }
  // Render compact ASCII tree
  const lines = [args.subpath ? `${args.repo}/${args.subpath}` : args.repo];
  for (const e of entries) {
    const indent = '  '.repeat(e.depth);
    const icon = e.isDir ? '📂' : '·';
    const name = e.rel.split('/').pop();
    lines.push(`${indent}${icon} ${name}`);
  }
  const summary = `_${entries.length} entries (depth ≤ ${args.depth ?? 2})_`;
  return { content: [{ type: 'text', text: '```\n' + lines.join('\n') + '\n```\n' + summary }] };
});

// ─────────────── v13.3/2 — repo_file ───────────────
server.registerTool('repo_file', {
  title: '📄 Lit un fichier d\'un repo (avec range optionnel)',
  description: 'Lit un fichier source en compact mode. Supporte les ranges de lignes (économise les tokens sur grand fichiers). Skip les binaires.',
  inputSchema: {
    repo: z.string().describe('Nom du repo'),
    path: z.string().describe('Chemin relatif du fichier (ex: "src/index.ts")'),
    start_line: z.number().int().min(1).optional().describe('Ligne de début (1-indexed)'),
    end_line: z.number().int().min(1).optional().describe('Ligne de fin (inclusive)'),
    max_lines: z.number().int().min(1).max(2000).optional().describe('Cap si start/end absents. Default: 300'),
  },
}, async (args) => {
  const repoAbs = await _resolveRepoPath(args.repo);
  if (!repoAbs) return { content: [{ type: 'text', text: `❌ Repo "${args.repo}" introuvable.` }], isError: true };

  const ext = path.extname(args.path).toLowerCase();
  if (_BINARY_EXT.has(ext)) {
    return { content: [{ type: 'text', text: `⚠️ Fichier binaire (${ext}) — lecture ignorée.` }] };
  }
  const abs = path.join(repoAbs, args.path);
  let content;
  try {
    const st = await fs.stat(abs);
    if (st.size > 2 * 1024 * 1024) {
      return { content: [{ type: 'text', text: `⚠️ Fichier trop grand (${Math.round(st.size / 1024)} ko). Utilisez start_line/end_line pour un range, ou repo_grep pour chercher dedans.` }] };
    }
    content = await fs.readFile(abs, 'utf8');
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ Fichier introuvable : ${args.path}` }], isError: true };
  }
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.max(1, args.start_line || 1);
  const end = args.end_line ? Math.min(total, args.end_line) : Math.min(total, start + (args.max_lines ?? 300) - 1);
  const slice = lines.slice(start - 1, end);

  const langTag = ext.replace('.', '');
  const header = `${args.repo}/${args.path} · lignes ${start}-${end}/${total}`;
  const body = slice.map((l, i) => `${String(start + i).padStart(4)}  ${l}`).join('\n');
  return { content: [{ type: 'text', text: `**${header}**\n\`\`\`${langTag}\n${body}\n\`\`\`` }] };
});

// ─────────────── v13.3/3 — repo_grep ───────────────
server.registerTool('repo_grep', {
  title: '🔎 Grep dans un repo (file:line:match)',
  description: 'Recherche regex dans les fichiers texte du repo. Format compact file:line:match. Limite stricte par défaut pour économiser les tokens.',
  inputSchema: {
    repo: z.string().describe('Nom du repo'),
    pattern: z.string().describe('Regex ou string à chercher (insensitive par défaut)'),
    subpath: z.string().optional().describe('Limiter la recherche à un sous-chemin'),
    glob: z.string().optional().describe('Extension/glob à filtrer (ex: "ts", "*.css", "py")'),
    limit: z.number().int().min(1).max(100).optional().describe('Default: 30'),
    case_sensitive: z.boolean().optional(),
  },
}, async (args) => {
  const repoAbs = await _resolveRepoPath(args.repo);
  if (!repoAbs) return { content: [{ type: 'text', text: `❌ Repo "${args.repo}" introuvable.` }], isError: true };
  const root = args.subpath ? path.join(repoAbs, args.subpath) : repoAbs;
  const limit = args.limit ?? 30;
  const flags = args.case_sensitive ? '' : 'i';
  let re;
  try { re = new RegExp(args.pattern, flags); }
  catch (e) { return { content: [{ type: 'text', text: `❌ Regex invalide : ${e.message}` }], isError: true }; }

  // Filter extension/glob
  let extFilter = null;
  if (args.glob) {
    const g = args.glob.toLowerCase().replace(/^\*?\.?/, '');
    if (g) extFilter = '.' + g;
  }

  const results = [];
  let filesScanned = 0;
  async function scan(rel) {
    if (results.length >= limit) return;
    const abs = path.join(root, rel);
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (results.length >= limit) return;
      if (_EXCLUDE_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await scan(childRel); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (_BINARY_EXT.has(ext)) continue;
      if (extFilter && ext !== extFilter) continue;
      try {
        const st = await fs.stat(path.join(root, childRel));
        if (st.size > 1024 * 1024) continue; // skip > 1 MB
        const content = await fs.readFile(path.join(root, childRel), 'utf8');
        filesScanned++;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (re.test(lines[i])) {
            const trim = lines[i].trim();
            const truncated = trim.length > 160 ? trim.slice(0, 160) + '…' : trim;
            results.push(`${args.subpath ? args.subpath + '/' : ''}${childRel}:${i + 1}: ${truncated}`);
          }
        }
      } catch {}
    }
  }
  await scan('');

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `Aucun match pour /${args.pattern}/${flags} dans ${args.repo} (${filesScanned} fichiers scannés).` }] };
  }
  const more = results.length >= limit ? ` _(tronqué à ${limit} — augmente limit ou affine pattern)_` : '';
  return { content: [{ type: 'text', text: `**${results.length} match(s)** dans ${args.repo}${more}\n\n\`\`\`\n${results.join('\n')}\n\`\`\`` }] };
});

// ─────────────── v13.3/4 — repo_meta ───────────────
server.registerTool('repo_meta', {
  title: '📋 Métadonnées clés d\'un repo (package.json, README head, etc.)',
  description: 'Lit les fichiers-clés en mode high-signal : package.json (deps + scripts), README (premiers paragraphes), .env.example (liste vars), schéma BDD si présent. Ultra compact (~300 tokens).',
  inputSchema: {
    repo: z.string().describe('Nom du repo'),
  },
}, async (args) => {
  const repoAbs = await _resolveRepoPath(args.repo);
  if (!repoAbs) return { content: [{ type: 'text', text: `❌ Repo "${args.repo}" introuvable.` }], isError: true };

  const parts = [`# ${args.repo} · meta`];

  // package.json (Node) ou pyproject.toml (Python) ou Cargo.toml (Rust) ou go.mod (Go)
  const pkgChecks = [
    { f: 'package.json', kind: 'node' },
    { f: 'pyproject.toml', kind: 'python' },
    { f: 'requirements.txt', kind: 'python-req' },
    { f: 'Cargo.toml', kind: 'rust' },
    { f: 'go.mod', kind: 'go' },
    { f: 'composer.json', kind: 'php' },
  ];
  for (const pc of pkgChecks) {
    try {
      const c = await fs.readFile(path.join(repoAbs, pc.f), 'utf8');
      if (pc.kind === 'node') {
        const json = JSON.parse(c);
        const deps = Object.keys(json.dependencies || {});
        const devDeps = Object.keys(json.devDependencies || {});
        const scripts = Object.keys(json.scripts || {});
        parts.push(`\n## 📦 ${pc.f} (Node)`);
        if (json.name)        parts.push(`- name: \`${json.name}\` ${json.version ? '· v' + json.version : ''}`);
        if (json.description) parts.push(`- desc: ${json.description}`);
        if (scripts.length)   parts.push(`- scripts: ${scripts.slice(0, 8).join(', ')}${scripts.length > 8 ? '…' : ''}`);
        if (deps.length)      parts.push(`- deps (${deps.length}): ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? '…' : ''}`);
        if (devDeps.length)   parts.push(`- devDeps (${devDeps.length}): ${devDeps.slice(0, 8).join(', ')}${devDeps.length > 8 ? '…' : ''}`);
      } else {
        parts.push(`\n## 📦 ${pc.f} (${pc.kind})`);
        parts.push('```\n' + c.split('\n').slice(0, 25).join('\n') + (c.split('\n').length > 25 ? '\n…' : '') + '\n```');
      }
      break;
    } catch {}
  }

  // README
  for (const r of ['README.md', 'README.rst', 'README.txt', 'README']) {
    try {
      const c = await fs.readFile(path.join(repoAbs, r), 'utf8');
      const head = c.split('\n').slice(0, 25).join('\n');
      parts.push(`\n## 📖 ${r} (head)`);
      parts.push(head.length > 800 ? head.slice(0, 800) + '\n…' : head);
      break;
    } catch {}
  }

  // .env.example variables
  try {
    const c = await fs.readFile(path.join(repoAbs, '.env.example'), 'utf8');
    const vars = c.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0]);
    if (vars.length) {
      parts.push(`\n## 🔐 .env.example (${vars.length} vars)`);
      parts.push(vars.map(v => '- `' + v + '`').join('\n'));
    }
  } catch {}

  // Schéma BDD (heuristique)
  for (const s of ['schema.sql', 'schema.prisma', 'migrations/init.sql', 'db/schema.sql']) {
    try {
      const c = await fs.readFile(path.join(repoAbs, s), 'utf8');
      const tables = [...c.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?/gi)].map(m => m[1]);
      if (tables.length) {
        parts.push(`\n## 🗄️ ${s} (${tables.length} tables)`);
        parts.push(tables.map(t => '- `' + t + '`').join('\n'));
      }
      break;
    } catch {}
  }

  // Stats globales : compte de fichiers par extension top-5
  const entries = await _walkRepo(repoAbs, { maxDepth: 6, maxEntries: 5000 });
  const byExt = {};
  for (const e of entries) {
    if (e.isDir) continue;
    const ext = path.extname(e.rel).toLowerCase() || '(noext)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  const topExt = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8);
  parts.push(`\n## 📊 Fichiers (top extensions)`);
  parts.push(topExt.map(([ext, n]) => `- \`${ext}\` ×${n}`).join('  '));

  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ═════════════════════════════════════════════════════════════════
// v13.4 — Tools d'apprentissage (4 nouveaux)
// ═════════════════════════════════════════════════════════════════

// ─────────────── v13.4/1 — feedback ───────────────
server.registerTool('feedback', {
  title: '👍 Donner un feedback sur le dernier routing',
  description: 'Dit au brain : "ton dernier routing était bon/mauvais, le bon outil aurait été X". Le brain s\'en sert pour s\'améliorer (cache learned.json après consolidation).',
  inputSchema: {
    rating: z.enum(['good', 'bad', 'correct_to']).describe('good=ok, bad=mauvais, correct_to=donne l\'outil correct'),
    correct_tool: z.string().optional().describe('Si rating=correct_to, nom du bon outil'),
    note: z.string().optional().describe('Note libre (optionnel)'),
  },
}, async (args) => {
  // Récupère le dernier event understand
  const events = await _readEvents({ type: 'understand', since_days: 1 });
  const last = events[events.length - 1];
  if (!last) {
    return { content: [{ type: 'text', text: 'Aucun event "understand" récent à corriger. Utilise d\'abord understand.' }] };
  }
  _logEvent('feedback', {
    targets: last.qkey,
    query: last.q,
    was: last.chose,
    rating: args.rating,
    correct: args.correct_tool || null,
    note: args.note || null,
  });
  return {
    content: [{ type: 'text', text: `✓ Feedback enregistré pour requête "${last.q}" → était ${last.chose.join(',')}, ${args.rating === 'correct_to' ? `correct=${args.correct_tool}` : args.rating}.\n\nLance \`brain_consolidate\` pour appliquer (le routing se mettra à jour).` }],
  };
});

// ─────────────── v13.4/2 — brain_stats ───────────────
server.registerTool('brain_stats', {
  title: '📊 Stats d\'apprentissage du brain',
  description: 'Affiche les stats du système d\'apprentissage : events loggés, requêtes uniques, top tools utilisés, taux d\'erreur, dernière consolidation. ~200 tokens.',
  inputSchema: {
    since_days: z.number().int().min(1).max(180).optional().describe('Fenêtre. Default: 30'),
  },
}, async (args) => {
  const days = args.since_days ?? 30;
  const events = await _readEvents({ since_days: days });
  if (events.length === 0) {
    return { content: [{ type: 'text', text: `Aucun event sur ${days} jours. Le brain n'a pas encore d'historique d'apprentissage — il apprendra dès tes prochaines utilisations.` }] };
  }
  const understand = events.filter(e => e.type === 'understand');
  const feedback   = events.filter(e => e.type === 'feedback');
  const errors     = events.filter(e => e.type === 'understand' && e.errors?.length > 0);
  const learnedHits = understand.filter(e => e.used_learned).length;

  // Top tools utilisés
  const toolCounts = {};
  for (const e of understand) {
    for (const t of (e.chose || [])) toolCounts[t] = (toolCounts[t] || 0) + 1;
  }
  const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Requêtes uniques
  const uniqueQueries = new Set(understand.map(e => e.qkey)).size;

  const learned = await _loadLearned();
  const lastConso = learned.last_consolidate
    ? `il y a ${Math.round((Date.now() - learned.last_consolidate) / 86400000)}j`
    : 'jamais';

  const lines = [
    `# 🧠 Brain stats (${days}j)`,
    ``,
    `- Events totaux : **${events.length}**`,
    `- Calls understand : **${understand.length}** (${uniqueQueries} requêtes uniques)`,
    `- Routings appris utilisés : **${learnedHits}** (${understand.length > 0 ? Math.round(learnedHits/understand.length*100) : 0}%)`,
    `- Erreurs : **${errors.length}** (${understand.length > 0 ? Math.round(errors.length/understand.length*100) : 0}%)`,
    `- Feedbacks : **${feedback.length}**`,
    `- Routes apprises en cache : **${Object.keys(learned.query_routes || {}).length}**`,
    `- Lexique étendu : **${Object.keys(learned.lexicon || {}).length}** termes`,
    `- Dernière consolidation : ${lastConso}`,
    ``,
    `## Top tools utilisés`,
    topTools.map(([t, n]) => `- \`${t}\` ×${n}`).join('\n') || '_(vide)_',
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ─────────────── v13.4/3 — brain_consolidate ───────────────
server.registerTool('brain_consolidate', {
  title: '🧬 Consolider l\'apprentissage du brain',
  description: 'Analyse les events récents et met à jour learned.json : cache de routings stables (≥3 occurrences même choix), feedbacks intégrés, lexique des termes fréquents. À lancer 1×/semaine ou après plusieurs feedbacks.',
  inputSchema: {
    since_days: z.number().int().min(1).max(365).optional().describe('Fenêtre. Default: 60'),
    apply: z.boolean().optional().describe('Si false, mode dry-run (montre les changements sans écrire). Default: true'),
  },
}, async (args) => {
  const days = args.since_days ?? 60;
  const apply = args.apply ?? true;
  const events = await _readEvents({ since_days: days });
  if (events.length === 0) {
    return { content: [{ type: 'text', text: `Aucun event à consolider (${days}j vide).` }] };
  }

  // Agréger par requête normalisée
  const byQuery = {};
  const understandEvents = events.filter(e => e.type === 'understand');
  for (const e of understandEvents) {
    if (!e.qkey) continue;
    (byQuery[e.qkey] = byQuery[e.qkey] || { count: 0, choices: {}, last: 0, sampleQuery: e.q }).count++;
    const choice = (e.chose || [])[0];
    if (choice) byQuery[e.qkey].choices[choice] = (byQuery[e.qkey].choices[choice] || 0) + 1;
    byQuery[e.qkey].last = Math.max(byQuery[e.qkey].last, e.t);
  }

  // Appliquer les feedbacks (corrections)
  const feedbacks = events.filter(e => e.type === 'feedback' && e.rating === 'correct_to' && e.correct);
  for (const f of feedbacks) {
    if (!byQuery[f.targets]) byQuery[f.targets] = { count: 0, choices: {}, last: f.t, sampleQuery: f.query };
    // Boost massif du tool corrigé
    byQuery[f.targets].choices[f.correct] = (byQuery[f.targets].choices[f.correct] || 0) + 10;
    byQuery[f.targets].feedbackApplied = true;
  }

  // Garder seulement les requêtes stables (≥3 occurrences, choix majoritaire ≥60%)
  const learned = await _loadLearned();
  const query_routes = {};
  let stable = 0, unstable = 0;
  for (const [qkey, data] of Object.entries(byQuery)) {
    const total = Object.values(data.choices).reduce((a, b) => a + b, 0);
    if (total < 3 && !data.feedbackApplied) { unstable++; continue; }
    const [topTool, topCount] = Object.entries(data.choices).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (!topTool) { unstable++; continue; }
    const confidence = topCount / total;
    if (confidence < 0.6 && !data.feedbackApplied) { unstable++; continue; }
    query_routes[qkey] = {
      tool: topTool,
      confidence: Math.round(confidence * 100) / 100,
      count: total,
      sample: data.sampleQuery,
      last: data.last,
    };
    stable++;
  }

  // Lexique : termes hors STOP qui apparaissent souvent dans les requêtes (≥5×)
  const termFreq = {};
  for (const e of understandEvents) {
    for (const t of tokenize(e.q || '')) {
      if (t.length < 3) continue;
      termFreq[t] = (termFreq[t] || 0) + 1;
    }
  }
  const lexicon = {};
  for (const [t, n] of Object.entries(termFreq)) {
    if (n >= 5) lexicon[t] = n;
  }

  // Hot notes : extraite si jamais on logue les notes accédées (pas encore implémenté)
  const newLearned = {
    query_routes,
    hot_notes: learned.hot_notes || [],
    cold_queries: Object.entries(byQuery)
      .filter(([k, d]) => d.count >= 2 && Object.keys(d.choices).length === 0)
      .map(([k, d]) => ({ qkey: k, sample: d.sampleQuery, count: d.count }))
      .slice(0, 20),
    lexicon,
    last_consolidate: Date.now(),
  };

  const diff = {
    routes_before: Object.keys(learned.query_routes || {}).length,
    routes_after: Object.keys(query_routes).length,
    lexicon_before: Object.keys(learned.lexicon || {}).length,
    lexicon_after: Object.keys(lexicon).length,
    feedbacks_applied: feedbacks.length,
    stable, unstable,
  };

  if (apply) {
    await _ensureBrainDir();
    await fs.writeFile(path.join(VAULT_PATH, _LEARNED_JSON), JSON.stringify(newLearned, null, 2), 'utf8');
    _learnedCache = null; // force reload
  }

  return {
    content: [{
      type: 'text',
      text: `# 🧬 Consolidation${apply ? '' : ' (dry-run)'} sur ${days}j

- Events analysés : **${events.length}** (${understandEvents.length} understand, ${feedbacks.length} feedbacks)
- Routes stables : **${diff.routes_before} → ${diff.routes_after}** (${stable} OK, ${unstable} instables)
- Lexique : **${diff.lexicon_before} → ${diff.lexicon_after}** termes
- Feedbacks intégrés : **${diff.feedbacks_applied}**

${apply ? '✓ Écrit dans `' + _LEARNED_JSON + '` — les prochains \`understand\` utiliseront le fast-path.' : '_(dry-run, rien écrit)_'}`,
    }],
  };
});

// ─────────────── v13.4/4 — brain_learned ───────────────
server.registerTool('brain_learned', {
  title: '🎓 Affiche ce que le brain a appris',
  description: 'Liste les routings appris en cache, le lexique étendu, et les requêtes "cold" (qui n\'ont pas matché). Utile pour debug du système d\'apprentissage.',
  inputSchema: {
    show: z.enum(['routes', 'lexicon', 'cold', 'all']).optional().describe('Default: all'),
    limit: z.number().int().min(1).max(50).optional().describe('Default: 15'),
  },
}, async (args) => {
  const show = args.show ?? 'all';
  const limit = args.limit ?? 15;
  const learned = await _loadLearned();

  const parts = [`# 🎓 Apprentissage actuel`];
  if (show === 'all' || show === 'routes') {
    const routes = Object.entries(learned.query_routes || {})
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit);
    parts.push(`\n## Routings cachés (${Object.keys(learned.query_routes || {}).length} total)`);
    if (!routes.length) parts.push('_(aucun routing stable appris encore)_');
    else for (const [k, v] of routes) {
      parts.push(`- "${v.sample || k}" → \`${v.tool}\` (×${v.count}, conf=${v.confidence})`);
    }
  }
  if (show === 'all' || show === 'lexicon') {
    const lex = Object.entries(learned.lexicon || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    parts.push(`\n## Lexique étendu (${Object.keys(learned.lexicon || {}).length} termes)`);
    if (!lex.length) parts.push('_(aucun terme appris encore)_');
    else parts.push(lex.map(([t, n]) => `\`${t}\`×${n}`).join(' · '));
  }
  if (show === 'all' || show === 'cold') {
    const cold = (learned.cold_queries || []).slice(0, limit);
    parts.push(`\n## Requêtes "cold" (no match — candidates pour nouveaux intents)`);
    if (!cold.length) parts.push('_(aucune)_');
    else for (const c of cold) parts.push(`- "${c.sample}" (×${c.count})`);
  }
  parts.push(`\n_Dernière consolidation : ${learned.last_consolidate ? new Date(learned.last_consolidate).toLocaleString('fr-FR') : 'jamais'}_`);
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ═════════════════════════════════════════════════════════════════════
// ════════ COGNITIVE SYNTHESIS LAYER v14 — Galactic Brain ════════════
//
// 12 outils orchestrateurs au-dessus des 96 existants. Objectif :
// passer du "menu d'outils" au "second cerveau qui pense pour toi".
//
// Caractéristiques :
// - Synthèse multi-source en une seule réponse (au lieu de N appels)
// - Raisonnement séquentiel (output[N-1] → input[N])
// - Anticipation (ce qui va manquer demain)
// - Stress-test adversarial des décisions
// - Voix narrative cohérente (briefing au lieu de bullet-points)
// ═════════════════════════════════════════════════════════════════════

// Handler resolver global (extrait du scope local de `understand`)
function _gbHandler(name) {
  const reg = server._registeredTools || server.registeredTools || server._tools;
  if (!reg) return null;
  const t = (typeof reg.get === 'function' ? reg.get(name) : reg[name]);
  return t?.callback || t?.handler || t?.fn || null;
}

async function _gbCall(name, params = {}) {
  const h = _gbHandler(name);
  if (!h) return { error: `handler ${name} indisponible` };
  try {
    const r = await h(params);
    return { text: r?.content?.[0]?.text || '', raw: r };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

function _gbExtractLines(text, max = 8) {
  if (!text) return [];
  return text.split('\n').filter(l => l.trim()).slice(0, max);
}

function _gbHourLabel() {
  const h = new Date().getHours();
  if (h < 6)  return { greet: 'Nuit profonde', energy: 'low',  emoji: '🌙' };
  if (h < 11) return { greet: 'Bonjour',       energy: 'high', emoji: '🌅' };
  if (h < 14) return { greet: 'Midi',          energy: 'med',  emoji: '🌤️' };
  if (h < 18) return { greet: 'Après-midi',    energy: 'med',  emoji: '☀️' };
  if (h < 22) return { greet: 'Bonsoir',       energy: 'low',  emoji: '🌆' };
  return { greet: 'Tard',                      energy: 'low',  emoji: '🌃' };
}

// ─────────────── brain_brief ───────────────
// Briefing proactif comprehensive — remplace l'enchaînement
// morning_routine + deadlines + anomaly + pulse + cluster_improvements.
server.registerTool('brain_brief', {
  title: '🛰️ Briefing proactif (situation report)',
  description: "Rapport de situation complet : commits récents, deadlines, anomalies, threads stalled, contradictions actives, top action. Une réponse cohérente narrative (pas une liste d'outils). À appeler comme première action de la journée OU quand tu reprends après une pause.",
  inputSchema: {
    depth: z.enum(['quick', 'full', 'deep']).optional().describe('quick=~250 tokens, full=~600, deep=~1200. Default: full'),
    days: z.number().int().min(1).max(30).optional().describe('Fenêtre activité. Default: 3'),
  },
}, async (args) => {
  const depth = args.depth ?? 'full';
  const days = args.days ?? 3;
  const { greet, energy, emoji } = _gbHourLabel();

  const [data, sats, imp, goals, handoff, events] = await Promise.all([
    loadData(),
    cachedSatellites(),
    cachedImprovements(),
    readJson(GOALS_PATH, []),
    readJson(HANDOFF_PATH, null),
    _readEvents({ since_days: days }),
  ]);

  const now = Date.now();
  const since = handoff ? new Date(handoff.saved_at).getTime() : now - days * 86400000;

  // Commits/notes pendant absence
  const newCommits = data.repos.filter(r => new Date(r.last_pushed).getTime() > since);
  const newSats = sats.filter(s => s.mtime > since);

  // Backlog
  const open = imp.filter(i => !i.done);
  const crit = open.filter(i => i.priority === 'critical');
  const high = open.filter(i => i.priority === 'high');

  // Deadlines urgentes (7j)
  const urgent = goals.filter(g => !g.done && g.deadline)
    .map(g => ({ ...g, days: Math.round((new Date(g.deadline).getTime() - now) / 86400000) }))
    .filter(g => g.days <= 7).sort((a, b) => a.days - b.days);

  // Stalled : repos sans commit depuis >21j mais avec improvements ouverts
  const stalled = data.repos
    .map(r => ({ name: r.name, age: Math.round((now - new Date(r.last_pushed).getTime()) / 86400000) }))
    .filter(r => r.age > 21 && open.some(i => i.repo === r.name))
    .sort((a, b) => b.age - a.age).slice(0, 3);

  // Hot : repos actifs ces 7j avec improvements ouverts
  const hot = data.repos
    .filter(r => now - new Date(r.last_pushed).getTime() < 7 * 86400000)
    .map(r => ({ name: r.name, openCount: open.filter(i => i.repo === r.name).length }))
    .filter(r => r.openCount > 0).sort((a, b) => b.openCount - a.openCount).slice(0, 3);

  // Top action via scoring (réutilise PRIORITY_WEIGHT/CATEGORY_WEIGHT/EFFORT_HOURS)
  const intentScore = {};
  for (const r of data.repos) {
    const age = now - new Date(r.last_pushed).getTime();
    if (age < 7 * 86400000) intentScore[r.name] = 1 - age / (7 * 86400000);
  }
  const topActions = open.map(i => ({
    ...i,
    score: ((PRIORITY_WEIGHT[i.priority] ?? 1) * (CATEGORY_WEIGHT[i.category] ?? 1) / (EFFORT_HOURS[i.effort] ?? 8)) * (1 + (intentScore[i.repo] ?? 0)),
  })).sort((a, b) => b.score - a.score).slice(0, 3);

  // Erreurs récentes dans le brain learning (signal de friction)
  const errCount = events.filter(e => e.type === 'understand' && (e.errors || []).length).length;

  // Narrative assembly
  const lines = [`# ${emoji} ${greet} — Galactic Brain · ${todayDate()}`, ''];

  // Ouverture narrative
  const headline = handoff
    ? `Tu reprends après **${handoff.context || 'ta dernière session'}**. La piste laissée : *${handoff.next || 'rien noté'}*.`
    : `Pas de handoff précédent — j'assume un démarrage à froid.`;
  lines.push(headline, '');

  // Section 1 : état du monde
  lines.push(`## 🌍 État`);
  const stateBits = [];
  if (newCommits.length) stateBits.push(`**${newCommits.length} commit${newCommits.length>1?'s':''}** sur ${new Set(newCommits.map(c=>c.name)).size} repo${newCommits.length>1?'s':''}`);
  if (newSats.length)    stateBits.push(`**${newSats.length} note${newSats.length>1?'s':''}** ajoutée${newSats.length>1?'s':''}`);
  stateBits.push(`**${open.length}** improvements ouverts (${crit.length} critical · ${high.length} high)`);
  lines.push(stateBits.join(' · '));
  if (newCommits.length && depth !== 'quick') {
    const top = newCommits.slice(0, 3).map(r => r.name).join(', ');
    lines.push(`_Actifs : ${top}${newCommits.length>3?'…':''}_`);
  }
  lines.push('');

  // Section 2 : urgences
  if (urgent.length || crit.length) {
    lines.push(`## ⏰ Urgences`);
    for (const g of urgent.slice(0, 3)) {
      const tag = g.days < 0 ? `⚠️ J+${-g.days} retard` : g.days === 0 ? '🔥 aujourd\'hui' : `J-${g.days}`;
      lines.push(`- ${tag} · ${g.title}`);
    }
    if (crit.length && depth !== 'quick') {
      lines.push(`- 🚨 ${crit.length} critical en backlog${crit[0]?` (ex: "${escapeMd(crit[0].title).slice(0, 60)}")`:''}`);
    }
    lines.push('');
  }

  // Section 3 : top action recommandée
  if (topActions.length) {
    lines.push(`## 🎯 Action prioritaire`);
    const t = topActions[0];
    lines.push(`**[${t.repo}]** ${t.title}`);
    lines.push(`_${t.priority}/${t.category || '?'} · effort ${t.effort || '?'} · score ${t.score.toFixed(2)}_`);
    if (depth === 'deep' && topActions.length > 1) {
      lines.push(``, `_Suivantes :_`);
      for (const t2 of topActions.slice(1)) {
        lines.push(`- [${t2.repo}] ${escapeMd(t2.title).slice(0, 70)} _(${t2.score.toFixed(2)})_`);
      }
    }
    lines.push('');
  }

  // Section 4 : momentum
  if ((hot.length || stalled.length) && depth !== 'quick') {
    lines.push(`## 📊 Momentum`);
    if (hot.length)     lines.push(`🔥 **Chaud** : ${hot.map(h => `${h.name} (${h.openCount} todo)`).join(' · ')}`);
    if (stalled.length) lines.push(`❄️ **Stalled** : ${stalled.map(s => `${s.name} (${s.age}j)`).join(' · ')}`);
    lines.push('');
  }

  // Section 5 : signal faible
  if (depth === 'deep' && errCount > 0) {
    lines.push(`## 🔬 Signaux faibles`);
    lines.push(`- ${errCount} erreur${errCount>1?'s':''} de routing dans le brain sur ${days}j — peut-être lancer \`brain_consolidate\``);
    lines.push('');
  }

  // Fermeture proactive
  const closer = [];
  if (urgent.length && urgent[0].days <= 1) closer.push(`Je commencerais par **${urgent[0].title}** (${urgent[0].days <= 0 ? 'en retard' : 'aujourd\'hui'}).`);
  else if (topActions.length) closer.push(`Je commencerais par **${topActions[0].title}** (${topActions[0].repo}).`);
  if (energy === 'high') closer.push(`Énergie haute — bon créneau pour les tâches deep.`);
  else if (energy === 'low') closer.push(`Énergie basse — privilégie les tâches courtes ou la revue.`);
  if (closer.length) lines.push(`---`, `> ${closer.join(' ')}`);

  _logEvent('brain_brief', { depth, days, urgent: urgent.length, crit: crit.length });
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ─────────────── brain_advise ───────────────
// Stress-test d'une décision : contradiction_check + reason + similar past decisions + risk
server.registerTool('brain_advise', {
  title: '⚖️ Stress-test d\'une décision (GO / NO-GO / CAUTION)',
  description: "Soumets une décision ou un plan ; je le confronte à la mémoire (contradictions, décisions similaires passées), je raisonne sur les risques, et je rends un verdict GO / NO-GO / CAUTION avec watchpoints. Le 'avocat du diable' du brain.",
  inputSchema: {
    decision: z.string().describe("La décision ou le plan à stress-tester"),
    context: z.string().optional().describe("Contexte additionnel (repo, contraintes...)"),
  },
}, async (args) => {
  const decision = args.decision.trim();
  const context  = args.context?.trim() || '';
  const query = context ? `${decision} — ${context}` : decision;

  // Lance en parallèle : contradiction, raisonnement, recherche, décisions passées
  const [contraR, reasonR, similarR, decisions] = await Promise.all([
    _gbCall('contradiction_check', { concept: decision }),
    _gbCall('reason', { question: `Quels sont les risques et les bénéfices de : ${decision}` }),
    _gbCall('search_brain', { query: decision, limit: 5 }),
    readJson(DECISIONS_PATH, []),
  ]);

  // Heuristique de scoring (basée sur mots-clés dans les sorties)
  const ctxText = `${contraR.text || ''} ${reasonR.text || ''} ${similarR.text || ''}`.toLowerCase();
  let risk = 0;
  const riskWords  = ['conflit', 'contradiction', 'risque', 'fragile', 'incompatible', 'bloque', 'rupture', 'incohér', 'manque', 'inconnu'];
  const safeWords  = ['cohérent', 'aligné', 'supporté', 'éprouvé', 'stable', 'précédent', 'similaire', 'déjà fait', 'validé'];
  for (const w of riskWords) if (ctxText.includes(w)) risk += 1;
  for (const w of safeWords) if (ctxText.includes(w)) risk -= 1;

  // Décisions passées similaires (tokens en commun)
  const decTokens = new Set(tokenize(decision));
  const past = Array.isArray(decisions) ? decisions
    .map(d => {
      const dt = tokenize(d.text || d.content || '');
      const overlap = dt.filter(t => decTokens.has(t)).length;
      return { ...d, overlap };
    })
    .filter(d => d.overlap >= 2)
    .sort((a, b) => b.overlap - a.overlap).slice(0, 3) : [];

  // Verdict
  let verdict, verdictEmoji;
  if (risk >= 3)       { verdict = 'NO-GO',   verdictEmoji = '🛑'; }
  else if (risk >= 1)  { verdict = 'CAUTION', verdictEmoji = '⚠️'; }
  else if (risk <= -2) { verdict = 'GO',      verdictEmoji = '✅'; }
  else                 { verdict = 'GO PRUDENT', verdictEmoji = '🟡'; }

  const parts = [
    `# ${verdictEmoji} Verdict : **${verdict}**`,
    ``,
    `**Décision** : ${escapeMd(decision)}`,
    context ? `**Contexte** : ${escapeMd(context)}` : '',
    `**Score de risque** : ${risk} (positif = risqué, négatif = sûr)`,
    ``,
  ].filter(Boolean);

  // Contradictions
  if (contraR.text && contraR.text.length > 20 && !contraR.error) {
    parts.push(`## 🔀 Contradictions détectées`);
    parts.push(_gbExtractLines(contraR.text, 6).join('\n'));
    parts.push('');
  }

  // Raisonnement
  if (reasonR.text && !reasonR.error) {
    parts.push(`## 🧮 Raisonnement`);
    parts.push(_gbExtractLines(reasonR.text, 8).join('\n'));
    parts.push('');
  }

  // Décisions similaires
  if (past.length) {
    parts.push(`## 📜 Décisions similaires passées`);
    for (const d of past) {
      const when = d.timestamp ? new Date(d.timestamp).toLocaleDateString('fr-FR') : '?';
      parts.push(`- _${when}_ — ${escapeMd(d.text || d.content || '').slice(0, 120)}`);
    }
    parts.push('');
  }

  // Watchpoints
  parts.push(`## 👁️ Watchpoints`);
  const wp = [];
  if (risk >= 1) wp.push('Surveiller les contradictions soulevées ci-dessus avant de t\'engager.');
  if (past.length) wp.push('Comparer avec les décisions passées — qu\'est-ce qui a changé depuis ?');
  if (!past.length) wp.push('Aucun précédent en mémoire — c\'est un terrain nouveau.');
  wp.push('Logguer cette décision (`decision` tool) une fois prise pour traçabilité.');
  parts.push(wp.map(w => `- ${w}`).join('\n'));

  _logEvent('brain_advise', { decision: decision.slice(0,80), verdict, risk });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_now ───────────────
// "Que faire MAINTENANT" — multi-facteur : énergie + deadlines + momentum + dépendances
server.registerTool('brain_now', {
  title: '⚡ Que faire maintenant (multi-facteur)',
  description: "Recommande quoi faire dans le créneau actuel. Combine : créneau d'énergie (heure du jour), deadlines, momentum repos, dépendances, effort vs temps dispo. Renvoie 3 candidats classés avec rationale.",
  inputSchema: {
    minutes: z.number().int().min(5).max(480).optional().describe("Temps dispo en minutes. Default: 60"),
  },
}, async (args) => {
  const minutes = args.minutes ?? 60;
  const { energy, greet } = _gbHourLabel();

  const [data, imp, goals, timelog] = await Promise.all([
    loadData(),
    cachedImprovements(),
    readJson(GOALS_PATH, []),
    _readEvents({ since_days: 14 }).catch(() => []),
  ]);

  const now = Date.now();
  const open = imp.filter(i => !i.done);

  // Mapping effort → minutes
  const effortMin = { xs: 15, s: 30, m: 90, l: 240, xl: 480 };

  // Momentum par repo
  const repoMomentum = {};
  for (const r of data.repos) {
    const age = (now - new Date(r.last_pushed).getTime()) / 86400000;
    repoMomentum[r.name] = age < 1 ? 2 : age < 3 ? 1.5 : age < 7 ? 1 : age < 21 ? 0.5 : 0.2;
  }

  // Deadline pressure par improvement (via goals du même repo)
  const deadlinePressure = {};
  for (const g of goals) {
    if (g.done || !g.deadline || !g.repo) continue;
    const d = (new Date(g.deadline).getTime() - now) / 86400000;
    deadlinePressure[g.repo] = Math.max(deadlinePressure[g.repo] || 0, d <= 0 ? 3 : d <= 2 ? 2.5 : d <= 7 ? 1.5 : 1);
  }

  // Filtrer : qui rentre dans le créneau ?
  const fits = open.filter(i => (effortMin[i.effort] || 90) <= minutes * 1.3);

  // Scoring : energy-match × priority × momentum × deadline / effort
  const energyMatchHigh = { critical: 1.3, high: 1.1, medium: 1, low: 0.8 };
  const energyMatchLow  = { critical: 1.2, high: 1, medium: 0.9, low: 1.1 }; // privilégie low pour tâches faciles
  const energyMap = energy === 'high' ? energyMatchHigh : energyMatchLow;

  const scored = fits.map(i => {
    const m = repoMomentum[i.repo] ?? 0.5;
    const dp = deadlinePressure[i.repo] ?? 1;
    const eff = effortMin[i.effort] || 90;
    const pri = PRIORITY_WEIGHT[i.priority] ?? 1;
    const cat = CATEGORY_WEIGHT[i.category] ?? 1;
    const eMatch = energyMap[i.priority] ?? 1;
    const fitBonus = eff <= minutes ? 1.2 : 0.8; // bonus si rentre largement
    const score = (pri * cat * m * dp * eMatch * fitBonus) / Math.sqrt(eff);
    return { ...i, score, effortEst: eff, momentum: m, deadlinePressure: dp };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  if (!scored.length) {
    return { content: [{ type: 'text', text:
      `# ⚡ ${greet} — créneau ${minutes}min\n\n_Aucun improvement ne rentre dans ce créneau (energy: ${energy}).\nPropose un créneau plus long, ou \`quick_note\` pour capturer une idée._`,
    }] };
  }

  const parts = [`# ⚡ Maintenant — ${minutes}min, énergie ${energy}`, ''];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const rank = ['🥇', '🥈', '🥉'][i];
    parts.push(`## ${rank} **[${s.repo}]** ${escapeMd(s.title)}`);
    parts.push(`_${s.priority} · ${s.category || '?'} · ~${s.effortEst}min · score ${s.score.toFixed(2)}_`);
    const why = [];
    if (s.momentum >= 1.5)   why.push(`repo chaud (${s.momentum.toFixed(1)}×)`);
    else if (s.momentum < 0.5) why.push(`repo froid — risque de perte de contexte`);
    if (s.deadlinePressure >= 2) why.push(`deadline proche (${s.deadlinePressure.toFixed(1)}×)`);
    if (s.priority === 'critical') why.push(`critical`);
    if (why.length) parts.push(`→ ${why.join(' · ')}`);
    parts.push('');
  }

  // Coup de pouce contextuel
  parts.push(`---`);
  if (energy === 'high') parts.push(`> Énergie haute — attaque le #1 sans hésiter.`);
  else if (energy === 'low') parts.push(`> Énergie basse — si #1 est trop costaud, fais le #2 ou #3.`);

  _logEvent('brain_now', { minutes, energy, top: scored[0]?.title?.slice(0, 60) });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_pack ───────────────
// Context bundle : tout ce qu'il faut savoir pour bosser sur un sujet, en un seul call
server.registerTool('brain_pack', {
  title: '📦 Context pack pour un sujet/repo',
  description: "Assemble en un seul bundle TOUT ce qu'il faut savoir pour bosser sur un sujet : notes pertinentes, décisions passées, improvements ouverts, derniers commits, reflexions, warnings. Plus dense qu'un get_repo_full + search_brain manuels.",
  inputSchema: {
    topic: z.string().describe("Repo ou sujet libre"),
    budget: z.number().int().min(400).max(3000).optional().describe("Budget tokens approx. Default: 1200"),
  },
}, async (args) => {
  const topic = args.topic.trim();
  const budget = args.budget ?? 1200;
  const data = await loadData();

  // Résoudre repo si match exact, sinon recherche libre
  const repo = data.repos.find(r => r.name.toLowerCase() === topic.toLowerCase());

  const [searchR, sats, imp, decisions, events] = await Promise.all([
    _gbCall('search_brain', { query: topic, limit: 6 }),
    cachedSatellites(),
    cachedImprovements(),
    readJson(DECISIONS_PATH, []),
    _readEvents({ since_days: 30 }).catch(() => []),
  ]);

  const tk = new Set(tokenize(topic).map(t => t.toLowerCase()));
  const matchSat = sats.filter(s => {
    const hay = (s.title + ' ' + (s.tags||[]).join(' ') + ' ' + (s.repo||'')).toLowerCase();
    return [...tk].some(t => hay.includes(t));
  }).slice(0, 5);

  const relevantImp = imp.filter(i => !i.done && (
    repo ? i.repo === repo.name : [...tk].some(t => (i.title||'').toLowerCase().includes(t))
  )).sort((a, b) => (PRIORITY_WEIGHT[b.priority] ?? 1) - (PRIORITY_WEIGHT[a.priority] ?? 1)).slice(0, 6);

  const relevantDec = (Array.isArray(decisions) ? decisions : [])
    .filter(d => {
      const t = (d.text || d.content || '').toLowerCase();
      return [...tk].some(tok => t.includes(tok));
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 3);

  const parts = [`# 📦 Pack · ${escapeMd(topic)}`, ''];

  if (repo) {
    const age = Math.round((Date.now() - new Date(repo.last_pushed).getTime()) / 86400000);
    parts.push(`**Repo** : \`${repo.name}\` · push J-${age} · ${repo.language || '?'} · ⭐${repo.stargazers_count || 0}`);
    if (repo.description) parts.push(`_${repo.description}_`);
    parts.push('');
  }

  if (relevantImp.length) {
    parts.push(`## 🔧 Open (${relevantImp.length})`);
    for (const i of relevantImp) {
      parts.push(`- **[${i.priority}]** ${escapeMd(i.title).slice(0, 100)}${i.repo && !repo ? ` _(${i.repo})_` : ''}`);
    }
    parts.push('');
  }

  if (relevantDec.length) {
    parts.push(`## 📜 Décisions passées`);
    for (const d of relevantDec) {
      const when = d.timestamp ? new Date(d.timestamp).toLocaleDateString('fr-FR') : '?';
      parts.push(`- _${when}_ — ${escapeMd(d.text || d.content || '').slice(0, 130)}`);
    }
    parts.push('');
  }

  if (matchSat.length) {
    parts.push(`## 🛰️ Notes liées`);
    for (const s of matchSat) parts.push(`- [[${s.path}]] ${s.title ? `— ${escapeMd(s.title).slice(0, 80)}` : ''}`);
    parts.push('');
  }

  if (searchR.text && !searchR.error) {
    parts.push(`## 🔍 Hits BM25`);
    parts.push(_capTokens(_compact(searchR.text), Math.max(300, budget - 600)));
    parts.push('');
  }

  // Warnings
  const warnings = [];
  if (repo) {
    const age = (Date.now() - new Date(repo.last_pushed).getTime()) / 86400000;
    if (age > 30) warnings.push(`Repo froid depuis ${Math.round(age)}j — contexte potentiellement perdu.`);
  }
  if (relevantImp.filter(i => i.priority === 'critical').length >= 2) {
    warnings.push(`≥2 critical en attente — risque de blocage prioritisé.`);
  }
  if (warnings.length) {
    parts.push(`## ⚠️ Warnings`);
    for (const w of warnings) parts.push(`- ${w}`);
  }

  _logEvent('brain_pack', { topic: topic.slice(0, 60), budget, repo: repo?.name });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_foresee ───────────────
// Anticipation : ce qui va probablement arriver dans les 7 prochains jours
server.registerTool('brain_foresee', {
  title: '🔮 Anticiper les 7 prochains jours',
  description: "Projette : deadlines sur le point de slipper, threads stalled qui vont mourir, contexte qui va se perdre, décisions dues. À appeler en fin de semaine ou avant une période d'absence.",
  inputSchema: {
    horizon_days: z.number().int().min(1).max(30).optional().describe("Default: 7"),
  },
}, async (args) => {
  const H = args.horizon_days ?? 7;
  const [data, imp, goals, sats] = await Promise.all([
    loadData(), cachedImprovements(), readJson(GOALS_PATH, []), cachedSatellites(),
  ]);
  const now = Date.now();

  // Deadlines à risque (deadline dans H jours, et momentum faible OU effort élevé)
  const atRisk = goals.filter(g => !g.done && g.deadline).map(g => {
    const d = (new Date(g.deadline).getTime() - now) / 86400000;
    const repoAge = g.repo ? (() => {
      const r = data.repos.find(x => x.name === g.repo);
      return r ? (now - new Date(r.last_pushed).getTime()) / 86400000 : 999;
    })() : null;
    return { ...g, daysLeft: Math.round(d), repoAge };
  }).filter(g => g.daysLeft <= H && g.daysLeft >= -2)
    .map(g => {
      let riskScore = 0;
      if (g.daysLeft <= 1) riskScore += 3;
      else if (g.daysLeft <= 3) riskScore += 2;
      else riskScore += 1;
      if (g.repoAge !== null && g.repoAge > 14) riskScore += 2;
      if (g.repoAge !== null && g.repoAge > 7)  riskScore += 1;
      return { ...g, riskScore };
    }).sort((a, b) => b.riskScore - a.riskScore);

  // Threads stalled — repos ≥21j avec improvements ouverts
  const dying = data.repos.map(r => ({
    name: r.name, age: Math.round((now - new Date(r.last_pushed).getTime()) / 86400000),
    open: imp.filter(i => !i.done && i.repo === r.name).length,
  })).filter(r => r.age >= 21 && r.age <= 60 && r.open > 0).sort((a, b) => b.open - a.open).slice(0, 5);

  // Cold context — notes pas relues depuis 30j sur des repos chauds
  const hotRepos = new Set(data.repos.filter(r => (now - new Date(r.last_pushed).getTime()) < 14*86400000).map(r => r.name));
  const lostCtx = sats.filter(s => s.repo && hotRepos.has(s.repo) && (now - s.mtime) > 30*86400000).slice(0, 3);

  // Decisions overdue — improvements critical depuis >7j
  const overdueDec = imp.filter(i => !i.done && i.priority === 'critical' && i.created && (now - new Date(i.created).getTime()) > 7*86400000).slice(0, 3);

  const parts = [`# 🔮 Foresight — horizon ${H}j`, ''];

  if (atRisk.length) {
    parts.push(`## ⏰ Deadlines à risque (${atRisk.length})`);
    for (const g of atRisk) {
      const tag = g.daysLeft < 0 ? `J+${-g.daysLeft} retard` : `J-${g.daysLeft}`;
      const ageNote = g.repoAge !== null && g.repoAge > 14 ? ` · repo froid (${Math.round(g.repoAge)}j)` : '';
      parts.push(`- 🔥${g.riskScore} · ${tag} · **${escapeMd(g.title)}**${ageNote}`);
    }
    parts.push('');
  }

  if (dying.length) {
    parts.push(`## 💀 Threads qui meurent`);
    parts.push(`_Repos ≥21j sans push, mais avec todo ouverts._`);
    for (const d of dying) parts.push(`- **${d.name}** : ${d.age}j sans commit, ${d.open} open`);
    parts.push('');
  }

  if (lostCtx.length) {
    parts.push(`## 🌫️ Contexte qui se perd`);
    parts.push(`_Notes pas rouvertes depuis 30j sur des repos encore actifs._`);
    for (const s of lostCtx) parts.push(`- [[${s.path}]] _(${s.repo})_`);
    parts.push('');
  }

  if (overdueDec.length) {
    parts.push(`## ⌛ Décisions overdue`);
    for (const i of overdueDec) {
      const age = Math.round((now - new Date(i.created).getTime()) / 86400000);
      parts.push(`- [${i.repo}] ${escapeMd(i.title).slice(0, 100)} _(${age}j en backlog)_`);
    }
    parts.push('');
  }

  if (!atRisk.length && !dying.length && !lostCtx.length && !overdueDec.length) {
    parts.push(`✨ _Aucun signal d'alerte sur les ${H} prochains jours. La voie est dégagée._`);
  } else {
    parts.push(`---`);
    const top = atRisk[0] || dying[0];
    if (atRisk[0]) parts.push(`> Priorité : **${atRisk[0].title}** (${atRisk[0].daysLeft <= 0 ? 'en retard' : `J-${atRisk[0].daysLeft}`}).`);
    else if (dying[0]) parts.push(`> Réveille **${dying[0].name}** avant qu'il devienne intouchable.`);
  }

  _logEvent('brain_foresee', { horizon: H, atRisk: atRisk.length, dying: dying.length });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_chain ───────────────
// Raisonnement séquentiel : breakdown → exec step-by-step → synthèse
server.registerTool('brain_chain', {
  title: '🔗 Raisonnement séquentiel multi-étapes',
  description: "Pour les questions complexes : je décompose en sous-étapes, j'exécute en séquence (chaque étape utilise l'output de la précédente), et je synthétise. Plus puissant que `understand` qui exécute en parallèle.",
  inputSchema: {
    question: z.string().describe("Question complexe à raisonner pas à pas"),
    max_steps: z.number().int().min(2).max(5).optional().describe("Default: 3"),
  },
}, async (args) => {
  const Q = args.question.trim();
  const maxSteps = args.max_steps ?? 3;
  const data = await loadData();

  // Heuristique de décomposition : détecte les intents principaux
  const lower = Q.toLowerCase();
  const steps = [];

  // Étape 1 : toujours un grounding contextuel (recherche)
  steps.push({ kind: 'ground', tool: 'search_brain', params: { query: Q, limit: 5 }, label: 'Grounding mémoire' });

  // Étape 2 : si la question mentionne un repo connu, charger son contexte
  const repoMention = data.repos.find(r => lower.includes(r.name.toLowerCase()));
  if (repoMention) {
    steps.push({ kind: 'context', tool: 'get_repo_summary', params: { name: repoMention.name }, label: `Contexte ${repoMention.name}` });
  }

  // Étape 3 : détection d'intent
  const wantsContradiction = /contradiction|conflit|incoh/.test(lower);
  const wantsRisk          = /risque|danger|impact|si je/.test(lower);
  const wantsDecide        = /dois-je|devrais-je|choix|opter|décide/.test(lower);
  const wantsExplain       = /pourquoi|comment|explique/.test(lower);

  if (wantsContradiction) steps.push({ kind: 'analyze', tool: 'contradiction_check', params: { concept: Q }, label: 'Contradictions' });
  else if (wantsRisk)     steps.push({ kind: 'analyze', tool: 'what_if', params: { scenario: Q }, label: 'Analyse de risque' });
  else if (wantsDecide)   steps.push({ kind: 'analyze', tool: 'recommend', params: { context: Q }, label: 'Recommandation' });
  else if (wantsExplain)  steps.push({ kind: 'analyze', tool: 'deep_reason', params: { question: Q }, label: 'Raisonnement profond' });
  else                    steps.push({ kind: 'analyze', tool: 'reason', params: { question: Q }, label: 'Raisonnement' });

  // Cap
  const planSteps = steps.slice(0, maxSteps);

  const trace = [];
  let accumulator = '';
  for (let i = 0; i < planSteps.length; i++) {
    const s = planSteps[i];
    // Enrichit les params avec l'accumulator pour les étapes d'analyse
    const enriched = { ...s.params };
    if (s.kind === 'analyze' && accumulator && enriched.question) {
      enriched.question = `${Q}\n\n[Contexte préalable]:\n${accumulator.slice(0, 500)}`;
    }
    const r = await _gbCall(s.tool, enriched);
    const text = r.error ? `❌ ${r.error}` : _capTokens(_compact(r.text || ''), 500);
    trace.push({ step: i + 1, label: s.label, tool: s.tool, output: text });
    accumulator += `\n\n[${s.label}]\n${text}`;
  }

  // Synthèse finale : un dernier deep_reason sur le tout
  const synthR = await _gbCall('reason', {
    question: `Synthétise une réponse claire à : "${Q}"\n\nÉvidences collectées :${accumulator.slice(0, 1500)}`,
  });

  const parts = [`# 🔗 Chain reasoning · "${escapeMd(Q).slice(0, 80)}"`, ''];
  for (const t of trace) {
    parts.push(`## ${t.step}. ${t.label} _(\`${t.tool}\`)_`);
    parts.push(t.output);
    parts.push('');
  }
  parts.push(`## ✨ Synthèse`);
  parts.push(synthR.error ? `_Synthèse échouée : ${synthR.error}_` : (_capTokens(_compact(synthR.text || ''), 700)));

  _logEvent('brain_chain', { q: Q.slice(0, 80), steps: trace.length });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_critic ───────────────
// Avocat du diable : attaque adversariale d'un plan/note
server.registerTool('brain_critic', {
  title: '😈 Avocat du diable (revue adversariale)',
  description: "Soumets un plan/idée/note ; je l'attaque depuis tous les angles : faiblesses, suppositions cachées, contradictions avec la mémoire, alternatives ignorées. Utile AVANT d'engager un effort.",
  inputSchema: {
    proposal: z.string().describe("Le plan/idée à critiquer"),
  },
}, async (args) => {
  const P = args.proposal.trim();
  const [contraR, searchR, reasonR] = await Promise.all([
    _gbCall('contradiction_check', { concept: P }),
    _gbCall('search_brain', { query: P, limit: 5 }),
    _gbCall('reason', { question: `Joue l'avocat du diable contre cette proposition : ${P}. Liste : (1) suppositions cachées, (2) faiblesses, (3) alternatives ignorées, (4) ce qui pourrait mal tourner.` }),
  ]);

  const parts = [
    `# 😈 Revue adversariale`,
    ``,
    `**Proposition** : ${escapeMd(P)}`,
    ``,
    `## ⚔️ Attaque`,
    reasonR.error ? `_${reasonR.error}_` : _capTokens(_compact(reasonR.text || ''), 1000),
    ``,
  ];

  if (contraR.text && !contraR.error && contraR.text.trim().length > 30) {
    parts.push(`## 🔀 Contradictions en mémoire`);
    parts.push(_gbExtractLines(contraR.text, 5).join('\n'));
    parts.push('');
  }

  if (searchR.text && !searchR.error) {
    parts.push(`## 📚 Évidences pour/contre`);
    parts.push(_capTokens(_compact(searchR.text || ''), 400));
  }

  _logEvent('brain_critic', { p: P.slice(0, 80) });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_momentum ───────────────
// Intelligence comportementale : énergie, momentum, stalled, productivité
server.registerTool('brain_momentum', {
  title: '📈 Intelligence comportementale (momentum & patterns)',
  description: "Analyse les patterns : créneaux productifs, repos hot/cold, threads stalled, vélocité, temps moyen pour clôturer. À appeler 1x par semaine.",
  inputSchema: {
    days: z.number().int().min(7).max(180).optional().describe("Default: 30"),
  },
}, async (args) => {
  const days = args.days ?? 30;
  const [data, imp, timelog, events] = await Promise.all([
    loadData(), cachedImprovements(),
    _readEvents({ since_days: days }).catch(() => []),
    _readEvents({ since_days: days }).catch(() => []),
  ]);
  const now = Date.now();

  // Hot/cold repos
  const repoStats = data.repos.map(r => {
    const age = (now - new Date(r.last_pushed).getTime()) / 86400000;
    const openImp = imp.filter(i => !i.done && i.repo === r.name).length;
    const doneImp = imp.filter(i => i.done && i.repo === r.name).length;
    return { name: r.name, age, openImp, doneImp, velocity: doneImp / Math.max(1, age) };
  });
  const hot = repoStats.filter(r => r.age < 7).sort((a, b) => b.velocity - a.velocity).slice(0, 5);
  const cold = repoStats.filter(r => r.age > 30 && r.openImp > 0).sort((a, b) => b.age - a.age).slice(0, 5);

  // Hour-of-day distribution des events (créneaux productifs)
  const hourCount = new Array(24).fill(0);
  for (const e of events) {
    if (!e.t) continue;
    const h = new Date(e.t).getHours();
    hourCount[h]++;
  }
  const peakHours = hourCount.map((c, h) => ({ h, c })).sort((a, b) => b.c - a.c).slice(0, 3);

  // Time-to-close moyen (créés vs done)
  const closed = imp.filter(i => i.done && i.created && i.completed);
  const closeTimes = closed.map(i => (new Date(i.completed).getTime() - new Date(i.created).getTime()) / 86400000).filter(d => d >= 0 && d < 365);
  const avgClose = closeTimes.length ? (closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length) : null;

  // Velocity totale
  const recentDone = imp.filter(i => i.done && i.completed && (now - new Date(i.completed).getTime()) / 86400000 <= days).length;
  const velocity = recentDone / days;

  const parts = [`# 📈 Momentum — ${days}j`, ''];

  parts.push(`## 🚀 Vélocité`);
  parts.push(`- **${recentDone}** improvements clôturés (${velocity.toFixed(2)}/jour)`);
  if (avgClose !== null) parts.push(`- Temps moyen pour clôturer : **${avgClose.toFixed(1)}j**`);
  parts.push('');

  if (peakHours[0]?.c > 0) {
    parts.push(`## ⏱️ Créneaux productifs (top)`);
    const fmt = h => `${String(h).padStart(2,'0')}h`;
    parts.push(peakHours.map(p => `- ${fmt(p.h)}–${fmt((p.h+1)%24)} · ${p.c} events`).join('\n'));
    parts.push('');
  }

  if (hot.length) {
    parts.push(`## 🔥 Repos chauds`);
    for (const r of hot) parts.push(`- **${r.name}** · ${r.openImp} open · ${r.doneImp} done · v=${r.velocity.toFixed(2)}`);
    parts.push('');
  }

  if (cold.length) {
    parts.push(`## ❄️ Repos qui refroidissent`);
    parts.push(`_>30j sans push mais todo ouverts._`);
    for (const r of cold) parts.push(`- **${r.name}** · ${Math.round(r.age)}j · ${r.openImp} open en attente`);
    parts.push('');
  }

  parts.push(`---`);
  if (peakHours[0]?.c > 0) parts.push(`> Ton créneau le plus productif : ${peakHours[0].h}h. Bloque-le.`);
  if (cold.length) parts.push(`> ${cold[0].name} dort depuis ${Math.round(cold[0].age)}j — décider : réveille ou archive.`);

  _logEvent('brain_momentum', { days, velocity, hot: hot.length, cold: cold.length });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_synthesize ───────────────
// Multi-source synthesis sur un topic : tout ce que le brain sait, narrativisé
server.registerTool('brain_synthesize', {
  title: '🧬 Synthèse multi-source sur un topic',
  description: "Combine notes, décisions, improvements, commits, reflexions pour produire UNE narration cohérente sur un sujet. Plus narratif que `brain_pack` (qui est structuré).",
  inputSchema: {
    topic: z.string(),
    angle: z.enum(['état', 'évolution', 'décisions', 'risques']).optional().describe("Angle de la synthèse. Default: état"),
  },
}, async (args) => {
  const topic = args.topic.trim();
  const angle = args.angle ?? 'état';

  const [searchR, decisions, sats, imp] = await Promise.all([
    _gbCall('search_brain', { query: topic, limit: 8 }),
    readJson(DECISIONS_PATH, []),
    cachedSatellites(),
    cachedImprovements(),
  ]);
  const tk = new Set(tokenize(topic).map(t => t.toLowerCase()));

  const relevantDec = (Array.isArray(decisions) ? decisions : [])
    .filter(d => [...tk].some(t => (d.text || d.content || '').toLowerCase().includes(t)))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 8);

  const relevantImp = imp.filter(i => [...tk].some(t => (i.title||'').toLowerCase().includes(t))).slice(0, 8);

  // Construire le contexte pour le reasoner
  let evidenceText = '';
  if (searchR.text && !searchR.error) evidenceText += `\n[NOTES]\n${searchR.text.slice(0, 1200)}`;
  if (relevantDec.length) {
    evidenceText += `\n[DÉCISIONS]\n` + relevantDec.map(d => `- ${new Date(d.timestamp || 0).toLocaleDateString('fr-FR')}: ${(d.text || d.content || '').slice(0, 200)}`).join('\n');
  }
  if (relevantImp.length) {
    evidenceText += `\n[IMPROVEMENTS]\n` + relevantImp.map(i => `- [${i.done?'✓':'○'}][${i.priority}] ${(i.title || '').slice(0, 100)}`).join('\n');
  }

  const angleHint = {
    'état':       `Décris l'état ACTUEL de "${topic}" : où on en est, ce qui marche, ce qui bloque.`,
    'évolution':  `Trace l'évolution de "${topic}" dans le temps : décisions clés, virages, leçons apprises.`,
    'décisions':  `Reconstitue le fil des décisions sur "${topic}" : pourquoi, dans quel ordre, conséquences.`,
    'risques':    `Identifie les risques actuels et latents sur "${topic}".`,
  }[angle];

  const synthR = await _gbCall('reason', {
    question: `${angleHint}\n\nÉvidences disponibles :${evidenceText}`,
  });

  const parts = [
    `# 🧬 Synthèse · ${escapeMd(topic)} _(angle: ${angle})_`,
    ``,
    synthR.error ? `_Erreur : ${synthR.error}_` : _capTokens(_compact(synthR.text || ''), 1500),
    ``,
    `---`,
    `_Sources : ${relevantDec.length} décisions · ${relevantImp.length} improvements · ${(searchR.text||'').split('\n').filter(l=>l.startsWith('-')).length || '?'} hits notes_`,
  ];

  _logEvent('brain_synthesize', { topic: topic.slice(0, 60), angle });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_explain ───────────────
// "Dis-moi tout ce que tu sais sur X"
server.registerTool('brain_explain', {
  title: '🎓 Tout ce que je sais sur X',
  description: "Donne-moi un sujet, je te raconte tout ce que la mémoire contient à son propos : définition contextuelle, repos où il apparaît, décisions liées, état actuel, notes pertinentes. Excellent pour reprendre du contexte sur un sujet froid.",
  inputSchema: { x: z.string() },
}, async (args) => {
  const x = args.x.trim();
  const data = await loadData();

  // Match repo direct ?
  const repo = data.repos.find(r => r.name.toLowerCase() === x.toLowerCase());

  const [searchR, conceptR, recallR] = await Promise.all([
    _gbCall('search_brain', { query: x, limit: 6 }),
    _gbCall('concept_search', { query: x }),
    _gbCall('recall_thread', { topic: x }),
  ]);

  const parts = [`# 🎓 ${escapeMd(x)}`, ''];

  if (repo) {
    const age = Math.round((Date.now() - new Date(repo.last_pushed).getTime()) / 86400000);
    parts.push(`## 📦 En tant que repo`);
    parts.push(`- ${repo.description || '_(pas de description)_'}`);
    parts.push(`- Langue : ${repo.language || '?'} · ⭐${repo.stargazers_count || 0} · push J-${age}`);
    if (repo.topics?.length) parts.push(`- Topics : ${repo.topics.join(', ')}`);
    parts.push('');
  }

  if (recallR.text && !recallR.error) {
    parts.push(`## 🧵 Fil mémoriel`);
    parts.push(_capTokens(_compact(recallR.text), 700));
    parts.push('');
  }

  if (conceptR.text && !conceptR.error) {
    parts.push(`## 💡 Concept`);
    parts.push(_capTokens(_compact(conceptR.text), 600));
    parts.push('');
  }

  if (searchR.text && !searchR.error) {
    parts.push(`## 🔍 Mentions`);
    parts.push(_capTokens(_compact(searchR.text), 500));
  }

  _logEvent('brain_explain', { x: x.slice(0, 60) });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_resolve ───────────────
// Résolution de contradiction
server.registerTool('brain_resolve', {
  title: '⚖️ Résoudre une contradiction',
  description: "Détecte les contradictions dans la mémoire sur un sujet, les pèse (récence, source, fréquence), et propose une synthèse résolue OU une question clarifiante.",
  inputSchema: { topic: z.string() },
}, async (args) => {
  const t = args.topic.trim();
  const [contraR, decisions] = await Promise.all([
    _gbCall('contradiction_check', { concept: t }),
    readJson(DECISIONS_PATH, []),
  ]);

  const tk = new Set(tokenize(t).map(x => x.toLowerCase()));
  const recentRelevant = (Array.isArray(decisions) ? decisions : [])
    .filter(d => [...tk].some(tok => (d.text || d.content || '').toLowerCase().includes(tok)))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 5);

  if (!contraR.text || contraR.error || contraR.text.trim().length < 30) {
    return { content: [{ type: 'text', text:
      `# ⚖️ Résolution · ${escapeMd(t)}\n\n_Aucune contradiction détectée. Mémoire cohérente sur ce sujet._`,
    }] };
  }

  const synthR = await _gbCall('reason', {
    question: `Voici des contradictions détectées en mémoire sur "${t}" :\n${contraR.text}\n\nDécisions récentes :\n${recentRelevant.map(d => `- ${new Date(d.timestamp||0).toLocaleDateString('fr-FR')}: ${(d.text||d.content||'').slice(0,150)}`).join('\n')}\n\nPondère par récence, propose une synthèse résolue, ou si impossible, formule la question clarifiante à se poser.`,
  });

  const parts = [
    `# ⚖️ Résolution · ${escapeMd(t)}`,
    ``,
    `## 🔀 Contradictions détectées`,
    _capTokens(_compact(contraR.text), 500),
    ``,
    `## ✨ Résolution proposée`,
    synthR.error ? `_${synthR.error}_` : _capTokens(_compact(synthR.text || ''), 800),
  ];

  if (recentRelevant.length) {
    parts.push(``, `## 📜 Décisions récentes prises en compte`);
    for (const d of recentRelevant.slice(0, 3)) {
      parts.push(`- _${new Date(d.timestamp||0).toLocaleDateString('fr-FR')}_ — ${escapeMd(d.text || d.content || '').slice(0, 130)}`);
    }
  }

  _logEvent('brain_resolve', { t: t.slice(0, 60) });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_orchestrate ───────────────
// Meta : planifie un workflow d'outils pour atteindre un objectif, l'exécute, rapporte
server.registerTool('brain_orchestrate', {
  title: '🎼 Orchestrer un workflow vers un objectif',
  description: "Donne-moi un objectif en langage naturel ; je planifie une séquence de 2-4 opérations du brain, je les exécute, et je rapporte. Plus puissant que `understand` car objectif-driven et non keyword-driven.",
  inputSchema: {
    goal: z.string().describe("Objectif à atteindre"),
    dry_run: z.boolean().optional().describe("Si true : montre le plan sans exécuter. Default: false"),
  },
}, async (args) => {
  const goal = args.goal.trim();
  const dryRun = args.dry_run ?? false;
  const lower = goal.toLowerCase();

  // Planification : map objectif → workflow
  const plan = [];
  if (/brief|matin|reprise|où.{0,4}j.en|situation/.test(lower)) {
    plan.push({ tool: 'brain_brief', params: { depth: 'full' }, why: 'Situation report' });
  } else if (/anticiper|prévoir|semaine.*venir|7.*jours/.test(lower)) {
    plan.push({ tool: 'brain_foresee', params: {}, why: 'Anticipation 7j' });
  } else if (/maintenant|là|tout de suite|prochaine action/.test(lower)) {
    plan.push({ tool: 'brain_now', params: {}, why: 'Action immédiate' });
  } else if (/décide|décision|stress.test|évalu/.test(lower)) {
    plan.push({ tool: 'brain_advise', params: { decision: goal }, why: 'Stress-test décision' });
    plan.push({ tool: 'brain_critic', params: { proposal: goal }, why: 'Revue adversariale' });
  } else if (/comprend|explique|tout sur/.test(lower)) {
    const subject = goal.replace(/(comprendre|expliquer|tout sur|dis-moi)/gi, '').trim();
    plan.push({ tool: 'brain_explain', params: { x: subject || goal }, why: 'Briefing sujet' });
  } else if (/pattern|momentum|productiv|vélocité|stalled/.test(lower)) {
    plan.push({ tool: 'brain_momentum', params: {}, why: 'Analyse comportementale' });
  } else if (/pack|contexte|bundle/.test(lower)) {
    const subject = goal.replace(/(pack|contexte|bundle|sur)/gi, '').trim();
    plan.push({ tool: 'brain_pack', params: { topic: subject || goal }, why: 'Context pack' });
  } else if (/contradiction|conflit|incohér/.test(lower)) {
    plan.push({ tool: 'brain_resolve', params: { topic: goal }, why: 'Résolution contradiction' });
  } else {
    // Default : chain reasoning
    plan.push({ tool: 'brain_chain', params: { question: goal }, why: 'Raisonnement multi-étapes' });
  }

  if (dryRun) {
    return { content: [{ type: 'text', text:
      `# 🎼 Plan (dry-run)\n\n**Objectif** : ${escapeMd(goal)}\n\n` +
      plan.map((p, i) => `${i+1}. \`${p.tool}\` — ${p.why}`).join('\n'),
    }] };
  }

  const results = [];
  for (const step of plan) {
    const r = await _gbCall(step.tool, step.params);
    results.push({ ...step, text: r.error ? `❌ ${r.error}` : r.text });
  }

  const parts = [`# 🎼 Orchestration · "${escapeMd(goal).slice(0, 80)}"`, ''];
  if (results.length === 1) {
    parts.push(results[0].text || '_(vide)_');
  } else {
    for (const r of results) {
      parts.push(`## ${r.why} _(\`${r.tool}\`)_`);
      parts.push(_capTokens(_compact(r.text || ''), 800));
      parts.push('');
    }
  }

  _logEvent('brain_orchestrate', { goal: goal.slice(0, 80), steps: plan.length });
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

// ─────────────── brain_speak ───────────────
// Renderer de voix narrative — transforme données brutes en prose Jarvis-style
server.registerTool('brain_speak', {
  title: '🗣️ Reformuler en voix narrative',
  description: "Prends n'importe quel output brut (ou un sujet) et reformule en prose narrative concise, anticipative, sans bullet-points. Style 'briefing de chef de cabinet'.",
  inputSchema: {
    content: z.string().describe("Texte ou sujet à narrer"),
    tone: z.enum(['neutre', 'urgent', 'détendu', 'analytique']).optional().describe("Default: neutre"),
  },
}, async (args) => {
  const c = args.content.trim();
  const tone = args.tone ?? 'neutre';
  const toneHint = {
    'neutre':     'ton neutre et professionnel',
    'urgent':     'ton direct, mets en avant ce qui presse',
    'détendu':    'ton conversationnel, comme à un collègue après le café',
    'analytique': 'ton analytique, structure ta pensée explicitement',
  }[tone];
  const r = await _gbCall('reason', {
    question: `Reformule en 1-3 paragraphes (${toneHint}, pas de bullet points, pas de markdown lourd, prose fluide). Anticipe la prochaine question de l'utilisateur en dernière phrase.\n\nContenu :\n${c}`,
  });
  return { content: [{ type: 'text', text: r.error ? `❌ ${r.error}` : (r.text || '_(vide)_') }] };
});

// ═════════════════════════════════════════════════════════════════════
// END v14 Cognitive Synthesis Layer
// ═════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════
// ════════ AUTO-SYNC LAYER v14.1 — gb_* tools ═══════════════════════
//
// Résout le decalage entre les sessions Claude et la mémoire du brain :
// - gb_session_ingest : digère _brain/events.jsonl en satellite notes + decisions
// - gb_push / gb_pull : git ops sur le vault GalacticBrain/
// - gb_sync           : ingest + push en un appel
// - gb_diff_since_last_session : ce qui a changé depuis le dernier handoff
// ═════════════════════════════════════════════════════════════════════

import { spawn as _gbSpawn } from 'node:child_process';

function _gbExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || path.join(VAULT_PATH, 'GalacticBrain');
    const child = _gbSpawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    child.on('error', e => resolve({ code: -1, out: '', err: e.message }));
  });
}

// ─────────────── gb_session_ingest ───────────────
server.registerTool('gb_session_ingest', {
  title: '🍽️ Digère le session log en satellite notes + décisions',
  description: "Lit _brain/events.jsonl (alimenté par les hooks Claude Code), regroupe les events par session, et matérialise : (1) une satellite note de session par jour si ≥3 fichiers touchés, (2) une décision pour chaque session_stop avec ≥10 actions. Idempotent grâce à un marker `last_ingest_t`.",
  inputSchema: {
    since_hours: z.number().int().min(1).max(168).optional().describe('Fenêtre. Default: 24'),
    dry_run: z.boolean().optional().describe('Si true, montre ce qui serait créé sans écrire'),
  },
}, async (args) => {
  const since = args.since_hours ?? 24;
  const dry = args.dry_run ?? false;

  const eventsPath = path.join(VAULT_PATH, 'GalacticBrain', '_brain', 'events.jsonl');
  let lines = [];
  try {
    const txt = await fs.readFile(eventsPath, 'utf8');
    lines = txt.split('\n').filter(Boolean);
  } catch {
    return { content: [{ type: 'text', text: `_(aucun events.jsonl — les hooks Claude Code ne sont peut-être pas activés)_` }] };
  }

  // Marker idempotence
  const markerPath = path.join(VAULT_PATH, 'GalacticBrain', '_brain', 'last_ingest.json');
  let lastIngestT = 0;
  try {
    const m = await fs.readFile(markerPath, 'utf8');
    lastIngestT = JSON.parse(m).t || 0;
  } catch { /* first run */ }

  const cutoff = Math.max(lastIngestT, Date.now() - since * 3600 * 1000);
  const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.t > cutoff);

  // Group by session
  const sessions = {};
  for (const e of events) {
    const sid = e.session || 'unknown';
    if (!sessions[sid]) sessions[sid] = { events: [], start: e.t, end: e.t, files: new Set(), tools: {} };
    sessions[sid].events.push(e);
    sessions[sid].start = Math.min(sessions[sid].start, e.t);
    sessions[sid].end = Math.max(sessions[sid].end, e.t);
    if (e.type === 'file_change' && e.path) sessions[sid].files.add(e.path);
    if (e.tool) sessions[sid].tools[e.tool] = (sessions[sid].tools[e.tool] || 0) + 1;
  }

  const created = { satellites: [], decisions: [] };

  for (const [sid, s] of Object.entries(sessions)) {
    const filesArr = [...s.files];
    if (filesArr.length < 3) continue; // ignore sessions courtes

    // Détecte le repo (heuristique : le path le plus fréquent)
    const repoGuess = (() => {
      const counts = {};
      for (const f of filesArr) {
        const m = f.match(/[\\\/]([^\\\/]+)[\\\/]/g);
        if (m && m.length) {
          // prend le 2e segment (souvent le nom du repo)
          const parts = f.replace(/\\/g, '/').split('/');
          const idx = parts.findIndex(p => p === 'www' || p === 'GitHub' || p === 'Downloads');
          const repoName = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
          if (repoName) counts[repoName] = (counts[repoName] || 0) + 1;
        }
      }
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'misc';
    })();

    const dateStr = new Date(s.start).toISOString().slice(0, 10);
    const sessionLabel = sid.slice(0, 8);
    const notePath = `GalacticBrain/_claude/${repoGuess}/${dateStr}-session-auto-${sessionLabel}.md`;
    const duration = Math.round((s.end - s.start) / 60000);

    const body = `---
parent_repo: ${repoGuess}
kind: session
created: "${new Date(s.start).toISOString()}"
ended: "${new Date(s.end).toISOString()}"
session_id: "${sid}"
auto: true
tags: ["claude", "session", "auto", "repo/${repoGuess}"]
---

# Session ${dateStr} — ${repoGuess} (${duration} min)

**Session ID** : \`${sid}\`
**Durée** : ${duration} min
**Tool calls** : ${s.events.length}
**Fichiers touchés** : ${filesArr.length}

## Fichiers
${filesArr.slice(0, 20).map(f => `- \`${f.replace(/\\/g, '/')}\``).join('\n')}${filesArr.length > 20 ? `\n_(+${filesArr.length - 20} autres)_` : ''}

## Tools utilisés
${Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => `- ${t} ×${n}`).join('\n')}

_Note auto-générée par \`gb_session_ingest\` v14.1._
`;

    created.satellites.push({ path: notePath, repo: repoGuess, files: filesArr.length });

    if (!dry) {
      try { await writeNote(notePath, body); } catch (e) { /* skip */ }
    }

    // Décision automatique si session significative (≥10 actions OU ≥5 fichiers)
    if (s.events.length >= 10 || filesArr.length >= 5) {
      const decText = `Session auto ${dateStr} sur ${repoGuess} : ${filesArr.length} fichiers, ${s.events.length} actions, ${duration} min`;
      created.decisions.push(decText);
      if (!dry) {
        try {
          const decPath = 'GalacticBrain/_decisions.jsonl';
          const existing = await readNote(decPath).catch(() => '') || '';
          await writeNote(decPath, existing + JSON.stringify({
            timestamp: s.end,
            text: decText,
            auto: true,
            session_id: sid,
            repo: repoGuess,
          }) + '\n');
        } catch { /* skip */ }
      }
    }
  }

  if (!dry) {
    try {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, JSON.stringify({ t: Date.now(), processed_events: events.length }), 'utf8');
    } catch { /* skip */ }
  }

  _logEvent('gb_session_ingest', {
    since_hours: since,
    events_processed: events.length,
    sessions: Object.keys(sessions).length,
    satellites_created: created.satellites.length,
    decisions_created: created.decisions.length,
    dry,
  });

  return { content: [{ type: 'text', text:
    `# 🍽️ Ingest${dry ? ' (dry-run)' : ''}\n\n` +
    `- Events analysés : **${events.length}** sur ${since}h\n` +
    `- Sessions distinctes : **${Object.keys(sessions).length}**\n` +
    `- Satellites créés : **${created.satellites.length}**\n` +
    `- Décisions créées : **${created.decisions.length}**\n\n` +
    (created.satellites.length ? `## Satellites\n${created.satellites.map(s => `- \`${s.path}\` (${s.files} fichiers)`).join('\n')}\n\n` : '') +
    (created.decisions.length ? `## Décisions\n${created.decisions.map(d => `- ${d}`).join('\n')}\n` : '')
  }] };
});

// ─────────────── gb_push ───────────────
server.registerTool('gb_push', {
  title: '📤 git push du vault GalacticBrain/',
  description: "Stage tous les changements du vault, commit avec un message auto, et push vers le remote configuré. No-op si rien à pusher.",
  inputSchema: {
    message: z.string().optional().describe('Message de commit custom. Default: auto-sync horodaté'),
  },
}, async (args) => {
  const status = await _gbExec('git', ['status', '--porcelain']);
  if (status.code !== 0) return { content: [{ type: 'text', text: `❌ git status: ${status.err}` }], isError: true };
  if (!status.out.trim()) return { content: [{ type: 'text', text: `✓ no-op (vault clean)` }] };

  const nbFiles = status.out.split('\n').length;
  const msg = args.message || `gb_push ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${nbFiles} file(s)`;

  const add = await _gbExec('git', ['add', '-A']);
  if (add.code !== 0) return { content: [{ type: 'text', text: `❌ git add: ${add.err}` }], isError: true };

  const commit = await _gbExec('git', ['commit', '-m', msg]);
  if (commit.code !== 0) return { content: [{ type: 'text', text: `❌ git commit: ${commit.err}` }], isError: true };

  const remote = await _gbExec('git', ['remote']);
  if (!remote.out.trim()) return { content: [{ type: 'text', text: `✓ commit OK (${nbFiles} fichiers), mais pas de remote — push skip\n\n_Configure un remote pour activer l'auto-sync GitHub._` }] };

  const push = await _gbExec('git', ['push']);
  if (push.code !== 0) return { content: [{ type: 'text', text: `⚠️ commit OK mais push échoué :\n${push.err}` }] };

  _logEvent('gb_push', { nb_files: nbFiles, msg });
  return { content: [{ type: 'text', text: `✓ Push OK — ${nbFiles} fichier(s)\n\`${msg}\`` }] };
});

// ─────────────── gb_pull ───────────────
server.registerTool('gb_pull', {
  title: '📥 git pull du vault',
  description: "Récupère les changements distants (utile en multi-machine). À appeler au début d'une session si tu as travaillé sur une autre machine.",
  inputSchema: {},
}, async () => {
  const remote = await _gbExec('git', ['remote']);
  if (!remote.out.trim()) return { content: [{ type: 'text', text: `❌ Pas de remote configuré` }], isError: true };

  const pull = await _gbExec('git', ['pull', '--ff-only']);
  if (pull.code !== 0) {
    return { content: [{ type: 'text', text: `⚠️ pull échoué (peut-être conflit) :\n${pull.err}\n\nManuel : \`cd \"${path.join(VAULT_PATH, 'GalacticBrain')}\" && git pull\`` }] };
  }
  _logEvent('gb_pull', {});
  return { content: [{ type: 'text', text: `✓ Pull OK\n${pull.out || '_(déjà à jour)_'}` }] };
});

// ─────────────── gb_sync ───────────────
server.registerTool('gb_sync', {
  title: '🔁 Sync complet : ingest + push',
  description: "Méta : enchaîne `gb_session_ingest` (digère le log session) puis `gb_push` (commit + push). À appeler en fin de journée ou avant de fermer Claude.",
  inputSchema: {},
}, async () => {
  const ingestR = await _gbCall('gb_session_ingest', {});
  const pushR = await _gbCall('gb_push', {});
  return { content: [{ type: 'text', text:
    `# 🔁 Sync complet\n\n` +
    `## 1. Ingest\n${ingestR.text || ingestR.error || '_(vide)_'}\n\n` +
    `## 2. Push\n${pushR.text || pushR.error || '_(vide)_'}\n`,
  }] };
});

// ─────────────── gb_diff_since_last_session ───────────────
server.registerTool('gb_diff_since_last_session', {
  title: '📊 Ce qui a changé depuis le dernier handoff',
  description: "Compare l'état actuel (commits, fichiers, events) avec le dernier handoff. À appeler en début de session pour reprendre informé.",
  inputSchema: {},
}, async () => {
  const handoff = await readJson(HANDOFF_PATH, null);
  if (!handoff) return { content: [{ type: 'text', text: `_(aucun handoff précédent)_` }] };

  const since = new Date(handoff.saved_at).getTime();
  const now = Date.now();
  const hoursAgo = Math.round((now - since) / 3600000);

  // git log depuis
  const log = await _gbExec('git', ['log', `--since=${handoff.saved_at}`, '--oneline']);
  const commits = log.out.split('\n').filter(Boolean);

  // events depuis
  let events = [];
  try {
    const eventsPath = path.join(VAULT_PATH, 'GalacticBrain', '_brain', 'events.jsonl');
    const txt = await fs.readFile(eventsPath, 'utf8');
    events = txt.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.t > since);
  } catch { /* ignore */ }

  const filesChanged = [...new Set(events.filter(e => e.type === 'file_change').map(e => e.path).filter(Boolean))];

  return { content: [{ type: 'text', text:
    `# 📊 Depuis ${hoursAgo}h\n\n` +
    `**Handoff précédent** : ${handoff.context}\n` +
    (handoff.next ? `**Next prévu** : ${handoff.next}\n` : '') +
    `\n` +
    `**Commits depuis** : ${commits.length}\n` +
    (commits.length ? commits.slice(0, 8).map(c => `- ${c}`).join('\n') + '\n' : '') +
    `\n**Events Claude** : ${events.length}\n` +
    `**Fichiers touchés** : ${filesChanged.length}\n` +
    (filesChanged.length ? filesChanged.slice(0, 10).map(f => `- \`${f.replace(/\\/g, '/').split('/').slice(-2).join('/')}\``).join('\n') : ''),
  }] };
});

// ═════════════════════════════════════════════════════════════════════
// END v14.1 Auto-Sync Layer
// ═════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Préchauffe l'index pour bootstrap instantané
  persistIndex().then(n => console.error(`   Index préchargé : ${n} chunks`)).catch(() => {});
  console.error(`🌌 Galactic Brain MCP v${VERSION} — v5..v14.1 (intel + predictive + persistent + omniscient + cohesive + operational + reasoning + adaptive + cognitive + conversational + multi-tool + synthesis + auto-sync)`);
  console.error(`   Vault : ${VAULT_RESOLVED}`);
  console.error(`   Tools : 114 · v14 ajoute (cognitive synthesis) : brain_brief, brain_advise, brain_now, brain_pack, brain_foresee, brain_chain, brain_critic, brain_momentum, brain_synthesize, brain_explain, brain_resolve, brain_orchestrate, brain_speak`);
  console.error(`   v14.1 ajoute (auto-sync) : gb_session_ingest, gb_push, gb_pull, gb_sync, gb_diff_since_last_session — vault git-versionné + hooks Claude Code + Task Scheduler 30 min`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});