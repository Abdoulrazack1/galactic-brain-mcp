# Product Hunt — Launch

**Catégorie :** Developer Tools / AI
**Launch day :** mardi ou mercredi (best traffic)
**Préparer 1 semaine avant** : précommander upvotes via tes contacts (notifier email + LinkedIn)

---

## Tagline (60 chars max)

> 114 MCP tools that give Claude Desktop a persistent brain

Alternatives :
- "Persistent memory for Claude — 114 tools, zero API costs"
- "Turn your Obsidian vault into Claude's long-term memory"

---

## Description (260 chars max)

> Galactic Brain is an open-source MCP server with 114 tools that transforms an Obsidian vault into persistent memory for Claude Desktop & Claude Code. BM25 search, decision stress-testing, anticipation, auto-sync hooks. Node.js, 2 deps, MIT.

---

## Gallery (4-6 images)

1. **Hero** — diagramme des 4 couches (v5-v14.1) + logo
2. **GIF demo** — `brain_brief depth:full` dans Claude Desktop → situation report
3. **Screenshot** — `brain_advise` rendant verdict CAUTION avec watchpoints
4. **Screenshot** — structure du vault Obsidian (sidebar gauche)
5. **Diagramme** — flow auto-sync (Claude Code → events.jsonl → Task Scheduler → GitHub)
6. **Table** — comparatif avec mcp-server-memory / Mem0 / Letta

---

## First comment (toi en tant que maker)

Hey Product Hunt 👋

Galactic Brain est né d'une frustration personnelle : j'utilisais Claude tous les jours, et à chaque session il oubliait tout — décisions passées, contexte de mes projets, mes deadlines.

J'ai construit Galactic Brain sur 2 semaines en livrant 14 versions. La v1 avait 20 outils. La v14.1 en a 114, organisés en 4 couches :

- **v5-v11** : Fondation (notes, repos, search BM25, time-log, decisions)
- **v12** : Adaptive (calibration, sprint planning, dedup)
- **v13.4** : Learning (cache adaptatif de routings stables)
- **v14** : Cognitive Synthesis (`brain_brief`, `brain_advise`, `brain_chain`, `brain_critic`, `brain_foresee`)
- **v14.1** : Auto-Sync (hooks Claude Code + Task Scheduler → push GitHub /30 min)

**Pourquoi Obsidian comme storage** : markdown = portabilité totale, git = versioning gratuit, et le client de lecture/édition existe déjà (et est excellent).

**Zéro API payante.** 2 dépendances runtime (`@mcp/sdk`, `zod`).

Heureux d'avoir vos retours — particulièrement sur les outils qui manquent dans votre workflow Claude. Et si vous voulez porter les scripts Windows Task Scheduler vers macOS/Linux, c'est très bienvenu.

GitHub : https://github.com/Abdoulrazack1/galactic-brain-mcp

---

## Topics (3-5)

- Developer Tools
- Artificial Intelligence
- Productivity
- Open Source

---

## Notes pour le launch

- **Schedule** : Product Hunt commence à minuit Pacific Time (PST), donc poste juste après minuit
- **Notification** : prévenir tous tes contacts ~6h avant le launch (email + DM LinkedIn)
- **Comments** : répondre dans les 5 minutes pour les 2 premières heures (algo PH valorise l'engagement précoce)
- **Twitter/X** : thread préparé pour relais (cf. promo/twitter-thread.md à créer)
- **HN** : si bon score sur PH, cross-post sur Hacker News le lendemain en "Show HN"
