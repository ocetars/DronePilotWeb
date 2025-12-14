/**
 * 无人机控制器
 * 职责：
 * - 管理命令队列
 * - 每帧驱动当前命令产生底层运动指令
 * - 提供高层 API（takeOff/land/moveTo/hover）
 * - 支持取消、暂停/继续
 */

import {
  BaseCommand,
  HoverCommand,
  TakeOffCommand,
  LandCommand,
  MoveToCommand,
  RotateYawCommand,
  DEFAULT_CONFIG
} from './commands.js';

// 控制器状态
const ControllerState = {
  IDLE: 'idle',       // 空闲，无活动命令
  RUNNING: 'running', // 正在执行命令
  PAUSED: 'paused',   // 暂停中
};

export class DroneControl {
  /**
   * @param {Object} movement - DroneMovement 实例
   */
  constructor(movement) {
    this.movement = movement;
    this.state = ControllerState.IDLE;
    this.currentCommand = null;
    this.commandQueue = [];
    this.paused = false;
    this.debug = false; // 开启调试日志
    
    // 事件回调（可选）
    this.onCommandStart = null;
    this.onCommandComplete = null;
    this.onCommandError = null;
    this.onStateChange = null;
  }

  _log(...args) {
    if (this.debug) {
      console.log('[DroneControl]', ...args);
    }
  }

