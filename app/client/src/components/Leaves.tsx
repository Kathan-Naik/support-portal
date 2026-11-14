import { useMemo, useState, type CSSProperties } from 'react';

/**
 * Falling leaves behind the sign-in. The shape is the path from assets/autumn-leaf.svg (SVG Repo),
 * drawn with currentColor so it takes the theme's tokens. Transform and opacity only; pausable;
 * not rendered as motion under prefers-reduced-motion (CSS holds every leaf still and hidden).
 */
const LEAF = 'M15.362,9.69c0,0-0.75,1.108-1.068,0c-0.318-1.109-1.346-4.949-1.762-5.226c-0.417-0.278-0.417-0.278-0.417-0.278s-0.078,1.506-0.594,1.307c-0.515-0.198-4.313-2.217-4.63-2.652L6.574,2.444c0,0,0.355,3.328-0.515,2.615c0,0,1.113,2.771-2.573,3.048c0,0,1.186,3.087,4.552,4.75c0,0,1.148,1.783-0.949,1.503c0,0-2.932-0.395-3.325-0.752c0,0-1.548,3.01-3.764,3.128c0,0,2.656,1.504,2.337,4.156c0,0,5.107,0.041,4.911,0.832c-0.2,0.795-0.555,1.601-0.555,1.601s4.71-0.929,5.422-2.194c0,0,0.989,0.99,1.071,1.939c0,0,2.693-0.594,2.452-2.296c0,0,1.269,0.948,1.427,2.551l0.554-0.375c0,0-0.319-1.661-1.464-2.967c0,0-0.517-1.308,0.789-0.633c0,0,3.085,1.029,5.7-0.833c0,0-2.888-0.948-3.006-1.978c0,0,5.394-3.326,5.625-5.542c0,0-1.944,0.198-2.972-0.633c0,0-1.309-0.396,0.394-4.791c0,0-1.227,0.724-1.62-3.636c0,0-3.051,4.665-4.518,3.082C16.548,5.018,15.165,8.066,15.362,9.69z';
const TONES = ['leaf--apricot', 'leaf--apricot', 'leaf--apricot', 'leaf--ember', 'leaf--periwinkle', 'leaf--muted'];

// Deterministic pseudo-random so the layout is stable between renders.
const rand = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

export function Leaves({ count = 18 }: { count?: number }) {
  const [paused, setPaused] = useState(false);
  const leaves = useMemo(() => Array.from({ length: count }, (_, i) => {
    const r = (k: number) => rand(i * 7 + k);
    const fall = 14 + r(1) * 14;                    // seconds to cross the screen
    return {
      left: `${Math.round(r(2) * 100)}%`,
      size: Math.round(14 + r(3) * 22),
      fall: `${fall.toFixed(1)}s`,
      delay: `${(-r(4) * fall).toFixed(1)}s`,        // negative: start mid-fall, no empty first screen
      sway: `${Math.round(30 + r(5) * 60) * (r(6) > 0.5 ? 1 : -1)}px`,
      swayTime: `${(3 + r(7) * 3).toFixed(1)}s`,
      spin: `${Math.round(180 + r(8) * 360) * (r(9) > 0.5 ? 1 : -1)}deg`,
      tone: TONES[Math.floor(r(10) * TONES.length)],
      opacity: (0.22 + r(11) * 0.35).toFixed(2),
    };
  }), [count]);

  return (
    <>
      <div className={`leaves${paused ? ' is-paused' : ''}`} aria-hidden="true">
        {leaves.map((l, i) => (
          <span key={i} className="leaf-fall" style={{ left: l.left, ['--fall' as string]: l.fall, animationDelay: l.delay } as CSSProperties}>
            <span className="leaf-sway" style={{ ['--sway' as string]: l.sway, ['--sway-time' as string]: l.swayTime } as CSSProperties}>
              <svg className={`leaf ${l.tone}`} viewBox="0 0 25.263 25.263" width={l.size} height={l.size}
                style={{ ['--spin' as string]: l.spin, ['--fall' as string]: l.fall, opacity: Number(l.opacity) } as CSSProperties}>
                <path d={LEAF} fill="currentColor" />
              </svg>
            </span>
          </span>
        ))}
      </div>
      <button type="button" className="leaves-toggle" onClick={() => setPaused(!paused)} aria-pressed={paused}>
        {paused ? 'Play leaves' : 'Pause leaves'}
      </button>
    </>
  );
}
