/* ============================================================================
 * cp-meet.js — Salle de réunion : vidéo WebRTC, clavardage traduit,
 *              liste des participants, main levée.
 *
 * MODULE AUTONOME. Aucune modification du reste de l'application n'est
 * nécessaire : une seule ligne suffit dans index.html, placée APRÈS
 * cp-remote.js et AVANT le script principal :
 *
 *     <script src="cp-meet.js"></script>
 *
 * Le module s'enveloppe autour de CPRemote.on() : le gestionnaire d'événements
 * existant continue de recevoir tous les messages, intacts.
 *
 * Pourquoi WebRTC ? La voix originale passait jusqu'ici par le serveur
 * (morceaux MediaRecorder + MediaSource) — un canal que Safari iOS ne sait pas
 * lire. WebRTC établit une connexion directe entre les deux navigateurs :
 * l'iPhone reçoit enfin la vraie voix, et la vidéo devient possible sans
 * charger le serveur, qui ne relaie plus que quelques messages de mise en
 * relation.
 *
 * Limite assumée : connexions directes de pair à pair. Excellent à 2, correct
 * jusqu'à 4-5 participants. Au-delà, il faut un serveur média (SFU) — hors
 * de portée de cette version et documenté comme tel.
 * ==========================================================================*/
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // ── État ──────────────────────────────────────────────────────────────
  const S = {
    selfId: null,
    selfName: 'Moi',
    myLang: 'en',
    peers: new Map(),        // peerId -> RTCPeerConnection
    streams: new Map(),      // peerId -> MediaStream distant
    roster: [],
    localStream: null,       // caméra + micro (vidéo)
    voiceStream: null,       // micro seul (vraie voix par WebRTC)
    videoOn: false,
    micMuted: false,
    handUp: false,
    // Quand chaque main s'est levee : c'est l'ordre de la file de parole.
    handAt: new Map(),
    open: false,             // panneau visible
    tab: 'chat',
    unread: 0,
    booted: false,
    sessionStart: null,      // horodatage de début d'appel (historique réel)
    rosterMax: 0,            // nombre maximal de participants vus pendant l'appel
    ttsMuted: false,         // l'utilisateur a coupé la voix de traduction (🔇)
  };

  const ICE = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ],
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ── Historique réel des conversations ────────────────────────────────
  // L'écran d'accueil affichait trois conversations fictives (« Client call ·
  // 14 min »…). Une donnée inventée qui ne mène nulle part est signalée en
  // revue par Apple et Google, et trompe l'utilisateur. On la remplace par
  // l'historique réel des appels de cet appareil — vide au premier lancement,
  // ce qui est la vérité.
  const HIST_KEY = 'loquivox_sessions';
  const FLAGS = {
    en:'🇺🇸', fr:'🇫🇷', es:'🇪🇸', de:'🇩🇪', pt:'🇵🇹', ar:'🇸🇦', zh:'🇨🇳',
    ja:'🇯🇵', ko:'🇰🇷', ru:'🇷🇺', hi:'🇮🇳', it:'🇮🇹', nl:'🇳🇱', pl:'🇵🇱',
    sv:'🇸🇪', tr:'🇹🇷', ht:'🇭🇹', sw:'🇰🇪', el:'🇬🇷', vi:'🇻🇳',
  };
  const LANG_NAMES = {
    en:'English', fr:'French', es:'Spanish', de:'German', pt:'Portuguese',
    ar:'Arabic', zh:'Chinese', ja:'Japanese', ko:'Korean', ru:'Russian',
    hi:'Hindi', it:'Italian', nl:'Dutch', pl:'Polish', sv:'Swedish',
    tr:'Turkish', ht:'Haitian Creole', sw:'Swahili', el:'Greek', vi:'Vietnamese',
  };

  function loadHist() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveHist(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 10))); } catch (e) {}
  }

  // Ma langue telle que le serveur la connaît : plus fiable que la valeur par
  // défaut du module, car l'utilisateur a pu la changer par un chemin que nous
  // n'interceptons pas.
  function myLangFromRoster() {
    const me = S.roster.find(p => p.id === S.selfId);
    return (me && me.lang) || S.myLang;
  }

  function recordSessionEnd() {
    if (!S.sessionStart) return;
    const mins = Math.round((Date.now() - S.sessionStart) / 60000);
    const others = [...new Set(S.roster.filter(p => p.id !== S.selfId).map(p => p.lang))].filter(Boolean);
    S.sessionStart = null;
    if (!others.length && mins < 1) return; // appel avorté : ne rien inscrire
    const list = loadHist();
    list.unshift({
      from: myLangFromRoster(), to: others[0] || null,
      peers: Math.max(S.rosterMax - 1, 0), mins, at: Date.now(),
    });
    saveHist(list);
    renderRecent();
    reportSession('remote', myLangFromRoster(), Math.max(S.rosterMax, 1), mins);
  }

  /* ────────────────────────────────────────────────────────────────────
   * STATISTIQUES ANONYMES (CREDIA — tableau de bord)
   *
   * Un seul signal par session terminée : le mode, la langue d'écoute,
   * le nombre de participants, la durée. Rien d'autre. Aucun contenu de
   * conversation, aucun nom, aucune position précise ne quitte l'appareil.
   *
   * L'identifiant d'installation est tiré au hasard localement : il permet
   * de distinguer un appareil d'un autre pour compter les utilisateurs
   * actifs, sans jamais dire de qui il s'agit. L'utilisateur peut le
   * remettre à zéro en effaçant les données du site.
   *
   * L'envoi passe par sendBeacon : il n'attend pas de réponse et ne peut
   * pas ralentir l'application. En cas d'échec, on n'insiste pas.
   * ──────────────────────────────────────────────────────────────────── */
  const STATS_URL = 'https://iuac.ca/loquivox-stats/collect.php';
  const INSTALL_KEY = 'loquivox_install_id';

  function installId() {
    try {
      let id = localStorage.getItem(INSTALL_KEY);
      if (!/^[a-f0-9]{32}$/.test(id || '')) {
        const b = new Uint8Array(16);
        (window.crypto || {}).getRandomValues
          ? crypto.getRandomValues(b)
          : b.forEach((_, i) => b[i] = Math.floor(Math.random() * 256));
        id = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(INSTALL_KEY, id);
      }
      return id;
    } catch (_) { return null; }
  }

  function reportSession(mode, lang, peers, mins) {
    try {
      const body = JSON.stringify({
        mode: mode || 'remote',
        lang: String(lang || '').slice(0, 12),
        peers: Math.max(1, Math.min(200, peers | 0)),
        mins: Math.max(0, Math.min(720, mins | 0)),
        install: installId(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(STATS_URL, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(STATS_URL, { method: 'POST', body, keepalive: true }).catch(() => {});
      }
    } catch (_) { /* les statistiques ne doivent jamais gêner l'appel */ }
  }

  // Exposé pour les deux autres modes, qui vivent dans index.html
  window.CPStats = { report: reportSession };

  function whenLabel(ts) {
    const d = Math.floor((Date.now() - ts) / 86400000);
    if (d <= 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderRecent() {
    const el = document.querySelector('.recent-list');
    if (!el) return;
    const list = loadHist();

    if (!list.length) {
      el.innerHTML = '<div style="padding:18px 6px;color:#7f8db0;font-size:13px;'
        + 'line-height:1.5;text-align:center">No conversations yet.<br>'
        + 'Your calls will appear here.</div>';
      return;
    }

    el.innerHTML = list.map(s => {
      const f = FLAGS[s.from] || '🌐';
      const t = s.to ? (FLAGS[s.to] || '🌐') : '';
      const names = LANG_NAMES[s.from] || (s.from || '').toUpperCase();
      const title = s.to ? `${names} → ${LANG_NAMES[s.to] || s.to.toUpperCase()}` : names;
      const dur = s.mins < 1 ? 'under a minute' : `${s.mins} min`;
      const detail = s.peers > 1
        ? `Conference · ${s.peers + 1} participants · ${dur}`
        : `Call · ${dur}`;
      return `<div class="recent-item">
        <div class="lang-flags">${f}${t ? '&nbsp;→&nbsp;' + t : ''}</div>
        <div class="recent-info"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>
        <div class="recent-time">${whenLabel(s.at)}</div>
      </div>`;
    }).join('');
  }

  const send = (obj) => {
    try {
      const R = window.CPRemote;
      if (R && typeof R.sendRaw === 'function') R.sendRaw(obj);
    } catch (e) {}
  };

  /* ────────────────────────────────────────────────────────────────────
   * VOIX DE TRADUCTION — reprise en main
   *
   * Le module de base fait parler Azure via
   * AudioConfig.fromDefaultSpeakerOutput(). Safari iOS refuse cette sortie
   * directe tant qu'aucun geste utilisateur n'a débloqué l'audio : le texte
   * s'affiche, aucun son ne sort. C'est la panne « Remote Call ne parle pas ».
   *
   * Contournement éprouvé : on demande à Azure l'audio *en données* (MP3),
   * puis on le joue dans UN élément <audio> déverrouillé au premier toucher.
   * Ce même élément, une fois autorisé, joue tout le reste de la session.
   *
   * On désactive la voix du module de base pour éviter de parler deux fois.
   * ──────────────────────────────────────────────────────────────────── */
  const TTS_VOICES = {
    fr:'fr-CA-JeanNeural',   en:'en-US-GuyNeural',    es:'es-MX-JorgeNeural',
    de:'de-DE-ConradNeural', pt:'pt-BR-AntonioNeural', ar:'ar-SA-HamedNeural',
    zh:'zh-CN-YunxiNeural',  ja:'ja-JP-KeitaNeural',   ko:'ko-KR-InJoonNeural',
    ru:'ru-RU-DmitryNeural', hi:'hi-IN-MadhurNeural',  it:'it-IT-DiegoNeural',
    nl:'nl-NL-MaartenNeural',pl:'pl-PL-MarekNeural',   sv:'sv-SE-MattiasNeural',
    tr:'tr-TR-AhmetNeural',  ht:'fr-CA-JeanNeural',    sw:'sw-KE-RafikiNeural',
    el:'el-GR-NestorasNeural', vi:'vi-VN-NamMinhNeural',
  };
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  let ttsAudio = null, ttsUnlocked = false, ttsQueue = Promise.resolve(), ttsOwned = false;

  /* Dernier echec de lecture, pour que le bandeau puisse l'expliquer.
   *
   * On a passe des heures a chercher pourquoi « le son ne sort pas », sans
   * jamais savoir si le navigateur refusait, si le media ne se chargeait
   * pas, ou si rien n'etait meme tente. L'information existait a chaque
   * fois — elle n'etait simplement ecrite nulle part. */
  let dernierEchecAudio = null;

  function diagAudio(motif, a) {
    dernierEchecAudio = {
      motif,
      etat: a ? a.readyState : -1,     // 0 = rien charge, 4 = pret
      arret: a ? !!a.paused : null,
      position: a ? Math.round((a.currentTime || 0) * 100) / 100 : null,
      erreur: (a && a.error) ? a.error.code : null,
      quand: Date.now(),
    };
    console.warn('[cp-meet] audio —', motif, JSON.stringify(dernierEchecAudio));
    try { majBandeauLangue(); } catch (_) {}
  }

  function ensureAudioEl() {
    if (!ttsAudio) {
      ttsAudio = new Audio();
      ttsAudio.setAttribute('playsinline', '');
      ttsAudio.autoplay = false;
      // Un element detache du document est traite de facon inegale selon
      // les navigateurs. On l'attache, invisible : cela ne coute rien et
      // supprime une variable dans une chaine deja difficile a observer.
      try {
        if (ttsAudio.style) {
          ttsAudio.style.cssText = 'position:absolute;width:0;height:0;opacity:0';
        }
        if (document.body && document.body.appendChild) document.body.appendChild(ttsAudio);
      } catch (_) {}
    }
    return ttsAudio;
  }

  // Doit être appelé DEPUIS un geste utilisateur (toucher, clic).
  function unlockAudio() {
    if (ttsUnlocked) return;            // ne jamais couper une voix en cours
    try {
      const a = ensureAudioEl();
      a.src = SILENT_WAV;
      a.play().then(() => { ttsUnlocked = true; }).catch(() => {});
    } catch (_) {}
  }

  async function azureCreds() {
    const base = (window.CP_SERVER || SERVER).replace(/\/+$/, '');
    const r = await fetch(base + '/api/token');
    if (!r.ok) throw new Error('token ' + r.status);
    return r.json();                     // {token, region}
  }

  /* ────────────────────────────────────────────────────────────────────
   * CANAL DE SORTIE UNIQUE
   *
   * Tout son produit par l'application est joué ici, dans l'élément
   * déverrouillé au premier geste de l'utilisateur. Une seule fonction, un
   * seul élément : c'est ce qui rend le son audible sur iPhone, et c'est
   * aussi ce qui garantit qu'on ne parle jamais deux fois en même temps.
   * ──────────────────────────────────────────────────────────────────── */
  function playBytes(buf, mime) {
    return new Promise((resolve) => {
      try {
        if (!buf || !buf.byteLength) return resolve();
        const a = ensureAudioEl();
        const url = URL.createObjectURL(new Blob([buf], { type: mime || 'audio/mpeg' }));

        // Garde-fou : si la fin de lecture n'est jamais signalée, la file
        // resterait bloquée et plus aucune phrase ne serait prononcée du
        // reste de la session. On libère au plus tard après 30 secondes.
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          duckVoices(false);                      // la vraie voix reprend son volume
          try { URL.revokeObjectURL(url); } catch (_) {}
          clearTimeout(guard);
          resolve();
        };
        /* Le garde-fou etait a 30 secondes. Trop long : la file etant
         * serielle, une seule lecture qui ne se termine jamais rendait
         * l'application muette pendant une demi-minute — et comme les
         * phrases s'enchainent, elle paraissait muette tout court. On
         * libere apres 10 secondes, ce qui depasse largement la duree
         * d'une phrase traduite. */
        const guard = setTimeout(() => {
          diagAudio('lecture jamais terminee', a);
          finish();
        }, 10000);

        /* Si la lecture n'a meme pas commence au bout d'une seconde et
         * demie, ce n'est pas de la lenteur : c'est un blocage. On le note
         * pour que le bandeau puisse le dire, au lieu de laisser
         * l'utilisateur devant un silence sans explication. */
        const veille = setTimeout(() => {
          if (a.paused || !a.currentTime) diagAudio('lecture bloquee', a);
        }, 1500);
        const finishAvecVeille = () => { clearTimeout(veille); finish(); };

        duckVoices(true);                         // la vraie voix passe dessous
        a.src = url;
        a.onended = finishAvecVeille;
        a.onerror = () => { diagAudio('erreur de lecture', a); finishAvecVeille(); };
        const p = a.play();
        if (p && p.catch) p.catch((e) => {
          diagAudio('refus du navigateur : ' + (e && e.name), a);
          finishAvecVeille();
        });
      } catch (_) { resolve(); }
    });
  }

  /* ── Anti-doublon ─────────────────────────────────────────────────────
   * Deux moteurs de synthèse ont coexisté dans le projet : celui de ce
   * fichier et celui réécrit ensuite dans cp-remote.js. Quand les deux
   * demandent la même phrase, l'utilisateur l'entend deux fois — c'est
   * l'écho signalé en Remote Call.
   *
   * Plutôt que de traquer chaque appelant, on refuse simplement de
   * prononcer deux fois la même phrase dans la même langue à quelques
   * secondes d'intervalle. La règle ne dépend d'aucun fichier : elle tient
   * même si le code d'en face est réécrit demain.
   * ──────────────────────────────────────────────────────────────────── */
  // La clé ne retient QUE le texte : les deux moteurs n'étiquettent pas la
  // langue de la même façon, et comparer sur la langue laisserait passer le
  // doublon. La fenêtre est courte — un écho est simultané, les deux moteurs
  // réagissant au même événement. Deux personnes qui disent « merci » à trois
  // secondes d'intervalle restent donc bien entendues toutes les deux.
  const DEDUPE_MS = 2500;
  const spokenAt = new Map();

  function alreadySpoken(text) {
    const key = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return false;
    const now = Date.now();
    for (const [k, t] of spokenAt) if (now - t > DEDUPE_MS) spokenAt.delete(k);
    if (spokenAt.has(key)) {
      console.info('[cp-meet] doublon ignoré — phrase déjà prononcée à l\'instant');
      return true;
    }
    spokenAt.set(key, now);
    return false;
  }

  // Créole haïtien : aucune voix Azure n'existe pour cette langue. L'application
  // utilise ElevenLabs via un point d'accès dédié. On récupère le MP3 et on le
  // joue dans le même élément déverrouillé que le reste — la version d'origine
  // passait par AudioContext, qui souffre du même blocage iOS que le SDK.
  const HT_TTS = 'https://cp-app-rho.vercel.app/api/ht-tts?text=';

  function speakCreole(text) {
    ttsQueue = ttsQueue.then(async () => {
      try {
        const r = await fetch(HT_TTS + encodeURIComponent(text));
        if (!r.ok) { console.warn('[cp-meet] voix créole indisponible :', r.status); return; }
        await playBytes(await r.arrayBuffer());
      } catch (e) {
        console.warn('[cp-meet] voix créole :', e && e.message);
      }
    });
    return ttsQueue;
  }

  function speakText(text, lang) {
    if (!text) return;
    if (alreadySpoken(text)) return;
    if (String(lang || '').toLowerCase().split('-')[0] === 'ht') return speakCreole(text);
    if (!window.SpeechSDK) return;
    ttsQueue = ttsQueue.then(() => new Promise(async (resolve) => {
      try {
        const { token, region } = await azureCreds();
        const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
        cfg.speechSynthesisVoiceName = TTS_VOICES[lang] || 'en-US-GuyNeural';
        cfg.speechSynthesisOutputFormat =
          SpeechSDK.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

        // audioConfig = null : Azure renvoie les octets au lieu de jouer
        const synth = new SpeechSDK.SpeechSynthesizer(cfg, null);
        // Chemin interne : cette fonction possede deja la file et la
        // lecture. L'enveloppe posee sur le prototype doit s'effacer.
        synth.__cpmInterne = true;
        synth.speakTextAsync(text, (r) => {
          synth.close();
          playBytes(r && r.audioData).then(resolve);
        }, (err) => { console.warn('[cp-meet] TTS:', err); synth.close(); resolve(); });
      } catch (err) {
        console.warn('[cp-meet] TTS init:', err && err.message);
        resolve();
      }
    }));
  }

  // Prononce la traduction reçue, dans la langue d'écoute de cet appareil
  function speakIncoming(m) {
    if (!ttsOwned) return;
    if (S.ttsMuted) return;
    const lang = myLangFromRoster();
    const text = m && m.translations ? m.translations[lang] : null;
    if (text) speakText(text, lang);
  }

  /* ────────────────────────────────────────────────────────────────────
   * MOTEUR AUDIO UNIQUE POUR LES TROIS MODES
   *
   * Two-Way Call, Conference et Remote Call avaient chacun leur propre code
   * de synthèse, et tous les trois utilisaient
   * AudioConfig.fromDefaultSpeakerOutput() — la sortie que Safari iOS bloque.
   * Trois copies du même défaut, d'où « aucun son nulle part ».
   *
   * On remplace ici les fonctions globales de l'application par une seule
   * implémentation, celle qui fonctionne sur tous les appareils. Aucun
   * fichier n'est modifié : les fonctions concernées sont globales, on les
   * réassigne.
   * ──────────────────────────────────────────────────────────────────── */
  /* ────────────────────────────────────────────────────────────────────
   * COLLECTEUR DE SYNTHÈSE — la protection qui ne dépend de personne
   *
   * Remplacer les fonctions de l'application une par une ne protège que
   * les fonctions qu'on connaît. À chaque réécriture, une nouvelle
   * apparaît, redemande la sortie directe, et l'iPhone redevient muet :
   * c'est arrivé trois fois.
   *
   * On intervient donc une couche plus bas. Toute construction d'un
   * synthétiseur Azure passe désormais par ici. Si l'appelant demande le
   * haut-parleur — explicitement, ou en omettant le second paramètre, ce
   * qui revient au même — on le lui refuse et on joue nous-mêmes les
   * octets dans le canal déverrouillé.
   *
   * Conséquence : le code écrit demain, par qui que ce soit, produit du
   * son sur iPhone sans avoir à connaître cette contrainte.
   * ──────────────────────────────────────────────────────────────────── */
  /* Le paquet Azure expose ses classes en accesseurs SANS setter et NON
   * reconfigurables. Reaffecter la classe echoue donc EN SILENCE : aucune
   * exception, la propriete ne bouge pas. Le collecteur se croyait installe
   * sans l'etre — d'ou l'absence totale de son en Remote Call.
   * On vise desormais deux objets reellement modifiables (verifie en
   * production) : AudioConfig.fromDefaultSpeakerOutput, et le PROTOTYPE de
   * SpeechSynthesizer. Et l'installation est VERIFIEE avant d'etre declaree. */
  function installSynthFunnel() {
    const SDK = window.SpeechSDK;
    if (!SDK || typeof SDK.SpeechSynthesizer !== 'function') return false;
    try {
      const AC = SDK.AudioConfig;
      if (AC && typeof AC.fromDefaultSpeakerOutput === 'function'
          && !AC.fromDefaultSpeakerOutput.__cpm) {
        const muet = function () { return null; };
        muet.__cpm = true; muet.__orig = AC.fromDefaultSpeakerOutput;
        AC.fromDefaultSpeakerOutput = muet;
      }
    } catch (_) {}
    const P = SDK.SpeechSynthesizer.prototype;
    if (P.speakTextAsync && P.speakTextAsync.__cpm) return true;
    const enveloppe = (nom, dedupe) => {
      const orig = P[nom];
      if (typeof orig !== 'function' || orig.__cpm) return;
      const patched = function (arg, cb, errCb) {
        // Nos propres appels gerent deja file et lecture. Les intercepter
        // ici jouerait deux fois — et enchainerait ttsQueue sur elle-meme,
        // ce qui fige la voix des le deuxieme enonce.
        if (this.__cpmInterne) return orig.call(this, arg, cb, errCb);
        if (!this.__cpmMuet) {
          this.__cpmMuet = true;
          for (const champ of ['privAudioConfig', 'audioConfig', 'audioCfg']) {
            try { if (this[champ] != null) this[champ] = null; } catch (_) {}
          }
        }
        if (dedupe && alreadySpoken(arg)) {
          if (typeof cb === 'function') cb({ audioData: new ArrayBuffer(0) });
          return;
        }
        return orig.call(this, arg, (r) => {
          ttsQueue = ttsQueue.then(() => playBytes(r && r.audioData));
          if (typeof cb === 'function') { try { cb(r); } catch (_) {} }
        }, errCb);
      };
      patched.__cpm = true; patched.__orig = orig;
      P[nom] = patched;
    };
    enveloppe('speakTextAsync', true);
    enveloppe('speakSsmlAsync', false);
    return !!(P.speakTextAsync && P.speakTextAsync.__cpm);
  }

  /* ────────────────────────────────────────────────────────────────────
   * TRADUCTION QUASI SIMULTANÉE (Two-Way Call)
   *
   * La restauration du 4 août a effacé l'affichage de la traduction
   * pendant la parole : l'utilisateur ne voyait plus la traduction
   * qu'après avoir fini sa phrase. Azure fournit pourtant des traductions
   * partielles dans chaque événement « recognizing ».
   *
   * On intervient au même niveau que le collecteur de synthèse : toute
   * construction d'un TranslationRecognizer est enveloppée, et son
   * gestionnaire « recognizing » est enrichi pour afficher la traduction
   * partielle au fil de la parole. La protection vit ici, pas dans
   * index.html — une réécriture de ce dernier ne peut plus l'effacer.
   * ──────────────────────────────────────────────────────────────────── */
  function partialTranslationOf(e) {
    try {
      const r = e && e.result;
      if (!r || !r.translations) return null;
      const langs = r.translations.languages || [];
      for (const l of langs) { const v = r.translations.get(l); if (v) return v; }
    } catch (_) {}
    return null;
  }

  function showLivePartial(e) {
    const call = document.getElementById('call');
    if (!call || !call.classList.contains('active')) return;   // Two-Way seulement
    const txt = partialTranslationOf(e);
    if (!txt) return;
    const el = document.getElementById('transA');
    if (el) { el.textContent = txt; el.style.opacity = '.8'; }
  }

  // Meme contrainte : le constructeur n'est pas remplacable. On accroche
  // l'affichage partiel au demarrage de la reconnaissance, sur le prototype.
  function installRecognizerFunnel() {
    const SDK = window.SpeechSDK;
    if (!SDK || typeof SDK.TranslationRecognizer !== 'function') return false;
    const P = SDK.TranslationRecognizer.prototype;
    if (!P || typeof P.startContinuousRecognitionAsync !== 'function') return false;
    if (P.startContinuousRecognitionAsync.__cpm) return true;
    const orig = P.startContinuousRecognitionAsync;
    const patched = function (cb, errCb) {
      try {
        if (!this.__cpmPartial) {
          this.__cpmPartial = true;
          const sien = this.recognizing;
          this.recognizing = function (s, e) {
            try { showLivePartial(e); } catch (_) {}
            if (typeof sien === 'function') { try { sien.call(this, s, e); } catch (_) {} }
          };
        }
      } catch (_) {}
      return orig.call(this, cb, errCb);
    };
    patched.__cpm = true; patched.__orig = orig;
    P.startContinuousRecognitionAsync = patched;
    return !!P.startContinuousRecognitionAsync.__cpm;
  }

  /* ────────────────────────────────────────────────────────────────────
   * DEUX RÉPARATIONS D'INTERFACE effacées par la restauration du 4 août
   *
   * 1. Conference : les sélecteurs de langue étaient repassés SOUS le
   *    transcript. On les remonte au-dessus, par déplacement du DOM —
   *    aucun contenu n'est modifié, seulement l'ordre.
   *
   * 2. Remote Call : le choix « je parle » avait disparu du modal. On y
   *    réinjecte un sélecteur complet, et le choix est transmis à
   *    CPRemote au moment de créer ou de rejoindre une salle.
   * ──────────────────────────────────────────────────────────────────── */
  /* Mesure du 7 aout 2026 en production : .conf-transcript a 782 px,
   * .conf-start-btn a 981 px. Les selecteurs de langue etaient donc SOUS le
   * texte. La version precedente remontait le bloc frere entier, ce qui
   * aurait aussi remonte le bouton Demarrer. On deplace les seuls
   * selecteurs, dans un conteneur insere avant le transcript. */
  /* Mesure du 7 aout 2026 en production : les selecteurs de langue etaient
   * SOUS le transcript. On les remonte, dans un conteneur dedie insere
   * avant lui. Le bouton Demarrer reste ou il est. */
  function fixConferenceLayout() {
    const tr = document.getElementById('confTranscript');
    if (!tr) return;
    const conf = document.getElementById('conference');
    if (!conf) return;
    let blocTr = tr;
    while (blocTr && blocTr.parentElement !== conf) blocTr = blocTr.parentElement;
    if (!blocTr) return;

    let boite = document.getElementById('cpmConfLangs');
    if (!boite) {
      boite = document.createElement('div');
      boite.id = 'cpmConfLangs';
      boite.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 24px 10px;flex-wrap:wrap;';
      conf.insertBefore(boite, blocTr);
    }

    /* Ne deplacer QUE le vrai selecteur, et avec son etiquette.
     *
     * Premiere version : on deplacait confSrcLang ET confVoiceSel. Mesure
     * ensuite en production, c'etait faux sur les deux plans.
     *
     *   confVoiceSel  <select> « Listen in », enferme dans un <div> avec son
     *                 <label>. Deplacer le seul <select> laissait
     *                 l'etiquette orpheline en bas de l'ecran.
     *   confSrcLang   n'est PAS un selecteur : c'est un <b> au milieu de la
     *                 phrase « You speak <b>English</b> — the room reads you
     *                 live… ». Le deplacer arrachait un mot a sa phrase.
     *
     * On deplace donc le bloc entier qui porte confVoiceSel, et on laisse
     * confSrcLang tranquille. */
    const sel = document.getElementById('confVoiceSel');
    if (sel && !boite.contains(sel)) {
      let bloc = sel;
      while (bloc.parentElement && bloc.parentElement !== conf
             && bloc.parentElement.id !== 'cpmConfLangs'
             && bloc.parentElement.children.length <= 3) bloc = bloc.parentElement;
      boite.appendChild(bloc.parentElement === conf ? sel : bloc);
    }

    // Reparation : si une version anterieure a sorti confSrcLang de sa
    // phrase, on l'y remet, juste avant le fragment « — the room reads… ».
    const b = document.getElementById('confSrcLang');
    const hint = document.getElementById('confHint');
    if (b && hint && !hint.contains(b)) {
      const tiret = [...hint.childNodes].find(
        (n) => n.nodeType === 3 && /^\s*—/.test(n.textContent || ''));
      hint.insertBefore(b, tiret || null);
    }

    installConfChair();
  }

  /* ────────────────────────────────────────────────────────────────────
   * TOUR DE PAROLE (Conference — un seul appareil)
   *
   * Autour d'une table, le micro est commun : on ne peut pas couper celui
   * des autres. La présidence y prend donc la forme d'un tour de parole :
   * la personne qui tient l'appareil ajoute les intervenants (nom +
   * langue) ; toucher un nom affiche « la parole est à X » et bascule
   * automatiquement la reconnaissance vocale dans la langue de X — plus
   * besoin de manipuler le sélecteur entre chaque orateur. La main se
   * lève physiquement ; l'application tient l'ordre et la langue.
   * ──────────────────────────────────────────────────────────────────── */
  const CONF_KEY = 'loquivox_conf_speakers';

  /* D'ou vient la liste des langues, et comment on donne la parole.
   *
   * La premiere version cherchait un <select> nomme confSrcLang. Mesure en
   * production le 7 aout 2026 : confSrcLang est un <b>, pas un menu. Le
   * garde-fou « structure inattendue » sortait donc a chaque fois et le
   * panneau n'apparaissait jamais. Il refusait de casser quoi que ce soit,
   * ce qui etait juste — mais il ne cherchait pas le bon element.
   *
   * L'ecran Conference possede deja ce qu'il faut : les cartes #pl-en,
   * #pl-fr, #pl-ht… portent chacune onclick="setConfSpeaker(nom, drapeau)".
   * Donner la parole revient donc a cliquer la carte de la langue de
   * l'intervenant — on emprunte le chemin de l'application au lieu d'en
   * inventer un second. */
  function languesDeLaSalle() {
    return [...document.querySelectorAll('[id^="pl-"]')].map((carte) => {
      const oc = carte.getAttribute('onclick') || '';
      const m = oc.match(/setConfSpeaker\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
      const code = carte.id.replace(/^pl-/, '');
      const label = (carte.textContent || '').trim().split(/\s+/).slice(0, 2).join(' ');
      return { code, nom: m ? m[1] : label, drapeau: m ? m[2] : '',
               label: (m ? (m[2] + ' ' + m[1]) : label).trim() };
    });
  }

  function installConfChair() {
    if (document.getElementById('cpmConfChair')) return;
    const boite = document.getElementById('cpmConfLangs');
    if (!boite || !boite.parentElement) return;
    const langues = languesDeLaSalle();
    if (!langues.length) return;          // ecran pas encore construit

    let speakers = [];
    try { speakers = JSON.parse(localStorage.getItem(CONF_KEY) || '[]'); } catch (_) {}
    let current = -1;

    const wrap = document.createElement('div');
    wrap.id = 'cpmConfChair';
    wrap.style.cssText = 'margin:10px 24px;padding:12px;border:1px solid #1e2d4a;'
      + 'border-radius:14px;background:#131929;';
    wrap.innerHTML =
      '<div style="font-size:12px;color:#8fa0bd;letter-spacing:.5px;text-transform:uppercase;'
      + 'margin-bottom:8px;">Tour de parole</div>'
      + '<div id="cpmConfChips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;"></div>'
      + '<div style="display:flex;gap:6px;">'
      + '<input id="cpmConfName" placeholder="Nom de l\'intervenant" style="flex:1;min-width:0;'
      + 'background:rgba(255,255,255,.05);border:1px solid #1e2d4a;border-radius:10px;'
      + 'padding:8px 10px;color:#e8edf5;font-size:13px;">'
      + '<select id="cpmConfLang" style="background:rgba(255,255,255,.05);border:1px solid #1e2d4a;'
      + 'border-radius:10px;padding:8px;color:#e8edf5;font-size:13px;max-width:38%">'
      + langues.map(l => '<option value="' + l.code + '">' + l.label + '</option>').join('')
      + '</select>'
      + '<button id="cpmConfAdd" style="border:none;border-radius:10px;padding:8px 12px;'
      + 'background:#28304a;color:#e8edf5;font-size:13px;cursor:pointer">+</button></div>';
    // Juste au-dessus des selecteurs de langue, donc au-dessus du transcript.
    boite.parentElement.insertBefore(wrap, boite);

    const chips = wrap.querySelector('#cpmConfChips');

    function save() { try { localStorage.setItem(CONF_KEY, JSON.stringify(speakers)); } catch (_) {} }

    function giveFloor(i) {
      current = (current === i) ? -1 : i;
      if (current >= 0) {
        const s = speakers[current];
        // On clique la carte de langue de l'intervenant : c'est le chemin
        // que l'application emprunte elle-meme (setConfSpeaker), donc le
        // seul dont on soit sur qu'il reste juste si l'ecran evolue.
        const carte = document.getElementById('pl-' + s.lang);
        if (carte) { try { carte.click(); } catch (_) {} }
        floorBar('La parole est a ' + s.name + ' (' + s.langLabel + ')', false);
      } else {
        floorBar(null);
      }
      draw();
    }

    function draw() {
      chips.innerHTML = speakers.map((s, i) =>
        '<span data-i="' + i + '" style="cursor:pointer;padding:6px 12px;border-radius:16px;font-size:13px;'
        + 'border:1px solid ' + (i === current ? '#57c46b' : 'rgba(255,255,255,.15)') + ';'
        + 'background:' + (i === current ? 'rgba(87,196,107,.15)' : 'rgba(255,255,255,.05)') + ';color:#e8edf5;">'
        + (i === current ? '&#127908; ' : '') + s.name + ' · ' + s.langLabel
        + '<b data-del="' + i + '" style="margin-left:6px;color:#8fa0bd;cursor:pointer">&times;</b></span>').join('')
        || '<span style="font-size:12px;color:#64748b">Ajoutez les intervenants, puis touchez un nom pour lui donner la parole.</span>';
      chips.querySelectorAll('[data-i]').forEach(el => {
        el.onclick = (ev) => {
          if (ev.target && ev.target.dataset && ev.target.dataset.del !== undefined) {
            const d = parseInt(ev.target.dataset.del, 10);
            speakers.splice(d, 1);
            if (current === d) { current = -1; floorBar(null); }
            else if (current > d) current--;
            save(); draw(); return;
          }
          giveFloor(parseInt(el.dataset.i, 10));
        };
      });
    }

    wrap.querySelector('#cpmConfAdd').onclick = () => {
      const nameEl = wrap.querySelector('#cpmConfName');
      const langEl = wrap.querySelector('#cpmConfLang');
      const name = (nameEl.value || '').trim();
      if (!name) return;
      speakers.push({ name, lang: langEl.value,
                      langLabel: langEl.options[langEl.selectedIndex].textContent.trim() });
      nameEl.value = '';
      save(); draw();
    };

    draw();
  }

  const SPEAK_LANGS = [
    ['fr','fr-FR','Français'],       ['en','en-US','English'],
    ['ht','fr-HT','Kreyòl ayisyen'], ['es','es-ES','Español'],
    ['de','de-DE','Deutsch'],        ['pt','pt-BR','Português'],
    ['ar','ar-SA','العربية'],        ['zh-Hans','zh-CN','中文'],
    ['ru','ru-RU','Русский'],        ['it','it-IT','Italiano'],
    ['ja','ja-JP','日本語'],          ['ko','ko-KR','한국어'],
    ['sw','sw-KE','Kiswahili'],      ['nl','nl-NL','Nederlands'],
    ['pl','pl-PL','Polski'],         ['tr','tr-TR','Türkçe'],
    ['vi','vi-VN','Tiếng Việt'],     ['hi','hi-IN','हिन्दी'],
  ];
  const SPEAK_KEY = 'loquivox_my_lang';

  function chosenSpeak() {
    const sel = document.getElementById('cpmSpeakSel');
    const code = (sel && sel.value) || localStorage.getItem(SPEAK_KEY) || 'fr';
    const row = SPEAK_LANGS.find(r => r[0] === code) || SPEAK_LANGS[0];
    return { lang: row[0], speechLang: row[1] };
  }

  function installSpeakPicker() {
    const modal = document.getElementById('remoteModal');
    const anchor = document.getElementById('joinCodeInput');
    if (!modal || !anchor || document.getElementById('cpmSpeakSel')) return;
    const saved = localStorage.getItem(SPEAK_KEY) || 'fr';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:10px 0 4px;';
    wrap.innerHTML =
      '<label style="display:block;font-size:12px;color:#8fa0bd;margin-bottom:5px;">'
      + 'Je parle / I speak</label>'
      + '<select id="cpmSpeakSel" style="width:100%;padding:10px 12px;border-radius:10px;'
      + 'background:rgba(255,255,255,.05);border:1px solid #1e2d4a;color:#e8edf5;font-size:14px;">'
      + SPEAK_LANGS.map(r =>
          '<option value="' + r[0] + '"' + (r[0] === saved ? ' selected' : '') + '>'
          + r[2] + '</option>').join('')
      + '</select>';
    anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
    // On ecrit le choix par defaut des l'affichage : sans cela rien n'est
    // memorise tant que l'utilisateur n'a pas touche au menu, et la langue
    // depend alors d'un menu qu'il n'a peut-etre jamais ouvert.
    try { if (!localStorage.getItem(SPEAK_KEY)) localStorage.setItem(SPEAK_KEY, saved); } catch (_) {}
    wrap.querySelector('select').addEventListener('change', (ev) => {
      localStorage.setItem(SPEAK_KEY, ev.target.value);
      const c = chosenSpeak();
      try { window.CPRemote && CPRemote.setLanguage && CPRemote.setLanguage(c.lang, c.speechLang); } catch (_) {}
      majBandeauLangue();
    });
  }

  /* Un bandeau qui dit ce qui se passe.
   *
   * Il existe parce qu'on m'a demande, le 9 aout 2026, si la langue avait
   * ete choisie et si l'ecran avait ete touche avant la premiere phrase —
   * et que personne ne pouvait repondre. Rien a l'ecran ne l'indiquait.
   * Une application qui ne montre pas son etat oblige a deviner.
   *
   * Il affiche la langue de parole reellement transmise a la salle, et si
   * le canal audio est deverrouille. Le toucher le deverrouille : c'est un
   * geste utilisateur, donc le navigateur l'autorise. */
  function majBandeauLangue() {
    const salle = document.getElementById('remote') || document.getElementById('meetRoot');
    const actif = !!(window.CPRemote && CPRemote.room);
    let el = document.getElementById('cpmLangBadge');
    if (!actif) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'cpmLangBadge';
      el.style.cssText = 'position:fixed;left:12px;bottom:96px;z-index:9998;'
        + 'padding:7px 12px;border-radius:14px;font-size:12px;cursor:pointer;'
        + 'background:rgba(11,17,32,.92);border:1px solid #1e2d4a;color:#e8edf5;';
      el.onclick = () => { try { unlockAudio(); } catch (_) {} setTimeout(majBandeauLangue, 400); };
      (salle || document.body).appendChild(el);
    }
    const c = chosenSpeak();
    const nom = (SPEAK_LANGS.find(r => r[0] === c.lang) || [,, c.lang])[2];
    const pret = !!(window.CPAudio && window.CPAudio.ready);
    // Si une lecture a echoue recemment, on dit pourquoi. Un silence sans
    // explication est ce qui coute le plus cher a diagnostiquer.
    const e = dernierEchecAudio;
    const recent = e && (Date.now() - e.quand < 60000);
    const detail = recent
      ? '<div style="margin-top:4px;font-size:11px;color:#f0b429">'
        + esc(e.motif) + ' &middot; media ' + e.etat + '/4'
        + (e.erreur ? ' &middot; err ' + e.erreur : '') + '</div>'
      : '';
    el.innerHTML = 'Vous parlez : <b>' + nom + '</b> &nbsp;&middot;&nbsp; son '
      + (pret ? 'actif' : '<b style="color:#f0b429">bloque — touchez ici</b>')
      + detail;
  }

  /* Pourquoi le choix de langue s'applique desormais TOUJOURS.
   *
   * La premiere version ne l'appliquait que si le modal Remote Call etait
   * encore ouvert au moment de l'appel. Condition fragile : le modal se
   * referme souvent avant que create() ne s'execute, et l'on entre aussi
   * dans une salle par un lien partage, sans passer par lui. Dans ces cas
   * mapOpts retombe sur ses valeurs par defaut — lang 'en', speechLang
   * 'en-US' — et Azure ecoute en anglais quoi que l'on ait choisi.
   * Symptome rapporte le 9 aout 2026 : « en Remote, cela ne prend que
   * l'anglais ; quand on parle francais, on ne reconnait pas. »
   *
   * Le garde-fou existait pour que Conference garde sa propre langue. Or
   * Conference ne passe jamais par CPRemote.create ni par CPRemote.join :
   * la condition ne protegeait rien et cassait le cas courant. */
  function installLangOnJoin(R) {
    const _create = R.create, _join = R.join;
    const avecLangue = (o) => {
      const c = chosenSpeak();
      const o2 = Object.assign({}, o || {}, c);
      S.myLang = c.lang;
      // Le son ne peut etre deverrouille que dans le geste de l'utilisateur.
      // Creer ou rejoindre une salle en est un : on en profite.
      try { unlockAudio(); } catch (_) {}
      return o2;
    };
    if (typeof _create === 'function') {
      R.create = function (o) {
        S.isChair = true;          // qui cree la salle preside la seance
        return _create.call(R, avecLangue(o));
      };
    }
    if (typeof _join === 'function') {
      R.join = function (code, o) {
        return _join.call(R, code, avecLangue(o));
      };
    }
  }

  /* Two-Way et Conference vivent dans index.html et n'ont pas de notion de
   * « fin de session ». On mesure donc le temps passé sur leur écran : le
   * signal part quand l'utilisateur quitte l'écran ou ferme l'application. */
  const screenTimer = { id: null, since: 0 };

  function watchScreens() {
    if (screenTimer.id) return;
    const modeOf = () => {
      const c = document.getElementById('call');
      const f = document.getElementById('conference');
      if (c && c.classList.contains('active')) return 'twoway';
      if (f && f.classList.contains('active')) return 'conference';
      return null;
    };
    let cur = null;
    const flush = () => {
      if (!cur || !screenTimer.since) return;
      const mins = Math.round((Date.now() - screenTimer.since) / 60000);
      if (mins >= 1) reportSession(cur, S.myLang, 1, mins);
      cur = null; screenTimer.since = 0;
    };
    screenTimer.id = setInterval(() => {
      const m = modeOf();
      if (m !== cur) { flush(); cur = m; screenTimer.since = m ? Date.now() : 0; }
    }, 4000);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  function installAudioEngine() {
    // Toute synthèse, d'où qu'elle vienne, passe par le canal unique.
    installSynthFunnel();
    watchScreens();
    // Traduction partielle pendant la parole (Two-Way).
    installRecognizerFunnel();
    // Réparations d'interface effacées par la restauration.
    fixConferenceLayout();
    installSpeakPicker();
    majBandeauLangue();

    // Langue → code court, pour retrouver la voix Azure
    const shortCode = (c) => String(c || 'en').toLowerCase().split('-')[0];

    // Le créole haïtien ne dispose d'aucune voix Azure : l'application le fait
    // passer par ElevenLabs. Cette voix-là fonctionne et doit être préservée —
    // on délègue donc le créole à la fonction d'origine plutôt que de le
    // rediriger vers une voix française approchée.
    // Two-Way Call — signature réelle : speakCallTTS(text, langCode, creds).
    // Le troisième paramètre n'est plus nécessaire : le moteur obtient son
    // propre jeton. Le créole est géré par speakText (voie ElevenLabs).
    if (typeof window.speakCallTTS === 'function' && !window.speakCallTTS.__cpm) {
      const patched = function (text, langCode) {
        try { speakText(text, shortCode(langCode)); } catch (e) { console.warn('[cp-meet]', e); }
      };
      patched.__cpm = true;
      window.speakCallTTS = patched;
    }

    // Conference — speakConf(text, langCode)
    if (typeof window.speakConf === 'function' && !window.speakConf.__cpm) {
      const patched = function (text, langCode) {
        try { speakText(text, shortCode(langCode)); } catch (e) { console.warn('[cp-meet]', e); }
      };
      patched.__cpm = true;
      window.speakConf = patched;
    }

    /* ── Fin des fausses traductions ────────────────────────────────────
     * runDemoTranslation() affichait, caractère par caractère, une phrase
     * inventée (« Welcome, how may I assist you? ») comme s'il s'agissait
     * d'une vraie traduction. Elle était déclenchée notamment en cas
     * d'ERREUR de reconnaissance vocale — ce qui masquait la panne réelle
     * derrière une démonstration convaincante. C'est ce qui « déclenche un
     * message tout seul » à l'ouverture de Two-Way Call.
     *
     * On la remplace par un message honnête. L'utilisateur doit savoir que
     * rien n'a été entendu ; un examinateur de boutique aussi.
     * ────────────────────────────────────────────────────────────────── */
    if (typeof window.runDemoTranslation === 'function') {
      window.runDemoTranslation = function () {
        try {
          const o = document.getElementById('origA');
          const t = document.getElementById('transA');
          if (o) o.textContent = '';
          if (t) {
            t.textContent = 'No speech detected — check the microphone permission '
                          + 'and your connection, then try again.';
            t.style.opacity = '.75';
          }
        } catch (e) {}
      };
    }
    if (typeof window.showMockTranslation === 'function') {
      window.showMockTranslation = function (original) {
        try {
          const o = document.getElementById('origA');
          if (o && original) o.textContent = original;
        } catch (e) {}
      };
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('cpMeetStyles')) return;
    const st = document.createElement('style');
    st.id = 'cpMeetStyles';
    st.textContent = `
.cpm-fab{position:fixed;right:14px;bottom:88px;z-index:9000;display:none;
  flex-direction:column;gap:8px}
.cpm-fab.on{display:flex}
.cpm-btn{width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.14);
  background:#1b2233;color:#e8ecf6;font-size:19px;cursor:pointer;display:flex;
  align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.35);
  -webkit-tap-highlight-color:transparent}
.cpm-btn:active{transform:scale(.94)}
.cpm-btn.active{background:#5b6ef5;border-color:#7b8bff}
.cpm-badge{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;padding:0 5px;
  border-radius:9px;background:#e05252;color:#fff;font-size:11px;font-weight:700;
  display:flex;align-items:center;justify-content:center}
.cpm-videos{position:fixed;left:0;right:0;top:0;z-index:8900;display:none;
  gap:6px;padding:8px;flex-wrap:wrap;justify-content:center;
  background:linear-gradient(180deg,rgba(8,11,20,.96),rgba(8,11,20,0))}
.cpm-videos.on{display:flex}
.cpm-tile{position:relative;width:min(46vw,220px);aspect-ratio:4/3;border-radius:12px;
  overflow:hidden;background:#0d1220;border:1px solid rgba(255,255,255,.10)}
.cpm-tile video{width:100%;height:100%;object-fit:cover;background:#0d1220}
.cpm-tile .lbl{position:absolute;left:6px;bottom:5px;font-size:11px;color:#e8ecf6;
  background:rgba(0,0,0,.55);padding:2px 7px;border-radius:8px;max-width:88%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpm-panel{position:fixed;right:0;bottom:0;top:auto;width:min(400px,100%);
  max-height:min(70vh,560px);z-index:9100;background:#111726;
  border-top-left-radius:16px;border-top-right-radius:16px;
  border:1px solid rgba(255,255,255,.10);display:none;flex-direction:column;
  box-shadow:0 -8px 30px rgba(0,0,0,.5)}
.cpm-panel.on{display:flex}
.cpm-head{display:flex;align-items:center;gap:6px;padding:10px 12px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.cpm-tab{flex:1;padding:8px 6px;border:0;border-radius:9px;background:transparent;
  color:#93a0bd;font-size:13px;font-weight:600;cursor:pointer}
.cpm-tab.sel{background:#1d2740;color:#e8ecf6}
.cpm-x{border:0;background:transparent;color:#93a0bd;font-size:20px;cursor:pointer;
  padding:0 6px;line-height:1}
.cpm-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;
  overscroll-behavior:contain;padding:10px 12px}
.cpm-msg{margin-bottom:11px}
.cpm-msg .who{font-size:11px;color:#8b98b6;margin-bottom:2px}
.cpm-msg .tx{font-size:14px;color:#e8ecf6;line-height:1.4;word-wrap:break-word}
.cpm-msg .orig{font-size:11.5px;color:#7f8db0;font-style:italic;margin-top:2px}
.cpm-msg.me .who{color:#7f9bff}
.cpm-row{display:flex;align-items:center;gap:9px;padding:8px 2px;
  border-bottom:1px solid rgba(255,255,255,.05)}
.cpm-av{width:30px;height:30px;border-radius:50%;background:#28324d;color:#cfd8ee;
  display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}
.cpm-nm{flex:1;font-size:13.5px;color:#e8ecf6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpm-tag{font-size:10.5px;color:#93a0bd;border:1px solid rgba(255,255,255,.12);
  border-radius:7px;padding:1px 6px}
.cpm-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08)}
.cpm-in{flex:1;background:#0e1422;border:1px solid rgba(255,255,255,.12);border-radius:10px;
  color:#e8ecf6;padding:10px 12px;font-size:14px;font-family:inherit}
.cpm-in:focus{outline:none;border-color:#5b6ef5}
.cpm-send{border:0;border-radius:10px;background:#5b6ef5;color:#fff;font-size:14px;
  font-weight:600;padding:0 16px;cursor:pointer}
.cpm-empty{color:#7f8db0;font-size:13px;text-align:center;padding:22px 8px;line-height:1.5}
`;
    document.head.appendChild(st);
  }

  // ── Interface ─────────────────────────────────────────────────────────
  function buildUI() {
    if (document.getElementById('cpmPanel')) return;

    const vids = document.createElement('div');
    vids.className = 'cpm-videos';
    vids.id = 'cpmVideos';
    document.body.appendChild(vids);

    const fab = document.createElement('div');
    fab.className = 'cpm-fab';
    fab.id = 'cpmFab';
    fab.innerHTML = `
      <button class="cpm-btn" id="cpmCam"  title="Camera">🎥</button>
      <button class="cpm-btn" id="cpmHand" title="Raise hand">✋</button>
      <button class="cpm-btn" id="cpmChat" title="Chat">💬<span class="cpm-badge" id="cpmUnread" style="display:none">0</span></button>`;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'cpm-panel';
    panel.id = 'cpmPanel';
    panel.innerHTML = `
      <div class="cpm-head">
        <button class="cpm-tab sel" id="cpmTabChat">💬 Chat</button>
        <button class="cpm-tab"     id="cpmTabPeople">👥 People</button>
        <button class="cpm-x"       id="cpmClose" aria-label="Close">×</button>
      </div>
      <div class="cpm-body" id="cpmBody"></div>
      <div class="cpm-foot" id="cpmFoot">
        <input class="cpm-in" id="cpmInput" placeholder="Type a message…" autocomplete="off">
        <button class="cpm-send" id="cpmSend">Send</button>
      </div>`;
    document.body.appendChild(panel);

    document.getElementById('cpmChat').onclick = () => toggle(true, 'chat');
    document.getElementById('cpmClose').onclick = () => toggle(false);
    document.getElementById('cpmTabChat').onclick = () => setTab('chat');
    document.getElementById('cpmTabPeople').onclick = () => setTab('people');
    document.getElementById('cpmSend').onclick = sendChat;
    document.getElementById('cpmInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
    document.getElementById('cpmHand').onclick = toggleHand;
    document.getElementById('cpmCam').onclick = toggleCam;
  }

  const chat = [];

  function toggle(on, tab) {
    S.open = (on === undefined) ? !S.open : !!on;
    document.getElementById('cpmPanel').classList.toggle('on', S.open);
    if (S.open) {
      S.unread = 0; renderBadge();
      if (tab) setTab(tab); else render();
      setTimeout(() => { try { document.getElementById('cpmInput').focus(); } catch (e) {} }, 60);
    }
  }

  function setTab(t) {
    S.tab = t;
    document.getElementById('cpmTabChat').classList.toggle('sel', t === 'chat');
    document.getElementById('cpmTabPeople').classList.toggle('sel', t === 'people');
    document.getElementById('cpmFoot').style.display = (t === 'chat') ? 'flex' : 'none';
    render();
  }

  function renderBadge() {
    const b = document.getElementById('cpmUnread');
    if (!b) return;
    b.style.display = S.unread > 0 ? 'flex' : 'none';
    b.textContent = S.unread > 99 ? '99+' : String(S.unread);
  }

  function render() {
    const body = document.getElementById('cpmBody');
    if (!body) return;

    if (S.tab === 'chat') {
      if (!chat.length) {
        body.innerHTML = '<div class="cpm-empty">Aucun message.<br>Chaque message est traduit dans la langue de chaque participant.</div>';
        return;
      }
      body.innerHTML = chat.map(m => `
        <div class="cpm-msg${m.mine ? ' me' : ''}">
          <div class="who">${esc(m.mine ? 'You' : m.from)}</div>
          <div class="tx">${esc(m.shown)}</div>
          ${m.orig && m.orig !== m.shown ? `<div class="orig">« ${esc(m.orig)} »</div>` : ''}
        </div>`).join('');
      body.scrollTop = body.scrollHeight;
      return;
    }

    // Participants
    if (!S.roster.length) {
      body.innerHTML = '<div class="cpm-empty">Personne d\'autre dans la salle.</div>';
      return;
    }
    /* Ordre d'arrivee des mains levees.
     *
     * Trier par « main levee » ne suffit pas : deux personnes qui levent la
     * main ne sont pas a egalite, la premiere a demande la parole avant. A
     * l'Assemblee generale on parle dans l'ordre d'inscription, pas dans
     * l'ordre alphabetique. On horodate donc chaque levee de main et on
     * classe la file la-dessus. */
    const chairId = S.isChair ? S.selfId : S.chairId;
    const rang = (p) => (p.hand ? (S.handAt.get(p.id) || 0) : Infinity);
    const ordered = [...S.roster].sort((a, b) => rang(a) - rang(b));
    body.innerHTML = ordered.map(p => {
      const ini = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      const tags = [];
      if (p.id === chairId) tags.push('<span class="cpm-tag">🪑 préside</span>');
      if (p.id === S.floor) tags.push('<span class="cpm-tag" style="border-color:#57c46b">🎤 a la parole</span>');
      if (p.hand) {
        const pos = ordered.filter(x => x.hand).findIndex(x => x.id === p.id) + 1;
        tags.push('<span class="cpm-tag">&#9995; ' + pos + '<sup>e</sup> dans la file</span>');
      }
      if (p.muted) tags.push('<span class="cpm-tag">🔇</span>');
      if (p.video) tags.push('<span class="cpm-tag">🎥</span>');
      if (p.lang) tags.push(`<span class="cpm-tag">${esc(String(p.lang).toUpperCase())}</span>`);
      // Boutons du président : donner ou reprendre la parole
      const give = (S.isChair && p.id && p.id !== S.selfId)
        ? `<button class="cpm-give" data-id="${esc(p.id)}" style="margin-left:auto;border:1px solid rgba(255,255,255,.2);
             background:${p.id === S.floor ? '#5b3131' : '#28304a'};color:#e8ecf6;border-radius:12px;
             padding:4px 10px;font-size:12px;cursor:pointer">${p.id === S.floor ? '⏸ Reprendre' : '🎤 Donner la parole'}</button>`
        : '';
      return `<div class="cpm-row"><div class="cpm-av">${esc(ini)}</div>
        <div class="cpm-nm">${esc(p.name)}${p.id === S.selfId ? ' (you)' : ''}</div>
        ${tags.join(' ')}${give}</div>`;
    }).join('');
    body.querySelectorAll('.cpm-give').forEach(b => {
      b.onclick = () => setFloor(b.dataset.id === S.floor ? null : b.dataset.id);
    });
  }

  // ── Clavardage ────────────────────────────────────────────────────────
  async function sendChat() {
    const input = document.getElementById('cpmInput');
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';

    chat.push({ mine: true, from: 'You', shown: text, orig: '' });
    render();

    // Traduire vers les langues présentes dans la salle
    const targets = [...new Set(S.roster.map(p => p.lang).filter(l => l && l !== S.myLang))];
    let translations = {};
    if (targets.length) {
      try { translations = await translateText(text, targets); } catch (e) {}
    }
    send({ type: 'chat', srcLang: S.myLang, text, translations });
  }

  // Traduction texte via Azure Translator (jeton fourni par le serveur, comme
  // le reste de l'application). En cas d'échec, le message part en clair.
  const SERVER = 'https://cp-server-kdbg.onrender.com'; // même serveur que cp-remote.js

  async function translateText(text, targets) {
    const base = (window.CP_SERVER || SERVER).replace(/\/+$/, '');
    if (!base) return {};
    const r = await fetch(base + '/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: S.myLang, to: targets }),
    });
    if (!r.ok) return {};
    const j = await r.json();
    return j && j.translations ? j.translations : {};
  }

  function onChat(m) {
    if (m.fromId && m.fromId === S.selfId) return; // mon propre message, déjà affiché
    const shown = (m.translations && m.translations[S.myLang]) || m.text || '';
    chat.push({ mine: false, from: m.from || 'Participant', shown, orig: m.text || '' });
    if (!S.open || S.tab !== 'chat') { S.unread++; renderBadge(); }
    render();
  }

  // ── Main levée ────────────────────────────────────────────────────────
  function toggleHand() {
    S.handUp = !S.handUp;
    document.getElementById('cpmHand').classList.toggle('active', S.handUp);
    // On s'inscrit soi-meme dans la file tout de suite, sans attendre
    // l'aller-retour par le serveur : sinon on ne se voit pas y entrer.
    if (S.selfId) {
      if (S.handUp) S.handAt.set(S.selfId, Date.now());
      else S.handAt.delete(S.selfId);
    }
    send({ type: 'state', hand: S.handUp });
    majFileParole();
  }

  /* ────────────────────────────────────────────────────────────────────
   * PRÉSIDENT DE SÉANCE (Remote Call)
   *
   * Le modèle des réunions multilatérales : la personne qui crée la salle
   * préside. Les participants demandent la parole en levant la main ; le
   * président la donne et la reprend depuis la liste des participants.
   * Quand la parole est attribuée, seul son détenteur (et le président)
   * peut ouvrir le micro. Quand elle n'est attribuée à personne, la
   * discussion est libre — comportement actuel inchangé.
   *
   * Transport : le relais « signal » du serveur, déjà déployé, achemine
   * des messages ciblés ; aucun changement serveur n'est nécessaire. Le
   * président rediffuse l'état (président + parole) à chaque évolution de
   * la salle, si bien qu'un retardataire est informé dès son arrivée.
   * ──────────────────────────────────────────────────────────────────── */
  function broadcastMeet() {
    if (!S.isChair) return;
    for (const p of S.roster) {
      if (p.id && p.id !== S.selfId) {
        send({ type: 'signal', to: p.id, kind: 'meet',
               payload: { chair: S.selfId, floor: S.floor || null } });
      }
    }
  }

  function nameOf(id) {
    const p = S.roster.find(x => x.id === id);
    return p ? (p.name || 'Participant') : 'Participant';
  }

  // Message passager (conseils, notifications) — distinct du bandeau de parole
  function toast(msg, ms) {
    let el = document.getElementById('cpmToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cpmToast';
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:14px;'
        + 'z-index:9200;padding:9px 16px;border-radius:14px;font-size:13px;'
        + 'background:#1b2233;color:#e8ecf6;border:1px solid rgba(255,255,255,.18);'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:88vw;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el.__t);
    el.__t = setTimeout(() => { el.style.display = 'none'; }, ms || 6000);
  }

  /* LA FILE DE PAROLE, VISIBLE PAR TOUS.
   *
   * Elle est affichee a tout le monde, pas seulement au president. Dans une
   * enceinte multilaterale, savoir qui attend et a quel rang fait partie de
   * la transparence des debats : on ne demande pas la parole a l'aveugle.
   * Chacun voit sa propre position ; le president donne la parole d'un seul
   * geste, sans ouvrir le panneau des participants.
   *
   * L'identite affichee est le nom saisi a l'entree dans la salle. Il peut
   * etre un nom de personne ou un nom de delegation — « Senegal » comme
   * « Marie Dupont ». Loquivox ne sert pas qu'aux rencontres multilaterales :
   * on n'impose donc pas le vocabulaire diplomatique, on l'autorise. */
  function majFileParole() {
    const enSalle = !!(window.CPRemote && CPRemote.room);
    let box = document.getElementById('cpmQueue');
    const attente = (S.roster || [])
      .filter(p => p.hand)
      .sort((a, b) => (S.handAt.get(a.id) || 0) - (S.handAt.get(b.id) || 0));

    if (!enSalle || !attente.length) { if (box) box.remove(); return; }

    if (!box) {
      box = document.createElement('div');
      box.id = 'cpmQueue';
      box.style.cssText = 'position:fixed;right:12px;bottom:150px;z-index:9099;'
        + 'width:min(268px,74vw);padding:10px 12px;border-radius:14px;'
        + 'background:rgba(11,17,32,.95);border:1px solid #1e2d4a;color:#e8ecf6;'
        + 'font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.4);';
      document.body.appendChild(box);
    }

    const lignes = attente.map((p, i) => {
      const moi = p.id === S.selfId;
      const attenteMin = Math.round((Date.now() - (S.handAt.get(p.id) || Date.now())) / 60000);
      const depuis = attenteMin >= 1 ? ' · ' + attenteMin + ' min' : '';
      const bouton = (S.isChair && !moi)
        ? '<button class="cpm-q" data-id="' + esc(p.id) + '" style="margin-left:auto;'
          + 'border:1px solid rgba(255,255,255,.2);background:#28304a;color:#e8ecf6;'
          + 'border-radius:10px;padding:3px 9px;font-size:12px;cursor:pointer">&#127908;</button>'
        : '';
      return '<div style="display:flex;align-items:center;gap:7px;padding:4px 0;'
        + (moi ? 'color:#8fd6a0' : '') + '">'
        + '<b style="opacity:.65;min-width:14px">' + (i + 1) + '.</b>'
        + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
        + esc(p.name || '—') + (moi ? ' (vous)' : '') + '</span>'
        + '<span style="opacity:.6;font-size:11px">' + esc(String(p.lang || '').toUpperCase())
        + depuis + '</span>' + bouton + '</div>';
    }).join('');

    box.innerHTML = '<div style="font-size:11px;letter-spacing:.4px;text-transform:uppercase;'
      + 'color:#8fa0bd;margin-bottom:6px">&#9995; Demandes de parole (' + attente.length + ')</div>'
      + lignes;
    box.querySelectorAll('.cpm-q').forEach(b => {
      b.onclick = () => setFloor(b.dataset.id);
    });
  }

  function floorBar(msg, mine) {
    let bar = document.getElementById('cpmFloorBar');
    if (!msg) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cpmFloorBar';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:148px;'
        + 'z-index:9100;padding:8px 16px;border-radius:20px;font-size:13px;'
        + 'background:#1b2233;color:#e8ecf6;border:1px solid rgba(255,255,255,.18);'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:86vw;text-align:center';
      document.body.appendChild(bar);
    }
    bar.style.borderColor = mine ? '#57c46b' : 'rgba(255,255,255,.18)';
    bar.textContent = msg;
  }

  function onFloorChange(prev) {
    // La parole vient de m'être donnée : je baisse la main automatiquement.
    if (S.floor === S.selfId && S.handUp) toggleHand();
    // Elle vient de m'être reprise pendant que je parlais : je m'arrête.
    if (prev === S.selfId && S.floor !== S.selfId) {
      try { window.CPRemote && CPRemote.stopSpeaking && CPRemote.stopSpeaking(); } catch (_) {}
    }
    if (!S.floor) floorBar(null);
    else if (S.floor === S.selfId) floorBar('🎤 Vous avez la parole', true);
    else floorBar('🎤 La parole est à ' + nameOf(S.floor) + ' — levez la main ✋ pour la demander', false);
    // Celui qui recoit la parole quitte la file : on la redessine.
    if (S.floor) S.handAt.delete(S.floor);
    majFileParole();
    render();
  }

  function setFloor(id) {
    if (!S.isChair) return;
    const prev = S.floor || null;
    S.floor = id || null;
    onFloorChange(prev);
    broadcastMeet();
  }

  function onMeetSignal(data) {
    const p = (data && data.payload) || {};
    const prev = S.floor || null;
    S.chairId = p.chair || null;
    S.floor = p.floor || null;
    if (prev !== S.floor) onFloorChange(prev); else render();
  }

  // ── Vidéo WebRTC ──────────────────────────────────────────────────────
  async function toggleCam() {
    if (S.videoOn) return stopCam();
    try {
      S.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      alert("Camera or microphone unavailable. Check your browser permissions.");
      return;
    }
    S.videoOn = true;
    document.getElementById('cpmCam').classList.add('active');
    document.getElementById('cpmVideos').classList.add('on');
    addTile('self', 'Vous', S.localStream, true);
    send({ type: 'state', video: true });

    // Proposer une connexion à chaque autre participant
    for (const p of S.roster) {
      if (p.id && p.id !== S.selfId) startOffer(p.id);
    }
  }

  function stopCam() {
    S.videoOn = false;
    document.getElementById('cpmCam').classList.remove('active');
    if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
    for (const [id, pc] of S.peers) { try { pc.close(); } catch (e) {} send({ type: 'signal', to: id, kind: 'bye' }); }
    S.peers.clear(); S.streams.clear();
    document.getElementById('cpmVideos').innerHTML = '';
    document.getElementById('cpmVideos').classList.remove('on');
    send({ type: 'state', video: false });
  }

  function addTile(id, label, stream, muted) {
    const wrap = document.getElementById('cpmVideos');
    let tile = document.getElementById('cpmT_' + id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'cpm-tile';
      tile.id = 'cpmT_' + id;
      tile.innerHTML = `<video playsinline autoplay${muted ? ' muted' : ''}></video>
                        <div class="lbl">${esc(label)}</div>`;
      wrap.appendChild(tile);
    }
    const v = tile.querySelector('video');
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {}); // iOS : la lecture démarre au geste utilisateur déjà donné
    }
    wrap.classList.add('on');
  }

  function dropTile(id) {
    const t = document.getElementById('cpmT_' + id);
    if (t) t.remove();
    const wrap = document.getElementById('cpmVideos');
    if (wrap && !wrap.children.length) wrap.classList.remove('on');
    dropVoice(id);
  }

  /* ────────────────────────────────────────────────────────────────────
   * VRAIE VOIX — transport WebRTC
   *
   * L'ancien mécanisme découpait la voix en morceaux de 200 ms, les faisait
   * transiter par le serveur et les recollait avec MediaSource. Safari iOS
   * n'implémente pas MediaSource pour cet usage : un iPhone pouvait envoyer
   * sa vraie voix mais jamais la recevoir.
   *
   * La connexion directe WebRTC — déjà en place pour la vidéo — transporte
   * l'audio nativement et fonctionne sur tous les navigateurs, iOS compris.
   * On réutilise donc exactement la même machinerie, en audio seul.
   * ──────────────────────────────────────────────────────────────────── */
  const DUCK_VOL = 0.35;      // volume de la vraie voix pendant la traduction parlée

  function attachVoice(id, stream) {
    let el = document.getElementById('cpmV_' + id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'cpmV_' + id;
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      document.body.appendChild(el);
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.volume = ttsSpeaking ? DUCK_VOL : 1.0;
      el.play().catch(() => {}); // le geste de déverrouillage a déjà eu lieu
    }
  }

  function dropVoice(id) {
    const el = document.getElementById('cpmV_' + id);
    if (el) { try { el.srcObject = null; } catch (_) {} el.remove(); }
  }

  // Atténue la vraie voix pendant que la traduction parle — comme une cabine
  // d'interprétation — puis rétablit le volume.
  let ttsSpeaking = false;
  function duckVoices(on) {
    ttsSpeaking = !!on;
    const v = (on && !S.ttsMuted) ? DUCK_VOL : 1.0;
    document.querySelectorAll('audio[id^="cpmV_"]').forEach(el => { el.volume = v; });
  }

  async function startVoice() {
    if (S.voiceStream) return true;
    try {
      S.voiceStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      console.warn('[cp-meet] micro refusé pour la vraie voix :', e && e.name);
      return false;
    }
    // Proposer la connexion à tous les participants déjà présents
    for (const p of S.roster) {
      if (p.id && p.id !== S.selfId) {
        const pc = S.peers.get(p.id);
        if (pc) S.voiceStream.getTracks().forEach(t => pc.addTrack(t, S.voiceStream));
        startOffer(p.id);   // renégocie avec la nouvelle piste
      }
    }
    send({ type: 'state', voice: true });
    return true;
  }

  function stopVoice() {
    if (!S.voiceStream) return;
    S.voiceStream.getTracks().forEach(t => t.stop());
    S.voiceStream = null;
    for (const id of S.peers.keys()) startOffer(id);  // renégocie sans la piste
    send({ type: 'state', voice: false });
  }

  function peer(id) {
    if (S.peers.has(id)) return S.peers.get(id);
    const pc = new RTCPeerConnection(ICE);

    if (S.localStream) {
      S.localStream.getTracks().forEach(t => pc.addTrack(t, S.localStream));
    }
    if (S.voiceStream) {
      S.voiceStream.getTracks().forEach(t => pc.addTrack(t, S.voiceStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: id, kind: 'ice', payload: e.candidate });
    };

    pc.ontrack = (e) => {
      const st = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      S.streams.set(id, st);
      const p = S.roster.find(x => x.id === id);
      const name = (p && p.name) || 'Participant';
      // Un flux sans piste vidéo est une vraie voix : pas de vignette, un
      // simple lecteur audio (indispensable sur iPhone, où l'ancien transport
      // MediaSource ne fonctionnait pas).
      if (st.getVideoTracks().length === 0) attachVoice(id, st);
      else addTile(id, name, st, false);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        dropTile(id); S.peers.delete(id); S.streams.delete(id);
      }
    };

    S.peers.set(id, pc);
    return pc;
  }

  async function startOffer(id) {
    const pc = peer(id);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      send({ type: 'signal', to: id, kind: 'offer', payload: pc.localDescription });
    } catch (e) { console.warn('[cp-meet] offre échouée', e); }
  }

  async function onSignal(m) {
    // Messages de séance (président, parole) — avant la signalisation WebRTC
    if (m && m.kind === 'meet') return onMeetSignal(m);
    const id = m.from;
    if (!id) return;
    try {
      if (m.kind === 'offer') {
        const pc = peer(id);
        await pc.setRemoteDescription(new RTCSessionDescription(m.payload));
        // Répondre en partageant sa caméra si elle est active, sinon en simple récepteur
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send({ type: 'signal', to: id, kind: 'answer', payload: pc.localDescription });
      } else if (m.kind === 'answer') {
        const pc = S.peers.get(id);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(m.payload));
      } else if (m.kind === 'ice') {
        const pc = S.peers.get(id);
        if (pc && m.payload) await pc.addIceCandidate(new RTCIceCandidate(m.payload));
      } else if (m.kind === 'bye') {
        const pc = S.peers.get(id);
        if (pc) { try { pc.close(); } catch (e) {} }
        S.peers.delete(id); S.streams.delete(id); dropTile(id);
      }
    } catch (e) { console.warn('[cp-meet] signal', m.kind, e); }
  }

  // ── Branchement sur CPRemote ──────────────────────────────────────────
  function handle(type, data) {
    if (type === 'joined') {
      S.selfId = data.selfId || null;
      S.roster = data.participants || [];
      S.rosterMax = S.roster.length;
      S.sessionStart = Date.now();
      document.getElementById('cpmFab').classList.add('on');
      // Conseil affiché une fois par session : évite la boucle audio quand
      // plusieurs appareils partagent la même pièce.
      if (!S.hintShown) {
        S.hintShown = true;
        toast('🎧 Plusieurs appareils dans la même pièce ? Écouteurs recommandés — '
            + 'un seul micro ouvert par pièce.', 8000);
      }
      render();
    } else if (type === 'roster') {
      // Le président est prévenu des nouvelles mains levées
      if (S.isChair) {
        const before = new Set((S.roster || []).filter(p => p.hand).map(p => p.id));
        for (const p of (data.participants || [])) {
          if (p.hand && p.id !== S.selfId && !before.has(p.id)) {
            toast('✋ ' + (p.name || 'Un participant') + ' demande la parole', 5000);
          }
        }
      }
      /* Horodatage de la file, tenu localement.
       *
       * Le serveur ne transmet qu'un booleen « main levee » : deux
       * personnes qui levent la main arrivent donc sans ordre. On note ici
       * l'instant ou chaque main apparait, et on oublie celles qui
       * redescendent. L'ordre est ainsi le meme pour tout le monde, a la
       * latence du relais pres — suffisant pour une file de parole. */
      const avant = new Set((S.roster || []).filter(p => p.hand).map(p => p.id));
      for (const p of (data.participants || [])) {
        if (p.hand && !avant.has(p.id) && !S.handAt.has(p.id)) S.handAt.set(p.id, Date.now());
        if (!p.hand) S.handAt.delete(p.id);
      }
      S.roster = data.participants || [];
      S.rosterMax = Math.max(S.rosterMax || 0, S.roster.length);
      majFileParole();
      // Le président informe les arrivants de l'état de la séance
      broadcastMeet();
      // Le détenteur de la parole est parti : la discussion redevient libre
      if (S.isChair && S.floor && !S.roster.some(p => p.id === S.floor)) setFloor(null);
      // Nouveau venu pendant que ma caméra tourne : je lui propose la connexion
      if (S.videoOn) {
        for (const p of S.roster) {
          if (p.id && p.id !== S.selfId && !S.peers.has(p.id)) startOffer(p.id);
        }
      }
      // Départs
      for (const id of [...S.peers.keys()]) {
        if (!S.roster.some(p => p.id === id)) {
          try { S.peers.get(id).close(); } catch (e) {}
          S.peers.delete(id); S.streams.delete(id); dropTile(id);
        }
      }
      render();
    } else if (type === 'utterance') {
      speakIncoming(data);   // voix de traduction (chemin compatible iOS)
    } else if (type === 'chat') {
      onChat(data);
    } else if (type === 'signal') {
      onSignal(data);
    } else if (type === 'closed') {
      recordSessionEnd();
      stopCam();
      document.getElementById('cpmFab').classList.remove('on');
      toggle(false);
    }
  }

  function boot() {
    const R = window.CPRemote;
    if (S.booted || !R) return;
    S.booted = true;
    injectStyles();
    buildUI();
    // Remplace immédiatement les exemples fictifs de l'écran d'accueil par
    // l'historique réel (vide au premier lancement).
    renderRecent();
    // L'accueil peut être rendu après nous : on repasse une fois la page stable.
    setTimeout(renderRecent, 600);
    window.addEventListener('pageshow', renderRecent);

    // Enveloppe CPRemote.on : le gestionnaire de l'application reste intact
    const _on = R.on;
    R.on = function (cb) {
      return _on(function (type, data) {
        try { handle(type, data); } catch (e) { console.warn('[cp-meet]', e); }
        try { if (typeof cb === 'function') cb(type, data); } catch (e) { throw e; }
      });
    };

    // Suivre la langue choisie par l'utilisateur
    const _setLang = R.setLanguage;
    if (typeof _setLang === 'function') {
      R.setLanguage = function (shortCode, speechCode) {
        S.myLang = shortCode || S.myLang;
        return _setLang.call(R, shortCode, speechCode);
      };
    }

    // Suivre l'état du micro et de la voix
    const _setMuted = R.setTtsMuted;
    if (typeof _setMuted === 'function') {
      R.setTtsMuted = function (b) {
        S.ttsMuted = !!b;
        send({ type: 'state', muted: !!b });
        return _setMuted.call(R, b);
      };
    }
    // Certaines versions n'exposent que setTTS(v) — v = true signifie « voix active »
    const _setTTS = R.setTTS;
    if (typeof _setTTS === 'function') {
      R.setTTS = function (v) { S.ttsMuted = !v; return _setTTS.call(R, v); };
    }

    // Langue choisie transmise à la création/jonction d'une salle (Remote Call)
    installLangOnJoin(R);

    // ── Discipline de séance : le micro respecte la parole attribuée ──
    // Quand le président a donné la parole à quelqu'un, les autres micros
    // refusent poliment de s'ouvrir. Sans parole attribuée, rien ne change.
    const _startSpeak = R.startSpeaking;
    if (typeof _startSpeak === 'function') {
      R.startSpeaking = function () {
        if (S.floor && S.floor !== S.selfId && !S.isChair) {
          floorBar('🎤 La parole est à ' + nameOf(S.floor) + ' — levez la main ✋ pour la demander', false);
          return;
        }
        return _startSpeak.apply(R, arguments);
      };
    }

    // ── Reprise en main de la voix de traduction ──
    // On coupe la voix du module de base (sortie directe bloquée par Safari)
    // et on la produit ici par un chemin qui fonctionne sur tous les appareils.
    if (typeof _setTTS === 'function') {
      try { _setTTS.call(R, false); ttsOwned = true; } catch (e) {}
    }
    if (!ttsOwned && typeof _setMuted === 'function') {
      try { _setMuted.call(R, true); ttsOwned = true; } catch (e) {}
    }
    if (!ttsOwned) {
      console.warn('[cp-meet] impossible de couper la voix du module de base : '
                 + 'voix laissée telle quelle pour éviter un double son');
    }

    // Déverrouillage audio au premier geste de l'utilisateur (obligatoire iOS)
    ['touchend', 'click', 'keydown'].forEach(ev =>
      document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

    // ── Vraie voix : on détourne le bouton existant de l'application vers
    // WebRTC. L'ancien transport (morceaux relayés par le serveur, recollés
    // avec MediaSource) ne peut pas être reçu sur iPhone ; la connexion
    // directe, elle, fonctionne partout. L'utilisateur ne change rien à ses
    // habitudes : c'est le même bouton.
    const _startStream = R.startAudioStream;
    if (typeof _startStream === 'function') {
      R.startAudioStream = function () {
        startVoice().then(ok => {
          if (!ok) {
            console.warn('[cp-meet] repli sur l\'ancien transport');
            try { _startStream.call(R); } catch (e) {}
          }
        });
      };
    }
    const _stopStream = R.stopAudioStream;
    if (typeof _stopStream === 'function') {
      R.stopAudioStream = function () {
        stopVoice();
        try { _stopStream.call(R); } catch (e) {}   // coupe aussi l'ancien, par sûreté
      };
    }

    // Moteur audio unique pour Two-Way, Conference et Remote Call.
    // Les fonctions visées sont définies plus bas dans index.html : on
    // réessaie brièvement le temps que le script principal s'exécute.
    // Le SDK Azure est chargé depuis un domaine externe et peut arriver
    // après nous ; on réessaie jusqu'à ce que le collecteur soit en place.
    installAudioEngine();

    /* La version precedente reessayait 10 s puis abandonnait. Or les ecrans
     * sont construits a la demande, souvent bien plus tard : tout ce qui
     * dependait d'un ecran ouvert ensuite n'etait jamais installe. On
     * observe donc le document. Les installateurs sont idempotents. */
    let dernier = 0;
    const rejouer = () => {
      const now = Date.now();
      if (now - dernier < 250) return;
      dernier = now;
      try { installAudioEngine(); } catch (e) { console.warn('[cp-meet]', e); }
    };
    try {
      new MutationObserver(rejouer).observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style'],
      });
    } catch (_) {}
    setInterval(rejouer, 2000);

    // Exposé pour diagnostic et pour un usage externe éventuel
    window.CPAudio = {
      speak: speakText,
      unlock: unlockAudio,
      get ready() { return ttsUnlocked; },
      get owned() { return ttsOwned; },
      get funnelled() {
        const P = window.SpeechSDK && window.SpeechSDK.SpeechSynthesizer
                  && window.SpeechSDK.SpeechSynthesizer.prototype;
        return !!(P && P.speakTextAsync && P.speakTextAsync.__cpm);
      },
    };

    window.CPMeet = {
      openChat: () => toggle(true, 'chat'),
      openPeople: () => toggle(true, 'people'),
      toggleCamera: toggleCam,
      raiseHand: toggleHand,
      get state() { return { videoOn: S.videoOn, handUp: S.handUp, peers: S.peers.size, roster: S.roster.length }; },
      // Diagnostic : état de la séance (président, parole)
      get seance() { return { isChair: !!S.isChair, chair: S.chairId || (S.isChair ? S.selfId : null), floor: S.floor || null }; },
      // Rejoue les installateurs sur demande (banc d'essai et diagnostic).
      rejouer() { try { installAudioEngine(); return true; } catch (e) { return String(e && e.message); } },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ═════════════════════════════════════════════════════════════════════
   MENAGE D AVANT-LANCEMENT — revision du 9 aout 2026

   Six corrections que index.html porte encore. Elles sont appliquees ici
   parce que cp-meet.js est la couche prevue pour ca, et parce que les
   ecrans concernes sont masques jusqu a ce que l utilisateur les ouvre :
   rien ne clignote, le resultat visible est le meme.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function ech(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 1. Deux « services premium » sont des maquettes remplies de fiction.
        L un affiche un numero de telephone invente comme s il etait actif,
        l autre trois collegues qui n existent pas et un taux de precision
        que rien ne mesure. Apple refuse une application pour moins que ca. */
  function retirerLesMaquettes() {
    ['lnumber', 'workspace'].forEach(function (id) {
      var sel = '[onclick*="showScreen(\'' + id + '\')"]';
      document.querySelectorAll(sel).forEach(function (n) {
        var carte = n.closest('.mode-card') || n;
        if (carte && carte.parentNode) carte.remove();
      });
      var ecran = document.getElementById(id);
      if (ecran && ecran.parentNode) ecran.remove();
    });
    document.querySelectorAll('.participant-card.p-add').forEach(function (n) {
      var oc = n.getAttribute('onclick') || '';
      if (oc.indexOf('v1.1') >= 0) n.remove();
    });
  }

  /* 2. « 20 Languages » : il y en a 18. Le chiffre 20 vient d un decompte
        ou le chinois est compte deux fois (zh et zh-Hans). Les boutiques
        sanctionnent les metadonnees inexactes. */
  function corrigerLeNombreDeLangues() {
    var p = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = p.nextNode())) {
      if (n.nodeValue && n.nodeValue.indexOf('20 Languages') >= 0) {
        n.nodeValue = n.nodeValue.replace(/20 Languages/g, '18 Languages');
      }
    }
  }

  /* 3. L accueil affichait « Good morning there CP » : « there » est le nom
        par defaut d un nom jamais demande, « CP » l ancienne initiale, et
        « Good morning » s affichait a toute heure. */
  function corrigerLaSalutation() {
    var hh = document.querySelector('.home-header');
    if (!hh) return;
    var h = new Date().getHours();
    var mot = h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
    var nom = '';
    try { nom = (localStorage.getItem('loquivox_name') || '').trim(); } catch (e) {}
    var w = document.createTreeWalker(hh, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      if (/Good (morning|afternoon|evening)/.test(n.nodeValue)) {
        n.nodeValue = n.nodeValue.replace(/Good (morning|afternoon|evening)/, mot);
      }
    }
    var t = document.getElementById('homeUserName');
    if (t) {
      if ((t.textContent || '').trim() === 'there') t.textContent = '';
      if (nom) t.textContent = nom;
      t.style.display = (t.textContent || '').trim() ? '' : 'none';
    }
    hh.querySelectorAll('*').forEach(function (e) {
      if (e.children.length === 0 && (e.textContent || '').trim() === 'CP') {
        var p = nom.split(/\s+/).filter(Boolean);
        e.textContent = p.length
          ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
          : 'LX';
      }
    });
  }

  /* 4. Le code de salle faisait quatre caracteres, sans mot de passe ni
        salle d attente : on tombe sur une reunion en cours en quelques
        minutes d essais. Le champ accepte desormais six caracteres ;
        le serveur doit suivre pour que ce soit reellement une protection. */
  function codeDeSalleASixCaracteres() {
    var c = document.getElementById('joinCodeInput');
    if (!c) return;
    if (c.maxLength !== 6) c.maxLength = 6;
    if (/K7Q2\)/.test(c.placeholder || '')) {
      c.placeholder = c.placeholder.replace('K7Q2', 'K7Q2M9');
    }
  }

  /* 5. Sans aria-live, un lecteur d ecran n annonce jamais les nouvelles
        lignes de transcription : pour une personne aveugle, la traduction
        en direct est muette. Et un bouton qui n affiche qu un pictogramme
        n a aucun nom lisible. */
  function rendreAudibleAuxLecteursDEcran() {
    ['confTranscript', 'meetTranscriptLines', 'cpmLog'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e && !e.getAttribute('aria-live')) {
        e.setAttribute('aria-live', 'polite');
        e.setAttribute('aria-atomic', 'false');
        e.setAttribute('role', 'log');
      }
    });
    document.querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('aria-label')) return;
      var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && /[A-Za-z0-9]/.test(t)) return;
      var s = b.getAttribute('title') || b.className || '';
      s = s.replace(/[-_]/g, ' ').replace(/\b(btn|ctrl|icon|nav)\b/g, '').trim();
      if (s) b.setAttribute('aria-label', s);
    });
  }

  /* 6. La ligne de transcription inserait le nom de l intervenant et le
        texte reconnu directement dans la page. Ces valeurs arrivent des
        autres appareils par le relais : un participant pouvait executer du
        code chez tous les autres, et falsifier une traduction affichee.
        On echappe les valeurs AVANT qu elles n atteignent la page. */
  function echapperLaTranscription() {
    var f = window.addMeetTranscriptLine;
    if (typeof f !== 'function' || f.__cpmEch) return;
    var enveloppe = function (o) {
      var v = o || {};
      return f.call(this, {
        speaker: ech(v.speaker),
        text: ech(v.text),
        trans: ech(v.trans),
      });
    };
    enveloppe.__cpmEch = true;
    enveloppe.__orig = f;
    window.addMeetTranscriptLine = enveloppe;
  }

  var enCours = false;
  function tout() {
    if (enCours) return;
    enCours = true;
    try {
      [retirerLesMaquettes, corrigerLeNombreDeLangues, corrigerLaSalutation,
     codeDeSalleASixCaracteres, rendreAudibleAuxLecteursDEcran,
       echapperLaTranscription].forEach(function (fn) {
        try { fn(); } catch (e) { console.warn('[cp-meet] menage —', fn.name, e); }
      });
    } finally {
      enCours = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tout);
  } else {
    tout();
  }

  /* PAS de MutationObserver ici. La premiere version en avait un, et il a
     fige l application : tout() modifie le document (textes, attributs),
     l observateur le voit et rappelle tout(), qui modifie a nouveau. Boucle
     sans fin, page bloquee. Un intervalle de deux secondes suffit largement :
     les ecrans sont statiques et rien n apparait entre deux passages. */
  setInterval(tout, 2000);
})();