  /**
   * 获取当前无人机状态
   * @returns {{ position: {x,y,z}, isActive: boolean, queueLength: number, state: string, headingRad?: number }}
   */
  getState() {
    const pos = this.movement.model?.position;
    return {
      position: pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: 0, y: 0, z: 0 },
      isActive: this.isActive(),
      queueLength: this.commandQueue.length,
      state: this.state,
      currentCommand: this.currentCommand?.constructor?.name || null,
      // 当前朝向（弧度），与 DroneMovement.currentAngle 保持一致
      headingRad: this.movement?.currentAngle ?? 0,
    };
  }

  /**
   * 检查控制器是否活跃（有正在执行或排队的命令）
   * @returns {boolean}
   */
  isActive() {
    return this.currentCommand !== null || this.commandQueue.length > 0;
  }

  /**
   * 每帧更新，由 Drone.update() 调用
   * @param {number} delta - 帧间隔时间 (秒)
   * @returns {boolean} - 返回 true 表示控制器产生了运动命令（优先级高）
   */
  update(delta) {
    // 如果暂停或无模型，不处理
    if (this.paused || !this.movement.model) {
      return false;
    }

    // 如果没有当前命令，尝试从队列取
    if (!this.currentCommand && this.commandQueue.length > 0) {
      this._startNextCommand();
    }

    // 如果仍然没有命令，返回 false（控制器空闲）
    if (!this.currentCommand) {
      if (this.state !== ControllerState.IDLE) {
        this._setState(ControllerState.IDLE);
      }
      return false;
    }

    // 执行当前命令
    const droneState = this.getState();
    
    try {
      const movementCmd = this.currentCommand.update(delta, droneState);
      
      // 写入运动命令
      this.movement.setMovementCommand(movementCmd);
      
      // 检查是否完成
      if (this.currentCommand.completed) {
        if (this.currentCommand.error) {
          this._onCommandError(this.currentCommand, this.currentCommand.error);
        } else {
          this._onCommandComplete(this.currentCommand);
        }
        this.currentCommand = null;
        
        // 尝试执行下一个命令
        if (this.commandQueue.length > 0) {
          this._startNextCommand();
        }
      }
    } catch (error) {
      console.error('[DroneControl] Command execution error:', error);
      this.currentCommand.fail(error);
      this._onCommandError(this.currentCommand, error);
      this.currentCommand = null;
    }

    return true; // 控制器活跃
  }

  /**
   * 将命令加入队列
   * @param {BaseCommand} command
   * @returns {Promise} 命令完成的 Promise
   */
  enqueue(command) {
    this.commandQueue.push(command);
    return command.promise;
  }

  /**
   * 立即执行命令（清空队列并取消当前命令）
   * @param {BaseCommand} command
   * @returns {Promise}
   */
  executeImmediate(command) {
    this.cancel(); // 取消所有
    return this.enqueue(command);
  }

  // ==================== 高层 API ====================

  /**
   * 悬停（立即完成，取消当前任务）
   * @returns {Promise}
   */
  hover() {
    const cmd = new HoverCommand();
    return this.executeImmediate(cmd);
  }

  /**
   * 起飞到指定高度
   * @param {number} altitude - 目标高度 (m)
   * @param {Object} options - 可选参数
   * @returns {Promise}
   */
  takeOff(altitude = DEFAULT_CONFIG.defaultAltitude, options = {}) {
    const cmd = new TakeOffCommand(altitude, options);
    return this.enqueue(cmd);
  }

  /**
   * 降落
   * @param {Object} options
   * @returns {Promise}
   */
  land(options = {}) {
    const cmd = new LandCommand(options);
    return this.enqueue(cmd);
  }

  /**
   * 移动到指定位置
   * @param {{ x?: number, y?: number, z?: number }} target - 目标位置
   * @param {Object} options - 可选参数 (maxSpeed, timeoutMs, etc.)
   * @returns {Promise}
   */
  moveTo(target, options = {}) {
    const cmd = new MoveToCommand(target, options);
    return this.enqueue(cmd);
  }

  /**
   * 旋转偏航
   * @param {number} angle - 目标角度（弧度）
   * @param {Object} options
   * @returns {Promise}
   */
  rotateYaw(angle, options = {}) {
    const cmd = new RotateYawCommand(angle, options);
    return this.enqueue(cmd);
  }

  // ==================== 控制方法 ====================

  /**
   * 取消所有命令并悬停
   */
  cancel() {
    // 取消当前命令
    if (this.currentCommand) {
      this.currentCommand.cancel();
      this.currentCommand = null;
    }
    // 取消队列中的命令
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift();
      cmd.cancel();
    }
    this._setState(ControllerState.IDLE);
    
    // 设置悬停
    if (this.movement.model) {
      this.movement.setMovementCommand({
        hover: true,
        angle: 0,
        speed: 0,
        altitude: this.movement.model.position.y
      });
    }
  }

  /**
   * 暂停执行
   */
  pause() {
    if (this.state === ControllerState.RUNNING) {
      this.paused = true;
      this._setState(ControllerState.PAUSED);
      
      // 设置悬停
      if (this.movement.model) {
        this.movement.setMovementCommand({
          hover: true,
          angle: 0,
          speed: 0,
          altitude: this.movement.model.position.y
        });
      }
    }
  }

  /**
   * 继续执行
   */
  resume() {
    if (this.state === ControllerState.PAUSED) {
      this.paused = false;
      this._setState(ControllerState.RUNNING);
    }
  }

  // ==================== 私有方法 ====================

  _startNextCommand() {
    if (this.commandQueue.length === 0) return;
    
    this.currentCommand = this.commandQueue.shift();
    this._setState(ControllerState.RUNNING);
    
    const droneState = this.getState();
    this.currentCommand.start(droneState);
    
    this._log('Command started:', this.currentCommand.constructor.name, 'at position:', droneState.position);
    
    if (this.onCommandStart) {
      this.onCommandStart(this.currentCommand);
    }
  }

  _onCommandComplete(command) {
    this._log('Command completed:', command.constructor.name);
    if (this.onCommandComplete) {
      this.onCommandComplete(command);
    }
  }

  _onCommandError(command, error) {
    console.error('[DroneControl] Command failed:', error);
    if (this.onCommandError) {
      this.onCommandError(command, error);
    }
  }

  _setState(newState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      if (this.onStateChange) {
        this.onStateChange(newState, oldState);
      }
    }
  }
}

export { ControllerState };
