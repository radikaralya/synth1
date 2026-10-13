'use strict';

const $ = (selector) => document.querySelector(selector);
const wavePaths = {
  sine: 'M7 31 C20 3 30 3 45 28 S68 54 84 24',
  triangle: 'M7 43 L42 8 L77 43',
  sawtooth: 'M7 43 L74 9 L74 42',
  square: 'M7 40 H20 V9 H52 V40 H85 V9'
};
const waveLabels = { sine: 'SINE', triangle: 'TRIANGLE', sawtooth: 'SAW', square: 'SQUARE' };
const noteNames = ['C', 'D', 'E♭', 'G'];
const semitones = [0, 2, 3, 7];
const voices = [
  { wave: 'sawtooth', notes: [true, true, true, true], volume: 78, pan: -0.24 },
  { wave: 'square', notes: [true, true, true, true], volume: 56, pan: 0.3 }
];
const patterns = [[1, 0, 0, 1, 1, 0, 0, 1], [0, 0, 1, 0, 0, 0, 1, 0], [1, 1, 0, 1, 1, 1, 1, 1]];
const drumNames = ['KICK', 'SNARE', 'HAT'];
let engine, running = false, starting = false, timer, nextTime = 0, stepIndex = 0, frame;
let visualQueue = [], currentStep = -1;

