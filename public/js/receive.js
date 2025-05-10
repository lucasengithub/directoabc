const socket = io();
const remoteVideo = document.getElementById('remoteVideo');
const roomCodeDisplay = document.getElementById('roomCode');
const loadingVideo = document.getElementById('loadingVideo');
const remSection = document.getElementById('rem');
const fullscreenButton = document.getElementById('fullscreenButton');
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

// Display room code when received
socket.on('room-created', (roomId) => {
    roomCodeDisplay.textContent = `${roomId}`;
});

// Handle incoming viewer
socket.on('viewer-joined', async (viewerId) => {
    try {
        // Create peer connection
        peerConnection = new RTCPeerConnection(rtcConfig);

        // Handle incoming tracks
        peerConnection.ontrack = (event) => {
            console.log("Stream recibido:", event.streams[0]);
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.muted = true; // Agrega mute para permitir autoplay sin interacción
            remoteVideo.addEventListener('loadedmetadata', () => {
                remoteVideo.play().catch(error => console.error("Error al reproducir remoteVideo:", error));
            });
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

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log("connectionState:", peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                // Hacer fade out de la sección "rem" y fade in de remoteVideo con transición de 1s
                remSection.style.transition = "opacity 1s ease-in-out";
                remoteVideo.style.transition = "opacity 1s ease-in-out";
                remSection.style.opacity = "0";
                remoteVideo.style.opacity = "1";
                remoteVideo.classList.remove('hidden');
                // Al finalizar la transición, ocultar la sección "rem" (opcional)
                setTimeout(() => {
                    remSection.classList.add('hidden');
                }, 1000);
                
            } else if (peerConnection.connectionState === 'disconnected') {
                // Al desconectar, revertir la transición:
                // Mostrar la sección "rem" y ocultar remoteVideo
                remSection.classList.remove('hidden');
                remSection.style.opacity = "1";
                remoteVideo.style.opacity = "0";
                remoteVideo.classList.add('hidden');
                remoteVideo.srcObject = null;
            }
        };
    } catch (error) {
        console.error('Error creating peer connection:', error);
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