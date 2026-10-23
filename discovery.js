import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

// La app Android escucha en este puerto UDP el anuncio con la dirección del servidor
const DISCOVERY_PORT = 41234;
const DISCOVERY_INTERVAL_MS = 3000;

export const lanInterfaces = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal);

// Dirección de broadcast de la red de una interfaz, ej. 192.168.18.96/24 -> 192.168.18.255
function broadcastAddress({ address, netmask }) {
  const mask = netmask.split(".").map(Number);
  return address.split(".").map((n, k) => n | (~mask[k] & 255)).join(".");
}

// Anuncia en cada red local la dirección con la que se llega al servidor desde esa red
export function startDiscoveryBeacon(port) {
  const beacon = dgram.createSocket("udp4");
  beacon.on("error", (err) => console.warn("Anuncio en la red local:", err.message));
  beacon.bind(() => {
    beacon.setBroadcast(true);
    const announce = () => {
      for (const i of lanInterfaces()) {
        const msg = JSON.stringify({ service: "pantallas-avisos", url: `http://${i.address}:${port}` });
        beacon.send(msg, DISCOVERY_PORT, broadcastAddress(i), () => {});
      }
    };
    announce();
    setInterval(announce, DISCOVERY_INTERVAL_MS);
  });
}
