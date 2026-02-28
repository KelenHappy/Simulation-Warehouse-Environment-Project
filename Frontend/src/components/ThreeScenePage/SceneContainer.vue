<template>
  <div class="bg-white/10 backdrop-blur rounded-2xl shadow-2xl p-4 border border-white/10 space-y-4">
    <ThreeScene ref="threeSceneRef" />
    <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
      <OrderExecutionPanel
        :orders="orders"
        :is-executing="isExecuting"
        :execution-status="executionStatus"
        @start-execution="handleStartExecution"
      />
      <ExecutionToolsPanel
        :completed-orders="completedOrders"
        @reset-warehouse="handleResetWarehouse"
      />
    </div>
    
    <!-- 車輛控制面板 -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
      <CollisionModeControl 
        :current-mode="collisionMode"
        :car-options="carOptions"
        :x-options="destinationXOptions"
        :z-options="destinationYOptions"
        :active-tasks="activeTasks"
        :system-status="systemStatus"
        :car-priorities="carPriorities"
        @switch-mode="handleSwitchMode"
        @set-priority="handleSetPriority"
        @create-task="handleCreateTask"
        @execute-task="handleExecuteTask"
        @cancel-task="handleCancelTask"
      />
      
      <CarStatusPanel :car-statuses="carStatuses" />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import ThreeScene from '../ThreeScene/ThreeScene.vue'
import OrderExecutionPanel from './OrderExecutionPanel.vue'
import ExecutionToolsPanel from './ExecutionToolsPanel.vue'
import CollisionModeControl from '../CarStatus/CollisionModeControl.vue'
import CarStatusPanel from '../CarStatus/CarStatusPanel.vue'

const props = defineProps({
  orders: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['order-complete'])

const threeSceneRef = ref(null)
const completedOrders = ref([])

const isExecuting = computed(() => threeSceneRef.value?.isExecuting?.value ?? false)
const executionStatus = computed(() => threeSceneRef.value?.executionStatus?.value ?? '')

// 車輛控制狀態
const collisionMode = ref('advanced')
const carOptions = ref([])
const destinationXOptions = ref([])
const destinationYOptions = ref([])
const activeTasks = ref([])
const systemStatus = ref({
  collisionMode: 'advanced',
  totalCars: 0,
  activeTasks: 0,
  waitingCars: 0,
  movingCars: 0,
  idleCars: 0
})
const carPriorities = ref({})
const carStatuses = ref([])

// 監聽 ThreeScene 的數據更新
watch(() => threeSceneRef.value, (scene) => {
  if (scene) {
    // 從 ThreeScene 獲取數據
    watch(() => scene.carStatuses, (newVal) => {
      if (newVal) carStatuses.value = newVal
    }, { deep: true })
    
    watch(() => scene.collisionMode, (newVal) => {
      if (newVal) collisionMode.value = newVal
    })
    
    watch(() => scene.carOptions, (newVal) => {
      if (newVal) carOptions.value = newVal
    }, { deep: true })
    
    watch(() => scene.destinationXOptions, (newVal) => {
      if (newVal) destinationXOptions.value = newVal
    }, { deep: true })
    
    watch(() => scene.destinationYOptions, (newVal) => {
      if (newVal) destinationYOptions.value = newVal
    }, { deep: true })
    
    watch(() => scene.activeTasks, (newVal) => {
      if (newVal) activeTasks.value = newVal
    }, { deep: true })
    
    watch(() => scene.systemStatus, (newVal) => {
      if (newVal) systemStatus.value = newVal
    }, { deep: true })
    
    watch(() => scene.carPriorities, (newVal) => {
      if (newVal) carPriorities.value = newVal
    }, { deep: true })
  }
})

const parseOrderItems = (content) => {
  if (!content) return []
  return content
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(item => Number(item))
    .filter(item => !Number.isNaN(item))
}

const handleStartExecution = async () => {
  if (!threeSceneRef.value || isExecuting.value || props.orders.length === 0) return

  const orderTasks = props.orders.slice(0, 2).map((order) => ({
    order,
    items: parseOrderItems(order.content)
  }))
  const result = await threeSceneRef.value.startOrderExecution(orderTasks)

  if (result?.completedOrderIds?.length) {
    const completed = orderTasks
      .filter(task => result.completedOrderIds.includes(task.order.id))
      .map(task => ({
        id: task.order.id,
        content: task.order.content,
        time: task.order.time
      }))

    completed.forEach((order) => {
      if (!completedOrders.value.find(existing => existing.id === order.id)) {
        completedOrders.value.unshift(order)
      }
    })

    result.completedOrderIds.forEach((orderId) => {
      emit('order-complete', orderId)
    })
  }
}

const handleResetWarehouse = () => {
  threeSceneRef.value?.resetWarehouse?.()
}

// 車輛控制處理函數
const handleSwitchMode = (mode) => {
  if (threeSceneRef.value?.switchCollisionMode) {
    threeSceneRef.value.switchCollisionMode(mode)
  }
}

const handleSetPriority = (carId, priority) => {
  if (threeSceneRef.value?.setCarPriority) {
    threeSceneRef.value.setCarPriority(carId, priority)
  }
}

const handleCreateTask = (taskData) => {
  if (threeSceneRef.value?.createCollaborativeTask) {
    threeSceneRef.value.createCollaborativeTask(taskData)
  }
}

const handleExecuteTask = (taskId) => {
  if (threeSceneRef.value?.executeCollaborativeTask) {
    threeSceneRef.value.executeCollaborativeTask(taskId)
  }
}

const handleCancelTask = (taskId) => {
  if (threeSceneRef.value?.cancelCollaborativeTask) {
    threeSceneRef.value.cancelCollaborativeTask(taskId)
  }
}
</script>
