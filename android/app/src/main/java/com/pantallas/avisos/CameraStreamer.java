package com.pantallas.avisos;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.hardware.display.DisplayManager;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Display;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** Transmite una cámara del dispositivo mientras alguien la está viendo desde el panel. */
final class CameraStreamer {
    private static final int MAX_WIDTH = 800;
    private static final int JPEG_QUALITY = 60;

    private final CameraManager manager;
    private final String cameraId;
    private final FrameSink sink;
    private final HandlerThread thread = new HandlerThread("Avisos-camara");
    private final Handler handler;
    private final int rotation;
    private final ImageReader reader;

    private CameraDevice camera;
    private CameraCaptureSession session;
    private volatile boolean stopped;

    /** Cámaras del dispositivo, para mostrar un botón por cada una en el panel. */
    static JSONArray list(Context context) {
        JSONArray list = new JSONArray();
        CameraManager manager = context.getSystemService(CameraManager.class);
        Map<String, Integer> seen = new HashMap<>();
        try {
            for (String id : manager.getCameraIdList()) {
                Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                String label = facing == null ? "Cámara"
                        : facing == CameraCharacteristics.LENS_FACING_FRONT ? "Cámara frontal"
                        : facing == CameraCharacteristics.LENS_FACING_BACK ? "Cámara trasera"
                        : "Cámara externa";
                int count = seen.merge(label, 1, Integer::sum);
                if (count > 1) label += " " + count;
                list.put(new JSONObject().put("id", id).put("label", label));
            }
        } catch (CameraAccessException | JSONException | RuntimeException e) {
            Log.w("Avisos", "No se pudieron listar las cámaras", e);
        }
        return list;
    }

    CameraStreamer(Context context, String cameraId, FrameSink sink) throws CameraAccessException {
        this.manager = context.getSystemService(CameraManager.class);
        this.cameraId = cameraId;
        this.sink = sink;

        CameraCharacteristics chars = manager.getCameraCharacteristics(cameraId);
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size size = pickSize(map.getOutputSizes(ImageFormat.YUV_420_888));
        rotation = frameRotation(context, chars);

        thread.start();
        handler = new Handler(thread.getLooper());
        reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
        reader.setOnImageAvailableListener(r -> onImage(), handler);
    }

    /** Abre la cámara. Requiere el permiso CAMERA y que el servicio tenga el tipo "camera". */
    void start() throws CameraAccessException {
        manager.openCamera(cameraId, new CameraDevice.StateCallback() {
            @Override
            public void onOpened(CameraDevice device) {
                if (stopped) {
                    device.close();
                    return;
                }
                camera = device;
                startSession();
            }

            @Override
            public void onDisconnected(CameraDevice device) {
                device.close();
                if (!stopped) sink.onStatus("Otra app empezó a usar la cámara");
            }

            @Override
            public void onError(CameraDevice device, int error) {
                device.close();
                if (!stopped) sink.onStatus("No se pudo abrir la cámara. Abre la app Avisos en la pantalla e inténtalo de nuevo.");
            }
        }, handler);
    }

    void stop() {
        stopped = true;
        handler.post(() -> {
            if (session != null) session.close();
            if (camera != null) camera.close();
            reader.close();
            thread.quitSafely();
        });
    }

    @SuppressWarnings("deprecation") // la alternativa con SessionConfiguration no existe en Android 8
    private void startSession() {
        try {
            camera.createCaptureSession(Collections.singletonList(reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession s) {
                    if (stopped) return;
                    session = s;
                    try {
                        CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        request.addTarget(reader.getSurface());
                        s.setRepeatingRequest(request.build(), null, handler);
                    } catch (CameraAccessException | IllegalStateException e) {
                        sink.onStatus("No se pudo iniciar la cámara");
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession s) {
                    sink.onStatus("No se pudo iniciar la cámara");
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException e) {
            sink.onStatus("No se pudo iniciar la cámara");
        }
    }

    private void onImage() {
        Image image;
        try {
            image = reader.acquireLatestImage();
        } catch (IllegalStateException e) {
            return;
        }
        if (image == null) return;
        if (stopped || !sink.wantsFrame()) {
            image.close();
            return;
        }
        int w = image.getWidth();
        int h = image.getHeight();
        byte[] nv21 = toNv21(image);
        image.close();

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(new Rect(0, 0, w, h), JPEG_QUALITY, out);
        sink.onFrame(out.toByteArray(), rotation);
    }

    /** YUV_420_888 (con cualquier relleno entre filas o píxeles) a NV21, que es lo que comprime YuvImage. */
    private static byte[] toNv21(Image image) {
        int w = image.getWidth();
        int h = image.getHeight();
        byte[] out = new byte[w * h * 3 / 2];
        Image.Plane[] planes = image.getPlanes();

        ByteBuffer y = planes[0].getBuffer();
        int yRow = planes[0].getRowStride();
        int yPixel = planes[0].getPixelStride();
        int pos = 0;
        for (int row = 0; row < h; row++) {
            if (yPixel == 1) {
                y.position(row * yRow);
                y.get(out, pos, w);
                pos += w;
            } else {
                for (int col = 0; col < w; col++) out[pos++] = y.get(row * yRow + col * yPixel);
            }
        }

        ByteBuffer u = planes[1].getBuffer();
        ByteBuffer v = planes[2].getBuffer();
        int uvRow = planes[1].getRowStride();
        int uvPixel = planes[1].getPixelStride();
        for (int row = 0; row < h / 2; row++) {
            for (int col = 0; col < w / 2; col++) {
                int i = row * uvRow + col * uvPixel;
                out[pos++] = v.get(i);
                out[pos++] = u.get(i);
            }
        }
        return out;
    }

    /** El tamaño más grande que no pase de MAX_WIDTH, para no saturar la red. */
    private static Size pickSize(Size[] sizes) {
        Size best = null;
        Size smallest = sizes[0];
        for (Size s : sizes) {
            if (s.getWidth() * s.getHeight() < smallest.getWidth() * smallest.getHeight()) smallest = s;
            if (s.getWidth() <= MAX_WIDTH && (best == null || s.getWidth() * s.getHeight() > best.getWidth() * best.getHeight())) best = s;
        }
        return best != null ? best : smallest;
    }

    /** Grados que hay que girar la imagen del sensor para verla como la ve quien está frente a la pantalla. */
    private static int frameRotation(Context context, CameraCharacteristics chars) {
        Integer sensorValue = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int sensor = sensorValue == null ? 0 : sensorValue;
        int device = context.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRotation() * 90;
        Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
        boolean front = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
        return front ? (sensor + device) % 360 : (sensor - device + 360) % 360;
    }
}
