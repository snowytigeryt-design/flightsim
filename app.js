// --- 1. Basic Scene & Lighting Setup ---
const scene = new THREE.Scene();

const skyColor = new THREE.Color(0x87CEEB);
const spaceColor = new THREE.Color(0x000011);

scene.background = skyColor.clone();
scene.fog = new THREE.Fog(skyColor.getHex(), 200, 2000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 800, 0); // Spawns safely above max building height (700)

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0x555555);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
scene.add(directionalLight);

// --- Multiplayer Setup ---
let ws;
let myUUID = null;
const otherPlayers = new Map(); // uuid -> { mesh, position, rotation, health }
let myHealth = 100;
let isDead = false;
let jetModel = null; // 3D model for jets
let hasSpawnProtection = false;

// Load 3D jet model
const loader = new THREE.GLTFLoader();
loader.load(
    'sukhoi_su-57_felon_-_fighter_jet_-_free.glb',
    function (gltf) {
        jetModel = gltf.scene;
        jetModel.scale.set(2, 2, 2); // Scale the model appropriately
        jetModel.rotation.y = Math.PI; // 180 degree rotation to face correct direction
        console.log('Jet model loaded successfully');

        // Update existing players to use the 3D model
        otherPlayers.forEach((player, uuid) => {
            const oldMesh = player.mesh;
            const newMesh = jetModel.clone();
            newMesh.scale.set(2, 2, 2);
            newMesh.rotation.y = Math.PI;
            newMesh.position.copy(oldMesh.position);
            newMesh.quaternion.copy(oldMesh.quaternion);

            scene.remove(oldMesh);
            scene.add(newMesh);
            player.mesh = newMesh;
        });
    },
    function (xhr) {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    },
    function (error) {
        console.error('Error loading jet model:', error);
    }
);

