// main-login.js — Login page: SIGNAL orb (auto-rotating ambient)

import { createOrbScene } from './orbScene.js';

window.addEventListener('DOMContentLoaded', init);

function init() {
  const container = document.getElementById('login-orb-container');
  if (!container) return;

  // Ambient auto-rotating orb — no OrbitControls
  createOrbScene(container, { interactive: false });

  // Submit navigates to the app
  const form = document.getElementById('login-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      window.location.href = 'app.html';
    });
  }
}
