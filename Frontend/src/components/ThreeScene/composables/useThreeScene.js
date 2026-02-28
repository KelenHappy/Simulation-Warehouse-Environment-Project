import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ref } from "vue";
import { convertBoxesToCargoData, saveCargoDataToBackend } from "../../../utils/cargoStorage.js";
import { CarManager } from "../../../utils/carManager.js";
import { createScene } from '../utils/sceneSetup';
import { createBoxGrid } from '../utils/boxGrid';
import { createTrackSystem } from '../utils/trackSystem';
import { createPlayer } from '../utils/player';
import { setupInputHandlers } from '../utils/inputHandlers';
import { setupHoverDetection } from '../utils/hoverDetection';
import { unloadBays, unloadAreaCells } from '../../../utils/warehouseConfig.js';

export function useThreeScene({ container, moveSpeed, hoveredBoxInfo, tooltipPosition }) {
    let scene, camera, renderer, boxes = [], baseModel = null, trackPieces = [];
    let currentModelSize = null;
    let gridMetricsCache = null;
    let player = null, carManager = null;
    let yaw = 0, pitch = -0.3;
    const cameraOffset = new THREE.Vector3(0, 2, 6);
    const keyState = new Set();
    let isDragging = false, previousPointer = { x: 0, y: 0 };
    const clock = new THREE.Clock();
    let animationId = null;
    let eventHandlers = {};
    const carOptions = ref([]);
    const destinationXOptions = ref([]);
    const destinationYOptions = ref([]);
    const routeStatus = ref("選擇車輛與目的地後派送");
    const isExecuting = ref(false);
    const executionStatus = ref("");
    const carStatuses = ref([]); // ⭐ 新增：車輛狀態
    const collisionMode = ref('advanced'); // ⭐ 避障模式
    const activeTasks = ref([]); // ⭐ 協作任務
    const systemStatus = ref({
        collisionMode: 'advanced',
        totalCars: 0,
        activeTasks: 0,
        waitingCars: 0,
        movingCars: 0,
        idleCars: 0
    });
    const carPriorities = ref({}); // ⭐ 車輛優先級

    const unloadBaysConfig = unloadBays;

    function init() {
        const sceneData = createScene(container.value);
        scene = sceneData.scene;
        camera = sceneData.camera;
        renderer = sceneData.renderer;

        carManager = new CarManager(scene);

        loadModel();
        setupInput();
        animate();
    }

    function loadModel() {
        const loader = new GLTFLoader();
        loader.load("/blue_box.glb", (gltf) => {
            baseModel = processModel(gltf.scene);
            const gridMetrics = createBoxGrid({
                scene,
                baseModel,
                boxes,
                unloadAreaCells,
                onComplete: (metrics) => {
                    gridMetricsCache = metrics;
                    currentModelSize = metrics.modelSize;
                    adjustCamera(metrics);
                    createTrackSystem({ scene, baseModel, trackPieces, gridMetrics: metrics, unloadBays: unloadBaysConfig });
                    player = createPlayer(scene, metrics.modelSize);
                    if (carManager) {
                        carManager.setCargoBoxes(boxes);
                        carManager.createCars(metrics)
                            .then(() => {
                                carOptions.value = carManager.getCarOptions();
                                destinationXOptions.value = Array.from({ length: metrics.width }, (_, i) => ({
                                    id: `${i}`,
                                    label: `X${i + 1}`,
                                }));
                                destinationYOptions.value = Array.from({ length: metrics.depth }, (_, i) => ({
                                    id: `${i}`,
                                    label: `Y${i + 1}`,
                                }));
                                routeStatus.value = "車輛已載入，請選擇目的地";
                            })
                            .catch(() => {
                                routeStatus.value = "車輛載入失敗";
                            });
                    }
                    loadCargoLayout(metrics).catch((error) => {
                        console.error("✗ 載入後端貨物配置失敗", error);
                        saveBoxData(boxes, metrics.modelSize);
                    });
                }
            });
        });
    }

    function setCarDestination(carId, destinationId) {
        if (!carManager) return false;
        const result = carManager.setDestination(carId, destinationId);
        routeStatus.value = result.message;
        return result.success;
    }

    function pickUpCargo(carId) {
        if (!carManager) return false;
        const result = carManager.pickUpCargo(carId);
        routeStatus.value = result.message;
        return result.success;
    }

    function dropCargo(carId) {
        if (!carManager) return false;
        const result = carManager.dropCargo(carId);
        routeStatus.value = result.message;
        return result.success;
    }

    function getDefaultCarId() {
        return carOptions.value[0]?.id || "";
    }

    function waitForCarReady(carId) {
        return new Promise((resolve) => {
            const checkReady = () => {
                if (!carManager) {
                    resolve(false);
                    return;
                }
                if (carManager.isCarReady(carId)) {
                    resolve(true);
                } else {
                    requestAnimationFrame(checkReady);
                }
            };
            checkReady();
        });
    }

    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pickDropDelay = 650;

    async function moveCargoBoxToCoord(carId, cargoBox, targetCoord) {
        if (!carManager || !cargoBox?.userData?.gridCoord) return false;

        const { x, z } = cargoBox.userData.gridCoord;
        const moveResult = setCarDestination(carId, `${x}-${z}`);
        if (!moveResult) return false;

        await waitForCarReady(carId);
        await pause(pickDropDelay);

        const pickResult = pickUpCargo(carId);
        if (!pickResult) return false;

        await pause(pickDropDelay);

        setCarDestination(carId, `${targetCoord.x}-${targetCoord.z}`);
        await waitForCarReady(carId);
        await pause(pickDropDelay);

        const dropResult = dropCargo(carId);
        await pause(pickDropDelay);

        return dropResult;
    }

    async function moveCargoBoxToCoords(carId, cargoBox, targetCoords = []) {
        const coords = targetCoords.filter(Boolean);
        for (const coord of coords) {
            const moved = await moveCargoBoxToCoord(carId, cargoBox, coord);
            if (moved) {
                return true;
            }
        }
        return false;
    }

    function getStackAtCoord(coord) {
        return boxes.filter((box) => {
            const gridCoord = box.userData?.gridCoord;
            return gridCoord && gridCoord.x === coord.x && gridCoord.z === coord.z && !box.userData?.isPicked;
        }).sort((a, b) => {
            const ay = a.userData?.gridCoord?.y ?? 0;
            const by = b.userData?.gridCoord?.y ?? 0;
            return by - ay;
        });
    }

    function getNearbyStagingCoords(centerCoord) {
        if (!gridMetricsCache) return [];
        const { width, depth } = gridMetricsCache;
        const offsets = [
            { x: 1, z: 0 },
            { x: -1, z: 0 },
            { x: 0, z: 1 },
            { x: 0, z: -1 },
            { x: 1, z: 1 },
            { x: 1, z: -1 },
            { x: -1, z: 1 },
            { x: -1, z: -1 },
        ];

        return offsets
            .map((offset) => ({
                x: Math.max(0, Math.min(width - 1, centerCoord.x + offset.x)),
                z: Math.max(0, Math.min(depth - 1, centerCoord.z + offset.z)),
            }))
            .filter((coord) => coord.x !== centerCoord.x || coord.z !== centerCoord.z);
    }

    function getNextAvailableStagingCoord(centerCoord) {
        const stagingCoords = getNearbyStagingCoords(centerCoord);
        if (!gridMetricsCache || stagingCoords.length === 0) {
            return { x: centerCoord.x, z: centerCoord.z };
        }

        let bestCoord = stagingCoords[0];
        let bestHeight = Number.POSITIVE_INFINITY;
        stagingCoords.forEach((coord) => {
            const stackHeight = getStackAtCoord(coord).length;
            if (stackHeight < bestHeight) {
                bestHeight = stackHeight;
                bestCoord = coord;
            }
        });
        return bestCoord;
    }

    async function clearBlockingCargo(carId, targetBox, orderItemIds, itemAssignments, deliveredItemIds) {
        const targetCoord = targetBox.userData?.gridCoord;
        if (!targetCoord) return;

        let stack = getStackAtCoord(targetCoord);
        while (stack.length > 0 && stack[0].userData?.boxId !== targetBox.userData?.boxId) {
            const blockingBox = stack[0];
            const blockingId = blockingBox.userData?.boxId;

            if (orderItemIds?.has(blockingId)) {
                const assignment = itemAssignments?.get(blockingId);
                const shippingCoord = assignment?.shippingTarget?.coord;
                if (shippingCoord) {
                    await moveCargoBoxToCoords(carId, blockingBox, [shippingCoord]);
                    deliveredItemIds?.add(blockingId);
                }
            } else if (itemAssignments?.has(blockingId)) {
                const assignment = itemAssignments.get(blockingId);
                const shippingCoord = assignment?.shippingTarget?.coord;
                if (shippingCoord) {
                    await moveCargoBoxToCoords(carId, blockingBox, [shippingCoord]);
                    deliveredItemIds?.add(blockingId);
                }
            } else {
                const stagingCoord = getNextAvailableStagingCoord(targetCoord);
                const stagingCoords = [stagingCoord, ...getNearbyStagingCoords(targetCoord)];
                await moveCargoBoxToCoords(carId, blockingBox, stagingCoords);
            }

            stack = getStackAtCoord(targetCoord);
        }
    }

    async function executeOrder({ carId, order, items, shippingTarget, itemAssignments, deliveredItemIds }) {
        if (!carId) {
            return { success: false, message: "尚未分配車輛" };
        }
        if (!carManager) {
            return { success: false, message: "車輛尚未準備完成" };
        }

        if (!Array.isArray(items) || items.length === 0) {
            return { success: false, message: "訂單內容為空" };
        }

        const orderItemIds = new Set(items);

        for (const itemId of items) {
            if (deliveredItemIds?.has(itemId)) {
                continue;
            }
            const cargoBox = boxes.find((box) => {
                return box.userData?.boxId === itemId && !box.userData?.isPicked;
            });

            if (!cargoBox) {
                executionStatus.value = `找不到商品 ${itemId}`;
                continue;
            }

            if (!cargoBox.userData?.gridCoord) {
                executionStatus.value = `商品 ${itemId} 的位置資訊缺失`;
                continue;
            }

            await clearBlockingCargo(carId, cargoBox, orderItemIds, itemAssignments, deliveredItemIds);
            const moveResult = await moveCargoBoxToCoords(carId, cargoBox, [shippingTarget.coord]);
            if (!moveResult) {
                executionStatus.value = `商品 ${itemId} 卸貨失敗`;
                continue;
            }

            deliveredItemIds?.add(itemId);
            executionStatus.value = `商品 ${itemId} 已送達 ${shippingTarget.label}`;
        }

        if (currentModelSize) {
            saveBoxData(boxes, currentModelSize);
        }

        return { success: true, message: `訂單 ${order?.id ?? ""} 已完成`.trim() };
    }

    async function executeOrders(orderTasks = []) {
        if (isExecuting.value) {
            executionStatus.value = "目前已有訂單執行中，請稍候";
            return { success: false, message: executionStatus.value };
        }

        const carIds = carOptions.value.slice(0, 2).map((car) => car.id);
        if (!carManager || carIds.length === 0) {
            executionStatus.value = "車輛尚未準備完成";
            return { success: false, message: executionStatus.value };
        }

        const shippingTargets = [
            { label: "X1Y1", coord: { x: 0, z: 0 } },
            { label: "X4Y1", coord: { x: 3, z: 0 } },
        ];

        isExecuting.value = true;
        executionStatus.value = "開始執行訂單";

        try {
            const deliveredItemIds = new Set();
            const itemAssignments = new Map();

            const taskConfigs = orderTasks.slice(0, 2).map((task, index) => {
                const shippingTarget = shippingTargets[index % shippingTargets.length];
                const carId = carIds[index % carIds.length] || getDefaultCarId();
                (task.items || []).forEach((itemId) => {
                    itemAssignments.set(itemId, {
                        orderId: task.order?.id,
                        shippingTarget,
                    });
                });
                executionStatus.value = `分配 ${task.order?.id ?? ""} -> ${shippingTarget.label}`.trim();
                return {
                    carId,
                    order: task.order,
                    items: task.items,
                    shippingTarget,
                };
            });

            const tasks = taskConfigs.map((config) => executeOrder({
                ...config,
                itemAssignments,
                deliveredItemIds,
            }));

            const results = await Promise.all(tasks);
            const completedOrderIds = orderTasks
                .slice(0, results.length)
                .filter((_, index) => results[index]?.success)
                .map((task) => task.order?.id)
                .filter(Boolean);

            if (completedOrderIds.length > 0) {
                executionStatus.value = `訂單 ${completedOrderIds.join(", ")} 已完成`;
            }

            return {
                success: completedOrderIds.length > 0,
                message: executionStatus.value,
                completedOrderIds,
            };
        } finally {
            isExecuting.value = false;
        }
    }

    function processModel(originalScene) {
        originalScene.updateMatrixWorld(true);
        const originalBox = new THREE.Box3().setFromObject(originalScene);
        const originalSize = originalBox.getSize(new THREE.Vector3());

        const baseModel = new THREE.Group();
        const meshes = [];

        originalScene.traverse((child) => {
            if (child.isMesh) {
                child.updateMatrixWorld(true);
                const worldMatrix = child.matrixWorld.clone();
                let geometry = child.geometry.clone();
                const material = child.material.clone();
                geometry.applyMatrix4(worldMatrix);
                const newMesh = new THREE.Mesh(geometry, material);
                meshes.push(newMesh);
            }
        });

        const normalizedGroup = new THREE.Group();
        meshes.forEach((mesh) => normalizedGroup.add(mesh));
        normalizedGroup.updateMatrixWorld(true);

        const normalizedBox = new THREE.Box3().setFromObject(normalizedGroup);
        const normalizedCenter = normalizedBox.getCenter(new THREE.Vector3());
        normalizedGroup.position.set(-normalizedCenter.x, -normalizedCenter.y, -normalizedCenter.z);
        baseModel.add(normalizedGroup);

        return baseModel;
    }

    function adjustCamera(metrics) {
        const maxDim = Math.max(metrics.totalWidth, metrics.totalDepth, metrics.totalHeight);
        const fov = camera.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraZ *= 1.6;
        cameraOffset.set(0, Math.max(1.8, cameraZ * 0.2), cameraZ * 0.6);
    }

    function saveBoxData(boxes, modelSize) {
        const cargoDataToSave = convertBoxesToCargoData(boxes, {
            x: modelSize.x,
            y: modelSize.y,
            z: modelSize.z,
        });

        saveCargoDataToBackend(cargoDataToSave, {
            apiBaseUrl: "http://localhost:8000",
            onSuccess: (result) => console.log("✓ 貨物數據已同步", result),
            onError: (error) => console.error("✗ 同步失敗", error),
        });
    }

    async function loadCargoLayout(metrics) {
        const response = await fetch("http://localhost:8000/vue/cargo?limit=300");
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const cargoList = data?.cargo || [];

        if (cargoList.length === 0) {
            saveBoxData(boxes, metrics.modelSize);
            return;
        }

        const cargoMap = new Map();
        cargoList.forEach((cargo) => {
            if (!cargo?.id) return;
            cargoMap.set(cargo.id, cargo);
        });

        boxes.forEach((box) => {
            const boxId = box.userData?.boxId;
            const cargo = cargoMap.get(`case ${boxId}`);
            if (!cargo?.position) return;

            const position = cargo.position;
            box.position.set(position.x, position.y, position.z);
            box.rotation.set(0, 0, 0);
            if (box.parent !== scene) {
                scene.attach(box);
            }
            box.updateMatrixWorld(true);

            const gridCoord = positionToGridCoord(position, metrics);
            box.userData.gridCoord = gridCoord;
            box.userData.isPicked = false;
            box.userData.attachedToCarId = null;
            box.userData.originalParent = scene;
        });
    }

    function positionToGridCoord(position, metrics) {
        const { startX, startY, startZ, boxWidth, boxHeight, boxDepth, spacingX, spacingY, spacingZ, modelCenter } = metrics;
        const xIndex = Math.round((position.x + modelCenter.x - startX) / (boxWidth + spacingX));
        const zIndex = Math.round((position.z + modelCenter.z - startZ) / (boxDepth + spacingZ));
        const yIndex = Math.round((position.y + modelCenter.y - startY) / (boxHeight + spacingY));

        return {
            x: Math.max(0, Math.min(metrics.width - 1, xIndex)),
            y: Math.max(0, Math.min(metrics.height + 2, yIndex)),
            z: Math.max(0, Math.min(metrics.depth - 1, zIndex)),
        };
    }

    function setupInput() {
        eventHandlers = setupInputHandlers({
            renderer,
            keyState,
            isDragging: (val) => isDragging = val,
            previousPointer: (val) => previousPointer = val,
            yaw: (val) => yaw = val,
            pitch: (val) => pitch = val,
            getIsDragging: () => isDragging,
            getPreviousPointer: () => previousPointer,
            getYaw: () => yaw,
            getPitch: () => pitch,
        });

        setupHoverDetection({
            renderer,
            camera,
            container: container.value,
            boxes,
            hoveredBoxInfo,
            tooltipPosition,
        });
    }

    function updatePlayer(delta) {
        if (!player) return;

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const direction = new THREE.Vector3();
        const vertical = new THREE.Vector3(0, 1, 0);
        
        if (keyState.has("KeyW") || keyState.has("ArrowUp")) direction.add(forward);
        if (keyState.has("KeyS") || keyState.has("ArrowDown")) direction.sub(forward);
        if (keyState.has("KeyA") || keyState.has("ArrowLeft")) direction.sub(right);
        if (keyState.has("KeyD") || keyState.has("ArrowRight")) direction.add(right);
        if (keyState.has("Space")) direction.add(vertical);
        if (keyState.has("ShiftLeft") || keyState.has("ShiftRight")) direction.sub(vertical);

        if (direction.lengthSq() > 0) {
            const moveDirection = direction.clone().normalize();
            player.position.addScaledVector(moveDirection, moveSpeed.value * delta);

            const horizontalDirection = moveDirection.clone();
            horizontalDirection.y = 0;

            if (horizontalDirection.lengthSq() > 0.0001) {
                const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(
                    new THREE.Matrix4().lookAt(
                        new THREE.Vector3(0, 0, 0),
                        horizontalDirection,
                        new THREE.Vector3(0, 1, 0),
                    ),
                );
                player.quaternion.slerp(targetQuaternion, 0.2);
            }
        }
    }

    function updateCamera() {
        if (!player) return;

        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
        const rotatedOffset = cameraOffset.clone().applyQuaternion(rotation);

        camera.position.copy(player.position).add(rotatedOffset);
        camera.lookAt(player.position.clone().add(new THREE.Vector3(0, 1, 0)));
    }

    function animate() {
        animationId = requestAnimationFrame(animate);

        const delta = clock.getDelta();
        updatePlayer(delta);
        if (carManager) {
            carManager.update(delta);
            // ⭐ 更新車輛狀態
            carStatuses.value = carManager.getAllCarStatus();
            systemStatus.value = carManager.getSystemStatus();
            activeTasks.value = carManager.getAllCollaborativeTasks();
            
            // 更新優先級顯示
            const priorities = {};
            carManager.cars.forEach(car => {
                priorities[car.id] = carManager.carPriorities.get(car.id) || 0;
            });
            carPriorities.value = priorities;
        }
        updateCamera();

        renderer.render(scene, camera);
    }

    function cleanup() {
        if (animationId) cancelAnimationFrame(animationId);
        
        Object.values(eventHandlers).forEach(handler => {
            if (handler && handler.cleanup) handler.cleanup();
        });

        if (container.value && renderer?.domElement) {
            container.value.removeChild(renderer.domElement);
        }

        boxes.forEach(box => {
            box.traverse(child => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material?.dispose();
                    }
                }
            });
            scene.remove(box);
        });

        trackPieces.forEach(track => {
            track.traverse(child => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material?.dispose();
                    }
                }
            });
            scene.remove(track);
        });

        carManager?.dispose();
        renderer?.dispose();
    }

    function resetWarehouse() {
        if (!scene) return;
        boxes.forEach((box) => {
            const defaultPosition = box.userData?.defaultPosition;
            const defaultGridCoord = box.userData?.defaultGridCoord;
            if (!defaultPosition || !defaultGridCoord) return;

            if (box.parent !== scene) {
                scene.attach(box);
            }
            box.position.copy(defaultPosition);
            box.rotation.set(0, 0, 0);
            box.updateMatrixWorld(true);

            box.userData.gridCoord = { ...defaultGridCoord };
            box.userData.isPicked = false;
            box.userData.attachedToCarId = null;
            box.userData.originalParent = scene;
        });

        if (currentModelSize) {
            saveBoxData(boxes, currentModelSize);
        }
    }

    // ⭐ 切換避障模式
    function switchCollisionMode(mode) {
        if (carManager) {
            carManager.setCollisionMode(mode);
            collisionMode.value = mode;
            routeStatus.value = `避障模式已切換至: ${mode === 'simple' ? '簡單避讓' : '完整系統'}`;
        }
    }

    // ⭐ 設置車輛優先級
    function setCarPriority(carId, priority) {
        if (carManager) {
            carManager.setCarPriority(carId, priority);
            const priorities = {};
            carManager.cars.forEach(car => {
                priorities[car.id] = carManager.carPriorities.get(car.id) || 0;
            });
            carPriorities.value = priorities;
        }
    }

    // ⭐ 創建協作任務
    function createCollaborativeTask(taskData) {
        if (!carManager) return { success: false, message: '車輛管理器未初始化' };
        const result = carManager.createCollaborativeTask(
            taskData.carIds,
            taskData.targetCoord,
            taskData.taskType
        );
        routeStatus.value = result.message;
        return result;
    }

    // ⭐ 執行協作任務
    function executeCollaborativeTask(taskId) {
        if (!carManager) return { success: false, message: '車輛管理器未初始化' };
        const result = carManager.executeCollaborativeTask(taskId);
        routeStatus.value = result.message;
        return result;
    }

    // ⭐ 取消協作任務
    function cancelCollaborativeTask(taskId) {
        if (!carManager) return;
        carManager.cancelCollaborativeTask(taskId);
        routeStatus.value = `協作任務 ${taskId} 已取消`;
    }

    return {
        init,
        cleanup,
        carOptions,
        destinationXOptions,
        destinationYOptions,
        routeStatus,
        isExecuting,
        executionStatus,
        carStatuses, // ⭐ 車輛狀態
        collisionMode, // ⭐ 避障模式
        activeTasks, // ⭐ 協作任務
        systemStatus, // ⭐ 系統狀態
        carPriorities, // ⭐ 車輛優先級
        setCarDestination,
        pickUpCargo,
        dropCargo,
        executeOrders,
        resetWarehouse,
        switchCollisionMode, // ⭐ 切換避障模式
        setCarPriority, // ⭐ 設置優先級
        createCollaborativeTask, // ⭐ 創建協作任務
        executeCollaborativeTask, // ⭐ 執行協作任務
        cancelCollaborativeTask, // ⭐ 取消協作任務
    };
}
