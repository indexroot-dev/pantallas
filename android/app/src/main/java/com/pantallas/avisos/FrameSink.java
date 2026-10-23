package com.pantallas.avisos;

/** Destino de los cuadros de la transmisión en vivo. */
interface FrameSink {
    /** Si conviene mandar un cuadro ahora; si no, se descarta sin comprimirlo. */
    boolean wantsFrame();

    /** Cuadro JPEG y los grados que hay que girarlo para verlo derecho. */
    void onFrame(byte[] jpeg, int rotation);

    /** Mensaje para mostrar en el panel (esperando, error, etc.). */
    void onStatus(String text);
}
