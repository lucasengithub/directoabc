const socket = io();
const remoteVideo = document.getElementById('remoteVideo');
const roomCodeDisplay = document.getElementById('roomCode');
const loadingVideo = document.getElementById('loadingVideo');
const remSection = document.getElementById('rem');
const fullscreenButton = document.getElementById('fullscreenButton');
const currentInstance = document.getElementById('currentInstance');
let peerConnection;
let currentViewerId = null;
let reconnectionAttempts = 0;
const MAX_RECONNECTION_ATTEMPTS = 3;
let reconnectionTimeout = null;

// Request a room code when page loads
socket.emit('create-room');

// Configure WebRTC with multiple STUN/TURN servers for better connectivity
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'stun:stun.stunprotocol.org:3478' },
        // Servidor TURN público gratuito (limitado)
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all' // Permite tanto relay como direct
};

// Función para mostrar notificaciones con Toastify
function showToast(message, type = 'info') {
    const config = {
        text: message,
        duration: 3000,
        gravity: "top",
        position: "right",
        stopOnFocus: true,
        style: {}
    };

    switch (type) {
        case 'success':
            config.style.background = "linear-gradient(to right, #00b09b, #96c93d)";
            break;
        case 'error':
            config.style.background = "linear-gradient(to right, #ff5f6d, #ffc371)";
            config.duration = 5000;
            break;
        case 'warning':
            config.style.background = "linear-gradient(to right, #f093fb, #f5576c)";
            break;
        case 'info':
        default:
            config.style.background = "linear-gradient(to right, #667eea, #764ba2)";
            break;
    }

    Toastify(config).showToast();
}

// Función para entrar/salir de pantalla completa
function toggleFullScreen() {
    if (!document.fullscreenElement) {
        // Entrar en pantalla completa
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) { /* Safari */
            document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.msRequestFullscreen) { /* IE11 */
            document.documentElement.msRequestFullscreen();
        }
    } else {
        // Salir de pantalla completa
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) { /* Safari */
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) { /* IE11 */
            document.msExitFullscreen();
        }
    }
}

// Función de diagnóstico de conectividad
function diagnoseConnectivity() {
    console.log("=== DIAGNÓSTICO DE CONECTIVIDAD ===");
    console.log("Browser:", navigator.userAgent);
    console.log("Platform:", navigator.platform);
    console.log("WebRTC support:", {
        RTCPeerConnection: !!window.RTCPeerConnection,
        getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
    });
    
    if (peerConnection) {
        console.log("PeerConnection state:", {
            connectionState: peerConnection.connectionState,
            iceConnectionState: peerConnection.iceConnectionState,
            iceGatheringState: peerConnection.iceGatheringState,
            signalingState: peerConnection.signalingState
        });
        
        // Mostrar estadísticas si está disponible
        if (peerConnection.getStats) {
            peerConnection.getStats().then(stats => {
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        console.log("Successful candidate pair:", report);
                    }
                });
            }).catch(err => console.warn("No se pudieron obtener estadísticas:", err));
        }
    }
    
    console.log("Network info:", {
        online: navigator.onLine,
        connection: navigator.connection ? {
            effectiveType: navigator.connection.effectiveType,
            downlink: navigator.connection.downlink,
            rtt: navigator.connection.rtt
        } : 'No disponible'
    });
    console.log("=== FIN DIAGNÓSTICO ===");
}

// Función para limpiar la conexión actual
function cleanupConnection() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onicegatheringstatechange = null;
        
        // Cerrar todas las conexiones
        peerConnection.getSenders().forEach(sender => {
            if (sender.track) {
                sender.track.stop();
            }
        });
        
        peerConnection.close();
        peerConnection = null;
    }
    
    // Limpiar timeout de reconexión
    if (reconnectionTimeout) {
        clearTimeout(reconnectionTimeout);
        reconnectionTimeout = null;
    }
}

// Función para reintentar conexión
function attemptReconnection() {
    if (reconnectionAttempts >= MAX_RECONNECTION_ATTEMPTS) {
        showToast('Máximo de reintentos alcanzado. Recarga la página.', 'error');
        return;
    }
    
    reconnectionAttempts++;
    showToast(`Reintentando conexión (${reconnectionAttempts}/${MAX_RECONNECTION_ATTEMPTS})...`, 'warning');
    
    // Limpiar conexión actual
    cleanupConnection();
    
    // Esperar un poco antes de reintentar
    reconnectionTimeout = setTimeout(() => {
        if (currentViewerId) {
            console.log(`Reintento ${reconnectionAttempts}: Creando nueva conexión`);
            createPeerConnection(currentViewerId);
        }
    }, 2000 + (reconnectionAttempts * 1000)); // Incrementar delay con cada intento
}

