require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// 6. Enable CORS "*"
app.use(cors());

// Return ICE configuration from Environment Variables securely
app.get('/api/ice-servers', (req, res) => {
    res.json({
        iceServers: [
            { urls: process.env.STUN_URL || 'stun:127.0.0.1:3478' },
            {
                urls: process.env.TURN_URL || 'turn:127.0.0.1:3478',
                username: process.env.TURN_USERNAME || 'stranger',
                credential: process.env.TURN_CREDENTIAL || 'thingspassword'
            },
            {
                urls: process.env.TURN_URL_TCP || 'turn:127.0.0.1:3478?transport=tcp',
                username: process.env.TURN_USERNAME || 'stranger',
                credential: process.env.TURN_CREDENTIAL || 'thingspassword'
            }
        ]
    });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// 1. Maintain matchmaking queue
let waitingUser = null;

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // 2. Event: "join"
    socket.on('join', () => {
        if (waitingUser === null) {
            // If waitingUser null → store socket
            waitingUser = socket;
        } else {
            // Edge case: don't match with self
            if (waitingUser.id === socket.id) return;

            // Match users: create roomId
            const partner = waitingUser;
            const roomId = `room_${Date.now()}`;

            // Join both sockets
            socket.join(roomId);
            partner.join(roomId);

            // Track the room for disconnect/skip events
            socket.roomId = roomId;
            partner.roomId = roomId;

            // emit "matched" with: { roomId, initiator: true/false }
            socket.emit('matched', { roomId, initiator: true });
            partner.emit('matched', { roomId, initiator: false });

            console.log(`Matched ${socket.id} and ${partner.id} in ${roomId}`);

            // reset waitingUser
            waitingUser = null;
        }
    });

    // 3. Relay events
    socket.on('offer', ({ roomId, offer }) => {
        socket.to(roomId).emit('offer', offer);
    });

    socket.on('answer', ({ roomId, answer }) => {
        socket.to(roomId).emit('answer', answer);
    });

    socket.on('ice-candidate', ({ roomId, candidate }) => {
        socket.to(roomId).emit('ice-candidate', candidate);
    });

    // 4. Skip
    socket.on('skip', ({ roomId }) => {
        console.log(`User ${socket.id} skipped in room ${roomId}`);
        // emit "partner-left"
        socket.to(roomId).emit('partner-left');

        // leave room
        socket.leave(roomId);
        socket.roomId = null;
    });

    // 5. Disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        // notify partner
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner-left');
        }

        // clean queue
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }
    });
});

// 7. Port = process.env.PORT || 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
