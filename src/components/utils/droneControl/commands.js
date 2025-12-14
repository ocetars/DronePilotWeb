/**
 * 无人机高层命令定义
 * 每个命令负责：
 * - 每帧生成底层运动命令 { hover, angle, speed, altitude }
 * - 判定是否完成
 * - 超时检测
 */

// 默认配置
const DEFAULT_CONFIG = {
  maxSpeed: 0.2,           // 最大水平速度 (m/s) - 降低以便更精确控制
  minSpeed: 0.05,           // 最小速度（防止卡住）
  positionTolerance: 0.08, // 位置到达判定阈值 (m) - 增大以更容易到达
  altitudeTolerance: 0.05, // 高度到达判定阈值 (m) - 增大
  defaultAltitude: 1.0,    // 默认起飞高度 (m)
  groundAltitude: 0.05,    // 地面高度 (m)
  timeoutMs: 30000,        // 默认超时时间 (ms)
  slowdownDistance: 0.3,   // 开始减速的距离 (m)
};

/**
 * 命令基类
 */
export class BaseCommand {
  constructor(options = {}) {
    this.startTime = null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
    this.completed = false;
    this.error = null;
    this._resolve = null;
    this._reject = null;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  /**
   * 启动命令
   * @param {Object} droneState - 当前无人机状态 { position: {x,y,z}, ... }
   */
  start(droneState) {
    this.startTime = performance.now();
  }

  /**
   * 每帧更新，返回运动命令
   * @param {number} delta - 帧间隔时间 (秒)
   * @param {Object} droneState - 当前无人机状态
   * @returns {{ hover: boolean, angle: number, speed: number, altitude: number }}
   */
  update(delta, droneState) {
    // 检查超时
    if (this.startTime && (performance.now() - this.startTime) > this.timeoutMs) {
      this.fail(new Error('Command timeout'));
    }
    return { hover: true, angle: 0, speed: 0, altitude: droneState.position.y };
  }

  /**
   * 检查命令是否完成
   * @param {Object} droneState
   * @returns {boolean}
   */
  isComplete(droneState) {
    return this.completed;
  }

  /**
   * 标记完成
   * @param {*} result
   */
  complete(result = null) {
    if (this.completed) return;
    this.completed = true;
    this._resolve(result);
  }

  /**
   * 标记失败
   * @param {Error} error
   */
  fail(error) {
    if (this.completed) return;
    this.completed = true;
    this.error = error;
    this._reject(error);
  }

  /**
   * 取消命令
   */
  cancel() {
    this.fail(new Error('Command cancelled'));
  }
}

/**
 * 悬停命令 - 立即完成，只是设置当前高度悬停
 */
export class HoverCommand extends BaseCommand {
  constructor(options = {}) {
    super(options);
  }

  start(droneState) {
    super.start(droneState);
    this.targetAltitude = droneState.position.y;
    // 悬停命令立即完成
    this.complete({ position: droneState.position });
  }

  update(delta, droneState) {
    super.update(delta, droneState);
    return {
      hover: true,
      angle: 0,
      speed: 0,
      altitude: this.targetAltitude
    };
  }
}

/**
 * 起飞命令 - 上升到指定高度
 */
export class TakeOffCommand extends BaseCommand {
  constructor(altitude, options = {}) {
    super(options);
    this.targetAltitude = altitude ?? DEFAULT_CONFIG.defaultAltitude;
    this.altitudeTolerance = options.altitudeTolerance ?? DEFAULT_CONFIG.altitudeTolerance;
    this.stableFrames = 0; // 连续稳定帧计数
  }

  start(droneState) {
    super.start(droneState);
    this.lastAltitude = droneState.position.y;
  }

  update(delta, droneState) {
    super.update(delta, droneState);
    
    const currentY = droneState.position.y;
    const diff = Math.abs(currentY - this.targetAltitude);
    
    // 检查是否到达目标高度
    if (diff < this.altitudeTolerance) {
      this.stableFrames++;
      // 连续2帧都在阈值内才算到达（避免抖动）
      if (this.stableFrames >= 2) {
        this.complete({ altitude: currentY, target: this.targetAltitude });
      }
    } else {
      this.stableFrames = 0;
    }
    
    this.lastAltitude = currentY;

    return {
      hover: true,
      angle: 0,
      speed: 0,
      altitude: this.targetAltitude
    };
  }
}

/**
 * 降落命令 - 下降到地面高度
 */
export class LandCommand extends BaseCommand {
  constructor(options = {}) {
    super(options);
    this.groundAltitude = options.groundAltitude ?? DEFAULT_CONFIG.groundAltitude;
    this.altitudeTolerance = options.altitudeTolerance ?? DEFAULT_CONFIG.altitudeTolerance;
    this.stableFrames = 0;
  }

