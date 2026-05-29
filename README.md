# 🌌 Galactic Brain MCP

> **Fatigué que Claude oublie le contexte entre deux sessions ?**
> Galactic Brain transforme ton vault Obsidian en **mémoire augmentée** pour Claude Desktop et Claude Code, avec **114 outils** de raisonnement, recherche et synthèse.

[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-%40modelcontextprotocol%2Fsdk-7c5cff)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Obsidian](https://img.shields.io/badge/Obsidian-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md/)
[![Claude](https://img.shields.io/badge/Claude-Desktop%20%2F%20Code-D97757)](https://claude.ai/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- 📽️ GIF/Démo à ajouter ici : 10-15s montrant Claude Desktop appelant brain_brief ou brain_advise et retournant un rapport multi-source. Drag-drop dans GitHub → coller le lien Markdown ici. -->

---

## 🚀 Ce que tu peux faire avec Galactic Brain MCP

| Avant | Avec Galactic Brain |
|---|---|
| « Claude, j'ai bossé sur X la semaine dernière, tu te souviens ? » | `brain_brief depth:full` → rapport situation en 1 call : commits, décisions, deadlines, threads stalled |
| « Est-ce que cette décision est cohérente avec ce que j'ai dit avant ? » | `brain_advise decision:"..."` → verdict GO/CAUTION/NO-GO + contradictions détectées |
| « Aide-moi à planifier mon sprint à partir de mes notes » | `sprint_plan` ou `brain_chain` — raisonnement séquentiel multi-étapes sur ton vault |
| « Quels sont les risques que je n'ai pas vus ? » | `brain_critic` — avocat du diable adversarial sur ton plan |
| « Anticipe ma semaine » | `brain_foresee` — deadlines à risque, threads qui meurent, décisions overdue |

**Pas une démo.** ~5900 lignes, 14 versions livrées en 2 semaines, utilisé quotidiennement.

---

## 🧠 Qu'est-ce que c'est

Galactic Brain MCP est un serveur [Model Context Protocol](https://modelcontextprotocol.io/) qui transforme un vault Obsidian en **mémoire augmentée** pour Claude. Il indexe tes repos GitHub, tes notes, tes décisions, ton time-log, et expose tout ça via **114 outils** — recherche, raisonnement, anticipation, stress-test de décisions, synthèse multi-source, et plus.

## 🏗️ Architecture en 4 couches

```
┌─────────────────────────────────────────────────────────────┐
│  v5–v11 — Fondation                                          │
│  ▸ 65+ outils : repos, notes, search BM25, satellite notes,  │
│    decisions, goals, time-log, anomaly detection, deadlines  │
├─────────────────────────────────────────────────────────────┤
│  v12 — ADAPTIVE                                              │
│  ▸ calibrate, sprint_plan, dedup_check, weekly_report        │
│  ▸ cluster_improvements, deep_reason, adaptive_score         │
├─────────────────────────────────────────────────────────────┤
│  v13.4 — LEARNING                                            │
│  ▸ feedback, brain_stats, brain_consolidate, brain_learned   │
│  ▸ Log d'events + cache de routings stables + lexique adapt. │
├─────────────────────────────────────────────────────────────┤
│  v14 — COGNITIVE SYNTHESIS                                   │
│  ▸ brain_brief — situation report proactif (1 call = 5 tools)│
│  ▸ brain_advise — stress-test décision (GO/CAUTION/NO-GO)    │
│  ▸ brain_now — quoi faire dans X min (multi-facteur)         │
│  ▸ brain_chain — raisonnement séquentiel multi-étapes        │
│  ▸ brain_foresee — anticipation à 7 jours                    │
│  ▸ brain_critic — avocat du diable adversarial               │
│  ▸ brain_pack — context bundle dense                         │
│  ▸ brain_synthesize / brain_explain / brain_resolve          │
│  ▸ brain_momentum / brain_orchestrate / brain_speak          │
├─────────────────────────────────────────────────────────────┤
│  v14.1 — AUTO-SYNC                                           │
│  ▸ gb_session_ingest — digère le log session en notes        │
│  ▸ gb_push / gb_pull / gb_sync — git ops sur le vault        │
│  ▸ gb_diff_since_last_session — état depuis dernier handoff  │
│  ▸ Hooks Claude Code (Edit/Write + Stop) → events.jsonl      │
│  ▸ Task Scheduler Windows push GitHub /30 min                │
└─────────────────────────────────────────────────────────────┘
```

Chaque couche apporte une capacité distincte : v5–v11 fournit la **mémoire brute** (notes, search, time-log), v12 ajoute la **calibration adaptative**, v13 introduit l'**apprentissage** des routings stables, v14 livre la **synthèse cognitive** (1 call multi-outils), et v14.1 boucle la **boucle auto-sync** entre Claude Code et le vault.

## 🌟 Quelques outils marquants

### `brain_brief` — Situation report proactif
Remplace l'enchaînement *morning_routine + deadlines + anomaly + pulse + cluster_improvements* par un seul appel narratif. Idéal en début de journée ou après une pause.

### `brain_advise` — Stress-test de décision
Confronte une décision à la mémoire (contradictions, décisions passées similaires) + raisonne sur les risques + rend un **verdict GO / CAUTION / NO-GO** avec watchpoints.

### `brain_chain` — Raisonnement séquentiel
Pour les questions complexes. Décompose en sous-étapes, exécute en séquence (output[N-1] → input[N]), synthétise. Plus puissant que `understand` qui exécute en parallèle.

### `brain_foresee` — Anticipation 7 jours
Projette : deadlines à risque, threads stalled qui meurent, contexte qui se perd, décisions overdue. À appeler en fin de semaine.

### `brain_critic` — Avocat du diable
Soumets un plan, je l'attaque depuis tous les angles : faiblesses, suppositions cachées, contradictions, alternatives ignorées.

## 📦 Quick Start

### Prérequis

- Node.js ≥ 20
- [Obsidian](https://obsidian.md/) avec un vault
- [Claude Desktop](https://claude.ai/download) ou Claude Code
- Le [plugin Obsidian Galactic Brain](#) (génère `_mcp_export.json` dans le vault)

### Installation (3 commandes)

```bash
git clone https://github.com/Abdoulrazack1/galactic-brain-mcp.git
cd galactic-brain-mcp
npm install
```

### Configurer Claude Desktop

Édite `%APPDATA%\Claude\claude_desktop_config.json` (Windows) ou
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) :

```json
{
  "mcpServers": {
    "galactic-brain": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\galactic-brain-mcp\\dist\\index.js"],
      "env": {
        "GALACTIC_VAULT_PATH": "C:\\chemin\\vers\\Obsidian Vault"
      }
    }
  }
}
```

Redémarre Claude Desktop. Les **114 outils** apparaissent dans le menu MCP.

## 🔁 Activer l'auto-sync (v14.1)

Le système de hooks et d'auto-push transforme Galactic Brain d'un brain **passif** en un brain **alimenté en continu** par tes sessions Claude.

### 1) Hooks Claude Code

Crée `~/.claude/settings.json` :

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write|NotebookEdit|MultiEdit",
      "hooks": [{
        "type": "command",
        "command": "node \"C:\\\\chemin\\\\vers\\\\dist\\\\hooks\\\\gb-hook.mjs\" edit",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"C:\\\\chemin\\\\vers\\\\dist\\\\hooks\\\\gb-hook.mjs\" stop",
        "timeout": 15
      }]
    }]
  }
}
```

### 2) Task Scheduler (Windows)

```powershell
& "C:\chemin\vers\dist\scripts\register-task.ps1"
```

→ Push automatique du vault toutes les 30 min vers ton repo GitHub privé.

## 🚀 Utilisation

Une fois connecté, dans Claude :

- **Reprise de session** : `brain_brief depth:full`
- **Avant une décision** : `brain_advise decision:"..."`
- **Question complexe** : `brain_chain question:"..."`
- **Fin de journée** : `gb_sync`

Le brain apprend de tes routings via `brain_consolidate` (à lancer 1× par semaine).

## 🗂️ Structure

```
galactic-brain-mcp/
├── dist/
│   ├── index.js              # Le serveur (5961 lignes, source de vérité)
│   ├── hooks/
│   │   └── gb-hook.mjs       # Hook handler Claude Code (edit + stop)
│   └── scripts/
│       ├── auto-push.ps1     # Script Task Scheduler
│       └── register-task.ps1 # Enregistrement Task Scheduler
├── src/
│   └── index.ts              # ⚠️ Obsolète (v2) — dist/index.js est canonique
├── package.json
└── README.md
```

⚠️ **Note** : `src/index.ts` n'est plus à jour. À partir de v3, j'édite directement `dist/index.js`. Une refonte TypeScript propre est dans le backlog v15.

## 🛠️ Stack

- **`@modelcontextprotocol/sdk`** — protocole MCP
- **`zod`** — validation des inputs des tools
- **BM25 custom** (k1=1.5, b=0.75, phrase boost +4, bigram +1.5) — recherche
- **Learning layer** — events.jsonl + consolidation périodique → cache de routings stables (≥3 occurrences, confidence ≥0.6)
- **Vault Obsidian** comme storage — markdown, JSON, JSONL append-only

## 📊 Stats

| Métrique | Valeur |
|---|---|
| Outils | **114** |
| Versions | 14 (v5 → v14.1) |
| Lignes Node.js | ~5961 |
| Lignes hooks/scripts | ~260 |
| API payantes | **0** |
| Dépendances runtime | 2 (`@mcp/sdk`, `zod`) |

## 🆚 Pourquoi pas un autre serveur MCP ?

| Solution | Outils | Mémoire persistante | Apprentissage | API payante |
|---|---|---|---|---|
| **Galactic Brain MCP** | **114** | ✅ Vault Obsidian git-versionné | ✅ Cache routings | ❌ 0 |
| `mcp-server-memory` officiel | ~10 | ⚠️ JSON local | ❌ | ❌ |
| Mem0 / Letta | variable | ✅ | ✅ | ✅ payant |

Le choix d'Obsidian comme storage = **portabilité totale** (markdown), versioning gratuit (git), et un client de lecture/édition déjà excellent.

## 🤝 Contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md). C'est un projet personnel, mais issues et PRs sont bienvenues — ajout d'un outil, fix d'un bug BM25, amélioration de la consolidation, port macOS/Linux pour Task Scheduler, etc.

## 📜 Licence

MIT. Fais-en ce que tu veux.

## 🔗 Liens

- **Vault de mémoire** (privé) : `galactic-brain-vault`
- **Plugin Obsidian** : à publier
- **Liste de serveurs MCP** : [awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers)
- **Auteur** : [@Abdoulrazack1](https://github.com/Abdoulrazack1)
