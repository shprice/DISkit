// DIS audio manager – plays decoded PCM frames from the server via Web Audio API.
// Exposed as window.AudioMgr (singleton).

class AudioChannel {
  constructor(ctx) {
    this.ctx = ctx;
    this.pan = 0;
    this.gain = 1;
    this.muted = false;
    this._nextTime = 0;
    this._lastActive = 0;
    this._panner = new StereoPannerNode(ctx, { pan: 0 });
    this._gainNode = new GainNode(ctx, { gain: 1 });
    this._panner.connect(this._gainNode).connect(ctx.destination);
  }

  play(pcmInt16, sampleRate) {
    if (this.muted || pcmInt16.length === 0) return;
    const buf = this.ctx.createBuffer(1, pcmInt16.length, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcmInt16.length; i++) data[i] = pcmInt16[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._panner);
    const now = this.ctx.currentTime;
    if (this._nextTime < now + 0.04) this._nextTime = now + 0.04;
    src.start(this._nextTime);
    this._nextTime += buf.duration;
    this._lastActive = Date.now();
  }

  setPan(v) { this.pan = v; this._panner.pan.setValueAtTime(v, this.ctx.currentTime); }
  setGain(v) { this.gain = v; if (!this.muted) this._gainNode.gain.setValueAtTime(v, this.ctx.currentTime); }
  setMute(v) { this.muted = v; this._gainNode.gain.setValueAtTime(v ? 0 : this.gain, this.ctx.currentTime); }
  isActive() { return Date.now() - this._lastActive < 3000; }
}

class AudioManager {
  constructor() {
    this._ctx = null;
    this._channels = new Map();
    this.onUpdate = null;
  }

  _ctx_() {
    if (!this._ctx) this._ctx = new AudioContext();
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    return this._ctx;
  }

  ingestFrame(key, sampleRate, pcmInt16) {
    const isNew = !this._channels.has(key);
    if (isNew) this._channels.set(key, new AudioChannel(this._ctx_()));
    this._channels.get(key).play(pcmInt16, sampleRate);
    if (isNew) this.onUpdate?.();
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
    const ctx = this._ctx_();
    if (ctx.setSinkId) {
      try { await ctx.setSinkId(deviceId); } catch (e) { console.warn('setSinkId:', e); }
    }
  }

  async enumerateOutputDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === 'audiooutput');
    } catch { return []; }
  }
}

window.AudioMgr = new AudioManager();
