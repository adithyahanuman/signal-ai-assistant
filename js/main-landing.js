// main-landing.js — Landing page: SIGNAL orb (auto-rotating, no interaction)

import { createOrbScene } from './orbScene.js';

window.addEventListener('DOMContentLoaded', init);

function init() {
  const heroContainer = document.getElementById('hero-orb-container');
  if (!heroContainer) { console.error('[SIGNAL] #hero-orb-container not found'); return; }

  // Ambient auto-rotating orb — no OrbitControls
  createOrbScene(heroContainer, { interactive: false });

  // GSAP ScrollTrigger for section reveals
  const gsap          = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (gsap && ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
    ['voice', 'vision', 'reasoning', 'local', 'availability', 'closing'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      ScrollTrigger.create({
        trigger:     el,
        start:       'top center',
        end:         'bottom center',
        onEnter:     () => {},
        onEnterBack: () => {},
      });
    });
  }
}
