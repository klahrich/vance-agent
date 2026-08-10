const gate = document.querySelector("#gate");
const dashboard = document.querySelector("#dashboard");
const unlockForm = document.querySelector("#unlock-form");
const callForm = document.querySelector("#call-form");
const passcodeInput = document.querySelector("#passcode");
const destinationInput = document.querySelector("#destination");
const callButton = document.querySelector("#call-button");
const hangupButton = document.querySelector("#hangup-button");
const listenButton = document.querySelector("#listen-button");
const lockButton = document.querySelector("#lock-button");
const statusChip = document.querySelector("#status-chip");
const liveTitle = document.querySelector("#live-title");
const durationElement = document.querySelector("#duration");
const signal = document.querySelector("#signal");
const listenCaption = document.querySelector("#listen-caption");
const activeDestination = document.querySelector("#active-destination");
const callIdElement = document.querySelector("#call-id");
const outcome = document.querySelector("#outcome");
const transcript = document.querySelector("#transcript");
const transcriptState = document.querySelector("#transcript-state");
const missionSelect = document.querySelector("#mission");
const missionDescription = document.querySelector("#mission-description");
const contextInput = document.querySelector("#context");
const contextWarning = document.querySelector("#context-warning");
const steerForm = document.querySelector("#steer-form");
const steerInput = document.querySelector("#steer-input");
const steerButton = document.querySelector("#steer-button");
const steerStatus = document.querySelector("#steer-status");
const outcomePanel = document.querySelector("#outcome-panel");
const outcomeSummary = document.querySelector("#outcome-summary");
const outcomeData = document.querySelector("#outcome-data");
const copyOutcome = document.querySelector("#copy-outcome");
const callerNumber = document.querySelector("#caller-number");
const footerCallerNumber = document.querySelector("#footer-caller-number");
const toast = document.querySelector("#toast");

const state = {
  key: sessionStorage.getItem("vance.dashboard.key") || "",
  call: null,
  pollTimer: null,
  liveAbort: null,
  clockTimer: null,
  socket: null,
  audioContext: null,
  audioOutput: null,
  audioSources: new Set(),
  audioStartAt: 0,
  sampleRate: 16000,
  channels: 1,
  encoding: "pcm_s16le",
  pendingAudioByte: null,
  transcriptFingerprint: "",
  toastTimer: null,
};

const terminalStatuses = new Set(["ended", "failed"]);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${state.key}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || "The call room could not complete that request.");
  return data;
}

function prettyPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value || "—";
}

function prettyStatus(status) {
  const names = {
    queued: "Dialing",
    ringing: "Ringing",
    "in-progress": "On the call",
    forwarding: "Connecting",
    ended: "Call ended",
    failed: "Call failed",
    unknown: "Checking status",
  };
  return names[status] || String(status || "Standing by").replaceAll("-", " ");
}

