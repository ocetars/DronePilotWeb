/**
 * 无人机 WebSocket 桥接
 * 负责：
 * - 连接本地 MCP WebSocket 服务器
 * - 接收命令消息并调用 drone.api
 * - 回传执行结果与进度
 */

import { runMission, createFullMission } from './mission.js';

const DEFAULT_WS_URL = 'ws://localhost:8765';

export class DroneWsBridge {
  /**
   * @param {Drone} drone - 无人机实例
   * @param {Object} options - 配置选项
   */
  constructor(drone, options = {}) {
    this.drone = drone;
    this.wsUrl = options.wsUrl || DEFAULT_WS_URL;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectInterval = options.reconnectInterval || 3000;
    this.debug = options.debug || false;
    
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject }
    
    // 当前运行的任务
    this.currentMission = null;
  }

  /**
   * 连接 WebSocket 服务器
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.connected) {
        resolve();
        return;
      }

      try {
        this.ws = new WebSocket(this.wsUrl);
        
        this.ws.onopen = () => {
          this._log('WebSocket connected to', this.wsUrl);
          this.connected = true;
          this._clearReconnectTimer();
          
          // 发送初始化消息
          this._send({
            type: 'init',
            client: 'drone-simulator',
            version: '1.0.0',
          });
          
          resolve();
        };

        this.ws.onclose = (event) => {
          this._log('WebSocket disconnected:', event.code, event.reason);
          this.connected = false;
          this._handleDisconnect();
        };

        this.ws.onerror = (error) => {
          this._log('WebSocket error:', error);
          if (!this.connected) {
            reject(error);
          }
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event.data);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    this._clearReconnectTimer();
    this.autoReconnect = false;
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * 尝试连接（不抛异常，用于自动重连场景）
   */
  async tryConnect() {
    try {
      await this.connect();
      // 连接成功时始终打印（不受 debug 开关限制）
      console.log('[DroneWsBridge] ✅ Connected to MCP Server at', this.wsUrl);
    } catch (error) {
      // 连接失败时也始终打印
      console.log('[DroneWsBridge] ⏳ MCP Server not available, will retry in', this.reconnectInterval / 1000, 's...');
    }
  }

  /**
   * 处理接收到的消息
   * @private
   */
  async _handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this._log('Invalid JSON message:', data);
      return;
    }

    this._log('Received:', message);

    const { type, requestId, action, args } = message;

    switch (type) {
      case 'ping':
        this._send({ type: 'pong', requestId });
        break;

      case 'command':
        await this._executeCommand(requestId, action, args || {});
        break;

      case 'query':
        this._handleQuery(requestId, action);
        break;

      default:
        this._sendError(requestId, `Unknown message type: ${type}`);
    }
  }

  /**
   * 执行命令
   * @private
   */
  async _executeCommand(requestId, action, args) {
    const api = this.drone.api;
    
    try {
      let result;
      
      switch (action) {
        case 'hover':
          result = await api.hover();
          break;

        case 'take_off':
        case 'takeOff':
          result = await api.takeOff(args.altitude, args.options);
          break;

        case 'land':
          result = await api.land(args.options);
          break;

        case 'move_to':
        case 'moveTo':
          const target = {
            x: args.x ?? 0,
            y: args.y ?? null,
            z: args.z ?? 0,
          };
          result = await api.moveTo(target, args.options);
          break;

        case 'move_relative':
        case 'moveRelative': {
          const state = this.drone.getState();
          const pos = state?.position;
          const headingRad = state?.headingRad ?? 0;
          if (!pos) {
            throw new Error('Drone position not available');
          }

          const frame = args.frame ?? 'world';
          const forward = args.forward ?? 0;
          const right = args.right ?? 0;
          const up = args.up ?? 0;

          // 坐标系约定（地面平面）：原点为中轴交点，+X 向右，+Z 向下，+Y 向上。
          // - world: forward=>-Z（屏幕/地图“向上”），right=>+X
          // - body : forward/right 相对于无人机朝向（headingRad 来自 DroneMovement.currentAngle）
          let nextTarget;
          if (frame === 'body') {
            // headingRad=0 表示朝 +X；headingRad=π/2 表示朝 +Z
            const fx = Math.cos(headingRad);
            const fz = Math.sin(headingRad);
            // “右侧”按你们坐标系定义：+X 右、+Z 下，因此右侧向量是 forward 旋转 +90°
            const rx = Math.cos(headingRad + Math.PI / 2);
            const rz = Math.sin(headingRad + Math.PI / 2);

            nextTarget = {
              x: pos.x + fx * forward + rx * right,
              y: (pos.y ?? 0) + up,
              z: pos.z + fz * forward + rz * right,
            };
          } else {
            // world（默认）：不看朝向，直接按世界轴移动
            nextTarget = {
              x: pos.x + right,          // +X 向右
              y: (pos.y ?? 0) + up,      // +Y 向上
              z: pos.z - forward,        // forward=向前（屏幕向上）=> -Z
            };
          }

          result = await api.moveTo(nextTarget, args.options);
          break;
        }

        case 'rotate_yaw':
        case 'rotateYaw':
          result = await api.rotateYaw(args.angle, args.options);
          break;

        case 'cancel':
          api.cancel();
          result = { cancelled: true };
          break;

        case 'pause':
          api.pause();
          result = { paused: true };
          break;

        case 'resume':
          api.resume();
          result = { resumed: true };
          break;

        case 'run_mission':
        case 'runMission':
          result = await this._runMission(args);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      this._sendSuccess(requestId, result);
    } catch (error) {
      this._sendError(requestId, error.message);
    }
  }

  /**
   * 执行任务航线
   * @private
   */
  async _runMission(args) {
    const { waypoints, options = {} } = args;
    console.log('[DroneWsBridge] waypoints:', waypoints);
    if (!waypoints || !Array.isArray(waypoints)) {
      throw new Error('waypoints must be an array');
    }

    // 取消之前的任务
    if (this.currentMission) {
      this.currentMission.cancel();
    }

    const mission = runMission(this.drone.control, waypoints, {
      ...options,
      onProgress: (current, total, waypoint) => {
        this._send({
          type: 'progress',
          action: 'mission',
          current,
          total,
          waypoint,
        });
      },
    });

    this.currentMission = mission;
    
    try {
      const result = await mission.promise;
      this.currentMission = null;
      return result;
    } catch (error) {
      this.currentMission = null;
      throw error;
    }
  }

  /**
   * 处理查询请求
   * @private
   */
  _handleQuery(requestId, action) {
    try {
      let result;
      
      switch (action) {
        case 'get_state':
        case 'getState':
          result = this.drone.getState();
          break;

        case 'is_active':
        case 'isActive':
          result = { active: this.drone.isControllerActive() };
          break;

        default:
          throw new Error(`Unknown query: ${action}`);
      }

      this._sendSuccess(requestId, result);
    } catch (error) {
      this._sendError(requestId, error.message);
    }
  }

  /**
   * 发送成功响应
   * @private
   */
  _sendSuccess(requestId, result) {
    this._send({
      type: 'response',
      requestId,
      ok: true,
      result,
    });
  }

  /**
   * 发送错误响应
   * @private
   */
  _sendError(requestId, error) {
    this._send({
      type: 'response',
      requestId,
      ok: false,
      error: typeof error === 'string' ? error : error.message,
    });
  }

  /**
   * 发送消息
   * @private
   */
  _send(data) {
    if (!this.ws || !this.connected) {
      this._log('Cannot send, not connected');
      return;
    }

    const message = JSON.stringify(data);
    this._log('Sending:', data);
    this.ws.send(message);
  }

  /**
   * 处理断开连接
   * @private
   */
  _handleDisconnect() {
    // 拒绝所有待处理的请求
    for (const [requestId, { reject }] of this.pendingRequests) {
      reject(new Error('WebSocket disconnected'));
    }
    this.pendingRequests.clear();

    // 自动重连
    if (this.autoReconnect) {
      this._scheduleReconnect();
    }
  }

  /**
   * 调度重连
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, this.reconnectInterval);
  }

  /**
   * 清除重连定时器
   * @private
   */
  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 日志输出
   * @private
   */
  _log(...args) {
    if (this.debug) {
      console.log('[DroneWsBridge]', ...args);
    }
  }
}

/**
 * 创建并初始化 WS Bridge（便捷函数）
 * @param {Drone} drone
 * @param {Object} options
 * @returns {DroneWsBridge}
 */
export function createWsBridge(drone, options = {}) {
  const bridge = new DroneWsBridge(drone, options);
  // 异步尝试连接，不阻塞
  bridge.tryConnect();
  return bridge;
}