// Connect to WebSocket server
function connectToServer() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to server');
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
    };

    ws.onclose = () => {
        console.log('Disconnected from server');
        setTimeout(connectToServer, 3000); // Reconnect after 3 seconds
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

function handleServerMessage(data) {
    switch (data.type) {
        case 'init':
            myUUID = data.uuid;
            hasSpawnProtection = true;
            console.log('My UUID:', myUUID);
            updateHealthDisplay();
            break;

        case 'allPlayers':
            data.players.forEach(player => {
                if (player.uuid !== myUUID) {
                    createOtherPlayer(player.uuid, player.position, player.rotation, player.health);
                }
            });
            break;

        case 'playerJoined':
            if (data.uuid !== myUUID) {
                createOtherPlayer(data.uuid, data.position, data.rotation, data.health);
            }
            break;

        case 'playerUpdate':
            updateOtherPlayer(data.uuid, data.position, data.rotation);
            break;

        case 'shot':
            handleIncomingShot(data.shooter, data.position, data.direction);
            break;

        case 'playerHit':
            if (data.uuid === myUUID) {
                myHealth = data.health;
                updateHealthDisplay();
                if (myHealth <= 0) {
                    handleDeath();
                }
            } else {
                updateOtherPlayerHealth(data.uuid, data.health);
            }
            break;

        case 'playerKilled':
            if (data.uuid === myUUID) {
                handleDeath();
            } else {
                removeOtherPlayer(data.uuid);
            }
            break;

        case 'playerRespawned':
            if (data.uuid === myUUID) {
                myHealth = data.health;
                isDead = false;
                hasSpawnProtection = true;
                camera.position.set(data.position.x, data.position.y, data.position.z);
                camera.quaternion.set(data.rotation.x, data.rotation.y, data.rotation.z, data.rotation.w);
                crashed = false;
                updateHealthDisplay();
                crashMsg.style.display = 'none';
                document.body.requestPointerLock();
            } else {
                createOtherPlayer(data.uuid, data.position, data.rotation, data.health);
            }
            break;

        case 'spawnProtectionEnd':
            hasSpawnProtection = false;
            console.log('Spawn protection ended');
            break;

        case 'playerLeft':
            removeOtherPlayer(data.uuid);
            break;
    }
}

function createOtherPlayer(uuid, position, rotation, health) {
    if (otherPlayers.has(uuid)) return;

    let mesh;

    if (jetModel) {
        // Use the 3D jet model
        mesh = jetModel.clone();
        mesh.scale.set(2, 2, 2);
        // Rotate the model to face the correct direction
        mesh.rotation.y = Math.PI; // 180 degree rotation
    } else {
        // Fallback to box shape if model not loaded yet
        const geometry = new THREE.BoxGeometry(4, 2, 8);
        const material = new THREE.MeshLambertMaterial({ color: 0xff0000 });
        mesh = new THREE.Mesh(geometry, material);
    }

    mesh.position.set(position.x, position.y, position.z);
    mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    scene.add(mesh);
    otherPlayers.set(uuid, { mesh, position, rotation, health });
}

function updateOtherPlayer(uuid, position, rotation) {
    const player = otherPlayers.get(uuid);
    if (player) {
        player.position = position;
        player.rotation = rotation;
        player.mesh.position.set(position.x, position.y, position.z);
        player.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
}

function updateOtherPlayerHealth(uuid, health) {
    const player = otherPlayers.get(uuid);
    if (player) {
        player.health = health;
        // Change color based on health for box shapes
        if (player.mesh.material && player.mesh.material.color) {
            const healthRatio = health / 100;
            player.mesh.material.color.setRGB(1, healthRatio, healthRatio);
        }
        // For 3D model, traverse and update materials
        player.mesh.traverse((child) => {
            if (child.isMesh && child.material) {
                const healthRatio = health / 100;
                if (Array.isArray(child.material)) {
                    child.material.forEach(mat => {
                        if (mat.color) mat.color.setRGB(1, healthRatio, healthRatio);
                    });
                } else if (child.material.color) {
                    child.material.color.setRGB(1, healthRatio, healthRatio);
                }
            }
        });
    }
}

function removeOtherPlayer(uuid) {
    const player = otherPlayers.get(uuid);
    if (player) {
        scene.remove(player.mesh);
        otherPlayers.delete(uuid);
    }
}

function handleIncomingShot(shooterUUID, position, direction) {
    // Create visual effect for incoming shot
    const shotGeometry = new THREE.SphereGeometry(0.5, 8, 8);
    const shotMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    const shotMesh = new THREE.Mesh(shotGeometry, shotMaterial);
    shotMesh.position.set(position.x, position.y, position.z);
    scene.add(shotMesh);

    // Animate shot and check collision with player
    const shotVelocity = new THREE.Vector3(direction.x, direction.y, direction.z).normalize().multiplyScalar(50);
    let distance = 0;

    function animateShot() {
        shotMesh.position.add(shotVelocity);
        distance += 50;

        // Check collision with player
        const distToPlayer = shotMesh.position.distanceTo(camera.position);
        if (distToPlayer < 15 && !isDead) {
            // Player was hit
            scene.remove(shotMesh);
            createExplosion(camera.position, 0.5);
            ws.send(JSON.stringify({
                type: 'hit',
                uuid: myUUID,
                target: myUUID,
                damage: 25,
                shooter: shooterUUID
            }));
            return;
        }

        if (distance > 3000) {
            scene.remove(shotMesh);
            return;
        }

        requestAnimationFrame(animateShot);
    }

    animateShot();
}

function handleDeath() {
    isDead = true;
    crashed = true;
    speed = 0;
    hasSpawnProtection = false;
    createExplosion(camera.position, 2);
    if (document.pointerLockElement === document.body) document.exitPointerLock();
    crashMsg.innerHTML = 'YOU WERE SHOT DOWN<br>Respawning in 3 seconds...';
    crashMsg.style.display = 'flex';
    crashMsg.style.flexDirection = 'column';
    crashMsg.style.alignItems = 'center';
    stallMsg.style.display = 'none';
    updateHealthDisplay();
}

function updateHealthDisplay() {
    // Create health display if it doesn't exist
    let healthDisplay = document.getElementById('health-display');
    if (!healthDisplay) {
        healthDisplay = document.createElement('div');
        healthDisplay.id = 'health-display';
        healthDisplay.className = 'hud-box';
        healthDisplay.style.top = '5%';
        healthDisplay.style.left = '50%';
        healthDisplay.style.transform = 'translateX(-50%)';
        healthDisplay.innerHTML = 'HP <br><span id="health-val">100</span>';
        document.getElementById('hud').appendChild(healthDisplay);
    }
    document.getElementById('health-val').innerText = Math.max(0, myHealth);

    // Update spawn protection indicator
    let spawnProtectionDisplay = document.getElementById('spawn-protection');
    if (hasSpawnProtection) {
        if (!spawnProtectionDisplay) {
            spawnProtectionDisplay = document.createElement('div');
            spawnProtectionDisplay.id = 'spawn-protection';
            spawnProtectionDisplay.style.position = 'absolute';
            spawnProtectionDisplay.style.top = '15%';
            spawnProtectionDisplay.style.left = '50%';
            spawnProtectionDisplay.style.transform = 'translateX(-50%)';
            spawnProtectionDisplay.style.color = '#00ffff';
            spawnProtectionDisplay.style.fontSize = '20px';
            spawnProtectionDisplay.style.textShadow = '0px 0px 10px #00ffff';
            spawnProtectionDisplay.style.textAlign = 'center';
            spawnProtectionDisplay.innerText = 'SPAWN PROTECTION ACTIVE';
            document.getElementById('hud').appendChild(spawnProtectionDisplay);
        }
    } else if (spawnProtectionDisplay) {
        spawnProtectionDisplay.remove();
    }
}

// Start connection
connectToServer();

// --- 2. Setup Projectile & Debris ---
const brickGeometry = new THREE.BoxGeometry(1, 0.5, 2);
const brickMaterial = new THREE.MeshLambertMaterial({ color: 0xffff00 });
const placeholderBrick = new THREE.Mesh(brickGeometry, brickMaterial);

const activeProjectiles = [];
const activeDebris = [];
const debrisGeometry = new THREE.BoxGeometry(4, 4, 4);
const debrisMaterial = new THREE.MeshLambertMaterial({ color: 0x555555 });

// Explosion particles
const explosionParticles = [];

function spawnVoxelDebris(position, scale) {
    for (let i = 0; i < 25; i++) {
        const voxel = new THREE.Mesh(debrisGeometry, debrisMaterial);
        voxel.position.set(
            position.x + (Math.random() - 0.5) * scale.x,
            (Math.random() * scale.y),
            position.z + (Math.random() - 0.5) * scale.z
        );
        scene.add(voxel);
        activeDebris.push({
            mesh: voxel,
            velocity: new THREE.Vector3(
                (Math.random() - 0.5) * 4,
                Math.random() * 5 + 2,
                (Math.random() - 0.5) * 4
            )
        });
    }
}

function createExplosion(position, scale = 1) {
    // Create explosion particles
    const explosionGeometry = new THREE.SphereGeometry(2 * scale, 8, 8);
    const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 1 });

    for (let i = 0; i < 20; i++) {
        const particle = new THREE.Mesh(explosionGeometry, explosionMaterial.clone());
        particle.position.copy(position);
        particle.position.x += (Math.random() - 0.5) * 10 * scale;
        particle.position.y += (Math.random() - 0.5) * 10 * scale;
        particle.position.z += (Math.random() - 0.5) * 10 * scale;
        particle.scale.setScalar(Math.random() * 0.5 + 0.5);
        scene.add(particle);

        explosionParticles.push({
            mesh: particle,
            velocity: new THREE.Vector3(
                (Math.random() - 0.5) * 10,
                Math.random() * 5,
                (Math.random() - 0.5) * 10
            ),
            life: 1.0
        });
    }

    // Create fire debris
    for (let i = 0; i < 15; i++) {
        const fireDebris = new THREE.Mesh(debrisGeometry, new THREE.MeshBasicMaterial({ color: 0xff6600 }));
        fireDebris.position.copy(position);
        fireDebris.position.x += (Math.random() - 0.5) * 15 * scale;
        fireDebris.position.y += (Math.random() - 0.5) * 15 * scale;
        fireDebris.position.z += (Math.random() - 0.5) * 15 * scale;
        fireDebris.scale.setScalar(Math.random() * 2 + 1);
        scene.add(fireDebris);

        activeDebris.push({
            mesh: fireDebris,
            velocity: new THREE.Vector3(
                (Math.random() - 0.5) * 8,
                Math.random() * 8 + 3,
                (Math.random() - 0.5) * 8
            )
        });
    }
}

