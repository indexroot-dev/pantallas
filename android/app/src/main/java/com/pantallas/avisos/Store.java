package com.pantallas.avisos;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Configuración y avisos pendientes guardados en la pantalla. */
final class Store {
    private static final String PREFS = "avisos";
    private static final String KEY_SERVER = "server";
    private static final String KEY_NAME = "name";
    private static final String KEY_PENDING = "pending";
    private static final String KEY_ACKED = "acked";
    private static final int MAX_ACKED = 200;

    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        return prefs(c).getString(KEY_SERVER, "");
    }

    static String name(Context c) {
        return prefs(c).getString(KEY_NAME, "");
    }

    static boolean isConfigured(Context c) {
        return !server(c).isEmpty() && !name(c).isEmpty();
    }

    static synchronized void saveConfig(Context c, String server, String name) {
        SharedPreferences.Editor editor = prefs(c).edit().putString(KEY_SERVER, server).putString(KEY_NAME, name);
        // Con otro servidor u otro nombre, los avisos guardados ya no aplican
        if (!server.equals(server(c)) || !name.equalsIgnoreCase(name(c))) {
            editor.remove(KEY_PENDING).remove(KEY_ACKED);
        }
        editor.apply();
    }

    /** Avisos que llegaron y todavía no se confirmaron con "Entendido". */
    static synchronized List<JSONObject> pending(Context c) {
        JSONArray array = readArray(c, KEY_PENDING);
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject msg = array.optJSONObject(i);
            if (msg != null) list.add(msg);
        }
        return list;
    }

    static synchronized void addPending(Context c, JSONObject msg) {
        String id = msg.optString("id");
        JSONArray array = readArray(c, KEY_PENDING);
        for (int i = 0; i < array.length(); i++) {
            JSONObject existing = array.optJSONObject(i);
            if (existing != null && id.equals(existing.optString("id"))) return;
        }
        array.put(msg);
        prefs(c).edit().putString(KEY_PENDING, array.toString()).apply();
    }

    static synchronized void removePending(Context c, String id) {
        JSONArray array = readArray(c, KEY_PENDING);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < array.length(); i++) {
            JSONObject msg = array.optJSONObject(i);
            if (msg != null && !id.equals(msg.optString("id"))) kept.put(msg);
        }
        prefs(c).edit().putString(KEY_PENDING, kept.toString()).apply();
    }

    /** Ids ya confirmados, para no volver a mostrarlos si el servidor los reenvía. */
    static synchronized boolean isAcked(Context c, String id) {
        JSONArray array = readArray(c, KEY_ACKED);
        for (int i = 0; i < array.length(); i++) {
            if (id.equals(array.optString(i))) return true;
        }
        return false;
    }

    static synchronized void markAcked(Context c, String id) {
        if (isAcked(c, id)) return;
        JSONArray array = readArray(c, KEY_ACKED);
        array.put(id);
        while (array.length() > MAX_ACKED) array.remove(0);
        prefs(c).edit().putString(KEY_ACKED, array.toString()).apply();
    }

    private static JSONArray readArray(Context c, String key) {
        try {
            return new JSONArray(prefs(c).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