// Función para crear conexión peer
async function createPeerConnection(viewerId) {
    try {
        currentViewerId = viewerId;
        
        // Create peer connection con configuración mejorada
        peerConnection = new RTCPeerConnection({
            ...rtcConfig,
            // Configuraciones adicionales para mejor conectividad
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceTransportPolicy: 'all'
        });

        // Configurar timeouts más agresivos
        let iceGatheringTimer = setTimeout(() => {
            if (peerConnection && peerConnection.iceGatheringState !== 'complete') {
                console.warn('ICE gathering tomando mucho tiempo, forzando complete');
            }
        }, 10000); // 10 segundos

        // Enhanced error handling and logging
        peerConnection.onicegatheringstatechange = () => {
            console.log("ICE gathering state:", peerConnection.iceGatheringState);
            if (peerConnection.iceGatheringState === 'complete') {
                clearTimeout(iceGatheringTimer);
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log("ICE connection state:", peerConnection.iceConnectionState);
            
            switch (peerConnection.iceConnectionState) {
                case 'checking':
                    showToast('Verificando conectividad...', 'info');
                    break;
                case 'connected':
                    showToast('ICE conectado correctamente', 'success');
                    reconnectionAttempts = 0; // Reset counter on success
                    break;
                case 'disconnected':
                    showToast('ICE desconectado, reintentando...', 'warning');
                    // Dar un poco de tiempo para reconectar automáticamente
                    setTimeout(() => {
                        if (peerConnection && peerConnection.iceConnectionState === 'disconnected') {
                            console.log('ICE sigue desconectado después de timeout, reintentando...');
                            attemptReconnection();
                        }
                    }, 5000);
                    break;
                case 'failed':
                    showToast('Conexión ICE falló. Reintentando...', 'error');
                    console.error('ICE connection failed. Attempting reconnection...');
                    attemptReconnection();
                    break;
                case 'closed':
                    showToast('Conexión ICE cerrada', 'info');
                    break;
            }
        };

        // Handle incoming tracks con optimización para mostrar el video más rápido
        peerConnection.ontrack = (event) => {
            console.log("Stream recibido:", event.streams[0]);
            console.log("Tracks en el stream:", event.streams[0].getTracks().map(t => ({
                kind: t.kind,
                enabled: t.enabled,
                readyState: t.readyState
            })));
            
            // Preparar el video antes de que lleguen los metadatos
            remoteVideo.style.zIndex = "0"; // Aumentar z-index para que sea visible
            remoteVideo.style.opacity = "0.3"; // Iniciar con opacidad baja para transición suave
            remoteVideo.classList.remove('hidden');
            remoteVideo.muted = true; // Permitir autoplay sin interacción
            
            // Asignar el stream inmediatamente
            remoteVideo.srcObject = event.streams[0];
            
            // Configurar para reproducción de baja latencia
            remoteVideo.playsInline = true;
            remoteVideo.autoplay = true;
            
            // Iniciar reproducción lo antes posible
            const playPromise = remoteVideo.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log("Video iniciado correctamente");
                }).catch(error => {
                    console.error("Error al reproducir remoteVideo:", error);
                    showToast('Error reproduciendo video. Haga clic para reproducir.', 'warning');
                    // Intentar reproducir nuevamente con interacción del usuario
                    remoteVideo.addEventListener('click', () => {
                        remoteVideo.play().catch(e => console.error("Error en click replay:", e));
                    }, { once: true });
                });
            }
        };

        // Handle and send ICE candidates with improved error handling
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("Enviando ICE candidate:", event.candidate.type, event.candidate.candidate);
                socket.emit('ice-candidate', {
                    target: viewerId,
                    candidate: event.candidate
                });
            } else {
                console.log("ICE gathering completado");
            }
        };

        // Handle connection state changes con transición mejorada y mejor debugging
        peerConnection.onconnectionstatechange = () => {
            console.log("connectionState:", peerConnection.connectionState);
            console.log("iceConnectionState:", peerConnection.iceConnectionState);
            console.log("iceGatheringState:", peerConnection.iceGatheringState);
            
            switch (peerConnection.connectionState) {
                case 'connecting':
                    showToast('Estableciendo conexión...', 'info');
                    break;
                case 'connected':
                    showToast('¡Conectado! Compartiendo pantalla', 'success');
                    // Transición más rápida y suave entre pantallas
                    remSection.style.transition = "opacity 0.5s ease-out";
                    remoteVideo.style.transition = "opacity 0.5s ease-in";
                    
                    // Asegurar que el video remoto ya está visible antes de ocultar la pantalla de espera
                    performTransition();
                    break;
                case 'disconnected':
                    showToast('Conexión interrumpida, reintentando...', 'warning');
                    console.warn('Conexión desconectada. Detalles:', {
                        connectionState: peerConnection.connectionState,
                        iceConnectionState: peerConnection.iceConnectionState,
                        iceGatheringState: peerConnection.iceGatheringState
                    });
                    break;
                case 'failed':
                    showToast('Conexión falló. Reintentando...', 'error');
                    console.error('Conexión falló. Detalles:', {
                        connectionState: peerConnection.connectionState,
                        iceConnectionState: peerConnection.iceConnectionState,
                        iceGatheringState: peerConnection.iceGatheringState
                    });
                    attemptReconnection();
                    break;
                case 'closed':
                    showToast('Conexión cerrada', 'info');
                    // Mostrar de nuevo la pantalla de espera
                    remSection.style.display = "flex";
                    remSection.style.opacity = "1";
                    remoteVideo.classList.add('hidden');
                    break;
            }
        };

        function performTransition() {
            // Esperar a que el video esté realmente reproduciendo
            const checkVideoReady = () => {
                if (remoteVideo.videoWidth > 0 && remoteVideo.videoHeight > 0 && !remoteVideo.paused) {
                    // Video listo, hacer transición
                    remSection.style.opacity = "0";
                    remoteVideo.style.opacity = "1";
                    
                    setTimeout(() => {
                        remSection.style.display = "none";
                        remoteVideo.style.zIndex = "1";
                    }, 500);
                } else {
                    // Reintentar en un momento
                    setTimeout(checkVideoReady, 100);
                }
            };
            
            checkVideoReady();
        }
        
    } catch (error) {
        console.error('Error creating peer connection:', error);
        showToast('Error al crear la conexión', 'error');
        attemptReconnection();
    }
}

