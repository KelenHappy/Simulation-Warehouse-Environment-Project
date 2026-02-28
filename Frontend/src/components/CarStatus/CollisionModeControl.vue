<template>
  <div class="collision-mode-control">
    <div class="control-header" @click="togglePanel">
      <h3>⚙️ 避障系統控制</h3>
      <button class="toggle-btn">
        {{ isExpanded ? '▼' : '▶' }}
      </button>
    </div>
    
    <div v-show="isExpanded" class="control-content">
      <!-- 模式切換 -->
      <div class="section">
        <h4>🔧 避障模式</h4>
        <div class="mode-selector">
          <button 
            @click="switchMode('simple')"
            :class="['mode-btn', { active: currentMode === 'simple' }]"
          >
            <span class="mode-icon">🟢</span>
            <div class="mode-info">
              <div class="mode-name">簡單避讓</div>
              <div class="mode-desc">基本碰撞檢測</div>
            </div>
          </button>
          
          <button 
            @click="switchMode('advanced')"
            :class="['mode-btn', { active: currentMode === 'advanced' }]"
          >
            <span class="mode-icon">🔵</span>
            <div class="mode-info">
              <div class="mode-name">完整系統</div>
              <div class="mode-desc">優先級+死鎖檢測</div>
            </div>
          </button>
        </div>
      </div>

      <!-- 模式說明 -->
      <div class="mode-description">
        <div v-if="currentMode === 'simple'" class="desc-content simple">
          <strong>簡單避讓模式：</strong>
          <ul>
            <li>✓ 基本碰撞檢測</li>
            <li>✓ 等待其他車輛通過</li>
            <li>✗ 無優先級系統</li>
            <li>✗ 無死鎖檢測</li>
            <li>✗ 無自動重新規劃</li>
          </ul>
        </div>
        
        <div v-else class="desc-content advanced">
          <strong>完整避障系統：</strong>
          <ul>
            <li>✓ A* 智能路徑規劃</li>
            <li>✓ 動態優先級系統</li>
            <li>✓ 死鎖自動檢測與解決</li>
            <li>✓ 超時自動重新規劃</li>
            <li>✓ 路徑預約機制</li>
          </ul>
        </div>
      </div>

      <!-- 優先級設置 -->
      <div class="section">
        <h4>⭐ 車輛優先級</h4>
        <div class="priority-controls">
          <div 
            v-for="car in carOptions" 
            :key="car.id"
            class="priority-item"
          >
            <span class="car-label">{{ car.label }}</span>
            <div class="priority-input-group">
              <button 
                @click="decreasePriority(car.id)"
                class="priority-btn"
                :disabled="getPriority(car.id) <= 0"
              >
                −
              </button>
              <input 
                type="number" 
                :value="getPriority(car.id)"
                @input="e => setPriority(car.id, parseInt(e.target.value))"
                class="priority-input"
                min="0"
                max="99"
              />
              <button 
                @click="increasePriority(car.id)"
                class="priority-btn"
                :disabled="getPriority(car.id) >= 99"
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 協作任務 -->
      <div class="section">
        <h4>🤝 協作任務</h4>
        
        <!-- 創建協作任務 -->
        <div class="task-creator">
          <div class="form-group">
            <label>選擇車輛：</label>
            <div class="car-checkboxes">
              <label 
                v-for="car in carOptions" 
                :key="car.id"
                class="checkbox-label"
              >
                <input 
                  type="checkbox" 
                  :value="car.id"
                  v-model="selectedCarsForTask"
                />
                <span>{{ car.label }}</span>
              </label>
            </div>
          </div>

          <div class="form-group">
           <label>目標位置 X：</label>
           <div class="coordinate-buttons">
            <button
              v-for="x in xOptions"
              :key="x.id"
              @click="taskTargetX = x.id"
              :class="['coord-btn', { active: taskTargetX === x.id }]"
            >
              {{ x.label }}
            </button>
           </div>
          </div>

          <div class="form-group">
           <label>目標位置 Z：</label>
           <div class="coordinate-buttons">
            <button
              v-for="z in zOptions"
              :key="z.id"
              @click="taskTargetZ = z.id"
              :class="['coord-btn', { active: taskTargetZ === z.id }]"
            >
              {{ z.label }}
            </button>
           </div>
          </div>

          <div class="form-group">
           <label>任務類型：</label>
           <div class="task-type-buttons">
            <button
              @click="taskType = 'pickup'"
              :class="['task-type-btn', { active: taskType === 'pickup' }]"
            >
              📦 拾取貨物
            </button>
            <button
              @click="taskType = 'delivery'"
              :class="['task-type-btn', { active: taskType === 'delivery' }]"
            >
              🚚 運送貨物
            </button>
           </div>
          </div>

          <button 
            @click="createTask"
            class="create-task-btn"
            :disabled="!canCreateTask"
          >
            <span>➕ 創建協作任務</span>
          </button>
        </div>

        <!-- 活動任務列表 -->
        <div class="active-tasks" v-if="activeTasks.length > 0">
          <h5>活動任務</h5>
          <div 
            v-for="task in activeTasks" 
            :key="task.id"
            class="task-card"
            :class="`status-${task.status}`"
          >
            <div class="task-header">
              <span class="task-id">{{ task.id }}</span>
              <span class="task-status">{{ getTaskStatusText(task.status) }}</span>
            </div>
            <div class="task-details">
              <div class="task-detail-row">
                <span>目標：</span>
                <span>X{{ task.targetCoord.x + 1 }} - Z{{ task.targetCoord.z + 1 }}</span>
              </div>
              <div class="task-detail-row">
                <span>車輛：</span>
                <span>{{ task.assignedCars.length }} 台</span>
              </div>
              <div class="task-detail-row">
                <span>類型：</span>
                <span>{{ task.taskType === 'pickup' ? '拾取' : '運送' }}</span>
              </div>
            </div>
            <div class="task-actions">
              <button 
                v-if="task.status === 'pending'"
                @click="executeTask(task.id)"
                class="task-action-btn execute"
              >
                ▶️ 執行
              </button>
              <button 
                @click="cancelTask(task.id)"
                class="task-action-btn cancel"
              >
                ✖️ 取消
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 系統狀態 -->
      <div class="section">
        <h4>📊 系統狀態</h4>
        <div class="system-stats">
          <div class="stat-row">
            <span class="stat-label">模式：</span>
            <span class="stat-value">
              {{ currentMode === 'simple' ? '簡單避讓' : '完整系統' }}
            </span>
          </div>
          <div class="stat-row">
            <span class="stat-label">總車輛數：</span>
            <span class="stat-value">{{ systemStatus.totalCars }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">活動任務：</span>
            <span class="stat-value">{{ systemStatus.activeTasks }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">等待車輛：</span>
            <span class="stat-value warning">{{ systemStatus.waitingCars }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">移動車輛：</span>
            <span class="stat-value success">{{ systemStatus.movingCars }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CollisionModeControl',
  props: {
    currentMode: {
      type: String,
      default: 'advanced'
    },
    carOptions: {
      type: Array,
      default: () => []
    },
    xOptions: {
      type: Array,
      default: () => []
    },
    zOptions: {
      type: Array,
      default: () => []
    },
    activeTasks: {
      type: Array,
      default: () => []
    },
    systemStatus: {
      type: Object,
      default: () => ({
        totalCars: 0,
        activeTasks: 0,
        waitingCars: 0,
        movingCars: 0,
        idleCars: 0
      })
    },
    carPriorities: {
      type: Object,
      default: () => ({})
    }
  },
  emits: [
    'switch-mode',
    'set-priority',
    'create-task',
    'execute-task',
    'cancel-task'
  ],
  data() {
    return {
      isExpanded: false,
      selectedCarsForTask: [],
      taskTargetX: '',
      taskTargetZ: '',
      taskType: 'pickup'
    };
  },
  computed: {
    canCreateTask() {
      return this.selectedCarsForTask.length > 0 && 
             this.taskTargetX !== '' && 
             this.taskTargetZ !== '';
    }
  },
  methods: {
    togglePanel() {
      this.isExpanded = !this.isExpanded;
    },
    switchMode(mode) {
      this.$emit('switch-mode', mode);
    },
    getPriority(carId) {
      return this.carPriorities[carId] || 0;
    },
    setPriority(carId, priority) {
      if (priority < 0) priority = 0;
      if (priority > 99) priority = 99;
      this.$emit('set-priority', carId, priority);
    },
    increasePriority(carId) {
      const current = this.getPriority(carId);
      this.setPriority(carId, current + 1);
    },
    decreasePriority(carId) {
      const current = this.getPriority(carId);
      this.setPriority(carId, Math.max(0, current - 1));
    },
    createTask() {
      if (!this.canCreateTask) return;
      
      const taskData = {
        carIds: [...this.selectedCarsForTask],
        targetCoord: {
          x: parseInt(this.taskTargetX),
          z: parseInt(this.taskTargetZ)
        },
        taskType: this.taskType
      };
      
      this.$emit('create-task', taskData);
      
      // 重置表單
      this.selectedCarsForTask = [];
      this.taskTargetX = '';
      this.taskTargetZ = '';
      this.taskType = 'pickup';
    },
    executeTask(taskId) {
      this.$emit('execute-task', taskId);
    },
    cancelTask(taskId) {
      this.$emit('cancel-task', taskId);
    },
    getTaskStatusText(status) {
      const statusMap = {
        pending: '待執行',
        'in-progress': '執行中',
        completed: '已完成',
        failed: '已失敗'
      };
      return statusMap[status] || status;
    }
  }
};
</script>

<style scoped>
.collision-mode-control {
  width: 100%;
  background: rgba(0, 0, 0, 0.9);
  border: 2px solid #9b59b6;
  border-radius: 12px;
  color: #ffffff;
  font-family: 'Arial', sans-serif;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(10px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.control-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  background: #764ba2;
  border-radius: 10px 10px 0 0;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s ease;
}

.control-header:hover {
  background: #8e44ad;
}

.control-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: bold;
}

.toggle-btn {
  background: transparent;
  border: none;
  color: white;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  transition: transform 0.3s ease;
}

.toggle-btn:hover {
  transform: scale(1.2);
}

.control-content {
  padding: 16px;
}

.section {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.section:last-child {
  border-bottom: none;
}

.section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: #9b59b6;
  font-weight: bold;
}

.section h5 {
  margin: 12px 0 8px 0;
  font-size: 12px;
  color: #aaa;
}

/* 模式選擇器 */
.mode-selector {
  display: flex;
  gap: 10px;
}

.mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #fff;
  cursor: pointer;
  transition: all 0.3s ease;
}

.mode-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.mode-btn.active {
  background: rgba(155, 89, 182, 0.3);
  border-color: #9b59b6;
  box-shadow: 0 0 15px rgba(155, 89, 182, 0.4);
}

.mode-icon {
  font-size: 24px;
}

.mode-info {
  flex: 1;
  text-align: left;
}

.mode-name {
  font-size: 13px;
  font-weight: bold;
  margin-bottom: 2px;
}

.mode-desc {
  font-size: 10px;
  color: #aaa;
}

/* 模式說明 */
.mode-description {
  margin-top: 12px;
}

.desc-content {
  padding: 10px;
  border-radius: 6px;
  font-size: 11px;
}

.desc-content.simple {
  background: rgba(46, 204, 113, 0.1);
  border-left: 3px solid #2ecc71;
}

.desc-content.advanced {
  background: rgba(52, 152, 219, 0.1);
  border-left: 3px solid #3498db;
}

.desc-content strong {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}

.desc-content ul {
  margin: 0;
  padding-left: 20px;
}

.desc-content li {
  margin-bottom: 3px;
}

/* 優先級控制 */
.priority-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.priority-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
}

.car-label {
  font-size: 13px;
  font-weight: 500;
}

.priority-input-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.priority-btn {
  width: 24px;
  height: 24px;
  background: rgba(52, 152, 219, 0.3);
  border: 1px solid #3498db;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.priority-btn:hover:not(:disabled) {
  background: rgba(52, 152, 219, 0.5);
  transform: scale(1.1);
}

.priority-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.priority-input {
  width: 50px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  color: #fff;
  text-align: center;
  font-size: 13px;
}

/* 協作任務 */
.task-creator {
  background: rgba(255, 255, 255, 0.03);
  padding: 12px;
  border-radius: 8px;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: #aaa;
  margin-bottom: 6px;
}

.car-checkboxes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
}

