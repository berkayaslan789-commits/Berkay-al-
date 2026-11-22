import { useEffect, useRef } from 'react';

interface AudioWaveformProps {
  analyser: AnalyserNode | null;
  active: boolean;
  isOutputPlaying?: boolean;
  label?: string;
}

export function AudioWaveform({ analyser, active, isOutputPlaying = false }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const barCount = 44;
    const dataArray = analyser ? new Uint8Array(analyser.frequencyBinCount) : new Uint8Array(barCount);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      if (analyser && active) {
        analyser.getByteFrequencyData(dataArray);
      }

      const gap = 4;
      const totalGap = gap * (barCount - 1);
      const barWidth = Math.max(2, (width - totalGap) / barCount);
      const time = performance.now() / 220;

      for (let i = 0; i < barCount; i++) {
        let normalized = 0.08;
        if (active && analyser) {
          const binIdx = Math.min(
            dataArray.length - 1,
            Math.floor((i / barCount) * (dataArray.length * 0.65))
          );
          normalized = Math.max(0.08, dataArray[binIdx] / 255);
        } else if (isOutputPlaying) {
          normalized = 0.25 + 0.55 * Math.abs(Math.sin(time + i * 0.45));
        }

        const barHeight = Math.max(4, normalized * (height - 8));
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;

        ctx.fillStyle = isOutputPlaying
          ? '#0F766E'
          : active
            ? '#0D9488'
            : '#CBD5E1';

        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 3));
        ctx.fill();
      }

      ctx.restore();
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [analyser, active, isOutputPlaying]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="h-12 w-full block"
    />
  );
}