$('#voices').innerHTML = voices.map((voice, index) => `
  <section class="voice" aria-labelledby="voice-${index}-title">
    <h2 id="voice-${index}-title">VOICE 0${index + 1}${index === 0 ? ' · ORGAN' : ''}</h2>
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
    this.haloVolume = c.createGain();
    this.haloPan = c.createStereoPanner();
    this.haloVolume.gain.value = voices[1].volume / 100;
    this.haloPan.pan.value = voices[1].pan;
    this.haloVolume.connect(this.haloPan).connect(this.outputBus);
    this.organVolume = c.createGain();
    this.organPan = c.createStereoPanner();
    this.organVolume.gain.value = voices[0].volume / 100;
    this.organPan.pan.value = voices[0].pan;
    this.organVolume.connect(this.organPan).connect(this.outputBus);
    const organReal = new Float32Array(17), organImag = new Float32Array(17);
    // Pipe registrations: 16', 8', mutation ranks, 4' and 2'.
    for (const [harmonic, level] of [[1, .42], [2, .9], [3, .13], [4, .48], [6, .24], [8, .1], [12, .06], [16, .025]]) {
      organImag[harmonic] = level;
    }
    this.organWave = c.createPeriodicWave(organReal, organImag);
    this.delay = c.createDelay(2);
    this.feedback = c.createGain();
    this.feedback.gain.value = .46;
    this.delayTone = c.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 3800;
    this.delayWet = c.createGain();
    this.filter.connect(this.delay).connect(this.delayTone);
    this.delayTone.connect(this.feedback).connect(this.delay);
    this.delayTone.connect(this.delayWet).connect(this.outputBus);
    this.reverb = c.createConvolver();
    this.reverbWet = c.createGain();
    const impulse = c.createBuffer(2, c.sampleRate * 4.8, c.sampleRate);
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
    this.outputCeiling = c.createWaveShaper();
    const ceiling = new Float32Array(4096);
    for (let i = 0; i < ceiling.length; i++) {
      const x = i * 2 / (ceiling.length - 1) - 1;
      ceiling[i] = .88 * Math.tanh(x / .88);
    }
    this.outputCeiling.curve = ceiling;
    this.outputCeiling.oversample = '4x';
    this.master.connect(this.limiter).connect(this.outputCeiling).connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const noise = this.noise.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    this.updateEffects();
  }
  smooth(param, value) { param.setTargetAtTime(value, this.ctx.currentTime, .025); }
  updateEffects() {
    const amount = Number($('#distortion').value) / 100;
    const curve = new Float32Array(8192), drive = 1 + amount * amount * 64;
    const resolution = Math.pow(2, 12 - amount * 8);
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1;
      const crushed = Math.round(x * resolution) / resolution;
      const saturated = Math.tanh(crushed * drive) / Math.tanh(drive);
      const clipped = Math.max(-1, Math.min(1, crushed * drive));
      curve[i] = amount === 0 ? x : x * (1 - amount) + (saturated * .35 + clipped * .65) * amount;
    }
    this.shaper.curve = curve;
    this.smooth(this.driveInput.gain, 1 + amount * 2.5);
    this.smooth(this.driveOutput.gain, 1 / (1 + amount * 2.3));
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
        previous.haloAmp?.gain.cancelScheduledValues(time);
        previous.haloAmp?.gain.setTargetAtTime(0, time, .06);
        previous.choirAmp?.gain.cancelScheduledValues(time);
        previous.choirAmp?.gain.setTargetAtTime(0, time, .08);
        previous.organAmp?.gain.cancelScheduledValues(time);
        previous.organAmp?.gain.setTargetAtTime(0, time, .055);
        previous.oscillators.forEach(osc => { try { osc.stop(time + .25); } catch {} });
      }
    }
    this.voiceSources[index] = [];
    const amp = c.createGain();
    const midi = (index === 0 ? 36 : 60) + semitones[note];
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const peak = index === 0 ? .62 : .23;
    const attack = index === 0 ? .006 : .012;
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(peak, time + attack);
    amp.gain.exponentialRampToValueAtTime(peak * .72, time + Math.max(attack + .01, duration * .65));
    amp.gain.setTargetAtTime(.0001, time + duration, index === 0 ? .13 : .28);
    const gate = c.createGain();
    gate.gain.value = 1;
    amp.connect(gate).connect(this.channels[index].gain);
    const end = time + duration + (index === 0 ? .8 : 1.6);
    const layers = index === 0
      ? [{ ratio: 1, detune: -21, level: .48 }, { ratio: 1, detune: 18, level: .4 }, { ratio: .5, detune: 0, level: .48, type: 'sine' }]
      : [{ ratio: 1, detune: -34, level: .4 }, { ratio: 1, detune: 31, level: .4 }, { ratio: 2.37, detune: 9, level: .28 }];
    const oscillators = layers.map((layer, n) => {
      const osc = c.createOscillator(), level = c.createGain();
      osc.type = layer.type || voices[index].wave;
      osc.frequency.setValueAtTime(frequency * layer.ratio * (index === 0 ? 1.08 : 1), time);
      osc.frequency.exponentialRampToValueAtTime(frequency * layer.ratio, time + .045);
      osc.detune.value = layer.detune;
      level.gain.value = layer.level;
      osc.connect(level).connect(amp);
      osc.start(time);
      this.track(osc, end, n === layers.length - 1 ? [level, amp, gate] : [level]);
      return osc;
    });
    const dirt = Number($('#distortion').value) / 100;
    if (dirt > 0) {
      const modulator = c.createOscillator(), depth = c.createGain();
      modulator.type = index === 0 ? 'sine' : 'triangle';
      modulator.frequency.value = frequency * (index === 0 ? .5 : 1.414);
      depth.gain.setValueAtTime(frequency * dirt * (index === 0 ? .65 : 1.1), time);
      depth.gain.exponentialRampToValueAtTime(frequency * dirt * .24, time + duration);
      modulator.connect(depth);
      oscillators.slice(0, 2).forEach(osc => depth.connect(osc.frequency));
      modulator.start(time); this.track(modulator, end, [depth]); oscillators.push(modulator);
    }
    let haloAmp, organAmp, choirAmp;
    if (index === 0) {
      organAmp = c.createGain();
      organAmp.gain.setValueAtTime(0, time);
      organAmp.gain.linearRampToValueAtTime(.52, time + .025);
      organAmp.gain.setValueAtTime(.52, time + duration);
      organAmp.gain.setTargetAtTime(.0001, time + duration + .035, .22);
      organAmp.connect(this.organVolume);
      const pipes = [-5, 5].map((detune, n) => {
        const pipe = c.createOscillator(), level = c.createGain();
        pipe.setPeriodicWave(this.organWave); pipe.frequency.value = frequency;
        pipe.detune.value = detune; level.gain.value = .5;
        pipe.connect(level).connect(organAmp); pipe.start(time);
        this.track(pipe, end, n === 1 ? [level, organAmp] : [level]);
        return pipe;
      });
      const tremulant = c.createOscillator(), tremulantDepth = c.createGain();
      tremulant.frequency.value = 4.3; tremulantDepth.gain.value = 4;
      tremulant.connect(tremulantDepth); pipes.forEach(pipe => tremulantDepth.connect(pipe.detune));
      tremulant.start(time); this.track(tremulant, end, [tremulantDepth]);
      oscillators.push(...pipes, tremulant);
    }
    if (index === 1) {
      const lfo = c.createOscillator(), depth = c.createGain();
      lfo.frequency.value = 6.7; depth.gain.value = 23;
      lfo.connect(depth); oscillators.slice(0, 3).forEach(osc => depth.connect(osc.detune));
      lfo.start(time); this.track(lfo, end, [depth]); oscillators.push(lfo);
      const chopper = c.createOscillator(), chopDepth = c.createGain();
      chopper.type = 'square'; chopper.frequency.value = tempo() / 60 * 8;
      gate.gain.value = .68; chopDepth.gain.value = .3 * dirt;
      chopper.connect(chopDepth).connect(gate.gain);
      chopper.start(time); this.track(chopper, end, [chopDepth]); oscillators.push(chopper);
      // A clean, airy component of VOICE 02 follows its volume and pan.
      haloAmp = c.createGain();
      haloAmp.gain.setValueAtTime(0, time);
      haloAmp.gain.linearRampToValueAtTime(.28, time + .09);
      haloAmp.gain.setTargetAtTime(.0001, time + duration + .12, .34);
      haloAmp.connect(this.haloVolume);
      const haloLayers = [
        { ratio: 2, detune: -9, level: .5, type: 'sine' },
        { ratio: 2, detune: 9, level: .5, type: 'sine' },
        { ratio: 3, detune: -4, level: .22, type: 'sine' },
        { ratio: 4, detune: 5, level: .1, type: 'triangle' }
      ];
      const haloOscillators = haloLayers.map((layer, n) => {
        const osc = c.createOscillator(), level = c.createGain();
        osc.type = layer.type; osc.frequency.value = frequency * layer.ratio;
        osc.detune.value = layer.detune; level.gain.value = layer.level;
        osc.connect(level).connect(haloAmp); osc.start(time);
        this.track(osc, end, n === haloLayers.length - 1 ? [level, haloAmp] : [level]);
        return osc;
      });
      const breath = c.createOscillator(), breathDepth = c.createGain();
      breath.frequency.value = 3.7; breathDepth.gain.value = 6;
      breath.connect(breathDepth); haloOscillators.forEach(osc => breathDepth.connect(osc.detune));
      breath.start(time); this.track(breath, end, [breathDepth]);
      oscillators.push(...haloOscillators, breath);
      // Low choir stays clear of the distortion and follows VOICE 02.
      choirAmp = c.createGain();
      choirAmp.gain.setValueAtTime(0, time);
      choirAmp.gain.linearRampToValueAtTime(.86, time + .11);
      choirAmp.gain.setTargetAtTime(.0001, time + duration + .24, .48);
      choirAmp.connect(this.haloVolume);
      const choirLayers = [
        { ratio: .5, detune: -17, level: .27 },
        { ratio: .5, detune: -6, level: .27 },
        { ratio: .5, detune: 7, level: .27 },
        { ratio: .5, detune: 18, level: .27 },
        { ratio: .25, detune: 3, level: .22 }
      ];
      const choirOscillators = choirLayers.map((layer, n) => {
        const real = new Float32Array(25), imag = new Float32Array(25);
        const pitch = frequency * layer.ratio;
        for (let harmonic = 1; harmonic < imag.length; harmonic++) {
          const hz = pitch * harmonic;
          const vowel = 1.6 * Math.exp(-Math.pow((hz - 360) / 180, 2))
            + .9 * Math.exp(-Math.pow((hz - 800) / 260, 2))
            + .12 * Math.exp(-Math.pow((hz - 1800) / 400, 2));
          imag[harmonic] = (.24 + vowel) * Math.exp(-hz / 1700) / Math.pow(harmonic, 1.05);
        }
        const osc = c.createOscillator(), level = c.createGain();
        osc.setPeriodicWave(c.createPeriodicWave(real, imag));
        osc.frequency.value = pitch; osc.detune.value = layer.detune;
        level.gain.value = layer.level;
        osc.connect(level).connect(choirAmp); osc.start(time + n * .002);
        this.track(osc, end, n === choirLayers.length - 1 ? [level, choirAmp] : [level]);
        return osc;
      });
      const choirVibrato = c.createOscillator(), choirDepth = c.createGain();
      choirVibrato.frequency.value = 3.2; choirDepth.gain.value = 7;
      choirVibrato.connect(choirDepth); choirOscillators.forEach(osc => choirDepth.connect(osc.detune));
      choirVibrato.start(time); this.track(choirVibrato, end, [choirDepth]);
      oscillators.push(...choirOscillators, choirVibrato);
    }
    this.voiceSources[index].push({ oscillators, amp, haloAmp, organAmp, choirAmp, end });
  }
  drum(row, time) {
    const c = this.ctx, amp = c.createGain();
    amp.connect(this.drumGain);
    if (row === 0) {
      const osc = c.createOscillator();
      osc.frequency.setValueAtTime(185, time);
      osc.frequency.exponentialRampToValueAtTime(34, time + .13);
      amp.gain.setValueAtTime(1.25, time);
      amp.gain.exponentialRampToValueAtTime(.001, time + .68);
      osc.connect(amp); osc.start(time); this.track(osc, time + .7, [amp]);
      const click = c.createOscillator(), clickAmp = c.createGain();
      click.type = 'square'; click.frequency.setValueAtTime(1400, time);
      click.frequency.exponentialRampToValueAtTime(90, time + .025);
      clickAmp.gain.setValueAtTime(.18, time); clickAmp.gain.exponentialRampToValueAtTime(.001, time + .035);
      click.connect(clickAmp).connect(this.drumGain); click.start(time); this.track(click, time + .04, [clickAmp]);
    } else {
      const noise = c.createBufferSource(), filter = c.createBiquadFilter();
      noise.buffer = this.noise;
      filter.type = 'highpass';
      filter.frequency.value = row === 1 ? 1050 : 6200;
      filter.Q.value = .7;
      const length = row === 1 ? .34 : .09;
      amp.gain.setValueAtTime(row === 1 ? 1.05 : .33, time);
      amp.gain.exponentialRampToValueAtTime(.001, time + length);
      noise.connect(filter).connect(amp); noise.start(time);
      this.track(noise, time + length + .01, [filter, amp]);
      if (row === 1) {
        const osc = c.createOscillator(), body = c.createGain();
        osc.type = 'square'; osc.frequency.setValueAtTime(245, time);
        osc.frequency.exponentialRampToValueAtTime(155, time + .12);
        body.gain.setValueAtTime(.32, time); body.gain.exponentialRampToValueAtTime(.001, time + .18);
        osc.connect(body).connect(this.drumGain); osc.start(time); this.track(osc, time + .2, [body]);
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
      const phrase = index === 0 ? [0, 2, 0, 1] : [3, 2, 0, 0, 3, 2, 1, 0];
      const note = selected[phrase[index === 0 ? step / 2 : step] % selected.length];
      engine.note(index, note, nextTime, beat * (index === 0 ? .98 : .42));
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
    if (engine && index === 1) engine.smooth(param === 'pan' ? engine.haloPan.pan : engine.haloVolume.gain, Number(input.value) / 100);
    if (engine && index === 0) engine.smooth(param === 'pan' ? engine.organPan.pan : engine.organVolume.gain, Number(input.value) / 100);
  } else { engine?.updateEffects(); }
}));
$('#bpm').addEventListener('change', () => { $('#bpm').value = tempo(); engine?.updateEffects(); });
$('#motion').addEventListener('click', () => {
  const off = document.body.classList.toggle('still');
  $('#motion').setAttribute('aria-pressed', String(!off)); $('#motion').textContent = off ? 'GLITCH OFF' : 'GLITCH ON';
  resetGlitch();
});
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let glitchTimer, glitchEnd;
function resetGlitch() {
  clearTimeout(glitchTimer); clearTimeout(glitchEnd);
  document.body.classList.remove('glitch-burst');
  if (reducedMotion.matches || document.hidden || document.body.classList.contains('still')) return;
  glitchTimer = setTimeout(() => {
    if (document.hidden || reducedMotion.matches || document.body.classList.contains('still')) return;
    document.body.classList.add('glitch-burst');
    glitchEnd = setTimeout(resetGlitch, 1600);
  }, 6000 + Math.random() * 6000);
}
reducedMotion.addEventListener('change', resetGlitch);
document.addEventListener('visibilitychange', resetGlitch);
window.addEventListener('pagehide', () => { clearTimeout(glitchTimer); clearTimeout(glitchEnd); });
resetGlitch();
const keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
document.addEventListener('keydown', event => {
  if (event.repeat || /INPUT|TEXTAREA/.test(document.activeElement.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
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
