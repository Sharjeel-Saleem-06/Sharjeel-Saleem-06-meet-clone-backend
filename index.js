const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Environment configuration
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN || [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:3001"
];

// Parse CORS_ORIGIN if it's a string (for production)
const corsOrigins = typeof CORS_ORIGIN === 'string' 
  ? CORS_ORIGIN.split(',').map(origin => origin.trim())
  : CORS_ORIGIN;

console.log('Server starting with configuration:');
console.log('- Environment:', NODE_ENV);
console.log('- Port:', PORT);
console.log('- CORS Origins:', corsOrigins);

// Socket.IO setup with CORS
const io = socketIo(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: NODE_ENV === 'development' ? false : {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  }
}));
app.use(compression());
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json());

// In-memory storage for rooms and participants
const rooms = new Map();
const participants = new Map();

// Room management functions
function createRoom(roomId, hostId) {
  const room = {
    id: roomId,
    hostId,
    participants: new Map(),
    createdAt: new Date(),
    settings: {
      maxParticipants: 25,
      requirePassword: false,
      password: null,
      allowScreenShare: true,
      allowChat: true,
      recordMeeting: false
    }
  };
  
  rooms.set(roomId, room);
  return room;
}

function addParticipantToRoom(roomId, participantData) {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  const participant = {
    id: participantData.id,
    socketId: participantData.socketId,
    name: participantData.name,
    isHost: participantData.id === room.hostId,
    isCoHost: false,
    isMuted: false,
    isCameraOff: false,
    isScreenSharing: false,
    isSpeaking: false,
    joinedAt: new Date(),
    lastSeen: new Date()
  };
  
  room.participants.set(participant.id, participant);
  participants.set(participantData.socketId, {
    ...participant,
    roomId
  });
  
  return participant;
}

function removeParticipantFromRoom(socketId) {
  const participant = participants.get(socketId);
  if (!participant) return null;
  
  const room = rooms.get(participant.roomId);
  if (room) {
    room.participants.delete(participant.id);
    
    // If room is empty, delete it
    if (room.participants.size === 0) {
      rooms.delete(participant.roomId);
    } else if (participant.isHost) {
      // Transfer host to another participant
      const newHost = Array.from(room.participants.values())[0];
      if (newHost) {
        newHost.isHost = true;
        room.hostId = newHost.id;
      }
    }
  }
  
  participants.delete(socketId);
  return participant;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    participants: participants.size
  });
});