function elapsedLabel(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function getElapsed(call) {
  if (!call) return 0;
  const start = Date.parse(call.startedAt || call.createdAt || "");
  if (!Number.isFinite(start)) return 0;
  const end = call.endedAt ? Date.parse(call.endedAt) : Date.now();
  return Math.max(0, (end - start) / 1000);
}

function renderTranscript(messages = []) {
  const fingerprint = JSON.stringify(messages.map((item) => [item.role, item.message, item.partial]));
  if (fingerprint === state.transcriptFingerprint) return;
  state.transcriptFingerprint = fingerprint;
  if (!messages.length) {
    transcript.innerHTML = `<div class="empty-state"><span>↗</span><p>The line is open. New conversation turns will show up here.</p></div>`;
    return;
  }
  transcript.replaceChildren(...messages.map((item) => {
    const row = document.createElement("article");
    row.className = `message ${item.role === "vance" ? "is-vance" : "is-them"}`;

    const speaker = document.createElement("span");
    speaker.className = "message-speaker";
    // The mission decides what to call the other side: "rep", "client", ...
    speaker.textContent = item.role === "vance" ? "Vance" : state.counterpart || "Them";

    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = item.message;
    if (item.partial) text.setAttribute("data-live", "true");

    const time = document.createElement("time");
    time.className = "message-time";
    time.textContent = elapsedLabel(item.secondsFromStart);

    row.append(speaker, text, time);
    return row;
  }));
  transcript.scrollTop = transcript.scrollHeight;
}

function renderCall(call) {
  if (state.call?.id === call?.id) {
    call = {
      ...state.call,
      ...call,
      monitor: call.monitor ?? state.call.monitor,
      destination: call.destination ?? state.call.destination,
      counterpart: call.counterpart ?? state.call.counterpart,
      mission: call.mission ?? state.call.mission,
      messages: call.messages ?? state.call.messages,
      analysis: call.analysis ?? state.call.analysis,
    };
  }
  state.call = call;
  state.counterpart = call?.counterpart
    ? call.counterpart.charAt(0).toUpperCase() + call.counterpart.slice(1)
    : "Them";
  const status = call?.status || "unknown";
  const active = Boolean(call) && !terminalStatuses.has(status);
  const hasMonitor = active && Boolean(call.monitor?.listenUrl);

  statusChip.textContent = call ? prettyStatus(status) : "Standing by";
  statusChip.className = `status-chip ${active ? "is-live" : status === "failed" ? "is-error" : status === "ended" ? "is-ended" : "is-idle"}`;
  liveTitle.textContent = call ? prettyStatus(status) : "Nothing active";
  signal.classList.toggle("is-active", active);
  callButton.disabled = active;
  callButton.textContent = active ? "Call in progress" : "Start call";
  hangupButton.disabled = !active || !call.monitor?.controlUrl;
  // Steering rides the same control channel as hang-up.
  setSteerEnabled(active && Boolean(call.monitor?.controlUrl));
  listenButton.disabled = !hasMonitor;
  activeDestination.textContent = prettyPhone(call?.destination);
  callIdElement.textContent = call?.id || "—";
  outcome.textContent = call?.endedReason ? call.endedReason.replaceAll("-", " ") : active ? "In progress" : call ? prettyStatus(status) : "—";
  listenCaption.textContent = hasMonitor ? "Hear both sides without joining" : active ? "Monitor is getting ready" : "Available once the call connects";
  transcriptState.textContent = active ? "Updating live" : call ? "Final conversation" : "Waiting for a call";
  renderTranscript(call?.messages || []);
  renderOutcome(call?.analysis);
  durationElement.textContent = elapsedLabel(getElapsed(call));

  if (call?.id) localStorage.setItem("vance.active.call", call.id);
  if (!active) {
    stopLiveFeed();
    stopListening();
    // Vapi runs extraction after the call ends, so hanging up is not the end
    // of the story on a mission with an outcome. Keep polling briefly, or the
    // deliverable never reaches the screen.
    const awaitingOutcome =
      call && !call.analysis && Date.now() - (state.endedAt ??= Date.now()) < 90_000;
    if (awaitingOutcome) {
      state.pollTimer = window.setTimeout(pollCall, 3000);
    } else {
      stopPolling();
      if (call) localStorage.removeItem("vance.active.call");
    }
  } else {
    state.endedAt = null;
  }
}

function stopPolling() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function pollCall() {
  if (!state.call?.id) return;
  try {
    const call = await api(`/api/calls/${state.call.id}`);
    renderCall(call);
    if (!terminalStatuses.has(call.status)) state.pollTimer = window.setTimeout(pollCall, 750);
  } catch (error) {
    showToast(error.message);
    state.pollTimer = window.setTimeout(pollCall, 4000);
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setTimeout(pollCall, 200);
}

function stopLiveFeed() {
  state.liveAbort?.abort();
  state.liveAbort = null;
}

async function startLiveFeed(callId) {
  stopLiveFeed();
  const abort = new AbortController();
  state.liveAbort = abort;
  try {
    const response = await fetch(`/api/calls/${callId}/live`, {
      headers: { Authorization: `Bearer ${state.key}` },
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error("Live feed unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const line = event.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;
        const nextCall = JSON.parse(line.slice(6));
        if (state.call?.id === nextCall.id) renderCall(nextCall);
      }
    }
  } catch (error) {
    if (!abort.signal.aborted && state.call?.id === callId && !terminalStatuses.has(state.call.status)) {
      window.setTimeout(() => startLiveFeed(callId), 900);
    }
  }
}

function decodeMuLaw(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return (sign ? -sample : sample) / 32768;
}

function flushScheduledAudio() {
  for (const source of state.audioSources) {
    try { source.stop(); } catch { /* source already ended */ }
  }
  state.audioSources.clear();
  if (state.audioContext) state.audioStartAt = state.audioContext.currentTime + 0.06;
}

function playAudioChunk(arrayBuffer) {
  if (!state.audioContext || !arrayBuffer.byteLength) return;
  let bytes = new Uint8Array(arrayBuffer);
  if (state.pendingAudioByte !== null) {
    const joined = new Uint8Array(bytes.length + 1);
    joined[0] = state.pendingAudioByte;
    joined.set(bytes, 1);
    bytes = joined;
    state.pendingAudioByte = null;
  }

  const isMuLaw = state.encoding.includes("mulaw") || state.encoding.includes("mu-law") || state.encoding.includes("pcmu");
  const bytesPerSample = isMuLaw ? 1 : 2;
  if (!isMuLaw && bytes.length % 2) {
    state.pendingAudioByte = bytes[bytes.length - 1];
    bytes = bytes.subarray(0, -1);
  }
  const channels = Math.max(1, state.channels);
  const frameCount = Math.floor(bytes.length / bytesPerSample / channels);
  if (!frameCount) return;
  const audioBuffer = state.audioContext.createBuffer(channels, frameCount, state.sampleRate);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const output = audioBuffer.getChannelData(channelIndex);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sampleIndex = frame * channels + channelIndex;
      output[frame] = isMuLaw
        ? decodeMuLaw(bytes[sampleIndex])
        : view.getInt16(sampleIndex * 2, true) / 32768;
    }
  }

  const now = state.audioContext.currentTime;
  if (state.audioStartAt < now) state.audioStartAt = now + 0.06;
  if (state.audioStartAt > now + 0.42) flushScheduledAudio();

  const source = state.audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.audioOutput);
  state.audioSources.add(source);
  source.addEventListener("ended", () => state.audioSources.delete(source));
  source.start(state.audioStartAt);
  state.audioStartAt += audioBuffer.duration;
}

