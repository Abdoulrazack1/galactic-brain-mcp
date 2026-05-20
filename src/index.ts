#!/usr/bin/env node
/**
 * Galactic Brain MCP Server v2
 *
 * Token-efficient RAG that lets Claude be smarter about your projects
 * WITHOUT loading entire notes into context every time.
 *
 * Strategy to minimize tokens:
 *
 *   1. Tools return TARGETED chunks, not entire files
 *   2. Search returns ranked snippets (~150 chars each), not full notes
 *   3. user_summary is the cheap entry point (always start here)
 *   4. get_repo_summary is a lightweight repo card — get_repo (full) only on demand
 *   5. Notes are split by ## sections so Claude can ask for one section at a time
 *   6. Inverted-index built on first call, cached in memory
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

interface MCPExportData {
  generated_at: string;
  github_username: string;
  user_summary: {
    total_repos: number;
    total_stars: number;
    languages_count: number;
    most_used_language: string;
    most_active_repo: string;
  };
  repos: Array<{
    id: number;
    name: string;
    description: string;
    language: string | null;
    topics: string[];
    stars: number;
    url: string;
    last_pushed: string;
    note_path: string;
  }>;
  stack: Array<{
    name: string;
    category: string;
    count: number;
    repoIds: number[];
    color: number;
    icon: string;
  }>;
  topic_constellations: Array<{ topic: string; repo_names: string[] }>;
}

// ── Config ────────────────────────────────────────────────
const VAULT_PATH = process.env.GALACTIC_VAULT_PATH || process.argv[2];
const EXPORT_REL = process.env.GALACTIC_EXPORT_REL || 'GalacticBrain/_mcp_export.json';

if (!VAULT_PATH) {
  console.error('❌ Set GALACTIC_VAULT_PATH env var or pass vault path as first arg');
  process.exit(1);
}

const EXPORT_PATH = path.join(VAULT_PATH, EXPORT_REL);

// ── In-memory cache ────────────────────────────────────────
let dataCache: { mtime: number; data: MCPExportData } | null = null;
let indexCache: { mtime: number; index: SearchIndex } | null = null;

interface SearchIndex {
  // Each "chunk" is a small piece of a note that can be searched independently
  chunks: Array<{
    repo: string;
    notePath: string;
    section: string;       // e.g. "🛠️ Stack technique" or "📝 Mes notes"
    text: string;          // raw text, ~500 chars max
    keywords: string[];    // pre-tokenized for fast matching
  }>;
}

async function loadData(): Promise<MCPExportData> {
  try {
    const stat = await fs.stat(EXPORT_PATH);
    if (dataCache && dataCache.mtime === stat.mtimeMs) return dataCache.data;
    const raw = await fs.readFile(EXPORT_PATH, 'utf-8');
    const data = JSON.parse(raw) as MCPExportData;
    dataCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (e) {
    throw new Error(`Cannot read export at ${EXPORT_PATH}: ${(e as Error).message}\nDid you run "Sync" + "🧠 Claude" in Obsidian?`);
  }
}

async function readNote(notePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(VAULT_PATH!, notePath), 'utf-8');
  } catch { return null; }
}

/**
 * Split a Markdown note into sections by ## headings.
 * Returns array of { heading, body } chunks of ~500 chars each.
 */
function splitNote(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const chunks: Array<{ heading: string; body: string }> = [];
  let currentHeading = '_intro';
  let currentBody: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)/);
    if (m) {
      if (currentBody.length > 0) {
        chunks.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      }
      currentHeading = m[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    chunks.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  }
  // Further split big sections (>1500 chars) to keep chunks small
  const out: Array<{ heading: string; body: string }> = [];
  for (const c of chunks) {
    if (c.body.length <= 1500) { out.push(c); continue; }
    const paras = c.body.split(/\n\n+/);
    let buf: string[] = [];
    let len = 0;
    for (const p of paras) {
      if (len + p.length > 1200 && buf.length > 0) {
        out.push({ heading: c.heading, body: buf.join('\n\n') });
        buf = [];
        len = 0;
      }
      buf.push(p);
      len += p.length;
    }
    if (buf.length > 0) out.push({ heading: c.heading, body: buf.join('\n\n') });
  }
  return out;
}

const STOP = new Set(['le','la','les','de','des','un','une','et','ou','à','en','dans','sur','pour','avec','par','que','qui','est','ce','cette','ces','mes','mon','ma','tu','je','il','elle','nous','vous','ils','elles','the','a','an','of','to','in','for','on','with','as','at','by','this','that','is','are','was','were','be','been']);
function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}_\-]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

