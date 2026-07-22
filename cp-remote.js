/**
 * cp-remote.js — Appel traduit à distance pour Equivox
 * À inclure dans index.html : <script src="cp-remote.js"></script>
 *
 * Dépend du SDK Azure Speech déjà chargé par l'app (SpeechSDK).
 *
 * Public API:
 *   CPRemote.create(opts)          — create a room, returns Promise<{room}>
 *   CPRemote.join(code, opts)      — join a room, returns Promise<{room}>
 *   CPRemote.startSpeaking()       — begin STT + translation broadcast
 *   CPRemote.stopSpeaking()        — stop STT
 *   CPRemote.startAudioStream()    — stream raw microphone audio to room (original voice)
 *   CPRemote.stopAudioStream()     — stop audio streaming
 *   CPRemote.setLanguage(code, speechCode)
 *   CPRemote.leave()               — disconnect
 *   CPRemote.on(cb)                — event callback: (type, data) => {}
 *   CPRemote.room                  — current room code
 *   CPRemote.peers                 — current participants array
 *
 * Events emitted via on(cb):
 *   joined          — {room, participants}
 *   roster          — {participants}
 *   partial         — {text}  (your own interim speech, local only)
 *   final           — {original, translations}  (your own final speech, local only)
 *   utterance       — {srcLang, original, translations}  (from server)
 *   partial_utterance — {srcLang, original, translations}  (interim, from server)
 *   audio_chunk     — {data, mimeType, isFirst, seq}  (raw audio from speaker)
 *   audio_started   — {mimeType}
 *   audio_error     — {error}
 *   invite          — {room}  (auto-detected join from URL hash)
 *   closed          — {}
 *   error           — {error}
 */
