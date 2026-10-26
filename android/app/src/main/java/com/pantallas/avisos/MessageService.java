package com.pantallas.avisos;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.UiModeManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.hardware.camera2.CameraAccessException;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.projection.MediaProjection;
import android.net.Uri;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.URISyntaxException;

import io.socket.client.IO;
import io.socket.client.Socket;

/**
 * Servicio en primer plano que mantiene la conexión con el servidor, muestra
 * cada aviso como una notificación con el botón "Entendido" y transmite en vivo
 * la pantalla o una cámara cuando alguien la mira desde el panel.
 */
public class MessageService extends Service {
    static final String ACTION_ACK = "com.pantallas.avisos.ACK";
    static final String ACTION_CHANGED = "com.pantallas.avisos.CHANGED";
    static final String ACTION_PROJECTION = "com.pantallas.avisos.PROJECTION";
    static final String EXTRA_ID = "id";
    private static final String EXTRA_RESULT_CODE = "resultCode";
    private static final String EXTRA_RESULT_DATA = "resultData";

    private static final String OLD_CHANNEL_MESSAGES = "avisos";
    private static final String CHANNEL_MESSAGES = "avisos_sonido";
    private static final String CHANNEL_CONNECTION = "conexion";
    private static final int CONNECTION_NOTIFICATION_ID = 1;

    // Unos 8 cuadros por segundo como máximo; si la red va lenta, se espera la confirmación del servidor
    private static final long FRAME_INTERVAL_MS = 120;
    private static final long FRAME_ACK_TIMEOUT_MS = 3000;

    /** Estado de la conexión que muestra la pantalla principal. */
    static volatile String status = "Desconectado";

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Socket socket;
    private NotificationManager notifications;
    /** Android TV: no muestra las notificaciones, así que el aviso se presenta abriendo la app. */
    private boolean tv;

    /** Captura de pantalla; sigue activa entre transmisiones para no pedir permiso cada vez. */
    private ScreenStreamer screen;
    private CameraStreamer camera;
    /** Si el panel pidió ver la pantalla (puede estar esperando el permiso). */
    private boolean screenRequested;
    /** Qué se está transmitiendo ("la pantalla", "la cámara") o null; se muestra en la notificación. */
    private String liveLabel;
    private volatile boolean frameInFlight;
    private volatile long frameSentAt;

    static void start(Context context) {
        context.startForegroundService(new Intent(context, MessageService.class));
    }

    static Intent ackIntent(Context context, String id) {
        return new Intent(context, MessageService.class).setAction(ACTION_ACK).putExtra(EXTRA_ID, id);
    }

