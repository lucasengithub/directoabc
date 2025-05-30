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

joinButton.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (!roomId) return;

    try {
        // Check browser support and log browser info
        console.log('Browser:', navigator.userAgent);
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.log('MediaDevices:', navigator.mediaDevices);
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
        } else if (error.name === 'NotReadableError') {
            statusDisplay.textContent = 'Unable to capture the screen. This device may not be compatible, try with other.';
        } else if (error.name === 'NotFoundError') {
            statusDisplay.textContent = 'No screen sharing device found';
        } else {
            statusDisplay.textContent = `Screen sharing error: ${error.message}`;
        }
    }
});

socket.on('joined-room', async (hostId) => {
    try {
        statusDisplay.textContent = 'Room joined. Setting up connection...';

        // Use the previously stored stream
        const stream = window.streamForPeerConnection;
        if (!stream) {
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

        // Configurar buffer mínimo para reducir latencia
        if (transceiver.sender && transceiver.sender.getParameters) {
            try {
                const parameters = transceiver.sender.getParameters();
                if (parameters.encodings && parameters.encodings.length > 0) {
                    // Crear un nuevo objeto de parámetros para evitar modificar el original directamente
                    const newParameters = {
                        encodings: parameters.encodings.map(encoding => ({ ...encoding }))
                    };

                    // Verificar si la propiedad es modificable antes de cambiarla
                    if ('networkPriority' in newParameters.encodings[0]) {
                        newParameters.encodings[0].networkPriority = 'very-high';
                        // Intentar establecer los nuevos parámetros
                        transceiver.sender.setParameters(newParameters)
                            .catch(e => console.error('Error al configurar parámetros:', e));
                    } else {
                        console.log('La propiedad networkPriority no está disponible o no es modificable en este navegador');
                    }
                }
            } catch (error) {
                console.error('Error al acceder o configurar parámetros del transceiver:', error);
            }
        }

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

        // Handle stream end
        stream.getVideoTracks()[0].onended = () => {
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            statusDisplay.textContent = 'Screen sharing ended';
        };
    } catch (error) {
        if (error.name === 'NotAllowedError') {
            statusDisplay.textContent = 'Screen share permission denied';
        } else {
            statusDisplay.textContent = 'Error starting screen share';
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
    }
});

socket.on('ice-candidate', async (data) => {
    try {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
    }
});

document.addEventListener('visibilitychange', () => {
    const remoteVideoElement = document.getElementById('remoteVideo');
    if (document.visibilityState === 'visible' && remoteVideoElement && remoteVideoElement.srcObject) {
        remoteVideoElement.play().catch(error => console.error("Error reactivando remoteVideo:", error));
    }
});