async function startListening() {
  const listenUrl = state.call?.monitor?.listenUrl;
  if (!listenUrl || state.socket) return;
  state.sampleRate = 16000;
  state.channels = 1;
  state.encoding = "pcm_s16le";
  state.pendingAudioByte = null;
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const highpass = state.audioContext.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 70;
  const compressor = state.audioContext.createDynamicsCompressor();
  compressor.threshold.value = -4;
  compressor.knee.value = 8;
  compressor.ratio.value = 3;
  const gain = state.audioContext.createGain();
  gain.gain.value = 0.82;
  highpass.connect(compressor);
  compressor.connect(gain);
  gain.connect(state.audioContext.destination);
  state.audioOutput = highpass;
  await state.audioContext.resume();
  state.audioStartAt = state.audioContext.currentTime + 0.06;
  state.socket = new WebSocket(listenUrl);
  state.socket.binaryType = "arraybuffer";
  state.socket.addEventListener("open", () => {
    listenButton.classList.add("is-listening");
    listenButton.innerHTML = `<span aria-hidden="true">■</span> Stop`;
    listenCaption.textContent = "Listening live · your microphone is off";
  });
  state.socket.addEventListener("message", async (event) => {
    if (typeof event.data === "string") {
      try {
        const info = JSON.parse(event.data);
        const format = info.audioFormat ?? info.format ?? info;
        if (Number(format.sampleRate ?? info.sampleRate)) state.sampleRate = Number(format.sampleRate ?? info.sampleRate);
        if (Number(format.channels ?? info.channels)) state.channels = Number(format.channels ?? info.channels);
        const encoding = format.encoding ?? format.format ?? info.encoding;
        if (typeof encoding === "string") state.encoding = encoding.toLowerCase();
      } catch { /* transport notices do not require action */ }
      return;
    }
    const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    playAudioChunk(data);
  });
  state.socket.addEventListener("close", () => stopListening());
  state.socket.addEventListener("error", () => {
    showToast("The quiet monitor lost its connection. You can reconnect without affecting the call.");
    stopListening();
  });
}

function stopListening() {
  const socket = state.socket;
  state.socket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (state.audioContext) state.audioContext.close().catch(() => {});
  state.audioContext = null;
  state.audioOutput = null;
  state.audioSources.clear();
  state.pendingAudioByte = null;
  listenButton.classList.remove("is-listening");
  listenButton.innerHTML = `<span aria-hidden="true">◉</span> Listen`;
  listenCaption.textContent = state.call && !terminalStatuses.has(state.call.status)
    ? "Hear both sides without joining"
    : "Available once the call connects";
}

function renderMissions(missions) {
  state.missions = missions;
  missionSelect.innerHTML = "";
  if (!missions.length) {
    missionSelect.append(new Option("No missions found", ""));
    missionSelect.disabled = true;
    return;
  }
  for (const mission of missions) {
    // A mission whose frontmatter is broken stays visible but unselectable —
    // silently hiding it would look like the file was never saved.
    const option = new Option(
      mission.error ? `${mission.name} — unreadable` : mission.name,
      mission.name,
    );
    option.disabled = Boolean(mission.error);
    missionSelect.append(option);
  }
  missionSelect.disabled = false;
  const saved = localStorage.getItem("vance.mission");
  if (saved && missions.some((m) => m.name === saved && !m.error)) missionSelect.value = saved;
  describeMission();
}

function describeMission() {
  const mission = (state.missions || []).find((m) => m.name === missionSelect.value);
  missionDescription.textContent = mission ? mission.error || mission.description : "";
  updateContextWarning();
}

