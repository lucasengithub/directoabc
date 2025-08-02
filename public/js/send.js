const socket = io();
const joinForm = document.getElementById('joinForm');
const roomInput = document.getElementById('roomInput');
const joinButton = document.getElementById('joinButton');
const statusDisplay = document.getElementById('status');
let peerConnection;
let reconnectionAttempts = 0;
const MAX_RECONNECTION_ATTEMPTS = 3;
let reconnectionTimeout = null;
let currentHostId = null;

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

// Función de diagnóstico de conectividad
function diagnoseConnectivity() {
    console.log("=== DIAGNÓSTICO DE CONECTIVIDAD (SENDER) ===");
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
                    if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
                        console.log("Video outbound stats:", {
                            bytesSent: report.bytesSent,
                            packetsSent: report.packetsSent,
                            framesEncoded: report.framesEncoded
                        });
                    }
                });
            }).catch(err => console.warn("No se pudieron obtener estadísticas:", err));
        }
    }
    
    if (window.streamForPeerConnection) {
        console.log("Stream info:", {
            id: window.streamForPeerConnection.id,
            active: window.streamForPeerConnection.active,
            tracks: window.streamForPeerConnection.getTracks().map(track => ({
                kind: track.kind,
                enabled: track.enabled,
                readyState: track.readyState,
                settings: track.getSettings ? track.getSettings() : 'No disponible'
            }))
        });
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

// Exponer función de diagnóstico globalmente para debugging
window.diagnoseConnectivity = diagnoseConnectivity;

// Función para limpiar la conexión actual
function cleanupConnection() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
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
        statusDisplay.textContent = 'Connection failed. Please refresh the page.';
        return;
    }
    
    reconnectionAttempts++;
    showToast(`Reintentando conexión (${reconnectionAttempts}/${MAX_RECONNECTION_ATTEMPTS})...`, 'warning');
    statusDisplay.textContent = `Reconnecting... (${reconnectionAttempts}/${MAX_RECONNECTION_ATTEMPTS})`;
    
    // Limpiar conexión actual
    cleanupConnection();
    
    // Esperar un poco antes de reintentar
    reconnectionTimeout = setTimeout(() => {
        if (currentHostId && window.streamForPeerConnection) {
            console.log(`Reintento ${reconnectionAttempts}: Creando nueva conexión`);
            createPeerConnectionForSender(currentHostId);
        }
    }, 2000 + (reconnectionAttempts * 1000)); // Incrementar delay con cada intento
}

// Función para crear la conexión peer en el sender
async function createPeerConnectionForSender(hostId) {
    try {
        currentHostId = hostId;
        
        // Use the previously stored stream
        const stream = window.streamForPeerConnection;
        if (!stream) {
            showToast('Error: No hay stream disponible', 'error');
            throw new Error('No stream available');
        }

        // Create peer connection with optimized low-latency settings
        peerConnection = new RTCPeerConnection({
            ...rtcConfig,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });

        // Enhanced connection state monitoring
        peerConnection.onconnectionstatechange = () => {
            console.log("Connection state:", peerConnection.connectionState);
            console.log("ICE connection state:", peerConnection.iceConnectionState);
            
            switch (peerConnection.connectionState) {
                case 'connecting':
                    statusDisplay.textContent = 'Connecting to receiver...';
                    showToast('Conectando al receptor...', 'info');
                    break;
                case 'connected':
                    statusDisplay.textContent = 'Screen sharing started';
                    showToast('¡Pantalla compartida exitosamente!', 'success');
                    reconnectionAttempts = 0; // Reset counter on success
                    break;
                case 'disconnected':
                    statusDisplay.textContent = 'Connection interrupted, reconnecting...';
                    showToast('Conexión interrumpida, reintentando...', 'warning');
                    // Dar tiempo para reconectar automáticamente
                    setTimeout(() => {
                        if (peerConnection && peerConnection.connectionState === 'disconnected') {
                            console.log('Conexión sigue desconectada, reintentando...');
                            attemptReconnection();
                        }
                    }, 5000);
                    break;
                case 'failed':
                    statusDisplay.textContent = 'Connection failed, retrying...';
                    showToast('Conexión falló. Reintentando...', 'error');
                    console.error('Connection failed. Attempting reconnection...');
                    attemptReconnection();
                    break;
                case 'closed':
                    statusDisplay.textContent = 'Connection closed';
                    showToast('Conexión cerrada', 'info');
                    break;
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log("ICE connection state changed:", peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                console.error('ICE connection failed in sender');
                showToast('Conexión ICE falló. Reintentando...', 'error');
                attemptReconnection();
            }
        };

        // Enable low-latency optimization
        const transceiver = peerConnection.addTransceiver(stream.getVideoTracks()[0], {
            direction: 'sendonly',
            streams: [stream],
            sendEncodings: [
                {
                    // Configuración optimizada para baja latencia
                    maxBitrate: 3000000, // 3 Mbps para equilibrar calidad y velocidad
                    maxFramerate: 30,     // Limitar a 30fps para reducir carga
                    priority: 'high',
                    networkPriority: 'high',
                    adaptivePtime: true,
                    scaleResolutionDownBy: 1.0, // No escalar inicialmente
                    degradationPreference: 'balanced' // Equilibrio entre framerate y resolución
                }
            ]
        });

        console.log('Transceiver configurado con optimizaciones de baja latencia');

        // Add audio track if available
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
            peerConnection.addTrack(audioTracks[0], stream);
        }

        // Handle and send ICE candidates with enhanced logging
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("Enviando ICE candidate desde sender:", event.candidate.type, event.candidate.candidate);
                socket.emit('ice-candidate', {
                    target: hostId,
                    candidate: event.candidate
                });
            } else {
                console.log("ICE gathering completado en sender");
            }
        };

        // Create and send offer with enhanced error handling
        console.log("Creando oferta WebRTC...");
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        await peerConnection.setLocalDescription(offer);
        console.log("Oferta creada y local description establecida");
        
        socket.emit('offer', {
            target: hostId,
            sdp: offer
        });
        console.log("Oferta enviada al receptor");

        // Handle stream end
        stream.getVideoTracks()[0].onended = () => {
            console.log("Stream ended, cleaning up...");
            cleanupConnection();
            statusDisplay.textContent = 'Screen sharing ended';
            showToast('Compartir pantalla terminado', 'info');
        };
        
    } catch (error) {
        console.error('Error creating peer connection in sender:', error);
        showToast('Error al crear la conexión', 'error');
        statusDisplay.textContent = 'Error creating connection';
        attemptReconnection();
    }
}

