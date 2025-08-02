const socket = io();
const remoteVideo = document.getElementById('remoteVideo');
const roomCodeDisplay = document.getElementById('roomCode');
const loadingVideo = document.getElementById('loadingVideo');
const remSection = document.getElementById('rem');
const fullscreenButton = document.getElementById('fullscreenButton');
const currentInstance = document.getElementById('currentInstance');
let peerConnection;

// Request a room code when page loads
socket.emit('create-room');

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

// Añadir evento al botón de pantalla completa
fullscreenButton.addEventListener('click', toggleFullScreen);

// CUrrenr Instance

document.addEventListener('DOMContentLoaded', () => {
    currentInstance.textContent = `${window.location.hostname}`;
})

// Display room code when received
socket.on('room-created', (roomId) => {
    roomCodeDisplay.textContent = `${roomId}`;
});

// Handle incoming viewer
socket.on('viewer-joined', async (viewerId) => {
    showToast('Alguien se está conectando...', 'info');
    try {
        // Create peer connection
        peerConnection = new RTCPeerConnection(rtcConfig);

        // Handle incoming tracks con optimización para mostrar el video más rápido
        peerConnection.ontrack = (event) => {
            console.log("Stream recibido:", event.streams[0]);
            
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
                playPromise.catch(error => {
                    console.error("Error al reproducir remoteVideo:", error);
                    // Intentar reproducir nuevamente con interacción del usuario
                    remoteVideo.addEventListener('click', () => remoteVideo.play());
                });
            }
        };

        // Handle and send ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    target: viewerId,
                    candidate: event.candidate
                });
            }
        };

        // Handle connection state changes con transición mejorada
        peerConnection.onconnectionstatechange = () => {
            console.log("connectionState:", peerConnection.connectionState);
            
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
                    if (remoteVideo.readyState >= 2) { // HAVE_CURRENT_DATA o superior
                        // Transición inmediata si ya tenemos datos de video
                        performTransition();
                    } else {
                        // Esperar a tener suficientes datos de video antes de la transición
                        remoteVideo.addEventListener('canplay', performTransition, { once: true });
                        
                        // Timeout de seguridad por si el evento canplay no se dispara
                        setTimeout(performTransition, 300);
                    }
                    break;
                case 'disconnected':
                    showToast('Conexión perdida', 'warning');
                    // Al desconectar, revertir la transición más rápidamente
                    remSection.classList.remove('hidden');
                    remSection.style.transition = "opacity 0.3s ease-in";
                    remoteVideo.style.transition = "opacity 0.3s ease-out";
                    remSection.style.opacity = "1";
                    remoteVideo.style.opacity = "0";
                    
                    // Limpiar el video más rápido
                    setTimeout(() => {
                        remoteVideo.classList.add('hidden');
                        remoteVideo.srcObject = null;
                    }, 300);
                    break;
                case 'failed':
                    showToast('Error en la conexión', 'error');
                    break;
                case 'closed':
                    showToast('Conexión cerrada', 'info');
                    break;
            }
            
            if (peerConnection.connectionState === 'connected') {
                function performTransition() {
                    // Hacer la transición más rápida
                    remSection.style.opacity = "0";
                    remoteVideo.style.opacity = "1";
                    
                    // Ocultar la sección de espera más rápido
                    setTimeout(() => {
                        remSection.classList.add('hidden');
                    }, 500);
                }
            }
        };
    } catch (error) {
        console.error('Error creating peer connection:', error);
        showToast('Error al crear la conexión', 'error');
    }
});

// Handle incoming WebRTC signaling
socket.on('offer', async (data) => {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', {
            target: data.sender,
            sdp: answer
        });
    } catch (error) {
        console.error('Error handling offer:', error);
        showToast('Error en la negociación WebRTC', 'error');
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