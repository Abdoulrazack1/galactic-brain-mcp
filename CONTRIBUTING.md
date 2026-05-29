# Contribuer à Galactic Brain MCP

Merci de t'intéresser au projet ! C'est un projet personnel mais ouvert — les contributions externes sont les bienvenues.

## 🚀 Setup local

```bash
git clone https://github.com/Abdoulrazack1/galactic-brain-mcp.git
cd galactic-brain-mcp
npm install
```

Le code source de référence est dans `dist/index.js` (5961 lignes). `src/index.ts` est obsolète depuis v3 — la refonte TypeScript est dans le backlog v15.

## 🎯 Bonnes premières contributions (`good first issue`)

Si tu veux contribuer sans te plonger dans toute l'architecture, voici des points d'entrée accessibles :

- **Ajouter un outil simple** (un nouveau `mcp__galactic-brain__*`) — copie le pattern d'un outil existant dans `dist/index.js`, ajoute son schéma Zod, exporte-le.
- **Améliorer un schéma Zod** existant (descriptions plus claires, validations plus strictes).
- **Tests manuels** — utilise un nouvel outil dans Claude Desktop, ouvre une issue avec un rapport "ça marche / ça marche pas / cas non couvert".
- **Documentation** — précise une section du README, ajoute un exemple d'usage concret.
- **Port macOS/Linux** — actuellement les scripts d'auto-push utilisent Windows Task Scheduler. Un port `cron` / `launchd` est très souhaité.

## 🐛 Signaler un bug

Ouvre une [issue](https://github.com/Abdoulrazack1/galactic-brain-mcp/issues) avec :

1. **Quel outil** appelé (`brain_brief`, `brain_advise`, etc.)
2. **Quels arguments** passés
3. **Output reçu** vs **output attendu**
4. **Version** de `galactic-brain-mcp` (`package.json`), Node, OS, Claude Desktop/Code

## 🔀 Proposer une PR

1. **Fork** le repo
2. Crée une branche descriptive : `git checkout -b feat/brain-summarize-tool`
3. **Édite `dist/index.js`** (pas `src/index.ts` — il est obsolète)
4. Teste localement : configure Claude Desktop pour pointer vers ta version
5. Commit avec un message clair : `feat(brain_summarize): nouvelle synthèse multi-source pour les threads`
6. Ouvre la PR contre `main`

## 🧪 Tests

Pas de framework de tests automatisés pour l'instant (les outils sont testés en live dans Claude Desktop). Si tu veux contribuer une suite de tests Vitest/Mocha, c'est très bienvenu.

## 💬 Discussions

Pour les questions générales ou les propositions d'architecture, ouvre une **Discussion** plutôt qu'une issue.

## 📜 Licence

En contribuant, tu acceptes que ton code soit publié sous **MIT** (la licence du projet).
