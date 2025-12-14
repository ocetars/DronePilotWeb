#!/usr/bin/env node
/**
 * 无人机 MCP Server
 * 
 * 标准 MCP Server 实现：
 * - 通过 stdio 与 MCP 客户端（Claude Desktop / MCP Inspector）通信
 * - 通过 WebSocket 与浏览器端模拟器通信
 * - 将 MCP 工具调用转发到浏览器并回传结果
 * 
 * 架构：
 *   LLM/Claude ──stdio──► MCP Server ──WebSocket──► Browser (执行)
 * 
 * 使用方式：
 *   1. 在 Claude Desktop 配置中添加此 server
 *   2. 或使用 MCP Inspector 测试: npx @modelcontextprotocol/inspector node mcp/server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

// ==================== 配置 ====================
const WS_PORT = 8765;
const REQUEST_TIMEOUT = 60000; // 60秒超时

// ==================== WebSocket Bridge (连接浏览器) ====================
class BrowserBridge {
  constructor(port) {
    this.port = port;
    this.wss = null;
    this.browser = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timer }
    this.requestCounter = 0;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    
    this.wss.on('connection', (ws) => {
      console.error(`[MCP] New WebSocket connection received`);
      
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        console.error(`[MCP] Received message:`, JSON.stringify(message));
        
        // 浏览器初始化消息
        if (message.type === 'init' && message.client === 'drone-simulator') {
          this.browser = ws;
          console.error(`[MCP] ✅ Browser registered as drone-simulator`);
          return;
        }
        
        // 处理浏览器响应
        this._handleResponse(message);
      });
      
      ws.on('close', () => {
        if (ws === this.browser) {
          console.error(`[MCP] Browser disconnected`);
          this.browser = null;
          // 拒绝所有待处理请求
          for (const [, { reject, timer }] of this.pendingRequests) {
            clearTimeout(timer);
            reject(new Error('Browser disconnected'));
          }
          this.pendingRequests.clear();
        }
      });
      
      ws.on('error', (error) => {
        console.error(`[MCP] WebSocket error:`, error.message);
      });
    });

    this.wss.on('listening', () => {
      console.error(`[MCP] WebSocket server listening on port ${this.port}`);
    });

    this.wss.on('error', (error) => {
      console.error(`[MCP] WebSocket server error:`, error.message);
    });
  }

  _handleResponse(message) {
    const { type, requestId } = message;

    if (type === 'response') {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error || 'Unknown error'));
        }
      }
    } else if (type === 'progress') {
      // 进度信息，可以输出到 stderr
      console.error(`[MCP] Progress: ${message.action} ${message.current}/${message.total}`);
    }
  }

  /**
   * 发送命令到浏览器并等待结果
   */
  sendCommand(action, args = {}) {
    return new Promise((resolve, reject) => {
      console.error(`[MCP] sendCommand called: ${action}, browser=${!!this.browser}, readyState=${this.browser?.readyState}`);
      if (!this.browser || this.browser.readyState !== WebSocket.OPEN) {
        reject(new Error('Browser not connected. Please open the drone simulator in your browser.'));
        return;
      }

      const requestId = `req_${++this.requestCounter}_${Date.now()}`;
      
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${action}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.browser.send(JSON.stringify({
        type: 'command',
        requestId,
        action,
        args,
      }));
    });
  }

  /**
   * 发送查询到浏览器
   */
  sendQuery(action) {
    return new Promise((resolve, reject) => {
      if (!this.browser || this.browser.readyState !== WebSocket.OPEN) {
        reject(new Error('Browser not connected. Please open the drone simulator in your browser.'));
        return;
      }

      const requestId = `req_${++this.requestCounter}_${Date.now()}`;
      
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Query timeout: ${action}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.browser.send(JSON.stringify({
        type: 'query',
        requestId,
        action,
      }));
    });
  }

  isConnected() {
    return this.browser && this.browser.readyState === WebSocket.OPEN;
  }
}

