import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * 車子管理器
 * 負責創建、更新和管理軌道上的車子
 * 包含完整的避障系統：優先級、死鎖檢測、A*路徑規劃
 */
export class CarManager {
    constructor(scene) {
        this.scene = scene;
        this.cars = [];
        this.carSpeed = 2.0;
        this.trackGauge = 0; // 軌距
        this.gridMetrics = null;
        this.trackY = 0;
        this.stepX = 0;
        this.stepZ = 0;
        this.unloadFacingDirection = new THREE.Vector3(0, 0, -1);
        this.unloadFacingRotation = Math.atan2(
            this.unloadFacingDirection.x,
            this.unloadFacingDirection.z,
        );
        this.cargoBoxes = [];
        this.cargoMountOffset = 0;
        this.cargoFrontOffset = 0;

        // ⭐ 避障模式設定
        this.collisionMode = 'advanced'; // 'simple' | 'advanced'
        
        // 避障系統
        this.occupiedGrids = new Map(); // 當前占用的格子 key -> carId
        this.reservedPaths = new Map(); // 預約的路徑 carId -> Set<gridKey>
        this.gridReservations = new Map(); // 格子預約 gridKey -> carId
        this.carPriorities = new Map(); // 車輛優先級 carId -> priority
        this.waitingCars = new Set(); // 正在等待的車輛
        this.deadlockCheckInterval = 3000; // 死鎖檢查間隔（毫秒）
        this.lastDeadlockCheck = 0;
        this.maxWaitTime = 5000; // 最大等待時間（毫秒）
        
        // ⭐ 協作任務系統
        this.collaborativeTasks = new Map(); // taskId -> { targetCoord, assignedCars: [], cargo, status }
        this.taskCounter = 0;
    }

    /**
     * 創建軌道上的車子
     * @param {Object} gridMetrics - 網格度量資訊
     */
    createCars(gridMetrics) {
        this.gridMetrics = gridMetrics;
        const loader = new GLTFLoader();

        // 計算軌距（兩條軌道中心之間的距離）
        const laneWidth = Math.max(
            Math.min(gridMetrics.spacingX, gridMetrics.spacingZ) * 0.8,
            gridMetrics.boxWidth * 0.1,
        );
        this.trackGauge = laneWidth * 0.6;
        this.stepX = gridMetrics.boxWidth + gridMetrics.spacingX;
        this.stepZ = gridMetrics.boxDepth + gridMetrics.spacingZ;
        this.trackY = gridMetrics.pillarTopY + gridMetrics.boxHeight * 0.7;
        this.cargoMountOffset = gridMetrics.boxHeight * 0.8;
        this.cargoFrontOffset = (gridMetrics.boxDepth + gridMetrics.spacingZ) * 0.3;

        // 只創建兩台車：一台橫向，一台縱向
        const carConfigs = [
            {
                name: "車輛1",
                pathType: "horizontal",
                startOffset: 0,
                startCoord: { x: 0, z: 0 },
                priority: 1 // 優先級
            },
            {
                name: "車輛2",
                pathType: "vertical",
                startOffset: 0.25,
                startCoord: { x: gridMetrics.width - 1, z: 0 },
                priority: 2
            }
        ];

        return new Promise((resolve, reject) => {
            loader.load(
                "/car.glb",
                (gltf) => {
                    // 車子大小：兩格（兩個箱子的寬度加上間距）
                    const carScale = this.stepX * 1.1;

                    carConfigs.forEach((config) => {
                        const carClone = gltf.scene.clone();
                        this.rotateModules(carClone);
                        carClone.scale.set(carScale, carScale, carScale);

                        // 設置固定旋轉：所有車輛面向卸貨區
                        carClone.rotation.y = this.unloadFacingRotation;

                        carClone.castShadow = true;
                        carClone.receiveShadow = true;

                        const startCoord = config.startCoord || { x: 0, z: 0 };
                        const heading = this.unloadFacingDirection.clone();
                        const startPoint = this.getCargoAlignedPosition(startCoord, heading);
                        const path = [{ position: startPoint, coord: startCoord, direction: heading.clone() }];

                        carClone.position.copy(startPoint);

                        carClone.updateMatrixWorld(true);
                        const carBox = new THREE.Box3().setFromObject(carClone);
                        const carSize = carBox.getSize(new THREE.Vector3());
                        const carCenterWorld = carBox.getCenter(new THREE.Vector3());
                        const baseY = carBox.min.y + carSize.y * 0.45;
                        const forwardDirWorld = this.unloadFacingDirection.clone().normalize();
                        const headCenterWorld = new THREE.Vector3(
                            carCenterWorld.x,
                            baseY,
                            carCenterWorld.z,
                        ).add(forwardDirWorld.clone().multiplyScalar(carSize.z * 0.25));
                        const tailCenterWorld = new THREE.Vector3(
                            carCenterWorld.x,
                            baseY,
                            carCenterWorld.z,
                        ).add(forwardDirWorld.clone().multiplyScalar(-carSize.z * 0.25));
                        const mountOffsetFront = carClone.worldToLocal(headCenterWorld.clone());
                        const mountOffsetBack = carClone.worldToLocal(tailCenterWorld.clone());

                        this.scene.add(carClone);

                        const carId = `car-${this.cars.length + 1}`;

                        // 儲存車子資訊
                        const carData = {
                            id: carId,
                            model: carClone,
                            path: path,
                            pathIndex: 0,
                            name: config.name,
                            fixedRotation: this.unloadFacingRotation,
                            heading: heading,
                            currentCoord: { ...startCoord },
                            targetCoord: null,
                            cargo: null,
                            mountOffsets: {
                                front: mountOffsetFront,
                                back: mountOffsetBack,
                            },
                            // 避障相關屬性
                            isWaiting: false,
                            waitStartTime: 0,
                            waitReason: null,
                            blockedBy: null, // 被哪台車擋住
                            priority: config.priority || 0,
                            pathCost: 0, // 路徑成本
                            hasCargoTask: false, // 是否有貨物任務
                        };

                        this.cars.push(carData);
                        this.carPriorities.set(carId, config.priority || 0);

                        // 占用初始位置
                        const key = `${startCoord.x}-${startCoord.z}`;
                        this.occupiedGrids.set(key, carId);

                        console.log(`✓ ${config.name} 已加載，優先級: ${config.priority}`);
                    });

                    console.log(`✓ 總共加載了 ${this.cars.length} 台車`);
                    console.log("  - 軌距:", this.trackGauge.toFixed(3));
                    console.log("  - 車子縮放:", carScale.toFixed(3));
                    console.log("  - 軌道高度:", this.trackY.toFixed(3));

                    resolve(this.getCarOptions());
                },
                (progress) => {
                    console.log(
                        "車子加載進度:",
                        (progress.loaded / progress.total) * 100 + "%",
                    );
                },
                (error) => {
                    console.error("❌ 加載 car.glb 時出錯:", error);
                    reject(error);
                }
            );
        });
    }

