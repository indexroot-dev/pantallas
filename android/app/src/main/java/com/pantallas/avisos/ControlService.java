package com.pantallas.avisos;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

/**
 * Servicio de accesibilidad que ejecuta lo que se hace desde el panel con "Tomar el control":
 * toques y deslizamientos, botones del sistema, flechas del control remoto y texto.
 * Android solo deja controlar otras apps así, y hay que activarlo a mano en Accesibilidad.
 */
public class ControlService extends AccessibilityService {
    private static final long MAX_GESTURE_MS = 3000;

    /** El servicio activo, o null si no está activado en Accesibilidad. */
    private static volatile ControlService instance;

    static boolean isEnabled() {
        return instance != null;
    }

    /** Ejecuta una orden del panel. Devuelve un texto para mostrar en el panel si no se pudo. */
    static String run(JSONObject command) {
        ControlService service = instance;
        if (service == null) {
            return "Para controlar esta pantalla, abre la app Avisos en el dispositivo y pulsa \"Permitir control remoto\"";
        }
        switch (command.optString("type")) {
            case "gesture":
                return service.gesture(command) ? null : "Android no aceptó el toque";
            case "key":
                return service.key(command.optString("key")) ? null : "Esa tecla no hizo nada en la pantalla";
            case "text":
                return service.type(command.optString("text")) ? null : "Toca primero un campo de texto en la pantalla";
            default:
                return null;
        }
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        sendBroadcast(new Intent(MessageService.ACTION_CHANGED).setPackage(getPackageName()));
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    // ---------- Toques ----------

    /** Las coordenadas llegan entre 0 y 1 sobre la imagen que se ve en el panel. */
    private boolean gesture(JSONObject g) {
        DisplayMetrics metrics = new DisplayMetrics();
        getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics);
        int w = metrics.widthPixels;
        int h = metrics.heightPixels;

        Path path = new Path();
        path.moveTo(coord(g.optDouble("x1"), w), coord(g.optDouble("y1"), h));
        path.lineTo(coord(g.optDouble("x2"), w), coord(g.optDouble("y2"), h));
        long duration = Math.max(1, Math.min(MAX_GESTURE_MS, g.optLong("ms", 50)));

        GestureDescription description = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, duration))
                .build();
        return dispatchGesture(description, null, null);
    }

    private static float coord(double value, int size) {
        if (Double.isNaN(value)) value = 0.5;
        return (float) (Math.max(0, Math.min(1, value)) * (size - 1));
    }

    // ---------- Teclas ----------

    private boolean key(String key) {
        switch (key) {
            case "back": return performGlobalAction(GLOBAL_ACTION_BACK);
            case "home": return performGlobalAction(GLOBAL_ACTION_HOME);
            case "recents": return performGlobalAction(GLOBAL_ACTION_RECENTS);
            case "notifications": return performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
            case "up": return dpad(GLOBAL_ACTION_DPAD_UP, View.FOCUS_UP);
            case "down": return dpad(GLOBAL_ACTION_DPAD_DOWN, View.FOCUS_DOWN);
            case "left": return dpad(GLOBAL_ACTION_DPAD_LEFT, View.FOCUS_LEFT);
            case "right": return dpad(GLOBAL_ACTION_DPAD_RIGHT, View.FOCUS_RIGHT);
            case "enter": return center();
            case "backspace": return backspace();
            default: return false;
        }
    }

    /** Desde Android 13 las flechas son acciones del sistema; antes se mueve el foco a mano. */
    private boolean dpad(int action, int direction) {
        if (Build.VERSION.SDK_INT >= 33) return performGlobalAction(action);
        AccessibilityNodeInfo focused = focused();
        if (focused == null) return false;
        AccessibilityNodeInfo next = focused.focusSearch(direction);
        return next != null && next.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
    }

    private boolean center() {
        if (Build.VERSION.SDK_INT >= 33) return performGlobalAction(GLOBAL_ACTION_DPAD_CENTER);
        AccessibilityNodeInfo focused = focused();
        return focused != null && focused.performAction(AccessibilityNodeInfo.ACTION_CLICK);
    }

    private AccessibilityNodeInfo focused() {
        AccessibilityNodeInfo focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return focused != null ? focused : findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
    }

    // ---------- Texto ----------

    private AccessibilityNodeInfo editable() {
        AccessibilityNodeInfo node = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return node != null && node.isEditable() ? node : null;
    }

    /** Agrega el texto al final del campo que tiene el foco. */
    private boolean type(String text) {
        AccessibilityNodeInfo field = editable();
        if (field == null || text.isEmpty()) return false;
        return setText(field, currentText(field) + text);
    }

    private boolean backspace() {
        AccessibilityNodeInfo field = editable();
        if (field == null) return false;
        String current = currentText(field);
        if (current.isEmpty()) return true;
        return setText(field, current.substring(0, current.offsetByCodePoints(current.length(), -1)));
    }

    /** Si el campo está vacío, getText() devuelve la pista ("Escribe aquí…"). */
    private static String currentText(AccessibilityNodeInfo field) {
        CharSequence text = field.getText();
        if (text == null || field.isShowingHintText()) return "";
        return text.toString();
    }

    private static boolean setText(AccessibilityNodeInfo field, String text) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }
}
