package com.pantallas.avisos;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Escucha en la red local el anuncio del servidor, que cada pocos segundos dice su dirección.
 * Una sola escucha para toda la app: la pantalla de configuración y el servicio se suscriben.
 */
final class ServerDiscovery {
    interface Listener {
        /** Se llama desde el hilo de la escucha. */
        void onServerFound(String url);
    }

    private static final int PORT = 41234;
    private static final String SERVICE = "pantallas-avisos";

    private static final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private static Thread thread;
    private static DatagramSocket socket;
    private static WifiManager.MulticastLock lock;

    private ServerDiscovery() {}

    static synchronized void addListener(Context context, Listener listener) {
        listeners.add(listener);
        if (thread != null) return;

        // Sin este bloqueo, muchos equipos descartan los broadcast que llegan por Wi-Fi
        WifiManager wifi = context.getApplicationContext().getSystemService(WifiManager.class);
        if (wifi != null) {
            lock = wifi.createMulticastLock("avisos");
            lock.setReferenceCounted(false);
            lock.acquire();
        }
        thread = new Thread(ServerDiscovery::listen, "Avisos-descubrir");
        thread.start();
    }

    static synchronized void removeListener(Listener listener) {
        listeners.remove(listener);
        if (!listeners.isEmpty() || thread == null) return;
        thread.interrupt();
        thread = null;
        if (socket != null) socket.close();
        socket = null;
        if (lock != null) lock.release();
        lock = null;
    }

    private static void listen() {
        try (DatagramSocket s = new DatagramSocket(null)) {
            s.setReuseAddress(true);
            s.setBroadcast(true);
            s.bind(new InetSocketAddress(PORT));
            synchronized (ServerDiscovery.class) {
                if (Thread.currentThread() != thread) return;
                socket = s;
            }
            byte[] buffer = new byte[1024];
            while (!Thread.currentThread().isInterrupted()) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                s.receive(packet);
                String url = parse(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                if (url != null) {
                    for (Listener l : listeners) l.onServerFound(url);
                }
            }
        } catch (IOException e) {
            // Normal al dejar de escuchar (se cierra el socket); si no, el puerto está ocupado
            if (!Thread.currentThread().isInterrupted()) Log.w("Avisos", "No se puede escuchar el anuncio del servidor", e);
        }
    }

    private static String parse(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String url = msg.optString("url");
            if (!SERVICE.equals(msg.optString("service")) || !url.startsWith("http://")) return null;
            return url;
        } catch (JSONException e) {
            return null;
        }
    }
}
