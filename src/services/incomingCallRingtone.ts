/**
 * Incoming-call ringtone using the existing notification chime's sound settings.
 * Three complete chimes, then a pause; incoming calls only.
 */

interface RingtoneCall {
  callId: string;
  direction: string;
  state: string;
}

let context: AudioContext | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let ringingCallId: string | null = null;
let silencedCallId: string | null = null;
let generation = 0;

const voices = new Map<OscillatorNode, GainNode>();

function stopPlayback(): void {
  generation += 1;

  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }

  for (const [oscillator, gain] of voices) {
    gain.disconnect();
    try {
      oscillator.stop();
    } catch {
      // The oscillator may already have ended.
    }
    oscillator.disconnect();
  }

  voices.clear();
}

function playChime(ctx: AudioContext): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(698.46, now);
  oscillator.frequency.setValueAtTime(880, now + 0.12);

  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  voices.set(oscillator, gain);

  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
    voices.delete(oscillator);
  };

  oscillator.start(now);
  oscillator.stop(now + 0.45);
}

function beginPattern(): void {
  const ctx = context;

  if (
    !ctx ||
    ctx.state !== 'running' ||
    !ringingCallId ||
    ringingCallId === silencedCallId ||
    timer !== null ||
    voices.size > 0
  ) {
    return;
  }

  const token = generation;
  let beat = 0;

  const tick = () => {
    timer = null;

    if (
      token !== generation ||
      context !== ctx ||
      ctx.state !== 'running' ||
      !ringingCallId ||
      ringingCallId === silencedCallId
    ) {
      return;
    }

    try {
      playChime(ctx);
    } catch {
      stopPlayback();
      return;
    }

    beat += 1;

    // 450 ms chime + 150 ms gap; after beat 3, 1500 ms silence.
    const delay = beat === 3 ? 1950 : 600;
    if (beat === 3) beat = 0;

    timer = setTimeout(tick, delay);
  };

  tick();
}

export async function unlockIncomingCallRingtone(): Promise<void> {
  try {
    if (!context || context.state === 'closed') {
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;

      if (!AudioCtor) return;
      context = new AudioCtor();
    }

    const ctx = context;

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (context === ctx) {
      beginPattern();
    }
  } catch {
    // Audio failure must not interrupt calling or messaging.
  }
}

export function syncIncomingCallRingtone(call: RingtoneCall | null): void {
  if (
    !call ||
    call.direction !== 'incoming' ||
    call.state !== 'ringing_incoming'
  ) {
    ringingCallId = null;
    stopPlayback();
    return;
  }

  if (ringingCallId !== call.callId) {
    stopPlayback();
    ringingCallId = call.callId;
  }

  beginPattern();
}

export function silenceIncomingCallRingtone(callId: string): void {
  silencedCallId = callId;

  if (ringingCallId === callId) {
    stopPlayback();
  }
}

export function disposeIncomingCallRingtone(): void {
  ringingCallId = null;
  silencedCallId = null;
  stopPlayback();

  const ctx = context;
  context = null;

  if (ctx && ctx.state !== 'closed') {
    void ctx.close().catch(() => {});
  }
}