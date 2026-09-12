/**
 * Very loud alerts for money events: an alarm tone (bundled WAV, with a synthesised WebAudio fallback), a long
 * vibration pattern where the device supports it, and a system notification when the tab is in the background.
 * Browsers only allow sound after a user gesture, so `armAlerts()` is wired to the first click / key press.
 */
const VIBRATION = [600, 150, 600, 150, 900, 300, 600, 150, 600];
let ctx: AudioContext | null = null;
let armed = false;
let audio: HTMLAudioElement | null = null;

export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem('bitripay.loudAlerts') !== 'off';
  } catch {
    return true;
  }
}
export function setAlertsEnabled(on: boolean) {
  try {
    localStorage.setItem('bitripay.loudAlerts', on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

export function armAlerts() {
  if (armed) return;
  armed = true;
  try {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    void ctx.resume();
    audio = new Audio('/loud_alert.wav');
    audio.preload = 'auto';
    audio.volume = 1;
  } catch {
    ctx = null;
  }
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
}

function synth(seconds = 3) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(ctx.destination);
  for (let i = 0; i < seconds * 4; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = i % 2 === 0 ? 880 : 1320;
    osc.connect(gain);
    osc.start(now + i * 0.25);
    osc.stop(now + i * 0.25 + 0.24);
  }
}

/** Ring, vibrate and (in the background) show a system notification. */
export function loudAlert(title: string, body?: string) {
  if (!alertsEnabled()) return;
  try {
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(() => synth());
    } else synth();
  } catch {
    /* no audio */
  }
  try {
    navigator.vibrate?.(VIBRATION);
  } catch {
    /* no vibration */
  }
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try {
      const n = new Notification(title, { body, icon: '/favicon.svg', tag: `bitripay-${Date.now()}`, requireInteraction: true, silent: false });
      n.onclick = () => window.focus();
    } catch {
      /* ignore */
    }
  }
  if (document.title && !document.title.startsWith('🔔')) {
    const old = document.title;
    document.title = `🔔 ${title}`;
    setTimeout(() => (document.title = old), 8000);
  }
}

/** Track which notifications already rang so a poll never repeats an alarm. */
const seen = new Set<string>();
let primed = false;
export function ringForNew(items: { id: string; title: string; body: string; read: boolean; data?: Record<string, unknown> }[]) {
  if (!primed) {
    // First load: remember everything that already exists without ringing.
    items.forEach((n) => seen.add(n.id));
    primed = true;
    return;
  }
  for (const n of items) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (!n.read && n.data?.loud) loudAlert(n.title, n.body);
  }
}