// Exponer función de diagnóstico globalmente para debugging
window.diagnoseConnectivity = diagnoseConnectivity;

// Añadir evento al botón de pantalla completa
fullscreenButton.addEventListener('click', toggleFullScreen);

// Current Instance
document.addEventListener('DOMContentLoaded', () => {
    currentInstance.textContent = `${window.location.hostname}`;
});

// Display room code when received
socket.on('room-created', (roomId) => {
    roomCodeDisplay.textContent = `${roomId}`;
});

// Handle incoming viewer
socket.on('viewer-joined', async (viewerId) => {
    showToast('Alguien se está conectando...', 'info');
    await createPeerConnection(viewerId);
});

// Handle incoming WebRTC signaling with enhanced error handling
socket.on('offer', async (data) => {
    try {
        console.log("Recibida oferta SDP:", data.sdp);
        if (!peerConnection) {
            console.error("No hay peerConnection disponible para procesar la oferta");
            showToast('Error: Conexión no inicializada', 'error');
            return;
        }
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        console.log("Remote description establecida correctamente");
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log("Answer creada y local description establecida");
        
        socket.emit('answer', {
            target: data.sender,
            sdp: answer
        });
        console.log("Answer enviada al sender");
    } catch (error) {
        console.error('Error detallado al manejar oferta:', {
            name: error.name,
            message: error.message,
            stack: error.stack
        });
        showToast(`Error en la negociación WebRTC: ${error.message}`, 'error');
        attemptReconnection();
    }
});

socket.on('ice-candidate', async (data) => {
    try {
        if (!peerConnection) {
            console.warn("Recibido ICE candidate pero no hay peerConnection");
            return;
        }
        
        console.log("Procesando ICE candidate:", data.candidate);
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log("ICE candidate añadido correctamente");
    } catch (error) {
        console.error('Error detallado al añadir ICE candidate:', {
            name: error.name,
            message: error.message,
            candidate: data.candidate
        });
        showToast('Error procesando candidato ICE', 'warning');
    }
});

// Manejar desconexión del host
socket.on('host-disconnected', () => {
    showToast('El emisor se ha desconectado', 'warning');
    cleanupConnection();
    // Volver a mostrar la pantalla de espera
    remSection.style.display = "flex";
    remSection.style.opacity = "1";
    remoteVideo.classList.add('hidden');
});

// Limpiar al cerrar la página
window.addEventListener('beforeunload', () => {
    cleanupConnection();
});

// Manejar cambios de visibilidad de la página
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && remoteVideo && remoteVideo.srcObject) {
        remoteVideo.play().catch(error => console.error("Error reactivando remoteVideo:", error));
    }
});
