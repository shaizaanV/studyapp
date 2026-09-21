'use strict';

/**
 * Synthesised alarm and chime.
 *
 * Everything is generated with WebAudio oscillators rather than played from a
 * bundled sound file: no asset to ship, no licensing, and the gain envelope is
 * fully under our control so the alarm can be genuinely loud.
 *
 * This is the dependable half of the "wake up and step away" behaviour. A
 * toast can be suppressed by Focus Assist; audio the app plays itself cannot.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});

  /** Gap between alarm pulses. Short enough to nag, long enough to stay distinct. */
  const PULSE_INTERVAL_MS = 950;

  let context = null;
  let master = null;
  let repeater = null;

  function ensureContext() {
    if (!context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      context = new AudioCtor();
      master = context.createGain();
      master.gain.value = 0;
      master.connect(context.destination);
    }
    // Autoplay policy can leave the context suspended until a gesture happens.
    if (context.state === 'suspended') context.resume();
    return context;
  }

  /**
   * One shaped tone. The short attack and release avoid the click that a bare
   * square wave produces when it starts and stops at full amplitude.
   */
  function tone(frequency, startAt, duration, peak, type) {
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = type || 'square';
    osc.frequency.setValueAtTime(frequency, startAt);

    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);
    gain.gain.setValueAtTime(peak, startAt + duration - 0.035);
    gain.gain.linearRampToValueAtTime(0, startAt + duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  /** The two-tone "beep-beep" that gives the alarm its character. */
  function pulse() {
    const now = context.currentTime + 0.01;
    // A square wave is harsh enough that it needs less amplitude than a sine.
    tone(880, now, 0.17, 0.42);
    tone(1174.66, now + 0.23, 0.17, 0.42);
  }

  function start(volume) {
    stop();
    ensureContext();

    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(Math.min(1, Math.max(0, Number(volume) || 0)), context.currentTime);

    pulse();
    repeater = setInterval(pulse, PULSE_INTERVAL_MS);
  }

  function stop() {
    if (repeater) {
      clearInterval(repeater);
      repeater = null;
    }
    if (context && master) {
      // Ramp instead of cutting, so silencing the alarm does not itself click.
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setValueAtTime(master.gain.value, context.currentTime);
      master.gain.linearRampToValueAtTime(0, context.currentTime + 0.06);
    }
  }

  /** Gentle rising two-note marker for the end of a focus period. */
  function chime(volume) {
    ensureContext();
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(Math.min(1, Math.max(0, Number(volume) || 0)), context.currentTime);

    const now = context.currentTime + 0.01;
    tone(659.25, now, 0.2, 0.22, 'sine');
    tone(987.77, now + 0.16, 0.36, 0.2, 'sine');
  }

  /**
   * One decaying sine partial. Exponential ramps need a non-zero floor, hence
   * 0.0001 rather than 0.
   */
  function ring(frequency, startAt, decay, peak) {
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);

    osc.connect(gain);
    gain.connect(master);
    osc.start(startAt);
    osc.stop(startAt + decay + 0.05);
  }

  /**
   * The clean tone that ends a Wall Method baseline: a pure sine fundamental
   * with a long decay and a faint octave above it, so it rings like a bell
   * rather than beeping. Deliberately nothing like the alarm -- this one says
   * "begin", not "stop".
   */
  function bell(volume) {
    ensureContext();
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(Math.min(1, Math.max(0, Number(volume) || 0)), context.currentTime);

    const now = context.currentTime + 0.01;
    ring(783.99, now, 1.9, 0.36);
    ring(1567.98, now, 1.1, 0.07);
  }

  Flowcus.alarm = { start, stop, chime, bell };
})();