// Get room info endpoint
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    id: room.id,
    participantCount: room.participants.size,
    maxParticipants: room.settings.maxParticipants,
    createdAt: room.createdAt,
    requirePassword: room.settings.requirePassword
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Join room
  socket.on('join-room', (data) => {
    const { roomId, userData, userId } = data;
    
    try {
      // Handle both old format (userData) and new format (userId)
      const userInfo = userData || { 
        id: userId, 
        name: 'You' // Use simple name instead of random
      };
      
      // Create room if it doesn't exist
      if (!rooms.has(roomId)) {
        createRoom(roomId, userInfo.id);
      }
      
      const room = rooms.get(roomId);
      
      // Check room capacity
      if (room.participants.size >= room.settings.maxParticipants) {
        socket.emit('join-error', { message: 'Room is full' });
        return;
      }
      
      // Add participant to room
      const participant = addParticipantToRoom(roomId, {
        ...userInfo,
        socketId: socket.id
      });
      
      if (!participant) {
        socket.emit('join-error', { message: 'Failed to join room' });
        return;
      }
      
      // Store participant in room
      room.participants.set(participant.id, participant);
      
      // Store socket mapping for this user
      socket.userId = participant.id;
      socket.userName = participant.name;
      socket.roomId = roomId;
      
      // Join socket room
      socket.join(roomId);
      
      // Send current participants to new user (exclude the current user to prevent duplication)
      const currentParticipants = Array.from(room.participants.values())
        .filter(p => p.id !== participant.id);
      socket.emit('room-joined', {
        roomId,
        participants: currentParticipants,
        currentUser: participant
      });
      
      // Notify other participants
      socket.to(roomId).emit('participant-joined', participant);
      
      console.log(`User ${participant.name} joined room ${roomId}`);
      console.log(`Sending ${currentParticipants.length} existing participants to new user`);
      
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('join-error', { message: 'Internal server error' });
    }
  });
  
  // Leave room
  socket.on('leave-room', () => {
    const participant = removeParticipantFromRoom(socket.id);
    
    if (participant) {
      socket.to(participant.roomId).emit('participant-left', {
        participantId: participant.id
      });
      
      socket.leave(participant.roomId);
      console.log(`User ${participant.name} left room ${participant.roomId}`);
    }
  });
  
  // WebRTC signaling
  socket.on('offer', (data) => {
    const { targetId, offer } = data;
    const participant = participants.get(socket.id);
    
    if (participant) {
      // Find target participant's socket
      const targetParticipant = Array.from(participants.values())
        .find(p => p.id === targetId && p.roomId === participant.roomId);
      
      if (targetParticipant) {
        io.to(targetParticipant.socketId).emit('offer', {
          fromId: participant.id,
          offer
        });
      }
    }
  });
  
  socket.on('answer', (data) => {
    const { targetId, answer } = data;
    const participant = participants.get(socket.id);
    
    if (participant) {
      const targetParticipant = Array.from(participants.values())
        .find(p => p.id === targetId && p.roomId === participant.roomId);
      
      if (targetParticipant) {
        io.to(targetParticipant.socketId).emit('answer', {
          fromId: participant.id,
          answer
        });
      }
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const { targetId, candidate } = data;
    const participant = participants.get(socket.id);
    
    if (participant) {
      const targetParticipant = Array.from(participants.values())
        .find(p => p.id === targetId && p.roomId === participant.roomId);
      
      if (targetParticipant) {
        io.to(targetParticipant.socketId).emit('ice-candidate', {
          fromId: participant.id,
          candidate
        });
      }
    }
  });
  
  // Media state updates
  socket.on('media-state-changed', (data) => {
    const participant = participants.get(socket.id);
    
    if (participant) {
      const room = rooms.get(participant.roomId);
      const roomParticipant = room?.participants.get(participant.id);
      
      if (roomParticipant) {
        // Update participant state
        Object.assign(roomParticipant, data);
        Object.assign(participant, data);
        
        // Broadcast to other participants
        socket.to(participant.roomId).emit('participant-media-changed', {
          participantId: participant.id,
          ...data
        });
      }
    }
  });
  
  // Handle screen sharing events
  socket.on('screen-share-started', () => {
    const participant = participants.get(socket.id);
    if (participant) {
      socket.to(participant.roomId).emit('participant-screen-share-started', { 
        participantId: socket.userId || participant.id 
      });
      console.log(`User ${participant.name} started screen sharing in room ${participant.roomId}`);
    }
  });
  
  socket.on('screen-share-stopped', () => {
    const participant = participants.get(socket.id);
    if (participant) {
      socket.to(participant.roomId).emit('participant-screen-share-stopped', { 
        participantId: socket.userId || participant.id 
      });
      console.log(`User ${participant.name} stopped screen sharing in room ${participant.roomId}`);
    }
  });
  
  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { content, type = 'public', recipientId } = data;
    
    if (!content || !content.trim()) {
      return;
    }
    
    const participant = participants.get(socket.id);
    if (!participant) {
      return;
    }
    
    const message = {
      id: require('crypto').randomUUID(),
      senderId: socket.userId || participant.id,
      senderName: socket.userName || participant.name || 'Unknown',
      content: content.trim(),
      timestamp: new Date(),
      type,
      recipientId
    };
    
    console.log(`Chat message from ${participant.name}: ${content}`);
    
    if (type === 'private' && recipientId) {
      // Send private message to specific recipient
      socket.to(recipientId).emit('chat-message', message);
    } else {
      // Broadcast public message to all participants in room
      socket.to(participant.roomId).emit('chat-message', message);
    }
  });
  
  // Reactions
  socket.on('reaction', (data) => {
    const participant = participants.get(socket.id);
    
    if (participant) {
      const reaction = {
        id: uuidv4(),
        participantId: participant.id,
        participantName: participant.name,
        emoji: data.emoji,
        timestamp: new Date()
      };
      
      // Broadcast to all participants in room
      io.to(participant.roomId).emit('reaction', reaction);
    }
  });
  
  // Speaking detection
  socket.on('speaking-changed', (data) => {
    const participant = participants.get(socket.id);
    
    if (participant) {
      const room = rooms.get(participant.roomId);
      const roomParticipant = room?.participants.get(participant.id);
      
      if (roomParticipant) {
        roomParticipant.isSpeaking = data.isSpeaking;
        participant.isSpeaking = data.isSpeaking;
        
        socket.to(participant.roomId).emit('participant-speaking-changed', {
          participantId: participant.id,
          isSpeaking: data.isSpeaking
        });
      }
    }
  });
  
  // Host controls
  socket.on('mute-participant', (data) => {
    const participant = participants.get(socket.id);
    
    if (participant && (participant.isHost || participant.isCoHost)) {
      const targetParticipant = Array.from(participants.values())
        .find(p => p.id === data.participantId && p.roomId === participant.roomId);
      
      if (targetParticipant) {
        io.to(targetParticipant.socketId).emit('force-mute');
      }
    }
  });
  
  socket.on('kick-participant', (data) => {
    const participant = participants.get(socket.id);
    
    if (participant && (participant.isHost || participant.isCoHost)) {
      const targetParticipant = Array.from(participants.values())
        .find(p => p.id === data.participantId && p.roomId === participant.roomId);
      
      if (targetParticipant && !targetParticipant.isHost) {
        io.to(targetParticipant.socketId).emit('kicked-from-room');
        
        // Remove participant
        removeParticipantFromRoom(targetParticipant.socketId);
        
        // Notify other participants
        socket.to(participant.roomId).emit('participant-left', {
          participantId: targetParticipant.id
        });
      }
    }
  });
  
  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    const participant = removeParticipantFromRoom(socket.id);
    
    if (participant) {
      socket.to(participant.roomId).emit('participant-left', {
        participantId: participant.id
      });
      
      console.log(`User ${participant.name} disconnected from room ${participant.roomId}`);
    }
  });
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Meet Clone Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
  console.log(`🌐 Client URL: ${process.env.CLIENT_URL || "http://localhost:5173"}`);
}); 