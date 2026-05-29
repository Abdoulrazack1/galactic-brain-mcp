# Reddit — r/LocalLLaMA

**Subreddit cible :** r/LocalLLaMA
**Flair suggéré :** `Tutorial | Guide` ou `Resources`
**Best time to post :** mardi-jeudi 18h-22h UTC (heures actives EU + early US)

---

## Titre

> Show: Galactic Brain MCP — 114 tools that give your LLM persistent memory via Obsidian + auto-sync

---

## Body

Hi r/LocalLLaMA,

J'ai construit un serveur MCP qui peut être utile à ceux qui veulent une **mémoire persistante** pour leur LLM sans dépendre d'une API SaaS.

### Le problème

Tu utilises Claude Desktop, Claude Code, ou n'importe quel client MCP (LM Studio supporte MCP, Ollama est en chemin). Mais à chaque session, ton LLM redémarre à zéro — pas de mémoire des décisions passées, pas de connaissance de ton codebase, pas de continuité.

### Ma solution

Galactic Brain MCP — serveur Node.js qui :

1. Lit ton vault **Obsidian** (markdown + JSON local, pas de SaaS)
2. Expose **114 outils MCP** pour requêter cette mémoire
3. Auto-sync via hooks éditeur (Edit/Write/Stop) → vault versionné git

**Stack :** Node.js 20+, `@modelcontextprotocol/sdk`, `zod`. **2 deps runtime**, 0 API payante.

### Outils notables

- **`brain_brief`** — situation report multi-source en 1 call (commits, deadlines, threads stalled, contradictions actives)
- **`brain_advise`** — stress-test une décision : confronte aux contradictions, rend verdict GO/CAUTION/NO-GO
- **`brain_chain`** — raisonnement séquentiel multi-étapes (chaque output devient input du suivant)
- **`brain_critic`** — avocat du diable adversarial sur ton plan
- **`brain_foresee`** — anticipation à 7 jours (deadlines, threads qui meurent)

Total : 65 outils de fondation (v5-v11), 12 outils "ADAPTIVE" (v12), 8 "LEARNING" (v13.4), 12 "COGNITIVE SYNTHESIS" (v14), 7 "AUTO-SYNC" (v14.1).

### Recherche BM25 custom

Implémentée from scratch en JS pur : k1=1.5, b=0.75, phrase boost +4, bigram boost +1.5. Pas de FAISS, pas de Pinecone, pas de Qdrant — tout en mémoire avec index serializable.

### Apprentissage

Layer "LEARNING" (v13.4) log les events dans `events.jsonl`, et `brain_consolidate` détecte les routings stables (≥3 occurrences, confidence ≥0.6) pour les promouvoir en cache. Pas de fine-tuning — juste un cache adaptatif.

### Compatibilité

Testé sur :
- ✅ Claude Desktop (macOS + Windows)
- ✅ Claude Code (CLI)
- ⏳ LM Studio — devrait marcher, pas encore testé
- ⏳ Ollama — quand le support MCP arrivera

### Code

https://github.com/Abdoulrazack1/galactic-brain-mcp

MIT, contributions bienvenues. Je cherche aussi des testeurs pour confirmer la compat avec d'autres clients MCP.

---

## Notes pour optimiser

- Sur r/LocalLLaMA, **les benchmarks et la stack technique pèsent plus que le pitch produit**
- Mentionne explicitement "no API costs", "fully local" — c'est un trigger fort
- Si possible, joins un screenshot du output de `brain_brief` (anonymisé)