joinButton.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (!roomId) {
        showToast('Por favor ingresa un código de sala', 'warning');
        return;
    }

    try {
        // Check browser support and log browser info
        console.log('Browser:', navigator.userAgent);
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.log('MediaDevices:', navigator.mediaDevices);
            showToast('API de compartir pantalla no disponible', 'error');
            throw new Error('Screen sharing API not available');
        }

        // Request screen share with standard settings
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always",
                frameRate: {
                    ideal: 30
                },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        });
        
        // Optimizar pistas de video
        stream.getVideoTracks().forEach(track => {
            if (track.getConstraints && track.applyConstraints) {
                track.applyConstraints({
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }).catch(e => console.warn('No se pudieron aplicar restricciones:', e));
            }
        });

        // After getting stream, join the room
        socket.emit('join-room', roomId);
        statusDisplay.textContent = 'Connecting...';
        showToast('Conectando a la sala...', 'info');

        // Store stream for later use
        window.streamForPeerConnection = stream;

    } catch (error) {
        console.log('Detailed error:', {
            name: error.name,
            message: error.message,
            stack: error.stack
        });

        if (error.name === 'NotAllowedError') {
            statusDisplay.textContent = 'Please allow screen sharing when prompted';
            showToast('Permiso de pantalla denegado', 'error');
        } else if (error.name === 'NotReadableError') {
            statusDisplay.textContent = 'Unable to capture the screen. This device may not be compatible, try with other.';
            showToast('Error de captura: dispositivo incompatible', 'error');
        } else if (error.name === 'NotFoundError') {
            statusDisplay.textContent = 'No screen sharing device found';
            showToast('No se encontró dispositivo de captura', 'error');
        } else {
            statusDisplay.textContent = `Screen sharing error: ${error.message}`;
            showToast(`Error: ${error.message}`, 'error');
        }
    }
});

// Handle room not found
socket.on('room-not-found', () => {
    showToast('Sala no encontrada. Verifica el código.', 'error');
    statusDisplay.textContent = 'Room not found';
});

