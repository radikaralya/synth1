'use strict';

const $ = (selector) => document.querySelector(selector);
const wavePaths = {
  sine: 'M7 31 C20 3 30 3 45 28 S68 54 84 24',
  triangle: 'M7 43 L42 8 L77 43',
  sawtooth: 'M7 43 L74 9 L74 42',
  square: 'M7 40 H20 V9 H52 V40 H85 V9'
};
const waveLabels = { sine: 'SINE', triangle: 'TRIANGLE', sawtooth: 'SAW', square: 'SQUARE' };
const noteNames = ['C', 'D', 'E', 'G'];
const semitones = [0, 2, 4, 7];
const voices = [
  { wave: 'sine', notes: [true, true, true, true], volume: 67, pan: -0.34 },
  { wave: 'sine', notes: [true, true, true, true], volume: 60, pan: 0.3 }
];
const patterns = [[1, 0, 0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 0, 1, 0], [1, 1, 0, 1, 0, 1, 0, 0]];
const drumNames = ['KICK', 'SNARE', 'HAT'];
let engine, running = false, starting = false, timer, nextTime = 0, stepIndex = 0, frame;
let visualQueue = [], currentStep = -1;

$('#voices').innerHTML = voices.map((voice, index) => `
  <section class="voice" aria-labelledby="voice-${index}-title">
    <h2 id="voice-${index}-title">VOICE 0${index + 1}</h2>
    <div class="waveforms">${Object.entries(wavePaths).map(([wave, path]) => `
      <button class="wave" data-voice="${index}" data-wave="${wave}" aria-label="Voice ${index + 1}: ${waveLabels[wave]}" aria-pressed="${wave === voice.wave}">
        <svg viewBox="0 0 92 54" aria-hidden="true"><path d="${path}"/></svg><span>${waveLabels[wave]}</span>
      </button>`).join('')}</div>
    <div class="notes">${noteNames.map((note, n) => `
      <button class="note" data-voice="${index}" data-note="${n}" aria-label="Voice ${index + 1}: нота ${note}, включить или выключить в рисунке" aria-pressed="true">${note}</button>`).join('')}</div>
    <div class="channel-controls">
      <label>VOLUME <input type="range" data-voice="${index}" data-param="volume" min="0" max="100" value="${voice.volume}" aria-label="Voice ${index + 1}: громкость"></label>
      <label>PAN (L/R) <input type="range" data-voice="${index}" data-param="pan" min="-100" max="100" value="${voice.pan * 100}" aria-label="Voice ${index + 1}: панорама"></label>
    </div>
  </section>`).join('');
$('#drum-grid').innerHTML = drumNames.map((name, row) => `
  <div class="drum-row ${name.toLowerCase()}">
    <button class="drum-name" data-drum="${row}" aria-label="Прослушать ${name}">${name}</button>
    ${patterns[row].map((on, step) => `<button class="step" data-row="${row}" data-step="${step}" aria-label="${name}, шаг ${step + 1}" aria-pressed="${Boolean(on)}"></button>`).join('')}
  </div>`).join('');

function paintRange(input) {
  const fill = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
  input.setAttribute('aria-valuetext', input.dataset.param === 'pan' ? `${Math.abs(Number(input.value))}% ${Number(input.value) < 0 ? 'left' : 'right'}` : `${input.value}%`);
}
document.querySelectorAll('input[type=range]').forEach(paintRange);