    gridToWorld(xIndex, zIndex) {
        if (!this.gridMetrics) return new THREE.Vector3();
        const worldX = this.gridMetrics.startX + xIndex * this.stepX - this.gridMetrics.modelCenter.x;
        const worldZ = this.gridMetrics.startZ + zIndex * this.stepZ - this.gridMetrics.modelCenter.z;
        return new THREE.Vector3(worldX, this.trackY, worldZ);
    }

    rotationToDirection(rotation) {
        const direction = new THREE.Vector3(Math.sin(rotation), 0, Math.cos(rotation));
        if (Math.abs(direction.x) > Math.abs(direction.z)) {
            return new THREE.Vector3(Math.sign(direction.x), 0, 0);
        }
        return new THREE.Vector3(0, 0, Math.sign(direction.z) || 1);
    }

    getAxisStep(direction) {
        if (Math.abs(direction.x) > Math.abs(direction.z)) {
            return this.stepX;
        }
        return this.stepZ;
    }

    getCargoAlignedPosition(coord, direction) {
        const dir = direction.clone();
        const axisStep = this.getAxisStep(dir);
        const offset = dir.lengthSq() > 0 ? dir.clone().normalize().multiplyScalar(-axisStep / 2) : new THREE.Vector3();
        return this.gridToWorld(coord.x, coord.z).add(offset);
    }

    getShelfWorldPosition({ x, y, z }) {
        if (!this.gridMetrics) return new THREE.Vector3();
        const xPos = this.gridMetrics.startX + x * (this.gridMetrics.boxWidth + this.gridMetrics.spacingX) - this.gridMetrics.modelCenter.x;
        const zPos = this.gridMetrics.startZ + z * (this.gridMetrics.boxDepth + this.gridMetrics.spacingZ) - this.gridMetrics.modelCenter.z;
        const yPos = this.gridMetrics.startY + y * (this.gridMetrics.boxHeight + this.gridMetrics.spacingY) - this.gridMetrics.modelCenter.y;
        return new THREE.Vector3(xPos, yPos, zPos);
    }

    applyWorldScale(object, targetWorldScale, parent) {
        const parentWorldScale = new THREE.Vector3(1, 1, 1);
        if (parent) {
            parent.getWorldScale(parentWorldScale);
        }
        object.scale.set(
            targetWorldScale.x / parentWorldScale.x,
            targetWorldScale.y / parentWorldScale.y,
            targetWorldScale.z / parentWorldScale.z,
        );
    }

    getCarOptions() {
        return this.cars.map(car => ({
            id: car.id,
            label: car.name,
        }));
    }

    getCarById(carId) {
        return this.cars.find(car => car.id === carId);
    }

    isCarReady(carId) {
        const car = this.getCarById(carId);
        return this.isCarReadyForAction(car);
    }

    hasCargo(carId) {
        const car = this.getCarById(carId);
        return Boolean(car?.cargo);
    }

    getDestinationOptions() {
        if (!this.gridMetrics) return [];
        const options = [];
        for (let z = 0; z < this.gridMetrics.depth; z++) {
            for (let x = 0; x < this.gridMetrics.width; x++) {
                const id = `${x}-${z}`;
                options.push({
                    id,
                    label: `X${x + 1} - Z${z + 1}`,
                });
            }
        }
        return options;
    }

    setCargoBoxes(boxes = []) {
        this.cargoBoxes = boxes;
    }

