package com.pantallas.avisos;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Captura lo que muestra la pantalla. La captura queda activa aunque nadie la vea,
 * porque Android pide permiso de nuevo para cada captura que se inicia.
 */
final class ScreenStreamer {
    private static final int MAX_SIZE = 960;
    private static final int JPEG_QUALITY = 60;
    private static final long IDLE_COPY_INTERVAL_MS = 1000;

    private final MediaProjection projection;
    private final FrameSink sink;
    private final HandlerThread thread = new HandlerThread("Avisos-pantalla");
    private final Handler handler;
    private final ImageReader reader;
    private final VirtualDisplay display;
    private final int width;
    private final int height;

    /** Último cuadro, para mostrar algo apenas alguien empieza a ver aunque la pantalla no cambie. */
    private Bitmap last;
    private long lastCopyAt;
    private volatile boolean streaming;

    ScreenStreamer(Context context, MediaProjection projection, FrameSink sink, Runnable onStopped) {
        this.projection = projection;
        this.sink = sink;
        thread.start();
        handler = new Handler(thread.getLooper());

        DisplayMetrics metrics = new DisplayMetrics();
        context.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics);
        float scale = Math.min(1f, (float) MAX_SIZE / Math.max(metrics.widthPixels, metrics.heightPixels));
        width = Math.round(metrics.widthPixels * scale) & ~1;
        height = Math.round(metrics.heightPixels * scale) & ~1;
        int dpi = Math.max(1, Math.round(metrics.densityDpi * scale));

        // Android 14 exige registrar el callback antes de crear la pantalla virtual
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                onStopped.run();
            }
        }, handler);

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(r -> onImage(), handler);
        display = projection.createVirtualDisplay("Avisos", width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
    }

    void setStreaming(boolean value) {
        streaming = value;
        if (value) handler.post(() -> send(last));
    }

    void stop() {
        streaming = false;
        handler.post(() -> {
            display.release();
            reader.close();
            projection.stop();
            thread.quitSafely();
        });
    }

    private void onImage() {
        Image image;
        try {
            image = reader.acquireLatestImage();
        } catch (IllegalStateException e) {
            return;
        }
        if (image == null) return;

        long now = SystemClock.elapsedRealtime();
        boolean send = streaming && sink.wantsFrame();
        // Sin nadie mirando solo se guarda un cuadro por segundo
        if (!send && now - lastCopyAt < IDLE_COPY_INTERVAL_MS) {
            image.close();
            return;
        }
        lastCopyAt = now;
        copy(image);
        image.close();
        if (send) send(last);
    }

    private void copy(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        // Cada fila puede traer bytes de relleno al final
        int rowWidth = plane.getRowStride() / plane.getPixelStride();
        if (last == null || last.getWidth() != rowWidth) {
            last = Bitmap.createBitmap(rowWidth, height, Bitmap.Config.ARGB_8888);
        }
        last.copyPixelsFromBuffer(buffer);
    }

    private void send(Bitmap bitmap) {
        if (bitmap == null || !streaming) return;
        Bitmap frame = bitmap.getWidth() == width ? bitmap : Bitmap.createBitmap(bitmap, 0, 0, width, height);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
        if (frame != bitmap) frame.recycle();
        sink.onFrame(out.toByteArray(), 0);
    }
}
