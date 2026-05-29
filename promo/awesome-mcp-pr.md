# ⚠️ OBSOLÈTE — Voir mcpservers-submission.md

> Le repo `wong2/awesome-mcp-servers` **n'accepte plus de PRs**. Note explicite en haut de leur README :
> > *We do not accept PRs. Please submit your MCP on the website: https://mcpservers.org/submit*
>
> ➡️ La voie officielle est désormais : **[mcpservers-submission.md](./mcpservers-submission.md)**
>
> Ce fichier est conservé pour archive historique.

---

# (Archive) — Procédure PR ancienne version

**Repo cible :** https://github.com/wong2/awesome-mcp-servers
**Action :** Fork → édit `README.md` → PR

---

## Étapes pratiques

1. Va sur https://github.com/wong2/awesome-mcp-servers
2. **Fork** le repo dans ton compte Abdoulrazack1
3. Clone le fork localement :
   ```bash
   git clone https://github.com/Abdoulrazack1/awesome-mcp-servers.git
   cd awesome-mcp-servers
   git checkout -b add-galactic-brain
   ```
4. Édite `README.md` (voir entrée ci-dessous, à placer dans la bonne section)
5. Commit :
   ```bash
   git commit -am "Add Galactic Brain MCP — 114 tools for Obsidian-backed memory"
   git push origin add-galactic-brain
   ```
6. Ouvre la PR sur https://github.com/wong2/awesome-mcp-servers/compare avec le body ci-dessous

---

## Entrée Markdown à ajouter

Lit d'abord la structure actuelle du README de `awesome-mcp-servers`. Place l'entrée dans la section la plus pertinente — probablement **"Knowledge & Memory"**, **"Productivity"** ou **"Note-Taking"** (cherche celle qui correspond le mieux). Si aucune n'existe, propose-la dans **"Server Implementations"**.

Format respectant la convention existante (vérifie l'alphabétique) :

```markdown
- [Abdoulrazack1/galactic-brain-mcp](https://github.com/Abdoulrazack1/galactic-brain-mcp) - 114 tools that turn an Obsidian vault into persistent memory for Claude Desktop / Claude Code. BM25 search, decision stress-testing, anticipation, auto-sync hooks. Node.js, 2 deps, MIT.
```

⚠️ **Vérifier avant submit** :
- L'entrée respecte le format (tiret en début, description ≤ 200 chars, point final)
- Ordre alphabétique respecté dans la section
- Pas de doublon (cherche "obsidian" et "memory" dans le README actuel)

---

## Body de la PR

```markdown
## Add Galactic Brain MCP

Adds [Galactic Brain MCP](https://github.com/Abdoulrazack1/galactic-brain-mcp), an open-source MCP server (Node.js, MIT) that exposes **114 tools** turning an Obsidian vault into persistent memory for Claude Desktop / Claude Code.

### Key features

- **Persistent memory** via Obsidian vault (markdown, git-versionable, portable)
- **BM25 search** custom-built (no FAISS/Pinecone dependency)
- **Reasoning tools** — `brain_advise` (decision stress-test), `brain_critic` (devil's advocate), `brain_chain` (sequential reasoning)
- **Synthesis** — `brain_brief` replaces 5 calls with 1 narrative situation report
- **Auto-sync** — Claude Code hooks (Edit/Write/Stop) → `events.jsonl` → Task Scheduler push GitHub /30 min
- **Zero paid APIs**, 2 runtime dependencies (`@modelcontextprotocol/sdk`, `zod`)

### Stats

- 114 tools across 4 architectural layers (v5 → v14.1)
- ~5961 lines in `dist/index.js`
- 14 versions shipped in 2 weeks

Happy to address any feedback on the entry formatting or placement.
```

---

## Conseils

- **Lis CONTRIBUTING** du repo `awesome-mcp-servers` (s'il existe) avant la PR
- **Vérifie les PRs récentes** pour voir le style attendu
- **Pas de spam** — une seule PR, attendre le merge avant d'en proposer une autre
- Si le maintainer demande des modifs, **applique-les rapidement** (généralement quelques jours suffisent pour le merge)