    /**
     * ⭐ 切換避障模式
     * @param {string} mode - 'simple' 或 'advanced'
     */
    setCollisionMode(mode) {
        if (mode !== 'simple' && mode !== 'advanced') {
            console.warn('無效的避障模式，使用預設值 advanced');
            return;
        }
        this.collisionMode = mode;
        console.log(`🔧 避障模式已切換至: ${mode === 'simple' ? '簡單避讓' : '完整系統'}`);
    }

    /**
     * ⭐ 獲取當前避障模式
     */
    getCollisionMode() {
        return this.collisionMode;
    }

    /**
     * ⭐ 設置車輛優先級
     */
    setCarPriority(carId, priority) {
        this.carPriorities.set(carId, priority);
        const car = this.getCarById(carId);
        if (car) {
            car.priority = priority;
            console.log(`✓ ${car.name} 優先級已設置為 ${priority}`);
        }
    }

    /**
     * ⭐ 創建協作任務
     * @param {Array} carIds - 參與的車輛ID列表
     * @param {Object} targetCoord - 目標座標 {x, z}
     * @param {string} taskType - 任務類型 'pickup' | 'delivery'
     */
    createCollaborativeTask(carIds, targetCoord, taskType = 'pickup') {
        if (carIds.length === 0) {
            return { success: false, message: '至少需要一台車輛' };
        }

        const taskId = `task-${++this.taskCounter}`;
        const assignedCars = [];

        // 驗證車輛
        for (const carId of carIds) {
            const car = this.getCarById(carId);
            if (!car) {
                return { success: false, message: `找不到車輛: ${carId}` };
            }
            assignedCars.push(car);
        }

        // 創建任務
        const task = {
            id: taskId,
            targetCoord,
            assignedCars: carIds,
            taskType,
            status: 'pending', // pending | in-progress | completed | failed
            createdAt: Date.now(),
            cargo: null,
        };

        this.collaborativeTasks.set(taskId, task);

        // 提升參與車輛的優先級
        assignedCars.forEach((car, index) => {
            const basePriority = this.carPriorities.get(car.id) || 0;
            const taskPriority = basePriority + 20 + (assignedCars.length - index); // 協作任務高優先級
            this.carPriorities.set(car.id, taskPriority);
            car.collaborativeTaskId = taskId;
            car.collaborativeRole = index === 0 ? 'leader' : 'follower';
        });

        console.log(`✓ 協作任務 ${taskId} 已創建，參與車輛: ${carIds.join(', ')}`);
        return { success: true, taskId, message: `協作任務已創建` };
    }

    /**
     * ⭐ 執行協作任務
     */
    executeCollaborativeTask(taskId) {
        const task = this.collaborativeTasks.get(taskId);
        if (!task) {
            return { success: false, message: '任務不存在' };
        }

        if (task.status !== 'pending') {
            return { success: false, message: `任務狀態錯誤: ${task.status}` };
        }

        // 所有車輛前往目標位置
        const results = [];
        for (const carId of task.assignedCars) {
            const result = this.setDestination(carId, `${task.targetCoord.x}-${task.targetCoord.z}`);
            results.push(result);
        }

        task.status = 'in-progress';
        
        const allSuccess = results.every(r => r.success);
        if (allSuccess) {
            return { success: true, message: `協作任務執行中，${task.assignedCars.length} 台車輛前往目標` };
        } else {
            return { success: false, message: '部分車輛路徑規劃失敗' };
        }
    }

    /**
     * ⭐ 完成協作任務
     */
    completeCollaborativeTask(taskId) {
        const task = this.collaborativeTasks.get(taskId);
        if (!task) return;

        task.status = 'completed';
        
        // 恢復車輛優先級
        for (const carId of task.assignedCars) {
            const car = this.getCarById(carId);
            if (car) {
                const basePriority = car.priority - 20 - task.assignedCars.length;
                this.carPriorities.set(carId, Math.max(0, basePriority));
                car.collaborativeTaskId = null;
                car.collaborativeRole = null;
            }
        }

        console.log(`✓ 協作任務 ${taskId} 已完成`);
    }

    /**
     * ⭐ 取消協作任務
     */
    cancelCollaborativeTask(taskId) {
        const task = this.collaborativeTasks.get(taskId);
        if (!task) return;

        task.status = 'failed';
        
        // 恢復車輛優先級並停止
        for (const carId of task.assignedCars) {
            const car = this.getCarById(carId);
            if (car) {
                car.path = [];
                car.pathIndex = 0;
                car.targetCoord = null;
                const basePriority = car.priority - 20 - task.assignedCars.length;
                this.carPriorities.set(carId, Math.max(0, basePriority));
                car.collaborativeTaskId = null;
                car.collaborativeRole = null;
            }
        }

        this.collaborativeTasks.delete(taskId);
        console.log(`⚠️ 協作任務 ${taskId} 已取消`);
    }

    /**
     * ⭐ 獲取所有協作任務
     */
    getAllCollaborativeTasks() {
        return Array.from(this.collaborativeTasks.values());
    }

    /**
     *  計算曼哈頓距離（用於 A* 啟發式）
     */
    manhattanDistance(a, b) {
        return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    }

    /**
     *  檢查格子是否被其他車占用或預約
     */
    isGridBlocked(x, z, carId) {
        if (x < 0 || x >= this.gridMetrics.width || z < 0 || z >= this.gridMetrics.depth) {
            return true;
        }

        const key = `${x}-${z}`;
        const occupier = this.occupiedGrids.get(key);
        const reserver = this.gridReservations.get(key);

        // 如果是自己占用或預約，不算被擋
        if ((occupier && occupier !== carId) || (reserver && reserver !== carId)) {
            return true;
        }

        return false;
    }

