import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const MAX_MESSAGES = 500;
const PANELS = "panels";
// Palabras que permiten entrar al panel web y lo que puede hacer cada una
const USERS = new Map([
  [process.env.ACCESS_WORD || "indexroot", { canWatch: true }], // avisos + ver pantallas y cámaras en vivo
  [process.env.SENDER_WORD || "monster", { canWatch: false }], // solo enviar avisos
]);
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

// Pantallas (app Android). Clave: nombre en minúsculas -> { name, socketId, lastSeen, cameras, live }
// live: lo que se está transmitiendo ({ type: "screen" } o { type: "camera", camera }) o null
const devices = new Map();
// Avisos enviados, del más viejo al más nuevo.
// status: "sent" (enviado) -> "delivered" (llegó a la pantalla) -> "acknowledged" (pulsó Entendido)
const messages = [];

const keyOf = (name) => String(name || "").trim().toLowerCase();
const cleanName = (name) => String(name || "").trim().slice(0, 24);

function lanUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

function deviceList() {
  return [...devices.values()].map((d) => ({
    name: d.name,
    online: !!d.socketId,
    lastSeen: d.lastSeen,
    cameras: d.cameras,
    pending: messages.filter((m) => m.to === d.name && m.status !== "acknowledged").length,
  }));
}

function cleanCameras(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((c) => ({ id: String(c?.id ?? "").slice(0, 16), label: String(c?.label ?? "Cámara").slice(0, 40) }));
}

// Los paneles que están viendo una pantalla en vivo están en esta sala
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

const publishDevices = () => io.to(PANELS).emit("devices", deviceList());
const publishMessage = (msg) => io.to(PANELS).emit("message", msg);

function deliver(device, msg) {
  if (device.socketId) io.to(device.socketId).emit("notify", { id: msg.id, from: msg.from, text: msg.text, at: msg.at });
}

function messageForDevice(socket, id) {
  const device = devices.get(socket.data.device);
  return device && messages.find((m) => m.id === id && m.to === device.name);
}

io.on("connection", (socket) => {
  // ---------- Panel web (envía avisos) ----------

  socket.on("panel:join", (data, ack) => {
    if (typeof ack !== "function") return;
    const name = cleanName(data?.name);
    if (!name) return ack({ ok: false, error: "Escribe la palabra de acceso" });
    const user = USERS.get(name);
    if (!user) return ack({ ok: false, error: "Palabra incorrecta" });
    socket.data.panel = name;
    socket.data.canWatch = user.canWatch;
    if (!user.canWatch) stopWatching(socket);
    socket.join(PANELS);
    ack({ ok: true, name, canWatch: user.canWatch, devices: deviceList(), messages, serverUrls: lanUrls() });
  });

  socket.on("panel:leave", () => {
    stopWatching(socket);
    socket.data.panel = null;
    socket.data.canWatch = false;
    socket.leave(PANELS);
  });

  // Ver en vivo la pantalla o una cámara de un dispositivo
  socket.on("panel:watch", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!socket.data.panel) return reply({ ok: false, error: "Sin sesión" });
    if (!socket.data.canWatch) return reply({ ok: false, error: "Este usuario solo puede enviar avisos" });
    const key = keyOf(data?.device);
    const device = devices.get(key);
    if (!device?.socketId) return reply({ ok: false, error: "La pantalla no está en línea" });

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
    const from = socket.data.panel;
    const text = String(data?.text || "").trim().slice(0, 1000);
    if (!from || !text) return reply({ ok: false, error: "Mensaje vacío" });

    const targets = data?.to === "*" ? [...devices.values()] : [devices.get(keyOf(data?.to))].filter(Boolean);
    if (!targets.length) return reply({ ok: false, error: "No hay pantallas a quién enviar" });

    for (const device of targets) {
      const msg = { id: randomUUID(), to: device.name, from, text, at: Date.now(), status: "sent", deliveredAt: null, ackAt: null };
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages.shift();
      publishMessage(msg);
      deliver(device, msg);
    }
    publishDevices();
    reply({ ok: true });
  });

  // ---------- Pantalla Android (recibe avisos) ----------

  socket.on("device:join", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const name = cleanName(data?.name);
    if (!name) return reply({ ok: false, error: "Falta el nombre" });

    const key = keyOf(name);
    let device = devices.get(key);
    if (!device) {
      device = { name, socketId: null, lastSeen: null, cameras: [], live: null };
      devices.set(key, device);
    }
    device.cameras = cleanCameras(data?.cameras);

    // La misma pantalla reconectando: se cierra la conexión vieja
    if (device.socketId && device.socketId !== socket.id) io.sockets.sockets.get(device.socketId)?.disconnect(true);

    device.socketId = socket.id;
    socket.data.device = key;
    reply({ ok: true, name: device.name });

    // Reenviar los avisos que todavía no confirmó
    messages.filter((m) => m.to === device.name && m.status !== "acknowledged").forEach((m) => deliver(device, m));
    // Si alguien la estaba viendo cuando se desconectó, retomar la transmisión
    if (device.live && liveViewers(key)) socket.emit("live:start", device.live);
    publishDevices();
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
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Panel web:          http://localhost:${PORT}`);
  for (const url of lanUrls()) {
    console.log(`Dirección para la app Android: ${url}`);
    console.log(`Descargar la app Android:      ${url}/avisos.apk`);
  }
});
