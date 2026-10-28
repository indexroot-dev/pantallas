import express from "express";
import { createServer } from "node:http";
import { createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const MAX_MESSAGES = 500;
// El administrador ve todas las pantallas, las ve en vivo y crea los grupos y los usuarios
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ACCESS_WORD || "indexroot";
const ADMINS = "admins";
// Usuarios y grupos (en Docker, ./data de la Pi)
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL("./data/", import.meta.url));
const USERS_FILE = join(DATA_DIR, "usuarios.json");
// Lo deja ahí la compilación de la app (ver android/app/build.gradle.kts)
const APK_PATH = fileURLToPath(new URL("./apk/avisos.apk", import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Descarga de la app Android para instalarla en las pantallas
app.get("/avisos.apk", (req, res) => {
  res.download(APK_PATH, "avisos.apk", (err) => {
    if (err && !res.headersSent) res.status(404).send("La app Android todavía no está compilada.");
  });
});

// ---------- Usuarios y grupos ----------

// { secret, users: [{ id, name, salt, hash, createdAt }], groups: [{ id, name, code, manager, createdAt }] }
// code: el código de grupo sin guion. manager: id del usuario que lo administra, o null (solo el admin)
const store = loadStore();

function loadStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  try {
    const data = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    if (data?.secret && Array.isArray(data.users)) return migrate(data);
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`No se pudo leer ${USERS_FILE}: ${err.message}`);
  }
  const fresh = { secret: randomBytes(32).toString("hex"), users: [], groups: [] };
  saveStore(fresh);
  return fresh;
}

// Antes cada usuario tenía su propio código: pasa a ser un grupo con su nombre, para que sus pantallas sigan entrando
function migrate(data) {
  data.groups ??= [];
  for (const user of data.users) {
    if (!user.code) continue;
    data.groups.push({ id: randomUUID(), name: user.name, code: user.code, manager: user.id, createdAt: user.createdAt });
    delete user.code;
  }
  saveStore(data);
  return data;
}

