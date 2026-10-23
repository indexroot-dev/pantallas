// Solo anuncia la dirección del servidor en la red local, sin servir el panel.
// Para Docker: el servidor corre en la red interna de Docker, de donde el broadcast no sale,
// así que este proceso corre aparte con la red del host y anuncia el puerto publicado.
import { lanInterfaces, startDiscoveryBeacon } from "./discovery.js";

const port = Number(process.env.ANNOUNCE_PORT || process.env.PORT || 3000);

startDiscoveryBeacon(port);
for (const i of lanInterfaces()) console.log(`Anunciando http://${i.address}:${port}`);