/* ═════════════════════════════════════════════════════════════════════
   ENTREE EN SALLE — pays, partage du lien, salle unique expliquee
   Revision du 9 aout 2026, demande de Wisnique :
   « La personne rentre dans la salle avec son nom et sa langue, ou le
   nom du pays, comme aux Nations unies. » Le menu propose les pays
   membres, puis Institution et Personne pour tous les autres cas.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Codes ISO des Etats membres de l ONU. Le nom s ecrit tout seul dans
     la langue de l appareil (Intl.DisplayNames) : rien a traduire, rien
     a maintenir, et le drapeau se deduit du code. */
  var CODES = ('AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW').split(' ');

  function drapeau(code) {
    return String.fromCodePoint.apply(null,
      code.split('').map(function (c) { return 127397 + c.charCodeAt(0); }));
  }

  function listePays() {
    var langue = (navigator.language || 'en');
    var noms;
    try { noms = new Intl.DisplayNames([langue], { type: 'region' }); }
    catch (e) { noms = { of: function (c) { return c; } }; }
    return CODES.map(function (c) {
      return { code: c, nom: noms.of(c) || c, drapeau: drapeau(c) };
    }).sort(function (a, b) { return a.nom.localeCompare(b.nom, langue); });
  }

  /* 1. Le menu « Vous representez » a l entree en conference.
        Choisir un pays remplit le nom avec drapeau + pays — c est ce que
        les autres verront dans la file de parole. Institution et Personne
        rendent la main au champ libre. */
  function poserSelecteur() {
    var inp = document.getElementById('confJoinNameInput');
    if (!inp || document.getElementById('cpmRepSel')) return;
    var sel = document.createElement('select');
    sel.id = 'cpmRepSel';
    sel.setAttribute('aria-label', 'Who you represent');
    sel.style.cssText = inp.style.cssText;
    sel.className = inp.className;
    sel.style.marginBottom = '8px';
    sel.style.width = '100%';
    var histoire = '';
    try { histoire = localStorage.getItem('loquivox_represente') || ''; } catch (e) {}
    var h = '';
    h += '\x3coption value=""\x3e\ud83c\udf10 Country \u00b7 Pays\u2026\x3c/option\x3e';
    h += '\x3coption value="pers"\x3e\ud83d\udc64 Person \u00b7 Personne\x3c/option\x3e';
    h += '\x3coption value="inst"\x3e\ud83c\udfe2 Institution\x3c/option\x3e';
    listePays().forEach(function (p) {
      h += '\x3coption value="' + p.code + '"\x3e' + p.drapeau + ' ' + p.nom + '\x3c/option\x3e';
    });
    sel.innerHTML = h;
    if (histoire) { try { sel.value = histoire; } catch (e) {} }
    sel.addEventListener('change', function () {
      var v = sel.value;
      try { localStorage.setItem('loquivox_represente', v); } catch (e) {}
      if (v && v !== 'pers' && v !== 'inst') {
        var p = listePays().filter(function (x) { return x.code === v; })[0];
        if (p) { inp.value = p.drapeau + ' ' + p.nom; }
      } else if (v === 'inst') {
        inp.value = ''; inp.placeholder = 'Institution name'; inp.focus();
      } else if (v === 'pers') {
        inp.value = ''; inp.placeholder = 'Your name'; inp.focus();
      }
    });
    inp.parentElement.insertBefore(sel, inp);
  }

  /* 2. Le lien d invitation, mis en avant la ou le code s affiche.
        Un code se dicte ; un lien s envoie. Le lien ouvre directement
        le choix de langue chez l invite. */
  function poserPartage() {
    var panneau = document.getElementById('qrPanel');
    if (!panneau || document.getElementById('cpmBtnPartage')) return;
    var lien = document.getElementById('qrLink');
    var b = document.createElement('button');
    b.id = 'cpmBtnPartage';
    b.textContent = '\ud83d\udce4 Send invitation link';
    b.setAttribute('aria-label', 'Send invitation link');
    b.style.cssText = 'width:100%;margin-top:10px;padding:13px;border:none;' +
      'border-radius:12px;background:linear-gradient(135deg,#4f8ef7,#7c5cfc);' +
      'color:#fff;font-size:14px;font-weight:600;cursor:pointer';
    b.addEventListener('click', function () {
      var url = (lien && lien.textContent && lien.textContent.trim()) || '';
      if (!url) {
        var code = (window.CPRemote && CPRemote.room && (CPRemote.room.code || CPRemote.room)) || '';
        if (code) url = 'https://loquivox.app/#conf=' + code;
      }
      if (!url) return;
      if (navigator.share) {
        navigator.share({ title: 'Loquivox', text: 'Join my meeting \u2014 in your own language:', url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          b.textContent = '\u2713 Link copied'; 
          setTimeout(function () { b.textContent = '\ud83d\udce4 Send invitation link'; }, 2000);
        }).catch(function () {});
      }
    });
    panneau.appendChild(b);
  }

  /* 3. Dire la salle unique, plutot que laisser croire a un bogue.
        Conference et appel a distance creent la meme salle : un seul
        code, que l on soit autour de la table ou a Geneve. */
  function poserExplication() {
    var panneau = document.getElementById('qrPanel');
    if (!panneau || document.getElementById('cpmNoteSalle')) return;
    var note = document.createElement('div');
    note.id = 'cpmNoteSalle';
    note.style.cssText = 'margin-top:10px;font-size:12px;line-height:1.5;color:#64748b;text-align:center';
    note.textContent = 'One room, one code \u2014 Conference and Remote Call share it. ' +
      'Anyone who opens the link joins in their own language.';
    panneau.appendChild(note);
  }


  /* 4. « Start live session » sous le choix de langue, pas apres le
        transcript. L animateur regle sa langue et son ecoute, puis lance :
        les trois vont ensemble. Le bouton etait relegue tout en bas, apres
        la liste des intervenants et le transcript. On le remonte — meme
        bouton, meme identifiant, meme action, juste deplace. */
  function deplacerBoutonSession() {
    var bloc = document.querySelector('.conf-start-btn');
    var voix = document.getElementById('confVoiceSel');
    if (!bloc || !voix) return;
    var ancre = voix.closest('div');
    if (!ancre || !ancre.parentElement) return;
    /* deja a la bonne place ? ne rien faire, sinon on boucle */
    if (ancre.nextElementSibling === bloc) return;
    ancre.parentElement.insertBefore(bloc, ancre.nextSibling);
  }

  var occupe = false;
  function poserTout() {
    if (occupe) return;
    occupe = true;
    try {
      [poserSelecteur, poserPartage, poserExplication, deplacerBoutonSession].forEach(function (fn) {
        try { fn(); } catch (e) { console.warn('[cp-meet] entree —', e); }
      });
    } finally { occupe = false; }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', poserTout);
  } else { poserTout(); }
  setInterval(poserTout, 2000);
})();

