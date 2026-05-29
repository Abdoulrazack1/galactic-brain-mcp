# Reddit — r/ClaudeAI

**Subreddit cible :** r/ClaudeAI
**Flair suggéré :** `Project Showcase`
**Best time to post :** mardi-jeudi, 14h-17h UTC (heures actives US)

---

## Titre (140 chars max)

> I built 114 MCP tools that give Claude Desktop a persistent brain (Obsidian vault + auto-sync hooks) — open source

Alternatives :
- "Tired of Claude forgetting context? I built an MCP server with 114 memory & reasoning tools for Claude Desktop"
- "Galactic Brain MCP: 114 tools that turn an Obsidian vault into Claude's long-term memory"

---

## Body

Hey r/ClaudeAI,

J'ai construit **Galactic Brain MCP**, un serveur Model Context Protocol qui résout un problème que beaucoup d'entre nous ont : **Claude oublie tout entre sessions**.

### Ce que ça fait

Galactic Brain transforme un vault Obsidian en mémoire augmentée pour Claude Desktop / Claude Code. **114 outils** exposés via MCP couvrent :

- **Mémoire structurée** — notes, repos, décisions, time-log, deadlines, goals
- **Recherche BM25** custom (k1=1.5, b=0.75, phrase boost) sur l'intégralité du vault
- **Raisonnement** — `brain_advise` (stress-test de décision), `brain_critic` (avocat du diable), `brain_chain` (raisonnement séquentiel)
- **Synthèse** — `brain_brief` remplace 5 outils en 1 call narratif ("situation report")
- **Anticipation** — `brain_foresee` projette à 7 jours (deadlines à risque, threads stalled)
- **Auto-sync** — hooks Claude Code (Edit/Write + Stop) → events.jsonl → push GitHub /30 min

### Pourquoi c'est différent

| | Galactic Brain | mcp-server-memory officiel | Mem0/Letta |
|---|---|---|---|
| Outils | 114 | ~10 | varie |
| Storage | Vault Obsidian (markdown, git) | JSON local | Cloud |
| Apprentissage | Cache routings stables | ❌ | ✅ |
| API payante | ❌ | ❌ | ✅ |

Le choix d'Obsidian = portabilité totale (markdown), versioning gratuit (git), client lecture/édition existant excellent.

### Stack

Node.js + `@modelcontextprotocol/sdk` + Zod (validation). 5961 lignes dans `dist/index.js`, 2 dépendances runtime, 14 versions livrées en 2 semaines.

### GitHub

https://github.com/Abdoulrazack1/galactic-brain-mcp

Heureux d'avoir vos retours sur :
- Quels outils manquent dans votre workflow Claude
- Si vous voyez des cas d'usage que je n'ai pas couverts
- Si quelqu'un veut porter les scripts Windows Task Scheduler vers macOS/Linux

(Je réponds à tout dans les commentaires, n'hésitez pas !)

---

## Comment optimiser le post

- **Ajoute le GIF de démo** (drag-drop dans le formulaire post Reddit, ou imgur link)
- Réponds aux 3 premiers commentaires dans les 30 min
- Ne pas faire de cross-post sur r/LocalLLaMA dans la même heure (Reddit anti-spam)
- Suivre la discussion 24-48h, upvoter les bonnes questions
