<template>
    <div class="three-scene-wrapper">
        <div ref="container" class="three-container"></div>
        <ControlsHint />
        <RoutePlanner
            class="route-planner"
            :car-options="carOptions"
            :destination-x-options="destinationXOptions"
            :destination-y-options="destinationYOptions"
            v-model:selected-car="selectedCar"
            v-model:selected-destination="selectedDestination"
            :status="routeStatus"
            @assign-route="handleAssignRoute"
            @pick-cargo="handlePickCargo"
            @drop-cargo="handleDropCargo"
        />
        <SpeedControl v-model="moveSpeed" />
        <BoxTooltip
            v-if="hoveredBoxInfo"
            :box-info="hoveredBoxInfo"
            :position="tooltipPosition"
        />
    </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from "vue";
import ControlsHint from './ControlsHint.vue';
import SpeedControl from './SpeedControl.vue';
import BoxTooltip from './BoxTooltip.vue';
import RoutePlanner from './RoutePlanner.vue';
import { useThreeScene } from './composables/useThreeScene';

const container = ref(null);
const moveSpeed = ref(6.5);
const hoveredBoxInfo = ref(null);
const tooltipPosition = ref({ x: 0, y: 0 });
const selectedCar = ref('');
const selectedDestination = ref('');
const selectedDestinationX = ref('');
const selectedDestinationY = ref('');
const {
    init,
    cleanup,
    carOptions,
    destinationXOptions,
    destinationYOptions,
    routeStatus,
    isExecuting,
    executionStatus,
    carStatuses,
    collisionMode,
    activeTasks,
    systemStatus,
    carPriorities,
    setCarDestination,
    pickUpCargo,
    dropCargo,
    executeOrders,
    resetWarehouse,
    switchCollisionMode,
    setCarPriority,
    createCollaborativeTask,
    executeCollaborativeTask,
    cancelCollaborativeTask,
} = useThreeScene({
    container,
    moveSpeed,
    hoveredBoxInfo,
    tooltipPosition,
});

watch(carOptions, (options) => {
    if (!selectedCar.value && options.length > 0) {
        selectedCar.value = options[0].id;
    }
});

watch(destinationXOptions, (options) => {
    if (!selectedDestinationX.value && options.length > 0) {
        selectedDestinationX.value = options[0].id;
    }
});

watch(destinationYOptions, (options) => {
    if (!selectedDestinationY.value && options.length > 0) {
        selectedDestinationY.value = options[0].id;
    }
});

watch([selectedDestinationX, selectedDestinationY], ([x, y]) => {
    if (x && y) {
        selectedDestination.value = `${x}-${y}`;
    } else {
        selectedDestination.value = '';
    }
});

const handleAssignRoute = () => {
    if (!selectedCar.value || !selectedDestination.value) {
        routeStatus.value = "請先選擇車輛與目的地";
        return;
    }
    setCarDestination(selectedCar.value, selectedDestination.value);
};

const handlePickCargo = () => {
    if (!selectedCar.value) {
        routeStatus.value = "請先選擇車輛";
        return;
    }
    pickUpCargo(selectedCar.value);
};

const handleDropCargo = () => {
    if (!selectedCar.value) {
        routeStatus.value = "請先選擇車輛";
        return;
    }
    dropCargo(selectedCar.value);
};

const handleSwitchMode = (mode) => {
    switchCollisionMode(mode);
};

const handleSetPriority = (carId, priority) => {
    setCarPriority(carId, priority);
};

const handleCreateTask = (taskData) => {
    createCollaborativeTask(taskData);
};

const handleExecuteTask = (taskId) => {
    executeCollaborativeTask(taskId);
};

const handleCancelTask = (taskId) => {
    cancelCollaborativeTask(taskId);
};

onMounted(() => {
    if (container.value) {
        init();
    }
});

onUnmounted(() => {
    cleanup();
});

const startOrderExecution = async (orderTasks) => {
    return executeOrders(orderTasks);
};

defineExpose({
    startOrderExecution,
    isExecuting,
    executionStatus,
    resetWarehouse,
    carStatuses,
    collisionMode,
    carOptions,
    destinationXOptions,
    destinationYOptions,
    activeTasks,
    systemStatus,
    carPriorities,
    switchCollisionMode,
    setCarPriority,
    createCollaborativeTask,
    executeCollaborativeTask,
    cancelCollaborativeTask,
});
</script>

<style scoped>
.three-scene-wrapper {
    width: 100%;
    position: relative;
}

.three-container {
    width: 100%;
    height: 500px;
    border-radius: 8px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    background: #222222;
}

.three-container:active {
    cursor: grabbing;
}

.route-planner {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 11;
}
</style>