  start(droneState) {
    super.start(droneState);
  }

  update(delta, droneState) {
    super.update(delta, droneState);
    
    const currentY = droneState.position.y;
    const diff = Math.abs(currentY - this.groundAltitude);
    
    if (diff < this.altitudeTolerance) {
      this.stableFrames++;
      if (this.stableFrames >= 2) {
        this.complete({ altitude: currentY, landed: true });
      }
    } else {
      this.stableFrames = 0;
    }

    return {
      hover: true,
      angle: 0,
      speed: 0,
      altitude: this.groundAltitude
    };
  }
}

/**
 * 移动到指定位置命令
 */
export class MoveToCommand extends BaseCommand {
  constructor(target, options = {}) {
    super(options);
    // target: { x, y, z } 或 { x, z } (y 表示高度)
    this.target = {
      x: target.x ?? 0,
      y: target.y ?? null, // null 表示保持当前高度
      z: target.z ?? 0
    };
    this.maxSpeed = options.maxSpeed ?? DEFAULT_CONFIG.maxSpeed;
    this.minSpeed = options.minSpeed ?? DEFAULT_CONFIG.minSpeed;
    this.positionTolerance = options.positionTolerance ?? DEFAULT_CONFIG.positionTolerance;
    this.altitudeTolerance = options.altitudeTolerance ?? DEFAULT_CONFIG.altitudeTolerance;
    this.slowdownDistance = options.slowdownDistance ?? DEFAULT_CONFIG.slowdownDistance;
    this.stableFrames = 0;
  }

  start(droneState) {
    super.start(droneState);
    // 如果目标高度未指定，使用当前高度
    if (this.target.y === null) {
      this.target.y = droneState.position.y;
    }
  }

  update(delta, droneState) {
    super.update(delta, droneState);
    
    const pos = droneState.position;
    const dx = this.target.x - pos.x;
    const dz = this.target.z - pos.z;
    const dy = this.target.y - pos.y;
    
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const altitudeDiff = Math.abs(dy);
    
    // 判定是否到达
    if (horizontalDist < this.positionTolerance && altitudeDiff < this.altitudeTolerance) {
      this.stableFrames++;
      if (this.stableFrames >= 2) {
        this.complete({ 
          position: { x: pos.x, y: pos.y, z: pos.z },
          target: this.target 
        });
        return {
          hover: true,
          angle: 0,
          speed: 0,
          altitude: this.target.y
        };
      }
    } else {
      this.stableFrames = 0;
    }

    // 计算朝向角度
    const angle = Math.atan2(dz, dx);
    
    // 计算速度（距离越近越慢，但确保有最小速度能到达目标）
    let speed;
    if (horizontalDist < this.positionTolerance * 2) {
      // 非常接近时使用很小的速度，让位置能精确到达
      speed = this.minSpeed;
    } else if (horizontalDist < this.slowdownDistance) {
      // 线性减速区域
      const t = horizontalDist / this.slowdownDistance;
      speed = this.minSpeed + (this.maxSpeed - this.minSpeed) * t;
    } else {
      speed = this.maxSpeed;
    }

    // 确保速度不会导致越过目标（每帧移动距离不超过到目标的距离）
    const frameDistance = speed * delta;
    if (frameDistance > horizontalDist && horizontalDist > this.positionTolerance) {
      speed = horizontalDist / delta * 0.8; // 稍微减速，避免越过
    }

    return {
      hover: false,
      angle: angle,
      speed: Math.max(speed, this.minSpeed * 0.8), // 确保有最小速度
      altitude: this.target.y
    };
  }
}

/**
 * 旋转偏航命令（原地转向）- 当前简化实现，后续可扩展
 */
export class RotateYawCommand extends BaseCommand {
  constructor(targetAngle, options = {}) {
    super(options);
    this.targetAngle = targetAngle; // 弧度
    // 当前简化：立即完成
  }

  start(droneState) {
    super.start(droneState);
    this.complete({ angle: this.targetAngle });
  }

  update(delta, droneState) {
    return {
      hover: true,
      angle: 0,
      speed: 0,
      altitude: droneState.position.y
    };
  }
}

export { DEFAULT_CONFIG };
