# Pourquoi je ne poste pas automatiquement sur Reddit / Dev.to / HN / Product Hunt / LinkedIn / Itch.io

Tu m'as demandé de "tout faire". Voilà pourquoi je m'arrête à la frontière des comptes externes, même avec autorisation explicite.

## 🛑 Le mur des credentials

Chacune des plateformes ciblées par les brouillons dans `promo/` nécessite **ton compte connecté**. Les options pour automatiser sont :

| Approche | Risque |
|---|---|
| Tu me tapes ton mot de passe pour que je login | Exposition de credentials dans le contexte d'une session AI → fuite possible via logs/transcripts |
| Tu te logges manuellement puis je drive l'extension Chrome | Faisable si l'extension Claude pour Chrome est active (elle ne l'est pas — `list_connected_browsers` retourne `[]`) |
| Token API officiel (quand il existe) | Reddit/Dev.to ont des APIs, mais : compte développeur à créer, rate-limits agressifs sur nouveaux comptes, et la plupart des plateformes interdisent l'automation utilisateur (ToS) |

## 🚫 Risques réels de bannissement

Les plateformes communautaires détectent et **bannissent** :

- **Reddit** : nouveau compte qui poste sur 5+ subs en 24h = shadowban quasi-garanti. r/programming, r/javascript, r/webdev ont tous des seuils karma+age. Si je poste à ta place, **ton compte personnel peut être banni définitivement** sans appel.
- **Hacker News** : algo très sensible aux upvotes coordonnés et au timing non-humain. Un Show HN raté peut "flag" ton compte pour des mois.
- **Product Hunt** : politique stricte sur les fake upvotes — un launch détecté comme inauthentique = retiré et compte limité.
- **LinkedIn** : automation = violation ToS, suspension du compte.
- **Dev.to** : moins agressif, mais publish 5 articles en 1h = anti-spam.
- **Itch.io** : OK pour upload de jeu, mais le compte développeur c'est toi.

## ⏰ Le timing n'est pas automatisable

Les brouillons dans `promo/` indiquent les **best post times** par sub. Plus important : ce qui fait décoller un post c'est **toi qui réponds aux 3 premiers commentaires dans les 30 minutes**. Aucun script ne peut faire ça avec ta voix.

## 💯 Ce qui maximise ton ROI

1. **Poste toi-même, en suivant les brouillons** — chaque fichier dans `promo/` est prêt à copier-coller
2. **Espace les posts** : 1 plateforme par jour, 1 sub par jour
3. **Réponds en personne** dans les 30 min après publication
4. **Mesure** : note les upvotes / vues / stars par campagne, ajuste

## ✅ Ce que j'ai fait à ta place (qui était sûr)

- Réécriture des 10 README + 4 CONTRIBUTING.md
- Création de 28+ brouillons promo prêts à coller
- Update topics + descriptions sur 8 repos GitHub (via `gh` CLI, ton compte authentifié)
- Capture screenshots des sites GH Pages live (Chrome headless local)
- Embed des screenshots dans portfolio_pro README
- Notification des sites live cassés (safari-frenzy, Kinka CSS) pour que tu puisses corriger

## 📋 Calendrier suggéré (1 semaine)

| Jour | Action | Plateforme | Brouillon |
|---|---|---|---|
| J1 (lundi) | Soumettre Galactic Brain | mcpservers.org/submit | `galactic-brain-mcp/promo/mcpservers-submission.md` |
| J2 (mardi) | Post galactic-brain | r/ClaudeAI | `galactic-brain-mcp/promo/reddit-r-ClaudeAI.md` |
| J3 (mercredi) | Show HN Logic-Lens | news.ycombinator.com | `Logic Lens/promo/hackernews-show.md` |
| J4 (jeudi) | Post galactic-brain | r/LocalLLaMA | `galactic-brain-mcp/promo/reddit-r-LocalLLaMA.md` |
| J5 (vendredi) | Publication article | Dev.to | `galactic-brain-mcp/promo/devto-article.md` |
| J6 (samedi) | Showoff Saturday × 3 repos | r/webdev | `*/promo/reddit-r-webdev.md` |
| J7 (dimanche) | Repos. Mesure. Ajuste. | — | — |

Semaine suivante : Cycling, Inko, Kinka, portfolio_pro, safari-frenzy, Js-Ranker.

## 🤝 Si tu veux quand même que je drive ton navigateur

C'est faisable si :
1. Tu installes/actives l'extension Claude pour Chrome
2. Tu te logges manuellement sur la plateforme
3. Tu me confirmes explicitement dans le chat pour CHAQUE submit

Mais honnêtement : taper Ctrl+C / Ctrl+V dans Reddit est plus rapide que ce setup. Et tu gardes le contrôle sur le timing + ton ton dans les commentaires.

---

**TL;DR** : la valeur que j'ai livré est dans les brouillons. La diffusion est à toi, pour ta propre sécurité et l'efficacité réelle.
