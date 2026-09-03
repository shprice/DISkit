// AudioWorklet processor for real-time DIS audio streaming.
// Runs on the audio hardware thread — immune to JavaScript timer jitter.
// Accepts pre-upsampled Float32 chunks via postMessage and drains them
// continuously via process(), with a ring buffer to decouple the two rates.

class DISStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._SIZE = 524288;                               // ~11s at 48000 Hz
    this._ring = new Float32Array(this._SIZE);
    this._wp = 0;
    this._rp = 0;
    this._PREROLL      = Math.round(sampleRate * 0.25); // 250ms before first output
    this._MAX          = Math.round(sampleRate * 0.6);  // cap: never buffer more than 600ms
    this._SILENCE_RESET = Math.round(sampleRate * 0.4); // reset preroll after 400ms silence
    this._started = false;
    this._silentSamples = 0;

    this.port.onmessage = ({ data }) => {
      if (data.cmd === 'reset') {
        this._wp = this._rp = 0;
        this._started = false;
        return;
      }
      const s = data.samples; // Float32Array
      // Drop chunk if it would push the buffer past the 600ms cap or overflow the ring
      const avail = (this._wp - this._rp + this._SIZE) % this._SIZE;
      const space = (this._rp - this._wp - 1 + this._SIZE) % this._SIZE;
      if (avail + s.length > this._MAX || s.length > space) return;
      for (let i = 0; i < s.length; i++) {
        this._ring[this._wp] = s[i];
        this._wp = (this._wp + 1) % this._SIZE;
      }
    };
  }

  _avail() { return (this._wp - this._rp + this._SIZE) % this._SIZE; }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const avail = this._avail();

    if (!this._started) {
      if (avail >= this._PREROLL) { this._started = true; this._silentSamples = 0; }
      else { out.fill(0); return true; }
    }

    if (avail === 0) {
      // Full underrun: output silence; only reset preroll after prolonged silence
      out.fill(0);
      this._silentSamples += out.length;
      if (this._silentSamples >= this._SILENCE_RESET) {
        this._started = false;
        this._silentSamples = 0;
      }
      return true;
    }

    this._silentSamples = 0;

    if (avail < out.length) {
      // Partial underrun: drain what's available, pad remainder with silence
      for (let i = 0; i < avail; i++) {
        out[i] = this._ring[this._rp];
        this._rp = (this._rp + 1) % this._SIZE;
      }
      out.fill(0, avail);
      return true;
    }

    for (let i = 0; i < out.length; i++) {
      out[i] = this._ring[this._rp];
      this._rp = (this._rp + 1) % this._SIZE;
    }
    return true;
  }
}

registerProcessor('dis-stream', DISStreamProcessor);
