const socket = io();

const $ = (id) => document.getElementById(id);
const loginView = $("login");
const panelView = $("panel");
const loginForm = $("login-form");
const loginUser = $("login-user");
const loginPassword = $("login-password");
const loginError = $("login-error");
const allItem = $("all");
const adminItem = $("admin-item");
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
const adminView = $("admin-view");
const adminError = $("admin-error");
const groupsList = $("groups-list");
const usersList = $("users-list");
const newGroupManager = $("new-group-manager");

const STORAGE_KEY = "panel-session";
const ADMIN_VIEW = "@admin";

let me = null; // { id, name, isAdmin, groups: [{ id, name, code }] }
let devices = [];
let messages = [];
let admin = { groups: [], users: [] }; // solo para el admin
let current = "*"; // "*" = todas, ADMIN_VIEW = grupos y usuarios, o el id de una pantalla
let live = null; // lo que se está viendo en vivo: { device, source: "screen" | "camera", camera, label }
let drawing = false;

const findDevice = (id) => devices.find((d) => d.id === id);
// Con pantallas de varios grupos, los nombres se pueden repetir
const showsGroups = () => me?.isAdmin || me?.groups.length > 1;
const deviceLabel = (d) => (showsGroups() ? `${d.name} · ${d.group || "sin grupo"}` : d.name);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function loadToken() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function saveToken(token) {
  try { localStorage.setItem(STORAGE_KEY, token); } catch {}
}
function clearToken() {
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

function button(text, className, onClick) {
  const btn = el("button", className, text);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
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
  if (current === "*") {
    const d = findDevice(msg.device);
    meta.append(el("span", "author", `Para ${d ? deviceLabel(d) : msg.to}`));
  }
  // Los avisos de un grupo los pueden mandar su usuario y el admin
  if (msg.from !== me.name) meta.append(el("span", "author", `de ${msg.from}`));
  meta.append(el("time", null, formatTime(msg.at)), statusChip(msg));
  li.append(meta, el("div", null, msg.text));
  return li;
}

function visibleMessages() {
  return current === "*" ? messages : messages.filter((m) => m.device === current);
}

function renderMessages() {
  if (current === ADMIN_VIEW) return;
  const list = visibleMessages();
  if (list.length === 0) {
    const d = findDevice(current);
    const hint = d ? `Aún no hay avisos para ${d.name}.` : "Aún no hay avisos.";
    messagesList.replaceChildren(el("li", "system", hint));
  } else {
    messagesList.replaceChildren(...list.map(messageElement));
  }
  messagesList.scrollTop = messagesList.scrollHeight;
}

// Los códigos que el usuario escribe en la app Android de sus pantallas
function renderMyGroups() {
  $("my-groups").hidden = me.isAdmin;
  if (me.isAdmin) return;
  $("my-groups-list").replaceChildren(
    ...me.groups.map((g) => {
      const li = el("li");
      li.append(el("span", "my-group-name", g.name), el("strong", "group-code-value", g.code));
      return li;
    })
  );
  $("my-groups-hint").textContent = me.groups.length
    ? "Escribe el código en la app Android de cada pantalla, junto con su nombre."
    : "Aún no administras ningún grupo. Pídele al administrador que te asigne uno.";
}

function renderSidebar() {
  const online = devices.filter((d) => d.online).length;
  const pending = devices.reduce((sum, d) => sum + d.pending, 0);
  onlineCount.textContent = online;
  noDevices.hidden = devices.length > 0;
  allItem.classList.toggle("active", current === "*");
  $("all-name").textContent = me.isAdmin ? "Todas las pantallas" : "Todas mis pantallas";
  $("all-status").textContent = pending ? `${pending} sin confirmar` : plural(devices.length, "pantalla", "pantallas");

  adminItem.hidden = !me.isAdmin;
  adminItem.classList.toggle("active", current === ADMIN_VIEW);
  $("admin-status").textContent = `${plural(admin.groups.length, "grupo", "grupos")} · ${plural(admin.users.length, "usuario", "usuarios")}`;
  renderMyGroups();

  const sorted = [...devices].sort((a, b) =>
    (showsGroups() ? a.group.localeCompare(b.group) : 0) || b.online - a.online || a.name.localeCompare(b.name));
  devicesList.replaceChildren(
    ...sorted.map((d) => {
      const btn = button("", "conv-item" + (current === d.id ? " active" : ""), () => openDevice(d.id));
      const info = el("span", "user-info");
      const status = showsGroups() ? `${d.group || "Sin grupo"} · ${deviceStatusText(d)}` : deviceStatusText(d);
      info.append(el("span", "user-name", d.name), el("span", "user-status", status));

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
  liveButtons.replaceChildren();
  if (current === ADMIN_VIEW) {
    roomTitle.textContent = "Grupos y usuarios";
    roomSub.replaceChildren("Cada usuario ve y envía avisos solo a las pantallas de los grupos que administra.");
    return;
  }
  if (current === "*") {
    roomTitle.textContent = me.isAdmin ? "Todas las pantallas" : "Todas mis pantallas";
    roomSub.replaceChildren(`${onlineCount.textContent} de ${devices.length} en línea`);
    textInput.placeholder = me.isAdmin ? "Aviso para todas las pantallas de todos los grupos…" : "Aviso para todas tus pantallas…";
    return;
  }
  const d = findDevice(current);
  roomTitle.textContent = d ? deviceLabel(d) : "";
  roomSub.replaceChildren(el("span", "dot " + (d?.online ? "online" : "offline")), d ? deviceStatusText(d) : "Desconectado");
  textInput.placeholder = `Aviso para ${d?.name ?? ""}…`;
  if (!me.isAdmin) return;
  liveButtons.replaceChildren(
    ...liveSources(d).map((s) => {
      const watching = live?.device === current && live.source === s.source && live.camera === s.camera;
      const btn = button(s.label, "live-btn" + (watching ? " active" : ""), () => watch(s));
      btn.disabled = !d?.online;
      return btn;
    })
  );
}

// ---------- Grupos y usuarios (solo el admin) ----------

// Lista de usuarios para elegir quién administra un grupo
function managerSelect(selected) {
  const select = el("select");
  select.append(new Option("Solo el admin", ""));
  for (const u of [...admin.users].sort((a, b) => a.name.localeCompare(b.name))) select.append(new Option(u.name, u.id));
  select.value = selected || "";
  return select;
}

function renderAdmin() {
  if (!me?.isAdmin) return;
  const keep = newGroupManager.value;
  newGroupManager.replaceChildren(...managerSelect(keep).options);
  newGroupManager.value = admin.users.some((u) => u.id === keep) ? keep : "";

  const groups = [...admin.groups].sort((a, b) => a.name.localeCompare(b.name));
  groupsList.replaceChildren(
    ...(groups.length ? groups.map(groupRow) : [el("li", "system", "Aún no hay grupos. Crea uno arriba y elige qué usuario lo administra.")])
  );
  const users = [...admin.users].sort((a, b) => a.name.localeCompare(b.name));
  usersList.replaceChildren(
    ...(users.length ? users.map(userRow) : [el("li", "system", "Aún no hay usuarios. Crea uno para asignarle grupos.")])
  );
}

function groupRow(g) {
  const li = el("li", "user-row");
  const info = el("div", "user-info");
  info.append(el("span", "user-name", g.name), el("span", "user-status", `${plural(g.devices, "pantalla", "pantallas")} · ${g.online} en línea`));

  const code = el("span", "user-code", g.code);
  code.title = "Código de grupo: se escribe en la app Android";

  const label = el("label", "manager");
  const select = managerSelect(g.manager);
  select.addEventListener("change", () => adminEmit("admin:update-group", { id: g.id, manager: select.value }));
  label.append(el("span", null, "Lo administra"), select);

  const actions = el("div", "row-actions");
  actions.append(button("Renombrar", "row-btn", () => renameGroup(g)), button("Borrar", "row-btn danger", () => deleteGroup(g)));
  li.append(info, code, label, actions);
  return li;
}

function userRow(u) {
  const li = el("li", "user-row");
  const info = el("div", "user-info");
  const groups = u.groups.length ? `Administra: ${u.groups.join(", ")}` : "Sin grupos asignados";
  info.append(el("span", "user-name", u.name), el("span", "user-status", groups));
  const actions = el("div", "row-actions");
  actions.append(button("Cambiar contraseña", "row-btn", () => changePassword(u)), button("Borrar", "row-btn danger", () => deleteUser(u)));
  li.append(info, actions);
  return li;
}

function adminEmit(event, data, done) {
  socket.emit(event, data, (res) => {
    adminError.hidden = res.ok;
    if (!res.ok) adminError.textContent = res.error;
    if (res.ok && done) done();
  });
}

function renameGroup(g) {
  const name = prompt("Nuevo nombre del grupo:", g.name);
  if (name == null || name.trim() === g.name) return;
  adminEmit("admin:update-group", { id: g.id, name });
}

function deleteGroup(g) {
  const screens = g.devices ? ` Sus ${plural(g.devices, "pantalla", "pantallas")} se desconectarán hasta que se les escriba otro código.` : "";
  if (!confirm(`¿Borrar el grupo ${g.name}?${screens}`)) return;
  adminEmit("admin:delete-group", { id: g.id });
}

function changePassword(u) {
  const password = prompt(`Nueva contraseña para ${u.name} (mínimo 4 caracteres):`);
  if (password == null) return;
  adminEmit("admin:set-password", { id: u.id, password });
}

function deleteUser(u) {
  const groups = u.groups.length ? ` Sus grupos (${u.groups.join(", ")}) quedarán sin usuario, a cargo del admin.` : "";
  if (!confirm(`¿Borrar a ${u.name}?${groups}`)) return;
  adminEmit("admin:delete-user", { id: u.id });
}

$("group-form").addEventListener("submit", (e) => {
  e.preventDefault();
  adminEmit("admin:create-group", { name: $("new-group-name").value.trim(), manager: newGroupManager.value }, () => {
    $("new-group-name").value = "";
  });
});

$("user-form").addEventListener("submit", (e) => {
  e.preventDefault();
  adminEmit("admin:create-user", { name: $("new-user-name").value.trim(), password: $("new-user-password").value }, () => {
    $("new-user-name").value = "";
    $("new-user-password").value = "";
  });
});

// ---------- En vivo (solo el admin) ----------

function liveSources(d) {
  const cameras = (d?.cameras || []).map((c) => ({ source: "camera", camera: c.id, label: c.label }));
  return [{ source: "screen", camera: undefined, label: "Ver pantalla" }, ...cameras];
}

function setLiveStatus(text) {
  if (liveStatus.textContent !== text) liveStatus.textContent = text;
}

function watch(s) {
  const d = findDevice(current);
  live = { device: current, source: s.source, camera: s.camera, label: s.label };
  liveTitle.textContent = `${d ? deviceLabel(d) : ""} · ${s.source === "screen" ? "Pantalla" : s.label}`;
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
  const inAdmin = current === ADMIN_VIEW;
  adminView.hidden = !inAdmin;
  messagesList.hidden = inAdmin;
  sendForm.hidden = inAdmin;
  if (inAdmin) sendError.hidden = true;
  renderSidebar();
  renderHeader();
  renderMessages();
  renderAdmin();
}

function openDevice(id) {
  if (live && live.device !== id) stopLive();
  current = id;
  sendError.hidden = true;
  adminError.hidden = true;
  renderAll();
  if (id === ADMIN_VIEW) $("new-group-name").focus();
  else textInput.focus();
}

allItem.addEventListener("click", () => openDevice("*"));
adminItem.addEventListener("click", () => openDevice(ADMIN_VIEW));

// ---------- Entrar ----------

function showLogin(error) {
  stopLive();
  me = null;
  current = "*";
  clearToken();
  sendError.hidden = true;
  offlineBanner.hidden = true;
  loginError.hidden = !error;
  loginError.textContent = error || "";
  loginPassword.value = "";
  panelView.hidden = true;
  loginView.hidden = false;
  (loginUser.value ? loginPassword : loginUser).focus();
}

// credentials: { name, password } al escribirlos, o { token } al volver a la página o reconectar
function join(credentials) {
  socket.emit("panel:join", credentials, (res) => {
    if (!res.ok) return showLogin(res.error);
    me = res.user;
    saveToken(res.token);
    devices = res.devices;
    messages = res.messages;
    admin = res.admin || { groups: [], users: [] };
    $("me").textContent = me.name;
    // La dirección de esta página (ej. https://pantallas.allsx.me); desde localhost, las de la red local
    const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
    const urls = isLocal ? res.serverUrls : [location.origin];
    $("server-urls").replaceChildren(...urls.map((url) => el("code", null, url)));
    $("apk-urls").replaceChildren(...urls.map((url) => el("code", null, `${url}/avisos.apk`)));
    if ((current === ADMIN_VIEW && !me.isAdmin) || (current !== "*" && current !== ADMIN_VIEW && !findDevice(current))) current = "*";

    offlineBanner.hidden = true;
    loginError.hidden = true;
    loginView.hidden = true;
    panelView.hidden = false;
    renderAll();
    // Al reconectar con el servidor, retomar la vista en vivo
    if (live && me.isAdmin && live.device === current) watch(live);
    else stopLive();
    if (current !== ADMIN_VIEW && document.activeElement === document.body) textInput.focus();
  });
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  join({ name: loginUser.value.trim(), password: loginPassword.value });
});

// ---------- Salir ----------

$("logout").addEventListener("click", () => {
  socket.emit("panel:leave");
  loginUser.value = "";
  showLogin();
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
  if (current !== "*" && current !== ADMIN_VIEW && !findDevice(current)) {
    stopLive();
    current = "*";
    return renderAll();
  }
  renderSidebar();
  renderHeader();
});

socket.on("admin", (data) => {
  admin = data;
  if (!me?.isAdmin) return;
  renderSidebar();
  renderAdmin();
});

socket.on("message", (msg) => {
  const i = messages.findIndex((m) => m.id === msg.id);
  if (i >= 0) messages[i] = msg;
  else messages.push(msg);
  if (!me || current === ADMIN_VIEW || (current !== "*" && msg.device !== current)) return;

  const existing = messagesList.querySelector(`[data-id="${msg.id}"]`);
  if (existing) existing.replaceWith(messageElement(msg));
  else renderMessages();
});

// Se borró el usuario o le cambiaron la contraseña
socket.on("session:ended", (reason) => showLogin(reason));

// El admin le asignó o quitó grupos: se vuelve a pedir todo
socket.on("session:refresh", () => {
  const token = loadToken();
  if (me && token) join({ token });
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
  const d = findDevice(live.device);
  const s = liveSources(d).find((x) => x.source === src.type && (src.type === "screen" || x.camera === src.camera));
  if (!s || (s.source === live.source && s.camera === live.camera)) return;
  Object.assign(live, s);
  liveTitle.textContent = `${d ? deviceLabel(d) : ""} · ${s.source === "screen" ? "Pantalla" : s.label}`;
  renderHeader();
});

socket.on("connect", () => {
  const token = loadToken();
  if (token) join({ token });
});

socket.on("disconnect", () => {
  if (me) offlineBanner.hidden = false;
  if (live) setLiveStatus("Sin conexión con el servidor…");
});

// La sesión de antes de los usuarios guardaba la palabra de acceso
try { localStorage.removeItem("panel-name"); } catch {}