// --- 3. Environment (Floor, Sun, Clouds, City) ---
const floorGeometry = new THREE.PlaneGeometry(10000, 10000);
const floorMaterial = new THREE.MeshLambertMaterial({ color: 0x1B4D3E }); 
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2; 
scene.add(floor);

const gridHelper = new THREE.GridHelper(5000, 100, 0x000000, 0x000000);
gridHelper.position.y = 0.5; 
scene.add(gridHelper);

const sunGeometry = new THREE.SphereGeometry(200, 32, 32);
const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xffee00 });
const sun = new THREE.Mesh(sunGeometry, sunMaterial);
sun.position.set(0, 12000, -4000); 
scene.add(sun);
directionalLight.position.copy(sun.position); 

const cloudGeometry = new THREE.BoxGeometry(200, 40, 200);
const cloudMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
for (let i = 0; i < 150; i++) {
    const cloud = new THREE.Mesh(cloudGeometry, cloudMaterial);
    cloud.position.set(
        (Math.random() - 0.5) * 6000,
        Math.random() * 3000 + 4000, 
        (Math.random() - 0.5) * 6000
    );
    scene.add(cloud);
}

const buildings = [];
const numBuildings = 300; 
const citySize = 4000;    
const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);

for (let i = 0; i < numBuildings; i++) {
    const bMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const building = new THREE.Mesh(buildingGeometry, bMat);
    const width = Math.random() * 60 + 30;
    const depth = Math.random() * 60 + 30;
    const height = Math.random() * 600 + 100;
    
    building.scale.set(width, height, depth);
    building.position.set(
        (Math.random() - 0.5) * citySize,
        height / 2, 
        (Math.random() - 0.5) * citySize
    );
    
    building.userData = { health: 3, isDestroyed: false, baseColor: 0x888888, _xG: false };
    scene.add(building);
    buildings.push(building);
}