async function buildIndex(): Promise<SearchIndex> {
  const stat = await fs.stat(EXPORT_PATH);
  if (indexCache && indexCache.mtime === stat.mtimeMs) return indexCache.index;
  const data = await loadData();
  const chunks: SearchIndex['chunks'] = [];
  for (const repo of data.repos) {
    const note = await readNote(repo.note_path);
    if (!note) continue;
    for (const sec of splitNote(note)) {
      const text = sec.body.length > 600 ? sec.body.slice(0, 600) : sec.body;
      chunks.push({
        repo: repo.name,
        notePath: repo.note_path,
        section: sec.heading,
        text,
        keywords: tokenize(text + ' ' + repo.name + ' ' + repo.description),
      });
    }
  }
  const index: SearchIndex = { chunks };
  indexCache = { mtime: stat.mtimeMs, index };
  return index;
}

// ── Search with TF-IDF-like scoring ──────────────────────
async function smartSearch(query: string, limit = 5): Promise<Array<{ repo: string; section: string; score: number; excerpt: string; notePath: string }>> {
  const index = await buildIndex();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Document frequency for IDF
  const df: Record<string, number> = {};
  for (const c of index.chunks) {
    const seen = new Set(c.keywords);
    for (const k of seen) df[k] = (df[k] ?? 0) + 1;
  }
  const N = index.chunks.length || 1;

  const scored = index.chunks.map(c => {
    let score = 0;
    for (const q of queryTokens) {
      const tf = c.keywords.filter(k => k === q || k.includes(q)).length;
      if (tf === 0) continue;
      const idf = Math.log((N + 1) / ((df[q] ?? 0) + 1));
      score += tf * idf;
    }
    // Boost: query word appears verbatim
    const lcText = c.text.toLowerCase();
    for (const q of queryTokens) {
      if (lcText.includes(q)) score += 2;
    }
    return { c, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  return scored.map(({ c, score }) => ({
    repo: c.repo,
    section: c.section,
    score: Math.round(score * 100) / 100,
    notePath: c.notePath,
    excerpt: c.text.length > 280 ? c.text.slice(0, 280) + '…' : c.text,
  }));
}

// ── MCP server ────────────────────────────────────────────
const server = new McpServer({
  name: 'galactic-brain',
  version: '2.0.0',
}, { capabilities: { tools: {} } });

// Tool 1: cheap entry point
server.registerTool('user_summary', {
  title: 'User profile overview',
  description: 'CHEAP. Always call this FIRST when starting to work with the user. Returns headline stats: total repos, top language, most active project. ~50 tokens.',
  inputSchema: {},
}, async () => {
  const data = await loadData();
  const u = data.user_summary;
  const text = `# ${data.github_username}
${u.total_repos} repos · ${u.total_stars}⭐ · top: **${u.most_used_language}** · most active: **${u.most_active_repo}**
${u.languages_count} languages · synced ${new Date(data.generated_at).toLocaleDateString('fr-FR')}`;
  return { content: [{ type: 'text', text }] };
});

// Tool 2: lightweight repo list
server.registerTool('list_repos', {
  title: 'List repos (compact)',
  description: 'Returns one-liner per repo: name, language, stars, top topics. Use sort_by + limit + language filter to keep result small. Each repo ~30 tokens.',
  inputSchema: {
    sort_by: z.enum(['stars', 'updated', 'name']).optional().describe('Default: updated'),
    language: z.string().optional().describe('Filter by primary language'),
    limit: z.number().int().min(1).max(50).optional().describe('Default: 20'),
  },
}, async (args: { sort_by?: 'stars' | 'updated' | 'name'; language?: string; limit?: number }) => {
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

// Tool 3: repo summary (no full README, no journal)
server.registerTool('get_repo_summary', {
  title: 'Get repo summary (light)',
  description: 'Returns metrics + stack + recent commits ONLY (no full README, no debug journal). Use this BEFORE get_repo. ~150 tokens.',
  inputSchema: {
    name: z.string().describe('Repo name (case insensitive)'),
  },
}, async (args: { name: string }) => {
  const data = await loadData();
  const repo = data.repos.find(r => r.name.toLowerCase() === args.name.toLowerCase());
  if (!repo) return { content: [{ type: 'text', text: `❌ Repo "${args.name}" introuvable. Try list_repos first.` }], isError: true };
  const note = await readNote(repo.note_path);
  // Extract just the metrics + stack + timeline sections
  const sections = note ? splitNote(note) : [];
  const wanted = sections.filter(s => /Métriques|Stack technique|Timeline/.test(s.heading));
  const compact = wanted.map(s => `## ${s.heading}\n${s.body.slice(0, 500)}`).join('\n\n');
  return {
    content: [{
      type: 'text',
      text: `# ${repo.name}\n${repo.description}\n${repo.language ? `Language: ${repo.language}` : ''} · ⭐${repo.stars}\n\n${compact || 'No detailed note yet.'}\n\n_To read full note (README, journal, your personal notes), use \`get_repo_section\`._`,
    }],
  };
});

// Tool 4: targeted section read
server.registerTool('get_repo_section', {
  title: 'Read ONE section of a repo note',
  description: 'Returns only the requested section (e.g. "Stack technique", "Journal de debug", "Mes notes"). Use this to get specifics without loading the entire note.',
  inputSchema: {
    name: z.string().describe('Repo name'),
    section: z.string().describe('Section heading or keyword (matches partial: "stack", "journal", "notes", "readme", "metrics")'),
  },
}, async (args: { name: string; section: string }) => {
  const data = await loadData();
  const repo = data.repos.find(r => r.name.toLowerCase() === args.name.toLowerCase());
  if (!repo) return { content: [{ type: 'text', text: `❌ Repo "${args.name}" introuvable.` }], isError: true };
  const note = await readNote(repo.note_path);
  if (!note) return { content: [{ type: 'text', text: `❌ Note non trouvée pour ${repo.name}.` }], isError: true };
  const sections = splitNote(note);
  const q = args.section.toLowerCase();
  const matches = sections.filter(s => s.heading.toLowerCase().includes(q));
  if (matches.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `Section "${args.section}" non trouvée. Sections disponibles: ${sections.map(s => `"${s.heading}"`).join(', ')}`,
      }],
    };
  }
  const text = matches.map(s => `## ${s.heading}\n\n${s.body}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text: text.slice(0, 4000) }] };
});

// Tool 5: full repo (only when really needed)
server.registerTool('get_repo_full', {
  title: 'Read entire repo note',
  description: 'Returns the full Markdown note. EXPENSIVE in tokens. Prefer get_repo_summary or get_repo_section first.',
  inputSchema: {
    name: z.string().describe('Repo name'),
  },
}, async (args: { name: string }) => {
  const data = await loadData();
  const repo = data.repos.find(r => r.name.toLowerCase() === args.name.toLowerCase());
  if (!repo) return { content: [{ type: 'text', text: `❌ Repo "${args.name}" introuvable.` }], isError: true };
  const note = await readNote(repo.note_path);
  return { content: [{ type: 'text', text: note ?? '❌ Note non disponible.' }] };
});

// Tool 6: smart search across the whole brain
server.registerTool('search_brain', {
  title: 'Smart search across all notes',
  description: 'TF-IDF ranked search. Returns top N short excerpts (~50 tokens each) with scores. Use this BEFORE get_repo_full to find what is relevant.',
  inputSchema: {
    query: z.string().describe('Search query'),
    limit: z.number().int().min(1).max(10).optional().describe('Default: 5'),
  },
}, async (args: { query: string; limit?: number }) => {
  const results = await smartSearch(args.query, args.limit ?? 5);
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `Aucun résultat pour "${args.query}"` }] };
  }
  const lines = results.map((r, i) =>
    `### ${i + 1}. **${r.repo}** > ${r.section} _(score ${r.score})_\n${r.excerpt}\n_path: ${r.notePath}_`
  );
  return { content: [{ type: 'text', text: `${results.length} matches:\n\n${lines.join('\n\n')}\n\n_To dig deeper, use get_repo_section with the matching repo + section._` }] };
});

// Tool 7: stack
server.registerTool('get_stack', {
  title: 'Tech stack breakdown',
  description: 'User\'s tech stack by category. Compact, ~200 tokens.',
  inputSchema: {
    category: z.enum(['frontend', 'backend', 'database', 'devops', 'ml', 'mobile', 'tooling', 'language', 'other']).optional(),
  },
}, async (args: { category?: string }) => {
  const data = await loadData();
  let stack = data.stack;
  if (args.category) stack = stack.filter(s => s.category === args.category);
  const grouped: Record<string, typeof stack> = {};
  stack.forEach(s => { (grouped[s.category] ??= []).push(s); });
  const lines: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`\n**${cat.toUpperCase()}**: ${items.map(t => `${t.icon}${t.name}(×${t.count})`).join(' · ')}`);
  }
  return { content: [{ type: 'text', text: `# Stack ${data.github_username}${lines.join('')}` }] };
});