// Se escribe en otro archivo y se renombra, para no dejarlo a medias si se corta la luz
function saveStore(data = store) {
  const tmp = `${USERS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, USERS_FILE);
}

const hashPassword = (password, salt) => scryptSync(password, salt, 32).toString("hex");

function passwordMatches(user, password) {
  const hash = Buffer.from(hashPassword(password, user.salt), "hex");
  return timingSafeEqual(hash, Buffer.from(user.hash, "hex"));
}

function setPassword(user, password) {
  user.salt = randomBytes(16).toString("hex");
  user.hash = hashPassword(password, user.salt);
}

// Sin letras ni números que se confundan (O/0, I/1, L)
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const cleanCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
  } while (store.groups.some((g) => g.code === code));
  return code;
}

const userById = (id) => store.users.find((u) => u.id === id);
const userByName = (name) => store.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
const groupById = (id) => store.groups.find((g) => g.id === id);
const groupByName = (name) => store.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
const groupByCode = (code) => store.groups.find((g) => g.code === code);
const managedGroups = (userId) => store.groups.filter((g) => g.manager === userId);

// La sesión del panel: el navegador guarda esto en vez de la contraseña.
// Deja de valer al cambiar la contraseña o al borrar el usuario.
function sessionToken(id) {
  const proof = id === ADMIN_ID ? ADMIN_PASSWORD : userById(id)?.hash;
  return `${id}.${createHmac("sha256", store.secret).update(`${id}:${proof}`).digest("hex").slice(0, 40)}`;
}

function userFromToken(token) {
  const id = String(token || "").split(".")[0];
  if (id !== ADMIN_ID && !userById(id)) return null;
  const expected = Buffer.from(sessionToken(id));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given) ? sessionUser(id) : null;
}

// groups: los que administra, con su código para conectar las pantallas
function sessionUser(id) {
  if (id === ADMIN_ID) return { id, name: "admin", isAdmin: true, groups: [] };
  const user = userById(id);
  const groups = managedGroups(id).map((g) => ({ id: g.id, name: g.name, code: showCode(g.code) }));
  return { id, name: user.name, isAdmin: false, groups };
}

function login(name, password) {
  if (name.toLowerCase() === ADMIN_ID) return password === ADMIN_PASSWORD ? sessionUser(ADMIN_ID) : null;
  const user = userByName(name);
  return user && passwordMatches(user, password) ? sessionUser(user.id) : null;
}

// Lo que ve el admin en "Grupos y usuarios"
function adminData() {
  const groups = store.groups.map((g) => {
    const own = [...devices.values()].filter((d) => d.group === g.id);
    return { id: g.id, name: g.name, code: showCode(g.code), manager: g.manager, devices: own.length, online: own.filter((d) => d.socketId).length };
  });
  const users = store.users.map((u) => ({ id: u.id, name: u.name, groups: managedGroups(u.id).map((g) => g.name) }));
  return { groups, users };
}

// ---------- Pantallas y avisos ----------

// Pantallas (app Android). Clave: "<id del grupo>:<nombre en minúsculas>"; sin código de grupo, grupo "" (solo las ve el admin)
// { id, name, group, socketId, lastSeen, cameras, live }. live: lo que se está transmitiendo o null
const devices = new Map();
// Avisos enviados, del más viejo al más nuevo.
// status: "sent" (enviado) -> "delivered" (llegó a la pantalla) -> "acknowledged" (pulsó Entendido)
const messages = [];

const deviceKey = (group, name) => `${group}:${String(name).trim().toLowerCase()}`;
const cleanName = (name, max = 24) => String(name || "").trim().slice(0, max);
const userRoom = (id) => `user:${id}`;
// Pantallas y avisos de sus grupos; el admin, todo
const canSee = (user, item) => user.isAdmin || (!!item.group && groupById(item.group)?.manager === user.id);

function lanUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

function deviceList(user) {
  return [...devices.values()].filter((d) => canSee(user, d)).map((d) => ({
    id: d.id,
    name: d.name,
    group: d.group ? groupById(d.group)?.name ?? "" : "",
    online: !!d.socketId,
    lastSeen: d.lastSeen,
    cameras: user.isAdmin ? d.cameras : [],
    pending: messages.filter((m) => m.device === d.id && m.status !== "acknowledged").length,
  }));
}

const messagesFor = (user) => messages.filter((m) => canSee(user, m));

function cleanCameras(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((c) => ({ id: String(c?.id ?? "").slice(0, 16), label: String(c?.label ?? "Cámara").slice(0, 40) }));
}

// El admin que está viendo una pantalla en vivo está en esta sala
const liveRoom = (key) => `live:${key}`;
const liveViewers = (key) => io.sockets.adapter.rooms.get(liveRoom(key))?.size ?? 0;

function stopWatching(socket) {
  const key = socket.data.watching;
  if (!key) return;
  socket.data.watching = null;
  socket.leave(liveRoom(key));
  const device = devices.get(key);
  if (!device || liveViewers(key)) return;
  device.live = null;
  if (device.socketId) io.to(device.socketId).emit("live:stop");
}

function publishDevices() {
  io.to(ADMINS).emit("devices", deviceList(sessionUser(ADMIN_ID)));
  for (const u of store.users) io.to(userRoom(u.id)).emit("devices", deviceList(sessionUser(u.id)));
}

const publishAdmin = () => io.to(ADMINS).emit("admin", adminData());

function publishMessage(msg) {
  const manager = groupById(msg.group)?.manager;
  (manager ? io.to(ADMINS).to(userRoom(manager)) : io.to(ADMINS)).emit("message", msg);
}

function deliver(device, msg) {
  if (device.socketId) io.to(device.socketId).emit("notify", { id: msg.id, from: msg.from, text: msg.text, at: msg.at });
}

function messageForDevice(socket, id) {
  return messages.find((m) => m.id === id && m.device === socket.data.device);
}

/** Cierra las sesiones del panel de ese usuario (se borró o se le cambió la contraseña). */
function endSessions(userId, reason) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.user?.id !== userId) continue;
    s.emit("session:ended", reason);
    leavePanel(s);
  }
}

/** Cambiaron sus grupos: el panel vuelve a pedir todo (pantallas, avisos y códigos). */
function refreshUsers(...ids) {
  for (const id of new Set(ids)) if (id) io.to(userRoom(id)).emit("session:refresh");
}

function leavePanel(socket) {
  stopWatching(socket);
  const user = socket.data.user;
  if (!user) return;
  socket.leave(user.isAdmin ? ADMINS : userRoom(user.id));
  socket.data.user = null;
}

/** Desconecta las pantallas del grupo y olvida sus avisos (se borró el grupo). */
function dropGroupDevices(groupId) {
  for (const [key, device] of devices) {
    if (device.group !== groupId) continue;
    devices.delete(key);
    if (device.socketId) io.sockets.sockets.get(device.socketId)?.disconnect(true);
  }
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].group === groupId) messages.splice(i, 1);
}

const fail = (reply, error) => reply({ ok: false, error });

io.on("connection", (socket) => {
  // ---------- Panel web ----------

  socket.on("panel:join", (data, ack) => {
    if (typeof ack !== "function") return;
    let user;
    if (data?.token) {
      user = userFromToken(data.token);
      if (!user) return fail(ack, "La sesión terminó. Vuelve a entrar.");
    } else {
      const name = cleanName(data?.name);
      const password = String(data?.password ?? "");
      if (!name || !password) return fail(ack, "Escribe el usuario y la contraseña");
      user = login(name, password);
      // Una pequeña espera para que no se puedan probar contraseñas a toda velocidad
      if (!user) return setTimeout(() => fail(ack, "Usuario o contraseña incorrectos"), 1000);
    }

    leavePanel(socket);
    socket.data.user = user;
    socket.join(user.isAdmin ? ADMINS : userRoom(user.id));
    ack({
      ok: true,
      token: sessionToken(user.id),
      user,
      devices: deviceList(user),
      messages: messagesFor(user),
      admin: user.isAdmin ? adminData() : null,
      serverUrls: lanUrls(),
    });
  });

  socket.on("panel:leave", () => leavePanel(socket));

  // Ver en vivo la pantalla o una cámara de un dispositivo (solo el admin)
  socket.on("panel:watch", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!socket.data.user?.isAdmin) return fail(reply, "Solo el administrador puede ver las pantallas en vivo");
    const key = String(data?.device ?? "");
    const device = devices.get(key);
    if (!device?.socketId) return fail(reply, "La pantalla no está en línea");

    const live = data?.source === "screen" ? { type: "screen" } : { type: "camera", camera: String(data?.camera ?? "") };
    if (socket.data.watching !== key) stopWatching(socket);
    socket.join(liveRoom(key));
    socket.data.watching = key;
    // Si otro panel ya la estaba viendo, todos pasan a ver la nueva fuente
    device.live = live;
    io.to(device.socketId).emit("live:start", live);
    io.to(liveRoom(key)).emit("live:source", live);
    reply({ ok: true });
  });

  socket.on("panel:unwatch", () => stopWatching(socket));

  socket.on("panel:send", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const user = socket.data.user;
    const text = String(data?.text || "").trim().slice(0, 1000);
    if (!user) return fail(reply, "La sesión terminó. Vuelve a entrar.");
    if (!text) return fail(reply, "Mensaje vacío");

    const visible = [...devices.values()].filter((d) => canSee(user, d));
    const targets = data?.to === "*" ? visible : visible.filter((d) => d.id === data?.to);
    if (!targets.length) return fail(reply, "No hay pantallas a quién enviar");

    for (const device of targets) {
      const msg = {
        id: randomUUID(), device: device.id, to: device.name, group: device.group, from: user.name, text,
        at: Date.now(), status: "sent", deliveredAt: null, ackAt: null,
      };
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages.shift();
      publishMessage(msg);
      deliver(device, msg);
    }
    publishDevices();
    reply({ ok: true });
  });

  // ---------- Grupos y usuarios (solo el admin) ----------

  function adminAction(handler) {
    return (data, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!socket.data.user?.isAdmin) return fail(reply, "Solo el administrador puede hacer esto");
      const error = handler(data ?? {});
      if (error) return fail(reply, error);
      saveStore();
      publishAdmin();
      publishDevices();
      reply({ ok: true });
    };
  }

  const passwordProblem = (password) => (password.length < 4 ? "La contraseña debe tener al menos 4 caracteres" : null);
  // "" o null: el grupo queda sin usuario (lo administra solo el admin)
  const managerProblem = (manager) => (manager && !userById(manager) ? "Ese usuario ya no existe" : null);

  socket.on("admin:create-group", adminAction((data) => {
    const name = cleanName(data.name, 40);
    if (name.length < 2) return "El nombre del grupo debe tener al menos 2 letras";
    if (groupByName(name)) return `Ya existe el grupo ${name}`;
    const problem = managerProblem(data.manager);
    if (problem) return problem;
    const manager = data.manager || null;
    store.groups.push({ id: randomUUID(), name, code: newCode(), manager, createdAt: Date.now() });
    refreshUsers(manager);
  }));

  // Cambiar el nombre o quién lo administra
  socket.on("admin:update-group", adminAction((data) => {
    const group = groupById(data.id);
    if (!group) return "Ese grupo ya no existe";
    const before = group.manager;
    if (data.name !== undefined) {
      const name = cleanName(data.name, 40);
      if (name.length < 2) return "El nombre del grupo debe tener al menos 2 letras";
      const other = groupByName(name);
      if (other && other !== group) return `Ya existe el grupo ${name}`;
      group.name = name;
    }
    if (data.manager !== undefined) {
      const problem = managerProblem(data.manager);
      if (problem) return problem;
      group.manager = data.manager || null;
    }
    refreshUsers(before, group.manager);
  }));

  // Sus pantallas se desconectan: hasta que se les escriba otro código, quedan fuera
  socket.on("admin:delete-group", adminAction((data) => {
    const group = groupById(data.id);
    if (!group) return "Ese grupo ya no existe";
    store.groups = store.groups.filter((g) => g !== group);
    dropGroupDevices(group.id);
    refreshUsers(group.manager);
  }));

  socket.on("admin:create-user", adminAction((data) => {
    const name = cleanName(data.name);
    const password = String(data.password ?? "");
    if (name.length < 2) return "El nombre debe tener al menos 2 letras";
    if (name.toLowerCase() === ADMIN_ID || userByName(name)) return `Ya existe el usuario ${name}`;
    const problem = passwordProblem(password);
    if (problem) return problem;
    const user = { id: randomUUID(), name, createdAt: Date.now() };
    setPassword(user, password);
    store.users.push(user);
  }));

  socket.on("admin:set-password", adminAction((data) => {
    const user = userById(data.id);
    const password = String(data.password ?? "");
    if (!user) return "Ese usuario ya no existe";
    const problem = passwordProblem(password);
    if (problem) return problem;
    setPassword(user, password);
    endSessions(user.id, "Te cambiaron la contraseña. Vuelve a entrar.");
  }));

  // Sus grupos quedan sin usuario: las pantallas siguen conectadas y las administra el admin
  socket.on("admin:delete-user", adminAction((data) => {
    const user = userById(data.id);
    if (!user) return "Ese usuario ya no existe";
    store.users = store.users.filter((u) => u !== user);
    for (const g of managedGroups(user.id)) g.manager = null;
    endSessions(user.id, "Tu usuario fue eliminado.");
  }));

  // ---------- Pantalla Android (recibe avisos) ----------

  socket.on("device:join", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const name = cleanName(data?.name);
    if (!name) return fail(reply, "Falta el nombre");

    // Sin código (o una app de antes de los grupos): la pantalla es del admin
    const code = cleanCode(data?.code);
    const group = code ? groupByCode(code) : null;
    if (code && !group) return fail(reply, "Código de grupo incorrecto");
    const groupId = group?.id ?? "";

    const key = deviceKey(groupId, name);
    let device = devices.get(key);
    if (!device) {
      device = { id: key, name, group: groupId, socketId: null, lastSeen: null, cameras: [], live: null };
      devices.set(key, device);
    }
    device.cameras = cleanCameras(data?.cameras);

    // La misma pantalla reconectando: se cierra la conexión vieja
    if (device.socketId && device.socketId !== socket.id) io.sockets.sockets.get(device.socketId)?.disconnect(true);

    device.socketId = socket.id;
    socket.data.device = key;
    reply({ ok: true, name: device.name, group: group?.name ?? "" });

    // Reenviar los avisos que todavía no confirmó
    messages.filter((m) => m.device === key && m.status !== "acknowledged").forEach((m) => deliver(device, m));
    // Si alguien la estaba viendo cuando se desconectó, retomar la transmisión
    if (device.live && liveViewers(key)) socket.emit("live:start", device.live);
    publishDevices();
    publishAdmin();
  });

  // Cuadro JPEG de la transmisión en vivo. El ack le indica a la pantalla que puede mandar el siguiente.
  socket.on("device:frame", (frame, rotation, ack) => {
    const key = socket.data.device;
    if (key && Buffer.isBuffer(frame)) io.to(liveRoom(key)).volatile.emit("live:frame", frame, Number(rotation) || 0);
    if (typeof ack === "function") ack();
  });

  socket.on("device:live-status", (text) => {
    const key = socket.data.device;
    if (key) io.to(liveRoom(key)).emit("live:status", String(text || "").slice(0, 200));
  });

  socket.on("device:received", (id) => {
    const msg = messageForDevice(socket, id);
    if (!msg || msg.status !== "sent") return;
    msg.status = "delivered";
    msg.deliveredAt = Date.now();
    publishMessage(msg);
  });

  socket.on("device:ack", (id) => {
    const msg = messageForDevice(socket, id);
    if (!msg || msg.status === "acknowledged") return;
    msg.deliveredAt ??= Date.now();
    msg.status = "acknowledged";
    msg.ackAt = Date.now();
    publishMessage(msg);
    publishDevices();
  });

  socket.on("disconnect", () => {
    stopWatching(socket);
    const device = devices.get(socket.data.device);
    if (!device || device.socketId !== socket.id) return;
    device.socketId = null;
    device.lastSeen = Date.now();
    io.to(liveRoom(socket.data.device)).emit("live:status", "La pantalla se desconectó. Esperando que vuelva…");
    publishDevices();
    publishAdmin();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Panel web:          http://localhost:${PORT}`);
  for (const url of lanUrls()) {
    console.log(`Dirección para la app Android: ${url}`);
    console.log(`Descargar la app Android:      ${url}/avisos.apk`);
  }
});
