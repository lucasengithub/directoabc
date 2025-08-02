const socket = io();
const joinForm = document.getElementById('joinForm');
const roomInput = document.getElementById('roomInput');
const joinButton = document.getElementById('joinButton');
const statusDisplay = document.getElementById('status');
let peerConnection;

// Configure WebRTC with STUN servers
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
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

        // Handle and send ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    target: hostId,
                    candidate: event.candidate
                });
            }
        };

        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', {
            target: hostId,
            sdp: offer
        });

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
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
    } catch (error) {
        console.error('Error handling answer:', error);
        showToast('Error en respuesta WebRTC', 'error');
    }
});

socket.on('ice-candidate', async (data) => {
    try {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
        showToast('Error procesando candidato ICE', 'warning');
    }
});

document.addEventListener('visibilitychange', () => {
    const remoteVideoElement = document.getElementById('remoteVideo');
    if (document.visibilityState === 'visible' && remoteVideoElement && remoteVideoElement.srcObject) {
        remoteVideoElement.play().catch(error => console.error("Error reactivando remoteVideo:", error));
    }
});
