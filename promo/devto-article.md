# Dev.to — Article technique

**Titre :** Building Galactic Brain: 114 MCP tools to give Claude a persistent brain (Obsidian + BM25 + auto-sync hooks)
**Tags :** `mcp`, `ai`, `claude`, `obsidian`, `nodejs`
**Canonical URL :** https://github.com/Abdoulrazack1/galactic-brain-mcp

---

## Cover image

À créer : screenshot du diagramme des 4 couches + logo Galactic Brain.
Suggestion : Excalidraw export, 1000×420px, fond sombre.

---

## TL;DR (200 mots max)

J'ai construit un serveur Model Context Protocol qui expose **114 outils** à Claude Desktop pour transformer un vault Obsidian en mémoire augmentée. Stack : Node.js, `@modelcontextprotocol/sdk`, BM25 custom, vault git-versionné. Cet article couvre l'architecture en 4 couches, l'implémentation BM25 from scratch, et le système d'auto-sync via hooks Claude Code + Windows Task Scheduler.

---

## Plan de l'article

### 1. Le problème — Claude oublie tout entre sessions
- Le contexte est éphémère
- Les solutions actuelles : context manuel répété, prompt-stuffing, SaaS payants
- Le constat : on a déjà un knowledge base (Obsidian) mais pas le pont

### 2. La solution — un serveur MCP qui parle à ton vault
- Quick intro MCP (référence vers https://modelcontextprotocol.io/)
- Pourquoi Obsidian comme storage (markdown, git, client existant)
- Vue d'ensemble des 114 outils en 4 couches

### 3. Architecture en 4 couches
```
v5-v11   → Fondation (65+ outils CRUD + search)
v12      → ADAPTIVE (calibration, sprint planning)
v13.4    → LEARNING (events.jsonl + consolidation)
v14      → COGNITIVE SYNTHESIS (brain_brief, brain_advise, ...)
v14.1    → AUTO-SYNC (hooks Claude Code + Task Scheduler)
```

### 4. Deep-dive — BM25 custom from scratch
- Pourquoi pas FAISS/Pinecone/Qdrant (coût, complexité, network)
- Paramètres choisis : k1=1.5, b=0.75
- Phrase boost +4 sur les matches exacts
- Bigram boost +1.5
- Index serializable, ~5ms par requête sur 500 notes

### 5. Deep-dive — `brain_brief` (situation report)
- Le pattern "1 call qui en remplace 5"
- Comment composer morning_routine + deadlines + anomaly + pulse + cluster_improvements
- Output narratif vs JSON brut (pourquoi le narratif gagne)

### 6. Deep-dive — `brain_advise` (stress-test décision)
- Recherche de contradictions actives
- Lookup de décisions similaires passées
- Verdict GO / CAUTION / NO-GO avec watchpoints

### 7. Le système d'auto-sync (v14.1)
- Hooks Claude Code : `PostToolUse` (Edit|Write) + `Stop`
- Tout est loggé dans `events.jsonl` (append-only)
- Task Scheduler Windows push GitHub /30 min via `auto-push.ps1`
- `gb_session_ingest` digère le log en notes Obsidian

### 8. Leçons apprises
- Le coût de "ne pas avoir de DB" — gain en simplicité, perte en concurrence
- MCP est encore jeune mais la spec est claire
- Les LLM aiment les outputs narratifs structurés > JSON brut
- L'apprentissage = pas du fine-tuning, juste un cache adaptatif

### 9. Limites et roadmap v15
- Pas de TypeScript propre (refonte v15)
- Port macOS/Linux pour Task Scheduler
- Tests automatisés (actuellement testé en live)

### 10. Liens
- GitHub : https://github.com/Abdoulrazack1/galactic-brain-mcp
- MCP spec : https://modelcontextprotocol.io/
- awesome-mcp-servers : https://github.com/wong2/awesome-mcp-servers

---

## Notes pour rédiger

- **Longueur cible** : 1500-2500 mots
- Inclure 3-5 snippets de code (BM25, hook handler, exemple de `brain_advise` schema)
- Inclure 2-3 screenshots (output de `brain_brief`, structure du vault, claude_desktop_config.json)
- CTA fin d'article : "Star sur GitHub, ouvre une issue, dis-moi quels outils manquent dans ton workflow"
- Publier mardi/mercredi/jeudi entre 9h-11h EST pour viz max sur Dev.to
- Cross-poster sur Medium (canonical = Dev.to)