socket.on('joined-room', async (hostId) => {
    try {
        statusDisplay.textContent = 'Room joined. Setting up connection...';
        showToast('¡Sala encontrada! Configurando conexión...', 'success');

        // Use the previously stored stream
        const stream = window.streamForPeerConnection;
        if (!stream) {
            showToast('Error: No hay stream disponible', 'error');
            throw new Error('No stream available');
        }

        // Create peer connection with optimized low-latency settings
        peerConnection = new RTCPeerConnection({
            ...rtcConfig,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });

        // Enhanced connection state monitoring
        peerConnection.onconnectionstatechange = () => {
            console.log("Connection state:", peerConnection.connectionState);
            console.log("ICE connection state:", peerConnection.iceConnectionState);
            
            switch (peerConnection.connectionState) {
                case 'connecting':
                    statusDisplay.textContent = 'Conectando...';
                    showToast('Estableciendo conexión P2P...', 'info');
                    break;
                case 'connected':
                    statusDisplay.textContent = 'Conectado - Transmitiendo';
                    showToast('¡Conexión establecida! Transmitiendo pantalla', 'success');
                    break;
                case 'disconnected':
                    statusDisplay.textContent = 'Desconectado';
                    showToast('Conexión perdida', 'warning');
                    break;
                case 'failed':
                    statusDisplay.textContent = 'Error de conexión';
                    showToast('Error de conexión. Verifique su red.', 'error');
                    console.error('Connection failed details:', {
                        connectionState: peerConnection.connectionState,
                        iceConnectionState: peerConnection.iceConnectionState
                    });
                    break;
                case 'closed':
                    statusDisplay.textContent = 'Conexión cerrada';
                    break;
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log("ICE connection state changed:", peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                console.error('ICE connection failed in sender');
                showToast('Conexión ICE falló. Reintentando...', 'error');
                attemptReconnection();
            }
        };

        // Enable low-latency optimization
        const transceiver = peerConnection.addTransceiver(stream.getVideoTracks()[0], {
            direction: 'sendonly',
            streams: [stream],
            sendEncodings: [
                {
                    // Configuración optimizada para baja latencia
                    maxBitrate: 3000000, // 3 Mbps para equilibrar calidad y velocidad
                    maxFramerate: 30,     // Limitar a 30fps para reducir carga
                    priority: 'high',
                    networkPriority: 'high',
                    adaptivePtime: true,
                    scaleResolutionDownBy: 1.0, // No escalar inicialmente
                    degradationPreference: 'balanced' // Equilibrio entre framerate y resolución
                }
            ]
        });

        // Configuración adicional para optimización (opcional)
        // Nota: Removemos setParameters() ya que puede causar errores en algunos navegadores
        // La configuración en sendEncodings ya proporciona la optimización necesaria
        console.log('Transceiver configurado con optimizaciones de baja latencia');

        // Add audio track if available
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
            peerConnection.addTrack(audioTracks[0], stream);
        }

        // Handle and send ICE candidates with enhanced logging
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("Enviando ICE candidate:", event.candidate.type, event.candidate.candidate);
                socket.emit('ice-candidate', {
                    target: hostId,
                    candidate: event.candidate
                });
            } else {
                console.log("ICE gathering completado para sender");
            }
        };

        // Create and send offer with enhanced error handling
        console.log("Creando oferta WebRTC...");
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        await peerConnection.setLocalDescription(offer);
        console.log("Oferta creada y local description establecida");
        
        socket.emit('offer', {
            target: hostId,
            sdp: offer
        });
        console.log("Oferta enviada al receptor");

        statusDisplay.textContent = 'Screen sharing started';
        showToast('¡Pantalla compartida exitosamente!', 'success');

        // Handle stream end
        stream.getVideoTracks()[0].onended = () => {
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            statusDisplay.textContent = 'Screen sharing ended';
            showToast('Compartir pantalla terminado', 'info');
        };
    } catch (error) {
        if (error.name === 'NotAllowedError') {
            statusDisplay.textContent = 'Screen share permission denied';
            showToast('Permiso de pantalla denegado', 'error');
        } else {
            statusDisplay.textContent = 'Error starting screen share';
            showToast('Error al iniciar compartir pantalla', 'error');
            console.error('Error:', error);
        }
    }
});

socket.on('answer', async (data) => {
    try {
        console.log("Recibida respuesta del receptor:", data.sdp);
        if (peerConnection && peerConnection.signalingState !== 'closed') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            console.log("Remote description establecida en sender");
        } else {
            console.warn("No se puede procesar answer: peerConnection no disponible o cerrada");
        }
    } catch (error) {
        console.error('Error detallado al manejar answer:', {
            name: error.name,
            message: error.message,
            signalingState: peerConnection?.signalingState
        });
        showToast('Error en respuesta WebRTC', 'error');
    }
});

socket.on('ice-candidate', async (data) => {
    try {
        if (peerConnection && peerConnection.signalingState !== 'closed') {
            console.log("Procesando ICE candidate en sender:", data.candidate);
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log("ICE candidate añadido en sender");
        } else {
            console.warn("No se puede añadir ICE candidate: peerConnection no disponible");
        }
    } catch (error) {
        console.error('Error detallado al añadir ICE candidate en sender:', {
            name: error.name,
            message: error.message,
            candidate: data.candidate
        });
        showToast('Error procesando candidato ICE', 'warning');
    }
});

document.addEventListener('visibilitychange', () => {
    const remoteVideoElement = document.getElementById('remoteVideo');
    if (document.visibilityState === 'visible' && remoteVideoElement && remoteVideoElement.srcObject) {
        remoteVideoElement.play().catch(error => console.error("Error reactivando remoteVideo:", error));
    }
});

// Limpiar al cerrar la página
window.addEventListener('beforeunload', () => {
    cleanupConnection();
    if (window.streamForPeerConnection) {
        window.streamForPeerConnection.getTracks().forEach(track => track.stop());
    }
});

// Manejar desconexión de la sala
socket.on('room-not-found', () => {
    showToast('Sala no encontrada. Verifica el código.', 'error');
    statusDisplay.textContent = 'Room not found';
    cleanupConnection();
});
