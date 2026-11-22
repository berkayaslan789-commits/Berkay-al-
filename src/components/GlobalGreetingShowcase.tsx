import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Globe } from 'lucide-react';

const GREETINGS = [
  { lang: 'Türkçe', hello: 'Merhaba Dünya!', reply: 'Hemen konuşalım' },
  { lang: 'English', hello: 'Hello World!', reply: 'Instant translation' },
  { lang: 'Español', hello: '¡Hola Mundo!', reply: 'Hablemos ahora' },
  { lang: '日本語', hello: 'こんにちは世界！', reply: 'リアルタイム翻訳' },
  { lang: 'العربية', hello: 'مرحباً بالعالم!', reply: 'ترجمة فورية للجميع' },
  { lang: 'Français', hello: 'Bonjour le monde !', reply: 'Parlons sans barrières' },
  { lang: 'Deutsch', hello: 'Hallo Welt!', reply: 'Sofort verstehen' },
  { lang: 'Русский', hello: 'Привет, мир!', reply: 'Общение без границ' },
];

const WAVE_BARS = [0.45, 0.85, 0.6, 1, 0.72, 0.9, 0.5, 0.78, 0.55];

export function GlobalGreetingShowcase() {
  const [index, setIndex] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % GREETINGS.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);

  const current = GREETINGS[index];

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-[1.2fr_1fr] items-stretch">
      <div className="relative bg-slate-100 min-h-[160px] overflow-hidden">
        {!imgFailed ? (
          <img
            src="/src/assets/images/global_dialogue_banner_1795268563272.jpg"
            alt="Global conversations connected across languages"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-slate-100 via-teal-50 to-slate-200 flex items-center justify-center p-6">
            <Globe className="w-10 h-10 text-teal-600" />
          </div>
        )}
      </div>

      <div className="p-5 flex flex-col justify-between gap-4 bg-white">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-teal-700">OndaTalk</span>
          <div className="flex items-end gap-1 h-4" aria-hidden="true">
            {WAVE_BARS.map((peak, i) => (
              <motion.span
                key={i}
                className="w-1 rounded-full bg-teal-600 origin-bottom"
                style={{ height: '14px' }}
                animate={
                  shouldReduceMotion
                    ? { scaleY: peak }
                    : { scaleY: [0.3, peak, 0.35] }
                }
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  delay: i * 0.1,
                  ease: 'easeInOut',
                }}
              />
            ))}
          </div>
        </div>

        <div className="min-h-[58px] flex items-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={current.lang}
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-0.5"
            >
              <div className="text-xs text-slate-500">{current.lang}</div>
              <div className="text-lg font-bold text-slate-900 font-display">
                {current.hello}
              </div>
              <div className="text-xs text-teal-700 font-medium">{current.reply}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-1.5 pt-2 border-t border-slate-100">
          {GREETINGS.map((g, i) => (
            <button
              key={g.lang}
              type="button"
              aria-label={g.lang}
              onClick={() => setIndex(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-5 bg-teal-600' : 'w-1.5 bg-slate-200 hover:bg-slate-300'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