/* ═════════════════════════════════════════════════════════════════════
   VOIX ORIGINALE — rendre la panne visible
   Demande de Wisnique, 10 aout 2026. Meme demarche que pour la synthese
   (PR #23) : je ne pretends pas corriger le son, je rends lisible POURQUOI
   il ne sort pas. La voix originale de Remote Call passe par le serveur en
   morceaux MediaRecorder, decodes par decodeAudioData. L en-tete du fichier
   dit que Safari iPhone lit mal ce canal : si c est le cas, le decodage
   echoue, et jusqu ici cet echec disparaissait en silence.
   On enveloppe decodeAudioData (prototype modifiable) sans toucher au code
   audio existant, et on affiche le motif sous l etat de l appel. */
(function () {
  'use strict';
  var dernierEchecVoix = null;

  function noter(motif) {
    dernierEchecVoix = { motif: motif, quand: Date.now() };
    try { montrerBandeauVoix(); } catch (e) {}
  }
  function oublier() {
    if (dernierEchecVoix) { dernierEchecVoix = null; try { montrerBandeauVoix(); } catch (e) {} }
  }

  function enroberDecode(Cls) {
    if (!Cls || !Cls.prototype) return;
    var orig = Cls.prototype.decodeAudioData;
    if (typeof orig !== 'function' || orig.__cpmDec) return;
    var patched = function (buf, ok, echec) {
      var self = this;
      var surEchec = function (e) {
        noter('flux illisible sur cet appareil (decodeAudioData a echoue)');
        if (typeof echec === 'function') { try { echec(e); } catch (_) {} }
      };
      var surSucces = function (d) { oublier(); if (typeof ok === 'function') { try { ok(d); } catch (_) {} } return d; };
      try {
        var p = orig.call(self, buf, (typeof ok === 'function' ? surSucces : undefined), surEchec);
        if (p && typeof p.then === 'function') {
          return p.then(function (d) { oublier(); return d; }, function (e) {
            noter('flux illisible sur cet appareil (decodeAudioData a echoue)'); throw e;
          });
        }
        return p;
      } catch (e) { surEchec(e); throw e; }
    };
    patched.__cpmDec = true; patched.__orig = orig;
    Cls.prototype.decodeAudioData = patched;
  }
  try { enroberDecode(window.AudioContext); } catch (e) {}
  try { enroberDecode(window.webkitAudioContext); } catch (e) {}

  /* Le bandeau : sous l etat de l appel a distance, un seul message, en
     rouge discret, seulement si l echec date de moins d une minute. */
  function montrerBandeauVoix() {
    var ancre = document.getElementById('remoteStatus')
             || document.getElementById('voiceLabel');
    if (!ancre) return;
    var b = document.getElementById('cpmBandeauVoix');
    var frais = dernierEchecVoix && (Date.now() - dernierEchecVoix.quand < 60000);
    if (!frais) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'cpmBandeauVoix';
      b.setAttribute('role', 'status');
      b.style.cssText = 'margin-top:8px;font-size:12px;line-height:1.4;color:#ef4444;text-align:center';
      ancre.parentElement.insertBefore(b, ancre.nextSibling);
    }
    b.textContent = 'Voix originale — ' + dernierEchecVoix.motif;
  }

  setInterval(function () { try { montrerBandeauVoix(); } catch (e) {} }, 2000);
})();

