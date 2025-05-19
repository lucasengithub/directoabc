import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http, {
    cors: {
        origin: "*", // Be more specific in production
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// Serve static files from public directory
app.use(express.static('public'));

// Store active rooms
const rooms = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/send', (req, res) => {
    res.sendFile(__dirname + '/public/send.html');
});

app.get('/receive', (req, res) => {
    res.sendFile(__dirname + '/public/receive.html');
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle room creation
    socket.on('create-room', () => {
        const roomId = uuidv4().substring(0, 6); // Generate shorter room code
        rooms.set(roomId, { host: socket.id });
        socket.emit('room-created', roomId);
    });

    // Handle room joining
    socket.on('join-room', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            socket.join(roomId);
            socket.to(room.host).emit('viewer-joined', socket.id);
            socket.emit('joined-room', room.host);
        } else {
            socket.emit('room-not-found');
        }
    });

    // Handle WebRTC signaling
    socket.on('offer', (data) => {
        socket.to(data.target).emit('offer', {
            sdp: data.sdp,
            sender: socket.id
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.target).emit('answer', {
            sdp: data.sdp,
            sender: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Remove room if host disconnects
        for (const [roomId, room] of rooms.entries()) {
            if (room.host === socket.id) {
                rooms.delete(roomId);
                // Notify all clients in the room
                io.to(roomId).emit('host-disconnected');
                break;
            }
        }
        // Clean up any remaining references
        socket.removeAllListeners();
    });
});

const PORT = process.env.PORT || 2332;
http.listen(PORT, () => {
    console.log(`Server running on  http://localhost:${PORT}`);
});