// ==================== MCP Server ====================
async function main() {
  // 启动 WebSocket 服务器（等待浏览器连接）
  const bridge = new BrowserBridge(WS_PORT);
  bridge.start();

  // 创建 MCP Server
  const server = new McpServer({
    name: 'drone-pilot-mcp',
    version: '1.0.0',
  });

  // 注册工具：获取状态
  server.registerTool(
    'drone.get_state',
    { description: '获取无人机当前状态，包括位置、是否活跃、队列长度等' },
    async () => {
      try {
        const result = await bridge.sendQuery('get_state');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：悬停
  server.registerTool(
    'drone.hover',
    { description: '立即悬停无人机，取消当前所有任务' },
    async () => {
      try {
        const result = await bridge.sendCommand('hover');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：起飞
  server.registerTool(
    'drone.take_off',
    {
      description: '起飞到指定高度',
      inputSchema: {
        altitude: z.number().default(1.0).describe('目标高度（米），默认1.0'),
      },
    },
    async ({ altitude }) => {
      try {
        const result = await bridge.sendCommand('take_off', { altitude });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：降落
  server.registerTool(
    'drone.land',
    { description: '降落无人机到地面' },
    async () => {
      try {
        const result = await bridge.sendCommand('land');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：移动到指定位置
  server.registerTool(
    'drone.move_to',
    {
      description: '移动无人机到指定3D坐标位置',
      inputSchema: {
        x: z.number().describe('X坐标（水平）'),
        y: z.number().optional().describe('Y坐标（高度），不指定则保持当前高度'),
        z: z.number().describe('Z坐标（水平）'),
        maxSpeed: z.number().optional().describe('最大飞行速度（米/秒），默认1.0'),
        timeoutMs: z.number().optional().describe('超时时间（毫秒），默认30000'),
      },
    },
    async ({ x, y, z: zCoord, maxSpeed, timeoutMs }) => {
      try {
        const result = await bridge.sendCommand('move_to', {
          x,
          y,
          z: zCoord,
          options: { maxSpeed, timeoutMs },
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：相对移动（支持 world/body 两种参考系）
  server.registerTool(
    'drone.move_relative',
    {
      description: '相对移动（默认 world 坐标系：+X向右、+Z向下、+Y向上，其中 forward 对应 -Z（屏幕向上）；可选 body 相对无人机朝向）。单位米。',
      inputSchema: {
        frame: z.enum(['world', 'body']).optional().describe('参考系：world(默认，+X右/+Z下/+Y上，forward=-Z) 或 body(相对无人机朝向)'),
        forward: z.number().optional().describe('前进距离（米，正=前进，负=后退）'),
        right: z.number().optional().describe('右移距离（米，正=向右，负=向左）'),
        up: z.number().optional().describe('上升距离（米，正=上升，负=下降）'),
        maxSpeed: z.number().optional().describe('最大飞行速度（米/秒）'),
        timeoutMs: z.number().optional().describe('超时时间（毫秒）'),
      },
    },
    async ({ frame, forward, right, up, maxSpeed, timeoutMs }) => {
      try {
        const result = await bridge.sendCommand('move_relative', {
          frame,
          forward,
          right,
          up,
          options: { maxSpeed, timeoutMs },
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：执行航线任务
  server.registerTool(
    'drone.run_mission',
    {
      description: '执行航线任务，按顺序飞过一系列航点',
      inputSchema: {
        waypoints: z.array(z.object({
          type: z.enum(['moveTo', 'takeOff', 'land', 'hover']).describe('航点类型'),
          x: z.number().optional().describe('X坐标'),
          y: z.number().optional().describe('Y坐标（高度）'),
          z: z.number().optional().describe('Z坐标'),
          altitude: z.number().optional().describe('起飞高度（仅takeOff）'),
          durationMs: z.number().optional().describe('悬停时间（仅hover）'),
        })).describe('航点数组'),
      },
    },
    async ({ waypoints }) => {
      try {
        const result = await bridge.sendCommand('run_mission', { waypoints });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：取消任务
  server.registerTool(
    'drone.cancel',
    { description: '取消当前所有任务并悬停' },
    async () => {
      try {
        const result = await bridge.sendCommand('cancel');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：暂停任务
  server.registerTool(
    'drone.pause',
    { description: '暂停当前任务执行' },
    async () => {
      try {
        const result = await bridge.sendCommand('pause');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 注册工具：继续任务
  server.registerTool(
    'drone.resume',
    { description: '继续执行暂停的任务' },
    async () => {
      try {
        const result = await bridge.sendCommand('resume');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // 启动 stdio 传输（MCP 标准协议）
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('[MCP] Drone Pilot MCP Server started');
  console.error(`[MCP] WebSocket server running on ws://localhost:${WS_PORT}`);
  console.error('[MCP] Waiting for browser connection...');
}

main().catch((error) => {
  console.error('[MCP] Fatal error:', error);
  process.exit(1);
});