    static Intent projectionIntent(Context context, int resultCode, Intent data) {
        return new Intent(context, MessageService.class).setAction(ACTION_PROJECTION)
                .putExtra(EXTRA_RESULT_CODE, resultCode).putExtra(EXTRA_RESULT_DATA, data);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = getSystemService(NotificationManager.class);
        tv = getSystemService(UiModeManager.class).getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        createChannels();
        status = "Conectando…";
        updateForeground(false, false);
        connect();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_ACK.equals(intent.getAction())) {
            acknowledge(intent.getStringExtra(EXTRA_ID));
        } else if (intent != null && ACTION_PROJECTION.equals(intent.getAction())) {
            onProjectionResult(intent);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopLive();
        if (screen != null) {
            ScreenStreamer old = screen;
            screen = null;
            old.stop();
        }
        if (socket != null) {
            socket.off();
            socket.disconnect();
        }
        status = "Desconectado";
        broadcastChanged();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Conexión ----------

    private void connect() {
        String server = Store.server(this);
        String name = Store.name(this);
        if (server.isEmpty() || name.isEmpty()) {
            stopSelf();
            return;
        }

        try {
            IO.Options options = new IO.Options();
            options.reconnectionDelayMax = 10_000;
            socket = IO.socket(server, options);
        } catch (URISyntaxException e) {
            setStatus("Dirección inválida: " + server);
            return;
        }

        socket.on(Socket.EVENT_CONNECT, args -> {
            frameInFlight = false;
            setStatus("Conectado como " + name);
            socket.emit("device:join", joinData(name));
        });
        socket.on(Socket.EVENT_DISCONNECT, args -> {
            boolean replaced = args.length > 0 && "io server disconnect".equals(args[0]);
            setStatus(replaced ? "Otra pantalla se conectó con el nombre " + name : "Sin conexión, reintentando…");
            // Al reconectar, el servidor vuelve a pedir la transmisión si alguien la sigue mirando
            main.post(this::stopLive);
        });
        socket.on(Socket.EVENT_CONNECT_ERROR, args -> setStatus("No se puede conectar a " + server + ", reintentando…"));
        socket.on("notify", args -> onMessage((JSONObject) args[0]));
        socket.on("live:start", args -> {
            JSONObject request = (JSONObject) args[0];
            main.post(() -> startLive(request));
        });
        socket.on("live:stop", args -> main.post(this::stopLive));
        // "Tomar el control" en el panel: toques, teclas y texto
        socket.on("control", args -> {
            JSONObject command = (JSONObject) args[0];
            main.post(() -> {
                String problem = ControlService.run(command);
                if (problem != null) sink.onStatus(problem);
            });
        });
        socket.connect();
    }

    private JSONObject joinData(String name) {
        try {
            return new JSONObject().put("name", name).put("cameras", CameraStreamer.list(this));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void onMessage(JSONObject msg) {
        String id = msg.optString("id");
        if (id.isEmpty()) return;
        socket.emit("device:received", id);

        // Se confirmó sin conexión: avisarle al servidor y no volver a mostrarlo
        if (Store.isAcked(this, id)) {
            socket.emit("device:ack", id);
            return;
        }

        boolean isNew = Store.addPending(this, msg);
        showMessage(msg);
        broadcastChanged();
        // Las teles no muestran notificaciones ni las hacen sonar: suena desde la app y se abre encima de lo que se esté viendo
        if (isNew && tv) main.post(() -> {
            playSound();
            openApp();
        });
    }

    private void acknowledge(String id) {
        if (id == null) return;
        Store.markAcked(this, id);
        Store.removePending(this, id);
        notifications.cancel(notificationId(id));
        // Si no hay conexión, el servidor lo reenviará al reconectar y se confirmará en onMessage
        if (socket != null && socket.connected()) socket.emit("device:ack", id);
        broadcastChanged();
    }

    // ---------- En vivo ----------

    private final FrameSink sink = new FrameSink() {
        @Override
        public boolean wantsFrame() {
            Socket s = socket;
            if (s == null || !s.connected()) return false;
            long elapsed = SystemClock.elapsedRealtime() - frameSentAt;
            return elapsed >= (frameInFlight ? FRAME_ACK_TIMEOUT_MS : FRAME_INTERVAL_MS);
        }

        @Override
        public void onFrame(byte[] jpeg, int rotation) {
            Socket s = socket;
            if (s == null) return;
            frameInFlight = true;
            frameSentAt = SystemClock.elapsedRealtime();
            s.emit("device:frame", new Object[]{jpeg, rotation}, ackArgs -> frameInFlight = false);
        }

        @Override
        public void onStatus(String text) {
            Socket s = socket;
            if (s != null && s.connected()) s.emit("device:live-status", text);
        }
    };

    private void startLive(JSONObject request) {
        stopCamera();
        if ("screen".equals(request.optString("type"))) {
            startScreen();
        } else {
            screenRequested = false;
            if (screen != null) screen.setStreaming(false);
            startCamera(request.optString("camera"));
        }
    }

    private void stopLive() {
        screenRequested = false;
        if (screen != null) screen.setStreaming(false);
        stopCamera();
        setLive(null);
    }

    private void startScreen() {
        screenRequested = true;
        if (screen != null) {
            setLive("la pantalla");
            screen.setStreaming(true);
            return;
        }
        // Android pide permiso cada vez que empieza una captura de pantalla
        sink.onStatus("Esperando que alguien acepte compartir la pantalla en el dispositivo…");
        try {
            startActivity(new Intent(this, ScreenConsentActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            Log.w("Avisos", "No se pudo pedir permiso para capturar la pantalla", e);
            sink.onStatus("No se pudo pedir permiso para compartir la pantalla");
        }
    }

    @SuppressWarnings("deprecation") // getParcelableExtra con tipo no existe antes de Android 13
    private void onProjectionResult(Intent intent) {
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultCode != Activity.RESULT_OK || data == null) {
            sink.onStatus("En el dispositivo no aceptaron compartir la pantalla");
            return;
        }
        if (screen != null) return;

        try {
            // Desde Android 14 el servicio debe tener el tipo mediaProjection antes de obtener la captura
            updateForeground(camera != null, true);
            MediaProjection projection = getSystemService(MediaProjectionManager.class).getMediaProjection(resultCode, data);
            if (projection == null) throw new IllegalStateException("Sin captura de pantalla");
            screen = new ScreenStreamer(this, projection, sink, () -> main.post(this::onScreenStopped));
        } catch (RuntimeException e) {
            Log.w("Avisos", "No se pudo capturar la pantalla", e);
            screen = null;
            updateForegroundQuietly();
            sink.onStatus("No se pudo capturar la pantalla");
            return;
        }
        if (screenRequested) {
            setLive("la pantalla");
            screen.setStreaming(true);
        }
    }

    /** La captura terminó desde el dispositivo (botón "Dejar de compartir", bloqueo, etc.). */
    private void onScreenStopped() {
        ScreenStreamer old = screen;
        if (old == null) return;
        screen = null;
        old.stop();
        updateForegroundQuietly();
        if (screenRequested) {
            setLive(null);
            sink.onStatus("En el dispositivo se dejó de compartir la pantalla");
        }
    }

    private void startCamera(String id) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            sink.onStatus("La app no tiene permiso para usar la cámara. Ábrela en el dispositivo y acéptalo.");
            return;
        }
        try {
            updateForeground(true, screen != null);
            camera = new CameraStreamer(this, id, sink);
            camera.start();
            setLive("la cámara");
        } catch (CameraAccessException | RuntimeException e) {
            Log.w("Avisos", "No se pudo abrir la cámara " + id, e);
            stopCamera();
            sink.onStatus("Android no dejó usar la cámara. Abre la app Avisos en el dispositivo e inténtalo de nuevo.");
        }
    }

    private void stopCamera() {
        if (camera != null) {
            camera.stop();
            camera = null;
        }
        updateForegroundQuietly();
    }

    private void setLive(String label) {
        liveLabel = label;
        notifications.notify(CONNECTION_NOTIFICATION_ID, connectionNotification(status));
    }

    /** Los tipos del servicio en primer plano habilitan la cámara y la captura de pantalla. */
    private void updateForeground(boolean withCamera, boolean withScreen) {
        Notification notification = connectionNotification(status);
        if (Build.VERSION.SDK_INT >= 34) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING;
            if (withCamera) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (withScreen) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            startForeground(CONNECTION_NOTIFICATION_ID, notification, types);
        } else {
            startForeground(CONNECTION_NOTIFICATION_ID, notification);
        }
    }

    private void updateForegroundQuietly() {
        try {
            updateForeground(camera != null, screen != null);
        } catch (RuntimeException e) {
            Log.w("Avisos", "No se pudo actualizar el servicio en primer plano", e);
        }
    }

    // ---------- Notificaciones ----------

    private void createChannels() {
        // Android no deja cambiar el sonido de un canal ya creado: el anterior se reemplaza por uno nuevo
        notifications.deleteNotificationChannel(OLD_CHANNEL_MESSAGES);

        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, "Avisos", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Avisos que llegan desde el panel");
        messages.enableVibration(true);
        // En la tele suena desde playSound(); con el canal sonaría dos veces en las que sí lo reproducen
        messages.setSound(tv ? null : soundUri(), tv ? null : new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        messages.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel connection = new NotificationChannel(CHANNEL_CONNECTION, "Conexión", NotificationManager.IMPORTANCE_LOW);
        connection.setDescription("Estado de la conexión con el servidor");
        connection.setShowBadge(false);

        notifications.createNotificationChannel(messages);
        notifications.createNotificationChannel(connection);
    }

    private Uri soundUri() {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/" + R.raw.aviso);
    }

    /** En la tele el volumen que se usa es el de lo que se está viendo. */
    private void playSound() {
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        int session = getSystemService(AudioManager.class).generateAudioSessionId();
        MediaPlayer player = MediaPlayer.create(this, R.raw.aviso, attributes, session);
        if (player == null) {
            Log.w("Avisos", "No se pudo reproducir el sonido del aviso");
            return;
        }
        player.setOnCompletionListener(MediaPlayer::release);
        player.start();
    }

    /** Desde Android 10 abrirla en segundo plano requiere el permiso "Mostrar sobre otras apps". */
    private void openApp() {
        if (!BootReceiver.canOpenOnBoot(this)) return;
        try {
            startActivity(new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        } catch (RuntimeException e) {
            Log.w("Avisos", "No se pudo abrir la app para mostrar el aviso", e);
        }
    }

    private PendingIntent openAppIntent() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification connectionNotification(String text) {
        String live = liveLabel;
        return new Notification.Builder(this, CHANNEL_CONNECTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(live == null ? text : "Transmitiendo " + live + " al panel · " + text)
                .setContentIntent(openAppIntent())
                .setOngoing(true)
                .build();
    }

    private void showMessage(JSONObject msg) {
        String id = msg.optString("id");
        String text = msg.optString("text");

        PendingIntent ack = PendingIntent.getService(this, notificationId(id), ackIntent(this, id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Action ackAction = new Notification.Action.Builder(
                Icon.createWithResource(this, R.drawable.ic_check), "Entendido", ack).build();

        Notification notification = new Notification.Builder(this, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Aviso de " + msg.optString("from"))
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setWhen(msg.optLong("at", System.currentTimeMillis()))
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(openAppIntent())
                .addAction(ackAction)
                // Solo se cierra con "Entendido"
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .build();

        notifications.notify(notificationId(id), notification);
    }

    private static int notificationId(String messageId) {
        int id = messageId.hashCode();
        return id == CONNECTION_NOTIFICATION_ID ? id + 1 : id;
    }

    // ---------- Utilidades ----------

    private void setStatus(String text) {
        status = text;
        notifications.notify(CONNECTION_NOTIFICATION_ID, connectionNotification(text));
        broadcastChanged();
    }

    private void broadcastChanged() {
        sendBroadcast(new Intent(ACTION_CHANGED).setPackage(getPackageName()));
    }
}
