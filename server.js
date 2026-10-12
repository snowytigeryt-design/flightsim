const WebSocket = require('ws');
const Datastore = require('nedb');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Create HTTP server for serving static files
const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';
    
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
    };
    
    const contentType = mimeTypes[extname] || 'application/octet-stream';
    
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// Initialize NedB for player data
const playersDB = new Datastore({ filename: 'players.db', autoload: true });
playersDB.ensureIndex({ fieldName: 'uuid', unique: true });

// WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected players
const connectedPlayers = new Map();

// Broadcast message to all clients except sender
function broadcast(sender, message) {
    wss.clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Send message to specific client
function sendToClient(client, message) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
    }
}

// Send all player data to a client
function sendAllPlayers(client) {
    const players = [];
    connectedPlayers.forEach((data, uuid) => {
        players.push({
            uuid: uuid,
            position: data.position,
            rotation: data.rotation,
            health: data.health
        });
    });
    sendToClient(client, { type: 'allPlayers', players });
}

wss.on('connection', (ws) => {
    // Generate UUID for new player
    const playerUUID = uuidv4();
    
    // Check if player exists in database
    playersDB.findOne({ uuid: playerUUID }, (err, doc) => {
        let playerData;
        
        if (doc) {
            // Existing player
            playerData = {
                ws: ws,
                uuid: playerUUID,
                position: doc.position || { x: 0, y: 800, z: 0 },
                rotation: doc.rotation || { x: 0, y: 0, z: 0, w: 1 },
                health: doc.health || 100,
                spawnProtection: false
            };
        } else {
            // New player - randomize spawn position
            const spawnRadius = 500;
            const randomAngle = Math.random() * Math.PI * 2;
            const randomX = Math.cos(randomAngle) * spawnRadius;
            const randomZ = Math.sin(randomAngle) * spawnRadius;

            playerData = {
                ws: ws,
                uuid: playerUUID,
                position: { x: randomX, y: 800, z: randomZ },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                health: 100,
                spawnProtection: true
            };

            // Save to database
            playersDB.insert({
                uuid: playerUUID,
                position: playerData.position,
                rotation: playerData.rotation,
                health: playerData.health
            });

            // Remove spawn protection after 5 seconds
            setTimeout(() => {
                const pData = connectedPlayers.get(playerUUID);
                if (pData) {
                    pData.spawnProtection = false;
                    sendToClient(ws, { type: 'spawnProtectionEnd' });
                }
            }, 5000);
        }
        
        connectedPlayers.set(playerUUID, playerData);
        
        // Send UUID to client
        sendToClient(ws, { type: 'init', uuid: playerUUID });
        
        // Send all existing players to new client
        sendAllPlayers(ws);
        
        // Broadcast new player to others
        broadcast(ws, {
            type: 'playerJoined',
            uuid: playerUUID,
            position: playerData.position,
            rotation: playerData.rotation,
            health: playerData.health
        });
        
        console.log(`Player connected: ${playerUUID}`);
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const playerData = connectedPlayers.get(data.uuid);
            
            if (!playerData) return;
            
            switch (data.type) {
                case 'updatePosition':
                    playerData.position = data.position;
                    playerData.rotation = data.rotation;
                    
                    // Update database
                    playersDB.update(
                        { uuid: data.uuid },
                        { $set: { position: data.position, rotation: data.rotation } },
                        {}
                    );
                    
                    // Broadcast to others
                    broadcast(ws, {
                        type: 'playerUpdate',
                        uuid: data.uuid,
                        position: data.position,
                        rotation: data.rotation
                    });
                    break;
                    
                case 'shoot':
                    // Broadcast shot to all players
                    broadcast(ws, {
                        type: 'shot',
                        shooter: data.uuid,
                        position: data.position,
                        direction: data.direction
                    });
                    break;
                    
                case 'hit':
                    // Player was hit
                    const targetUUID = data.target;
                    const targetData = connectedPlayers.get(targetUUID);

                    if (targetData) {
                        // Check if target has spawn protection
                        if (targetData.spawnProtection) {
                            // Player is protected, ignore the hit
                            return;
                        }

                        targetData.health -= data.damage;

                        // Update database
                        playersDB.update(
                            { uuid: targetUUID },
                            { $set: { health: targetData.health } },
                            {}
                        );

                        // Broadcast health update
                        broadcast(ws, {
                            type: 'playerHit',
                            uuid: targetUUID,
                            health: targetData.health,
                            shooter: data.uuid
                        });

                        // Check if player is dead
                        if (targetData.health <= 0) {
                            broadcast(ws, {
                                type: 'playerKilled',
                                uuid: targetUUID,
                                killer: data.uuid
                            });

                            // Respawn player
                            setTimeout(() => {
                                targetData.health = 100;

                                // Randomize respawn position
                                const spawnRadius = 500;
                                const randomAngle = Math.random() * Math.PI * 2;
                                const randomX = Math.cos(randomAngle) * spawnRadius;
                                const randomZ = Math.sin(randomAngle) * spawnRadius;
                                targetData.position = { x: randomX, y: 800, z: randomZ };
                                targetData.rotation = { x: 0, y: 0, z: 0, w: 1 };
                                targetData.spawnProtection = true;

                                playersDB.update(
                                    { uuid: targetUUID },
                                    { $set: { health: 100, position: targetData.position, rotation: targetData.rotation } },
                                    {}
                                );

                                sendToClient(targetData.ws, {
                                    type: 'respawn',
                                    position: targetData.position,
                                    rotation: targetData.rotation
                                });

                                broadcast(targetData.ws, {
                                    type: 'playerRespawned',
                                    uuid: targetUUID,
                                    position: targetData.position,
                                    rotation: targetData.rotation,
                                    health: 100
                                });

                                // Remove spawn protection after 5 seconds
                                setTimeout(() => {
                                    const pData = connectedPlayers.get(targetUUID);
                                    if (pData) {
                                        pData.spawnProtection = false;
                                        sendToClient(targetData.ws, { type: 'spawnProtectionEnd' });
                                    }
                                }, 5000);
                            }, 3000);
                        }
                    }
                    break;
                    
                case 'respawn':
                    // Client-side respawn completed
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });
    
    ws.on('close', () => {
        // Find and remove player
        for (const [uuid, data] of connectedPlayers.entries()) {
            if (data.ws === ws) {
                connectedPlayers.delete(uuid);
                broadcast(ws, { type: 'playerLeft', uuid });
                console.log(`Player disconnected: ${uuid}`);
                break;
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