(function () {
  const CP_SERVER_URL = 'https://cp-server-kdbg.onrender.com';
  const WS_URL = CP_SERVER_URL.replace(/^http/, 'ws') + '/ws';

  const state = {
    ws: null,
    room: null,
    myName: 'Guest',
    myLang: 'en',
    mySpeechLang: 'en-US',
    peers: [],
    recognizer: null,
    ttsQueue: Promise.resolve(),
    onEvent: () => {},
  };

  // ── Azure token ──────────────────────────────────────────────────
  async function getAzureToken() {
    const r = await fetch(CP_SERVER_URL + '/api/token');
    if (!r.ok) throw new Error('Azure token unavailable');
    return r.json(); // {token, region}
  }

  // ── WebSocket connection ─────────────────────────────────────────
  function connect(action, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: action,
          room: opts.room,
          name: state.myName,
          lang: state.myLang,
        }));
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.type === 'joined') {
          state.room = m.room;
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('joined', m);
          resolve(m);
        } else if (m.type === 'roster') {
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('roster', m);
        } else if (m.type === 'utterance') {
          // Final translated utterance from any room participant
          state.onEvent('utterance', m);
          speakTranslation(m);
        } else if (m.type === 'partial_utterance') {
          // Interim/streaming translation for instant preview
          state.onEvent('partial_utterance', m);
        } else if (m.type === 'audio_chunk') {
          // Raw audio from the speaker for original voice playback
          state.onEvent('audio_chunk', m);
        } else if (m.type === 'error') {
          state.onEvent('error', m);
          reject(new Error(m.error));
        }
      };

      ws.onclose = () => state.onEvent('closed', {});
      ws.onerror = () => reject(new Error('Cannot connect to Equivox conference server'));
    });
  }

  // ── STT + translation → broadcast to room ───────────────────────
  async function startSpeaking() {
    const { token, region } = await getAzureToken();
    const cfg = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
    cfg.speechRecognitionLanguage = state.mySpeechLang;

    const targets = [...new Set(state.peers.map(p => p.lang))].filter(l => l && l !== state.myLang);
    if (targets.length === 0) targets.push(state.myLang === 'en' ? 'fr' : 'en');
    targets.forEach(l => cfg.addTargetLanguage(l));

    const audio = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const rec = new SpeechSDK.TranslationRecognizer(cfg, audio);
    state.recognizer = rec;

    // Interim results → instant preview for attendees
    rec.recognizing = (_s, e) => {
      const text = e.result.text;
      state.onEvent('partial', { text });

      // Broadcast partial translation so attendees see text as you speak
      if (state.ws?.readyState === WebSocket.OPEN && text) {
        const pt = {};
        targets.forEach(l => {
          const t = e.result.translations.get(l);
          if (t) pt[l] = t;
        });
        if (Object.keys(pt).length > 0) {
          state.ws.send(JSON.stringify({
            type: 'partial_utterance',
            srcLang: state.myLang,
            original: text,
            translations: pt,
          }));
        }
      }
    };

    // Final recognized sentence → broadcast with full translations
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

  // ── Original voice streaming ─────────────────────────────────────
  let mediaRecorder = null;
  let audioStream = null;

  async function startAudioStream() {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 }
      });

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';

      let chunkIndex = 0;
      mediaRecorder = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 24000 });

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0 || state.ws?.readyState !== WebSocket.OPEN) return;
        const buf = await e.data.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Encode as base64 in chunks to avoid large strings
        let binary = '';
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        const base64 = btoa(binary);

        state.ws.send(JSON.stringify({
          type: 'audio_chunk',
          data: base64,
          mimeType,
          isFirst: chunkIndex === 0,
          seq: chunkIndex,
        }));
        chunkIndex++;
      };

      mediaRecorder.start(200); // 200ms chunks → ~4 per second, low latency
      state.onEvent('audio_started', { mimeType });
    } catch (err) {
      console.warn('[CPRemote] Audio stream error:', err);
      state.onEvent('audio_error', { error: err.message });
    }
  }

  function stopAudioStream() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder = null;
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
  }

  // ── TTS: play received translation through speakers ──────────────
  const TTS_VOICES = {
    fr: 'fr-CA-JeanNeural',     en: 'en-US-GuyNeural',
    es: 'es-MX-JorgeNeural',   de: 'de-DE-ConradNeural',
    pt: 'pt-BR-AntonioNeural',  ar: 'ar-SA-HamedNeural',
    zh: 'zh-CN-YunxiNeural',    ja: 'ja-JP-KeitaNeural',
    ko: 'ko-KR-InJoonNeural',   ru: 'ru-RU-DmitryNeural',
    hi: 'hi-IN-MadhurNeural',   it: 'it-IT-DiegoNeural',
    nl: 'nl-NL-MaartenNeural',  pl: 'pl-PL-MarekNeural',
    sv: 'sv-SE-MattiasNeural',  tr: 'tr-TR-AhmetNeural',
    ht: 'fr-CA-JeanNeural',     sw: 'sw-KE-RafikiNeural',
    el: 'el-GR-NestorasNeural', vi: 'vi-VN-NamMinhNeural',
  };

  function speakTranslation(m) {
    const text = m.translations?.[state.myLang];
    if (!text) return;

    // Queue TTS so overlapping utterances play in order
    state.ttsQueue = state.ttsQueue.then(() => new Promise(async (resolve) => {
      try {
        const { token, region } = await getAzureToken();
        const cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
        cfg.speechSynthesisVoiceName = TTS_VOICES[state.myLang] || 'en-US-GuyNeural';

        // ✅ Route audio to the default speaker
        const ac = SpeechSDK.AudioConfig.fromDefaultSpeakerOutput();
        const synth = new SpeechSDK.SpeechSynthesizer(cfg, ac);

        synth.speakTextAsync(
          text,
          () => { synth.close(); resolve(); },
          (err) => { console.warn('[CPRemote] TTS error:', err); synth.close(); resolve(); }
        );
      } catch (err) {
        console.warn('[CPRemote] TTS setup error:', err);
        resolve();
      }
    }));
  }

  // ── Change language mid-call ─────────────────────────────────────
  function setLanguage(shortCode, speechCode) {
    state.myLang = shortCode;
    state.mySpeechLang = speechCode;
    state.ws?.send(JSON.stringify({ type: 'lang', lang: shortCode }));
  }

  // ── Public API ───────────────────────────────────────────────────
  window.CPRemote = {
    create:          (o) => { Object.assign(state, mapOpts(o)); return connect('create'); },
    join:            (code, o) => { Object.assign(state, mapOpts(o)); return connect('join', { room: code }); },
    startSpeaking,
    stopSpeaking,
    startAudioStream,
    stopAudioStream,
    setLanguage,
    leave:           () => { stopSpeaking(); stopAudioStream(); state.ws?.close(); },
    on:              (cb) => { state.onEvent = cb; },
    sendRaw:         (obj) => state.ws?.send(JSON.stringify(obj)),
    get room()       { return state.room; },
    get peers()      { return state.peers; },
  };

  function mapOpts(o = {}) {
    return {
      myName:       o.name       || 'Guest',
      myLang:       o.lang       || 'en',
      mySpeechLang: o.speechLang || 'en-US',
    };
  }

  // Auto-join via shared link …/#join=K7Q2
  window.addEventListener('load', () => {
    const match = location.hash.match(/join=([A-Za-z0-9]{4})/i);
    if (match) state.onEvent('invite', { room: match[1].toUpperCase() });
  });
})();