// Tool 8: topics
server.registerTool('get_topics', {
  title: 'Cross-cutting topics',
  description: 'Topics shared between ≥2 repos. Useful to find themes across projects.',
  inputSchema: {
    min_repos: z.number().int().min(1).optional(),
  },
}, async (args: { min_repos?: number }) => {
  const data = await loadData();
  const min = args.min_repos ?? 2;
  const items = data.topic_constellations
    .filter(c => c.repo_names.length >= min)
    .sort((a, b) => b.repo_names.length - a.repo_names.length);
  if (items.length === 0) return { content: [{ type: 'text', text: 'No shared topics.' }] };
  const lines = items.map(c => `- **#${c.topic}**: ${c.repo_names.join(', ')}`);
  return { content: [{ type: 'text', text: `${items.length} shared topics:\n${lines.join('\n')}` }] };
});

// Tool 9: read arbitrary note
server.registerTool('read_note', {
  title: 'Read a vault note by path',
  description: 'For any .md file in the vault (not just repo notes).',
  inputSchema: {
    path: z.string().describe('Vault-relative path, e.g. "Projets/Idées.md"'),
  },
}, async (args: { path: string }) => {
  const note = await readNote(args.path);
  if (!note) return { content: [{ type: 'text', text: `❌ Note "${args.path}" introuvable.` }], isError: true };
  return { content: [{ type: 'text', text: note.length > 8000 ? note.slice(0, 8000) + '\n\n_(truncated)_' : note }] };
});