// A call placed with no background still connects and still sounds fine — the
// agent simply knows nothing, and you only find out from the transcript
// afterwards. Say so before dialling.
function updateContextWarning() {
  const mission = (state.missions || []).find((m) => m.name === missionSelect.value);
  const typed = contextInput.value.trim().length > 0;
  const stored = Boolean(mission?.hasContext);
  if (typed) {
    contextWarning.textContent = "Using the background typed below.";
    contextWarning.className = "field-hint";
  } else if (stored) {
    contextWarning.textContent = `Using the saved background for ${mission.name}.`;
    contextWarning.className = "field-hint";
  } else {
    contextWarning.textContent =
      "No background saved for this mission — Vance will go in knowing nothing.";
    contextWarning.className = "field-hint is-warning";
  }
}

function renderOutcome(analysis) {
  const data = analysis?.structuredData;
  const summary = analysis?.summary;
  if (!data && !summary) {
    outcomePanel.hidden = true;
    return;
  }
  outcomePanel.hidden = false;
  outcomeSummary.textContent = summary || "";
  outcomeSummary.hidden = !summary;
  outcomeData.textContent = data ? JSON.stringify(data, null, 2) : "";
  outcomeData.hidden = !data;
  state.outcomeJson = data ? JSON.stringify(data, null, 2) : "";
}

function setSteerEnabled(enabled) {
  steerInput.disabled = !enabled;
  steerButton.disabled = !enabled;
  if (!enabled) steerStatus.textContent = "";
}

async function unlock(key) {
  state.key = key;
  const config = await api("/api/session");
  sessionStorage.setItem("vance.dashboard.key", key);
  gate.hidden = true;
  dashboard.hidden = false;
  callerNumber.textContent = prettyPhone(config.callerNumber);
  footerCallerNumber.textContent = prettyPhone(config.callerNumber);
  if (config.defaultDestination) destinationInput.value ||= prettyPhone(config.defaultDestination);
  renderMissions(config.missions || []);

  const savedCallId = localStorage.getItem("vance.active.call");
  if (savedCallId) {
    try {
      renderCall(await api(`/api/calls/${savedCallId}`));
      if (!terminalStatuses.has(state.call.status)) {
        startLiveFeed(savedCallId);
        startPolling();
      }
    } catch {
      localStorage.removeItem("vance.active.call");
    }
  }
}

unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = unlockForm.querySelector("button");
  button.disabled = true;
  try {
    await unlock(passcodeInput.value);
    passcodeInput.value = "";
  } catch (error) {
    showToast(error.message);
    passcodeInput.select();
  } finally {
    button.disabled = false;
  }
});

callForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  callButton.disabled = true;
  callButton.textContent = "Starting…";
  try {
    const call = await api("/api/calls", {
      method: "POST",
      body: JSON.stringify({
        destination: destinationInput.value,
        mission: missionSelect.value,
        context: contextInput.value,
      }),
    });
    localStorage.setItem("vance.mission", missionSelect.value);
    renderCall(call);
    startLiveFeed(call.id);
    startPolling();
  } catch (error) {
    showToast(error.message);
    callButton.disabled = false;
    callButton.textContent = "Start call";
  }
});

missionSelect.addEventListener("change", describeMission);
contextInput.addEventListener("input", updateContextWarning);

copyOutcome.addEventListener("click", async () => {
  if (!state.outcomeJson) return;
  await navigator.clipboard.writeText(state.outcomeJson);
  copyOutcome.textContent = "Copied";
  window.setTimeout(() => (copyOutcome.textContent = "Copy JSON"), 1500);
});

steerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const instruction = steerInput.value.trim();
  if (!instruction || !state.call?.id) return;
  steerButton.disabled = true;
  steerStatus.textContent = "Sending…";
  try {
    await api(`/api/calls/${state.call.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    });
    steerInput.value = "";
    steerStatus.textContent = "Sent — Vance will pick it up on the next turn.";
  } catch (error) {
    steerStatus.textContent = error.message;
  } finally {
    steerButton.disabled = false;
  }
});

hangupButton.addEventListener("click", async () => {
  if (!state.call?.id) return;
  hangupButton.disabled = true;
  hangupButton.textContent = "Ending…";
  try {
    await api(`/api/calls/${state.call.id}/hangup`, { method: "POST" });
    showToast("Hang-up sent. The line is closing now.");
    startPolling();
  } catch (error) {
    showToast(error.message);
    hangupButton.disabled = false;
  } finally {
    hangupButton.textContent = "Hang up";
  }
});

listenButton.addEventListener("click", () => state.socket ? stopListening() : startListening());

lockButton.addEventListener("click", () => {
  stopPolling();
  stopLiveFeed();
  stopListening();
  sessionStorage.removeItem("vance.dashboard.key");
  state.key = "";
  dashboard.hidden = true;
  gate.hidden = false;
  passcodeInput.focus();
});

state.clockTimer = window.setInterval(() => {
  if (state.call) durationElement.textContent = elapsedLabel(getElapsed(state.call));
}, 1000);

if (state.key) unlock(state.key).catch(() => {
  sessionStorage.removeItem("vance.dashboard.key");
  state.key = "";
});
