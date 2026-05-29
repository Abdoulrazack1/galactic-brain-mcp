# Soumission à mcpservers.org

> ⚠️ **Important** : Le repo `wong2/awesome-mcp-servers` n'accepte plus de PRs depuis ~2026 (cf. note en haut de leur README) :
> > *We do not accept PRs. Please submit your MCP on the website: https://mcpservers.org/submit*
>
> Le précédent brouillon `awesome-mcp-pr.md` est donc **obsolète**. La voie officielle = soumettre via le formulaire web.

---

## 🌐 URL de soumission

**https://mcpservers.org/submit**

(à ouvrir dans ton navigateur, connecté ou non selon ce qu'ils demandent)

---

## 📝 Contenu à coller dans le formulaire

### Nom

```
Galactic Brain MCP
```

### URL GitHub

```
https://github.com/Abdoulrazack1/galactic-brain-mcp
```

### Description courte (1 ligne, ~150 chars)

```
114 tools that turn an Obsidian vault into persistent memory for Claude Desktop / Claude Code. BM25 search, decision stress-testing, auto-sync hooks.
```

### Description longue (~500-800 chars si le formulaire le permet)

```
Galactic Brain MCP is an open-source Node.js MCP server (MIT) that exposes 114 tools turning an Obsidian vault into persistent memory for Claude Desktop and Claude Code.

Architecture in 4 layers:
- v5-v11 Foundation: 65+ tools (notes, repos, BM25 search, time-log, decisions, anomaly detection)
- v12 ADAPTIVE: calibration, sprint planning, deduplication
- v13.4 LEARNING: events log + consolidation → adaptive routing cache
- v14 COGNITIVE SYNTHESIS: brain_brief (1-call situation report), brain_advise (decision stress-test → GO/CAUTION/NO-GO), brain_chain (sequential reasoning), brain_critic (devil's advocate), brain_foresee (7-day anticipation)
- v14.1 AUTO-SYNC: Claude Code hooks (Edit/Write/Stop) → events.jsonl → Task Scheduler push to GitHub /30 min

Custom BM25 search (k1=1.5, b=0.75, phrase boost +4, bigram +1.5) built from scratch — no FAISS/Pinecone dependency.

Stack: Node.js >= 20, @modelcontextprotocol/sdk, zod. Only 2 runtime dependencies. Zero paid APIs. ~5961 lines in dist/index.js, 14 versions shipped in 2 weeks.

Use cases: persistent memory across Claude sessions, decision stress-testing against past contradictions, weekly anticipation of deadlines/threads at risk, situation reports.
```

### Tags / Categories (si demandés)

```
memory, knowledge-management, obsidian, productivity, reasoning, agent
```

### Stack / Language

```
Node.js, TypeScript, MCP, Obsidian
```

### License

```
MIT
```

### Author

```
Abdoulrazack Abdillahi (@Abdoulrazack1)
```

### Demo URL (optionnel)

```
(à compléter si tu fais une vidéo YouTube de démo)
```

---

## ✅ Avant de soumettre

1. **Vérifier le README** : si possible, ajouter un GIF de démo en haut avant la soumission (mcpservers.org affichera vraisemblablement la 1ère image du README)
2. **Vérifier les topics GitHub** : `mcp`, `model-context-protocol`, `claude`, `claude-desktop`, `obsidian`, `ai`, `llm`, `bm25` sont essentiels — ✅ déjà ajoutés
3. **Vérifier la description GitHub** : à jour avec "114 memory & reasoning tools" — ✅ fait
4. **Vérifier la license** : `LICENSE` présent à la racine et de type MIT — à vérifier
5. **Vérifier que README.md est en anglais** OU au moins bilingue — actuellement FR. **Recommandation** : ajouter une section English au top, ou créer `README.en.md` linké depuis le README principal

---

## 🔍 Pourquoi je ne soumets pas moi-même

- Le formulaire web peut demander une **authentification** (GitHub OAuth probable)
- Soumettre via le navigateur depuis ma session = je ne peux pas confirmer ton identité
- **Risque** : si la soumission est mal formée ou rejetée par modération, tu hérites de l'échec sans avoir vu le formulaire
- **Mieux** : tu ouvres l'URL, tu colles, tu cliques Submit. C'est 2 minutes.

---

## 📨 Alternatives si mcpservers.org ne suffit pas

- **modelcontextprotocol/servers** (le repo officiel Anthropic) — vérifier s'ils acceptent des PRs pour `community-servers.md`
  - URL : https://github.com/modelcontextprotocol/servers
- **Reddit r/ClaudeAI** + **r/LocalLLaMA** — drafts dans ce même dossier
- **Hacker News Show HN** — à envisager une fois 1-2 utilisateurs externes ont testé et validé

---

## ⏱️ Timing recommandé

- **Soumettre mcpservers.org en premier** (zero coût, soumission rapide)
- Attendre 1-2 jours pour voir si listé
- Puis lancer Reddit r/ClaudeAI (cf. `reddit-r-ClaudeAI.md`)
- 24-48h plus tard, r/LocalLLaMA
- 1 semaine plus tard, Hacker News si les retours Reddit sont bons
