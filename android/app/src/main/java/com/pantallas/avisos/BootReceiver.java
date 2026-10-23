package com.pantallas.avisos;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

/** Al encender la pantalla: vuelve a conectar y abre la app. */
public class BootReceiver extends BroadcastReceiver {
    private static final String ACTION_QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !ACTION_QUICKBOOT.equals(action)) return;

        if (Store.isConfigured(context)) {
            try {
                MessageService.start(context);
            } catch (RuntimeException e) {
                Log.w("Avisos", "No se pudo iniciar el servicio al encender", e);
            }
        }

        if (!canOpenOnBoot(context)) return;
        try {
            context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            Log.w("Avisos", "No se pudo abrir la app al encender", e);
        }
    }

    /** Desde Android 10 abrir una pantalla en segundo plano requiere el permiso "Mostrar sobre otras apps". */
    static boolean canOpenOnBoot(Context context) {
        return Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(context);
    }
}