/* ═════════════════════════════════════════════════════════════════════
   PRESIDENT : camera et marqueur visibles sur l'ecran Conference
   Demande de Wisnique. La camera (🎥), la main levee et la parole existent
   deja dans le panneau flottant en bas a droite, mais il n'apparait qu'une
   fois connecte a la salle et il est facile a manquer. On amene sur l'ecran
   Conference lui-meme : un marqueur « Vous presidez » pour celui qui a cree
   la salle, et un bouton camera qui reutilise le vrai bouton existant. */
(function () {
  'use strict';

  /* Le president est celui qui cree la salle (comme S.isChair a l'interieur).
     On le detecte depuis l'exterieur en enveloppant create/join une fois. */
  try {
    if (window.CPRemote && !CPRemote.__cpmChairFlag) {
      var _c = CPRemote.create, _j = CPRemote.join;
      if (typeof _c === 'function') CPRemote.create = function () { window.__cpmChair = true; return _c.apply(CPRemote, arguments); };
      if (typeof _j === 'function') CPRemote.join = function () { window.__cpmChair = false; return _j.apply(CPRemote, arguments); };
      CPRemote.__cpmChairFlag = true;
    }
  } catch (e) {}

  function salleOuverte() {
    var fab = document.getElementById('cpmFab');
    return !!(fab && fab.classList.contains('on'));
  }

  function poserBarrePresident() {
    var conf = document.getElementById('conference');
    if (!conf || (conf.getAttribute('class') || '').indexOf('active') < 0) return;
    var ancre = document.querySelector('.conf-start-btn');
    if (!ancre) return;
    var bar = document.getElementById('cpmChairBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cpmChairBar';
      bar.style.cssText = 'margin:10px 24px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap';
      var badge = document.createElement('div');
      badge.id = 'cpmChairBadge';
      badge.style.cssText = 'font-size:13px;font-weight:600;color:#c9a45c;display:none';
      badge.textContent = '🪑 Vous présidez la séance';
      var cam = document.createElement('button');
      cam.id = 'cpmChairCam';
      cam.type = 'button';
      cam.setAttribute('aria-label', 'Activer ma caméra');
      cam.style.cssText = 'padding:10px 16px;border:1px solid #4f8ef7;border-radius:12px;background:rgba(79,142,247,.12);color:#e8edf5;font-size:13px;font-weight:600;cursor:pointer';
      cam.textContent = '🎥 Activer ma caméra';
      cam.addEventListener('click', function () {
        var vrai = document.getElementById('cpmCam');
        if (!vrai || !salleOuverte()) {
          cam.textContent = '🎥 Ouvrez la salle d\'abord (partagez le lien)';
          setTimeout(function () { majBarre(); }, 2500);
          return;
        }
        try { vrai.click(); } catch (e) {}
        cam.__on = !cam.__on;
        cam.textContent = cam.__on ? '🎥 Caméra activée — toucher pour couper' : '🎥 Activer ma caméra';
      });
      bar.appendChild(badge);
      bar.appendChild(cam);
      ancre.parentElement.insertBefore(bar, ancre);
    }
    majBarre();
  }

  function majBarre() {
    var badge = document.getElementById('cpmChairBadge');
    if (badge) badge.style.display = window.__cpmChair ? '' : 'none';
    var cam = document.getElementById('cpmChairCam');
    if (cam && !cam.__on) {
      cam.textContent = salleOuverte() ? '🎥 Activer ma caméra' : '🎥 Activer ma caméra (dès l\'ouverture de la salle)';
    }
  }

  setInterval(function () { try { poserBarrePresident(); } catch (e) {} }, 2000);
})();

