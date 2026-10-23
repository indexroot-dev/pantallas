package com.pantallas.avisos;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.format.DateFormat;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/** Muestra el estado de la conexión, los avisos pendientes y la configuración. */
public class MainActivity extends Activity {
    private TextView statusText;
    private TextView emptyText;
    private LinearLayout messagesContainer;
    private LinearLayout configForm;
    private Button changeButton;
    private Button autostartButton;
    private EditText serverInput;
    private EditText nameInput;
    /** Última dirección que se escribió sola, para no pisar una que haya escrito la persona. */
    private String autoServer = "";

    private final BroadcastReceiver changedReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            render();
        }
    };

    /** Completa la dirección del servidor con la que anuncia en la red local. */
    private final ServerDiscovery.Listener discovery = url -> runOnUiThread(() -> {
        String typed = serverInput.getText().toString().trim();
        if (url.equals(typed)) return;
        if (!typed.isEmpty() && !typed.equals(autoServer) && !typed.equals(Store.server(this))) return;
        autoServer = url;
        serverInput.setText(url);
        Toast.makeText(this, "Servidor encontrado: " + url, Toast.LENGTH_SHORT).show();
    });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusText = findViewById(R.id.status);
        emptyText = findViewById(R.id.empty);
        messagesContainer = findViewById(R.id.messages);
        configForm = findViewById(R.id.config_form);
        changeButton = findViewById(R.id.change);
        autostartButton = findViewById(R.id.autostart);
        serverInput = findViewById(R.id.server);
        nameInput = findViewById(R.id.name);

        applySystemBarInsets(findViewById(R.id.root));

        serverInput.setText(Store.server(this));
        nameInput.setText(Store.name(this));
        findViewById(R.id.connect).setOnClickListener(v -> saveAndConnect());
        changeButton.setOnClickListener(v -> {
            configForm.setVisibility(View.VISIBLE);
            changeButton.setVisibility(View.GONE);
        });
        autostartButton.setOnClickListener(v -> openOverlaySettings());

        requestMissingPermissions();
        if (Store.isConfigured(this)) MessageService.start(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(MessageService.ACTION_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(changedReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(changedReceiver, filter);
        }
        ServerDiscovery.addListener(this, discovery);
        render();
    }

    @Override
    protected void onStop() {
        ServerDiscovery.removeListener(discovery);
        unregisterReceiver(changedReceiver);
        super.onStop();
    }

    private void render() {
        boolean configured = Store.isConfigured(this);
        statusText.setText(configured ? MessageService.status : "Configura la conexión para recibir avisos.");
        if (!configured) configForm.setVisibility(View.VISIBLE);
        changeButton.setVisibility(configured && configForm.getVisibility() != View.VISIBLE ? View.VISIBLE : View.GONE);
        autostartButton.setVisibility(BootReceiver.canOpenOnBoot(this) ? View.GONE : View.VISIBLE);

        List<JSONObject> pending = Store.pending(this);
        emptyText.setVisibility(pending.isEmpty() ? View.VISIBLE : View.GONE);
        messagesContainer.removeAllViews();
        LayoutInflater inflater = getLayoutInflater();

        for (JSONObject msg : pending) {
            View card = inflater.inflate(R.layout.item_message, messagesContainer, false);
            String time = DateFormat.getTimeFormat(this).format(new Date(msg.optLong("at")));
            ((TextView) card.findViewById(R.id.message_from)).setText("Aviso de " + msg.optString("from") + " · " + time);
            ((TextView) card.findViewById(R.id.message_text)).setText(msg.optString("text"));
            card.findViewById(R.id.message_ack).setOnClickListener(v -> {
                startService(MessageService.ackIntent(this, msg.optString("id")));
                messagesContainer.removeView(card);
                if (messagesContainer.getChildCount() == 0) emptyText.setVisibility(View.VISIBLE);
            });
            messagesContainer.addView(card);
        }
    }

    private void saveAndConnect() {
        String server = serverInput.getText().toString().trim();
        String name = nameInput.getText().toString().trim();
        if (server.isEmpty() || name.isEmpty()) {
            Toast.makeText(this, "Escribe la dirección y el nombre", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!server.startsWith("http://") && !server.startsWith("https://")) server = "http://" + server;

        Store.saveConfig(this, server, name);
        serverInput.setText(server);
        stopService(new Intent(this, MessageService.class));
        MessageService.status = "Conectando…";
        MessageService.start(this);

        configForm.setVisibility(View.GONE);
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(nameInput.getWindowToken(), 0);
        render();
    }

    /** Notificaciones para los avisos y cámara para verla en vivo desde el panel. */
    private void requestMissingPermissions() {
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
                && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.CAMERA);
        }
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), 1);
    }

    /** Abre el ajuste "Mostrar sobre otras apps"; al volver, onStart() oculta el botón si se concedió. */
    private void openOverlaySettings() {
        Uri app = Uri.parse("package:" + getPackageName());
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, app));
        } catch (ActivityNotFoundException e) {
            // Algunos Android TV no tienen esa pantalla: abrir la ficha de la app
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app));
        }
    }

    /** Desde Android 15 la app dibuja detrás de las barras del sistema; esto deja el contenido visible. */
    private static void applySystemBarInsets(View root) {
        if (Build.VERSION.SDK_INT < 30) return;
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
    }
}