function resetBuilding(b) {
    if (b.userData.isDestroyed) {
        b.userData.isDestroyed = false;
        b.userData.health = 3;
        b.material.color.setHex(b.userData.baseColor);
        b.visible = true;
    }
}

// --- 4. Flight Controls & Variables ---
let speed = 0;
const maxSpeed = 8.0; 
const terminalVelocity = 20.0; 
const acceleration = 0.05;
const drag = 0.01;
const stallAltitude = 10000; 
let gravityDropSpeed = 0;    
let pitchVelocity = 0;
let rollVelocity = 0;
let yawVelocity = 0;
const turnAcceleration = 0.0015;
const damping = 0.93; 
let crashed = false;

// Send position updates to server (throttled)
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 50; // 20 updates per second

let _e1=0, _e2=0, _e3=false, _e4=false, _e5=false, _e6=false, _e7=0, _e8=false, _e9=false, _e10=false;
let _kStr = "";

const keys = { ArrowUp: false, w: false, a: false, s: false, d: false };

window.addEventListener('keydown', (e) => {
    const key = e.key === 'ArrowUp' ? 'ArrowUp' : e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = true;
    
    _kStr += key;
    if(_kStr.length > 15) _kStr = _kStr.slice(-15);
    if(_kStr.includes('party')) { _e3 = !_e3; _kStr = ""; }
    if(_kStr.includes('god')) { _e4 = !_e4; _kStr = ""; }
    if(_kStr.includes('moon')) { _e8 = !_e8; _kStr = ""; }
    if(_kStr.includes('giant')) { _e9 = !_e9; _kStr = ""; }
    if(_kStr.includes('lava')) { _e10 = !_e10; _kStr = ""; floor.material.color.setHex(_e10 ? 0xff2200 : 0x1B4D3E); }
    
    if (e.code === 'Space' && !crashed && !isDead) {
        _e1++;
        const newProjectile = placeholderBrick.clone();
        if(_e1 > 42) newProjectile.scale.set(6, 6, 6);
        newProjectile.position.copy(camera.position);
        newProjectile.quaternion.copy(camera.quaternion);
        newProjectile.translateZ(-5);
        scene.add(newProjectile);
        activeProjectiles.push({ mesh: newProjectile, distance: 0, isPlayerShot: true });

        // Send shot to server
        if (ws && ws.readyState === WebSocket.OPEN) {
            const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            ws.send(JSON.stringify({
                type: 'shoot',
                uuid: myUUID,
                position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                direction: { x: forwardVector.x, y: forwardVector.y, z: forwardVector.z }
            }));
        }
    }
});

