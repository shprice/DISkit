// DIS audio manager – streams decoded PCM frames to the browser.
// Secure contexts (HTTPS / localhost): AudioWorklet ring buffer — hardware-clock
// driven, immune to JS timer jitter, click-free.
// Non-secure contexts (HTTP remote): AudioBufferSourceNode fallback with a 500ms
// jitter buffer — works everywhere but slightly more susceptible to gaps.
// Exposed as window.AudioMgr (singleton).

// ── Worklet-backed channel (secure context) ─────────────────────────────────

class WorkletChannel {
  constructor(ctx, workletNode) {
    this.ctx  = ctx;
    this.pan  = 0;
    this.gain = 1;
    this.muted = false;
    this._node = workletNode;
    this._lastActive = 0;
    this._panner   = new StereoPannerNode(ctx, { pan: 0 });
    this._gainNode = new GainNode(ctx, { gain: 1 });
    this._node.connect(this._panner).connect(this._gainNode).connect(ctx.destination);
  }

  play(pcmInt16, sampleRate) {
    if (this.muted || pcmInt16.length === 0) return;
    const ratio   = this.ctx.sampleRate / sampleRate;
    const outLen  = Math.round(pcmInt16.length * ratio);
    const float32 = new Float32Array(outLen);
    const last    = pcmInt16.length - 1;
    for (let i = 0; i < outLen; i++) {
      const pos  = i / ratio;
      const lo   = Math.floor(pos);
      const frac = pos - lo;
      const a    = pcmInt16[lo]                      / 32768;
      const b    = pcmInt16[lo < last ? lo + 1 : lo] / 32768;
      float32[i] = a + frac * (b - a);
    }
    this._node.port.postMessage({ samples: float32 }, [float32.buffer]);
    this._lastActive = Date.now();
  }

  setPan(v)  { this.pan = v; this._panner.pan.setValueAtTime(v, this.ctx.currentTime); }
  setGain(v) {
    this.gain = v;
    if (!this.muted) this._gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }
  setMute(v) {
    this.muted = v;
    const now = this.ctx.currentTime;
    if (v) {
      this._gainNode.gain.setTargetAtTime(0, now, 0.005);
      this._node.port.postMessage({ cmd: 'reset' });
    } else {
      this._gainNode.gain.setTargetAtTime(this.gain, now, 0.01);
    }
  }
  isActive() { return Date.now() - this._lastActive < 3000; }
}

// ── AudioBufferSourceNode fallback (non-secure / HTTP remote clients) ────────

class FallbackChannel {
  constructor(ctx) {
    this.ctx  = ctx;
    this.pan  = 0;
    this.gain = 1;
    this.muted = false;
    this._nextTime   = 0;
    this._lastActive = 0;
    this._pending    = [];
    this._panner   = new StereoPannerNode(ctx, { pan: 0 });
    this._gainNode = new GainNode(ctx, { gain: 1 });
    this._panner.connect(this._gainNode).connect(ctx.destination);
  }

  play(pcmInt16, sampleRate) {
    if (this.muted || pcmInt16.length === 0) return;
    const buf  = this.ctx.createBuffer(1, pcmInt16.length, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcmInt16.length; i++) data[i] = pcmInt16[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._panner);
    const now = this.ctx.currentTime;
    if (this._nextTime === 0 || this._nextTime < now - 0.5) {
      this._nextTime = now + 0.500; // 500ms jitter buffer
    }
    src.start(this._nextTime);
    this._nextTime += buf.duration;
    this._lastActive = Date.now();
    this._pending.push(src);
    src.onended = () => {
      const i = this._pending.indexOf(src);
      if (i >= 0) this._pending.splice(i, 1);
    };
  }

  setPan(v)  { this.pan = v; this._panner.pan.setValueAtTime(v, this.ctx.currentTime); }
  setGain(v) {
    this.gain = v;
    if (!this.muted) this._gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }
  setMute(v) {
    this.muted = v;
    const now = this.ctx.currentTime;
    if (v) {
      this._gainNode.gain.setTargetAtTime(0, now, 0.005);
      this._pending.forEach(s => { try { s.stop(now + 0.02); } catch {} });
      this._pending  = [];
      this._nextTime = 0;
    } else {
      this._gainNode.gain.setTargetAtTime(this.gain, now, 0.01);
    }
  }
  isActive() { return Date.now() - this._lastActive < 3000; }
}

// ── Manager ──────────────────────────────────────────────────────────────────

class AudioManager {
  constructor() {
    this._ctx        = null;
    this._useWorklet = false;
    this._ready      = false;
    this._channels   = new Map();
    this._pending    = [];
    this.onUpdate    = null;
  }

  async _init() {
    if (this._ctx) return;
    this._ctx = new AudioContext();
    // Retry resume on every user gesture (Chrome blocks without one)
    const tryResume = () => {
      if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
    };
    document.addEventListener('click',   tryResume);
    document.addEventListener('keydown', tryResume);
    try { await this._ctx.resume(); } catch {}

    // AudioWorklet requires a secure context (HTTPS or localhost)
    if (window.isSecureContext && this._ctx.audioWorklet) {
      try {
        await this._ctx.audioWorklet.addModule('/audio-worklet.js');
        this._useWorklet = true;
        console.log(`[audio] worklet ready, sampleRate=${this._ctx.sampleRate}, state=${this._ctx.state}`);
      } catch (e) {
        console.warn('[audio] AudioWorklet failed, using fallback:', e);
      }
    } else {
      console.log('[audio] non-secure context, using AudioBufferSourceNode fallback');
    }

    this._ready = true;
    for (const { key, sr, pcm } of this._pending) this._getChannel(key).play(pcm, sr);
    this._pending = [];
  }

  _getChannel(key) {
    if (!this._channels.has(key)) {
      const ch = this._useWorklet
        ? new WorkletChannel(this._ctx, new AudioWorkletNode(this._ctx, 'dis-stream'))
        : new FallbackChannel(this._ctx);
      this._channels.set(key, ch);
      this.onUpdate?.();
    }
    return this._channels.get(key);
  }

  ingestFrame(key, sampleRate, pcmInt16) {
    if (!this._ctx) this._init().catch(console.error);
    else if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    if (!this._ready) {
      this._pending.push({ key, sr: sampleRate, pcm: pcmInt16 });
      if (this._pending.length > 100) this._pending.shift();
      return;
    }
    this._getChannel(key).play(pcmInt16, sampleRate);
  }

  setPan(key, v)  { this._channels.get(key)?.setPan(v);  this.onUpdate?.(); }
  setGain(key, v) { this._channels.get(key)?.setGain(v); this.onUpdate?.(); }
  setMute(key, v) { this._channels.get(key)?.setMute(v); this.onUpdate?.(); }

  getChannels() {
    return [...this._channels.entries()].map(([key, ch]) => ({
      key, pan: ch.pan, gain: ch.gain, muted: ch.muted, active: ch.isActive(),
    }));
  }

  async setOutputDevice(deviceId) {
    if (!this._ctx?.setSinkId) return;
    try { await this._ctx.setSinkId(deviceId); } catch (e) { console.warn('setSinkId:', e); }
  }

  async enumerateOutputDevices() {
    try {
      // getUserMedia unlocks labelled device names in Chrome
      await navigator.mediaDevices.getUserMedia({ audio: true })
        .then(s => s.getTracks().forEach(t => t.stop()))
        .catch(() => {});
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === 'audiooutput');
    } catch { return []; }
  }
}

window.AudioMgr = new AudioManager();