class AudioEngine {
  constructor() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('В этом браузере нет Web Audio. Открой инструмент в современном браузере.');
    this.ctx = new AudioContext();
    const c = this.ctx;
    this.sources = new Set();
    this.voiceSources = [[], []];
    this.mix = c.createGain();
    this.mix.gain.value = .6;
    this.channels = voices.map((voice) => {
      const gain = c.createGain(), pan = c.createStereoPanner();
      gain.gain.value = voice.volume / 100;
      pan.pan.value = voice.pan;
      gain.connect(pan).connect(this.mix);
      return { gain, pan };
    });
    this.drumGain = c.createGain();
    this.drumGain.gain.value = .85;
    this.drumPan = c.createStereoPanner();
    this.drumGain.connect(this.drumPan).connect(this.mix);
    this.driveInput = c.createGain();
    this.shaper = c.createWaveShaper();
    this.shaper.oversample = '4x';
    this.driveOutput = c.createGain();
    this.filter = c.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = .6;
    this.mix.connect(this.driveInput).connect(this.shaper).connect(this.driveOutput).connect(this.filter);
    this.outputBus = c.createGain();
    this.filter.connect(this.outputBus);
    this.delay = c.createDelay(2);
    this.feedback = c.createGain();
    this.feedback.gain.value = .34;
    this.delayTone = c.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2700;
    this.delayWet = c.createGain();
    this.filter.connect(this.delay).connect(this.delayTone);
    this.delayTone.connect(this.feedback).connect(this.delay);
    this.delayTone.connect(this.delayWet).connect(this.outputBus);
    this.reverb = c.createConvolver();
    this.reverbWet = c.createGain();
    const impulse = c.createBuffer(2, c.sampleRate * 3.2, c.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.6);
    }
    this.reverb.buffer = impulse;
    this.outputBus.connect(this.reverb).connect(this.reverbWet);
    this.master = c.createGain();
    this.outputBus.connect(this.master);
    this.reverbWet.connect(this.master);
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = .003;
    this.limiter.release.value = .18;
    this.master.connect(this.limiter).connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const noise = this.noise.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    this.updateEffects();
  }
  smooth(param, value) { param.setTargetAtTime(value, this.ctx.currentTime, .025); }
  updateEffects() {
    const amount = Number($('#distortion').value) / 100;
    const curve = new Float32Array(2048), drive = 1 + amount * 8;
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = amount === 0 ? x : Math.tanh(x * drive) / Math.tanh(drive);
    }
    this.shaper.curve = curve;
    this.smooth(this.driveOutput.gain, 1 / (1 + amount * 1.8));
    this.smooth(this.filter.frequency, 180 * Math.pow(100, Number($('#filter').value) / 100));
    this.smooth(this.delayWet.gain, Number($('#delay').value) / 100 * .65);
    this.smooth(this.reverbWet.gain, Number($('#reverb').value) / 100 * 1.25);
    this.smooth(this.master.gain, Number($('#master').value) / 100 * .8);
    this.smooth(this.delay.delayTime, 60 / tempo() * .75);
  }
  track(source, end, nodes = []) {
    this.sources.add(source);
    source.addEventListener('ended', () => {
      this.sources.delete(source);
      source.disconnect();
      nodes.forEach(node => node.disconnect());
    }, { once: true });
    source.stop(end);
  }
  note(index, note, time, duration) {
    const c = this.ctx;
    // Each channel remains monophonic, with a short release between notes.
    for (const previous of this.voiceSources[index]) {
      if (previous.end > time) {
        previous.amp.gain.cancelScheduledValues(time);
        previous.amp.gain.setTargetAtTime(0, time, .018);
        try { previous.osc.stop(time + .1); } catch {}
      }
    }
    this.voiceSources[index] = [];
    const osc = c.createOscillator(), amp = c.createGain();
    osc.type = voices[index].wave;
    const midi = (index === 0 ? 36 : 60) + semitones[note];
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    osc.detune.value = index === 0 ? -5 : 7;
    const peak = index === 0 ? .6 : .23;
    const attack = index === 0 ? .018 : .06;
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(peak, time + attack);
    amp.gain.exponentialRampToValueAtTime(peak * .55, time + Math.max(attack + .01, duration * .65));
    amp.gain.setTargetAtTime(.0001, time + duration, index === 0 ? .12 : .35);
    osc.connect(amp).connect(this.channels[index].gain);
    osc.start(time);
    const end = time + duration + (index === 0 ? .7 : 1.8);
    this.track(osc, end, [amp]);
    this.voiceSources[index].push({ osc, amp, end });
  }
  drum(row, time) {
    const c = this.ctx, amp = c.createGain();
    amp.connect(this.drumGain);
    if (row === 0) {
      const osc = c.createOscillator();
      osc.frequency.setValueAtTime(145, time);
      osc.frequency.exponentialRampToValueAtTime(38, time + .17);
      amp.gain.setValueAtTime(.95, time);
      amp.gain.exponentialRampToValueAtTime(.001, time + .48);
      osc.connect(amp); osc.start(time); this.track(osc, time + .5, [amp]);
    } else {
      const noise = c.createBufferSource(), filter = c.createBiquadFilter();
      noise.buffer = this.noise;
      filter.type = row === 1 ? 'bandpass' : 'highpass';
      filter.frequency.value = row === 1 ? 1800 : 7500;
      filter.Q.value = row === 1 ? .65 : .4;
      const length = row === 1 ? .24 : .07;
      amp.gain.setValueAtTime(row === 1 ? .7 : .26, time);
      amp.gain.exponentialRampToValueAtTime(.001, time + length);
      noise.connect(filter).connect(amp); noise.start(time);
      this.track(noise, time + length + .01, [filter, amp]);
      if (row === 1) {
        const osc = c.createOscillator(), body = c.createGain();
        osc.type = 'triangle'; osc.frequency.value = 165;
        body.gain.setValueAtTime(.22, time); body.gain.exponentialRampToValueAtTime(.001, time + .12);
        osc.connect(body).connect(this.drumGain); osc.start(time); this.track(osc, time + .14, [body]);
      }
    }
  }
  stopSources() {
    for (const source of this.sources) { try { source.stop(this.ctx.currentTime); } catch {} }
    this.voiceSources = [[], []];
  }
}

