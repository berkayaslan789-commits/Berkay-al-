export function pcmFloat32ToBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class GaplessPcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  public onPlaybackStateChange?: (isPlaying: boolean) => void;

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = 0;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public enqueuePcm24Base64(base64: string): void {
    const ctx = this.ensureContext();
    const bytes = base64ToUint8Array(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return;

    const dataView = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = dataView.getInt16(i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, sampleCount, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    if (this.activeSources.size === 1) {
      this.onPlaybackStateChange?.(true);
    }

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.onPlaybackStateChange?.(false);
      }
    };

    source.start(startAt);
  }

  public interrupt(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // ignore already stopped
      }
    }
    this.activeSources.clear();
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    } else {
      this.nextStartTime = 0;
    }
    this.onPlaybackStateChange?.(false);
  }

  public dispose(): void {
    this.interrupt();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}

let activeHtmlAudio: HTMLAudioElement | null = null;

export function stopWavPlayback(): void {
  if (activeHtmlAudio) {
    activeHtmlAudio.pause();
    activeHtmlAudio.src = '';
    activeHtmlAudio = null;
  }
}

export function playWavBase64(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopWavPlayback();
    const bytes = base64ToUint8Array(base64);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeHtmlAudio = audio;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
    };

    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('Ses dosyası oynatılamadı.'));
    };

    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Ses verisi okunamadı.'));
    reader.readAsDataURL(blob);
  });
}
