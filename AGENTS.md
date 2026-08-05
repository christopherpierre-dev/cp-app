# Contraintes du projet Loquivox

À lire avant toute modification du code — que vous soyez humain ou agent.

Ce fichier ne décrit pas l'architecture. Il consigne **les erreurs déjà commises**
et pourquoi il ne faut pas les refaire. Chacune a coûté plusieurs jours.

---

## 1. Un seul canal de sortie audio

```js
// ✗ À ÉVITER — l'application devient muette sur iPhone
const ac = SpeechSDK.AudioConfig.fromDefaultSpeakerOutput();
const s  = new SpeechSDK.SpeechSynthesizer(cfg, ac);

// ✗ Identique : un seul argument = haut-parleur par défaut
const s2 = new SpeechSDK.SpeechSynthesizer(cfg);
```

Safari sur iOS refuse toute lecture audio qui ne découle pas d'un geste de
l'utilisateur. Ces instructions fonctionnent parfaitement sur un ordinateur de
développement et échouent en silence sur la moitié des téléphones.

```js
// ✓ Le chemin recommandé
CPAudio.speak(texte, 'fr');   // cp-meet.js
```

Le moteur récupère l'audio **en données** et le joue dans un unique élément
`<audio>` déverrouillé au premier toucher de l'écran.

**Ce défaut est réapparu trois fois** — à chaque réécriture de `cp-remote.js`
ou d'`index.html`, par des personnes différentes, aucune n'ayant eu de raison
de connaître la contrainte.

C'est pourquoi la protection ne repose plus sur la mémoire de qui écrit le
code. `cp-meet.js` installe un **collecteur** : toute construction d'un
synthétiseur Azure passe par lui, et toute demande de sortie directe est
silencieusement redirigée vers le canal déverrouillé. Le code écrit demain
produit donc du son sur iPhone même si son auteur ignore tout de ce fichier.

Vérification en console : `CPAudio.funnelled` doit valoir `true`.

## 1 bis. Ne pas ajouter un second moteur de synthèse

Deux moteurs ont coexisté début août — celui de `cp-meet.js` et un second
réécrit dans `cp-remote.js`. Les deux réagissaient au même événement, et
l'utilisateur entendait chaque phrase **deux fois**. C'est l'écho signalé en
Remote Call.

`cp-meet.js` refuse désormais de prononcer deux fois la même phrase à moins de
2,5 secondes d'intervalle, quelle que soit l'origine de la demande. Cela
corrige le symptôme — mais deux moteurs restent deux moteurs à maintenir.
Avant d'en écrire un troisième, vérifiez si `CPAudio.speak` ne suffit pas.

## 2. Ne jamais présenter comme réel ce qui est simulé

`runDemoTranslation()` affichait une phrase inventée — « Welcome, how may I
assist you? » — lettre par lettre, comme une vraie traduction. Elle était
appelée depuis le **gestionnaire d'erreur** de la reconnaissance vocale : chaque
panne réelle apparaissait donc comme une réussite, ce qui a rendu les vraies
pannes invisibles pendant des semaines.

Apple et Google refusent les fonctionnalités simulées. Un examinateur qui voit
une traduction sans qu'aucune parole n'ait été prononcée conclut à une
démonstration truquée, et le refus reste inscrit au dossier du compte.

**Règle** : en cas d'échec, afficher ce qui a échoué. Jamais un faux résultat.

## 3. Le créole haïtien ne passe pas par Azure

Aucune voix créole n'existe chez Microsoft, Google ou Amazon — c'est le constat
que documente la recherche de CREDIA, et c'est la singularité du produit.
La synthèse créole passe par **ElevenLabs**, via le point d'accès dédié
(`/api/ht-tts`).

Rediriger `ht` vers une voix française approchée dégrade précisément ce qui
distingue Loquivox. Le moteur de `cp-meet.js` gère ce cas ; ne pas le
court-circuiter.

## 4. Répartition des fichiers

| Fichier | Responsabilité | Précaution |
|---|---|---|
| `index.html` | Interface, écrans, navigation | Ne pas y remettre de logique audio |
| `cp-remote.js` | Réseau, salles, reconnaissance vocale | Ne pas y remettre de synthèse vocale |
| `cp-meet.js` | **Audio, vidéo, clavardage, participants** | À ne pas régénérer automatiquement |
| `sw.js` | Cache — réseau d'abord pour le code | Le cache d'abord fige les appareils |

`cp-meet.js` fonctionne en enveloppant les fonctions globales de l'application
au chargement. Il ne modifie aucun autre fichier : on peut donc travailler sur
`index.html` sans crainte, à condition de **ne pas renommer** `speakCallTTS`,
`speakConf` ni `runDemoTranslation`, et de conserver la balise
`<script src="cp-meet.js">` **avant** l'appel à `CPRemote.on()`.

## 5. Le serveur ne se déploie pas tout seul

`cp-server` est hébergé sur Render **sans déploiement automatique**. Un commit
poussé n'est pas un commit en ligne. Après toute modification :
Render → cp-server → *Manual Deploy* → *Deploy latest commit*.

Vérification : `https://cp-server-kdbg.onrender.com/api/version` doit afficher
la version attendue.

Cette confusion a laissé deux correctifs non déployés pendant onze jours.

## 6. Avant de dire que c'est corrigé

Une correction validée sur un ordinateur ne prouve rien. Les pannes de ce projet
étaient toutes propres à **Safari sur iPhone** ou aux **réseaux différents**.

Minimum : deux appareils, deux réseaux, un iPhone. La grille de recette
(`GRILLE-TEST-avant-soumission.pdf`) énumère les 28 points à vérifier.

## 7. Comment travailler à deux sans se perdre

Le problème n'a jamais été qu'une personne écrase l'autre. C'est que **les deux
écrivent en parallèle sur le même sujet sans le savoir**, et que la deuxième
version arrive en ignorant la première.

Trois habitudes suffisent :

- **Une proposition ne dort pas plus de 24 h.** Plus elle attend, plus l'écart
  avec `main` grandit, et plus la fusion devient risquée. Si vous ne pouvez pas
  la relire, dites-le et fermez-la plutôt que de la laisser en suspens.
- **Repartir de la version à jour**, jamais d'une copie de la veille. Envoyer un
  fichier entier depuis l'interface web remplace tout : ce qui manquait à votre
  copie disparaît.
- **Annoncer le fichier avant d'y toucher.** Le tableau du point 4 dit qui est
  responsable de quoi ; une phrase suffit à éviter une journée de travail en
  double.

---

*Ce fichier est vérifié par le contrôle automatique `.github/workflows/garde-fous.yml`.
Le contrôle distingue deux niveaux : ce qui est **bloquant** (la protection doit
rester en place) et les **plafonds** (les défauts connus ne doivent pas se
multiplier). Les plafonds descendent, jamais l'inverse — quand un compteur
atteint zéro, abaissez-le dans le fichier : c'est acquis.*

*Si vous devez enfreindre une de ces règles, expliquez pourquoi dans la
proposition de modification — ne désactivez pas le contrôle.*
