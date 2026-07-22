/**
 * cp-remote.js — Appel traduit à distance pour Equivox
 * À inclure dans index.html : <script src="cp-remote.js"></script>
 *
 * Dépend du SDK Azure Speech déjà chargé par l'app (SpeechSDK).
 */
(function () {
  const CP_SERVER_URL = 'https://cp-server-kdbg.onrender.com';
  const WS_URL = CP_SERVER_URL.replace(/^http/, 'ws') + '/ws';

  const state = {
    ws: null, room: null, myName: 'Moi', myLang: 'fr', mySpeechLang: 'fr-FR',
    peers: [], recognizer: null, ttsQueue: Promise.resolve(), onEvent: () => {},
  };

  async function getAzureToken() {
    const r = await fetch(CP_SERVER_URL + '/api/token');
    if (!r.ok) throw new Error('Jeton Azure indisponible');
    return r.json();
  }

  function connect(action, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      state.ws = ws;
      ws.onopen = () => { ws.send(JSON.stringify({ type: action, room: opts.room, name: state.myName, lang: state.myLang })); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'joined') { state.room = m.room; state.peers = m.participants.filter(p => p.name !== state.myName); state.onEvent('joined', m); resolve(m); }
        else if (m.type === 'roster') { state.peers = m.participants.filter(p => p.name !== state.myName); state.onEvent('roster', m); }
        else if (m.type === 'utterance') { state.onEvent('utterance', m); speakTranslation(m); }
        else if (m.type === 'error') { state.onEvent('error', m); reject(new Error(m.error)); }
      };
      ws.onclose = () => state.onEvent('closed', {});
      ws.onerror = () => reject(new Error('Connexion au serveur CP impossible'));
    });
  }

  async function startSpeaking() {
    const { token, region } = await getAzureToken();
    const cfg = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
    cfg.speechRecognitionLanguage = state.mySpeechLang;
    const targets = [...new Set(state.peers.map(p => p.lang))].filter(l => l && l !== state.myLang);
    if (targets.length === 0) targets.push(state.myLang === 'fr' ? 'en' : 'fr');
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
      state.ws?.send(JSON.stringify({ type: 'utterance', srcLang: state.myLang, original: e.result.text, translations }));
    };
    rec.startContinuousRecognitionAsync();
  }

  function stopSpeaking() {
    state.recognizer?.stopContinuousRecognitionAsync(() => { state.recognizer?.close(); state.recognizer = null; });
  }

  const TTS_VOICES = {
    fr: 'fr-CA-JeanNeural', en: 'en-US-GuyNeural', es: 'es-MX-JorgeNeural', de: 'de-DE-ConradNeural',
    pt: 'pt-BR-AntonioNeural', ar: 'ar-SA-HamedNeural', zh: 'zh-CN-YunxiNeural', ja: 'ja-JP-KeitaNeural',
    ko: 'ko-KR-InJoonNeural', ru: 'ru-RU-DmitryNeural', hi: 'hi-IN-MadhurNeural', it: 'it-IT-DiegoNeural',
    nl: 'nl-NL-MaartenNeural', pl: 'pl-PL-MarekNeural', sv: 'sv-SE-MattiasNeural', tr: 'tr-TR-AhmetNeural',
    ht: 'fr-CA-JeanNeural', sw: 'sw-KE-RafikiNeural',
  };

  function speakTranslation(m) {
    const text = m.translations?.[state.myLang];
    if (!text) return;
    state.ttsQueue = state.ttsQueue.then(() => new Promise(async (resolve) => {
      try {
        const { token, region } = await getAzureToken();
        const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
        cfg.speechSynthesisVoiceName = TTS_VOICES[state.myLang] || 'en-US-GuyNeural';
        const ac = SpeechSDK.AudioConfig.fromDefaultSpeakerOutput();
        const synth = new SpeechSDK.SpeechSynthesizer(cfg, ac);
        synth.speakTextAsync(text, () => { synth.close(); resolve(); }, (err) => { console.warn('[CPRemote] TTS error:', err); synth.close(); resolve(); });
      } catch (err) { console.warn('[CPRemote] TTS setup error:', err); resolve(); }
    }));
  }

  function setLanguage(shortCode, speechCode) {
    state.myLang = shortCode; state.mySpeechLang = speechCode;
    state.ws?.send(JSON.stringify({ type: 'lang', lang: shortCode }));
  }

  window.CPRemote = {
    create: (o) => { Object.assign(state, mapOpts(o)); return connect('create'); },
    join: (code, o) => { Object.assign(state, mapOpts(o)); return connect('join', { room: code }); },
    startSpeaking, stopSpeaking, setLanguage,
    leave: () => { stopSpeaking(); state.ws?.close(); },
    on: (cb) => { state.onEvent = cb; },
    get room() { return state.room; },
    get peers() { return state.peers; },
  };

  function mapOpts(o = {}) {
    return { myName: o.name || 'Guest', myLang: o.lang || 'en', mySpeechLang: o.speechLang || 'en-US' };
  }

  window.addEventListener('load', () => {
    const match = location.hash.match(/join=([A-Za-z0-9]{4})/);
    if (match) state.onEvent('invite', { room: match[1].toUpperCase() });
  });
})();
