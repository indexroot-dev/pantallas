const socket = io();

const $ = (id) => document.getElementById(id);
const loginView = $("login");
const panelView = $("panel");
const loginForm = $("login-form");
const nameInput = $("name");
const loginError = $("login-error");
const allItem = $("all");
const devicesList = $("devices");
const onlineCount = $("online-count");
const noDevices = $("no-devices");
const roomTitle = $("room-title");
const roomSub = $("room-sub");
const offlineBanner = $("offline-banner");
const messagesList = $("messages");
const sendError = $("send-error");
const sendForm = $("send-form");
const textInput = $("text");
const liveButtons = $("live-buttons");
const liveView = $("live");
const liveTitle = $("live-title");
const liveStatus = $("live-status");
const liveCanvas = $("live-canvas");

const STORAGE_KEY = "panel-name";

let me = null;
let canWatch = false; // si este usuario puede ver pantallas y cámaras en vivo
let devices = [];
let messages = [];
let current = "*"; // "*" = todos, o el nombre de una pantalla
let live = null; // lo que se está viendo en vivo: { device, source: "screen" | "camera", camera, label }
let drawing = false;

const findDevice = (name) => devices.find((d) => d.name === name);

function loadName() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function saveName(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
}
function clearName() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

function deviceStatusText(d) {
  if (d.online) return "En línea";
  if (!d.lastSeen) return "Desconectado";
  const date = new Date(d.lastSeen);
  const day = date.toDateString() === new Date().toDateString() ? "hoy" : date.toLocaleDateString("es");
  return `Últ. vez ${day} a las ${formatTime(d.lastSeen)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Render ----------

function statusChip(msg) {
  if (msg.status === "acknowledged") return el("span", "chip ok", `✓ Entendido ${formatTime(msg.ackAt)}`);
  if (msg.status === "delivered") return el("span", "chip delivered", "Recibido");
  return el("span", "chip", "Enviado");
}

function messageElement(msg) {
  const li = el("li", "msg mine");
  li.dataset.id = msg.id;
  const meta = el("div", "meta");
  if (current === "*") meta.append(el("span", "author", `Para ${msg.to}`));
  meta.append(el("time", null, formatTime(msg.at)), statusChip(msg));
  li.append(meta, el("div", null, msg.text));
  return li;
}

function visibleMessages() {
  return current === "*" ? messages : messages.filter((m) => m.to === current);
}

function renderMessages() {
  const list = visibleMessages();
  if (list.length === 0) {
    const hint = current === "*" ? "Aún no has enviado avisos." : `Aún no has enviado avisos a ${current}.`;
    messagesList.replaceChildren(el("li", "system", hint));
  } else {
    messagesList.replaceChildren(...list.map(messageElement));
  }
  messagesList.scrollTop = messagesList.scrollHeight;
}

function renderSidebar() {
  const online = devices.filter((d) => d.online).length;
  const pending = devices.reduce((sum, d) => sum + d.pending, 0);
  onlineCount.textContent = online;
  noDevices.hidden = devices.length > 0;
  allItem.classList.toggle("active", current === "*");
  $("all-status").textContent = pending ? `${pending} sin confirmar` : `${devices.length} pantallas`;

  const sorted = [...devices].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  devicesList.replaceChildren(
    ...sorted.map((d) => {
      const btn = el("button", "conv-item" + (current === d.name ? " active" : ""));
      btn.type = "button";
      btn.addEventListener("click", () => openDevice(d.name));

      const info = el("span", "user-info");
      info.append(el("span", "user-name", d.name), el("span", "user-status", deviceStatusText(d)));

      const badge = el("span", "pending", d.pending);
      badge.title = "Avisos sin confirmar";
      badge.hidden = !d.pending;

      btn.append(el("span", "dot " + (d.online ? "online" : "offline")), info, badge);
      const li = el("li");
      li.append(btn);
      return li;
    })
  );
}

function renderHeader() {
  if (current === "*") {
    roomTitle.textContent = "Todas las pantallas";
    roomSub.replaceChildren(`${onlineCount.textContent} de ${devices.length} en línea`);
    textInput.placeholder = "Aviso para todas las pantallas…";
    liveButtons.replaceChildren();
    return;
  }
  const d = findDevice(current);
  roomTitle.textContent = current;
  roomSub.replaceChildren(el("span", "dot " + (d?.online ? "online" : "offline")), d ? deviceStatusText(d) : "Desconectado");
  textInput.placeholder = `Aviso para ${current}…`;
  if (!canWatch) return liveButtons.replaceChildren();
  liveButtons.replaceChildren(
    ...liveSources(d).map((s) => {
      const watching = live?.device === current && live.source === s.source && live.camera === s.camera;
      const btn = el("button", "live-btn" + (watching ? " active" : ""), s.label);
      btn.type = "button";
      btn.disabled = !d?.online;
      btn.addEventListener("click", () => watch(s));
      return btn;
    })
  );
}

// ---------- En vivo ----------

function liveSources(d) {
  const cameras = (d?.cameras || []).map((c) => ({ source: "camera", camera: c.id, label: c.label }));
  return [{ source: "screen", camera: undefined, label: "Ver pantalla" }, ...cameras];
}

function setLiveStatus(text) {
  if (liveStatus.textContent !== text) liveStatus.textContent = text;
}

function watch(s) {
  live = { device: current, source: s.source, camera: s.camera, label: s.label };
  liveTitle.textContent = `${current} · ${s.source === "screen" ? "Pantalla" : s.label}`;
  setLiveStatus(s.source === "screen" ? "Conectando… La primera vez alguien debe aceptar en la pantalla." : "Conectando…");
  liveCanvas.hidden = true;
  liveView.hidden = false;
  renderHeader();
  socket.emit("panel:watch", { device: current, source: s.source, camera: s.camera }, (res) => {
    if (!res.ok) setLiveStatus(res.error);
  });
}

function stopLive() {
  if (!live) return;
  live = null;
  socket.emit("panel:unwatch");
  liveView.hidden = true;
}

function drawFrame(image, rotation) {
  const turned = rotation === 90 || rotation === 270;
  const w = turned ? image.height : image.width;
  const h = turned ? image.width : image.height;
  if (liveCanvas.width !== w) liveCanvas.width = w;
  if (liveCanvas.height !== h) liveCanvas.height = h;
  const ctx = liveCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  liveCanvas.hidden = false;
  setLiveStatus("");
}

$("live-close").addEventListener("click", () => {
  stopLive();
  renderHeader();
});

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMessages();
}

function openDevice(name) {
  if (live && live.device !== name) stopLive();
  current = name;
  sendError.hidden = true;
  renderAll();
  textInput.focus();
}

allItem.addEventListener("click", () => openDevice("*"));

// ---------- Entrar ----------

function join(name) {
  socket.emit("panel:join", { name }, (res) => {
    if (!res.ok) {
      clearName();
      loginError.textContent = res.error;
      loginError.hidden = false;
      return;
    }
    me = res.name;
    canWatch = !!res.canWatch;
    saveName(me);
    devices = res.devices;
    messages = res.messages;
    $("me").textContent = me;
    $("server-urls").replaceChildren(...res.serverUrls.map((url) => el("code", null, url)));
    $("apk-urls").replaceChildren(...res.serverUrls.map((url) => el("code", null, `${url}/avisos.apk`)));
    if (current !== "*" && !findDevice(current)) current = "*";

    offlineBanner.hidden = true;
    loginView.hidden = true;
    panelView.hidden = false;
    renderAll();
    // Al reconectar con el servidor, retomar la vista en vivo
    if (live && canWatch && live.device === current) watch(live);
    else stopLive();
    textInput.focus();
  });
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  join(nameInput.value.trim());
});

// ---------- Salir ----------

$("logout").addEventListener("click", () => {
  stopLive();
  socket.emit("panel:leave");
  me = null;
  canWatch = false;
  current = "*";
  clearName();
  sendError.hidden = true;
  offlineBanner.hidden = true;
  loginError.hidden = true;
  nameInput.value = "";
  panelView.hidden = true;
  loginView.hidden = false;
  nameInput.focus();
});

// ---------- Enviar ----------

sendForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  socket.emit("panel:send", { to: current, text }, (res) => {
    sendError.hidden = res.ok;
    if (!res.ok) sendError.textContent = res.error;
  });
  textInput.value = "";
});

// ---------- Eventos del servidor ----------

socket.on("devices", (list) => {
  devices = list;
  if (!me) return;
  renderSidebar();
  renderHeader();
});

socket.on("message", (msg) => {
  const i = messages.findIndex((m) => m.id === msg.id);
  if (i >= 0) messages[i] = msg;
  else messages.push(msg);
  if (!me || (current !== "*" && msg.to !== current)) return;

  const existing = messagesList.querySelector(`[data-id="${msg.id}"]`);
  if (existing) existing.replaceWith(messageElement(msg));
  else renderMessages();
});

socket.on("live:frame", async (frame, rotation) => {
  // Si todavía se está dibujando el cuadro anterior, este se descarta
  if (!live || drawing) return;
  drawing = true;
  try {
    const image = await createImageBitmap(new Blob([frame], { type: "image/jpeg" }));
    if (live) drawFrame(image, rotation);
    image.close();
  } catch {
    // Cuadro dañado: se espera el siguiente
  } finally {
    drawing = false;
  }
});

socket.on("live:status", (text) => {
  if (live) setLiveStatus(text);
});

// Otro panel cambió lo que se ve de esta pantalla
socket.on("live:source", (src) => {
  if (!live) return;
  const s = liveSources(findDevice(live.device)).find((x) => x.source === src.type && (src.type === "screen" || x.camera === src.camera));
  if (!s || (s.source === live.source && s.camera === live.camera)) return;
  Object.assign(live, s);
  liveTitle.textContent = `${live.device} · ${s.source === "screen" ? "Pantalla" : s.label}`;
  renderHeader();
});

socket.on("connect", () => {
  const saved = me || loadName();
  if (saved) join(saved);
});

socket.on("disconnect", () => {
  if (me) offlineBanner.hidden = false;
  if (live) setLiveStatus("Sin conexión con el servidor…");
});