    /**
     * A* 路徑規劃算法（比 BFS 更智能）
     */
    findGridPathAStar(startCoord, targetCoord, carId) {
        const openSet = new Map(); // 待探索節點
        const closedSet = new Set(); // 已探索節點
        const gScore = new Map(); // 從起點到該點的實際成本
        const fScore = new Map(); // gScore + 啟發式估計
        const cameFrom = new Map(); // 路徑重建用

        const startKey = `${startCoord.x}-${startCoord.z}`;
        const targetKey = `${targetCoord.x}-${targetCoord.z}`;

        gScore.set(startKey, 0);
        fScore.set(startKey, this.manhattanDistance(startCoord, targetCoord));
        openSet.set(startKey, startCoord);

        const directions = [
            { x: 1, z: 0 },
            { x: -1, z: 0 },
            { x: 0, z: 1 },
            { x: 0, z: -1 },
        ];

        while (openSet.size > 0) {
            // 找到 fScore 最小的節點
            let currentKey = null;
            let lowestF = Infinity;
            for (const [key, coord] of openSet) {
                const f = fScore.get(key) || Infinity;
                if (f < lowestF) {
                    lowestF = f;
                    currentKey = key;
                }
            }

            if (!currentKey) break;

            const current = openSet.get(currentKey);

            // 到達目標
            if (currentKey === targetKey) {
                const path = [];
                let key = currentKey;
                while (key) {
                    const [x, z] = key.split("-").map(Number);
                    path.unshift({ x, z });
                    key = cameFrom.get(key);
                }
                return path;
            }

            openSet.delete(currentKey);
            closedSet.add(currentKey);

            // 探索鄰居
            for (const dir of directions) {
                const nx = current.x + dir.x;
                const nz = current.z + dir.z;
                const neighborKey = `${nx}-${nz}`;

                if (closedSet.has(neighborKey)) continue;

                // 檢查是否被阻擋（但允許目標點）
                const isTarget = nx === targetCoord.x && nz === targetCoord.z;
                if (!isTarget && this.isGridBlocked(nx, nz, carId)) {
                    continue;
                }

                const tentativeG = (gScore.get(currentKey) || 0) + 1;

                if (!openSet.has(neighborKey)) {
                    openSet.set(neighborKey, { x: nx, z: nz });
                } else if (tentativeG >= (gScore.get(neighborKey) || Infinity)) {
                    continue;
                }

                // 這條路徑更好
                cameFrom.set(neighborKey, currentKey);
                gScore.set(neighborKey, tentativeG);
                fScore.set(neighborKey, tentativeG + this.manhattanDistance({ x: nx, z: nz }, targetCoord));
            }
        }

        return null; // 找不到路徑
    }

    /**
     * ⭐ 預約路徑上的所有格子
     */
    reservePathGrids(carId, pathCoords) {
        // 清除舊的預約
        for (const [key, id] of this.gridReservations) {
            if (id === carId) {
                this.gridReservations.delete(key);
            }
        }

        // 預約新路徑
        const reserved = new Set();
        pathCoords.forEach(coord => {
            const key = `${coord.x}-${coord.z}`;
            this.gridReservations.set(key, carId);
            reserved.add(key);
        });
        this.reservedPaths.set(carId, reserved);
    }

    /**
     * ⭐ 釋放路徑預約
     */
    releasePathReservation(carId) {
        const reserved = this.reservedPaths.get(carId);
        if (reserved) {
            for (const key of reserved) {
                if (this.gridReservations.get(key) === carId) {
                    this.gridReservations.delete(key);
                }
            }
        }
        this.reservedPaths.delete(carId);
    }

    /**
     * ⭐ 檢測死鎖並解決
     */
    detectAndResolveDeadlock() {
        const now = Date.now();
        if (now - this.lastDeadlockCheck < this.deadlockCheckInterval) {
            return;
        }
        this.lastDeadlockCheck = now;

        // 找出所有等待中的車輛
        const waitingCars = this.cars.filter(car => car.isWaiting);
        if (waitingCars.length < 2) return;

        // 檢查循環等待
        const waitGraph = new Map(); // carId -> blockedBy carId
        waitingCars.forEach(car => {
            if (car.blockedBy) {
                waitGraph.set(car.id, car.blockedBy);
            }
        });

        // 使用深度優先搜索檢測環
        const detectCycle = (start, visited = new Set(), recStack = new Set()) => {
            visited.add(start);
            recStack.add(start);

            const next = waitGraph.get(start);
            if (next) {
                if (!visited.has(next)) {
                    if (detectCycle(next, visited, recStack)) {
                        return true;
                    }
                } else if (recStack.has(next)) {
                    return true; // 找到環
                }
            }

            recStack.delete(start);
            return false;
        };

        for (const carId of waitGraph.keys()) {
            if (detectCycle(carId)) {
                console.warn(`⚠️ 檢測到死鎖！涉及車輛：${Array.from(waitGraph.keys()).join(', ')}`);
                this.resolveDeadlock(waitGraph);
                break;
            }
        }
    }

