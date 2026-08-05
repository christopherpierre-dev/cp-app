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
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
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
  }

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

  function ensureAudioEl() {
    if (!ttsAudio) {
      ttsAudio = new Audio();
      ttsAudio.setAttribute('playsinline', '');
      ttsAudio.autoplay = false;
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
        const guard = setTimeout(() => {
          console.warn('[cp-meet] fin de lecture non signalée — file libérée');
          finish();
        }, 30000);

        duckVoices(true);                         // la vraie voix passe dessous
        a.src = url;
        a.onended = finish;
        a.onerror = finish;
        a.play().catch((e) => {
          console.warn('[cp-meet] lecture bloquée :', e && e.name,
                       '— l\'audio n\'a pas été déverrouillé par un geste');
          finish();
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
  function installSynthFunnel() {
    const SDK = window.SpeechSDK;
    if (!SDK || typeof SDK.SpeechSynthesizer !== 'function') return false;
    if (SDK.SpeechSynthesizer.__cpm) return true;

    const Orig = SDK.SpeechSynthesizer;

    function Funnelled(cfg, audioCfg) {
      // Un seul argument = haut-parleur par défaut dans le SDK Azure.
      const wantsSpeaker = (arguments.length < 2) || (audioCfg !== null && audioCfg !== undefined);
      const inst = new Orig(cfg, null);
      if (!wantsSpeaker) return inst;

      console.info('[cp-meet] sortie audio directe interceptée — '
                 + 'lecture redirigée vers le canal déverrouillé');

      const orig = inst.speakTextAsync.bind(inst);
      inst.speakTextAsync = function (text, cb, errCb) {
        if (alreadySpoken(text)) {
          if (typeof cb === 'function') cb({ audioData: new ArrayBuffer(0) });
          return;
        }
        return orig(text, (r) => {
          ttsQueue = ttsQueue.then(() => playBytes(r && r.audioData));
          if (typeof cb === 'function') { try { cb(r); } catch (_) {} }
        }, errCb);
      };
      if (typeof inst.speakSsmlAsync === 'function') {
        const origSsml = inst.speakSsmlAsync.bind(inst);
        inst.speakSsmlAsync = function (ssml, cb, errCb) {
          return origSsml(ssml, (r) => {
            ttsQueue = ttsQueue.then(() => playBytes(r && r.audioData));
            if (typeof cb === 'function') { try { cb(r); } catch (_) {} }
          }, errCb);
        };
      }
      return inst;
    }

    Funnelled.prototype = Orig.prototype;
    Funnelled.__cpm = true;
    Funnelled.__orig = Orig;
    try { SDK.SpeechSynthesizer = Funnelled; } catch (_) { return false; }
    return true;
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

  function installRecognizerFunnel() {
    const SDK = window.SpeechSDK;
    if (!SDK || typeof SDK.TranslationRecognizer !== 'function') return false;
    if (SDK.TranslationRecognizer.__cpm) return true;

    const Orig = SDK.TranslationRecognizer;
    function Wrapped(...args) {
      const inst = new Orig(...args);
      let userFn = null;
      try {
        Object.defineProperty(inst, 'recognizing', {
          configurable: true,
          get() { return userFn; },
          set(fn) {
            userFn = function (s, e) {
              try { showLivePartial(e); } catch (_) {}
              if (typeof fn === 'function') fn(s, e);
            };
          },
        });
      } catch (_) {}
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    Wrapped.__cpm = true;
    Wrapped.__orig = Orig;
    try { SDK.TranslationRecognizer = Wrapped; } catch (_) { return false; }
    return true;
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
  function fixConferenceLayout() {
    const tr = document.getElementById('confTranscript');
    if (!tr || !tr.parentElement) return;
    const p = tr.parentElement;
    const lift = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      let b = el;
      while (b && b.parentElement !== p) b = b.parentElement;   // bloc frère du transcript
      if (b && b !== tr && b.parentElement === p) p.insertBefore(b, tr);
    };
    lift('confSrcLang');
    lift('confVoiceSel');
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
    wrap.querySelector('select').addEventListener('change', (ev) => {
      localStorage.setItem(SPEAK_KEY, ev.target.value);
      const c = chosenSpeak();
      try { window.CPRemote && CPRemote.setLanguage && CPRemote.setLanguage(c.lang, c.speechLang); } catch (_) {}
    });
  }

  // Le choix ne s'applique que lorsque l'utilisateur passe par le modal
  // Remote Call — le panneau Conference garde son propre choix de langue.
  function remoteModalOpen() {
    const m = document.getElementById('remoteModal');
    return !!(m && (m.classList.contains('open') || m.style.display === 'flex'));
  }

  function installLangOnJoin(R) {
    const _create = R.create, _join = R.join;
    if (typeof _create === 'function') {
      R.create = function (o) {
        const o2 = remoteModalOpen() ? Object.assign({}, o || {}, chosenSpeak()) : o;
        if (o2 && o2.lang) S.myLang = o2.lang;
        return _create.call(R, o2);
      };
    }
    if (typeof _join === 'function') {
      R.join = function (code, o) {
        const o2 = remoteModalOpen() ? Object.assign({}, o || {}, chosenSpeak()) : o;
        if (o2 && o2.lang) S.myLang = o2.lang;
        return _join.call(R, code, o2);
      };
    }
  }

  function installAudioEngine() {
    // Toute synthèse, d'où qu'elle vienne, passe par le canal unique.
    installSynthFunnel();
    // Traduction partielle pendant la parole (Two-Way).
    installRecognizerFunnel();
    // Réparations d'interface effacées par la restauration.
    fixConferenceLayout();
    installSpeakPicker();

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
    body.innerHTML = S.roster.map(p => {
      const ini = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      const tags = [];
      if (p.hand) tags.push('<span class="cpm-tag">✋ main levée</span>');
      if (p.muted) tags.push('<span class="cpm-tag">🔇</span>');
      if (p.video) tags.push('<span class="cpm-tag">🎥</span>');
      if (p.lang) tags.push(`<span class="cpm-tag">${esc(String(p.lang).toUpperCase())}</span>`);
      return `<div class="cpm-row"><div class="cpm-av">${esc(ini)}</div>
        <div class="cpm-nm">${esc(p.name)}${p.id === S.selfId ? ' (you)' : ''}</div>
        ${tags.join(' ')}</div>`;
    }).join('');
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
    send({ type: 'state', hand: S.handUp });
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
      render();
    } else if (type === 'roster') {
      S.roster = data.participants || [];
      S.rosterMax = Math.max(S.rosterMax || 0, S.roster.length);
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
    let tries = 0;
    const t = setInterval(() => {
      installAudioEngine();
      if (++tries > 50) {                   // ~10 s au maximum
        clearInterval(t);
        if (!(window.SpeechSDK && window.SpeechSDK.SpeechSynthesizer
              && window.SpeechSDK.SpeechSynthesizer.__cpm)) {
          console.warn('[cp-meet] collecteur de synthèse non installé — '
                     + 'le SDK Azure n\'a pas été chargé');
        }
      }
    }, 200);

    // Exposé pour diagnostic et pour un usage externe éventuel
    window.CPAudio = {
      speak: speakText,
      unlock: unlockAudio,
      get ready() { return ttsUnlocked; },
      get owned() { return ttsOwned; },
      get funnelled() {
        return !!(window.SpeechSDK && window.SpeechSDK.SpeechSynthesizer
                  && window.SpeechSDK.SpeechSynthesizer.__cpm);
      },
    };

    window.CPMeet = {
      openChat: () => toggle(true, 'chat'),
      openPeople: () => toggle(true, 'people'),
      toggleCamera: toggleCam,
      raiseHand: toggleHand,
      get state() { return { videoOn: S.videoOn, handUp: S.handUp, peers: S.peers.size, roster: S.roster.length }; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