/* ═════════════════════════════════════════════════════════════════════
   CACHE DU JETON AZURE — ne plus le redemander a chaque phrase
   La synthese (speakText) demandait un jeton au serveur POUR CHAQUE phrase.
   Sans cache, une conference active vidait la limite du serveur en quelques
   minutes : la voix s'arretait, le texte continuait. Un jeton Azure vaut dix
   minutes ; on le garde 8 min et on le reutilise. Les appels a /api/token
   tombent de un-par-phrase a environ un toutes les 8 minutes, et la synthese
   demarre plus vite (plus d'aller-retour serveur avant de parler).
   On enveloppe fetch : seul /api/token en GET est mis en cache, tout le
   reste passe inchange. */
(function () {
  'use strict';
  if (window.fetch && window.fetch.__cpmTokCache) return;
  var cache = null, cacheAt = 0, TTL = 8 * 60 * 1000;
  var orig = window.fetch;
  if (typeof orig !== 'function') return;
  var enveloppe = function (url, opts) {
    try {
      var u = (typeof url === 'string') ? url : (url && url.url) || '';
      var m = (opts && opts.method ? opts.method : (url && url.method) || 'GET').toUpperCase();
      if (u.indexOf('/api/token') >= 0 && m === 'GET') {
        if (cache && (Date.now() - cacheAt) < TTL) return Promise.resolve(cache.clone());
        return orig.apply(this, arguments).then(function (r) {
          if (r && r.ok) { try { cache = r.clone(); cacheAt = Date.now(); } catch (e) {} }
          return r;
        });
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  enveloppe.__cpmTokCache = true;
  enveloppe.__orig = orig;
  window.fetch = enveloppe;
})();

/* ═════════════════════════════════════════════════════════════════════
   REMOTE CALL — deverrouiller le son pour CELUI QUI ECOUTE
   La conference (cote animateur) joue par un element <audio> deverrouille
   largement. Remote Call ET les participants qui rejoignent une conference
   a distance jouent par un AudioContext, deverrouille seulement dans
   toggleMic (au moment ou l'on touche le micro). Or l'auditeur ne touche
   jamais son micro : il ecoute. Son AudioContext reste suspendu par la
   politique iOS/Android, et il n'entend rien. On le deverrouille au PREMIER
   geste, quel qu'il soit, en reveillant le contexte deja expose par
   cp-remote.js via window._getRemoteAudioCtx. */
(function () {
  'use strict';
  function reveiller() {
    try {
      if (typeof window._getRemoteAudioCtx === 'function') {
        var c = window._getRemoteAudioCtx();
        if (c && c.state === 'suspended' && typeof c.resume === 'function') {
          c.resume().catch(function () {});
        }
      }
    } catch (e) {}
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, reveiller, { capture: true, passive: true });
  });
})();