    /**
     * ⭐ 解決死鎖 - 讓優先級最低的車輛讓路
     */
    resolveDeadlock(waitGraph) {
        // 找出死鎖中優先級最低的車輛
        let lowestPriorityCar = null;
        let lowestPriority = Infinity;

        for (const carId of waitGraph.keys()) {
            const priority = this.carPriorities.get(carId) || 0;
            if (priority < lowestPriority) {
                lowestPriority = priority;
                lowestPriorityCar = this.getCarById(carId);
            }
        }

        if (lowestPriorityCar) {
            console.log(`🔄 ${lowestPriorityCar.name} (優先級最低) 讓路，返回起點`);
            
            // 讓車輛返回起點或隨機安全位置
            this.moveCarToSafePosition(lowestPriorityCar);
        }
    }

    /**
     * ⭐ 移動車輛到安全位置（避免死鎖）
     */
    moveCarToSafePosition(car) {
        // 嘗試找一個空閒的格子
        for (let z = 0; z < this.gridMetrics.depth; z++) {
            for (let x = 0; x < this.gridMetrics.width; x++) {
                const key = `${x}-${z}`;
                if (!this.occupiedGrids.has(key) && !this.gridReservations.has(key)) {
                    // 找到空閒格子，規劃路徑
                    const path = this.findGridPathAStar(car.currentCoord, { x, z }, car.id);
                    if (path && path.length > 0) {
                        const carHeading = car.heading?.clone() || this.unloadFacingDirection.clone();
                        car.path = path.map((coord) => ({
                            coord,
                            direction: carHeading.clone(),
                            position: this.getCargoAlignedPosition(coord, carHeading),
                        }));
                        car.pathIndex = 0;
                        car.isWaiting = false;
                        car.blockedBy = null;
                        car.targetCoord = null; // 取消原目標
                        this.reservePathGrids(car.id, path);
                        console.log(`✅ ${car.name} 移動到安全位置 (${x}, ${z})`);
                        return true;
                    }
                }
            }
        }
        
        // 如果找不到，強制清空路徑
        car.path = [];
        car.pathIndex = 0;
        car.isWaiting = false;
        car.blockedBy = null;
        car.targetCoord = null;
        this.releasePathReservation(car.id);
        console.warn(`⚠️ ${car.name} 無法找到安全位置，停止移動`);
        return false;
    }

    setDestination(carId, destinationId) {
        const car = this.cars.find(c => c.id === carId);
        if (!car || !this.gridMetrics) return { success: false, message: "找不到車子" };

        const [xStr, zStr] = destinationId.split("-");
        const targetCoord = { x: Number(xStr), z: Number(zStr) };

        if (Number.isNaN(targetCoord.x) || Number.isNaN(targetCoord.z)) {
            return { success: false, message: "目的地格式不正確" };
        }

        if (
            targetCoord.x < 0 ||
            targetCoord.x >= this.gridMetrics.width ||
            targetCoord.z < 0 ||
            targetCoord.z >= this.gridMetrics.depth
        ) {
            return { success: false, message: "目的地超出架位範圍" };
        }

        // 使用 A* 算法規劃路徑
        const pathCoords = this.findGridPathAStar(car.currentCoord, targetCoord, car.id);
        if (!pathCoords) {
            return { success: false, message: "無法找到路徑（可能被阻擋）" };
        }

        const carHeading = car.heading?.clone() || this.unloadFacingDirection.clone();
        const newPath = pathCoords.map((coord) => ({
            coord,
            direction: carHeading.clone(),
            position: this.getCargoAlignedPosition(coord, carHeading),
        }));

        car.path = newPath;
        car.pathIndex = 0;
        car.targetCoord = targetCoord;
        car.isWaiting = false;
        car.blockedBy = null;
        car.pathCost = pathCoords.length;

        if (newPath.length > 0) {
            car.heading = this.unloadFacingDirection.clone();
        }

        // 預約整條路徑
        this.reservePathGrids(car.id, pathCoords);

        return { success: true, message: `${car.name} 路線已更新（${pathCoords.length} 步）` };
    }

    /**
     * ⭐ 兼容舊的 BFS 方法（作為備用）
     */
    findGridPath(startCoord, targetCoord, carId) {
        return this.findGridPathAStar(startCoord, targetCoord, carId);
    }

    isCarReadyForAction(carData) {
        if (!carData) return false;
        if (carData.path.length === 0) return true;
        if (carData.pathIndex === carData.path.length - 1) {
            const target = carData.path[carData.path.length - 1];
            return carData.model.position.distanceTo(target.position) < 0.05;
        }
        return false;
    }

    getShelfBoxesAtCoord(coord) {
        if (!this.cargoBoxes || this.cargoBoxes.length === 0) return [];
        return this.cargoBoxes.filter((box) => {
            const gridCoord = box.userData?.gridCoord;
            return (
                gridCoord &&
                gridCoord.x === coord.x &&
                gridCoord.z === coord.z &&
                !box.userData?.attachedToCarId &&
                !box.userData?.isPicked
            );
        });
    }