.checkbox-label:hover {
  color: #3498db;
}

.coordinate-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.coord-btn {
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.coord-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.3);
}

.coord-btn.active {
  background: rgba(52, 152, 219, 0.4);
  border-color: #3498db;
  color: #3498db;
  font-weight: bold;
}

.task-type-buttons {
  display: flex;
  gap: 8px;
}

.task-type-btn {
  flex: 1;
  padding: 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.task-type-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.3);
}

.task-type-btn.active {
  background: rgba(46, 204, 113, 0.3);
  border-color: #2ecc71;
  color: #2ecc71;
  font-weight: bold;
}

.create-task-btn {
  width: 100%;
  padding: 10px;
  background: #2ecc71;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-weight: bold;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.create-task-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(52, 152, 219, 0.4);
}

.create-task-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 活動任務 */
.active-tasks {
  margin-top: 12px;
}

.task-card {
  background: rgba(255, 255, 255, 0.05);
  border-left: 4px solid #95a5a6;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}

.task-card.status-pending {
  border-left-color: #f39c12;
}

.task-card.status-in-progress {
  border-left-color: #3498db;
}

.task-card.status-completed {
  border-left-color: #2ecc71;
}

.task-card.status-failed {
  border-left-color: #e74c3c;
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.task-id {
  font-size: 12px;
  font-weight: bold;
  color: #3498db;
}

.task-status {
  font-size: 11px;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
}

.task-details {
  font-size: 11px;
  margin-bottom: 8px;
}

.task-detail-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: #aaa;
}

.task-detail-row span:last-child {
  color: #fff;
  font-weight: 500;
}

.task-actions {
  display: flex;
  gap: 6px;
}

.task-action-btn {
  flex: 1;
  padding: 6px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.task-action-btn.execute {
  background: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
  border: 1px solid #2ecc71;
}

.task-action-btn.execute:hover {
  background: rgba(46, 204, 113, 0.3);
}

.task-action-btn.cancel {
  background: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
  border: 1px solid #e74c3c;
}

.task-action-btn.cancel:hover {
  background: rgba(231, 76, 60, 0.3);
}

/* 系統狀態 */
.system-stats {
  font-size: 12px;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.stat-row:last-child {
  border-bottom: none;
}

.stat-label {
  color: #aaa;
}

.stat-value {
  font-weight: bold;
  color: #fff;
}

.stat-value.warning {
  color: #f39c12;
}

.stat-value.success {
  color: #2ecc71;
}

/* 滾動條 */

</style>