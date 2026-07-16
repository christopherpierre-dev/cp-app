/**
 * cp-remote.js — Appel traduit à distance pour Communication Properly
 * À inclure dans index.html : <script src="cp-remote.js"></script>
 *
 * Dépend du SDK Azure Speech déjà chargé par l'app (SpeechSDK).
 * Voir INTEGRATION.md pour le branchement dans l'UI.
 */
(function () {
  // ⚠️ Renseigner l'URL du serveur déployé (https obligatoire)
  const CP_SERVER_URL = 'https://cp-server-kdbg.onrender.com';

  const WS_URL = CP_SERVER_URL.replace(/^http/, 'ws') + '/ws';

  const state = {
    ws: null,
    room: null,
    myName: 'Moi',
    myLang: 'fr',        // code court (fr, en, es…) — voir LANG_TRANS de l'app
    mySpeechLang: 'fr-FR', // code STT — voir LANG_SPEECH de l'app
    peers: [],           // [{name, lang}]
    recognizer: null,
    onEvent: () => {},   // callback UI : (type, data) => {}
  };

  // ── Jeton Azure éphémère (remplace la clé collée par l'utilisateur) ──
  async function getAzureToken() {
    const r = await fetch(CP_SERVER_URL + '/api/token');
    if (!r.ok) throw new Error('Jeton Azure indisponible');
    return r.json(); // {token, region}
  }

  // ── Connexion / salles ────────────────────────────────────────────
  function connect(action, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: action, // 'create' | 'join'
          room: opts.room,
          name: state.myName,
          lang: state.myLang,
        }));
      };

      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'joined') {
          state.room = m.room;
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('joined', m);
          resolve(m);
        } else if (m.type === 'roster') {
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('roster', m);
        } else if (m.type === 'utterance') {
          state.onEvent('utterance', m);
          speakTranslation(m); // lecture TTS de la traduction dans MA langue
        } else if (m.type === 'error') {
          state.onEvent('error', m);
          reject(new Error(m.error));
        }
      };

      ws.onclose = () => state.onEvent('closed', {});
      ws.onerror = () => reject(new Error('Connexion au serveur CP impossible'));
    });
  }

  // ── Reconnaissance + traduction locale, puis envoi à la salle ─────
  async function startSpeaking() {
    const { token, region } = await getAzureToken();
    const cfg = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
    cfg.speechRecognitionLanguage = state.mySpeechLang;

    // Traduire vers la langue de chaque participant distant
    const targets = [...new Set(state.peers.map(p => p.lang))].filter(l => l && l !== state.myLang);
    if (targets.length === 0) targets.push(state.myLang === 'fr' ? 'en' : 'fr'); // défaut
    targets.forEach(l => cfg.addTargetLanguage(l));

    const audio = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const rec = new SpeechSDK.TranslationRecognizer(cfg, audio);
    state.recognizer = rec;

    rec.recognizing = (_s, e) => state.onEvent('partial', { text: e.result.text });

    rec.recognized = (_s, e) => {
      if (e.result.reason !== SpeechSDK.ResultReason.TranslatedSpeech || !e.result.text) return;
      const translations = {};
      targets.forEach(l => { translations[l] = e.result.translations.get(l); });
      state.onEvent('final', { original: e.result.text, translations });
      state.ws?.send(JSON.stringify({
        type: 'utterance',
        srcLang: state.myLang,
        original: e.result.text,
        translations,
      }));
    };

    rec.startContinuousRecognitionAsync();
  }

  function stopSpeaking() {
    state.recognizer?.stopContinuousRecognitionAsync(() => {
      state.recognizer?.close();
      state.recognizer = null;
    });
  }

  // ── Synthèse vocale : lire la traduction reçue dans ma langue ─────
  const TTS_VOICES = {
    fr: 'fr-CA-SylvieNeural', en: 'en-US-JennyNeural', es: 'es-ES-ElviraNeural',
    de: 'de-DE-KatjaNeural', pt: 'pt-BR-FranciscaNeural', ar: 'ar-SA-ZariyahNeural',
    ht: 'fr-CA-SylvieNeural', // pas de voix créole : repli français
  };

  async function speakTranslation(m) {
    const text = m.translations?.[state.myLang];
    if (!text) return;
    try {
      const { token, region } = await getAzureToken();
      const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
      cfg.speechSynthesisVoiceName = TTS_VOICES[state.myLang] || 'en-US-JennyNeural';
      const synth = new SpeechSDK.SpeechSynthesizer(cfg);
      synth.speakTextAsync(text, () => synth.close(), () => synth.close());
    } catch (_) { /* affichage texte seulement */ }
  }

  // ── Changement de langue en cours d'appel ─────────────────────────
  function setLanguage(shortCode, speechCode) {
    state.myLang = shortCode;
    state.mySpeechLang = speechCode;
    state.ws?.send(JSON.stringify({ type: 'lang', lang: shortCode }));
  }

  // ── API publique ──────────────────────────────────────────────────
  window.CPRemote = {
    /** CPRemote.create({name, lang, speechLang}) → Promise<{room}> */
    create: (o) => { Object.assign(state, mapOpts(o)); return connect('create'); },
    /** CPRemote.join(code, {name, lang, speechLang}) */
    join: (code, o) => { Object.assign(state, mapOpts(o)); return connect('join', { room: code }); },
    startSpeaking,
    stopSpeaking,
    setLanguage,
    leave: () => { stopSpeaking(); state.ws?.close(); },
    /** CPRemote.on((type, data) => {...})  types: joined|roster|partial|final|utterance|error|closed */
    on: (cb) => { state.onEvent = cb; },
    get room() { return state.room; },
    get peers() { return state.peers; },
  };

  function mapOpts(o = {}) {
    return {
      myName: o.name || 'Invité',
      myLang: o.lang || 'fr',
      mySpeechLang: o.speechLang || 'fr-FR',
    };
  }

  // Rejoindre automatiquement via lien partagé …/#join=K7Q2
  window.addEventListener('load', () => {
    const match = location.hash.match(/join=([A-Za-z0-9]{4})/);
    if (match) state.onEvent('invite', { room: match[1].toUpperCase() });
  });
})();