    findTopCargoAtCoord(coord) {
        const candidates = this.getShelfBoxesAtCoord(coord);
        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            const ay = a.userData?.gridCoord?.y ?? 0;
            const by = b.userData?.gridCoord?.y ?? 0;
            return by - ay;
        });

        return candidates[0];
    }

    attachCargoToCar(carData, cargoBox, mountPosition = "front") {
        const mountOffset = carData.mountOffsets?.[mountPosition]?.clone()
            || carData.mountOffsets?.front?.clone()
            || new THREE.Vector3(0, this.cargoMountOffset || 0, 0);

        if (!cargoBox.userData.originalScale) {
            cargoBox.userData.originalScale = cargoBox.scale.clone();
        }
        if (!cargoBox.userData.originalParent) {
            cargoBox.userData.originalParent = cargoBox.parent;
        }

        cargoBox.userData.isPicked = true;
        cargoBox.userData.attachedToCarId = carData.id;
        cargoBox.userData.originalParent = cargoBox.parent;

        carData.model.attach(cargoBox);
        cargoBox.position.copy(mountOffset);
        cargoBox.rotation.set(0, 0, 0);
        if (cargoBox.userData.originalWorldScale) {
            this.applyWorldScale(cargoBox, cargoBox.userData.originalWorldScale, carData.model);
        } else {
            cargoBox.scale.copy(cargoBox.userData.originalScale);
        }
        cargoBox.updateMatrixWorld(true);

        carData.cargo = cargoBox;
        carData.hasCargoTask = true;
        
        // 提高優先級（有貨物的車優先）
        const currentPriority = this.carPriorities.get(carData.id) || 0;
        this.carPriorities.set(carData.id, currentPriority + 10);
    }

    pickUpCargo(carId) {
        const car = this.cars.find(c => c.id === carId);
        if (!car) return { success: false, message: "找不到車輛" };
        if (!this.gridMetrics) return { success: false, message: "網格資訊未初始化" };

        if (!this.isCarReadyForAction(car)) {
            return { success: false, message: "請先讓車輛抵達目標位置" };
        }

        if (car.cargo) {
            return { success: false, message: `${car.name} 已載有貨物` };
        }

        const cargoBox = this.findTopCargoAtCoord(car.currentCoord);
        if (!cargoBox) {
            return { success: false, message: "該位置沒有可拿取的貨物" };
        }

        this.attachCargoToCar(car, cargoBox);
        return { success: true, message: `${car.name} 已拿取 ${cargoBox.userData.productName}` };
    }

    getNextShelfLevel(coord) {
        const stacks = this.getShelfBoxesAtCoord(coord);
        const highestLevel = stacks.reduce((max, box) => {
            const level = box.userData?.gridCoord?.y ?? -1;
            return Math.max(max, level);
        }, -1);
        return highestLevel + 1;
    }

    dropCargo(carId) {
        const car = this.cars.find(c => c.id === carId);
        if (!car) return { success: false, message: "找不到車輛" };
        if (!this.gridMetrics) return { success: false, message: "網格資訊未初始化" };

        if (!car.cargo) {
            return { success: false, message: `${car.name} 沒有貨物可放下` };
        }

        if (!this.isCarReadyForAction(car)) {
            return { success: false, message: "請先讓車輛抵達目標位置" };
        }

        const nextLevel = this.getNextShelfLevel(car.currentCoord);
        if (nextLevel >= this.gridMetrics.height + 1) {
            return { success: false, message: "貨物堆疊已達架子高度上限" };
        }

        const cargoBox = car.cargo;
        const worldPosition = this.getShelfWorldPosition({
            x: car.currentCoord.x,
            y: nextLevel,
            z: car.currentCoord.z,
        });

        const parent = cargoBox.userData.originalParent || this.scene;
        const localPosition = worldPosition.clone();
        parent.worldToLocal(localPosition);
        parent.attach(cargoBox);

        cargoBox.position.copy(localPosition);
        cargoBox.rotation.set(0, 0, 0);
        if (cargoBox.userData.originalWorldScale) {
            this.applyWorldScale(cargoBox, cargoBox.userData.originalWorldScale, parent);
        } else if (cargoBox.userData.originalScale) {
            cargoBox.scale.copy(cargoBox.userData.originalScale);
        }
        cargoBox.updateMatrixWorld(true);

        cargoBox.userData.gridCoord = { x: car.currentCoord.x, y: nextLevel, z: car.currentCoord.z };
        cargoBox.userData.isPicked = false;
        cargoBox.userData.attachedToCarId = null;
        cargoBox.userData.originalParent = parent;

        car.cargo = null;
        car.hasCargoTask = false;
        
        // 恢復優先級
        const currentPriority = this.carPriorities.get(car.id) || 0;
        this.carPriorities.set(car.id, Math.max(0, currentPriority - 10));

        return { success: true, message: `${car.name} 已放下 ${cargoBox.userData.productName}` };
    }

    /**
     * ⭐ 更新所有車子的位置（支援兩種避障模式）
     * @param {number} delta - 時間增量
     */
    update(delta) {
        if (this.cars.length === 0) return;

        // 更新當前占用的格子
        this.occupiedGrids.clear();
        this.cars.forEach(carData => {
            const key = `${carData.currentCoord.x}-${carData.currentCoord.z}`;
            this.occupiedGrids.set(key, carData.id);
        });

        // 根據模式選擇更新方法
        if (this.collisionMode === 'simple') {
            this.updateSimpleMode(delta);
        } else {
            this.updateAdvancedMode(delta);
        }
    }

    /**
     * ⭐ 簡單避讓模式更新
     */
    updateSimpleMode(delta) {
        this.cars.forEach(carData => {
            const { model, path } = carData;

            // 車輛保持面向卸貨區，不隨路徑轉向
            model.rotation.y = this.unloadFacingRotation;

            if (path.length === 0) {
                carData.isWaiting = false;
                carData.blockedBy = null;
                return;
            }

            // 計算移動距離
            const moveDistance = this.carSpeed * delta;
            let remainingDistance = moveDistance;

            while (remainingDistance > 0 && path.length > 0) {
                const currentPos = model.position;
                const targetPoint = path[carData.pathIndex];

                // ⭐ 簡單模式：只檢查碰撞，不重新規劃
                const nextKey = `${targetPoint.coord.x}-${targetPoint.coord.z}`;
                const occupier = this.occupiedGrids.get(nextKey);

                if (occupier && occupier !== carData.id) {
                    if (!carData.isWaiting) {
                        carData.isWaiting = true;
                        carData.waitStartTime = Date.now();
                        console.log(`🚗 ${carData.name} 等待中... (簡單模式)`);
                    }
                    break; // 停止移動，等待
                }

                // 恢復移動
                if (carData.isWaiting) {
                    carData.isWaiting = false;
                    console.log(`✅ ${carData.name} 繼續移動`);
                }

                const direction = new THREE.Vector3()
                    .subVectors(targetPoint.position, currentPos);
                const distanceToTarget = direction.length();

                if (distanceToTarget <= remainingDistance) {
                    model.position.copy(targetPoint.position);
                    carData.currentCoord = { ...targetPoint.coord };
                    remainingDistance -= distanceToTarget;

                    if (carData.pathIndex < path.length - 1) {
                        carData.pathIndex += 1;
                    } else {
                        remainingDistance = 0;
                    }
                } else {
                    direction.normalize();
                    model.position.addScaledVector(direction, remainingDistance);
                    remainingDistance = 0;
                }
            }

            const reachedEnd = path.length > 0 &&
                carData.pathIndex === path.length - 1 &&
                model.position.distanceTo(path[path.length - 1].position) < 0.001;

            if (reachedEnd) {
                carData.path = [];
                carData.pathIndex = 0;
                carData.targetCoord = null;
                carData.heading = this.unloadFacingDirection.clone();
                carData.isWaiting = false;
                carData.blockedBy = null;
                carData.waitReason = null;

                // 釋放路徑預約
                this.releasePathReservation(carData.id);
                
                console.log(`🎯 ${carData.name} 已到達目的地`);
            }
        });
    }

    /**
     * ⭐ 完整避障模式更新
     */
    updateAdvancedMode(delta) {
        // 定期檢測死鎖
        this.detectAndResolveDeadlock();

        this.cars.forEach(carData => {
            const { model, path } = carData;

            // 車輛保持面向卸貨區，不隨路徑轉向
            model.rotation.y = this.unloadFacingRotation;

            if (path.length === 0) {
                carData.isWaiting = false;
                carData.blockedBy = null;
                return;
            }

            // 計算移動距離
            const moveDistance = this.carSpeed * delta;
            let remainingDistance = moveDistance;

            while (remainingDistance > 0 && path.length > 0) {
                const currentPos = model.position;
                const targetPoint = path[carData.pathIndex];

                // ⭐ 完整模式：碰撞檢測 + 優先級 + 重新規劃
                const nextKey = `${targetPoint.coord.x}-${targetPoint.coord.z}`;
                const occupier = this.occupiedGrids.get(nextKey);

                if (occupier && occupier !== carData.id) {
                    const occupierCar = this.getCarById(occupier);
                    
                    // 比較優先級
                    const myPriority = this.carPriorities.get(carData.id) || 0;
                    const theirPriority = this.carPriorities.get(occupier) || 0;

                    if (!carData.isWaiting) {
                        carData.isWaiting = true;
                        carData.waitStartTime = Date.now();
                        carData.blockedBy = occupier;
                        carData.waitReason = `被 ${occupierCar?.name || occupier} 阻擋`;
                        console.log(`🚗 ${carData.name} (優先級${myPriority}) 等待 ${occupierCar?.name || occupier} (優先級${theirPriority}) 離開 (${nextKey})`);
                    }

                    // 等待超時處理
                    const waitTime = Date.now() - carData.waitStartTime;
                    if (waitTime > this.maxWaitTime) {
                        // 如果我優先級更高，嘗試讓對方讓路
                        if (myPriority > theirPriority && occupierCar && !occupierCar.hasCargoTask) {
                            console.log(`⚠️ ${carData.name} 等待超時且優先級更高，請求 ${occupierCar.name} 讓路`);
                            this.moveCarToSafePosition(occupierCar);
                        } else if (carData.targetCoord) {
                            // 否則自己重新規劃路徑
                            console.log(`⚠️ ${carData.name} 等待超時，重新規劃路徑...`);
                            const newPath = this.findGridPathAStar(carData.currentCoord, carData.targetCoord, carData.id);
                            if (newPath && newPath.length > 1) {
                                const carHeading = carData.heading?.clone() || this.unloadFacingDirection.clone();
                                carData.path = newPath.map((coord) => ({
                                    coord,
                                    direction: carHeading.clone(),
                                    position: this.getCargoAlignedPosition(coord, carHeading),
                                }));
                                carData.pathIndex = 0;
                                carData.isWaiting = false;
                                carData.blockedBy = null;
                                this.reservePathGrids(carData.id, newPath);
                            } else {
                                // 重新規劃失敗，延長等待時間
                                carData.waitStartTime = Date.now();
                            }
                        }
                    }
                    break;
                }

                // 恢復非等待狀態
                if (carData.isWaiting) {
                    carData.isWaiting = false;
                    carData.blockedBy = null;
                    carData.waitReason = null;
                    console.log(`✅ ${carData.name} 繼續移動`);
                }

                const direction = new THREE.Vector3()
                    .subVectors(targetPoint.position, currentPos);
                const distanceToTarget = direction.length();

                if (distanceToTarget <= remainingDistance) {
                    model.position.copy(targetPoint.position);
                    carData.currentCoord = { ...targetPoint.coord };
                    remainingDistance -= distanceToTarget;

                    if (carData.pathIndex < path.length - 1) {
                        carData.pathIndex += 1;
                    } else {
                        remainingDistance = 0;
                    }
                } else {
                    direction.normalize();
                    model.position.addScaledVector(direction, remainingDistance);
                    remainingDistance = 0;
                }
            }

            const reachedEnd = path.length > 0 &&
                carData.pathIndex === path.length - 1 &&
                model.position.distanceTo(path[path.length - 1].position) < 0.001;

            if (reachedEnd) {
                carData.path = [];
                carData.pathIndex = 0;
                carData.targetCoord = null;
                carData.heading = this.unloadFacingDirection.clone();
                carData.isWaiting = false;
                carData.blockedBy = null;
                carData.waitReason = null;

                // 釋放路徑預約
                this.releasePathReservation(carData.id);
                
                console.log(`🎯 ${carData.name} 已到達目的地`);

                // 檢查是否是協作任務
                if (carData.collaborativeTaskId) {
                    this.checkCollaborativeTaskProgress(carData.collaborativeTaskId);
                }
            }
        });
    }

    /**
     * ⭐ 檢查協作任務進度
     */
    checkCollaborativeTaskProgress(taskId) {
        const task = this.collaborativeTasks.get(taskId);
        if (!task || task.status !== 'in-progress') return;

        // 檢查所有車輛是否到達
        const allArrived = task.assignedCars.every(carId => {
            const car = this.getCarById(carId);
            return car && car.path.length === 0 && 
                   car.currentCoord.x === task.targetCoord.x && 
                   car.currentCoord.z === task.targetCoord.z;
        });

        if (allArrived) {
            console.log(`✓ 協作任務 ${taskId} - 所有車輛已到達目標`);
            // 可以在這裡自動執行下一步操作
        }
    }

    /**
     * 清理所有車子資源
     */
    dispose() {
        this.cars.forEach(carData => {
            if (carData.model) {
                carData.model.traverse((child) => {
                    if (child.isMesh) {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (Array.isArray(child.material)) {
                                child.material.forEach((material) => material.dispose());
                            } else {
                                child.material.dispose();
                            }
                        }
                    }
                });
                this.scene.remove(carData.model);
            }
        });
        this.cars = [];
        this.occupiedGrids.clear();
        this.reservedPaths.clear();
        this.gridReservations.clear();
        this.carPriorities.clear();
        this.waitingCars.clear();
    }

    /**
     * 設置車子速度
     * @param {number} speed - 新的速度值
     */
    setSpeed(speed) {
        this.carSpeed = speed;
    }

    /**
     * 獲取軌距
     * @returns {number} 軌距值
     */
    getTrackGauge() {
        return this.trackGauge;
    }

    rotateModules(carModel) {
        const flipMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
        carModel.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;

            child.geometry = child.geometry.clone();
            child.geometry.applyMatrix4(flipMatrix);
            child.geometry.computeBoundingBox();
            child.geometry.computeBoundingSphere();
        });
    }

    /**
     * ⭐ 獲取車輛狀態信息（用於調試和可視化）
     */
    getCarStatus(carId) {
        const car = this.getCarById(carId);
        if (!car) return null;

        return {
            id: car.id,
            name: car.name,
            currentCoord: car.currentCoord,
            targetCoord: car.targetCoord,
            isWaiting: car.isWaiting,
            waitReason: car.waitReason,
            blockedBy: car.blockedBy,
            priority: this.carPriorities.get(car.id),
            hasCargo: Boolean(car.cargo),
            pathLength: car.path.length,
            pathIndex: car.pathIndex,
        };
    }

    /**
     * ⭐ 獲取所有車輛狀態
     */
    getAllCarStatus() {
        return this.cars.map(car => this.getCarStatus(car.id));
    }

    /**
     * ⭐ 獲取系統狀態摘要
     */
    getSystemStatus() {
        return {
            collisionMode: this.collisionMode,
            totalCars: this.cars.length,
            activeTasks: this.collaborativeTasks.size,
            waitingCars: this.cars.filter(c => c.isWaiting).length,
            movingCars: this.cars.filter(c => !c.isWaiting && c.path.length > 0).length,
            idleCars: this.cars.filter(c => c.path.length === 0).length,
        };
    }
}