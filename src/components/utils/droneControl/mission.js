/**
 * 任务/航线执行器
 * 支持：
 * - waypoints 序列执行
 * - 进度回调
 * - 取消/暂停
 * - 错误处理与超时
 */

import { MoveToCommand, TakeOffCommand, LandCommand, DEFAULT_CONFIG } from './commands.js';

/**
 * 任务状态
 */
export const MissionState = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

/**
 * 航点类型
 */
export const WaypointType = {
  MOVE_TO: 'moveTo',
  TAKE_OFF: 'takeOff',
  LAND: 'land',
  HOVER: 'hover',
};

/**
 * 任务执行器
 */
export class Mission {
  /**
   * @param {Array} waypoints - 航点数组，每个航点格式：
   *   { type: 'moveTo', x, y, z, options? }
   *   { type: 'takeOff', altitude, options? }
   *   { type: 'land', options? }
   *   { type: 'hover', durationMs? }
   * @param {Object} options - 任务选项
   */
  constructor(waypoints, options = {}) {
    this.waypoints = waypoints || [];
    this.options = {
      onProgress: options.onProgress || null,     // (current, total, waypoint) => void
      onWaypointComplete: options.onWaypointComplete || null, // (index, result) => void
      onError: options.onError || null,           // (error, index) => void
      continueOnError: options.continueOnError || false, // 发生错误时是否继续
      timeoutMs: options.timeoutMs || 300000,     // 总任务超时 (5分钟)
    };

    this.state = MissionState.PENDING;
    this.currentIndex = 0;
    this.startTime = null;
    this.results = [];
    this.cancelled = false;

    this._resolve = null;
    this._reject = null;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  /**
   * 在控制器上执行任务
   * @param {DroneControl} control - 无人机控制器
   * @returns {Promise} 任务完成的 Promise
   */
  async run(control) {
    if (this.state !== MissionState.PENDING) {
      throw new Error('Mission already started');
    }

    this.state = MissionState.RUNNING;
    this.startTime = performance.now();
    this.control = control;

    try {
      for (let i = 0; i < this.waypoints.length; i++) {
        // 检查取消
        if (this.cancelled) {
          this.state = MissionState.CANCELLED;
          this._reject(new Error('Mission cancelled'));
          return;
        }

        // 检查总超时
        if (performance.now() - this.startTime > this.options.timeoutMs) {
          this.state = MissionState.FAILED;
          const error = new Error('Mission timeout');
          this._reject(error);
          return;
        }

        this.currentIndex = i;
        const waypoint = this.waypoints[i];

        // 进度回调
        if (this.options.onProgress) {
          this.options.onProgress(i, this.waypoints.length, waypoint);
        }

        try {
          const result = await this._executeWaypoint(waypoint);
          this.results.push({ index: i, success: true, result });
          
          if (this.options.onWaypointComplete) {
            this.options.onWaypointComplete(i, result);
          }
        } catch (error) {
          this.results.push({ index: i, success: false, error });
          
          if (this.options.onError) {
            this.options.onError(error, i);
          }

          if (!this.options.continueOnError) {
            this.state = MissionState.FAILED;
            this._reject(error);
            return;
          }
        }
      }

      this.state = MissionState.COMPLETED;
      this._resolve({
        duration: performance.now() - this.startTime,
        results: this.results,
        waypointsCompleted: this.results.filter(r => r.success).length,
        waypointsTotal: this.waypoints.length,
      });
    } catch (error) {
      this.state = MissionState.FAILED;
      this._reject(error);
    }
  }

  /**
   * 取消任务
   */
  cancel() {
    this.cancelled = true;
    if (this.control) {
      this.control.cancel();
    }
  }

  /**
   * 暂停任务
   */
  pause() {
    if (this.state === MissionState.RUNNING) {
      this.state = MissionState.PAUSED;
      if (this.control) {
        this.control.pause();
      }
    }
  }

  /**
   * 继续任务
   */
  resume() {
    if (this.state === MissionState.PAUSED) {
      this.state = MissionState.RUNNING;
      if (this.control) {
        this.control.resume();
      }
    }
  }

  /**
   * 获取任务进度
   * @returns {{ current: number, total: number, percentage: number, state: string }}
   */
  getProgress() {
    return {
      current: this.currentIndex,
      total: this.waypoints.length,
      percentage: this.waypoints.length > 0 
        ? Math.round((this.currentIndex / this.waypoints.length) * 100) 
        : 0,
      state: this.state,
    };
  }

  /**
   * 执行单个航点
   * @private
   */
  async _executeWaypoint(waypoint) {
    const type = waypoint.type || WaypointType.MOVE_TO;
    const options = waypoint.options || {};

    switch (type) {
      case WaypointType.TAKE_OFF:
        return await this.control.takeOff(waypoint.altitude, options);

      case WaypointType.LAND:
        return await this.control.land(options);

      case WaypointType.HOVER:
        // 悬停指定时间
        const durationMs = waypoint.durationMs || 1000;
        await this.control.hover();
        await this._delay(durationMs);
        return { hovered: true, duration: durationMs };

      case WaypointType.MOVE_TO:
      default:
        const target = {
          x: waypoint.x ?? 0,
          y: waypoint.y ?? null,
          z: waypoint.z ?? 0,
        };
        return await this.control.moveTo(target, options);
    }
  }

  /**
   * 延迟工具
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 便捷函数：运行任务
 * @param {DroneControl} control
 * @param {Array} waypoints
 * @param {Object} options
 * @returns {Promise}
 */
export function runMission(control, waypoints, options = {}) {
  const mission = new Mission(waypoints, options);
  mission.run(control);
  return mission;
}

/**
 * 创建简单的移动航线（只有 moveTo 点）
 * @param {Array<{x,y,z}>} points - 坐标点数组
 * @param {Object} defaultOptions - 每个航点的默认选项
 * @returns {Array} waypoints 数组
 */
export function createMoveRoute(points, defaultOptions = {}) {
  return points.map(point => ({
    type: WaypointType.MOVE_TO,
    x: point.x,
    y: point.y,
    z: point.z,
    options: { ...defaultOptions, ...point.options },
  }));
}

/**
 * 创建完整任务航线（起飞 → 航点序列 → 降落）
 * @param {Array<{x,y,z}>} points
 * @param {number} flightAltitude - 飞行高度
 * @param {Object} options
 * @returns {Array} waypoints 数组
 */
export function createFullMission(points, flightAltitude = 1.0, options = {}) {
  const waypoints = [];
  
  // 起飞
  waypoints.push({
    type: WaypointType.TAKE_OFF,
    altitude: flightAltitude,
  });

  // 航点
  points.forEach(point => {
    waypoints.push({
      type: WaypointType.MOVE_TO,
      x: point.x,
      y: point.y ?? flightAltitude, // 默认使用飞行高度
      z: point.z,
      options: point.options,
    });
  });

  // 降落
  waypoints.push({
    type: WaypointType.LAND,
  });

  return waypoints;
}