window.addEventListener('keyup', (e) => {
    const key = e.key === 'ArrowUp' ? 'ArrowUp' : e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = true ? false : false;
});

let isPointerLocked = false;
document.body.addEventListener('click', (e) => {
    if (!crashed && e.target.id !== 'respawn-btn') document.body.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === document.body);
});
document.addEventListener('mousemove', (e) => {
    if (isPointerLocked && !crashed) {
        const mouseSensitivity = 0.00015; 
        pitchVelocity += e.movementY * mouseSensitivity;
        rollVelocity -= e.movementX * mouseSensitivity;
        yawVelocity -= e.movementX * (mouseSensitivity * 0.4);
    }
});

const speedVal = document.getElementById('speed-val');
const altVal = document.getElementById('alt-val');
const pitchLadder = document.getElementById('pitch-ladder');
const crashMsg = document.getElementById('crash-msg');
const stallMsg = document.getElementById('stall-msg');

// --- Respawn Button Setup ---
const respawnBtn = document.createElement('button');
respawnBtn.id = 'respawn-btn';
respawnBtn.innerText = 'Restart Game';
respawnBtn.style.display = 'block';
respawnBtn.style.marginTop = '20px';
respawnBtn.style.padding = '12px 24px';
respawnBtn.style.fontSize = '20px';
respawnBtn.style.cursor = 'pointer';
respawnBtn.style.backgroundColor = '#ff5555';
respawnBtn.style.color = '#fff';
respawnBtn.style.border = 'none';
respawnBtn.style.borderRadius = '5px';
respawnBtn.style.zIndex = '9999';
respawnBtn.style.pointerEvents = 'auto';
crashMsg.appendChild(respawnBtn);

respawnBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevents document click handlers from firing

    // 1. Reset Physics & Controls
    crashed = false;
    isDead = false;
    hasSpawnProtection = false;
    speed = 0;
    pitchVelocity = 0;
    rollVelocity = 0;
    yawVelocity = 0;
    gravityDropSpeed = 0;
    for (let key in keys) keys[key] = false;

    // 2. Clear Secrets & Camera State
    _e1=0; _e2=0; _e3=false; _e4=false; _e5=false; _e6=false; _e7=0; _e8=false; _e9=false; _e10=false;
    _kStr = "";
    camera.fov = 75;
    camera.updateProjectionMatrix();
    floor.material.color.setHex(0x1B4D3E);
    sun.material.color.setHex(0xffee00);

    // 3. Reset Plane Safe Position Above City
    camera.position.set(0, 800, 0);
    camera.quaternion.identity();

    // 4. Reset health
    myHealth = 100;
    updateHealthDisplay();

    // 5. Clear Objects
    activeProjectiles.forEach(p => scene.remove(p.mesh));
    activeProjectiles.length = 0;
    activeDebris.forEach(d => scene.remove(d.mesh));
    activeDebris.length = 0;

    // 6. Reset City Buildings
    buildings.forEach(b => {
        if(b.userData._xG) { b.scale.y /= 4; b.userData._xG = false; }
        b.userData.isDestroyed = false;
        b.userData.health = 3;
        b.material.color.setHex(b.userData.baseColor);
        b.visible = true;
    });

    // 7. Reset crash message
    crashMsg.innerHTML = 'SYSTEM FAILURE<br>CRASH DETECTED';

    // 8. Hide Crash Display & Lock Mouse
    crashMsg.style.display = 'none';
    document.body.requestPointerLock();
});