async function ensureAudio() {
  if (!engine) engine = new AudioEngine();
  if (engine.ctx.state !== 'running') await engine.ctx.resume();
  if (engine.ctx.state !== 'running') throw new Error('Нажми PLAY ещё раз, чтобы включить звук.');
  return engine;
}
function tempo() { return Math.min(180, Math.max(45, Number($('#bpm').value) || 120)); }
function schedule() {
  if (!running) return;
  const beat = 60 / tempo();
  while (nextTime < engine.ctx.currentTime + .12) {
    const step = stepIndex % 8;
    const notes = [];
    patterns.forEach((pattern, row) => { if (pattern[step]) engine.drum(row, nextTime); });
    voices.forEach((voice, index) => {
      const selected = voice.notes.map((on, n) => on ? n : -1).filter(n => n >= 0);
      if (!selected.length || (index === 0 && step % 2 !== 0)) return;
      const phrase = index === 0 ? [0, 0, 2, 1] : [0, 2, 1, 3, 2, 1, 3, 1];
      const note = selected[phrase[index === 0 ? step / 2 : step] % selected.length];
      engine.note(index, note, nextTime, beat * (index === 0 ? .78 : .36));
      notes.push([index, note]);
    });
    visualQueue.push({ time: nextTime, step, notes });
    nextTime += beat / 2;
    stepIndex++;
  }
}
function animate() {
  if (!running) return;
  while (visualQueue.length && visualQueue[0].time <= engine.ctx.currentTime) {
    const event = visualQueue.shift(); currentStep = event.step;
    document.querySelectorAll('.step').forEach(button => button.classList.toggle('current', Number(button.dataset.step) === currentStep));
    document.querySelectorAll('.note').forEach(button => button.classList.toggle('sounding', event.notes.some(([v, n]) => v === Number(button.dataset.voice) && n === Number(button.dataset.note))));
    $('#status').textContent = `RITUAL IN PROGRESS · ${currentStep + 1}/8`;
  }
  frame = requestAnimationFrame(animate);
}
async function play() {
  if (running || starting) return;
  starting = true;
  try {
    await ensureAudio();
    if (!starting) return;
    engine.updateEffects();
    running = true; stepIndex = 0; nextTime = engine.ctx.currentTime + .06;
    $('#play').setAttribute('aria-pressed', 'true');
    schedule(); timer = setInterval(schedule, 25); animate();
  } catch (error) { $('#status').textContent = error.message; }
  finally { starting = false; }
}
function stop() {
  running = false; starting = false;
  clearInterval(timer); cancelAnimationFrame(frame); visualQueue = [];
  engine?.stopSources();
  $('#play').setAttribute('aria-pressed', 'false');
  document.querySelectorAll('.current,.sounding').forEach(button => button.classList.remove('current', 'sounding'));
  $('#status').textContent = 'READY TO HAUNT';
}
$('#play').addEventListener('click', play);
$('#stop').addEventListener('click', stop);
document.querySelectorAll('.wave').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.voice); voices[index].wave = button.dataset.wave;
  document.querySelectorAll(`.wave[data-voice="${index}"]`).forEach(wave => wave.setAttribute('aria-pressed', String(wave === button)));
}));
async function audition(index, note) {
  try { await ensureAudio(); engine.note(index, note, engine.ctx.currentTime, .3); }
  catch (error) { $('#status').textContent = error.message; }
}
document.querySelectorAll('.note').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.voice), note = Number(button.dataset.note);
  voices[index].notes[note] = !voices[index].notes[note];
  button.setAttribute('aria-pressed', String(voices[index].notes[note]));
  if (voices[index].notes[note]) audition(index, note);
}));
document.querySelectorAll('.step').forEach(button => button.addEventListener('click', () => {
  const row = Number(button.dataset.row), step = Number(button.dataset.step);
  patterns[row][step] = patterns[row][step] ? 0 : 1;
  button.setAttribute('aria-pressed', String(Boolean(patterns[row][step])));
}));
document.querySelectorAll('.drum-name').forEach(button => button.addEventListener('click', async () => {
  try { await ensureAudio(); engine.drum(Number(button.dataset.drum), engine.ctx.currentTime); }
  catch (error) { $('#status').textContent = error.message; }
}));
document.querySelectorAll('input[type=range]').forEach(input => input.addEventListener('input', () => {
  paintRange(input);
  if (input.dataset.voice !== undefined) {
    const index = Number(input.dataset.voice), param = input.dataset.param;
    voices[index][param] = param === 'pan' ? Number(input.value) / 100 : Number(input.value);
    if (engine) engine.smooth(param === 'pan' ? engine.channels[index].pan.pan : engine.channels[index].gain.gain, Number(input.value) / 100);
  } else { engine?.updateEffects(); }
}));
$('#bpm').addEventListener('change', () => { $('#bpm').value = tempo(); engine?.updateEffects(); });
$('#motion').addEventListener('click', () => {
  const off = document.body.classList.toggle('still');
  $('#motion').setAttribute('aria-pressed', String(!off)); $('#motion').textContent = off ? 'GLITCH OFF' : 'GLITCH ON';
});
const keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
document.addEventListener('keydown', event => {
  if (event.repeat || /INPUT|TEXTAREA|BUTTON/.test(document.activeElement.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); running ? stop() : play(); return; }
  const key = keys.indexOf(event.code);
  if (key < 0) return;
  event.preventDefault(); audition(Math.floor(key / 4), key % 4);
  $(`.note[data-voice="${Math.floor(key / 4)}"][data-note="${key % 4}"]`).classList.add('sounding');
});
document.addEventListener('keyup', event => {
  const key = keys.indexOf(event.code);
  if (key >= 0) $(`.note[data-voice="${Math.floor(key / 4)}"][data-note="${key % 4}"]`).classList.remove('sounding');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
window.addEventListener('pagehide', stop);