// Tool 10: recent activity (cheap composite)
server.registerTool('get_recent_activity', {
  title: 'What moved recently',
  description: 'Returns repos that received commits in the last N days. Use for "what did I work on recently?". ~150 tokens.',
  inputSchema: {
    days: z.number().int().min(1).max(90).optional().describe('Lookback window. Default: 7'),
  },
}, async (args: { days?: number }) => {
  const data = await loadData();
  const days = args.days ?? 7;
  const cutoff = Date.now() - days * 86400000;
  const active = data.repos
    .filter(r => new Date(r.last_pushed).getTime() > cutoff)
    .sort((a, b) => b.last_pushed.localeCompare(a.last_pushed));
  if (active.length === 0) {
    return { content: [{ type: 'text', text: `Aucun repo actif depuis ${days} jours.` }] };
  }
  const lines = active.map(r => {
    const d = Math.floor((Date.now() - new Date(r.last_pushed).getTime()) / 86400000);
    return `- **${r.name}** [${r.language ?? '?'}] — il y a ${d}j`;
  });
  return { content: [{ type: 'text', text: `${active.length} repos actifs sur ${days}j:\n\n${lines.join('\n')}` }] };
});

// Tool 11: find similar repos (uses topics + language)
server.registerTool('find_similar_repos', {
  title: 'Find repos similar to a given one',
  description: 'Returns repos that share language or topics with the target repo. Useful for "give me my projects related to X".',
  inputSchema: {
    name: z.string().describe('Target repo name'),
    limit: z.number().int().min(1).max(10).optional(),
  },
}, async (args: { name: string; limit?: number }) => {
  const data = await loadData();
  const target = data.repos.find(r => r.name.toLowerCase() === args.name.toLowerCase());
  if (!target) return { content: [{ type: 'text', text: `❌ Repo "${args.name}" introuvable.` }], isError: true };
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
  if (scored.length === 0) {
    return { content: [{ type: 'text', text: `Aucun repo similaire à "${args.name}".` }] };
  }
  const lines = scored.map(({ r, score }) => {
    const shared = r.topics.filter(t => targetTopics.has(t));
    return `- **${r.name}** _(score ${score})_ — ${r.language ?? '?'} ${shared.length ? `· shared: ${shared.join(',')}` : ''}`;
  });
  return { content: [{ type: 'text', text: `Repos similaires à **${target.name}**:\n\n${lines.join('\n')}` }] };
});

// Tool 12: compose brief — meta tool that builds a focused report
server.registerTool('compose_brief', {
  title: 'Compose a focused brief on a subject',
  description: 'Smart composite: searches the brain, picks top relevant chunks, returns a compact briefing. Use for open questions like "Where do I stand on auth?" or "What did I learn about ML?". Avoids loading entire notes.',
  inputSchema: {
    subject: z.string().describe('The subject to brief on'),
    max_repos: z.number().int().min(1).max(8).optional().describe('Default: 4'),
  },
}, async (args: { subject: string; max_repos?: number }) => {
  const max = args.max_repos ?? 4;
  const results = await smartSearch(args.subject, max * 3);
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `Pas de matériel sur "${args.subject}".` }] };
  }
  // Group by repo, take best section per repo
  const byRepo = new Map<string, typeof results>();
  for (const r of results) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo)!.push(r);
  }
  const top = Array.from(byRepo.entries()).slice(0, max);
  const lines: string[] = [`# Brief: ${args.subject}\n`];
  for (const [repo, hits] of top) {
    const best = hits[0];
    lines.push(`## ${repo} > ${best.section}`);
    lines.push(best.excerpt);
    lines.push('');
  }
  lines.push(`_${results.length} matches across ${byRepo.size} repos. Use \`get_repo_section\` for full content of any section above._`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ── Start ────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🌌 Galactic Brain MCP v2 connected');
  console.error(`   Vault: ${VAULT_PATH}`);
  console.error(`   Export: ${EXPORT_PATH}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