// --- 5. Main Game Loop ---
function animate() {
    requestAnimationFrame(animate);

    if (!crashed) {
        const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        let gravityAssist = -forwardVector.y * 0.15; 
        
        if(_e8) gravityAssist = 0; 
        if (gravityAssist < 0) gravityAssist *= 0.3; 

        speed += gravityAssist;
        let isStalling = camera.position.y > stallAltitude;

        if (isStalling) {
            stallMsg.style.display = 'block'; pitchVelocity -= 0.005; gravityDropSpeed += 0.2; camera.position.y -= gravityDropSpeed;
        } else {
            stallMsg.style.display = 'none'; gravityDropSpeed = 0; 
            if (keys.ArrowUp) speed += acceleration; else speed -= drag;
            if (keys.w) pitchVelocity -= turnAcceleration; 
            if (keys.s) pitchVelocity += turnAcceleration; 
            if (keys.a) { rollVelocity += turnAcceleration; yawVelocity += turnAcceleration * 0.4; }
            if (keys.d) { rollVelocity -= turnAcceleration; yawVelocity -= turnAcceleration * 0.4; }
        }

        if(camera.position.y > 15000) _e5 = true;
        if(_e5) scene.background.setHSL((Date.now()%3000)/3000, 0.8, 0.5);

        if(camera.position.y < 12 && speed > 2) _e7++; else _e7 = 0;
        if(_e7 > 120) speed = Math.min(speed + 0.1, maxSpeed * 1.8);

        if(Math.abs(rollVelocity) > 0.015) _e2++; else _e2 = 0;
        if(_e2 > 80) camera.fov = 130; else camera.fov = 75;
        camera.updateProjectionMatrix();

        if (speed < 0) speed = 0; 
        if (speed > maxSpeed && gravityAssist < 0.02 && _e7 <= 120) speed -= drag * 4; 
        if (speed > terminalVelocity) speed = terminalVelocity;

        pitchVelocity *= damping; rollVelocity *= damping; yawVelocity *= damping;
        camera.rotateX(pitchVelocity); camera.rotateZ(rollVelocity); camera.rotateY(yawVelocity); camera.translateZ(-speed);

        for (let i = activeProjectiles.length - 1; i >= 0; i--) {
            const projObj = activeProjectiles[i];
            const projSpeed = speed + 5;
            projObj.mesh.translateZ(-projSpeed); projObj.distance += projSpeed;
            let hitSomething = false;

            if(projObj.mesh.position.y > 11500 && projObj.mesh.position.z < -3500) _e6 = true;
            if(_e6) sun.material.color.setHSL((Date.now()%500)/500, 1, 0.5);

            // Check collision with other players
            if (projObj.isPlayerShot) {
                for (const [uuid, player] of otherPlayers.entries()) {
                    const distToPlayer = projObj.mesh.position.distanceTo(player.mesh.position);
                    if (distToPlayer < 10) {
                        // Hit another player
                        hitSomething = true;
                        createExplosion(projObj.mesh.position, 0.5);
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'hit',
                                uuid: myUUID,
                                target: uuid,
                                damage: 25,
                                shooter: myUUID
                            }));
                        }
                        break;
                    }
                }
            }

            for (let j = 0; j < buildings.length; j++) {
                const b = buildings[j];
                if (b.userData.isDestroyed) continue;
                const hitWidth = b.scale.x / 2; const hitDepth = b.scale.z / 2;
                const distX = Math.abs(projObj.mesh.position.x - b.position.x);
                const distZ = Math.abs(projObj.mesh.position.z - b.position.z);
                const distY = projObj.mesh.position.y;

                if (distX < hitWidth && distZ < hitDepth && distY > 0 && distY < b.scale.y) {
                    b.userData.health -= (_e1 > 42 ? 3 : 1);
                    hitSomething = true;
                    if (b.userData.health <= 0) {
                        b.userData.isDestroyed = true; b.visible = false; spawnVoxelDebris(b.position, b.scale);
                    } else {
                        b.material.color.setHex(0xff5555);
                        setTimeout(() => { if (!b.userData.isDestroyed) b.material.color.setHex(b.userData.baseColor); }, 100);
                    }
                    break;
                }
            }
            if (hitSomething || projObj.distance > 4000) { scene.remove(projObj.mesh); activeProjectiles.splice(i, 1); }
        }

        for (let i = activeDebris.length - 1; i >= 0; i--) {
            const d = activeDebris[i];
            d.mesh.position.add(d.velocity);
            d.velocity.y -= (_e8 ? 0.02 : 0.15);
            if (d.mesh.position.y < -50) { scene.remove(d.mesh); activeDebris.splice(i, 1); }
        }

        // Update explosion particles
        for (let i = explosionParticles.length - 1; i >= 0; i--) {
            const p = explosionParticles[i];
            p.mesh.position.add(p.velocity);
            p.life -= 0.02;
            p.mesh.material.opacity = p.life;
            p.mesh.scale.multiplyScalar(0.98);

            if (p.life <= 0) {
                scene.remove(p.mesh);
                explosionParticles.splice(i, 1);
            }
        }

        floor.position.x = camera.position.x; floor.position.z = camera.position.z;
        gridHelper.position.x = camera.position.x - (camera.position.x % 50);
        gridHelper.position.z = camera.position.z - (camera.position.z % 50);
        sun.position.x = camera.position.x; sun.position.z = camera.position.z - 4000;
        directionalLight.position.copy(sun.position);

        // Check collision with other players
        for (const [uuid, player] of otherPlayers.entries()) {
            const distToPlayer = camera.position.distanceTo(player.mesh.position);
            if (distToPlayer < 15 && !isDead && !hasSpawnProtection) {
                // Collision detected - both players die
                createExplosion(camera.position, 2);
                createExplosion(player.mesh.position, 2);

                // Kill self
                myHealth = 0;
                updateHealthDisplay();
                handleDeath();

                // Kill other player (only if they don't have spawn protection)
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'hit',
                        uuid: myUUID,
                        target: uuid,
                        damage: 100,
                        shooter: myUUID
                    }));
                }
                break;
            }
        }

        if (camera.position.y < 2 && !_e4) triggerCrash();

        buildings.forEach(b => {
            if (camera.position.z - b.position.z < -citySize / 2) { b.position.z -= citySize; resetBuilding(b); }
            if (camera.position.z - b.position.z > citySize / 2) { b.position.z += citySize; resetBuilding(b); }
            if (camera.position.x - b.position.x < -citySize / 2) { b.position.x -= citySize; resetBuilding(b); }
            if (camera.position.x - b.position.x > citySize / 2) { b.position.x += citySize; resetBuilding(b); }

            if(_e3 && !b.userData.isDestroyed) b.material.color.setHSL(Math.random(), 0.8, 0.5);
            if(_e9 && !b.userData._xG) { b.scale.y *= 4; b.userData._xG = true; }

            if (!b.userData.isDestroyed) {
                const distX = Math.abs(camera.position.x - b.position.x);
                const distZ = Math.abs(camera.position.z - b.position.z);
                const hitWidth = (b.scale.x / 2) + 5; const hitDepth = (b.scale.z / 2) + 5;
                if (distX < hitWidth && distZ < hitDepth && camera.position.y < b.scale.y && !_e4) triggerCrash();
            }
        });

        if(!_e5) {
            let altRatio = Math.max(0, Math.min(1, (camera.position.y - 7000) / 3000));
            let currentColor = skyColor.clone().lerp(spaceColor, altRatio);
            scene.background = currentColor; scene.fog.color = currentColor;
        }

        speedVal.innerText = Math.floor((speed / maxSpeed) * 450); altVal.innerText = Math.floor(camera.position.y * 10);
        const rollAngleDeg = camera.rotation.z * (180 / Math.PI);
        pitchLadder.style.transform = `rotate(${-rollAngleDeg}deg)`;

        // Send position update to server
        const now = Date.now();
        if (now - lastUpdateTime > UPDATE_INTERVAL && ws && ws.readyState === WebSocket.OPEN && !isDead) {
            lastUpdateTime = now;
            ws.send(JSON.stringify({
                type: 'updatePosition',
                uuid: myUUID,
                position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                rotation: { x: camera.quaternion.x, y: camera.quaternion.y, z: camera.quaternion.z, w: camera.quaternion.w }
            }));
        }
    }
    renderer.render(scene, camera);
}

function triggerCrash() {
    crashed = true; speed = 0;
    if (document.pointerLockElement === document.body) document.exitPointerLock();
    crashMsg.style.display = 'flex'; crashMsg.style.flexDirection = 'column'; crashMsg.style.alignItems = 'center';
    stallMsg.style.display = 'none'; 
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});