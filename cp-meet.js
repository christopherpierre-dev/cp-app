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
    localStream: null,
    videoOn: false,
    micMuted: false,
    handUp: false,
    open: false,             // panneau visible
    tab: 'chat',
    unread: 0,
    booted: false,
  };

  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ],
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const send = (obj) => {
    try {
      const R = window.CPRemote;
      if (R && typeof R.sendRaw === 'function') R.sendRaw(obj);
    } catch (e) {}
  };

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
      <button class="cpm-btn" id="cpmCam"  title="Caméra">🎥</button>
      <button class="cpm-btn" id="cpmHand" title="Lever la main">✋</button>
      <button class="cpm-btn" id="cpmChat" title="Clavardage">💬<span class="cpm-badge" id="cpmUnread" style="display:none">0</span></button>`;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'cpm-panel';
    panel.id = 'cpmPanel';
    panel.innerHTML = `
      <div class="cpm-head">
        <button class="cpm-tab sel" id="cpmTabChat">💬 Chat</button>
        <button class="cpm-tab"     id="cpmTabPeople">👥 Participants</button>
        <button class="cpm-x"       id="cpmClose" aria-label="Fermer">×</button>
      </div>
      <div class="cpm-body" id="cpmBody"></div>
      <div class="cpm-foot" id="cpmFoot">
        <input class="cpm-in" id="cpmInput" placeholder="Écrire un message…" autocomplete="off">
        <button class="cpm-send" id="cpmSend">Envoyer</button>
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
          <div class="who">${esc(m.mine ? 'Vous' : m.from)}</div>
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
        <div class="cpm-nm">${esc(p.name)}${p.id === S.selfId ? ' (vous)' : ''}</div>
        ${tags.join(' ')}</div>`;
    }).join('');
  }

  // ── Clavardage ────────────────────────────────────────────────────────
  async function sendChat() {
    const input = document.getElementById('cpmInput');
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';

    chat.push({ mine: true, from: 'Vous', shown: text, orig: '' });
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
      alert("Caméra ou micro inaccessible. Vérifiez l'autorisation du navigateur.");
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
  }

  function peer(id) {
    if (S.peers.has(id)) return S.peers.get(id);
    const pc = new RTCPeerConnection(ICE);

    if (S.localStream) {
      S.localStream.getTracks().forEach(t => pc.addTrack(t, S.localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: id, kind: 'ice', payload: e.candidate });
    };

    pc.ontrack = (e) => {
      const st = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      S.streams.set(id, st);
      const p = S.roster.find(x => x.id === id);
      addTile(id, (p && p.name) || 'Participant', st, false);
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
      document.getElementById('cpmFab').classList.add('on');
      render();
    } else if (type === 'roster') {
      S.roster = data.participants || [];
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
    } else if (type === 'chat') {
      onChat(data);
    } else if (type === 'signal') {
      onSignal(data);
    } else if (type === 'closed') {
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

    // Suivre l'état du micro
    const _setMuted = R.setTtsMuted;
    if (typeof _setMuted === 'function') {
      R.setTtsMuted = function (b) { send({ type: 'state', muted: !!b }); return _setMuted.call(R, b); };
    }

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
